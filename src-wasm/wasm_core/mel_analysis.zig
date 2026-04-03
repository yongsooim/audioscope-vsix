const core = @import("./core.zig");

pub fn createMelBands(
    bands: []core.MelBand,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const rows = @as(i32, @intCast(bands.len));
    const nyquist = sample_rate / 2.0;
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const safe_min_frequency = core.maxF32(0.0, min_frequency);
    const safe_max_frequency = core.maxF32(safe_min_frequency + 1.0, max_frequency);
    const mel_min = core.hzToMel(safe_min_frequency);
    const mel_max = core.hzToMel(safe_max_frequency);
    const mel_step = (mel_max - mel_min) / @as(f32, @floatFromInt(rows + 1));

    for (bands, 0..) |*band, row_usize| {
        const row = @as(i32, @intCast(row_usize));
        const left_frequency = core.melToHz(mel_min + (mel_step * @as(f32, @floatFromInt(row))));
        const center_frequency = core.melToHz(mel_min + (mel_step * @as(f32, @floatFromInt(row + 1))));
        const right_frequency = core.melToHz(mel_min + (mel_step * @as(f32, @floatFromInt(row + 2))));
        const start_bin = core.clampi32(
            @as(i32, @intFromFloat(@floor((left_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            0,
            maximum_bin - 1,
        );
        const peak_bin = core.clampi32(
            @as(i32, @intFromFloat(@round((center_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            start_bin + 1,
            maximum_bin - 1,
        );
        const end_bin = core.clampi32(
            @as(i32, @intFromFloat(@ceil((right_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            peak_bin + 1,
            maximum_bin,
        );

        band.* = .{
            .start_bin = start_bin,
            .peak_bin = peak_bin,
            .end_bin = end_bin,
            .start_frequency = left_frequency,
            .center_frequency = center_frequency,
            .end_frequency = right_frequency,
        };
    }
}

pub fn computeMelBandPower(power_spectrum: []const f32, band: core.MelBand, fft_size: i32, sample_rate: f32) f32 {
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const nyquist = sample_rate / 2.0;
    const area_normalization = 2.0 / core.maxF32(1e-6, band.end_frequency - band.start_frequency);
    var weighted_energy: f32 = 0.0;
    var bin = band.start_bin;

    while (bin < band.end_bin) : (bin += 1) {
        const frequency = (@as(f32, @floatFromInt(bin)) / @as(f32, @floatFromInt(maximum_bin))) * nyquist;
        var weight: f32 = 0.0;

        if (frequency <= band.center_frequency) {
            const denominator = core.maxF32(1e-6, band.center_frequency - band.start_frequency);
            weight = (frequency - band.start_frequency) / denominator;
        } else {
            const denominator = core.maxF32(1e-6, band.end_frequency - band.center_frequency);
            weight = (band.end_frequency - frequency) / denominator;
        }

        weight = core.clampf32(weight, 0.0, 1.0);
        weighted_energy += power_spectrum[@as(usize, @intCast(bin))] * (weight * area_normalization);
    }

    return weighted_energy;
}
