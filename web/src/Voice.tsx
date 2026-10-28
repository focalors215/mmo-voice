import { useCallback, useEffect, useRef, useState } from 'react';
import { DisconnectReason, Room, RoomEvent, Track } from 'livekit-client';
import {
  screenProfiles, audioProfiles, applyScreenQuality, applyAudioQuality,
  buildScreenCaptureOptions, buildScreenPublishOptions,
  buildMicrophoneCaptureOptions, buildMicrophonePublishOptions, audioNeedsRepublish, isStereoAudio,
  type ScreenQuality, type AudioQuality,
} from './mediaQuality';

function savedQuality<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch { return fallback; }
}
function saveQuality(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
}


type Channel = { id: string | number; name: string; type: 'text' | 'voice' };
type Person = { id: string; name: string; speaking: boolean; muted: boolean; self: boolean };
type View = { status: string; mic: boolean; screen: boolean; deaf: boolean; people: Person[]; screens: number };
const initial: View = { status: 'disconnected', mic: false, screen: false, deaf: false, people: [], screens: 0 };

export default function Voice({ ch, secure }: { ch: Channel; secure: boolean }) {
  const [view, setView] = useState<View>(initial);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [screenQuality, setScreenQuality] = useState<ScreenQuality>(() => savedQuality('voice-hub.screen-quality', screenProfiles.map(p => p.id), 'standard'));
  const [audioQuality, setAudioQuality] = useState<AudioQuality>(() => savedQuality('voice-hub.audio-quality', audioProfiles.map(p => p.id), 'standard'));
  const screenQualityRef = useRef(screenQuality);
  const audioQualityRef = useRef(audioQuality);
  const [qualityNotice, setQualityNotice] = useState('');

  const room = useRef<Room | null>(null);
  const epoch = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const deaf = useRef(false);
  const media = useRef<Map<any, HTMLMediaElement[]>>(new Map());
  const screenHost = useRef<HTMLDivElement>(null);
  const audioHost = useRef<HTMLDivElement>(null);

  function fullscreenElement() {
    return document.fullscreenElement || (document as any).webkitFullscreenElement;
  }
  function syncFullscreenButtons() {
    screenHost.current?.querySelectorAll<HTMLButtonElement>('.screen-fullscreen').forEach(button => {
      const card = button.closest('.screen-card');
      const video = card?.querySelector('video') as any;
      const active = fullscreenElement() === card || !!video?.webkitDisplayingFullscreen;
      button.textContent = active ? '退出全屏' : '全屏';
      button.setAttribute('aria-label', active ? '退出全屏' : '全屏观看');
      button.setAttribute('aria-pressed', String(active));
    });
  }
  async function toggleFullscreen(card: HTMLDivElement, video: HTMLVideoElement) {
    try {
      if (fullscreenElement() === card) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else (document as any).webkitExitFullscreen?.();
      } else if ((video as any).webkitDisplayingFullscreen) {
        (video as any).webkitExitFullscreen?.();
      } else if (card.requestFullscreen) {
        await card.requestFullscreen();
      } else if ((card as any).webkitRequestFullscreen) {
        (card as any).webkitRequestFullscreen();
      } else if ((video as any).webkitEnterFullscreen) {
        (video as any).webkitEnterFullscreen();
      } else {
        throw new Error('此浏览器暂不支持画面全屏，请使用浏览器全屏模式。');
      }
    } catch (e: any) {
      if (card.isConnected) setError(e.message || '无法进入全屏，请重试。');
    }
  }
  function removeMedia(elements: HTMLMediaElement[]) {
    elements.forEach(element => {
      const card = element.closest('.screen-card');
      const target = card || element;
      const active = fullscreenElement();
      if (active && target.contains(active)) {
        if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
        else (document as any).webkitExitFullscreen?.();
      }
      if ((element as any).webkitDisplayingFullscreen) (element as any).webkitExitFullscreen?.();
      target.remove();
    });
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      const active = fullscreenElement();
      if (event.key === 'Escape' && active && screenHost.current?.contains(active)) {
        if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
        else (document as any).webkitExitFullscreen?.();
      }
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('fullscreenchange', syncFullscreenButtons);
    document.addEventListener('webkitfullscreenchange', syncFullscreenButtons);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('fullscreenchange', syncFullscreenButtons);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenButtons);
    };
  }, []);


  const closeRoom = (r: Room) => {
    r.removeAllListeners();
    for (const p of r.localParticipant.trackPublications.values()) p.track?.stop();
    void r.disconnect();
  };
  const dispose = useCallback((reset = true) => {
    epoch.current++;
    abort.current?.abort();
    abort.current = null;
    const old = room.current;
    room.current = null;
    for (const [track, elements] of media.current) {
      track.detach();
      removeMedia(elements);
    }
    media.current.clear();
    if (old) closeRoom(old);
    deaf.current = false;
    if (reset) { setView(initial); setBlocked(false); setBusy(false); }
  }, []);

  useEffect(() => {
    setView(initial);
    setError('');
    return () => dispose(false);
  }, [ch.id, dispose]);

  function update(r: Room) {
    if (room.current !== r) return;
    const participants = [r.localParticipant, ...r.remoteParticipants.values()];
    setView({
      status: String(r.state),
      mic: r.localParticipant.isMicrophoneEnabled,
      screen: r.localParticipant.isScreenShareEnabled,
      deaf: deaf.current,
      screens: [...media.current.keys()].filter(t => t.source === Track.Source.ScreenShare).length,
      people: participants.map(p => ({
        id: p.identity, name: p.name || p.identity, self: p === r.localParticipant,
        speaking: p.isSpeaking, muted: !p.isMicrophoneEnabled,
      })),
    });
  }
  function detach(track: any, r: Room) {
    const elements = media.current.get(track);
    track.detach();
    if (elements) removeMedia(elements);
    media.current.delete(track);
    update(r);
  }
  function attach(track: any, r: Room, local = false, sharer = '') {
    if (room.current !== r || media.current.has(track)) return;
    if (local && track.source !== Track.Source.ScreenShare) return;
    if (track.kind === Track.Kind.Video && track.source !== Track.Source.ScreenShare) return;
    const element = track.attach() as HTMLMediaElement;
    element.autoplay = true;
    element.setAttribute('playsinline', '');
    element.className = track.kind === Track.Kind.Video ? 'screen-video' : 'remote-audio';
    element.muted = local || (track.kind === Track.Kind.Audio && deaf.current);
    if (track.kind === Track.Kind.Video) {
      const card = document.createElement('div');
      card.className = 'screen-card';
      const toolbar = document.createElement('div');
      toolbar.className = 'screen-toolbar';
      const label = document.createElement('span');
      label.textContent = local ? '我的屏幕' : (sharer || '成员') + '的屏幕';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'screen-fullscreen';
      button.textContent = '全屏';
      button.setAttribute('aria-label', '全屏观看');
      button.setAttribute('aria-pressed', 'false');
      button.onclick = () => { void toggleFullscreen(card, element as HTMLVideoElement); };
      element.ondblclick = () => { void toggleFullscreen(card, element as HTMLVideoElement); };
      element.addEventListener('webkitbeginfullscreen', syncFullscreenButtons);
      element.addEventListener('webkitendfullscreen', syncFullscreenButtons);
      toolbar.append(label, button);
      card.append(toolbar, element);
      screenHost.current?.appendChild(card);
    } else {
      audioHost.current?.appendChild(element);
    }
    media.current.set(track, [element]);
    element.play().catch(() => {
      if (room.current === r && track.kind === Track.Kind.Audio) setBlocked(true);
    });
    update(r);
  }

  async function connect() {
    if (!secure) {
      setError('公网 HTTP 无法使用麦克风和屏幕分享。请通过 SSH 转发访问 localhost:18080，或配置 HTTPS。');
      return;
    }
    dispose();
    const current = ++epoch.current;
    const controller = new AbortController();
    abort.current = controller;
    setError('');
    setView(v => ({ ...v, status: 'connecting' }));
    let r: Room | null = null;
    const active = () => epoch.current === current;
    try {
      const response = await fetch('/api/channels/' + ch.id + '/token', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) window.dispatchEvent(new Event('voicehub:unauthorized'));
      if (!response.ok) throw new Error(data.error || '无法加入频道，请稍后重试');
      if (!active()) return;
      r = new Room({ adaptiveStream: true, dynacast: true });
      const joined = r;
      room.current = joined;
      const guard = () => active() && room.current === joined;
      joined.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => guard() && attach(track, joined, false, participant.name || participant.identity));
      joined.on(RoomEvent.TrackUnsubscribed, track => guard() && detach(track, joined));
      joined.on(RoomEvent.LocalTrackPublished, publication => {
        if (!guard()) return;
        if (publication.track) attach(publication.track, joined, true);
        update(joined);
      });
      joined.on(RoomEvent.LocalTrackUnpublished, publication => {
        if (!guard()) return;
        if (publication.track) detach(publication.track, joined);
        update(joined);
      });
      for (const event of [
        RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
        RoomEvent.ActiveSpeakersChanged, RoomEvent.ConnectionStateChanged,
        RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      ]) joined.on(event, () => guard() && update(joined));
      joined.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (guard()) setBlocked(!joined.canPlaybackAudio);
      });
      joined.on(RoomEvent.Reconnected, () => {
        if (!guard()) return;
        setBusy(true);
        void (async () => {
          if (joined.localParticipant.getTrackPublication(Track.Source.Microphone)?.track)
            await applyAudioQuality(joined, audioQualityRef.current);
          if (guard() && joined.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track)
            await applyScreenQuality(joined, screenQualityRef.current);
          if (guard()) update(joined);
        })().catch(e => {
          if (guard()) setError(e.message || '重连后的档位恢复失败，请重新设置。');
        }).finally(() => { if (guard()) setBusy(false); });
      });
      joined.on(RoomEvent.Disconnected, reason => {
        if (!guard()) return;
        dispose();
        setError(reason === DisconnectReason.DUPLICATE_IDENTITY ? '你已在其他页面或设备加入了语音，这里已断开。'
          : reason === DisconnectReason.PARTICIPANT_REMOVED ? '你已被移出语音频道。'
          : reason === DisconnectReason.ROOM_DELETED ? '语音频道已被删除。'
          : '语音连接已断开，可以重新加入。');
      });
      await joined.connect(data.url, data.token);
      if (!guard()) { closeRoom(joined); return; }
      await joined.startAudio().catch(() => guard() && setBlocked(true));
      // Without a usable microphone the member still joins to listen; the mic can be retried from the controls.
      let micReady = false;
      try {
        await joined.localParticipant.setMicrophoneEnabled(true, buildMicrophoneCaptureOptions(audioQualityRef.current), buildMicrophonePublishOptions(audioQualityRef.current));
        micReady = true;
      } catch (e: any) {
        if (guard()) setError(e.name === 'NotAllowedError' ? '麦克风权限未获允许，已以仅收听方式加入；修改浏览器权限后可点击“开启麦克风”。' : '麦克风无法使用，已以仅收听方式加入：' + (e.message || '未知错误'));
      }
      if (!guard()) { closeRoom(joined); return; }
      if (micReady) await applyAudioQuality(joined, audioQualityRef.current);
      if (!guard()) { closeRoom(joined); return; }
      update(joined);
    } catch (e: any) {
      if (r && room.current !== r) closeRoom(r);
      if (!active()) return;
      dispose();
      setError(e.message || '连接失败，请重试');
    }
  }

  async function toggle(kind: 'mic' | 'screen') {
    const r = room.current;
    if (!r || busy) return;
    const current = epoch.current;
    setBusy(true);
    setError('');
    try {
      if (kind === 'mic') {
        await r.localParticipant.setMicrophoneEnabled(!r.localParticipant.isMicrophoneEnabled, buildMicrophoneCaptureOptions(audioQualityRef.current), buildMicrophonePublishOptions(audioQualityRef.current));
        if (room.current !== r || epoch.current !== current) { closeRoom(r); return; }
        if (r.localParticipant.isMicrophoneEnabled) await applyAudioQuality(r, audioQualityRef.current);
      } else await r.localParticipant.setScreenShareEnabled(!r.localParticipant.isScreenShareEnabled, buildScreenCaptureOptions(screenQualityRef.current), buildScreenPublishOptions(screenQualityRef.current));
      if (room.current !== r || epoch.current !== current) { closeRoom(r); return; }
      update(r);
    } catch (e: any) {
      if (room.current === r && epoch.current === current)
        setError(e.name === 'NotAllowedError' ? (kind === 'screen' ? '已取消屏幕分享或未授予权限，可再次尝试。' : '麦克风权限未获允许，请修改浏览器权限后重试。') : e.message || '设备操作失败');
    } finally {
      if (room.current === r && epoch.current === current) setBusy(false);
    }
  }
  async function changeQuality(kind: 'screen' | 'audio', value: ScreenQuality | AudioQuality) {
    if (busy) return;
    const r = room.current;
    const current = epoch.current;
    setError('');
    setQualityNotice('');
    setBusy(true);
    try {
      const publication = r?.localParticipant.getTrackPublication(kind === 'screen' ? Track.Source.ScreenShare : Track.Source.Microphone);
      if (r && publication?.track && kind === 'audio' && audioNeedsRepublish(audioQualityRef.current, value as AudioQuality)) {
        // A muted microphone is only unpublished; it is captured again with the new profile when turned back on.
        const muted = publication.isMuted;
        await r.localParticipant.unpublishTrack(publication.track);
        if (room.current !== r || epoch.current !== current) return;
        if (!muted) {
          await r.localParticipant.setMicrophoneEnabled(true, buildMicrophoneCaptureOptions(value as AudioQuality), buildMicrophonePublishOptions(value as AudioQuality));
          if (room.current !== r || epoch.current !== current) return;
          const applied = await applyAudioQuality(r, value as AudioQuality);
          if (room.current !== r || epoch.current !== current) return;
          if (!applied.publishApplied) throw new Error('当前浏览器无法调整音频编码参数，请重新加入后设置档位。');
        }
      } else if (r && publication?.track) {
        const applied = kind === 'screen'
          ? await applyScreenQuality(r, value as ScreenQuality)
          : await applyAudioQuality(r, value as AudioQuality);
        if (room.current !== r || epoch.current !== current) return;
        if (!applied.publishApplied) throw new Error('当前浏览器无法动态调整编码参数，请重新加入后设置档位。');
        if (kind === 'screen' && !applied.captureApplied)
          setQualityNotice('编码参数已调整；当前浏览器无法动态调整采集分辨率，重新分享时会应用所选画质。');
      }
      if (epoch.current !== current) return;
      if (kind === 'screen') {
        screenQualityRef.current = value as ScreenQuality;
        setScreenQuality(value as ScreenQuality);
        saveQuality('voice-hub.screen-quality', value);
      } else {
        audioQualityRef.current = value as AudioQuality;
        setAudioQuality(value as AudioQuality);
        saveQuality('voice-hub.audio-quality', value);
        if (isStereoAudio(value as AudioQuality))
          setQualityNotice('立体声高码率模式关闭了回声消除、降噪和自动增益，请佩戴耳机，避免对方听到回声。');
      }
      if (r) update(r);
    } catch (e: any) {
      if (epoch.current === current) setError(e.message || '档位调整失败，请重试。');
    } finally {
      if (epoch.current === current) setBusy(false);
    }
  }
  function toggleDeaf() {
    deaf.current = !deaf.current;
    for (const [track, elements] of media.current)
      if (track.kind === Track.Kind.Audio) elements.forEach(e => { e.muted = deaf.current; });
    if (room.current) update(room.current);
  }
  async function enableAudio() {
    const r = room.current;
    if (!r) return;
    try {
      await r.startAudio();
      for (const [track, elements] of media.current)
        if (track.kind === Track.Kind.Audio) await Promise.all(elements.map(e => e.play()));
      if (room.current === r) setBlocked(false);
    } catch { if (room.current === r) setError('浏览器仍阻止声音播放，请再次点击启用声音。'); }
  }

  const connected = view.status === 'connected' || view.status === 'reconnecting' || view.status === 'signalReconnecting';
  const stateLabel = view.status === 'connected' ? '已连接'
    : view.status === 'connecting' ? '连接中'
    : connected ? '重连中' : '未连接';
  return <div className="voice">
    <div className="voicehead">
      <div><small>● 语音频道 · {stateLabel}</small><h2>{ch.name}</h2>
        <p>{connected ? '频道中 ' + view.people.length + ' 人 · WebRTC 加密传输' : '加入后即可和社区成员语音聊天'}</p></div>
      {view.status === 'disconnected'
        ? <button onClick={connect}>加入语音</button>
        : <button className="danger" onClick={() => dispose()}>{connected ? '离开语音' : '取消连接'}</button>}
    </div>
    <div className="media-quality">
      <label>屏幕分享画质
        <select aria-label="屏幕分享画质" value={screenQuality} disabled={busy || view.status === 'connecting' || view.status === 'reconnecting'}
          onChange={event => { void changeQuality('screen', event.target.value as ScreenQuality); }}>
          {screenProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label} · {profile.description}</option>)}
        </select>
      </label>
      <label>麦克风音质
        <select aria-label="麦克风音质" value={audioQuality} disabled={busy || view.status === 'connecting' || view.status === 'reconnecting'}
          onChange={event => { void changeQuality('audio', event.target.value as AudioQuality); }}>
          {audioProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label} · {profile.description}</option>)}
        </select>
      </label>
      <small>{busy ? '正在调整…' : '可在通话中切换；实际画质取决于分享源、浏览器和网络。'}</small>
      {qualityNotice && <small role="status">{qualityNotice}</small>}
    </div>
    <div className="stage">
      {view.screens === 0 && <small>屏幕分享将在这里显示</small>}
      <div ref={screenHost} className="screen-tracks" />
    </div>
    <div ref={audioHost} className="audio-host" />
    {blocked && <button onClick={enableAudio}>启用声音</button>}
    {error && <div role="alert" className="error">{error}</div>}
    {view.people.map(p => <div className="voicebar" key={p.id}>
      <div className={'avatar big' + (p.speaking ? ' talking' : '')}>{p.self ? '我' : p.name[0]}</div>
      <span>{p.name}{p.self ? '（我）' : ''} · {p.muted ? '麦克风静音' : p.speaking ? '正在说话' : '已连接'}</span>
    </div>)}
    {connected && <div className="controls">
      <button disabled={busy} onClick={() => toggle('mic')} aria-label={view.mic ? '关闭麦克风' : '开启麦克风'}>{view.mic ? '关闭麦克风' : '开启麦克风'}</button>
      <button onClick={toggleDeaf} aria-label={view.deaf ? '恢复收听' : '静音收听'}>{view.deaf ? '恢复收听' : '静音收听'}</button>
      <button disabled={busy} onClick={() => toggle('screen')} aria-label={view.screen ? '停止分享' : '分享屏幕'}>{view.screen ? '停止分享' : '分享屏幕'}</button>
    </div>}
  </div>;
}
