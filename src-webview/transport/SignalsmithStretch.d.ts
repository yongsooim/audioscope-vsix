declare module '../vendor/SignalsmithStretch.mjs' {
  export interface SignalsmithStretchSchedule {
    active?: boolean;
    input?: number;
    loopEnd?: number;
    loopStart?: number;
    output?: number;
    rate?: number;
  }

  export interface SignalsmithStretchNode extends AudioWorkletNode {
    inputTime: number;
    addBuffers(buffers: Float32Array[]): Promise<number>;
    latency(): Promise<number>;
    schedule(schedule: SignalsmithStretchSchedule, adjustPrevious?: boolean): Promise<unknown>;
    setUpdateInterval(seconds: number, callback?: (seconds: number) => void): Promise<unknown>;
  }

  export default function SignalsmithStretch(
    audioContext: AudioContext,
    options?: AudioWorkletNodeOptions,
  ): Promise<SignalsmithStretchNode>;
}
