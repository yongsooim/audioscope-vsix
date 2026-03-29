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
    next: ?*FftResource = null,

    fn deinit(self: *FftResource) void {
        if (self.setup) |setup| pffft_destroy_setup(setup);
        if (self.input) |buffer| pffft_aligned_free(@ptrCast(buffer.ptr));
        if (self.output) |buffer| pffft_aligned_free(@ptrCast(buffer.ptr));
        if (self.work) |buffer| pffft_aligned_free(@ptrCast(buffer.ptr));
        if (self.window.len > 0) allocator.free(self.window);
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

const WaveSession = struct {
    samples: []f32 = &.{},
    sample_count: i32 = 0,
    sample_rate: f32 = 0,
    duration: f32 = 0,
    min_frequency: f32 = hard_min_frequency,
    max_frequency: f32 = hard_max_frequency,
    levels: []WaveLevel = &.{},
    fft_resources: ?*FftResource = null,
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

    const denominator = @as(f32, @floatFromInt(fft_size - 1));
    for (resource.window, 0..) |*value, index| {
        const ratio = (2.0 * std.math.pi * @as(f32, @floatFromInt(index))) / denominator;
        value.* = 0.5 * (1.0 - @cos(ratio));
    }

    resource.next = g_session.fft_resources;
    g_session.fft_resources = resource;
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

fn computeMorletMagnitude(center_sample: i32, frequency: f32) f32 {
    const safe_frequency = maxF32(1.0, frequency);
    const scale_seconds = morlet_omega0 / (2.0 * std.math.pi * safe_frequency);
    const support_samples = minI32(
        morlet_max_support_samples,
        maxI32(24, @as(i32, @intFromFloat(@ceil(scale_seconds * morlet_support_sigma * g_session.sample_rate)))),
    );
    const stride = maxI32(1, @divTrunc(support_samples, morlet_target_steps));
    var real: f32 = 0.0;
    var imaginary: f32 = 0.0;
    var norm: f32 = 0.0;
    var offset: i32 = -support_samples;

    while (offset <= support_samples) : (offset += stride) {
        const sample_index = center_sample + offset;
        if (sample_index < 0 or sample_index >= g_session.sample_count) continue;

        const time = @as(f32, @floatFromInt(offset)) / g_session.sample_rate;
        const normalized_time = time / scale_seconds;
        const gaussian = @exp(-0.5 * normalized_time * normalized_time);
        const phase = morlet_omega0 * normalized_time;
        const sample = g_session.samples[@as(usize, @intCast(sample_index))];

        real += sample * gaussian * @cos(phase);
        imaginary -= sample * gaussian * @sin(phase);
        norm += gaussian * gaussian;
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
    const power_spectrum_length = @as(usize, @intCast(maxI32(2, @divTrunc(fft_size, 2) + 1)));
    const power_spectrum = allocator.alloc(f32, power_spectrum_length) catch return 0;
    defer allocator.free(power_spectrum);

    const safe_min_frequency = maxF32(g_session.min_frequency, min_frequency);
    const safe_max_frequency = minF32(g_session.max_frequency, max_frequency);
    const output = @as([*]u8, @ptrFromInt(@as(usize, @intCast(output_ptr))));
    const safe_tile_span = maxF32(1.0 / g_session.sample_rate, @as(f32, @floatCast(tile_end - tile_start)));
    const output_width = @as(usize, @intCast(column_count));

    var band_ranges: []BandRange = &.{};
    var mel_bands: []MelBand = &.{};
    var use_low_frequency_enhancement = false;
    var low_frequency_maximum: f32 = 0.0;
    var low_power_spectrum: []f32 = &.{};
    var enhanced_band_ranges: []BandRange = &.{};

    defer if (band_ranges.len > 0) allocator.free(band_ranges);
    defer if (mel_bands.len > 0) allocator.free(mel_bands);
    defer if (low_power_spectrum.len > 0) allocator.free(low_power_spectrum);
    defer if (enhanced_band_ranges.len > 0) allocator.free(enhanced_band_ranges);

    switch (analysis_type) {
        .mel => {
            mel_bands = allocator.alloc(MelBand, @as(usize, @intCast(row_count))) catch return 0;
            createMelBands(mel_bands, fft_size, g_session.sample_rate, safe_min_frequency, safe_max_frequency);
        },
        .spectrogram => {
            band_ranges = allocator.alloc(BandRange, @as(usize, @intCast(row_count))) catch return 0;
            switch (frequency_scale) {
                .linear => createLinearBandRanges(band_ranges, fft_size, g_session.sample_rate, safe_min_frequency, safe_max_frequency),
                .log => createLogBandRanges(band_ranges, fft_size, g_session.sample_rate, safe_min_frequency, safe_max_frequency),
            }

            if (decimation_factor > 1) {
                const effective_sample_rate = g_session.sample_rate / @as(f32, @floatFromInt(decimation_factor));
                low_frequency_maximum = minF32(
                    low_frequency_enhancement_max_frequency,
                    minF32((effective_sample_rate / 2.0) * 0.92, safe_max_frequency),
                );

                if (low_frequency_maximum > safe_min_frequency * 1.25) {
                    low_power_spectrum = allocator.alloc(f32, power_spectrum_length) catch &.{};
                    enhanced_band_ranges = allocator.alloc(BandRange, @as(usize, @intCast(row_count))) catch &.{};

                    if (low_power_spectrum.len > 0 and enhanced_band_ranges.len > 0) {
                        createBandRangesForSampleRate(
                            enhanced_band_ranges,
                            band_ranges,
                            fft_size,
                            effective_sample_rate,
                            safe_min_frequency,
                            low_frequency_maximum,
                        );
                        use_low_frequency_enhancement = true;
                    }
                }
            }
        },
        .scalogram => return 0,
    }

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

        if (use_low_frequency_enhancement) {
            writeDecimatedInput(resource, center_sample, decimation_factor);
            pffft_transform_ordered(setup, input.ptr, output_buffer.ptr, work_buffer.ptr, .forward);
            writePowerSpectrum(resource, low_power_spectrum);
        }

        var row: i32 = 0;
        while (row < row_count) : (row += 1) {
            const normalized = switch (analysis_type) {
                .mel => normalizeMagnitudeToDecibels(computeMelBandRms(
                    power_spectrum,
                    mel_bands[@as(usize, @intCast(row))],
                    fft_size,
                    g_session.sample_rate,
                )),
                .spectrogram => blk: {
                    const base_range = band_ranges[@as(usize, @intCast(row))];
                    const use_low_band = use_low_frequency_enhancement and base_range.end_frequency <= low_frequency_maximum;
                    const active_range = if (use_low_band)
                        enhanced_band_ranges[@as(usize, @intCast(row))]
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
    const output = @as([*]u8, @ptrFromInt(@as(usize, @intCast(output_ptr))));
    const safe_tile_span = maxF32(1.0 / g_session.sample_rate, @as(f32, @floatCast(tile_end - tile_start)));
    const output_width = @as(usize, @intCast(column_count));

    var column_index: i32 = 0;
    while (column_index < column_count) : (column_index += 1) {
        const center_ratio = if (column_count == 1)
            0.5
        else
            (@as(f64, @floatFromInt(column_index)) + 0.5) / @as(f64, @floatFromInt(column_count));
        const center_time = tile_start + (center_ratio * @as(f64, safe_tile_span));
        const center_sample = @as(i32, @intFromFloat(@round(center_time * @as(f64, g_session.sample_rate))));

        var row: i32 = 0;
        while (row < row_count) : (row += 1) {
            const frequency = frequencyForScalogramRow(row, row_count, safe_min_frequency, safe_max_frequency);
            const normalized = normalizeMagnitudeToDecibels(computeMorletMagnitude(center_sample, frequency));
            const target_row = row_count - row - 1;
            const pixel_offset = ((@as(usize, @intCast(target_row)) * output_width) + @as(usize, @intCast(column_index))) * 4;
            writePaletteColor(normalized, output[pixel_offset .. pixel_offset + 4]);
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
