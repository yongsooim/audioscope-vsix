import assert from 'node:assert/strict';
import test from 'node:test';

const { getSpeechSpectrogramPreset } = await import('../src-webview/audio-engine-worker/spectrogramConfig.ts');

test('speech presets use short and long windows at common sample rates', () => {
  const wide44100 = getSpeechSpectrogramPreset('formants', 44_100);
  const wide96000 = getSpeechSpectrogramPreset('formants', 96_000);
  const narrow44100 = getSpeechSpectrogramPreset('harmonics', 44_100);

  assert.equal(wide44100.fftSize, 256);
  assert.equal(wide96000.fftSize, 512);
  assert.equal(narrow44100.fftSize, 1024);
  assert.ok(wide44100.windowMilliseconds < narrow44100.windowMilliseconds);
  assert.equal(wide44100.spectrogramMaxFrequency, 5000);
  assert.equal(wide44100.frequencyScale, 'linear');
});
