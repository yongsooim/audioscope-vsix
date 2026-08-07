import * as vscode from 'vscode';

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i += 1) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function getAudioscopeWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'audioscope.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'src-webview', 'audioscope.css'));
    const engineWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'audioEngineWorker.js'));
    const analysisWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'audioAnalysisWorker.js'));
    const waveformWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'interactiveWaveformWorker.js'));
    const decodeWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'embeddedDecodeWorker.js'));
    const pcmDownmixWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'pcmDownmixWorker.js'));
    const decodeBrowserModuleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'embedded-tools', 'ffdecode_browser_module.js'));
    const decodeBrowserModuleWasmUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'embedded-tools', 'ffdecode_module.wasm'));
    const audioTransportProcessorUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'audioTransportProcessor.js'));
    const stretchProcessorUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'src-webview', 'vendor', 'SignalsmithStretch.mjs'));
    const wasmCoreSimdUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'wasm', 'wasm_core_simd.wasm'));
    const wasmCoreFallbackUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'wasm', 'wasm_core_fallback.wasm'));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} blob: data:; media-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; connect-src ${webview.cspSource} blob:; worker-src ${webview.cspSource} blob:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>audioscope</title>
  </head>
  <body data-engine-worker-src="${engineWorkerUri}" data-analysis-worker-src="${analysisWorkerUri}" data-waveform-worker-src="${waveformWorkerUri}" data-decode-module-src="${decodeBrowserModuleUri}" data-decode-module-wasm-src="${decodeBrowserModuleWasmUri}" data-decode-worker-src="${decodeWorkerUri}" data-pcm-downmix-worker-src="${pcmDownmixWorkerUri}" data-audio-transport-processor-src="${audioTransportProcessorUri}" data-stretch-processor-src="${stretchProcessorUri}" data-wasm-core-simd-src="${wasmCoreSimdUri}" data-wasm-core-fallback-src="${wasmCoreFallbackUri}">
    <main class="app-shell">
      <section id="audioscope-viewport" class="viewport" aria-label="audioscope waveform and spectrogram">
        <div id="wave-panel" class="wave-panel">
          <div id="wave-toolbar" class="wave-toolbar">
            <div id="wave-toolbar-info" class="wave-toolbar-info">
              <div id="media-metadata-panel" class="media-metadata-panel" data-state="idle" aria-label="Audio metadata">
                <div id="media-metadata-summary" class="media-metadata-summary" tabindex="0">Checking metadata…</div>
                <div id="media-metadata-detail" class="media-metadata-detail" aria-hidden="true" hidden></div>
              </div>
            </div>
            <div class="wave-toolbar-actions">
              <div class="wave-toolbar-group wave-toolbar-group-zoom wave-seg">
                <span class="wave-seg-label">Window</span>
                <button
                  id="wave-zoom-reset"
                  class="wave-tool-button wave-seg-value"
                  type="button"
                  aria-label="Reset waveform zoom"
                  aria-live="polite"
                  title="Length of the visible time window — click to fit the whole file"
                >1.0x</button>
                <button id="wave-zoom-out" class="wave-tool-button" type="button" aria-label="Zoom out waveform" title="Zoom out waveform (-)">-</button>
                <button id="wave-zoom-in" class="wave-tool-button" type="button" aria-label="Zoom in waveform" title="Zoom in waveform (+)">+</button>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-amp wave-seg">
                <span class="wave-seg-label">Amp ±</span>
                <button
                  id="wave-amp-reset"
                  class="wave-tool-button wave-seg-value"
                  type="button"
                  aria-label="Reset waveform amplitude range"
                  title="Full-scale amplitude of the Y axis — click to reset to ±1.0"
                >1</button>
                <button id="wave-amp-out" class="wave-tool-button" type="button" aria-label="Widen the waveform amplitude range" title="Widen the amplitude range">-</button>
                <button id="wave-amp-in" class="wave-tool-button" type="button" aria-label="Narrow the waveform amplitude range" title="Narrow the amplitude range">+</button>
                <button
                  id="wave-amp-fit"
                  class="wave-tool-button"
                  type="button"
                  title="Fit the Y axis to the loudest visible sample"
                >Fit</button>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-follow">
                <label class="wave-follow-toggle" title="Toggle follow playback (F)">
                  <input id="wave-follow" class="wave-follow-toggle-input" type="checkbox" aria-keyshortcuts="F" />
                  <span class="wave-follow-toggle-button">
                    <span class="wave-follow-toggle-text">Follow</span>
                    <span class="wave-follow-toggle-track" aria-hidden="true">
                      <span class="wave-follow-toggle-thumb"></span>
                    </span>
                  </span>
                </label>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-loop wave-seg">
                <div id="wave-loop-label" class="wave-toolbar-pill wave-toolbar-pill-loop">Drag to set loop</div>
                <button id="wave-clear-loop" class="wave-tool-button wave-tool-button-quiet" type="button" aria-hidden="false" disabled>Clear</button>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-export wave-seg">
                <button
                  id="wave-export"
                  class="wave-tool-button wave-tool-button-wide"
                  type="button"
                  title="Export the loop selection (drag on the waveform to set one)"
                  disabled
                >Export selected</button>
                <select id="wave-export-format" class="wave-export-format" aria-label="Export format" disabled>
                  <option value="wav" selected>wav</option>
                  <option value="mp3">mp3</option>
                  <option value="m4a">m4a</option>
                  <option value="flac">flac</option>
                </select>
              </div>
              <div class="wave-toolbar-group wave-toolbar-group-settings">
                <button
                  id="spectrogram-meta-toggle"
                  class="wave-tool-button wave-tool-button-wide"
                  type="button"
                  aria-controls="spectrogram-meta-controls"
                  aria-expanded="false"
                  aria-label="Toggle spectrogram settings"
                >Settings</button>
              </div>
            </div>
          </div>
          <div id="waveform-viewport" class="waveform-viewport" aria-label="Waveform">
            <div id="waveform-canvas-host" class="waveform-canvas-host" aria-hidden="true"></div>
            <div class="waveform-level-labels" aria-hidden="true">
              <div id="waveform-level-label-positive" class="waveform-level-label waveform-level-label-positive">1.0</div>
              <div id="waveform-level-label-negative" class="waveform-level-label waveform-level-label-negative">-1.0</div>
            </div>
            <div id="waveform-hit-target" class="waveform-hit-target" aria-hidden="true"></div>
            <div id="waveform-hover-tooltip" class="surface-hover-tooltip" aria-hidden="true"></div>
            <div id="waveform-selection" class="waveform-selection" aria-hidden="true"></div>
            <div id="waveform-progress" class="waveform-progress" aria-hidden="true"></div>
            <div id="waveform-cursor" class="waveform-cursor" aria-hidden="true"></div>
            <div id="waveform-loop-start" class="waveform-loop-handle" aria-hidden="true"></div>
            <div id="waveform-loop-end" class="waveform-loop-handle" aria-hidden="true"></div>
            <div id="waveform-loading" class="surface-loading" role="status" aria-label="Loading waveform" hidden>
              <span class="surface-loading-spinner" aria-hidden="true"></span>
            </div>
          </div>
          <div id="waveform-axis" class="waveform-axis" aria-hidden="true"></div>
        </div>
        <div
          id="viewport-splitter"
          class="viewport-splitter"
          role="separator"
          aria-controls="wave-panel spectrogram-panel"
          aria-label="Resize waveform and spectrogram panels"
          aria-orientation="horizontal"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="50"
          aria-valuetext="Waveform 50%, spectrogram 50%"
          tabindex="0"
        >
          <div class="viewport-splitter-handle" aria-hidden="true"></div>
        </div>
        <div id="spectrogram-panel" class="spectrogram-panel">
          <div id="spectrogram-axis" class="spectrogram-axis" aria-hidden="true"></div>
          <div id="spectrogram-stage" class="spectrogram-stage">
            <canvas id="spectrogram" class="spectrogram-canvas" aria-label="Spectrogram"></canvas>
            <div id="spectrogram-meta" class="spectrogram-meta" data-open="false">
              <div id="spectrogram-meta-controls" class="spectrogram-meta-controls" hidden>
                <label id="spectrogram-type-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Type</span>
                  <span class="spectrogram-control-inline">
                    <select id="spectrogram-type-select" class="spectrogram-control-select" aria-label="Spectrogram analysis type">
                      <option value="spectrogram" selected>Spectrogram</option>
                      <option value="mel">Mel-Spectrogram</option>
                      <option value="mfcc">MFCC</option>
                      <option value="scalogram">Scalogram</option>
                      <option value="chroma">Chroma</option>
                      <option value="loudness">Loudness</option>
                    </select>
                    <button
                      id="spectrogram-reset-type-button"
                      class="spectrogram-control-button"
                      type="button"
                      aria-label="Reset current spectrogram type settings to defaults"
                    >Default</button>
                  </span>
                </label>
                <label id="spectrogram-fft-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">FFT</span>
                  <select id="spectrogram-fft-select" class="spectrogram-control-select" aria-label="Spectrogram FFT size">
                    <option value="1024">1024</option>
                    <option value="2048">2048</option>
                    <option value="4096" selected>4096</option>
                    <option value="8192">8192</option>
                    <option value="16384">16384</option>
                  </select>
                </label>
                <label id="spectrogram-overlap-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Overlap</span>
                  <span class="spectrogram-control-inline">
                    <select id="spectrogram-overlap-select" class="spectrogram-control-select" aria-label="Spectrogram overlap ratio">
                      <option value="0.5">50%</option>
                      <option value="0.75" selected>75%</option>
                      <option value="0.875">87.5%</option>
                      <option value="0.9375">93.75%</option>
                    </select>
                    <span id="spectrogram-scalogram-hop-value" class="spectrogram-control-meta" aria-label="Computed spectrogram hop size">--</span>
                  </span>
                </label>
                <label id="spectrogram-window-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Window</span>
                  <select id="spectrogram-window-select" class="spectrogram-control-select" aria-label="Spectrogram window function">
                    <option value="hann" selected>Hann</option>
                    <option value="hamming">Hamming</option>
                    <option value="blackman">Blackman</option>
                    <option value="rectangular">Rectangular</option>
                  </select>
                </label>
                <label id="spectrogram-scale-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Scale</span>
                  <select id="spectrogram-scale-select" class="spectrogram-control-select" aria-label="Spectrogram frequency scale">
                    <option value="log" selected>Log</option>
                    <option value="mixed">Mixed</option>
                    <option value="linear">Linear</option>
                  </select>
                </label>
                <label id="spectrogram-mel-bands-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">Bands</span>
                  <select id="spectrogram-mel-bands-select" class="spectrogram-control-select" aria-label="Mel spectrogram band count">
                    <option value="128">128</option>
                    <option value="256" selected>256</option>
                    <option value="512">512</option>
                  </select>
                </label>
                <label id="spectrogram-mfcc-coefficients-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">n_mfcc</span>
                  <select id="spectrogram-mfcc-coefficients-select" class="spectrogram-control-select" aria-label="MFCC coefficient count">
                    <option value="13">13</option>
                    <option value="20" selected>20</option>
                    <option value="32">32</option>
                    <option value="40">40</option>
                  </select>
                </label>
                <label id="spectrogram-mfcc-mel-bands-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">n_mels</span>
                  <select id="spectrogram-mfcc-mel-bands-select" class="spectrogram-control-select" aria-label="MFCC mel filter count">
                    <option value="128" selected>128</option>
                    <option value="256">256</option>
                    <option value="512">512</option>
                  </select>
                </label>
                <label id="spectrogram-scalogram-omega-control" class="spectrogram-control spectrogram-control-slider" hidden>
                  <span class="spectrogram-control-label">Omega0</span>
                  <span class="spectrogram-control-slider-group spectrogram-control-slider-group-single spectrogram-control-slider-group-inline">
                    <span class="spectrogram-control-range-single" aria-hidden="true"></span>
                    <input
                      id="spectrogram-scalogram-omega-slider"
                      class="spectrogram-control-range spectrogram-control-range-single-input"
                      type="range"
                      min="0"
                      max="6"
                      step="1"
                      value="2"
                      aria-label="Scalogram wavelet cycles"
                    />
                    <span id="spectrogram-scalogram-omega-value" class="spectrogram-control-slider-value spectrogram-control-slider-value-inline">6</span>
                  </span>
                </label>
                <label id="spectrogram-distribution-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Curve</span>
                  <select id="spectrogram-distribution-select" class="spectrogram-control-select" aria-label="Spectrogram colormap distribution">
                    <option value="balanced" selected>Balanced</option>
                    <option value="soft">Soft</option>
                    <option value="contrast">Contrast</option>
                  </select>
                </label>
                <div id="spectrogram-db-range-control" class="spectrogram-control spectrogram-control-slider">
                  <span class="spectrogram-control-label">Min/Max</span>
                  <span id="spectrogram-db-range-group" class="spectrogram-control-slider-group spectrogram-control-slider-group-dual">
                    <span class="spectrogram-control-range-dual" aria-hidden="true"></span>
                    <input
                      id="spectrogram-min-db-slider"
                      class="spectrogram-control-range spectrogram-control-range-min"
                      type="range"
                      min="-120"
                      max="12"
                      step="1"
                      value="-80"
                      aria-label="Spectrogram minimum decibel"
                    />
                    <input
                      id="spectrogram-max-db-slider"
                      class="spectrogram-control-range spectrogram-control-range-max"
                      type="range"
                      min="-120"
                      max="12"
                      step="1"
                      value="0"
                      aria-label="Spectrogram maximum decibel"
                    />
                    <span id="spectrogram-db-range-value" class="spectrogram-control-slider-value">Min -80 / Max 0 dB</span>
                  </span>
                </div>
                <label id="spectrogram-freq-range-control" class="spectrogram-control">
                  <span class="spectrogram-control-label">Freq</span>
                  <span class="spectrogram-control-inline">
                    <input id="spectrogram-freq-min-input" class="spectrogram-control-input" type="number" min="20" max="19999" step="1" value="20" aria-label="Spectrogram minimum frequency in Hz" />
                    <span class="spectrogram-control-inline-sep" aria-hidden="true">–</span>
                    <input id="spectrogram-freq-max-input" class="spectrogram-control-input" type="number" min="21" max="20000" step="1" value="20000" aria-label="Spectrogram maximum frequency in Hz" />
                    <span class="spectrogram-control-unit" aria-hidden="true">Hz</span>
                  </span>
                </label>
                <label id="spectrogram-loudness-ref-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">Ref</span>
                  <span class="spectrogram-control-inline">
                    <select id="spectrogram-loudness-ref-select" class="spectrogram-control-select" aria-label="Loudness reference level preset">
                      <option value="off">Off</option>
                      <option value="-14" selected>Streaming (-14)</option>
                      <option value="-16">Apple (-16)</option>
                      <option value="-23">Broadcast (-23)</option>
                      <option value="custom">Custom</option>
                    </select>
                    <input id="spectrogram-loudness-ref-input" class="spectrogram-control-input" type="number" min="-70" max="6" step="1" value="-14" aria-label="Custom reference level in LUFS" hidden />
                  </span>
                </label>
                <label id="spectrogram-loudness-yaxis-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">Y-axis</span>
                  <select id="spectrogram-loudness-yaxis-select" class="spectrogram-control-select" aria-label="Loudness Y-axis mode">
                    <option value="auto" selected>Auto</option>
                    <option value="fixed">Fixed</option>
                  </select>
                </label>
                <div id="spectrogram-loudness-yrange-control" class="spectrogram-control spectrogram-control-slider" hidden>
                  <span class="spectrogram-control-label">Range</span>
                  <span id="spectrogram-loudness-yrange-group" class="spectrogram-control-slider-group spectrogram-control-slider-group-dual">
                    <span class="spectrogram-control-range-dual" aria-hidden="true"></span>
                    <input
                      id="spectrogram-loudness-min-lufs-slider"
                      class="spectrogram-control-range spectrogram-control-range-min"
                      type="range"
                      min="-70"
                      max="6"
                      step="1"
                      value="-60"
                      aria-label="Loudness Y-axis minimum LUFS"
                    />
                    <input
                      id="spectrogram-loudness-max-lufs-slider"
                      class="spectrogram-control-range spectrogram-control-range-max"
                      type="range"
                      min="-70"
                      max="6"
                      step="1"
                      value="0"
                      aria-label="Loudness Y-axis maximum LUFS"
                    />
                    <span id="spectrogram-loudness-yrange-value" class="spectrogram-control-slider-value">Min -60 / Max 0 LUFS</span>
                  </span>
                </div>
                <label id="spectrogram-loudness-curves-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">Curves</span>
                  <select id="spectrogram-loudness-curves-select" class="spectrogram-control-select" aria-label="Loudness curve visibility">
                    <option value="both" selected>Both</option>
                    <option value="momentary">Momentary</option>
                    <option value="shortTerm">Short-term</option>
                  </select>
                </label>
                <label id="spectrogram-loudness-peak-control" class="spectrogram-control" hidden>
                  <span class="spectrogram-control-label">Sample Peak</span>
                  <select id="spectrogram-loudness-peak-select" class="spectrogram-control-select" aria-label="Show sample peak curve">
                    <option value="hide" selected>Hide</option>
                    <option value="show">Show</option>
                  </select>
                </label>
                <div class="spectrogram-control-divider" aria-hidden="true">Experimental</div>
                <label id="spectrogram-webgpu-control" class="spectrogram-control" title="Render the spectrogram with WebGPU compute when available. Falls back to CPU automatically. Several times faster but uses extra GPU memory.">
                  <span class="spectrogram-control-label">WebGPU</span>
                  <span class="spectrogram-control-inline spectrogram-control-toggle-inline">
                    <input id="spectrogram-webgpu-toggle" class="spectrogram-control-toggle-input" type="checkbox" aria-label="Enable experimental WebGPU spectrogram rendering" />
                    <span class="spectrogram-control-toggle-track" aria-hidden="true">
                      <span class="spectrogram-control-toggle-thumb"></span>
                    </span>
                  </span>
                </label>
                <label id="spectrogram-split-channels-control" class="spectrogram-control" title="Show each audio channel as its own stacked lane instead of a mono downmix. Increases compute and memory with channel count.">
                  <span class="spectrogram-control-label">Channels</span>
                  <span class="spectrogram-control-inline spectrogram-control-toggle-inline">
                    <input id="spectrogram-split-channels-toggle" class="spectrogram-control-toggle-input" type="checkbox" aria-label="Split audio channels into separate lanes" />
                    <span class="spectrogram-control-toggle-track" aria-hidden="true">
                      <span class="spectrogram-control-toggle-thumb"></span>
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div id="spectrogram-hover-tooltip" class="surface-hover-tooltip surface-hover-tooltip-detail" aria-hidden="true"></div>
            <div id="spectrogram-selection" class="spectrogram-selection" aria-hidden="true"></div>
            <div id="spectrogram-progress" class="spectrogram-progress" aria-hidden="true"></div>
            <div id="spectrogram-cursor" class="spectrogram-cursor" aria-hidden="true"></div>
            <div id="spectrogram-loop-start" class="waveform-loop-handle spectrogram-loop-handle" aria-hidden="true"></div>
            <div id="spectrogram-loop-end" class="waveform-loop-handle spectrogram-loop-handle" aria-hidden="true"></div>
            <div id="spectrogram-guides" class="spectrogram-guides" aria-hidden="true"></div>
            <div id="spectrogram-loudness-ref-label" class="spectrogram-loudness-ref-label" aria-hidden="true" hidden></div>
            <div id="spectrogram-hit-target" class="spectrogram-hit-target" aria-hidden="true"></div>
            <div id="spectrogram-loading" class="surface-loading" role="status" aria-label="Loading spectrogram" hidden>
              <span class="surface-loading-spinner" aria-hidden="true"></span>
            </div>
          </div>
        </div>
      </section>
      <footer class="transport" aria-label="Playback controls">
        <button id="seek-backward" class="transport-button" type="button" aria-keyshortcuts="ArrowLeft" title="Seek backward 5 seconds (Left Arrow)" disabled>-5s</button>
        <button id="play-toggle" class="play-toggle" type="button" aria-keyshortcuts="Space" title="Toggle playback (Space)" disabled>Play</button>
        <button id="seek-forward" class="transport-button" type="button" aria-keyshortcuts="ArrowRight" title="Seek forward 5 seconds (Right Arrow)" disabled>+5s</button>
        <div class="transport-rate" role="group" aria-label="Playback speed">
          <span class="transport-rate-label">Speed</span>
          <div id="playback-rate-control" class="transport-rate-control">
            <button
              id="playback-rate-button"
              class="transport-rate-button"
              type="button"
              aria-haspopup="listbox"
              aria-controls="playback-rate-menu"
              aria-expanded="false"
              aria-label="Playback speed"
              aria-keyshortcuts="ArrowUp ArrowDown"
              title="Adjust playback speed (Up/Down Arrow)"
              disabled
            >1x</button>
            <select id="playback-rate-select" class="transport-rate-select" aria-label="Playback speed" disabled tabindex="-1">
              <option value="0.5">0.5x</option>
              <option value="0.75">0.75x</option>
              <option value="1" selected>1x</option>
              <option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option>
              <option value="2">2x</option>
            </select>
          </div>
        </div>
        <div class="transport-volume" role="group" aria-label="Playback volume">
          <span id="volume-label" class="transport-volume-label">Vol</span>
          <input
            id="volume-slider"
            class="transport-volume-slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value="1"
            aria-label="Playback volume"
            title="Volume 100%"
          />
        </div>
        <div id="time-readout" class="time-readout">0:00.00 / --:--.--</div>
        <div id="waveform-overview" class="timeline-shell">
          <div id="waveform-overview-thumb" class="timeline-viewport" aria-hidden="true"></div>
          <div id="timeline-loop-range" class="timeline-loop-range" aria-hidden="true" hidden></div>
          <div id="timeline-current-marker" class="timeline-current-marker" aria-hidden="true" hidden></div>
          <div id="timeline-hover-tooltip" class="timeline-hover-tooltip" aria-hidden="true"></div>
          <input id="timeline" class="timeline" type="range" min="0" max="1" step="0.00001" value="0" disabled />
        </div>
        <div id="loudness-summary" class="loudness-summary" data-state="idle" aria-label="Loudness summary" aria-live="polite" hidden>
          <div class="loudness-chip">
            <span class="loudness-chip-label">I</span>
            <span id="loudness-integrated" class="loudness-chip-value">--</span>
          </div>
          <div class="loudness-chip">
            <span class="loudness-chip-label">LRA</span>
            <span id="loudness-range" class="loudness-chip-value">--</span>
          </div>
          <div class="loudness-chip">
            <span class="loudness-chip-label">Peak</span>
            <span id="loudness-sample-peak" class="loudness-chip-value">--</span>
          </div>
          <div class="loudness-chip">
            <span class="loudness-chip-label">True Peak</span>
            <span id="loudness-true-peak" class="loudness-chip-value">--</span>
          </div>
        </div>
        <div id="analysis-status" class="analysis-status" role="status" aria-live="polite" aria-atomic="true">Preparing audioscope…</div>
      </footer>
      <div id="playback-rate-layer" class="transport-rate-layer" hidden>
        <div id="playback-rate-menu" class="transport-rate-menu" role="listbox" aria-label="Playback speed"></div>
      </div>
      <div id="status" class="status-overlay" role="alertdialog" aria-modal="true" aria-label="audioscope error" hidden></div>
    </main>

    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
