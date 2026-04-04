export {};

declare global {
  interface VsCodeApi<TState = unknown> {
    getState(): TState | undefined;
    postMessage(message: unknown): void;
    setState(state: TState): void;
  }

  function acquireVsCodeApi<TState = unknown>(): VsCodeApi<TState>;

  const currentTime: number;
  const sampleRate: number;

  abstract class AudioWorkletProcessor {
    protected constructor(options?: unknown);
    readonly port: MessagePort;
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  }

  function registerProcessor(
    name: string,
    processorCtor: new (options?: unknown) => AudioWorkletProcessor,
  ): void;

  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
