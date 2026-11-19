import type { ProjectEntry } from "@t3tools/contracts";

export interface LinkedFolderPathResult {
  readonly folder: { readonly path: string; readonly name: string };
  readonly entries: ReadonlyArray<ProjectEntry>;
}

export interface LinkedFolderPathMention {
  /** Absolute, since the agent's cwd is the thread's own checkout, not the linked folder. */
  readonly path: string;
  readonly kind: ProjectEntry["kind"];
  readonly label: string;
  /** Leads with the folder name so linked matches read apart from the thread's own files. */
  readonly description: string;
}

export function joinFolderPath(folder: string, relativePath: string): string {
  const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const base = folder.replace(/[\\/]+$/, "");
  return `${base}${separator}${relativePath.replace(/^[\\/]+/, "").replaceAll("/", separator)}`;
}

export function linkedFolderPathMentions(
  results: ReadonlyArray<LinkedFolderPathResult>,
): ReadonlyArray<LinkedFolderPathMention> {
  return results.flatMap(({ folder, entries }) =>
    entries.map((entry) => {
      const slash = entry.path.lastIndexOf("/");
      const directory = slash < 0 ? "" : entry.path.slice(0, slash);
      return {
        path: joinFolderPath(folder.path, entry.path),
        kind: entry.kind,
        label: entry.path.slice(slash + 1),
        description: directory === "" ? folder.name : `${folder.name}/${directory}`,
      };
    }),
  );
}
