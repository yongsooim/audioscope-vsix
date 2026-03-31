import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createInitialExternalToolStatus,
  decodeWithFfmpeg,
  getExternalToolStatus,
  getMediaMetadata,
  probeAudioOpen,
  type WaveScopePayload,
} from './externalAudioTools';
import {
  createHostDebugTimelineEvent,
  getExtensionActivatedAtMs,
  type DebugTimelineEventPayload,
} from './debugTimeline';

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

class WaveScopeDocument implements vscode.CustomDocument {
  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidDispose = this.onDidDisposeEmitter.event;

  private constructor(public readonly uri: vscode.Uri) {}

  public static async create(uri: vscode.Uri): Promise<WaveScopeDocument> {
    return new WaveScopeDocument(uri);
  }

  public dispose(): void {
    this.onDidDisposeEmitter.fire();
    this.onDidDisposeEmitter.dispose();
  }
}

export class WaveScopeEditorProvider implements vscode.CustomReadonlyEditorProvider<WaveScopeDocument> {
  public static readonly viewType = 'waveScope.editor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new WaveScopeEditorProvider(context);

    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(WaveScopeEditorProvider.viewType, provider, {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand('waveScope.openActiveFileInWaveScope', async (resource?: vscode.Uri) => {
        const target = resource ?? getActiveResource();

        if (!target) {
          void vscode.window.showInformationMessage('Select or open an audio file first.');
          return;
        }

        if (!(await canOpenInWaveScope(target))) {
          return;
        }

        await vscode.commands.executeCommand('vscode.openWith', target, WaveScopeEditorProvider.viewType);
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
  ): Promise<WaveScopeDocument> {
    return WaveScopeDocument.create(uri);
  }

  public async resolveCustomEditor(
    document: WaveScopeDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const resolveStartedAtMs = Date.now();
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

    const sendDebugTimelineEventRecord = async (event: DebugTimelineEventPayload, loadToken?: number): Promise<void> => {
      await webviewPanel.webview.postMessage({
        type: 'debugTimelineEvent',
        body: {
          event: {
            ...event,
            loadToken: loadToken ?? event.loadToken,
          },
        },
      });
    };
    const sendDebugTimelineEvent = async (label: string, loadToken?: number, detail?: string): Promise<void> => {
      await sendDebugTimelineEventRecord(createHostDebugTimelineEvent(label, detail, loadToken), loadToken);
    };
    const getOrStartExternalToolStatus = (): Promise<Awaited<ReturnType<typeof getExternalToolStatus>>> => {
      if (!externalToolStatusPromise) {
        externalToolStatusPromise = getExternalToolStatus(document.uri);
      }

      return externalToolStatusPromise;
    };
    void getOrStartExternalToolStatus();

    const postAudioPayload = async (triggerLabel: string): Promise<void> => {
      const triggerEvent = createHostDebugTimelineEvent(triggerLabel);
      const buildStartEvent = createHostDebugTimelineEvent('host.buildPayload.start');
      const payload = await this.buildPayload(document, webviewPanel.webview);
      const buildDoneEvent = createHostDebugTimelineEvent(
        'host.buildPayload.done',
        `size=${payload.fileSize ?? 'n/a'} quality=${payload.spectrogramQuality}`,
      );
      const loadAudioPostedEvent = createHostDebugTimelineEvent('host.loadAudio.posted');
      const debugTimelineSeed: DebugTimelineEventPayload[] = [
        {
          label: 'host.extension.activate',
          source: 'host',
          timeMs: getExtensionActivatedAtMs(),
        },
        {
          label: 'host.resolveCustomEditor.start',
          source: 'host',
          timeMs: resolveStartedAtMs,
        },
        triggerEvent,
        buildStartEvent,
        ...(payload.debugTimelineSeed ?? []),
        buildDoneEvent,
        loadAudioPostedEvent,
      ];
      await webviewPanel.webview.postMessage({
        type: 'loadAudio',
        body: {
          ...payload,
          debugTimelineSeed,
        },
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
        await postAudioPayload(message.type === 'reload' ? 'host.webview.reload.received' : 'host.webview.ready.received');
        return;
      }

      if (message?.type === 'requestMediaMetadata') {
        const loadToken = Number(message.body?.loadToken) || 0;
        await sendDebugTimelineEvent('host.mediaMetadata.request.start', loadToken);

        try {
          const metadata = await getMediaMetadata(document.uri);
          await sendDebugTimelineEvent('host.mediaMetadata.request.done', loadToken);
          await webviewPanel.webview.postMessage({
            type: 'mediaMetadataReady',
            body: {
              loadToken,
              metadata,
            },
          });
        } catch (error) {
          const toolStatus = await getExternalToolStatus(document.uri);
          await sendDebugTimelineEvent(
            'host.mediaMetadata.request.error',
            loadToken,
            error instanceof Error ? error.message : String(error),
          );
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
        await sendDebugTimelineEvent('host.decodeFallback.request.start', loadToken);

        try {
          const fallback = await decodeWithFfmpeg(document.uri, {
            onDebugTimelineEvent: (event) => {
              void sendDebugTimelineEventRecord(event, loadToken);
            },
          });
          await sendDebugTimelineEvent(
            'host.decodeFallback.request.done',
            loadToken,
            `bytes=${fallback.byteLength}`,
          );
          await webviewPanel.webview.postMessage({
            type: 'decodeFallbackReady',
            body: {
              ...fallback,
              loadToken,
            },
          });
        } catch (error) {
          const toolStatus = await getExternalToolStatus(document.uri);
          await sendDebugTimelineEvent(
            'host.decodeFallback.request.error',
            loadToken,
            error instanceof Error ? error.message : String(error),
          );
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

  private async buildPayload(document: WaveScopeDocument, webview: vscode.Webview): Promise<WaveScopePayload> {
    const debugTimelineSeed: DebugTimelineEventPayload[] = [];
    let fileSize: number | null = null;

    try {
      debugTimelineSeed.push(createHostDebugTimelineEvent('host.buildPayload.fsStat.start'));
      const stat = await vscode.workspace.fs.stat(document.uri);
      fileSize = stat.size;
      debugTimelineSeed.push(createHostDebugTimelineEvent('host.buildPayload.fsStat.done', `size=${fileSize}`));
    } catch {
      fileSize = null;
      debugTimelineSeed.push(createHostDebugTimelineEvent('host.buildPayload.fsStat.error'));
    }

    const spectrogramQuality = vscode.workspace
      .getConfiguration('waveScope', document.uri)
      .get<'balanced' | 'high' | 'max'>('spectrogramQuality', 'high');
    const externalTools = createInitialExternalToolStatus(document.uri);

    if (!externalTools.resolved) {
      debugTimelineSeed.push(createHostDebugTimelineEvent('host.buildPayload.externalTools.deferred'));
    }

    return {
      debugTimelineSeed,
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'waveScope.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'src-webview', 'waveScope.css'));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'audioAnalysisWorker.js'));
    const decodeWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'embeddedDecodeWorker.js'));
    const decodeBrowserModuleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'embedded-tools', 'ffdecode_browser_module.js'));
    const decodeBrowserModuleWasmUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'embedded-tools', 'ffdecode_browser_module.wasm'));
    const waveformWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'interactiveWaveformWorker.js'));
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
    <title>Wave Scope</title>
  </head>
  <body data-worker-src="${workerUri}" data-decode-module-src="${decodeBrowserModuleUri}" data-decode-module-wasm-src="${decodeBrowserModuleWasmUri}" data-decode-worker-src="${decodeWorkerUri}" data-waveform-worker-src="${waveformWorkerUri}" data-audio-transport-processor-src="${audioTransportProcessorUri}" data-stretch-processor-src="${stretchProcessorUri}">
    <main class="app-shell">
      <section id="wave-scope-viewport" class="viewport" aria-label="Wave Scope waveform and spectrogram">
        <div id="wave-panel" class="wave-panel">
          <div id="wave-toolbar" class="wave-toolbar">
            <div id="wave-toolbar-info" class="wave-toolbar-info">
              <div id="media-metadata-panel" class="media-metadata-panel" data-state="idle" aria-label="Audio metadata">
                <div id="media-metadata-summary" class="media-metadata-summary" tabindex="0">Checking metadata…</div>
                <div id="media-metadata-detail" class="media-metadata-detail" aria-hidden="true" hidden></div>
              </div>
              <div id="wave-hint" hidden>Click to seek. Drag to set a loop. Wheel to zoom or pan.</div>
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
                  <input id="wave-follow" class="wave-follow-toggle-input" type="checkbox" checked />
                  <span class="wave-follow-toggle-button">
                    <span class="wave-follow-toggle-track" aria-hidden="true">
                      <span class="wave-follow-toggle-thumb"></span>
                    </span>
                    <span class="wave-follow-toggle-text">Follow</span>
                  </span>
                </label>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-loop">
                <div id="wave-loop-label" class="wave-toolbar-pill wave-toolbar-pill-loop">Drag to set loop</div>
                <button id="wave-clear-loop" class="wave-tool-button wave-tool-button-quiet" type="button" aria-hidden="true" tabindex="-1" disabled>Clear</button>
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
            <div id="spectrogram-meta" class="spectrogram-meta">
              <label class="spectrogram-control">
                <span class="spectrogram-control-label">Type</span>
                <select id="spectrogram-type-select" class="spectrogram-control-select" aria-label="Spectrogram analysis type">
                  <option value="spectrogram" selected>Spectrogram</option>
                  <option value="mel">Mel-Spectrogram</option>
                  <option value="scalogram">Scalogram</option>
                </select>
              </label>
              <label class="spectrogram-control">
                <span class="spectrogram-control-label">FFT</span>
                <select id="spectrogram-fft-select" class="spectrogram-control-select" aria-label="Spectrogram FFT size">
                  <option value="1024">1024</option>
                  <option value="2048">2048</option>
                  <option value="4096" selected>4096</option>
                  <option value="8192">8192</option>
                  <option value="16384">16384</option>
                </select>
              </label>
              <label class="spectrogram-control">
                <span class="spectrogram-control-label">Overlap</span>
                <select id="spectrogram-overlap-select" class="spectrogram-control-select" aria-label="Spectrogram overlap ratio">
                  <option value="0.5">50%</option>
                  <option value="0.75" selected>75%</option>
                  <option value="0.875">87.5%</option>
                  <option value="0.9375">93.75%</option>
                </select>
              </label>
              <label class="spectrogram-control">
                <span class="spectrogram-control-label">Scale</span>
                <select id="spectrogram-scale-select" class="spectrogram-control-select" aria-label="Spectrogram frequency scale">
                  <option value="log" selected>Log</option>
                  <option value="linear">Linear</option>
                </select>
              </label>
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
        <label class="transport-rate" for="playback-rate-select">
          <span class="transport-rate-label">Speed</span>
          <select id="playback-rate-select" class="transport-rate-select" aria-label="Playback speed" disabled>
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
        </label>
        <div id="time-readout" class="time-readout">0:00 / --:--</div>
        <div id="waveform-overview" class="timeline-shell">
          <div id="waveform-overview-thumb" class="timeline-viewport" aria-hidden="true"></div>
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
        <div id="analysis-status" class="analysis-status">Preparing Wave Scope…</div>
      </footer>
      <div id="status" class="status-overlay" hidden></div>
      <aside id="debug-timeline-panel" class="debug-timeline-panel" aria-label="Wave Scope debug timeline" data-collapsed="false">
        <div class="debug-timeline-header">
          <div id="debug-timeline-summary" class="debug-timeline-summary">Timeline pending…</div>
          <button id="debug-timeline-toggle" class="debug-timeline-toggle" type="button" aria-expanded="true">Hide</button>
        </div>
        <div id="debug-timeline-list" class="debug-timeline-list"></div>
      </aside>
    </main>

    <script type="module" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

async function canOpenInWaveScope(target: vscode.Uri): Promise<boolean> {
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
    void vscode.window.showErrorMessage(`Wave Scope could not inspect this file: ${message}`);
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
