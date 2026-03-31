import { AUDIO_TRANSPORT_PROCESSOR_NAME } from './audioTransportShared';

const SNAPSHOT_INTERVAL_QUANTA = 8;

interface ProcessorControlBody {
  loopEnabled?: boolean;
  loopEndFrame?: number;
  loopStartFrame?: number;
  playing?: boolean;
  seekFrame?: number | null;
  seekSerial?: number | null;
}

interface ProcessorMessage {
  body?: ProcessorControlBody;
  type?: string;
}

interface ProcessorOptionsPayload {
  channelBuffers?: ArrayBuffer[];
  durationSeconds?: number;
  initialFrame?: number;
  initialLoopEnabled?: boolean;
  initialLoopEndFrame?: number;
  initialLoopStartFrame?: number;
  initialPlaying?: boolean;
  initialSeekSerial?: number;
  sourceLength?: number;
  sourceSampleRate?: number;
}

interface ProcessorCtorOptions {
  processorOptions?: ProcessorOptionsPayload;
}

class AudioscopeAudioTransportProcessor extends AudioWorkletProcessor {
  private channelData: Float32Array[];
  private durationSeconds: number;
  private ended: boolean;
  private lastPublishedEnded: boolean;
  private lastPublishedFrame: number;
  private lastPublishedPlaying: boolean;
  private lastSeekSerial: number;
  private loopEnabled: boolean;
  private loopEndFrame: number;
  private loopStartFrame: number;
  private playing: boolean;
  private positionFrame: number;
  private snapshotCountdown: number;
  private sourceLength: number;
  private sourceSampleRate: number;

  constructor(options?: ProcessorCtorOptions) {
    super();

    const processorOptions = options?.processorOptions ?? {};
    this.channelData = Array.isArray(processorOptions.channelBuffers)
      ? processorOptions.channelBuffers.map((buffer) => new Float32Array(buffer))
      : [];
    this.sourceLength = Math.max(0, Math.trunc(Number(processorOptions.sourceLength) || 0));
    this.sourceSampleRate = Math.max(1, Number(processorOptions.sourceSampleRate) || sampleRate || 1);
    this.durationSeconds = Number.isFinite(processorOptions.durationSeconds)
      ? Math.max(0, Number(processorOptions.durationSeconds))
      : (this.sourceLength / this.sourceSampleRate);
    this.positionFrame = clampFrame(Number(processorOptions.initialFrame) || 0, this.sourceLength);
    this.playing = Boolean(processorOptions.initialPlaying);
    this.loopEnabled = Boolean(processorOptions.initialLoopEnabled);
    this.loopStartFrame = normalizeLoopStartFrame(Number(processorOptions.initialLoopStartFrame) || 0, this.sourceLength);
    this.loopEndFrame = normalizeLoopEndFrame(
      Number(processorOptions.initialLoopEndFrame) || this.sourceLength,
      this.loopStartFrame,
      this.sourceLength,
    );
    this.ended = false;
    this.lastSeekSerial = Number.isFinite(processorOptions.initialSeekSerial)
      ? Math.trunc(Number(processorOptions.initialSeekSerial))
      : 0;
    this.snapshotCountdown = SNAPSHOT_INTERVAL_QUANTA;
    this.lastPublishedFrame = -1;
    this.lastPublishedPlaying = this.playing;
    this.lastPublishedEnded = this.ended;

    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.publishState(true);
  }

  handleMessage(message: ProcessorMessage): void {
    if (message?.type !== 'setControl') {
      return;
    }

    const body = message.body ?? {};
    const loopEnabled = Boolean(body.loopEnabled);
    const loopStartFrame = normalizeLoopStartFrame(Number(body.loopStartFrame) || 0, this.sourceLength);
    const loopEndFrame = normalizeLoopEndFrame(
      Number(body.loopEndFrame) || this.sourceLength,
      loopStartFrame,
      this.sourceLength,
    );
    const seekSerial = Number.isFinite(body.seekSerial) ? Math.trunc(Number(body.seekSerial)) : null;

    this.loopEnabled = loopEnabled;
    this.loopStartFrame = loopStartFrame;
    this.loopEndFrame = loopEndFrame;

    if (seekSerial !== null && seekSerial !== this.lastSeekSerial) {
      this.lastSeekSerial = seekSerial;
      this.positionFrame = clampFrame(Number(body.seekFrame) || 0, this.sourceLength);
      this.ended = false;
    }

    this.playing = Boolean(body.playing);

    if (this.loopEnabled && this.positionFrame >= this.loopEndFrame) {
      this.positionFrame = this.loopStartFrame;
    }

    this.publishState(true);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];

    if (!output || output.length === 0) {
      return true;
    }

    const quantumLength = output[0]?.length ?? 0;

    if (!this.playing || this.sourceLength <= 0 || quantumLength <= 0) {
      fillSilence(output);
      this.publishState(false);
      return true;
    }

    const sourceChannels = this.channelData.length;
    const sourceStep = this.sourceSampleRate / Math.max(1, sampleRate || this.sourceSampleRate);

    for (let frameIndex = 0; frameIndex < quantumLength; frameIndex += 1) {
      if (!this.playing) {
        zeroRemainingFrames(output, frameIndex);
        break;
      }

      if (this.positionFrame >= this.sourceLength) {
        this.finishPlayback();
        zeroRemainingFrames(output, frameIndex);
        break;
      }

      const sampleIndex = Math.max(0, Math.min(this.positionFrame, Math.max(0, this.sourceLength - 1)));
      const baseIndex = Math.floor(sampleIndex);
      const nextIndex = Math.min(this.sourceLength - 1, baseIndex + 1);
      const fraction = clampUnit(sampleIndex - baseIndex);

      for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
        const outputChannel = output[channelIndex];
        const sourceChannel = this.channelData[Math.min(channelIndex, Math.max(0, sourceChannels - 1))];

        if (!(sourceChannel instanceof Float32Array) || sourceChannel.length === 0) {
          outputChannel[frameIndex] = 0;
          continue;
        }

        const currentSample = sourceChannel[baseIndex] ?? 0;
        const nextSample = sourceChannel[nextIndex] ?? currentSample;
        outputChannel[frameIndex] = currentSample + ((nextSample - currentSample) * fraction);
      }

      this.advanceFrame(sourceStep);
    }

    this.publishState(false);
    return true;
  }

  advanceFrame(sourceStep: number): void {
    if (this.loopEnabled && this.loopEndFrame > this.loopStartFrame) {
      const loopSpan = this.loopEndFrame - this.loopStartFrame;
      const nextFrame = this.positionFrame + sourceStep;

      if (nextFrame >= this.loopEndFrame) {
        this.positionFrame = this.loopStartFrame + positiveModulo(nextFrame - this.loopStartFrame, loopSpan);
        return;
      }

      this.positionFrame = nextFrame;
      return;
    }

    const nextFrame = this.positionFrame + sourceStep;

    if (nextFrame >= this.sourceLength) {
      this.finishPlayback();
      return;
    }

    this.positionFrame = nextFrame;
  }

  finishPlayback(): void {
    this.positionFrame = this.sourceLength;

    if (!this.playing && this.ended) {
      return;
    }

    this.playing = false;
    this.ended = true;
    this.publishState(true);
    this.port.postMessage({
      type: 'ended',
      body: {
        currentFrame: Math.max(0, this.sourceLength),
        durationSeconds: this.durationSeconds,
      },
    });
  }

  publishState(force: boolean): void {
    const currentFrame = clampFrame(Math.floor(this.positionFrame), this.sourceLength);

    const changed = force
      || currentFrame !== this.lastPublishedFrame
      || this.playing !== this.lastPublishedPlaying
      || this.ended !== this.lastPublishedEnded;

    if (!changed) {
      return;
    }

    this.snapshotCountdown -= 1;

    if (!force && this.snapshotCountdown > 0) {
      return;
    }

    this.snapshotCountdown = SNAPSHOT_INTERVAL_QUANTA;
    this.lastPublishedFrame = currentFrame;
    this.lastPublishedPlaying = this.playing;
    this.lastPublishedEnded = this.ended;

    this.port.postMessage({
      type: 'state',
      body: {
        contextTime: currentTime,
        currentFrame,
        ended: this.ended,
        playing: this.playing,
      },
    });
  }
}

function fillSilence(output: Float32Array[]): void {
  for (const channel of output) {
    channel.fill(0);
  }
}

function zeroRemainingFrames(output: Float32Array[], startIndex: number): void {
  for (const channel of output) {
    for (let frameIndex = startIndex; frameIndex < channel.length; frameIndex += 1) {
      channel[frameIndex] = 0;
    }
  }
}

function clampFrame(value: number, sourceLength: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(0, value), Math.max(0, sourceLength));
}

function normalizeLoopStartFrame(value: number, sourceLength: number): number {
  return clampFrame(Math.floor(value), sourceLength);
}

function normalizeLoopEndFrame(value: number, loopStartFrame: number, sourceLength: number): number {
  return Math.min(
    Math.max(loopStartFrame + 1, Math.ceil(value)),
    Math.max(loopStartFrame + 1, sourceLength),
  );
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function positiveModulo(value: number, divisor: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
    return 0;
  }

  return ((value % divisor) + divisor) % divisor;
}

registerProcessor(AUDIO_TRANSPORT_PROCESSOR_NAME, AudioscopeAudioTransportProcessor);
