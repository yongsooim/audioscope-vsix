import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as MediaTools from '../src/embeddedMediaTools.js';
import type * as NativeTools from '../src/nativeMediaTools.js';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');
const nodeModule = require('node:module');
const originalLoad = nodeModule._load;
let nativeDecoding = false;
nodeModule._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') {
    return { workspace: {
      getConfiguration: () => ({ get: (name: string, fallback: unknown) => name === 'nativeDecoding' ? nativeDecoding : fallback }),
      fs: { readFile: (resource: { fsPath: string; bytes?: Buffer }) =>
      resource.bytes ? Promise.resolve(resource.bytes) : fs.promises.readFile(resource.fsPath) } } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
export let mediaTools: typeof MediaTools;
export let nativeTools: typeof NativeTools;
try {
  mediaTools = require(path.join(projectRoot, 'out', 'embeddedMediaTools.js'));
  nativeTools = require(path.join(projectRoot, 'out', 'nativeMediaTools.js'));
} finally {
  nodeModule._load = originalLoad;
}

export function resourceFor(file: string): any {
  return { fsPath: file, path: file, scheme: 'file' };
}

export function setNativeDecodingForTest(enabled: boolean): () => void {
  const previous = nativeDecoding;
  nativeDecoding = enabled;
  return () => { nativeDecoding = previous; };
}

// Serial benchmark/test operations use the production entry points for both
// backends. Native errors must not silently turn into WASM timing measurements.
export async function withBackend<T>(backend: 'native' | 'wasm', run: () => Promise<T>): Promise<T> {
  const originalPath = nativeTools.getNativeExecutablePath;
  const previousDecoding = nativeDecoding;
  nativeDecoding = backend === 'native';
  const originalWarn = console.warn;
  const failures: string[] = [];
  if (backend === 'wasm') nativeTools.getNativeExecutablePath = () => null;
  else console.warn = (...args: unknown[]) => failures.push(args.map(String).join(' '));
  try {
    const value = await run();
    if (failures.length) throw new Error(failures.join('\n'));
    return value;
  } finally {
    nativeTools.getNativeExecutablePath = originalPath;
    nativeDecoding = previousDecoding;
    console.warn = originalWarn;
  }
}
