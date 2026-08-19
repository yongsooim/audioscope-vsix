import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

const messageSessionModule = await import('../src-webview/workerMessageSession.ts');
const decodeStrategyModule = await import('../src-webview/audioscope/controllers/decodeStrategy.ts');
const playbackProgressModule = await import('../src-webview/audioscope/core/playbackProgress.ts');
const columnGridModule = await import('../src-webview/audioscope/core/waveformColumnGrid.ts');
const transportLoopModulePath = '../src-webview/audioscope/controllers/transportLoop.ts';
const transportLoopModule: any = await import(transportLoopModulePath);
const isCurrentWorkerMessage = messageSessionModule.isCurrentWorkerMessage
  ?? (messageSessionModule.default as typeof messageSessionModule | undefined)?.isCurrentWorkerMessage;
const selectDecodeFallbackTarget = decodeStrategyModule.selectDecodeFallbackTarget
  ?? (decodeStrategyModule.default as typeof decodeStrategyModule | undefined)?.selectDecodeFallbackTarget;
const createAudioscopeTransportLoopController = transportLoopModule.createAudioscopeTransportLoopController
  ?? transportLoopModule.default?.createAudioscopeTransportLoopController;
const calculatePlaybackProgress = playbackProgressModule.calculatePlaybackProgress
  ?? (playbackProgressModule.default as typeof playbackProgressModule | undefined)?.calculatePlaybackProgress;
const createWaveformColumnGrid = columnGridModule.createWaveformColumnGrid
  ?? (columnGridModule.default as typeof columnGridModule | undefined)?.createWaveformColumnGrid;

const projectRoot = path.resolve(import.meta.dirname, '..');

function readArrayBuffer(filePath: string): ArrayBuffer {
  const bytes = fs.readFileSync(filePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function waitForWorkerMessage(
  worker: Worker,
  predicate: (message: any) => boolean,
  timeoutMs = 5_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for worker message.'));
    }, timeoutMs);
    const handleMessage = (message: any) => {
      if (!predicate(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off('message', handleMessage);
      worker.off('error', handleError);
    };
    worker.on('message', handleMessage);
    worker.on('error', handleError);
  });
}

function createWebWorkerHarness(bundlePath: string): Worker {
  const bundleUrl = pathToFileURL(bundlePath).href;
  const bootstrap = `
    const { parentPort } = require('node:worker_threads');
    globalThis.self = globalThis;
    globalThis.WorkerGlobalScope = function WorkerGlobalScope() {};
    globalThis.location = { href: ${JSON.stringify(bundleUrl)} };
    // Node has no OffscreenCanvas, and a worker without a surface bails out of
    // renderWaveform before it reports anything. Only the surface *dimensions* matter
    // to the window arithmetic under test, so the 2D context is a no-op recorder-free
    // stub — this harness checks what the worker computes, not what it paints.
    globalThis.OffscreenCanvas = class OffscreenCanvas {
      constructor(width, height) {
        this.width = Math.max(1, Number(width) || 1);
        this.height = Math.max(1, Number(height) || 1);
      }
      getContext() {
        return new Proxy({}, {
          get: (target, key) => (key in target ? target[key] : () => {}),
          set: (target, key, value) => { target[key] = value; return true; },
        });
      }
    };
    const queuedMessages = [];
    self.postMessage = (message) => parentPort.postMessage(message);
    parentPort.on('message', (data) => {
      // An OffscreenCanvas cannot cross a worker_threads boundary, so tests send
      // { width, height } and it is constructed here instead.
      const canvasRequest = data?.body?.offscreenCanvas;
      if (canvasRequest && !(canvasRequest instanceof OffscreenCanvas)) {
        data.body.offscreenCanvas = new OffscreenCanvas(canvasRequest.width, canvasRequest.height);
      }
      if (typeof self.onmessage === 'function') self.onmessage({ data });
      else queuedMessages.push(data);
    });
    import(${JSON.stringify(bundleUrl)}).then(() => {
      for (const data of queuedMessages.splice(0)) self.onmessage({ data });
    }).catch((error) => { throw error; });
  `;
  return new Worker(bootstrap, { eval: true });
}

test('compressed source bytes stay in the webview decode worker', () => {
  const bytes = new ArrayBuffer(8);
  assert.equal(selectDecodeFallbackTarget({ sourceBytes: bytes }), 'webview-worker');
  assert.equal(selectDecodeFallbackTarget({ sourceBytes: null }), 'host-worker');
});

test('analysis worker accepts the current reload and rejects stale sessions', () => {
  assert.equal(isCurrentWorkerMessage(2, 2, 7, 7), true);
  assert.equal(isCurrentWorkerMessage(1, 2, 7, 7), false);
  assert.equal(isCurrentWorkerMessage(2, 2, 7, 6), false);
  assert.equal(isCurrentWorkerMessage(2, 2, 7, undefined), true);
  assert.equal(isCurrentWorkerMessage(2, 2, 7, -1), true);
});

test('playback progress calculation covers scrolling and fixed playheads', () => {
  assert.deepEqual(calculatePlaybackProgress({
    currentFrameFloat: 250,
    durationFrames: 1_000,
    followCursorLocked: false,
    presentedEndFrame: 500,
    presentedStartFrame: 0,
  }), {
    cursorPercent: 50,
    cursorVisible: true,
    overviewCurrentPercent: 25,
    overviewCurrentVisible: true,
  });
  // While following, the view origin is quantized to whole device columns and the
  // playhead carries the sub-column remainder instead of being pinned to the follow
  // ratio — pinning it would push that remainder onto the image and make the
  // waveform slide unevenly. Here the origin sits 2 frames early, so the playhead
  // reads 50.5% rather than a hard 50%.
  assert.deepEqual(calculatePlaybackProgress({
    currentFrameFloat: 750,
    durationFrames: 1_000,
    followCursorLocked: true,
    presentedEndFrame: 948,
    presentedStartFrame: 548,
  }), {
    cursorPercent: 50.5,
    cursorVisible: true,
    overviewCurrentPercent: 75,
    overviewCurrentVisible: true,
  });
});

// The follow viewport has to advance once per presented frame. A fixed 60 Hz tick
// cap used to make the image step on some frames and not others on 90/120/144 Hz
// displays, which reads as judder next to a playhead that moves every frame.
test('playback UI and the follow viewport both advance once per display frame', () => {
  const originalPerformanceNow = performance.now;
  const originalWindow = (globalThis as any).window;
  let now = 0;

  performance.now = () => now;
  (globalThis as any).window = {
    cancelAnimationFrame() {},
    requestAnimationFrame() {
      return 1;
    },
  } as any;

  try {
    for (const displayRate of [60, 90, 120, 144, 165, 240]) {
      let localFrameCount = 0;
      let workerTickCount = 0;
      const createElement = () => ({ disabled: false, textContent: '', value: '' });
      const state = {
        audioTransport: {
          getPlaybackClockState: () => ({
            currentFrameFloat: now * 44.1,
            durationFrames: 441_000,
            loopEndFrame: null,
            loopStartFrame: null,
            playing: true,
            sampleRate: 44_100,
          }),
          isPlaying: () => true,
        },
        engineWorker: {
          postMessage: () => {
            workerTickCount += 1;
          },
        },
        playbackFrame: 0,
        playbackRate: 1,
        playbackSession: null,
        playbackTransportError: null,
        playbackTransportKind: 'audio-worklet-copy',
      };
      const controller = createAudioscopeTransportLoopController({
        elements: {
          playbackRateSelect: createElement(),
          playToggle: createElement(),
          seekBackward: createElement(),
          seekForward: createElement(),
          timeReadout: createElement(),
        },
        frameToSeconds: (frame: number) => frame / 44_100,
        getDurationFrames: () => 441_000,
        getEffectiveDurationSeconds: () => 10,
        getSampleRate: () => 44_100,
        onPlaybackClock: () => {
          localFrameCount += 1;
        },
        renderMediaMetadata() {},
        state,
        syncPlaybackRateControl() {},
      } as any);

      for (let frame = 0; frame < displayRate; frame += 1) {
        now = frame * 1_000 / displayRate;
        controller.syncTransport();
      }

      assert.equal(localFrameCount, displayRate, `${displayRate} Hz local playback frames`);
      assert.equal(
        workerTickCount,
        displayRate,
        `${displayRate} Hz display produced ${workerTickCount} worker ticks`,
      );
    }
  } finally {
    performance.now = originalPerformanceNow;
    (globalThis as any).window = originalWindow;
  }
});

test('follow playback tick emits one full viewport state', { timeout: 2_000 }, async () => {
  const workerPath = path.join(projectRoot, 'dist', 'webview', 'audioEngineWorker.js');
  assert.equal(fs.existsSync(workerPath), true, `Missing build artifact: ${workerPath}`);

  const worker = createWebWorkerHarness(workerPath);
  try {
    worker.postMessage({
      type: 'LoadAnalysisSession',
      body: { durationFrames: 441_000, sampleRate: 44_100, sessionRevision: 1 },
    });
    worker.postMessage({
      type: 'SetViewportIntent',
      body: { kind: 'setViewFrameRange', startFrame: 0, endFrame: 44_100 },
    });
    worker.postMessage({
      type: 'SetViewportIntent',
      body: { enabled: true, kind: 'setFollow' },
    });
    await waitForWorkerMessage(
      worker,
      (message) => message.type === 'ViewportUiState' && message.body?.viewport?.followEnabled === true,
    );

    const matchingMessages: any[] = [];
    const handleMessage = (message: any) => {
      if (message.type === 'ViewportUiState' && message.body?.playback?.currentFrameFloat === 30_870) {
        matchingMessages.push(message);
      }
    };
    worker.on('message', handleMessage);
    worker.postMessage({
      type: 'PlaybackClockTick',
      body: {
        currentFrameFloat: 30_870,
        durationFrames: 441_000,
        loopEndFrame: null,
        loopStartFrame: null,
        playing: true,
        sampleRate: 44_100,
      },
    });
    await waitForWorkerMessage(
      worker,
      (message) => message.type === 'ViewportUiState' && message.body?.playback?.currentFrameFloat === 30_870,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    worker.off('message', handleMessage);

    assert.equal(matchingMessages.length, 1);
  } finally {
    await worker.terminate();
  }
});

test('codec loudness runs without blocking the host event loop', { timeout: 5_000 }, async () => {
  const workerPath = path.join(projectRoot, 'out', 'embeddedDecodeWorkerThread.js');
  const modulePath = path.join(projectRoot, 'dist', 'embedded-tools', 'ffdecode_module.js');
  const wasmPath = path.join(projectRoot, 'dist', 'embedded-tools', 'ffdecode_module.wasm');
  const samplePath = path.join(projectRoot, 'exampleFiles', 'sample-full.m4a');
  for (const requiredPath of [workerPath, modulePath, wasmPath, samplePath]) {
    assert.equal(fs.existsSync(requiredPath), true, `Missing build artifact: ${requiredPath}`);
  }

  const worker = new Worker(workerPath);
  try {
    worker.postMessage({ type: 'prewarm', requestId: 1, body: { modulePath, wasmPath } });
    await waitForWorkerMessage(worker, (message) => message.type === 'runtimeReady' && message.requestId === 1);

    let maxEventLoopGapMs = 0;
    let lastHeartbeat = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastHeartbeat);
      lastHeartbeat = now;
    }, 5);
    const startedAt = performance.now();
    let decodeReadyAt = 0;
    const completion = waitForWorkerMessage(worker, (message) => {
      if (message.type === 'decodeReady' && message.requestId === 2) {
        decodeReadyAt = performance.now();
        assert.ok(Number(message.body?.byteLength) > 0);
      }
      return message.type === 'loudnessReady' && message.requestId === 2;
    });
    worker.postMessage({
      type: 'decode',
      requestId: 2,
      body: { fileExtension: 'm4a', hostPath: samplePath, modulePath, wasmPath },
    });
    const loudness = await completion;
    clearInterval(heartbeat);
    const totalMs = performance.now() - startedAt;

    assert.ok(decodeReadyAt > startedAt, 'decode result must arrive before loudness');
    assert.ok(Number.isFinite(loudness.body?.integratedLufs));
    assert.ok(maxEventLoopGapMs < Math.max(100, totalMs * 0.5), `event loop gap ${maxEventLoopGapMs}ms`);
  } finally {
    await worker.terminate();
  }
});

test('codec pool decodes two documents concurrently', { timeout: 5_000 }, async () => {
  const require = createRequire(import.meta.url);
  const nodeModule = require('node:module') as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = nodeModule._load;
  nodeModule._load = function loadWithVscodeMock(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        workspace: {
          fs: {
            readFile: async (resource: { fsPath: string }) => fs.promises.readFile(resource.fsPath),
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let mediaTools: {
    runEmbeddedFfmpegDecodeLoudnessPipeline(resource: { fsPath: string; path: string }): Promise<any>;
  };
  try {
    mediaTools = require(path.join(projectRoot, 'out', 'embeddedMediaTools.js'));
  } finally {
    nodeModule._load = originalLoad;
  }

  let maxEventLoopGapMs = 0;
  let lastHeartbeat = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastHeartbeat);
    lastHeartbeat = now;
  }, 5);
  const startedAt = performance.now();
  try {
    const files = ['sample-full.m4a', 'Go, With or Without Me.mp3'];
    const results = await Promise.all(files.map(async (fileName) => {
      const filePath = path.join(projectRoot, 'exampleFiles', fileName);
      const pipeline = await mediaTools.runEmbeddedFfmpegDecodeLoudnessPipeline({ fsPath: filePath, path: filePath });
      const decodeReadyMs = performance.now() - startedAt;
      const loudness = await pipeline.loudnessPromise;
      return {
        decodeReadyMs,
        integratedLufs: loudness.integratedLufs,
        totalMs: performance.now() - startedAt,
      };
    }));
    assert.ok(Math.max(...results.map((result) => result.decodeReadyMs)) < Math.min(...results.map((result) => result.totalMs)));
    assert.ok(results.every((result) => Number.isFinite(result.integratedLufs)));
    const totalMs = Math.max(...results.map((result) => result.totalMs));
    assert.ok(maxEventLoopGapMs < Math.max(100, totalMs * 0.5), `event loop gap ${maxEventLoopGapMs}ms`);
  } finally {
    clearInterval(heartbeat);
  }
});

test('latest waveform session completes its pyramid after a rapid reload', { timeout: 5_000 }, async () => {
  const workerPath = path.join(projectRoot, 'dist', 'webview', 'interactiveWaveformWorker.js');
  const simdPath = path.join(projectRoot, 'dist', 'wasm', 'wasm_core_simd.wasm');
  const fallbackPath = path.join(projectRoot, 'dist', 'wasm', 'wasm_core_fallback.wasm');
  for (const requiredPath of [workerPath, simdPath, fallbackPath]) {
    assert.equal(fs.existsSync(requiredPath), true, `Missing build artifact: ${requiredPath}`);
  }

  const worker = createWebWorkerHarness(workerPath);
  try {
    worker.postMessage({
      type: 'bootstrapRuntime',
      body: {
        wasmBytes: {
          fallback: readArrayBuffer(fallbackPath),
          simd: readArrayBuffer(simdPath),
        },
      },
    });
    await waitForWorkerMessage(worker, (message) => message.type === 'runtimeReady');

    let initializedCount = 0;
    const latestPyramidReady = waitForWorkerMessage(worker, (message) => {
      if (message.type === 'analysisInitialized') {
        initializedCount += 1;
      }
      return initializedCount >= 2 && message.type === 'waveformPyramidReady';
    });
    const sampleCount = 1_000_000;
    for (const sessionVersion of [1, 2]) {
      worker.postMessage({
        type: 'attachAudioSession',
        body: {
          duration: sampleCount / 44_100,
          sampleCount,
          sampleRate: 44_100,
          samplesBuffer: new Float32Array(sampleCount).buffer,
          sessionVersion,
        },
      });
      worker.postMessage({ type: 'buildWaveformPyramid' });
    }
    await latestPyramidReady;
    assert.equal(initializedCount, 2);
  } finally {
    await worker.terminate();
  }
});

// The waveform canvas is the viewport plus a fixed strip of off-screen slack columns,
// and the whole column-grid design rests on the visible columns staying 1:1 with the
// viewport. That breaks the moment anything clips the render window at the end of the
// file: the column count does not shrink with the window, so samples-per-column does,
// and the picture silently stretches. It shipped that way once (full zoom-out drew the
// file ~8% wide with its tail pushed off screen), so it gets a test.
//
// The signal is a 0->1 ramp, which makes the reported peak a direct read-out of where
// the visible window actually ends.
test('waveform render window stays 1:1 with the viewport at the end of the file', { timeout: 10_000 }, async () => {
  const workerPath = path.join(projectRoot, 'dist', 'webview', 'interactiveWaveformWorker.js');
  const simdPath = path.join(projectRoot, 'dist', 'wasm', 'wasm_core_simd.wasm');
  const fallbackPath = path.join(projectRoot, 'dist', 'wasm', 'wasm_core_fallback.wasm');
  for (const requiredPath of [workerPath, simdPath, fallbackPath]) {
    assert.equal(fs.existsSync(requiredPath), true, `Missing build artifact: ${requiredPath}`);
  }

  const SAMPLE_RATE = 44_100;
  const SAMPLE_COUNT = 441_000;
  const VISIBLE_COLUMNS = 1_600;
  const RENDER_SCALE = 2;
  const ramp = new Float32Array(SAMPLE_COUNT);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    ramp[index] = index / SAMPLE_COUNT;
  }

  const worker = createWebWorkerHarness(workerPath);
  try {
    worker.postMessage({
      type: 'bootstrapRuntime',
      body: {
        wasmBytes: {
          fallback: readArrayBuffer(fallbackPath),
          simd: readArrayBuffer(simdPath),
        },
      },
    });
    await waitForWorkerMessage(worker, (message) => message.type === 'runtimeReady');

    worker.postMessage({
      type: 'attachAudioSession',
      body: {
        duration: SAMPLE_COUNT / SAMPLE_RATE,
        sampleCount: SAMPLE_COUNT,
        sampleRate: SAMPLE_RATE,
        samplesBuffer: ramp.buffer,
        sessionVersion: 1,
      },
    }, [ramp.buffer]);
    worker.postMessage({ type: 'buildWaveformPyramid' });
    await waitForWorkerMessage(worker, (message) => message.type === 'waveformPyramidReady');

    const grids = [
      { label: 'full zoom-out', presentedStartFrame: 0, presentedEndFrame: SAMPLE_COUNT },
      { label: 'first half (slack runs into louder audio)', presentedStartFrame: 0, presentedEndFrame: SAMPLE_COUNT / 2 },
      { label: 'last half (window runs past EOF)', presentedStartFrame: SAMPLE_COUNT / 2, presentedEndFrame: SAMPLE_COUNT },
    ];

    worker.postMessage({
      type: 'initCanvas',
      body: {
        color: '#8ccadd',
        height: 200,
        offscreenCanvas: { width: 1, height: 1 },
        renderScale: RENDER_SCALE,
        width: 1,
      },
    });

    let generation = 0;
    for (const { label, presentedStartFrame, presentedEndFrame } of grids) {
      // Exactly what requestWaveformRender builds on the main thread.
      const grid = createWaveformColumnGrid(VISIBLE_COLUMNS, presentedEndFrame - presentedStartFrame);
      const request = {
        amplitudeMax: 1,
        generation: (generation += 1),
        height: 200,
        renderScale: RENDER_SCALE,
        viewEnd: (presentedStartFrame + grid.spanSamples) / SAMPLE_RATE,
        viewStart: presentedStartFrame / SAMPLE_RATE,
        visibleSpan: (presentedEndFrame - presentedStartFrame) / SAMPLE_RATE,
        width: grid.columnCount / RENDER_SCALE,
      };
      worker.postMessage({ type: 'renderWaveformView', body: request });
      const { body: presented } = await waitForWorkerMessage(
        worker,
        (message) => message.type === 'waveformPresented' && message.body?.generation === request.generation,
      );

      assert.equal(presented.viewEnd, request.viewEnd, `${label}: render window was clipped`);
      assert.equal(presented.columnCount, grid.columnCount, `${label}: column count`);

      // The invariant clipping breaks: the visible columns must cover the viewport's
      // samples at the same density as the full window covers its own.
      const renderSamplesPerColumn = ((presented.viewEnd - presented.viewStart) * SAMPLE_RATE) / presented.columnCount;
      const visibleSamplesPerColumn = (presented.visibleSpan * SAMPLE_RATE) / VISIBLE_COLUMNS;
      assert.ok(
        Math.abs(renderSamplesPerColumn - visibleSamplesPerColumn) < 0.001,
        `${label}: ${renderSamplesPerColumn} samples/column vs the viewport's ${visibleSamplesPerColumn}`,
      );

      // Peak is scoped to the on-screen columns, so on a 0->1 ramp it reads back the
      // right edge of the visible window. Catches both a peak that leaks into the
      // slack and an origin dragged backwards by a clamp against the padded span.
      const expectedPeak = presentedEndFrame / SAMPLE_COUNT;
      assert.ok(
        Math.abs(presented.peak - expectedPeak) < 0.005,
        `${label}: visible window ends at ${presented.peak} of the file, expected ${expectedPeak}`,
      );
    }
  } finally {
    await worker.terminate();
  }
});

test('self-contained webview decoder handles compressed audio and retained-PCM loudness', { timeout: 5_000 }, async () => {
  const workerPath = path.join(projectRoot, 'dist', 'webview', 'embeddedDecodeWorker.js');
  const wasmPath = path.join(projectRoot, 'dist', 'embedded-tools', 'ffdecode_module.wasm');
  const samplePath = path.join(projectRoot, 'exampleFiles', 'sample-full.m4a');
  const worker = createWebWorkerHarness(workerPath);
  try {
    const wasmBytes = readArrayBuffer(wasmPath);
    worker.postMessage({ type: 'bootstrapRuntime', body: { wasmBytes } }, [wasmBytes]);
    await waitForWorkerMessage(worker, (message) => message.type === 'runtimeReady');
    worker.postMessage({ type: 'prewarmDecodeModule', body: { loadToken: 3 } });
    await waitForWorkerMessage(worker, (message) => message.type === 'prewarmReady');

    let decodeReady = false;
    const completed = waitForWorkerMessage(worker, (message) => {
      if (message.type === 'decodeReady') {
        decodeReady = true;
        assert.ok(Number(message.body?.byteLength) > 0);
      }
      return message.type === 'loudnessReady';
    });
    const audioBytes = readArrayBuffer(samplePath);
    worker.postMessage({
      type: 'decodeAudioData',
      body: { audioBytes, fileExtension: 'm4a', loadToken: 3 },
    }, [audioBytes]);
    const loudness = await completed;
    assert.equal(decodeReady, true);
    assert.ok(Number.isFinite(loudness.body?.integratedLufs));
  } finally {
    await worker.terminate();
  }
});

test('persistent downmix worker returns retained, waveform, and analysis buffers', async () => {
  const workerPath = path.join(projectRoot, 'dist', 'webview', 'pcmDownmixWorker.js');
  const worker = createWebWorkerHarness(workerPath);
  try {
    for (const requestId of [11, 12]) {
      const left = Float32Array.from([1, -1, 0.5]);
      const right = Float32Array.from([-1, 1, 0.5]);
      const completed = waitForWorkerMessage(
        worker,
        (message) => message.type === 'downmixReady' && message.body?.requestId === requestId,
      );
      worker.postMessage({
        type: 'downmixPcm',
        body: {
          channelBuffers: [left.buffer, right.buffer],
          channelCount: 2,
          maxTotalSamples: 100,
          requestId,
          sampleCount: 3,
        },
      }, [left.buffer, right.buffer]);
      const result = await completed;
      assert.deepEqual([...new Float32Array(result.body.monoBuffer)], [0, 0, 0.5]);
      assert.deepEqual([...new Float32Array(result.body.analysisBuffer)], [0, 0, 0.5]);
      assert.deepEqual([...new Float32Array(result.body.waveformBuffer)], [0, 0, 0.5]);
    }
  } finally {
    await worker.terminate();
  }
});

test('startup bundle keeps optional stretch and decoder glue out of hot-path imports', () => {
  const webviewDirectory = path.join(projectRoot, 'dist', 'webview');
  const mainBundlePath = path.join(webviewDirectory, 'audioscope.js');
  const decoderWorkerPath = path.join(webviewDirectory, 'embeddedDecodeWorker.js');
  const stretchChunks = fs.readdirSync(webviewDirectory).filter((name) => /^SignalsmithStretch-.+\.js$/u.test(name));
  assert.equal(stretchChunks.length, 1);
  assert.ok(fs.statSync(mainBundlePath).size < 200_000, 'startup bundle exceeded 200 KB');
  assert.equal(fs.readFileSync(decoderWorkerPath, 'utf8').includes('import('), false);
});
