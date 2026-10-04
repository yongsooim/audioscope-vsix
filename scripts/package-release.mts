import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createVSIX } from '@vscode/vsce';
import { verifyNativeArtifacts } from './native-artifacts.mts';
import type { NativeTarget } from '../src/nativePlatform.ts';
const { NATIVE_TARGETS } = createRequire(import.meta.url)('../src/nativePlatform.ts') as typeof import('../src/nativePlatform.ts');

const root = path.resolve(import.meta.dirname, '..');
const target = process.argv[2] || process.platform + '-' + process.arch;
if (target !== 'universal' && !NATIVE_TARGETS.includes(target as NativeTarget)) {
  throw new Error('Choose a native target or universal (WASM-only).');
}
const artifactDirectory = path.join(root, '.artifacts');
const releaseDirectory = path.join(artifactDirectory, 'release');
await fs.mkdir(releaseDirectory, { recursive: true });
const stage = await fs.mkdtemp(path.join(artifactDirectory, 'package-' + target + '-'));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const packageFile = path.join(releaseDirectory, manifest.name + '-' + manifest.version + '-' + target + '.vsix');
try {
  // Stage only runtime assets. Packaging cannot invoke a build or erase the
  // platform artifacts assembled by CI.
  for (const directory of ['out', 'dist/embedded-tools', 'dist/wasm', 'dist/webview', 'images']) {
    await fs.cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
  }
  await fs.mkdir(path.join(stage, 'src-webview', 'vendor'), { recursive: true });
  for (const file of await fs.readdir(path.join(root, 'src-webview'))) {
    if (file.endsWith('.css')) await fs.copyFile(path.join(root, 'src-webview', file), path.join(stage, 'src-webview', file));
  }
  await fs.cp(path.join(root, 'src-webview', 'vendor'), path.join(stage, 'src-webview', 'vendor'), { recursive: true });
  for (const file of ['README.md', 'CHANGELOG.md', 'FFMPEG_SOURCE.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE',
    'licenses/LAME-COPYING', 'licenses/LAME-LICENSE',
    'src-wasm/third_party/ffmpeg/COPYING.LGPLv2.1', 'src-wasm/third_party/ffmpeg/COPYING.LGPLv3']) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(stage, file));
  }
  if (target !== 'universal') {
    const source = path.join(artifactDirectory, 'native-tools', target);
    await verifyNativeArtifacts(source, target as NativeTarget, root);
    const destination = path.join(stage, 'dist', 'native-tools', target);
    await fs.cp(source, destination, { recursive: true });
    for (const file of await fs.readdir(destination)) {
      if (file !== 'manifest.json') await fs.chmod(path.join(destination, file), 0o755);
    }
  }
  delete manifest.scripts;
  delete manifest.devDependencies;
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await createVSIX({
    cwd: stage, packagePath: packageFile,
    target: target === 'universal' ? undefined : target,
    dependencies: false, githubBranch: 'main',
  });
  console.log('Release package: ' + packageFile);
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
