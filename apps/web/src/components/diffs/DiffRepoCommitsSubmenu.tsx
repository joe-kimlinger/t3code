import type { EnvironmentId } from "@t3tools/contracts";
import { T, useMessages } from "gt-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/menu";

/** Commits of a repository the diff panel isn't showing; they load only when the submenu opens. */
export function DiffRepoCommitsSubmenu({
  environmentId,
  cwd,
  onSelectCommit,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  onSelectCommit: (sha: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenuSub onOpenChange={setOpen}>
      <DropdownMenuSubTrigger>
        <T>Commits</T>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 max-w-96">
        {open ? (
          <DiffRepoCommitItems
            environmentId={environmentId}
            cwd={cwd}
            onSelectCommit={onSelectCommit}
          />
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function DiffRepoCommitItems({
  environmentId,
  cwd,
  onSelectCommit,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  onSelectCommit: (sha: string) => void;
}) {
  const messages = useMessages();
  const commitsQuery = useEnvironmentQuery(
    reviewEnvironment.branchCommits({ environmentId, input: { cwd } }),
    messages,
  );
  const commits = commitsQuery.data?.commits;
  if (commitsQuery.error) {
    return <DropdownMenuItem disabled>{commitsQuery.error}</DropdownMenuItem>;
  }
  if (commits === undefined) {
    return (
      <DropdownMenuItem disabled>
        <T>Loading commits...</T>
      </DropdownMenuItem>
    );
  }
  if (commits.length === 0) {
    return (
      <DropdownMenuItem disabled>
        <T>No commits on this branch.</T>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuRadioGroup
      value=""
      onValueChange={(value) => {
        if (typeof value === "string") onSelectCommit(value);
      }}
    >
      {commits.map((commit) => (
        <DropdownMenuRadioItem key={commit.sha} value={commit.sha} closeOnClick>
          <span className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {commit.sha.slice(0, 7)}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatRelativeTimeLabel(commit.committedAt, undefined, messages)}
            </span>
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
