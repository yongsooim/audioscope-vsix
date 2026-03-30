import { AUDIO_TRANSPORT_PROCESSOR_NAME } from './audioTransportShared';

const DEFAULT_SAMPLE_RATE = 48000;

export function createAudioTransport(options = {}) {
  return new AudioWorkletTransport(options);
}

class AudioWorkletTransport {
  constructor(options = {}) {
    this.audioContext = null;
    this.audioBuffer = null;
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

  async load(source) {
    const normalizedSource = normalizePlaybackSource(source, this.workletModuleUrl);

    this.disposeWorkletNode();
    this.audioBuffer = normalizedSource.audioBuffer;
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
    if (!(this.audioBuffer instanceof AudioBuffer)) {
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

  pause() {
    if (!(this.audioBuffer instanceof AudioBuffer)) {
      return;
    }

    this.pausedAtSeconds = this.getCurrentTime();
    this.playing = false;
    this.ended = false;
    this.snapshotState = null;
    this.updateControlState();
    this.notifyStateChange();
  }

  seek(timeSeconds) {
    if (!(this.audioBuffer instanceof AudioBuffer) || !Number.isFinite(timeSeconds)) {
      return;
    }

    const nextTime = this.normalizePausedTime(timeSeconds);
    this.pausedAtSeconds = nextTime;
    this.ended = false;
    this.snapshotState = null;
    this.updateControlState(nextTime);
    this.notifyStateChange();
  }

  setLoop(loopRangeOrNull) {
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

  getCurrentTime() {
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

  getDuration() {
    return this.audioBuffer instanceof AudioBuffer
      ? this.audioBuffer.duration
      : 0;
  }

  getTransportKind() {
    return this.transportKind;
  }

  getLastFallbackReason() {
    return this.lastFallbackReason;
  }

  isPlaying() {
    return this.playing || this.snapshotState?.playing === true;
  }

  async dispose() {
    this.disposeWorkletNode();

    this.audioBuffer = null;
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

  async ensureAudioContext() {
    if (this.audioContext) {
      return this.audioContext;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextConstructor) {
      throw new Error('Web Audio API is unavailable in this webview.');
    }

    this.audioContext = new AudioContextConstructor();
    return this.audioContext;
  }

  async ensureWorkletNode(initialTimeSeconds = this.pausedAtSeconds) {
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

  disposeWorkletNode() {
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

  getWorkletUnavailableReason() {
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

  getControlLoopFrames() {
    const sourceLength = this.playbackSession?.sourceLength ?? this.audioBuffer?.length ?? 0;

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

  getPlaybackStartOffset() {
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

  normalizePausedTime(timeSeconds) {
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

  getPlayableEndTime() {
    const duration = this.getDuration();

    if (!(duration > 0)) {
      return 0;
    }

    const sampleRate = this.audioBuffer?.sampleRate || this.playbackSession?.sourceSampleRate || DEFAULT_SAMPLE_RATE;
    const epsilon = Math.min(1 / sampleRate, duration / 2);
    return Math.max(0, duration - epsilon);
  }

  getLoopPlayableEnd() {
    if (!(this.loopRange?.end > this.loopRange?.start)) {
      return this.getPlayableEndTime();
    }

    const sampleRate = this.audioBuffer?.sampleRate || this.playbackSession?.sourceSampleRate || DEFAULT_SAMPLE_RATE;
    const epsilon = Math.min(1 / sampleRate, (this.loopRange.end - this.loopRange.start) / 2);
    return Math.max(this.loopRange.start, this.loopRange.end - epsilon);
  }

  getEndedPauseTime() {
    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      return this.loopRange.start;
    }

    return this.getDuration();
  }

  updateControlState(seekTimeSeconds = null) {
    if (!this.workletNode) {
      return;
    }

    const seekFrame = seekTimeSeconds === null
      ? null
      : this.secondsToSourceFrame(seekTimeSeconds);
    this.pushPortControl(seekFrame);
  }

  pushPortControl(seekFrame = null) {
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

  handleWorkletMessage(message) {
    if (message?.type === 'state') {
      this.snapshotState = {
        contextTime: Number(message.body?.contextTime) || 0,
        currentFrame: clampFrame(
          Number(message.body?.currentFrame) || 0,
          this.playbackSession?.sourceLength ?? this.audioBuffer?.length ?? 0,
        ),
        ended: message.body?.ended === true,
        playing: message.body?.playing === true,
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

  projectFrameFromSnapshot(snapshotState) {
    const sourceLength = this.playbackSession?.sourceLength ?? this.audioBuffer?.length ?? 0;

    if (!snapshotState?.playing || snapshotState.ended) {
      return clampFrame(snapshotState?.currentFrame ?? 0, sourceLength);
    }

    const nowContextTime = getProjectedContextTime(this.audioContext);
    const elapsedSeconds = Math.max(0, nowContextTime - (Number(snapshotState.contextTime) || 0));
    const projectedFrame = (Number(snapshotState.currentFrame) || 0) + (elapsedSeconds * this.getSourceSampleRate());

    if (this.loopRange && this.loopRange.end > this.loopRange.start) {
      const { loopEndFrame, loopStartFrame } = this.getControlLoopFrames();
      const loopSpan = Math.max(1, loopEndFrame - loopStartFrame);
      return clampFrame(
        loopStartFrame + positiveModulo(projectedFrame - loopStartFrame, loopSpan),
        sourceLength,
      );
    }

    return clampFrame(projectedFrame, sourceLength);
  }

  applyObservedState(currentFrame, playing, ended) {
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

  markUnavailable(reason) {
    const currentTime = this.getCurrentTime();
    this.transportKind = 'unavailable';
    this.lastFallbackReason = formatTransportFailureReason(reason);
    this.playing = false;
    this.ended = false;
    this.pausedAtSeconds = this.normalizePausedTime(currentTime);
    this.disposeWorkletNode();
    this.notifyStateChange();
  }

  getSourceSampleRate() {
    return this.playbackSession?.sourceSampleRate
      || this.audioBuffer?.sampleRate
      || DEFAULT_SAMPLE_RATE;
  }

  secondsToSourceFrame(timeSeconds) {
    const sourceLength = this.playbackSession?.sourceLength ?? this.audioBuffer?.length ?? 0;
    return clampFrame(Math.round(timeSeconds * this.getSourceSampleRate()), sourceLength);
  }

  sourceFrameToSeconds(frame) {
    const sourceLength = this.playbackSession?.sourceLength ?? this.audioBuffer?.length ?? 0;
    const safeFrame = clampFrame(frame, sourceLength);
    const duration = this.getDuration();
    return clamp(safeFrame / this.getSourceSampleRate(), 0, duration);
  }

  notifyStateChange() {
    this.onStateChange?.();
  }
}

function normalizePlaybackSource(source, defaultWorkletModuleUrl) {
  const sourceOptions = isPlaybackSourceObject(source) ? source : null;
  const audioBuffer = sourceOptions?.audioBuffer ?? source;

  if (!(audioBuffer instanceof AudioBuffer)) {
    throw new Error('A decoded AudioBuffer is required for playback.');
  }

  return {
    audioBuffer,
    playbackSession: normalizePlaybackSession(sourceOptions?.playbackSession, audioBuffer),
    workletModuleUrl: typeof sourceOptions?.workletModuleUrl === 'string' && sourceOptions.workletModuleUrl.length > 0
      ? sourceOptions.workletModuleUrl
      : defaultWorkletModuleUrl,
  };
}

function normalizePlaybackSession(session, audioBuffer) {
  if (!session || typeof session !== 'object') {
    return null;
  }

  const sourceLength = Math.max(0, Math.trunc(Number(session.sourceLength) || audioBuffer.length || 0));
  const sourceSampleRate = Math.max(1, Number(session.sourceSampleRate) || audioBuffer.sampleRate || DEFAULT_SAMPLE_RATE);
  const durationSeconds = Number.isFinite(session.durationSeconds)
    ? Math.max(0, Number(session.durationSeconds))
    : audioBuffer.duration;
  const buffers = Array.isArray(session.channelBuffers)
    ? session.channelBuffers.filter((buffer) => buffer instanceof ArrayBuffer)
    : [];
  const numberOfChannels = Math.max(1, Math.trunc(Number(session.numberOfChannels) || buffers.length || audioBuffer.numberOfChannels || 1));

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

function isPlaybackSourceObject(value) {
  return Boolean(value && typeof value === 'object' && !(value instanceof AudioBuffer));
}

function getProjectedContextTime(audioContext) {
  if (!audioContext) {
    return 0;
  }

  if (typeof audioContext.getOutputTimestamp === 'function') {
    const outputTimestamp = audioContext.getOutputTimestamp();
    const contextTime = Number(outputTimestamp?.contextTime);

    if (Number.isFinite(contextTime) && contextTime >= 0) {
      return contextTime;
    }
  }

  return Number(audioContext.currentTime) || 0;
}

function formatTransportFailureReason(reason) {
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return reason.trim();
  }

  if (reason instanceof Error && typeof reason.message === 'string' && reason.message.trim().length > 0) {
    return reason.message.trim();
  }

  if (reason && typeof reason === 'object') {
    const message = reason.message;

    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }

  return 'AudioWorklet playback is unavailable.';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampFrame(frame, sourceLength) {
  const maxFrame = Math.max(0, Math.trunc(Number(sourceLength) || 0));
  const normalizedFrame = Math.round(Number(frame) || 0);
  return clamp(normalizedFrame, 0, maxFrame);
}

function normalizeLoopRange(range, duration) {
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

function positiveModulo(value, divisor) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
    return 0;
  }

  return ((value % divisor) + divisor) % divisor;
}

function areLoopRangesEqual(left, right) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return Math.abs(left.start - right.start) <= 1e-6
    && Math.abs(left.end - right.end) <= 1e-6;
}
