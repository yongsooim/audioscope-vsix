/// <reference lib="dom" />
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { _electron as electron, type Frame, type Page } from 'playwright';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { mediaTools, resourceFor, withBackend } from './media-tools-harness.mts';

const root = path.resolve(import.meta.dirname, '..');
const vsix = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Usage: bun run test:vsix <package.vsix>');
await fs.access(vsix);
const directory = path.join(root, '.artifacts', 'vsix-test', path.basename(vsix, '.vsix'));
await fs.mkdir(directory, { recursive: true });
const executable = process.env.AUDIOSCOPE_VSCODE_EXECUTABLE || await downloadAndUnzipVSCode({ version: '1.138.0' });
const fixture = path.join(directory, 'workspace');
await fs.mkdir(fixture, { recursive: true });
await fs.copyFile(path.join(root, 'exampleFiles', 'sample-tone.wav'), path.join(fixture, 'sample-tone.wav'));
// VS Code's Unix-domain socket needs a short path (macOS limits it to 103 bytes).
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'as-vsix-'));
const userData = path.join(profile, 'user');
const extensions = path.join(profile, 'ext');
await fs.mkdir(path.join(userData, 'User'), { recursive: true });
await fs.mkdir(extensions, { recursive: true });
const isolatedEnv: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(
  (entry): entry is [string, string] => typeof entry[1] === 'string'
    && !entry[0].startsWith('VSCODE_') && entry[0] !== 'ELECTRON_RUN_AS_NODE',
));

async function install(): Promise<void> {
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, [...cliArgs, '--user-data-dir', userData, '--extensions-dir', extensions,
      '--install-extension', vsix, '--force'], {
      env: { ...isolatedEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit', shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('VSIX installation failed: ' + code)));
  });
}

async function audioFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator('#play-toggle').count()) return frame;
      } catch {}
    }
    await page.waitForTimeout(100);
  }
  throw new Error('The installed audio editor did not create a webview.');
}

await install();
const installed = (await fs.readdir(extensions)).find((entry) => entry.startsWith('yongsooim.audioscope-'));
assert.ok(installed, 'The VSIX must be installed into the isolated extension directory.');
const nativeDirectory = path.join(extensions, installed, 'dist', 'native-tools');
const hasNative = await fs.stat(nativeDirectory).then(() => true, () => false);
const results: any[] = [];
const modes = hasNative ? ['hybrid', 'native-experimental', 'wasm-fallback'] : ['wasm-only'];
for (const mode of modes) {
  console.log('Installed VSIX smoke test: ' + mode);
  const output = path.join(directory, mode);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false,
    'extensions.ignoreRecommendations': true, 'telemetry.telemetryLevel': 'off',
    'git.enabled': false,
    'update.mode': 'none', 'workbench.enableExperiments': false,
    'audioscope.openSampleOnStartupInDevelopment': false,
    'audioscope.nativeDecoding': mode === 'native-experimental',
    'audioscope.playbackVolume': 0.25,
    'workbench.editorAssociations': { '*.wav': 'audioscope.editor' },
  }, null, 2));
  if (mode === 'wasm-fallback') await fs.rename(nativeDirectory, nativeDirectory + '.disabled');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const startedAt = performance.now();
    app = await electron.launch({
      executablePath: executable,
      args: ['--new-window', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--no-sandbox', '--disable-gpu-sandbox',
        '--user-data-dir=' + userData, '--extensions-dir=' + extensions, fixture, path.join(fixture, 'sample-tone.wav')],
      env: isolatedEnv, timeout: 60_000,
    });
    app.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
    // Mute this isolated VS Code instance after audio mixing. The audio graph
    // still runs and its signal is checked below without playing test tones.
    const page = await app.firstWindow();
    await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
    await app.evaluate(({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) contents.setAudioMuted(true);
      return true;
    });
    const frame = await audioFrame(page);
    await frame.locator('#play-toggle').waitFor({ state: 'visible' });
    await frame.waitForFunction(() => !(document.querySelector('#play-toggle') as HTMLButtonElement)?.disabled, undefined, { timeout: 60_000 });
    const launchToReadyMs = performance.now() - startedAt;
    await frame.waitForFunction(() => document.querySelector('#media-metadata-panel')?.getAttribute('data-state') === 'ready', undefined, { timeout: 30_000 });
    assert.equal(await frame.locator('#status').isVisible(), false);
    await frame.waitForFunction(() => (document.querySelector('#waveform-loading') as HTMLElement)?.hidden === true, undefined, { timeout: 30_000 });

    // Attach an analyser when playback creates a gain node. This observes the
    // real AudioWorklet signal; no production test hooks are needed.
    await frame.evaluate(() => {
      const Original = window.AudioContext;
      const contexts: AnalyserNode[] = [];
      (window as any).__audioscopeTestAnalysers = contexts;
      (window as any).AudioContext = class extends Original {
        constructor(...args: any[]) {
          super(args[0]);
          const originalGain = this.createGain.bind(this);
          this.createGain = () => {
            const gain = originalGain();
            const analyser = this.createAnalyser();
            analyser.fftSize = 2048;
            gain.connect(analyser);
            analyser.connect(this.destination);
            contexts.push(analyser);
            return gain;
          };
        }
      };
    });
    await frame.locator('#play-toggle').click();
    await frame.waitForFunction(() => {
      for (const analyser of (window as any).__audioscopeTestAnalysers || []) {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        if (samples.some((value) => Math.abs(value) > 0.001)) return true;
      }
      return false;
    }, undefined, { timeout: 15_000 });
    await frame.locator('#play-toggle').click();
    await page.screenshot({ path: path.join(output, 'editor.png') });

    await frame.locator('#wave-selection-toggle').click();
    await frame.locator('#selection-start-input').fill('0.25');
    await frame.locator('#selection-end-input').fill('1.25');
    await frame.locator('#selection-apply').click();
    await frame.locator('#wave-selection-toggle').click();
    await frame.waitForFunction(() => !(document.querySelector('#wave-export') as HTMLButtonElement)?.disabled);
    const exports = [];
    for (const format of ['wav', 'mp3', 'm4a', 'flac']) {
      const target = path.join(output, 'export.' + format);
      await fs.rm(target, { force: true });
      await app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
        return true;
      }, target);
      await frame.locator('#wave-export').click();
      await frame.locator('#wave-export-menu [data-export-format="' + format + '"]').click();
      // Notifications can be coalesced by VS Code. Wait for a completed file
      // rather than accepting an early MP4 ftyp header or relying on a toast.
      let previousSize = 0;
      let stable = 0;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const current = await fs.stat(target).then((stat) => stat.size, () => 0);
        stable = current > 64 && current === previousSize ? stable + 1 : 0;
        previousSize = current;
        if (stable >= 4) break;
        await page.waitForTimeout(100);
      }
      assert.ok(stable >= 4, 'UI export did not finish: ' + format);
      const size = previousSize;
      const metadata = JSON.parse(await withBackend('wasm', () => mediaTools.runEmbeddedFfprobe(resourceFor(target), 30_000)));
      const stream = metadata.streams.find((item: any) => item.codec_type === 'audio');
      assert.ok(stream, 'UI export must contain an audio stream: ' + format);
      assert.equal(stream.sample_rate, '44100');
      assert.equal(stream.channels, 1);
      assert.ok(Math.abs(Number(metadata.format.duration) - 1) < 0.1, 'UI selection duration: ' + format);
      exports.push({ format, bytes: size, codec: stream.codec_name, duration: metadata.format.duration });
    }
    results.push({ mode, launchToReadyMs, audioSignal: true, exports });
    console.log('Passed: ' + mode + ', ready in ' + launchToReadyMs.toFixed(0) + 'ms');
  } finally {
    await app?.close();
    if (mode === 'wasm-fallback') await fs.rename(nativeDirectory + '.disabled', nativeDirectory);
  }
}
await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({
  platform: process.platform, arch: process.arch, vsix, vscode: '1.138.0', results,
}, null, 2) + '\n');
console.log('Installed VSIX tests passed: ' + directory);
await fs.rm(profile, { recursive: true, force: true });
