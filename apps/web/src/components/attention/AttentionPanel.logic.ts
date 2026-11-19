import type { AttentionServerState } from "@t3tools/client-runtime/state/attention";
import type { AttentionCandidate } from "@t3tools/client-runtime/state/attention-ranking";
import {
  arrangeThreads,
  arrangedDescendants,
  arrangedThreadKey,
} from "@t3tools/client-runtime/state/thread-arrangement";
import {
  effectiveSnoozed,
  isThreadWokeUnseen,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  isListedThreadLineage,
  type AttentionItem,
  type AttentionItemFeatures,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { SidebarThreadSummary } from "../../types";
import { hasUnseenCompletion, resolveSidebarRowStatus } from "../Sidebar.logic";

export type AttentionPayload =
  | {
      readonly type: "thread";
      readonly environmentId: EnvironmentId;
      readonly shell: SidebarThreadSummary;
      /** Changes whenever what the thread needs changes; keys the ask query. */
      readonly askKey: string;
    }
  | {
      readonly type: "item";
      readonly environmentId: EnvironmentId;
      readonly item: AttentionItem;
    };

export type AttentionEntry = AttentionCandidate<AttentionPayload>;

export interface RunningEntry {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly shell: SidebarThreadSummary;
  readonly since: string;
  readonly blockedOnWait: boolean;
}

export interface LaterEntry {
  readonly entry: AttentionEntry;
  readonly wakeAt: string;
}

const threadAttentionId = (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) =>
  `thread:${arrangedThreadKey(thread)}`;
export const itemAttentionId = (environmentId: EnvironmentId, itemId: string) =>
  `item:${environmentId}:${itemId}`;
/** A dismissal holds until the item changes kind or updates. */
export const itemVersion = (item: Pick<AttentionItem, "kind" | "updatedAt">) =>
  `${item.kind}@${item.updatedAt}`;

type ThreadNeed =
  | { readonly type: "need"; readonly kind: string; readonly since: string }
  | { readonly type: "running"; readonly since: string; readonly blockedOnWait: boolean }
  | null;

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

/**
 * What a thread needs from the user, from the same status the sidebar row shows. Plans, wakes and
 * unread completions only count once the run has settled to ready.
 */
function threadNeed(thread: SidebarThreadSummary, nowIso: string): ThreadNeed {
  const status = resolveSidebarRowStatus(thread);
  const run = thread.latestRun;
  const runEndedAt = run?.completedAt ?? thread.runtime?.updatedAt ?? thread.updatedAt;
  const requestAt =
    thread.source.pendingRuntimeRequest === null
      ? (thread.pendingUserInputAt ?? thread.updatedAt)
      : iso(thread.source.pendingRuntimeRequest.createdAt);
  switch (status) {
    case "approval":
    case "input":
      return { type: "need", kind: status, since: requestAt };
    case "request":
      return { type: "need", kind: "request", since: thread.updatedAt };
    case "failed":
    case "limited":
      return { type: "need", kind: status, since: runEndedAt };
    case "preparing":
    case "working":
    case "waiting":
      return {
        type: "running",
        since: thread.runtime?.activityStartedAt ?? run?.startedAt ?? thread.updatedAt,
        blockedOnWait: thread.blockedOnThreadWait === true,
      };
    case "ready":
      break;
  }
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) {
    return { type: "need", kind: "plan", since: runEndedAt };
  }
  const wokeAt = threadWokeAt(thread, { now: nowIso });
  if (
    wokeAt !== null &&
    isThreadWokeUnseen({
      wokeAt,
      settled: thread.settledOverride === "settled",
      lastVisitedAt: thread.lastVisitedAt,
      latestRunCompletedAt: run?.completedAt ?? null,
    })
  ) {
    return { type: "need", kind: "woke", since: wokeAt };
  }
  if (hasUnseenCompletion(thread)) return { type: "need", kind: "completed", since: runEndedAt };
  return null;
}

const BLOCKING_KINDS = new Set(["approval", "input", "request"]);

export interface AttentionDerivation {
  readonly candidates: ReadonlyArray<AttentionEntry>;
  readonly running: ReadonlyArray<RunningEntry>;
  readonly later: ReadonlyArray<LaterEntry>;
  /** The thread tree an entry belongs to, for rollups. */
  readonly rootOf: (entry: AttentionEntry) => {
    readonly key: string;
    readonly descendantCount: number;
  } | null;
}

/** Thread entries from shells already in memory, plus every environment's server items. */
export function deriveAttention(input: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly projectTitle: (environmentId: EnvironmentId, projectId: string) => string | null;
  readonly servers: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly state: AttentionServerState;
  }>;
  readonly nowMs: number;
}): AttentionDerivation {
  const nowIso = new Date(input.nowMs).toISOString();
  const listed = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      isListedThreadLineage(thread.lineage),
  );
  const arrangement = arrangeThreads(listed);
  const candidates: AttentionEntry[] = [];
  const running: RunningEntry[] = [];
  const later: LaterEntry[] = [];

  for (const thread of listed) {
    const need = threadNeed(thread, nowIso);
    if (need === null) continue;
    if (need.type === "running") {
      running.push({
        id: threadAttentionId(thread),
        environmentId: thread.environmentId,
        shell: thread,
        since: need.since,
        blockedOnWait: need.blockedOnWait,
      });
      continue;
    }
    // A settled thread only comes back when its agent is blocked on the user.
    if (thread.settledOverride === "settled" && !BLOCKING_KINDS.has(need.kind)) continue;
    const entry: AttentionEntry = {
      id: threadAttentionId(thread),
      source: "thread",
      kind: need.kind,
      since: need.since,
      repo: null,
      author: null,
      project: input.projectTitle(thread.environmentId, thread.projectId),
      payload: {
        type: "thread",
        environmentId: thread.environmentId,
        shell: thread,
        askKey: [
          need.kind,
          thread.source.pendingRuntimeRequest?.id ?? "",
          thread.source.latestRunId ?? "",
          thread.latestRun?.completedAt ?? "",
        ].join(":"),
      },
    };
    if (effectiveSnoozed(thread, { now: nowIso }) && thread.snoozedUntil !== null) {
      later.push({ entry, wakeAt: thread.snoozedUntil });
    } else {
      candidates.push(entry);
    }
  }

  for (const { environmentId, state } of input.servers) {
    for (const item of state.items.values()) {
      const itemState = state.itemStates.get(item.id);
      if (itemState?.dismissedVersion === itemVersion(item)) continue;
      const entry: AttentionEntry = {
        id: itemAttentionId(environmentId, item.id),
        source: item.source,
        kind: item.kind,
        since: item.updatedAt,
        repo: item.repo,
        author: item.author,
        project: item.projectId === null ? null : input.projectTitle(environmentId, item.projectId),
        payload: { type: "item", environmentId, item },
      };
      const snoozedUntil = itemState?.snoozedUntil ?? null;
      if (snoozedUntil !== null && Date.parse(snoozedUntil) > input.nowMs) {
        later.push({ entry, wakeAt: snoozedUntil });
      } else {
        candidates.push(entry);
      }
    }
  }

  const rootKeyOf = (key: string) => {
    let current = key;
    for (let parent = arrangement.parentKeyOf(current); parent !== null;) {
      current = parent;
      parent = arrangement.parentKeyOf(current);
    }
    return current;
  };
  return {
    candidates,
    running: running.toSorted((left, right) => left.since.localeCompare(right.since)),
    later: later.toSorted((left, right) => left.wakeAt.localeCompare(right.wakeAt)),
    rootOf: (entry) => {
      if (entry.payload.type !== "thread") return null;
      const rootKey = rootKeyOf(arrangedThreadKey(entry.payload.shell));
      return {
        key: `thread:${rootKey}`,
        descendantCount: arrangedDescendants(rootKey, arrangement).length,
      };
    },
  };
}

/** What the decision log keeps about an entry. */
export function attentionFeaturesOf(entry: AttentionEntry): AttentionItemFeatures {
  return {
    itemId: entry.payload.type === "thread" ? entry.payload.shell.id : entry.payload.item.id,
    source: entry.source,
    kind: entry.kind,
    repo: entry.repo,
    author: entry.author,
    project: entry.project,
    itemCreatedAt: entry.since,
  };
}

/** Prefill for "Hand to agent". The agent reads it, so it stays in English like other prompts. */
export function handToAgentPrompt(item: AttentionItem): string {
  const reference = item.url ?? item.detail;
  switch (item.kind) {
    case "review_requested":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- a prompt the agent reads
      return `Review pull request ${reference} ("${item.title}"). Summarize the change, flag risks, and draft review comments for me to approve.`;
    case "changes_requested":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- a prompt the agent reads
      return `Address the review comments on pull request ${reference} ("${item.title}"). Read every unresolved thread, make the changes, and push them.`;
    case "ci_failing":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- a prompt the agent reads
      return `CI is failing on pull request ${reference} ("${item.title}"). Find the failing checks, fix the cause, and push the fix.`;
    case "ready_to_merge":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- a prompt the agent reads
      return `Pull request ${reference} ("${item.title}") is approved. Check it is still up to date with its base and ready to merge, and tell me if anything blocks it.`;
    default:
      // oxlint-disable-next-line t3code/no-untranslated-copy -- a prompt the agent reads
      return `Look into ${reference} ("${item.title}") and tell me what it needs from me.`;
  }
}
