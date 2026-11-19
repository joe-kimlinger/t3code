import { FolderGit2Icon } from "lucide-react";
import { useGT } from "gt-react";

import { useThreadRepoSelectionStore, type ThreadRepoSelection } from "../threadRepoSelection";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

/** Picks which of a multi-folder project's repositories the thread's git controls act on. */
export function RepoSwitcher({
  threadKey,
  selection,
}: {
  threadKey: string | null;
  selection: ThreadRepoSelection;
}) {
  const gt = useGT();
  const select = useThreadRepoSelectionStore((state) => state.select);
  if (threadKey === null || selection.options.length < 2 || selection.selected === null) {
    return null;
  }
  const value = selection.selected.root ?? "";
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        select(threadKey, next === "" ? null : next);
      }}
    >
      <SelectTrigger size="xs" aria-label={gt("Repository")}>
        <FolderGit2Icon aria-hidden />
        <SelectValue>{selection.selected.name}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {selection.options.map((option) => (
          <SelectItem key={option.root ?? ""} hideIndicator value={option.root ?? ""}>
            {option.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
