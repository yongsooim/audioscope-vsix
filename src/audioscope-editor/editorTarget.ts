import * as path from 'node:path';
import * as vscode from 'vscode';
import { probeAudioOpen } from '../externalAudioTools';
import { KNOWN_AUDIO_EXTENSIONS } from './constants';

export type AudioscopeOpenDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: 'not-audio' | 'unsupported'; message: string }
  | { kind: 'error'; message: string };

export async function evaluateAudioscopeTarget(
  target: vscode.Uri,
): Promise<AudioscopeOpenDecision> {
  const fileExtension = path.posix.extname(target.path).replace(/^\./, '').toLowerCase();

  if (KNOWN_AUDIO_EXTENSIONS.has(fileExtension)) {
    return { kind: 'allow' };
  }

  try {
    const result = await probeAudioOpen(target);

    if (result.kind === 'audio') {
      return { kind: 'allow' };
    }

    return {
      kind: 'deny',
      reason: result.kind === 'not-audio' ? 'not-audio' : 'unsupported',
      message: result.message,
    };
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
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
