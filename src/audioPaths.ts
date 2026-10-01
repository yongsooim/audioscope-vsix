import { KNOWN_AUDIO_EXTENSIONS } from './audioscope-editor/constants';

export const MAX_AUDIO_PATH_LINE_LENGTH = 20_000;

export interface AudioPathMatch {
  path: string;
  start: number;
  end: number;
}

export function isAudioPath(value: string): boolean {
  if (!value || /[\x00-\x1f*?\[\]]/.test(value) || value.startsWith('~')) {
    return false;
  }
  // Text navigation opens workspace files, never URLs or executable URI schemes.
  if (/^[a-z][\w+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value) && !/^file:\/\//i.test(value)) {
    return false;
  }
  const name = value.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && KNOWN_AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Scan only the requested line. Quoted paths may contain spaces; JSON escapes are decoded. */
export function findAudioPathAtPosition(line: string, character: number): AudioPathMatch | undefined {
  if (line.length > MAX_AUDIO_PATH_LINE_LENGTH || character < 0 || character > line.length) {
    return undefined;
  }
  const tokens = /"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\s"'`<>{},;|=()[\]]+/g;
  for (const match of line.matchAll(tokens)) {
    const token = match[0];
    const quoted = /^["'`]/.test(token);
    const start = match.index + (quoted ? 1 : 0);
    const end = match.index + token.length - (quoted ? 1 : 0);
    if (character < start || character > end) {
      continue;
    }
    let value = quoted ? token.slice(1, -1) : token;
    if (token.startsWith('"')) {
      try { value = JSON.parse(token); } catch { /* A quoted path need not be JSON. */ }
    }
    if (isAudioPath(value)) {
      return { path: value, start, end };
    }
  }
  return undefined;
}
