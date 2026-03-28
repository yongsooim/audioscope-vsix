import * as path from 'node:path';
import * as vscode from 'vscode';

interface AudioPreviewPayload {
  fileExtension: string;
  fileName: string;
  fileSize: number | null;
  sourceUri: string;
}

class AudioPreviewDocument implements vscode.CustomDocument {
  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidDispose = this.onDidDisposeEmitter.event;

  private constructor(public readonly uri: vscode.Uri) {}

  public static async create(uri: vscode.Uri): Promise<AudioPreviewDocument> {
    return new AudioPreviewDocument(uri);
  }

  public dispose(): void {
    this.onDidDisposeEmitter.fire();
    this.onDidDisposeEmitter.dispose();
  }
}

export class AudioPreviewEditorProvider implements vscode.CustomReadonlyEditorProvider<AudioPreviewDocument> {
  public static readonly viewType = 'wavePreview.audioPreview';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AudioPreviewEditorProvider(context);

    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(AudioPreviewEditorProvider.viewType, provider, {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand('wavePreview.openActiveAudioPreview', async (resource?: vscode.Uri) => {
        const target = resource ?? getActiveResource();

        if (!target) {
          void vscode.window.showInformationMessage('Select or open an audio file first.');
          return;
        }

        await vscode.commands.executeCommand('vscode.openWith', target, AudioPreviewEditorProvider.viewType);
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
  ): Promise<AudioPreviewDocument> {
    return AudioPreviewDocument.create(uri);
  }

  public async resolveCustomEditor(
    document: AudioPreviewDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
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

    const postAudioPayload = async (): Promise<void> => {
      const payload = await this.buildPayload(document, webviewPanel.webview);
      await webviewPanel.webview.postMessage({
        type: 'loadAudio',
        body: payload,
      });
    };

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready' || message?.type === 'reload') {
        await postAudioPayload();
      }
    });
  }

  private async buildPayload(document: AudioPreviewDocument, webview: vscode.Webview): Promise<AudioPreviewPayload> {
    let fileSize: number | null = null;

    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      fileSize = stat.size;
    } catch {
      fileSize = null;
    }

    return {
      fileExtension: path.posix.extname(document.uri.path).replace(/^\./, '').toLowerCase(),
      fileName: path.posix.basename(document.uri.path),
      fileSize,
      sourceUri: webview.asWebviewUri(document.uri).toString(),
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'audioPreview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'audioPreview.css'));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'audioAnalysisWorker.js'));
    const waveformWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'interactiveWaveformWorker.js'));

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
    <title>Wave Preview</title>
  </head>
  <body data-worker-src="${workerUri}" data-waveform-worker-src="${waveformWorkerUri}">
    <main class="app-shell">
      <section class="viewport" aria-label="Waveform and spectrogram preview">
        <div class="wave-panel">
          <div class="wave-toolbar">
            <div class="wave-toolbar-copy">
              <div id="wave-hint" class="wave-hint">Click to seek. Drag to set a loop. Wheel to zoom or pan.</div>
              <div id="wave-loop-label" class="wave-loop-label">No loop selection</div>
            </div>
            <div class="wave-toolbar-actions">
              <button id="wave-clear-loop" class="wave-tool-button wave-tool-button-wide" type="button" hidden>Clear</button>
              <button id="wave-zoom-out" class="wave-tool-button" type="button" aria-label="Zoom out waveform">-</button>
              <button id="wave-zoom-reset" class="wave-tool-button wave-tool-button-wide" type="button" aria-label="Reset waveform zoom">1.0x</button>
              <button id="wave-zoom-in" class="wave-tool-button" type="button" aria-label="Zoom in waveform">+</button>
              <label class="wave-follow-toggle">
                <input id="wave-follow" type="checkbox" checked />
                <span>Follow</span>
              </label>
            </div>
          </div>
          <div id="waveform-viewport" class="waveform-viewport" aria-label="Waveform">
            <div id="waveform-canvas-host" class="waveform-canvas-host" aria-hidden="true"></div>
            <div id="waveform-hit-target" class="waveform-hit-target" aria-hidden="true"></div>
            <div id="waveform-selection" class="waveform-selection" aria-hidden="true"></div>
            <div id="waveform-progress" class="waveform-progress" aria-hidden="true"></div>
            <div id="waveform-cursor" class="waveform-cursor" aria-hidden="true"></div>
            <div id="waveform-loop-start" class="waveform-loop-handle" aria-hidden="true"></div>
            <div id="waveform-loop-end" class="waveform-loop-handle" aria-hidden="true"></div>
          </div>
          <div id="waveform-axis" class="waveform-axis" aria-hidden="true"></div>
          <div id="waveform-overview" class="waveform-overview" aria-hidden="true">
            <div id="waveform-overview-thumb" class="waveform-overview-thumb"></div>
          </div>
        </div>
        <div class="spectrogram-panel">
          <div id="spectrogram-axis" class="spectrogram-axis" aria-hidden="true"></div>
          <div class="spectrogram-stage">
            <canvas id="spectrogram" class="spectrogram-canvas" aria-label="Spectrogram"></canvas>
            <div id="spectrogram-guides" class="spectrogram-guides" aria-hidden="true"></div>
          </div>
        </div>
      </section>
      <footer class="transport" aria-label="Playback controls">
        <button id="jump-start" class="transport-button" type="button" disabled>Start</button>
        <button id="seek-backward" class="transport-button" type="button" disabled>-5s</button>
        <button id="play-toggle" class="play-toggle" type="button" disabled>Play</button>
        <button id="seek-forward" class="transport-button" type="button" disabled>+5s</button>
        <button id="jump-end" class="transport-button" type="button" disabled>End</button>
        <input id="timeline" class="timeline" type="range" min="0" max="1" step="0.001" value="0" disabled />
        <div id="time-readout" class="time-readout">0:00 / --:--</div>
        <div id="analysis-status" class="analysis-status">Preparing preview…</div>
      </footer>
      <div id="status" class="status-overlay" hidden></div>
    </main>

    <script type="module" src="${scriptUri}"></script>
  </body>
</html>`;
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
