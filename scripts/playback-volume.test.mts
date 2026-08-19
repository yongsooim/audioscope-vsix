import assert from 'node:assert/strict';
import test from 'node:test';

const playbackVolumeModule = await import('../src/playbackVolume.ts');
const {
  MAX_PLAYBACK_BOOST_DB,
  MAX_PLAYBACK_VOLUME,
  normalizePlaybackVolume,
  playbackVolumeFromSliderValue,
  playbackVolumeToDecibels,
  playbackVolumeToSliderValue,
  snapPlaybackVolume,
} = playbackVolumeModule;

test('playback volume supports a bounded +12 dB boost', () => {
  assert.equal(MAX_PLAYBACK_BOOST_DB, 12);
  assert.ok(Math.abs(MAX_PLAYBACK_VOLUME - 3.9810717055349722) < 1e-12);
  assert.equal(normalizePlaybackVolume(-0.25), 0);
  assert.equal(normalizePlaybackVolume(1), 1);
  assert.equal(normalizePlaybackVolume(2), 2);
  assert.equal(normalizePlaybackVolume(5), MAX_PLAYBACK_VOLUME);
  assert.equal(normalizePlaybackVolume(Number.NaN), 1);
});

test('the boost half of the slider maps evenly from 0 to +12 dB', () => {
  const sixDbGain = playbackVolumeFromSliderValue(1.5);
  assert.ok(Math.abs(playbackVolumeToDecibels(sixDbGain) - 6) < 1e-12);
  assert.ok(Math.abs(playbackVolumeToSliderValue(sixDbGain) - 1.5) < 1e-12);
  assert.ok(Math.abs(playbackVolumeFromSliderValue(2) - MAX_PLAYBACK_VOLUME) < 1e-12);
  assert.equal(playbackVolumeFromSliderValue(1.02), 1);
});

test('playback volume has a weak snap around unity gain', () => {
  assert.equal(snapPlaybackVolume(0.98), 1);
  assert.equal(snapPlaybackVolume(1.02), 1);
  assert.equal(snapPlaybackVolume(0.97), 0.97);
  assert.equal(snapPlaybackVolume(1.03), 1.03);
});
