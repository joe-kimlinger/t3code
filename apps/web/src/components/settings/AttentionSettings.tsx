import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_ATTENTION_NOW_LIMIT,
  type AttentionSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { attentionEnvironment } from "../../state/attention";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsSection, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const NOW_LIMITS = [3, 5, 8, 12] as const;

const GITHUB_KINDS = [
  "githubReviewRequested",
  "githubFailingCi",
  "githubChangesRequested",
  "githubReadyToMerge",
] as const satisfies ReadonlyArray<keyof AttentionSettings>;

/** Settings for the attention panel docked at the bottom of the sidebar. */
export function AttentionSettingsSection() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const attention = settings.attention;
  const patchAttention = (patch: Partial<AttentionSettings>) =>
    updateSettings({ attention: patch });
  const kindLabels: Record<(typeof GITHUB_KINDS)[number], string> = {
    githubReviewRequested: gt("Review requested from you"),
    githubFailingCi: gt("Your pull requests with failing CI"),
    githubChangesRequested: gt("Changes requested on your pull requests"),
    githubReadyToMerge: gt("Your pull requests approved and ready to merge"),
  };

  return (
    <SettingsSection id="attention" title={gt("Attention panel")}>
      <SettingsRow
        {...setting("attention-now-limit")}
        description={
          <T>
            How many items Now shows before the rest fold under "more". Toggle the panel with its
            shortcut or the command palette.
          </T>
        }
        control={
          <Select
            value={String(settings.attentionNowLimit)}
            onValueChange={(value) => updateSettings({ attentionNowLimit: Number(value) })}
          >
            <SelectTrigger aria-label={gt("Items in Now")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {[
                ...new Set([
                  ...NOW_LIMITS,
                  settings.attentionNowLimit,
                  DEFAULT_ATTENTION_NOW_LIMIT,
                ]),
              ]
                .toSorted((left, right) => left - right)
                .map((limit) => (
                  <SelectItem hideIndicator key={limit} value={String(limit)}>
                    {String(limit)}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["attention"]}
        {...setting("attention-github")}
        description={
          <T>
            Watch open pull requests on this environment's project repositories, using its GitHub
            sign-in. Checked every few minutes while the panel is open.
          </T>
        }
        control={
          <ScopedSwitch
            settingKeys={["attention"]}
            checked={attention.githubEnabled}
            onCheckedChange={(checked) => patchAttention({ githubEnabled: Boolean(checked) })}
            aria-label={gt("Pull requests in the attention panel")}
          />
        }
      />
      {attention.githubEnabled
        ? GITHUB_KINDS.map((key) => (
            <SettingsRow
              key={key}
              serverScoped
              settingKeys={["attention"]}
              title={kindLabels[key]}
              control={
                <ScopedSwitch
                  settingKeys={["attention"]}
                  checked={attention[key]}
                  onCheckedChange={(checked) => patchAttention({ [key]: Boolean(checked) })}
                  aria-label={kindLabels[key]}
                />
              }
            />
          ))
        : null}
      <SettingsRow
        serverScoped
        settingKeys={["attention"]}
        {...setting("attention-summaries")}
        description={
          <T>
            When a thread finishes without a question or error, write its one-line ask with the text
            generation model. Saved per run, so each is written once.
          </T>
        }
        control={
          <ScopedSwitch
            settingKeys={["attention"]}
            checked={attention.completionSummaries}
            onCheckedChange={(checked) => patchAttention({ completionSummaries: Boolean(checked) })}
            aria-label={gt("Summarize finished threads")}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["attention"]}
        {...setting("attention-rerank")}
        description={
          <T>
            Experimental. Reorders Now with the text generation model, reading your preferences file
            and recent decisions. Each new set of items costs one request.
          </T>
        }
        control={
          <ScopedSwitch
            settingKeys={["attention"]}
            checked={attention.llmRerank}
            onCheckedChange={(checked) => patchAttention({ llmRerank: Boolean(checked) })}
            aria-label={gt("AI re-ranking")}
          />
        }
      />
      {environment ? (
        <AttentionPreferencesEditor
          environmentId={environment.environmentId}
          {...setting("attention-preferences")}
        />
      ) : null}
    </SettingsSection>
  );
}

function AttentionPreferencesEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
}) {
  const gt = useGT();
  const file = useAtomValue(
    attentionEnvironment.preferencesFile({ environmentId: props.environmentId, input: {} }),
  );
  const loaded = AsyncResult.getOrElse(file, () => null);
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const writePreferences = useAtomCommand(attentionEnvironment.writePreferences);
  const resetLearning = useAtomCommand(attentionEnvironment.resetLearning);
  // A draft is kept only while the file under it is unchanged.
  const editing = draft !== null && loaded !== null && draft.base === loaded.text ? draft : null;
  const text = editing?.text ?? loaded?.text ?? "";

  const save = async () => {
    if (editing === null) return;
    const result = await writePreferences({
      environmentId: props.environmentId,
      input: { text: editing.text },
    });
    if (result._tag === "Success") {
      setDraft(null);
      toastManager.add({ type: "success", title: gt("Preferences saved") });
    }
  };
  const reset = async () => {
    const api = readLocalApi();
    const confirmed = api
      ? await api.dialogs.confirm(
          gt("Forget every decision the attention panel learned from on this environment?"),
        )
      : window.confirm(
          gt("Forget every decision the attention panel learned from on this environment?"),
        );
    if (!confirmed) return;
    const result = await resetLearning({ environmentId: props.environmentId, input: {} });
    if (result._tag === "Success")
      toastManager.add({ type: "success", title: gt("Learning reset") });
  };

  return (
    <SettingsRow
      id={props.id}
      title={props.title}
      description={
        <span className="flex flex-col gap-2">
          <span>
            <T>
              Rules, mutes and weights in a file on this environment. Edits here or in any editor
              apply at once. "Not important" and "More like this" add lines.
            </T>
          </span>
          {loaded ? <code className="text-xs break-all">{loaded.path}</code> : null}
          <Textarea
            value={text}
            rows={14}
            spellCheck={false}
            aria-label={gt("Attention preferences file")}
            onChange={(event) =>
              setDraft({ base: loaded?.text ?? "", text: event.currentTarget.value })
            }
          />
          <span className="flex flex-wrap gap-2">
            <Button size="sm" disabled={editing === null} onClick={() => void save()}>
              <T>Save preferences</T>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={editing === null}
              onClick={() => setDraft(null)}
            >
              <T>Discard changes</T>
            </Button>
            <Button size="sm" variant="destructive-outline" onClick={() => void reset()}>
              <T>Reset learning</T>
            </Button>
          </span>
        </span>
      }
    />
  );
}
