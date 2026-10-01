import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createInitialExternalToolStatus,
  decodeWithFfmpegAndLoudness,
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
  createResourceRevision,
  getCachedDecodeLoudnessPipeline,
  getCachedLoudnessSummary,
  getCachedMediaMetadata,
} from './mediaHostCache';
import { DEFAULT_SPECTROGRAM_DEFAULTS, KNOWN_AUDIO_EXTENSIONS } from './audioscope-editor/constants';
import { AudioscopeDocument } from './audioscope-editor/document';
import { evaluateAudioscopeTarget, getActiveResource } from './audioscope-editor/editorTarget';
import { normalizeSpectrogramDefaults } from './audioscope-editor/spectrogramDefaults';
import { getAudioscopeWebviewHtml } from './audioscope-editor/webviewHtml';
import { normalizePlaybackVolume } from './playbackVolume';

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

// Mirrors the webview's shouldPreferFfmpegDecode list: local files with these
// extensions are always decoded by the host before the webview fetches anything.
const HOST_PREFERRED_DECODE_EXTENSIONS = new Set([
  'aac',
  'aif',
  'aiff',
  'flac',
  'm4a',
  'mp3',
  'oga',
  'ogg',
  'opus',
  'wav',
  'wave',
]);

function shouldPrefetchHostDecode(resource: vscode.Uri): boolean {
  // Remote webviews fetch the compressed file and decode locally instead.
  if (vscode.env.remoteName) {
    return false;
  }

  const extension = path.posix.extname(resource.path).replace(/^\./, '').toLowerCase();
  if (!HOST_PREFERRED_DECODE_EXTENSIONS.has(extension)) {
    return false;
  }

  const toolStatus = createInitialExternalToolStatus(resource);
  return toolStatus.fileBacked && toolStatus.canDecodeFallback;
}

export class AudioscopeEditorProvider implements vscode.CustomReadonlyEditorProvider<AudioscopeDocument> {
  public static readonly viewType = 'audioscope.editor';
  public static readonly compareViewType = 'audioscope.compare';

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
      vscode.commands.registerCommand('audioscope.selectForCompare', (resource?: vscode.Uri) =>
        provider.selectForCompare(resource)),
      vscode.commands.registerCommand('audioscope.compareWithSelected', (resource?: vscode.Uri) =>
        provider.compareWithSelected(resource)),
      vscode.commands.registerCommand('audioscope.compareAudioFiles', (resource?: vscode.Uri, resources?: vscode.Uri[]) =>
        provider.compareAudioFiles(resource, resources)),
    );
  }

  private selectedForCompare: vscode.Uri | null = null;

  private constructor(
    private readonly context: vscode.ExtensionContext,
  ) {}

  private async selectForCompare(resource?: vscode.Uri): Promise<void> {
    const target = resource ?? getActiveResource();
    if (!target) {
      void vscode.window.showInformationMessage('Select or open an audio file first.');
      return;
    }

    this.selectedForCompare = target;
    await vscode.commands.executeCommand('setContext', 'audioscope.compareSelected', true);
  }

  private async compareWithSelected(resource?: vscode.Uri): Promise<void> {
    const target = resource ?? getActiveResource();
    if (!this.selectedForCompare) {
      void vscode.window.showInformationMessage('Run "Select for Audio Compare" on the reference file first.');
      return;
    }
    if (!target) {
      void vscode.window.showInformationMessage('Select or open the audio file to compare against.');
      return;
    }

    await this.openComparePanel(this.selectedForCompare, target);
  }

  // Explorer multi-select passes both files; otherwise the active file (if any)
  // is the reference and a picker supplies the rest.
  private async compareAudioFiles(resource?: vscode.Uri, resources?: vscode.Uri[]): Promise<void> {
    let pair = Array.isArray(resources) && resources.length === 2 ? resources : [];

    if (pair.length !== 2) {
      const reference = resource ?? getActiveResource();
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: !reference,
        defaultUri: reference?.with({ path: path.posix.dirname(reference.path) }),
        filters: { Audio: [...KNOWN_AUDIO_EXTENSIONS] },
        openLabel: reference ? 'Compare with reference' : 'Compare',
        title: reference
          ? `Compare ${path.posix.basename(reference.path)} with…`
          : 'Pick two audio files to compare',
      });
      if (!picked || picked.length === 0) {
        return;
      }

      pair = reference ? [reference, picked[0]] : picked.slice(0, 2);
      if (pair.length !== 2) {
        void vscode.window.showInformationMessage('Pick two audio files to compare.');
        return;
      }
    }

    await this.openComparePanel(pair[0], pair[1]);
  }

  private async openComparePanel(reference: vscode.Uri, candidate: vscode.Uri): Promise<void> {
    if (reference.toString() === candidate.toString()) {
      void vscode.window.showInformationMessage('Pick two different audio files to compare.');
      return;
    }

    for (const target of [reference, candidate]) {
      const decision = await evaluateAudioscopeTarget(target);
      if (decision.kind !== 'allow') {
        void vscode.window.showWarningMessage(
          `audioscope cannot compare ${path.posix.basename(target.path)}: ${decision.message}`,
        );
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      AudioscopeEditorProvider.compareViewType,
      `${path.posix.basename(reference.path)} ↔ ${path.posix.basename(candidate.path)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.attachAudioscopeWebview(reference, panel, candidate);
  }

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
    this.attachAudioscopeWebview(document.uri, webviewPanel, null);
  }

  // Shared by the custom editor (one file) and the compare panel (A = documentUri,
  // B = compareUri). Every message about "the file" refers to A; B has its own
  // compare* messages so the single-file flows stay untouched.
  private attachAudioscopeWebview(
    documentUri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
    compareUri: vscode.Uri | null,
  ): void {
    let externalToolStatusPromise: Promise<Awaited<ReturnType<typeof getExternalToolStatus>>> | null = null;
    let resourceRevision: ReturnType<typeof createResourceRevision> | null = null;
    let prefetchedDecodeRevision: ReturnType<typeof createResourceRevision> | null = null;
    let compareRevision: ReturnType<typeof createResourceRevision> | null = null;
    const getResourceRoot = (uri: vscode.Uri): vscode.Uri => uri.with({
      path: path.posix.dirname(uri.path),
      query: '',
      fragment: '',
    });

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        getResourceRoot(documentUri),
        ...(compareUri ? [getResourceRoot(compareUri)] : []),
      ],
    };
    webviewPanel.webview.html = getAudioscopeWebviewHtml(this.context, webviewPanel.webview);

    const getOrStartExternalToolStatus = (): Promise<Awaited<ReturnType<typeof getExternalToolStatus>>> => {
      if (!externalToolStatusPromise) {
        externalToolStatusPromise = getExternalToolStatus(documentUri);
      }

      return externalToolStatusPromise;
    };
    const getOrStartResourceRevision = (): ReturnType<typeof createResourceRevision> => {
      resourceRevision ??= createResourceRevision(documentUri);
      return resourceRevision;
    };
    const getOrStartCompareRevision = (uri: vscode.Uri): ReturnType<typeof createResourceRevision> => {
      compareRevision ??= createResourceRevision(uri);
      return compareRevision;
    };
    void getOrStartExternalToolStatus();
    if (shouldUseSharedHostDecodeLoudness(documentUri)) {
      void prewarmEmbeddedDirectDecodeModule().catch(() => {});
    }
    // Start decoding while the webview is still booting; its requestDecodeFallback
    // then joins this in-flight pipeline through the shared cache.
    if (shouldPrefetchHostDecode(documentUri)) {
      prefetchedDecodeRevision = getOrStartResourceRevision();
      void getCachedDecodeLoudnessPipeline(
        documentUri,
        () => decodeWithFfmpegAndLoudness(documentUri),
        prefetchedDecodeRevision.getKey(),
      ).catch(() => {});
    }
    if (compareUri && shouldPrefetchHostDecode(compareUri)) {
      void getCachedDecodeLoudnessPipeline(
        compareUri,
        () => decodeWithFfmpegAndLoudness(compareUri),
        getOrStartCompareRevision(compareUri).getKey(),
      ).catch(() => {});
    }

    let disposed = false;
    // ponytail: iconPath can't render an emoji, so the play/pause state lives in
    // the tab title text. It goes AFTER the name so the (proportional UI-font)
    // width difference between ⏵/⏸ only moves the trailing icon, never the name.
    // Shows ⏸ until the webview reports playback.
    const baseTitle = compareUri
      ? `${path.posix.basename(documentUri.path)} ↔ ${path.posix.basename(compareUri.path)}`
      : path.posix.basename(documentUri.path);
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
      const payload = await this.buildPayload(
        documentUri,
        webviewPanel.webview,
        getOrStartResourceRevision().getFileSize(),
        compareUri,
        compareUri ? getOrStartCompareRevision(compareUri).getFileSize() : null,
      );
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
        case 'reload': {
          // The first ready reuses the prefetch revision so its cache key is not
          // recomputed; reloads always re-stat the file.
          if (message.type !== 'ready' || resourceRevision !== prefetchedDecodeRevision) {
            resourceRevision = createResourceRevision(documentUri);
            compareRevision = null;
          }
          prefetchedDecodeRevision = null;
          await postAudioPayload();
          return;
        }

        case 'persistSpectrogramDefaults': {
          const nextDefaults = normalizeSpectrogramDefaults(message.body);
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('spectrogramDefaults', nextDefaults, vscode.ConfigurationTarget.Global);
          return;
        }

        case 'persistSplitChannels': {
          await vscode.workspace
            .getConfiguration('audioscope')
            .update('splitChannels', Boolean(message.body?.enabled), vscode.ConfigurationTarget.Global);
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
            .update('playbackVolume', normalizePlaybackVolume(volume), vscode.ConfigurationTarget.Global);
          return;
        }

        case 'exportAudio': {
          await this.exportAudio(documentUri, message.body);
          return;
        }

        case 'requestMediaMetadata': {
          const loadToken = Number(message.body?.loadToken) || 0;
          try {
            const metadata = await getCachedMediaMetadata(
              documentUri,
              () => getMediaMetadata(documentUri),
              getOrStartResourceRevision().getKey(),
            );
            await postIfAlive({
              type: 'mediaMetadataReady',
              body: { loadToken, metadata },
            });
          } catch (error) {
            const toolStatus = await getExternalToolStatus(documentUri);
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
            const pipeline = await getCachedDecodeLoudnessPipeline(
              documentUri,
              () => decodeWithFfmpegAndLoudness(documentUri),
              getOrStartResourceRevision().getKey(),
            );
            void pipeline.loudnessPromise
              .then((summary) => postIfAlive({
                type: 'loudnessSummaryReady',
                body: { ...summary, loadToken },
              }))
              .catch((error) => postIfAlive({
                type: 'loudnessSummaryError',
                body: {
                  loadToken,
                  message: error instanceof Error ? error.message : String(error),
                },
              }));
            await postIfAlive({
              type: 'decodeFallbackReady',
              body: { ...pipeline.decode, loadToken },
            });
          } catch (error) {
            const toolStatus = await getExternalToolStatus(documentUri);
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
              documentUri,
              () => getLoudnessSummary(documentUri),
              getOrStartResourceRevision().getKey(),
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

        case 'requestCompareSource': {
          const loadToken = Number(message.body?.loadToken) || 0;
          if (!compareUri) {
            return;
          }
          const revision = getOrStartCompareRevision(compareUri);
          void getCachedMediaMetadata(compareUri, () => getMediaMetadata(compareUri), revision.getKey())
            .then((metadata) => postIfAlive({ type: 'compareMetadataReady', body: { loadToken, metadata } }))
            .catch(() => {});
          try {
            const toolStatus = createInitialExternalToolStatus(compareUri);
            if (!toolStatus.fileBacked || !toolStatus.canDecodeFallback) {
              throw new Error('Comparison needs both files on a filesystem the extension host can read.');
            }
            const pipeline = await getCachedDecodeLoudnessPipeline(
              compareUri,
              () => decodeWithFfmpegAndLoudness(compareUri),
              revision.getKey(),
            );
            void pipeline.loudnessPromise
              .then((summary) => postIfAlive({ type: 'compareLoudnessReady', body: { ...summary, loadToken } }))
              .catch(() => {});
            await postIfAlive({
              type: 'compareSourceReady',
              body: { ...pipeline.decode, loadToken },
            });
          } catch (error) {
            await postIfAlive({
              type: 'compareSourceError',
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

        case 'copySelectionCsv': {
          const csv = message.body?.csv;
          if (typeof csv === 'string'
            && (csv.startsWith('frequency_hz,level_dbfs\n') || csv.startsWith('metric,value\n'))
            && csv.length <= 250_000) {
            await vscode.env.clipboard.writeText(csv);
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

  private async exportAudio(documentUri: vscode.Uri, body: ExportAudioMessage['body']): Promise<void> {
    const format = body?.format;
    if (format !== 'wav' && format !== 'mp3' && format !== 'm4a' && format !== 'flac') {
      return;
    }

    const startSeconds = Number(body?.startSeconds);
    const endSeconds = Number(body?.endSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || !(endSeconds > startSeconds) || startSeconds < 0) {
      return;
    }

    const sourceBaseName = path.posix.basename(documentUri.path).replace(/\.[^.]+$/u, '') || 'audio';
    const defaultName = `${sourceBaseName}_${startSeconds.toFixed(2)}s-${endSeconds.toFixed(2)}s.${format}`;
    const defaultUri = documentUri.scheme === 'file'
      ? vscode.Uri.file(path.join(path.dirname(documentUri.fsPath), defaultName))
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
        () => exportAudioSegment(documentUri, targetUri.fsPath, format, startSeconds, endSeconds),
      );
      void vscode.window.showInformationMessage(`audioscope: exported ${path.basename(targetUri.fsPath)}`);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `audioscope export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async buildPayload(
    documentUri: vscode.Uri,
    webview: vscode.Webview,
    fileSizePromise: Promise<number | null>,
    compareUri: vscode.Uri | null = null,
    compareFileSizePromise: Promise<number | null> | null = null,
  ): Promise<AudioscopePayload> {
    const [fileSize, compareFileSize] = await Promise.all([fileSizePromise, compareFileSizePromise]);

    const spectrogramQuality = vscode.workspace
      .getConfiguration('audioscope', documentUri)
      .get<'balanced' | 'high' | 'max'>('spectrogramQuality', 'high');
    const spectrogramDefaults = normalizeSpectrogramDefaults(
      vscode.workspace.getConfiguration('audioscope').get('spectrogramDefaults', DEFAULT_SPECTROGRAM_DEFAULTS),
    );
    const channelConfiguration = vscode.workspace.getConfiguration('audioscope', documentUri);
    const channelSetting = channelConfiguration.inspect<boolean>('splitChannels');
    // Keep previously saved channel preferences until the regular setting is set.
    const splitChannels = channelSetting?.workspaceFolderValue
      ?? channelSetting?.workspaceValue
      ?? channelSetting?.globalValue
      ?? channelConfiguration.get<boolean>('experimental.splitChannels', false);
    const viewportSplitRatioSetting = Number(
      vscode.workspace.getConfiguration('audioscope', documentUri).get<number>('viewportSplitRatio', 0.5),
    );
    const viewportSplitRatio = Number.isFinite(viewportSplitRatioSetting)
      ? Math.min(1, Math.max(0, viewportSplitRatioSetting))
      : 0.5;
    const waveformAmplitudeMaxSetting = Number(
      vscode.workspace.getConfiguration('audioscope', documentUri).get<number>('waveformAmplitudeMax', 1),
    );
    const waveformAmplitudeMax = Number.isFinite(waveformAmplitudeMaxSetting)
      ? Math.min(1, Math.max(0.01, waveformAmplitudeMaxSetting))
      : 1;
    const playbackVolumeSetting = Number(
      vscode.workspace.getConfiguration('audioscope', documentUri).get<number>('playbackVolume', 1),
    );
    const playbackVolume = normalizePlaybackVolume(playbackVolumeSetting);
    const externalTools = createInitialExternalToolStatus(documentUri);

    return {
      audioBytes: null,
      compare: compareUri
        ? {
          documentUri: compareUri.toString(),
          fileExtension: path.posix.extname(compareUri.path).replace(/^\./, '').toLowerCase(),
          fileName: path.posix.basename(compareUri.path),
          fileSize: compareFileSize ?? null,
        }
        : null,
      documentUri: documentUri.toString(),
      splitChannels,
      viewportSplitRatio,
      waveformAmplitudeMax,
      playbackVolume,
      externalTools,
      fileExtension: path.posix.extname(documentUri.path).replace(/^\./, '').toLowerCase(),
      fileBacked: externalTools.fileBacked,
      fileName: path.posix.basename(documentUri.path),
      fileSize,
      isRemote: Boolean(vscode.env.remoteName),
      spectrogramDefaults,
      spectrogramQuality,
      sourceUri: webview.asWebviewUri(documentUri).toString(),
    };
  }
}
