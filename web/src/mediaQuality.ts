import {
  AudioPresets,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  Track,
  type AudioCaptureOptions,
  type AudioPreset,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoEncoding,
  type VideoResolution,
} from 'livekit-client';

export type ScreenQuality = 'data' | 'standard' | 'high' | 'ultra';
export type AudioQuality = 'data' | 'standard' | 'high' | 'hifi' | 'max';
export type QualityProfile<T extends string> = { id: T; label: string; description: string };
type ScreenProfile = QualityProfile<ScreenQuality> & { resolution: VideoResolution; encoding: VideoEncoding };
type AudioProfile = QualityProfile<AudioQuality> & { bitrate: number; stereo: boolean; capture: AudioCaptureOptions; preset: AudioPreset };

export const screenProfiles: readonly ScreenProfile[] = [
  { id: 'data', label: '省流', description: '最高 360p · 15 fps · 400 kbps', resolution: { width: 640, height: 360, frameRate: 15 }, encoding: { maxBitrate: 400_000, maxFramerate: 15 } },
  { id: 'standard', label: '标准', description: '最高 720p · 30 fps · 1.5 Mbps', resolution: { width: 1280, height: 720, frameRate: 30 }, encoding: { maxBitrate: 1_500_000, maxFramerate: 30 } },
  { id: 'high', label: '高清', description: '最高 1080p · 30 fps · 3 Mbps', resolution: { width: 1920, height: 1080, frameRate: 30 }, encoding: { maxBitrate: 3_000_000, maxFramerate: 30 } },
  { id: 'ultra', label: '超清', description: '最高 1440p · 30 fps · 6 Mbps', resolution: { width: 2560, height: 1440, frameRate: 30 }, encoding: { maxBitrate: 6_000_000, maxFramerate: 30 } },
];
export const audioProfiles: readonly AudioProfile[] = [
  { id: 'data', label: '省流', description: 'Opus 单声道 · 24 kbps', bitrate: 24_000, stereo: false, capture: { channelCount: 1, sampleRate: 16_000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, preset: AudioPresets.speech },
  { id: 'standard', label: '标准', description: 'Opus 单声道 · 48 kbps', bitrate: 48_000, stereo: false, capture: { channelCount: 1, sampleRate: 48_000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, preset: AudioPresets.music },
  { id: 'high', label: '高音质', description: 'Opus 单声道 · 96 kbps', bitrate: 96_000, stereo: false, capture: { channelCount: 1, sampleRate: 48_000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, preset: AudioPresets.musicHighQuality },
  // Music profiles: stereo Opus with browser voice processing off, so the signal reaches the encoder untouched.
  { id: 'hifi', label: '高保真', description: 'Opus 立体声 · 192 kbps · 需佩戴耳机', bitrate: 192_000, stereo: true, capture: { channelCount: 2, sampleRate: 48_000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, preset: { maxBitrate: 192_000 } },
  { id: 'max', label: '极致', description: 'Opus 立体声 · 320 kbps · 需佩戴耳机', bitrate: 320_000, stereo: true, capture: { channelCount: 2, sampleRate: 48_000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, preset: { maxBitrate: 320_000 } },
];
export const SCREEN_QUALITY_PROFILES = screenProfiles;
export const AUDIO_QUALITY_PROFILES = audioProfiles;
const screenProfile = (quality: ScreenQuality) => screenProfiles.find(p => p.id === quality) ?? screenProfiles[1];
const audioProfile = (quality: AudioQuality) => audioProfiles.find(p => p.id === quality) ?? audioProfiles[1];

export function buildScreenCaptureOptions(quality: ScreenQuality): ScreenShareCaptureOptions {
  const p = screenProfile(quality);
  return { audio: true, video: true, resolution: p.resolution, contentHint: 'text', systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' };
}
export function buildScreenPublishOptions(quality: ScreenQuality): TrackPublishOptions {
  const p = screenProfile(quality);
  return { source: Track.Source.ScreenShare, screenShareEncoding: p.encoding, degradationPreference: 'maintain-resolution', simulcast: false };
}
export function buildMicrophoneCaptureOptions(quality: AudioQuality): AudioCaptureOptions { return { ...audioProfile(quality).capture }; }
export function buildMicrophonePublishOptions(quality: AudioQuality): TrackPublishOptions {
  const p = audioProfile(quality);
  // DTX and RED would cut or duplicate a constant music stream, so stereo profiles turn them off.
  return p.stereo
    ? { source: Track.Source.Microphone, audioPreset: p.preset, dtx: false, red: false, forceStereo: true }
    : { source: Track.Source.Microphone, audioPreset: p.preset, dtx: true, red: true, forceStereo: false };
}
export const isStereoAudio = (quality: AudioQuality) => audioProfile(quality).stereo;
// Channel count and voice processing are fixed when a track is captured and negotiated, so switching between
// mono and stereo profiles needs the microphone track to be published again.
export const audioNeedsRepublish = (from: AudioQuality, to: AudioQuality) => isStereoAudio(from) !== isStereoAudio(to);
export type AppliedQualityResult = { source: Track.Source; quality: string; captureApplied: boolean; publishApplied: boolean };

async function applySenderBitrate(track: LocalVideoTrack | LocalAudioTrack, maxBitrate: number, maxFramerate?: number) {
  const sender = track.sender;
  if (!sender?.getParameters || !sender.setParameters) return false;
  const previous = sender.getParameters();
  const encodings = (previous.encodings ?? []).map(encoding => ({ ...encoding, maxBitrate, ...(maxFramerate ? { maxFramerate } : {}) }));
  if (!encodings.length) encodings.push({ maxBitrate, ...(maxFramerate ? { maxFramerate } : {}) });
  try { await sender.setParameters({ ...previous, encodings }); return true; }
  catch (error) { try { await sender.setParameters(previous); } catch { /* preserve original error */ } throw error; }
}
// A profile change is all-or-nothing: if the encoder cannot follow, capture goes back to what it was.
async function revertConstraints(track: LocalVideoTrack | LocalAudioTrack, constraints: MediaTrackConstraints) {
  try { await track.mediaStreamTrack.applyConstraints(constraints); } catch { /* best effort */ }
}
export async function applyScreenQuality(room: Room, quality: ScreenQuality): Promise<AppliedQualityResult> {
  const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const track = publication?.track;
  if (!(track instanceof LocalVideoTrack)) throw new Error('当前没有正在发布的屏幕分享');
  const p = screenProfile(quality);
  const previousConstraints = track.mediaStreamTrack.getConstraints();
  let captureApplied = false;
  try {
    await track.mediaStreamTrack.applyConstraints({ width: { ideal: p.resolution.width, max: p.resolution.width }, height: { ideal: p.resolution.height, max: p.resolution.height }, frameRate: { ideal: p.resolution.frameRate, max: p.resolution.frameRate } });
    captureApplied = true;
  } catch { /* display capture constraints can be immutable */ }
  try {
    const publishApplied = await applySenderBitrate(track, p.encoding.maxBitrate, p.encoding.maxFramerate);
    if (!publishApplied && captureApplied) await revertConstraints(track, previousConstraints);
    return { source: Track.Source.ScreenShare, quality, captureApplied: captureApplied && publishApplied, publishApplied };
  } catch (error) {
    if (captureApplied) { try { await track.mediaStreamTrack.applyConstraints(previousConstraints); } catch { /* retain original error */ } }
    throw error;
  }
}
export async function applyAudioQuality(room: Room, quality: AudioQuality): Promise<AppliedQualityResult> {
  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = publication?.track;
  if (!(track instanceof LocalAudioTrack)) throw new Error('当前没有正在发布的麦克风');
  const p = audioProfile(quality);
  const previousConstraints = track.mediaStreamTrack.getConstraints();
  let captureApplied = false;
  try { await track.mediaStreamTrack.applyConstraints({ ...p.capture }); captureApplied = true; } catch { /* unsupported constraints do not interrupt calls */ }
  try {
    const publishApplied = await applySenderBitrate(track, p.bitrate);
    if (!publishApplied && captureApplied) await revertConstraints(track, previousConstraints);
    return { source: Track.Source.Microphone, quality, captureApplied: captureApplied && publishApplied, publishApplied };
  } catch (error) {
    if (captureApplied) { try { await track.mediaStreamTrack.applyConstraints(previousConstraints); } catch { /* retain original error */ } }
    throw error;
  }
}
