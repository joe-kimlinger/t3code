import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { FolderGit2Icon, GitBranchIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import {
  selectThreadRepo,
  type ThreadRepoOption,
  type ThreadRepoSelection,
} from "../../threadRepoSelection";
import { resolveChangesTotals } from "../GitActionsControl.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

/** Every repository a multi-folder thread works in, with the one its git controls act on selected. */
export function ThreadRepositoriesSection({
  environmentId,
  threadRef,
  selection,
  separated,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  selection: ThreadRepoSelection;
  separated: boolean;
}) {
  const gt = useGT();
  if (selection.options.length < 2) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-repositories-heading"
      title={gt("Repositories")}
      separated={separated}
    >
      <div className="flex flex-col gap-0.5">
        {selection.options.map((option) => (
          <ThreadRepositoryRow
            key={option.root ?? ""}
            environmentId={environmentId}
            option={option}
            selected={selection.selected?.root === option.root}
            onSelect={() => selectThreadRepo(threadRef, option.root)}
          />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function ThreadRepositoryRow({
  environmentId,
  option,
  selected,
  onSelect,
}: {
  environmentId: EnvironmentId;
  option: ThreadRepoOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const gt = useGT();
  // The same query the git controls use, so the selected repository shares one subscription.
  const status = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: option.cwd } }),
  ).data;
  const isRepo = status?.isRepo ?? true;
  const branch = option.branch ?? (isRepo ? (status?.refName ?? null) : gt("Not a git repository"));
  const totals = isRepo ? resolveChangesTotals(status) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            type="button"
            variant="ghost"
            size="sm"
            part="row"
            multiline
            tone={selected ? "primary" : "default"}
            aria-pressed={selected}
            onClick={onSelect}
          />
        }
      >
        <FolderGit2Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate">{option.name}</span>
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              {option.root === null
                ? option.kind === "worktree"
                  ? gt("main · worktree")
                  : gt("main · folder")
                : option.kind === "worktree"
                  ? gt("worktree")
                  : gt("folder")}
            </span>
          </span>
          {branch !== null ? (
            <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
              <GitBranchIcon className="size-3 shrink-0" aria-hidden />
              <span className="truncate font-mono">{branch}</span>
            </span>
          ) : null}
        </span>
        {totals ? (
          <span className="flex shrink-0 items-baseline gap-2 self-center ps-2 font-mono text-xs tabular-nums">
            <span
              className={
                totals.insertions ? "text-diff-addition-foreground" : "text-muted-foreground"
              }
            >
              +{formatDiffCount(totals.insertions)}
            </span>
            <span
              className={
                totals.deletions ? "text-diff-deletion-foreground" : "text-muted-foreground"
              }
            >
              -{formatDiffCount(totals.deletions)}
            </span>
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="left" className="max-w-96 break-all">
        {option.cwd}
      </TooltipPopup>
    </Tooltip>
  );
}
