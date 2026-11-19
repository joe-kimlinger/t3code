import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
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
  it("nests children under listed parents and leaves the rest top level", () => {
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
    expect(arrangement.parentKeyOf(key("elsewhere"))).toBeNull();
    const roots = threads.filter((t) => arrangement.parentKeyOf(key(t.id)) === null);
    const rows = flattenArrangedThreads(roots, arrangement, () => false);
    expect(rows.map((row) => [row.thread.id, row.depth, row.childCount])).toEqual([
      ["root", 0, 1],
      ["child", 1, 1],
      ["grandchild", 2, 0],
      ["orphan", 0, 0],
      ["elsewhere", 0, 0],
    ]);
    expect(ids(flattenArrangedThreads(roots, arrangement, (k) => k === key("child")))).toEqual([
      "root",
      "child",
      "orphan",
      "elsewhere",
    ]);
    expect(arrangedDescendants(key("root"), arrangement).map((t) => t.id)).toEqual([
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

  it("offers parents in the same project, never the thread or its descendants", () => {
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
    ).toEqual(["root", "sibling"]);
  });
});
