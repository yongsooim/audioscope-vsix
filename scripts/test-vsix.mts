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
const driver = path.join(profile, 'driver');
const driverStatus = path.join(fixture, 'driver-status.json');
await fs.mkdir(path.join(userData, 'User'), { recursive: true });
await fs.mkdir(extensions, { recursive: true });
await fs.mkdir(driver, { recursive: true });
await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify({
  name: 'audioscope-release-test-driver', publisher: 'audioscope-tests', version: '0.0.1',
  engines: { vscode: '^1.100.0' }, main: './driver.cjs', activationEvents: ['onStartupFinished'],
}));
// Only this driver is a development extension. Audioscope runs from the installed
// VSIX in production mode; the driver uses its public command after activation.
await fs.writeFile(path.join(driver, 'driver.cjs'), [
  'const vscode = require("vscode"); const fs = require("node:fs");',
  'exports.activate = async () => {',
  '  try {',
  '    const extension = vscode.extensions.getExtension("yongsooim.audioscope");',
  '    if (!extension) throw new Error("Installed audioscope extension is missing.");',
  '    await extension.activate();',
  '    await vscode.commands.executeCommand("audioscope.openActiveFileInAudioscope", vscode.Uri.file(' + JSON.stringify(path.join(fixture, 'sample-tone.wav')) + '));',
  '    fs.writeFileSync(' + JSON.stringify(driverStatus) + ', JSON.stringify({ path: extension.extensionUri.fsPath, version: extension.packageJSON.version }));',
  '  } catch (error) {',
  '    fs.writeFileSync(' + JSON.stringify(driverStatus) + ', JSON.stringify({ error: String(error.stack || error) }));',
  '    throw error;',
  '  }',
  '};',
].join('\n'));
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
  const userData = path.join(profile, 'u' + modes.indexOf(mode));
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.rm(driverStatus, { force: true });
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
    'workbench.editorAssociations': { '*.wav': 'default' },
  }, null, 2));
  if (mode === 'wasm-fallback') await fs.rename(nativeDirectory, nativeDirectory + '.disabled');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const startedAt = performance.now();
    app = await electron.launch({
      executablePath: executable,
      args: ['--new-window', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--no-sandbox', '--disable-gpu-sandbox',
        '--user-data-dir=' + userData, '--extensions-dir=' + extensions, '--extensionDevelopmentPath=' + driver, fixture],
      env: isolatedEnv, timeout: 60_000,
    });
    app.process().stderr?.on('data', (chunk) => process.stderr.write(chunk));
    // Mute this isolated VS Code instance after audio mixing. The audio graph
    // still runs and its signal is checked below without playing test tones.
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
      return true;
    });
    await page.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
    await app.evaluate(({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) contents.setAudioMuted(true);
      return true;
    });
    const frame = await audioFrame(page);
    await frame.locator('#play-toggle').waitFor({ state: 'visible' });
    await frame.waitForFunction(() => !(document.querySelector('#play-toggle') as HTMLButtonElement)?.disabled, undefined, { timeout: 60_000 });
    const opened = JSON.parse(await fs.readFile(driverStatus, 'utf8'));
    assert.equal(opened.error, undefined);
    const normalizedPath = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    assert.equal(normalizedPath(opened.path), normalizedPath(path.join(extensions, installed)));
    const launchToReadyMs = performance.now() - startedAt;
    await frame.waitForFunction(() => document.querySelector('#media-metadata-panel')?.getAttribute('data-state') === 'ready', undefined, { timeout: 30_000 });
    const toolDetails = await frame.locator('#media-metadata-detail').textContent() || '';
    const backends = {
      decode: toolDetails.includes('native (ffmpeg @') ? 'native' : 'wasm',
      probe: toolDetails.includes('native (ffprobe @') ? 'native' : 'wasm',
    };
    assert.equal(backends.decode, mode === 'native-experimental' ? 'native' : 'wasm');
    assert.equal(backends.probe, ['hybrid', 'native-experimental'].includes(mode) ? 'native' : 'wasm');
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
      await frame.locator('#wave-export-menu [data-export-format="' + format + '"]').press('Enter');
      await frame.waitForFunction(() => document.querySelector('#wave-export')?.getAttribute('aria-expanded') === 'false');
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
    results.push({ mode, backends, launchToReadyMs, audioSignal: true, exports });
    console.log('Passed: ' + mode + ', ready in ' + launchToReadyMs.toFixed(0) + 'ms');
  } catch (error) {
    const page = app?.windows()[0];
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.cp(path.join(userData, 'logs'), path.join(output, 'logs'), { recursive: true }).catch(() => {});
    await fs.copyFile(path.join(userData, 'User', 'settings.json'), path.join(output, 'settings.json')).catch(() => {});
    await fs.copyFile(driverStatus, path.join(output, 'driver-status.json')).catch(() => {});
    throw error;
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
