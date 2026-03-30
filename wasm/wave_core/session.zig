const core = @import("./core.zig");
const spectrogram = @import("./spectrogram.zig");

pub fn freeWaveLevels() void {
    if (core.g_session.levels.len == 0) return;
    for (core.g_session.levels) |*level| level.deinit();
    core.allocator.free(core.g_session.levels);
    core.g_session.levels = &.{};
}

pub fn computeLevelCount(sample_count: i32) i32 {
    if (sample_count <= 0) return 0;

    var level_count: i32 = 0;
    var block_size: i32 = core.min_level_block_size;

    while (block_size < sample_count) {
        level_count += 1;
        if (core.ceilDivI32(sample_count, block_size) <= core.min_level_buckets) break;
        block_size *= core.level_scale_factor;
    }

    return level_count;
}

pub fn resetSessionState() void {
    freeWaveLevels();
    spectrogram.freeFftResources();
    spectrogram.freeBandLayoutResources();
    spectrogram.freeScalogramResources();
    if (core.g_session.samples.len > 0) core.allocator.free(core.g_session.samples);
    core.g_session = .{};
}

pub export fn wave_dispose_session() void {
    resetSessionState();
}

pub export fn wave_prepare_session(sample_count: i32, sample_rate: f32, duration: f32) i32 {
    resetSessionState();
    if (sample_count <= 0 or !core.isFiniteF32(sample_rate) or !core.isFiniteF32(duration) or sample_rate <= 0.0 or duration <= 0.0) {
        return 0;
    }

    core.g_session.samples = core.allocator.alloc(f32, @as(usize, @intCast(sample_count))) catch {
        resetSessionState();
        return 0;
    };
    @memset(core.g_session.samples, 0);

    core.g_session.sample_count = sample_count;
    core.g_session.sample_rate = sample_rate;
    core.g_session.duration = duration;
    core.g_session.min_frequency = core.hard_min_frequency;
    core.g_session.max_frequency = core.minF32(core.hard_max_frequency, sample_rate / 2.0);
    return 1;
}

pub export fn wave_get_pcm_ptr() usize {
    if (core.g_session.samples.len == 0) return 0;
    return @intFromPtr(core.g_session.samples.ptr);
}
