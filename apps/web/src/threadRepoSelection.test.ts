import { describe, expect, it } from "vite-plus/test";

import { resolveThreadRepoSelection } from "./threadRepoSelection";

const project = { workspaceRoot: "/work/app", additionalRoots: ["/work/api", "/work/docs"] };

describe("resolveThreadRepoSelection", () => {
  it("marks recorded linked worktrees with their branch and plain folders without one", () => {
    const selection = resolveThreadRepoSelection({
      primaryCwd: "/worktrees/app/feature",
      project,
      thread: {
        worktreePath: "/worktrees/app/feature",
        branch: "feature",
        linkedWorktrees: [
          { root: "/work/api", worktreePath: "/worktrees/api/feature", branch: "feature" },
        ],
      },
      selectedRoot: "/work/api",
    });
    expect(
      selection.options.map(({ name, cwd, kind, branch }) => [name, cwd, kind, branch]),
    ).toEqual([
      ["app", "/worktrees/app/feature", "worktree", "feature"],
      ["api", "/worktrees/api/feature", "worktree", "feature"],
      ["docs", "/work/docs", "folder", null],
    ]);
    expect(selection.selected?.name).toBe("api");
  });

  it("falls back to the main folder when the selected folder was unlinked", () => {
    const selection = resolveThreadRepoSelection({
      primaryCwd: "/work/app",
      project: { workspaceRoot: "/work/app", additionalRoots: [] },
      thread: { worktreePath: null },
      selectedRoot: "/work/api",
    });
    expect(selection.options).toHaveLength(1);
    expect(selection.selected).toMatchObject({ root: null, kind: "folder", branch: null });
  });
});
