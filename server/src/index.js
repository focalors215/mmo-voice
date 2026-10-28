import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
const { Pool } = pg,
  PORT = Number(process.env.PORT || 3000),
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }),
  app = express();
const livekit =
  process.env.LIVEKIT_INTERNAL_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
    ? new RoomServiceClient(
        process.env.LIVEKIT_INTERNAL_URL,
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
      )
    : null;
// Only the local gateway/OpenResty hops are trusted for X-Forwarded-* headers.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '32kb' }));
const id = () => crypto.randomUUID(),
  sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex'),
  randomToken = () => crypto.randomBytes(32).toString('base64url');
const passwordHash = (p) =>
  new Promise((r, j) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(p, (process.env.PASSWORD_PEPPER || '') + salt, 64, (e, d) =>
      e ? j(e) : r('scrypt$' + salt + '$' + d.toString('hex')),
    );
  });
const passwordOk = async (p, x) => {
  const parts = String(x).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = await new Promise((r, j) =>
    crypto.scrypt(p, (process.env.PASSWORD_PEPPER || '') + parts[1], 64, (e, d) =>
      e ? j(e) : r(d.toString('hex')),
    ),
  );
  const a = Buffer.from(actual, 'hex'),
    b = Buffer.from(parts[2], 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
// Hash compared against when the username does not exist, so login timing does not reveal registered names.
const dummyHash = passwordHash(randomToken());
const cookie = (req, t, max = '2592000') =>
  'voicehub_session=' +
  t +
  '; Path=/; HttpOnly; SameSite=Lax' +
  (req.secure ? '; Secure' : '') +
  '; Max-Age=' +
  max;
const cookies = (h) => {
  const out = {};
  for (const part of (h || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
};
const fail = (res, s, m) => res.status(s).json({ error: m }),
  q = (t, p) => pool.query(t, p),
  logError = (where, e) =>
    console.error(JSON.stringify({ where, name: e?.name, code: e?.code, message: e?.message, stack: e?.stack })),
  isOwner = async (db, cid, uid) =>
    (await db.query('SELECT 1 FROM communities WHERE id=$1 AND owner_id=$2', [cid, uid])).rowCount > 0,
  notFound = (e) => e?.status === 404 || e?.code === 'not_found';
async function schema() {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    await c.query(
      'CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, username varchar(32) NOT NULL UNIQUE, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())',
    );
    await c.query(
      'CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash char(64) NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())',
    );
    await c.query(
      'CREATE TABLE IF NOT EXISTS communities (id uuid PRIMARY KEY, name varchar(80) NOT NULL, owner_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now())',
    );
    await c.query(
      'CREATE TABLE IF NOT EXISTS members (community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (community_id,user_id))',
    );
    await c.query(
      "CREATE TABLE IF NOT EXISTS channels (id uuid PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE, name varchar(80) NOT NULL, type varchar(8) NOT NULL CHECK(type IN ('text','voice')), created_at timestamptz NOT NULL DEFAULT now())",
    );
    await c.query(
      'CREATE TABLE IF NOT EXISTS invites (code varchar(64) PRIMARY KEY, community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE, created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, revoked_at timestamptz)',
    );
    await c.query(
      'CREATE TABLE IF NOT EXISTS messages (id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 4000), created_at timestamptz NOT NULL DEFAULT now())',
    );
    await c.query(
      'CREATE INDEX IF NOT EXISTS messages_channel_created_idx ON messages(channel_id,created_at DESC)',
    );
    await c.query('DELETE FROM sessions WHERE expires_at<=now()');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
const buckets = new Map();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of buckets) if (t - v.start >= v.ms) buckets.delete(k);
}, 60000).unref();
const hit = (k, lim, ms) => {
  const t = Date.now(),
    b = buckets.get(k);
  if (!b || t - b.start >= ms) {
    buckets.set(k, { start: t, count: 1, ms });
    return true;
  }
  return ++b.count <= lim;
};
// Keyed by route pattern rather than concrete path so IDs in URLs cannot grow the bucket map.
const rate = (lim, ms) => (req, res, next) => {
  if (!hit(req.ip + ':' + req.method + ':' + req.route.path, lim, ms)) return fail(res, 429, '请求过于频繁');
  next();
};
setInterval(
  () => q('DELETE FROM sessions WHERE expires_at<=now()').catch((e) => logError('session-cleanup', e)),
  3600000,
).unref();
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const o = req.get('origin');
  if (!o) return next();
  try {
    if (new URL(o).origin !== req.protocol + '://' + req.get('host')) return fail(res, 403, '无效的请求来源');
  } catch {
    return fail(res, 403, '无效的请求来源');
  }
  next();
});
async function auth(req, res, next) {
  try {
    const c = cookies(req.get('cookie'));
    if (!c.voicehub_session) return fail(res, 401, '未登录');
    const r = await q(
      'SELECT u.id,u.username,s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
      [sha256(c.voicehub_session)],
    );
    if (!r.rowCount) return fail(res, 401, '登录已过期');
    req.user = r.rows[0];
    req.token = c.voicehub_session;
    next();
  } catch (e) {
    next(e);
  }
}
async function member(req, res, next) {
  try {
    const cid = req.params.id || req.communityId;
    if (!uuidOk(cid)) return fail(res, 400, '无效的社区 ID');
    const r = await q('SELECT 1 FROM members WHERE community_id=$1 AND user_id=$2', [cid, req.user.id]);
    if (!r.rowCount) return fail(res, 403, '不是社区成员');
    req.communityId = cid;
    next();
  } catch (e) {
    next(e);
  }
}
async function channel(req, res, next) {
  try {
    if (!uuidOk(req.params.id)) return fail(res, 400, '无效的频道 ID');
    const r = await q(
      'SELECT c.* FROM channels c JOIN members m ON m.community_id=c.community_id WHERE c.id=$1 AND m.user_id=$2',
      [req.params.id, req.user.id],
    );
    if (!r.rowCount) return fail(res, 404, '频道不存在或无权限');
    req.channel = r.rows[0];
    next();
  } catch (e) {
    next(e);
  }
}
const nameOk = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 80,
  userOk = (v) => typeof v === 'string' && /^[\p{L}\p{N}_-]{2,32}$/u.test(v),
  uuidOk = (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
app.get('/api/health', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, database: 'up' });
  } catch {
    res.status(503).json({ ok: false, database: 'down' });
  }
});
app.post('/api/auth/register', rate(10, 60000), async (req, res, next) => {
  let client;
  try {
    const { username, password } = req.body || {};
    if (!userOk(username) || typeof password !== 'string' || password.length < 8 || password.length > 128)
      return fail(res, 400, '用户名或密码格式无效');
    const uid = id(),
      tok = randomToken();
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)', [
      uid,
      username.trim(),
      await passwordHash(password),
    ]);
    await client.query(
      "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",
      [id(), uid, sha256(tok)],
    );
    await client.query('COMMIT');
    res
      .set('Set-Cookie', cookie(req, tok))
      .status(201)
      .json({ user: { id: uid, username: username.trim() } });
  } catch (e) {
    if (client)
      try {
        await client.query('ROLLBACK');
      } catch {}
    if (e.code === '23505') return fail(res, 409, '用户名已存在');
    next(e);
  } finally {
    if (client) client.release();
  }
});
app.post('/api/auth/login', rate(10, 60000), async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!userOk(username) || typeof password !== 'string' || password.length < 8 || password.length > 128)
      return fail(res, 400, '用户名或密码格式无效');
    if (!hit('login-user:' + username.toLowerCase(), 20, 3600000)) return fail(res, 429, '请求过于频繁');
    const r = await q('SELECT id,username,password_hash FROM users WHERE username=$1', [username]);
    const ok = await passwordOk(password, r.rowCount ? r.rows[0].password_hash : await dummyHash);
    if (!r.rowCount || !ok) return fail(res, 401, '用户名或密码错误');
    const tok = randomToken();
    await q(
      "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days')",
      [id(), r.rows[0].id, sha256(tok)],
    );
    res
      .set('Set-Cookie', cookie(req, tok))
      .json({ user: { id: r.rows[0].id, username: r.rows[0].username } });
  } catch (e) {
    next(e);
  }
});
app.post('/api/auth/logout', auth, async (req, res, next) => {
  try {
    await q('DELETE FROM sessions WHERE id=$1', [req.user.session_id]);
    res.set('Set-Cookie', cookie(req, '', '0')).json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.get('/api/auth/me', auth, (req, res) =>
  res.json({ user: { id: req.user.id, username: req.user.username } }),
);
app.get('/api/communities', auth, async (req, res, next) => {
  try {
    const r = await q(
      'SELECT c.id,c.name,c.owner_id FROM communities c JOIN members m ON m.community_id=c.id WHERE m.user_id=$1 ORDER BY c.created_at',
      [req.user.id],
    );
    res.json({ communities: r.rows });
  } catch (e) {
    next(e);
  }
});
app.post('/api/communities', auth, rate(10, 60000), async (req, res, next) => {
  const { name } = req.body || {};
  if (!nameOk(name)) return fail(res, 400, '社区名称无效');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cid = id();
    await c.query('INSERT INTO communities(id,name,owner_id) VALUES($1,$2,$3)', [
      cid,
      name.trim(),
      req.user.id,
    ]);
    await c.query('INSERT INTO members(community_id,user_id) VALUES($1,$2)', [cid, req.user.id]);
    for (const x of [
      ['大厅聊天', 'text'],
      ['休闲大厅', 'voice'],
      ['开黑房间', 'voice'],
    ])
      await c.query('INSERT INTO channels(id,community_id,name,type) VALUES($1,$2,$3,$4)', [
        id(),
        cid,
        x[0],
        x[1],
      ]);
    await c.query('COMMIT');
    res.status(201).json({ community: { id: cid, name: name.trim(), owner_id: req.user.id } });
  } catch (e) {
    await c.query('ROLLBACK');
    next(e);
  } finally {
    c.release();
  }
});
app.get('/api/communities/:id', auth, member, async (req, res, next) => {
  try {
    const [a, b, c] = await Promise.all([
      q('SELECT id,name,owner_id FROM communities WHERE id=$1', [req.communityId]),
      q('SELECT id,name,type FROM channels WHERE community_id=$1 ORDER BY created_at', [req.communityId]),
      q(
        'SELECT u.id,u.username FROM members m JOIN users u ON u.id=m.user_id WHERE m.community_id=$1 ORDER BY u.username',
        [req.communityId],
      ),
    ]);
    if (!a.rowCount) return fail(res, 404, '社区不存在');
    res.json({ community: a.rows[0], channels: b.rows, members: c.rows });
  } catch (e) {
    next(e);
  }
});
app.post('/api/communities/:id/channels', auth, rate(20, 60000), member, async (req, res, next) => {
  try {
    if (!(await isOwner(pool, req.params.id, req.user.id))) return fail(res, 403, '仅社区所有者可管理频道');
    const { name, type } = req.body || {};
    if (!nameOk(name) || !['text', 'voice'].includes(type)) return fail(res, 400, '频道参数无效');
    const ch = { id: id(), name: name.trim(), type };
    await q('INSERT INTO channels(id,community_id,name,type) VALUES($1,$2,$3,$4)', [
      ch.id,
      req.params.id,
      ch.name,
      ch.type,
    ]);
    res.status(201).json({ channel: ch });
  } catch (e) {
    next(e);
  }
});
app.delete('/api/channels/:id', auth, async (req, res, next) => {
  let c;
  try {
    if (!uuidOk(req.params.id)) return fail(res, 400, '无效的频道 ID');
    c = await pool.connect();
    await c.query('BEGIN');
    const r = await c.query(
      'SELECT c.id,c.community_id,c.type FROM channels c JOIN members m ON m.community_id=c.community_id WHERE c.id=$1 AND m.user_id=$2 FOR UPDATE OF c',
      [req.params.id, req.user.id],
    );
    if (!r.rowCount) {
      await c.query('ROLLBACK');
      return fail(res, 404, '频道不存在或无权限');
    }
    const ch = r.rows[0];
    if (!(await isOwner(c, ch.community_id, req.user.id))) {
      await c.query('ROLLBACK');
      return fail(res, 403, '仅社区所有者可管理频道');
    }
    if (ch.type === 'voice' && livekit) {
      try {
        await livekit.deleteRoom('channel-' + ch.id);
      } catch (e) {
        if (!notFound(e)) {
          await c.query('ROLLBACK');
          return fail(res, 503, '实时房间删除失败');
        }
      }
    }
    await c.query('DELETE FROM channels WHERE id=$1', [ch.id]);
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    if (c)
      try {
        await c.query('ROLLBACK');
      } catch {}
    next(e);
  } finally {
    if (c) c.release();
  }
});
app.post('/api/communities/:id/invites', auth, rate(10, 60000), member, async (req, res, next) => {
  try {
    const code = randomToken(),
      expires = new Date(Date.now() + 604800000);
    await q('INSERT INTO invites(code,community_id,created_by,expires_at) VALUES($1,$2,$3,$4)', [
      code,
      req.params.id,
      req.user.id,
      expires,
    ]);
    res.status(201).json({ code, expires_at: expires.toISOString() });
  } catch (e) {
    next(e);
  }
});
app.post('/api/invites/:code/join', auth, async (req, res, next) => {
  try {
    const r = await q(
      'SELECT c.id,c.name,c.owner_id FROM invites i JOIN communities c ON c.id=i.community_id WHERE i.code=$1 AND i.revoked_at IS NULL AND i.expires_at>now()',
      [req.params.code],
    );
    if (!r.rowCount) return fail(res, 404, '邀请无效或已过期');
    await q('INSERT INTO members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [
      r.rows[0].id,
      req.user.id,
    ]);
    res.json({ community: r.rows[0] });
  } catch (e) {
    next(e);
  }
});
app.delete('/api/communities/:id/invites', auth, member, async (req, res, next) => {
  try {
    if (!(await isOwner(pool, req.params.id, req.user.id))) return fail(res, 403, '仅社区所有者可撤销邀请');
    await q('UPDATE invites SET revoked_at=now() WHERE community_id=$1 AND revoked_at IS NULL', [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.delete('/api/communities/:id', auth, member, async (req, res, next) => {
  let c;
  try {
    c = await pool.connect();
    await c.query('BEGIN');
    const r = await c.query('SELECT owner_id FROM communities WHERE id=$1 FOR UPDATE', [req.communityId]);
    if (!r.rowCount || r.rows[0].owner_id !== req.user.id) {
      await c.query('ROLLBACK');
      return fail(res, 403, '仅社区所有者可删除社区');
    }
    const voice = await c.query("SELECT id FROM channels WHERE community_id=$1 AND type='voice' FOR UPDATE", [
      req.communityId,
    ]);
    if (livekit)
      for (const ch of voice.rows) {
        try {
          await livekit.deleteRoom('channel-' + ch.id);
        } catch (e) {
          if (!notFound(e)) {
            await c.query('ROLLBACK');
            return fail(res, 503, '实时房间删除失败');
          }
        }
      }
    await c.query('DELETE FROM communities WHERE id=$1', [req.communityId]);
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    if (c)
      try {
        await c.query('ROLLBACK');
      } catch {}
    next(e);
  } finally {
    if (c) c.release();
  }
});
// Owners remove other members; any non-owner member may remove themselves (leave).
app.delete('/api/communities/:id/members/:userId', auth, rate(30, 60000), member, async (req, res, next) => {
  try {
    const target = String(req.params.userId).toLowerCase();
    if (!uuidOk(target)) return fail(res, 400, '无效的成员 ID');
    const owner = await q('SELECT owner_id FROM communities WHERE id=$1', [req.communityId]);
    if (!owner.rowCount) return fail(res, 404, '社区不存在');
    if (target === owner.rows[0].owner_id) return fail(res, 400, '所有者不能退出，请改为删除社区');
    if (target !== req.user.id && owner.rows[0].owner_id !== req.user.id)
      return fail(res, 403, '仅社区所有者可移出成员');
    const d = await q('DELETE FROM members WHERE community_id=$1 AND user_id=$2', [req.communityId, target]);
    if (!d.rowCount) return fail(res, 404, '成员不存在');
    if (livekit) {
      const voice = await q("SELECT id FROM channels WHERE community_id=$1 AND type='voice'", [req.communityId]);
      await Promise.all(
        voice.rows.map((ch) =>
          livekit.removeParticipant('channel-' + ch.id, target).catch((e) => {
            if (!notFound(e)) logError('remove-participant', e);
          }),
        ),
      );
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.get('/api/channels/:id/messages', auth, channel, async (req, res, next) => {
  try {
    const r = await q(
      'SELECT m.id,m.content,m.created_at,m.user_id,u.username FROM messages m JOIN users u ON u.id=m.user_id WHERE m.channel_id=$1 ORDER BY m.created_at DESC LIMIT 100',
      [req.params.id],
    );
    res.json({ messages: r.rows.reverse() });
  } catch (e) {
    next(e);
  }
});
app.post('/api/channels/:id/messages', auth, rate(30, 60000), channel, async (req, res, next) => {
  try {
    if (req.channel.type !== 'text') return fail(res, 400, '语音频道不能发送消息');
    const content = req.body && req.body.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 4000)
      return fail(res, 400, '消息内容无效');
    const r = await q(
      'INSERT INTO messages(id,channel_id,user_id,content) VALUES($1,$2,$3,$4) RETURNING id,content,created_at,user_id',
      [id(), req.params.id, req.user.id, content.trim()],
    );
    res.status(201).json({ message: Object.assign(r.rows[0], { username: req.user.username }) });
  } catch (e) {
    next(e);
  }
});
app.post('/api/channels/:id/token', auth, rate(10, 60000), async (req, res, next) => {
  let c;
  try {
    if (!uuidOk(req.params.id)) return fail(res, 400, '无效的频道 ID');
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !livekit)
      return fail(res, 503, '实时服务未配置');
    c = await pool.connect();
    await c.query('BEGIN');
    const r = await c.query(
      'SELECT c.id,c.type FROM channels c JOIN members m ON m.community_id=c.community_id WHERE c.id=$1 AND m.user_id=$2 FOR SHARE OF c',
      [req.params.id, req.user.id],
    );
    if (!r.rowCount) {
      await c.query('ROLLBACK');
      return fail(res, 404, '频道不存在或无权限');
    }
    if (r.rows[0].type !== 'voice') {
      await c.query('ROLLBACK');
      return fail(res, 400, '只有语音频道支持实时令牌');
    }
    const room = 'channel-' + r.rows[0].id;
    try {
      await livekit.createRoom({ name: room, maxParticipants: 20 });
    } catch (e) {
      if (e?.status !== 409 && e?.code !== 'already_exists' && e?.code !== 'already-exists') {
        logError('create-room', e);
        await c.query('ROLLBACK');
        return fail(res, 503, '实时房间创建失败');
      }
    }
    const t = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: req.user.id,
      name: req.user.username,
      ttl: '10m',
    });
    t.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    });
    const proto = req.secure ? 'wss' : 'ws';
    const jwt = await t.toJwt();
    await c.query('COMMIT');
    res.json({ token: jwt, url: proto + '://' + req.get('host') + '/rtc' });
  } catch (e) {
    if (c)
      try {
        await c.query('ROLLBACK');
      } catch {}
    next(e);
  } finally {
    if (c) c.release();
  }
});
app.use((e, req, res, next) => {
  logError(req.method + ' ' + (req.route?.path || req.path), e);
  if (!res.headersSent) fail(res, 500, '服务器内部错误');
});
schema()
  .then(() =>
    app.listen(PORT, process.env.HOST || '0.0.0.0', () =>
      console.log('voice-hub server listening on ' + PORT),
    ),
  )
  .catch((e) => {
    logError('startup', e);
    process.exit(1);
  });
