import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

class Uri {
  constructor(readonly scheme: string, readonly authority: string, readonly path: string, readonly query = '', readonly fragment = '') {}
  static parse(value: string) {
    const url = new URL(value);
    return new Uri(url.protocol.slice(0, -1), url.host, decodeURIComponent(url.pathname), url.search.slice(1), url.hash.slice(1));
  }
  static file(value: string) { return new Uri('file', '', value.startsWith('/') ? value : `/${value}`); }
  static joinPath(base: Uri, value: string) { return base.with({ path: path.posix.join(base.path, value) }); }
  with(changes: Partial<Uri>) { return new Uri(changes.scheme ?? this.scheme, changes.authority ?? this.authority, changes.path ?? this.path, changes.query ?? this.query, changes.fragment ?? this.fragment); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

let hoverProvider: any;
let openPath: (...args: unknown[]) => Promise<void>;
let enabled = true;
const probes: string[] = [];
const opened: Uri[] = [];
const warnings: string[] = [];
const existingFiles = new Set<string>();
const document = {
  uri: Uri.parse('vscode-remote://ssh-remote+audio/work/project/manifests/train.jsonl'),
  lineCount: 1,
  text: '"clips/voice one.wav"',
  lineAt: () => ({ text: document.text }),
};
const workspace = {
  workspaceFolders: [{ uri: Uri.parse('vscode-remote://ssh-remote+audio/work/project') }],
  getWorkspaceFolder: () => workspace.workspaceFolders[0],
  getConfiguration: () => ({ get: () => enabled }),
  textDocuments: [document],
  fs: { stat: async (uri: Uri) => {
    probes.push(uri.toString());
    if (!existingFiles.has(uri.toString())) { throw new Error('not found'); }
    return { type: 1 };
  } },
};
const vscode = {
  Uri,
  FileType: { File: 1 },
  Disposable: { from: (...values: unknown[]) => values },
  Position: class { constructor(public line: number, public character: number) {} },
  Range: class { constructor(..._values: unknown[]) {} },
  MarkdownString: class { isTrusted: unknown; constructor(public value: string) {} },
  Hover: class { constructor(public contents: unknown, public range: unknown) {} },
  languages: { registerHoverProvider: (_selector: unknown, provider: unknown) => { hoverProvider = provider; } },
  commands: {
    registerCommand: (_id: string, callback: typeof openPath) => { openPath = callback; },
    executeCommand: async (id: string, uri: Uri) => {
      assert.equal(id, 'audioscope.openActiveFileInAudioscope');
      opened.push(uri);
    },
  },
  workspace,
  window: {
    activeTextEditor: { document, selection: { active: { line: 0, character: 10 } } },
    showInformationMessage: (message: string) => warnings.push(message),
    showWarningMessage: (message: string) => warnings.push(message),
    showErrorMessage: (message: string) => warnings.push(message),
  },
};
const require = createRequire(import.meta.url);
const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
let navigation: any;
try {
  nodeModule._load = function (request: string, ...args: unknown[]) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...args);
  };
  navigation = require('../src/audioPathNavigation.ts');
} finally {
  nodeModule._load = originalLoad;
}
navigation.registerAudioPathNavigation();

test.beforeEach(() => {
  enabled = true;
  probes.length = opened.length = warnings.length = 0;
  existingFiles.clear();
  document.text = '"clips/voice one.wav"';
});

test('relative and absolute paths preserve the remote workspace authority', () => {
  const relative = navigation.audioPathCandidates('../voice.wav', document.uri).map((uri: Uri) => uri.toString());
  assert.deepEqual(relative, [
    'vscode-remote://ssh-remote+audio/work/project/voice.wav',
    'vscode-remote://ssh-remote+audio/work/voice.wav',
  ]);
  assert.equal(navigation.audioPathCandidates('/dataset/voice.wav', document.uri)[0].toString(),
    'vscode-remote://ssh-remote+audio/dataset/voice.wav');
  assert.equal(navigation.audioPathCandidates('C:\\audio\\voice.wav', Uri.file('/project/log.txt'))[0].path, '/C:/audio/voice.wav');
  assert.equal(navigation.audioPathCandidates('file:///audio/voice%20one.wav', document.uri)[0].path, '/audio/voice one.wav');
});

test('hover performs no file reads and trusts only the audio-path command', () => {
  const hover = hoverProvider.provideHover(document, { line: 0, character: 10 });
  assert.deepEqual(hover.contents.isTrusted, { enabledCommands: ['audioscope.openAudioPathAtCursor'] });
  assert.match(hover.contents.value, /Open in audioscope/);
  assert.deepEqual(probes, []);
});

test('opening resolves relative to the document before trying the workspace root', async () => {
  const target = 'vscode-remote://ssh-remote+audio/work/project/clips/voice one.wav';
  existingFiles.add(target);
  await openPath();
  assert.deepEqual(probes, [
    'vscode-remote://ssh-remote+audio/work/project/manifests/clips/voice one.wav', target,
  ]);
  assert.deepEqual(opened.map((uri) => uri.toString()), [target]);
  assert.deepEqual(warnings, []);
});

test('disabled navigation and unknown document arguments cannot open files', async () => {
  enabled = false;
  assert.equal(hoverProvider.provideHover(document, { line: 0, character: 10 }), undefined);
  await openPath();
  enabled = true;
  await openPath('file:///unknown.json', 0, 10);
  await openPath(document.uri.toString(), -1, 10);
  assert.deepEqual(probes, []);
});

test('a hover action revalidates current text and reports missing files', async () => {
  document.text = '"https://host/voice.wav"';
  await openPath(document.uri.toString(), 0, 10);
  assert.deepEqual(probes, []);
  document.text = '"missing.wav"';
  await openPath(document.uri.toString(), 0, 3);
  assert.equal(opened.length, 0);
  assert.match(warnings.at(-1)!, /Audio file not found: missing.wav/);
});
