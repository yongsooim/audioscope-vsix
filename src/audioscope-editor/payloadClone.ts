import type { DecodeFallbackPayload } from '../externalAudioTools';

export function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}

export function cloneDecodeFallbackPayload(payload: DecodeFallbackPayload): DecodeFallbackPayload {
  if (payload.kind === 'wav') {
    return {
      ...payload,
      audioBuffer: cloneArrayBuffer(payload.audioBuffer),
    };
  }

  return {
    ...payload,
    channelBuffers: payload.channelBuffers.map((buffer) => cloneArrayBuffer(buffer)),
  };
}
