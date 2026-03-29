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

pub export fn wave_extract_waveform_slice(view_start: f64, view_end: f64, column_count: i32, output_ptr: i32) i32 {
    if (core.g_session.samples.len == 0 or output_ptr == 0 or column_count <= 0 or view_end <= view_start or core.g_session.duration <= 0.0) {
        return 0;
    }

    const output: [*]f32 = @ptrFromInt(@as(usize, @intCast(output_ptr)));
    const clamped_start = core.clampf64(view_start, 0.0, @as(f64, core.g_session.duration));
    const clamped_end = core.clampf64(view_end, clamped_start + 0.0001, @as(f64, core.g_session.duration));
    const duration_f64 = @as(f64, core.g_session.duration);
    const sample_count_f64 = @as(f64, @floatFromInt(core.g_session.sample_count));
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
        const column_start_sample = core.clampi32(
            @as(i32, @intFromFloat(@floor((column_start_time / duration_f64) * sample_count_f64))),
            0,
            core.g_session.sample_count,
        );
        const column_end_sample = core.clampi32(
            @as(i32, @intFromFloat(@ceil((column_end_time / duration_f64) * sample_count_f64))),
            0,
            core.g_session.sample_count,
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
