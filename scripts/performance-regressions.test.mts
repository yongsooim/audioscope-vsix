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
const isCurrentWorkerMessage = messageSessionModule.isCurrentWorkerMessage
  ?? (messageSessionModule.default as typeof messageSessionModule | undefined)?.isCurrentWorkerMessage;
const selectDecodeFallbackTarget = decodeStrategyModule.selectDecodeFallbackTarget
  ?? (decodeStrategyModule.default as typeof decodeStrategyModule | undefined)?.selectDecodeFallbackTarget;

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
    const queuedMessages = [];
    self.postMessage = (message) => parentPort.postMessage(message);
    parentPort.on('message', (data) => {
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
