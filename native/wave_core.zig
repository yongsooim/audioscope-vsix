const memory = @import("./wave_core/memory.zig");
const session = @import("./wave_core/session.zig");
const waveform = @import("./wave_core/waveform.zig");
const loudness = @import("./wave_core/loudness.zig");
const spectrogram = @import("./wave_core/spectrogram.zig");

comptime {
    _ = memory;
    _ = session;
    _ = waveform;
    _ = loudness;
    _ = spectrogram;
}
