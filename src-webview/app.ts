import { DISPLAY_MIN_DPR } from './sharedBuffers';
import { isCurrentWorkerMessage } from './workerMessageSession';
import type { AudioTransport, PlaybackSession } from './transport/audioTransport';
import { createAudioscopeElements } from './audioscope/core/elements';
import { clamp, formatAxisLabel } from './audioscope/core/format';
import { createVisibleFrequencyAxisTicks } from './audioscope/core/frequencyAxisTicks';
import {
  calculatePlaybackProgress,
  type PlaybackProgressSnapshot,
} from './audioscope/core/playbackProgress';
import { getWaveformMarkerYRatio } from './audio-engine-worker/waveformRender';
import {
  createWaveformColumnGrid,
  getWaveformColumnCount,
  getWaveformRenderWidthCssPx,
  sampleToColumnIndex,
  WAVEFORM_GRID_SLACK_COLUMNS,
  type WaveformColumnGrid,
} from './audioscope/core/waveformColumnGrid';
import { createAudioscopeFocusController } from './audioscope/controllers/focus';
import { createAudioscopeLifecycleController } from './audioscope/controllers/lifecycle';
import {
  createAudioscopeMediaController,
  createExternalToolStatusState,
  createLoudnessSummaryState,
  createMediaMetadataState,
  normalizeExternalToolStatus,
} from './audioscope/controllers/media';
import {
  MAX_TOTAL_ANALYSIS_SAMPLES,
  createPlaybackAnalysisData,
  createPlaybackAnalysisDataFromPlaybackSession,
  createPlaybackSessionFromPcmFallback,
  preparePlaybackAnalysisData,
  type DownmixedPcm,
} from './audioscope/controllers/playbackData';
import {
  createAudioscopePlaybackRateController,
  normalizePlaybackRateSelection,
} from './audioscope/controllers/playbackRate';
import { createAudioscopeTransportLoopController } from './audioscope/controllers/transportLoop';
import { createAudioscopeViewportController } from './audioscope/controllers/viewport';
import {
  createAudioscopeLoadController,
  type AudioscopeWorkerBootstrapStateKey,
} from './audioscope/controllers/load';
import {
  canonicalizeColormapDistribution,
  canonicalizeFrequencyScale,
  canonicalizeSpectrogramAnalysisType,
  type AnalysisRenderBackend,
  type AnalysisSurfaceResetReason,
  type EngineWorkerToMainMessage,
  type PlaybackClockState,
  type SampleInfoPayload,
  type SetViewportIntentMessage,
  type SpectrogramAnalysisType,
  type SpectrogramColormapDistribution,
  type SpectrogramFrequencyScale,
  type SpectrogramWindowFunction,
  type SurfaceKind,
  type TransportCommand,
  type ViewportUiState,
} from './audioEngineProtocol';
import {
  WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
  WAVEFORM_BOTTOM_PADDING_PX,
  WAVEFORM_TOP_PADDING_PX,
} from './interactive-waveform/geometry';
import { normalizeSpectrogramWindowFunction } from './windowShared';
import {
  MAX_PLAYBACK_BOOST_DB,
  normalizePlaybackVolume,
  playbackVolumeFromSliderValue,
  playbackVolumeToDecibels,
  playbackVolumeToSliderValue,
  snapPlaybackVolume,
} from '../src/playbackVolume';
import type {
  ExportAudioFormat,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from '../src/hostWebviewProtocol';

const rawVscode = acquireVsCodeApi();
const vscode = {
  ...rawVscode,
  postMessage: (message: WebviewToHostMessage): void => {
    rawVscode.postMessage(message);
  },
};
const engineWorkerScriptUri = document.body.dataset.engineWorkerSrc || '';
const analysisWorkerScriptUri = document.body.dataset.analysisWorkerSrc || '';
const waveformWorkerScriptUri = document.body.dataset.waveformWorkerSrc || '';
const decodeBrowserModuleWasmUri = document.body.dataset.decodeModuleWasmSrc;
const decodeWorkerScriptUri = document.body.dataset.decodeWorkerSrc;
const pcmDownmixWorkerScriptUri = document.body.dataset.pcmDownmixWorkerSrc;
const audioTransportProcessorScriptUri = document.body.dataset.audioTransportProcessorSrc;
const stretchProcessorScriptUri = document.body.dataset.stretchProcessorSrc;
const wasmCoreSimdScriptUri = document.body.dataset.wasmCoreSimdSrc || '';
const wasmCoreFallbackScriptUri = document.body.dataset.wasmCoreFallbackSrc || '';

let wasmCoreBytesPromise: Promise<{ fallback: ArrayBuffer | null; simd: ArrayBuffer | null }> | null = null;
let decodeModuleWasmBytesPromise: Promise<ArrayBuffer> | null = null;

function fetchDecodeModuleWasmBytes(): Promise<ArrayBuffer> {
  if (!decodeModuleWasmBytesPromise) {
    decodeModuleWasmBytesPromise = (async () => {
      if (!decodeBrowserModuleWasmUri) {
        throw new Error('Embedded decode worker WASM URL is missing.');
      }
      const response = await fetch(decodeBrowserModuleWasmUri, { credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(`Failed to fetch embedded decode WASM: ${response.status}`);
      }
      return response.arrayBuffer();
    })().catch((error) => {
      decodeModuleWasmBytesPromise = null;
      throw error;
    });
  }
  return decodeModuleWasmBytesPromise;
}

function fetchWasmCoreBytes(): Promise<{ fallback: ArrayBuffer | null; simd: ArrayBuffer | null }> {
  if (!wasmCoreBytesPromise) {
    const fetchOne = async (url: string): Promise<ArrayBuffer | null> => {
      if (!url) {
        return null;
      }
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
          return null;
        }
        return await response.arrayBuffer();
      } catch {
        return null;
      }
    };
    wasmCoreBytesPromise = Promise.all([
      fetchOne(wasmCoreSimdScriptUri),
      fetchOne(wasmCoreFallbackScriptUri),
    ]).then(([simd, fallback]) => ({ fallback, simd }));
  }
  return wasmCoreBytesPromise;
}

const workerSourceTextCache = new Map<string, Promise<string>>();

function fetchWorkerSourceText(moduleUrl: string): Promise<string> {
  let cached = workerSourceTextCache.get(moduleUrl);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(moduleUrl, { credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(`Failed to fetch worker source ${moduleUrl}: ${response.status}`);
      }
      return await response.text();
    })();
    workerSourceTextCache.set(moduleUrl, cached);
  }
  return cached;
}

interface PendingPcmDownmixRequest {
  expectedChannelCount: number;
  fail(error: unknown): void;
  resolve(result: DownmixedPcm): void;
}

let nextPcmDownmixRequestId = 1;
let pcmDownmixWorker: Worker | null = null;
let pcmDownmixWorkerBootstrapUrl: string | null = null;
let pcmDownmixWorkerPromise: Promise<Worker> | null = null;
const pendingPcmDownmixRequests = new Map<number, PendingPcmDownmixRequest>();

function disposePcmDownmixWorker(error: unknown = new Error('PCM downmix worker was reset.')): void {
  const worker = pcmDownmixWorker;
  const bootstrapUrl = pcmDownmixWorkerBootstrapUrl;
  const pending = [...pendingPcmDownmixRequests.values()];
  pcmDownmixWorker = null;
  pcmDownmixWorkerBootstrapUrl = null;
  pcmDownmixWorkerPromise = null;
  pendingPcmDownmixRequests.clear();
  worker?.terminate();
  if (bootstrapUrl) {
    URL.revokeObjectURL(bootstrapUrl);
  }
  for (const request of pending) {
    request.fail(error);
  }
}

function ensurePcmDownmixWorker(): Promise<Worker> {
  if (pcmDownmixWorker) {
    return Promise.resolve(pcmDownmixWorker);
  }
  if (pcmDownmixWorkerPromise) {
    return pcmDownmixWorkerPromise;
  }

  pcmDownmixWorkerPromise = (async () => {
    const sourceText = await fetchWorkerSourceText(pcmDownmixWorkerScriptUri || '');
    const bootstrapUrl = URL.createObjectURL(new Blob([sourceText], { type: 'text/javascript' }));
    const worker = new Worker(bootstrapUrl, { type: 'module' });
    pcmDownmixWorker = worker;
    pcmDownmixWorkerBootstrapUrl = bootstrapUrl;
    worker.addEventListener('message', (event: MessageEvent) => {
      const requestId = Math.max(0, Math.trunc(Number(event.data?.body?.requestId) || 0));
      const pending = pendingPcmDownmixRequests.get(requestId);
      if (!pending) {
        return;
      }
      if (event.data?.type === 'error') {
        pending.fail(new Error(event.data.body?.message || 'PCM downmix failed.'));
        return;
      }
      if (event.data?.type !== 'downmixReady') {
        return;
      }

      const channelBuffers = Array.isArray(event.data.body?.channelBuffers)
        ? event.data.body.channelBuffers.filter((buffer) => buffer instanceof ArrayBuffer)
        : [];
      const monoBuffer = event.data.body?.monoBuffer;
      const analysisBuffer = event.data.body?.analysisBuffer;
      const waveformBuffer = event.data.body?.waveformBuffer;
      if (
        channelBuffers.length !== pending.expectedChannelCount
        || !(monoBuffer instanceof ArrayBuffer)
        || !(analysisBuffer instanceof ArrayBuffer)
        || !(waveformBuffer instanceof ArrayBuffer)
      ) {
        pending.fail(new Error('PCM downmix worker returned invalid buffers.'));
        return;
      }
      pending.resolve({ analysisBuffer, channelBuffers, monoBuffer, waveformBuffer });
    });
    worker.addEventListener('error', (event) => {
      disposePcmDownmixWorker(new Error(event.message || 'PCM downmix worker failed.'));
    });
    return worker;
  })().catch((error) => {
    disposePcmDownmixWorker(error);
    throw error;
  });
  return pcmDownmixWorkerPromise;
}

async function downmixPcmInWorker(
  channelBuffers: ArrayBuffer[],
  sampleCount: number,
  channelCount: number,
): Promise<DownmixedPcm> {
  if (!pcmDownmixWorkerScriptUri) {
    throw new Error('PCM downmix worker script is unavailable.');
  }

  const abortSignal = state.sourceFetchController?.signal ?? null;
  const worker = await ensurePcmDownmixWorker();
  const requestId = nextPcmDownmixRequestId++;

  return new Promise<DownmixedPcm>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      pendingPcmDownmixRequests.delete(requestId);
      abortSignal?.removeEventListener('abort', handleAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = (): void => {
      fail(new DOMException('PCM downmix was aborted.', 'AbortError'));
      disposePcmDownmixWorker();
    };
    pendingPcmDownmixRequests.set(requestId, {
      expectedChannelCount: channelBuffers.length,
      fail,
      resolve: (result) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      },
    });
    abortSignal?.addEventListener('abort', handleAbort, { once: true });

    if (abortSignal?.aborted) {
      handleAbort();
      return;
    }

    try {
      worker.postMessage({
        type: 'downmixPcm',
        body: {
          channelBuffers,
          channelCount,
          maxTotalSamples: MAX_TOTAL_ANALYSIS_SAMPLES,
          requestId,
          sampleCount,
        },
      }, channelBuffers);
    } catch (error) {
      fail(error);
    }
  });
}

let DISPLAY_PIXEL_RATIO = Math.max(window.devicePixelRatio || 1, DISPLAY_MIN_DPR);
const DEFAULT_VIEWPORT_SPLIT_RATIO = 0.5;
const VIEWPORT_SPLIT_STEP = 0.05;
// Must stay in sync with --viewport-splitter-size in audioscope.css.
const VIEWPORT_SPLITTER_FALLBACK_SIZE_PX = 20;
const VIEWPORT_RATIO_MAX = 1;
const VIEWPORT_RATIO_MIN = 0;
const DEFAULT_WAVEFORM_AMPLITUDE_MAX = 1;
const WAVEFORM_AMPLITUDE_MAX_MIN = 0.001;
const LOOP_HANDLE_WIDTH_PX = 8;
const EMBEDDED_MEDIA_TOOLS_GUIDANCE = 'audioscope media tools are unavailable. Rebuild or reinstall audioscope to restore metadata and decoding.';
const SPECTROGRAM_FFT_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const SPECTROGRAM_MEL_BAND_OPTIONS = [128, 256, 512];
const SPECTROGRAM_MFCC_COEFFICIENT_OPTIONS = [13, 20, 32, 40];
const SPECTROGRAM_SCALOGRAM_HOP_OPTIONS = [0, 256, 512, 1024, 2048, 4096];
const SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS = [4, 5, 6, 7, 8, 10, 12];
const SPECTROGRAM_SCALOGRAM_ROW_DENSITY_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const SPECTROGRAM_OVERLAP_OPTIONS = [0.5, 0.75, 0.875, 0.9375];
// Just under a 60 Hz frame interval (16.67 ms): a true 60 Hz frame always
// passes the gate, while 120/144 Hz displays are capped to ~60 Hz.
const HOVER_FLUSH_MIN_INTERVAL_MS = 1000 / 65;
const SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.2;
const SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR = 2.5;
const SPECTROGRAM_RANGE_EPSILON_SECONDS = 1 / 2000;
const DEFAULT_SCALOGRAM_OMEGA0 = 6;
const DEFAULT_SCALOGRAM_ROW_DENSITY = 1;
const DEFAULT_SCALOGRAM_MIN_FREQUENCY = 20;
const DEFAULT_SCALOGRAM_MAX_FREQUENCY = 20000;
const DEFAULT_SCALOGRAM_HOP_SAMPLES = 0;
const DEFAULT_SPECTROGRAM_FFT_SIZE = 4096;
const DEFAULT_SPECTROGRAM_OVERLAP_RATIO = 0.75;
const DEFAULT_SPECTROGRAM_WINDOW_FUNCTION: SpectrogramWindowFunction = 'hann';
const DEFAULT_SPECTROGRAM_FREQUENCY_SCALE: SpectrogramFrequencyScale = 'log';
const DEFAULT_SPECTROGRAM_COLORMAP_DISTRIBUTION: SpectrogramColormapDistribution = 'balanced';
const DEFAULT_MEL_BAND_COUNT = 256;
const DEFAULT_MFCC_COEFFICIENT_COUNT = 20;
const DEFAULT_MFCC_MEL_BAND_COUNT = 128;
const DEFAULT_LOUDNESS_REF_LEVEL = -14;
const DEFAULT_LOUDNESS_Y_AXIS_MIN = -60;
const DEFAULT_LOUDNESS_Y_AXIS_MAX = 0;
const SPECTROGRAM_CONFIG_APPLY_DELAY_MS = 16;
const SCALOGRAM_HOP_SAMPLES_BY_QUALITY = {
  balanced: 2048,
  high: 1024,
  max: 512,
} as const;
const SPECTROGRAM_DB_WINDOW_LIMITS = {
  max: 12,
  min: -120,
  minimumSpan: 6,
} as const;
const LOUDNESS_REF_LEVEL_LIMITS = {
  max: 6,
  min: -70,
} as const;
const LOUDNESS_Y_AXIS_LIMITS = {
  max: 6,
  min: -70,
  minimumSpan: 5,
} as const;

type LoudnessCurveVisibility = 'both' | 'momentary' | 'shortTerm';
type LoudnessRefPreset = '-14' | '-16' | '-23' | 'custom' | 'off';
type LoudnessYAxisMode = 'auto' | 'fixed';

const elements = createAudioscopeElements();
applyWaveformGeometryCssVariables();

function applyWaveformGeometryCssVariables(): void {
  elements.waveformViewport.style.setProperty('--waveform-top-padding-px', `${WAVEFORM_TOP_PADDING_PX}px`);
  elements.waveformViewport.style.setProperty('--waveform-bottom-padding-px', `${WAVEFORM_BOTTOM_PADDING_PX}px`);
  elements.waveformViewport.style.setProperty('--waveform-amplitude-height-ratio', String(WAVEFORM_AMPLITUDE_HEIGHT_RATIO));
  elements.waveformViewport.dataset.waveformGeometryReady = 'true';
}

function createInitialWaveformViewportState() {
  return {
    activeRenderRange: null as TimeRange | null,
    activeRenderWidthPx: 0,
    activeRenderHeightPx: 0,
    pendingRenderRange: null as TimeRange | null,
    pendingRenderWidthPx: 0,
    pendingRenderHeightPx: 0,
    presentedPeak: 0,
    presentedRange: { end: 0, start: 0 },
    renderedRange: { end: 0, start: 0 },
    renderWidthPx: 0,
    targetRange: { end: 0, start: 0 },
  };
}

function areTimeRangesEqual(left: TimeRange | null | undefined, right: TimeRange | null | undefined): boolean {
  return Boolean(left && right && left.start === right.start && left.end === right.end);
}

type HoverContext = {
  clientX: number;
  clientY: number;
  requestId: number;
  laneCount: number;
  laneIndex: number;
};

type HoverRequestPoint = {
  clientX: number;
  clientY: number;
};

type ChannelSampleValueResult = {
  frequencyEndHz: number | null;
  frequencyStartHz: number | null;
  timeSeconds: number;
  valueDb: number | null;
  loudnessMomentary?: number | null;
  loudnessShortTerm?: number | null;
  loudnessSamplePeak?: number | null;
} | null;

type TimeRange = {
  end: number;
  start: number;
};

type SpectrogramVisibleRequest = {
  analysisType: SpectrogramAnalysisType;
  colormapDistribution: SpectrogramColormapDistribution;
  configVersion: number;
  displayEnd: number;
  displayStart: number;
  fftSize: number;
  frequencyScale: SpectrogramFrequencyScale;
  generation: number;
  maxDecibels: number;
  melBandCount: number;
  mfccCoefficientCount: number;
  windowFunction: SpectrogramWindowFunction;
  scalogramHopSamples: number;
  scalogramMaxFrequency: number;
  scalogramMinFrequency: number;
  scalogramOmega0: number;
  scalogramRowDensity: number;
  spectrogramMaxFrequency: number;
  spectrogramMinFrequency: number;
  minDecibels: number;
  overlapRatio: number;
  pixelHeight: number;
  pixelWidth: number;
  viewEnd: number;
  viewStart: number;
};

type SpectrogramAnalysisState = {
  activeVisibleRequest: SpectrogramVisibleRequest | null;
  configVersion: number;
  duration: number;
  fallbackReason: string | null;
  generation: number;
  initialized: boolean;
  maxFrequency: number;
  minFrequency: number;
  quality: 'balanced' | 'high' | 'max';
  renderBackend: AnalysisRenderBackend;
  runtimeVariant: string | null;
  sampleCount: number;
  sampleRate: number;
};

type AnalysisWorkerToMainMessage =
  | {
      body: {
        fallbackReason?: string | null;
        maxFrequency?: number;
        minFrequency?: number;
        quality?: 'balanced' | 'high' | 'max';
        renderBackend?: AnalysisRenderBackend;
        runtimeVariant?: string | null;
        sampleCount?: number;
        sampleRate?: number;
        sessionVersion?: number;
      };
      type: 'analysisInitialized';
    }
  | {
      body: Record<string, unknown>;
      type: 'runtimeReady';
    }
  | {
      body: {
        reason?: AnalysisSurfaceResetReason;
      };
      type: 'analysisSurfaceResetRequested';
    }
  | {
      body: Record<string, unknown>;
      type: 'visibleReady';
    }
  | {
      body: {
        message?: string;
      };
      type: 'error';
    }
  | {
      body: {
        maxLufs?: number;
        minLufs?: number;
        refLevel?: number | null;
      };
      type: 'loudnessLegend';
    };

type WaveformWorkerToMainMessage =
  | {
      body: {
        runtimeVariant?: string | null;
      };
      type: 'runtimeReady';
    }
  | {
      body: {
        duration?: number;
        runtimeVariant?: string | null;
        sampleCount?: number;
        sampleRate?: number;
      };
      type: 'analysisInitialized';
    }
  | {
      body: Record<string, unknown>;
      type: 'waveformPyramidReady';
    }
  | {
      body: {
        generation?: number;
        height?: number;
        peak?: number;
        sessionVersion?: number;
        viewEnd?: number;
        viewStart?: number;
        width?: number;
      };
      type: 'waveformPresented';
    }
  | {
      body: {
        message?: string;
        sessionVersion?: number;
      };
      type: 'error';
    };

const state = {
  activeFile: null,
  splitChannels: false,
  analysis: null as SpectrogramAnalysisState | null,
  analysisSourceKind: 'native',
  analysisRuntimeReadyPromise: null as Promise<void> | null,
  analysisWorker: null as Worker | null,
  analysisLaneWorkers: [] as Worker[],
  spectrogramLaneCanvases: [] as HTMLCanvasElement[],
  spectrogramLaneLabels: [] as HTMLElement[],
  spectrogramSessionRevision: 0,
  waveformLaneWorkers: [] as Worker[],
  waveformLaneCanvases: [] as HTMLCanvasElement[],
  waveformLaneLabels: [] as HTMLElement[],
  waveformSessionRevision: 0,
  lastSpectrogramOverviewMessage: null as unknown,
  lastSpectrogramVisibleMessage: null as unknown,
  lastWaveformRenderMessage: null as unknown,
  analysisWorkerBootstrapUrl: null as string | null,
  audioTransport: null as AudioTransport | null,
  decodeAudioContext: null as AudioContext | null,
  decodeFallbackError: null,
  decodeFallbackLoadToken: 0,
  decodeFallbackPromise: null,
  decodeFallbackRequest: null as {
    hostRequested: boolean;
    loadToken: number;
    payload: any;
    reason: string;
  } | null,
  decodeFallbackResult: null,
  decodeWorker: null as Worker | null,
  decodeWorkerBootstrapUrl: null as string | null,
  decodeWorkerPrewarmed: false,
  decodeWorkerReady: false,
  deferredLoudnessLoadToken: 0,
  engineSessionRevision: 0,
  engineUiState: null as ViewportUiState | null,
  engineSurfacesPosted: false,
  engineWorker: null as Worker | null,
  engineWorkerBootstrapUrl: null as string | null,
  waveformWorker: null as Worker | null,
  waveformWorkerBootstrapUrl: null as string | null,
  externalTools: createExternalToolStatusState(EMBEDDED_MEDIA_TOOLS_GUIDANCE),
  followPlayback: false,
  hoverRequestIds: {
    spectrogram: 0,
    waveform: 0,
  },
  hoverFrame: 0,
  lastHoverFlushTime: 0,
  pendingHoverRequests: {
    spectrogram: null as HoverRequestPoint | null,
    waveform: null as HoverRequestPoint | null,
  },
  hoverState: {
    spectrogram: null as HoverContext | null,
    waveform: null as HoverContext | null,
  },
  spectrogramChannelHover: null as {
    requestId: number;
    laneCount: number;
    results: (ChannelSampleValueResult | null)[];
  } | null,
  waveformSampleMarkers: [] as HTMLElement[],
  lastAppliedTransportCommandSerial: 0,
  latestPlaybackClock: null as PlaybackClockState | null,
  loadToken: 0,
  loudness: createLoudnessSummaryState('idle'),
  loudnessChannelSessionRevision: 0,
  mediaMetadataLoadToken: 0,
  mediaMetadata: createMediaMetadataState('idle'),
  mediaMetadataDetailOpen: false,
  observedOverviewWidth: 0,
  observedSpectrogramPixelHeight: 0,
  observedSpectrogramPixelWidth: 0,
  observedWaveformViewportHeight: 0,
  observedWaveformViewportWidth: 0,
  analysisOverviewRefreshPending: false,
  initialWaveformReadyLoadToken: 0,
  lastSyncedSpectrogramDisplay: null as {
    end: number;
    pixelHeight: number;
    pixelWidth: number;
    start: number;
  } | null,
  renderedFrequencyTicks: null as ViewportUiState['frequencyTicks'] | null,
  renderedFrequencyAxisHeightPx: 0,
  renderedFrequencyLaneCount: 1,
  renderedWaveformAxisTicks: null as ViewportUiState['waveformAxisTicks'] | null,
  renderedWaveformAxisWidthPx: 0,
  playbackFrame: 0,
  playbackRate: 1,
  playbackRateMenuOpen: false,
  waveExportMenuOpen: false,
  waveOverflowMenuOpen: false,
  playbackSession: null as PlaybackSession | null,
  playbackSourceKind: 'native',
  playbackTransportError: null as string | null,
  playbackTransportKind: 'unavailable',
  pendingAnalysisSession: null as {
    loadToken: number;
    monoSamples: Float32Array;
    playbackSession: PlaybackSession;
    quality: 'balanced' | 'high' | 'max';
  } | null,
  rejectDecodeFallback: null,
  resolveAnalysisRuntimeReady: null as (() => void) | null,
  resolveDecodeFallback: null,
  selectionDrag: null as { pointerId: number; target: HTMLElement } | null,
  loopHandleDrag: null as { edge: 'end' | 'start'; handle: HTMLElement; pointerId: number; target: HTMLElement } | null,
  sourceFetchController: null as AbortController | null,
  spectrogramCanvas: null as HTMLCanvasElement | null,
  spectrogramConfig: {
    analysisType: 'spectrogram' as SpectrogramAnalysisType,
    colormapDistribution: 'balanced' as SpectrogramColormapDistribution,
    fftSize: 4096,
    frequencyScale: 'log' as SpectrogramFrequencyScale,
    maxDecibels: 0,
    melBandCount: 256,
    mfccCoefficientCount: 20,
    mfccMelBandCount: 128,
    windowFunction: 'hann' as SpectrogramWindowFunction,
    scalogramHopSamples: DEFAULT_SCALOGRAM_HOP_SAMPLES,
    scalogramMaxFrequency: DEFAULT_SCALOGRAM_MAX_FREQUENCY,
    scalogramMinFrequency: DEFAULT_SCALOGRAM_MIN_FREQUENCY,
    scalogramOmega0: DEFAULT_SCALOGRAM_OMEGA0,
    scalogramRowDensity: DEFAULT_SCALOGRAM_ROW_DENSITY,
    spectrogramMaxFrequency: DEFAULT_SCALOGRAM_MAX_FREQUENCY,
    spectrogramMinFrequency: DEFAULT_SCALOGRAM_MIN_FREQUENCY,
    minDecibels: -80,
    overlapRatio: 0.75,
    loudnessRefPreset: '-14' as LoudnessRefPreset,
    loudnessRefCustom: DEFAULT_LOUDNESS_REF_LEVEL,
    loudnessYAxisMode: 'auto' as LoudnessYAxisMode,
    loudnessYAxisMin: DEFAULT_LOUDNESS_Y_AXIS_MIN,
    loudnessYAxisMax: DEFAULT_LOUDNESS_Y_AXIS_MAX,
    loudnessCurves: 'both' as LoudnessCurveVisibility,
    loudnessShowPeak: false,
  },
  spectrogramConfigApplyTimer: null as number | null,
  spectrogramConfigPersistPending: false,
  spectrogramFrame: 0,
  spectrogramDefaultsPersistTimer: null as number | null,
  spectrogramMetaOpen: false,
  spectrogramRenderForcePending: false,
  spectrogramSurfaceResetPromise: null as Promise<void> | null,
  spectrogramSurfaceReadyPromise: null as Promise<void> | null,
  viewportResizeDrag: null as { pointerId: number; startClientY: number; startRatio: number } | null,
  viewportSplitRatio: DEFAULT_VIEWPORT_SPLIT_RATIO,
  viewportSplitRatioPersistTimer: null as number | null,
  playbackVolume: 1,
  playbackVolumePersistTimer: null as number | null,
  waveformAmplitudeMax: DEFAULT_WAVEFORM_AMPLITUDE_MAX,
  waveformAmplitudeMaxPersistTimer: null as number | null,
  waveformCanvas: null as HTMLCanvasElement | null,
  waveformRenderGeneration: 0,
  waveformSurfaceReadyPromise: null as Promise<void> | null,
  waveformViewport: createInitialWaveformViewportState(),
};

const {
  focusKeyboardSurface,
  initializeKeyboardSurfaceFocus,
  isTextEditableTarget,
  scheduleKeyboardSurfaceFocus,
} = createAudioscopeFocusController();

const {
  renderLoudnessSummary,
  renderMediaMetadata,
  setLoudnessSummaryUnavailable,
  setReadyLoudnessSummary,
  setMediaMetadataDetailOpen,
  setPendingLoudnessSummary,
  syncMediaMetadataDetailVisibility,
  updateMediaMetadataDetailPosition,
} = createAudioscopeMediaController({
  embeddedMediaToolsGuidance: EMBEDDED_MEDIA_TOOLS_GUIDANCE,
  elements,
  state,
});

const {
  closePlaybackRateMenu,
  focusPlaybackRateOption,
  getPlaybackRateOptionButtons,
  initializePlaybackRateControl,
  isPlaybackRateUiTarget,
  movePlaybackRateFocus,
  openPlaybackRateMenu,
  positionPlaybackRateMenu,
  syncPlaybackRateControl,
} = createAudioscopePlaybackRateController({
  elements,
  scheduleKeyboardSurfaceFocus,
  state,
});

const {
  destroySession,
  disposeAnalysisWorker,
  disposeEngineWorker,
  disposeWaveformWorker,
} = createAudioscopeLifecycleController({
  createInitialWaveformViewportState,
  elements,
  hideSurfaceHoverTooltip,
  hideWaveformSampleMarker,
  renderSpectrogramMeta,
  renderSpectrogramScale,
  renderWaveformUi,
  state,
  teardownSatelliteLanes: () => {
    teardownSpectrogramLanes();
    teardownWaveformLanes();
  },
});

const {
  hasPlaybackTransport,
  seekBy,
  setPlaybackPositionFromFrame,
  startPlaybackLoop,
  syncTransport,
  togglePlayback,
} = createAudioscopeTransportLoopController({
  elements,
  frameToSeconds,
  getDurationFrames,
  getEffectiveDurationSeconds,
  getSampleRate,
  onPlaybackClock: applyPlaybackClock,
  onPlayingChange: (playing) => { vscode.postMessage({ type: 'playbackState', body: { playing } }); },
  renderMediaMetadata,
  state,
  syncPlaybackRateControl,
});

const {
  applyViewportSplit,
  attachResizeObservers,
  handleViewportWheel,
  syncSurfaceSizes,
  updateViewportSplitRatioFromClientY,
} = createAudioscopeViewportController({
  defaultViewportSplitRatio: DEFAULT_VIEWPORT_SPLIT_RATIO,
  getDisplayPixelRatio: () => DISPLAY_PIXEL_RATIO,
  elements,
  getDurationFrames,
  refreshHoveredSampleInfos,
  getSpectrogramCanvasTargetSize,
  getWaveformViewportSize,
  requestWaveformRender,
  renderSpectrogramScale,
  scheduleSpectrogramRender,
  sendViewportIntent,
  splitterFallbackSizePx: VIEWPORT_SPLITTER_FALLBACK_SIZE_PX,
  state,
  viewportRatioMax: VIEWPORT_RATIO_MAX,
  viewportRatioMin: VIEWPORT_RATIO_MIN,
});

function setAnalysisStatus(message: string, isError = false): void {
  elements.analysisStatus.textContent = message;
  elements.analysisStatus.title = message;
  elements.analysisStatus.classList.toggle('error', isError);
}

function setSurfaceLoading(surface: 'spectrogram' | 'waveform', loading: boolean): void {
  const element = surface === 'waveform' ? elements.waveformLoading : elements.spectrogramLoading;
  element.hidden = !loading;
}

function setFatalStatus(message: string): void {
  elements.status.hidden = false;
  elements.status.classList.add('error');
  elements.status.replaceChildren();

  const messageElement = document.createElement('div');
  messageElement.id = 'status-overlay-message';
  messageElement.className = 'status-overlay-message';
  messageElement.textContent = message;

  const retryButton = document.createElement('button');
  retryButton.className = 'status-overlay-button';
  retryButton.type = 'button';
  retryButton.textContent = 'Retry';
  retryButton.addEventListener('click', () => {
    setAnalysisStatus('Retrying…');
    vscode.postMessage({ type: 'reload' });
  });

  elements.status.append(messageElement, retryButton);
  elements.status.setAttribute('aria-describedby', messageElement.id);
  window.requestAnimationFrame(() => {
    retryButton.focus({ preventScroll: true });
  });
}

function clearFatalStatus(): void {
  elements.status.hidden = true;
  elements.status.replaceChildren();
  elements.status.removeAttribute('aria-describedby');
  elements.status.classList.remove('error');
}

const normalizeSpectrogramAnalysisType = canonicalizeSpectrogramAnalysisType;

function normalizeLoudnessRefPreset(value: unknown): LoudnessRefPreset {
  return value === 'off'
    || value === '-14'
    || value === '-16'
    || value === '-23'
    || value === 'custom'
    ? value
    : '-14';
}

function normalizeLoudnessRefCustom(value: unknown): number {
  return Math.round(clamp(
    Number.isFinite(Number(value)) ? Number(value) : DEFAULT_LOUDNESS_REF_LEVEL,
    LOUDNESS_REF_LEVEL_LIMITS.min,
    LOUDNESS_REF_LEVEL_LIMITS.max,
  ));
}

function normalizeLoudnessRefLevel(value: unknown): number | null {
  if (value === null || value === 'off') {
    return null;
  }

  return normalizeLoudnessRefCustom(value);
}

function normalizeLoudnessYAxisMode(value: unknown): LoudnessYAxisMode {
  return value === 'fixed' ? 'fixed' : 'auto';
}

function normalizeLoudnessCurves(value: unknown): LoudnessCurveVisibility {
  return value === 'momentary' || value === 'shortTerm' ? value : 'both';
}

function normalizeLoudnessYAxisRange(
  minValue: unknown,
  maxValue: unknown,
): {
  max: number;
  min: number;
} {
  let min = Number.isFinite(Number(minValue))
    ? Math.round(Number(minValue))
    : DEFAULT_LOUDNESS_Y_AXIS_MIN;
  let max = Number.isFinite(Number(maxValue))
    ? Math.round(Number(maxValue))
    : DEFAULT_LOUDNESS_Y_AXIS_MAX;

  min = clamp(min, LOUDNESS_Y_AXIS_LIMITS.min, LOUDNESS_Y_AXIS_LIMITS.max - LOUDNESS_Y_AXIS_LIMITS.minimumSpan);
  max = clamp(max, LOUDNESS_Y_AXIS_LIMITS.min + LOUDNESS_Y_AXIS_LIMITS.minimumSpan, LOUDNESS_Y_AXIS_LIMITS.max);

  if (max < min + LOUDNESS_Y_AXIS_LIMITS.minimumSpan) {
    max = Math.min(LOUDNESS_Y_AXIS_LIMITS.max, min + LOUDNESS_Y_AXIS_LIMITS.minimumSpan);
    min = Math.min(min, max - LOUDNESS_Y_AXIS_LIMITS.minimumSpan);
  }

  return { max, min };
}

function getConfiguredLoudnessRefLevel(): number | null {
  const preset = normalizeLoudnessRefPreset(state.spectrogramConfig.loudnessRefPreset);
  if (preset === 'off') {
    return null;
  }

  return preset === 'custom'
    ? normalizeLoudnessRefCustom(state.spectrogramConfig.loudnessRefCustom)
    : Number(preset);
}

function applyLoudnessRefLevel(refLevel: unknown): void {
  const normalizedRefLevel = normalizeLoudnessRefLevel(refLevel);
  if (normalizedRefLevel === null) {
    state.spectrogramConfig.loudnessRefPreset = 'off';
    state.spectrogramConfig.loudnessRefCustom = DEFAULT_LOUDNESS_REF_LEVEL;
    return;
  }

  const preset = String(normalizedRefLevel);
  state.spectrogramConfig.loudnessRefPreset = preset === '-14' || preset === '-16' || preset === '-23'
    ? preset
    : 'custom';
  state.spectrogramConfig.loudnessRefCustom = normalizedRefLevel;
}

const normalizeSpectrogramColormapDistribution = canonicalizeColormapDistribution;

function getSpectrogramAnalysisTypeLabel(analysisType: SpectrogramAnalysisType): string {
  switch (analysisType) {
    case 'loudness':
      return 'Loudness';
    case 'mel':
      return 'Mel-Spectrogram';
    case 'mfcc':
      return 'MFCC';
    case 'scalogram':
      return 'Scalogram';
    case 'chroma':
      return 'Chroma';
    default:
      return 'Spectrogram';
  }
}

function getDefaultSpectrogramDbWindow(analysisType: SpectrogramAnalysisType): {
  maxDecibels: number;
  minDecibels: number;
} {
  if (analysisType === 'mel') {
    return { minDecibels: -92, maxDecibels: 0 };
  }

  if (analysisType === 'mfcc') {
    return { minDecibels: -80, maxDecibels: 0 };
  }

  if (analysisType === 'scalogram') {
    return { minDecibels: -72, maxDecibels: 0 };
  }

  return { minDecibels: -80, maxDecibels: 0 };
}

function normalizeSpectrogramDbWindow(
  minValue: unknown,
  maxValue: unknown,
  analysisType: SpectrogramAnalysisType,
): {
  maxDecibels: number;
  minDecibels: number;
} {
  const defaults = getDefaultSpectrogramDbWindow(analysisType);
  let minDecibels = Number.isFinite(Number(minValue)) ? Math.round(Number(minValue)) : defaults.minDecibels;
  let maxDecibels = Number.isFinite(Number(maxValue)) ? Math.round(Number(maxValue)) : defaults.maxDecibels;

  minDecibels = clamp(
    minDecibels,
    SPECTROGRAM_DB_WINDOW_LIMITS.min,
    SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
  );
  maxDecibels = clamp(
    maxDecibels,
    SPECTROGRAM_DB_WINDOW_LIMITS.min + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    SPECTROGRAM_DB_WINDOW_LIMITS.max,
  );

  if (maxDecibels < minDecibels + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan) {
    maxDecibels = Math.min(
      SPECTROGRAM_DB_WINDOW_LIMITS.max,
      minDecibels + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    );
    minDecibels = Math.min(
      minDecibels,
      maxDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    );
  }

  return { minDecibels, maxDecibels };
}

function normalizeSpectrogramFftSize(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_FFT_OPTIONS.includes(numericValue) ? numericValue : 4096;
}

function normalizeSpectrogramMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MEL_BAND_OPTIONS.includes(numericValue) ? numericValue : 256;
}

function getSpectrogramFrequencyCeiling(): number {
  const analysisMaxFrequency = Number(state.analysis?.maxFrequency);
  const fallbackCeiling = DEFAULT_SCALOGRAM_MAX_FREQUENCY;
  if (!Number.isFinite(analysisMaxFrequency) || analysisMaxFrequency <= DEFAULT_SCALOGRAM_MIN_FREQUENCY + 1) {
    return fallbackCeiling;
  }

  return Math.max(
    DEFAULT_SCALOGRAM_MIN_FREQUENCY + 1,
    Math.min(DEFAULT_SCALOGRAM_MAX_FREQUENCY, Math.round(analysisMaxFrequency)),
  );
}

function normalizeSpectrogramMfccCoefficientCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MFCC_COEFFICIENT_OPTIONS.includes(numericValue) ? numericValue : 20;
}

function normalizeSpectrogramMfccMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MEL_BAND_OPTIONS.includes(numericValue) ? numericValue : 128;
}

function normalizeSpectrogramScalogramOmega0(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_OMEGA0;
}

function getSpectrogramScalogramOmegaSliderIndex(value: unknown): number {
  const normalizedValue = normalizeSpectrogramScalogramOmega0(value);
  const optionIndex = SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.indexOf(normalizedValue);
  return optionIndex >= 0 ? optionIndex : SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.indexOf(DEFAULT_SCALOGRAM_OMEGA0);
}

function getSpectrogramScalogramOmega0FromSlider(value: unknown): number {
  const optionIndex = clamp(
    Math.round(Number(value) || 0),
    0,
    SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.length - 1,
  );
  return SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS[optionIndex] ?? DEFAULT_SCALOGRAM_OMEGA0;
}

function normalizeSpectrogramScalogramRowDensity(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_SCALOGRAM_ROW_DENSITY_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_ROW_DENSITY;
}

function normalizeSpectrogramScalogramHopSetting(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_SCALOGRAM_HOP_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_HOP_SAMPLES;
}

function getQualityDefaultScalogramHopSamples(): number {
  const quality = state.analysis?.quality === 'balanced' || state.analysis?.quality === 'max'
    ? state.analysis.quality
    : 'high';

  return SCALOGRAM_HOP_SAMPLES_BY_QUALITY[quality] ?? SCALOGRAM_HOP_SAMPLES_BY_QUALITY.high;
}

function getEffectiveScalogramHopSamplesFromOverlap(overlapRatio: unknown): number {
  const normalizedOverlapRatio = normalizeSpectrogramOverlapRatio(overlapRatio);
  const qualityDefaultHopSamples = getQualityDefaultScalogramHopSamples();
  const baselineStrideRatio = Math.max(0.000001, 1 - DEFAULT_SPECTROGRAM_OVERLAP_RATIO);
  const nextStrideRatio = Math.max(0.000001, 1 - normalizedOverlapRatio);

  return Math.max(1, Math.round(qualityDefaultHopSamples * (nextStrideRatio / baselineStrideRatio)));
}

function getEffectiveSpectrogramHopSamples(
  analysisType: ReturnType<typeof normalizeSpectrogramAnalysisType>,
  fftSize: number,
  overlapRatio: unknown,
): number {
  const normalizedOverlapRatio = normalizeSpectrogramOverlapRatio(overlapRatio);

  if (analysisType === 'scalogram' || analysisType === 'chroma') {
    return getEffectiveScalogramHopSamplesFromOverlap(normalizedOverlapRatio);
  }

  return Math.max(1, Math.round(fftSize * (1 - normalizedOverlapRatio)));
}

function formatSpectrogramHopSizeText(hopSamples: number): string {
  return `${Math.max(1, Math.round(hopSamples)).toLocaleString()} smp`;
}

function normalizeSpectrogramScalogramFrequencyRange(minValue: unknown, maxValue: unknown): {
  maxFrequency: number;
  minFrequency: number;
} {
  const ceiling = getSpectrogramFrequencyCeiling();
  let minFrequency = Number.isFinite(Number(minValue))
    ? Math.round(Number(minValue))
    : DEFAULT_SCALOGRAM_MIN_FREQUENCY;
  let maxFrequency = Number.isFinite(Number(maxValue))
    ? Math.round(Number(maxValue))
    : Math.min(DEFAULT_SCALOGRAM_MAX_FREQUENCY, ceiling);

  minFrequency = clamp(
    minFrequency,
    DEFAULT_SCALOGRAM_MIN_FREQUENCY,
    Math.max(DEFAULT_SCALOGRAM_MIN_FREQUENCY, ceiling - 1),
  );
  maxFrequency = clamp(
    maxFrequency,
    Math.min(ceiling, minFrequency + 1),
    ceiling,
  );

  if (maxFrequency <= minFrequency) {
    maxFrequency = Math.min(ceiling, minFrequency + 1);
    minFrequency = Math.min(minFrequency, maxFrequency - 1);
  }

  return { minFrequency, maxFrequency };
}

const normalizeSpectrogramFrequencyScale = canonicalizeFrequencyScale;

function normalizeSpectrogramOverlapRatio(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_OVERLAP_OPTIONS.includes(numericValue) ? numericValue : 0.75;
}

function getEffectiveDurationSeconds(): number {
  const duration = Number(state.audioTransport?.getDuration());
  return Number.isFinite(duration) && duration > 0
    ? duration
    : (state.playbackSession?.durationSeconds ?? 0);
}

function getDurationFrames(): number {
  return state.playbackSession?.sourceLength ?? 0;
}

function getSampleRate(): number {
  return state.playbackSession?.sourceSampleRate ?? 0;
}

function frameToSeconds(frame: number): number {
  const sampleRate = getSampleRate();
  return sampleRate > 0 ? clamp(frame, 0, getDurationFrames()) / sampleRate : 0;
}

async function createModuleWorker(
  moduleUrl: string,
  bootstrapStateKey: AudioscopeWorkerBootstrapStateKey,
): Promise<Worker> {
  // VS Code 1.119's webview service worker (PR microsoft/vscode#311844) does
  // not handle resource fetches that originate from blob workers, so any
  // cross-origin module import inside a worker hangs. Workaround: fetch the
  // worker bundle on the main thread (where the service worker still serves
  // requests correctly) and inline the source into the bootstrap blob. The
  // worker bundles are built as self-contained single files (see
  // scripts/build-webview.mts) so once the source is in the blob the worker
  // has no further imports to resolve.
  const sourceText = await fetchWorkerSourceText(moduleUrl);
  const bootstrapBlob = new Blob([sourceText], { type: 'text/javascript' });
  const bootstrapUrl = URL.createObjectURL(bootstrapBlob);
  state[bootstrapStateKey] = bootstrapUrl;
  return new Worker(bootstrapUrl, { type: 'module' });
}

function createSpectrogramAnalysisState(
  duration: number,
  quality: 'balanced' | 'high' | 'max',
  sampleCount: number,
  sampleRate: number,
): SpectrogramAnalysisState {
  return {
    activeVisibleRequest: null,
    configVersion: 0,
    duration,
    fallbackReason: null,
    generation: 0,
    initialized: false,
    maxFrequency: Math.min(20000, sampleRate / 2),
    minFrequency: 20,
    quality,
    renderBackend: '2d-wasm',
    runtimeVariant: null,
    sampleCount,
    sampleRate,
  };
}

function normalizeSpectrogramQuality(value: unknown): 'balanced' | 'high' | 'max' {
  return value === 'balanced' || value === 'max' ? value : 'high';
}

async function ensureEngineWorker(loadToken: number): Promise<Worker | null> {
  if (state.engineWorker) {
    return state.engineWorker;
  }

  if (!engineWorkerScriptUri || loadToken !== state.loadToken) {
    return null;
  }

  const worker = await createModuleWorker(engineWorkerScriptUri, 'engineWorkerBootstrapUrl');
  if (loadToken !== state.loadToken) {
    worker.terminate();
    return null;
  }
  state.engineWorker = worker;
  worker.addEventListener('message', (event: MessageEvent<EngineWorkerToMainMessage>) => {
    handleEngineWorkerMessage(event.data);
  });
  worker.addEventListener('error', (event) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    setFatalStatus(`Audio engine worker failed: ${event.message || 'Unknown worker error.'}`);
  });
  postInitSurfaces();
  return worker;
}

async function ensureWaveformWorker(loadToken: number): Promise<Worker | null> {
  if (state.waveformWorker) {
    return state.waveformWorker;
  }

  if (!waveformWorkerScriptUri || loadToken !== state.loadToken) {
    return null;
  }

  const [worker, wasmBytes] = await Promise.all([
    createModuleWorker(waveformWorkerScriptUri, 'waveformWorkerBootstrapUrl'),
    fetchWasmCoreBytes(),
  ]);
  if (loadToken !== state.loadToken) {
    worker.terminate();
    return null;
  }
  state.waveformWorker = worker;
  worker.addEventListener('message', (event: MessageEvent<WaveformWorkerToMainMessage>) => {
    handleWaveformWorkerMessage(state.loadToken, event.data);
  });
  worker.addEventListener('error', (event) => {
    if (state.loadToken <= 0) {
      return;
    }
    disposeWaveformWorker();
    setFatalStatus(`Waveform worker failed: ${event.message || 'Unknown worker error.'}`);
  });
  worker.postMessage({ type: 'bootstrapRuntime', body: { wasmBytes } });
  return worker;
}

async function ensureAnalysisWorker(loadToken: number): Promise<Worker | null> {
  if (state.analysisWorker) {
    return state.analysisWorker;
  }

  if (!analysisWorkerScriptUri || loadToken !== state.loadToken) {
    return null;
  }

  const [worker, wasmBytes] = await Promise.all([
    createModuleWorker(analysisWorkerScriptUri, 'analysisWorkerBootstrapUrl'),
    fetchWasmCoreBytes(),
  ]);
  if (loadToken !== state.loadToken) {
    worker.terminate();
    return null;
  }
  state.analysisRuntimeReadyPromise = new Promise((resolve) => {
    state.resolveAnalysisRuntimeReady = resolve;
  });
  state.analysisWorker = worker;
  worker.addEventListener('message', (event: MessageEvent<AnalysisWorkerToMainMessage>) => {
    handleAnalysisWorkerMessage(state.loadToken, event.data);
  });
  worker.addEventListener('error', (event) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    disposeAnalysisWorker();
    setAnalysisStatus(`Spectrogram failed: ${event.message || 'Unknown worker error.'}`, true);
  });
  worker.postMessage({ type: 'bootstrapRuntime', body: { wasmBytes } });
  return worker;
}

function postInitSurfaces(): void {
  if (state.engineSurfacesPosted || !state.engineWorker) {
    return;
  }

  const waveformSize = getWaveformViewportSize();
  const spectrogramSize = getSpectrogramCanvasTargetSize();
  state.engineSurfacesPosted = true;

  state.engineWorker.postMessage({
    type: 'InitSurfaces',
    body: {
      spectrogramPixelHeight: spectrogramSize.pixelHeight,
      spectrogramPixelWidth: spectrogramSize.pixelWidth,
      waveformHeightCssPx: waveformSize.height,
      waveformRenderScale: DISPLAY_PIXEL_RATIO,
      waveformWidthCssPx: waveformSize.width,
    },
  });
}

function resetSpectrogramCanvasElement(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.id = 'spectrogram';
  canvas.className = 'spectrogram-canvas';
  canvas.setAttribute('aria-label', 'Spectrogram');
  elements.spectrogram.replaceWith(canvas);
  elements.spectrogram = canvas;
  state.spectrogramCanvas = canvas;
  state.spectrogramSurfaceReadyPromise = null;
  return canvas;
}

function channelLaneLabel(channelIndex: number, channelCount: number): string {
  if (channelCount === 2) {
    return channelIndex === 0 ? 'L' : 'R';
  }
  return `Ch ${channelIndex + 1}`;
}

// Tears down per-channel satellite spectrogram workers, their lane canvases and
// labels, and restores the primary canvas to its full-stage (mono) layout.
function teardownSpectrogramLanes(): void {
  for (const worker of state.analysisLaneWorkers) {
    try {
      worker.terminate();
    } catch {
      // Ignore termination failures for already-dead workers.
    }
  }
  state.analysisLaneWorkers = [];
  for (const canvas of state.spectrogramLaneCanvases) {
    canvas.remove();
  }
  state.spectrogramLaneCanvases = [];
  for (const label of state.spectrogramLaneLabels) {
    label.remove();
  }
  state.spectrogramLaneLabels = [];
  elements.spectrogramStage.classList.remove('split-channels');
  elements.spectrogram.style.removeProperty('top');
  elements.spectrogram.style.removeProperty('bottom');
  elements.spectrogram.style.removeProperty('height');
}

function layoutSpectrogramLanePrimary(laneCount: number): void {
  elements.spectrogramStage.classList.toggle('split-channels', laneCount > 1);
  if (laneCount <= 1) {
    elements.spectrogram.style.removeProperty('top');
    elements.spectrogram.style.removeProperty('bottom');
    elements.spectrogram.style.removeProperty('height');
    return;
  }
  elements.spectrogram.style.top = '0';
  elements.spectrogram.style.bottom = 'auto';
  elements.spectrogram.style.height = `${100 / laneCount}%`;
}

function addSpectrogramLaneLabel(channelIndex: number, channelCount: number): void {
  const label = document.createElement('div');
  label.className = 'spectrogram-lane-label';
  label.textContent = channelLaneLabel(channelIndex, channelCount);
  label.style.top = `${(channelIndex / channelCount) * 100}%`;
  elements.spectrogramStage.appendChild(label);
  state.spectrogramLaneLabels.push(label);
}

// Posts a render-affecting message to every satellite lane worker. Used to
// mirror the primary worker's render/cancel/display-range messages; the
// per-channel PCM attach is handled per-lane at setup, never broadcast.
function broadcastSpectrogramLaneMessage(message: unknown): void {
  for (const worker of state.analysisLaneWorkers) {
    worker.postMessage(message);
  }
}

async function createSpectrogramSatellite(
  loadToken: number,
  channelIndex: number,
  laneCount: number,
  channelPcm: Float32Array,
  sampleRate: number,
  duration: number,
  quality: 'balanced' | 'high' | 'max',
): Promise<void> {
  if (!analysisWorkerScriptUri || loadToken !== state.loadToken) {
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'spectrogram-canvas spectrogram-lane-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.top = `${(channelIndex / laneCount) * 100}%`;
  canvas.style.height = `${100 / laneCount}%`;
  elements.spectrogram.insertAdjacentElement('afterend', canvas);
  state.spectrogramLaneCanvases.push(canvas);

  const [worker, wasmBytes] = await Promise.all([
    createModuleWorker(analysisWorkerScriptUri, 'analysisWorkerBootstrapUrl'),
    fetchWasmCoreBytes(),
  ]);
  if (loadToken !== state.loadToken) {
    worker.terminate();
    canvas.remove();
    return;
  }
  worker.addEventListener('error', () => {
    // Satellite lanes are best-effort; the primary lane drives status/state.
  });
  // Per-channel hover value responses from this lane's worker.
  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; body?: { channelIndex: number; requestId: number; result: ChannelSampleValueResult } };
    if (data?.type === 'channelSampleValue' && data.body) {
      applyChannelSampleValue(data.body);
    }
  });

  const runtimeReady = new Promise<void>((resolve) => {
    const handler = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'runtimeReady') {
        worker.removeEventListener('message', handler);
        resolve();
      }
    };
    worker.addEventListener('message', handler);
  });

  worker.postMessage({ type: 'bootstrapRuntime', body: { wasmBytes } });
  await runtimeReady;
  if (loadToken !== state.loadToken) {
    worker.terminate();
    return;
  }

  const offscreenCanvas = canvas.transferControlToOffscreen();
  const enableWebGpu = Boolean((state.activeFile as { enableWebGpuRendering?: boolean } | null)?.enableWebGpuRendering);
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  worker.postMessage({
    type: 'initCanvas',
    body: { offscreenCanvas, pixelHeight, pixelWidth, enableWebGpu },
  }, [offscreenCanvas]);
  worker.postMessage({
    type: 'attachAudioSession',
    body: {
      duration,
      quality,
      sampleCount: channelPcm.length,
      sampleRate,
      samplesBuffer: channelPcm.buffer,
      sessionVersion: state.spectrogramSessionRevision,
    },
  }, [channelPcm.buffer]);
  // Replay the current overview + visible render so this lane paints the view
  // that the primary already rendered (instead of waiting for the next render).
  if (state.lastSpectrogramOverviewMessage) {
    worker.postMessage(state.lastSpectrogramOverviewMessage);
  }
  if (state.lastSpectrogramVisibleMessage) {
    worker.postMessage(state.lastSpectrogramVisibleMessage);
  }
  // Only join the broadcast list after init+attach are queued, so the next
  // render broadcast can't reach the worker before its session is set up.
  state.analysisLaneWorkers.push(worker);
}

async function setupSpectrogramSatellites(
  loadToken: number,
  laneCount: number,
  sampleRate: number,
  duration: number,
  quality: 'balanced' | 'high' | 'max',
): Promise<void> {
  const session = state.playbackSession;
  if (!session || laneCount <= 1) {
    return;
  }

  addSpectrogramLaneLabel(0, laneCount);
  // Spawn every satellite lane concurrently so all channels load together
  // (left + right filling at the same time) instead of one-lane-then-the-next.
  const tasks: Promise<void>[] = [];
  for (let channelIndex = 1; channelIndex < laneCount; channelIndex += 1) {
    const buffer = session.channelBuffers[channelIndex];
    if (!(buffer instanceof ArrayBuffer)) {
      continue;
    }
    const channelPcm = new Float32Array(buffer.slice(0));
    addSpectrogramLaneLabel(channelIndex, laneCount);
    tasks.push(createSpectrogramSatellite(loadToken, channelIndex, laneCount, channelPcm, sampleRate, duration, quality));
  }
  await Promise.all(tasks);

  if (loadToken === state.loadToken) {
    scheduleSpectrogramRender({ force: true });
  }
}

// --- Per-channel waveform lanes (mirrors the spectrogram satellite model) ----

function teardownWaveformLanes(): void {
  for (const worker of state.waveformLaneWorkers) {
    try {
      worker.terminate();
    } catch {
      // Ignore termination failures.
    }
  }
  state.waveformLaneWorkers = [];
  for (const canvas of state.waveformLaneCanvases) {
    canvas.remove();
  }
  state.waveformLaneCanvases = [];
  for (const label of state.waveformLaneLabels) {
    label.remove();
  }
  state.waveformLaneLabels = [];
  elements.waveformCanvasHost.classList.remove('split-channels');
  elements.waveformViewport.classList.remove('split-channels');
}

function layoutWaveformLanePrimary(laneCount: number): void {
  elements.waveformCanvasHost.classList.toggle('split-channels', laneCount > 1);
  elements.waveformViewport.classList.toggle('split-channels', laneCount > 1);
  const primary = state.waveformCanvas;
  if (!primary) {
    return;
  }
  if (laneCount <= 1) {
    primary.classList.remove('waveform-canvas-lane');
    primary.style.removeProperty('position');
    primary.style.removeProperty('top');
    primary.style.removeProperty('height');
    primary.style.removeProperty('left');
    return;
  }
  primary.classList.add('waveform-canvas-lane');
  primary.style.position = 'absolute';
  primary.style.left = '0';
  primary.style.top = '0';
  primary.style.height = `${100 / laneCount}%`;
}

function addWaveformLaneLabel(channelIndex: number, channelCount: number): void {
  const label = document.createElement('div');
  label.className = 'waveform-lane-label';
  label.textContent = channelLaneLabel(channelIndex, channelCount);
  label.style.top = `${(channelIndex / channelCount) * 100}%`;
  elements.waveformCanvasHost.appendChild(label);
  state.waveformLaneLabels.push(label);
}

// Copies the primary waveform canvas' horizontal presentation (width + transform
// set by syncWaveformCanvasPresentation) onto every satellite lane canvas.
function mirrorWaveformLaneStyles(): void {
  const primary = state.waveformCanvas;
  if (!primary) {
    return;
  }
  for (const canvas of state.waveformLaneCanvases) {
    canvas.style.width = primary.style.width;
    canvas.style.transformOrigin = primary.style.transformOrigin;
    canvas.style.transform = primary.style.transform;
  }
}

function broadcastWaveformLaneMessage(message: unknown): void {
  for (const worker of state.waveformLaneWorkers) {
    worker.postMessage(message);
  }
}

async function createWaveformSatellite(
  loadToken: number,
  channelIndex: number,
  laneCount: number,
  channelPcm: Float32Array,
  sampleRate: number,
  duration: number,
): Promise<void> {
  if (!waveformWorkerScriptUri || loadToken !== state.loadToken) {
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'waveform-canvas waveform-canvas-lane';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = `${(channelIndex / laneCount) * 100}%`;
  canvas.style.height = `${100 / laneCount}%`;
  elements.waveformCanvasHost.appendChild(canvas);
  state.waveformLaneCanvases.push(canvas);

  const [worker, wasmBytes] = await Promise.all([
    createModuleWorker(waveformWorkerScriptUri, 'waveformWorkerBootstrapUrl'),
    fetchWasmCoreBytes(),
  ]);
  if (loadToken !== state.loadToken) {
    worker.terminate();
    canvas.remove();
    return;
  }
  worker.addEventListener('error', () => {
    // Satellite lanes are best-effort; the primary lane drives status/state.
  });

  const runtimeReady = new Promise<void>((resolve) => {
    const handler = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'runtimeReady') {
        worker.removeEventListener('message', handler);
        resolve();
      }
    };
    worker.addEventListener('message', handler);
  });

  worker.postMessage({ type: 'bootstrapRuntime', body: { wasmBytes } });
  await runtimeReady;
  if (loadToken !== state.loadToken) {
    worker.terminate();
    return;
  }

  const offscreenCanvas = canvas.transferControlToOffscreen();
  const size = getWaveformViewportSize();
  worker.postMessage({
    type: 'initCanvas',
    body: {
      height: Math.max(1, Math.round(size.height / laneCount)),
      offscreenCanvas,
      renderScale: DISPLAY_PIXEL_RATIO,
      width: getWaveformRenderWidthCssPx(size.width, DISPLAY_PIXEL_RATIO),
    },
  }, [offscreenCanvas]);
  worker.postMessage({
    type: 'attachAudioSession',
    body: {
      duration,
      sampleCount: channelPcm.length,
      sampleRate,
      samplesBuffer: channelPcm.buffer,
      sessionVersion: state.waveformSessionRevision,
    },
  }, [channelPcm.buffer]);
  worker.postMessage({ type: 'buildWaveformPyramid' });
  // Replay the current view so this lane paints immediately after its pyramid is
  // built, instead of waiting for the next render broadcast.
  if (state.lastWaveformRenderMessage) {
    worker.postMessage(state.lastWaveformRenderMessage);
  }
  // Join the broadcast list only after setup is queued (see spectrogram note).
  state.waveformLaneWorkers.push(worker);
}

// Sets up the waveform for the current channel mode: reshapes the primary lane,
// re-attaches the primary worker's PCM (channel 0 in split, mono otherwise) and
// spawns satellite workers for the remaining channels.
async function setupWaveformChannels(
  loadToken: number,
  monoSamples: Float32Array,
  playbackSession: PlaybackSession,
): Promise<void> {
  const waveformWorker = state.waveformWorker;
  if (!waveformWorker || loadToken !== state.loadToken) {
    return;
  }

  teardownWaveformLanes();
  const laneCount = getSpectrogramLaneCount();
  layoutWaveformLanePrimary(laneCount);

  state.waveformSessionRevision += 1;
  const primaryPcm = laneCount > 1 && playbackSession.channelBuffers[0] instanceof ArrayBuffer
    ? new Float32Array(playbackSession.channelBuffers[0].slice(0))
    : monoSamples;

  if (laneCount > 1) {
    waveformWorker.postMessage({
      type: 'resizeCanvas',
      body: {
        height: Math.max(1, Math.round(getWaveformViewportSize().height / laneCount)),
        renderScale: DISPLAY_PIXEL_RATIO,
        width: getWaveformRenderWidthCssPx(getWaveformViewportSize().width, DISPLAY_PIXEL_RATIO),
      },
    });
  }

  waveformWorker.postMessage({
    type: 'attachAudioSession',
    body: {
      duration: playbackSession.durationSeconds,
      sampleCount: primaryPcm.length,
      sampleRate: playbackSession.sourceSampleRate,
      samplesBuffer: primaryPcm.buffer,
      sessionVersion: state.waveformSessionRevision,
    },
  }, [primaryPcm.buffer]);
  waveformWorker.postMessage({ type: 'buildWaveformPyramid' });

  await setupWaveformSatellites(loadToken, laneCount, playbackSession.sourceSampleRate, playbackSession.durationSeconds);
}

async function setupWaveformSatellites(
  loadToken: number,
  laneCount: number,
  sampleRate: number,
  duration: number,
): Promise<void> {
  const session = state.playbackSession;
  if (!session || laneCount <= 1) {
    return;
  }

  addWaveformLaneLabel(0, laneCount);
  // Spawn every satellite lane concurrently so all channels load together.
  const tasks: Promise<void>[] = [];
  for (let channelIndex = 1; channelIndex < laneCount; channelIndex += 1) {
    const buffer = session.channelBuffers[channelIndex];
    if (!(buffer instanceof ArrayBuffer)) {
      continue;
    }
    const channelPcm = new Float32Array(buffer.slice(0));
    addWaveformLaneLabel(channelIndex, laneCount);
    tasks.push(createWaveformSatellite(loadToken, channelIndex, laneCount, channelPcm, sampleRate, duration));
  }
  await Promise.all(tasks);

  if (loadToken === state.loadToken) {
    requestWaveformRender();
  }
}

async function initializeWaveformSurface(loadToken: number): Promise<void> {
  setSurfaceLoading('waveform', true);
  elements.waveformCanvasHost.replaceChildren();
  state.waveformViewport = createInitialWaveformViewportState();

  const canvas = document.createElement('canvas');
  canvas.className = 'waveform-canvas';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.transform = 'translate3d(0, 0, 0)';
  elements.waveformCanvasHost.replaceChildren(canvas);
  state.waveformCanvas = canvas;
  state.engineSurfacesPosted = false;

  const waveformWorker = await ensureWaveformWorker(loadToken);
  if (loadToken !== state.loadToken) {
    return;
  }

  if (!waveformWorker || typeof canvas.transferControlToOffscreen !== 'function') {
    throw new Error('Waveform worker runtime is unavailable.');
  }

  const waveformSize = getWaveformViewportSize();
  const offscreenCanvas = canvas.transferControlToOffscreen();
  waveformWorker.postMessage({
    type: 'initCanvas',
    body: {
      height: waveformSize.height,
      offscreenCanvas,
      renderScale: DISPLAY_PIXEL_RATIO,
      width: getWaveformRenderWidthCssPx(waveformSize.width, DISPLAY_PIXEL_RATIO),
    },
  }, [offscreenCanvas]);

  await ensureEngineWorker(loadToken);
  if (loadToken !== state.loadToken) {
    return;
  }
  postInitSurfaces();
}

async function initializeSpectrogramSurface(loadToken: number): Promise<void> {
  setSurfaceLoading('spectrogram', true);
  const canvas = state.spectrogramCanvas ?? resetSpectrogramCanvasElement();
  state.spectrogramSurfaceReadyPromise = Promise.resolve();

  const worker = await ensureAnalysisWorker(loadToken);
  if (loadToken !== state.loadToken) {
    return;
  }

  if (!worker || typeof canvas.transferControlToOffscreen !== 'function') {
    throw new Error('Spectrogram worker runtime is unavailable.');
  }

  const offscreenCanvas = canvas.transferControlToOffscreen();
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  const enableWebGpu = Boolean((state.activeFile as { enableWebGpuRendering?: boolean } | null)?.enableWebGpuRendering);
  worker.postMessage({
    type: 'initCanvas',
    body: {
      enableWebGpu,
      offscreenCanvas,
      pixelHeight,
      pixelWidth,
    },
  }, [offscreenCanvas]);
}

async function resetSpectrogramSurface(loadToken: number, reason: AnalysisSurfaceResetReason): Promise<void> {
  if (state.spectrogramSurfaceResetPromise) {
    return state.spectrogramSurfaceResetPromise;
  }

  setAnalysisStatus(
    reason === 'device-lost'
      ? 'Spectrogram surface resetting after WebGPU device loss...'
      : 'Spectrogram surface resetting...',
  );

  state.spectrogramSurfaceResetPromise = (async () => {
    await initializeSpectrogramSurface(loadToken);
  })()
    .finally(() => {
      state.spectrogramSurfaceResetPromise = null;
    });

  return state.spectrogramSurfaceResetPromise;
}

// Re-initializes the spectrogram surface so the worker re-reads the WebGPU flag
// from initCanvas, switching the render backend without reopening the file.
function applyWebGpuRenderingChange(): void {
  if (!state.analysis?.initialized) {
    return;
  }

  const loadToken = state.loadToken;
  // The live canvas already transferred its control to the worker, so swap in a
  // fresh element before re-initializing the surface.
  resetSpectrogramCanvasElement();
  void resetSpectrogramSurface(loadToken, 'surface-invalid')
    .then(() => {
      if (loadToken !== state.loadToken) {
        return;
      }
      scheduleSpectrogramRender({ force: true });
    })
    .catch((error) => {
      if (loadToken !== state.loadToken) {
        return;
      }
      setAnalysisStatus(
        `Spectrogram failed to switch renderer: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    });
}

function syncWebGpuToggleFromActiveFile(): void {
  elements.spectrogramWebGpuToggle.checked = Boolean(
    (state.activeFile as { enableWebGpuRendering?: boolean } | null)?.enableWebGpuRendering,
  );
}

function syncSplitChannelsToggleFromActiveFile(): void {
  state.splitChannels = Boolean(
    (state.activeFile as { splitChannels?: boolean } | null)?.splitChannels,
  );
  elements.spectrogramSplitChannelsToggle.checked = state.splitChannels;
}

// Rebuilds the spectrogram for the current channel mode (mono downmix vs
// per-channel lanes) from the retained playback session, without re-decoding or
// disturbing playback. Tears down satellite lanes, swaps in a fresh primary
// canvas, and re-runs the deferred analysis session setup.
function applyChannelModeChange(): void {
  if (!state.playbackSession || !state.analysis) {
    return;
  }
  const loadToken = state.loadToken;
  if (loadToken <= 0) {
    return;
  }

  teardownSpectrogramLanes();
  resetSpectrogramCanvasElement();
  renderSpectrogramScale();
  const prepared = createPlaybackAnalysisDataFromPlaybackSession(state.playbackSession);
  state.pendingAnalysisSession = {
    loadToken,
    monoSamples: prepared.monoSamples,
    playbackSession: state.playbackSession,
    quality: state.analysis.quality,
  };
  void startDeferredAnalysisSession(loadToken).catch((error) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    setAnalysisStatus(
      `Spectrogram failed to switch channels: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  });

  void setupWaveformChannels(loadToken, prepared.waveformSamples, state.playbackSession);
}

function applyTransportCommand(command: TransportCommand | null): void {
  if (!command || command.serial <= state.lastAppliedTransportCommandSerial) {
    return;
  }

  state.lastAppliedTransportCommandSerial = command.serial;

  switch (command.type) {
    case 'seek':
      setPlaybackPositionFromFrame(command.frame);
      return;
    case 'clearLoopAndSeek':
      state.audioTransport?.setLoop(null);
      setPlaybackPositionFromFrame(command.frame);
      return;
    case 'setLoop':
      state.audioTransport?.setLoop({
        end: frameToSeconds(command.endFrame),
        start: frameToSeconds(command.startFrame),
      });
      syncTransport();
      return;
    case 'clearLoop':
      state.audioTransport?.setLoop(null);
      syncTransport();
      return;
    default:
      return;
  }
}

function applyViewportUiState(uiState: ViewportUiState): void {
  applyLatestPlaybackClock(uiState);
  const previousUiState = state.engineUiState;
  const previousPresentedRange = state.waveformViewport.presentedRange;
  state.engineUiState = uiState;
  state.followPlayback = uiState.viewport.followEnabled;
  elements.waveFollow.checked = uiState.viewport.followEnabled;
  const sampleRate = uiState.playback.sampleRate || getSampleRate();
  let nextPresentedRange: TimeRange | null = null;

  if (sampleRate > 0) {
    nextPresentedRange = {
      start: uiState.presentedStartFrame / sampleRate,
      end: uiState.presentedEndFrame / sampleRate,
    };
    state.waveformViewport.presentedRange = nextPresentedRange;
    state.waveformViewport.targetRange = {
      start: uiState.viewport.targetStartFrame / sampleRate,
      end: uiState.viewport.targetEndFrame / sampleRate,
    };
    state.waveformViewport.renderedRange = {
      start: uiState.viewport.renderedStartFrame / sampleRate,
      end: uiState.viewport.renderedEndFrame / sampleRate,
    };
    state.waveformViewport.renderWidthPx = Math.max(1, uiState.viewport.renderWidthPx);
  }

  syncWaveformCanvasPresentation(uiState);
  requestWaveformRender(uiState);
  if (nextPresentedRange && !areTimeRangesEqual(previousPresentedRange, nextPresentedRange)) {
    syncPresentedSpectrogramRange(nextPresentedRange);
    scheduleSpectrogramRender();
    refreshHoveredSampleInfos();
  }

  if (shouldUseLightweightFollowUi(previousUiState, uiState)) {
    renderFollowPlaybackUi(previousUiState, uiState);
    applyTransportCommand(uiState.transportCommand);
    return;
  }

  renderWaveformUi();
  renderSpectrogramScale();
  applyTransportCommand(uiState.transportCommand);
}

function shouldUseLightweightFollowUi(
  previousUiState: ViewportUiState | null,
  nextUiState: ViewportUiState,
): boolean {
  if (
    !previousUiState
    || previousUiState.viewport.followEnabled !== true
    || nextUiState.viewport.followEnabled !== true
    || nextUiState.playback.playing !== true
    || nextUiState.transportCommand !== null
    || (state.renderedFrequencyTicks === null && nextUiState.frequencyTicks.length > 0)
  ) {
    return false;
  }

  return previousUiState.viewport.plotMode === nextUiState.viewport.plotMode
    && Math.abs(previousUiState.zoomFactor - nextUiState.zoomFactor) <= 1e-6
    && areFrequencyTicksEqual(previousUiState.frequencyTicks, nextUiState.frequencyTicks)
    && areSelectionAnchorsEqual(previousUiState.selection, nextUiState.selection);
}

function areSelectionAnchorsEqual(
  previousSelection: ViewportUiState['selection'],
  nextSelection: ViewportUiState['selection'],
): boolean {
  return previousSelection.committed === nextSelection.committed
    && previousSelection.startFrame === nextSelection.startFrame
    && previousSelection.endFrame === nextSelection.endFrame;
}

function renderFollowPlaybackUi(
  previousUiState: ViewportUiState,
  nextUiState: ViewportUiState,
): void {
  elements.waveFollow.checked = nextUiState.viewport.followEnabled;
  if (previousUiState.selection.active || nextUiState.selection.active) {
    renderSelectionAndLoop(nextUiState);
  }
  renderWaveformAxis();
  renderPlaybackIndicators(nextUiState);
}

function areFrequencyTicksEqual(
  previousTicks: ViewportUiState['frequencyTicks'] | null,
  nextTicks: ViewportUiState['frequencyTicks'],
): boolean {
  if (previousTicks === nextTicks) {
    return true;
  }

  if (!previousTicks || previousTicks.length !== nextTicks.length) {
    return false;
  }

  for (let index = 0; index < nextTicks.length; index += 1) {
    const previousTick = previousTicks[index];
    const nextTick = nextTicks[index];

    if (
      !previousTick
      || previousTick.edge !== nextTick.edge
      || previousTick.frequency !== nextTick.frequency
      || previousTick.label !== nextTick.label
      || Math.abs(previousTick.positionRatio - nextTick.positionRatio) > 1e-9
    ) {
      return false;
    }
  }

  return true;
}

function areWaveformAxisTicksEqual(
  previousTicks: ViewportUiState['waveformAxisTicks'] | null,
  nextTicks: ViewportUiState['waveformAxisTicks'],
): boolean {
  if (previousTicks === nextTicks) {
    return true;
  }

  if (!previousTicks || previousTicks.length !== nextTicks.length) {
    return false;
  }

  for (let index = 0; index < nextTicks.length; index += 1) {
    const previousTick = previousTicks[index];
    const nextTick = nextTicks[index];

    if (
      !previousTick
      || previousTick.align !== nextTick.align
      || previousTick.frame !== nextTick.frame
      || previousTick.label !== nextTick.label
      || Math.abs(previousTick.positionRatio - nextTick.positionRatio) > 1e-9
    ) {
      return false;
    }
  }

  return true;
}

function renderWaveformAxis(): void {
  const uiState = state.engineUiState;
  const waveformAxisTicks = uiState?.waveformAxisTicks ?? [];

  if (!uiState || waveformAxisTicks.length === 0) {
    if (!state.renderedWaveformAxisTicks && state.renderedWaveformAxisWidthPx === 0) {
      return;
    }

    elements.waveformAxis.replaceChildren();
    state.renderedWaveformAxisTicks = null;
    state.renderedWaveformAxisWidthPx = 0;
    return;
  }

  const renderWidthPx = Math.max(1, elements.waveformViewport.clientWidth);
  if (
    state.renderedWaveformAxisWidthPx === renderWidthPx
    && areWaveformAxisTicksEqual(state.renderedWaveformAxisTicks, waveformAxisTicks)
  ) {
    return;
  }

  const axisContent = document.createElement('div');
  axisContent.className = 'waveform-axis-content';
  axisContent.setAttribute('aria-hidden', 'true');
  axisContent.style.width = `${renderWidthPx}px`;

  for (const tick of waveformAxisTicks) {
    const tickElement = document.createElement('div');
    tickElement.className = 'waveform-axis-tick';
    tickElement.style.left = `${tick.positionRatio * 100}%`;
    tickElement.style.transform = tick.align === 'start'
      ? 'translateX(0)'
      : tick.align === 'end'
        ? 'translateX(-100%)'
        : 'translateX(-50%)';

    const topMark = document.createElement('div');
    topMark.className = 'waveform-axis-mark';
    const label = document.createElement('div');
    label.className = 'waveform-axis-label';
    label.textContent = tick.label;
    const bottomMark = document.createElement('div');
    bottomMark.className = 'waveform-axis-mark';
    tickElement.append(topMark, label, bottomMark);
    axisContent.append(tickElement);
  }

  elements.waveformAxis.replaceChildren(axisContent);
  state.renderedWaveformAxisTicks = waveformAxisTicks;
  state.renderedWaveformAxisWidthPx = renderWidthPx;
}

function renderSelectionAndLoop(uiState: ViewportUiState | null): void {
  const selection = uiState?.selection;
  const active = Boolean(selection?.active);

  for (const element of [elements.waveformSelection, elements.spectrogramSelection]) {
    element.style.display = active ? 'block' : 'none';
    element.style.left = active ? `${selection?.leftPercent ?? 0}%` : '0%';
    element.style.width = active ? `${selection?.widthPercent ?? 0}%` : '0%';
  }

  const showLoopHandles = active && selection?.committed === true;
  const startPercent = selection?.leftPercent ?? 0;
  const endPercent = (selection?.leftPercent ?? 0) + (selection?.widthPercent ?? 0);

  positionLoopHandle(elements.waveformLoopStart, elements.waveformViewport.clientWidth, startPercent, showLoopHandles);
  positionLoopHandle(elements.waveformLoopEnd, elements.waveformViewport.clientWidth, endPercent, showLoopHandles);
  positionLoopHandle(elements.spectrogramLoopStart, elements.spectrogramHitTarget.clientWidth, startPercent, showLoopHandles);
  positionLoopHandle(elements.spectrogramLoopEnd, elements.spectrogramHitTarget.clientWidth, endPercent, showLoopHandles);
}

function positionLoopHandle(element: HTMLElement, widthPx: number, percent: number, visible: boolean): void {
  element.style.display = visible ? 'block' : 'none';
  if (!visible) {
    element.style.left = '0px';
    return;
  }

  const x = (clamp(percent, 0, 100) / 100) * Math.max(0, widthPx);
  element.style.left = `${Math.max(0, x - LOOP_HANDLE_WIDTH_PX / 2)}px`;
}

function renderTransportOverview(uiState: ViewportUiState | null): void {
  if (!uiState) {
    elements.waveformOverviewThumb.hidden = true;
    elements.waveformOverviewThumb.style.left = '0%';
    elements.waveformOverviewThumb.style.width = '0%';
    elements.timelineLoopRange.hidden = true;
    elements.timelineLoopRange.style.left = '0%';
    elements.timelineLoopRange.style.width = '0%';
    return;
  }

  elements.timeline.disabled = !hasPlaybackTransport();
  elements.waveformOverviewThumb.hidden = uiState.overview.viewportWidthPercent <= 0;
  elements.waveformOverviewThumb.style.left = `${uiState.overview.viewportLeftPercent.toFixed(6)}%`;
  elements.waveformOverviewThumb.style.width = `${uiState.overview.viewportWidthPercent.toFixed(6)}%`;

  const selection = uiState.selection;
  const durationFrames = Math.max(0, uiState.playback.durationFrames || getDurationFrames());
  const hasTimelineLoop = typeof selection.startFrame === 'number'
    && typeof selection.endFrame === 'number'
    && durationFrames > 0;

  if (!hasTimelineLoop) {
    elements.timelineLoopRange.hidden = true;
    elements.timelineLoopRange.style.left = '0%';
    elements.timelineLoopRange.style.width = '0%';
  } else {
    const startFrame = clamp(Math.min(selection.startFrame ?? 0, selection.endFrame ?? 0), 0, durationFrames);
    const endFrame = clamp(Math.max(selection.startFrame ?? 0, selection.endFrame ?? 0), 0, durationFrames);
    const leftPercent = (startFrame / durationFrames) * 100;
    const widthPercent = ((endFrame - startFrame) / durationFrames) * 100;
    elements.timelineLoopRange.hidden = widthPercent <= 0;
    elements.timelineLoopRange.dataset.state = selection.committed ? 'committed' : 'draft';
    elements.timelineLoopRange.style.left = `${leftPercent.toFixed(6)}%`;
    elements.timelineLoopRange.style.width = `${widthPercent.toFixed(6)}%`;
  }
}

function getPlaybackPositionPx(percent: number, knownWidth: number, element: HTMLElement): number {
  const width = knownWidth > 0 ? knownWidth : element.clientWidth;
  return (clamp(percent, 0, 100) / 100) * Math.max(0, width);
}

function renderPlaybackPosition(uiState: ViewportUiState | null): void {
  const cursorVisible = uiState?.cursorVisible === true;
  const cursorPercent = uiState?.cursorPercent ?? 0;
  const progressScale = clamp(cursorPercent / 100, 0, 1);
  const waveformCursorX = getPlaybackPositionPx(
    cursorPercent,
    state.observedWaveformViewportWidth,
    elements.waveformViewport,
  );
  const spectrogramCursorX = getPlaybackPositionPx(
    cursorPercent,
    state.observedSpectrogramPixelWidth / DISPLAY_PIXEL_RATIO,
    elements.spectrogram,
  );

  elements.waveformProgress.style.transform = `scaleX(${progressScale})`;
  elements.waveformCursor.style.transform = `translate3d(${waveformCursorX.toFixed(3)}px, 0, 0)`;
  elements.waveformCursor.style.display = cursorVisible ? 'block' : 'none';
  elements.spectrogramProgress.style.transform = `scaleX(${progressScale})`;
  elements.spectrogramCursor.style.transform = `translate3d(${spectrogramCursorX.toFixed(3)}px, 0, 0)`;
  elements.spectrogramCursor.style.display = cursorVisible ? 'block' : 'none';

  const currentPercent = uiState?.overview.currentPercent ?? 0;
  elements.timeline.value = String(currentPercent / 100);
  if (!uiState?.overview.currentVisible) {
    elements.timelineCurrentMarker.hidden = true;
    elements.timelineCurrentMarker.style.transform = 'translate3d(0, -50%, 0) translateX(-50%)';
    return;
  }

  const timelineMarkerX = getPlaybackPositionPx(
    currentPercent,
    state.observedOverviewWidth,
    elements.waveformOverview,
  );
  elements.timelineCurrentMarker.hidden = false;
  elements.timelineCurrentMarker.style.transform = `translate3d(${timelineMarkerX.toFixed(3)}px, -50%, 0) translateX(-50%)`;
}

function renderPlaybackIndicators(uiState: ViewportUiState | null): void {
  renderTransportOverview(uiState);
  renderPlaybackPosition(uiState);
}

function formatVisibleDuration(seconds: number): string {
  if (!(seconds > 0)) {
    return '0 ms';
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds - minutes * 60;
    return `${minutes}:${remainder.toFixed(0).padStart(2, '0')}`;
  }
  if (seconds >= 1) {
    return `${seconds.toFixed(2)} s`;
  }
  const ms = seconds * 1000;
  return ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`;
}

// The visible window length — more meaningful than a file-relative multiplier.
function formatWaveformZoomLabel(uiState: ViewportUiState): string {
  const sampleRate = uiState.playback.sampleRate || getSampleRate();
  const spanFrames = uiState.presentedEndFrame - uiState.presentedStartFrame;
  if (!(sampleRate > 0) || !(spanFrames > 0)) {
    return formatVisibleDuration(0);
  }
  return formatVisibleDuration(spanFrames / sampleRate);
}

// Pixels-per-sample only says anything once individual samples are resolvable, and
// appending it to the readout was the widest thing that ever landed in the toolbar.
// It lives in the tooltip instead, where a variable width costs nothing.
function formatWaveformZoomTitle(uiState: ViewportUiState | null): string {
  const spanFrames = uiState ? uiState.presentedEndFrame - uiState.presentedStartFrame : 0;
  // The observed width, not a fresh clientWidth read: this runs on every follow frame.
  const viewportWidth = state.observedWaveformViewportWidth || getWaveformViewportSize().width;
  const pxPerSample = spanFrames > 0 ? viewportWidth / spanFrames : 0;
  const detail = pxPerSample >= 1
    ? ` · ${pxPerSample >= 10 ? Math.round(pxPerSample) : pxPerSample.toFixed(1)} px/sample`
    : '';
  return `X axis — length of the visible time window${detail}. Click to fit the whole file.`;
}

function renderWaveformUi(): void {
  const uiState = state.engineUiState;
  // The zoom readout is the reset button — clicking the value fits the whole file.
  elements.waveZoomReset.textContent = uiState ? formatWaveformZoomLabel(uiState) : formatVisibleDuration(0);
  elements.waveZoomReset.title = formatWaveformZoomTitle(uiState);
  elements.waveFollow.checked = state.followPlayback;

  const selection = uiState?.selection;
  const sampleRate = uiState?.playback.sampleRate || getSampleRate();
  const selectionLabel = selection && sampleRate > 0 && selection.startFrame !== null && selection.endFrame !== null
    ? `Loop ${formatAxisLabel(selection.startFrame / sampleRate)} - ${formatAxisLabel(selection.endFrame / sampleRate)}`
    : 'Drag to set loop';

  elements.waveLoopLabel.textContent = '↻ Loop';
  elements.waveLoopLabel.setAttribute('aria-label', selectionLabel);
  const loopActive = selection?.committed === true;
  elements.waveLoopLabel.dataset.active = loopActive ? 'true' : 'false';
  elements.waveLoopLabel.parentElement?.setAttribute('data-active', loopActive ? 'true' : 'false');
  elements.waveClearLoop.disabled = !(selection?.committed);
  const exportDisabled = getExportRangeSeconds() === null;
  elements.waveExport.disabled = exportDisabled;
  elements.waveExportFormat.disabled = !(getDurationFrames() > 0);
  for (const button of elements.waveOverflowMenu.querySelectorAll<HTMLButtonElement>('[data-export-format]')) {
    button.disabled = exportDisabled;
  }
  if (exportDisabled) {
    closeWaveExportMenu();
  }
  renderWaveformAxis();
  renderSelectionAndLoop(uiState);
  renderPlaybackIndicators(uiState);
}

function normalizeWaveformAmplitudeMax(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WAVEFORM_AMPLITUDE_MAX;
  }
  // Same bounds the renderer clamps to; 3 decimals keeps the input readable.
  return Number(clamp(numeric, WAVEFORM_AMPLITUDE_MAX_MIN, 1).toFixed(3));
}

function formatWaveformAmplitudeMax(value: number): string {
  return String(Number(value.toFixed(3)));
}

// One step is ~1 dB, so the range stays fine-grained at both ends of the scale.
// Rounding can swallow a step near the floor, hence the 0.001 nudge.
function stepWaveformAmplitudeMax(direction: 'in' | 'out'): number {
  const current = state.waveformAmplitudeMax;
  const scaled = normalizeWaveformAmplitudeMax(direction === 'in' ? current / 1.122 : current * 1.122);
  if (scaled !== current) {
    return scaled;
  }
  return normalizeWaveformAmplitudeMax(direction === 'in' ? current - 0.001 : current + 0.001);
}

function renderWaveformAmplitudeUi(): void {
  const label = formatWaveformAmplitudeMax(state.waveformAmplitudeMax);
  elements.waveAmpReset.textContent = label;
  elements.waveformLevelLabelPositive.textContent = label;
  elements.waveformLevelLabelNegative.textContent = `-${label}`;
  elements.waveAmpIn.disabled = state.waveformAmplitudeMax <= WAVEFORM_AMPLITUDE_MAX_MIN;
  elements.waveAmpOut.disabled = state.waveformAmplitudeMax >= 1;
}

// Fit: scale the Y axis so the loudest sample in the rendered window reaches the
// guide lines. The worker reports that peak with every presented frame.
function fitWaveformAmplitudeToView(): void {
  const peak = state.waveformViewport.presentedPeak;
  if (!(peak > 0)) {
    return;
  }
  applyWaveformAmplitudeMax(normalizeWaveformAmplitudeMax(peak));
}

// Drops the request dedupe state so the next requestWaveformRender re-sends
// even for an unchanged view range (needed when only the amplitude scale changed).
function forceWaveformRerender(): void {
  state.waveformViewport.activeRenderRange = null;
  state.waveformViewport.pendingRenderRange = null;
  requestWaveformRender();
}

function schedulePersistWaveformAmplitudeMax(): void {
  if (state.waveformAmplitudeMaxPersistTimer) {
    window.clearTimeout(state.waveformAmplitudeMaxPersistTimer);
  }

  state.waveformAmplitudeMaxPersistTimer = window.setTimeout(() => {
    state.waveformAmplitudeMaxPersistTimer = null;
    vscode.postMessage({
      type: 'persistWaveformAmplitudeMax',
      body: { amplitudeMax: state.waveformAmplitudeMax },
    });
  }, 160);
}

function applyWaveformAmplitudeMax(value: number, { persist = true } = {}): void {
  const nextValue = normalizeWaveformAmplitudeMax(value);
  const changed = Math.abs(nextValue - state.waveformAmplitudeMax) > 1e-9;
  state.waveformAmplitudeMax = nextValue;
  renderWaveformAmplitudeUi();

  if (!changed) {
    return;
  }
  forceWaveformRerender();
  if (persist) {
    schedulePersistWaveformAmplitudeMax();
  }
}

function schedulePersistViewportSplitRatio(): void {
  if (state.viewportSplitRatioPersistTimer) {
    window.clearTimeout(state.viewportSplitRatioPersistTimer);
  }

  state.viewportSplitRatioPersistTimer = window.setTimeout(() => {
    state.viewportSplitRatioPersistTimer = null;
    vscode.postMessage({
      type: 'persistViewportSplitRatio',
      body: { ratio: clamp(state.viewportSplitRatio, VIEWPORT_RATIO_MIN, VIEWPORT_RATIO_MAX) },
    });
  }, 160);
}

function renderPlaybackVolumeUi(): void {
  const percent = `${Math.round(state.playbackVolume * 100)}%`;
  const boosted = state.playbackVolume > 1;
  const boostLabel = boosted ? `+${playbackVolumeToDecibels(state.playbackVolume).toFixed(1)} dB` : '';
  const valueLabel = boosted ? boostLabel : percent;
  elements.volumeSlider.value = String(playbackVolumeToSliderValue(state.playbackVolume));
  elements.volumeSlider.dataset.boosted = boosted ? 'true' : 'false';
  elements.volumeLabel.dataset.boosted = boosted ? 'true' : 'false';
  elements.volumeSlider.setAttribute('aria-valuetext', boosted ? `${boostLabel} boost` : percent);
  elements.volumeSlider.title = boosted
    ? `Volume ${boostLabel} boost (Up/Down Arrow; max +${MAX_PLAYBACK_BOOST_DB} dB)`
    : `Volume ${percent} (Up/Down Arrow; boost up to +${MAX_PLAYBACK_BOOST_DB} dB)`;
  elements.volumeLabel.textContent = valueLabel;
  elements.volumeToggle.textContent = '\u{1F508}\uFE0E';
  elements.volumeToggle.setAttribute(
    'aria-label',
    boosted ? `Playback volume ${boostLabel} boost` : `Playback volume ${percent}`,
  );
  elements.volumeToggle.title = `Volume ${valueLabel} — hover or focus to adjust`;
}

function schedulePersistPlaybackVolume(): void {
  if (state.playbackVolumePersistTimer) {
    window.clearTimeout(state.playbackVolumePersistTimer);
  }

  state.playbackVolumePersistTimer = window.setTimeout(() => {
    state.playbackVolumePersistTimer = null;
    vscode.postMessage({
      type: 'persistPlaybackVolume',
      body: { volume: state.playbackVolume },
    });
  }, 160);
}

function applyPlaybackVolume(value: unknown): void {
  state.playbackVolume = snapPlaybackVolume(value);
  renderPlaybackVolumeUi();
  state.audioTransport?.setVolume(state.playbackVolume);
  schedulePersistPlaybackVolume();
}

function stepPlaybackVolume(direction: -1 | 1): void {
  if (state.playbackVolume > 1 || (state.playbackVolume === 1 && direction > 0)) {
    const currentDb = state.playbackVolume > 1 ? playbackVolumeToDecibels(state.playbackVolume) : 0;
    const nextDb = clamp(currentDb + direction, 0, MAX_PLAYBACK_BOOST_DB);
    applyPlaybackVolume(playbackVolumeFromSliderValue(1 + (nextDb / MAX_PLAYBACK_BOOST_DB)));
    return;
  }
  const currentPercent = Math.round(state.playbackVolume * 100);
  applyPlaybackVolume((currentPercent + (direction * 5)) / 100);
}

// Export range: the committed loop selection. No selection, nothing to export.
function getExportRangeSeconds(): { end: number; start: number } | null {
  const sampleRate = getSampleRate();
  if (!(sampleRate > 0) || !(getDurationFrames() > 0)) {
    return null;
  }

  const selection = state.engineUiState?.selection;
  if (
    selection?.committed
    && selection.startFrame !== null
    && selection.endFrame !== null
    && selection.endFrame > selection.startFrame
  ) {
    return { end: selection.endFrame / sampleRate, start: selection.startFrame / sampleRate };
  }

  return null;
}

function isExportAudioFormat(value: unknown): value is ExportAudioFormat {
  return value === 'wav' || value === 'mp3' || value === 'm4a' || value === 'flac';
}

function exportSelectedAudio(format: ExportAudioFormat): void {
  const range = getExportRangeSeconds();
  if (!range) {
    return;
  }

  elements.waveExportFormat.value = format;
  vscode.postMessage({
    type: 'exportAudio',
    body: {
      endSeconds: range.end,
      format,
      startSeconds: range.start,
    },
  });
}

function getWaveMenuButtons(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
}

function positionWaveMenu(menu: HTMLElement, trigger: HTMLElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  const menuWidth = Math.max(Math.ceil(triggerRect.width), Math.ceil(menu.offsetWidth || 0));
  const menuHeight = Math.ceil(menu.offsetHeight || 0);
  const viewportPadding = 8;
  const offset = 4;
  const top = Math.min(
    Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding),
    Math.round(triggerRect.bottom + offset),
  );
  const left = Math.min(
    Math.max(viewportPadding, Math.round(triggerRect.right - menuWidth)),
    Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
  );

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function closeWaveExportMenu({ restoreFocus = false } = {}): void {
  state.waveExportMenuOpen = false;
  elements.waveExportLayer.hidden = true;
  elements.waveExport.setAttribute('aria-expanded', 'false');
  elements.waveExportMenu.style.top = '';
  elements.waveExportMenu.style.left = '';
  if (restoreFocus) {
    elements.waveExport.focus();
  }
}

function openWaveExportMenu(): void {
  if (elements.waveExport.disabled) {
    return;
  }
  closeWaveOverflowMenu();
  closePlaybackRateMenu();
  setSpectrogramMetaOpen(false);
  state.waveExportMenuOpen = true;
  elements.waveExportLayer.hidden = false;
  elements.waveExport.setAttribute('aria-expanded', 'true');
  positionWaveMenu(elements.waveExportMenu, elements.waveExport);
  getWaveMenuButtons(elements.waveExportMenu)[0]?.focus();
}

function closeWaveOverflowMenu({ restoreFocus = false } = {}): void {
  state.waveOverflowMenuOpen = false;
  elements.waveOverflowLayer.hidden = true;
  elements.waveOverflowToggle.setAttribute('aria-expanded', 'false');
  elements.waveOverflowMenu.style.top = '';
  elements.waveOverflowMenu.style.left = '';
  if (restoreFocus) {
    elements.waveOverflowToggle.focus();
  }
}

function openWaveOverflowMenu(): void {
  closeWaveExportMenu();
  closePlaybackRateMenu();
  setSpectrogramMetaOpen(false);
  state.waveOverflowMenuOpen = true;
  elements.waveOverflowLayer.hidden = false;
  elements.waveOverflowToggle.setAttribute('aria-expanded', 'true');
  positionWaveMenu(elements.waveOverflowMenu, elements.waveOverflowToggle);
  getWaveMenuButtons(elements.waveOverflowMenu)[0]?.focus();
}

function closeWaveMenus(): void {
  closeWaveExportMenu();
  closeWaveOverflowMenu();
}

function isWaveMenuUiTarget(target: EventTarget | null): boolean {
  return target instanceof Node && (
    elements.waveExport.contains(target)
    || elements.waveExportLayer.contains(target)
    || elements.waveOverflowToggle.contains(target)
    || elements.waveOverflowLayer.contains(target)
  );
}

function handleWaveMenuKeydown(
  event: KeyboardEvent,
  menu: HTMLElement,
  close: (options?: { restoreFocus?: boolean }) => void,
): void {
  if (event.code === 'Escape') {
    event.preventDefault();
    close({ restoreFocus: true });
    return;
  }

  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.code)) {
    return;
  }

  const buttons = getWaveMenuButtons(menu);
  if (buttons.length === 0) {
    return;
  }
  event.preventDefault();
  const activeIndex = buttons.findIndex((button) => button === document.activeElement);
  const nextIndex = event.code === 'Home'
    ? 0
    : event.code === 'End'
      ? buttons.length - 1
      : (Math.max(0, activeIndex) + (event.code === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}

function renderSpectrogramScale(): void {
  const frequencyTicks = state.engineUiState?.frequencyTicks ?? [];
  const axisHeightPx = elements.spectrogramStage.clientHeight;

  if (frequencyTicks.length === 0) {
    if (!state.renderedFrequencyTicks) {
      return;
    }

    elements.spectrogramAxis.replaceChildren();
    elements.spectrogramGuides.replaceChildren();
    state.renderedFrequencyTicks = null;
    state.renderedFrequencyAxisHeightPx = 0;
    return;
  }

  const laneCount = getSpectrogramLaneCount();
  if (
    laneCount === state.renderedFrequencyLaneCount
    && axisHeightPx === state.renderedFrequencyAxisHeightPx
    && areFrequencyTicksEqual(state.renderedFrequencyTicks, frequencyTicks)
  ) {
    return;
  }

  const axisFragment = document.createDocumentFragment();
  const guideFragment = document.createDocumentFragment();
  const visibleTicks = createVisibleFrequencyAxisTicks({
    axisHeightPx,
    laneCount,
    ticks: frequencyTicks,
  });
  const visibleTickByKey = new Map(
    visibleTicks.map((tick) => [`${tick.lane}:${tick.tickIndex}`, tick]),
  );

  // Each channel lane spans the full frequency range within its own vertical
  // band, so the ticks/guides repeat once per lane.
  for (let lane = 0; lane < laneCount; lane += 1) {
    for (const [tickIndex, tick] of frequencyTicks.entries()) {
      // The lowest-frequency (bottom-edge) label of an interior lane sits at the
      // same y as the next lane's top label, so drop it to avoid the collision.
      if (tick.edge === 'bottom' && lane < laneCount - 1) {
        continue;
      }
      const positionRatio = (lane + tick.positionRatio) / laneCount;
      const visibleTick = visibleTickByKey.get(`${lane}:${tickIndex}`);

      if (visibleTick) {
        const axisTick = document.createElement('div');
        axisTick.className = 'spectrogram-tick';
        if (visibleTick.edge === 'top') {
          axisTick.classList.add('spectrogram-tick-edge-top');
        } else if (visibleTick.edge === 'bottom') {
          axisTick.classList.add('spectrogram-tick-edge-bottom');
        }
        axisTick.style.top = `${positionRatio * 100}%`;

        const label = document.createElement('span');
        label.className = 'spectrogram-tick-label';
        label.textContent = tick.label;
        axisTick.append(label);
        axisFragment.append(axisTick);
      }

      const guide = document.createElement('div');
      guide.className = 'spectrogram-guide';
      guide.style.top = `${positionRatio * 100}%`;
      guideFragment.append(guide);
    }
  }

  elements.spectrogramAxis.replaceChildren(axisFragment);
  elements.spectrogramGuides.replaceChildren(guideFragment);
  state.renderedFrequencyTicks = frequencyTicks;
  state.renderedFrequencyAxisHeightPx = axisHeightPx;
  state.renderedFrequencyLaneCount = laneCount;
}

function updateLoudnessLegendDom(body: {
  maxLufs?: number;
  minLufs?: number;
  refLevel?: number | null;
} | null): void {
  if (!body) { return; }

  const ref = body.refLevel;
  const minL = body.minLufs ?? -60;
  const maxL = body.maxLufs ?? 0;
  const refVisible = ref !== null && ref !== undefined && ref >= minL && ref <= maxL;
  elements.loudnessRefLabel.hidden = !refVisible;
  if (refVisible) {
    const pct = ((maxL - ref) / Math.max(1, maxL - minL)) * 100;
    elements.loudnessRefLabel.style.top = `${pct.toFixed(3)}%`;
    elements.loudnessRefLabel.textContent = `${ref} LUFS`;
  }
}

function renderSpectrogramMeta(): void {
  const analysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
  const isChroma = analysisType === 'chroma';
  const isLoudness = analysisType === 'loudness';
  const supportsScale = analysisType === 'spectrogram';
  const supportsMelBands = analysisType === 'mel';
  const supportsMfccOptions = analysisType === 'mfcc';
  const supportsScalogramOptions = analysisType === 'scalogram';
  const supportsWindowControl = analysisType !== 'scalogram' && !isLoudness;
  const supportsDbWindow = analysisType !== 'mfcc' && !isChroma && !isLoudness;
  const isScalogram = analysisType === 'scalogram';
  const dbWindow = normalizeSpectrogramDbWindow(
    state.spectrogramConfig.minDecibels,
    state.spectrogramConfig.maxDecibels,
    analysisType,
  );
  const normalizedOverlapRatio = normalizeSpectrogramOverlapRatio(state.spectrogramConfig.overlapRatio);
  const computedHopSamples = getEffectiveSpectrogramHopSamples(
    analysisType,
    normalizeSpectrogramFftSize(state.spectrogramConfig.fftSize),
    normalizedOverlapRatio,
  );
  elements.spectrogramTypeSelect.value = analysisType;
  elements.spectrogramFftSelect.value = String(state.spectrogramConfig.fftSize);
  elements.spectrogramOverlapSelect.value = String(normalizedOverlapRatio);
  elements.spectrogramWindowSelect.value = normalizeSpectrogramWindowFunction(state.spectrogramConfig.windowFunction);
  elements.spectrogramScaleSelect.value = normalizeSpectrogramFrequencyScale(state.spectrogramConfig.frequencyScale);
  elements.spectrogramMelBandsSelect.value = String(
    normalizeSpectrogramMelBandCount(state.spectrogramConfig.melBandCount),
  );
  elements.spectrogramMfccCoefficientsSelect.value = String(
    normalizeSpectrogramMfccCoefficientCount(state.spectrogramConfig.mfccCoefficientCount),
  );
  elements.spectrogramMfccMelBandsSelect.value = String(
    normalizeSpectrogramMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount),
  );
  elements.spectrogramScalogramOmegaSlider.value = String(
    getSpectrogramScalogramOmegaSliderIndex(state.spectrogramConfig.scalogramOmega0),
  );
  elements.spectrogramScalogramOmegaValue.textContent = String(
    normalizeSpectrogramScalogramOmega0(state.spectrogramConfig.scalogramOmega0),
  );
  elements.spectrogramScalogramHopValue.textContent = formatSpectrogramHopSizeText(computedHopSamples);
  elements.spectrogramScalogramHopValue.title = analysisType === 'scalogram' || isChroma
    ? `Computed from overlap ${Math.round(normalizedOverlapRatio * 1000) / 10}% and current quality`
    : `Computed from FFT ${normalizeSpectrogramFftSize(state.spectrogramConfig.fftSize)} and overlap ${Math.round(normalizedOverlapRatio * 1000) / 10}%`;
  elements.spectrogramDistributionSelect.value = normalizeSpectrogramColormapDistribution(
    state.spectrogramConfig.colormapDistribution,
  );
  const analysisTypeLabel = getSpectrogramAnalysisTypeLabel(analysisType);
  elements.spectrogramResetTypeButton.setAttribute('aria-label', `Reset ${analysisTypeLabel} settings to defaults`);
  elements.spectrogramResetTypeButton.title = `Reset ${analysisTypeLabel} settings to defaults`;

  elements.spectrogramFftControl.hidden = isScalogram || isLoudness;
  elements.spectrogramOverlapControl.hidden = isLoudness;
  elements.spectrogramWindowControl.hidden = !supportsWindowControl;
  elements.spectrogramScaleControl.hidden = !supportsScale;
  elements.spectrogramMelBandsControl.hidden = !supportsMelBands;
  elements.spectrogramMfccCoefficientsControl.hidden = !supportsMfccOptions;
  elements.spectrogramMfccMelBandsControl.hidden = !supportsMfccOptions;
  elements.spectrogramScalogramOmegaControl.hidden = !supportsScalogramOptions;
  elements.spectrogramDbRangeControl.hidden = !supportsDbWindow;
  elements.spectrogramDistributionControl.hidden = isLoudness;
  elements.spectrogramFftSelect.disabled = isScalogram || isChroma || isLoudness;
  elements.spectrogramOverlapSelect.disabled = isLoudness;
  elements.spectrogramWindowSelect.disabled = !supportsWindowControl;
  elements.spectrogramScaleSelect.disabled = !supportsScale;
  elements.spectrogramMelBandsSelect.disabled = !supportsMelBands;
  elements.spectrogramMfccCoefficientsSelect.disabled = !supportsMfccOptions;
  elements.spectrogramMfccMelBandsSelect.disabled = !supportsMfccOptions;
  elements.spectrogramScalogramOmegaSlider.disabled = !supportsScalogramOptions;
  elements.spectrogramMinDbSlider.disabled = !supportsDbWindow;
  elements.spectrogramMaxDbSlider.disabled = !supportsDbWindow;

  // Frequency Y-axis range: spectrogram/mel/mfcc share it; scalogram has its own,
  // chroma is pitch-class, loudness has no frequency axis.
  const supportsFreqRange = analysisType === 'spectrogram' || analysisType === 'mel' || analysisType === 'mfcc';
  elements.spectrogramFreqRangeControl.hidden = !supportsFreqRange;
  elements.spectrogramFreqMinInput.disabled = !supportsFreqRange;
  elements.spectrogramFreqMaxInput.disabled = !supportsFreqRange;
  if (supportsFreqRange) {
    const freqRange = normalizeSpectrogramScalogramFrequencyRange(
      state.spectrogramConfig.spectrogramMinFrequency,
      state.spectrogramConfig.spectrogramMaxFrequency,
    );
    elements.spectrogramFreqMinInput.value = String(freqRange.minFrequency);
    elements.spectrogramFreqMaxInput.value = String(freqRange.maxFrequency);
  }

  // Loudness-specific controls.
  const loudnessYAxisMode = normalizeLoudnessYAxisMode(state.spectrogramConfig.loudnessYAxisMode);
  const loudnessYAxisRange = normalizeLoudnessYAxisRange(
    state.spectrogramConfig.loudnessYAxisMin,
    state.spectrogramConfig.loudnessYAxisMax,
  );
  const loudnessCurves = normalizeLoudnessCurves(state.spectrogramConfig.loudnessCurves);
  const loudnessRefPreset = normalizeLoudnessRefPreset(state.spectrogramConfig.loudnessRefPreset);
  const loudnessRefCustom = normalizeLoudnessRefCustom(state.spectrogramConfig.loudnessRefCustom);
  const isYAxisFixed = loudnessYAxisMode === 'fixed';
  if (!isLoudness) { elements.loudnessRefLabel.hidden = true; }
  elements.loudnessRefControl.hidden = !isLoudness;
  elements.loudnessYAxisControl.hidden = !isLoudness;
  elements.loudnessYRangeControl.hidden = !isLoudness || !isYAxisFixed;
  elements.loudnessCurvesControl.hidden = !isLoudness;
  elements.loudnessPeakControl.hidden = !isLoudness;
  elements.loudnessRefSelect.value = loudnessRefPreset;
  elements.loudnessRefInput.hidden = loudnessRefPreset !== 'custom';
  elements.loudnessRefInput.value = String(loudnessRefCustom);
  elements.loudnessYAxisSelect.value = loudnessYAxisMode;
  elements.loudnessMinLufsSlider.value = String(loudnessYAxisRange.min);
  elements.loudnessMaxLufsSlider.value = String(loudnessYAxisRange.max);
  elements.loudnessYRangeValue.textContent = `Min ${loudnessYAxisRange.min} / Max ${loudnessYAxisRange.max} LUFS`;
  if (isLoudness && isYAxisFixed) {
    const rangeMin = -70;
    const rangeMax = 6;
    const rangeSpan = rangeMax - rangeMin;
    const startPct = ((loudnessYAxisRange.min - rangeMin) / rangeSpan) * 100;
    const endPct = ((loudnessYAxisRange.max - rangeMin) / rangeSpan) * 100;
    elements.loudnessYRangeGroup.style.setProperty('--range-start', `${startPct.toFixed(3)}%`);
    elements.loudnessYRangeGroup.style.setProperty('--range-end', `${endPct.toFixed(3)}%`);
  }
  elements.loudnessCurvesSelect.value = loudnessCurves;
  elements.loudnessPeakSelect.value = state.spectrogramConfig.loudnessShowPeak ? 'show' : 'hide';

  renderSpectrogramDbWindowUi(dbWindow);
  setSpectrogramMetaOpen(state.spectrogramMetaOpen);
}

function renderSpectrogramDbWindowUi(dbWindow: { maxDecibels: number; minDecibels: number }): void {
  elements.spectrogramMinDbSlider.value = String(dbWindow.minDecibels);
  elements.spectrogramMaxDbSlider.value = String(dbWindow.maxDecibels);
  const rangeStartPercent = ((dbWindow.minDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.min)
    / (SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.min)) * 100;
  const rangeEndPercent = ((dbWindow.maxDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.min)
    / (SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.min)) * 100;
  elements.spectrogramDbRangeGroup.style.setProperty('--range-start', `${rangeStartPercent.toFixed(3)}%`);
  elements.spectrogramDbRangeGroup.style.setProperty('--range-end', `${rangeEndPercent.toFixed(3)}%`);
  elements.spectrogramDbRangeValue.textContent = `Min ${dbWindow.minDecibels} / Max ${dbWindow.maxDecibels} dB`;
}

function setSpectrogramMetaOpen(open: boolean): void {
  if (open) {
    closeWaveMenus();
    closePlaybackRateMenu();
  }
  state.spectrogramMetaOpen = open;
  elements.spectrogramMeta.dataset.open = open ? 'true' : 'false';
  elements.spectrogramMetaControls.hidden = !open;
  if (open) {
    // Drop the panel right under its toolbar button and let it use the rest of the window.
    const anchor = elements.spectrogramMetaToggle.getClientRects().length > 0
      ? elements.spectrogramMetaToggle
      : elements.waveOverflowToggle;
    const trigger = anchor.getBoundingClientRect();
    const top = Math.round(trigger.bottom + 4);
    elements.spectrogramMeta.style.top = `${top}px`;
    elements.spectrogramMeta.style.right = `${Math.round(Math.max(8, window.innerWidth - trigger.right))}px`;
    elements.spectrogramMeta.style.maxHeight = `${Math.max(120, window.innerHeight - top - 12)}px`;
  }
  elements.spectrogramMetaToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  elements.spectrogramMetaToggle.setAttribute(
    'aria-label',
    open ? 'Hide spectrogram settings' : 'Show spectrogram settings',
  );
  elements.spectrogramMetaToggle.title = open ? 'Hide spectrogram settings' : 'Spectrogram settings';
  elements.waveOverflowSettings.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function getEffectiveSpectrogramRenderConfig() {
  const analysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
  const dbWindow = normalizeSpectrogramDbWindow(
    state.spectrogramConfig.minDecibels,
    state.spectrogramConfig.maxDecibels,
    analysisType,
  );
  const scalogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
    state.spectrogramConfig.scalogramMinFrequency,
    state.spectrogramConfig.scalogramMaxFrequency,
  );
  // Reuses the scalogram [20, nyquist] clamp; this is the general Y-axis
  // frequency range applied to spectrogram/mel/mfcc views.
  const spectrogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
    state.spectrogramConfig.spectrogramMinFrequency,
    state.spectrogramConfig.spectrogramMaxFrequency,
  );
  const loudnessYAxisRange = normalizeLoudnessYAxisRange(
    state.spectrogramConfig.loudnessYAxisMin,
    state.spectrogramConfig.loudnessYAxisMax,
  );
  const fftSize = normalizeSpectrogramFftSize(state.spectrogramConfig.fftSize);
  const overlapRatio = normalizeSpectrogramOverlapRatio(state.spectrogramConfig.overlapRatio);
  return {
    analysisType,
    colormapDistribution: normalizeSpectrogramColormapDistribution(state.spectrogramConfig.colormapDistribution),
    fftSize,
    frequencyScale: analysisType === 'spectrogram'
      ? normalizeSpectrogramFrequencyScale(state.spectrogramConfig.frequencyScale)
      : 'log' as SpectrogramFrequencyScale,
    maxDecibels: dbWindow.maxDecibels,
    melBandCount: analysisType === 'mfcc'
      ? normalizeSpectrogramMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount)
      : normalizeSpectrogramMelBandCount(state.spectrogramConfig.melBandCount),
    mfccCoefficientCount: normalizeSpectrogramMfccCoefficientCount(state.spectrogramConfig.mfccCoefficientCount),
    mfccMelBandCount: normalizeSpectrogramMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount),
    windowFunction: normalizeSpectrogramWindowFunction(state.spectrogramConfig.windowFunction),
    scalogramHopSamples: getEffectiveSpectrogramHopSamples(analysisType, fftSize, overlapRatio),
    scalogramMaxFrequency: scalogramFrequencyRange.maxFrequency,
    scalogramMinFrequency: scalogramFrequencyRange.minFrequency,
    scalogramOmega0: normalizeSpectrogramScalogramOmega0(state.spectrogramConfig.scalogramOmega0),
    scalogramRowDensity: normalizeSpectrogramScalogramRowDensity(state.spectrogramConfig.scalogramRowDensity),
    spectrogramMaxFrequency: spectrogramFrequencyRange.maxFrequency,
    spectrogramMinFrequency: spectrogramFrequencyRange.minFrequency,
    minDecibels: dbWindow.minDecibels,
    overlapRatio,
    loudnessRefLevel: getConfiguredLoudnessRefLevel(),
    loudnessYAxisMode: normalizeLoudnessYAxisMode(state.spectrogramConfig.loudnessYAxisMode),
    loudnessYAxisMin: loudnessYAxisRange.min,
    loudnessYAxisMax: loudnessYAxisRange.max,
    loudnessCurves: normalizeLoudnessCurves(state.spectrogramConfig.loudnessCurves),
    loudnessShowPeak: Boolean(state.spectrogramConfig.loudnessShowPeak),
  };
}

function getPersistedSpectrogramDefaults() {
  const {
    scalogramHopSamples: _derivedScalogramHopSamples,
    ...persistedDefaults
  } = getEffectiveSpectrogramRenderConfig();

  return {
    ...persistedDefaults,
    // The effective range is clamped to the current file's Nyquist frequency.
    // Persist the requested global range so low-rate files do not narrow later files.
    spectrogramMaxFrequency: state.spectrogramConfig.spectrogramMaxFrequency,
    spectrogramMinFrequency: state.spectrogramConfig.spectrogramMinFrequency,
  };
}

function applyPersistedSpectrogramDefaults(defaults: any): void {
  state.spectrogramConfig.analysisType = normalizeSpectrogramAnalysisType(defaults?.analysisType);
  state.spectrogramConfig.colormapDistribution = normalizeSpectrogramColormapDistribution(defaults?.colormapDistribution);
  state.spectrogramConfig.fftSize = normalizeSpectrogramFftSize(defaults?.fftSize);
  state.spectrogramConfig.frequencyScale = normalizeSpectrogramFrequencyScale(defaults?.frequencyScale);
  state.spectrogramConfig.maxDecibels = Number.isFinite(Number(defaults?.maxDecibels))
    ? Math.round(Number(defaults.maxDecibels))
    : state.spectrogramConfig.maxDecibels;
  state.spectrogramConfig.melBandCount = normalizeSpectrogramMelBandCount(defaults?.melBandCount);
  state.spectrogramConfig.mfccCoefficientCount = normalizeSpectrogramMfccCoefficientCount(defaults?.mfccCoefficientCount);
  state.spectrogramConfig.mfccMelBandCount = normalizeSpectrogramMfccMelBandCount(defaults?.mfccMelBandCount);
  state.spectrogramConfig.minDecibels = Number.isFinite(Number(defaults?.minDecibels))
    ? Math.round(Number(defaults.minDecibels))
    : state.spectrogramConfig.minDecibels;
  state.spectrogramConfig.overlapRatio = normalizeSpectrogramOverlapRatio(defaults?.overlapRatio);
  state.spectrogramConfig.scalogramHopSamples = normalizeSpectrogramScalogramHopSetting(defaults?.scalogramHopSamples);
  const scalogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
    defaults?.scalogramMinFrequency,
    defaults?.scalogramMaxFrequency,
  );
  state.spectrogramConfig.scalogramMinFrequency = scalogramFrequencyRange.minFrequency;
  state.spectrogramConfig.scalogramMaxFrequency = scalogramFrequencyRange.maxFrequency;
  const spectrogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
    defaults?.spectrogramMinFrequency,
    defaults?.spectrogramMaxFrequency,
  );
  state.spectrogramConfig.spectrogramMinFrequency = spectrogramFrequencyRange.minFrequency;
  state.spectrogramConfig.spectrogramMaxFrequency = spectrogramFrequencyRange.maxFrequency;
  state.spectrogramConfig.scalogramOmega0 = normalizeSpectrogramScalogramOmega0(defaults?.scalogramOmega0);
  state.spectrogramConfig.scalogramRowDensity = normalizeSpectrogramScalogramRowDensity(defaults?.scalogramRowDensity);
  state.spectrogramConfig.windowFunction = normalizeSpectrogramWindowFunction(defaults?.windowFunction);
  applyLoudnessRefLevel(defaults?.loudnessRefLevel);
  state.spectrogramConfig.loudnessYAxisMode = normalizeLoudnessYAxisMode(defaults?.loudnessYAxisMode);
  const loudnessYAxisRange = normalizeLoudnessYAxisRange(
    defaults?.loudnessYAxisMin,
    defaults?.loudnessYAxisMax,
  );
  state.spectrogramConfig.loudnessYAxisMin = loudnessYAxisRange.min;
  state.spectrogramConfig.loudnessYAxisMax = loudnessYAxisRange.max;
  state.spectrogramConfig.loudnessCurves = normalizeLoudnessCurves(defaults?.loudnessCurves);
  state.spectrogramConfig.loudnessShowPeak = defaults?.loudnessShowPeak === true;
}

function resetCurrentSpectrogramTypeToDefaults(): void {
  const analysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
  const dbWindow = getDefaultSpectrogramDbWindow(analysisType);

  state.spectrogramConfig.colormapDistribution = DEFAULT_SPECTROGRAM_COLORMAP_DISTRIBUTION;

  switch (analysisType) {
    case 'spectrogram':
      state.spectrogramConfig.fftSize = DEFAULT_SPECTROGRAM_FFT_SIZE;
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.frequencyScale = DEFAULT_SPECTROGRAM_FREQUENCY_SCALE;
      state.spectrogramConfig.spectrogramMinFrequency = DEFAULT_SCALOGRAM_MIN_FREQUENCY;
      state.spectrogramConfig.spectrogramMaxFrequency = DEFAULT_SCALOGRAM_MAX_FREQUENCY;
      state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
      state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
      break;
    case 'mel':
      state.spectrogramConfig.fftSize = DEFAULT_SPECTROGRAM_FFT_SIZE;
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.melBandCount = DEFAULT_MEL_BAND_COUNT;
      state.spectrogramConfig.spectrogramMinFrequency = DEFAULT_SCALOGRAM_MIN_FREQUENCY;
      state.spectrogramConfig.spectrogramMaxFrequency = DEFAULT_SCALOGRAM_MAX_FREQUENCY;
      state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
      state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
      break;
    case 'mfcc':
      state.spectrogramConfig.fftSize = DEFAULT_SPECTROGRAM_FFT_SIZE;
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.mfccCoefficientCount = DEFAULT_MFCC_COEFFICIENT_COUNT;
      state.spectrogramConfig.mfccMelBandCount = DEFAULT_MFCC_MEL_BAND_COUNT;
      state.spectrogramConfig.spectrogramMinFrequency = DEFAULT_SCALOGRAM_MIN_FREQUENCY;
      state.spectrogramConfig.spectrogramMaxFrequency = DEFAULT_SCALOGRAM_MAX_FREQUENCY;
      break;
    case 'scalogram':
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.scalogramHopSamples = DEFAULT_SCALOGRAM_HOP_SAMPLES;
      state.spectrogramConfig.scalogramMinFrequency = DEFAULT_SCALOGRAM_MIN_FREQUENCY;
      state.spectrogramConfig.scalogramMaxFrequency = DEFAULT_SCALOGRAM_MAX_FREQUENCY;
      state.spectrogramConfig.scalogramOmega0 = DEFAULT_SCALOGRAM_OMEGA0;
      state.spectrogramConfig.scalogramRowDensity = DEFAULT_SCALOGRAM_ROW_DENSITY;
      state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
      state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
      break;
    case 'chroma':
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.scalogramHopSamples = DEFAULT_SCALOGRAM_HOP_SAMPLES;
      break;
    case 'loudness':
      state.spectrogramConfig.loudnessRefPreset = '-14';
      state.spectrogramConfig.loudnessRefCustom = DEFAULT_LOUDNESS_REF_LEVEL;
      state.spectrogramConfig.loudnessYAxisMode = 'auto';
      state.spectrogramConfig.loudnessYAxisMin = DEFAULT_LOUDNESS_Y_AXIS_MIN;
      state.spectrogramConfig.loudnessYAxisMax = DEFAULT_LOUDNESS_Y_AXIS_MAX;
      state.spectrogramConfig.loudnessCurves = 'both';
      state.spectrogramConfig.loudnessShowPeak = false;
      break;
  }

  refreshSpectrogramAnalysisConfig();
  scheduleKeyboardSurfaceFocus();
}

function schedulePersistSpectrogramDefaults(): void {
  if (state.spectrogramDefaultsPersistTimer) {
    window.clearTimeout(state.spectrogramDefaultsPersistTimer);
  }

  state.spectrogramDefaultsPersistTimer = window.setTimeout(() => {
    state.spectrogramDefaultsPersistTimer = null;
    vscode.postMessage({
      type: 'persistSpectrogramDefaults',
      body: getPersistedSpectrogramDefaults(),
    });
  }, 160);
}

function cancelActiveSpectrogramRender(): void {
  if (!state.analysisWorker || !state.analysis) {
    return;
  }

  const generation = state.analysis.generation;
  if (generation <= 0) {
    return;
  }

  const message = { type: 'cancelGeneration', body: { generation } };
  state.analysisWorker.postMessage(message);
  broadcastSpectrogramLaneMessage(message);
}

function scheduleSpectrogramConfigRefresh({ persist = true } = {}): void {
  state.spectrogramConfigPersistPending = state.spectrogramConfigPersistPending || persist;
  cancelActiveSpectrogramRender();

  if (state.spectrogramConfigApplyTimer) {
    return;
  }

  state.spectrogramConfigApplyTimer = window.setTimeout(() => {
    const shouldPersist = state.spectrogramConfigPersistPending;
    state.spectrogramConfigApplyTimer = null;
    state.spectrogramConfigPersistPending = false;
    refreshSpectrogramAnalysisConfig({ persist: shouldPersist });
  }, SPECTROGRAM_CONFIG_APPLY_DELAY_MS);
}

function getSpectrogramLaneCount(): number {
  const channels = state.playbackSession?.numberOfChannels ?? 1;
  return state.splitChannels && channels > 1 ? channels : 1;
}

function getSpectrogramRenderPixelHeight(): number {
  const renderHeight = Math.max(
    1,
    elements.spectrogramStage.clientHeight,
    elements.spectrogram.clientHeight,
    elements.spectrogramPanel.clientHeight,
    elements.viewport.clientHeight,
    window.innerHeight,
    1,
  );

  // Each channel lane occupies an equal vertical slice, so the per-lane render
  // height (used for every lane worker's canvas + render plan) is divided down.
  const laneCount = getSpectrogramLaneCount();
  return Math.max(1, Math.round((renderHeight * DISPLAY_PIXEL_RATIO) / laneCount));
}

function refreshSpectrogramAnalysisConfig({ persist = true } = {}): void {
  if (state.spectrogramConfigApplyTimer) {
    window.clearTimeout(state.spectrogramConfigApplyTimer);
    state.spectrogramConfigApplyTimer = null;
  }
  const shouldPersist = persist || state.spectrogramConfigPersistPending;
  state.spectrogramConfigPersistPending = false;
  const renderConfig = getEffectiveSpectrogramRenderConfig();

  if (state.engineWorker) {
    state.engineWorker.postMessage({
      type: 'SetSpectrogramConfig',
      body: renderConfig,
    });
  }

  if (state.analysis) {
    state.analysis.configVersion += 1;
    state.analysis.activeVisibleRequest = null;
    state.analysisOverviewRefreshPending = true;
  }

  renderSpectrogramMeta();
  scheduleSpectrogramRender({ force: true });
  if (shouldPersist) {
    schedulePersistSpectrogramDefaults();
  }
}

function getPresentedRangeSeconds(): TimeRange | null {
  const uiState = state.engineUiState;
  const sampleRate = uiState?.playback.sampleRate || getSampleRate();
  if (!uiState || !(sampleRate > 0)) {
    return null;
  }

  const start = uiState.presentedStartFrame / sampleRate;
  const end = uiState.presentedEndFrame / sampleRate;
  return end > start ? { start, end } : null;
}

function areWaveformRenderRequestsEqual(
  leftRange: TimeRange | null,
  leftWidthPx: number,
  leftHeightPx: number,
  rightRange: TimeRange | null,
  rightWidthPx: number,
  rightHeightPx: number,
): boolean {
  return areTimeRangesEqual(leftRange, rightRange)
    && Math.abs(Math.round(leftWidthPx) - Math.round(rightWidthPx)) <= 1
    && Math.abs(Math.round(leftHeightPx) - Math.round(rightHeightPx)) <= 1;
}

// The column grid this viewport + zoom renders on. Same inputs and same formula as
// the engine worker's copy, so both agree on where a column starts.
function getWaveformColumnGrid(uiState: ViewportUiState | null): WaveformColumnGrid | null {
  const spanFrames = uiState ? uiState.presentedEndFrame - uiState.presentedStartFrame : 0;
  if (!(spanFrames > 0)) {
    return null;
  }
  // The observed width, not a fresh clientWidth read: this runs next to style writes
  // on every follow frame (layout thrash), and it has to be the exact width the
  // engine worker was told about or the two grids would drift apart.
  return createWaveformColumnGrid(
    getWaveformColumnCount(
      state.observedWaveformViewportWidth || getWaveformViewportSize().width,
      DISPLAY_PIXEL_RATIO,
    ),
    spanFrames,
  );
}

// How many device columns the image on screen sits behind the presented origin.
// The canvas carries slack columns past the right edge, so sliding it left by that
// many device pixels puts the right samples under the playhead even while the
// replacement render is still in flight — the follow scroll then runs at display
// rate instead of stepping whenever the worker happens to finish.
function getWaveformCatchUpColumns(
  uiState: ViewportUiState | null,
  grid: WaveformColumnGrid | null,
): number {
  const drawnRange = state.waveformViewport.activeRenderRange;
  const sampleRate = uiState?.playback.sampleRate || getSampleRate();
  if (!uiState || !grid || !drawnRange || !(sampleRate > 0)) {
    return 0;
  }

  // A stale image from another zoom level is never translated (and never scaled) —
  // it stays put until its replacement lands. That rule is what keeps the old zoom
  // flash gone: no transform ever bridges two different geometries.
  if (Math.round((drawnRange.end - drawnRange.start) * sampleRate) !== grid.spanSamples) {
    return 0;
  }

  return clamp(
    sampleToColumnIndex(uiState.presentedStartFrame - drawnRange.start * sampleRate, grid),
    0,
    WAVEFORM_GRID_SLACK_COLUMNS,
  );
}

// The engine worker owns the geometry (presentedRange) and the waveform workers
// render it at exactly one device pixel per grid column, so the visible part of the
// canvas is always a 1:1 image of the viewport — no CSS scale bridge, which is what
// used to stretch a stale envelope on zoom and flash the wrong region. The only
// transform is an integer-device-pixel translate into the off-screen slack columns,
// and it is pixel-exact because both origins sit on the same absolute column grid.
function syncWaveformCanvasPresentation(uiState: ViewportUiState | null = state.engineUiState): void {
  const canvas = state.waveformCanvas;
  if (!canvas) {
    return;
  }

  const grid = getWaveformColumnGrid(uiState);
  const offsetCssPx = getWaveformCatchUpColumns(uiState, grid) / DISPLAY_PIXEL_RATIO;
  canvas.style.width = grid ? `${grid.columnCount / DISPLAY_PIXEL_RATIO}px` : '100%';
  if (getSpectrogramLaneCount() <= 1) {
    canvas.style.height = '100%';
  }
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = `translate3d(${(-offsetCssPx).toFixed(3)}px, 0, 0)`;
  mirrorWaveformLaneStyles();
}

function expandRange(range: TimeRange, duration: number, factor: number): TimeRange {
  const span = Math.max(0, range.end - range.start);
  if (!(duration > 0) || !(span > 0)) {
    return range;
  }

  const nextSpan = clamp(span * Math.max(1, factor), span, Math.max(span, duration));
  const extraSpan = nextSpan - span;
  const nextStart = clamp(range.start - extraSpan * 0.5, 0, Math.max(0, duration - nextSpan));
  return { start: nextStart, end: nextStart + nextSpan };
}

function isSmoothFollowPlaybackActive(): boolean {
  return Boolean(
    state.followPlayback
      && state.audioTransport?.isPlaying() === true
      && !state.selectionDrag
      && !state.loopHandleDrag,
  );
}

function getVisibleSpectrogramRequestMetrics(displayRange: TimeRange) {
  const duration = getEffectiveDurationSeconds();
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  let requestRange = displayRange;
  let requestPixelWidth = pixelWidth;

  if (duration > 0 && visibleSpan > 0 && isSmoothFollowPlaybackActive()) {
    requestRange = expandRange(displayRange, duration, SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR);
    requestPixelWidth = Math.max(
      pixelWidth,
      Math.ceil(pixelWidth * ((requestRange.end - requestRange.start) / visibleSpan)),
    );
  }

  return {
    displayRange,
    pixelHeight,
    pixelWidth,
    requestPixelWidth: Math.max(1, requestPixelWidth),
    requestRange,
  };
}

function isRangeBuffered(targetRange: TimeRange, bufferRange: TimeRange, marginRatio = 0): boolean {
  if (!(targetRange.end > targetRange.start) || !(bufferRange.end > bufferRange.start)) {
    return false;
  }

  const targetSpan = targetRange.end - targetRange.start;
  const bufferSpan = bufferRange.end - bufferRange.start;
  const availablePadding = Math.max(0, (bufferSpan - targetSpan) * 0.5);
  const requestedPadding = Math.max(0, bufferSpan * Math.max(0, marginRatio));
  const effectivePadding = Math.min(availablePadding, requestedPadding);

  return targetRange.start >= (bufferRange.start + effectivePadding - SPECTROGRAM_RANGE_EPSILON_SECONDS)
    && targetRange.end <= (bufferRange.end - effectivePadding + SPECTROGRAM_RANGE_EPSILON_SECONDS);
}

function isCompatibleVisibleRequest(
  activeRequest: SpectrogramVisibleRequest | null,
  size: { pixelHeight: number; pixelWidth: number },
) {
  if (!activeRequest || !state.analysis) {
    return false;
  }

  const renderConfig = getEffectiveSpectrogramRenderConfig();
  return activeRequest.configVersion === state.analysis.configVersion
    && activeRequest.analysisType === renderConfig.analysisType
    && activeRequest.colormapDistribution === renderConfig.colormapDistribution
    && activeRequest.fftSize === renderConfig.fftSize
    && activeRequest.frequencyScale === renderConfig.frequencyScale
    && activeRequest.maxDecibels === renderConfig.maxDecibels
    && activeRequest.melBandCount === renderConfig.melBandCount
    && (renderConfig.analysisType !== 'mfcc' || activeRequest.mfccCoefficientCount === renderConfig.mfccCoefficientCount)
    && activeRequest.windowFunction === renderConfig.windowFunction
    && ((renderConfig.analysisType !== 'chroma' && renderConfig.analysisType !== 'scalogram')
      || activeRequest.scalogramHopSamples === renderConfig.scalogramHopSamples)
    && (renderConfig.analysisType !== 'scalogram' || (
      activeRequest.scalogramMinFrequency === renderConfig.scalogramMinFrequency
      && activeRequest.scalogramMaxFrequency === renderConfig.scalogramMaxFrequency
      && Math.abs(activeRequest.scalogramOmega0 - renderConfig.scalogramOmega0) <= 1e-6
      && Math.abs(activeRequest.scalogramRowDensity - renderConfig.scalogramRowDensity) <= 1e-6
    ))
    && (renderConfig.analysisType === 'scalogram' || renderConfig.analysisType === 'chroma' || (
      activeRequest.spectrogramMinFrequency === renderConfig.spectrogramMinFrequency
      && activeRequest.spectrogramMaxFrequency === renderConfig.spectrogramMaxFrequency
    ))
    && activeRequest.minDecibels === renderConfig.minDecibels
    && Math.abs(activeRequest.overlapRatio - renderConfig.overlapRatio) <= 1e-6
    && Math.abs(activeRequest.pixelWidth - size.pixelWidth) <= 1
    && Math.abs(activeRequest.pixelHeight - size.pixelHeight) <= 1;
}

function hasBufferedVisibleSpectrogramCoverage(displayRange: TimeRange): boolean {
  const activeRequest = state.analysis?.activeVisibleRequest ?? null;
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();

  if (!isCompatibleVisibleRequest(activeRequest, { pixelHeight, pixelWidth })) {
    return false;
  }

  if (isSmoothFollowPlaybackActive()) {
    return isRangeBuffered(displayRange, {
      start: activeRequest!.viewStart,
      end: activeRequest!.viewEnd,
    }, SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO);
  }

  return Math.abs(activeRequest!.viewStart - displayRange.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(activeRequest!.viewEnd - displayRange.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
}

function syncSpectrogramDisplayRange(displayRange: TimeRange, pixelWidth: number, pixelHeight: number): void {
  if (!state.analysisWorker || !state.analysis?.initialized) {
    return;
  }

  const previousDisplay = state.lastSyncedSpectrogramDisplay;
  if (
    previousDisplay
    && previousDisplay.start === displayRange.start
    && previousDisplay.end === displayRange.end
    && previousDisplay.pixelWidth === pixelWidth
    && previousDisplay.pixelHeight === pixelHeight
  ) {
    return;
  }

  if (state.analysis.activeVisibleRequest) {
    state.analysis.activeVisibleRequest.displayEnd = displayRange.end;
    state.analysis.activeVisibleRequest.displayStart = displayRange.start;
    state.analysis.activeVisibleRequest.pixelHeight = pixelHeight;
    state.analysis.activeVisibleRequest.pixelWidth = pixelWidth;
  }

  state.lastSyncedSpectrogramDisplay = {
    end: displayRange.end,
    pixelHeight,
    pixelWidth,
    start: displayRange.start,
  };

  const message = {
    type: 'updateVisibleDisplayRange',
    body: {
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      pixelHeight,
      pixelWidth,
    },
  };
  state.analysisWorker.postMessage(message);
  broadcastSpectrogramLaneMessage(message);
}

function syncPresentedSpectrogramRange(displayRange: TimeRange | null): void {
  if (!displayRange) {
    return;
  }
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  syncSpectrogramDisplayRange(displayRange, pixelWidth, pixelHeight);
}

function postProgramLoudnessChannelsIfNeeded(renderConfig = getEffectiveSpectrogramRenderConfig()): void {
  if (
    renderConfig.analysisType !== 'loudness'
    || !state.analysisWorker
    || !state.playbackSession
    || state.loudnessChannelSessionRevision === state.spectrogramSessionRevision
  ) {
    return;
  }

  const session = state.playbackSession;
  if (getSpectrogramLaneCount() !== 1 || session.numberOfChannels < 2) {
    state.loudnessChannelSessionRevision = state.spectrogramSessionRevision;
    return;
  }

  const channelBuffers = session.channelBuffers
    .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
    .map((buffer) => buffer.slice(0));
  if (channelBuffers.length < 2) {
    state.loudnessChannelSessionRevision = state.spectrogramSessionRevision;
    return;
  }

  state.analysisWorker.postMessage({
    type: 'attachLoudnessChannels',
    body: {
      channelBuffers,
      sessionVersion: state.spectrogramSessionRevision,
    },
  }, channelBuffers);
  state.loudnessChannelSessionRevision = state.spectrogramSessionRevision;
}

function requestSpectrogramOverviewRender(renderConfig = getEffectiveSpectrogramRenderConfig()): void {
  if (!state.analysisWorker || !state.analysis?.initialized) {
    return;
  }

  postProgramLoudnessChannelsIfNeeded(renderConfig);

  const message = {
    type: 'renderOverview',
    body: {
      analysisType: renderConfig.analysisType,
      colormapDistribution: renderConfig.colormapDistribution,
      configVersion: state.analysis.configVersion,
      dpr: DISPLAY_PIXEL_RATIO,
      fftSize: renderConfig.fftSize,
      frequencyScale: renderConfig.frequencyScale,
      maxDecibels: renderConfig.maxDecibels,
      melBandCount: renderConfig.melBandCount,
      mfccCoefficientCount: renderConfig.mfccCoefficientCount,
      mfccMelBandCount: renderConfig.mfccMelBandCount,
      minDecibels: renderConfig.minDecibels,
      overlapRatio: renderConfig.overlapRatio,
      scalogramHopSamples: renderConfig.scalogramHopSamples,
      scalogramMaxFrequency: renderConfig.scalogramMaxFrequency,
      scalogramMinFrequency: renderConfig.scalogramMinFrequency,
      spectrogramMaxFrequency: renderConfig.spectrogramMaxFrequency,
      spectrogramMinFrequency: renderConfig.spectrogramMinFrequency,
      scalogramOmega0: renderConfig.scalogramOmega0,
      scalogramRowDensity: renderConfig.scalogramRowDensity,
      windowFunction: renderConfig.windowFunction,
      loudnessRefLevel: renderConfig.loudnessRefLevel,
      loudnessYAxisMode: renderConfig.loudnessYAxisMode,
      loudnessYAxisMin: renderConfig.loudnessYAxisMin,
      loudnessYAxisMax: renderConfig.loudnessYAxisMax,
      loudnessCurves: renderConfig.loudnessCurves,
      loudnessShowPeak: renderConfig.loudnessShowPeak,
    },
  };
  state.lastSpectrogramOverviewMessage = message;
  state.analysisWorker.postMessage(message);
  broadcastSpectrogramLaneMessage(message);
}

function scheduleSpectrogramRender({ force = false } = {}): void {
  state.spectrogramRenderForcePending = state.spectrogramRenderForcePending || force;
  if (state.spectrogramFrame) {
    return;
  }

  state.spectrogramFrame = window.requestAnimationFrame(() => {
    state.spectrogramFrame = 0;
    const nextForce = state.spectrogramRenderForcePending;
    state.spectrogramRenderForcePending = false;
    syncSpectrogramView({ force: nextForce });
  });
}

function syncSpectrogramView({ force = false } = {}): void {
  if (!state.analysisWorker || !state.analysis?.initialized) {
    return;
  }

  const displayRange = getPresentedRangeSeconds();
  if (!displayRange || !(displayRange.end > displayRange.start)) {
    return;
  }

  const { pixelHeight, pixelWidth, requestPixelWidth, requestRange } = getVisibleSpectrogramRequestMetrics(displayRange);
  syncSpectrogramDisplayRange(displayRange, pixelWidth, pixelHeight);

  if (!force && hasBufferedVisibleSpectrogramCoverage(displayRange)) {
    return;
  }

  const renderConfig = getEffectiveSpectrogramRenderConfig();
  postProgramLoudnessChannelsIfNeeded(renderConfig);

  const previousGeneration = state.analysis.generation;
  const generation = previousGeneration + 1;
  state.analysis.generation = generation;
    state.analysis.activeVisibleRequest = {
      analysisType: renderConfig.analysisType,
      colormapDistribution: renderConfig.colormapDistribution,
      configVersion: state.analysis.configVersion,
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      fftSize: renderConfig.fftSize,
      frequencyScale: renderConfig.frequencyScale,
      generation,
      maxDecibels: renderConfig.maxDecibels,
      melBandCount: renderConfig.melBandCount,
      mfccCoefficientCount: renderConfig.mfccCoefficientCount,
      windowFunction: renderConfig.windowFunction,
      scalogramHopSamples: renderConfig.scalogramHopSamples,
      scalogramMaxFrequency: renderConfig.scalogramMaxFrequency,
      scalogramMinFrequency: renderConfig.scalogramMinFrequency,
      spectrogramMaxFrequency: renderConfig.spectrogramMaxFrequency,
      spectrogramMinFrequency: renderConfig.spectrogramMinFrequency,
      scalogramOmega0: renderConfig.scalogramOmega0,
      scalogramRowDensity: renderConfig.scalogramRowDensity,
      minDecibels: renderConfig.minDecibels,
      overlapRatio: renderConfig.overlapRatio,
      pixelHeight,
    pixelWidth,
    viewEnd: requestRange.end,
    viewStart: requestRange.start,
  };

  if (previousGeneration > 0) {
    const cancelMessage = {
      type: 'cancelGeneration',
      body: { generation: previousGeneration },
    };
    state.analysisWorker.postMessage(cancelMessage);
    broadcastSpectrogramLaneMessage(cancelMessage);
  }

  const visibleMessage = {
    type: 'renderVisibleRange',
    body: {
      analysisType: renderConfig.analysisType,
      colormapDistribution: renderConfig.colormapDistribution,
      configVersion: state.analysis.configVersion,
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      dpr: DISPLAY_PIXEL_RATIO,
      fftSize: renderConfig.fftSize,
      frequencyScale: renderConfig.frequencyScale,
      generation,
      maxDecibels: renderConfig.maxDecibels,
      melBandCount: renderConfig.melBandCount,
      mfccCoefficientCount: renderConfig.mfccCoefficientCount,
      mfccMelBandCount: renderConfig.mfccMelBandCount,
      windowFunction: renderConfig.windowFunction,
      scalogramHopSamples: renderConfig.scalogramHopSamples,
      scalogramMaxFrequency: renderConfig.scalogramMaxFrequency,
      scalogramMinFrequency: renderConfig.scalogramMinFrequency,
      spectrogramMaxFrequency: renderConfig.spectrogramMaxFrequency,
      spectrogramMinFrequency: renderConfig.spectrogramMinFrequency,
      scalogramOmega0: renderConfig.scalogramOmega0,
      scalogramRowDensity: renderConfig.scalogramRowDensity,
      minDecibels: renderConfig.minDecibels,
      overlapRatio: renderConfig.overlapRatio,
      loudnessRefLevel: renderConfig.loudnessRefLevel,
      loudnessYAxisMode: renderConfig.loudnessYAxisMode,
      loudnessYAxisMin: renderConfig.loudnessYAxisMin,
      loudnessYAxisMax: renderConfig.loudnessYAxisMax,
      loudnessCurves: renderConfig.loudnessCurves,
      loudnessShowPeak: renderConfig.loudnessShowPeak,
      pixelHeight,
      pixelWidth: requestPixelWidth,
      requestEnd: requestRange.end,
      requestStart: requestRange.start,
    },
  };
  state.lastSpectrogramVisibleMessage = visibleMessage;
  state.analysisWorker.postMessage(visibleMessage);
  broadcastSpectrogramLaneMessage(visibleMessage);

  if (state.analysisOverviewRefreshPending) {
    state.analysisOverviewRefreshPending = false;
    requestSpectrogramOverviewRender(renderConfig);
  }
}

function hideSurfaceHoverTooltip(tooltipElement: HTMLElement): void {
  tooltipElement.classList.remove('visible');
  tooltipElement.setAttribute('aria-hidden', 'true');
}

// Structured hover readout: `meta` lines (time, frequency, sample index) render
// stacked in the left column; `channels` render one per line in the right column
// with the value right-aligned so digits line up across channels.
interface HoverTooltipModel {
  meta: string[];
  channels: Array<{ label: string; value: string }>;
}

function isHoverTooltipModelEmpty(model: HoverTooltipModel): boolean {
  return model.meta.length === 0 && model.channels.length === 0;
}

function setSurfaceHoverTooltipContent(tooltipElement: HTMLElement, content: string | HoverTooltipModel): void {
  if (typeof content === 'string') {
    tooltipElement.textContent = content;
    return;
  }

  tooltipElement.textContent = '';
  const grid = document.createElement('div');
  grid.className = 'surface-hover-tooltip-grid';

  const meta = document.createElement('div');
  meta.className = 'surface-hover-tooltip-col surface-hover-tooltip-meta';
  for (const line of content.meta) {
    const row = document.createElement('div');
    row.className = 'surface-hover-tooltip-line';
    row.textContent = line;
    meta.append(row);
  }
  grid.append(meta);

  if (content.channels.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'surface-hover-tooltip-divider';
    grid.append(divider);

    const channels = document.createElement('div');
    channels.className = 'surface-hover-tooltip-col surface-hover-tooltip-channels';
    for (const channel of content.channels) {
      const row = document.createElement('div');
      row.className = 'surface-hover-tooltip-chan';
      const label = document.createElement('span');
      label.className = 'surface-hover-tooltip-chan-label';
      label.textContent = channel.label;
      const value = document.createElement('span');
      value.className = 'surface-hover-tooltip-chan-value';
      value.textContent = channel.value;
      row.append(label, value);
      channels.append(row);
    }
    grid.append(channels);
  }

  tooltipElement.append(grid);
}

function updateSurfaceHoverTooltip(tooltipElement: HTMLElement, targetElement: HTMLElement, point: HoverContext, content: string | HoverTooltipModel): void {
  const rect = targetElement.getBoundingClientRect();
  const isEmpty = typeof content === 'string' ? !content : isHoverTooltipModelEmpty(content);
  if (isEmpty || rect.width <= 0 || rect.height <= 0) {
    hideSurfaceHoverTooltip(tooltipElement);
    return;
  }

  const localX = clamp(point.clientX - rect.left, 0, rect.width);
  const localY = clamp(point.clientY - rect.top, 0, rect.height);
  setSurfaceHoverTooltipContent(tooltipElement, content);
  tooltipElement.classList.add('visible');
  tooltipElement.setAttribute('aria-hidden', 'false');

  const tooltipWidth = tooltipElement.offsetWidth || 0;
  const tooltipHeight = tooltipElement.offsetHeight || 0;
  const maxLeft = Math.max(12, rect.width - tooltipWidth - 12);
  const maxTop = Math.max(12, rect.height - tooltipHeight - 12);
  tooltipElement.style.left = `${clamp(localX + 14, 12, maxLeft)}px`;
  tooltipElement.style.top = `${clamp(localY - tooltipHeight - 14, 12, maxTop)}px`;
}

function ensureWaveformSampleMarkerElement(): void {
  if (elements.waveformSampleMarker || !elements.waveformViewport) {
    return;
  }

  const marker = document.createElement('div');
  marker.id = 'waveform-sample-marker';
  marker.className = 'waveform-sample-marker';
  marker.setAttribute('aria-hidden', 'true');
  elements.waveformViewport.append(marker);
  elements.waveformSampleMarker = marker;
}

function hideWaveformSampleMarker(): void {
  if (!elements.waveformSampleMarker) {
    return;
  }
  elements.waveformSampleMarker.style.display = 'none';
  elements.waveformSampleMarker.style.left = '0px';
  elements.waveformSampleMarker.style.top = '0px';
}

// Pool of per-channel hover markers (one per lane in split mode, one for the
// mono downmix otherwise).
function getWaveformSampleMarker(index: number): HTMLElement {
  let marker = state.waveformSampleMarkers[index];
  if (!marker) {
    marker = document.createElement('div');
    marker.className = 'waveform-sample-marker';
    marker.setAttribute('aria-hidden', 'true');
    elements.waveformViewport.append(marker);
    state.waveformSampleMarkers[index] = marker;
  }
  return marker;
}

function hideWaveformSampleMarkers(): void {
  for (const marker of state.waveformSampleMarkers) {
    marker.style.display = 'none';
  }
  hideWaveformSampleMarker();
}

function readChannelSampleValue(channelIndex: number, sampleIndex: number): number | null {
  const buffer = state.playbackSession?.channelBuffers[channelIndex];
  if (!(buffer instanceof ArrayBuffer)) {
    return null;
  }
  const view = new Float32Array(buffer);
  if (sampleIndex < 0 || sampleIndex >= view.length) {
    return null;
  }
  return clamp(view[sampleIndex], -1, 1);
}

// Positions a hover marker on each displayed waveform: one per channel lane in
// split mode, or a single marker on the mono downmix line otherwise.
function positionWaveformChannelMarkers(sampleIndex: number, markerXRatio: number): void {
  const session = state.playbackSession;
  if (!session) {
    hideWaveformSampleMarkers();
    return;
  }
  const channelCount = Math.max(1, Math.min(session.numberOfChannels, session.channelBuffers.length));
  const laneCount = getSpectrogramLaneCount();
  const viewportWidth = elements.waveformViewport.clientWidth;
  const viewportHeight = elements.waveformViewport.clientHeight;
  const left = markerXRatio * viewportWidth;

  if (laneCount > 1) {
    const laneHeight = viewportHeight / laneCount;
    for (let channelIndex = 0; channelIndex < laneCount; channelIndex += 1) {
      const marker = getWaveformSampleMarker(channelIndex);
      const value = readChannelSampleValue(channelIndex, sampleIndex);
      if (value === null) {
        marker.style.display = 'none';
        continue;
      }
      const fullRatioY = (channelIndex + getWaveformMarkerYRatio(laneHeight, value, state.waveformAmplitudeMax)) / laneCount;
      marker.style.display = 'block';
      marker.style.left = `${left}px`;
      marker.style.top = `${fullRatioY * viewportHeight}px`;
    }
    for (let index = laneCount; index < state.waveformSampleMarkers.length; index += 1) {
      state.waveformSampleMarkers[index].style.display = 'none';
    }
    return;
  }

  // Mono view: the displayed waveform is the equal-weight downmix.
  let sum = 0;
  let count = 0;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const value = readChannelSampleValue(channelIndex, sampleIndex);
    if (value !== null) {
      sum += value;
      count += 1;
    }
  }
  if (count === 0) {
    hideWaveformSampleMarkers();
    return;
  }
  const marker = getWaveformSampleMarker(0);
  marker.style.display = 'block';
  marker.style.left = `${left}px`;
  marker.style.top = `${getWaveformMarkerYRatio(viewportHeight, sum / count, state.waveformAmplitudeMax) * viewportHeight}px`;
  for (let index = 1; index < state.waveformSampleMarkers.length; index += 1) {
    state.waveformSampleMarkers[index].style.display = 'none';
  }
}

function applySampleInfo(payload: SampleInfoPayload): void {
  const hover = state.hoverState[payload.surface];
  if (!hover || hover.requestId !== payload.requestId) {
    return;
  }

  const laneCount = Math.max(1, hover.laneCount);
  const channelPrefix = laneCount > 1 && payload.label
    ? `${channelLaneLabel(hover.laneIndex, laneCount)} • `
    : '';

  if (payload.surface === 'waveform') {
    // At per-sample zoom show every channel stacked; otherwise keep the single
    // time-only readout the worker produced.
    const sampleModel = payload.markerVisible && typeof payload.sampleIndex === 'number'
      ? buildWaveformChannelHoverModel(payload.sampleIndex)
      : null;
    updateSurfaceHoverTooltip(
      elements.waveformHoverTooltip,
      elements.waveformViewport,
      hover,
      sampleModel ?? channelPrefix + payload.label,
    );

    if (payload.markerVisible && typeof payload.sampleIndex === 'number') {
      positionWaveformChannelMarkers(payload.sampleIndex, payload.markerXRatio);
    } else {
      hideWaveformSampleMarkers();
    }
    return;
  }

  updateSurfaceHoverTooltip(
    elements.spectrogramHoverTooltip,
    elements.spectrogramHitTarget,
    hover,
    channelPrefix + payload.label,
  );
}

function isPerChannelSpectrogramValueType(): boolean {
  const type = state.spectrogramConfig.analysisType;
  return type === 'spectrogram' || type === 'mel' || type === 'scalogram';
}

// Primary analysis worker is channel 0; satellite lane workers follow in order.
function getAnalysisChannelWorkers(): Worker[] {
  const workers: Worker[] = [];
  if (state.analysisWorker) {
    workers.push(state.analysisWorker);
  }
  for (const worker of state.analysisLaneWorkers) {
    workers.push(worker);
  }
  return workers;
}

function formatHoverFrequency(startHz: number | null, endHz: number | null): string | null {
  const startValid = typeof startHz === 'number' && Number.isFinite(startHz);
  const endValid = typeof endHz === 'number' && Number.isFinite(endHz);
  const hz = startValid && endValid
    ? ((startHz as number) + (endHz as number)) / 2
    : (startValid ? (startHz as number) : (endValid ? (endHz as number) : NaN));
  if (!Number.isFinite(hz) || hz <= 0) {
    return null;
  }
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

function formatHoverDb(valueDb: number | null): string {
  if (valueDb === null || !Number.isFinite(valueDb)) {
    return '–';
  }
  return valueDb <= -120 ? '-∞ dB' : `${valueDb.toFixed(1)} dB`;
}

function formatHoverLufs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= -100) {
    return '-∞';
  }
  return value.toFixed(1);
}

// Fixed decimal count keeps the decimal point and digits aligned across channels
// in the monospace readout (trailing zeros are intentionally kept).
function formatWaveformChannelSample(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '–';
  }
  const normalized = Math.abs(value) < 0.0000005 ? 0 : value;
  return normalized.toFixed(5);
}

// Reads every source channel's amplitude at the hovered sample directly from the
// main-thread decoded buffers, so the waveform readout shows all channels at once.
function buildWaveformChannelHoverModel(sampleIndex: number): HoverTooltipModel | null {
  const session = state.playbackSession;
  if (!session || !Number.isFinite(sampleIndex) || sampleIndex < 0) {
    return null;
  }

  const channelCount = Math.max(1, Math.min(session.numberOfChannels, session.channelBuffers.length));
  const meta: string[] = [];
  if (session.sourceSampleRate > 0) {
    meta.push(formatAxisLabel(sampleIndex / session.sourceSampleRate));
  }
  meta.push(`Sample ${(sampleIndex + 1).toLocaleString()}`);

  const channels: Array<{ label: string; value: string }> = [];
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const buffer = session.channelBuffers[channelIndex];
    let value: number | null = null;
    if (buffer instanceof ArrayBuffer) {
      const view = new Float32Array(buffer);
      if (sampleIndex < view.length) {
        value = view[sampleIndex];
      }
    }
    channels.push({
      label: channelCount > 1 ? channelLaneLabel(channelIndex, channelCount) : '',
      value: formatWaveformChannelSample(value),
    });
  }

  return { meta, channels };
}

function applyChannelSampleValue(payload: { channelIndex: number; requestId: number; result: ChannelSampleValueResult }): void {
  const aggregation = state.spectrogramChannelHover;
  if (!aggregation || aggregation.requestId !== payload.requestId) {
    return;
  }
  if (payload.channelIndex < 0 || payload.channelIndex >= aggregation.results.length) {
    return;
  }
  aggregation.results[payload.channelIndex] = payload.result;
  renderSpectrogramChannelHoverTooltip();
}

function renderSpectrogramChannelHoverTooltip(): void {
  const aggregation = state.spectrogramChannelHover;
  const hover = state.hoverState.spectrogram;
  if (!aggregation || !hover || hover.requestId !== aggregation.requestId) {
    return;
  }
  const reference = aggregation.results.find((entry) => entry) ?? null;
  if (!reference) {
    return;
  }

  const laneCount = aggregation.laneCount;
  const meta = [formatAxisLabel(reference.timeSeconds)];

  // Loudness: time + per-channel momentary / short-term LUFS and sample peak.
  // No frequency axis applies to the loudness view.
  if (state.spectrogramConfig.analysisType === 'loudness') {
    const channels = aggregation.results.map((entry, channelIndex) => ({
      label: laneCount > 1 ? channelLaneLabel(channelIndex, laneCount) : '',
      value: entry
        ? `M ${formatHoverLufs(entry.loudnessMomentary)} / S ${formatHoverLufs(entry.loudnessShortTerm)} LUFS · Pk ${formatHoverLufs(entry.loudnessSamplePeak)} dBFS`
        : '–',
    }));
    updateSurfaceHoverTooltip(elements.spectrogramHoverTooltip, elements.spectrogramHitTarget, hover, { meta, channels });
    return;
  }

  const frequencyLabel = formatHoverFrequency(reference.frequencyStartHz, reference.frequencyEndHz);
  if (frequencyLabel) {
    meta.push(frequencyLabel);
  }
  const channels = aggregation.results.map((entry, channelIndex) => ({
    label: laneCount > 1 ? channelLaneLabel(channelIndex, laneCount) : '',
    value: formatHoverDb(entry ? entry.valueDb : null),
  }));

  updateSurfaceHoverTooltip(elements.spectrogramHoverTooltip, elements.spectrogramHitTarget, hover, { meta, channels });
}

function requestSampleInfoAtClientPoint(surface: SurfaceKind, clientX: number, clientY: number): void {
  if (!state.engineWorker) {
    return;
  }

  const target = getHoverTarget(surface);
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    hideHoverForSurface(surface);
    return;
  }

  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    hideHoverForSurface(surface);
    return;
  }

  const requestId = state.hoverRequestIds[surface] + 1;
  state.hoverRequestIds[surface] = requestId;

  // In split-channel mode the surface stacks one lane per channel, so map the
  // full-height pointer ratio into the hovered lane and report values relative
  // to that lane (so frequency / marker position match the channel under it).
  const pointerRatioY = clamp((clientY - rect.top) / rect.height, 0, 1);
  const laneCount = getSpectrogramLaneCount();
  const laneIndex = clamp(Math.floor(pointerRatioY * laneCount), 0, laneCount - 1);
  const laneRatioY = clamp(pointerRatioY * laneCount - laneIndex, 0, 1);

  state.hoverState[surface] = {
    clientX,
    clientY,
    requestId,
    laneCount,
    laneIndex,
  };

  const pointerRatioX = clamp((clientX - rect.left) / rect.width, 0, 1);

  // dB-valued analyses (spectrogram / mel / scalogram) and loudness read their
  // value from the analysis worker(s), which hold the decoded PCM. The engine
  // worker keeps no PCM copy, so it can only report time + frequency — routing
  // here is what makes the hovered dB readout appear. In split mode every lane
  // worker reports its own channel; in mono the single worker reports the
  // downmix (loudness reports program loudness).
  const isLoudnessSurface = state.spectrogramConfig.analysisType === 'loudness';
  const analysisWorkers = getAnalysisChannelWorkers();
  if (
    surface === 'spectrogram'
    && analysisWorkers.length > 0
    && (isPerChannelSpectrogramValueType() || isLoudnessSurface)
  ) {
    state.spectrogramChannelHover = {
      requestId,
      laneCount,
      results: new Array(analysisWorkers.length).fill(null),
    };
    analysisWorkers.forEach((worker, channelIndex) => {
      worker.postMessage({
        type: 'requestChannelSampleValue',
        body: { channelIndex, pointerRatioX, pointerRatioY: laneRatioY, requestId },
      });
    });
    return;
  }
  state.spectrogramChannelHover = null;

  state.engineWorker.postMessage({
    type: 'RequestSampleInfo',
    body: {
      pointerRatioX,
      pointerRatioY: laneRatioY,
      requestId,
      surface,
    },
  });
}

function flushPendingSampleInfoRequests(): void {
  const waveformRequest = state.pendingHoverRequests.waveform;
  const spectrogramRequest = state.pendingHoverRequests.spectrogram;
  state.pendingHoverRequests.waveform = null;
  state.pendingHoverRequests.spectrogram = null;

  if (waveformRequest) {
    requestSampleInfoAtClientPoint('waveform', waveformRequest.clientX, waveformRequest.clientY);
  }
  if (spectrogramRequest) {
    requestSampleInfoAtClientPoint('spectrogram', spectrogramRequest.clientX, spectrogramRequest.clientY);
  }
}

function scheduleSampleInfoRequestAtClientPoint(surface: SurfaceKind, clientX: number, clientY: number): void {
  state.pendingHoverRequests[surface] = {
    clientX,
    clientY,
  };
  if (state.hoverFrame) {
    return;
  }

  // Cap hover sample-info updates at ~60 Hz regardless of the display refresh
  // rate (rAF fires at 120/144 Hz on high-refresh monitors), so high-rate
  // pointer moves don't drive extra worker queries.
  const flush = (now: number): void => {
    if (now - state.lastHoverFlushTime < HOVER_FLUSH_MIN_INTERVAL_MS) {
      state.hoverFrame = window.requestAnimationFrame(flush);
      return;
    }
    state.hoverFrame = 0;
    state.lastHoverFlushTime = now;
    flushPendingSampleInfoRequests();
  };
  state.hoverFrame = window.requestAnimationFrame(flush);
}

function requestSampleInfo(surface: SurfaceKind, event: PointerEvent): void {
  scheduleSampleInfoRequestAtClientPoint(surface, event.clientX, event.clientY);
}

function refreshHoveredSampleInfo(surface: SurfaceKind): void {
  const hover = state.hoverState[surface];
  if (!hover) {
    return;
  }

  scheduleSampleInfoRequestAtClientPoint(surface, hover.clientX, hover.clientY);
}

function clearPendingSampleInfoRequest(surface: SurfaceKind): void {
  state.pendingHoverRequests[surface] = null;
  if (state.pendingHoverRequests.waveform || state.pendingHoverRequests.spectrogram || !state.hoverFrame) {
    return;
  }

  window.cancelAnimationFrame(state.hoverFrame);
  state.hoverFrame = 0;
}

function refreshHoveredSampleInfos(): void {
  refreshHoveredSampleInfo('waveform');
  refreshHoveredSampleInfo('spectrogram');
}

function hideWaveformHoverTooltip(): void {
  clearPendingSampleInfoRequest('waveform');
  state.hoverState.waveform = null;
  hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
  hideWaveformSampleMarkers();
}

function hideSpectrogramHoverTooltip(): void {
  clearPendingSampleInfoRequest('spectrogram');
  state.hoverState.spectrogram = null;
  state.spectrogramChannelHover = null;
  hideSurfaceHoverTooltip(elements.spectrogramHoverTooltip);
}

function updateTimelineHoverTooltip(event: PointerEvent): void {
  const durationFrames = getDurationFrames();
  const sampleRate = getSampleRate();
  const rect = elements.waveformOverview.getBoundingClientRect();
  if (!(durationFrames > 0) || !(sampleRate > 0) || rect.width <= 0) {
    hideTimelineHoverTooltip();
    return;
  }

  const localX = event.clientX - rect.left;
  const ratio = clamp(localX / rect.width, 0, 1);
  const frame = Math.round(ratio * durationFrames);
  elements.timelineHoverTooltip.textContent = formatAxisLabel(frame / sampleRate);
  elements.timelineHoverTooltip.classList.add('visible');
  elements.timelineHoverTooltip.setAttribute('aria-hidden', 'false');

  const halfTooltipWidth = (elements.timelineHoverTooltip.offsetWidth || 0) / 2;
  const edgePadding = Math.max(8, halfTooltipWidth);
  const tooltipX = clamp(localX, edgePadding, Math.max(edgePadding, rect.width - edgePadding));
  elements.timelineHoverTooltip.style.left = `${tooltipX}px`;
}

function hideTimelineHoverTooltip(): void {
  elements.timelineHoverTooltip.classList.remove('visible');
  elements.timelineHoverTooltip.setAttribute('aria-hidden', 'true');
}

function getWaveformViewportSize(): { height: number; width: number } {
  return {
    height: Math.max(1, elements.waveformViewport.clientHeight),
    width: Math.max(1, elements.waveformViewport.clientWidth),
  };
}

function getSpectrogramCanvasTargetSize(): { pixelHeight: number; pixelWidth: number } {
  return {
    pixelHeight: getSpectrogramRenderPixelHeight(),
    pixelWidth: Math.max(1, Math.round(elements.spectrogram.clientWidth * DISPLAY_PIXEL_RATIO)),
  };
}

function sendViewportIntent(body: SetViewportIntentMessage['body']): void {
  if (!state.engineWorker) {
    return;
  }

  state.engineWorker.postMessage({
    type: 'SetViewportIntent',
    body,
  });
}

function pointerRatioForEvent(target: HTMLElement, event: PointerEvent): number {
  const rect = target.getBoundingClientRect();
  return rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5;
}

function beginSelectionDrag(event: PointerEvent, target: HTMLElement, surface: SurfaceKind): void {
  if (!hasPlaybackTransport() || getDurationFrames() <= 0) {
    return;
  }
  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }
  target.setPointerCapture(event.pointerId);
  state.selectionDrag = { pointerId: event.pointerId, target };
  sendViewportIntent({
    kind: 'selectionStart',
    pointerRatioX: pointerRatioForEvent(target, event),
    surface,
  });
  scheduleKeyboardSurfaceFocus();
}

function updateSelectionDrag(event: PointerEvent, target: HTMLElement, surface: SurfaceKind): void {
  if (!state.selectionDrag || state.selectionDrag.pointerId !== event.pointerId || state.selectionDrag.target !== target) {
    return;
  }
  sendViewportIntent({
    kind: 'selectionUpdate',
    pointerRatioX: pointerRatioForEvent(target, event),
    surface,
  });
}

function releaseSelectionDrag(event: PointerEvent, target: HTMLElement, surface: SurfaceKind, cancelled = false): void {
  if (!state.selectionDrag || state.selectionDrag.pointerId !== event.pointerId || state.selectionDrag.target !== target) {
    return;
  }

  if (target.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }

  state.selectionDrag = null;
  sendViewportIntent({
    cancelled,
    kind: 'selectionEnd',
    pointerRatioX: pointerRatioForEvent(target, event),
    surface,
  });
}

function bindLoopHandle(handle: HTMLElement, edge: 'end' | 'start', target: HTMLElement, surface: SurfaceKind): void {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    state.loopHandleDrag = { edge, handle, pointerId: event.pointerId, target };
    sendViewportIntent({
      edge,
      kind: 'loopHandleStart',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });

  handle.addEventListener('pointermove', (event) => {
    if (!state.loopHandleDrag || state.loopHandleDrag.pointerId !== event.pointerId || state.loopHandleDrag.handle !== handle) {
      return;
    }
    sendViewportIntent({
      edge,
      kind: 'loopHandleUpdate',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });

  handle.addEventListener('pointerup', (event) => {
    if (!state.loopHandleDrag || state.loopHandleDrag.pointerId !== event.pointerId || state.loopHandleDrag.handle !== handle) {
      return;
    }
    if (handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    state.loopHandleDrag = null;
    sendViewportIntent({
      edge,
      kind: 'loopHandleEnd',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });

  handle.addEventListener('pointercancel', (event) => {
    if (!state.loopHandleDrag || state.loopHandleDrag.pointerId !== event.pointerId || state.loopHandleDrag.handle !== handle) {
      return;
    }
    state.loopHandleDrag = null;
    sendViewportIntent({
      cancelled: true,
      edge,
      kind: 'loopHandleEnd',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });
}

function handleAnalysisWorkerMessage(loadToken: number, message: AnalysisWorkerToMainMessage): void {
  if (!isCurrentWorkerMessage(
    loadToken,
    state.loadToken,
    state.spectrogramSessionRevision,
    (message.body as { sessionVersion?: number } | undefined)?.sessionVersion,
  )) {
    return;
  }

  if (message?.type === 'runtimeReady') {
    state.resolveAnalysisRuntimeReady?.();
    state.resolveAnalysisRuntimeReady = null;
    return;
  }

  if ((message as { type?: string })?.type === 'channelSampleValue') {
    applyChannelSampleValue((message as unknown as { body: { channelIndex: number; requestId: number; result: ChannelSampleValueResult } }).body);
    return;
  }

  if (!state.analysis) {
    return;
  }

  if (message?.type === 'analysisInitialized') {
    state.lastSyncedSpectrogramDisplay = null;
    state.analysis.initialized = true;
    state.analysisOverviewRefreshPending = true;
    state.analysis.fallbackReason = typeof message.body?.fallbackReason === 'string'
      ? message.body.fallbackReason
      : null;
    state.analysis.renderBackend = message.body?.renderBackend === 'webgpu-native'
      ? 'webgpu-native'
      : '2d-wasm';
    state.analysis.runtimeVariant = message.body?.runtimeVariant ?? null;
    state.analysis.sampleRate = Number(message.body?.sampleRate) || state.analysis.sampleRate;
    state.analysis.sampleCount = Number(message.body?.sampleCount) || state.analysis.sampleCount;
    state.analysis.minFrequency = Number(message.body?.minFrequency) || state.analysis.minFrequency;
    state.analysis.maxFrequency = Number(message.body?.maxFrequency) || state.analysis.maxFrequency;
    scheduleSpectrogramRender({ force: true });
    return;
  }

  if (message?.type === 'analysisSurfaceResetRequested') {
    const reason = message.body?.reason === 'device-lost' ? 'device-lost' : 'surface-invalid';
    void resetSpectrogramSurface(loadToken, reason)
      .then(() => {
        if (loadToken !== state.loadToken || !state.analysis) {
          return;
        }

        scheduleSpectrogramRender({ force: true });
      })
      .catch((error) => {
        if (loadToken !== state.loadToken) {
          return;
        }

        setAnalysisStatus(
          `Spectrogram failed to recover surface: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      });
    return;
  }

  if (message?.type === 'visibleReady') {
    const body = message.body ?? {};
    if (Number(body.generation) !== state.analysis.generation) {
      return;
    }
    const scalogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
      body.scalogramMinFrequency,
      body.scalogramMaxFrequency,
    );
    // The layer-ready body reports the resolved min/max frequency, which for
    // spectrogram/mel/mfcc is exactly the general display range that was rendered.
    const spectrogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
      body.minFrequency,
      body.maxFrequency,
    );

    state.analysis.activeVisibleRequest = {
      analysisType: normalizeSpectrogramAnalysisType(body.analysisType),
      colormapDistribution: normalizeSpectrogramColormapDistribution(body.colormapDistribution),
      configVersion: Number(body.configVersion) || 0,
      displayEnd: Number(body.displayEnd) || 0,
      displayStart: Number(body.displayStart) || 0,
      fftSize: Number(body.fftSize) || 0,
      frequencyScale: body.frequencyScale === 'linear' || body.frequencyScale === 'mixed' ? body.frequencyScale : 'log',
      generation: Number(body.generation) || 0,
      maxDecibels: Math.round(Number(body.maxDecibels) || 0),
      melBandCount: normalizeSpectrogramMelBandCount(body.melBandCount),
      mfccCoefficientCount: normalizeSpectrogramMfccCoefficientCount(body.mfccCoefficientCount),
      windowFunction: normalizeSpectrogramWindowFunction(body.windowFunction),
      scalogramHopSamples: Math.max(1, Math.round(Number(body.scalogramHopSamples) || 0)),
      scalogramMaxFrequency: scalogramFrequencyRange.maxFrequency,
      scalogramMinFrequency: scalogramFrequencyRange.minFrequency,
      scalogramOmega0: normalizeSpectrogramScalogramOmega0(body.scalogramOmega0),
      scalogramRowDensity: normalizeSpectrogramScalogramRowDensity(body.scalogramRowDensity),
      spectrogramMaxFrequency: spectrogramFrequencyRange.maxFrequency,
      spectrogramMinFrequency: spectrogramFrequencyRange.minFrequency,
      minDecibels: Math.round(Number(body.minDecibels) || 0),
      overlapRatio: Number(body.overlapRatio) || 0,
      pixelHeight: Number(body.pixelHeight) || 0,
      pixelWidth: Number(body.pixelWidth) || 0,
      viewEnd: Number(body.viewEnd) || 0,
      viewStart: Number(body.viewStart) || 0,
    };
    setAnalysisStatus('Ready');
    setSurfaceLoading('spectrogram', false);
    return;
  }

  if (message?.type === 'loudnessLegend') {
    updateLoudnessLegendDom(message.body);
    return;
  }

  if (message?.type === 'error') {
    setAnalysisStatus(`Spectrogram failed: ${message.body?.message || 'Unknown worker error.'}`, true);
    setSurfaceLoading('spectrogram', false);
  }
}

function handleWaveformSurfaceReady(): void {
  const loadToken = state.loadToken;

  if (loadToken <= 0 || state.initialWaveformReadyLoadToken === loadToken) {
    return;
  }

  state.initialWaveformReadyLoadToken = loadToken;
  void startDeferredAnalysisSession(loadToken)
    .catch((error) => {
      if (loadToken !== state.loadToken) {
        return;
      }

      setAnalysisStatus(`Spectrogram failed: ${error instanceof Error ? error.message : String(error)}`, true);
    });
}

function handleWaveformWorkerMessage(loadToken: number, message: WaveformWorkerToMainMessage): void {
  if (!isCurrentWorkerMessage(
    loadToken,
    state.loadToken,
    state.waveformSessionRevision,
    (message.body as { sessionVersion?: number } | undefined)?.sessionVersion,
  )) {
    return;
  }

  switch (message.type) {
    case 'runtimeReady':
      return;
    case 'analysisInitialized':
      handleWaveformSurfaceReady();
      return;
    case 'waveformPyramidReady':
      requestWaveformRender();
      return;
    case 'waveformPresented':
      state.waveformViewport.activeRenderRange = {
        start: Number(message.body?.viewStart) || 0,
        end: Number(message.body?.viewEnd) || 0,
      };
      state.waveformViewport.activeRenderWidthPx = Math.max(
        1,
        Math.round(Number(message.body?.width) || state.waveformViewport.renderWidthPx || 1),
      );
      state.waveformViewport.activeRenderHeightPx = Math.max(1, Math.round(Number(message.body?.height) || 1));
      state.waveformViewport.presentedPeak = Number(message.body?.peak) || 0;
      state.waveformViewport.pendingRenderRange = null;
      state.waveformViewport.pendingRenderWidthPx = 0;
      state.waveformViewport.pendingRenderHeightPx = 0;
      syncWaveformCanvasPresentation();
      setSurfaceLoading('waveform', false);
      handleWaveformSurfaceReady();
      return;
    case 'error':
      setFatalStatus(`Waveform failed: ${message.body?.message || 'Unknown worker error.'}`);
      return;
    default:
      return;
  }
}

function handleEngineWorkerMessage(message: EngineWorkerToMainMessage): void {
  switch (message.type) {
    case 'ViewportUiState':
      applyViewportUiState(message.body);
      return;
    case 'SampleInfo':
      applySampleInfo(message.body);
      return;
    case 'Error':
      setFatalStatus(`Audio engine failed: ${message.body.message}`);
      return;
    default:
      return;
  }
}

function requestWaveformRender(uiState: ViewportUiState | null = state.engineUiState): void {
  if (!state.waveformWorker || !uiState) {
    return;
  }

  const sampleRate = uiState.playback.sampleRate || getSampleRate();
  if (!(sampleRate > 0)) {
    return;
  }

  const grid = getWaveformColumnGrid(uiState);
  if (!grid) {
    return;
  }

  // Render the presented range plus a fixed strip of slack columns that hang off the
  // right edge, at exactly one device pixel per grid column. The visible part is 1:1
  // with the viewport, so there is never a CSS scale bridge (the old zoom-flash);
  // the slack only ever moves under an integer-pixel translate, which is pixel-exact
  // because every column sits on the shared absolute grid.
  const renderWidthPx = grid.columnCount / DISPLAY_PIXEL_RATIO;
  const renderRange: TimeRange = {
    start: uiState.presentedStartFrame / sampleRate,
    end: (uiState.presentedStartFrame + grid.spanSamples) / sampleRate,
  };
  if (!(renderRange.end > renderRange.start)) {
    return;
  }

  const laneCount = getSpectrogramLaneCount();
  const renderHeightPx = Math.max(
    1,
    Math.round((state.observedWaveformViewportHeight || getWaveformViewportSize().height) / laneCount),
  );

  if (areWaveformRenderRequestsEqual(
    state.waveformViewport.activeRenderRange,
    state.waveformViewport.activeRenderWidthPx,
    state.waveformViewport.activeRenderHeightPx,
    renderRange,
    renderWidthPx,
    renderHeightPx,
  ) || areWaveformRenderRequestsEqual(
    state.waveformViewport.pendingRenderRange,
    state.waveformViewport.pendingRenderWidthPx,
    state.waveformViewport.pendingRenderHeightPx,
    renderRange,
    renderWidthPx,
    renderHeightPx,
  )) {
    syncWaveformCanvasPresentation(uiState);
    return;
  }

  state.waveformRenderGeneration += 1;
  state.waveformViewport.pendingRenderRange = renderRange;
  state.waveformViewport.pendingRenderWidthPx = renderWidthPx;
  state.waveformViewport.pendingRenderHeightPx = renderHeightPx;
  const message = {
    type: 'renderWaveformView',
    body: {
      amplitudeMax: state.waveformAmplitudeMax,
      generation: state.waveformRenderGeneration,
      height: renderHeightPx,
      renderScale: DISPLAY_PIXEL_RATIO,
      viewEnd: renderRange.end,
      viewStart: renderRange.start,
      // The on-screen part of the rendered window. The worker scopes the reported
      // peak to it so amplitude Fit ignores the off-screen slack columns.
      visibleSpan: Math.max(0, (uiState.presentedEndFrame - uiState.presentedStartFrame) / sampleRate),
      width: renderWidthPx,
    },
  };
  state.lastWaveformRenderMessage = message;
  state.waveformWorker.postMessage(message);
  broadcastWaveformLaneMessage(message);
}

function getPlaybackProgress(
  uiState: ViewportUiState,
  playback: PlaybackClockState,
): PlaybackProgressSnapshot {
  return calculatePlaybackProgress({
    currentFrameFloat: playback.currentFrameFloat,
    durationFrames: playback.durationFrames,
    // From the engine, not re-derived here: it is the side that tracks the drag
    // state the rule keys off, and two copies of the rule would drift.
    followCursorLocked: uiState.followCursorLocked,
    presentedEndFrame: uiState.presentedEndFrame,
    presentedStartFrame: uiState.presentedStartFrame,
  });
}

function applyPlaybackToUiState(uiState: ViewportUiState, playback: PlaybackClockState): void {
  const progress = getPlaybackProgress(uiState, playback);
  uiState.cursorPercent = progress.cursorPercent;
  uiState.cursorVisible = progress.cursorVisible;
  uiState.overview.currentPercent = progress.overviewCurrentPercent;
  uiState.overview.currentVisible = progress.overviewCurrentVisible;
  uiState.playback = playback;
}

function applyLatestPlaybackClock(uiState: ViewportUiState): void {
  if (state.latestPlaybackClock) {
    applyPlaybackToUiState(uiState, state.latestPlaybackClock);
  }
}

function applyPlaybackClock(playback: PlaybackClockState): void {
  state.latestPlaybackClock = playback;
  if (!state.engineUiState) {
    return;
  }

  applyPlaybackToUiState(state.engineUiState, playback);
  renderPlaybackPosition(state.engineUiState);
}

function getHoverTarget(surface: SurfaceKind): HTMLElement {
  return surface === 'waveform' ? elements.waveformHitTarget : elements.spectrogramHitTarget;
}

function hideHoverForSurface(surface: SurfaceKind): void {
  if (surface === 'waveform') {
    hideWaveformHoverTooltip();
    return;
  }

  hideSpectrogramHoverTooltip();
}

async function decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('Web Audio API is unavailable in this webview.');
  }

  if (!state.decodeAudioContext || state.decodeAudioContext.state === 'closed') {
    state.decodeAudioContext = new AudioContextConstructor();
  }

  return await state.decodeAudioContext.decodeAudioData(arrayBuffer);
}

async function startDeferredAnalysisSession(loadToken: number): Promise<void> {
  const pending = state.pendingAnalysisSession;

  if (!pending || pending.loadToken !== loadToken || loadToken !== state.loadToken) {
    return;
  }

  state.pendingAnalysisSession = null;
  teardownSpectrogramLanes();
  const laneCount = getSpectrogramLaneCount();
  layoutSpectrogramLanePrimary(laneCount);
  state.spectrogramSurfaceReadyPromise = initializeSpectrogramSurface(loadToken);
  await state.spectrogramSurfaceReadyPromise;

  if (loadToken !== state.loadToken) {
    return;
  }

  const analysisWorker = await ensureAnalysisWorker(loadToken);
  if (!analysisWorker || loadToken !== state.loadToken) {
    return;
  }

  const runtimeReadyPromise = state.analysisRuntimeReadyPromise;
  if (runtimeReadyPromise) {
    await runtimeReadyPromise;
  }

  if (loadToken !== state.loadToken) {
    return;
  }

  // Lane 0 (the primary worker) renders channel 0 in split mode, or the mono
  // downmix otherwise. A dedicated session revision forces the worker to
  // re-prepare its WASM session with the new per-lane PCM on a mode change.
  state.spectrogramSessionRevision += 1;
  state.loudnessChannelSessionRevision = 0;
  const primaryPcm = laneCount > 1 && pending.playbackSession.channelBuffers[0] instanceof ArrayBuffer
    ? new Float32Array(pending.playbackSession.channelBuffers[0].slice(0))
    : pending.monoSamples;
  analysisWorker.postMessage({
    type: 'attachAudioSession',
    body: {
      duration: pending.playbackSession.durationSeconds,
      quality: pending.quality,
      sampleCount: primaryPcm.length,
      sampleRate: pending.playbackSession.sourceSampleRate,
      samplesBuffer: primaryPcm.buffer,
      sessionVersion: state.spectrogramSessionRevision,
    },
  }, [primaryPcm.buffer]);

  await setupSpectrogramSatellites(
    loadToken,
    laneCount,
    pending.playbackSession.sourceSampleRate,
    pending.playbackSession.durationSeconds,
    pending.quality,
  );
}

async function initializeDecodedPlayback(loadToken: number, payload: any, decodedAudio: AudioBuffer): Promise<void> {
  await initializePlaybackFromPreparedData(
    loadToken,
    payload,
    await createPlaybackAnalysisData(decodedAudio, downmixPcmInWorker),
  );
}

async function initializePlaybackFromPreparedData(
  loadToken: number,
  payload: any,
  preparedPlaybackData: {
    monoSamples: Float32Array;
    playbackSession: PlaybackSession;
    waveformSamples: Float32Array;
  },
): Promise<void> {
  const { monoSamples, playbackSession, waveformSamples } = preparedPlaybackData;

  // Refuse files beyond the analysis ceiling: holding per-channel PCM across the
  // transport + waveform + spectrogram workers would multiply into several GB
  // and risk an OOM crash. Better to show a clear message than to take down the
  // editor host.
  const totalAnalysisSamples = Math.max(0, playbackSession.sourceLength) * Math.max(1, playbackSession.numberOfChannels);
  if (totalAnalysisSamples > MAX_TOTAL_ANALYSIS_SAMPLES) {
    const durationMinutes = playbackSession.sourceSampleRate > 0
      ? Math.round(playbackSession.sourceLength / playbackSession.sourceSampleRate / 60)
      : 0;
    setFatalStatus(
      `This file is too large for audioscope to analyze (${durationMinutes} min, ${playbackSession.numberOfChannels} ch). `
      + 'Try a shorter excerpt.',
    );
    return;
  }

  const audioTransport = state.audioTransport;
  state.playbackSession = playbackSession;
  state.lastSyncedSpectrogramDisplay = null;
  state.analysis = createSpectrogramAnalysisState(
    playbackSession.durationSeconds,
    normalizeSpectrogramQuality(payload?.spectrogramQuality),
    monoSamples.length,
    playbackSession.sourceSampleRate,
  );

  await state.waveformSurfaceReadyPromise;

  const engineWorker = await ensureEngineWorker(loadToken);
  const waveformWorker = await ensureWaveformWorker(loadToken);
  if (
    !audioTransport
    || !engineWorker
    || !waveformWorker
    || loadToken !== state.loadToken
    || state.audioTransport !== audioTransport
  ) {
    return;
  }

  state.engineSessionRevision += 1;
  engineWorker.postMessage({
    type: 'LoadAnalysisSession',
    body: {
      durationFrames: playbackSession.sourceLength,
      sampleRate: playbackSession.sourceSampleRate,
      sessionRevision: state.engineSessionRevision,
    },
  });
  // Sets up the primary waveform lane with the worker-created fan-out buffer;
  // the analysis copy remains available for the spectrogram session below.
  void setupWaveformChannels(loadToken, waveformSamples, playbackSession);

  state.pendingAnalysisSession = {
    loadToken,
    monoSamples,
    playbackSession,
    quality: normalizeSpectrogramQuality(payload?.spectrogramQuality),
  };

  // Start the spectrogram session in parallel with the waveform (both right
  // after decode) instead of waiting for the waveform's first frame.
  void startDeferredAnalysisSession(loadToken).catch((error) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    setAnalysisStatus(`Spectrogram failed: ${error instanceof Error ? error.message : String(error)}`, true);
  });

  await audioTransport.load({
    playbackSession,
    workletModuleUrl: audioTransportProcessorScriptUri,
  });

  if (loadToken !== state.loadToken || state.audioTransport !== audioTransport) {
    return;
  }

  state.playbackTransportKind = audioTransport.getTransportKind() ?? 'unavailable';
  state.playbackTransportError = audioTransport.getLastFallbackReason() ?? null;
  renderMediaMetadata();
  renderWaveformUi();
  syncTransport();
  refreshSpectrogramAnalysisConfig({ persist: false });
  setAnalysisStatus('Playback ready');
}

const {
  acceptDecodeFallbackResult,
  disposeDecodeWorker,
  loadAudioFile,
  rejectDecodeFallbackRequest,
} = createAudioscopeLoadController({
  audioTransportProcessorScriptUri,
  createModuleWorker,
  createPlaybackSessionFromPcmFallback,
  createMediaMetadataState,
  decodeAudioData,
  decodeBrowserModuleWasmUri,
  decodeWorkerScriptUri,
  downmixPcm: downmixPcmInWorker,
  destroySession,
  embeddedMediaToolsGuidance: EMBEDDED_MEDIA_TOOLS_GUIDANCE,
  fetchDecodeModuleWasmBytes,
  initializeDecodedPlayback,
  initializePlaybackFromPreparedData,
  initializeWaveformSurface,
  normalizeExternalToolStatus,
  preparePlaybackAnalysisData,
  resetSpectrogramCanvasElement,
  renderMediaMetadata,
  renderSpectrogramScale,
  renderWaveformUi,
  setAnalysisStatus,
  setFatalStatus,
  setLoudnessSummaryUnavailable,
  setReadyLoudnessSummary,
  setPendingLoudnessSummary,
  clearFatalStatus,
  startPlaybackLoop,
  state,
  stretchProcessorScriptUri,
  syncTransport,
  vscode,
});

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;

  if (message?.type === 'loadAudio') {
    if (message.body && typeof message.body === 'object') {
      const { audioBytes: _audioBytes, ...activeFile } = message.body;
      state.activeFile = activeFile;
    } else {
      state.activeFile = message.body;
    }
    applyPersistedSpectrogramDefaults(message.body?.spectrogramDefaults);
    const persistedSplitRatio = Number(message.body?.viewportSplitRatio);
    if (Number.isFinite(persistedSplitRatio)) {
      state.viewportSplitRatio = clamp(persistedSplitRatio, VIEWPORT_RATIO_MIN, VIEWPORT_RATIO_MAX);
      applyViewportSplit(true);
    }
    applyWaveformAmplitudeMax(message.body?.waveformAmplitudeMax, { persist: false });
    state.playbackVolume = normalizePlaybackVolume(message.body?.playbackVolume);
    renderPlaybackVolumeUi();
    state.audioTransport?.setVolume(state.playbackVolume);
    syncWebGpuToggleFromActiveFile();
    syncSplitChannelsToggleFromActiveFile();
    renderSpectrogramMeta();
    state.externalTools = normalizeExternalToolStatus(message.body?.externalTools, EMBEDDED_MEDIA_TOOLS_GUIDANCE);
    void loadAudioFile(message.body);
    return;
  }

  if (message?.type === 'externalToolStatus') {
    state.externalTools = normalizeExternalToolStatus(message.body, EMBEDDED_MEDIA_TOOLS_GUIDANCE);
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'mediaMetadataReady') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    state.mediaMetadata = {
      detail: message.body?.metadata ?? null,
      loadToken,
      message: '',
      status: 'ready',
      summary: message.body?.metadata?.summary ?? null,
    };
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'mediaMetadataError') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    state.mediaMetadata = {
      detail: null,
      loadToken,
      message: message.body?.message || 'Metadata unavailable.',
      status: 'error',
      summary: null,
    };
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'decodeFallbackReady') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    acceptDecodeFallbackResult(loadToken, message.body);
    return;
  }

  if (message?.type === 'decodeFallbackError') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    rejectDecodeFallbackRequest(loadToken, message.body?.message || 'ffmpeg decode failed.');
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'loudnessSummaryReady') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    setReadyLoudnessSummary(message.body);
    return;
  }

  if (message?.type === 'loudnessSummaryError') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    setLoudnessSummaryUnavailable(message.body?.message ?? 'Failed to measure loudness summary.');
    return;
  }
});

function attachUiEvents(): void {
  ensureWaveformSampleMarkerElement();
  const waveFollowToggle = elements.waveFollow.closest<HTMLElement>('.wave-follow-toggle');
  const nonFocusableClickControls = [
    elements.mediaMetadataSummary,
    elements.seekBackward,
    elements.playToggle,
    elements.seekForward,
    elements.playbackRateButton,
    elements.waveZoomOut,
    elements.waveZoomReset,
    elements.waveZoomIn,
    elements.waveFollow,
    waveFollowToggle,
    elements.waveClearLoop,
    elements.waveAmpReset,
    elements.waveAmpOut,
    elements.waveAmpIn,
    elements.spectrogramMetaToggle,
    elements.spectrogramResetTypeButton,
  ];

  for (const control of nonFocusableClickControls) {
    control?.addEventListener('click', () => {
      focusKeyboardSurface();
    });
  }

  elements.mediaMetadataPanel.addEventListener('mouseenter', () => setMediaMetadataDetailOpen(true));
  elements.mediaMetadataPanel.addEventListener('mouseleave', () => setMediaMetadataDetailOpen(false));
  elements.mediaMetadataPanel.addEventListener('focusin', () => setMediaMetadataDetailOpen(true));
  elements.mediaMetadataPanel.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && elements.mediaMetadataPanel.contains(event.relatedTarget)) {
      return;
    }
    setMediaMetadataDetailOpen(false);
  });
  elements.mediaMetadataDetail.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const link = target.closest('[data-external-url]');
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }
    const url = link.dataset.externalUrl;
    if (!url) {
      return;
    }
    event.preventDefault();
    vscode.postMessage({
      type: 'openExternal',
      body: { url },
    });
  });

  elements.waveToolbar.addEventListener('scroll', () => {
    updateMediaMetadataDetailPosition();
    closeWaveMenus();
  }, { passive: true });

  window.addEventListener('resize', () => {
    updateMediaMetadataDetailPosition();
    closePlaybackRateMenu();
    closeWaveMenus();
    if (state.spectrogramMetaOpen) {
      setSpectrogramMetaOpen(true);
    }
  });

  // Re-scale the canvas backing stores when the device pixel ratio changes
  // (window dragged to a different-DPI monitor, or OS/browser zoom). A pure DPR
  // change does not alter CSS sizes, so the ResizeObserver would not fire and
  // the surfaces would otherwise stay at the launch resolution and look soft.
  const handleDevicePixelRatioChange = (): void => {
    const next = Math.max(window.devicePixelRatio || 1, DISPLAY_MIN_DPR);
    if (next !== DISPLAY_PIXEL_RATIO) {
      DISPLAY_PIXEL_RATIO = next;
      syncSurfaceSizes(true);
    }
    armDevicePixelRatioListener();
  };
  function armDevicePixelRatioListener(): void {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    try {
      window
        .matchMedia(`(resolution: ${DISPLAY_PIXEL_RATIO}dppx)`)
        .addEventListener('change', handleDevicePixelRatioChange, { once: true });
    } catch {
      // Older engines without a resolution media query: leave the launch DPR.
    }
  }
  armDevicePixelRatioListener();

  // Terminal teardown when the editor panel is disposed. retainContextWhenHidden
  // keeps this page alive while hidden, so the only reliable teardown signal is
  // pagehide. Release every long-lived resource (workers + their GPU device,
  // the decode AudioContext, and worker bootstrap object URLs) so repeated
  // open/close cycles do not accumulate AudioContexts or hundreds of MB of GPU
  // memory per session.
  window.addEventListener('pagehide', () => {
    destroySession();
    disposePcmDownmixWorker();
    disposeEngineWorker();
    disposeAnalysisWorker();
    disposeWaveformWorker();
    disposeDecodeWorker();
    if (state.decodeAudioContext && state.decodeAudioContext.state !== 'closed') {
      void state.decodeAudioContext.close().catch(() => {});
    }
    state.decodeAudioContext = null;
  });

  document.addEventListener('pointerdown', (event) => {
    if (!isPlaybackRateUiTarget(event.target)) {
      closePlaybackRateMenu();
    }
    if (!isWaveMenuUiTarget(event.target)) {
      closeWaveMenus();
    }
  }, true);

  document.addEventListener('focusin', (event) => {
    if (!isPlaybackRateUiTarget(event.target)) {
      closePlaybackRateMenu();
    }
    if (!isWaveMenuUiTarget(event.target)) {
      closeWaveMenus();
    }
  });

  const handleGlobalShortcut = (event: KeyboardEvent, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  const handleGlobalShortcutKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) {
      return;
    }

    if (event.code === 'Escape' && (state.waveExportMenuOpen || state.waveOverflowMenuOpen)) {
      handleGlobalShortcut(event, () => {
        if (state.waveExportMenuOpen) {
          closeWaveExportMenu({ restoreFocus: true });
        } else {
          closeWaveOverflowMenu({ restoreFocus: true });
        }
      });
      return;
    }

    if (
      event.ctrlKey
      || event.metaKey
      || event.altKey
      || isTextEditableTarget(event.target)
      || isPlaybackRateUiTarget(event.target)
      || isWaveMenuUiTarget(event.target)
    ) {
      return;
    }

    if (event.code === 'Space') {
      handleGlobalShortcut(event, () => {
        void togglePlayback();
      });
      return;
    }

    if (event.code === 'ArrowLeft') {
      handleGlobalShortcut(event, () => {
        seekBy(-5);
      });
      return;
    }

    if (event.code === 'ArrowRight') {
      handleGlobalShortcut(event, () => {
        seekBy(5);
      });
      return;
    }

    if (event.code === 'ArrowUp') {
      handleGlobalShortcut(event, () => {
        stepPlaybackVolume(1);
      });
      return;
    }

    if (event.code === 'ArrowDown') {
      handleGlobalShortcut(event, () => {
        stepPlaybackVolume(-1);
      });
      return;
    }

    if (event.code === 'KeyF' && !event.repeat) {
      handleGlobalShortcut(event, () => {
        sendViewportIntent({
          enabled: !state.followPlayback,
          kind: 'setFollow',
        });
      });
      return;
    }

    if (event.code === 'Minus') {
      handleGlobalShortcut(event, () => {
        sendViewportIntent({ direction: 'out', kind: 'zoomStep' });
      });
      return;
    }

    if (event.code === 'Equal') {
      handleGlobalShortcut(event, () => {
        sendViewportIntent({ direction: 'in', kind: 'zoomStep' });
      });
    }
  };

  window.addEventListener('keydown', handleGlobalShortcutKeydown, { capture: true });

  elements.spectrogramTypeSelect.addEventListener('change', () => {
    const previousAnalysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
    const previousDefaults = getDefaultSpectrogramDbWindow(previousAnalysisType);
    const previousWindow = normalizeSpectrogramDbWindow(
      state.spectrogramConfig.minDecibels,
      state.spectrogramConfig.maxDecibels,
      previousAnalysisType,
    );
    const nextAnalysisType = normalizeSpectrogramAnalysisType(elements.spectrogramTypeSelect.value);
    state.spectrogramConfig.analysisType = nextAnalysisType;

    if (
      previousWindow.minDecibels === previousDefaults.minDecibels
      && previousWindow.maxDecibels === previousDefaults.maxDecibels
    ) {
      const nextDefaults = getDefaultSpectrogramDbWindow(nextAnalysisType);
      state.spectrogramConfig.minDecibels = nextDefaults.minDecibels;
      state.spectrogramConfig.maxDecibels = nextDefaults.maxDecibels;
    }

    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramFftSelect.addEventListener('change', () => {
    state.spectrogramConfig.fftSize = normalizeSpectrogramFftSize(elements.spectrogramFftSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramOverlapSelect.addEventListener('change', () => {
    state.spectrogramConfig.overlapRatio = normalizeSpectrogramOverlapRatio(elements.spectrogramOverlapSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramWindowSelect.addEventListener('change', () => {
    state.spectrogramConfig.windowFunction = normalizeSpectrogramWindowFunction(elements.spectrogramWindowSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramResetTypeButton.addEventListener('click', () => {
    resetCurrentSpectrogramTypeToDefaults();
  });
  elements.spectrogramMelBandsSelect.addEventListener('change', () => {
    state.spectrogramConfig.melBandCount = normalizeSpectrogramMelBandCount(elements.spectrogramMelBandsSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramMfccCoefficientsSelect.addEventListener('change', () => {
    state.spectrogramConfig.mfccCoefficientCount = normalizeSpectrogramMfccCoefficientCount(
      elements.spectrogramMfccCoefficientsSelect.value,
    );
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramMfccMelBandsSelect.addEventListener('change', () => {
    state.spectrogramConfig.mfccMelBandCount = normalizeSpectrogramMfccMelBandCount(
      elements.spectrogramMfccMelBandsSelect.value,
    );
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramScalogramOmegaSlider.addEventListener('input', () => {
    elements.spectrogramScalogramOmegaValue.textContent = String(
      getSpectrogramScalogramOmega0FromSlider(elements.spectrogramScalogramOmegaSlider.value),
    );
  });
  elements.spectrogramScalogramOmegaSlider.addEventListener('change', () => {
    state.spectrogramConfig.scalogramOmega0 = getSpectrogramScalogramOmega0FromSlider(
      elements.spectrogramScalogramOmegaSlider.value,
    );
    elements.spectrogramScalogramOmegaValue.textContent = String(state.spectrogramConfig.scalogramOmega0);
    scheduleSpectrogramConfigRefresh();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramScaleSelect.addEventListener('change', () => {
    state.spectrogramConfig.frequencyScale = normalizeSpectrogramFrequencyScale(elements.spectrogramScaleSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramDistributionSelect.addEventListener('change', () => {
    state.spectrogramConfig.colormapDistribution = normalizeSpectrogramColormapDistribution(
      elements.spectrogramDistributionSelect.value,
    );
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramWebGpuToggle.addEventListener('change', () => {
    const enabled = elements.spectrogramWebGpuToggle.checked;
    if (state.activeFile) {
      (state.activeFile as { enableWebGpuRendering?: boolean }).enableWebGpuRendering = enabled;
    }
    vscode.postMessage({ type: 'persistWebGpuRendering', body: { enabled } });
    applyWebGpuRenderingChange();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramSplitChannelsToggle.addEventListener('change', () => {
    const enabled = elements.spectrogramSplitChannelsToggle.checked;
    state.splitChannels = enabled;
    if (state.activeFile) {
      (state.activeFile as { splitChannels?: boolean }).splitChannels = enabled;
    }
    vscode.postMessage({ type: 'persistSplitChannels', body: { enabled } });
    applyChannelModeChange();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramMeta.addEventListener('dragstart', (event) => {
    event.preventDefault();
  });
  elements.spectrogramMinDbSlider.addEventListener('input', () => {
    const dbWindow = normalizeSpectrogramDbWindow(
      elements.spectrogramMinDbSlider.value,
      state.spectrogramConfig.maxDecibels,
      normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType),
    );
    state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
    state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
    renderSpectrogramDbWindowUi(dbWindow);
    scheduleSpectrogramConfigRefresh();
  });
  elements.spectrogramMaxDbSlider.addEventListener('input', () => {
    const dbWindow = normalizeSpectrogramDbWindow(
      state.spectrogramConfig.minDecibels,
      elements.spectrogramMaxDbSlider.value,
      normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType),
    );
    state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
    state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
    renderSpectrogramDbWindowUi(dbWindow);
    scheduleSpectrogramConfigRefresh();
  });
  // 'change' (not 'input') so the min<max clamp doesn't fight the user mid-typing.
  const applySpectrogramFreqRange = () => {
    const range = normalizeSpectrogramScalogramFrequencyRange(
      elements.spectrogramFreqMinInput.value,
      elements.spectrogramFreqMaxInput.value,
    );
    state.spectrogramConfig.spectrogramMinFrequency = range.minFrequency;
    state.spectrogramConfig.spectrogramMaxFrequency = range.maxFrequency;
    elements.spectrogramFreqMinInput.value = String(range.minFrequency);
    elements.spectrogramFreqMaxInput.value = String(range.maxFrequency);
    scheduleSpectrogramConfigRefresh();
  };
  elements.spectrogramFreqMinInput.addEventListener('change', applySpectrogramFreqRange);
  elements.spectrogramFreqMaxInput.addEventListener('change', applySpectrogramFreqRange);
  elements.spectrogramMetaToggle.addEventListener('click', () => {
    setSpectrogramMetaOpen(!state.spectrogramMetaOpen);
    if (!state.spectrogramMetaOpen) {
      scheduleKeyboardSurfaceFocus();
    }
  });

  // Loudness controls.
  elements.loudnessRefSelect.addEventListener('change', () => {
    state.spectrogramConfig.loudnessRefPreset = normalizeLoudnessRefPreset(elements.loudnessRefSelect.value);
    elements.loudnessRefInput.hidden = elements.loudnessRefSelect.value !== 'custom';
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.loudnessRefInput.addEventListener('change', () => {
    state.spectrogramConfig.loudnessRefCustom = normalizeLoudnessRefCustom(elements.loudnessRefInput.value);
    elements.loudnessRefInput.value = String(state.spectrogramConfig.loudnessRefCustom);
    refreshSpectrogramAnalysisConfig();
  });
  elements.loudnessYAxisSelect.addEventListener('change', () => {
    state.spectrogramConfig.loudnessYAxisMode = normalizeLoudnessYAxisMode(elements.loudnessYAxisSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.loudnessMinLufsSlider.addEventListener('input', () => {
    const { max, min } = normalizeLoudnessYAxisRange(
      elements.loudnessMinLufsSlider.value,
      state.spectrogramConfig.loudnessYAxisMax,
    );
    state.spectrogramConfig.loudnessYAxisMin = min;
    state.spectrogramConfig.loudnessYAxisMax = max;
    renderSpectrogramMeta();
    scheduleSpectrogramConfigRefresh();
  });
  elements.loudnessMaxLufsSlider.addEventListener('input', () => {
    const { max, min } = normalizeLoudnessYAxisRange(
      state.spectrogramConfig.loudnessYAxisMin,
      elements.loudnessMaxLufsSlider.value,
    );
    state.spectrogramConfig.loudnessYAxisMin = min;
    state.spectrogramConfig.loudnessYAxisMax = max;
    renderSpectrogramMeta();
    scheduleSpectrogramConfigRefresh();
  });
  elements.loudnessCurvesSelect.addEventListener('change', () => {
    state.spectrogramConfig.loudnessCurves = normalizeLoudnessCurves(elements.loudnessCurvesSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.loudnessPeakSelect.addEventListener('change', () => {
    state.spectrogramConfig.loudnessShowPeak = elements.loudnessPeakSelect.value === 'show';
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });

  elements.seekBackward.addEventListener('click', () => seekBy(-5));
  elements.seekForward.addEventListener('click', () => seekBy(5));
  elements.playToggle.addEventListener('click', () => { void togglePlayback(); });
  elements.playbackRateButton.addEventListener('click', () => {
    if (state.playbackRateMenuOpen) {
      closePlaybackRateMenu();
      scheduleKeyboardSurfaceFocus();
      return;
    }

    openPlaybackRateMenu({ focusSelected: false });
  });
  elements.playbackRateButton.addEventListener('keydown', (event) => {
    if (event.code === 'ArrowDown' || event.code === 'Enter' || event.code === 'Space') {
      event.preventDefault();
      openPlaybackRateMenu();
      return;
    }
    if (event.code === 'ArrowUp') {
      event.preventDefault();
      openPlaybackRateMenu();
      const buttons = getPlaybackRateOptionButtons();
      focusPlaybackRateOption(Math.max(0, buttons.length - 1));
      return;
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      closePlaybackRateMenu();
    }
  });
  elements.playbackRateMenu.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      closePlaybackRateMenu({ restoreFocus: true });
      return;
    }
    if (event.code === 'ArrowDown') {
      event.preventDefault();
      movePlaybackRateFocus(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      event.preventDefault();
      movePlaybackRateFocus(-1);
    }
  });
  elements.playbackRateSelect.addEventListener('change', () => {
    state.playbackRate = normalizePlaybackRateSelection(elements.playbackRateSelect.value);
    state.audioTransport?.setPlaybackRate(state.playbackRate);
    renderMediaMetadata();
    syncTransport();
    scheduleKeyboardSurfaceFocus();
  });

  elements.timeline.addEventListener('input', () => {
    if (!state.audioTransport || getDurationFrames() <= 0) {
      return;
    }
    setPlaybackPositionFromFrame(Math.round(Number(elements.timeline.value) * getDurationFrames()));
  });
  elements.timeline.addEventListener('pointerup', () => {
    scheduleKeyboardSurfaceFocus();
  });

  elements.waveformOverview.addEventListener('pointermove', updateTimelineHoverTooltip);
  elements.waveformOverview.addEventListener('pointerleave', hideTimelineHoverTooltip);
  elements.waveformOverview.addEventListener('pointercancel', hideTimelineHoverTooltip);

  elements.waveZoomOut.addEventListener('click', () => sendViewportIntent({ direction: 'out', kind: 'zoomStep' }));
  elements.waveZoomReset.addEventListener('click', () => sendViewportIntent({ kind: 'resetZoom' }));
  elements.waveZoomIn.addEventListener('click', () => sendViewportIntent({ direction: 'in', kind: 'zoomStep' }));
  elements.waveAmpReset.addEventListener('click', () => applyWaveformAmplitudeMax(DEFAULT_WAVEFORM_AMPLITUDE_MAX));
  elements.waveAmpOut.addEventListener('click', () => applyWaveformAmplitudeMax(stepWaveformAmplitudeMax('out')));
  elements.waveAmpIn.addEventListener('click', () => applyWaveformAmplitudeMax(stepWaveformAmplitudeMax('in')));
  elements.waveAmpFit.addEventListener('click', () => {
    fitWaveformAmplitudeToView();
    scheduleKeyboardSurfaceFocus();
  });
  elements.waveFollow.addEventListener('change', () => {
    sendViewportIntent({
      enabled: elements.waveFollow.checked,
      kind: 'setFollow',
    });
  });
  elements.waveClearLoop.addEventListener('click', () => {
    closeWaveExportMenu();
    sendViewportIntent({ kind: 'clearLoop' });
  });
  elements.waveExport.addEventListener('click', () => {
    if (state.waveExportMenuOpen) {
      closeWaveExportMenu({ restoreFocus: true });
    } else {
      openWaveExportMenu();
    }
  });
  elements.waveExportMenu.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('[data-export-format]')
      : null;
    const format = button?.dataset.exportFormat;
    if (!isExportAudioFormat(format)) {
      return;
    }
    closeWaveExportMenu();
    exportSelectedAudio(format);
    scheduleKeyboardSurfaceFocus();
  });
  elements.waveExportMenu.addEventListener('keydown', (event) => {
    handleWaveMenuKeydown(event, elements.waveExportMenu, closeWaveExportMenu);
  });
  elements.waveOverflowToggle.addEventListener('click', () => {
    if (state.waveOverflowMenuOpen) {
      closeWaveOverflowMenu({ restoreFocus: true });
    } else {
      openWaveOverflowMenu();
    }
  });
  elements.waveOverflowMenu.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('[data-export-format]')
      : null;
    const format = button?.dataset.exportFormat;
    if (!isExportAudioFormat(format)) {
      return;
    }
    closeWaveOverflowMenu();
    exportSelectedAudio(format);
    scheduleKeyboardSurfaceFocus();
  });
  elements.waveOverflowMenu.addEventListener('keydown', (event) => {
    handleWaveMenuKeydown(event, elements.waveOverflowMenu, closeWaveOverflowMenu);
  });
  elements.waveOverflowSettings.addEventListener('click', () => {
    closeWaveOverflowMenu();
    setSpectrogramMetaOpen(true);
  });
  elements.volumeSlider.addEventListener('input', () => {
    applyPlaybackVolume(playbackVolumeFromSliderValue(elements.volumeSlider.value));
  });
  for (const control of [elements.volumeToggle, elements.volumeSlider]) {
    control.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') {
        control.blur();
      }
    });
  }
  for (const type of ['pointerenter', 'pointerleave', 'focus', 'blur']) {
    elements.volumeSlider.addEventListener(type, renderPlaybackVolumeUi);
  }

  // One wheel listener for the whole viewport — the waveform window, the shared time strip
  // and splitter between the panels, and the spectrogram window. Pick the surface from
  // where the cursor is and anchor the zoom against that surface's element; the two
  // surfaces are x-aligned (same panel inline padding), so the time strip and splitter
  // resolve correctly through the waveform. Scrollable chrome (the toolbar and the
  // spectrogram settings panel) is skipped so its own scrolling keeps working.
  elements.viewport.addEventListener(
    'wheel',
    (event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || elements.waveToolbar.contains(target) || elements.spectrogramMeta.contains(target)) {
        return;
      }
      const onSpectrogram = elements.spectrogramPanel.contains(target);
      handleViewportWheel(
        event,
        onSpectrogram ? 'spectrogram' : 'waveform',
        onSpectrogram ? elements.spectrogramHitTarget : elements.waveformViewport,
      );
    },
    { passive: false },
  );

  elements.waveformHitTarget.addEventListener('pointerdown', (event) => beginSelectionDrag(event, elements.waveformHitTarget, 'waveform'));
  elements.waveformHitTarget.addEventListener('pointermove', (event) => {
    requestSampleInfo('waveform', event);
    updateSelectionDrag(event, elements.waveformHitTarget, 'waveform');
  });
  elements.waveformHitTarget.addEventListener('pointerleave', hideWaveformHoverTooltip);
  elements.waveformHitTarget.addEventListener('pointerup', (event) => releaseSelectionDrag(event, elements.waveformHitTarget, 'waveform'));
  elements.waveformHitTarget.addEventListener('pointercancel', (event) => {
    hideWaveformHoverTooltip();
    releaseSelectionDrag(event, elements.waveformHitTarget, 'waveform', true);
  });

  elements.spectrogramHitTarget.addEventListener('pointerdown', (event) => beginSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram'));
  elements.spectrogramHitTarget.addEventListener('pointermove', (event) => {
    requestSampleInfo('spectrogram', event);
    updateSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram');
  });
  elements.spectrogramHitTarget.addEventListener('pointerleave', hideSpectrogramHoverTooltip);
  elements.spectrogramHitTarget.addEventListener('pointerup', (event) => releaseSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram'));
  elements.spectrogramHitTarget.addEventListener('pointercancel', (event) => {
    hideSpectrogramHoverTooltip();
    releaseSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram', true);
  });
  elements.spectrogramHitTarget.addEventListener('dblclick', () => { void togglePlayback(); });

  bindLoopHandle(elements.waveformLoopStart, 'start', elements.waveformHitTarget, 'waveform');
  bindLoopHandle(elements.waveformLoopEnd, 'end', elements.waveformHitTarget, 'waveform');
  bindLoopHandle(elements.spectrogramLoopStart, 'start', elements.spectrogramHitTarget, 'spectrogram');
  bindLoopHandle(elements.spectrogramLoopEnd, 'end', elements.spectrogramHitTarget, 'spectrogram');

  elements.viewportSplitter.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    elements.viewportSplitter.setPointerCapture(event.pointerId);
    state.viewportResizeDrag = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startRatio: state.viewportSplitRatio,
    };
  });
  elements.viewportSplitter.addEventListener('pointermove', (event) => {
    const drag = state.viewportResizeDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    updateViewportSplitRatioFromClientY(event.clientY, drag.startClientY, drag.startRatio);
  });
  elements.viewportSplitter.addEventListener('pointerup', (event) => {
    const drag = state.viewportResizeDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (elements.viewportSplitter.hasPointerCapture?.(event.pointerId)) {
      elements.viewportSplitter.releasePointerCapture(event.pointerId);
    }
    state.viewportResizeDrag = null;
    updateViewportSplitRatioFromClientY(event.clientY, drag.startClientY, drag.startRatio);
    schedulePersistViewportSplitRatio();
  });
  elements.viewportSplitter.addEventListener('pointercancel', (event) => {
    if (!state.viewportResizeDrag || state.viewportResizeDrag.pointerId !== event.pointerId) {
      return;
    }
    state.viewportResizeDrag = null;
    // The dragged ratio stays applied on cancel, so persist what the user sees.
    schedulePersistViewportSplitRatio();
  });
  elements.viewportSplitter.addEventListener('dblclick', () => {
    state.viewportSplitRatio = DEFAULT_VIEWPORT_SPLIT_RATIO;
    applyViewportSplit(true);
    schedulePersistViewportSplitRatio();
  });
  elements.viewportSplitter.addEventListener('keydown', (event) => {
    let nextRatio: number | null = null;
    if (event.key === 'ArrowUp') {
      nextRatio = state.viewportSplitRatio - VIEWPORT_SPLIT_STEP;
    } else if (event.key === 'ArrowDown') {
      nextRatio = state.viewportSplitRatio + VIEWPORT_SPLIT_STEP;
    } else if (event.key === 'Home') {
      nextRatio = VIEWPORT_RATIO_MIN;
    } else if (event.key === 'End') {
      nextRatio = VIEWPORT_RATIO_MAX;
    } else if (event.key === 'Enter' || event.key === ' ') {
      nextRatio = DEFAULT_VIEWPORT_SPLIT_RATIO;
    }

    if (nextRatio === null) {
      return;
    }
    event.preventDefault();
    state.viewportSplitRatio = clamp(nextRatio, VIEWPORT_RATIO_MIN, VIEWPORT_RATIO_MAX);
    applyViewportSplit(true);
    schedulePersistViewportSplitRatio();
  });
}

if (
  typeof OffscreenCanvas !== 'function'
  || typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function'
) {
  setFatalStatus('OffscreenCanvas is required for audioscope.');
} else {
  initializePlaybackRateControl();
  initializeKeyboardSurfaceFocus();
  attachUiEvents();
  attachResizeObservers();
  applyViewportSplit(true);
  renderWaveformUi();
  renderWaveformAmplitudeUi();
  renderPlaybackVolumeUi();
  renderSpectrogramMeta();
  renderSpectrogramScale();
  renderLoudnessSummary();
  renderMediaMetadata();
  syncMediaMetadataDetailVisibility();
  vscode.postMessage({ type: 'ready' });
}
