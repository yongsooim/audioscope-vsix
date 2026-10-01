const core = @import("./core.zig");
const spectrogram = @import("./spectrogram.zig");

const max_clipping_positions = 32;
const spectrum_floor_db = -160.0;

// ABI: 15 f64 metrics, 32 f64 clipping positions, then bin_count f32
// frequencies and bin_count f32 levels. Negative values encode null metrics.
// Keep in sync with audioscope/core/selectionAnalysis.ts.
const Result = extern struct {
    start_frame: f64 = 0,
    end_frame: f64 = 0,
    sample_count: f64 = 0,
    peak_amplitude: f64 = 0,
    peak_frame: f64 = -1,
    rms: f64 = 0,
    dc_offset: f64 = 0,
    crest_factor_db: f64 = -1,
    zero_crossing_rate: f64 = 0,
    clipping_sample_count: f64 = 0,
    clipping_ratio: f64 = 0,
    clipping_position_count: f64 = 0,
    spectrum_window_count: f64 = 0,
    dominant_frequency_hz: f64 = -1,
    spectral_centroid_hz: f64 = -1,
    clipping_frames: [max_clipping_positions]f64 = @splat(0),
};

pub export fn wave_analyze_selection(
    start_input: f64,
    end_input: f64,
    fft_size: i32,
    window_code: i32,
    output_pointer: usize,
) i32 {
    if (output_pointer == 0 or core.g_session.sample_count <= 0 or
        !core.isFiniteF64(start_input) or !core.isFiniteF64(end_input) or
        fft_size < 16 or fft_size > 32768 or (fft_size & (fft_size - 1)) != 0 or
        window_code < 0 or window_code > 3) return 0;

    const start = @as(usize, @intFromFloat(core.clampf64(@round(start_input), 0, @floatFromInt(core.g_session.sample_count))));
    const end = @as(usize, @intFromFloat(core.clampf64(@round(end_input), @floatFromInt(start), @floatFromInt(core.g_session.sample_count))));
    const samples = core.g_session.samples[start..end];
    const bin_count: usize = @intCast(@divTrunc(fft_size, 2) + 1);
    const frequencies: [*]f32 = @ptrFromInt(output_pointer + @sizeOf(Result));
    const levels: [*]f32 = @ptrFromInt(output_pointer + @sizeOf(Result) + bin_count * @sizeOf(f32));
    const result: *Result = @ptrFromInt(output_pointer);
    result.* = .{ .start_frame = @floatFromInt(start), .end_frame = @floatFromInt(end), .sample_count = @floatFromInt(samples.len) };
    for (0..bin_count) |bin| {
        frequencies[bin] = @floatCast(@as(f64, @floatFromInt(bin)) * core.g_session.sample_rate / @as(f64, @floatFromInt(fft_size)));
        levels[bin] = spectrum_floor_db;
    }
    if (samples.len == 0) return 1;

    // All exact time-domain metrics share this single pass over resident PCM.
    var sum: f64 = 0;
    var sum_squares: f64 = 0;
    var peak: f64 = 0;
    var peak_frame = start;
    var clipping_count: usize = 0;
    var clipping_positions: usize = 0;
    var crossing_count: usize = 0;
    var previous_negative = samples[0] < 0;
    var in_clipping_run = false;
    for (samples, 0..) |sample, index| {
        const value: f64 = sample;
        const amplitude = @abs(value);
        sum += value;
        sum_squares += value * value;
        if (amplitude > peak) {
            peak = amplitude;
            peak_frame = start + index;
        }
        const negative = value < 0;
        if (negative != previous_negative) crossing_count += 1;
        previous_negative = negative;
        const clipping = amplitude >= 0.999;
        if (clipping) {
            clipping_count += 1;
            if (!in_clipping_run and clipping_positions < max_clipping_positions) {
                result.clipping_frames[clipping_positions] = @floatFromInt(start + index);
                clipping_positions += 1;
            }
        }
        in_clipping_run = clipping;
    }
    result.peak_amplitude = peak;
    result.peak_frame = @floatFromInt(peak_frame);
    result.rms = @sqrt(sum_squares / result.sample_count);
    result.dc_offset = sum / result.sample_count;
    if (result.rms > 0) result.crest_factor_db = @max(0, 20 * @log10(peak / result.rms));
    result.zero_crossing_rate = if (samples.len > 1) @as(f64, @floatFromInt(crossing_count)) / @as(f64, @floatFromInt(samples.len - 1)) else 0;
    result.clipping_sample_count = @floatFromInt(clipping_count);
    result.clipping_ratio = result.clipping_sample_count / result.sample_count;
    result.clipping_position_count = @floatFromInt(clipping_positions);

    // Share the spectrogram's PFFFT setup and aligned input/output/work buffers.
    // PFFFT requires at least 32 points; a 16-point request uses every other bin.
    const window_function: core.WindowFunction = @enumFromInt(window_code);
    const resource = spectrogram.getFftResource(@max(32, fft_size), window_function) orelse return 0;
    if (resource.selection_power.len == 0) {
        resource.selection_power = core.allocator.alloc(f64, resource.maximum_bin + 1) catch return 0;
    }
    const power = resource.selection_power[0..bin_count];
    @memset(power, 0);
    const window_length = @min(samples.len, @as(usize, @intCast(fft_size)));
    var window = resource.window[0..window_length];
    if (window_length != resource.fft_size) {
        if (resource.selection_window.len == 0) {
            resource.selection_window = core.allocator.alloc(f32, resource.fft_size) catch return 0;
        }
        window = resource.selection_window[0..window_length];
        for (window, 0..) |*weight, index| {
            weight.* = if (window_length < 3) 1 else core.windowValue(window_function, @intCast(index), @intCast(window_length));
        }
    }
    var window_sum: f64 = 0;
    for (window) |weight| window_sum += weight;
    const last_window_start = samples.len - window_length;
    const window_count: usize = if (last_window_start == 0) 1 else @min(64, @max(2, (samples.len - 1) / @as(usize, @intCast(@divTrunc(fft_size, 2))) + 1));
    const input = resource.input.?;
    const output = resource.output.?;
    const bin_stride = resource.fft_size / @as(usize, @intCast(fft_size));
    for (0..window_count) |window_index| {
        const window_start: usize = if (window_count == 1) 0 else @intFromFloat(@round(@as(f64, @floatFromInt(last_window_start)) * @as(f64, @floatFromInt(window_index)) / @as(f64, @floatFromInt(window_count - 1))));
        for (window, 0..) |weight, index| input[index] = samples[window_start + index] * weight;
        @memset(input[window_length..], 0);
        core.pffft_transform_ordered(resource.setup.?, input.ptr, output.ptr, resource.work.?.ptr, .forward);
        for (power, 0..) |*bin_power, bin| {
            const fft_bin = bin * bin_stride;
            const edge = bin == 0 or bin == bin_count - 1;
            const scale: f64 = (if (edge) @as(f64, 1) else 2) / window_sum;
            // PFFFT packs real DC and Nyquist values into output[0] and output[1].
            const real: f64 = if (bin == 0) output[0] else if (edge) output[1] else output[fft_bin * 2];
            const imaginary: f64 = if (edge) 0 else output[fft_bin * 2 + 1];
            bin_power.* += (real * real + imaginary * imaginary) * scale * scale;
        }
    }
    // Derive both frequency metrics while converting the same accumulated FFT to dB.
    var strongest_power: f64 = 0;
    var total_energy: f64 = 0;
    var weighted_energy: f64 = 0;
    for (power, 0..) |bin_power, bin| {
        levels[bin] = if (bin_power > 0) @floatCast(@max(spectrum_floor_db, 10 * @log10(bin_power / @as(f64, @floatFromInt(window_count))))) else spectrum_floor_db;
        if (bin_power > strongest_power) {
            strongest_power = bin_power;
            result.dominant_frequency_hz = frequencies[bin];
        }
        const energy = bin_power / (if (bin == 0 or bin == bin_count - 1) @as(f64, 1) else 2);
        total_energy += energy;
        weighted_energy += frequencies[bin] * energy;
    }
    if (total_energy > 0) result.spectral_centroid_hz = weighted_energy / total_energy;
    result.spectrum_window_count = @floatFromInt(window_count);
    return 1;
}
