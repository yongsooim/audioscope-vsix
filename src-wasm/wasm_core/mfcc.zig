const std = @import("std");
const core = @import("./core.zig");
const mel_analysis = @import("./mel_analysis.zig");

const max_coefficients: usize = 64;
const max_mel_bands: usize = 512;
const low_order_coefficient_scale: f32 = 0.25;

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

pub fn writeDctBasis(destination: []f32, coefficient_count: i32, band_count: i32) void {
    const safe_coefficient_count = @as(usize, @intCast(core.maxI32(0, coefficient_count)));
    const safe_band_count = @as(usize, @intCast(core.maxI32(1, band_count)));
    const band_count_f32 = @as(f32, @floatFromInt(safe_band_count));

    for (0..safe_coefficient_count) |coefficient_index| {
        const coefficient = @as(f32, @floatFromInt(coefficient_index));
        const normalization = if (coefficient_index == 0)
            @sqrt(1.0 / band_count_f32)
        else
            @sqrt(2.0 / band_count_f32);

        for (0..safe_band_count) |band_index| {
            const band_position = @as(f32, @floatFromInt(band_index)) + 0.5;
            const angle = (std.math.pi / band_count_f32) * band_position * coefficient;
            destination[(coefficient_index * safe_band_count) + band_index] = @cos(angle) * normalization;
        }
    }
}

pub fn sampleCoefficient(
    power_spectrum: []const f32,
    row_offsets: []const i32,
    bin_indices: []const i32,
    weights: []const f32,
    dct_basis: []const f32,
    coefficient_index: usize,
) f32 {
    const band_count = row_offsets.len -| 1;
    if (band_count == 0 or band_count > max_mel_bands) {
        return 0.0;
    }

    const required_basis_length = (coefficient_index + 1) * band_count;
    if (required_basis_length > dct_basis.len) {
        return 0.0;
    }

    var band_values: [max_mel_bands]f32 = undefined;
    for (0..band_count) |band_index| {
        band_values[band_index] = powerToDb(mel_analysis.computeMelBandPowerWeighted(
            power_spectrum,
            row_offsets,
            bin_indices,
            weights,
            band_index,
        ));
    }

    const basis_offset = coefficient_index * band_count;
    var sum0: f32 = 0.0;
    var sum1: f32 = 0.0;
    var sum2: f32 = 0.0;
    var sum3: f32 = 0.0;
    var band_index: usize = 0;

    while (band_index + 4 <= band_count) : (band_index += 4) {
        sum0 += band_values[band_index] * dct_basis[basis_offset + band_index];
        sum1 += band_values[band_index + 1] * dct_basis[basis_offset + band_index + 1];
        sum2 += band_values[band_index + 2] * dct_basis[basis_offset + band_index + 2];
        sum3 += band_values[band_index + 3] * dct_basis[basis_offset + band_index + 3];
    }

    var sum = (sum0 + sum1) + (sum2 + sum3);
    while (band_index < band_count) : (band_index += 1) {
        sum += band_values[band_index] * dct_basis[basis_offset + band_index];
    }

    return sum;
}

pub fn writeColumn(
    power_spectrum: []const f32,
    row_offsets: []const i32,
    bin_indices: []const i32,
    weights: []const f32,
    dct_basis: []const f32,
    coefficient_count: usize,
    distribution_gamma: f32,
    output: [*]u8,
    output_width: usize,
    column_index: usize,
) void {
    const band_count = row_offsets.len -| 1;
    if (band_count == 0 or band_count > max_mel_bands or coefficient_count == 0 or coefficient_count > max_coefficients) {
        return;
    }

    var band_values: [max_mel_bands]f32 = undefined;
    var coefficients: [max_coefficients]f32 = undefined;

    for (0..band_count) |band_index| {
        band_values[band_index] = powerToDb(mel_analysis.computeMelBandPowerWeighted(
            power_spectrum,
            row_offsets,
            bin_indices,
            weights,
            band_index,
        ));
    }

    for (0..coefficient_count) |coefficient_index| {
        const basis_offset = coefficient_index * band_count;
        var sum0: f32 = 0.0;
        var sum1: f32 = 0.0;
        var sum2: f32 = 0.0;
        var sum3: f32 = 0.0;
        var band_index: usize = 0;

        while (band_index + 4 <= band_count) : (band_index += 4) {
            sum0 += band_values[band_index] * dct_basis[basis_offset + band_index];
            sum1 += band_values[band_index + 1] * dct_basis[basis_offset + band_index + 1];
            sum2 += band_values[band_index + 2] * dct_basis[basis_offset + band_index + 2];
            sum3 += band_values[band_index + 3] * dct_basis[basis_offset + band_index + 3];
        }

        var sum = (sum0 + sum1) + (sum2 + sum3);
        while (band_index < band_count) : (band_index += 1) {
            sum += band_values[band_index] * dct_basis[basis_offset + band_index];
        }
        coefficients[coefficient_index] = sum;
    }

    for (0..coefficient_count) |row_index| {
        const display_value = if (row_index == 0)
            coefficients[row_index] * low_order_coefficient_scale
        else
            coefficients[row_index];
        const compressed = compressCoefficient(display_value, distribution_gamma);
        const target_row = coefficient_count - row_index - 1;
        const pixel_offset = ((target_row * output_width) + column_index) * 4;
        writeCoefficientColor(compressed, output[pixel_offset..][0..4]);
    }
}
