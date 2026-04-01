export type TimeRange = {
  end: number;
  start: number;
};

export interface WaveformAxisRenderOptions {
  displayRange?: TimeRange;
  displayMetrics?: WaveformDisplayWindowMetrics | null;
  renderRange?: TimeRange;
  renderWidth?: number;
}

export interface WaveformAxisTick {
  align: 'start' | 'center' | 'end';
  label: string;
  positionRatio: number;
  time: number;
}

export interface WaveformAxisSnapshot {
  renderRange: TimeRange;
  renderWidth: number;
  ticks: WaveformAxisTick[];
  viewportWidth: number;
}

export interface WaveformDisplaySnapshot {
  axisTicks: WaveformAxisTick[];
  bitmap: ImageBitmap | null;
  columnCount: number;
  displayOffsetPx: number;
  displayRange: TimeRange;
  displayWidth: number;
  rawSamplePlotMode: boolean;
  renderHeight: number;
  renderRange: TimeRange;
  renderWidth: number;
  samplePlotMode: boolean;
  visibleSpan: number;
}

export interface WaveformDisplayWindowMetrics {
  displayOffsetPx: number;
  displayRange: TimeRange;
  displayWidth: number;
  renderRange: TimeRange;
  renderSpan: number;
  renderWidth: number;
  secondsPerPixel: number;
  viewportWidth: number;
}

export interface WaveformRenderRequest {
  displayRange: TimeRange;
  end: number;
  generation: number;
  height: number;
  start: number;
  visibleSpan: number;
  width: number;
}
