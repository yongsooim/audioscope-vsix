interface VsCodeApi<TState = unknown> {
  getState(): TState | undefined;
  postMessage(message: unknown): void;
  setState(state: TState): void;
}

declare function acquireVsCodeApi<TState = unknown>(): VsCodeApi<TState>;
