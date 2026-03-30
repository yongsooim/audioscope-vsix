import * as vscode from 'vscode';
import { WaveScopeEditorProvider } from './waveScopeEditor';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(WaveScopeEditorProvider.register(context));
  void maybeOpenBundledSample(context);
}

export function deactivate(): void {}

let didAttemptStartupWaveScopeOpen = false;

async function maybeOpenBundledSample(context: vscode.ExtensionContext): Promise<void> {
  if (didAttemptStartupWaveScopeOpen || context.extensionMode !== vscode.ExtensionMode.Development) {
    return;
  }

  didAttemptStartupWaveScopeOpen = true;

  const enabled = vscode.workspace
    .getConfiguration('waveScope')
    .get<boolean>('openSampleOnStartupInDevelopment', true);

  if (!enabled) {
    return;
  }

  const sampleUri = vscode.Uri.joinPath(context.extensionUri, 'exampleFiles', 'sample-tone.wav');

  try {
    await vscode.workspace.fs.stat(sampleUri);
    await vscode.commands.executeCommand('vscode.openWith', sampleUri, WaveScopeEditorProvider.viewType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Wave Scope could not open the bundled sample file: ${message}`);
  }
}
