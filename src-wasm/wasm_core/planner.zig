const core = @import("./core.zig");

const planner_output_value_count: usize = 3;

const TimeRange = struct {
    start: f64,
    end: f64,
};

fn maxF64(left: f64, right: f64) f64 {
    return if (left > right) left else right;
}

fn minF64(left: f64, right: f64) f64 {
    return if (left < right) left else right;
}

fn clampPositiveI32(value: i32, fallback: i32) i32 {
    if (value > 0) return value;
    return if (fallback > 0) fallback else 1;
}

fn writePlannerOutput(output_ptr: usize, range: TimeRange, width: i32) void {
    const output: [*]f64 = @ptrFromInt(output_ptr);
    output[0] = range.start;
    output[1] = range.end;
    output[2] = @as(f64, @floatFromInt(width));
}

fn normalizeDisplayRange(display_start: f64, display_end: f64, duration: f64) TimeRange {
    const safe_duration = if (core.isFiniteF64(duration) and duration > 0.0) duration else 0.0;

    if (safe_duration <= 0.0) {
        return .{ .start = 0.0, .end = 0.0 };
    }

    const safe_start = if (core.isFiniteF64(display_start)) display_start else 0.0;
    const safe_end = if (core.isFiniteF64(display_end)) display_end else safe_duration;
    const raw_start = core.clampf64(safe_start, 0.0, safe_duration);
    const raw_end = core.clampf64(safe_end, raw_start, safe_duration);

    if (raw_end <= raw_start) {
        return .{ .start = 0.0, .end = safe_duration };
    }

    return .{
        .start = raw_start,
        .end = raw_end,
    };
}

fn expandRange(range: TimeRange, duration: f64, factor: f64) TimeRange {
    const normalized = normalizeDisplayRange(range.start, range.end, duration);
    const span = maxF64(0.0, normalized.end - normalized.start);

    if (span <= 0.0 or duration <= 0.0) {
        return normalized;
    }

    const next_span = core.clampf64(
        span * maxF64(1.0, factor),
        span,
        maxF64(span, duration),
    );
    const extra_span = next_span - span;
    const next_start = core.clampf64(
        normalized.start - (extra_span * 0.5),
        0.0,
        maxF64(0.0, duration - next_span),
    );

    return .{
        .start = next_start,
        .end = next_start + next_span,
    };
}

fn renderColumnCount(render_width: i32, render_scale: f64) i32 {
    return clampPositiveI32(
        @as(i32, @intFromFloat(@round(@as(f64, @floatFromInt(render_width)) * maxF64(1.0, render_scale)))),
        render_width,
    );
}

fn computeBufferedRenderWidth(display_width: i32, visible_span: f64, buffered_range: TimeRange) i32 {
    const safe_display_width = clampPositiveI32(display_width, 1);
    const buffered_span = maxF64(0.0, buffered_range.end - buffered_range.start);

    if (visible_span <= 0.0 or buffered_span <= 0.0) {
        return safe_display_width;
    }

    const scaled_width = @as(i32, @intFromFloat(@ceil(
        @as(f64, @floatFromInt(safe_display_width)) * (buffered_span / visible_span),
    )));

    return clampPositiveI32(maxI32(safe_display_width, scaled_width), safe_display_width);
}

fn maxI32(left: i32, right: i32) i32 {
    return if (left > right) left else right;
}

fn snapWaveformRenderRange(
    display_range: TimeRange,
    candidate_range: TimeRange,
    duration: f64,
    render_width: i32,
    render_scale: f64,
) TimeRange {
    const render_span = maxF64(0.0, candidate_range.end - candidate_range.start);
    const clamped_duration = if (core.isFiniteF64(duration) and duration > 0.0) duration else 0.0;
    const max_start = maxF64(0.0, clamped_duration - render_span);

    if (render_span <= 0.0 or render_width <= 0 or clamped_duration <= 0.0) {
        return candidate_range;
    }

    const column_count = renderColumnCount(render_width, render_scale);
    const seconds_per_column = render_span / @as(f64, @floatFromInt(column_count));

    if (!core.isFiniteF64(seconds_per_column) or seconds_per_column <= 0.0) {
        return candidate_range;
    }

    const lower_bound = core.clampf64(display_range.end - render_span, 0.0, max_start);
    const upper_bound = core.clampf64(display_range.start, lower_bound, max_start);
    const snapped_start = @round(candidate_range.start / seconds_per_column) * seconds_per_column;
    const next_start = core.clampf64(snapped_start, lower_bound, upper_bound);

    return .{
        .start = next_start,
        .end = next_start + render_span,
    };
}

fn computeStableWaveformRenderRange(
    display_range: TimeRange,
    duration: f64,
    render_width: i32,
    render_scale: f64,
    preferred_range: TimeRange,
    preferred_valid: bool,
    buffer_factor: f64,
    margin_ratio: f64,
    epsilon: f64,
) TimeRange {
    const expanded_range = expandRange(display_range, duration, buffer_factor);
    const render_span = maxF64(0.0, expanded_range.end - expanded_range.start);

    if (!preferred_valid or render_span <= 0.0 or duration <= 0.0 or render_width <= 0) {
        return snapWaveformRenderRange(display_range, expanded_range, duration, render_width, render_scale);
    }

    const preferred_span = preferred_range.end - preferred_range.start;
    const span_tolerance = maxF64(epsilon, render_span * 0.001);

    if (@abs(preferred_span - render_span) > span_tolerance) {
        return snapWaveformRenderRange(display_range, expanded_range, duration, render_width, render_scale);
    }

    const visible_span = maxF64(0.0, display_range.end - display_range.start);
    const max_start = maxF64(0.0, duration - render_span);
    const available_padding = maxF64(0.0, (render_span - visible_span) * 0.5);
    const requested_padding = maxF64(0.0, render_span * maxF64(0.0, margin_ratio));
    const effective_padding = minF64(available_padding, requested_padding);
    const lower_bound = core.clampf64(display_range.end - render_span + effective_padding, 0.0, max_start);
    const upper_bound = core.clampf64(display_range.start - effective_padding, lower_bound, max_start);
    const column_count = renderColumnCount(render_width, render_scale);
    const seconds_per_column = render_span / @as(f64, @floatFromInt(column_count));
    const unclamped_start = core.clampf64(preferred_range.start, lower_bound, upper_bound);
    const snapped_start = if (core.isFiniteF64(seconds_per_column) and seconds_per_column > 0.0)
        @round(unclamped_start / seconds_per_column) * seconds_per_column
    else
        unclamped_start;
    const next_start = core.clampf64(snapped_start, lower_bound, upper_bound);

    return .{
        .start = next_start,
        .end = next_start + render_span,
    };
}

pub export fn wave_plan_waveform_follow_render(
    display_start: f64,
    display_end: f64,
    duration: f64,
    display_width: i32,
    render_scale: f64,
    preferred_start: f64,
    preferred_end: f64,
    preferred_valid: i32,
    buffer_factor: f64,
    margin_ratio: f64,
    epsilon: f64,
    output_ptr: usize,
) i32 {
    if (output_ptr == 0) {
        return 0;
    }

    const display_range = normalizeDisplayRange(display_start, display_end, duration);
    const visible_span = maxF64(0.0, display_range.end - display_range.start);

    if (duration <= 0.0 or visible_span <= 0.0 or display_width <= 0) {
        return 0;
    }

    const expanded_range = expandRange(display_range, duration, buffer_factor);
    const render_width = computeBufferedRenderWidth(display_width, visible_span, expanded_range);
    const preferred_range = TimeRange{
        .start = preferred_start,
        .end = preferred_end,
    };
    const render_range = computeStableWaveformRenderRange(
        display_range,
        duration,
        render_width,
        render_scale,
        preferred_range,
        preferred_valid != 0 and preferred_end > preferred_start,
        buffer_factor,
        margin_ratio,
        epsilon,
    );

    writePlannerOutput(output_ptr, render_range, render_width);
    return 1;
}

pub export fn wave_plan_spectrogram_follow_render(
    display_start: f64,
    display_end: f64,
    duration: f64,
    pixel_width: i32,
    buffer_factor: f64,
    output_ptr: usize,
) i32 {
    if (output_ptr == 0) {
        return 0;
    }

    const display_range = normalizeDisplayRange(display_start, display_end, duration);
    const visible_span = maxF64(0.0, display_range.end - display_range.start);

    if (duration <= 0.0 or visible_span <= 0.0 or pixel_width <= 0) {
        return 0;
    }

    const request_range = expandRange(display_range, duration, buffer_factor);
    const request_width = computeBufferedRenderWidth(pixel_width, visible_span, request_range);

    writePlannerOutput(output_ptr, request_range, request_width);
    return 1;
}
