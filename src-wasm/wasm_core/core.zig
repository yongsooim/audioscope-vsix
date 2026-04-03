const std = @import("std");
const builtin = @import("builtin");

pub const allocator = std.heap.wasm_allocator;
pub const simd_enabled = builtin.target.cpu.arch.isWasm() and std.Target.wasm.featureSetHas(builtin.target.cpu.features, .simd128);
pub const Vec4f = @Vector(4, f32);

pub const default_malloc_alignment: std.mem.Alignment = .@"16";
pub const min_level_block_size: i32 = 16;
pub const level_scale_factor: i32 = 4;
pub const min_level_buckets: i32 = 512;

pub const hard_min_frequency: f32 = 50.0;
pub const hard_max_frequency: f32 = 20_000.0;
pub const min_db: f32 = -80.0;
pub const max_db: f32 = 0.0;
pub const chroma_bin_count: i32 = 12;
pub const cqt_default_bins_per_octave: i32 = 36;
pub const cqt_default_fmin: f32 = 32.70319566257483;
pub const librosa_default_mel_band_count: i32 = 128;
pub const low_frequency_enhancement_max_frequency: f32 = 1_200.0;
pub const morlet_omega0: f32 = 6.0;
pub const morlet_support_sigma: f32 = 3.0;
pub const morlet_max_support_samples: i32 = 4096;
pub const morlet_target_steps: i32 = 96;
pub const scalogram_row_block_size: i32 = 32;
pub const log10_of_two: f32 = 0.3010299956639812;
pub const log10_of_e: f32 = 0.4342944819032518;

pub const RangeResult = struct {
    min: f32,
    max: f32,
};

pub const AnalysisType = enum(i32) {
    spectrogram = 0,
    mel = 1,
    scalogram = 2,
    mfcc = 3,
    chroma = 4,
};

pub const FrequencyScale = enum(i32) {
    log = 0,
    linear = 1,
    mixed = 2,
};

pub const WindowFunction = enum(i32) {
    hann = 0,
    hamming = 1,
    blackman = 2,
    rectangular = 3,
};

pub const PffftSetup = opaque {};
pub const PffftDirection = enum(c_int) {
    forward = 0,
    backward = 1,
};
pub const PffftTransform = enum(c_int) {
    real = 0,
    complex = 1,
};

pub extern fn pffft_new_setup(size: c_int, transform: PffftTransform) ?*PffftSetup;
pub extern fn pffft_destroy_setup(setup: *PffftSetup) void;
pub extern fn pffft_transform_ordered(
    setup: *PffftSetup,
    input: [*]const f32,
    output: [*]f32,
    work: [*]f32,
    direction: PffftDirection,
) void;
pub extern fn pffft_aligned_malloc(byte_count: usize) ?*anyopaque;
pub extern fn pffft_aligned_free(ptr: ?*anyopaque) void;

pub const AllocationHeader = extern struct {
    total_size: usize,
    base_offset: usize,
    raw_alignment: u32,
    _: u32 = 0,
};

pub const WaveLevel = struct {
    block_size: i32 = 0,
    block_count: i32 = 0,
    abs_peaks: []f32 = &.{},

    pub fn deinit(self: *WaveLevel) void {
        if (self.abs_peaks.len > 0) allocator.free(self.abs_peaks);
        self.* = .{};
    }
};

pub const FftResource = struct {
    fft_size: usize = 0,
    maximum_bin: usize = 0,
    window_function: WindowFunction = .hann,
    power_scale: f32 = 0.0,
    setup: ?*PffftSetup = null,
    input: ?[]align(16) f32 = null,
    output: ?[]align(16) f32 = null,
    work: ?[]align(16) f32 = null,
    window: []f32 = &.{},
    power_spectrum: []f32 = &.{},
    low_power_spectrum: []f32 = &.{},
    next: ?*FftResource = null,

    pub fn deinit(self: *FftResource) void {
        if (self.setup) |setup| pffft_destroy_setup(setup);
        if (self.input) |buffer| pffft_aligned_free(@ptrCast(buffer.ptr));
        if (self.output) |buffer| pffft_aligned_free(@ptrCast(buffer.ptr));
        if (self.work) |buffer| pffft_aligned_free(@ptrCast(buffer.ptr));
        if (self.window.len > 0) allocator.free(self.window);
        if (self.power_spectrum.len > 0) allocator.free(self.power_spectrum);
        if (self.low_power_spectrum.len > 0) allocator.free(self.low_power_spectrum);
        self.* = .{};
    }
};

pub const BandRange = extern struct {
    start_bin: i32 = 0,
    end_bin: i32 = 0,
    start_frequency: f32 = 0,
    end_frequency: f32 = 0,
};

pub const MelBand = struct {
    start_bin: i32 = 0,
    peak_bin: i32 = 0,
    end_bin: i32 = 0,
    start_frequency: f32 = 0,
    center_frequency: f32 = 0,
    end_frequency: f32 = 0,
};

pub const ScalogramRowKernel = struct {
    frequency: f32 = 0.0,
    scale_seconds: f32 = 0.0,
    support_samples: i32 = 0,
    stride: i32 = 1,
    normalization: f32 = 0.0,
    offsets: []i32 = &.{},
    real_weights: []f32 = &.{},
    imag_weights: []f32 = &.{},
    norm_weights: []f32 = &.{},
};

pub const ScalogramKernelBank = struct {
    rows: []ScalogramRowKernel = &.{},
    offsets: []i32 = &.{},
    real_weights: []f32 = &.{},
    imag_weights: []f32 = &.{},
    norm_weights: []f32 = &.{},

    pub fn init(row_count: i32, min_frequency: f32, max_frequency: f32, omega0: f32) !ScalogramKernelBank {
        const frequencies = try allocator.alloc(f32, @as(usize, @intCast(row_count)));
        defer allocator.free(frequencies);

        for (frequencies, 0..) |*frequency, row_usize| {
            frequency.* = frequencyForScalogramRow(
                @as(i32, @intCast(row_usize)),
                row_count,
                min_frequency,
                max_frequency,
            );
        }

        return initMorletFromFrequencies(frequencies, omega0);
    }

    pub fn initMorletFromFrequencies(frequencies: []const f32, omega0: f32) !ScalogramKernelBank {
        var bank: ScalogramKernelBank = .{};
        errdefer bank.deinit();

        bank.rows = try allocator.alloc(ScalogramRowKernel, frequencies.len);
        for (bank.rows) |*row| row.* = .{};

        var total_tap_count: usize = 0;
        for (bank.rows, frequencies) |*row_kernel, frequency| {
            const safe_frequency = maxF32(1.0, frequency);
            const scale_seconds = omega0 / (2.0 * std.math.pi * safe_frequency);
            const support_samples = minI32(
                morlet_max_support_samples,
                maxI32(24, @as(i32, @intFromFloat(@ceil(scale_seconds * morlet_support_sigma * g_session.sample_rate)))),
            );
            const stride = maxI32(1, @divTrunc(support_samples, morlet_target_steps));
            const tap_count = @as(usize, @intCast(@divFloor(support_samples * 2, stride) + 1));

            row_kernel.* = .{
                .frequency = frequency,
                .scale_seconds = scale_seconds,
                .support_samples = support_samples,
                .stride = stride,
            };
            total_tap_count += tap_count;
        }

        bank.offsets = try allocator.alloc(i32, total_tap_count);
        bank.real_weights = try allocator.alloc(f32, total_tap_count);
        bank.imag_weights = try allocator.alloc(f32, total_tap_count);
        bank.norm_weights = try allocator.alloc(f32, total_tap_count);

        var tap_cursor: usize = 0;
        for (bank.rows) |*row_kernel| {
            const tap_count = @as(usize, @intCast(@divFloor(row_kernel.support_samples * 2, row_kernel.stride) + 1));
            const offsets = bank.offsets[tap_cursor .. tap_cursor + tap_count];
            const real_weights = bank.real_weights[tap_cursor .. tap_cursor + tap_count];
            const imag_weights = bank.imag_weights[tap_cursor .. tap_cursor + tap_count];
            const norm_weights = bank.norm_weights[tap_cursor .. tap_cursor + tap_count];

            row_kernel.offsets = offsets;
            row_kernel.real_weights = real_weights;
            row_kernel.imag_weights = imag_weights;
            row_kernel.norm_weights = norm_weights;

            const phase_step = (2.0 * std.math.pi * row_kernel.frequency * @as(f32, @floatFromInt(row_kernel.stride))) / g_session.sample_rate;
            const step_cos = @cos(phase_step);
            const step_sin = @sin(phase_step);
            const initial_phase = (2.0 * std.math.pi * row_kernel.frequency * @as(f32, @floatFromInt(-row_kernel.support_samples))) / g_session.sample_rate;
            var phase_cos = @cos(initial_phase);
            var phase_sin = @sin(initial_phase);
            var normalization: f32 = 0.0;
            var offset = -row_kernel.support_samples;
            var tap_index: usize = 0;

            while (tap_index < tap_count) : (tap_index += 1) {
                const time = @as(f32, @floatFromInt(offset)) / g_session.sample_rate;
                const normalized_time = time / row_kernel.scale_seconds;
                const gaussian = @exp(-0.5 * normalized_time * normalized_time);
                const norm_weight = gaussian * gaussian;

                offsets[tap_index] = offset;
                real_weights[tap_index] = gaussian * phase_cos;
                imag_weights[tap_index] = -gaussian * phase_sin;
                norm_weights[tap_index] = norm_weight;
                normalization += norm_weight;

                const next_phase_cos = (phase_cos * step_cos) - (phase_sin * step_sin);
                phase_sin = (phase_sin * step_cos) + (phase_cos * step_sin);
                phase_cos = next_phase_cos;
                offset += row_kernel.stride;
            }

            row_kernel.normalization = normalization;
            tap_cursor += tap_count;
        }

        return bank;
    }

    pub fn initFromFrequencies(frequencies: []const f32, window_function: WindowFunction) !ScalogramKernelBank {
        var bank: ScalogramKernelBank = .{};
        errdefer bank.deinit();

        bank.rows = try allocator.alloc(ScalogramRowKernel, frequencies.len);
        for (bank.rows) |*row| row.* = .{};

        var total_tap_count: usize = 0;
        for (bank.rows, frequencies) |*row_kernel, frequency| {
            const safe_frequency = maxF32(1.0, frequency);
            const q_value = @as(f32, @floatFromInt(cqt_default_bins_per_octave)) / (std.math.pow(f32, 2.0, 1.0 / @as(f32, @floatFromInt(cqt_default_bins_per_octave))) - 1.0);
            const support_samples = minI32(
                morlet_max_support_samples,
                maxI32(24, @as(i32, @intFromFloat(@ceil((q_value * g_session.sample_rate) / safe_frequency)))),
            );
            const stride = maxI32(1, @divTrunc(support_samples, morlet_target_steps));
            const tap_count = @as(usize, @intCast(@divFloor(support_samples * 2, stride) + 1));

            row_kernel.* = .{
                .frequency = frequency,
                .scale_seconds = @as(f32, @floatFromInt(support_samples)) / g_session.sample_rate,
                .support_samples = support_samples,
                .stride = stride,
            };
            total_tap_count += tap_count;
        }

        bank.offsets = try allocator.alloc(i32, total_tap_count);
        bank.real_weights = try allocator.alloc(f32, total_tap_count);
        bank.imag_weights = try allocator.alloc(f32, total_tap_count);
        bank.norm_weights = try allocator.alloc(f32, total_tap_count);

        var tap_cursor: usize = 0;
        for (bank.rows) |*row_kernel| {
            const tap_count = @as(usize, @intCast(@divFloor(row_kernel.support_samples * 2, row_kernel.stride) + 1));
            const offsets = bank.offsets[tap_cursor .. tap_cursor + tap_count];
            const real_weights = bank.real_weights[tap_cursor .. tap_cursor + tap_count];
            const imag_weights = bank.imag_weights[tap_cursor .. tap_cursor + tap_count];
            const norm_weights = bank.norm_weights[tap_cursor .. tap_cursor + tap_count];

            row_kernel.offsets = offsets;
            row_kernel.real_weights = real_weights;
            row_kernel.imag_weights = imag_weights;
            row_kernel.norm_weights = norm_weights;

            const phase_step = (2.0 * std.math.pi * row_kernel.frequency * @as(f32, @floatFromInt(row_kernel.stride))) / g_session.sample_rate;
            const step_cos = @cos(phase_step);
            const step_sin = @sin(phase_step);
            const initial_phase = (2.0 * std.math.pi * row_kernel.frequency * @as(f32, @floatFromInt(-row_kernel.support_samples))) / g_session.sample_rate;
            var phase_cos = @cos(initial_phase);
            var phase_sin = @sin(initial_phase);
            var normalization: f32 = 0.0;
            var offset = -row_kernel.support_samples;
            var tap_index: usize = 0;

            while (tap_index < tap_count) : (tap_index += 1) {
                const window_value = windowValue(window_function, @as(i32, @intCast(tap_index)), @as(i32, @intCast(tap_count)));
                const norm_weight = window_value * window_value;

                offsets[tap_index] = offset;
                real_weights[tap_index] = window_value * phase_cos;
                imag_weights[tap_index] = -window_value * phase_sin;
                norm_weights[tap_index] = norm_weight;
                normalization += norm_weight;

                const next_phase_cos = (phase_cos * step_cos) - (phase_sin * step_sin);
                phase_sin = (phase_sin * step_cos) + (phase_cos * step_sin);
                phase_cos = next_phase_cos;
                offset += row_kernel.stride;
            }

            row_kernel.normalization = normalization;
            tap_cursor += tap_count;
        }

        return bank;
    }

    pub fn deinit(self: *ScalogramKernelBank) void {
        if (self.rows.len > 0) allocator.free(self.rows);
        if (self.offsets.len > 0) allocator.free(self.offsets);
        if (self.real_weights.len > 0) allocator.free(self.real_weights);
        if (self.imag_weights.len > 0) allocator.free(self.imag_weights);
        if (self.norm_weights.len > 0) allocator.free(self.norm_weights);
        self.* = .{};
    }
};

pub const BandLayoutResource = struct {
    analysis_type: AnalysisType = .spectrogram,
    frequency_scale: FrequencyScale = .log,
    fft_size: i32 = 0,
    decimation_factor: i32 = 1,
    row_count: i32 = 0,
    band_count: i32 = 0,
    min_frequency: f32 = 0.0,
    max_frequency: f32 = 0.0,
    band_ranges: []BandRange = &.{},
    mel_bands: []MelBand = &.{},
    mfcc_basis: []f32 = &.{},
    enhanced_band_ranges: []BandRange = &.{},
    use_low_frequency_enhancement: bool = false,
    low_frequency_maximum: f32 = 0.0,
    next: ?*BandLayoutResource = null,

    pub fn deinit(self: *BandLayoutResource) void {
        if (self.band_ranges.len > 0) allocator.free(self.band_ranges);
        if (self.mel_bands.len > 0) allocator.free(self.mel_bands);
        if (self.mfcc_basis.len > 0) allocator.free(self.mfcc_basis);
        if (self.enhanced_band_ranges.len > 0) allocator.free(self.enhanced_band_ranges);
        self.* = .{};
    }
};

pub const ScalogramResource = struct {
    row_count: i32 = 0,
    min_frequency: f32 = 0.0,
    max_frequency: f32 = 0.0,
    omega0: f32 = morlet_omega0,
    bank: ScalogramKernelBank = .{},
    center_samples: []i32 = &.{},
    next: ?*ScalogramResource = null,

    pub fn ensureCenterSampleCapacity(self: *ScalogramResource, column_count: i32) ![]i32 {
        const required = @as(usize, @intCast(column_count));
        if (self.center_samples.len < required) {
            if (self.center_samples.len > 0) allocator.free(self.center_samples);
            self.center_samples = try allocator.alloc(i32, required);
        }
        return self.center_samples[0..required];
    }

    pub fn deinit(self: *ScalogramResource) void {
        self.bank.deinit();
        if (self.center_samples.len > 0) allocator.free(self.center_samples);
        self.* = .{};
    }
};

pub const ChromaLayoutResource = struct {
    analysis_type: AnalysisType = .chroma,
    fft_size: i32 = 0,
    sample_rate: f32 = 0.0,
    min_frequency: f32 = 0.0,
    max_frequency: f32 = 0.0,
    bin_count: i32 = 0,
    bins_per_octave: i32 = cqt_default_bins_per_octave,
    row_offsets: []i32 = &.{},
    bin_indices: []i32 = &.{},
    weights: []f32 = &.{},
    next: ?*ChromaLayoutResource = null,

    pub fn deinit(self: *ChromaLayoutResource) void {
        if (self.row_offsets.len > 0) allocator.free(self.row_offsets);
        if (self.bin_indices.len > 0) allocator.free(self.bin_indices);
        if (self.weights.len > 0) allocator.free(self.weights);
        self.* = .{};
    }
};

pub const ConstantQResource = struct {
    bin_count: i32 = 0,
    max_frequency: f32 = 0.0,
    bins_per_octave: i32 = cqt_default_bins_per_octave,
    window_function: WindowFunction = .hann,
    bank: ScalogramKernelBank = .{},
    next: ?*ConstantQResource = null,

    pub fn deinit(self: *ConstantQResource) void {
        self.bank.deinit();
        self.* = .{};
    }
};

pub const WaveformBuildState = struct {
    active: bool = false,
    current_block_index: i32 = 0,
    current_level_index: i32 = 0,
};

pub const WaveSession = struct {
    samples: []f32 = &.{},
    sample_count: i32 = 0,
    sample_rate: f32 = 0,
    duration: f32 = 0,
    min_frequency: f32 = hard_min_frequency,
    max_frequency: f32 = hard_max_frequency,
    levels: []WaveLevel = &.{},
    waveform_build: WaveformBuildState = .{},
    fft_resources: ?*FftResource = null,
    band_layout_resources: ?*BandLayoutResource = null,
    chroma_layout_resources: ?*ChromaLayoutResource = null,
    scalogram_resources: ?*ScalogramResource = null,
    constant_q_resources: ?*ConstantQResource = null,
};

pub var g_session: WaveSession = .{};

pub fn makeAlignedF32Buffer(byte_count: usize) ?[]align(16) f32 {
    const raw = pffft_aligned_malloc(byte_count) orelse return null;
    const ptr: [*]align(16) f32 = @ptrCast(@alignCast(raw));
    return ptr[0 .. byte_count / @sizeOf(f32)];
}

pub fn clampf32(value: f32, min_value: f32, max_value: f32) f32 {
    return @min(max_value, @max(min_value, value));
}

pub fn clampf64(value: f64, min_value: f64, max_value: f64) f64 {
    return @min(max_value, @max(min_value, value));
}

pub fn isFiniteF32(value: f32) bool {
    return std.math.isFinite(value);
}

pub fn isFiniteF64(value: f64) bool {
    return std.math.isFinite(value);
}
pub fn approxLog10Positive(value: f32) f32 {
    if (value <= 0.0) return -std.math.inf(f32);

    const bits: u32 = @bitCast(value);
    const exponent = @as(i32, @intCast((bits >> 23) & 0xff)) - 127;
    const mantissa_bits: u32 = (bits & 0x7fffff) | 0x3f800000;
    const mantissa: f32 = @bitCast(mantissa_bits);
    const y = (mantissa - 1.0) / (mantissa + 1.0);
    const y2 = y * y;
    const y3 = y * y2;
    const y5 = y3 * y2;
    const y7 = y5 * y2;
    const ln_mantissa = 2.0 * (y + (y3 / 3.0) + (y5 / 5.0) + (y7 / 7.0));
    return (@as(f32, @floatFromInt(exponent)) * log10_of_two) + (ln_mantissa * log10_of_e);
}

pub fn clampi32(value: i32, min_value: i32, max_value: i32) i32 {
    return @min(max_value, @max(min_value, value));
}

pub fn ceilDivI32(numerator: i32, denominator: i32) i32 {
    return @divFloor(numerator + denominator - 1, denominator);
}

pub fn maxI32(left: i32, right: i32) i32 {
    return @max(left, right);
}

pub fn minI32(left: i32, right: i32) i32 {
    return @min(left, right);
}

pub fn minF32(left: f32, right: f32) f32 {
    return @min(left, right);
}

pub fn maxF32(left: f32, right: f32) f32 {
    return @max(left, right);
}

pub fn approxEqF32(left: f32, right: f32) bool {
    return @abs(left - right) <= 0.001;
}

pub fn decodeAnalysisType(value: i32) AnalysisType {
    return switch (value) {
        1 => .mel,
        2 => .scalogram,
        3 => .mfcc,
        4, 5 => .chroma,
        else => .spectrogram,
    };
}

pub fn decodeFrequencyScale(value: i32) FrequencyScale {
    return switch (value) {
        1 => .linear,
        2 => .mixed,
        else => .log,
    };
}

pub fn decodeWindowFunction(value: i32) WindowFunction {
    return switch (value) {
        1 => .hamming,
        2 => .blackman,
        3 => .rectangular,
        else => .hann,
    };
}

pub fn windowValue(window_function: WindowFunction, index: i32, size: i32) f32 {
    if (size <= 1 or window_function == .rectangular) return 1.0;

    const denominator = @as(f32, @floatFromInt(maxI32(1, size - 1)));
    const phase = (2.0 * std.math.pi * @as(f32, @floatFromInt(index))) / denominator;

    return switch (window_function) {
        .hann => 0.5 - (0.5 * @cos(phase)),
        .hamming => 0.54 - (0.46 * @cos(phase)),
        .blackman => 0.42 - (0.5 * @cos(phase)) + (0.08 * @cos(phase * 2.0)),
        .rectangular => 1.0,
    };
}

const mixed_frequency_pivot_hz: f32 = 1_000.0;
const mixed_frequency_pivot_ratio: f32 = 0.5;
const slaney_mel_frequency_min: f32 = 0.0;
const slaney_mel_frequency_step: f32 = 200.0 / 3.0;
const slaney_mel_log_region_start_hz: f32 = 1_000.0;
const slaney_mel_log_region_start_mel: f32 = (slaney_mel_log_region_start_hz - slaney_mel_frequency_min) / slaney_mel_frequency_step;
const slaney_mel_log_step: f32 = @log(6.4) / 27.0;

fn getMixedFrequencyPivot(min_frequency: f32, max_frequency: f32) f32 {
    return clampf32(mixed_frequency_pivot_hz, min_frequency, max_frequency);
}

pub fn hzToMel(frequency: f32) f32 {
    const safe_frequency = maxF32(0.0, frequency);
    if (safe_frequency < slaney_mel_log_region_start_hz) {
        return (safe_frequency - slaney_mel_frequency_min) / slaney_mel_frequency_step;
    }

    return slaney_mel_log_region_start_mel
        + (@log(safe_frequency / slaney_mel_log_region_start_hz) / slaney_mel_log_step);
}

pub fn melToHz(mel_value: f32) f32 {
    if (mel_value < slaney_mel_log_region_start_mel) {
        return slaney_mel_frequency_min + (slaney_mel_frequency_step * mel_value);
    }

    return slaney_mel_log_region_start_hz
        * @exp(slaney_mel_log_step * (mel_value - slaney_mel_log_region_start_mel));
}

pub fn bandStartFrequencyForRow(row: i32, rows: i32, min_frequency: f32, max_frequency: f32, scale: FrequencyScale) f32 {
    const safe_rows = maxI32(1, rows);
    const start_ratio = @as(f32, @floatFromInt(row)) / @as(f32, @floatFromInt(safe_rows));
    return switch (scale) {
        .linear => min_frequency + ((max_frequency - min_frequency) * start_ratio),
        .log => min_frequency * @exp(@log(max_frequency / min_frequency) * start_ratio),
        .mixed => blk: {
            const pivot = getMixedFrequencyPivot(min_frequency, max_frequency);

            if (start_ratio <= mixed_frequency_pivot_ratio or pivot >= max_frequency) {
                const lower_ratio = if (mixed_frequency_pivot_ratio <= 0)
                    0
                else
                    start_ratio / mixed_frequency_pivot_ratio;
                break :blk min_frequency + ((pivot - min_frequency) * lower_ratio);
            }

            const upper_ratio = (start_ratio - mixed_frequency_pivot_ratio) / (1.0 - mixed_frequency_pivot_ratio);
            break :blk pivot * @exp(@log(max_frequency / pivot) * upper_ratio);
        },
    };
}

pub fn bandEndFrequencyForRow(row: i32, rows: i32, min_frequency: f32, max_frequency: f32, scale: FrequencyScale) f32 {
    const safe_rows = maxI32(1, rows);
    const end_ratio = @as(f32, @floatFromInt(row + 1)) / @as(f32, @floatFromInt(safe_rows));
    return switch (scale) {
        .linear => min_frequency + ((max_frequency - min_frequency) * end_ratio),
        .log => min_frequency * @exp(@log(max_frequency / min_frequency) * end_ratio),
        .mixed => blk: {
            const pivot = getMixedFrequencyPivot(min_frequency, max_frequency);

            if (end_ratio <= mixed_frequency_pivot_ratio or pivot >= max_frequency) {
                const lower_ratio = if (mixed_frequency_pivot_ratio <= 0)
                    0
                else
                    end_ratio / mixed_frequency_pivot_ratio;
                break :blk min_frequency + ((pivot - min_frequency) * lower_ratio);
            }

            const upper_ratio = (end_ratio - mixed_frequency_pivot_ratio) / (1.0 - mixed_frequency_pivot_ratio);
            break :blk pivot * @exp(@log(max_frequency / pivot) * upper_ratio);
        },
    };
}

pub fn frequencyForScalogramRow(row: i32, rows: i32, min_frequency: f32, max_frequency: f32) f32 {
    if (rows <= 1) return min_frequency;
    const ratio = @as(f32, @floatFromInt(row)) / @as(f32, @floatFromInt(rows - 1));
    return min_frequency * @exp(@log(max_frequency / min_frequency) * ratio);
}

pub fn reduceMinMax(values: []const f32, comptime clamp_samples: bool) RangeResult {
    if (values.len == 0) {
        return .{ .min = 1.0, .max = -1.0 };
    }

    var local_min = if (clamp_samples)
        clampf32(values[0], -1.0, 1.0)
    else
        values[0];
    var local_max = local_min;
    var index: usize = 1;

    if (comptime simd_enabled) {
        if (values.len - index >= 4) {
            var min_vec: Vec4f = @splat(local_min);
            var max_vec: Vec4f = @splat(local_max);

            while (index + 4 <= values.len) : (index += 4) {
                var vec = @as(Vec4f, values[index..][0..4].*);
                if (clamp_samples) {
                    vec = std.math.clamp(vec, @as(Vec4f, @splat(-1.0)), @as(Vec4f, @splat(1.0)));
                }
                min_vec = @min(min_vec, vec);
                max_vec = @max(max_vec, vec);
            }

            local_min = @reduce(.Min, min_vec);
            local_max = @reduce(.Max, max_vec);
        }
    }

    while (index < values.len) : (index += 1) {
        var value = values[index];
        if (clamp_samples) value = clampf32(value, -1.0, 1.0);
        local_min = @min(local_min, value);
        local_max = @max(local_max, value);
    }

    return .{ .min = local_min, .max = local_max };
}

test "reduceMinMax preserves unclamped extrema" {
    const result = reduceMinMax(&.{ 1.25, -1.4, 0.5 }, false);
    try std.testing.expectApproxEqAbs(@as(f32, -1.4), result.min, 0.0001);
    try std.testing.expectApproxEqAbs(@as(f32, 1.25), result.max, 0.0001);
}

test "reduceMinMax clamps samples when requested" {
    const result = reduceMinMax(&.{ 1.25, -1.4, 0.5 }, true);
    try std.testing.expectApproxEqAbs(@as(f32, -1.0), result.min, 0.0001);
    try std.testing.expectApproxEqAbs(@as(f32, 1.0), result.max, 0.0001);
}
