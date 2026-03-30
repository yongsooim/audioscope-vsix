import { execFile, spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface ExternalToolStatusPayload {
  canDecodeFallback: boolean;
  canReadMetadata: boolean;
  ffmpegAvailable: boolean;
  ffmpegCommand: string;
  ffmpegPath: string | null;
  ffmpegVersion: string | null;
  ffprobeAvailable: boolean;
  ffprobeCommand: string;
  ffprobePath: string | null;
  ffprobeVersion: string | null;
  fileBacked: boolean;
  guidance: string;
}

export interface WaveScopePayload {
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

export interface DecodeFallbackPayload {
  audioBuffer: ArrayBuffer;
  byteLength: number;
  mimeType: string;
  source: 'ffmpeg';
}

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

interface ExecutableStatus {
  available: boolean;
  command: string;
  path: string | null;
  version: string | null;
}

const FFMPEG_CLI_INSTALL_GUIDANCE = 'Install ffmpeg CLI first: brew install ffmpeg or winget install --id Gyan.FFmpeg --exact.';

interface ResolvedExternalTools {
  ffmpeg: ExecutableStatus;
  ffprobe: ExecutableStatus;
}

const EXTERNAL_TOOL_TIMEOUT_MS = 15_000;
const EXECUTABLE_VERSION_TIMEOUT_MS = 4_000;
const EXEC_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const FFMPEG_DECODE_TIMEOUT_MS = 120_000;

const toolResolutionCache = new Map<string, Promise<ResolvedExternalTools>>();

function normalizeConfiguredExecutable(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : '';
}

function getCliFilePath(resource: vscode.Uri): string | null {
  return resource.scheme === 'file' ? resource.fsPath : null;
}

function toToolCacheKey(resource: vscode.Uri): string {
  const config = vscode.workspace.getConfiguration('waveScope', resource);
  const ffmpegCommand = normalizeConfiguredExecutable(config.get<string>('ffmpegPath', ''));
  const ffprobeCommand = normalizeConfiguredExecutable(config.get<string>('ffprobePath', ''));

  return `${ffmpegCommand}\u0000${ffprobeCommand}`;
}

function getConfiguredCommand(resource: vscode.Uri, settingKey: 'ffmpegPath' | 'ffprobePath', fallbackCommand: string): string {
  const config = vscode.workspace.getConfiguration('waveScope', resource);
  const configured = normalizeConfiguredExecutable(config.get<string>(settingKey, ''));
  return configured || fallbackCommand;
}

function getExecErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return String(error);
}

function execFileAsync(
  command: string,
  args: string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        signal,
        timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          stderr: stderr ?? '',
          stdout: stdout ?? '',
        });
      },
    );
  });
}

async function locateCommand(command: string): Promise<string | null> {
  if (!command) {
    return null;
  }

  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return command;
  }

  const locatorCommand = process.platform === 'win32' ? 'where' : 'which';

  try {
    const { stdout } = await execFileAsync(locatorCommand, [command], EXECUTABLE_VERSION_TIMEOUT_MS);
    const resolved = stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);

    return resolved ?? null;
  } catch {
    return null;
  }
}

async function resolveExecutable(command: string): Promise<ExecutableStatus> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['-version'], EXECUTABLE_VERSION_TIMEOUT_MS);
    return {
      available: true,
      command,
      path: await locateCommand(command),
      version: parseExecutableVersion(stdout || stderr, command),
    };
  } catch {
    return {
      available: false,
      command,
      path: path.isAbsolute(command) ? command : null,
      version: null,
    };
  }
}

function parseExecutableVersion(output: string, command: string): string | null {
  const firstLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return null;
  }

  const versionMatch = firstLine.match(/^([^\s]+)\s+version\s+([^\s]+)/iu);

  if (versionMatch) {
    return `${versionMatch[1]} ${versionMatch[2]}`;
  }

  const executableName = path.basename(command);
  return firstLine.startsWith(executableName) ? firstLine : `${executableName} ${firstLine}`;
}

async function resolveExternalTools(resource: vscode.Uri): Promise<ResolvedExternalTools> {
  const cacheKey = toToolCacheKey(resource);
  const cached = toolResolutionCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const resolutionPromise = Promise.all([
    resolveExecutable(getConfiguredCommand(resource, 'ffmpegPath', 'ffmpeg')),
    resolveExecutable(getConfiguredCommand(resource, 'ffprobePath', 'ffprobe')),
  ]).then(([ffmpeg, ffprobe]) => ({ ffmpeg, ffprobe }));

  toolResolutionCache.set(cacheKey, resolutionPromise);
  return resolutionPromise;
}

function buildExternalToolGuidance(fileBacked: boolean, tools: ResolvedExternalTools): string {
  if (!fileBacked) {
    return 'External ffmpeg tools are only available for local filesystem files.';
  }

  if (!tools.ffprobe.available && !tools.ffmpeg.available) {
    return `${FFMPEG_CLI_INSTALL_GUIDANCE} This enables metadata and decode fallback for local files.`;
  }

  if (!tools.ffprobe.available) {
    return `${FFMPEG_CLI_INSTALL_GUIDANCE} This enables metadata via ffprobe.`;
  }

  if (!tools.ffmpeg.available) {
    return `${FFMPEG_CLI_INSTALL_GUIDANCE} This enables decode fallback.`;
  }

  return 'Using installed ffmpeg CLI tools.';
}

export async function getExternalToolStatus(resource: vscode.Uri): Promise<ExternalToolStatusPayload> {
  const tools = await resolveExternalTools(resource);
  const fileBacked = Boolean(getCliFilePath(resource));

  return {
    canDecodeFallback: fileBacked && tools.ffmpeg.available,
    canReadMetadata: fileBacked && tools.ffprobe.available,
    ffmpegAvailable: tools.ffmpeg.available,
    ffmpegCommand: tools.ffmpeg.command,
    ffmpegPath: tools.ffmpeg.path,
    ffmpegVersion: tools.ffmpeg.version,
    ffprobeAvailable: tools.ffprobe.available,
    ffprobeCommand: tools.ffprobe.command,
    ffprobePath: tools.ffprobe.path,
    ffprobeVersion: tools.ffprobe.version,
    fileBacked,
    guidance: buildExternalToolGuidance(fileBacked, tools),
  };
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
  signal?: AbortSignal,
): Promise<{ metadata: MediaMetadataPayload; rawPayload: FfprobeJsonPayload; toolStatus: ExternalToolStatusPayload }> {
  const toolStatus = await getExternalToolStatus(resource);
  const filePath = getCliFilePath(resource);

  if (!toolStatus.fileBacked || !filePath) {
    throw new Error('Metadata is only available for local filesystem files.');
  }

  if (!toolStatus.ffprobeAvailable) {
    throw new Error('Install ffmpeg CLI to view metadata.');
  }

  const { stdout } = await execFileAsync(
    toolStatus.ffprobeCommand,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      filePath,
    ],
    EXTERNAL_TOOL_TIMEOUT_MS,
    signal,
  );

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

export async function probeAudioOpen(resource: vscode.Uri): Promise<ProbeOpenResult> {
  const toolStatus = await getExternalToolStatus(resource);
  const filePath = getCliFilePath(resource);

  if (!filePath) {
    return {
      kind: 'unsupported-resource',
      message: 'Wave Scope can probe arbitrary files only from the local filesystem.',
      toolStatus,
    };
  }

  if (!toolStatus.ffprobeAvailable) {
    return {
      kind: 'missing-tools',
      message: 'Install ffmpeg CLI to inspect arbitrary audio files before opening them in Wave Scope.',
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
  const toolStatus = await getExternalToolStatus(resource);
  const filePath = getCliFilePath(resource);

  if (!toolStatus.fileBacked || !filePath) {
    throw new Error('ffmpeg decode fallback is only available for local filesystem files.');
  }

  if (!toolStatus.ffmpegAvailable) {
    throw new Error('Install ffmpeg CLI to decode this audio file.');
  }

  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn(
      toolStatus.ffmpegCommand,
      [
        '-v',
        'error',
        '-i',
        filePath,
        '-vn',
        '-sn',
        '-dn',
        '-map',
        '0:a:0',
        '-acodec',
        'pcm_s16le',
        '-f',
        'wav',
        '-',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeoutId = setTimeout(() => {
      ffmpegProcess.kill();
      reject(new Error('ffmpeg decode fallback timed out.'));
    }, FFMPEG_DECODE_TIMEOUT_MS);

    ffmpegProcess.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    ffmpegProcess.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    ffmpegProcess.once('error', (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to launch ffmpeg: ${getExecErrorMessage(error)}`));
    });

    ffmpegProcess.once('close', (exitCode) => {
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(stderr || `ffmpeg exited with code ${exitCode}.`));
        return;
      }

      const wavBuffer = Buffer.concat(stdoutChunks);
      const arrayBuffer = wavBuffer.buffer.slice(
        wavBuffer.byteOffset,
        wavBuffer.byteOffset + wavBuffer.byteLength,
      );

      resolve({
        audioBuffer: arrayBuffer,
        byteLength: wavBuffer.byteLength,
        mimeType: 'audio/wav',
        source: 'ffmpeg',
      });
    });
  });
}
