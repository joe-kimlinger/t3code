import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A worktree a thread made in one of its project's linked folders, alongside its own worktree. */
export const ThreadLinkedWorktree = Schema.Struct({
  root: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type ThreadLinkedWorktree = typeof ThreadLinkedWorktree.Type;

export interface ThreadLinkedFolder {
  /** The linked folder as the project records it. */
  readonly root: string;
  /** Where the thread works on it: its linked worktree, or the folder itself. */
  readonly path: string;
  readonly name: string;
}

/** Last path segment for either separator, so clients label server paths from any host. */
export function folderDisplayName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const name = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  return name === "" ? folder : name;
}

/**
 * The linked folders a thread works in. A recorded worktree counts only while the thread still has
 * its own worktree, and folders removed from the project drop out even when a worktree remains.
 */
export function threadLinkedFolders(
  project: { readonly additionalRoots?: ReadonlyArray<string> | undefined },
  thread:
    | {
        readonly worktreePath: string | null;
        readonly linkedWorktrees?: ReadonlyArray<ThreadLinkedWorktree> | undefined;
      }
    | null
    | undefined,
): ReadonlyArray<ThreadLinkedFolder> {
  const roots = project.additionalRoots ?? [];
  if (roots.length === 0) return [];
  const worktrees = thread?.worktreePath == null ? [] : (thread.linkedWorktrees ?? []);
  return roots.map((root) => ({
    root,
    path: worktrees.find((worktree) => worktree.root === root)?.worktreePath ?? root,
    name: folderDisplayName(root),
  }));
}
