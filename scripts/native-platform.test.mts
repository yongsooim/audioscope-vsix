import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { NativeManifest } from '../src/nativePlatform.ts';
const { isNativeCompatible, inspectNativeBinary, versionAtLeast } = createRequire(import.meta.url)('../src/nativePlatform.ts') as typeof import('../src/nativePlatform.ts');

const manifest: NativeManifest = {
  schema: 1, target: 'darwin-arm64', ffmpegRevision: 'a'.repeat(40), sha256: {},
  minimumKernelRelease: '21.0.0',
};

test('native compatibility rejects older macOS, wrong architectures and legacy manifests', () => {
  const runtime = { platform: 'darwin', arch: 'arm64', kernelRelease: '25.6.0' };
  assert.equal(isNativeCompatible(manifest, runtime), true);
  assert.equal(isNativeCompatible(manifest, { ...runtime, kernelRelease: '20.6.0' }), false);
  assert.equal(isNativeCompatible(manifest, { ...runtime, arch: 'x64' }), false);
  assert.equal(isNativeCompatible({ ...manifest, schema: undefined } as any, runtime), false);
  assert.equal(isNativeCompatible({ ...manifest, minimumKernelRelease: undefined }, runtime), false);
});

test('Linux compatibility rejects musl and insufficient glibc without executing a binary', () => {
  const linux: NativeManifest = { ...manifest, target: 'linux-x64', minimumKernelRelease: undefined, minimumGlibcVersion: '2.34' };
  const runtime = { platform: 'linux', arch: 'x64', kernelRelease: '6.8.0', glibcVersion: '2.35' };
  assert.equal(isNativeCompatible(linux, runtime), true);
  assert.equal(isNativeCompatible(linux, { ...runtime, glibcVersion: '2.28' }), false);
  assert.equal(isNativeCompatible(linux, { ...runtime, glibcVersion: undefined }), false);
  assert.equal(versionAtLeast('12.0.0', '12.0'), true);
  assert.equal(versionAtLeast('2.9', '2.10'), false);
  assert.equal(versionAtLeast('unknown', '2.28'), false);
});

test('Mach-O inspection reads the minimum OS rather than the SDK version', () => {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(1, 40);
  bytes.writeUInt32LE(12 << 16, 44);
  bytes.writeUInt32LE((26 << 16) | (4 << 8), 48);
  assert.deepEqual(inspectNativeBinary(bytes), { target: 'darwin-arm64', minimumMacOS: '12.0.0' });
  assert.throws(() => inspectNativeBinary(bytes.subarray(0, 45)), /Truncated|Invalid/u);
});

test('ELF and PE inspection identify x64 and ARM64 and reject corrupt files', () => {
  const elf = Buffer.alloc(64);
  elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1;
  elf.writeUInt16LE(62, 18);
  assert.equal(inspectNativeBinary(elf).target, 'linux-x64');
  elf.writeUInt16LE(183, 18);
  assert.equal(inspectNativeBinary(elf).target, 'linux-arm64');
  const pe = Buffer.alloc(128);
  pe.write('MZ'); pe.writeUInt32LE(80, 60); pe.write('50450000', 80, 'hex');
  pe.writeUInt16LE(0x8664, 84);
  assert.equal(inspectNativeBinary(pe).target, 'win32-x64');
  pe.writeUInt16LE(0xaa64, 84);
  assert.equal(inspectNativeBinary(pe).target, 'win32-arm64');
  assert.throws(() => inspectNativeBinary(Buffer.from('invalid')), /Unsupported/u);
});
