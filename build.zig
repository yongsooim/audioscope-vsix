const std = @import("std");

const WaveCoreVariant = struct {
    artifact_name: []const u8,
    pffft_flags: []const []const u8 = &.{},
    target: std.Build.ResolvedTarget,
};

pub fn build(b: *std.Build) void {
    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "Optimization mode") orelse .ReleaseFast;

    const fallback_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
    });

    const simd_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
        .cpu_features_add = std.Target.wasm.featureSet(&.{.simd128}),
    });

    const update_artifacts = b.addUpdateSourceFiles();
    const wave_core_step = b.step("wave-core-artifacts", "Build wave core wasm artifacts into dist/wasm/");

    const simd_artifact = addWaveCoreArtifact(b, .{
        .artifact_name = "wave_core_simd",
        .pffft_flags = &.{ "-msimd128" },
        .target = simd_target,
    }, optimize);
    update_artifacts.addCopyFileToSource(simd_artifact.getEmittedBin(), "dist/wasm/wave_core_simd.wasm");

    const fallback_artifact = addWaveCoreArtifact(b, .{
        .artifact_name = "wave_core_fallback",
        .pffft_flags = &.{ "-DPFFFT_SIMD_DISABLE=1" },
        .target = fallback_target,
    }, optimize);
    update_artifacts.addCopyFileToSource(fallback_artifact.getEmittedBin(), "dist/wasm/wave_core_fallback.wasm");

    wave_core_step.dependOn(&update_artifacts.step);
}

fn addWaveCoreArtifact(
    b: *std.Build,
    variant: WaveCoreVariant,
    optimize: std.builtin.OptimizeMode,
) *std.Build.Step.Compile {
    const root_module = b.createModule(.{
        .root_source_file = b.path("wasm/wave_core.zig"),
        .target = variant.target,
        .optimize = optimize,
        .strip = true,
    });

    root_module.addIncludePath(b.path("wasm/freestanding/include"));
    root_module.addIncludePath(b.path("wasm/third_party/pffft"));
    root_module.addIncludePath(b.path("wasm/third_party/libebur128/ebur128"));

    root_module.addCSourceFile(.{
        .file = b.path("wasm/third_party/pffft/pffft.c"),
        .flags = buildCFlags(b, variant.pffft_flags),
    });
    root_module.addCSourceFile(.{
        .file = b.path("wasm/third_party/libebur128/ebur128/ebur128.c"),
        .flags = buildCFlags(b, &.{}),
    });

    const artifact = b.addExecutable(.{
        .name = variant.artifact_name,
        .root_module = root_module,
    });

    artifact.entry = .disabled;
    artifact.rdynamic = true;
    artifact.export_memory = true;
    artifact.stack_size = 1024 * 1024;
    artifact.initial_memory = 8 * 1024 * 1024;

    return artifact;
}

fn buildCFlags(b: *std.Build, extra_flags: []const []const u8) []const []const u8 {
    const common_flags = [_][]const u8{
        "-std=c11",
        "-O3",
        "-DNDEBUG",
        "-ffast-math",
        "-fno-math-errno",
        "-ffunction-sections",
        "-fdata-sections",
    };

    const flags = b.allocator.alloc([]const u8, common_flags.len + extra_flags.len) catch @panic("OOM");

    @memcpy(flags[0..common_flags.len], common_flags[0..]);
    @memcpy(flags[common_flags.len..], extra_flags);

    return flags;
}
