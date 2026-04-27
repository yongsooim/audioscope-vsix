const core = @import("./core.zig");

pub const MelWeightLayout = struct {
    row_offsets: []i32,
    bin_indices: []i32,
    weights: []f32,
};

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

pub fn createMelWeightLayout(bands: []const core.MelBand, fft_size: i32, sample_rate: f32) !MelWeightLayout {
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const nyquist = sample_rate / 2.0;
    var row_offsets = try core.allocator.alloc(i32, bands.len + 1);
    errdefer core.allocator.free(row_offsets);

    var total_weight_count: usize = 0;
    row_offsets[0] = 0;
    for (bands, 0..) |band, band_index| {
        var band_weight_count: usize = 0;
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

            if (core.clampf32(weight, 0.0, 1.0) > 0.0) {
                band_weight_count += 1;
            }
        }

        total_weight_count += band_weight_count;
        row_offsets[band_index + 1] = @as(i32, @intCast(total_weight_count));
    }

    var bin_indices = try core.allocator.alloc(i32, total_weight_count);
    errdefer core.allocator.free(bin_indices);
    var weights = try core.allocator.alloc(f32, total_weight_count);
    errdefer core.allocator.free(weights);

    var cursor: usize = 0;
    for (bands) |band| {
        const area_normalization = 2.0 / core.maxF32(1e-6, band.end_frequency - band.start_frequency);
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
            if (weight <= 0.0) {
                continue;
            }

            bin_indices[cursor] = bin;
            weights[cursor] = weight * area_normalization;
            cursor += 1;
        }
    }

    return .{
        .row_offsets = row_offsets,
        .bin_indices = bin_indices,
        .weights = weights,
    };
}

pub fn computeMelBandPowerWeighted(
    power_spectrum: []const f32,
    row_offsets: []const i32,
    bin_indices: []const i32,
    weights: []const f32,
    band_index: usize,
) f32 {
    if (band_index + 1 >= row_offsets.len) {
        return 0.0;
    }

    const start = @as(usize, @intCast(core.maxI32(0, row_offsets[band_index])));
    const end = @as(usize, @intCast(core.maxI32(row_offsets[band_index], row_offsets[band_index + 1])));
    if (end <= start) {
        return 0.0;
    }

    var sum0: f32 = 0.0;
    var sum1: f32 = 0.0;
    var sum2: f32 = 0.0;
    var sum3: f32 = 0.0;
    var index = start;

    while (index + 4 <= end) : (index += 4) {
        sum0 += power_spectrum[@as(usize, @intCast(bin_indices[index]))] * weights[index];
        sum1 += power_spectrum[@as(usize, @intCast(bin_indices[index + 1]))] * weights[index + 1];
        sum2 += power_spectrum[@as(usize, @intCast(bin_indices[index + 2]))] * weights[index + 2];
        sum3 += power_spectrum[@as(usize, @intCast(bin_indices[index + 3]))] * weights[index + 3];
    }

    var total = (sum0 + sum1) + (sum2 + sum3);
    while (index < end) : (index += 1) {
        total += power_spectrum[@as(usize, @intCast(bin_indices[index]))] * weights[index];
    }

    return total;
}
