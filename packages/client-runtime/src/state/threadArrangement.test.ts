import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  arrangeThreadsKeepingUnparked,
  arrangeParentCandidates,
  arrangeThreads,
  arrangedDescendants,
  flattenArrangedThreads,
} from "./threadArrangement.ts";

const environmentId = EnvironmentId.make("env");
const thread = (
  id: string,
  parent: string | null = null,
  options: { orderKey?: string; createdAt?: string; projectId?: string } = {},
) => ({
  environmentId,
  id: ThreadId.make(id),
  projectId: ProjectId.make(options.projectId ?? "project"),
  createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
  arrangedParentThreadId: parent === null ? null : ThreadId.make(parent),
  arrangedOrderKey: options.orderKey ?? null,
});
const key = (id: string) => `env:${id}`;
const ids = (rows: ReadonlyArray<{ readonly thread: { readonly id: string } }>) =>
  rows.map((row) => row.thread.id);

describe("arrangeThreads", () => {
  it("nests children under listed parents, across projects, and leaves the rest top level", () => {
    const threads = [
      thread("root"),
      thread("child", "root"),
      thread("grandchild", "child"),
      thread("orphan", "archived-parent"),
      thread("elsewhere", "root", { projectId: "other" }),
    ];
    const arrangement = arrangeThreads(threads);
    expect(arrangement.parentKeyOf(key("grandchild"))).toBe(key("child"));
    expect(arrangement.parentKeyOf(key("orphan"))).toBeNull();
    expect(arrangement.parentKeyOf(key("elsewhere"))).toBe(key("root"));
    const roots = threads.filter((t) => arrangement.parentKeyOf(key(t.id)) === null);
    const rows = flattenArrangedThreads(roots, arrangement, () => false);
    expect(rows.map((row) => [row.thread.id, row.depth, row.childCount])).toEqual([
      ["root", 0, 2],
      ["child", 1, 1],
      ["grandchild", 2, 0],
      ["elsewhere", 1, 0],
      ["orphan", 0, 0],
    ]);
    expect(ids(flattenArrangedThreads(roots, arrangement, (k) => k === key("child")))).toEqual([
      "root",
      "child",
      "elsewhere",
      "orphan",
    ]);
    expect(arrangedDescendants(key("root"), arrangement).map((t) => t.id)).toEqual([
      "elsewhere",
      "child",
      "grandchild",
    ]);
  });

  it("cuts a cycle left by racing moves so every thread still renders once", () => {
    const threads = [thread("a", "c"), thread("b", "a"), thread("c", "b")];
    const arrangement = arrangeThreads(threads);
    const roots = threads.filter((t) => arrangement.parentKeyOf(key(t.id)) === null);
    expect(roots).toHaveLength(1);
    expect(flattenArrangedThreads(roots, arrangement, () => false)).toHaveLength(3);
  });

  it("orders siblings by order key, then newest first", () => {
    const arrangement = arrangeThreads([
      thread("parent"),
      thread("old", "parent", { createdAt: "2026-01-01T00:00:00.000Z" }),
      thread("new", "parent", { createdAt: "2026-02-01T00:00:00.000Z" }),
      thread("keyed-b", "parent", { orderKey: "b" }),
      thread("keyed-a", "parent", { orderKey: "a" }),
    ]);
    expect(arrangement.childrenOf(key("parent")).map((t) => t.id)).toEqual([
      "keyed-a",
      "keyed-b",
      "new",
      "old",
    ]);
  });

  it("offers parents in any project, never the thread or its descendants", () => {
    const threads = [
      thread("root"),
      thread("moving", "root"),
      thread("under-moving", "moving"),
      thread("sibling", "root"),
      thread("elsewhere", null, { projectId: "other" }),
    ];
    const moving = threads[1]!;
    expect(
      arrangeParentCandidates(moving, threads, arrangeThreads(threads)).map((t) => t.id),
    ).toEqual(["root", "sibling", "elsewhere"]);
  });

  it("keeps a thread that needs the user out of a parked parent's shelf, with its own nested threads", () => {
    const threads = [
      thread("settled-root"),
      thread("settled-child", "settled-root"),
      thread("working-child", "settled-root"),
      thread("under-working", "working-child"),
      thread("active-root"),
      thread("active-child", "active-root"),
    ];
    const parked = new Set(["settled-root", "settled-child", "under-working"]);
    const arrangement = arrangeThreadsKeepingUnparked(threads, (t) => parked.has(t.id));
    expect(arrangement.parentKeyOf(key("settled-child"))).toBe(key("settled-root"));
    expect(arrangement.parentKeyOf(key("working-child"))).toBeNull();
    expect(arrangement.childrenOf(key("settled-root")).map((t) => t.id)).toEqual(["settled-child"]);
    // Its own nested threads follow it, parked or not.
    expect(arrangement.parentKeyOf(key("under-working"))).toBe(key("working-child"));
    // Under an unparked root, a parked child still follows its parent.
    expect(
      arrangeThreadsKeepingUnparked(threads, (t) => t.id === "active-child").parentKeyOf(
        key("active-child"),
      ),
    ).toBe(key("active-root"));
  });
});
