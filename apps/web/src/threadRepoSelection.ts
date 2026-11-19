import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  folderDisplayName,
  threadLinkedFolders,
  type ScopedThreadRef,
  type ThreadLinkedWorktree,
} from "@t3tools/contracts";
import { create } from "zustand";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";

export interface ThreadRepoOption {
  /** Null for the thread's own checkout. */
  readonly root: string | null;
  readonly cwd: string;
  readonly name: string;
  /** A worktree the thread made, or the folder itself. */
  readonly kind: "worktree" | "folder";
  /** The branch the thread recorded for it; null when only live git status knows it. */
  readonly branch: string | null;
}

export interface ThreadRepoSelection {
  readonly options: ReadonlyArray<ThreadRepoOption>;
  readonly selected: ThreadRepoOption | null;
}

type ThreadRepoProject = {
  readonly workspaceRoot: string;
  readonly additionalRoots?: ReadonlyArray<string> | undefined;
};

type ThreadRepoThread = {
  readonly worktreePath: string | null;
  readonly branch?: string | null | undefined;
  readonly linkedWorktrees?: ReadonlyArray<ThreadLinkedWorktree> | undefined;
};

/** A selection for a folder the project no longer links falls back to the thread's own checkout. */
export function resolveThreadRepoSelection(input: {
  readonly primaryCwd: string | null;
  readonly project: ThreadRepoProject | null | undefined;
  readonly thread: ThreadRepoThread | null | undefined;
  readonly selectedRoot: string | null | undefined;
}): ThreadRepoSelection {
  if (input.primaryCwd === null) return { options: [], selected: null };
  const thread = input.thread;
  const primary: ThreadRepoOption = {
    root: null,
    cwd: input.primaryCwd,
    name: input.project ? folderDisplayName(input.project.workspaceRoot) : "",
    kind: thread?.worktreePath ? "worktree" : "folder",
    branch: thread?.branch ?? null,
  };
  const linked = input.project ? threadLinkedFolders(input.project, thread) : [];
  const options = [
    primary,
    ...linked.map((folder): ThreadRepoOption => {
      const worktree =
        folder.path === folder.root
          ? undefined
          : thread?.linkedWorktrees?.find((entry) => entry.root === folder.root);
      return {
        root: folder.root,
        cwd: folder.path,
        name: folder.name,
        kind: worktree ? "worktree" : "folder",
        branch: worktree?.branch ?? null,
      };
    }),
  ];
  return {
    options,
    selected: options.find((option) => option.root === (input.selectedRoot ?? null)) ?? primary,
  };
}

interface ThreadRepoSelectionStore {
  readonly selectedRootByThreadKey: Readonly<Record<string, string>>;
  readonly select: (threadKey: string, root: string | null) => void;
}

/** Session-only: which repo a thread's git surfaces show. */
const useThreadRepoSelectionStore = create<ThreadRepoSelectionStore>()((set) => ({
  selectedRootByThreadKey: {},
  select: (threadKey, root) =>
    set((state) => {
      const next = { ...state.selectedRootByThreadKey };
      if (root === null) delete next[threadKey];
      else next[threadKey] = root;
      return { selectedRootByThreadKey: next };
    }),
}));

/** A commit belongs to one repository, so switching repositories falls back to its changes. */
export function selectThreadRepo(threadRef: ScopedThreadRef, root: string | null) {
  const threadKey = scopedThreadKey(threadRef);
  if (
    (useThreadRepoSelectionStore.getState().selectedRootByThreadKey[threadKey] ?? null) === root
  ) {
    return;
  }
  useThreadRepoSelectionStore.getState().select(threadKey, root);
  const diffPanel = useDiffPanelStore.getState();
  if (selectThreadDiffPanelSelection(diffPanel.byThreadKey, threadRef).kind === "commit") {
    diffPanel.selectGitScope(threadRef, "branch");
  }
}

export function useThreadRepoSelection(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly project: ThreadRepoProject | null | undefined;
  readonly thread: ThreadRepoThread | null | undefined;
  readonly primaryCwd: string | null;
}): ThreadRepoSelection {
  const threadKey = input.threadRef ? scopedThreadKey(input.threadRef) : null;
  const selectedRoot = useThreadRepoSelectionStore((state) =>
    threadKey === null ? undefined : state.selectedRootByThreadKey[threadKey],
  );
  return resolveThreadRepoSelection({
    primaryCwd: input.primaryCwd,
    project: input.project,
    thread: input.thread,
    selectedRoot,
  });
}
