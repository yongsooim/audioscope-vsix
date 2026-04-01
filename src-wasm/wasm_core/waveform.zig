const core = @import("./core.zig");
const session = @import("./session.zig");

fn pickWaveformLevel(samples_per_pixel: f64) ?*const core.WaveLevel {
    var selected: ?*const core.WaveLevel = null;

    for (core.g_session.levels) |*level| {
        if (@as(f64, @floatFromInt(level.block_size)) <= samples_per_pixel * 1.5) {
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

    const min_result = core.reduceMinMax(
        level.min_peaks[@as(usize, @intCast(start_block))..@as(usize, @intCast(end_block))],
        false,
    );
    const max_result = core.reduceMinMax(
        level.max_peaks[@as(usize, @intCast(start_block))..@as(usize, @intCast(end_block))],
        false,
    );

    return .{ .min = min_result.min, .max = max_result.max };
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

pub export fn wave_build_waveform_pyramid() i32 {
    if (core.g_session.samples.len == 0 or core.g_session.sample_count <= 0) return 0;

    session.freeWaveLevels();

    const level_count = session.computeLevelCount(core.g_session.sample_count);
    if (level_count <= 0) return 0;

    core.g_session.levels = core.allocator.alloc(core.WaveLevel, @as(usize, @intCast(level_count))) catch return 0;
    for (core.g_session.levels) |*level| level.* = .{};

    var block_size = core.min_level_block_size;
    var previous_level: ?*core.WaveLevel = null;
    for (core.g_session.levels, 0..) |*level, block_index| {
        _ = block_index;
        const block_count = core.ceilDivI32(core.g_session.sample_count, block_size);
        level.block_size = block_size;
        level.block_count = block_count;
        level.min_peaks = core.allocator.alloc(f32, @as(usize, @intCast(block_count))) catch {
            session.freeWaveLevels();
            return 0;
        };
        level.max_peaks = core.allocator.alloc(f32, @as(usize, @intCast(block_count))) catch {
            session.freeWaveLevels();
            return 0;
        };

        var sample_block_index: usize = 0;
        if (previous_level) |parent_level| {
            while (sample_block_index < level.min_peaks.len) : (sample_block_index += 1) {
                const start = @as(i32, @intCast(sample_block_index)) * core.level_scale_factor;
                const end = core.minI32(parent_level.block_count, start + core.level_scale_factor);
                var min_peak: f32 = 1.0;
                var max_peak: f32 = -1.0;
                var parent_index = start;

                while (parent_index < end) : (parent_index += 1) {
                    const parent_usize = @as(usize, @intCast(parent_index));
                    min_peak = core.minF32(min_peak, parent_level.min_peaks[parent_usize]);
                    max_peak = core.maxF32(max_peak, parent_level.max_peaks[parent_usize]);
                }

                level.min_peaks[sample_block_index] = min_peak;
                level.max_peaks[sample_block_index] = max_peak;
            }
        } else {
            while (sample_block_index < level.min_peaks.len) : (sample_block_index += 1) {
                const start = @as(i32, @intCast(sample_block_index)) * block_size;
                const end = core.minI32(core.g_session.sample_count, start + block_size);
                const result = core.reduceMinMax(
                    core.g_session.samples[@as(usize, @intCast(start))..@as(usize, @intCast(end))],
                    true,
                );
                level.min_peaks[sample_block_index] = result.min;
                level.max_peaks[sample_block_index] = result.max;
            }
        }

        previous_level = level;

        if (core.ceilDivI32(core.g_session.sample_count, block_size) <= core.min_level_buckets) break;
        block_size *= core.level_scale_factor;
    }

    return @as(i32, @intCast(core.g_session.levels.len));
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
    const selected_level = pickWaveformLevel(samples_per_pixel);

    if (selected_level) |level| {
        const plan = computeStableLevelSlicePlan(level, requested_start_sample, requested_end_sample, column_count);
        writeWaveformSliceMeta(
            meta_output_ptr,
            samplePositionToSeconds(plan.actual_start_sample),
            samplePositionToSeconds(plan.actual_end_sample),
        );

        var column_index: i32 = 0;
        const actual_block_span = core.maxI32(1, plan.actual_end_block - plan.actual_start_block);
        while (column_index < column_count) : (column_index += 1) {
            const column_start_block = plan.actual_start_block + @as(i32, @intFromFloat(@floor(
                (@as(f64, @floatFromInt(column_index)) * @as(f64, @floatFromInt(actual_block_span)))
                    / @as(f64, @floatFromInt(column_count)),
            )));
            const column_end_block = plan.actual_start_block + @as(i32, @intFromFloat(@ceil(
                (@as(f64, @floatFromInt(column_index + 1)) * @as(f64, @floatFromInt(actual_block_span)))
                    / @as(f64, @floatFromInt(column_count)),
            )));
            const start_block = core.clampi32(column_start_block, 0, core.maxI32(0, level.block_count - 1));
            const end_block = core.clampi32(core.maxI32(start_block + 1, column_end_block), start_block + 1, level.block_count);
            const result = getLevelRange(
                level,
                start_block * level.block_size,
                end_block * level.block_size,
            );

            output[@as(usize, @intCast(column_index * 2))] = result.min;
            output[@as(usize, @intCast((column_index * 2) + 1))] = result.max;
        }

        return 1;
    }

    const plan = computeStableSampleSlicePlan(requested_start_sample, requested_end_sample, column_count);
    writeWaveformSliceMeta(
        meta_output_ptr,
        samplePositionToSeconds(plan.actual_start_sample),
        samplePositionToSeconds(plan.actual_end_sample),
    );

    var column_index: i32 = 0;
    const actual_sample_span = core.maxI32(1, plan.actual_end_sample_index - plan.actual_start_sample_index);
    while (column_index < column_count) : (column_index += 1) {
        const raw_start_sample = plan.actual_start_sample_index + @as(i32, @intFromFloat(@floor(
            (@as(f64, @floatFromInt(column_index)) * @as(f64, @floatFromInt(actual_sample_span)))
                / @as(f64, @floatFromInt(column_count)),
        )));
        const raw_end_sample = plan.actual_start_sample_index + @as(i32, @intFromFloat(@ceil(
            (@as(f64, @floatFromInt(column_index + 1)) * @as(f64, @floatFromInt(actual_sample_span)))
                / @as(f64, @floatFromInt(column_count)),
        )));
        const column_start_sample = core.clampi32(raw_start_sample, 0, core.maxI32(0, core.g_session.sample_count - 1));
        const column_end_sample = core.clampi32(
            core.maxI32(column_start_sample + 1, raw_end_sample),
            column_start_sample + 1,
            core.g_session.sample_count,
        );
        const result = getSampleRange(column_start_sample, column_end_sample);

        output[@as(usize, @intCast(column_index * 2))] = result.min;
        output[@as(usize, @intCast((column_index * 2) + 1))] = result.max;
    }

    return 1;
}
