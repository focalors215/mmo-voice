import { useCallback, useEffect, useRef, useState } from 'react';
import { DisconnectReason, LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import {
  screenProfiles, audioProfiles, applyScreenQuality, applyAudioQuality,
  buildScreenCaptureOptions, buildScreenPublishOptions,
  buildMicrophoneCaptureOptions, buildMicrophonePublishOptions, audioNeedsRepublish, isStereoAudio,
  type ScreenQuality, type AudioQuality,
} from './mediaQuality';
import { VoiceProcessor, isAiNoise, noiseModes, voiceAudioContext, type NoiseMode } from './voiceProcessing';
import MicTest, { type TestSource } from './MicTest';

function savedQuality<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch { return fallback; }
}
function saveQuality(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
}
function savedString(key: string) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
const deviceLabel = (d: MediaDeviceInfo, i: number) => d.label || (d.kind === 'audioinput' ? '麦克风 ' : '扬声器 ') + (i + 1);


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
  const [noise, setNoise] = useState<NoiseMode>(() => savedQuality('voice-hub.noise', noiseModes.map(m => m.id), 'browser'));
  const [boost, setBoost] = useState(() => savedString('voice-hub.voice-boost') === '1');
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState(() => savedString('voice-hub.audio-input'));
  const [outputId, setOutputId] = useState(() => savedString('voice-hub.audio-output'));
  const noiseRef = useRef(noise);
  const boostRef = useRef(boost);
  const inputRef = useRef(inputId);
  const outputRef = useRef(outputId);

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


  const refreshDevices = useCallback(async () => {
    try {
      const all = (await navigator.mediaDevices?.enumerateDevices()) ?? [];
      // Chrome adds 'default'/'communications' aliases; the 系统默认 option already covers them.
      const real = (kind: MediaDeviceKind) => all.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
      setInputs(real('audioinput'));
      setOutputs(real('audiooutput'));
    } catch { /* device listing is optional */ }
  }, []);
  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

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
  // Browser noise suppression is a capture constraint; the AI modes and voice emphasis run in VoiceProcessor instead.
  function micCapture(quality: AudioQuality = audioQualityRef.current) {
    const options = buildMicrophoneCaptureOptions(quality);
    if (!isStereoAudio(quality)) options.noiseSuppression = noiseRef.current === 'browser';
    if (inputRef.current) options.deviceId = inputRef.current;
    return options;
  }
  function applyAudio(r: Room, quality: AudioQuality) {
    return applyAudioQuality(r, quality, isStereoAudio(quality) ? {} : { noiseSuppression: noiseRef.current === 'browser' });
  }
  function micTrack(r: Room) {
    const track = r.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    return track instanceof LocalAudioTrack ? track : null;
  }
  async function syncProcessor(r: Room) {
    const track = micTrack(r);
    if (!track) return;
    const mode = noiseRef.current, wantBoost = boostRef.current;
    if (isStereoAudio(audioQualityRef.current) || (!isAiNoise(mode) && !wantBoost)) {
      if (track.getProcessor()) await track.stopProcessor();
      return;
    }
    const current = track.getProcessor();
    const wantNoise = isAiNoise(mode) ? mode : 'off';
    if (current instanceof VoiceProcessor && current.noise === wantNoise && current.boost === wantBoost) return;
    track.setAudioContext(voiceAudioContext());
    await track.setProcessor(new VoiceProcessor(wantNoise, wantBoost));
  }
  async function safeSync(r: Room) {
    try {
      await syncProcessor(r);
    } catch (e: any) {
      try { await micTrack(r)?.stopProcessor(); } catch { /* already plain */ }
      if (room.current === r) setError('此浏览器无法启用 AI 降噪或人声凸显，已使用原始麦克风：' + (e?.message || '未知错误'));
    }
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
      r = new Room({
        adaptiveStream: true, dynacast: true,
        audioOutput: canPickOutput && outputRef.current ? { deviceId: outputRef.current } : undefined,
      });
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
          if (joined.localParticipant.getTrackPublication(Track.Source.Microphone)?.track) {
            await applyAudio(joined, audioQualityRef.current);
            await safeSync(joined);
          }
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
        await joined.localParticipant.setMicrophoneEnabled(true, micCapture(), buildMicrophonePublishOptions(audioQualityRef.current));
        micReady = true;
        void refreshDevices(); // labels become available once permission is granted
      } catch (e: any) {
        if (guard()) setError(e.name === 'NotAllowedError' ? '麦克风权限未获允许，已以仅收听方式加入；修改浏览器权限后可点击“开启麦克风”。' : '麦克风无法使用，已以仅收听方式加入：' + (e.message || '未知错误'));
      }
      if (!guard()) { closeRoom(joined); return; }
      if (micReady) {
        await applyAudio(joined, audioQualityRef.current);
        if (guard()) await safeSync(joined);
      }
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
        await r.localParticipant.setMicrophoneEnabled(!r.localParticipant.isMicrophoneEnabled, micCapture(), buildMicrophonePublishOptions(audioQualityRef.current));
        if (room.current !== r || epoch.current !== current) { closeRoom(r); return; }
        if (r.localParticipant.isMicrophoneEnabled) {
          await applyAudio(r, audioQualityRef.current);
          await safeSync(r);
        }
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
          await r.localParticipant.setMicrophoneEnabled(true, micCapture(value as AudioQuality), buildMicrophonePublishOptions(value as AudioQuality));
          if (room.current !== r || epoch.current !== current) return;
          const applied = await applyAudio(r, value as AudioQuality);
          if (room.current !== r || epoch.current !== current) return;
          if (!applied.publishApplied) throw new Error('当前浏览器无法调整音频编码参数，请重新加入后设置档位。');
        }
      } else if (r && publication?.track) {
        const applied = kind === 'screen'
          ? await applyScreenQuality(r, value as ScreenQuality)
          : await applyAudio(r, value as AudioQuality);
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
      if (r && kind === 'audio' && room.current === r) await safeSync(r);
      if (r) update(r);
    } catch (e: any) {
      if (epoch.current === current) setError(e.message || '档位调整失败，请重试。');
    } finally {
      if (epoch.current === current) setBusy(false);
    }
  }
  async function changeNoise(next: NoiseMode) {
    const previous = noiseRef.current;
    noiseRef.current = next;
    setNoise(next);
    saveQuality('voice-hub.noise', next);
    if (isAiNoise(next)) voiceAudioContext(); // create/resume inside the click
    const r = room.current, track = r && micTrack(r);
    if (!r || !track || isStereoAudio(audioQualityRef.current)) return;
    setBusy(true);
    setError('');
    try {
      if ((previous === 'browser') !== (next === 'browser')) {
        // The browser's own suppression is fixed at capture; a muted mic is recaptured when turned back on.
        if (track.isMuted) await r.localParticipant.unpublishTrack(track);
        else await track.restartTrack(micCapture());
      }
      if (room.current === r) await safeSync(r);
      if (room.current === r) update(r);
    } catch (e: any) {
      if (room.current === r) setError(e.message || '降噪设置失败，请重试。');
    } finally {
      if (room.current === r) setBusy(false);
    }
  }
  async function changeBoost(next: boolean) {
    boostRef.current = next;
    setBoost(next);
    saveQuality('voice-hub.voice-boost', next ? '1' : '0');
    if (next) voiceAudioContext();
    const r = room.current;
    if (r && micTrack(r)) await safeSync(r);
  }
  async function changeDevice(kind: 'audioinput' | 'audiooutput', id: string) {
    const ref = kind === 'audioinput' ? inputRef : outputRef;
    const previous = ref.current;
    ref.current = id;
    (kind === 'audioinput' ? setInputId : setOutputId)(id);
    saveQuality(kind === 'audioinput' ? 'voice-hub.audio-input' : 'voice-hub.audio-output', id);
    const r = room.current;
    if (!r || (kind === 'audioinput' && !micTrack(r))) return;
    const list = kind === 'audioinput' ? inputs : outputs;
    // 系统默认: Chrome exposes a 'default' device; other browsers fall back to the first listed one.
    const target = id || ((await navigator.mediaDevices.enumerateDevices()).some(d => d.kind === kind && d.deviceId === 'default') ? 'default' : list[0]?.deviceId);
    if (!target) return;
    try {
      await r.switchActiveDevice(kind, target);
    } catch (e: any) {
      ref.current = previous;
      (kind === 'audioinput' ? setInputId : setOutputId)(previous);
      if (room.current === r) setError((kind === 'audioinput' ? '无法切换麦克风：' : '无法切换扬声器：') + (e.message || '设备不可用'));
    }
  }
  // The loopback test hears what would be sent: the live (processed) track in a call, otherwise a capture with the same settings.
  async function testSource(): Promise<TestSource> {
    const r = room.current, live = r && micTrack(r);
    if (live && !live.isMuted && live.mediaStreamTrack.readyState === 'live') {
      const track = live.mediaStreamTrack.clone();
      return { track, release: () => track.stop(), live: true };
    }
    const { deviceId, channelCount, sampleRate, echoCancellation, noiseSuppression, autoGainControl } = micCapture();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { ideal: deviceId as string } : undefined, channelCount, sampleRate, echoCancellation, noiseSuppression, autoGainControl },
    });
    const raw = stream.getAudioTracks()[0];
    void refreshDevices(); // permission may have just been granted
    const mode = noiseRef.current, wantBoost = boostRef.current;
    if (isStereoAudio(audioQualityRef.current) || (!isAiNoise(mode) && !wantBoost)) return { track: raw, release: () => raw.stop(), live: false };
    const processor = new VoiceProcessor(isAiNoise(mode) ? mode : 'off', wantBoost);
    try {
      await processor.init({ kind: Track.Kind.Audio, track: raw, audioContext: voiceAudioContext() });
    } catch (e) {
      raw.stop();
      throw e;
    }
    return { track: processor.processedTrack!, release: () => { void processor.destroy(); raw.stop(); }, live: false };
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
    <details className="audio-settings">
      <summary>
        <span>声音与设备</span>
        <small>{noiseModes.find(m => m.id === noise)?.label}{boost ? ' · 人声凸显' : ''}</small>
      </summary>
      <div className="audio-settings-grid">
        <label>麦克风
          <select aria-label="麦克风设备" value={inputs.some(d => d.deviceId === inputId) ? inputId : ''} onChange={event => { void changeDevice('audioinput', event.target.value); }}>
            <option value="">系统默认</option>
            {inputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{deviceLabel(d, i)}</option>)}
          </select>
        </label>
        {canPickOutput
          ? <label>扬声器
              <select aria-label="扬声器设备" value={outputs.some(d => d.deviceId === outputId) ? outputId : ''} onChange={event => { void changeDevice('audiooutput', event.target.value); }}>
                <option value="">系统默认</option>
                {outputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{deviceLabel(d, i)}</option>)}
              </select>
            </label>
          : <p className="audio-settings-note">此浏览器不支持在网页中选择扬声器，请在系统声音设置中切换。</p>}
        <label>降噪
          <select aria-label="降噪" value={noise} disabled={busy} onChange={event => { void changeNoise(event.target.value as NoiseMode); }}>
            {noiseModes.map(m => <option key={m.id} value={m.id}>{m.label} · {m.description}</option>)}
          </select>
        </label>
        <label className="switch-row">
          <span>人声凸显<small>压低低频轰鸣与浑浊感，突出咬字并稳定音量</small></span>
          <input type="checkbox" role="switch" aria-label="人声凸显" checked={boost} onChange={event => { void changeBoost(event.target.checked); }} />
        </label>
      </div>
      <MicTest
        getSource={testSource}
        bitrate={audioProfiles.find(p => p.id === audioQuality)?.bitrate ?? 48_000}
        outputId={outputId}
        disabled={!secure || busy}
      />
      {inputs.length > 0 && inputs.every(d => !d.label) && <small className="audio-settings-note">加入语音并允许麦克风后会显示设备名称。</small>}
      {isStereoAudio(audioQuality) && <small className="audio-settings-note">当前为立体声音乐档位，降噪与人声凸显不生效。</small>}
    </details>
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
