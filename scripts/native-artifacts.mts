import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { NativeManifest, NativeTarget } from '../src/nativePlatform.ts';
const { inspectNativeBinary, NATIVE_TARGETS } = createRequire(import.meta.url)('../src/nativePlatform.ts') as typeof import('../src/nativePlatform.ts');

export async function verifyNativeArtifacts(directory: string, target: NativeTarget, root = path.resolve(import.meta.dirname, '..')) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) as NativeManifest & {
    sourceSha256: Record<string, string>;
    compilerVersion: string;
    ebur128Flags: string[];
  };
  assert.equal(manifest.schema, 1, 'Native manifest schema');
  assert.equal(manifest.target, target);
  assert.ok(NATIVE_TARGETS.includes(target));
  assert.match(manifest.compilerVersion || '', /\S/u, 'Compiler version must be recorded.');
  assert.deepEqual(manifest.ebur128Flags, target === 'darwin-arm64' ? ['-fno-vectorize'] : [],
    'EBUR128 compiler workaround');
  const shared = JSON.parse(await fs.readFile(path.join(root, 'dist', 'embedded-tools', 'manifest.json'), 'utf8'));
  assert.equal(manifest.ffmpegRevision, shared.ffmpegRevision, 'Native and WASM FFmpeg revisions must match.');
  if (target.startsWith('darwin-')) assert.equal(manifest.minimumKernelRelease, '21.0.0');
  if (target.startsWith('linux-')) assert.match(manifest.minimumGlibcVersion || '', /^\d+\.\d+$/u);
  const extension = target.startsWith('win32-') ? '.exe' : '';
  for (const tool of ['ffdecode', 'ffdecode-wav', 'ffprobe', 'ffloudness', 'ffencode']) {
    const name = tool + extension;
    const file = path.join(directory, name);
    const bytes = await fs.readFile(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256[name], 'Checksum: ' + name);
    const info = inspectNativeBinary(bytes);
    assert.equal(info.target, target, 'Machine type: ' + name);
    if (target.startsWith('darwin-')) assert.equal(info.minimumMacOS, '12.0.0', 'Deployment target: ' + name);
  }
  for (const source of ['ffdecode.c', 'ffdecode_module.c', 'ffdecode_native.c', 'ffloudness.c', 'ffencode.c',
    'loudness_graph.h', 'native_io.h', 'native_main.c']) {
    const bytes = await fs.readFile(path.join(root, 'src-wasm', 'embedded', source));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sourceSha256[source], 'Stale native source: ' + source);
  }
  return manifest;
}
