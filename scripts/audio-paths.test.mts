import assert from 'node:assert/strict';
import test from 'node:test';
const pathsModule = await import('../src/audioPaths.ts');
const { findAudioPathAtPosition, isAudioPath, MAX_AUDIO_PATH_LINE_LENGTH } = pathsModule.default ?? pathsModule;

test('audio paths in JSON, CSV, logs and pipe-delimited manifests resolve only under the cursor', () => {
  for (const [line, expected] of [
    ['{"audio": "../clips/voice one.WAV", "text": "hello"}', '../clips/voice one.WAV'],
    ['id,speaker,"/dataset/voice one.flac",en', '/dataset/voice one.flac'],
    ['utterance|text|/dataset/voice.wav', '/dataset/voice.wav'],
    ['INFO path=./clips/voice.mp3', './clips/voice.mp3'],
    ['[recording](./clips/voice.aiff)', './clips/voice.aiff'],
    ["load_audio('clips/voice one.ogg')", 'clips/voice one.ogg'],
    ['file:///dataset/voice%20one.wav', 'file:///dataset/voice%20one.wav'],
  ]) {
    const position = line.indexOf('voice');
    const result = findAudioPathAtPosition(line, position);
    assert.equal(result?.path, expected, line);
    assert.ok(result!.start <= position && result!.end > position);
  }
  const line = 'first.wav second.flac';
  assert.equal(findAudioPathAtPosition(line, 2)?.path, 'first.wav');
  assert.equal(findAudioPathAtPosition(line, 14)?.path, 'second.flac');
});

test('JSON escaped Windows paths and Unicode filenames are decoded without changing text ranges', () => {
  const expected = 'C:\\audio\\한국어 voice.wav';
  const line = JSON.stringify({ audio: expected });
  const result = findAudioPathAtPosition(line, line.indexOf('voice'));
  assert.equal(result?.path, expected);
  assert.equal(JSON.parse(`"${line.slice(result!.start, result!.end)}"`), expected);
  assert.equal(findAudioPathAtPosition('C:\\audio\\voice.wav', 10)?.path, 'C:\\audio\\voice.wav');
});

test('non-audio values, globs, network URLs and executable schemes are ignored', () => {
  for (const value of ['*.wav', 'foo?.wav', 'foo[0-9].wav', 'https://host/voice.wav',
    'command:voice.wav', 'data:voice.wav', 'voice.wav.exe', '.wav', '~/voice.wav', 'voice.wav\n']) {
    assert.equal(isAudioPath(value), false, value);
  }
  for (const line of ['*.wav', 'foo[0-9].wav', 'https://host/voice.wav', '{"text":"hello"}']) {
    for (let position = 0; position < line.length; position += 1) {
      assert.equal(findAudioPathAtPosition(line, position), undefined, line);
    }
  }
});

test('huge lines are skipped and cursor positions outside a path do not match', () => {
  const line = `${' '.repeat(MAX_AUDIO_PATH_LINE_LENGTH)}voice.wav`;
  assert.equal(findAudioPathAtPosition(line, line.length - 2), undefined);
  assert.equal(findAudioPathAtPosition('id voice.wav label', 0), undefined);
  assert.equal(findAudioPathAtPosition('voice.wav', -1), undefined);
  assert.equal(findAudioPathAtPosition('voice.wav', 100), undefined);
});
