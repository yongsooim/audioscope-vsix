// Type-only contract between the audioscope extension host and the webview.
// Both sides import from this module to avoid drift between handler shapes.
// Do not add runtime code or vscode dependencies here.

export interface ExternalToolStatusPayload {
  resolved: boolean;
  canDecodeFallback: boolean;
  canReadMetadata: boolean;
  ffmpegAvailable: boolean;
  ffmpegCommand: string;
  ffmpegVersion: string | null;
  ffprobeAvailable: boolean;
  ffprobeCommand: string;
  ffprobeVersion: string | null;
  fileBacked: boolean;
  guidance: string;
}

export interface SpectrogramDefaultsPayload {
  analysisType: 'chroma' | 'loudness' | 'mel' | 'mfcc' | 'scalogram' | 'spectrogram';
  colormapDistribution: 'balanced' | 'contrast' | 'soft';
  fftSize: number;
  frequencyScale: 'linear' | 'log' | 'mixed';
  loudnessCurves: 'both' | 'momentary' | 'shortTerm';
  loudnessRefLevel: number | null;
  loudnessShowPeak: boolean;
  loudnessYAxisMax: number;
  loudnessYAxisMin: number;
  loudnessYAxisMode: 'auto' | 'fixed';
  maxDecibels: number;
  melBandCount: number;
  mfccCoefficientCount: number;
  mfccMelBandCount: number;
  minDecibels: number;
  overlapRatio: number;
  scalogramHopSamples: number;
  scalogramMaxFrequency: number;
  scalogramMinFrequency: number;
  scalogramOmega0: number;
  scalogramRowDensity: number;
  windowFunction: 'blackman' | 'hamming' | 'hann' | 'rectangular';
}

export interface AudioscopePayload {
  audioBytes: ArrayBuffer | null;
  documentUri: string;
  externalTools: ExternalToolStatusPayload;
  fileBacked: boolean;
  fileExtension: string;
  fileName: string;
  fileSize: number | null;
  spectrogramDefaults: SpectrogramDefaultsPayload;
  spectrogramQuality: 'balanced' | 'high' | 'max';
  sourceUri: string;
}

export interface MediaMetadataSummaryPayload {
  bitrateText: string | null;
  bitDepthText: string | null;
  channelText: string | null;
  codecText: string | null;
  containerText: string | null;
  durationText: string | null;
  profileText: string | null;
  sampleRateText: string | null;
  segments: string[];
  sizeText: string | null;
}

export interface MediaMetadataStreamPayload {
  bitRateText: string | null;
  bitDepthText: string | null;
  channelLayout: string | null;
  channels: number | null;
  codecLongName: string | null;
  codecName: string | null;
  codecType: string | null;
  dispositionDefault: boolean;
  durationText: string | null;
  index: number | null;
  profileText: string | null;
  sampleFormat: string | null;
  sampleRateText: string | null;
}

export interface MediaMetadataTagPayload {
  key: string;
  value: string;
}

export interface MediaMetadataChapterPayload {
  endText: string | null;
  id: number | null;
  startText: string | null;
  title: string | null;
}

export interface MediaMetadataPayload {
  audioStreamCount: number;
  chapters: MediaMetadataChapterPayload[];
  chaptersCount: number;
  fileBacked: boolean;
  formatLongName: string | null;
  formatName: string | null;
  guidance: string;
  hasAudioStream: boolean;
  probeSource: 'ffprobe';
  streams: MediaMetadataStreamPayload[];
  summary: MediaMetadataSummaryPayload;
  tags: MediaMetadataTagPayload[];
  toolStatus: ExternalToolStatusPayload;
}

export interface LoudnessSummaryPayload {
  channelCount: number | null;
  channelLayout: string | null;
  channelMode: string;
  integratedLufs: number | null;
  integratedThresholdLufs: number | null;
  loudnessRangeLu: number | null;
  lraHighLufs: number | null;
  lraLowLufs: number | null;
  rangeThresholdLufs: number | null;
  samplePeakDbfs: number | null;
  source: 'FFmpeg ebur128';
  truePeakDbtp: number | null;
}

export type DecodeFallbackPayload =
  | {
      audioBuffer: ArrayBuffer;
      byteLength: number;
      kind: 'wav';
      mimeType: string;
      source: 'ffmpeg';
    }
  | {
      byteLength: number;
      channelBuffers: ArrayBuffer[];
      frameCount: number;
      kind: 'pcm';
      numberOfChannels: number;
      sampleRate: number;
      source: 'ffmpeg';
    };

// --- Webview → Host messages ---

export interface ReadyMessage {
  type: 'ready';
}

export interface ReloadMessage {
  type: 'reload';
}

// The webview intentionally omits derived fields (e.g. scalogramHopSamples) when
// persisting; the host fills defaults via normalizeSpectrogramDefaults.
export interface PersistSpectrogramDefaultsMessage {
  type: 'persistSpectrogramDefaults';
  body: Partial<SpectrogramDefaultsPayload>;
}

export interface RequestMediaMetadataMessage {
  type: 'requestMediaMetadata';
  body: { loadToken: number };
}

export interface RequestDecodeFallbackMessage {
  type: 'requestDecodeFallback';
  body: { loadToken: number; reason?: string; sourceUri?: string };
}

export interface RequestLoudnessSummaryMessage {
  type: 'requestLoudnessSummary';
  body: { loadToken: number };
}

export interface OpenExternalMessage {
  type: 'openExternal';
  body: { url: string };
}

export type WebviewToHostMessage =
  | ReadyMessage
  | ReloadMessage
  | PersistSpectrogramDefaultsMessage
  | RequestMediaMetadataMessage
  | RequestDecodeFallbackMessage
  | RequestLoudnessSummaryMessage
  | OpenExternalMessage;

// --- Host → Webview messages ---

export interface LoadAudioMessage {
  type: 'loadAudio';
  body: AudioscopePayload;
}

export interface ExternalToolStatusMessage {
  type: 'externalToolStatus';
  body: ExternalToolStatusPayload;
}

export interface MediaMetadataReadyMessage {
  type: 'mediaMetadataReady';
  body: { loadToken: number; metadata: MediaMetadataPayload };
}

export interface MediaMetadataErrorMessage {
  type: 'mediaMetadataError';
  body: { loadToken: number; message: string; toolStatus: ExternalToolStatusPayload };
}

export type DecodeFallbackReadyMessage =
  & { type: 'decodeFallbackReady' }
  & { body: DecodeFallbackPayload & { loadToken: number } };

export interface DecodeFallbackErrorMessage {
  type: 'decodeFallbackError';
  body: { loadToken: number; message: string; toolStatus: ExternalToolStatusPayload };
}

export type LoudnessSummaryReadyMessage =
  & { type: 'loudnessSummaryReady' }
  & { body: LoudnessSummaryPayload & { loadToken: number } };

export interface LoudnessSummaryErrorMessage {
  type: 'loudnessSummaryError';
  body: { loadToken: number; message: string };
}

export type HostToWebviewMessage =
  | LoadAudioMessage
  | ExternalToolStatusMessage
  | MediaMetadataReadyMessage
  | MediaMetadataErrorMessage
  | DecodeFallbackReadyMessage
  | DecodeFallbackErrorMessage
  | LoudnessSummaryReadyMessage
  | LoudnessSummaryErrorMessage;
