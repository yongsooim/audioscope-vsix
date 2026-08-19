import { clamp } from '../audioscope/core/format';

export interface SpectrogramTileGeometry {
  columnCount: number;
  complete: boolean;
  renderedColumns: number;
  tileEndSample: number;
  tileStartSample: number;
}

export interface SpectrogramDisplayGeometry {
  endSampleExact: number;
  startSampleExact: number;
}

export interface SpectrogramTilePresentationGeometry {
  destinationWidthPx: number;
  destinationX: number;
  sourceWidth: number;
  sourceX: number;
}

export function getTilePresentationGeometry(
  tile: SpectrogramTileGeometry,
  displayRange: SpectrogramDisplayGeometry,
  destinationWidth: number,
): SpectrogramTilePresentationGeometry | null {
  const safeDestinationWidth = Math.max(1, destinationWidth);
  const displayStartSample = displayRange.startSampleExact;
  const displaySampleSpan = Math.max(1, displayRange.endSampleExact - displayStartSample);
  const tileSampleSpan = Math.max(1, tile.tileEndSample - tile.tileStartSample);
  const availableColumns = tile.complete
    ? tile.columnCount
    : clamp(tile.renderedColumns, 0, tile.columnCount);

  if (availableColumns <= 0) {
    return null;
  }

  const availableTileEndSample = Math.min(
    tile.tileEndSample,
    tile.tileStartSample + Math.ceil((availableColumns * tileSampleSpan) / tile.columnCount),
  );
  const overlapStartSample = Math.max(displayStartSample, tile.tileStartSample);
  const overlapEndSample = Math.min(displayRange.endSampleExact, availableTileEndSample);

  if (overlapEndSample <= overlapStartSample) {
    return null;
  }

  // Preserve the fractional crop. Flooring sourceX made follow playback hold a
  // tile still for several frames and then jump a whole analysis column, which
  // reads as horizontal jitter. Both Canvas2D and WebGPU linearly filter these
  // coordinates, so the spectrogram now advances continuously with time.
  const sourceScale = tile.columnCount / tileSampleSpan;
  const sourceX = clamp(
    (overlapStartSample - tile.tileStartSample) * sourceScale,
    0,
    availableColumns,
  );
  const sourceEndX = clamp(
    (overlapEndSample - tile.tileStartSample) * sourceScale,
    sourceX,
    availableColumns,
  );
  const sourceWidth = sourceEndX - sourceX;
  if (!(sourceWidth > 0)) {
    return null;
  }

  // Destination edges stay on whole device pixels, so neighbouring tiles share
  // one exact boundary and never open a seam while the source crop moves smoothly.
  const sampleToPixel = safeDestinationWidth / displaySampleSpan;
  const destinationX = Math.round((overlapStartSample - displayStartSample) * sampleToPixel);
  const destinationEndX = Math.round((overlapEndSample - displayStartSample) * sampleToPixel);
  const destinationWidthPx = Math.max(1, destinationEndX - destinationX);

  return {
    destinationWidthPx,
    destinationX,
    sourceWidth,
    sourceX,
  };
}
