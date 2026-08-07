import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createInitialExternalToolStatus,
  decodeWithFfmpeg,
  exportAudioSegment,
  getExternalToolStatus,
  getLoudnessSummary,
  getMediaMetadata,
} from './externalAudioTools';
import type {
  AudioscopePayload,
  ExportAudioMessage,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from './hostWebviewProtocol';
import { prewarmEmbeddedDirectDecodeModule } from './embeddedMediaTools';
import {
  getCachedDecodeFallback,
  getCachedLoudnessSummary,
  getCachedMediaMetadata,
} from './mediaHostCache';
import { DEFAULT_SPECTROGRAM_DEFAULTS } from './audioscope-editor/constants';
import { AudioscopeDocument } from './audioscope-editor/document';
import { evaluateAudioscopeTarget, getActiveResource } from './audioscope-editor/editorTarget';
import { cloneDecodeFallbackPayload } from './audioscope-editor/payloadClone';
import { normalizeSpectrogramDefaults } from './audioscope-editor/spectrogramDefaults';
import { getAudioscopeWebviewHtml } from './audioscope-editor/webviewHtml';

function postToWebview(webview: vscode.Webview, message: HostToWebviewMessage): Thenable<boolean> {
  return webview.postMessage(message);
}

const HOST_SHARED_LOUDNESS_EXTENSIONS = new Set([
  'aac',
  'flac',
  'm4a',
  'mp3',
  'oga',
  'ogg',
  'opus',
]);

function shouldUseSharedHostDecodeLoudness(resource: vscode.Uri): boolean {
  const extension = path.posix.extname(resource.path).replace(/^\./, '').toLowerCase();
  return HOST_SHARED_LOUDNESS_EXTENSIONS.has(extension);
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

        const decision = await evaluateAudioscopeTarget(target);

        if (decision.kind === 'deny') {
          const showMessage = decision.reason === 'not-audio'
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;
          void showMessage(decision.message);
          return;
        }

        if (decision.kind === 'error') {
          void vscode.window.showErrorMessage(`audioscope could not inspect this file: ${decision.message}`);
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
    webviewPanel.webview.html = getAudioscopeWebviewHtml(this.context, webviewPanel.webview);

    const getOrStartExternalToolStatus = (): Promise<Awaited<ReturnType<typeof getExternalToolStatus>>> => {
      if (!externalToolStatusPromise) {
        externalToolStatusPromise = getExternalToolStatus(document.uri);
      }

      return externalToolStatusPromise;
    };
    void getOrStartExternalToolStatus();
    if (shouldUseSharedHostDecodeLoudness(document.uri)) {
      void prewarmEmbeddedDirectDecodeModule().catch(() => {});
    }

    let disposed = false;
    // ponytail: iconPath can't render an emoji, so the play/pause state lives in
    // the tab title text. It goes AFTER the name so the (proportional UI-font)
    // width difference between ⏵/⏸ only moves the trailing icon, never the name.
    // Shows ⏸ until the webview reports playback.
    const baseTitle = path.posix.basename(document.uri.path);
    const PLAY_ICON = '⏵︎';
    const PAUSE_ICON = '⏸︎';
    webviewPanel.title = `${baseTitle} ${PAUSE_ICON}`;

    const postIfAlive = (message: HostToWebviewMessage): Thenable<boolean> => {
      if (disposed) {
        return Promise.resolve(false);
      }
      return postToWebview(webviewPanel.webview, message);
    };

    const postAudioPayload = async (): Promise<void> => {
      const payload = await this.buildPayload(document, webviewPanel.webview);
      await postIfAlive({ type: 'loadAudio', body: payload });

      if (!payload.externalTools.resolved) {
        void getOrStartExternalToolStatus()
          .then((externalTools) =>
            postIfAlive({
              type: 'externalToolStatus',
              body: externalTools,
            }),
          )
          .catch(() => {});
      }
    };

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const message = raw as WebviewToHostMessage | null | undefined;
      if (!message) {
        return;
      }

      switch (message.type) {
        case 'ready':
        case 'reload':
          await postAudioPayload();
          return;

        case 'persistSpectrogramDefaults': {
          const nextDefaults = normalizeSpectrogramDefaults(message.body);
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('spectrogramDefaults', nextDefaults, vscode.ConfigurationTarget.Global);
          return;
        }

        case 'persistWebGpuRendering': {
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('experimental.enableWebGpuRendering', Boolean(message.body?.enabled), vscode.ConfigurationTarget.Global);
          return;
        }

        case 'persistSplitChannels': {
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('experimental.splitChannels', Boolean(message.body?.enabled), vscode.ConfigurationTarget.Global);
          return;
        }

        case 'persistViewportSplitRatio': {
          const ratio = Number(message.body?.ratio);
          if (!Number.isFinite(ratio)) {
            return;
          }
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('viewportSplitRatio', Math.min(1, Math.max(0, ratio)), vscode.ConfigurationTarget.Global);
          return;
        }

        case 'persistWaveformAmplitudeMax': {
          const amplitudeMax = Number(message.body?.amplitudeMax);
          if (!Number.isFinite(amplitudeMax)) {
            return;
          }
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('waveformAmplitudeMax', Math.min(1, Math.max(0.01, amplitudeMax)), vscode.ConfigurationTarget.Global);
          return;
        }

        case 'persistPlaybackVolume': {
          const volume = Number(message.body?.volume);
          if (!Number.isFinite(volume)) {
            return;
          }
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('playbackVolume', Math.min(1, Math.max(0, volume)), vscode.ConfigurationTarget.Global);
          return;
        }

        case 'exportAudio': {
          await this.exportAudio(document, message.body);
          return;
        }

        case 'requestMediaMetadata': {
          const loadToken = Number(message.body?.loadToken) || 0;
          try {
            const metadata = await getCachedMediaMetadata(
              document.uri,
              () => getMediaMetadata(document.uri),
            );
            await postIfAlive({
              type: 'mediaMetadataReady',
              body: { loadToken, metadata },
            });
          } catch (error) {
            const toolStatus = await getExternalToolStatus(document.uri);
            await postIfAlive({
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

        case 'requestDecodeFallback': {
          const loadToken = Number(message.body?.loadToken) || 0;
          try {
            const fallback = await getCachedDecodeFallback(
              document.uri,
              () => decodeWithFfmpeg(document.uri),
            );
            await postIfAlive({
              type: 'decodeFallbackReady',
              body: { ...cloneDecodeFallbackPayload(fallback), loadToken },
            });
          } catch (error) {
            const toolStatus = await getExternalToolStatus(document.uri);
            await postIfAlive({
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

        case 'requestLoudnessSummary': {
          const loadToken = Number(message.body?.loadToken) || 0;
          try {
            const summary = await getCachedLoudnessSummary(
              document.uri,
              () => getLoudnessSummary(document.uri),
            );
            await postIfAlive({
              type: 'loudnessSummaryReady',
              body: { ...summary, loadToken },
            });
          } catch (error) {
            await postIfAlive({
              type: 'loudnessSummaryError',
              body: {
                loadToken,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
          return;
        }

        case 'playbackState': {
          webviewPanel.title = `${baseTitle} ${message.body?.playing ? PLAY_ICON : PAUSE_ICON}`;
          return;
        }

        case 'openExternal': {
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
          return;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      disposed = true;
      messageSubscription.dispose();
    });
  }

  private async exportAudio(document: AudioscopeDocument, body: ExportAudioMessage['body']): Promise<void> {
    const format = body?.format;
    if (format !== 'wav' && format !== 'mp3' && format !== 'm4a' && format !== 'flac') {
      return;
    }

    const startSeconds = Number(body?.startSeconds);
    const endSeconds = Number(body?.endSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || !(endSeconds > startSeconds) || startSeconds < 0) {
      return;
    }

    const sourceBaseName = path.posix.basename(document.uri.path).replace(/\.[^.]+$/u, '') || 'audio';
    const defaultName = `${sourceBaseName}_${startSeconds.toFixed(2)}s-${endSeconds.toFixed(2)}s.${format}`;
    const defaultUri = document.uri.scheme === 'file'
      ? vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), defaultName))
      : vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir()), defaultName);

    const targetUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { [`${format.toUpperCase()} audio`]: [format] },
    });
    if (!targetUri) {
      return;
    }

    try {
      if (targetUri.scheme !== 'file') {
        throw new Error('Export can only save to the local filesystem.');
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `audioscope: exporting ${path.basename(targetUri.fsPath)}…`,
        },
        () => exportAudioSegment(document.uri, targetUri.fsPath, format, startSeconds, endSeconds),
      );
      void vscode.window.showInformationMessage(`audioscope: exported ${path.basename(targetUri.fsPath)}`);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `audioscope export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async buildPayload(document: AudioscopeDocument, webview: vscode.Webview): Promise<AudioscopePayload> {
    let fileSize: number | null = null;

    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      fileSize = stat.size;
    } catch {
      fileSize = null;
    }

    const spectrogramQuality = vscode.workspace
      .getConfiguration('audioscope', document.uri)
      .get<'balanced' | 'high' | 'max'>('spectrogramQuality', 'high');
    const spectrogramDefaults = normalizeSpectrogramDefaults(
      vscode.workspace.getConfiguration('audioscope').get('spectrogramDefaults', DEFAULT_SPECTROGRAM_DEFAULTS),
    );
    const enableWebGpuRendering = vscode.workspace
      .getConfiguration('audioscope', document.uri)
      .get<boolean>('experimental.enableWebGpuRendering', false);
    const splitChannels = vscode.workspace
      .getConfiguration('audioscope', document.uri)
      .get<boolean>('experimental.splitChannels', false);
    const viewportSplitRatioSetting = Number(
      vscode.workspace.getConfiguration('audioscope', document.uri).get<number>('viewportSplitRatio', 0.5),
    );
    const viewportSplitRatio = Number.isFinite(viewportSplitRatioSetting)
      ? Math.min(1, Math.max(0, viewportSplitRatioSetting))
      : 0.5;
    const waveformAmplitudeMaxSetting = Number(
      vscode.workspace.getConfiguration('audioscope', document.uri).get<number>('waveformAmplitudeMax', 1),
    );
    const waveformAmplitudeMax = Number.isFinite(waveformAmplitudeMaxSetting)
      ? Math.min(1, Math.max(0.01, waveformAmplitudeMaxSetting))
      : 1;
    const playbackVolumeSetting = Number(
      vscode.workspace.getConfiguration('audioscope', document.uri).get<number>('playbackVolume', 1),
    );
    const playbackVolume = Number.isFinite(playbackVolumeSetting)
      ? Math.min(1, Math.max(0, playbackVolumeSetting))
      : 1;
    const externalTools = createInitialExternalToolStatus(document.uri);

    return {
      audioBytes: null,
      documentUri: document.uri.toString(),
      enableWebGpuRendering,
      splitChannels,
      viewportSplitRatio,
      waveformAmplitudeMax,
      playbackVolume,
      externalTools,
      fileExtension: path.posix.extname(document.uri.path).replace(/^\./, '').toLowerCase(),
      fileBacked: externalTools.fileBacked,
      fileName: path.posix.basename(document.uri.path),
      fileSize,
      isRemote: Boolean(vscode.env.remoteName),
      spectrogramDefaults,
      spectrogramQuality,
      sourceUri: webview.asWebviewUri(document.uri).toString(),
    };
  }
}
