import * as vscode from 'vscode';
import { AudioscopeEditorProvider } from './audioscopeEditor';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(AudioscopeEditorProvider.register(context));
  void maybeOpenBundledSample(context);
}

export function deactivate(): void {}

let didAttemptStartupAudioscopeOpen = false;

async function maybeOpenBundledSample(context: vscode.ExtensionContext): Promise<void> {
  if (didAttemptStartupAudioscopeOpen || context.extensionMode !== vscode.ExtensionMode.Development) {
    return;
  }

  didAttemptStartupAudioscopeOpen = true;

  const enabled = vscode.workspace
    .getConfiguration('audioscope')
    .get<boolean>('openSampleOnStartupInDevelopment', true);

  if (!enabled) {
    return;
  }

  const sampleUri = vscode.Uri.joinPath(context.extensionUri, 'exampleFiles', 'sample-tone.wav');

  try {
    await vscode.workspace.fs.stat(sampleUri);
    await vscode.commands.executeCommand('vscode.openWith', sampleUri, AudioscopeEditorProvider.viewType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`audioscope could not open the bundled sample file: ${message}`);
  }
}
