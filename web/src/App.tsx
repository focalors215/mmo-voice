import { useEffect, useRef, useState } from 'react';
import Voice from './Voice';
import { AppearanceButton } from './Appearance';

type U = { id: string | number; username: string };
type C = { id: string | number; name: string; owner_id: string | number };
type Ch = { id: string | number; name: string; type: 'text' | 'voice' };
type M = { id: string | number; user_id?: string | number; username: string; content: string; created_at: string };
const api = async <T,>(p: string, o?: RequestInit) => {
  const r = await fetch(p, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...o,
  });
  // An expired session anywhere sends the user back to the login screen.
  if (r.status === 401) window.dispatchEvent(new Event('voicehub:unauthorized'));
  if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || '请求失败');
  return r.json() as Promise<T>;
};
const Icon = ({ name }: { name: string }) => (
  <svg
    className="ico"
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {{
      add: <path d="M12 5v14M5 12h14" />,
      mic: (
        <>
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" />
        </>
      ),
      screen: (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>
      ),
      logout: (
        <>
          <path d="M10 4H4v16h6M13 8l4 4-4 4M8 12h13" />
        </>
      ),
      send: <path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14" />,
      close: <path d="m6 6 12 12M6 18 18 6" />,
      menu: <path d="M4 6h16M4 12h16M4 18h16" />,
      members: (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 6" />
        </>
      ),
    }[name] || <circle cx="12" cy="12" r="3" />}
  </svg>
);
// 喵喵零 and 小鱼 from the brand sticker; decorative wherever it appears.
const Mark = () => (
  <span className="brand-mark" aria-hidden="true">
    <img src="/brand/mark.png" alt="" draggable={false} />
  </span>
);
const PeekCat = () => <img className="peek-cat" src="/brand/peek-cat.png" alt="" aria-hidden="true" draggable={false} />;
const timeLabel = (iso: string) => {
  const d = new Date(iso),
    now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function Login({ done }: { done: (u: U) => void }) {
  const [register, setRegister] = useState(false),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState('');
  async function submit(e: any) {
    e.preventDefault();
    setError('');
    try {
      done(
        (
          await api<{ user: U }>(register ? '/api/auth/register' : '/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
          })
        ).user,
      );
    } catch (x: any) {
      setError(x.message);
    }
  }
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand-lockup">
          <Mark />
          <span>喵喵零和小鱼的小屋</span>
          <AppearanceButton />
        </div>
        <div className="auth-copy">
          <small>一个给朋友留的安静房间</small>
          <h1>
            听见彼此，
            <br />
            <em>分享此刻。</em>
          </h1>
          <p>和熟悉的人聊天、进入语音频道，也可以一起分享屏幕。</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              minLength={2}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={register ? 'new-password' : 'current-password'}
              required
              minLength={8}
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary wide">
            {register ? '创建账号' : '进入小屋'}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <button className="text-button" type="button" onClick={() => setRegister(!register)}>
          {register ? '已有账号？直接登录' : '还没有账号？创建一个'}
        </button>
      </div>
      <div className="auth-art" aria-hidden="true">
        <div className="sticker-stage">
          <span className="sticker-glow" />
          <img className="sticker" src="/brand/sticker.webp" alt="" draggable={false} />
          <span className="float-heart h1">♥</span>
          <span className="float-heart h2">♥</span>
          <span className="float-heart h3">♥</span>
        </div>
        <p>
          喵喵零和小鱼在等你
          <br />
          <span>今天也要好好说话。</span>
        </p>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<U | null>(null),
    [ready, setReady] = useState(false);
  useEffect(() => {
    api<{ user: U }>('/api/auth/me')
      .then((x) => setUser(x.user))
      .catch(() => {})
      .finally(() => setReady(true));
    const expired = () => setUser(null);
    window.addEventListener('voicehub:unauthorized', expired);
    return () => window.removeEventListener('voicehub:unauthorized', expired);
  }, []);
  return ready ? (
    user ? (
      <Home user={user} out={() => setUser(null)} />
    ) : (
      <Login done={setUser} />
    )
  ) : (
    <div className="loading">
      <Mark />
      <span>正在打开小屋…</span>
    </div>
  );
}

function Home({ user, out }: { user: U; out: () => void }) {
  const [communities, setCommunities] = useState<C[]>([]),
    [community, setCommunity] = useState<C | null>(null),
    [channels, setChannels] = useState<Ch[]>([]),
    [members, setMembers] = useState<U[]>([]),
    [channel, setChannel] = useState<Ch | null>(null),
    [messages, setMessages] = useState<M[]>([]),
    [input, setInput] = useState(''),
    [modal, setModal] = useState(''),
    [value, setValue] = useState(''),
    [warning, setWarning] = useState(''),
    [invite, setInvite] = useState<{ code: string; expires_at: string } | null>(null),
    [copyFallback, setCopyFallback] = useState(false),
    [mobilePanel, setMobilePanel] = useState<'channels' | 'members' | ''>(''),
    [sending, setSending] = useState(false),
    inviteCode = new URLSearchParams(location.search).get('invite') || '';
  const selected = useRef<Ch | null>(null),
    dialogRef = useRef<HTMLDialogElement | null>(null),
    messagesRef = useRef<HTMLDivElement | null>(null),
    stickToBottom = useRef(true);
  selected.current = channel;
  useEffect(() => {
    const d = dialogRef.current;
    if (!modal || !d) return;
    if (!d.open) d.showModal();
    return () => {
      if (d.open) d.close();
    };
  }, [modal]);
  useEffect(() => {
    api<{ communities: C[] }>('/api/communities')
      .then((x) => {
        setCommunities(x.communities);
        setCommunity(x.communities[0] || null);
      })
      .catch((x) => setWarning(x.message));
  }, []);
  useEffect(() => {
    if (inviteCode) {
      setValue(inviteCode);
      setModal('join');
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    setChannel(null);
    setChannels([]);
    setMembers([]);
    setMessages([]);
    setInvite(null);
    if (!community) return;
    api<{ channels: Ch[]; members: U[] }>('/api/communities/' + community.id)
      .then((x) => {
        if (!stopped) {
          setChannels(x.channels);
          setMembers(x.members);
          setChannel(x.channels[0] || null);
        }
      })
      .catch((x) => !stopped && setWarning(x.message));
    return () => {
      stopped = true;
    };
  }, [community]);
  useEffect(() => {
    setMessages([]);
    setInput('');
    if (!channel || channel.type !== 'text') return;
    let stopped = false;
    const load = () =>
      api<{ messages: M[] }>('/api/channels/' + channel.id + '/messages')
        .then((x) => !stopped && setMessages(x.messages))
        .catch((x) => !stopped && setWarning(x.message));
    load();
    const timer = setInterval(load, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [channel]);
  // Keep the newest message in view unless the reader has scrolled up to older ones.
  useEffect(() => {
    stickToBottom.current = true;
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [channel]);
  useEffect(() => {
    const el = messagesRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const owner = !!community && String(community.owner_id) === String(user.id);
  const choose = (next: Ch) => {
    setChannel(next);
    setMobilePanel('');
  };
  async function send(e: any) {
    e.preventDefault();
    if (!input.trim() || !channel || sending) return;
    const id = channel.id;
    setSending(true);
    try {
      const x = await api<{ message: M }>('/api/channels/' + id + '/messages', {
        method: 'POST',
        body: JSON.stringify({ content: input.trim() }),
      });
      if (selected.current?.id === id)
        setMessages((current) =>
          current.some((m) => m.id === x.message.id) ? current : [...current, x.message],
        );
      setInput('');
    } catch (x: any) {
      setWarning(x.message);
    } finally {
      setSending(false);
    }
  }
  async function create(e: any) {
    e.preventDefault();
    try {
      const x = await api<{ community: C }>('/api/communities', {
        method: 'POST',
        body: JSON.stringify({ name: value.trim() }),
      });
      setCommunities([...communities, x.community]);
      setCommunity(x.community);
      setValue('');
      setModal('');
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  async function join(e: any) {
    e.preventDefault();
    try {
      const raw = value.trim(),
        code = raw.includes('://') ? new URL(raw).searchParams.get('invite') || '' : raw,
        x = await api<{ community: C }>('/api/invites/' + encodeURIComponent(code) + '/join', {
          method: 'POST',
        });
      setCommunities(
        communities.some((c) => c.id === x.community.id) ? communities : [...communities, x.community],
      );
      setCommunity(x.community);
      setModal('');
      if (inviteCode) history.replaceState(null, '', location.pathname);
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  function dropCommunity(id: C['id']) {
    const next = communities.filter((c) => c.id !== id);
    setCommunities(next);
    setCommunity(next[0] || null);
  }
  async function removeMember(target: U) {
    if (!community) return;
    const self = String(target.id) === String(user.id);
    if (!confirm(self ? '确定退出社区“' + community.name + '”？' : '确定将“' + target.username + '”移出社区？'))
      return;
    try {
      await api('/api/communities/' + community.id + '/members/' + target.id, { method: 'DELETE' });
      if (self) dropCommunity(community.id);
      else setMembers((current) => current.filter((m) => m.id !== target.id));
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  async function deleteCommunity() {
    if (!community || !confirm('确定删除社区“' + community.name + '”？所有频道和消息都会被删除，无法撤销。'))
      return;
    try {
      await api('/api/communities/' + community.id, { method: 'DELETE' });
      dropCommunity(community.id);
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  async function add(e: any) {
    e.preventDefault();
    if (!community) return;
    try {
      const x = await api<{ channel: Ch }>('/api/communities/' + community.id + '/channels', {
        method: 'POST',
        body: JSON.stringify({ name: value.trim(), type: modal === 'voice' ? 'voice' : 'text' }),
      });
      setChannels([...channels, x.channel]);
      setValue('');
      setModal('');
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  async function makeInvite() {
    if (!community) return;
    try {
      setInvite(await api('/api/communities/' + community.id + '/invites', { method: 'POST' }));
      setCopyFallback(false);
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  async function revoke() {
    if (!community || !confirm('撤销此社区的全部邀请链接？')) return;
    try {
      await api('/api/communities/' + community.id + '/invites', { method: 'DELETE' });
      setInvite(null);
      setCopyFallback(false);
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  async function remove(target: Ch) {
    if (!community || !confirm('确定删除频道“' + target.name + '”？此操作无法撤销。')) return;
    try {
      await api('/api/channels/' + target.id, { method: 'DELETE' });
      const next = channels.filter((x) => x.id !== target.id);
      setChannels(next);
      setChannel((current) => (current?.id === target.id ? next[0] || null : current));
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  async function copy() {
    if (!invite) return;
    const link = location.origin + '/?invite=' + encodeURIComponent(invite.code);
    try {
      await navigator.clipboard.writeText(link);
      setCopyFallback(false);
    } catch {
      setCopyFallback(true);
    }
  }
  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      out();
    } catch (x: any) {
      setWarning(x.message);
    }
  }
  const secure = window.isSecureContext || location.hostname === 'localhost';
  return (
    <div className="app-shell">
      <header className="mobile-top">
        <button
          className="icon-button"
          aria-label="打开频道"
          onClick={() => setMobilePanel(mobilePanel === 'channels' ? '' : 'channels')}
        >
          <Icon name="menu" />
        </button>
        <div className="mobile-title">
          <Mark />
          <strong>{community?.name || '小屋'}</strong>
        </div>
        <button
          className="icon-button"
          aria-label="打开成员"
          onClick={() => setMobilePanel(mobilePanel === 'members' ? '' : 'members')}
        >
          <Icon name="members" />
        </button>
      </header>
      <nav className="community-rail" aria-label="社区列表">
        <Mark />
        {communities.map((c) => (
          <button
            className={community?.id === c.id ? 'selected' : ''}
            aria-current={community?.id === c.id ? 'page' : undefined}
            key={c.id}
            title={c.name}
            aria-label={c.name}
            onClick={() => {
              setChannel(null);
              setCommunity(c);
            }}
          >
            {c.name[0]}
          </button>
        ))}
        <button
          className="rail-add"
          title="创建社区"
          aria-label="创建社区"
          onClick={() => {
            setValue('');
            setModal('new');
          }}
        >
          <Icon name="add" />
        </button>
        <button
          className="rail-add"
          title="加入社区"
          aria-label="加入社区"
          onClick={() => {
            setValue(inviteCode);
            setModal('join');
          }}
        >
          ↗
        </button>
        <span className="rail-spacer" />
        <div className="avatar user-avatar" aria-label={user.username}>
          {user.username[0]}
        </div>
      </nav>
      <aside className={'channels-panel ' + (mobilePanel === 'channels' ? 'mobile-open' : '')}>
        <div className="mobile-community-list">
          <strong>社区</strong>
          {communities.map((c) => (
            <button
              className={community?.id === c.id ? 'selected' : ''}
              aria-current={community?.id === c.id ? 'page' : undefined}
              key={c.id}
              onClick={() => {
                setChannel(null);
                setCommunity(c);
              }}
            >
              <span>{c.name[0]}</span>
              {c.name}
            </button>
          ))}
          <div>
            <button
              className="secondary"
              onClick={() => {
                setValue('');
                setModal('new');
              }}
            >
              创建社区
            </button>
            <button className="ghost" onClick={() => setModal('join')}>
              加入社区
            </button>
          </div>
        </div>
        <div className="panel-heading">
          <div>
            <span className="brand-caption">喵喵零和小鱼的小屋</span>
            <h2>{community?.name || '选择社区'}</h2>
          </div>
          <button className="close-mobile" aria-label="关闭频道面板" onClick={() => setMobilePanel('')}>
            <Icon name="close" />
          </button>
        </div>
        {!community ? (
          <div className="panel-empty">
            <strong>还没有社区</strong>
            <span>创建一个小屋，或加入朋友的邀请。</span>
            <button
              className="secondary"
              onClick={() => {
                setValue('');
                setModal('new');
              }}
            >
              创建社区
            </button>
            <button className="ghost" onClick={() => setModal('join')}>
              加入社区
            </button>
          </div>
        ) : (
          <>
            <Group
              title="文字频道"
              type="text"
              channels={channels}
              active={channel}
              set={choose}
              owner={owner}
              add={() => setModal('channel')}
              remove={remove}
            />
            <Group
              title="语音频道"
              type="voice"
              channels={channels}
              active={channel}
              set={choose}
              owner={owner}
              add={() => setModal('voice')}
              remove={remove}
            />
          </>
        )}
        <div className="channel-footer">
          <div className="avatar">{user.username[0]}</div>
          <span>
            <b>{user.username}</b>
            <small>当前在线</small>
          </span>
          <button className="icon-button" title="退出登录" aria-label="退出登录" onClick={logout}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main className="content-panel">
        <header className="content-header">
          <div>
            <span className="channel-symbol">{channel?.type === 'voice' ? '◌' : '#'}</span>
            <div>
              <h1>{channel?.name || '欢迎回家'}</h1>
              <p>{channel?.type === 'voice' ? '语音空间，随时加入' : '和社区成员聊点什么'}</p>
            </div>
          </div>
          <div className="header-actions">
            <AppearanceButton />
            <button
              className="mobile-member-button"
              onClick={() => setMobilePanel(mobilePanel === 'members' ? '' : 'members')}
            >
              <Icon name="members" />
              <span>成员</span>
            </button>
          </div>
        </header>
        {warning && (
          <div className="notice" role="status">
            {warning}
            <button aria-label="关闭提示" onClick={() => setWarning('')}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {!secure && (
          <div className="secure">
            公网 HTTP 无法使用麦克风或屏幕分享，请使用 HTTPS 或本机 localhost 访问。
          </div>
        )}
        {!channel ? (
          <div className="welcome">
            <PeekCat />
            <span className="eyebrow">欢迎来到共享小屋</span>
            <h2>{community ? '先选一个频道' : '开始建造你的小屋'}</h2>
            <p>
              {community
                ? '去文字频道聊天，或进入语音频道和朋友见面。'
                : '创建社区或加入一个邀请，和朋友开始聊天。'}
            </p>
            {!community && (
              <div>
                <button
                  className="primary"
                  onClick={() => {
                    setValue('');
                    setModal('new');
                  }}
                >
                  创建社区
                </button>
                <button className="secondary" onClick={() => setModal('join')}>
                  加入社区
                </button>
              </div>
            )}
          </div>
        ) : channel.type === 'voice' ? (
          <Voice key={channel.id} ch={channel} secure={secure} />
        ) : (
          <>
            <div className="messages" ref={messagesRef}>
              {messages.length === 0 && (
                <div className="empty">
                  <PeekCat />
                  <strong>这是 #{channel.name} 的开始</strong>
                  <small>发一条消息，和社区成员打个招呼吧。</small>
                </div>
              )}
              {messages.map((m) => (
                <article key={m.id} className={String(m.user_id) === String(user.id) ? 'mine' : ''}>
                  <div className="avatar">{m.username[0]}</div>
                  <div>
                    <div className="message-meta">
                      <b>{m.username}</b>
                      <time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString('zh-CN')}>
                        {timeLabel(m.created_at)}
                      </time>
                    </div>
                    <p>{m.content}</p>
                  </div>
                </article>
              ))}
            </div>
            <form className="composer" onSubmit={send}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={'发送消息到 #' + channel.name}
                aria-label={'发送消息到 #' + channel.name}
              />
              <button className="send-button" aria-label="发送消息" disabled={sending}>
                <Icon name="send" />
              </button>
            </form>
          </>
        )}
      </main>
      <aside className={'members-panel ' + (mobilePanel === 'members' ? 'mobile-open' : '')}>
        <div className="members-heading">
          <div>
            <span>现在在这里</span>
            <h2>
              社区成员 <small>{members.length}</small>
            </h2>
          </div>
          <button className="close-mobile" aria-label="关闭成员面板" onClick={() => setMobilePanel('')}>
            <Icon name="close" />
          </button>
        </div>
        {community && (
          <div className="community-actions">
            <button
              className="secondary"
              onClick={() => {
                setInvite(null);
                setCopyFallback(false);
                setModal('invite-manage');
              }}
            >
              生成邀请
            </button>
            {owner && (
              <button className="ghost revoke-invites" onClick={revoke}>
                撤销全部
              </button>
            )}
            {owner ? (
              <button className="ghost danger-text" onClick={deleteCommunity}>
                删除社区
              </button>
            ) : (
              <button className="ghost danger-text" onClick={() => removeMember(user)}>
                退出社区
              </button>
            )}
          </div>
        )}
        <div className="member-list">
          {members.map((m) => (
            <div className="member" key={m.id}>
              <div className="avatar">{m.username[0]}</div>
              <span>{m.username}</span>
              {owner && String(m.id) !== String(user.id) && (
                <button
                  className="member-remove"
                  title={'移出' + m.username}
                  aria-label={'移出' + m.username}
                  onClick={() => removeMember(m)}
                >
                  移出
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
      {modal && (
        <div
          className="backdrop"
          role="presentation"
          onMouseDown={(e) => e.currentTarget === e.target && setModal('')}
        >
          <dialog
            ref={dialogRef}
            onCancel={() => setModal('')}
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <button className="dialog-close x" aria-label="关闭" onClick={() => setModal('')}>
              <Icon name="close" />
            </button>
            <h3 id="dialog-title">
              {modal === 'new'
                ? '创建社区'
                : modal === 'join'
                  ? '加入社区'
                  : modal === 'invite-manage'
                    ? '社区邀请'
                    : modal === 'voice'
                      ? '新建语音频道'
                      : '新建文字频道'}
            </h3>
            {modal === 'invite-manage' ? (
              <div className="invite-panel">
                {invite ? (
                  <>
                    <label>
                      完整邀请链接
                      <input
                        readOnly
                        value={location.origin + '/?invite=' + encodeURIComponent(invite.code)}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                    </label>
                    <small className="invite-expiry">
                      有效期至 {new Date(invite.expires_at).toLocaleString('zh-CN')}
                    </small>
                    <button className="primary" type="button" onClick={copy}>
                      复制邀请链接
                    </button>
                    {copyFallback && (
                      <p className="copy-help">浏览器未允许自动复制，请选中上方输入框内容后手动复制。</p>
                    )}
                  </>
                ) : (
                  <button className="primary" type="button" onClick={makeInvite}>
                    生成邀请链接
                  </button>
                )}
              </div>
            ) : (
              <form onSubmit={modal === 'new' ? create : modal === 'join' ? join : add}>
                <label>
                  {modal === 'join' ? '邀请代码或链接' : '名称'}
                  <input
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={modal === 'join' ? '粘贴邀请代码' : '名称'}
                    required
                  />
                </label>
                <button className="primary" type="submit">
                  {modal === 'new' ? '创建' : modal === 'join' ? '加入' : '添加'}
                </button>
              </form>
            )}
          </dialog>
        </div>
      )}
    </div>
  );
}
function Group({
  title,
  type,
  channels,
  active,
  set,
  owner,
  add,
  remove,
}: {
  title: string;
  type: 'text' | 'voice';
  channels: Ch[];
  active: Ch | null;
  set: (x: Ch) => void;
  owner: boolean;
  add: () => void;
  remove: (x: Ch) => void;
}) {
  return (
    <section className="channel-group">
      <div className="group-heading">
        <h3>{title}</h3>
        {owner && (
          <button className="tiny-add" aria-label={'添加' + title} onClick={add}>
            <Icon name="add" />
          </button>
        )}
      </div>
      {channels
        .filter((x) => x.type === type)
        .map((x) => (
          <div className="channel-row" key={x.id}>
            <button
              className={'channel ' + (active?.id === x.id ? 'active' : '')}
              aria-current={active?.id === x.id ? 'page' : undefined}
              onClick={() => set(x)}
            >
              <span>{type === 'text' ? '#' : '◌'}</span>
              {x.name}
            </button>
            {owner && (
              <button
                className="channel-delete"
                title={'删除' + x.name}
                aria-label={'删除' + x.name}
                onClick={() => remove(x)}
              >
                ×
              </button>
            )}
          </div>
        ))}
    </section>
  );
}
export default App;
