import { AUDIO_TRANSPORT_PROCESSOR_NAME } from './audioTransportShared';
import SignalsmithStretch from './vendor/SignalsmithStretch.mjs';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_PLAYBACK_RATE = 1;
const STRETCH_TIME_UPDATE_INTERVAL_SECONDS = 1 / 30;

export type PlaybackLoopRange = {
  end: number;
  start: number;
};

type TransportKind = 'audio-worklet-copy' | 'audio-worklet-stretch' | 'unavailable';

export interface PlaybackSession {
  channelBuffers: ArrayBuffer[];
  durationSeconds: number;
  numberOfChannels: number;
  sourceLength: number;
  sourceSampleRate: number;
}

interface PlaybackSnapshotState {
  contextTime: number;
  currentFrame: number;
  ended: boolean;
  playing: boolean;
}

interface AudioTransportOptions {
  onStateChange?: () => void;
  stretchModuleUrl?: string;
  workletModuleUrl?: string;
}

export interface AudioTransport {
  dispose(): Promise<void>;
  getCurrentTime(): number;
  getDuration(): number;
  getLastFallbackReason(): string | null;
  getPlaybackRate(): number;
  getTransportKind(): TransportKind;
  isPlaying(): boolean;
  load(source: PlaybackSource): Promise<void>;
  pause(): void;
  play(): Promise<void>;
  seek(timeSeconds: number): void;
  setLoop(loopRangeOrNull: PlaybackLoopRange | null): void;
  setPlaybackRate(rate: number): void;
}

interface PlaybackSourceObject {
  audioBuffer?: AudioBuffer | null;
  playbackSession?: PlaybackSession | null;
  workletModuleUrl?: string;
}

interface NormalizedPlaybackSource {
  playbackSession: PlaybackSession;
  workletModuleUrl: string;
}

type PlaybackSource = AudioBuffer | PlaybackSession | PlaybackSourceObject;

interface StretchSchedule {
  active?: boolean;
  input?: number;
  loopEnd?: number;
  loopStart?: number;
  outputTime?: number;
  rate?: number;
}

interface StretchNode extends AudioWorkletNode {
  inputTime: number;
  addBuffers(buffers: Float32Array[]): Promise<number>;
  latency(): Promise<number>;
  schedule(schedule: StretchSchedule, adjustPrevious?: boolean): Promise<unknown>;
  setUpdateInterval(seconds: number, callback?: (seconds: number) => void): Promise<unknown>;
}

interface SignalsmithStretchFactory {
  (audioContext: AudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
  moduleUrl?: string;
}

interface WorkletControlMessage {
  body?: {
    loopEnabled?: boolean;
    loopEndFrame?: number;
    loopStartFrame?: number;
    playing?: boolean;
    seekFrame?: number | null;
    seekSerial?: number | null;
  };
  type?: string;
}

interface WorkletStateMessage {
  body?: {
    contextTime?: number;
    currentFrame?: number;
    ended?: boolean;
    playing?: boolean;
  };
  type?: 'state';
}

interface WorkletEndedMessage {
  body?: {
    currentFrame?: number;
    durationSeconds?: number;
  };
  type?: 'ended';
}

type WorkletMessage = WorkletEndedMessage | WorkletStateMessage | WorkletControlMessage;

export function createAudioTransport(options: AudioTransportOptions = {}): AudioTransport {
  return new HybridAudioTransport(options);
}

class AudioWorkletCopyTransport {
  private audioContext: AudioContext | null;
  private ended: boolean;
  private lastFallbackReason: string | null;
  private loopRange: PlaybackLoopRange | null;
  private onStateChange: (() => void) | null;
  private pausedAtSeconds: number;
  private playbackSession: PlaybackSession | null;
  private playing: boolean;
  private seekSerial: number;
  private snapshotState: PlaybackSnapshotState | null;
  private transportKind: TransportKind;
  private workletModuleReadyPromise: Promise<void> | null;
  private workletModuleUrl: string;
  private workletNode: AudioWorkletNode | null;

  constructor(options: AudioTransportOptions = {}) {
    this.audioContext = null;
    this.playbackSession = null;
    this.workletNode = null;
    this.workletModuleReadyPromise = null;
    this.workletModuleUrl = typeof options.workletModuleUrl === 'string'
      ? options.workletModuleUrl
      : '';
    this.snapshotState = null;
    this.seekSerial = 0;
    this.pausedAtSeconds = 0;
    this.loopRange = null;
    this.playing = false;
    this.ended = false;
    this.transportKind = 'unavailable';
    this.lastFallbackReason = null;
    this.onStateChange = typeof options.onStateChange === 'function'
      ? options.onStateChange
      : null;
  }

  async load(source: PlaybackSource): Promise<void> {
    const normalizedSource = normalizePlaybackSource(source, this.workletModuleUrl);

    this.disposeWorkletNode();
    this.playbackSession = normalizedSource.playbackSession;
    this.workletModuleUrl = normalizedSource.workletModuleUrl;
    this.workletModuleReadyPromise = null;
    this.pausedAtSeconds = 0;
    this.loopRange = normalizeLoopRange(this.loopRange, this.getDuration());
    this.playing = false;
    this.ended = false;
    this.snapshotState = null;
    this.seekSerial = 0;
    this.lastFallbackReason = this.getWorkletUnavailableReason();
    this.transportKind = this.lastFallbackReason ? 'unavailable' : 'audio-worklet-copy';

    this.notifyStateChange();
  }

  async play() {
    if (!this.playbackSession) {
      return;
    }

    if (this.transportKind === 'unavailable') {
      throw new Error(this.lastFallbackReason || 'AudioWorklet playback is unavailable.');
    }

    try {
      const context = await this.ensureAudioContext();

      if (context.state !== 'running') {
        await context.resume();
      }

      const startOffset = this.getPlaybackStartOffset();
      await this.ensureWorkletNode(startOffset);
      this.snapshotState = null;
      this.playing = true;
      this.ended = false;
      this.pausedAtSeconds = startOffset;
      this.updateControlState(startOffset);
      this.notifyStateChange();
    } catch (error) {
      this.markUnavailable(error);
      throw new Error(this.lastFallbackReason || 'AudioWorklet playback is unavailable.');
    }
  }

  pause(): void {
    if (!this.playbackSession) {
      return;
    }

    this.pausedAtSeconds = this.getCurrentTime();
    this.playing = false;
    this.ended = false;
    this.snapshotState = null;
    this.updateControlState();
    this.notifyStateChange();
  }

  seek(timeSeconds: number): void {
    if (!this.playbackSession || !Number.isFinite(timeSeconds)) {
      return;
    }

    const nextTime = this.normalizePausedTime(timeSeconds);
    this.pausedAtSeconds = nextTime;
    this.ended = false;
    this.snapshotState = null;
    this.updateControlState(nextTime);
    this.notifyStateChange();
  }

  setLoop(loopRangeOrNull: PlaybackLoopRange | null): void {
    const nextLoopRange = normalizeLoopRange(loopRangeOrNull, this.getDuration());
    const loopChanged = !areLoopRangesEqual(this.loopRange, nextLoopRange);

    if (!loopChanged) {
      return;
    }

    const currentTime = this.getCurrentTime();
    this.loopRange = nextLoopRange;
    this.ended = false;
    const nextTime = this.normalizePausedTime(currentTime);
    this.pausedAtSeconds = nextTime;
    this.snapshotState = null;
    this.updateControlState(nextTime);
    this.notifyStateChange();
  }

  getCurrentTime(): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    if (this.snapshotState) {
      const projectedFrame = this.projectFrameFromSnapshot(this.snapshotState);
      return this.applyObservedState(
        projectedFrame,
        this.snapshotState.playing,
        this.snapshotState.ended,
      );
    }

    return this.normalizePausedTime(this.pausedAtSeconds);
  }

  getDuration(): number {
    return this.playbackSession?.durationSeconds ?? 0;
  }

  getTransportKind(): TransportKind {
    return this.transportKind;
  }

  getLastFallbackReason(): string | null {
    return this.lastFallbackReason;
  }

  getPlaybackRate(): number {
    return DEFAULT_PLAYBACK_RATE;
  }

  isPlaying(): boolean {
    return this.playing || this.snapshotState?.playing === true;
  }

  setPlaybackRate(_rate: number): void {
    // The copied-buffer transport always runs at native speed.
  }

  async dispose() {
    this.disposeWorkletNode();

    this.playbackSession = null;
    this.pausedAtSeconds = 0;
    this.loopRange = null;
    this.playing = false;
    this.ended = false;
    this.transportKind = 'unavailable';
    this.lastFallbackReason = null;
    this.snapshotState = null;

    if (this.audioContext) {
      const audioContext = this.audioContext;
      this.audioContext = null;
      this.workletModuleReadyPromise = null;
      await audioContext.close().catch(() => {});
    }

    this.notifyStateChange();
  }

  async ensureAudioContext(): Promise<AudioContext> {
    if (this.audioContext) {
      return this.audioContext;
    }

    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;

    if (!AudioContextConstructor) {
      throw new Error('Web Audio API is unavailable in this webview.');
    }

    this.audioContext = new AudioContextConstructor();
    return this.audioContext;
  }

  async ensureWorkletNode(initialTimeSeconds = this.pausedAtSeconds): Promise<AudioWorkletNode> {
    if (this.workletNode) {
      return this.workletNode;
    }

    const availabilityError = this.getWorkletUnavailableReason();

    if (availabilityError) {
      throw new Error(availabilityError);
    }

    const context = await this.ensureAudioContext();

    if (
      !context.audioWorklet
      || typeof context.audioWorklet.addModule !== 'function'
      || typeof AudioWorkletNode !== 'function'
    ) {
      throw new Error('AudioWorklet is unavailable in this webview.');
    }

    if (!this.workletModuleReadyPromise) {
      this.workletModuleReadyPromise = context.audioWorklet.addModule(this.workletModuleUrl);
    }

    await this.workletModuleReadyPromise;

    const outputChannelCount = Math.max(1, Math.trunc(this.playbackSession.numberOfChannels));
    const initialFrame = this.secondsToSourceFrame(initialTimeSeconds);
    const controlFrames = this.getControlLoopFrames();

    const node = new AudioWorkletNode(context, AUDIO_TRANSPORT_PROCESSOR_NAME, {
      channelCount: outputChannelCount,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [outputChannelCount],
      processorOptions: {
        channelBuffers: this.playbackSession.channelBuffers,
        durationSeconds: this.playbackSession.durationSeconds,
        initialFrame,
        initialLoopEnabled: Boolean(this.loopRange),
        initialLoopEndFrame: controlFrames.loopEndFrame,
        initialLoopStartFrame: controlFrames.loopStartFrame,
        initialPlaying: false,
        initialSeekSerial: this.seekSerial,
        sourceLength: this.playbackSession.sourceLength,
        sourceSampleRate: this.playbackSession.sourceSampleRate,
      },
    });

    node.port.onmessage = (event) => {
      this.handleWorkletMessage(event.data);
    };
    node.onprocessorerror = () => {
      this.markUnavailable(new Error('AudioWorklet processor failed.'));
    };
    node.connect(context.destination);

    this.workletNode = node;
    this.snapshotState = null;
    this.transportKind = 'audio-worklet-copy';
    this.lastFallbackReason = null;
    this.pushPortControl(initialFrame);

    return node;
  }

  disposeWorkletNode(): void {
    if (this.workletNode) {
      const workletNode = this.workletNode;
      this.workletNode = null;
      workletNode.port.onmessage = null;
      workletNode.onprocessorerror = null;

      try {
        workletNode.disconnect();
      } catch {
        // Disconnect may fail if the node is already detached.
      }
    }

    this.snapshotState = null;
  }

  getWorkletUnavailableReason(): string | null {
    if (!this.playbackSession) {
      return 'Decoded playback session is unavailable.';
    }

    if (!Array.isArray(this.playbackSession.channelBuffers) || this.playbackSession.channelBuffers.length === 0) {
      return 'Decoded playback buffers are unavailable.';
    }

    if (!this.workletModuleUrl) {
      return 'AudioWorklet processor module URL is unavailable.';
    }

    if (!(window.AudioContext || window.webkitAudioContext)) {
      return 'Web Audio API is unavailable in this webview.';
    }

    if (typeof AudioWorkletNode !== 'function') {
      return 'AudioWorkletNode is unavailable in this webview.';
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    const audioContextPrototype = AudioContextConstructor?.prototype ?? null;

    if (!audioContextPrototype || !('audioWorklet' in audioContextPrototype)) {
      return 'AudioWorklet is unavailable in this webview.';
    }

    return null;
  }

  getControlLoopFrames(): { loopEndFrame: number; loopStartFrame: number } {
    const sourceLength = this.playbackSession?.sourceLength ?? 0;

    if (!(this.loopRange?.end > this.loopRange?.start)) {
      return {
        loopEndFrame: Math.max(1, sourceLength),
        loopStartFrame: 0,
      };
    }

    const loopStartFrame = clamp(
      Math.floor(this.loopRange.start * this.getSourceSampleRate()),
      0,
      Math.max(0, sourceLength - 1),
    );
    const loopEndFrame = clamp(
      Math.ceil(this.loopRange.end * this.getSourceSampleRate()),
      loopStartFrame + 1,
      Math.max(loopStartFrame + 1, sourceLength),
    );

    return {
      loopEndFrame,
      loopStartFrame,
    };
  }

  getPlaybackStartOffset(): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      const loopStart = this.loopRange.start;
      const loopEnd = this.getLoopPlayableEnd();
      const pausedAt = this.normalizePausedTime(this.pausedAtSeconds);

      if (pausedAt < loopStart || pausedAt >= loopEnd) {
        return loopStart;
      }

      return pausedAt;
    }

    const playbackEnd = this.getPlayableEndTime();
    const pausedAt = clamp(this.pausedAtSeconds, 0, duration);
    return pausedAt >= playbackEnd ? 0 : pausedAt;
  }

  normalizePausedTime(timeSeconds: number): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    const clampedTime = clamp(timeSeconds, 0, duration);

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      return clamp(clampedTime, this.loopRange.start, this.loopRange.end);
    }

    return clampedTime;
  }

  getPlayableEndTime(): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    const sampleRate = this.playbackSession?.sourceSampleRate || DEFAULT_SAMPLE_RATE;
    const epsilon = Math.min(1 / sampleRate, duration / 2);
    return Math.max(0, duration - epsilon);
  }

  getLoopPlayableEnd(): number {
    if (!(this.loopRange?.end > this.loopRange?.start)) {
      return this.getPlayableEndTime();
    }

    const sampleRate = this.playbackSession?.sourceSampleRate || DEFAULT_SAMPLE_RATE;
    const epsilon = Math.min(1 / sampleRate, (this.loopRange.end - this.loopRange.start) / 2);
    return Math.max(this.loopRange.start, this.loopRange.end - epsilon);
  }

  getEndedPauseTime(): number {
    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      return this.loopRange.start;
    }

    return this.getDuration();
  }

  updateControlState(seekTimeSeconds: number | null = null): void {
    if (!this.workletNode) {
      return;
    }

    const seekFrame = seekTimeSeconds === null
      ? null
      : this.secondsToSourceFrame(seekTimeSeconds);
    this.pushPortControl(seekFrame);
  }

  pushPortControl(seekFrame: number | null = null): void {
    if (!this.workletNode) {
      return;
    }

    const controlFrames = this.getControlLoopFrames();

    if (seekFrame !== null) {
      this.seekSerial += 1;
    }

    this.workletNode.port.postMessage({
      type: 'setControl',
      body: {
        loopEnabled: Boolean(this.loopRange),
        loopEndFrame: controlFrames.loopEndFrame,
        loopStartFrame: controlFrames.loopStartFrame,
        playing: this.playing,
        seekFrame,
        seekSerial: seekFrame === null ? null : this.seekSerial,
      },
    });
  }

  handleWorkletMessage(message: WorkletMessage): void {
    if (message?.type === 'state') {
      const body = message.body as WorkletStateMessage['body'] | undefined;
      this.snapshotState = {
        contextTime: Number(body?.contextTime) || 0,
        currentFrame: clampFramePrecise(
          Number(body?.currentFrame) || 0,
          this.playbackSession?.sourceLength ?? 0,
        ),
        ended: body?.ended === true,
        playing: body?.playing === true,
      };
      return;
    }

    if (message?.type === 'ended') {
      this.playing = false;
      this.ended = true;
      this.pausedAtSeconds = this.getEndedPauseTime();
      this.transportKind = 'audio-worklet-copy';
      this.notifyStateChange();
    }
  }

  projectFrameFromSnapshot(snapshotState: PlaybackSnapshotState | null): number {
    const sourceLength = this.playbackSession?.sourceLength ?? 0;

    if (!snapshotState?.playing || snapshotState.ended) {
      return clampFramePrecise(snapshotState?.currentFrame ?? 0, sourceLength);
    }

    const nowContextTime = Number(this.audioContext?.currentTime) || 0;
    const elapsedSeconds = Math.max(0, nowContextTime - (Number(snapshotState.contextTime) || 0));
    const projectedFrame = (Number(snapshotState.currentFrame) || 0) + (elapsedSeconds * this.getSourceSampleRate());

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      const { loopEndFrame, loopStartFrame } = this.getControlLoopFrames();
      const loopSpan = Math.max(1, loopEndFrame - loopStartFrame);
      return clampFramePrecise(
        loopStartFrame + positiveModulo(projectedFrame - loopStartFrame, loopSpan),
        sourceLength,
      );
    }

    return clampFramePrecise(projectedFrame, sourceLength);
  }

  applyObservedState(currentFrame: number, playing: boolean, ended: boolean): number {
    const currentTime = this.sourceFrameToSeconds(currentFrame);
    this.playing = playing;
    this.ended = ended;

    if (!playing || ended) {
      this.pausedAtSeconds = ended
        ? this.getEndedPauseTime()
        : this.normalizePausedTime(currentTime);
    }

    return currentTime;
  }

  markUnavailable(reason: unknown): void {
    const currentTime = this.getCurrentTime();
    this.transportKind = 'unavailable';
    this.lastFallbackReason = formatTransportFailureReason(reason);
    this.playing = false;
    this.ended = false;
    this.pausedAtSeconds = this.normalizePausedTime(currentTime);
    this.disposeWorkletNode();
    this.notifyStateChange();
  }

  getSourceSampleRate(): number {
    return this.playbackSession?.sourceSampleRate || DEFAULT_SAMPLE_RATE;
  }

  secondsToSourceFrame(timeSeconds: number): number {
    const sourceLength = this.playbackSession?.sourceLength ?? 0;
    return clampFrame(Math.round(timeSeconds * this.getSourceSampleRate()), sourceLength);
  }

  sourceFrameToSeconds(frame: number): number {
    const sourceLength = this.playbackSession?.sourceLength ?? 0;
    const safeFrame = clampFramePrecise(frame, sourceLength);
    const duration = this.getDuration();
    return clamp(safeFrame / this.getSourceSampleRate(), 0, duration);
  }

  notifyStateChange(): void {
    this.onStateChange?.();
  }
}

class HybridAudioTransport implements AudioTransport {
  private readonly copyTransport: AudioWorkletCopyTransport;
  private readonly stretchTransport: StretchAudioTransport;
  private readonly onStateChange: (() => void) | null;
  private playbackRate: number;

  constructor(options: AudioTransportOptions = {}) {
    this.onStateChange = typeof options.onStateChange === 'function'
      ? options.onStateChange
      : null;
    this.playbackRate = DEFAULT_PLAYBACK_RATE;

    const childOptions: AudioTransportOptions = {
      ...options,
      onStateChange: () => {
        this.notifyStateChange();
      },
    };

    this.copyTransport = new AudioWorkletCopyTransport(childOptions);
    this.stretchTransport = new StretchAudioTransport(childOptions);
  }

  async load(source: PlaybackSource): Promise<void> {
    await this.copyTransport.load(source);
    await this.stretchTransport.load(source);
    this.stretchTransport.setPlaybackRate(this.playbackRate);
    this.syncBackendsToCurrentPosition();
    this.notifyStateChange();
  }

  async play(): Promise<void> {
    const activeTransport = this.getSelectedTransport();
    const inactiveTransport = this.getInactiveTransport();
    const currentTime = this.getCurrentTime();

    inactiveTransport.pause();
    inactiveTransport.seek(currentTime);
    await activeTransport.play();
    this.notifyStateChange();
  }

  pause(): void {
    const currentTime = this.getCurrentTime();

    this.copyTransport.pause();
    this.stretchTransport.pause();
    this.copyTransport.seek(currentTime);
    this.stretchTransport.seek(currentTime);
    this.notifyStateChange();
  }

  seek(timeSeconds: number): void {
    const nextTime = Number.isFinite(timeSeconds) ? timeSeconds : 0;

    this.copyTransport.seek(nextTime);
    this.stretchTransport.seek(nextTime);
    this.notifyStateChange();
  }

  setLoop(loopRangeOrNull: PlaybackLoopRange | null): void {
    this.copyTransport.setLoop(loopRangeOrNull);
    this.stretchTransport.setLoop(loopRangeOrNull);
    this.notifyStateChange();
  }

  setPlaybackRate(rate: number): void {
    const nextRate = normalizePlaybackRate(rate);

    if (Math.abs(nextRate - this.playbackRate) <= 1e-6) {
      return;
    }

    const wasPlaying = this.isPlaying();
    const currentTime = this.getCurrentTime();
    this.playbackRate = nextRate;
    this.stretchTransport.setPlaybackRate(nextRate);
    this.copyTransport.seek(currentTime);
    this.stretchTransport.seek(currentTime);

    if (wasPlaying) {
      void this.play().catch(() => {
        this.notifyStateChange();
      });
      return;
    }

    this.notifyStateChange();
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  getCurrentTime(): number {
    return this.getActiveTransport().getCurrentTime();
  }

  getDuration(): number {
    return this.getSelectedTransport().getDuration();
  }

  getTransportKind(): TransportKind {
    return this.getSelectedTransport().getTransportKind();
  }

  getLastFallbackReason(): string | null {
    return this.getSelectedTransport().getLastFallbackReason();
  }

  isPlaying(): boolean {
    return this.copyTransport.isPlaying() || this.stretchTransport.isPlaying();
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.copyTransport.dispose(),
      this.stretchTransport.dispose(),
    ]);
    this.notifyStateChange();
  }

  private getSelectedTransport(): AudioTransport {
    return this.playbackRate === DEFAULT_PLAYBACK_RATE
      ? this.copyTransport
      : this.stretchTransport;
  }

  private getInactiveTransport(): AudioTransport {
    return this.playbackRate === DEFAULT_PLAYBACK_RATE
      ? this.stretchTransport
      : this.copyTransport;
  }

  private getActiveTransport(): AudioTransport {
    if (this.stretchTransport.isPlaying()) {
      return this.stretchTransport;
    }

    if (this.copyTransport.isPlaying()) {
      return this.copyTransport;
    }

    return this.getSelectedTransport();
  }

  private syncBackendsToCurrentPosition(): void {
    const currentTime = this.getSelectedTransport().getCurrentTime();
    this.copyTransport.seek(currentTime);
    this.stretchTransport.seek(currentTime);
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }
}

class StretchAudioTransport implements AudioTransport {
  private audioContext: AudioContext | null;
  private ended: boolean;
  private inputTimeSeconds: number;
  private lastFallbackReason: string | null;
  private loopRange: PlaybackLoopRange | null;
  private onStateChange: (() => void) | null;
  private outputLatencySeconds: number;
  private pausedAtSeconds: number;
  private playbackRate: number;
  private playbackSession: PlaybackSession | null;
  private playing: boolean;
  private stretchModuleUrl: string;
  private stretchNode: StretchNode | null;
  private transportKind: TransportKind;

  constructor(options: AudioTransportOptions = {}) {
    this.audioContext = null;
    this.ended = false;
    this.inputTimeSeconds = 0;
    this.lastFallbackReason = null;
    this.loopRange = null;
    this.onStateChange = typeof options.onStateChange === 'function'
      ? options.onStateChange
      : null;
    this.outputLatencySeconds = 0;
    this.pausedAtSeconds = 0;
    this.playbackRate = DEFAULT_PLAYBACK_RATE;
    this.playbackSession = null;
    this.playing = false;
    this.stretchModuleUrl = typeof options.stretchModuleUrl === 'string'
      ? options.stretchModuleUrl
      : '';
    this.stretchNode = null;
    this.transportKind = 'unavailable';
  }

  async load(source: PlaybackSource): Promise<void> {
    const normalizedSource = normalizePlaybackSource(source, '');

    this.disposeStretchNode();
    this.playbackSession = normalizedSource.playbackSession;
    this.pausedAtSeconds = 0;
    this.inputTimeSeconds = 0;
    this.loopRange = normalizeLoopRange(this.loopRange, this.getDuration());
    this.outputLatencySeconds = 0;
    this.playing = false;
    this.ended = false;
    this.lastFallbackReason = this.getStretchUnavailableReason();
    this.transportKind = this.lastFallbackReason ? 'unavailable' : 'audio-worklet-stretch';
    this.notifyStateChange();
  }

  async play(): Promise<void> {
    if (!this.playbackSession) {
      return;
    }

    if (this.transportKind === 'unavailable') {
      throw new Error(this.lastFallbackReason || 'Pitch-preserving playback is unavailable.');
    }

    try {
      const context = await this.ensureAudioContext();

      if (context.state !== 'running') {
        await context.resume();
      }

      const startOffset = this.getPlaybackStartOffset();
      await this.ensureStretchNode();
      this.pausedAtSeconds = startOffset;
      this.inputTimeSeconds = startOffset;
      this.playing = true;
      this.ended = false;
      await this.pushStretchSchedule({
        active: true,
        input: startOffset,
      });
      this.notifyStateChange();
    } catch (error) {
      this.markUnavailable(error);
      throw new Error(this.lastFallbackReason || 'Pitch-preserving playback is unavailable.');
    }
  }

  pause(): void {
    if (!this.playbackSession) {
      return;
    }

    const currentTime = this.getCurrentTime();
    this.pausedAtSeconds = currentTime;
    this.inputTimeSeconds = currentTime;
    this.playing = false;
    this.ended = false;
    void this.pushStretchSchedule({
      active: false,
      input: currentTime,
    });
    this.notifyStateChange();
  }

  seek(timeSeconds: number): void {
    if (!this.playbackSession || !Number.isFinite(timeSeconds)) {
      return;
    }

    const nextTime = this.normalizePausedTime(timeSeconds);
    this.pausedAtSeconds = nextTime;
    this.inputTimeSeconds = nextTime;
    this.ended = false;
    void this.pushStretchSchedule({
      active: this.playing,
      input: nextTime,
    });
    this.notifyStateChange();
  }

  setLoop(loopRangeOrNull: PlaybackLoopRange | null): void {
    const nextLoopRange = normalizeLoopRange(loopRangeOrNull, this.getDuration());
    const loopChanged = !areLoopRangesEqual(this.loopRange, nextLoopRange);

    if (!loopChanged) {
      return;
    }

    const currentTime = this.getCurrentTime();
    this.loopRange = nextLoopRange;
    this.ended = false;
    this.pausedAtSeconds = this.normalizePausedTime(currentTime);
    this.inputTimeSeconds = this.pausedAtSeconds;
    void this.pushStretchSchedule({
      active: this.playing,
      input: this.pausedAtSeconds,
    });
    this.notifyStateChange();
  }

  setPlaybackRate(rate: number): void {
    const nextRate = normalizePlaybackRate(rate);

    if (Math.abs(nextRate - this.playbackRate) <= 1e-6) {
      return;
    }

    const currentTime = this.getCurrentTime();
    this.playbackRate = nextRate;
    this.pausedAtSeconds = currentTime;
    this.inputTimeSeconds = currentTime;
    void this.pushStretchSchedule({
      active: this.playing,
      input: currentTime,
      rate: nextRate,
    });
    this.notifyStateChange();
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  getCurrentTime(): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    if (this.playing && !this.ended) {
      return this.normalizeObservedTime(this.inputTimeSeconds);
    }

    return this.normalizePausedTime(this.pausedAtSeconds);
  }

  getDuration(): number {
    return this.playbackSession?.durationSeconds ?? 0;
  }

  getTransportKind(): TransportKind {
    return this.transportKind;
  }

  getLastFallbackReason(): string | null {
    return this.lastFallbackReason;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  async dispose(): Promise<void> {
    this.disposeStretchNode();

    this.playbackSession = null;
    this.pausedAtSeconds = 0;
    this.inputTimeSeconds = 0;
    this.loopRange = null;
    this.outputLatencySeconds = 0;
    this.playing = false;
    this.ended = false;
    this.transportKind = 'unavailable';
    this.lastFallbackReason = null;

    if (this.audioContext) {
      const audioContext = this.audioContext;
      this.audioContext = null;
      await audioContext.close().catch(() => {});
    }

    this.notifyStateChange();
  }

  private async ensureAudioContext(): Promise<AudioContext> {
    if (this.audioContext) {
      return this.audioContext;
    }

    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;

    if (!AudioContextConstructor) {
      throw new Error('Web Audio API is unavailable in this webview.');
    }

    this.audioContext = new AudioContextConstructor();
    return this.audioContext;
  }

  private async ensureStretchNode(): Promise<StretchNode> {
    if (this.stretchNode) {
      return this.stretchNode;
    }

    const availabilityError = this.getStretchUnavailableReason();

    if (availabilityError) {
      throw new Error(availabilityError);
    }

    const context = await this.ensureAudioContext();
    const outputChannelCount = Math.max(1, Math.trunc(this.playbackSession?.numberOfChannels || 1));
    const stretchFactory = SignalsmithStretch as SignalsmithStretchFactory;

    if (this.stretchModuleUrl) {
      stretchFactory.moduleUrl = this.stretchModuleUrl;
    }

    const node = await stretchFactory(context, {
      channelCount: outputChannelCount,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      // Signalsmith's worklet expects an input bus to exist even when we only
      // feed it sample buffers via addBuffers().
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [outputChannelCount],
    }) as StretchNode;

    node.onprocessorerror = () => {
      this.markUnavailable(new Error('Signalsmith Stretch processor failed.'));
    };

    const channelViews = this.playbackSession?.channelBuffers.map((buffer) => new Float32Array(buffer)) ?? [];
    await node.addBuffers(channelViews);
    await node.setUpdateInterval(STRETCH_TIME_UPDATE_INTERVAL_SECONDS, (seconds) => {
      this.handleStretchTimeUpdate(seconds);
    });
    this.outputLatencySeconds = Math.max(0, Number(await node.latency()) || 0);
    node.connect(context.destination);

    this.stretchNode = node;
    this.transportKind = 'audio-worklet-stretch';
    this.lastFallbackReason = null;
    return node;
  }

  private disposeStretchNode(): void {
    if (!this.stretchNode) {
      return;
    }

    const node = this.stretchNode;
    this.stretchNode = null;
    node.onprocessorerror = null;

    try {
      node.disconnect();
    } catch {
      // Disconnect may fail if the node is already detached.
    }
  }

  private getStretchUnavailableReason(): string | null {
    if (!this.playbackSession) {
      return 'Decoded playback session is unavailable.';
    }

    if (!Array.isArray(this.playbackSession.channelBuffers) || this.playbackSession.channelBuffers.length === 0) {
      return 'Decoded playback buffers are unavailable.';
    }

    if (!(window.AudioContext || window.webkitAudioContext)) {
      return 'Web Audio API is unavailable in this webview.';
    }

    if (typeof AudioWorkletNode !== 'function') {
      return 'AudioWorkletNode is unavailable in this webview.';
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    const audioContextPrototype = AudioContextConstructor?.prototype ?? null;

    if (!audioContextPrototype || !('audioWorklet' in audioContextPrototype)) {
      return 'AudioWorklet is unavailable in this webview.';
    }

    if (typeof SignalsmithStretch !== 'function') {
      return 'Signalsmith Stretch runtime is unavailable.';
    }

    return null;
  }

  private async pushStretchSchedule(overrides: StretchSchedule): Promise<void> {
    if (!this.stretchNode) {
      return;
    }

    try {
      const outputTime = this.getStretchScheduleTime();
      const loopRange = this.loopRange && this.loopRange.end > this.loopRange.start
        ? this.loopRange
        : null;

      await this.stretchNode.schedule({
        active: this.playing,
        input: this.getCurrentTime(),
        loopEnd: loopRange?.end ?? 0,
        loopStart: loopRange?.start ?? 0,
        outputTime,
        rate: this.playbackRate,
        ...overrides,
      });
    } catch (error) {
      this.markUnavailable(error);
    }
  }

  private getStretchScheduleTime(): number {
    const contextTime = Number(this.audioContext?.currentTime) || 0;
    return contextTime + Math.max(0, this.outputLatencySeconds);
  }

  private handleStretchTimeUpdate(seconds: number): void {
    const duration = this.getDuration();

    if (!(duration > 0) || !Number.isFinite(seconds)) {
      return;
    }

    this.inputTimeSeconds = this.normalizeObservedTime(seconds);

    if (!this.playing) {
      return;
    }

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      this.notifyStateChange();
      return;
    }

    if (this.inputTimeSeconds >= this.getPlayableEndTime()) {
      this.playing = false;
      this.ended = true;
      this.pausedAtSeconds = this.getEndedPauseTime();
      this.inputTimeSeconds = this.pausedAtSeconds;
    }

    this.notifyStateChange();
  }

  private normalizeObservedTime(timeSeconds: number): number {
    if (!Number.isFinite(timeSeconds)) {
      return this.normalizePausedTime(this.pausedAtSeconds);
    }

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      const loopSpan = this.loopRange.end - this.loopRange.start;

      if (!(loopSpan > 0)) {
        return this.loopRange.start;
      }

      return this.loopRange.start + positiveModulo(timeSeconds - this.loopRange.start, loopSpan);
    }

    return clamp(timeSeconds, 0, this.getDuration());
  }

  private getPlaybackStartOffset(): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      const loopStart = this.loopRange.start;
      const loopEnd = this.getLoopPlayableEnd();
      const pausedAt = this.normalizePausedTime(this.pausedAtSeconds);

      if (pausedAt < loopStart || pausedAt >= loopEnd) {
        return loopStart;
      }

      return pausedAt;
    }

    const playbackEnd = this.getPlayableEndTime();
    const pausedAt = clamp(this.pausedAtSeconds, 0, duration);
    return pausedAt >= playbackEnd ? 0 : pausedAt;
  }

  private normalizePausedTime(timeSeconds: number): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    const clampedTime = clamp(timeSeconds, 0, duration);

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      return clamp(clampedTime, this.loopRange.start, this.loopRange.end);
    }

    return clampedTime;
  }

  private getPlayableEndTime(): number {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    const sampleRate = this.playbackSession?.sourceSampleRate || DEFAULT_SAMPLE_RATE;
    const epsilon = Math.min(1 / sampleRate, duration / 2);
    return Math.max(0, duration - epsilon);
  }

  private getLoopPlayableEnd(): number {
    if (!(this.loopRange?.end > this.loopRange?.start)) {
      return this.getPlayableEndTime();
    }

    const sampleRate = this.playbackSession?.sourceSampleRate || DEFAULT_SAMPLE_RATE;
    const epsilon = Math.min(1 / sampleRate, (this.loopRange.end - this.loopRange.start) / 2);
    return Math.max(this.loopRange.start, this.loopRange.end - epsilon);
  }

  private getEndedPauseTime(): number {
    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      return this.loopRange.start;
    }

    return this.getDuration();
  }

  private markUnavailable(reason: unknown): void {
    const currentTime = this.getCurrentTime();
    this.transportKind = 'unavailable';
    this.lastFallbackReason = formatTransportFailureReason(reason);
    this.playing = false;
    this.ended = false;
    this.pausedAtSeconds = this.normalizePausedTime(currentTime);
    this.inputTimeSeconds = this.pausedAtSeconds;
    this.disposeStretchNode();
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }
}

function normalizePlaybackSource(source: PlaybackSource, defaultWorkletModuleUrl: string): NormalizedPlaybackSource {
  const sourceOptions = isPlaybackSourceObject(source) ? source : null;
  const audioBuffer = source instanceof AudioBuffer
    ? source
    : (sourceOptions?.audioBuffer instanceof AudioBuffer ? sourceOptions.audioBuffer : null);
  const playbackSession = normalizePlaybackSession(
    isPlaybackSession(source) ? source : sourceOptions?.playbackSession,
    audioBuffer,
  );

  if (!playbackSession) {
    throw new Error('A decoded playback session is required for playback.');
  }

  return {
    playbackSession,
    workletModuleUrl: typeof sourceOptions?.workletModuleUrl === 'string' && sourceOptions.workletModuleUrl.length > 0
      ? sourceOptions.workletModuleUrl
      : defaultWorkletModuleUrl,
  };
}

function normalizePlaybackSession(session: PlaybackSession | null | undefined, audioBuffer: AudioBuffer | null = null): PlaybackSession | null {
  if ((!session || typeof session !== 'object') && !(audioBuffer instanceof AudioBuffer)) {
    return null;
  }

  const sourceLength = Math.max(0, Math.trunc(Number(session?.sourceLength) || audioBuffer?.length || 0));
  const sourceSampleRate = Math.max(1, Number(session?.sourceSampleRate) || audioBuffer?.sampleRate || DEFAULT_SAMPLE_RATE);
  const durationSeconds = Number.isFinite(session?.durationSeconds)
    ? Math.max(0, Number(session?.durationSeconds))
    : (audioBuffer?.duration ?? 0);
  const buffers = Array.isArray(session?.channelBuffers)
    ? session.channelBuffers.filter((buffer) => buffer instanceof ArrayBuffer)
    : (audioBuffer ? createPlaybackSession(audioBuffer).channelBuffers : []);
  const numberOfChannels = Math.max(1, Math.trunc(Number(session?.numberOfChannels) || buffers.length || audioBuffer?.numberOfChannels || 1));

  if (buffers.length === 0) {
    return null;
  }

  return {
    channelBuffers: buffers,
    durationSeconds,
    numberOfChannels,
    sourceLength,
    sourceSampleRate,
  };
}

function createPlaybackSession(audioBuffer: AudioBuffer): PlaybackSession {
  const channelBuffers = [];

  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const sourceChannelData = audioBuffer.getChannelData(channelIndex);
    channelBuffers.push(sourceChannelData.slice().buffer);
  }

  return {
    channelBuffers,
    durationSeconds: audioBuffer.duration,
    numberOfChannels: audioBuffer.numberOfChannels,
    sourceLength: audioBuffer.length,
    sourceSampleRate: audioBuffer.sampleRate,
  };
}

function isPlaybackSession(value: unknown): value is PlaybackSession {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as PlaybackSession).channelBuffers),
  );
}

function isPlaybackSourceObject(value: PlaybackSource): value is PlaybackSourceObject {
  return Boolean(
    value
    && typeof value === 'object'
    && !(value instanceof AudioBuffer)
    && !Array.isArray((value as PlaybackSession).channelBuffers),
  );
}

function formatTransportFailureReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return reason.trim();
  }

  if (reason instanceof Error && typeof reason.message === 'string' && reason.message.trim().length > 0) {
    return reason.message.trim();
  }

  if (reason && typeof reason === 'object') {
    const message = 'message' in reason ? (reason as { message?: unknown }).message : null;

    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }

  return 'AudioWorklet playback is unavailable.';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampFrame(frame: number, sourceLength: number): number {
  const maxFrame = Math.max(0, Math.trunc(Number(sourceLength) || 0));
  const normalizedFrame = Math.round(Number(frame) || 0);
  return clamp(normalizedFrame, 0, maxFrame);
}

function clampFramePrecise(frame: number, sourceLength: number): number {
  const maxFrame = Math.max(0, Math.trunc(Number(sourceLength) || 0));
  const normalizedFrame = Number(frame) || 0;
  return clamp(normalizedFrame, 0, maxFrame);
}

function normalizeLoopRange(range: PlaybackLoopRange | null | undefined, duration: number): PlaybackLoopRange | null {
  if (
    !range
    || !Number.isFinite(range.start)
    || !Number.isFinite(range.end)
    || !Number.isFinite(duration)
    || duration <= 0
  ) {
    return null;
  }

  const start = clamp(range.start, 0, duration);
  const end = clamp(range.end, 0, duration);

  if (end <= start) {
    return null;
  }

  return { start, end };
}

function positiveModulo(value: number, divisor: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
    return 0;
  }

  return ((value % divisor) + divisor) % divisor;
}

function areLoopRangesEqual(left: PlaybackLoopRange | null, right: PlaybackLoopRange | null): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return Math.abs(left.start - right.start) <= 1e-6
    && Math.abs(left.end - right.end) <= 1e-6;
}

function normalizePlaybackRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    return DEFAULT_PLAYBACK_RATE;
  }

  return clamp(rate, 0.25, 4);
}
