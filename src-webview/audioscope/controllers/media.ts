import type { AudioscopeElements } from '../core/elements';
import { clamp } from '../core/format';

export function createExternalToolStatusState(guidance = '') {
  return {
    resolved: false,
    canDecodeFallback: false,
    canReadMetadata: false,
    ffmpegAvailable: false,
    ffmpegCommand: 'ffmpeg.wasm',
    ffmpegVersion: null,
    ffprobeAvailable: false,
    ffprobeCommand: 'ffprobe.wasm',
    ffprobeVersion: null,
    fileBacked: false,
    guidance,
  };
}

export function normalizeExternalToolStatus(status, guidance = '') {
  const base = {
    ...createExternalToolStatusState(guidance),
  };

  if (!status || typeof status !== 'object') {
    return base;
  }

  return {
    ...base,
    resolved: Boolean(status.resolved),
    canDecodeFallback: Boolean(status.canDecodeFallback),
    canReadMetadata: Boolean(status.canReadMetadata),
    ffmpegAvailable: Boolean(status.ffmpegAvailable),
    ffmpegCommand: typeof status.ffmpegCommand === 'string' && status.ffmpegCommand.trim().length > 0
      ? status.ffmpegCommand
      : base.ffmpegCommand,
    ffmpegVersion: typeof status.ffmpegVersion === 'string' && status.ffmpegVersion.trim().length > 0
      ? status.ffmpegVersion
      : null,
    ffprobeAvailable: Boolean(status.ffprobeAvailable),
    ffprobeCommand: typeof status.ffprobeCommand === 'string' && status.ffprobeCommand.trim().length > 0
      ? status.ffprobeCommand
      : base.ffprobeCommand,
    ffprobeVersion: typeof status.ffprobeVersion === 'string' && status.ffprobeVersion.trim().length > 0
      ? status.ffprobeVersion
      : null,
    fileBacked: Boolean(status.fileBacked),
    guidance: typeof status.guidance === 'string' && status.guidance.trim().length > 0
      ? status.guidance
      : base.guidance,
  };
}

export function createMediaMetadataState(status = 'idle') {
  return {
    status,
    summary: null,
    detail: null,
    message: '',
    loadToken: 0,
  };
}

export function createLoudnessSummaryState(status = 'idle') {
  return {
    status,
    channelCount: null,
    channelLayout: null,
    integratedThresholdLufs: null,
    integratedLufs: null,
    loudnessRangeLu: null,
    lraHighLufs: null,
    lraLowLufs: null,
    rangeThresholdLufs: null,
    samplePeakDbfs: null,
    truePeakDbtp: null,
    source: null,
    channelMode: null,
    message: '',
  };
}

function formatExternalToolVersion(available, version, command) {
  if (!available) {
    return `Unavailable (${command || 'tool'})`;
  }

  if (typeof version === 'string' && version.trim().length > 0) {
    return version;
  }

  return command || 'Available';
}

function parseLoudnessNumber(value) {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeLoudnessDisplayValue(value) {
  if (!Number.isFinite(value)) {
    return value;
  }

  return Math.abs(value) < 0.05 ? 0 : value;
}

function formatLoudnessValue(status, value, unit) {
  if (status === 'error') {
    return 'Unavailable';
  }

  if (status !== 'ready') {
    return '--';
  }

  if (value === Number.NEGATIVE_INFINITY) {
    return '-∞';
  }

  if (!Number.isFinite(value)) {
    return '--';
  }

  return `${normalizeLoudnessDisplayValue(value).toFixed(1)} ${unit}`;
}

function formatLoudnessSourceLabel(loudness) {
  return loudness?.status === 'ready'
    ? [loudness.source, loudness.channelLayout || loudness.channelMode].filter(Boolean).join(' • ')
    : null;
}

function formatLoudnessSummaryTitle(loudness) {
  if (loudness?.message) {
    return loudness.message;
  }

  return [
    formatLoudnessSourceLabel(loudness),
  ].filter(Boolean).join('\n');
}

function formatMetadataSummarySegments(summary) {
  if (!summary || !Array.isArray(summary.segments)) {
    return [];
  }

  return summary.segments.filter((segment) => typeof segment === 'string' && segment.trim().length > 0);
}

function appendMetadataDetailSection(container, title) {
  const section = document.createElement('section');
  section.className = 'media-metadata-section';

  if (title) {
    const heading = document.createElement('h3');
    heading.className = 'media-metadata-section-title';
    heading.textContent = title;
    section.append(heading);
  }

  container.append(section);
  return section;
}

function createMetadataExternalLink(label, url) {
  const link = document.createElement('a');
  link.className = 'media-metadata-link';
  link.href = url;
  link.rel = 'noopener noreferrer';
  link.target = '_blank';
  link.textContent = label;
  link.dataset.externalUrl = url;
  return link;
}

function appendMetadataDetailRow(container, label, value, links = []) {
  const hasTextValue = typeof value === 'string'
    ? value.trim().length > 0
    : Boolean(value);
  const normalizedLinks = Array.isArray(links) ? links.filter((link) => link?.label && link?.url) : [];

  if (!hasTextValue && normalizedLinks.length === 0) {
    return;
  }

  const row = document.createElement('div');
  row.className = 'media-metadata-row-detail';

  const labelElement = document.createElement('span');
  labelElement.className = 'media-metadata-row-label';
  labelElement.textContent = label;

  const valueElement = document.createElement('span');
  valueElement.className = 'media-metadata-row-value';

  if (hasTextValue) {
    const valueText = document.createElement('span');
    valueText.className = 'media-metadata-row-value-text';
    valueText.textContent = typeof value === 'string' ? value : String(value);
    valueElement.append(valueText);
  }

  normalizedLinks.forEach((link, index) => {
    if (hasTextValue || index > 0) {
      const separator = document.createElement('span');
      separator.className = 'media-metadata-link-separator';
      separator.textContent = '•';
      valueElement.append(separator);
    }

    valueElement.append(createMetadataExternalLink(link.label, link.url));
  });

  row.append(labelElement, valueElement);
  container.append(row);
}

function formatMetadataTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return [];
  }

  return tags
    .filter((tag) => typeof tag?.key === 'string' && typeof tag?.value === 'string')
    .map((tag) => `${tag.key}: ${tag.value}`);
}

function formatMetadataChapters(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return [];
  }

  return chapters.map((chapter, index) => {
    const range = [chapter?.startText, chapter?.endText].filter(Boolean).join(' - ');
    const title = chapter?.title || `Chapter ${index + 1}`;
    return range ? `${title} (${range})` : title;
  });
}

function appendMetadataListSection(container, title, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const section = appendMetadataDetailSection(container, title);
  const list = document.createElement('div');
  list.className = 'media-metadata-list';

  items.forEach((item) => {
    const line = document.createElement('div');
    line.className = 'media-metadata-list-item';
    line.textContent = item;
    list.append(line);
  });

  section.append(list);
}

interface MediaControllerDeps {
  embeddedMediaToolsGuidance: string;
  elements: AudioscopeElements;
  state: any;
}

export function createAudioscopeMediaController({
  embeddedMediaToolsGuidance,
  elements,
  state,
}: MediaControllerDeps) {
  function getActiveDecodeSourceKind() {
    return state.playbackSourceKind === 'ffmpeg-fallback' || state.analysisSourceKind === 'ffmpeg-fallback'
      ? 'ffmpeg-fallback'
      : 'native';
  }

  function formatMetadataDecodeSourceLabel() {
    return getActiveDecodeSourceKind() === 'ffmpeg-fallback'
      ? 'ffmpeg decode'
      : 'native browser decode';
  }

  function formatPlaybackTransportLabel() {
    if (state.playbackTransportKind === 'audio-worklet-copy') {
      return 'AudioWorklet';
    }

    if (state.playbackTransportKind === 'audio-worklet-stretch') {
      return 'AudioWorklet + Signalsmith Stretch';
    }

    return 'Playback unavailable';
  }

  function formatMetadataSummaryText() {
    const metadata = state.mediaMetadata;
    const summarySegments = formatMetadataSummarySegments(metadata?.summary);

    if (!state.activeFile) {
      return 'Open an audio file to inspect metadata.';
    }

    if (summarySegments.length > 0) {
      return summarySegments.join(' • ');
    }

    if (metadata?.status === 'pending') {
      return 'Loading metadata with ffprobe…';
    }

    if (metadata?.message) {
      return metadata.message;
    }

    if (!state.externalTools.resolved) {
      return 'Checking bundled media tools…';
    }

    if (!state.externalTools.canReadMetadata) {
      return state.externalTools.guidance || embeddedMediaToolsGuidance;
    }

    return 'Metadata unavailable.';
  }

  function syncMediaMetadataDetailVisibility() {
    if (!elements.mediaMetadataPanel || !elements.mediaMetadataDetail) {
      return;
    }

    const hasDetailContent = elements.mediaMetadataDetail.childElementCount > 0;
    const shouldShowDetail = hasDetailContent && state.mediaMetadataDetailOpen;

    elements.mediaMetadataPanel.dataset.detailOpen = shouldShowDetail ? 'true' : 'false';
    elements.mediaMetadataDetail.hidden = !shouldShowDetail;
    elements.mediaMetadataDetail.setAttribute('aria-hidden', shouldShowDetail ? 'false' : 'true');

    if (shouldShowDetail) {
      updateMediaMetadataDetailPosition();
    }
  }

  function setMediaMetadataDetailOpen(nextOpen) {
    const normalizedOpen = Boolean(nextOpen);

    if (state.mediaMetadataDetailOpen === normalizedOpen) {
      syncMediaMetadataDetailVisibility();
      return;
    }

    state.mediaMetadataDetailOpen = normalizedOpen;
    syncMediaMetadataDetailVisibility();
  }

  function updateMediaMetadataDetailPosition() {
    if (
      !elements.mediaMetadataSummary
      || !elements.mediaMetadataDetail
      || elements.mediaMetadataDetail.hidden
    ) {
      return;
    }

    const summaryRect = elements.mediaMetadataSummary.getBoundingClientRect();
    const detailRect = elements.mediaMetadataDetail.getBoundingClientRect();
    const detailWidth = detailRect.width || elements.mediaMetadataDetail.offsetWidth || 280;
    const detailHeight = detailRect.height || elements.mediaMetadataDetail.offsetHeight || 0;
    const maxLeft = Math.max(12, window.innerWidth - detailWidth - 12);
    const maxTop = Math.max(12, window.innerHeight - detailHeight - 12);
    const left = clamp(summaryRect.left, 12, maxLeft);
    const top = clamp(summaryRect.bottom - 1, 12, maxTop);

    elements.mediaMetadataDetail.style.left = `${left}px`;
    elements.mediaMetadataDetail.style.top = `${top}px`;
  }

  function renderMediaMetadata() {
    if (!elements.mediaMetadataPanel || !elements.mediaMetadataSummary || !elements.mediaMetadataDetail) {
      return;
    }

    const metadata = state.mediaMetadata ?? createMediaMetadataState('idle');
    const summaryText = formatMetadataSummaryText();
    const playbackTransportLabel = formatPlaybackTransportLabel();
    const playbackTransportError = state.playbackTransportError || null;
    const detailRoot = elements.mediaMetadataDetail;

    elements.mediaMetadataPanel.dataset.state = metadata.status;
    elements.mediaMetadataPanel.dataset.sourceKind = getActiveDecodeSourceKind();
    elements.mediaMetadataSummary.textContent = summaryText;
    elements.mediaMetadataSummary.title = [
      summaryText,
      `Playback: ${playbackTransportLabel}`,
      playbackTransportError ? `Playback status: ${playbackTransportError}` : null,
    ].filter(Boolean).join('\n');

    detailRoot.replaceChildren();

    const overviewSection = appendMetadataDetailSection(detailRoot, 'Overview');
    const detail = metadata.detail;
    const detailSummary = detail?.summary ?? null;

    appendMetadataDetailRow(overviewSection, 'Format', detail?.formatLongName || detail?.formatName || detailSummary?.containerText || null);
    appendMetadataDetailRow(overviewSection, 'Codec', detailSummary?.codecText || null);
    appendMetadataDetailRow(overviewSection, 'Sample Rate', detailSummary?.sampleRateText || null);
    appendMetadataDetailRow(overviewSection, 'Bit Depth', detailSummary?.bitDepthText || null);
    appendMetadataDetailRow(overviewSection, 'Channels', detailSummary?.channelText || null);
    appendMetadataDetailRow(overviewSection, 'Bitrate', detailSummary?.bitrateText || null);
    appendMetadataDetailRow(overviewSection, 'Duration', detailSummary?.durationText || null);
    appendMetadataDetailRow(overviewSection, 'Size', detailSummary?.sizeText || null);

    const loudnessSection = appendMetadataDetailSection(detailRoot, 'Loudness');
    const loudness = state.loudness ?? createLoudnessSummaryState('idle');
    appendMetadataDetailRow(loudnessSection, 'Integrated', formatLoudnessValue(loudness.status, loudness.integratedLufs, 'LUFS'));
    appendMetadataDetailRow(loudnessSection, 'I Threshold', formatLoudnessValue(loudness.status, loudness.integratedThresholdLufs, 'LUFS'));
    appendMetadataDetailRow(loudnessSection, 'Range', formatLoudnessValue(loudness.status, loudness.loudnessRangeLu, 'LU'));
    appendMetadataDetailRow(loudnessSection, 'LRA Threshold', formatLoudnessValue(loudness.status, loudness.rangeThresholdLufs, 'LUFS'));
    appendMetadataDetailRow(loudnessSection, 'LRA Low', formatLoudnessValue(loudness.status, loudness.lraLowLufs, 'LUFS'));
    appendMetadataDetailRow(loudnessSection, 'LRA High', formatLoudnessValue(loudness.status, loudness.lraHighLufs, 'LUFS'));
    appendMetadataDetailRow(loudnessSection, 'Sample Peak', formatLoudnessValue(loudness.status, loudness.samplePeakDbfs, 'dBFS'));
    appendMetadataDetailRow(loudnessSection, 'True Peak', formatLoudnessValue(loudness.status, loudness.truePeakDbtp, 'dBTP'));
    appendMetadataDetailRow(loudnessSection, 'Note', loudness.status === 'error' ? loudness.message : null);
    appendMetadataDetailRow(loudnessSection, 'Source', formatLoudnessSourceLabel(loudness));

    appendMetadataListSection(detailRoot, 'Tags', formatMetadataTags(detail?.tags));
    appendMetadataListSection(detailRoot, 'Chapters', formatMetadataChapters(detail?.chapters));

    const toolSection = appendMetadataDetailSection(detailRoot, 'Tools');
    appendMetadataDetailRow(toolSection, 'Decode', formatMetadataDecodeSourceLabel());
    appendMetadataDetailRow(toolSection, 'Playback', playbackTransportLabel);
    appendMetadataDetailRow(toolSection, 'Playback Status', playbackTransportError);
    appendMetadataDetailRow(toolSection, 'Probe', detail?.probeSource === 'ffprobe' ? 'ffprobe' : 'Unavailable');
    appendMetadataDetailRow(
      toolSection,
      'ffmpeg',
      formatExternalToolVersion(
        state.externalTools.ffmpegAvailable,
        state.externalTools.ffmpegVersion,
        state.externalTools.ffmpegCommand,
      ),
    );
    appendMetadataDetailRow(
      toolSection,
      'ffprobe',
      formatExternalToolVersion(
        state.externalTools.ffprobeAvailable,
        state.externalTools.ffprobeVersion,
        state.externalTools.ffprobeCommand,
      ),
    );
    const toolStatusMessage = state.decodeFallbackError?.message
      || detail?.guidance
      || metadata.message
      || state.externalTools.guidance
      || null;
    appendMetadataDetailRow(
      toolSection,
      'Status',
      toolStatusMessage === 'Using audioscope media tools.' ? null : toolStatusMessage,
    );

    syncMediaMetadataDetailVisibility();
  }

  function renderLoudnessSummary() {
    if (
      !elements.loudnessSummary
      || !elements.loudnessIntegrated
      || !elements.loudnessRange
      || !elements.loudnessSamplePeak
      || !elements.loudnessTruePeak
    ) {
      return;
    }

    const loudness = state.loudness ?? createLoudnessSummaryState('idle');
    elements.loudnessSummary.dataset.state = loudness.status;
    elements.loudnessSummary.title = formatLoudnessSummaryTitle(loudness);
    elements.loudnessIntegrated.textContent = formatLoudnessValue(loudness.status, loudness.integratedLufs, 'LUFS');
    elements.loudnessRange.textContent = formatLoudnessValue(loudness.status, loudness.loudnessRangeLu, 'LU');
    elements.loudnessSamplePeak.textContent = formatLoudnessValue(loudness.status, loudness.samplePeakDbfs, 'dBFS');
    elements.loudnessTruePeak.textContent = formatLoudnessValue(loudness.status, loudness.truePeakDbtp, 'dBTP');
    renderMediaMetadata();
  }

  function setPendingLoudnessSummary() {
    state.loudness = createLoudnessSummaryState('pending');
    renderLoudnessSummary();
  }

  function setReadyLoudnessSummary(summary) {
    state.loudness = {
      status: 'ready',
      channelCount: parseLoudnessNumber(summary?.channelCount),
      channelLayout: typeof summary?.channelLayout === 'string' ? summary.channelLayout : null,
      integratedThresholdLufs: parseLoudnessNumber(summary?.integratedThresholdLufs),
      integratedLufs: parseLoudnessNumber(summary?.integratedLufs),
      loudnessRangeLu: parseLoudnessNumber(summary?.loudnessRangeLu),
      lraHighLufs: parseLoudnessNumber(summary?.lraHighLufs),
      lraLowLufs: parseLoudnessNumber(summary?.lraLowLufs),
      rangeThresholdLufs: parseLoudnessNumber(summary?.rangeThresholdLufs),
      samplePeakDbfs: parseLoudnessNumber(summary?.samplePeakDbfs),
      truePeakDbtp: parseLoudnessNumber(summary?.truePeakDbtp),
      source: summary?.source ?? 'FFmpeg ebur128',
      channelMode: summary?.channelMode ?? 'source layout',
      message: '',
    };
    renderLoudnessSummary();
  }

  function setLoudnessSummaryUnavailable(message = 'Loudness summary unavailable.') {
    state.loudness = {
      ...createLoudnessSummaryState('error'),
      message,
    };
    renderLoudnessSummary();
  }

  return {
    formatMetadataDecodeSourceLabel,
    formatPlaybackTransportLabel,
    getActiveDecodeSourceKind,
    renderLoudnessSummary,
    renderMediaMetadata,
    setLoudnessSummaryUnavailable,
    setMediaMetadataDetailOpen,
    setPendingLoudnessSummary,
    setReadyLoudnessSummary,
    syncMediaMetadataDetailVisibility,
    updateMediaMetadataDetailPosition,
  };
}
