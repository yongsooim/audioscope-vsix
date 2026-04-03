export type WaveformPlotMode = 'envelope' | 'raw' | 'sample';
export type SpectrogramAnalysisType = 'mel' | 'scalogram' | 'spectrogram';
export type SpectrogramFrequencyScale = 'linear' | 'log' | 'mixed';
export type SurfaceKind = 'spectrogram' | 'waveform';

export interface PlaybackClockState {
  currentFrameFloat: number;
  durationFrames: number;
  loopEndFrame: number | null;
  loopStartFrame: number | null;
  playing: boolean;
  sampleRate: number;
}

export interface ViewportState {
  followEnabled: boolean;
  plotMode: WaveformPlotMode;
  presentedEndFrame: number;
  presentedStartFrame: number;
  renderWidthPx: number;
  renderedEndFrame: number;
  renderedStartFrame: number;
  targetEndFrame: number;
  targetStartFrame: number;
}

export interface FrameAxisTick {
  align: 'center' | 'end' | 'start';
  frame: number;
  label: string;
  positionRatio: number;
}

export interface FrequencyTickUi {
  edge: 'bottom' | 'middle' | 'top';
  frequency: number;
  label: string;
  positionRatio: number;
}

export interface SelectionUiState {
  active: boolean;
  committed: boolean;
  endFrame: number | null;
  leftPercent: number;
  startFrame: number | null;
  widthPercent: number;
}

export interface OverviewUiState {
  currentPercent: number;
  currentVisible: boolean;
  viewportLeftPercent: number;
  viewportWidthPercent: number;
}

export type TransportCommand =
  | {
      frame: number;
      serial: number;
      type: 'seek';
    }
  | {
      endFrame: number;
      serial: number;
      startFrame: number;
      type: 'setLoop';
    }
  | {
      serial: number;
      type: 'clearLoop';
    };

export interface ViewportUiState {
  cursorPercent: number;
  cursorVisible: boolean;
  frequencyTicks: FrequencyTickUi[];
  overview: OverviewUiState;
  playback: PlaybackClockState;
  presentedEndFrame: number;
  presentedStartFrame: number;
  selection: SelectionUiState;
  serial: number;
  spectrogramPresentedEndFrame: number;
  spectrogramPresentedStartFrame: number;
  transportCommand: TransportCommand | null;
  viewport: ViewportState;
  waveformAxisTicks: FrameAxisTick[];
  waveformPresentedEndFrame: number;
  waveformPresentedStartFrame: number;
  zoomFactor: number;
}

export interface SampleInfoPayload {
  label: string;
  markerVisible: boolean;
  markerXRatio: number;
  markerYRatio: number;
  requestId: number;
  surface: SurfaceKind;
}

export interface InitSurfacesMessage {
  body: {
    spectrogramOffscreenCanvas?: OffscreenCanvas;
    spectrogramPixelHeight: number;
    spectrogramPixelWidth: number;
    waveformHeightCssPx: number;
    waveformOffscreenCanvas?: OffscreenCanvas;
    waveformRenderScale: number;
    waveformWidthCssPx: number;
  };
  type: 'InitSurfaces';
}

export interface LoadAnalysisSessionMessage {
  body: {
    durationFrames: number;
    monoSamplesBuffer: ArrayBuffer;
    quality: 'balanced' | 'high' | 'max';
    sampleRate: number;
    sessionRevision: number;
  };
  type: 'LoadAnalysisSession';
}

export interface PlaybackClockTickMessage {
  body: PlaybackClockState;
  type: 'PlaybackClockTick';
}

export type ViewportIntent =
  | {
      kind: 'clearLoop';
    }
  | {
      kind: 'loopHandleEnd';
      pointerRatioX: number;
      cancelled?: boolean;
      edge: 'end' | 'start';
      surface: SurfaceKind;
    }
  | {
      kind: 'loopHandleStart';
      pointerRatioX: number;
      edge: 'end' | 'start';
      surface: SurfaceKind;
    }
  | {
      kind: 'loopHandleUpdate';
      pointerRatioX: number;
      edge: 'end' | 'start';
      surface: SurfaceKind;
    }
  | {
      kind: 'resetZoom';
    }
  | {
      kind: 'resize';
      spectrogramPixelHeight: number;
      spectrogramPixelWidth: number;
      waveformHeightCssPx: number;
      waveformRenderScale: number;
      waveformWidthCssPx: number;
    }
  | {
      enabled: boolean;
      kind: 'setFollow';
    }
  | {
      frame: number;
      kind: 'setLoop';
    }
  | {
      kind: 'setViewFrameRange';
      endFrame: number;
      startFrame: number;
    }
  | {
      kind: 'selectionEnd';
      pointerRatioX: number;
      cancelled?: boolean;
      surface: SurfaceKind;
    }
  | {
      kind: 'selectionStart';
      pointerRatioX: number;
      surface: SurfaceKind;
    }
  | {
      kind: 'selectionUpdate';
      pointerRatioX: number;
      surface: SurfaceKind;
    }
  | {
      kind: 'wheel';
      deltaMode: number;
      deltaX: number;
      deltaY: number;
      pointerRatioX: number;
      surface: SurfaceKind;
    }
  | {
      direction: 'in' | 'out';
      kind: 'zoomStep';
    };

export interface SetViewportIntentMessage {
  body: ViewportIntent;
  type: 'SetViewportIntent';
}

export interface SetSpectrogramConfigMessage {
  body: {
    analysisType: SpectrogramAnalysisType;
    fftSize: number;
    frequencyScale: SpectrogramFrequencyScale;
    overlapRatio: number;
  };
  type: 'SetSpectrogramConfig';
}

export interface RequestSampleInfoMessage {
  body: {
    pointerRatioX: number;
    pointerRatioY: number;
    requestId: number;
    surface: SurfaceKind;
  };
  type: 'RequestSampleInfo';
}

export type EngineMainToWorkerMessage =
  | InitSurfacesMessage
  | LoadAnalysisSessionMessage
  | PlaybackClockTickMessage
  | RequestSampleInfoMessage
  | SetSpectrogramConfigMessage
  | SetViewportIntentMessage;

export interface ViewportUiStateMessage {
  body: ViewportUiState;
  type: 'ViewportUiState';
}

export interface WaveformSurfaceReadyMessage {
  body: {
    presentedEndFrame: number;
    presentedStartFrame: number;
    serial: number;
  };
  type: 'WaveformSurfaceReady';
}

export interface SpectrogramSurfaceReadyMessage {
  body: {
    presentedEndFrame: number;
    presentedStartFrame: number;
    serial: number;
  };
  type: 'SpectrogramSurfaceReady';
}

export interface SampleInfoMessage {
  body: SampleInfoPayload;
  type: 'SampleInfo';
}

export interface EngineErrorMessage {
  body: {
    message: string;
  };
  type: 'Error';
}

export type EngineWorkerToMainMessage =
  | EngineErrorMessage
  | SampleInfoMessage
  | SpectrogramSurfaceReadyMessage
  | ViewportUiStateMessage
  | WaveformSurfaceReadyMessage;
