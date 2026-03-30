const std = @import("std");
const core = @import("./core.zig");

const palette_lut_size: usize = 1024;
const palette_lut = buildPaletteLut();

pub fn freeFftResources() void {
    var current = core.g_session.fft_resources;
    while (current) |node| {
        const next = node.next;
        node.deinit();
        core.allocator.destroy(node);
        current = next;
    }
    core.g_session.fft_resources = null;
}

pub fn freeBandLayoutResources() void {
    var current = core.g_session.band_layout_resources;
    while (current) |node| {
        const next = node.next;
        node.deinit();
        core.allocator.destroy(node);
        current = next;
    }
    core.g_session.band_layout_resources = null;
}

pub fn freeScalogramResources() void {
    var current = core.g_session.scalogram_resources;
    while (current) |node| {
        const next = node.next;
        node.deinit();
        core.allocator.destroy(node);
        current = next;
    }
    core.g_session.scalogram_resources = null;
}

fn getFftResource(fft_size_i32: i32) ?*core.FftResource {
    const fft_size = @as(usize, @intCast(fft_size_i32));
    const maximum_bin = @as(usize, @intCast(core.maxI32(2, @divTrunc(fft_size_i32, 2))));
    var current = core.g_session.fft_resources;
    while (current) |resource| : (current = resource.next) {
        if (resource.fft_size == fft_size) return resource;
    }

    if (fft_size == 0) return null;

    const resource = core.allocator.create(core.FftResource) catch return null;
    resource.* = .{
        .fft_size = fft_size,
        .maximum_bin = maximum_bin,
    };
    errdefer {
        resource.deinit();
        core.allocator.destroy(resource);
    }

    resource.setup = core.pffft_new_setup(@as(c_int, @intCast(fft_size)), .real) orelse return null;
    resource.input = core.makeAlignedF32Buffer(fft_size * @sizeOf(f32)) orelse return null;
    resource.output = core.makeAlignedF32Buffer(fft_size * @sizeOf(f32)) orelse return null;
    resource.work = core.makeAlignedF32Buffer(fft_size * @sizeOf(f32)) orelse return null;
    resource.window = core.allocator.alloc(f32, fft_size) catch return null;
    const power_spectrum_length = maximum_bin + 1;
    resource.power_spectrum = core.allocator.alloc(f32, power_spectrum_length) catch return null;
    resource.low_power_spectrum = core.allocator.alloc(f32, power_spectrum_length) catch return null;
    const half_fft_size = @as(f32, @floatFromInt(fft_size / 2));
    resource.power_scale = 1.0 / (half_fft_size * half_fft_size);

    const denominator = @as(f32, @floatFromInt(fft_size - 1));
    for (resource.window, 0..) |*value, index| {
        const ratio = (2.0 * std.math.pi * @as(f32, @floatFromInt(index))) / denominator;
        value.* = 0.5 * (1.0 - @cos(ratio));
    }

    resource.next = core.g_session.fft_resources;
    core.g_session.fft_resources = resource;
    return resource;
}

fn createLogBandRanges(
    ranges: []core.BandRange,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const rows = @as(i32, @intCast(ranges.len));
    const nyquist = sample_rate / 2.0;
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const safe_min_frequency = core.maxF32(1.0, min_frequency);
    const safe_max_frequency = core.maxF32(safe_min_frequency * 1.01, max_frequency);
    const log_ratio = @log(safe_max_frequency / safe_min_frequency);

    for (ranges, 0..) |*range, row_usize| {
        const row = @as(i32, @intCast(row_usize));
        const start_ratio = @as(f32, @floatFromInt(row)) / @as(f32, @floatFromInt(rows));
        const end_ratio = @as(f32, @floatFromInt(row + 1)) / @as(f32, @floatFromInt(rows));
        const start_frequency = safe_min_frequency * @exp(log_ratio * start_ratio);
        const end_frequency = safe_min_frequency * @exp(log_ratio * end_ratio);
        const start_bin = core.clampi32(
            @as(i32, @intFromFloat(@floor((start_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            1,
            maximum_bin - 1,
        );
        const end_bin = core.clampi32(
            @as(i32, @intFromFloat(@ceil((end_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            start_bin + 1,
            maximum_bin,
        );

        range.* = .{
            .start_bin = start_bin,
            .end_bin = end_bin,
            .start_frequency = start_frequency,
            .end_frequency = end_frequency,
        };
    }
}

fn createLinearBandRanges(
    ranges: []core.BandRange,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const rows = @as(i32, @intCast(ranges.len));
    const nyquist = sample_rate / 2.0;
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const safe_min_frequency = core.maxF32(1.0, min_frequency);
    const safe_max_frequency = core.maxF32(safe_min_frequency + 1.0, max_frequency);

    for (ranges, 0..) |*range, row_usize| {
        const row = @as(i32, @intCast(row_usize));
        const start_frequency = core.bandStartFrequencyForRow(row, rows, safe_min_frequency, safe_max_frequency, .linear);
        const end_frequency = core.bandEndFrequencyForRow(row, rows, safe_min_frequency, safe_max_frequency, .linear);
        const start_bin = core.clampi32(
            @as(i32, @intFromFloat(@floor((start_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            1,
            maximum_bin - 1,
        );
        const end_bin = core.clampi32(
            @as(i32, @intFromFloat(@ceil((end_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            start_bin + 1,
            maximum_bin,
        );

        range.* = .{
            .start_bin = start_bin,
            .end_bin = end_bin,
            .start_frequency = start_frequency,
            .end_frequency = end_frequency,
        };
    }
}

fn createBandRangesForSampleRate(
    output: []core.BandRange,
    template_ranges: []const core.BandRange,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const nyquist = sample_rate / 2.0;
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));

    for (output, template_ranges) |*range, template_range| {
        const start_frequency = core.minF32(
            core.maxF32(min_frequency, template_range.start_frequency),
            max_frequency * 0.999,
        );
        const end_frequency = core.minF32(
            max_frequency,
            core.maxF32(start_frequency * 1.01, template_range.end_frequency),
        );
        const start_bin = core.clampi32(
            @as(i32, @intFromFloat(@floor((start_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            1,
            maximum_bin - 1,
        );
        const end_bin = core.clampi32(
            @as(i32, @intFromFloat(@ceil((end_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            start_bin + 1,
            maximum_bin,
        );

        range.* = .{
            .start_bin = start_bin,
            .end_bin = end_bin,
            .start_frequency = start_frequency,
            .end_frequency = end_frequency,
        };
    }
}

fn createMelBands(
    bands: []core.MelBand,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const rows = @as(i32, @intCast(bands.len));
    const nyquist = sample_rate / 2.0;
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const safe_min_frequency = core.maxF32(1.0, min_frequency);
    const safe_max_frequency = core.maxF32(safe_min_frequency * 1.01, max_frequency);
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
            1,
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

fn getBandLayoutResource(
    analysis_type: core.AnalysisType,
    frequency_scale: core.FrequencyScale,
    fft_size: i32,
    decimation_factor: i32,
    row_count: i32,
    min_frequency: f32,
    max_frequency: f32,
) ?*core.BandLayoutResource {
    var current = core.g_session.band_layout_resources;
    while (current) |resource| : (current = resource.next) {
        if (resource.analysis_type == analysis_type and
            resource.frequency_scale == frequency_scale and
            resource.fft_size == fft_size and
            resource.decimation_factor == decimation_factor and
            resource.row_count == row_count and
            core.approxEqF32(resource.min_frequency, min_frequency) and
            core.approxEqF32(resource.max_frequency, max_frequency))
        {
            return resource;
        }
    }

    const resource = core.allocator.create(core.BandLayoutResource) catch return null;
    resource.* = .{
        .analysis_type = analysis_type,
        .frequency_scale = frequency_scale,
        .fft_size = fft_size,
        .decimation_factor = decimation_factor,
        .row_count = row_count,
        .min_frequency = min_frequency,
        .max_frequency = max_frequency,
    };
    errdefer {
        resource.deinit();
        core.allocator.destroy(resource);
    }

    switch (analysis_type) {
        .mel => {
            resource.mel_bands = core.allocator.alloc(core.MelBand, @as(usize, @intCast(row_count))) catch return null;
            createMelBands(resource.mel_bands, fft_size, core.g_session.sample_rate, min_frequency, max_frequency);
        },
        .spectrogram => {
            resource.band_ranges = core.allocator.alloc(core.BandRange, @as(usize, @intCast(row_count))) catch return null;
            switch (frequency_scale) {
                .linear => createLinearBandRanges(resource.band_ranges, fft_size, core.g_session.sample_rate, min_frequency, max_frequency),
                .log => createLogBandRanges(resource.band_ranges, fft_size, core.g_session.sample_rate, min_frequency, max_frequency),
            }

            if (decimation_factor > 1) {
                const effective_sample_rate = core.g_session.sample_rate / @as(f32, @floatFromInt(decimation_factor));
                resource.low_frequency_maximum = core.minF32(
                    core.low_frequency_enhancement_max_frequency,
                    core.minF32((effective_sample_rate / 2.0) * 0.92, max_frequency),
                );

                if (resource.low_frequency_maximum > min_frequency * 1.25) {
                    resource.enhanced_band_ranges = core.allocator.alloc(core.BandRange, @as(usize, @intCast(row_count))) catch return null;
                    createBandRangesForSampleRate(
                        resource.enhanced_band_ranges,
                        resource.band_ranges,
                        fft_size,
                        effective_sample_rate,
                        min_frequency,
                        resource.low_frequency_maximum,
                    );
                    resource.use_low_frequency_enhancement = true;
                }
            }
        },
        .scalogram => return null,
    }

    resource.next = core.g_session.band_layout_resources;
    core.g_session.band_layout_resources = resource;
    return resource;
}

fn getScalogramResource(row_count: i32, min_frequency: f32, max_frequency: f32) ?*core.ScalogramResource {
    var current = core.g_session.scalogram_resources;
    while (current) |resource| : (current = resource.next) {
        if (resource.row_count == row_count and
            core.approxEqF32(resource.min_frequency, min_frequency) and
            core.approxEqF32(resource.max_frequency, max_frequency))
        {
            return resource;
        }
    }

    const resource = core.allocator.create(core.ScalogramResource) catch return null;
    resource.* = .{
        .row_count = row_count,
        .min_frequency = min_frequency,
        .max_frequency = max_frequency,
        .bank = core.ScalogramKernelBank.init(row_count, min_frequency, max_frequency) catch {
            core.allocator.destroy(resource);
            return null;
        },
    };

    resource.next = core.g_session.scalogram_resources;
    core.g_session.scalogram_resources = resource;
    return resource;
}

fn writeWindowedInput(resource: *core.FftResource, center_sample: i32) void {
    const input = resource.input.?;
    const fft_size_i32 = @as(i32, @intCast(resource.fft_size));
    const window_start = center_sample - @divTrunc(fft_size_i32, 2);
    const valid_start = core.clampi32(-window_start, 0, fft_size_i32);
    const valid_end = core.clampi32(core.g_session.sample_count - window_start, 0, fft_size_i32);

    if (valid_end <= valid_start) {
        @memset(input, 0);
        return;
    }

    const valid_start_usize = @as(usize, @intCast(valid_start));
    const valid_end_usize = @as(usize, @intCast(valid_end));
    if (valid_start_usize > 0) {
        @memset(input[0..valid_start_usize], 0);
    }
    if (valid_end_usize < input.len) {
        @memset(input[valid_end_usize..], 0);
    }

    const src = core.g_session.samples[@as(usize, @intCast(window_start + valid_start))..@as(usize, @intCast(window_start + valid_end))];
    const dst = input[valid_start_usize..valid_end_usize];
    const window = resource.window[valid_start_usize..valid_end_usize];

    var index: usize = 0;
    if (comptime core.simd_enabled) {
        while (index + 4 <= src.len) : (index += 4) {
            const sample_vec = @as(core.Vec4f, src[index..][0..4].*);
            const window_vec = @as(core.Vec4f, window[index..][0..4].*);
            dst[index..][0..4].* = @as([4]f32, sample_vec * window_vec);
        }
    }

    while (index < src.len) : (index += 1) {
        dst[index] = src[index] * window[index];
    }
}

fn writeDecimatedInput(resource: *core.FftResource, center_sample: i32, decimation_factor: i32) void {
    const input = resource.input.?;
    const fft_size_i32 = @as(i32, @intCast(resource.fft_size));
    const decimated_window_start = center_sample - @divTrunc(fft_size_i32 * decimation_factor, 2);
    const decimation_scale = 1.0 / @as(f32, @floatFromInt(decimation_factor));

    for (input, resource.window, 0..) |*slot, window_value, offset_usize| {
        const offset = @as(i32, @intCast(offset_usize));
        var sum: f32 = 0.0;
        var tap: i32 = 0;

        while (tap < decimation_factor) : (tap += 1) {
            const source_index = decimated_window_start + (offset * decimation_factor) + tap;
            if (source_index >= 0 and source_index < core.g_session.sample_count) {
                sum += core.g_session.samples[@as(usize, @intCast(source_index))];
            }
        }

        slot.* = (sum * decimation_scale) * window_value;
    }
}

fn writePowerSpectrum(resource: *const core.FftResource, power_spectrum: []f32) void {
    const output = resource.output.?;

    var bin: usize = 1;
    while (bin < resource.maximum_bin) : (bin += 1) {
        const real = output[bin * 2];
        const imaginary = output[(bin * 2) + 1];
        power_spectrum[bin] = ((real * real) + (imaginary * imaginary)) * resource.power_scale;
    }
}

fn computeBandMeanPower(power_spectrum: []const f32, range: core.BandRange) f32 {
    const band_size = core.maxI32(1, range.end_bin - range.start_bin);
    var weighted_energy: f32 = 0.0;
    var total_weight: f32 = 0.0;
    var bin = range.start_bin;

    while (bin < range.end_bin) : (bin += 1) {
        const position = if (band_size == 1)
            0.5
        else
            (@as(f32, @floatFromInt(bin - range.start_bin)) + 0.5) / @as(f32, @floatFromInt(band_size));
        const taper = 1.0 - @abs((position * 2.0) - 1.0);
        const weight = 0.7 + (taper * 0.3);
        weighted_energy += power_spectrum[@as(usize, @intCast(bin))] * weight;
        total_weight += weight;
    }

    return weighted_energy / core.maxF32(total_weight, 1e-8);
}

fn computeMelBandMeanPower(power_spectrum: []const f32, band: core.MelBand, fft_size: i32, sample_rate: f32) f32 {
    const maximum_bin = core.maxI32(2, @divTrunc(fft_size, 2));
    const nyquist = sample_rate / 2.0;
    var weighted_energy: f32 = 0.0;
    var total_weight: f32 = 0.0;
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
        weighted_energy += power_spectrum[@as(usize, @intCast(bin))] * weight;
        total_weight += weight;
    }

    return weighted_energy / core.maxF32(total_weight, 1e-8);
}

fn normalizePowerToDecibels(power: f32) f32 {
    const decibels = 10.0 * core.approxLog10Positive(power + 1e-14);
    return (decibels - core.min_db) / (core.max_db - core.min_db);
}

fn computeScalogramKernelPower(center_sample: i32, kernel: *const core.ScalogramRowKernel) f32 {
    if (kernel.offsets.len == 0) return 0.0;

    const first_sample = center_sample + kernel.offsets[0];
    const last_sample = center_sample + kernel.offsets[kernel.offsets.len - 1];
    const use_full_normalization = first_sample >= 0 and last_sample < core.g_session.sample_count;

    if (kernel.stride == 1) {
        const tap_count_i32 = @as(i32, @intCast(kernel.offsets.len));
        const valid_tap_start = core.clampi32(-first_sample, 0, tap_count_i32);
        const valid_tap_end = core.clampi32(core.g_session.sample_count - first_sample, valid_tap_start, tap_count_i32);
        if (valid_tap_end <= valid_tap_start) return 0.0;

        const valid_start = @as(usize, @intCast(valid_tap_start));
        const valid_end = @as(usize, @intCast(valid_tap_end));
        const sample_start = @as(usize, @intCast(first_sample + valid_tap_start));
        const sample_end = sample_start + (valid_end - valid_start);
        const samples = core.g_session.samples[sample_start..sample_end];
        const real_weights = kernel.real_weights[valid_start..valid_end];
        const imag_weights = kernel.imag_weights[valid_start..valid_end];
        const norm_weights = kernel.norm_weights[valid_start..valid_end];
        var real: f32 = 0.0;
        var imaginary: f32 = 0.0;
        var norm: f32 = if (use_full_normalization) kernel.normalization else 0.0;
        var index: usize = 0;

        if (comptime core.simd_enabled) {
            var real_vec: core.Vec4f = @splat(0.0);
            var imaginary_vec: core.Vec4f = @splat(0.0);
            var norm_vec: core.Vec4f = @splat(0.0);

            while (index + 4 <= samples.len) : (index += 4) {
                const sample_vec = @as(core.Vec4f, samples[index..][0..4].*);
                const real_weight_vec = @as(core.Vec4f, real_weights[index..][0..4].*);
                const imag_weight_vec = @as(core.Vec4f, imag_weights[index..][0..4].*);

                real_vec += sample_vec * real_weight_vec;
                imaginary_vec += sample_vec * imag_weight_vec;
                if (!use_full_normalization) {
                    norm_vec += @as(core.Vec4f, norm_weights[index..][0..4].*);
                }
            }

            real += @reduce(.Add, real_vec);
            imaginary += @reduce(.Add, imaginary_vec);
            if (!use_full_normalization) {
                norm += @reduce(.Add, norm_vec);
            }
        }

        while (index < samples.len) : (index += 1) {
            const sample = samples[index];
            real += sample * real_weights[index];
            imaginary += sample * imag_weights[index];
            if (!use_full_normalization) {
                norm += norm_weights[index];
            }
        }

        if (norm <= 1e-8) return 0.0;
        return ((real * real) + (imaginary * imaginary)) / norm;
    }

    var real: f32 = 0.0;
    var imaginary: f32 = 0.0;
    var norm: f32 = if (use_full_normalization) kernel.normalization else 0.0;

    for (kernel.offsets, kernel.real_weights, kernel.imag_weights, kernel.norm_weights) |offset, real_weight, imag_weight, norm_weight| {
        const sample_index = center_sample + offset;
        if (sample_index < 0 or sample_index >= core.g_session.sample_count) continue;

        const sample = core.g_session.samples[@as(usize, @intCast(sample_index))];
        real += sample * real_weight;
        imaginary += sample * imag_weight;
        if (!use_full_normalization) {
            norm += norm_weight;
        }
    }

    if (norm <= 1e-8) return 0.0;
    return ((real * real) + (imaginary * imaginary)) / norm;
}

fn lerpColorChannel(start: f32, end: f32, t: f32) u8 {
    return @as(u8, @intFromFloat(@round(start + ((end - start) * t))));
}

fn paletteColorAt(normalized: f32) [4]u8 {
    const t = core.clampf32(normalized, 0.0, 1.0);
    var local_t: f32 = 0.0;
    var start_r: f32 = 0.0;
    var start_g: f32 = 0.0;
    var start_b: f32 = 0.0;
    var end_r: f32 = 0.0;
    var end_g: f32 = 0.0;
    var end_b: f32 = 0.0;

    if (t < 0.14) {
        local_t = t / 0.14;
        start_r = 4.0;
        start_g = 4.0;
        start_b = 12.0;
        end_r = 34.0;
        end_g = 17.0;
        end_b = 70.0;
    } else if (t < 0.34) {
        local_t = (t - 0.14) / 0.2;
        start_r = 34.0;
        start_g = 17.0;
        start_b = 70.0;
        end_r = 91.0;
        end_g = 31.0;
        end_b = 126.0;
    } else if (t < 0.58) {
        local_t = (t - 0.34) / 0.24;
        start_r = 91.0;
        start_g = 31.0;
        start_b = 126.0;
        end_r = 179.0;
        end_g = 68.0;
        end_b = 112.0;
    } else if (t < 0.82) {
        local_t = (t - 0.58) / 0.24;
        start_r = 179.0;
        start_g = 68.0;
        start_b = 112.0;
        end_r = 248.0;
        end_g = 143.0;
        end_b = 84.0;
    } else {
        local_t = (t - 0.82) / 0.18;
        start_r = 248.0;
        start_g = 143.0;
        start_b = 84.0;
        end_r = 252.0;
        end_g = 236.0;
        end_b = 176.0;
    }

    return .{
        lerpColorChannel(start_r, end_r, local_t),
        lerpColorChannel(start_g, end_g, local_t),
        lerpColorChannel(start_b, end_b, local_t),
        255,
    };
}

fn buildPaletteLut() [palette_lut_size][4]u8 {
    @setEvalBranchQuota(10_000);
    var lut: [palette_lut_size][4]u8 = undefined;
    for (&lut, 0..) |*entry, index| {
        const t = @as(f32, @floatFromInt(index)) / @as(f32, @floatFromInt(palette_lut_size - 1));
        entry.* = paletteColorAt(t);
    }
    return lut;
}

fn writePaletteColor(normalized: f32, output: []u8) void {
    const clamped = core.clampf32(normalized, 0.0, 1.0);
    const index = @as(usize, @intFromFloat(@round(clamped * @as(f32, @floatFromInt(palette_lut_size - 1)))));
    const color = palette_lut[index];
    output[0] = color[0];
    output[1] = color[1];
    output[2] = color[2];
    output[3] = color[3];
}

fn renderStftDerivedTile(
    analysis_type: core.AnalysisType,
    frequency_scale: core.FrequencyScale,
    tile_start: f64,
    tile_end: f64,
    column_count: i32,
    row_count: i32,
    fft_size: i32,
    decimation_factor: i32,
    min_frequency: f32,
    max_frequency: f32,
    output_ptr: i32,
) i32 {
    const resource = getFftResource(fft_size) orelse return 0;

    const safe_min_frequency = core.maxF32(core.g_session.min_frequency, min_frequency);
    const safe_max_frequency = core.minF32(core.g_session.max_frequency, max_frequency);
    const layout = getBandLayoutResource(
        analysis_type,
        frequency_scale,
        fft_size,
        decimation_factor,
        row_count,
        safe_min_frequency,
        safe_max_frequency,
    ) orelse return 0;
    const output = @as([*]u8, @ptrFromInt(@as(usize, @intCast(output_ptr))));
    const safe_tile_span = core.maxF32(1.0 / core.g_session.sample_rate, @as(f32, @floatCast(tile_end - tile_start)));
    const output_width = @as(usize, @intCast(column_count));
    const power_spectrum = resource.power_spectrum;
    const low_power_spectrum = resource.low_power_spectrum;

    var column_index: i32 = 0;
    while (column_index < column_count) : (column_index += 1) {
        const center_ratio = if (column_count == 1)
            0.5
        else
            (@as(f64, @floatFromInt(column_index)) + 0.5) / @as(f64, @floatFromInt(column_count));
        const center_time = tile_start + (center_ratio * @as(f64, safe_tile_span));
        const center_sample = @as(i32, @intFromFloat(@round(center_time * @as(f64, core.g_session.sample_rate))));
        const input = resource.input.?;
        const output_buffer = resource.output.?;
        const work_buffer = resource.work.?;
        const setup = resource.setup.?;

        writeWindowedInput(resource, center_sample);
        core.pffft_transform_ordered(setup, input.ptr, output_buffer.ptr, work_buffer.ptr, .forward);
        writePowerSpectrum(resource, power_spectrum);

        if (layout.use_low_frequency_enhancement) {
            writeDecimatedInput(resource, center_sample, decimation_factor);
            core.pffft_transform_ordered(setup, input.ptr, output_buffer.ptr, work_buffer.ptr, .forward);
            writePowerSpectrum(resource, low_power_spectrum);
        }

        var row: i32 = 0;
        while (row < row_count) : (row += 1) {
            const normalized = switch (analysis_type) {
                .mel => normalizePowerToDecibels(computeMelBandMeanPower(
                    power_spectrum,
                    layout.mel_bands[@as(usize, @intCast(row))],
                    fft_size,
                    core.g_session.sample_rate,
                )),
                .spectrogram => blk: {
                    const base_range = layout.band_ranges[@as(usize, @intCast(row))];
                    const use_low_band = layout.use_low_frequency_enhancement and base_range.end_frequency <= layout.low_frequency_maximum;
                    const active_range = if (use_low_band)
                        layout.enhanced_band_ranges[@as(usize, @intCast(row))]
                    else
                        base_range;
                    const active_power = if (use_low_band) low_power_spectrum else power_spectrum;
                    break :blk normalizePowerToDecibels(computeBandMeanPower(active_power, active_range));
                },
                .scalogram => 0.0,
            };

            const target_row = row_count - row - 1;
            const pixel_offset = ((@as(usize, @intCast(target_row)) * output_width) + @as(usize, @intCast(column_index))) * 4;
            writePaletteColor(normalized, output[pixel_offset .. pixel_offset + 4]);
        }
    }

    return 1;
}

fn renderScalogramTile(
    tile_start: f64,
    tile_end: f64,
    column_count: i32,
    row_count: i32,
    min_frequency: f32,
    max_frequency: f32,
    output_ptr: i32,
) i32 {
    const safe_min_frequency = core.maxF32(core.g_session.min_frequency, min_frequency);
    const safe_max_frequency = core.minF32(core.g_session.max_frequency, max_frequency);
    const resource = getScalogramResource(row_count, safe_min_frequency, safe_max_frequency) orelse return 0;
    const kernel_bank = &resource.bank;
    const output = @as([*]u8, @ptrFromInt(@as(usize, @intCast(output_ptr))));
    const safe_tile_span = core.maxF32(1.0 / core.g_session.sample_rate, @as(f32, @floatCast(tile_end - tile_start)));
    const output_width = @as(usize, @intCast(column_count));
    const center_samples = resource.ensureCenterSampleCapacity(column_count) catch return 0;

    var column_index: i32 = 0;
    while (column_index < column_count) : (column_index += 1) {
        const center_ratio = if (column_count == 1)
            0.5
        else
            (@as(f64, @floatFromInt(column_index)) + 0.5) / @as(f64, @floatFromInt(column_count));
        const center_time = tile_start + (center_ratio * @as(f64, safe_tile_span));
        center_samples[@as(usize, @intCast(column_index))] = @as(i32, @intFromFloat(@round(center_time * @as(f64, core.g_session.sample_rate))));
    }

    var row_block_start: i32 = 0;
    while (row_block_start < row_count) : (row_block_start += core.scalogram_row_block_size) {
        const row_block_end = core.minI32(row_count, row_block_start + core.scalogram_row_block_size);
        var row = row_block_start;

        while (row < row_block_end) : (row += 1) {
            const kernel = &kernel_bank.rows[@as(usize, @intCast(row))];
            const target_row = row_count - row - 1;
            const row_offset = @as(usize, @intCast(target_row)) * output_width * 4;
            var active_column: i32 = 0;

            while (active_column < column_count) : (active_column += 1) {
                const normalized = normalizePowerToDecibels(
                    computeScalogramKernelPower(
                        center_samples[@as(usize, @intCast(active_column))],
                        kernel,
                    ),
                );
                const pixel_offset = row_offset + (@as(usize, @intCast(active_column)) * 4);
                writePaletteColor(normalized, output[pixel_offset .. pixel_offset + 4]);
            }
        }
    }

    return 1;
}

pub export fn wave_render_spectrogram_tile_rgba(
    tile_start: f64,
    tile_end: f64,
    column_count: i32,
    row_count: i32,
    fft_size: i32,
    decimation_factor: i32,
    min_frequency: f32,
    max_frequency: f32,
    analysis_type_value: i32,
    frequency_scale_value: i32,
    output_ptr: i32,
) i32 {
    if (core.g_session.samples.len == 0 or output_ptr == 0 or column_count <= 0 or row_count <= 0 or tile_end <= tile_start) {
        return 0;
    }

    const analysis_type = core.decodeAnalysisType(analysis_type_value);
    const frequency_scale = core.decodeFrequencyScale(frequency_scale_value);

    return switch (analysis_type) {
        .scalogram => renderScalogramTile(
            tile_start,
            tile_end,
            column_count,
            row_count,
            min_frequency,
            max_frequency,
            output_ptr,
        ),
        .mel, .spectrogram => if (fft_size > 0)
            renderStftDerivedTile(
                analysis_type,
                frequency_scale,
                tile_start,
                tile_end,
                column_count,
                row_count,
                fft_size,
                decimation_factor,
                min_frequency,
                max_frequency,
                output_ptr,
            )
        else
            0,
    };
}
