import { useEffect, useRef, useState } from 'react';
import { voiceAudioContext } from './voiceProcessing';

/** A microphone track to test with, and how to give it back. */
export type TestSource = { track: MediaStreamTrack; release: () => void; live: boolean };
type Props = {
  /** Resolves the track exactly as it would be sent: the live sending track in a call, otherwise a matching capture. */
  getSource: () => Promise<TestSource>;
  bitrate: number;
  outputId: string;
  disabled?: boolean;
};
type Mode = 'idle' | 'recording' | 'playing' | 'monitoring';
const RECORD_SECONDS = 5;

function recorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'])
    if (MediaRecorder.isTypeSupported(type)) return type;
  return '';
}
async function routeTo(el: HTMLAudioElement, outputId: string) {
  const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (outputId && sink.setSinkId) await sink.setSinkId(outputId).catch(() => {});
}

/** Loopback test: record-and-play (safe on speakers) or live monitoring (headphones). */
export default function MicTest({ getSource, bitrate, outputId, disabled }: Props) {
  const [mode, setMode] = useState<Mode>('idle');
  const [left, setLeft] = useState(0);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState('');
  const run = useRef(0);
  const cleanup = useRef<(() => void)[]>([]);
  const audio = useRef<HTMLAudioElement>(null);

  function stop() {
    run.current++;
    for (const fn of cleanup.current.splice(0)) {
      try { fn(); } catch { /* best effort */ }
    }
    const el = audio.current;
    if (el) {
      el.pause();
      el.srcObject = null;
      el.removeAttribute('src');
    }
    setMode('idle');
    setLevel(0);
    setLeft(0);
  }
  useEffect(() => stop, []);

  // Peak meter on the tested track, in a 0..1 scale mapped from -60..0 dBFS.
  function meter(track: MediaStreamTrack) {
    const ctx = voiceAudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      const dbfs = 20 * Math.log10(peak || 1e-6);
      setLevel(Math.max(0, Math.min(1, (dbfs + 60) / 60)));
      frame = requestAnimationFrame(tick);
    };
    tick();
    cleanup.current.push(() => {
      cancelAnimationFrame(frame);
      src.disconnect();
    });
  }

  async function begin(next: 'recording' | 'monitoring') {
    stop();
    const id = run.current;
    setNote('');
    voiceAudioContext(); // inside the click, so playback and processing are allowed to start
    let source: TestSource;
    try {
      source = await getSource();
    } catch (e: any) {
      setNote(e?.name === 'NotAllowedError' ? '需要允许麦克风权限才能测试。' : '无法打开麦克风：' + (e?.message || '未知错误'));
      return;
    }
    if (run.current !== id) return source.release();
    cleanup.current.push(source.release);
    meter(source.track);
    const el = audio.current!;
    await routeTo(el, outputId);
    if (next === 'monitoring') {
      el.srcObject = new MediaStream([source.track]);
      el.muted = false;
      await el.play().catch(() => setNote('浏览器阻止了播放，请再点一次。'));
      setMode('monitoring');
      if (source.live) setNote('正在监听你发送给频道的声音。');
      return;
    }
    const type = recorderType();
    if (type === null) {
      setNote('此浏览器不支持录音回放，可以使用实时监听。');
      return stop();
    }
    const chunks: Blob[] = [];
    // Encoding at the selected bitrate makes the playback close to what others receive.
    const recorder = new MediaRecorder(new MediaStream([source.track]), { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: bitrate });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const finished = new Promise<void>((done) => (recorder.onstop = () => done()));
    recorder.start(250);
    setMode('recording');
    setLeft(RECORD_SECONDS);
    const started = Date.now();
    const countdown = setInterval(() => setLeft(Math.max(0, RECORD_SECONDS - Math.floor((Date.now() - started) / 1000))), 200);
    const timer = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), RECORD_SECONDS * 1000);
    cleanup.current.push(() => {
      clearInterval(countdown);
      clearTimeout(timer);
      if (recorder.state !== 'inactive') recorder.stop();
    });
    await finished;
    if (run.current !== id) return;
    clearInterval(countdown);
    for (const fn of cleanup.current.splice(0)) fn(); // release the mic before playing back
    setLevel(0);
    const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' }));
    cleanup.current.push(() => URL.revokeObjectURL(url));
    el.srcObject = null;
    el.src = url;
    el.muted = false;
    el.onended = () => run.current === id && stop();
    setMode('playing');
    await el.play().catch(() => {
      setNote('浏览器阻止了播放，请再点一次。');
      stop();
    });
  }

  return (
    <div className="mic-test" data-mode={mode}>
      <div className="mic-test-head">
        <span>
          声音测试
          <small>
            {mode === 'recording'
              ? `正在录音，${left} 秒后回放…`
              : mode === 'playing'
                ? '正在回放，这就是对方大致会听到的声音'
                : mode === 'monitoring'
                  ? '实时监听中，请佩戴耳机以免啸叫'
                  : '用当前的麦克风、降噪和音质设置听听自己'}
          </small>
        </span>
      </div>
      <div className="mic-meter" role="meter" aria-label="麦克风音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} data-level={level.toFixed(3)}>
        <span style={{ transform: `scaleX(${level})` }} />
      </div>
      <div className="mic-test-actions">
        {mode === 'idle' ? (
          <>
            <button type="button" className="secondary" disabled={disabled} onClick={() => void begin('recording')}>
              录音 {RECORD_SECONDS} 秒并回放
            </button>
            <button type="button" className="ghost" disabled={disabled} onClick={() => void begin('monitoring')}>
              实时监听
            </button>
          </>
        ) : (
          <button type="button" className="secondary" onClick={stop}>
            {mode === 'monitoring' ? '停止监听' : mode === 'recording' ? '取消录音' : '停止回放'}
          </button>
        )}
      </div>
      {note && <small className="audio-settings-note" role="status">{note}</small>}
      <audio ref={audio} className="mic-test-audio" hidden />
    </div>
  );
}
