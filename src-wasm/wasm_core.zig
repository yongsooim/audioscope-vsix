const memory = @import("./wasm_core/memory.zig");
const session = @import("./wasm_core/session.zig");
const waveform = @import("./wasm_core/waveform.zig");
const loudness = @import("./wasm_core/loudness.zig");
const spectrogram = @import("./wasm_core/spectrogram.zig");

comptime {
    _ = memory;
    _ = session;
    _ = waveform;
    _ = loudness;
    _ = spectrogram;
}
