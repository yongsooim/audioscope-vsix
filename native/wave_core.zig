const std = @import("std");
const builtin = @import("builtin");

const allocator = std.heap.wasm_allocator;
const simd_enabled = builtin.target.cpu.arch.isWasm() and std.Target.wasm.featureSetHas(builtin.target.cpu.features, .simd128);
const Vec4f = @Vector(4, f32);

const default_malloc_alignment: std.mem.Alignment = .@"16";
const min_level_block_size: i32 = 16;
const level_scale_factor: i32 = 4;
const min_level_buckets: i32 = 512;

const hard_min_frequency: f32 = 20.0;
const hard_max_frequency: f32 = 20_000.0;
const min_db: f32 = -92.0;
const max_db: f32 = -12.0;
const low_frequency_enhancement_max_frequency: f32 = 1_200.0;
const morlet_omega0: f32 = 6.0;
const morlet_support_sigma: f32 = 3.0;
const morlet_max_support_samples: i32 = 4096;
const morlet_target_steps: i32 = 96;
const scalogram_row_block_size: i32 = 32;

const RangeResult = struct {
    min: f32,
    max: f32,
};

const AnalysisType = enum(i32) {
    spectrogram = 0,
    mel = 1,
    scalogram = 2,
};

const FrequencyScale = enum(i32) {
    log = 0,
    linear = 1,
};

const PffftSetup = opaque {};
const PffftDirection = enum(c_int) {
    forward = 0,
    backward = 1,
};
const PffftTransform = enum(c_int) {
    real = 0,
    complex = 1,
};
const Ebur128State = opaque {};
const ebur128_summary_mode: c_int = 127;

extern fn pffft_new_setup(size: c_int, transform: PffftTransform) ?*PffftSetup;
extern fn pffft_destroy_setup(setup: *PffftSetup) void;
extern fn pffft_transform_ordered(
    setup: *PffftSetup,
    input: [*]const f32,
    output: [*]f32,
    work: [*]f32,
    direction: PffftDirection,
) void;
extern fn pffft_aligned_malloc(byte_count: usize) ?*anyopaque;
extern fn pffft_aligned_free(ptr: ?*anyopaque) void;
extern fn ebur128_init(channels: c_uint, samplerate: c_ulong, mode: c_int) ?*Ebur128State;
extern fn ebur128_destroy(st: *?*Ebur128State) void;
extern fn ebur128_add_frames_float(st: *Ebur128State, src: [*]const f32, frames: usize) c_int;
extern fn ebur128_loudness_global(st: *Ebur128State, out: *f64) c_int;
extern fn ebur128_loudness_range(st: *Ebur128State, out: *f64) c_int;
extern fn ebur128_sample_peak(st: *Ebur128State, channel_number: c_uint, out: *f64) c_int;
extern fn ebur128_true_peak(st: *Ebur128State, channel_number: c_uint, out: *f64) c_int;

const AllocationHeader = extern struct {
    total_size: usize,
    base_offset: usize,
    raw_alignment: u32,
    _: u32 = 0,
};

const WaveLevel = struct {
    block_size: i32 = 0,
    block_count: i32 = 0,
    min_peaks: []f32 = &.{},
    max_peaks: []f32 = &.{},

    fn deinit(self: *WaveLevel) void {
        if (self.min_peaks.len > 0) allocator.free(self.min_peaks);
        if (self.max_peaks.len > 0) allocator.free(self.max_peaks);
        self.* = .{};
    }
};

const FftResource = struct {
    fft_size: usize = 0,
    setup: ?*PffftSetup = null,
    input: ?[]align(16) f32 = null,
    output: ?[]align(16) f32 = null,
    work: ?[]align(16) f32 = null,
    window: []f32 = &.{},
    power_spectrum: []f32 = &.{},
    low_power_spectrum: []f32 = &.{},
    next: ?*FftResource = null,

    fn deinit(self: *FftResource) void {
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

const BandRange = extern struct {
    start_bin: i32 = 0,
    end_bin: i32 = 0,
    start_frequency: f32 = 0,
    end_frequency: f32 = 0,
};

const MelBand = struct {
    start_bin: i32 = 0,
    peak_bin: i32 = 0,
    end_bin: i32 = 0,
    start_frequency: f32 = 0,
    center_frequency: f32 = 0,
    end_frequency: f32 = 0,
};

const ScalogramRowKernel = struct {
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

const ScalogramKernelBank = struct {
    rows: []ScalogramRowKernel = &.{},
    offsets: []i32 = &.{},
    real_weights: []f32 = &.{},
    imag_weights: []f32 = &.{},
    norm_weights: []f32 = &.{},

    fn init(row_count: i32, min_frequency: f32, max_frequency: f32) !ScalogramKernelBank {
        var bank: ScalogramKernelBank = .{};
        errdefer bank.deinit();

        bank.rows = try allocator.alloc(ScalogramRowKernel, @as(usize, @intCast(row_count)));
        for (bank.rows) |*row| row.* = .{};

        var total_tap_count: usize = 0;
        for (bank.rows, 0..) |*row_kernel, row_usize| {
            const row = @as(i32, @intCast(row_usize));
            const frequency = frequencyForScalogramRow(row, row_count, min_frequency, max_frequency);
            const safe_frequency = maxF32(1.0, frequency);
            const scale_seconds = morlet_omega0 / (2.0 * std.math.pi * safe_frequency);
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

    fn deinit(self: *ScalogramKernelBank) void {
        if (self.rows.len > 0) allocator.free(self.rows);
        if (self.offsets.len > 0) allocator.free(self.offsets);
        if (self.real_weights.len > 0) allocator.free(self.real_weights);
        if (self.imag_weights.len > 0) allocator.free(self.imag_weights);
        if (self.norm_weights.len > 0) allocator.free(self.norm_weights);
        self.* = .{};
    }
};

const BandLayoutResource = struct {
    analysis_type: AnalysisType = .spectrogram,
    frequency_scale: FrequencyScale = .log,
    fft_size: i32 = 0,
    decimation_factor: i32 = 1,
    row_count: i32 = 0,
    min_frequency: f32 = 0.0,
    max_frequency: f32 = 0.0,
    band_ranges: []BandRange = &.{},
    mel_bands: []MelBand = &.{},
    enhanced_band_ranges: []BandRange = &.{},
    use_low_frequency_enhancement: bool = false,
    low_frequency_maximum: f32 = 0.0,
    next: ?*BandLayoutResource = null,

    fn deinit(self: *BandLayoutResource) void {
        if (self.band_ranges.len > 0) allocator.free(self.band_ranges);
        if (self.mel_bands.len > 0) allocator.free(self.mel_bands);
        if (self.enhanced_band_ranges.len > 0) allocator.free(self.enhanced_band_ranges);
        self.* = .{};
    }
};

const ScalogramResource = struct {
    row_count: i32 = 0,
    min_frequency: f32 = 0.0,
    max_frequency: f32 = 0.0,
    bank: ScalogramKernelBank = .{},
    next: ?*ScalogramResource = null,

    fn deinit(self: *ScalogramResource) void {
        self.bank.deinit();
        self.* = .{};
    }
};

const WaveSession = struct {
    samples: []f32 = &.{},
    sample_count: i32 = 0,
    sample_rate: f32 = 0,
    duration: f32 = 0,
    min_frequency: f32 = hard_min_frequency,
    max_frequency: f32 = hard_max_frequency,
    levels: []WaveLevel = &.{},
    fft_resources: ?*FftResource = null,
    band_layout_resources: ?*BandLayoutResource = null,
    scalogram_resources: ?*ScalogramResource = null,
};

var g_session: WaveSession = .{};

fn allocBytes(byte_count: usize, alignment: std.mem.Alignment) ?[*]u8 {
    if (byte_count == 0) return null;

    const raw_alignment = alignment.max(std.mem.Alignment.of(AllocationHeader));
    const header_size = @sizeOf(AllocationHeader);
    const total_size = std.math.add(usize, byte_count, header_size + alignment.toByteUnits() - 1) catch return null;
    const raw_ptr = allocator.rawAlloc(total_size, raw_alignment, @returnAddress()) orelse return null;
    const raw_addr = @intFromPtr(raw_ptr);
    const user_addr = alignment.forward(raw_addr + header_size);
    const header_ptr: *AllocationHeader = @ptrFromInt(user_addr - header_size);

    header_ptr.* = .{
        .total_size = total_size,
        .base_offset = user_addr - raw_addr,
        .raw_alignment = @as(u32, @intCast(raw_alignment.toByteUnits())),
    };

    return @ptrFromInt(user_addr);
}

fn freeBytes(ptr_value: usize) void {
    if (ptr_value == 0) return;

    const header_ptr: *const AllocationHeader = @ptrFromInt(ptr_value - @sizeOf(AllocationHeader));
    const raw_addr = ptr_value - header_ptr.base_offset;
    const raw_ptr: [*]u8 = @ptrFromInt(raw_addr);
    const raw_alignment = std.mem.Alignment.fromByteUnits(header_ptr.raw_alignment);
    allocator.rawFree(raw_ptr[0..header_ptr.total_size], raw_alignment, @returnAddress());
}

pub export fn malloc(size: usize) usize {
    return @intFromPtr(allocBytes(size, default_malloc_alignment) orelse return 0);
}

pub export fn calloc(count: usize, size: usize) usize {
    const total = std.math.mul(usize, count, size) catch return 0;
    const ptr = allocBytes(total, default_malloc_alignment) orelse return 0;
    @memset(ptr[0..total], 0);
    return @intFromPtr(ptr);
}

pub export fn free(ptr: usize) void {
    freeBytes(ptr);
}

fn makeAlignedF32Buffer(byte_count: usize) ?[]align(16) f32 {
    const raw = pffft_aligned_malloc(byte_count) orelse return null;
    const ptr: [*]align(16) f32 = @ptrCast(@alignCast(raw));
    return ptr[0 .. byte_count / @sizeOf(f32)];
}

fn clampf32(value: f32, min_value: f32, max_value: f32) f32 {
    return @min(max_value, @max(min_value, value));
}

fn clampf64(value: f64, min_value: f64, max_value: f64) f64 {
    return @min(max_value, @max(min_value, value));
}

fn castSummaryValue(value: f64) f32 {
    if (!std.math.isFinite(value)) {
        return if (value < 0.0) -std.math.inf(f32) else std.math.inf(f32);
    }

    return @as(f32, @floatCast(value));
}

fn linearToDecibels(value: f64) f32 {
    if (!std.math.isFinite(value)) {
        return if (value < 0.0) -std.math.inf(f32) else std.math.inf(f32);
    }

    if (value <= 0.0) {
        return -std.math.inf(f32);
    }

    return @as(f32, @floatCast(20.0 * (@log(value) / @log(@as(f64, 10.0)))));
}

fn clampi32(value: i32, min_value: i32, max_value: i32) i32 {
    return @min(max_value, @max(min_value, value));
}

fn ceilDivI32(numerator: i32, denominator: i32) i32 {
    return @divFloor(numerator + denominator - 1, denominator);
}

fn maxI32(left: i32, right: i32) i32 {
    return @max(left, right);
}

fn minI32(left: i32, right: i32) i32 {
    return @min(left, right);
}

fn minF32(left: f32, right: f32) f32 {
    return @min(left, right);
}

fn maxF32(left: f32, right: f32) f32 {
    return @max(left, right);
}

fn approxEqF32(left: f32, right: f32) bool {
    return @abs(left - right) <= 0.001;
}

fn decodeAnalysisType(value: i32) AnalysisType {
    return switch (value) {
        1 => .mel,
        2 => .scalogram,
        else => .spectrogram,
    };
}

fn decodeFrequencyScale(value: i32) FrequencyScale {
    return if (value == 1) .linear else .log;
}

fn hzToMel(frequency: f32) f32 {
    return 1127.0 * @log(1.0 + (frequency / 700.0));
}

fn melToHz(mel_value: f32) f32 {
    return 700.0 * (@exp(mel_value / 1127.0) - 1.0);
}

fn bandStartFrequencyForRow(row: i32, rows: i32, min_frequency: f32, max_frequency: f32, scale: FrequencyScale) f32 {
    const safe_rows = maxI32(1, rows);
    const start_ratio = @as(f32, @floatFromInt(row)) / @as(f32, @floatFromInt(safe_rows));
    return switch (scale) {
        .linear => min_frequency + ((max_frequency - min_frequency) * start_ratio),
        .log => min_frequency * @exp(@log(max_frequency / min_frequency) * start_ratio),
    };
}

fn bandEndFrequencyForRow(row: i32, rows: i32, min_frequency: f32, max_frequency: f32, scale: FrequencyScale) f32 {
    const safe_rows = maxI32(1, rows);
    const end_ratio = @as(f32, @floatFromInt(row + 1)) / @as(f32, @floatFromInt(safe_rows));
    return switch (scale) {
        .linear => min_frequency + ((max_frequency - min_frequency) * end_ratio),
        .log => min_frequency * @exp(@log(max_frequency / min_frequency) * end_ratio),
    };
}

fn frequencyForScalogramRow(row: i32, rows: i32, min_frequency: f32, max_frequency: f32) f32 {
    if (rows <= 1) return min_frequency;
    const ratio = @as(f32, @floatFromInt(row)) / @as(f32, @floatFromInt(rows - 1));
    return min_frequency * @exp(@log(max_frequency / min_frequency) * ratio);
}

fn reduceMinMax(values: []const f32, comptime clamp_samples: bool) RangeResult {
    var local_min: f32 = 1.0;
    var local_max: f32 = -1.0;
    var index: usize = 0;

    if (comptime simd_enabled) {
        if (values.len >= 4) {
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

fn resetSessionState() void {
    freeWaveLevels();
    freeFftResources();
    freeBandLayoutResources();
    freeScalogramResources();
    if (g_session.samples.len > 0) allocator.free(g_session.samples);
    g_session = .{};
}

fn freeWaveLevels() void {
    if (g_session.levels.len == 0) return;
    for (g_session.levels) |*level| level.deinit();
    allocator.free(g_session.levels);
    g_session.levels = &.{};
}

fn freeFftResources() void {
    var current = g_session.fft_resources;
    while (current) |node| {
        const next = node.next;
        node.deinit();
        allocator.destroy(node);
        current = next;
    }
    g_session.fft_resources = null;
}

fn freeBandLayoutResources() void {
    var current = g_session.band_layout_resources;
    while (current) |node| {
        const next = node.next;
        node.deinit();
        allocator.destroy(node);
        current = next;
    }
    g_session.band_layout_resources = null;
}

fn freeScalogramResources() void {
    var current = g_session.scalogram_resources;
    while (current) |node| {
        const next = node.next;
        node.deinit();
        allocator.destroy(node);
        current = next;
    }
    g_session.scalogram_resources = null;
}

fn computeLevelCount(sample_count: i32) i32 {
    if (sample_count <= 0) return 0;

    var level_count: i32 = 0;
    var block_size: i32 = min_level_block_size;

    while (block_size < sample_count) {
        level_count += 1;
        if (ceilDivI32(sample_count, block_size) <= min_level_buckets) break;
        block_size *= level_scale_factor;
    }

    return level_count;
}

fn getFftResource(fft_size_i32: i32) ?*FftResource {
    const fft_size = @as(usize, @intCast(fft_size_i32));
    var current = g_session.fft_resources;
    while (current) |resource| : (current = resource.next) {
        if (resource.fft_size == fft_size) return resource;
    }

    if (fft_size == 0) return null;

    const resource = allocator.create(FftResource) catch return null;
    resource.* = .{ .fft_size = fft_size };
    errdefer {
        resource.deinit();
        allocator.destroy(resource);
    }

    resource.setup = pffft_new_setup(@as(c_int, @intCast(fft_size)), .real) orelse return null;
    resource.input = makeAlignedF32Buffer(fft_size * @sizeOf(f32)) orelse return null;
    resource.output = makeAlignedF32Buffer(fft_size * @sizeOf(f32)) orelse return null;
    resource.work = makeAlignedF32Buffer(fft_size * @sizeOf(f32)) orelse return null;
    resource.window = allocator.alloc(f32, fft_size) catch return null;
    const power_spectrum_length = @as(usize, @intCast(maxI32(2, @divTrunc(fft_size_i32, 2) + 1)));
    resource.power_spectrum = allocator.alloc(f32, power_spectrum_length) catch return null;
    resource.low_power_spectrum = allocator.alloc(f32, power_spectrum_length) catch return null;

    const denominator = @as(f32, @floatFromInt(fft_size - 1));
    for (resource.window, 0..) |*value, index| {
        const ratio = (2.0 * std.math.pi * @as(f32, @floatFromInt(index))) / denominator;
        value.* = 0.5 * (1.0 - @cos(ratio));
    }

    resource.next = g_session.fft_resources;
    g_session.fft_resources = resource;
    return resource;
}

fn getBandLayoutResource(
    analysis_type: AnalysisType,
    frequency_scale: FrequencyScale,
    fft_size: i32,
    decimation_factor: i32,
    row_count: i32,
    min_frequency: f32,
    max_frequency: f32,
) ?*BandLayoutResource {
    var current = g_session.band_layout_resources;
    while (current) |resource| : (current = resource.next) {
        if (resource.analysis_type == analysis_type and
            resource.frequency_scale == frequency_scale and
            resource.fft_size == fft_size and
            resource.decimation_factor == decimation_factor and
            resource.row_count == row_count and
            approxEqF32(resource.min_frequency, min_frequency) and
            approxEqF32(resource.max_frequency, max_frequency))
        {
            return resource;
        }
    }

    const resource = allocator.create(BandLayoutResource) catch return null;
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
        allocator.destroy(resource);
    }

    switch (analysis_type) {
        .mel => {
            resource.mel_bands = allocator.alloc(MelBand, @as(usize, @intCast(row_count))) catch return null;
            createMelBands(resource.mel_bands, fft_size, g_session.sample_rate, min_frequency, max_frequency);
        },
        .spectrogram => {
            resource.band_ranges = allocator.alloc(BandRange, @as(usize, @intCast(row_count))) catch return null;
            switch (frequency_scale) {
                .linear => createLinearBandRanges(resource.band_ranges, fft_size, g_session.sample_rate, min_frequency, max_frequency),
                .log => createLogBandRanges(resource.band_ranges, fft_size, g_session.sample_rate, min_frequency, max_frequency),
            }

            if (decimation_factor > 1) {
                const effective_sample_rate = g_session.sample_rate / @as(f32, @floatFromInt(decimation_factor));
                resource.low_frequency_maximum = minF32(
                    low_frequency_enhancement_max_frequency,
                    minF32((effective_sample_rate / 2.0) * 0.92, max_frequency),
                );

                if (resource.low_frequency_maximum > min_frequency * 1.25) {
                    resource.enhanced_band_ranges = allocator.alloc(BandRange, @as(usize, @intCast(row_count))) catch return null;
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

    resource.next = g_session.band_layout_resources;
    g_session.band_layout_resources = resource;
    return resource;
}

fn getScalogramResource(row_count: i32, min_frequency: f32, max_frequency: f32) ?*ScalogramResource {
    var current = g_session.scalogram_resources;
    while (current) |resource| : (current = resource.next) {
        if (resource.row_count == row_count and
            approxEqF32(resource.min_frequency, min_frequency) and
            approxEqF32(resource.max_frequency, max_frequency))
        {
            return resource;
        }
    }

    const resource = allocator.create(ScalogramResource) catch return null;
    resource.* = .{
        .row_count = row_count,
        .min_frequency = min_frequency,
        .max_frequency = max_frequency,
        .bank = ScalogramKernelBank.init(row_count, min_frequency, max_frequency) catch {
            allocator.destroy(resource);
            return null;
        },
    };

    resource.next = g_session.scalogram_resources;
    g_session.scalogram_resources = resource;
    return resource;
}

fn pickWaveformLevel(samples_per_pixel: f64) ?*const WaveLevel {
    var selected: ?*const WaveLevel = null;

    for (g_session.levels) |*level| {
        if (@as(f64, @floatFromInt(level.block_size)) <= samples_per_pixel * 1.5) {
            selected = level;
            continue;
        }
        break;
    }

    return selected;
}

fn getSampleRange(start_sample: i32, end_sample: i32) RangeResult {
    const clamped_start = maxI32(0, start_sample);
    const clamped_end = minI32(g_session.sample_count, end_sample);
    if (clamped_end <= clamped_start or g_session.samples.len == 0) {
        return .{ .min = 1.0, .max = -1.0 };
    }

    return reduceMinMax(
        g_session.samples[@as(usize, @intCast(clamped_start))..@as(usize, @intCast(clamped_end))],
        false,
    );
}

fn getLevelRange(level: *const WaveLevel, start_sample: i32, end_sample: i32) RangeResult {
    const start_block = maxI32(0, @divTrunc(start_sample, level.block_size));
    const end_block = minI32(level.block_count, ceilDivI32(end_sample, level.block_size));
    if (end_block <= start_block) {
        return .{ .min = 1.0, .max = -1.0 };
    }

    const min_result = reduceMinMax(
        level.min_peaks[@as(usize, @intCast(start_block))..@as(usize, @intCast(end_block))],
        false,
    );
    const max_result = reduceMinMax(
        level.max_peaks[@as(usize, @intCast(start_block))..@as(usize, @intCast(end_block))],
        false,
    );

    return .{ .min = min_result.min, .max = max_result.max };
}

fn writeWindowedInput(resource: *FftResource, center_sample: i32) void {
    const input = resource.input.?;
    @memset(input, 0);

    const fft_size_i32 = @as(i32, @intCast(resource.fft_size));
    const window_start = center_sample - @divTrunc(fft_size_i32, 2);
    const valid_start = clampi32(-window_start, 0, fft_size_i32);
    const valid_end = clampi32(g_session.sample_count - window_start, 0, fft_size_i32);

    if (valid_end <= valid_start) return;

    const src = g_session.samples[@as(usize, @intCast(window_start + valid_start))..@as(usize, @intCast(window_start + valid_end))];
    const dst = input[@as(usize, @intCast(valid_start))..@as(usize, @intCast(valid_end))];
    const window = resource.window[@as(usize, @intCast(valid_start))..@as(usize, @intCast(valid_end))];

    var index: usize = 0;
    if (comptime simd_enabled) {
        while (index + 4 <= src.len) : (index += 4) {
            const sample_vec = @as(Vec4f, src[index..][0..4].*);
            const window_vec = @as(Vec4f, window[index..][0..4].*);
            dst[index..][0..4].* = @as([4]f32, sample_vec * window_vec);
        }
    }

    while (index < src.len) : (index += 1) {
        dst[index] = src[index] * window[index];
    }
}

fn writeDecimatedInput(resource: *FftResource, center_sample: i32, decimation_factor: i32) void {
    const input = resource.input.?;
    @memset(input, 0);

    const fft_size_i32 = @as(i32, @intCast(resource.fft_size));
    const decimated_window_start = center_sample - @divTrunc(fft_size_i32 * decimation_factor, 2);

    for (input, resource.window, 0..) |*slot, window_value, offset_usize| {
        const offset = @as(i32, @intCast(offset_usize));
        var sum: f32 = 0.0;
        var tap: i32 = 0;

        while (tap < decimation_factor) : (tap += 1) {
            const source_index = decimated_window_start + (offset * decimation_factor) + tap;
            if (source_index >= 0 and source_index < g_session.sample_count) {
                sum += g_session.samples[@as(usize, @intCast(source_index))];
            }
        }

        slot.* = (sum / @as(f32, @floatFromInt(decimation_factor))) * window_value;
    }
}

fn writePowerSpectrum(resource: *const FftResource, power_spectrum: []f32) void {
    @memset(power_spectrum, 0);

    const output = resource.output.?;
    const maximum_bin = @as(usize, @intCast(maxI32(2, @divTrunc(@as(i32, @intCast(resource.fft_size)), 2))));
    const normalization_factor = @as(f32, @floatFromInt((resource.fft_size / 2) * (resource.fft_size / 2)));

    var bin: usize = 1;
    while (bin < maximum_bin) : (bin += 1) {
        const real = output[bin * 2];
        const imaginary = output[(bin * 2) + 1];
        power_spectrum[bin] = ((real * real) + (imaginary * imaginary)) / normalization_factor;
    }
}

fn createLogBandRanges(
    ranges: []BandRange,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const rows = @as(i32, @intCast(ranges.len));
    const nyquist = sample_rate / 2.0;
    const maximum_bin = maxI32(2, @divTrunc(fft_size, 2));
    const safe_min_frequency = maxF32(1.0, min_frequency);
    const safe_max_frequency = maxF32(safe_min_frequency * 1.01, max_frequency);
    const log_ratio = @log(safe_max_frequency / safe_min_frequency);

    for (ranges, 0..) |*range, row_usize| {
        const row = @as(i32, @intCast(row_usize));
        const start_ratio = @as(f32, @floatFromInt(row)) / @as(f32, @floatFromInt(rows));
        const end_ratio = @as(f32, @floatFromInt(row + 1)) / @as(f32, @floatFromInt(rows));
        const start_frequency = safe_min_frequency * @exp(log_ratio * start_ratio);
        const end_frequency = safe_min_frequency * @exp(log_ratio * end_ratio);
        const start_bin = clampi32(
            @as(i32, @intFromFloat(@floor((start_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            1,
            maximum_bin - 1,
        );
        const end_bin = clampi32(
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
    ranges: []BandRange,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const rows = @as(i32, @intCast(ranges.len));
    const nyquist = sample_rate / 2.0;
    const maximum_bin = maxI32(2, @divTrunc(fft_size, 2));
    const safe_min_frequency = maxF32(1.0, min_frequency);
    const safe_max_frequency = maxF32(safe_min_frequency + 1.0, max_frequency);

    for (ranges, 0..) |*range, row_usize| {
        const row = @as(i32, @intCast(row_usize));
        const start_frequency = bandStartFrequencyForRow(row, rows, safe_min_frequency, safe_max_frequency, .linear);
        const end_frequency = bandEndFrequencyForRow(row, rows, safe_min_frequency, safe_max_frequency, .linear);
        const start_bin = clampi32(
            @as(i32, @intFromFloat(@floor((start_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            1,
            maximum_bin - 1,
        );
        const end_bin = clampi32(
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
    output: []BandRange,
    template_ranges: []const BandRange,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const nyquist = sample_rate / 2.0;
    const maximum_bin = maxI32(2, @divTrunc(fft_size, 2));

    for (output, template_ranges) |*range, template_range| {
        const start_frequency = minF32(
            maxF32(min_frequency, template_range.start_frequency),
            max_frequency * 0.999,
        );
        const end_frequency = minF32(
            max_frequency,
            maxF32(start_frequency * 1.01, template_range.end_frequency),
        );
        const start_bin = clampi32(
            @as(i32, @intFromFloat(@floor((start_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            1,
            maximum_bin - 1,
        );
        const end_bin = clampi32(
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
    bands: []MelBand,
    fft_size: i32,
    sample_rate: f32,
    min_frequency: f32,
    max_frequency: f32,
) void {
    const rows = @as(i32, @intCast(bands.len));
    const nyquist = sample_rate / 2.0;
    const maximum_bin = maxI32(2, @divTrunc(fft_size, 2));
    const safe_min_frequency = maxF32(1.0, min_frequency);
    const safe_max_frequency = maxF32(safe_min_frequency * 1.01, max_frequency);
    const mel_min = hzToMel(safe_min_frequency);
    const mel_max = hzToMel(safe_max_frequency);
    const mel_step = (mel_max - mel_min) / @as(f32, @floatFromInt(rows + 1));

    for (bands, 0..) |*band, row_usize| {
        const row = @as(i32, @intCast(row_usize));
        const left_frequency = melToHz(mel_min + (mel_step * @as(f32, @floatFromInt(row))));
        const center_frequency = melToHz(mel_min + (mel_step * @as(f32, @floatFromInt(row + 1))));
        const right_frequency = melToHz(mel_min + (mel_step * @as(f32, @floatFromInt(row + 2))));
        const start_bin = clampi32(
            @as(i32, @intFromFloat(@floor((left_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            1,
            maximum_bin - 1,
        );
        const peak_bin = clampi32(
            @as(i32, @intFromFloat(@round((center_frequency / nyquist) * @as(f32, @floatFromInt(maximum_bin))))),
            start_bin + 1,
            maximum_bin - 1,
        );
        const end_bin = clampi32(
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

fn computeBandRms(power_spectrum: []const f32, range: BandRange) f32 {
    const band_size = maxI32(1, range.end_bin - range.start_bin);
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

    return @sqrt(weighted_energy / maxF32(total_weight, 1e-8));
}

fn computeMelBandRms(power_spectrum: []const f32, band: MelBand, fft_size: i32, sample_rate: f32) f32 {
    const maximum_bin = maxI32(2, @divTrunc(fft_size, 2));
    const nyquist = sample_rate / 2.0;
    var weighted_energy: f32 = 0.0;
    var total_weight: f32 = 0.0;
    var bin = band.start_bin;

    while (bin < band.end_bin) : (bin += 1) {
        const frequency = (@as(f32, @floatFromInt(bin)) / @as(f32, @floatFromInt(maximum_bin))) * nyquist;
        var weight: f32 = 0.0;

        if (frequency <= band.center_frequency) {
            const denominator = maxF32(1e-6, band.center_frequency - band.start_frequency);
            weight = (frequency - band.start_frequency) / denominator;
        } else {
            const denominator = maxF32(1e-6, band.end_frequency - band.center_frequency);
            weight = (band.end_frequency - frequency) / denominator;
        }

        weight = clampf32(weight, 0.0, 1.0);
        weighted_energy += power_spectrum[@as(usize, @intCast(bin))] * weight;
        total_weight += weight;
    }

    return @sqrt(weighted_energy / maxF32(total_weight, 1e-8));
}

fn normalizeMagnitudeToDecibels(magnitude: f32) f32 {
    const decibels = 20.0 * @log10(magnitude + 1e-7);
    return (decibels - min_db) / (max_db - min_db);
}

fn computeScalogramKernelMagnitude(center_sample: i32, kernel: *const ScalogramRowKernel) f32 {
    if (kernel.offsets.len == 0) return 0.0;

    const first_sample = center_sample + kernel.offsets[0];
    const last_sample = center_sample + kernel.offsets[kernel.offsets.len - 1];
    const use_full_normalization = first_sample >= 0 and last_sample < g_session.sample_count;

    if (kernel.stride == 1) {
        const tap_count_i32 = @as(i32, @intCast(kernel.offsets.len));
        const valid_tap_start = clampi32(-first_sample, 0, tap_count_i32);
        const valid_tap_end = clampi32(g_session.sample_count - first_sample, valid_tap_start, tap_count_i32);
        if (valid_tap_end <= valid_tap_start) return 0.0;

        const valid_start = @as(usize, @intCast(valid_tap_start));
        const valid_end = @as(usize, @intCast(valid_tap_end));
        const sample_start = @as(usize, @intCast(first_sample + valid_tap_start));
        const sample_end = sample_start + (valid_end - valid_start);
        const samples = g_session.samples[sample_start..sample_end];
        const real_weights = kernel.real_weights[valid_start..valid_end];
        const imag_weights = kernel.imag_weights[valid_start..valid_end];
        const norm_weights = kernel.norm_weights[valid_start..valid_end];
        var real: f32 = 0.0;
        var imaginary: f32 = 0.0;
        var norm: f32 = if (use_full_normalization) kernel.normalization else 0.0;
        var index: usize = 0;

        if (comptime simd_enabled) {
            var real_vec: Vec4f = @splat(0.0);
            var imaginary_vec: Vec4f = @splat(0.0);
            var norm_vec: Vec4f = @splat(0.0);

            while (index + 4 <= samples.len) : (index += 4) {
                const sample_vec = @as(Vec4f, samples[index..][0..4].*);
                const real_weight_vec = @as(Vec4f, real_weights[index..][0..4].*);
                const imag_weight_vec = @as(Vec4f, imag_weights[index..][0..4].*);

                real_vec += sample_vec * real_weight_vec;
                imaginary_vec += sample_vec * imag_weight_vec;
                if (!use_full_normalization) {
                    norm_vec += @as(Vec4f, norm_weights[index..][0..4].*);
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
        return @sqrt((real * real) + (imaginary * imaginary)) / @sqrt(norm);
    }

    var real: f32 = 0.0;
    var imaginary: f32 = 0.0;
    var norm: f32 = if (use_full_normalization) kernel.normalization else 0.0;

    for (kernel.offsets, kernel.real_weights, kernel.imag_weights, kernel.norm_weights) |offset, real_weight, imag_weight, norm_weight| {
        const sample_index = center_sample + offset;
        if (sample_index < 0 or sample_index >= g_session.sample_count) continue;

        const sample = g_session.samples[@as(usize, @intCast(sample_index))];
        real += sample * real_weight;
        imaginary += sample * imag_weight;
        if (!use_full_normalization) {
            norm += norm_weight;
        }
    }

    if (norm <= 1e-8) return 0.0;
    return @sqrt((real * real) + (imaginary * imaginary)) / @sqrt(norm);
}

fn lerpColorChannel(start: f32, end: f32, t: f32) u8 {
    return @as(u8, @intFromFloat(@round(start + ((end - start) * t))));
}

fn writePaletteColor(normalized: f32, output: []u8) void {
    const t = clampf32(normalized, 0.0, 1.0);
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

    output[0] = lerpColorChannel(start_r, end_r, local_t);
    output[1] = lerpColorChannel(start_g, end_g, local_t);
    output[2] = lerpColorChannel(start_b, end_b, local_t);
    output[3] = 255;
}

pub export fn wave_dispose_session() void {
    resetSessionState();
}

pub export fn wave_prepare_session(sample_count: i32, sample_rate: f32, duration: f32) i32 {
    resetSessionState();
    if (sample_count <= 0 or sample_rate <= 0.0 or duration <= 0.0) return 0;

    g_session.samples = allocator.alloc(f32, @as(usize, @intCast(sample_count))) catch {
        resetSessionState();
        return 0;
    };
    @memset(g_session.samples, 0);

    g_session.sample_count = sample_count;
    g_session.sample_rate = sample_rate;
    g_session.duration = duration;
    g_session.min_frequency = hard_min_frequency;
    g_session.max_frequency = minF32(hard_max_frequency, sample_rate / 2.0);
    return 1;
}

pub export fn wave_get_pcm_ptr() i32 {
    if (g_session.samples.len == 0) return 0;
    return @as(i32, @intCast(@intFromPtr(g_session.samples.ptr)));
}

pub export fn wave_measure_loudness_summary(output_ptr: i32) i32 {
    if (g_session.samples.len == 0 or output_ptr == 0 or g_session.sample_count <= 0 or g_session.sample_rate <= 0.0) {
        return 0;
    }

    var state = ebur128_init(1, @as(c_ulong, @intFromFloat(@round(g_session.sample_rate))), ebur128_summary_mode);
    if (state == null) {
        return 0;
    }

    defer ebur128_destroy(&state);
    const meter = state.?;

    if (ebur128_add_frames_float(meter, g_session.samples.ptr, @as(usize, @intCast(g_session.sample_count))) != 0) {
        return 0;
    }

    var integrated_lufs: f64 = 0.0;
    var loudness_range_lu: f64 = 0.0;
    var sample_peak: f64 = 0.0;
    var true_peak: f64 = 0.0;

    if (ebur128_loudness_global(meter, &integrated_lufs) != 0) return 0;
    if (ebur128_loudness_range(meter, &loudness_range_lu) != 0) return 0;
    if (ebur128_sample_peak(meter, 0, &sample_peak) != 0) return 0;
    if (ebur128_true_peak(meter, 0, &true_peak) != 0) return 0;

    const output: [*]f32 = @ptrFromInt(@as(usize, @intCast(output_ptr)));
    output[0] = castSummaryValue(integrated_lufs);
    output[1] = castSummaryValue(loudness_range_lu);
    output[2] = linearToDecibels(sample_peak);
    output[3] = linearToDecibels(true_peak);
    return 1;
}

pub export fn wave_build_waveform_pyramid() i32 {
    if (g_session.samples.len == 0 or g_session.sample_count <= 0) return 0;

    freeWaveLevels();

    const level_count = computeLevelCount(g_session.sample_count);
    if (level_count <= 0) return 0;

    g_session.levels = allocator.alloc(WaveLevel, @as(usize, @intCast(level_count))) catch return 0;
    for (g_session.levels) |*level| level.* = .{};

    var block_size = min_level_block_size;
    var previous_level: ?*WaveLevel = null;
    for (g_session.levels, 0..) |*level, block_index| {
        _ = block_index;
        const block_count = ceilDivI32(g_session.sample_count, block_size);
        level.block_size = block_size;
        level.block_count = block_count;
        level.min_peaks = allocator.alloc(f32, @as(usize, @intCast(block_count))) catch {
            freeWaveLevels();
            return 0;
        };
        level.max_peaks = allocator.alloc(f32, @as(usize, @intCast(block_count))) catch {
            freeWaveLevels();
            return 0;
        };

        var sample_block_index: usize = 0;
        if (previous_level) |parent_level| {
            while (sample_block_index < level.min_peaks.len) : (sample_block_index += 1) {
                const start = @as(i32, @intCast(sample_block_index)) * level_scale_factor;
                const end = minI32(parent_level.block_count, start + level_scale_factor);
                var min_peak: f32 = 1.0;
                var max_peak: f32 = -1.0;
                var parent_index = start;

                while (parent_index < end) : (parent_index += 1) {
                    const parent_usize = @as(usize, @intCast(parent_index));
                    min_peak = minF32(min_peak, parent_level.min_peaks[parent_usize]);
                    max_peak = maxF32(max_peak, parent_level.max_peaks[parent_usize]);
                }

                level.min_peaks[sample_block_index] = min_peak;
                level.max_peaks[sample_block_index] = max_peak;
            }
        } else {
            while (sample_block_index < level.min_peaks.len) : (sample_block_index += 1) {
                const start = @as(i32, @intCast(sample_block_index)) * block_size;
                const end = minI32(g_session.sample_count, start + block_size);
                const result = reduceMinMax(
                    g_session.samples[@as(usize, @intCast(start))..@as(usize, @intCast(end))],
                    true,
                );
                level.min_peaks[sample_block_index] = result.min;
                level.max_peaks[sample_block_index] = result.max;
            }
        }

        previous_level = level;

        if (ceilDivI32(g_session.sample_count, block_size) <= min_level_buckets) break;
        block_size *= level_scale_factor;
    }

    return @as(i32, @intCast(g_session.levels.len));
}

pub export fn wave_extract_waveform_slice(view_start: f64, view_end: f64, column_count: i32, output_ptr: i32) i32 {
    if (g_session.samples.len == 0 or output_ptr == 0 or column_count <= 0 or view_end <= view_start or g_session.duration <= 0.0) {
        return 0;
    }

    const output: [*]f32 = @ptrFromInt(@as(usize, @intCast(output_ptr)));
    const clamped_start = clampf64(view_start, 0.0, @as(f64, g_session.duration));
    const clamped_end = clampf64(view_end, clamped_start + 0.0001, @as(f64, g_session.duration));
    const duration_f64 = @as(f64, g_session.duration);
    const sample_count_f64 = @as(f64, @floatFromInt(g_session.sample_count));
    const render_span = clamped_end - clamped_start;
    const exact_visible_samples = @max(1.0, (render_span / duration_f64) * sample_count_f64);
    const samples_per_pixel = exact_visible_samples / @as(f64, @floatFromInt(column_count));
    const selected_level = pickWaveformLevel(samples_per_pixel);

    var column_index: i32 = 0;
    while (column_index < column_count) : (column_index += 1) {
        const start_ratio = @as(f64, @floatFromInt(column_index)) / @as(f64, @floatFromInt(column_count));
        const end_ratio = (@as(f64, @floatFromInt(column_index)) + 1.0) / @as(f64, @floatFromInt(column_count));
        const column_start_time = clamped_start + (start_ratio * render_span);
        const column_end_time = clamped_start + (end_ratio * render_span);
        const column_start_sample = clampi32(
            @as(i32, @intFromFloat(@floor((column_start_time / duration_f64) * sample_count_f64))),
            0,
            g_session.sample_count,
        );
        const column_end_sample = clampi32(
            @as(i32, @intFromFloat(@ceil((column_end_time / duration_f64) * sample_count_f64))),
            0,
            g_session.sample_count,
        );
        const result = if (selected_level) |level|
            getLevelRange(level, column_start_sample, column_end_sample)
        else
            getSampleRange(column_start_sample, column_end_sample);

        output[@as(usize, @intCast(column_index * 2))] = result.min;
        output[@as(usize, @intCast((column_index * 2) + 1))] = result.max;
    }

    return 1;
}

fn renderStftDerivedTile(
    analysis_type: AnalysisType,
    frequency_scale: FrequencyScale,
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

    const safe_min_frequency = maxF32(g_session.min_frequency, min_frequency);
    const safe_max_frequency = minF32(g_session.max_frequency, max_frequency);
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
    const safe_tile_span = maxF32(1.0 / g_session.sample_rate, @as(f32, @floatCast(tile_end - tile_start)));
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
        const center_sample = @as(i32, @intFromFloat(@round(center_time * @as(f64, g_session.sample_rate))));
        const input = resource.input.?;
        const output_buffer = resource.output.?;
        const work_buffer = resource.work.?;
        const setup = resource.setup.?;

        writeWindowedInput(resource, center_sample);
        pffft_transform_ordered(setup, input.ptr, output_buffer.ptr, work_buffer.ptr, .forward);
        writePowerSpectrum(resource, power_spectrum);

        if (layout.use_low_frequency_enhancement) {
            writeDecimatedInput(resource, center_sample, decimation_factor);
            pffft_transform_ordered(setup, input.ptr, output_buffer.ptr, work_buffer.ptr, .forward);
            writePowerSpectrum(resource, low_power_spectrum);
        }

        var row: i32 = 0;
        while (row < row_count) : (row += 1) {
            const normalized = switch (analysis_type) {
                .mel => normalizeMagnitudeToDecibels(computeMelBandRms(
                    power_spectrum,
                    layout.mel_bands[@as(usize, @intCast(row))],
                    fft_size,
                    g_session.sample_rate,
                )),
                .spectrogram => blk: {
                    const base_range = layout.band_ranges[@as(usize, @intCast(row))];
                    const use_low_band = layout.use_low_frequency_enhancement and base_range.end_frequency <= layout.low_frequency_maximum;
                    const active_range = if (use_low_band)
                        layout.enhanced_band_ranges[@as(usize, @intCast(row))]
                    else
                        base_range;
                    const active_power = if (use_low_band) low_power_spectrum else power_spectrum;
                    break :blk normalizeMagnitudeToDecibels(computeBandRms(active_power, active_range));
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
    const safe_min_frequency = maxF32(g_session.min_frequency, min_frequency);
    const safe_max_frequency = minF32(g_session.max_frequency, max_frequency);
    const resource = getScalogramResource(row_count, safe_min_frequency, safe_max_frequency) orelse return 0;
    const kernel_bank = &resource.bank;
    const output = @as([*]u8, @ptrFromInt(@as(usize, @intCast(output_ptr))));
    const safe_tile_span = maxF32(1.0 / g_session.sample_rate, @as(f32, @floatCast(tile_end - tile_start)));
    const output_width = @as(usize, @intCast(column_count));

    const center_samples = allocator.alloc(i32, @as(usize, @intCast(column_count))) catch return 0;
    defer allocator.free(center_samples);

    var column_index: i32 = 0;
    while (column_index < column_count) : (column_index += 1) {
        const center_ratio = if (column_count == 1)
            0.5
        else
            (@as(f64, @floatFromInt(column_index)) + 0.5) / @as(f64, @floatFromInt(column_count));
        const center_time = tile_start + (center_ratio * @as(f64, safe_tile_span));
        center_samples[@as(usize, @intCast(column_index))] = @as(i32, @intFromFloat(@round(center_time * @as(f64, g_session.sample_rate))));
    }

    var row_block_start: i32 = 0;
    while (row_block_start < row_count) : (row_block_start += scalogram_row_block_size) {
        const row_block_end = minI32(row_count, row_block_start + scalogram_row_block_size);
        var row = row_block_start;

        while (row < row_block_end) : (row += 1) {
            const kernel = &kernel_bank.rows[@as(usize, @intCast(row))];
            const target_row = row_count - row - 1;
            const row_offset = @as(usize, @intCast(target_row)) * output_width * 4;
            var active_column: i32 = 0;

            while (active_column < column_count) : (active_column += 1) {
                const normalized = normalizeMagnitudeToDecibels(
                    computeScalogramKernelMagnitude(
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
    if (g_session.samples.len == 0 or output_ptr == 0 or column_count <= 0 or row_count <= 0 or tile_end <= tile_start) {
        return 0;
    }

    const analysis_type = decodeAnalysisType(analysis_type_value);
    const frequency_scale = decodeFrequencyScale(frequency_scale_value);

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
