export const NATIVE_TARGETS = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
] as const;
export type NativeTarget = typeof NATIVE_TARGETS[number];

export interface NativeManifest {
  schema: 1;
  target: NativeTarget;
  ffmpegRevision: string;
  minimumKernelRelease?: string;
  minimumGlibcVersion?: string;
  sha256: Record<string, string>;
}

export interface NativeRuntime {
  platform: string;
  arch: string;
  kernelRelease: string;
  glibcVersion?: string;
}

export function versionAtLeast(actual: string, required: string): boolean {
  if (!/^\d+(\.\d+)*$/u.test(actual) || !/^\d+(\.\d+)*$/u.test(required)) return false;
  const a = actual.split('.').map(Number);
  const b = required.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return true;
}

export function isNativeCompatible(manifest: NativeManifest, runtime: NativeRuntime): boolean {
  if (!/^[0-9a-f]{40}$/u.test(manifest.ffmpegRevision) || !manifest.sha256 || typeof manifest.sha256 !== 'object') return false;
  if (manifest.schema !== 1 || manifest.target !== runtime.platform + '-' + runtime.arch) return false;
  if (!NATIVE_TARGETS.includes(manifest.target)) return false;
  if (runtime.platform === 'darwin' && !manifest.minimumKernelRelease) return false;
  if (manifest.minimumKernelRelease && !versionAtLeast(runtime.kernelRelease, manifest.minimumKernelRelease)) return false;
  if (runtime.platform === 'linux') {
    if (!manifest.minimumGlibcVersion || !runtime.glibcVersion) return false;
    if (!versionAtLeast(runtime.glibcVersion, manifest.minimumGlibcVersion)) return false;
  }
  return true;
}

// Packaging verifies the actual machine type rather than trusting directory names.
export function inspectNativeBinary(bytes: Buffer): { target: NativeTarget; minimumMacOS?: string } {
  if (bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    const arch = cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : null;
    if (!arch) throw new Error('Unsupported Mach-O architecture.');
    let offset = 32;
    for (let index = 0; index < bytes.readUInt32LE(16); index++) {
      if (offset + 8 > bytes.length) throw new Error('Truncated Mach-O load command.');
      const command = bytes.readUInt32LE(offset);
      const size = bytes.readUInt32LE(offset + 4);
      if (size < 8 || offset + size > bytes.length) throw new Error('Invalid Mach-O load command.');
      const versionOffset = command === 0x32 ? offset + 12 : command === 0x24 ? offset + 8 : null;
      if (versionOffset !== null) {
        if (versionOffset + 4 > offset + size) throw new Error('Truncated Mach-O minimum version.');
        const version = bytes.readUInt32LE(versionOffset);
        return { target: ('darwin-' + arch) as NativeTarget,
          minimumMacOS: [version >>> 16, (version >>> 8) & 255, version & 255].join('.') };
      }
      offset += size;
    }
    throw new Error('Mach-O minimum OS version is missing.');
  }
  if (bytes.length >= 20 && bytes.toString('hex', 0, 4) === '7f454c46' && bytes[4] === 2 && bytes[5] === 1) {
    const cpu = bytes.readUInt16LE(18);
    if (cpu === 62) return { target: 'linux-x64' };
    if (cpu === 183) return { target: 'linux-arm64' };
  }
  if (bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 > bytes.length || bytes.toString('hex', offset, offset + 4) !== '50450000') {
      throw new Error('Invalid PE header.');
    }
    const cpu = bytes.readUInt16LE(offset + 4);
    if (cpu === 0x8664) return { target: 'win32-x64' };
    if (cpu === 0xaa64) return { target: 'win32-arm64' };
  }
  throw new Error('Unsupported native executable format.');
}
