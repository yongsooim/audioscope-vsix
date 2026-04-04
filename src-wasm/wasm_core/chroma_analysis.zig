const std = @import("std");
const core = @import("./core.zig");

pub const ChromaLayoutData = struct {
    row_offsets: []i32,
    bin_indices: []i32,
    weights: []f32,
};

fn positiveModuloI32(value: i32, modulus: i32) i32 {
    const remainder = @mod(value, modulus);
    return if (remainder < 0) remainder + modulus else remainder;
}

pub fn createCqtChromaFoldLayout(bin_count: i32, bins_per_octave: i32) !ChromaLayoutData {
    const safe_bin_count = core.maxI32(1, bin_count);
    const safe_bins_per_octave = core.maxI32(core.chroma_bin_count, bins_per_octave);
    const bins_per_chroma = core.maxI32(1, @divTrunc(safe_bins_per_octave, core.chroma_bin_count));
    const row_offsets = try core.allocator.alloc(i32, @as(usize, @intCast(core.chroma_bin_count + 1)));
    errdefer core.allocator.free(row_offsets);
    const bin_indices = try core.allocator.alloc(i32, @as(usize, @intCast(safe_bin_count)));
    errdefer core.allocator.free(bin_indices);
    const weights = try core.allocator.alloc(f32, @as(usize, @intCast(safe_bin_count)));
    errdefer core.allocator.free(weights);

    var counts: [core.chroma_bin_count]i32 = [_]i32{0} ** core.chroma_bin_count;
    var bin_index: i32 = 0;
    while (bin_index < safe_bin_count) : (bin_index += 1) {
        const octave_index = positiveModuloI32(bin_index, safe_bins_per_octave);
        const chroma = core.minI32(core.chroma_bin_count - 1, @divTrunc(octave_index, bins_per_chroma));
        counts[@as(usize, @intCast(chroma))] += 1;
    }

    var running_offset: i32 = 0;
    for (0..counts.len) |index| {
        row_offsets[index] = running_offset;
        running_offset += counts[index];
    }
    row_offsets[counts.len] = running_offset;

    var cursor_by_row: [core.chroma_bin_count]i32 = counts;
    for (0..cursor_by_row.len) |index| {
        cursor_by_row[index] = row_offsets[index];
    }

    bin_index = 0;
    while (bin_index < safe_bin_count) : (bin_index += 1) {
        const octave_index = positiveModuloI32(bin_index, safe_bins_per_octave);
        const chroma = core.minI32(core.chroma_bin_count - 1, @divTrunc(octave_index, bins_per_chroma));
        const row_usize = @as(usize, @intCast(chroma));
        const write_index = @as(usize, @intCast(cursor_by_row[row_usize]));
        bin_indices[write_index] = bin_index;
        weights[write_index] = 1.0;
        cursor_by_row[row_usize] += 1;
    }

    return .{
        .row_offsets = row_offsets,
        .bin_indices = bin_indices,
        .weights = weights,
    };
}

pub fn constantQBinCount(max_frequency: f32, bins_per_octave: i32) i32 {
    const safe_max_frequency = core.maxF32(core.cqt_default_fmin * 1.01, max_frequency);
    const octave_span = std.math.log2(safe_max_frequency / core.cqt_default_fmin);
    return core.maxI32(1, @as(i32, @intFromFloat(@floor(octave_span * @as(f32, @floatFromInt(bins_per_octave))))) + 1);
}

pub fn createConstantQFrequencies(bin_count: i32, bins_per_octave: i32) ![]f32 {
    const safe_bin_count = core.maxI32(1, bin_count);
    const safe_bins_per_octave = core.maxI32(core.chroma_bin_count, bins_per_octave);
    const frequencies = try core.allocator.alloc(f32, @as(usize, @intCast(safe_bin_count)));
    errdefer core.allocator.free(frequencies);

    for (frequencies, 0..) |*frequency, bin_usize| {
        const bin = @as(f32, @floatFromInt(bin_usize));
        frequency.* = core.cqt_default_fmin * @exp2(bin / @as(f32, @floatFromInt(safe_bins_per_octave)));
    }

    return frequencies;
}

pub fn accumulateChromaValues(
    source_values: []const f32,
    layout: *const core.ChromaLayoutResource,
    destination: []f32,
) void {
    @memset(destination, 0.0);

    var row: i32 = 0;
    while (row < core.chroma_bin_count and row < @as(i32, @intCast(destination.len))) : (row += 1) {
        const row_start = layout.row_offsets[@as(usize, @intCast(row))];
        const row_end = layout.row_offsets[@as(usize, @intCast(row + 1))];
        var cursor = row_start;
        var sum: f32 = 0.0;

        while (cursor < row_end) : (cursor += 1) {
            const active_index = @as(usize, @intCast(cursor));
            const source_index = @as(usize, @intCast(layout.bin_indices[active_index]));
            if (source_index >= source_values.len) continue;
            sum += source_values[source_index] * layout.weights[active_index];
        }

        destination[@as(usize, @intCast(row))] = sum;
    }
}

pub fn normalizeChromaValues(values: []f32) void {
    var maximum_value: f32 = 0.0;
    for (values) |value| {
        maximum_value = core.maxF32(maximum_value, @abs(value));
    }

    if (maximum_value <= 1e-8) {
        @memset(values, 0.0);
        return;
    }

    for (values) |*value| {
        value.* /= maximum_value;
    }
}
