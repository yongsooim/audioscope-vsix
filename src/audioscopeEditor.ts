import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createInitialExternalToolStatus,
  decodeWithFfmpeg,
  getExternalToolStatus,
  getLoudnessSummary,
  getMediaMetadata,
  startDecodeAndSummarizeWithFfmpeg,
  type AudioscopePayload,
} from './externalAudioTools';
import {
  getCachedDecodeFallback,
  getCachedHostDecodeLoudnessPipeline,
  getCachedLoudnessSummary,
  getCachedMediaMetadata,
  peekCachedHostDecodeLoudnessPipeline,
} from './mediaHostCache';
import { DEFAULT_SPECTROGRAM_DEFAULTS } from './audioscope-editor/constants';
import { AudioscopeDocument } from './audioscope-editor/document';
import { canOpenInAudioscope, getActiveResource } from './audioscope-editor/editorTarget';
import { cloneDecodeFallbackPayload } from './audioscope-editor/payloadClone';
import { normalizeSpectrogramDefaults } from './audioscope-editor/spectrogramDefaults';
import { getAudioscopeWebviewHtml } from './audioscope-editor/webviewHtml';

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
    webviewPanel.webview.html = getAudioscopeWebviewHtml(this.context, webviewPanel.webview);

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

      if (message?.type === 'persistSpectrogramDefaults') {
        const nextDefaults = normalizeSpectrogramDefaults(message.body);
        await vscode.workspace
          .getConfiguration('audioscope')
          .update('spectrogramDefaults', nextDefaults, vscode.ConfigurationTarget.Global);
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
          let fallback;

          try {
            const sharedAnalysis = await getCachedHostDecodeLoudnessPipeline(
              document.uri,
              () => startDecodeAndSummarizeWithFfmpeg(document.uri),
            );
            fallback = sharedAnalysis.decodeFallback;
            void sharedAnalysis.loudnessSummaryPromise.catch(() => {});
          } catch {
            fallback = await getCachedDecodeFallback(
              document.uri,
              () => decodeWithFfmpeg(document.uri),
            );
          }

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
          const sharedAnalysis = await peekCachedHostDecodeLoudnessPipeline(document.uri);
          const summary = sharedAnalysis
            ? await sharedAnalysis.loudnessSummaryPromise
            : shouldUseSharedHostDecodeLoudness(document.uri)
              ? await (await getCachedHostDecodeLoudnessPipeline(
                  document.uri,
                  () => startDecodeAndSummarizeWithFfmpeg(document.uri),
                )).loudnessSummaryPromise
              : await getCachedLoudnessSummary(
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
    const externalTools = createInitialExternalToolStatus(document.uri);

    return {
      audioBytes: null,
      documentUri: document.uri.toString(),
      externalTools,
      fileExtension: path.posix.extname(document.uri.path).replace(/^\./, '').toLowerCase(),
      fileBacked: externalTools.fileBacked,
      fileName: path.posix.basename(document.uri.path),
      fileSize,
      spectrogramDefaults,
      spectrogramQuality,
      sourceUri: webview.asWebviewUri(document.uri).toString(),
    };
  }
}
