import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { folderDisplayName } from "@t3tools/contracts";
import { FolderOpenIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT } from "gt-react";

import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useServerConfigs } from "../../state/entities";
import { getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const MAX_SUGGESTIONS = 6;

/** Linked folders are paths on one machine, so each checkout keeps its own list. */
export function ProjectLinkedFoldersSettings({
  members,
  editableIds,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
  editableIds: ReadonlySet<string>;
}) {
  const gt = useGT();
  return (
    <SettingsSection title={gt("Linked folders")}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          Agents in every thread of this project can read, edit and run commands in linked folders.
          Worktree threads get a worktree on the same branch in each linked git repository. Removing
          a folder never deletes files. Turn checkpoints and revert cover only the main folder.
        </T>
      </p>
      {members.map((member) => (
        <MemberLinkedFolders
          key={member.physicalProjectKey}
          member={member}
          canEdit={editableIds.has(member.environmentId)}
          showEnvironment={members.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function MemberLinkedFolders({
  member,
  canEdit,
  showEnvironment,
}: {
  member: SidebarProjectGroupMember;
  canEdit: boolean;
  showEnvironment: boolean;
}) {
  const gt = useGT();
  const { updateProjectGroup } = useProjectGroupUpdate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const roots = member.additionalRoots ?? [];

  const platform = getEnvironmentBrowsePlatform(
    serverConfigs.get(member.environmentId)?.environment.platform.os,
  );
  const browsePath = getFilesystemBrowsePath(draft, platform, canEdit);
  const browseAccess = useFilesystemReadAccess(member.environmentId);
  const browseQuery = useEnvironmentQuery(
    browseAccess.canReadFiles && browsePath.isBrowsing && browsePath.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId: member.environmentId,
          input: { partialPath: browsePath.directoryPath, cwd: member.workspaceRoot },
        })
      : null,
  );
  const suggestions = browseQuery.data
    ? filterFilesystemBrowseEntries(browseQuery.data.entries, browsePath.filterQuery)
        .visibleEntries.filter((entry) => entry.fullPath !== draft)
        .slice(0, MAX_SUGGESTIONS)
    : [];

  const save = async (next: ReadonlyArray<string>, failureTitle: string) => {
    setSaving(true);
    const result = await updateProjectGroup([member], { additionalRoots: next }, failureTitle);
    setSaving(false);
    return result._tag === "Success";
  };
  const add = async (path: string) => {
    const trimmed = path.trim();
    if (trimmed === "" || roots.includes(trimmed)) return;
    if (await save([...roots, trimmed], gt("Failed to link folder"))) setDraft("");
  };
  // Native pickers browse this device, so they only fit the device's own environment.
  const pickFolder =
    member.environmentId === primaryEnvironmentId && typeof window !== "undefined"
      ? window.desktopBridge?.pickFolder
      : undefined;

  return (
    <SettingsRow
      title={showEnvironment ? (member.environmentLabel ?? gt("Environment")) : gt("Folders")}
      description={member.workspaceRoot}
    >
      <div className="space-y-2 pb-2 pt-1">
        {roots.map((root) => (
          <div key={root} className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-medium">{folderDisplayName(root)}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{root}</span>
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              disabled={!canEdit || saving}
              aria-label={gt("Unlink folder {path}", { path: root })}
              onClick={() =>
                void save(
                  roots.filter((candidate) => candidate !== root),
                  gt("Failed to unlink folder"),
                )
              }
            >
              <XIcon />
            </Button>
          </div>
        ))}
        {canEdit ? (
          <form
            className="flex min-w-0 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void add(draft);
            }}
          >
            <Input
              size="sm"
              className="min-w-0 flex-1"
              value={draft}
              placeholder={gt("Absolute folder path")}
              aria-label={gt("Folder to link")}
              disabled={saving}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            {pickFolder ? (
              <Button
                size="icon-sm"
                variant="outline"
                type="button"
                disabled={saving}
                aria-label={gt("Choose a folder to link")}
                onClick={async () => {
                  const picked = await readLocalApi()
                    ?.dialogs.pickFolder({ initialPath: member.workspaceRoot })
                    .catch(() => null);
                  if (picked) await add(picked);
                }}
              >
                <FolderOpenIcon />
              </Button>
            ) : null}
            <Button size="sm" variant="outline" type="submit" disabled={saving || draft === ""}>
              <T>Link</T>
            </Button>
          </form>
        ) : null}
        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {suggestions.map((entry) => (
              <Button
                key={entry.fullPath}
                size="compact"
                variant="ghost-muted"
                type="button"
                onClick={() => setDraft(entry.fullPath)}
              >
                {entry.name}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}
