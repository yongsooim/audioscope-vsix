import { createAudioTransport } from '../../transport/audioTransport';
import {
  createMediaMetadataState,
} from './media';
import {
  createPlaybackAnalysisDataFromPlaybackSession,
  createPlaybackSessionFromPcmFallback,
} from './playbackData';

export type AudioscopeWorkerBootstrapStateKey =
  | 'analysisWorkerBootstrapUrl'
  | 'decodeWorkerBootstrapUrl'
  | 'engineWorkerBootstrapUrl'
  | 'waveformWorkerBootstrapUrl';

interface AudioscopeLoadControllerDeps {
  audioTransportProcessorScriptUri?: string;
  createModuleWorker: (moduleUrl: string, bootstrapStateKey: AudioscopeWorkerBootstrapStateKey) => Worker;
  createPlaybackAnalysisDataFromPlaybackSession: typeof createPlaybackAnalysisDataFromPlaybackSession;
  createPlaybackSessionFromPcmFallback: typeof createPlaybackSessionFromPcmFallback;
  createMediaMetadataState: typeof createMediaMetadataState;
  decodeAudioData: (arrayBuffer: ArrayBuffer) => Promise<AudioBuffer>;
  decodeBrowserModuleScriptUri?: string;
  decodeBrowserModuleWasmUri?: string;
  decodeWorkerScriptUri?: string;
  destroySession: () => void;
  embeddedMediaToolsGuidance: string;
  initializeDecodedPlayback: (loadToken: number, payload: any, decodedAudio: AudioBuffer) => Promise<void>;
  initializePlaybackFromPreparedData: (loadToken: number, payload: any, preparedPlaybackData: any) => Promise<void>;
  initializeWaveformSurface: (loadToken: number) => Promise<void>;
  normalizeExternalToolStatus: (status: unknown, guidance?: string) => any;
  resetSpectrogramCanvasElement: () => void;
  renderMediaMetadata: () => void;
  renderSpectrogramScale: () => void;
  renderWaveformUi: () => void;
  setAnalysisStatus: (message: string, persistent?: boolean) => void;
  setFatalStatus: (message: string) => void;
  setLoudnessSummaryUnavailable: (message?: string) => void;
  setPendingLoudnessSummary: () => void;
  clearFatalStatus: () => void;
  startPlaybackLoop: () => void;
  state: any;
  stretchProcessorScriptUri?: string;
  syncTransport: () => void;
  vscode: { postMessage: (message: unknown) => void };
}

export function createAudioscopeLoadController({
  audioTransportProcessorScriptUri,
  createModuleWorker,
  createPlaybackAnalysisDataFromPlaybackSession,
  createPlaybackSessionFromPcmFallback,
  createMediaMetadataState,
  decodeAudioData,
  decodeBrowserModuleScriptUri,
  decodeBrowserModuleWasmUri,
  decodeWorkerScriptUri,
  destroySession,
  embeddedMediaToolsGuidance,
  initializeDecodedPlayback,
  initializePlaybackFromPreparedData,
  initializeWaveformSurface,
  normalizeExternalToolStatus,
  resetSpectrogramCanvasElement,
  renderMediaMetadata,
  renderSpectrogramScale,
  renderWaveformUi,
  setAnalysisStatus,
  setFatalStatus,
  setLoudnessSummaryUnavailable,
  setPendingLoudnessSummary,
  clearFatalStatus,
  startPlaybackLoop,
  state,
  stretchProcessorScriptUri,
  syncTransport,
  vscode,
}: AudioscopeLoadControllerDeps) {
  function shouldPreferEmbeddedDecode(payload) {
    const fileExtension = typeof payload?.fileExtension === 'string'
      ? payload.fileExtension.trim().toLowerCase()
      : '';

    if (!fileExtension) {
      return false;
    }

    if (!decodeWorkerScriptUri || !decodeBrowserModuleScriptUri || !decodeBrowserModuleWasmUri) {
      return false;
    }

    return (
      fileExtension === 'aac'
      || fileExtension === 'flac'
      || fileExtension === 'm4a'
      || fileExtension === 'mp3'
      || fileExtension === 'oga'
      || fileExtension === 'ogg'
      || fileExtension === 'opus'
    );
  }

  function requestMediaMetadata(loadToken, payload) {
    if (loadToken !== state.loadToken) {
      return;
    }

    if (!payload?.fileBacked) {
      state.mediaMetadata = {
        ...createMediaMetadataState('error'),
        loadToken,
        message: 'Metadata is only available for local filesystem files.',
      };
      renderMediaMetadata();
      return;
    }

    vscode.postMessage({
      type: 'requestMediaMetadata',
      body: { loadToken },
    });
  }

  function requestLoudnessSummary(loadToken, payload) {
    if (loadToken !== state.loadToken) {
      return;
    }

    if (!payload?.fileBacked) {
      setLoudnessSummaryUnavailable('Loudness is only available for local filesystem files.');
      return;
    }

    if (!state.externalTools.ffmpegAvailable) {
      setLoudnessSummaryUnavailable(state.externalTools.guidance || 'ffmpeg loudness analysis is unavailable.');
      return;
    }

    vscode.postMessage({
      type: 'requestLoudnessSummary',
      body: { loadToken },
    });
  }

  function setAnalysisSourceKind(sourceKind) {
    state.analysisSourceKind = sourceKind;
    renderMediaMetadata();
  }

  function clearDecodeFallbackCache() {
    state.decodeFallbackError = null;
    state.decodeFallbackLoadToken = 0;
    state.decodeFallbackPromise = null;
    state.decodeFallbackRequest = null;
    state.decodeFallbackResult = null;
    state.resolveDecodeFallback = null;
    state.rejectDecodeFallback = null;
  }

  function rejectDecodeFallbackRequest(loadToken, message) {
    state.decodeFallbackRequest = null;
    state.decodeFallbackResult = null;
    state.decodeFallbackError = {
      loadToken,
      message,
    };
    state.rejectDecodeFallback?.(new Error(message));
    state.decodeFallbackPromise = null;
    state.resolveDecodeFallback = null;
    state.rejectDecodeFallback = null;
  }

  function getActiveDecodeFallbackRequest(loadToken) {
    if (
      state.decodeFallbackLoadToken !== loadToken
      || !state.decodeFallbackPromise
      || !state.decodeFallbackRequest
      || state.decodeFallbackRequest.loadToken !== loadToken
    ) {
      return null;
    }

    return state.decodeFallbackRequest;
  }

  function requestHostDecodeFallbackForActiveRequest(loadToken) {
    const activeRequest = getActiveDecodeFallbackRequest(loadToken);

    if (!activeRequest) {
      return false;
    }

    if (activeRequest.hostRequested) {
      return true;
    }

    activeRequest.hostRequested = true;
    postHostDecodeFallbackRequest(loadToken, activeRequest.payload, activeRequest.reason);
    return true;
  }

  function handleDecodeWorkerFailure(loadToken, message, { disposeWorker = false } = {}) {
    if (disposeWorker) {
      disposeDecodeWorker();
    }

    if (requestHostDecodeFallbackForActiveRequest(loadToken)) {
      return;
    }

    if (getActiveDecodeFallbackRequest(loadToken)) {
      rejectDecodeFallbackRequest(loadToken, message);
      renderMediaMetadata();
    }
  }

  function acceptDecodeFallbackResult(loadToken, body, source = 'host') {
    state.decodeFallbackError = null;

    if (body?.kind === 'pcm') {
      const channelBuffers = Array.isArray(body?.channelBuffers)
        ? body.channelBuffers.filter((buffer) => buffer instanceof ArrayBuffer)
        : [];
      const numberOfChannels = Math.max(1, Math.trunc(Number(body?.numberOfChannels) || channelBuffers.length || 0));
      const sampleRate = Math.max(1, Math.trunc(Number(body?.sampleRate) || 0));
      const frameCount = Math.max(0, Math.trunc(Number(body?.frameCount) || 0));

      if (channelBuffers.length === 0 || sampleRate <= 0 || frameCount <= 0) {
        if (source === 'worker' && requestHostDecodeFallbackForActiveRequest(loadToken)) {
          return;
        }

        rejectDecodeFallbackRequest(loadToken, 'ffmpeg decode did not return decoded PCM channel buffers.');
        return;
      }

      state.decodeFallbackResult = {
        byteLength: Number(body?.byteLength) || channelBuffers.reduce((total, buffer) => total + buffer.byteLength, 0),
        channelBuffers,
        frameCount,
        kind: 'pcm',
        numberOfChannels,
        sampleRate,
        source: body?.source === 'ffmpeg' ? 'ffmpeg' : 'ffmpeg',
      };
    } else {
      const audioBuffer = body?.audioBuffer;

      if (!(audioBuffer instanceof ArrayBuffer)) {
        if (source === 'worker' && requestHostDecodeFallbackForActiveRequest(loadToken)) {
          return;
        }

        rejectDecodeFallbackRequest(loadToken, 'ffmpeg decode did not return audio bytes.');
        return;
      }

      state.decodeFallbackResult = {
        audioBuffer,
        byteLength: Number(body?.byteLength) || audioBuffer.byteLength,
        kind: 'wav',
        mimeType: typeof body?.mimeType === 'string' && body.mimeType.length > 0
          ? body.mimeType
          : 'audio/wav',
        source: body?.source === 'ffmpeg' ? 'ffmpeg' : 'ffmpeg',
      };
    }

    state.resolveDecodeFallback?.(state.decodeFallbackResult);
    state.decodeFallbackPromise = null;
    state.resolveDecodeFallback = null;
    state.rejectDecodeFallback = null;
    renderMediaMetadata();
  }

  function postHostDecodeFallbackRequest(loadToken, payload, reason) {
    vscode.postMessage({
      type: 'requestDecodeFallback',
      body: {
        loadToken,
        reason,
        sourceUri: payload?.documentUri ?? payload?.sourceUri ?? '',
      },
    });
  }

  async function createDecodeWorker() {
    if (state.decodeWorker) {
      return state.decodeWorker;
    }

    if (!decodeWorkerScriptUri || !decodeBrowserModuleScriptUri || !decodeBrowserModuleWasmUri) {
      return null;
    }

    const worker = createModuleWorker(decodeWorkerScriptUri, 'decodeWorkerBootstrapUrl');
    state.decodeWorker = worker;
    state.decodeWorkerReady = false;
    state.decodeWorkerPrewarmed = false;

    worker.addEventListener('message', (event) => {
      handleDecodeWorkerMessage(event.data);
    });
    worker.addEventListener('error', (event) => {
      if (state.loadToken > 0) {
        handleDecodeWorkerFailure(
          state.loadToken,
          event.message || 'Embedded decode worker failed.',
          { disposeWorker: true },
        );
      } else {
        disposeDecodeWorker();
      }
    });
    worker.postMessage({
      type: 'bootstrapRuntime',
      body: {
        moduleUrl: decodeBrowserModuleScriptUri,
        wasmUrl: decodeBrowserModuleWasmUri,
      },
    });

    return worker;
  }

  function prewarmDecodeWorker(loadToken) {
    if (state.decodeWorkerPrewarmed) {
      return;
    }

    void createDecodeWorker().then((worker) => {
      if (!worker || loadToken !== state.loadToken || state.decodeWorkerPrewarmed) {
        return;
      }

      worker.postMessage({
        type: 'prewarmDecodeModule',
        body: { loadToken },
      });
    }).catch(() => {});
  }

  function handleDecodeWorkerMessage(message) {
    const loadToken = Number(message?.body?.loadToken) || state.loadToken;

    if (message?.type === 'runtimeReady') {
      state.decodeWorkerReady = true;
      return;
    }

    if (message?.type === 'prewarmReady') {
      state.decodeWorkerPrewarmed = true;
      return;
    }

    if (loadToken !== state.loadToken) {
      return;
    }

    if (message?.type === 'decodeReady') {
      acceptDecodeFallbackResult(loadToken, message.body, 'worker');
      return;
    }

    if (message?.type === 'decodeError') {
      handleDecodeWorkerFailure(loadToken, message.body?.message || 'Embedded decode worker failed.');
      return;
    }

    if (message?.type === 'error') {
      handleDecodeWorkerFailure(
        loadToken,
        message.body?.message || 'Embedded decode worker failed.',
        { disposeWorker: true },
      );
    }
  }

  function disposeDecodeWorker() {
    if (state.decodeWorker) {
      state.decodeWorker.terminate();
      state.decodeWorker = null;
    }

    state.decodeWorkerReady = false;
    state.decodeWorkerPrewarmed = false;

    if (state.decodeWorkerBootstrapUrl) {
      URL.revokeObjectURL(state.decodeWorkerBootstrapUrl);
      state.decodeWorkerBootstrapUrl = null;
    }
  }

  function requestDecodeFallback(loadToken, payload, reason, sourceBytes = null) {
    if (loadToken !== state.loadToken) {
      return Promise.reject(new Error('Decode request is stale.'));
    }

    if (state.decodeFallbackResult && state.decodeFallbackLoadToken === loadToken) {
      return Promise.resolve(state.decodeFallbackResult);
    }

    if (state.decodeFallbackPromise && state.decodeFallbackLoadToken === loadToken) {
      return state.decodeFallbackPromise;
    }

    if (state.decodeFallbackError?.loadToken === loadToken) {
      return Promise.reject(new Error(state.decodeFallbackError.message));
    }

    if (state.externalTools.resolved && !state.externalTools.canDecodeFallback) {
      return Promise.reject(new Error(state.externalTools.guidance || embeddedMediaToolsGuidance));
    }

    state.decodeFallbackLoadToken = loadToken;
    state.decodeFallbackError = null;
    state.decodeFallbackRequest = {
      hostRequested: false,
      loadToken,
      payload,
      reason,
    };
    state.decodeFallbackPromise = new Promise((resolve, reject) => {
      state.resolveDecodeFallback = resolve;
      state.rejectDecodeFallback = reject;
    });
    renderMediaMetadata();

    void createDecodeWorker()
      .then((worker) => {
        if (loadToken !== state.loadToken) {
          return;
        }

        if (worker && sourceBytes instanceof ArrayBuffer) {
          worker.postMessage({
            type: 'decodeAudioData',
            body: {
              audioBytes: sourceBytes,
              fileExtension: typeof payload?.fileExtension === 'string' && payload.fileExtension.length > 0
                ? payload.fileExtension
                : 'bin',
              loadToken,
            },
          }, [sourceBytes]);
          return;
        }

        requestHostDecodeFallbackForActiveRequest(loadToken);
      })
      .catch(() => {
        if (loadToken !== state.loadToken) {
          return;
        }

        requestHostDecodeFallbackForActiveRequest(loadToken);
      });

    return state.decodeFallbackPromise;
  }

  function guessAudioMimeType(resourcePath) {
    const extension = resourcePath.split('.').pop()?.toLowerCase();

    switch (extension) {
      case 'wav':
      case 'wave':
        return 'audio/wav';
      case 'mp3':
        return 'audio/mpeg';
      case 'ogg':
      case 'oga':
        return 'audio/ogg';
      case 'flac':
        return 'audio/flac';
      case 'm4a':
        return 'audio/mp4';
      case 'aac':
        return 'audio/aac';
      case 'opus':
        return 'audio/ogg';
      case 'aif':
      case 'aiff':
        return 'audio/aiff';
      default:
        return 'application/octet-stream';
    }
  }

  function resolvePlayableAudioMimeType(payload, responseContentType) {
    const normalizedContentType = responseContentType?.split(';', 1)[0]?.trim().toLowerCase() || '';

    if (
      normalizedContentType
      && normalizedContentType !== 'application/octet-stream'
      && normalizedContentType !== 'binary/octet-stream'
    ) {
      return normalizedContentType;
    }

    if (typeof payload?.fileExtension === 'string' && payload.fileExtension.length > 0) {
      return guessAudioMimeType(`file.${payload.fileExtension}`);
    }

    return guessAudioMimeType(payload?.sourceUri || payload?.documentUri || '');
  }

  function createPlaybackTransport(loadToken) {
    let transport = null;

    transport = createAudioTransport({
      onStateChange: () => {
        if (loadToken !== state.loadToken || state.audioTransport !== transport) {
          return;
        }

        const nextPlaybackTransportKind = transport.getTransportKind?.() ?? state.playbackTransportKind;
        const nextPlaybackTransportError = transport.getLastFallbackReason?.() ?? null;
        const transportKindChanged = nextPlaybackTransportKind !== state.playbackTransportKind;
        const transportErrorChanged =
          nextPlaybackTransportError !== state.playbackTransportError;
        state.playbackTransportKind = nextPlaybackTransportKind;
        state.playbackTransportError = nextPlaybackTransportError;

        if (transportKindChanged || transportErrorChanged) {
          renderMediaMetadata();
        }

        if (transport.isPlaying?.()) {
          if (!state.playbackFrame) {
            startPlaybackLoop();
          }
          return;
        }

        syncTransport();
      },
      stretchModuleUrl: stretchProcessorScriptUri,
      workletModuleUrl: audioTransportProcessorScriptUri,
    });

    state.playbackTransportKind = transport.getTransportKind?.() ?? 'unavailable';
    state.playbackTransportError = transport.getLastFallbackReason?.() ?? null;
    transport.setPlaybackRate(state.playbackRate);
    return transport;
  }

  function getHostSuppliedAudioBytes(payload) {
    return payload?.audioBytes instanceof ArrayBuffer
      ? payload.audioBytes
      : null;
  }

  async function initializeFromDecodeFallback(loadToken, payload, fallback) {
    if (loadToken !== state.loadToken) {
      return;
    }

    setAnalysisSourceKind('ffmpeg-fallback');
    state.playbackSourceKind = 'ffmpeg-fallback';
    renderMediaMetadata();

    if (fallback.kind === 'pcm') {
      const playbackSession = createPlaybackSessionFromPcmFallback(fallback);
      await initializePlaybackFromPreparedData(
        loadToken,
        payload,
        createPlaybackAnalysisDataFromPlaybackSession(playbackSession),
      );
      return;
    }

    setAnalysisStatus('Decoding audio…');
    const decodedAudio = await decodeAudioData(fallback.audioBuffer);

    if (loadToken !== state.loadToken) {
      return;
    }

    await initializeDecodedPlayback(loadToken, payload, decodedAudio);
  }

  function startDeferredAuxiliaryLoads(loadToken, payload = state.activeFile) {
    if (loadToken !== state.loadToken || state.deferredAuxiliaryLoadsLoadToken === loadToken) {
      return;
    }

    state.deferredAuxiliaryLoadsLoadToken = loadToken;
    requestMediaMetadata(loadToken, payload);
    requestLoudnessSummary(loadToken, payload);
  }

  async function loadDecodedAudioSource(loadToken, payload) {
    const controller = new AbortController();
    state.sourceFetchController = controller;

    try {
      setAnalysisStatus('Loading audio…');
      let audioData = getHostSuppliedAudioBytes(payload);
      let responseContentType = null;

      if (!(audioData instanceof ArrayBuffer)) {
        const response = await fetch(payload.sourceUri, { signal: controller.signal });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        responseContentType = response.headers.get('content-type');
        audioData = await response.arrayBuffer();
      }

      resolvePlayableAudioMimeType(payload, responseContentType);
      let sourceKind = 'native';

      if (loadToken !== state.loadToken) {
        return;
      }

      setAnalysisSourceKind(sourceKind);
      state.playbackSourceKind = sourceKind;
      renderMediaMetadata();

      if (shouldPreferEmbeddedDecode(payload)) {
        try {
          setAnalysisStatus('Decoding audio with embedded ffmpeg…');
          const fallback = await requestDecodeFallback(
            loadToken,
            payload,
            'preferred-embedded-decode',
            audioData.slice(0),
          );

          if (loadToken !== state.loadToken) {
            return;
          }

          await initializeFromDecodeFallback(loadToken, payload, fallback);
          if (loadToken !== state.loadToken || controller.signal.aborted) {
            return;
          }

          clearDecodeFallbackCache();
          return;
        } catch {
          if (loadToken !== state.loadToken) {
            return;
          }
        }
      }

      setAnalysisStatus('Decoding audio…');

      let decodedAudio;
      const browserDecodeFallbackBytes = state.externalTools.canDecodeFallback
        ? audioData.slice(0)
        : audioData;

      try {
        decodedAudio = await decodeAudioData(audioData);
      } catch {
        if (loadToken !== state.loadToken) {
          return;
        }

        setAnalysisStatus('Requesting ffmpeg decode…');
        const fallback = await requestDecodeFallback(
          loadToken,
          payload,
          'analysis-decode-error',
          browserDecodeFallbackBytes,
        );

        if (loadToken !== state.loadToken) {
          return;
        }

        sourceKind = 'ffmpeg-fallback';
        setAnalysisSourceKind(sourceKind);
        state.playbackSourceKind = sourceKind;
        renderMediaMetadata();
        await initializeFromDecodeFallback(loadToken, payload, fallback);
        if (loadToken !== state.loadToken) {
          return;
        }
        clearDecodeFallbackCache();
        return;
      }

      if (loadToken !== state.loadToken) {
        return;
      }

      state.playbackSourceKind = sourceKind;
      setAnalysisSourceKind(sourceKind);
      renderMediaMetadata();

      await initializeDecodedPlayback(loadToken, payload, decodedAudio);
      if (loadToken !== state.loadToken || controller.signal.aborted) {
        return;
      }
      clearDecodeFallbackCache();
    } catch (error) {
      if (loadToken !== state.loadToken || controller.signal.aborted) {
        return;
      }

      if (
        state.playbackSourceKind !== 'ffmpeg-fallback'
        && (state.externalTools.canDecodeFallback || !state.externalTools.resolved)
      ) {
        try {
          setAnalysisStatus('Requesting ffmpeg decode…');
          const fallback = await requestDecodeFallback(loadToken, payload, 'fetch-error');

          if (loadToken !== state.loadToken) {
            return;
          }

          state.playbackSourceKind = 'ffmpeg-fallback';
          setAnalysisSourceKind('ffmpeg-fallback');
          state.playbackSourceKind = 'ffmpeg-fallback';
          renderMediaMetadata();

          await initializeFromDecodeFallback(loadToken, payload, fallback);
          if (loadToken !== state.loadToken) {
            return;
          }
          clearDecodeFallbackCache();
          return;
        } catch (fallbackError) {
          if (loadToken !== state.loadToken) {
            return;
          }

          error = fallbackError;
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      setLoudnessSummaryUnavailable(message);
      setFatalStatus(`Unable to load this audio file: ${message}`);
    } finally {
      if (state.sourceFetchController === controller) {
        state.sourceFetchController = null;
      }
    }
  }

  async function loadAudioFile(payload) {
    const loadToken = state.loadToken + 1;
    state.loadToken = loadToken;

    destroySession();
    clearDecodeFallbackCache();
    state.externalTools = normalizeExternalToolStatus(payload?.externalTools, embeddedMediaToolsGuidance);
    state.mediaMetadata = {
      ...createMediaMetadataState('pending'),
      loadToken,
      message: !payload?.fileBacked
        ? 'Metadata is only available for local filesystem files.'
        : (!state.externalTools.resolved || state.externalTools.canReadMetadata)
        ? 'Loading metadata with ffprobe…'
        : state.externalTools.guidance || embeddedMediaToolsGuidance,
    };
    state.playbackSourceKind = 'native';
    state.analysisSourceKind = 'native';
    renderMediaMetadata();
    setPendingLoudnessSummary();
    clearFatalStatus();
    setAnalysisStatus('Preparing playback…');
    state.audioTransport = createPlaybackTransport(loadToken);
    state.playbackSession = null;
    state.deferredAuxiliaryLoadsLoadToken = 0;
    state.waveformViewport.targetRange = { start: 0, end: 0 };
    state.waveformViewport.presentedRange = { start: 0, end: 0 };

    state.waveformSurfaceReadyPromise = initializeWaveformSurface(loadToken);
    resetSpectrogramCanvasElement();
    state.spectrogramSurfaceReadyPromise = null;
    prewarmDecodeWorker(loadToken);
    syncTransport();
    renderWaveformUi();
    renderSpectrogramScale();
    await loadDecodedAudioSource(loadToken, payload);
  }

  return {
    acceptDecodeFallbackResult,
    createPlaybackTransport,
    disposeDecodeWorker,
    handleDecodeWorkerMessage,
    loadAudioFile,
    prewarmDecodeWorker,
    rejectDecodeFallbackRequest,
    requestDecodeFallback,
    startDeferredAuxiliaryLoads,
  };
}
