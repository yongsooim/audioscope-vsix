export interface DebugTimelineEventPayload {
  detail?: string;
  label: string;
  loadToken?: number;
  source: 'host' | 'webview' | 'waveform-worker' | 'analysis-worker' | 'decode-worker';
  timeMs: number;
}

let extensionActivatedAtMs = Date.now();

export function noteExtensionActivated(): void {
  extensionActivatedAtMs = Date.now();
}

export function getExtensionActivatedAtMs(): number {
  return extensionActivatedAtMs;
}

export function createHostDebugTimelineEvent(label: string, detail?: string, loadToken?: number): DebugTimelineEventPayload {
  return {
    detail,
    label,
    loadToken,
    source: 'host',
    timeMs: Date.now(),
  };
}
