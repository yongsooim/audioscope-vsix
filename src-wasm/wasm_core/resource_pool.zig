const core = @import("./core.zig");

/// Walk a singly-linked resource list, dispose each node, then null the head.
/// Each resource type must define `pub fn deinit(self: *Self) void` and
/// `next: ?*Self`.
pub fn disposeAll(comptime T: type, head_ptr: *?*T) void {
    var current = head_ptr.*;
    while (current) |node| {
        const next = node.next;
        node.deinit();
        core.allocator.destroy(node);
        current = next;
    }
    head_ptr.* = null;
}
