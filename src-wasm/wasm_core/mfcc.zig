const std = @import("std");
const core = @import("./core.zig");

const max_coefficients: usize = 64;
const low_order_coefficient_scale: f32 = 0.25;

fn computeMelBandPower(power_spectrum: []const f32, band: core.MelBand, fft_size: i32, sample_rate: f32) f32 {
    const nyquist = sample_rate / 2.0;
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const area_normalization = 2.0 / core.maxF32(1e-6, band.end_frequency - band.start_frequency);
    var sum: f32 = 0.0;

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

        weight = core.clampf32(weight, 0.0, 1.0) * area_normalization;
        sum += power_spectrum[@as(usize, @intCast(bin))] * weight;
    }

    return core.maxF32(sum, 1e-20);
}

fn powerToDb(power: f32) f32 {
    return 10.0 * (@log(core.maxF32(power, 1e-20)) * core.log10_of_e);
}

fn compressCoefficient(value: f32, distribution_gamma: f32) f32 {
    const contrast = core.clampf32(distribution_gamma, 0.2, 2.5);
    const magnitude = @abs(value);
    if (magnitude <= 1e-6) {
        return 0.0;
    }

    const compression = 28.0 / contrast;
    return core.clampf32(value / (magnitude + compression), -1.0, 1.0);
}

fn mixChannel(start: f32, end: f32, t: f32) u8 {
    const mixed = start + ((end - start) * core.clampf32(t, 0.0, 1.0));
    return @as(u8, @intFromFloat(@round(core.clampf32(mixed, 0.0, 255.0))));
}

fn writeGradient(start: [3]f32, end: [3]f32, t: f32, output: []u8) void {
    output[0] = mixChannel(start[0], end[0], t);
    output[1] = mixChannel(start[1], end[1], t);
    output[2] = mixChannel(start[2], end[2], t);
    output[3] = 255;
}

fn writeCoefficientColor(value: f32, output: []u8) void {
    const center = [3]f32{ 8.0, 10.0, 18.0 };
    const negative_mid = [3]f32{ 33.0, 92.0, 180.0 };
    const negative_bright = [3]f32{ 148.0, 225.0, 255.0 };
    const positive_mid = [3]f32{ 190.0, 84.0, 54.0 };
    const positive_bright = [3]f32{ 255.0, 226.0, 138.0 };
    const magnitude = @sqrt(core.clampf32(@abs(value), 0.0, 1.0));

    if (value < 0.0) {
        if (magnitude < 0.55) {
            writeGradient(center, negative_mid, magnitude / 0.55, output);
        } else {
            writeGradient(negative_mid, negative_bright, (magnitude - 0.55) / 0.45, output);
        }
    } else {
        if (magnitude < 0.55) {
            writeGradient(center, positive_mid, magnitude / 0.55, output);
        } else {
            writeGradient(positive_mid, positive_bright, (magnitude - 0.55) / 0.45, output);
        }
    }
}

pub fn writeColumn(
    power_spectrum: []const f32,
    bands: []const core.MelBand,
    fft_size: i32,
    sample_rate: f32,
    distribution_gamma: f32,
    output: [*]u8,
    output_width: usize,
    column_index: usize,
) void {
    const row_count = bands.len;
    if (row_count == 0 or row_count > max_coefficients) {
        return;
    }

    var band_values: [max_coefficients]f32 = undefined;
    var coefficients: [max_coefficients]f32 = undefined;
    const row_count_f32 = @as(f32, @floatFromInt(row_count));

    for (bands, 0..) |band, band_index| {
        band_values[band_index] = powerToDb(computeMelBandPower(power_spectrum, band, fft_size, sample_rate));
    }

    for (0..row_count) |coefficient_index| {
        var sum: f32 = 0.0;
        const coefficient = @as(f32, @floatFromInt(coefficient_index));

        for (0..row_count) |band_index| {
            const band_position = @as(f32, @floatFromInt(band_index)) + 0.5;
            const angle = (std.math.pi / row_count_f32) * band_position * coefficient;
            sum += band_values[band_index] * @cos(angle);
        }

        const normalization = if (coefficient_index == 0)
            @sqrt(1.0 / row_count_f32)
        else
            @sqrt(2.0 / row_count_f32);
        coefficients[coefficient_index] = sum * normalization;
    }

    for (0..row_count) |row_index| {
        const display_value = if (row_index == 0)
            coefficients[row_index] * low_order_coefficient_scale
        else
            coefficients[row_index];
        const compressed = compressCoefficient(display_value, distribution_gamma);
        const target_row = row_count - row_index - 1;
        const pixel_offset = ((target_row * output_width) + column_index) * 4;
        writeCoefficientColor(compressed, output[pixel_offset..][0..4]);
    }
}
