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
  effectiveParentThreadId,
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
      /** Server items about this thread's pull requests, folded into its task. */
      readonly items: ReadonlyArray<AttentionItem>;
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
  /** Pull request items this thread's agent is already working on. */
  readonly items: ReadonlyArray<AttentionItem>;
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

const pullRequestKey = (repository: string, number: number) =>
  `${repository.toLowerCase()}#${number}`;

/**
 * Every pull request a thread works on: ones it links, the one it was opened from, and the one
 * its branch has. Agents often open a pull request without linking it, so the branch counts.
 */
export function threadPullRequestRefs(
  thread: SidebarThreadSummary,
): ReadonlyArray<{ readonly repository: string; readonly number: number; readonly url: string }> {
  const refs = new Map<string, { repository: string; number: number; url: string }>();
  for (const ref of [
    ...thread.pullRequests.filter((link) => link.source !== "stack-dismissed"),
    thread.linkedPullRequest,
    thread.branchPullRequest,
  ]) {
    if (ref == null) continue;
    const key = pullRequestKey(ref.repository, ref.number);
    if (!refs.has(key))
      refs.set(key, { repository: ref.repository, number: ref.number, url: ref.url });
  }
  return [...refs.values()];
}

/** Changes when a linked pull request's state does, so the task's summary refreshes. */
function pullRequestFingerprint(thread: SidebarThreadSummary): string {
  return thread.pullRequests
    .map(({ number, snapshot }) =>
      [
        number,
        snapshot?.state,
        snapshot?.checksState,
        snapshot?.reviewDecision,
        snapshot?.mergeability,
      ].join("/"),
    )
    .join(",");
}

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

/**
 * One task per thread from shells already in memory, with server items about its pull requests
 * folded in. Items no listed thread links stand as their own tasks.
 */
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
  // Rolls up by the shared effective parent, so changes to its rules reach the panel too.
  const arrangement = arrangeThreads(
    listed.map((thread) => ({
      ...thread,
      arrangedParentThreadId: effectiveParentThreadId(thread),
    })),
  );
  const candidates: AttentionEntry[] = [];
  const running: RunningEntry[] = [];
  const later: LaterEntry[] = [];

  // A pull request belongs to the most recently active thread working on it, in any connected
  // environment: the alert may come from this machine while the agent runs on another.
  const threadByPullRequest = new Map<string, SidebarThreadSummary>();
  for (const thread of listed.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    for (const ref of threadPullRequestRefs(thread)) {
      threadByPullRequest.set(pullRequestKey(ref.repository, ref.number), thread);
    }
  }
  const itemsByThread = new Map<SidebarThreadSummary, AttentionItem[]>();
  // Every environment watching the same repositories reports the same pull requests.
  const seenItems = new Set<string>();
  for (const { environmentId, state } of input.servers) {
    for (const item of state.items.values()) {
      if (seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      const itemState = state.itemStates.get(item.id);
      if (itemState?.dismissedVersion === itemVersion(item)) continue;
      const snoozedUntil = itemState?.snoozedUntil ?? null;
      const snoozed = snoozedUntil !== null && Date.parse(snoozedUntil) > input.nowMs;
      const owner =
        item.repo === null || item.number === null
          ? undefined
          : threadByPullRequest.get(pullRequestKey(item.repo, item.number));
      if (owner !== undefined && !snoozed) {
        itemsByThread.set(owner, [...(itemsByThread.get(owner) ?? []), item]);
        continue;
      }
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
      if (snoozed) later.push({ entry, wakeAt: snoozedUntil });
      else candidates.push(entry);
    }
  }

  for (const thread of listed) {
    const need = threadNeed(thread, nowIso);
    const items = itemsByThread.get(thread) ?? [];
    if (need?.type === "running") {
      running.push({
        id: threadAttentionId(thread),
        environmentId: thread.environmentId,
        shell: thread,
        since: need.since,
        blockedOnWait: need.blockedOnWait,
        items,
      });
      continue;
    }
    // A settled thread only comes back when its agent is blocked on the user or its pull
    // requests need something.
    const threadNeeds =
      need !== null && (thread.settledOverride !== "settled" || BLOCKING_KINDS.has(need.kind));
    const [lead] = items;
    if (!threadNeeds && lead === undefined) continue;
    const entry: AttentionEntry = {
      id: threadAttentionId(thread),
      source: threadNeeds ? "thread" : lead!.source,
      kind: threadNeeds ? need.kind : lead!.kind,
      since: threadNeeds ? need.since : lead!.updatedAt,
      repo: lead?.repo ?? null,
      author: threadNeeds ? null : (lead?.author ?? null),
      project: input.projectTitle(thread.environmentId, thread.projectId),
      payload: {
        type: "thread",
        environmentId: thread.environmentId,
        shell: thread,
        items,
        askKey: [
          threadNeeds ? need.kind : "items",
          thread.source.pendingRuntimeRequest?.id ?? "",
          thread.source.latestRunId ?? "",
          thread.latestRun?.completedAt ?? "",
          pullRequestFingerprint(thread),
          items.map(itemVersion).join(","),
        ].join(":"),
      },
    };
    if (effectiveSnoozed(thread, { now: nowIso }) && thread.snoozedUntil !== null) {
      later.push({ entry, wakeAt: thread.snoozedUntil });
    } else {
      candidates.push(entry);
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
