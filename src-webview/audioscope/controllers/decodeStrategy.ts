export type DecodeFallbackTarget = 'host-worker' | 'webview-worker';

export function selectDecodeFallbackTarget({
  sourceBytes,
}: {
  sourceBytes: unknown;
}): DecodeFallbackTarget {
  return sourceBytes instanceof ArrayBuffer ? 'webview-worker' : 'host-worker';
}
