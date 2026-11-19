import {
  folderDisplayName,
  threadLinkedFolders,
  type ThreadLinkedFolder,
} from "@t3tools/contracts";
import { create } from "zustand";

export interface ThreadRepoOption {
  /** Null for the thread's own checkout. */
  readonly root: string | null;
  readonly cwd: string;
  readonly name: string;
}

export interface ThreadRepoSelection {
  readonly options: ReadonlyArray<ThreadRepoOption>;
  readonly selected: ThreadRepoOption | null;
}

/** A selection for a folder the project no longer links falls back to the thread's own checkout. */
function resolveThreadRepoSelection(input: {
  readonly primaryCwd: string | null;
  readonly primaryName: string;
  readonly linkedFolders: ReadonlyArray<ThreadLinkedFolder>;
  readonly selectedRoot: string | null | undefined;
}): ThreadRepoSelection {
  if (input.primaryCwd === null) return { options: [], selected: null };
  const primary: ThreadRepoOption = { root: null, cwd: input.primaryCwd, name: input.primaryName };
  const options = [
    primary,
    ...input.linkedFolders.map((folder) => ({
      root: folder.root,
      cwd: folder.path,
      name: folder.name,
    })),
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
export const useThreadRepoSelectionStore = create<ThreadRepoSelectionStore>()((set) => ({
  selectedRootByThreadKey: {},
  select: (threadKey, root) =>
    set((state) => {
      const next = { ...state.selectedRootByThreadKey };
      if (root === null) delete next[threadKey];
      else next[threadKey] = root;
      return { selectedRootByThreadKey: next };
    }),
}));

export function useThreadRepoSelection(input: {
  readonly threadKey: string | null;
  readonly project:
    | {
        readonly workspaceRoot: string;
        readonly additionalRoots?: ReadonlyArray<string> | undefined;
      }
    | null
    | undefined;
  readonly thread: Parameters<typeof threadLinkedFolders>[1];
  readonly primaryCwd: string | null;
}): ThreadRepoSelection {
  const selectedRoot = useThreadRepoSelectionStore((state) =>
    input.threadKey === null ? undefined : state.selectedRootByThreadKey[input.threadKey],
  );
  return resolveThreadRepoSelection({
    primaryCwd: input.primaryCwd,
    primaryName: input.project ? folderDisplayName(input.project.workspaceRoot) : "",
    linkedFolders: input.project ? threadLinkedFolders(input.project, input.thread) : [],
    selectedRoot,
  });
}
