import * as vscode from 'vscode';
import {
  type EmbeddedExecutableStatus,
  getEmbeddedExecutableStatusSync,
  runEmbeddedFfmpegDecodeToPcm,
  runEmbeddedFfmpegMeasureLoudness,
  runEmbeddedFfmpegDecodeToWav,
  runEmbeddedFfprobe,
} from './embeddedMediaTools';

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

export interface AudioscopePayload {
  audioBytes: ArrayBuffer | null;
  documentUri: string;
  externalTools: ExternalToolStatusPayload;
  fileBacked: boolean;
  fileExtension: string;
  fileName: string;
  fileSize: number | null;
  spectrogramQuality: 'balanced' | 'high' | 'max';
  sourceUri: string;
}

export interface MediaMetadataSummaryPayload {
  bitrateText: string | null;
  channelText: string | null;
  codecText: string | null;
  containerText: string | null;
  durationText: string | null;
  sampleRateText: string | null;
  segments: string[];
  sizeText: string | null;
}

export interface MediaMetadataStreamPayload {
  bitRateText: string | null;
  channelLayout: string | null;
  channels: number | null;
  codecLongName: string | null;
  codecName: string | null;
  codecType: string | null;
  dispositionDefault: boolean;
  durationText: string | null;
  index: number | null;
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

export type ProbeOpenResult =
  | { kind: 'audio'; metadata: MediaMetadataPayload; toolStatus: ExternalToolStatusPayload }
  | { kind: 'not-audio'; message: string; toolStatus: ExternalToolStatusPayload }
  | { kind: 'missing-tools'; message: string; toolStatus: ExternalToolStatusPayload }
  | { kind: 'unsupported-resource'; message: string; toolStatus: ExternalToolStatusPayload };

interface FfprobeFormatSection {
  bit_rate?: string;
  duration?: string;
  filename?: string;
  format_long_name?: string;
  format_name?: string;
  size?: string;
  tags?: Record<string, string>;
}

interface FfprobeDispositionSection {
  default?: number;
}

interface FfprobeStreamSection {
  bit_rate?: string;
  channel_layout?: string;
  channels?: number;
  codec_long_name?: string;
  codec_name?: string;
  codec_type?: string;
  disposition?: FfprobeDispositionSection;
  duration?: string;
  index?: number;
  sample_fmt?: string;
  sample_rate?: string;
  tags?: Record<string, string>;
}

interface FfprobeChapterSection {
  end_time?: string;
  id?: number;
  start_time?: string;
  tags?: Record<string, string>;
}

interface FfprobeJsonPayload {
  chapters?: FfprobeChapterSection[];
  format?: FfprobeFormatSection;
  streams?: FfprobeStreamSection[];
}

const EMBEDDED_TOOL_UNAVAILABLE_GUIDANCE = 'audioscope media tools are unavailable. Rebuild or reinstall audioscope to restore metadata and decoding.';
const EMBEDDED_FFMPEG_UNAVAILABLE_GUIDANCE = 'ffmpeg.wasm is unavailable. Rebuild or reinstall audioscope to restore decoding.';
const EMBEDDED_FFPROBE_UNAVAILABLE_GUIDANCE = 'ffprobe.wasm is unavailable. Rebuild or reinstall audioscope to restore metadata.';

interface ResolvedToolSelection {
  ffmpeg: EmbeddedExecutableStatus;
  ffprobe: EmbeddedExecutableStatus;
  resourceReadable: boolean;
}

const EXTERNAL_TOOL_TIMEOUT_MS = 15_000;
const FFMPEG_DECODE_TIMEOUT_MS = 120_000;

function getCliFilePath(resource: vscode.Uri): string | null {
  return resource.scheme === 'file' ? resource.fsPath : null;
}

function getExecErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return String(error);
}

function buildExternalToolGuidance(tools: ResolvedToolSelection): string {
  if (!tools.ffprobe.available && !tools.ffmpeg.available) {
    return EMBEDDED_TOOL_UNAVAILABLE_GUIDANCE;
  }

  if (!tools.ffprobe.available) {
    return EMBEDDED_FFPROBE_UNAVAILABLE_GUIDANCE;
  }

  if (!tools.ffmpeg.available) {
    return EMBEDDED_FFMPEG_UNAVAILABLE_GUIDANCE;
  }

  if (!tools.resourceReadable) {
    return EMBEDDED_TOOL_UNAVAILABLE_GUIDANCE;
  }

  return 'Using audioscope media tools.';
}

function createToolStatusPayload(resolved: boolean, selection: ResolvedToolSelection): ExternalToolStatusPayload {
  const canDecodeFallback = selection.resourceReadable && selection.ffmpeg.available;
  const canReadMetadata = selection.resourceReadable && selection.ffprobe.available;

  return {
    resolved,
    canDecodeFallback,
    canReadMetadata,
    ffmpegAvailable: selection.ffmpeg.available,
    ffmpegCommand: selection.ffmpeg.command,
    ffmpegVersion: selection.ffmpeg.version,
    ffprobeAvailable: selection.ffprobe.available,
    ffprobeCommand: selection.ffprobe.command,
    ffprobeVersion: selection.ffprobe.version,
    fileBacked: selection.resourceReadable,
    guidance: buildExternalToolGuidance(selection),
  };
}

async function resolvePreferredTools(resource: vscode.Uri): Promise<ResolvedToolSelection> {
  const fileBacked = Boolean(getCliFilePath(resource));
  const ffmpeg = getEmbeddedExecutableStatusSync('ffmpeg');
  const ffprobe = getEmbeddedExecutableStatusSync('ffprobe');

  return {
    ffmpeg,
    ffprobe,
    resourceReadable: fileBacked || ffmpeg.available || ffprobe.available,
  };
}

export function createInitialExternalToolStatus(resource: vscode.Uri): ExternalToolStatusPayload {
  const selection: ResolvedToolSelection = {
    ffmpeg: getEmbeddedExecutableStatusSync('ffmpeg'),
    ffprobe: getEmbeddedExecutableStatusSync('ffprobe'),
    resourceReadable: Boolean(getCliFilePath(resource))
      || getEmbeddedExecutableStatusSync('ffmpeg').available
      || getEmbeddedExecutableStatusSync('ffprobe').available,
  };

  return createToolStatusPayload(true, selection);
}

export async function getExternalToolStatus(resource: vscode.Uri): Promise<ExternalToolStatusPayload> {
  return createToolStatusPayload(true, await resolvePreferredTools(resource));
}

function parseNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getPrimaryAudioStream(rawPayload: FfprobeJsonPayload): FfprobeStreamSection | null {
  const streams = Array.isArray(rawPayload.streams) ? rawPayload.streams : [];
  return streams.find((stream) => stream.codec_type === 'audio') ?? null;
}

function getAudioDurationSeconds(rawPayload: FfprobeJsonPayload): number | null {
  const primaryAudioStream = getPrimaryAudioStream(rawPayload);
  const formatSection = rawPayload.format;

  return parseNumberValue(primaryAudioStream?.duration) ?? parseNumberValue(formatSection?.duration);
}

function formatFrequencyText(value: number | null): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  if (value >= 1000) {
    const kilohertz = value / 1000;
    const digits = Number.isInteger(kilohertz) ? 0 : 1;
    return `${kilohertz.toFixed(digits)} kHz`;
  }

  return `${Math.round(value).toLocaleString()} Hz`;
}

function formatDurationText(value: number | null): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  const totalSeconds = Math.round(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatBitrateText(value: number | null): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} Mbps`;
  }

  return `${Math.round(value / 1000).toLocaleString()} kbps`;
}

function formatSizeText(value: number | null): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatChannelText(channels: number | null, channelLayout: string | null): string | null {
  if (!Number.isFinite(channels) || !channels || channels <= 0) {
    return channelLayout;
  }

  const normalizedLayout = channelLayout?.trim().toLowerCase() ?? '';

  if (normalizedLayout === 'mono') {
    return 'Mono';
  }

  if (normalizedLayout === 'stereo') {
    return 'Stereo';
  }

  if (channelLayout) {
    return channels > 2 ? `${channelLayout} (${channels} ch)` : channelLayout;
  }

  if (channels === 1) {
    return 'Mono';
  }

  if (channels === 2) {
    return 'Stereo';
  }

  return `${channels} ch`;
}

function formatCodecText(stream: FfprobeStreamSection | null): string | null {
  if (!stream) {
    return null;
  }

  if (stream.codec_name) {
    return stream.codec_name.toUpperCase();
  }

  return stream.codec_long_name ?? null;
}

function formatContainerText(format: FfprobeFormatSection | undefined): string | null {
  if (!format) {
    return null;
  }

  const formatName = format.format_long_name ?? format.format_name ?? null;

  if (!formatName) {
    return null;
  }

  return formatName.replace(/,/gu, ' / ');
}

function sortTags(tags: Record<string, string> | undefined): MediaMetadataTagPayload[] {
  if (!tags) {
    return [];
  }

  return Object.entries(tags)
    .filter((entry) => entry[1].trim().length > 0)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => ({ key, value }));
}

function summarizeMetadata(rawPayload: FfprobeJsonPayload, toolStatus: ExternalToolStatusPayload): MediaMetadataPayload {
  const streams = Array.isArray(rawPayload.streams) ? rawPayload.streams : [];
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const primaryAudioStream = audioStreams[0] ?? null;
  const formatSection = rawPayload.format;

  const summary: MediaMetadataSummaryPayload = {
    bitrateText: formatBitrateText(parseNumberValue(primaryAudioStream?.bit_rate) ?? parseNumberValue(formatSection?.bit_rate)),
    channelText: formatChannelText(primaryAudioStream?.channels ?? null, primaryAudioStream?.channel_layout ?? null),
    codecText: formatCodecText(primaryAudioStream),
    containerText: formatContainerText(formatSection),
    durationText: formatDurationText(parseNumberValue(primaryAudioStream?.duration) ?? parseNumberValue(formatSection?.duration)),
    sampleRateText: formatFrequencyText(parseNumberValue(primaryAudioStream?.sample_rate)),
    segments: [],
    sizeText: formatSizeText(parseNumberValue(formatSection?.size)),
  };

  summary.segments = [
    summary.codecText ?? summary.containerText,
    summary.sampleRateText,
    summary.channelText,
    summary.bitrateText,
    summary.durationText,
  ].filter((segment): segment is string => Boolean(segment && segment.trim().length > 0));

  return {
    audioStreamCount: audioStreams.length,
    chapters: (Array.isArray(rawPayload.chapters) ? rawPayload.chapters : []).map((chapter) => ({
      endText: formatDurationText(parseNumberValue(chapter.end_time)),
      id: typeof chapter.id === 'number' ? chapter.id : null,
      startText: formatDurationText(parseNumberValue(chapter.start_time)),
      title: chapter.tags?.title?.trim() || null,
    })),
    chaptersCount: Array.isArray(rawPayload.chapters) ? rawPayload.chapters.length : 0,
    fileBacked: toolStatus.fileBacked,
    formatLongName: formatSection?.format_long_name ?? null,
    formatName: formatSection?.format_name ?? null,
    guidance: toolStatus.guidance,
    hasAudioStream: audioStreams.length > 0,
    probeSource: 'ffprobe',
    streams: streams.map((stream) => ({
      bitRateText: formatBitrateText(parseNumberValue(stream.bit_rate)),
      channelLayout: stream.channel_layout ?? null,
      channels: typeof stream.channels === 'number' ? stream.channels : null,
      codecLongName: stream.codec_long_name ?? null,
      codecName: stream.codec_name ?? null,
      codecType: stream.codec_type ?? null,
      dispositionDefault: stream.disposition?.default === 1,
      durationText: formatDurationText(parseNumberValue(stream.duration)),
      index: typeof stream.index === 'number' ? stream.index : null,
      sampleFormat: stream.sample_fmt ?? null,
      sampleRateText: formatFrequencyText(parseNumberValue(stream.sample_rate)),
    })),
    summary,
    tags: sortTags(formatSection?.tags),
    toolStatus,
  };
}

async function runFfprobe(
  resource: vscode.Uri,
  _signal?: AbortSignal,
): Promise<{ metadata: MediaMetadataPayload; rawPayload: FfprobeJsonPayload; toolStatus: ExternalToolStatusPayload }> {
  const preferredTools = await resolvePreferredTools(resource);
  const toolStatus = createToolStatusPayload(true, preferredTools);

  if (!toolStatus.fileBacked) {
    throw new Error(EMBEDDED_TOOL_UNAVAILABLE_GUIDANCE);
  }

  if (!toolStatus.ffprobeAvailable) {
    throw new Error(EMBEDDED_FFPROBE_UNAVAILABLE_GUIDANCE);
  }

  if (!toolStatus.canReadMetadata) {
    throw new Error(EMBEDDED_FFPROBE_UNAVAILABLE_GUIDANCE);
  }

  const stdout = await runEmbeddedFfprobe(resource, EXTERNAL_TOOL_TIMEOUT_MS);

  let parsed: FfprobeJsonPayload;

  try {
    parsed = JSON.parse(stdout) as FfprobeJsonPayload;
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON: ${getExecErrorMessage(error)}`);
  }

  return {
    metadata: summarizeMetadata(parsed, toolStatus),
    rawPayload: parsed,
    toolStatus,
  };
}

export async function getMediaMetadata(resource: vscode.Uri): Promise<MediaMetadataPayload> {
  const { metadata } = await runFfprobe(resource);
  return metadata;
}

export async function getLoudnessSummary(resource: vscode.Uri): Promise<LoudnessSummaryPayload> {
  const preferredTools = await resolvePreferredTools(resource);
  const toolStatus = createToolStatusPayload(true, preferredTools);

  if (!toolStatus.fileBacked) {
    throw new Error(EMBEDDED_TOOL_UNAVAILABLE_GUIDANCE);
  }

  if (!toolStatus.ffmpegAvailable) {
    throw new Error(EMBEDDED_FFMPEG_UNAVAILABLE_GUIDANCE);
  }

  if (!toolStatus.canDecodeFallback) {
    throw new Error(EMBEDDED_FFMPEG_UNAVAILABLE_GUIDANCE);
  }

  const summary = await runEmbeddedFfmpegMeasureLoudness(resource, FFMPEG_DECODE_TIMEOUT_MS);

  return {
    ...summary,
    channelCount: typeof summary.channelCount === 'number' && Number.isFinite(summary.channelCount)
      ? Math.max(0, Math.trunc(summary.channelCount))
      : null,
    channelLayout: typeof summary.channelLayout === 'string' && summary.channelLayout.trim().length > 0
      ? summary.channelLayout.trim()
      : null,
    channelMode: 'source layout',
    integratedLufs: parseNumberValue(summary.integratedLufs),
    integratedThresholdLufs: parseNumberValue(summary.integratedThresholdLufs),
    loudnessRangeLu: parseNumberValue(summary.loudnessRangeLu),
    lraHighLufs: parseNumberValue(summary.lraHighLufs),
    lraLowLufs: parseNumberValue(summary.lraLowLufs),
    rangeThresholdLufs: parseNumberValue(summary.rangeThresholdLufs),
    samplePeakDbfs: parseNumberValue(summary.samplePeakDbfs),
    source: 'FFmpeg ebur128',
    truePeakDbtp: parseNumberValue(summary.truePeakDbtp),
  };
}

export async function probeAudioOpen(resource: vscode.Uri): Promise<ProbeOpenResult> {
  const toolStatus = await getExternalToolStatus(resource);

  if (!toolStatus.fileBacked) {
    return {
      kind: 'unsupported-resource',
      message: 'audioscope can probe arbitrary files only from the local filesystem in this build.',
      toolStatus,
    };
  }

  if (!toolStatus.ffprobeAvailable) {
    return {
      kind: 'missing-tools',
      message: EMBEDDED_FFPROBE_UNAVAILABLE_GUIDANCE,
      toolStatus,
    };
  }

  const { metadata } = await runFfprobe(resource);

  if (!metadata.hasAudioStream) {
    return {
      kind: 'not-audio',
      message: 'ffprobe did not find an audio stream in the selected file.',
      toolStatus,
    };
  }

  return {
    kind: 'audio',
    metadata,
    toolStatus,
  };
}

export async function decodeWithFfmpeg(resource: vscode.Uri): Promise<DecodeFallbackPayload> {
  const preferredTools = await resolvePreferredTools(resource);
  const toolStatus = createToolStatusPayload(true, preferredTools);

  if (!toolStatus.fileBacked) {
    throw new Error(EMBEDDED_TOOL_UNAVAILABLE_GUIDANCE);
  }

  if (!toolStatus.ffmpegAvailable) {
    throw new Error(EMBEDDED_FFMPEG_UNAVAILABLE_GUIDANCE);
  }

  if (!toolStatus.canDecodeFallback) {
    throw new Error(EMBEDDED_FFMPEG_UNAVAILABLE_GUIDANCE);
  }

  try {
    const result = await runEmbeddedFfmpegDecodeToPcm(resource);

    return {
      ...result,
      kind: 'pcm',
    };
  } catch (error) {
    const result = await runEmbeddedFfmpegDecodeToWav(
      resource,
      FFMPEG_DECODE_TIMEOUT_MS,
    );

    return {
      ...result,
      kind: 'wav',
      source: 'ffmpeg',
    };
  }
}
