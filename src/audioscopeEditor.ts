import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createInitialExternalToolStatus,
  decodeWithFfmpeg,
  getExternalToolStatus,
  getLoudnessSummary,
  getMediaMetadata,
  probeAudioOpen,
  type DecodeFallbackPayload,
  type AudioscopePayload,
} from './externalAudioTools';
import {
  getCachedDecodeFallback,
  getCachedLoudnessSummary,
  getCachedMediaMetadata,
  getCachedSourceAudioBytes,
} from './mediaHostCache';

const KNOWN_AUDIO_EXTENSIONS = new Set([
  'wav',
  'wave',
  'mp3',
  'ogg',
  'oga',
  'flac',
  'm4a',
  'aac',
  'opus',
  'aif',
  'aiff',
]);

function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

function cloneDecodeFallbackPayload(payload: DecodeFallbackPayload): DecodeFallbackPayload {
  if (payload.kind === 'wav') {
    return {
      ...payload,
      audioBuffer: cloneArrayBuffer(payload.audioBuffer),
    };
  }

  return {
    ...payload,
    channelBuffers: payload.channelBuffers.map((buffer) => cloneArrayBuffer(buffer)),
  };
}

class AudioscopeDocument implements vscode.CustomDocument {
  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidDispose = this.onDidDisposeEmitter.event;

  private constructor(public readonly uri: vscode.Uri) {}

  public static async create(uri: vscode.Uri): Promise<AudioscopeDocument> {
    return new AudioscopeDocument(uri);
  }

  public dispose(): void {
    this.onDidDisposeEmitter.fire();
    this.onDidDisposeEmitter.dispose();
  }
}

export class AudioscopeEditorProvider implements vscode.CustomReadonlyEditorProvider<AudioscopeDocument> {
  public static readonly viewType = 'audioscope.editor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AudioscopeEditorProvider(context);

    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(AudioscopeEditorProvider.viewType, provider, {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand('audioscope.openActiveFileInAudioscope', async (resource?: vscode.Uri) => {
        const target = resource ?? getActiveResource();

        if (!target) {
          void vscode.window.showInformationMessage('Select or open an audio file first.');
          return;
        }

        if (!(await canOpenInAudioscope(target))) {
          return;
        }

        await vscode.commands.executeCommand('vscode.openWith', target, AudioscopeEditorProvider.viewType);
      }),
    );
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
  ) {}

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<AudioscopeDocument> {
    return AudioscopeDocument.create(uri);
  }

  public async resolveCustomEditor(
    document: AudioscopeDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    let externalToolStatusPromise: Promise<Awaited<ReturnType<typeof getExternalToolStatus>>> | null = null;
    const documentRoot = document.uri.with({
      path: path.posix.dirname(document.uri.path),
      query: '',
      fragment: '',
    });

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, documentRoot],
    };
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    const getOrStartExternalToolStatus = (): Promise<Awaited<ReturnType<typeof getExternalToolStatus>>> => {
      if (!externalToolStatusPromise) {
        externalToolStatusPromise = getExternalToolStatus(document.uri);
      }

      return externalToolStatusPromise;
    };
    void getOrStartExternalToolStatus();

    const postAudioPayload = async (): Promise<void> => {
      const payload = await this.buildPayload(document, webviewPanel.webview);
      await webviewPanel.webview.postMessage({
        type: 'loadAudio',
        body: payload,
      });

      if (!payload.externalTools.resolved) {
        void getOrStartExternalToolStatus()
          .then(async (externalTools) => {
            await webviewPanel.webview.postMessage({
              type: 'externalToolStatus',
              body: externalTools,
            });
          })
          .catch(() => {});
      }
    };

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready' || message?.type === 'reload') {
        await postAudioPayload();
        return;
      }

      if (message?.type === 'requestMediaMetadata') {
        const loadToken = Number(message.body?.loadToken) || 0;

        try {
          const metadata = await getCachedMediaMetadata(
            document.uri,
            () => getMediaMetadata(document.uri),
          );
          await webviewPanel.webview.postMessage({
            type: 'mediaMetadataReady',
            body: {
              loadToken,
              metadata,
            },
          });
        } catch (error) {
          const toolStatus = await getExternalToolStatus(document.uri);
          await webviewPanel.webview.postMessage({
            type: 'mediaMetadataError',
            body: {
              loadToken,
              message: error instanceof Error ? error.message : String(error),
              toolStatus,
            },
          });
        }
        return;
      }

      if (message?.type === 'requestDecodeFallback') {
        const loadToken = Number(message.body?.loadToken) || 0;

        try {
          const fallback = await getCachedDecodeFallback(
            document.uri,
            () => decodeWithFfmpeg(document.uri),
          );
          await webviewPanel.webview.postMessage({
            type: 'decodeFallbackReady',
            body: {
              ...cloneDecodeFallbackPayload(fallback),
              loadToken,
            },
          });
        } catch (error) {
          const toolStatus = await getExternalToolStatus(document.uri);
          await webviewPanel.webview.postMessage({
            type: 'decodeFallbackError',
            body: {
              loadToken,
              message: error instanceof Error ? error.message : String(error),
              toolStatus,
            },
          });
        }
        return;
      }

      if (message?.type === 'requestLoudnessSummary') {
        const loadToken = Number(message.body?.loadToken) || 0;

        try {
          const summary = await getCachedLoudnessSummary(
            document.uri,
            () => getLoudnessSummary(document.uri),
          );
          await webviewPanel.webview.postMessage({
            type: 'loudnessSummaryReady',
            body: {
              ...summary,
              loadToken,
            },
          });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'loudnessSummaryError',
            body: {
              loadToken,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      if (message?.type === 'openExternal') {
        const url = typeof message.body?.url === 'string' ? message.body.url.trim() : '';

        if (!url) {
          return;
        }

        try {
          const uri = vscode.Uri.parse(url);

          if (uri.scheme === 'https' || uri.scheme === 'http') {
            await vscode.env.openExternal(uri);
          }
        } catch {
          // Ignore malformed external URLs from the webview.
        }
      }
    });
  }

  private async buildPayload(document: AudioscopeDocument, webview: vscode.Webview): Promise<AudioscopePayload> {
    let fileSize: number | null = null;
    let audioBytes: ArrayBuffer | null = null;

    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      fileSize = stat.size;
    } catch {
      fileSize = null;
    }

    try {
      audioBytes = await getCachedSourceAudioBytes(document.uri);
    } catch {
      audioBytes = null;
    }

    const spectrogramQuality = vscode.workspace
      .getConfiguration('audioscope', document.uri)
      .get<'balanced' | 'high' | 'max'>('spectrogramQuality', 'high');
    const externalTools = createInitialExternalToolStatus(document.uri);

    return {
      audioBytes: audioBytes ? cloneArrayBuffer(audioBytes) : null,
      documentUri: document.uri.toString(),
      externalTools,
      fileExtension: path.posix.extname(document.uri.path).replace(/^\./, '').toLowerCase(),
      fileBacked: externalTools.fileBacked,
      fileName: path.posix.basename(document.uri.path),
      fileSize,
      spectrogramQuality,
      sourceUri: webview.asWebviewUri(document.uri).toString(),
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'audioscope.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'src-webview', 'audioscope.css'));
    const engineWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'audioEngineWorker.js'));
    const analysisWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'audioAnalysisWorker.js'));
    const decodeWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'embeddedDecodeWorker.js'));
    const decodeBrowserModuleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'embedded-tools', 'ffdecode_browser_module.js'));
    const decodeBrowserModuleWasmUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'embedded-tools', 'ffdecode_browser_module.wasm'));
    const audioTransportProcessorUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'audioTransportProcessor.js'));
    const stretchProcessorUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'src-webview', 'vendor', 'SignalsmithStretch.mjs'));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} blob: data:; media-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'wasm-unsafe-eval'; connect-src ${webview.cspSource} blob:; worker-src ${webview.cspSource} blob:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>audioscope</title>
  </head>
  <body data-engine-worker-src="${engineWorkerUri}" data-analysis-worker-src="${analysisWorkerUri}" data-decode-module-src="${decodeBrowserModuleUri}" data-decode-module-wasm-src="${decodeBrowserModuleWasmUri}" data-decode-worker-src="${decodeWorkerUri}" data-audio-transport-processor-src="${audioTransportProcessorUri}" data-stretch-processor-src="${stretchProcessorUri}">
    <main class="app-shell">
      <section id="audioscope-viewport" class="viewport" aria-label="audioscope waveform and spectrogram">
        <div id="wave-panel" class="wave-panel">
          <div id="wave-toolbar" class="wave-toolbar">
            <div id="wave-toolbar-info" class="wave-toolbar-info">
              <div id="media-metadata-panel" class="media-metadata-panel" data-state="idle" aria-label="Audio metadata">
                <div id="media-metadata-summary" class="media-metadata-summary" tabindex="0">Checking metadata…</div>
                <div id="media-metadata-detail" class="media-metadata-detail" aria-hidden="true" hidden></div>
              </div>
            </div>
            <div class="wave-toolbar-actions">
              <div class="wave-toolbar-group wave-toolbar-group-zoom">
                <div id="wave-zoom-chip" class="wave-toolbar-pill wave-toolbar-pill-zoom" aria-live="polite">Zoom 1.0x</div>
                <button id="wave-zoom-out" class="wave-tool-button" type="button" aria-label="Zoom out waveform">-</button>
                <button id="wave-zoom-reset" class="wave-tool-button wave-tool-button-wide" type="button" aria-label="Reset waveform zoom">1.0x</button>
                <button id="wave-zoom-in" class="wave-tool-button" type="button" aria-label="Zoom in waveform">+</button>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-follow">
                <label class="wave-follow-toggle">
                  <input id="wave-follow" class="wave-follow-toggle-input" type="checkbox" />
                  <span class="wave-follow-toggle-button">
                    <span class="wave-follow-toggle-text">Follow</span>
                    <span class="wave-follow-toggle-track" aria-hidden="true">
                      <span class="wave-follow-toggle-thumb"></span>
                    </span>
                  </span>
                </label>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-loop">
                <div id="wave-loop-label" class="wave-toolbar-pill wave-toolbar-pill-loop">Drag to set loop</div>
                <button id="wave-clear-loop" class="wave-tool-button wave-tool-button-quiet" type="button" aria-hidden="false" disabled>Clear</button>
              </div>
            </div>
          </div>
          <div id="waveform-viewport" class="waveform-viewport" aria-label="Waveform">
            <div id="waveform-canvas-host" class="waveform-canvas-host" aria-hidden="true"></div>
            <div id="waveform-hit-target" class="waveform-hit-target" aria-hidden="true"></div>
            <div id="waveform-hover-tooltip" class="surface-hover-tooltip" aria-hidden="true"></div>
            <div id="waveform-selection" class="waveform-selection" aria-hidden="true"></div>
            <div id="waveform-progress" class="waveform-progress" aria-hidden="true"></div>
            <div id="waveform-cursor" class="waveform-cursor" aria-hidden="true"></div>
            <div id="waveform-loop-start" class="waveform-loop-handle" aria-hidden="true"></div>
            <div id="waveform-loop-end" class="waveform-loop-handle" aria-hidden="true"></div>
          </div>
          <div id="waveform-axis" class="waveform-axis" aria-hidden="true"></div>
        </div>
        <div
          id="viewport-splitter"
          class="viewport-splitter"
          role="separator"
          aria-controls="wave-panel spectrogram-panel"
          aria-label="Resize waveform and spectrogram panels"
          aria-orientation="horizontal"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="50"
          aria-valuetext="Waveform 50%, spectrogram 50%"
          tabindex="0"
        >
          <div class="viewport-splitter-handle" aria-hidden="true"></div>
        </div>
        <div id="spectrogram-panel" class="spectrogram-panel">
          <div id="spectrogram-axis" class="spectrogram-axis" aria-hidden="true"></div>
          <div id="spectrogram-stage" class="spectrogram-stage">
            <canvas id="spectrogram" class="spectrogram-canvas" aria-label="Spectrogram"></canvas>
            <div id="spectrogram-meta" class="spectrogram-meta" data-open="false">
              <button
                id="spectrogram-meta-toggle"
                class="spectrogram-meta-toggle"
                type="button"
                aria-controls="spectrogram-meta-controls"
                aria-expanded="false"
                aria-label="Toggle spectrogram settings"
              >Settings</button>
              <div id="spectrogram-meta-controls" class="spectrogram-meta-controls" hidden>
                <label id="spectrogram-type-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Type</span>
                  <select id="spectrogram-type-select" class="spectrogram-control-select" aria-label="Spectrogram analysis type">
                    <option value="spectrogram" selected>Spectrogram</option>
                    <option value="mel">Mel-Spectrogram</option>
                    <option value="mfcc">MFCC</option>
                    <option value="scalogram">Scalogram</option>
                  </select>
                </label>
                <label id="spectrogram-fft-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">FFT</span>
                  <select id="spectrogram-fft-select" class="spectrogram-control-select" aria-label="Spectrogram FFT size">
                    <option value="1024">1024</option>
                    <option value="2048">2048</option>
                    <option value="4096" selected>4096</option>
                    <option value="8192">8192</option>
                    <option value="16384">16384</option>
                  </select>
                </label>
                <label id="spectrogram-overlap-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Overlap</span>
                  <select id="spectrogram-overlap-select" class="spectrogram-control-select" aria-label="Spectrogram overlap ratio">
                    <option value="0.5">50%</option>
                    <option value="0.75" selected>75%</option>
                    <option value="0.875">87.5%</option>
                    <option value="0.9375">93.75%</option>
                  </select>
                </label>
                <label id="spectrogram-scale-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Scale</span>
                  <select id="spectrogram-scale-select" class="spectrogram-control-select" aria-label="Spectrogram frequency scale">
                    <option value="log" selected>Log</option>
                    <option value="mixed">Mixed</option>
                    <option value="linear">Linear</option>
                  </select>
                </label>
                <label id="spectrogram-mel-bands-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">Bands</span>
                  <select id="spectrogram-mel-bands-select" class="spectrogram-control-select" aria-label="Mel spectrogram band count">
                    <option value="128">128</option>
                    <option value="256" selected>256</option>
                    <option value="512">512</option>
                  </select>
                </label>
                <label id="spectrogram-mfcc-coefficients-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">n_mfcc</span>
                  <select id="spectrogram-mfcc-coefficients-select" class="spectrogram-control-select" aria-label="MFCC coefficient count">
                    <option value="13">13</option>
                    <option value="20" selected>20</option>
                    <option value="32">32</option>
                    <option value="40">40</option>
                  </select>
                </label>
                <label id="spectrogram-mfcc-mel-bands-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">n_mels</span>
                  <select id="spectrogram-mfcc-mel-bands-select" class="spectrogram-control-select" aria-label="MFCC mel filter count">
                    <option value="128" selected>128</option>
                    <option value="256">256</option>
                    <option value="512">512</option>
                  </select>
                </label>
                <label id="spectrogram-distribution-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Curve</span>
                  <select id="spectrogram-distribution-select" class="spectrogram-control-select" aria-label="Spectrogram colormap distribution">
                    <option value="balanced" selected>Balanced</option>
                    <option value="soft">Soft</option>
                    <option value="contrast">Contrast</option>
                  </select>
                </label>
                <div id="spectrogram-db-range-control" class="spectrogram-control spectrogram-control-slider">
                  <span class="spectrogram-control-label">Min/Max</span>
                  <span id="spectrogram-db-range-group" class="spectrogram-control-slider-group spectrogram-control-slider-group-dual">
                    <span class="spectrogram-control-range-dual" aria-hidden="true"></span>
                    <input
                      id="spectrogram-min-db-slider"
                      class="spectrogram-control-range spectrogram-control-range-min"
                      type="range"
                      min="-120"
                      max="12"
                      step="1"
                      value="-80"
                      aria-label="Spectrogram minimum decibel"
                    />
                    <input
                      id="spectrogram-max-db-slider"
                      class="spectrogram-control-range spectrogram-control-range-max"
                      type="range"
                      min="-120"
                      max="12"
                      step="1"
                      value="0"
                      aria-label="Spectrogram maximum decibel"
                    />
                    <span id="spectrogram-db-range-value" class="spectrogram-control-slider-value">Min -80 / Max 0 dB</span>
                  </span>
                </div>
              </div>
            </div>
            <div id="spectrogram-hover-tooltip" class="surface-hover-tooltip surface-hover-tooltip-detail" aria-hidden="true"></div>
            <div id="spectrogram-selection" class="spectrogram-selection" aria-hidden="true"></div>
            <div id="spectrogram-progress" class="spectrogram-progress" aria-hidden="true"></div>
            <div id="spectrogram-cursor" class="spectrogram-cursor" aria-hidden="true"></div>
            <div id="spectrogram-loop-start" class="waveform-loop-handle spectrogram-loop-handle" aria-hidden="true"></div>
            <div id="spectrogram-loop-end" class="waveform-loop-handle spectrogram-loop-handle" aria-hidden="true"></div>
            <div id="spectrogram-guides" class="spectrogram-guides" aria-hidden="true"></div>
            <div id="spectrogram-hit-target" class="spectrogram-hit-target" aria-hidden="true"></div>
          </div>
        </div>
      </section>
      <footer class="transport" aria-label="Playback controls">
        <button id="seek-backward" class="transport-button" type="button" disabled>-5s</button>
        <button id="play-toggle" class="play-toggle" type="button" disabled>Play</button>
        <button id="seek-forward" class="transport-button" type="button" disabled>+5s</button>
        <div class="transport-rate" role="group" aria-label="Playback speed">
          <span class="transport-rate-label">Speed</span>
          <div id="playback-rate-control" class="transport-rate-control">
            <button
              id="playback-rate-button"
              class="transport-rate-button"
              type="button"
              aria-haspopup="listbox"
              aria-controls="playback-rate-menu"
              aria-expanded="false"
              aria-label="Playback speed"
              disabled
            >1x</button>
            <select id="playback-rate-select" class="transport-rate-select" aria-label="Playback speed" disabled tabindex="-1">
              <option value="0.5">0.5x</option>
              <option value="0.75">0.75x</option>
              <option value="1" selected>1x</option>
              <option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option>
              <option value="2">2x</option>
            </select>
          </div>
        </div>
        <div id="time-readout" class="time-readout">0:00 / --:--</div>
        <div id="waveform-overview" class="timeline-shell">
          <div id="waveform-overview-thumb" class="timeline-viewport" aria-hidden="true"></div>
          <div id="timeline-current-marker" class="timeline-current-marker" aria-hidden="true" hidden></div>
          <div id="timeline-hover-tooltip" class="timeline-hover-tooltip" aria-hidden="true"></div>
          <input id="timeline" class="timeline" type="range" min="0" max="1" step="0.00001" value="0" disabled />
        </div>
        <div id="loudness-summary" class="loudness-summary" data-state="idle" aria-label="Loudness summary" aria-live="polite" hidden>
          <div class="loudness-chip">
            <span class="loudness-chip-label">I</span>
            <span id="loudness-integrated" class="loudness-chip-value">--</span>
          </div>
          <div class="loudness-chip">
            <span class="loudness-chip-label">LRA</span>
            <span id="loudness-range" class="loudness-chip-value">--</span>
          </div>
          <div class="loudness-chip">
            <span class="loudness-chip-label">Peak</span>
            <span id="loudness-sample-peak" class="loudness-chip-value">--</span>
          </div>
          <div class="loudness-chip">
            <span class="loudness-chip-label">True Peak</span>
            <span id="loudness-true-peak" class="loudness-chip-value">--</span>
          </div>
        </div>
        <div id="analysis-status" class="analysis-status">Preparing audioscope…</div>
      </footer>
      <div id="playback-rate-layer" class="transport-rate-layer" hidden>
        <div id="playback-rate-menu" class="transport-rate-menu" role="listbox" aria-label="Playback speed"></div>
      </div>
      <div id="status" class="status-overlay" hidden></div>
    </main>

    <script type="module" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

async function canOpenInAudioscope(target: vscode.Uri): Promise<boolean> {
  const fileExtension = path.posix.extname(target.path).replace(/^\./, '').toLowerCase();

  if (KNOWN_AUDIO_EXTENSIONS.has(fileExtension)) {
    return true;
  }

  try {
    const result = await probeAudioOpen(target);

    if (result.kind === 'audio') {
      return true;
    }

    const severity = result.kind === 'not-audio' ? 'warning' : 'info';
    const showMessage = severity === 'warning'
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;

    void showMessage(result.message);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`audioscope could not inspect this file: ${message}`);
    return false;
  }
}

function getActiveResource(): vscode.Uri | undefined {
  const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;

  if (activeTabInput instanceof vscode.TabInputText) {
    return activeTabInput.uri;
  }

  if (activeTabInput instanceof vscode.TabInputCustom) {
    return activeTabInput.uri;
  }

  if (activeTabInput instanceof vscode.TabInputTextDiff) {
    return activeTabInput.modified;
  }

  return vscode.window.activeTextEditor?.document.uri;
}
