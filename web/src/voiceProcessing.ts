/// <reference types="vite/client" />
// Microphone processing that runs in each member's browser before encoding, so the server does no audio work.
import { Track, type AudioProcessorOptions, type TrackProcessor } from 'livekit-client';
import { GtcrnWorkletNode, RnnoiseWorkletNode, loadGtcrn, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import gtcrnWorklet from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';

export type NoiseMode = 'off' | 'browser' | 'rnnoise' | 'gtcrn';
export const noiseModes: readonly { id: NoiseMode; label: string; description: string }[] = [
  { id: 'off', label: '关闭', description: '保留原始声音' },
  { id: 'browser', label: '标准', description: '浏览器内置降噪' },
  { id: 'rnnoise', label: 'AI 降噪', description: 'RNNoise · 占用低' },
  { id: 'gtcrn', label: 'AI 强力降噪', description: 'GTCRN · 效果更好' },
];
export const isAiNoise = (mode: NoiseMode) => mode === 'rnnoise' || mode === 'gtcrn';

// One 48 kHz context for the page: both models expect 48 kHz, and Chrome limits how many contexts can exist.
let sharedContext: AudioContext | null = null;
export function voiceAudioContext() {
  if (!sharedContext || sharedContext.state === 'closed')
    sharedContext = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
  if (sharedContext.state === 'suspended') void sharedContext.resume().catch(() => {});
  return sharedContext;
}

const modules = new WeakMap<AudioContext, Map<string, Promise<void>>>();
function addModule(ctx: AudioContext, url: string) {
  let loaded = modules.get(ctx);
  if (!loaded) modules.set(ctx, (loaded = new Map()));
  let pending = loaded.get(url);
  if (!pending) {
    pending = ctx.audioWorklet.addModule(url);
    pending.catch(() => loaded!.delete(url));
    loaded.set(url, pending);
  }
  return pending;
}
const binaries = new Map<string, Promise<ArrayBuffer>>();
function wasm(model: 'rnnoise' | 'gtcrn') {
  let pending = binaries.get(model);
  if (!pending) {
    pending = model === 'rnnoise' ? loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }) : loadGtcrn({ url: gtcrnWasm });
    pending.catch(() => binaries.delete(model));
    binaries.set(model, pending);
  }
  return pending;
}

const db = (value: number) => Math.pow(10, value / 20);

/**
 * high-pass → optional AI noise suppression → optional voice emphasis (EQ, compressor, limiter).
 * LiveKit swaps the processed track into the sender and restarts the chain when the input device changes.
 */
export class VoiceProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'voice-hub-voice';
  processedTrack?: MediaStreamTrack;
  private nodes: AudioNode[] = [];
  private suppressor?: RnnoiseWorkletNode | GtcrnWorkletNode;
  private context?: AudioContext;

  constructor(
    readonly noise: NoiseMode,
    readonly boost: boolean,
  ) {}

  async init({ track, audioContext }: AudioProcessorOptions) {
    // LiveKit's restart() (device switch, restartTrack) does not pass the context again, so keep the first one.
    const ctx = (this.context = audioContext ?? this.context ?? voiceAudioContext());
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.nodes.push(source);
    let tail: AudioNode = source;
    const add = <T extends AudioNode>(node: T) => {
      tail.connect(node);
      this.nodes.push(node);
      tail = node;
      return node;
    };
    const filter = (type: BiquadFilterType, frequency: number, gain = 0, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.gain.value = gain;
      f.Q.value = q;
      return add(f);
    };

    filter('highpass', 80); // desk thumps, HVAC and handling rumble
    if (this.noise === 'rnnoise' || this.noise === 'gtcrn') {
      const [binary] = await Promise.all([
        wasm(this.noise),
        addModule(ctx, this.noise === 'rnnoise' ? rnnoiseWorklet : gtcrnWorklet),
      ]);
      this.suppressor =
        this.noise === 'rnnoise'
          ? new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary })
          : new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
      add(this.suppressor);
    }
    if (this.boost) {
      filter('peaking', 250, -2.5, 1); // muddiness from small rooms and close mics
      filter('peaking', 3200, 4, 0.9); // consonant presence, where speech intelligibility lives
      filter('highshelf', 9000, 1.5); // a little air
      const compressor = add(ctx.createDynamicsCompressor());
      compressor.threshold.value = -26;
      compressor.knee.value = 10;
      compressor.ratio.value = 3.5;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.2;
      const makeup = add(ctx.createGain());
      makeup.gain.value = db(5);
      const limiter = add(ctx.createDynamicsCompressor());
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;
    }
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    tail.connect(destination);
    this.nodes.push(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  async restart(options: AudioProcessorOptions) {
    await this.destroy();
    await this.init(options);
  }

  async destroy() {
    for (const node of this.nodes) node.disconnect();
    this.suppressor?.destroy();
    this.processedTrack?.stop();
    this.nodes = [];
    this.suppressor = undefined;
    this.processedTrack = undefined;
  }
}
