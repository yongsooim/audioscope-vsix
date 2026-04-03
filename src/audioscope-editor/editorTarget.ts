import * as path from 'node:path';
import * as vscode from 'vscode';
import { probeAudioOpen } from '../externalAudioTools';
import { KNOWN_AUDIO_EXTENSIONS } from './constants';

export async function canOpenInAudioscope(target: vscode.Uri): Promise<boolean> {
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

export function getActiveResource(): vscode.Uri | undefined {
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
