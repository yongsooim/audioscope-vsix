const std = @import("std");
const core = @import("./core.zig");

fn allocBytes(byte_count: usize, alignment: std.mem.Alignment) ?[*]u8 {
    if (byte_count == 0) return null;

    const raw_alignment = alignment.max(std.mem.Alignment.of(core.AllocationHeader));
    const header_size = @sizeOf(core.AllocationHeader);
    const total_size = std.math.add(usize, byte_count, header_size + alignment.toByteUnits() - 1) catch return null;
    const raw_ptr = core.allocator.rawAlloc(total_size, raw_alignment, @returnAddress()) orelse return null;
    const raw_addr = @intFromPtr(raw_ptr);
    const user_addr = alignment.forward(raw_addr + header_size);
    const header_ptr: *core.AllocationHeader = @ptrFromInt(user_addr - header_size);

    header_ptr.* = .{
        .total_size = total_size,
        .base_offset = user_addr - raw_addr,
        .raw_alignment = @as(u32, @intCast(raw_alignment.toByteUnits())),
    };

    return @ptrFromInt(user_addr);
}

fn freeBytes(ptr_value: usize) void {
    if (ptr_value == 0) return;

    const header_ptr: *const core.AllocationHeader = @ptrFromInt(ptr_value - @sizeOf(core.AllocationHeader));
    const raw_addr = ptr_value - header_ptr.base_offset;
    const raw_ptr: [*]u8 = @ptrFromInt(raw_addr);
    const raw_alignment = std.mem.Alignment.fromByteUnits(header_ptr.raw_alignment);
    core.allocator.rawFree(raw_ptr[0..header_ptr.total_size], raw_alignment, @returnAddress());
}

pub export fn malloc(size: usize) usize {
    return @intFromPtr(allocBytes(size, core.default_malloc_alignment) orelse return 0);
}

pub export fn calloc(count: usize, size: usize) usize {
    const total = std.math.mul(usize, count, size) catch return 0;
    const ptr = allocBytes(total, core.default_malloc_alignment) orelse return 0;
    @memset(ptr[0..total], 0);
    return @intFromPtr(ptr);
}

pub export fn free(ptr: usize) void {
    freeBytes(ptr);
}
