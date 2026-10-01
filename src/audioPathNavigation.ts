import * as path from 'node:path';
import * as vscode from 'vscode';
import { findAudioPathAtPosition } from './audioPaths';

const OPEN_PATH_COMMAND = 'audioscope.openAudioPathAtCursor';

export function audioPathCandidates(value: string, source: vscode.Uri): vscode.Uri[] {
  if (/^file:\/\//i.test(value)) {
    const uri = vscode.Uri.parse(value);
    return uri.query || uri.fragment ? [] : [uri];
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    if (source.scheme === 'vscode-remote') {
      return [source.with({ path: normalized.startsWith('/') ? normalized : `/${normalized}`, query: '', fragment: '' })];
    }
    return [vscode.Uri.file(normalized)];
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const sourceFolder = vscode.workspace.getWorkspaceFolder(source);
  const bases = [
    ...(source.scheme === 'file' || source.scheme === 'vscode-remote'
      ? [source.with({ path: path.posix.dirname(source.path), query: '', fragment: '' })] : []),
    ...(sourceFolder ? [sourceFolder.uri] : []),
    ...folders.map((folder) => folder.uri),
  ];
  const candidates = bases.map((base) => vscode.Uri.joinPath(base, normalized));
  return candidates.filter((uri, index) => candidates.findIndex((other) => other.toString() === uri.toString()) === index);
}

export function registerAudioPathNavigation(): vscode.Disposable {
  const enabled = (document: vscode.TextDocument) => vscode.workspace
    .getConfiguration('audioscope', document.uri).get<boolean>('audioPathNavigation.enabled', true);

  return vscode.Disposable.from(
    vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'vscode-remote' }, { scheme: 'untitled' }], {
      provideHover(document, position) {
        if (!enabled(document)) {
          return undefined;
        }
        const match = findAudioPathAtPosition(document.lineAt(position.line).text, position.character);
        if (!match) {
          return undefined;
        }
        // Resolve only after a click. Large manifests never trigger background file-system probes.
        const args = encodeURIComponent(JSON.stringify([document.uri.toString(), position.line, position.character]));
        const contents = new vscode.MarkdownString(`[Open in audioscope](command:${OPEN_PATH_COMMAND}?${args})`);
        contents.isTrusted = { enabledCommands: [OPEN_PATH_COMMAND] };
        return new vscode.Hover(contents, new vscode.Range(position.line, match.start, position.line, match.end));
      },
    }),
    vscode.commands.registerCommand(OPEN_PATH_COMMAND, async (source?: unknown, line?: unknown, character?: unknown) => {
      const editor = vscode.window.activeTextEditor;
      // Hover arguments identify an already-open document; re-read its current text on activation.
      const document = source === undefined ? editor?.document : vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === source,
      );
      const position = source === undefined ? editor?.selection.active
        : Number.isInteger(line) && Number.isInteger(character) && Number(line) >= 0 && Number(character) >= 0
          ? new vscode.Position(Number(line), Number(character)) : undefined;
      if (!document || !position || position.line >= document.lineCount || !enabled(document)) {
        return;
      }
      const match = findAudioPathAtPosition(document.lineAt(position.line).text, position.character);
      if (!match) {
        void vscode.window.showInformationMessage('Place the cursor on an audio file path first.');
        return;
      }
      try {
        for (const candidate of audioPathCandidates(match.path, document.uri)) {
          let stat: vscode.FileStat;
          try { stat = await vscode.workspace.fs.stat(candidate); } catch { continue; }
          if ((stat.type & vscode.FileType.File) === 0) {
            continue;
          }
          await vscode.commands.executeCommand('audioscope.openActiveFileInAudioscope', candidate);
          return;
        }
        void vscode.window.showWarningMessage(`Audio file not found: ${match.path}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`audioscope could not open this path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}
