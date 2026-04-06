const core = @import("./core.zig");
const session = @import("./session.zig");

fn isWaveformLevelRangeBuilt(level_index: usize, end_sample: f64) bool {
    if (level_index >= core.g_session.levels.len) return false;
    if (!core.g_session.waveform_build.active) return true;

    const build_level_index = core.g_session.waveform_build.current_level_index;
    const target_level_index = @as(i32, @intCast(level_index));
    if (build_level_index > target_level_index) return true;
    if (build_level_index < target_level_index) return false;

    const level = &core.g_session.levels[level_index];
    const clamped_end_sample = clampSamplePosition(end_sample);
    const required_end_block = core.ceilDivI32(
        @as(i32, @intFromFloat(@ceil(clamped_end_sample))),
        level.block_size,
    );
    return required_end_block <= core.g_session.waveform_build.current_block_index;
}

fn pickWaveformLevel(samples_per_pixel: f64, end_sample: f64) ?*const core.WaveLevel {
    var selected: ?*const core.WaveLevel = null;

    for (core.g_session.levels, 0..) |*level, level_index| {
        if (@as(f64, @floatFromInt(level.block_size)) <= samples_per_pixel * 1.5) {
            if (!isWaveformLevelRangeBuilt(level_index, end_sample)) {
                continue;
            }
            selected = level;
            continue;
        }
        break;
    }

    return selected;
}

fn getSampleRange(start_sample: i32, end_sample: i32) core.RangeResult {
    const clamped_start = core.maxI32(0, start_sample);
    const clamped_end = core.minI32(core.g_session.sample_count, end_sample);
    if (clamped_end <= clamped_start or core.g_session.samples.len == 0) {
        return .{ .min = 1.0, .max = -1.0 };
    }

    return core.reduceMinMax(
        core.g_session.samples[@as(usize, @intCast(clamped_start))..@as(usize, @intCast(clamped_end))],
        false,
    );
}

fn getLevelRange(level: *const core.WaveLevel, start_sample: i32, end_sample: i32) core.RangeResult {
    const start_block = core.maxI32(0, @divTrunc(start_sample, level.block_size));
    const end_block = core.minI32(level.block_count, core.ceilDivI32(end_sample, level.block_size));
    if (end_block <= start_block) {
        return .{ .min = 1.0, .max = -1.0 };
    }

    var min_value: f32 = 1.0;
    var max_value: f32 = -1.0;
    var block_index = start_block;
    while (block_index < end_block) : (block_index += 1) {
        const block_usize = @as(usize, @intCast(block_index));
        min_value = core.minF32(min_value, level.min_peaks[block_usize]);
        max_value = core.maxF32(max_value, level.max_peaks[block_usize]);
    }

    return .{ .min = min_value, .max = max_value };
}

fn getSamplePeak(start_sample: i32, end_sample: i32) f32 {
    return peakFromRange(getSampleRange(start_sample, end_sample));
}

fn getLevelPeak(level: *const core.WaveLevel, start_sample: i32, end_sample: i32) f32 {
    return peakFromRange(getLevelRange(level, start_sample, end_sample));
}

fn fillWaveformColumns(
    output: [*]f32,
    column_count: i32,
    requested_start_sample: f64,
    requested_end_sample: f64,
    selected_level: ?*const core.WaveLevel,
) void {
    const requested_sample_span = maxF64(1.0, requested_end_sample - requested_start_sample);
    const sample_step = requested_sample_span / @as(f64, @floatFromInt(column_count));
    const max_start_sample = core.maxI32(0, core.g_session.sample_count - 1);
    var column_start_position = requested_start_sample;
    var next_boundary = requested_start_sample + sample_step;
    var column_index: i32 = 0;
    var output_index: usize = 0;

    while (column_index < column_count) : (column_index += 1) {
        const column_end_position = if (column_index + 1 >= column_count)
            requested_end_sample
        else
            next_boundary;
        const raw_start_sample = @as(i32, @intFromFloat(@floor(column_start_position)));
        const raw_end_sample = @as(i32, @intFromFloat(@ceil(column_end_position)));
        const start_sample = core.clampi32(raw_start_sample, 0, max_start_sample);
        const end_sample = core.clampi32(
            core.maxI32(start_sample + 1, raw_end_sample),
            start_sample + 1,
            core.g_session.sample_count,
        );
        const result = if (selected_level) |level|
            getLevelRange(level, start_sample, end_sample)
        else
            getSampleRange(start_sample, end_sample);

        output[output_index] = result.min;
        output[output_index + 1] = result.max;
        output_index += 2;
        column_start_position = column_end_position;
        next_boundary += sample_step;
    }
}

const StableLevelSlicePlan = struct {
    actual_end_sample: f64,
    actual_end_block: i32,
    actual_start_block: i32,
    actual_start_sample: f64,
};

const StableSampleSlicePlan = struct {
    actual_end_sample: f64,
    actual_end_sample_index: i32,
    actual_start_sample: f64,
    actual_start_sample_index: i32,
};

fn maxF64(left: f64, right: f64) f64 {
    return if (left > right) left else right;
}

fn clampSamplePosition(sample_position: f64) f64 {
    return core.clampf64(sample_position, 0.0, @as(f64, @floatFromInt(core.g_session.sample_count)));
}

fn samplePositionToSeconds(sample_position: f64) f64 {
    const sample_rate = @as(f64, core.g_session.sample_rate);
    if (!core.isFiniteF64(sample_rate) or sample_rate <= 0.0) return 0.0;
    return core.clampf64(sample_position / sample_rate, 0.0, @as(f64, core.g_session.duration));
}

fn writeWaveformSliceMeta(meta_output_ptr: usize, start_seconds: f64, end_seconds: f64) void {
    if (meta_output_ptr == 0) {
        return;
    }

    const output: [*]f64 = @ptrFromInt(meta_output_ptr);
    output[0] = start_seconds;
    output[1] = end_seconds;
}


fn computeStableLevelSlicePlan(level: *const core.WaveLevel, start_sample: f64, end_sample: f64, _: i32) StableLevelSlicePlan {
    const block_size_f64 = @as(f64, @floatFromInt(level.block_size));
    const desired_start_block = start_sample / block_size_f64;
    const desired_end_block = end_sample / block_size_f64;
    var actual_start_block = core.maxI32(
        0,
        @as(i32, @intFromFloat(@floor(desired_start_block))),
    );
    var actual_end_block = core.maxI32(
        actual_start_block + 1,
        @as(i32, @intFromFloat(@ceil(desired_end_block))),
    );

    if (actual_end_block > level.block_count) {
        actual_end_block = level.block_count;
        actual_start_block = core.minI32(actual_start_block, core.maxI32(0, actual_end_block - 1));
    }

    return .{
        .actual_end_sample = @as(f64, @floatFromInt(actual_end_block * level.block_size)),
        .actual_end_block = actual_end_block,
        .actual_start_block = actual_start_block,
        .actual_start_sample = @as(f64, @floatFromInt(actual_start_block * level.block_size)),
    };
}

fn computeStableSampleSlicePlan(start_sample: f64, end_sample: f64, _: i32) StableSampleSlicePlan {
    var actual_start_sample_index = core.maxI32(
        0,
        @as(i32, @intFromFloat(@floor(start_sample))),
    );
    var actual_end_sample_index = core.maxI32(
        actual_start_sample_index + 1,
        @as(i32, @intFromFloat(@ceil(end_sample))),
    );

    if (actual_end_sample_index > core.g_session.sample_count) {
        actual_end_sample_index = core.g_session.sample_count;
        actual_start_sample_index = core.minI32(
            actual_start_sample_index,
            core.maxI32(0, actual_end_sample_index - 1),
        );
    }

    return .{
        .actual_end_sample = @as(f64, @floatFromInt(actual_end_sample_index)),
        .actual_end_sample_index = actual_end_sample_index,
        .actual_start_sample = @as(f64, @floatFromInt(actual_start_sample_index)),
        .actual_start_sample_index = actual_start_sample_index,
    };
}

fn peakFromRange(result: core.RangeResult) f32 {
    return core.maxF32(@abs(result.min), @abs(result.max));
}

fn prepareWaveformLevels() i32 {
    session.freeWaveLevels();

    const level_count = session.computeLevelCount(core.g_session.sample_count);
    if (level_count <= 0) return 0;

    core.g_session.levels = core.allocator.alloc(core.WaveLevel, @as(usize, @intCast(level_count))) catch return 0;
    for (core.g_session.levels) |*level| level.* = .{};

    var block_size = core.min_level_block_size;
    for (core.g_session.levels) |*level| {
        const block_count = core.ceilDivI32(core.g_session.sample_count, block_size);
        level.block_size = block_size;
        level.block_count = block_count;
        level.max_peaks = core.allocator.alloc(f32, @as(usize, @intCast(block_count))) catch {
            session.freeWaveLevels();
            return 0;
        };
        level.min_peaks = core.allocator.alloc(f32, @as(usize, @intCast(block_count))) catch {
            session.freeWaveLevels();
            return 0;
        };
        @memset(level.max_peaks, -1.0);
        @memset(level.min_peaks, 1.0);
        block_size *= core.level_scale_factor;
    }

    core.g_session.waveform_build = .{
        .active = true,
        .current_block_index = 0,
        .current_level_index = 0,
    };

    return @as(i32, @intCast(core.g_session.levels.len));
}

fn buildWaveformPyramidBlock(level_index: i32, block_index: i32) void {
    const level = &core.g_session.levels[@as(usize, @intCast(level_index))];
    const block_usize = @as(usize, @intCast(block_index));

    if (level_index > 0) {
        const parent_level = &core.g_session.levels[@as(usize, @intCast(level_index - 1))];
        const start = block_index * core.level_scale_factor;
        const end = core.minI32(parent_level.block_count, start + core.level_scale_factor);
        var min_value: f32 = 1.0;
        var max_value: f32 = -1.0;
        var parent_index = start;

        while (parent_index < end) : (parent_index += 1) {
            const parent_usize = @as(usize, @intCast(parent_index));
            min_value = core.minF32(min_value, parent_level.min_peaks[parent_usize]);
            max_value = core.maxF32(max_value, parent_level.max_peaks[parent_usize]);
        }

        level.min_peaks[block_usize] = min_value;
        level.max_peaks[block_usize] = max_value;
        return;
    }

    const start = block_index * level.block_size;
    const end = core.minI32(core.g_session.sample_count, start + level.block_size);
    const result = core.reduceMinMax(
        core.g_session.samples[@as(usize, @intCast(start))..@as(usize, @intCast(end))],
        false,
    );
    level.min_peaks[block_usize] = result.min;
    level.max_peaks[block_usize] = result.max;
}

pub export fn wave_begin_waveform_pyramid_build() i32 {
    if (core.g_session.samples.len == 0 or core.g_session.sample_count <= 0) return 0;
    return prepareWaveformLevels();
}

pub export fn wave_build_waveform_pyramid_step(max_blocks: i32) i32 {
    if (core.g_session.samples.len == 0 or core.g_session.sample_count <= 0 or core.g_session.levels.len == 0) {
        return 0;
    }

    if (!core.g_session.waveform_build.active) {
        return 1;
    }

    var remaining_blocks = core.maxI32(1, max_blocks);
    while (remaining_blocks > 0 and core.g_session.waveform_build.active) : (remaining_blocks -= 1) {
        if (core.g_session.waveform_build.current_level_index >= @as(i32, @intCast(core.g_session.levels.len))) {
            core.g_session.waveform_build.active = false;
            break;
        }

        const level = &core.g_session.levels[@as(usize, @intCast(core.g_session.waveform_build.current_level_index))];
        if (core.g_session.waveform_build.current_block_index >= level.block_count) {
            core.g_session.waveform_build.current_level_index += 1;
            core.g_session.waveform_build.current_block_index = 0;
            continue;
        }

        buildWaveformPyramidBlock(
            core.g_session.waveform_build.current_level_index,
            core.g_session.waveform_build.current_block_index,
        );
        core.g_session.waveform_build.current_block_index += 1;

        if (core.g_session.waveform_build.current_block_index >= level.block_count) {
            core.g_session.waveform_build.current_level_index += 1;
            core.g_session.waveform_build.current_block_index = 0;
        }
    }

    if (core.g_session.waveform_build.current_level_index >= @as(i32, @intCast(core.g_session.levels.len))) {
        core.g_session.waveform_build.active = false;
    }

    return if (core.g_session.waveform_build.active) 0 else 1;
}

pub export fn wave_build_waveform_pyramid() i32 {
    const level_count = wave_begin_waveform_pyramid_build();
    if (level_count <= 0) return 0;

    while (wave_build_waveform_pyramid_step(1_048_576) == 0) {}
    return level_count;
}

pub export fn wave_extract_waveform_peaks(view_start: f64, view_end: f64, column_count: i32, output_ptr: usize, meta_output_ptr: usize) i32 {
    if (core.g_session.samples.len == 0 or output_ptr == 0 or column_count <= 0 or !core.isFiniteF64(view_start) or !core.isFiniteF64(view_end) or view_end <= view_start or !core.isFiniteF32(core.g_session.duration) or core.g_session.duration <= 0.0 or !core.isFiniteF32(core.g_session.sample_rate) or core.g_session.sample_rate <= 0.0) {
        return 0;
    }

    const output: [*]f32 = @ptrFromInt(output_ptr);
    const duration_f64 = @as(f64, core.g_session.duration);
    const sample_rate_f64 = @as(f64, core.g_session.sample_rate);
    const max_start = maxF64(0.0, duration_f64 - (1.0 / sample_rate_f64));
    const clamped_start = core.clampf64(view_start, 0.0, max_start);
    const clamped_end = core.clampf64(view_end, clamped_start + (1.0 / sample_rate_f64), duration_f64);
    const requested_start_sample = clampSamplePosition(clamped_start * sample_rate_f64);
    const requested_end_sample = clampSamplePosition(clamped_end * sample_rate_f64);
    const requested_sample_span = maxF64(1.0, requested_end_sample - requested_start_sample);
    const samples_per_pixel = requested_sample_span / @as(f64, @floatFromInt(column_count));
    const selected_level = pickWaveformLevel(samples_per_pixel, requested_end_sample);

    writeWaveformSliceMeta(
        meta_output_ptr,
        samplePositionToSeconds(requested_start_sample),
        samplePositionToSeconds(requested_end_sample),
    );

    fillWaveformColumns(output, column_count, requested_start_sample, requested_end_sample, selected_level);
    return 1;
}

pub export fn wave_extract_waveform_slice(view_start: f64, view_end: f64, column_count: i32, output_ptr: usize, meta_output_ptr: usize) i32 {
    if (core.g_session.samples.len == 0 or output_ptr == 0 or column_count <= 0 or !core.isFiniteF64(view_start) or !core.isFiniteF64(view_end) or view_end <= view_start or !core.isFiniteF32(core.g_session.duration) or core.g_session.duration <= 0.0 or !core.isFiniteF32(core.g_session.sample_rate) or core.g_session.sample_rate <= 0.0) {
        return 0;
    }

    const output: [*]f32 = @ptrFromInt(output_ptr);
    const duration_f64 = @as(f64, core.g_session.duration);
    const sample_rate_f64 = @as(f64, core.g_session.sample_rate);
    const max_start = maxF64(0.0, duration_f64 - (1.0 / sample_rate_f64));
    const clamped_start = core.clampf64(view_start, 0.0, max_start);
    const clamped_end = core.clampf64(view_end, clamped_start + (1.0 / sample_rate_f64), duration_f64);
    const requested_start_sample = clampSamplePosition(clamped_start * sample_rate_f64);
    const requested_end_sample = clampSamplePosition(clamped_end * sample_rate_f64);
    const requested_sample_span = maxF64(1.0, requested_end_sample - requested_start_sample);
    const samples_per_pixel = requested_sample_span / @as(f64, @floatFromInt(column_count));
    const selected_level = pickWaveformLevel(samples_per_pixel, requested_end_sample);

    writeWaveformSliceMeta(
        meta_output_ptr,
        samplePositionToSeconds(requested_start_sample),
        samplePositionToSeconds(requested_end_sample),
    );

    fillWaveformColumns(output, column_count, requested_start_sample, requested_end_sample, selected_level);
    return 1;
}
