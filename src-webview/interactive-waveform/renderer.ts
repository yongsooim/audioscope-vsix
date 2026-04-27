export function resizeInteractiveWaveformSurface(
  surface: OffscreenCanvas,
  width: number,
  height: number,
  renderScale: number,
): boolean {
  const nextWidth = Math.max(1, Math.round(width * renderScale));
  const nextHeight = Math.max(1, Math.round(height * renderScale));
  const changed = surface.width !== nextWidth || surface.height !== nextHeight;

  if (!changed) {
    return false;
  }

  surface.width = nextWidth;
  surface.height = nextHeight;
  return true;
}
