// Membership removal, community deletion and forwarded-proto handling. Creates random-prefixed test accounts.
import assert from 'node:assert/strict';
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:18080';
const ORIGIN = process.env.ORIGIN || BASE_URL;
const prefix = 'mem-test-' + Date.now().toString(36);
const jars = [{}, {}, {}];
async function call(i, path, opts = {}) {
  const headers = { 'content-type': 'application/json', origin: ORIGIN, ...(opts.headers || {}) };
  if (jars[i].cookie) headers.cookie = jars[i].cookie;
  const r = await fetch(BASE_URL + path, { ...opts, headers });
  const set = r.headers.get('set-cookie');
  if (set) jars[i].cookie = set.split(';')[0];
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body, setCookie: set };
}
const expect = (x, s) => {
  assert.equal(x.status, s, JSON.stringify(x.body));
  return x.body;
};
const users = [];
for (let i = 0; i < 3; i++) {
  const u = { username: prefix + 'abc'[i], password: 'TestPass-' + i + '-123!' };
  const res = await call(i, '/api/auth/register', { method: 'POST', body: JSON.stringify(u) });
  users.push(expect(res, 201).user);
  if (i === 0 && ORIGIN.startsWith('https:')) assert.match(res.setCookie || '', /Secure/);
}
expect(
  await call(0, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: prefix + 'nobody', password: 'whatever-123' }),
  }),
  401,
);
const { community } = expect(
  await call(0, '/api/communities', { method: 'POST', body: JSON.stringify({ name: prefix }) }),
  201,
);
const invite = expect(await call(0, '/api/communities/' + community.id + '/invites', { method: 'POST' }), 201);
expect(await call(1, '/api/invites/' + invite.code + '/join', { method: 'POST' }), 200);
expect(await call(2, '/api/invites/' + invite.code + '/join', { method: 'POST' }), 200);
const detail = expect(await call(0, '/api/communities/' + community.id), 200);
const voice = detail.channels.find((c) => c.type === 'voice');
const tok = expect(await call(1, '/api/channels/' + voice.id + '/token', { method: 'POST' }), 200);
assert.equal(tok.url.startsWith('wss://'), ORIGIN.startsWith('https:'), tok.url);
const base = '/api/communities/' + community.id + '/members/';
expect(await call(1, base + users[2].id, { method: 'DELETE' }), 403);
expect(await call(0, base + users[2].id, { method: 'DELETE' }), 200);
expect(await call(2, '/api/communities/' + community.id), 403);
expect(await call(2, '/api/channels/' + voice.id + '/token', { method: 'POST' }), 404);
expect(await call(0, base + users[0].id, { method: 'DELETE' }), 400);
expect(await call(1, '/api/communities/' + community.id, { method: 'DELETE' }), 403);
expect(await call(1, base + users[1].id, { method: 'DELETE' }), 200);
expect(await call(1, '/api/communities/' + community.id), 403);
expect(await call(0, '/api/communities/' + community.id, { method: 'DELETE' }), 200);
expect(await call(0, '/api/communities/' + community.id), 403);
const list = expect(await call(0, '/api/communities'), 200);
assert.ok(!list.communities.some((c) => c.id === community.id));
console.log(JSON.stringify({ ok: true, prefix, base: BASE_URL }));
