const core = @import("./core.zig");

pub export fn wave_measure_loudness_summary(output_ptr: usize) i32 {
    if (core.g_session.samples.len == 0 or output_ptr == 0 or core.g_session.sample_count <= 0 or !core.isFiniteF32(core.g_session.sample_rate) or core.g_session.sample_rate <= 0.0) {
        return 0;
    }

    var state = core.ebur128_init(1, @as(c_ulong, @intFromFloat(@round(core.g_session.sample_rate))), core.ebur128_summary_mode);
    if (state == null) {
        return 0;
    }

    defer core.ebur128_destroy(&state);
    const meter = state.?;

    if (core.ebur128_add_frames_float(meter, core.g_session.samples.ptr, @as(usize, @intCast(core.g_session.sample_count))) != 0) {
        return 0;
    }

    var integrated_lufs: f64 = 0.0;
    var loudness_range_lu: f64 = 0.0;
    var sample_peak: f64 = 0.0;
    var true_peak: f64 = 0.0;

    if (core.ebur128_loudness_global(meter, &integrated_lufs) != 0) return 0;
    if (core.ebur128_loudness_range(meter, &loudness_range_lu) != 0) return 0;
    if (core.ebur128_sample_peak(meter, 0, &sample_peak) != 0) return 0;
    if (core.ebur128_true_peak(meter, 0, &true_peak) != 0) return 0;

    const output: [*]f32 = @ptrFromInt(output_ptr);
    output[0] = core.castSummaryValue(integrated_lufs);
    output[1] = core.castSummaryValue(loudness_range_lu);
    output[2] = core.linearToDecibels(sample_peak);
    output[3] = core.linearToDecibels(true_peak);
    return 1;
}
