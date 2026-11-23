import {
  EMPTY_ATTENTION_SERVER_STATE,
  type AttentionServerState,
} from "@t3tools/client-runtime/state/attention";
import { rankAttention } from "@t3tools/client-runtime/state/attention-ranking";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type AttentionItem,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveAttention, itemAttentionId, itemVersion } from "./AttentionPanel.logic";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const at = (iso: string) => DateTime.makeUnsafe(iso);

function shell(id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  const threadId = ThreadId.make(id);
  return presentThreadShell(environmentId, {
    id: threadId,
    projectId,
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at("2026-11-19T08:00:00.000Z"),
    updatedAt: at("2026-11-19T09:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: at("2026-11-19T08:30:00.000Z"),
    deletedAt: null,
    ...overrides,
  });
}

const approval = (id: string) => ({
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(`request-${id}`),
    kind: "command" as const,
    createdAt: at("2026-11-19T10:00:00.000Z"),
  },
});
const finished = {
  latestRunId: RunId.make("run"),
  status: "completed" as const,
  latestRunCompletedAt: at("2026-11-19T11:00:00.000Z"),
};

const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "github:github.com/acme/web#7",
  source: "github",
  kind: "review_requested",
  title: "Add retries",
  detail: "acme/web#7",
  url: "https://github.com/acme/web/pull/7",
  repo: "acme/web",
  author: "bob",
  projectId,
  number: 7,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-19T07:00:00.000Z",
  signals: ["review-requested"],
  actions: ["open_url"],
  ...overrides,
});

const derive = (
  threads: ReadonlyArray<ReturnType<typeof shell>>,
  state: AttentionServerState = EMPTY_ATTENTION_SERVER_STATE,
) =>
  deriveAttention({
    threads,
    projectTitle: () => "Web",
    servers: [{ environmentId, state }],
    nowMs: NOW,
  });

describe("deriveAttention", () => {
  it("classifies threads the way the sidebar does and keeps running work apart", () => {
    const derived = derive([
      shell("approve", approval("approve")),
      shell("done-unread", finished),
      shell("done-seen", { ...finished, lastVisitedAt: at("2026-11-19T11:30:00.000Z") }),
      shell("failed", { ...finished, status: "failed", lastError: "boom" }),
      shell("working", {
        latestRunId: RunId.make("run"),
        activeRunId: RunId.make("run"),
        status: "running",
        blockedOnThreadWait: true,
      }),
      shell("plan", { ...finished, interactionMode: "plan", hasActionableProposedPlan: true }),
      shell("archived", { ...approval("archived"), archivedAt: at("2026-11-19T10:00:00.000Z") }),
      // Settled threads only return when their agent is blocked on the user.
      shell("settled-done", { ...finished, settledOverride: "settled" }),
      shell("settled-approve", { ...approval("settled"), settledOverride: "settled" }),
    ]);
    expect(
      derived.candidates.map((entry) => [
        entry.payload.type === "thread" && entry.payload.shell.id,
        entry.kind,
      ]),
    ).toEqual([
      ["approve", "approval"],
      ["done-unread", "completed"],
      ["failed", "failed"],
      ["plan", "plan"],
      ["settled-approve", "approval"],
    ]);
    expect(derived.candidates[0]!.since).toBe("2026-11-19T10:00:00.000Z");
    expect(derived.running.map((entry) => [entry.shell.id, entry.blockedOnWait])).toEqual([
      ["working", true],
    ]);
  });

  it("rolls children up under their arranged root, counting its subthreads", () => {
    const parentId = ThreadId.make("parent");
    const childOf = (id: string, extra: Partial<OrchestrationV2ThreadShell>) =>
      shell(id, { arrangedParentThreadId: parentId, ...extra });
    const derived = derive([
      shell("parent"),
      childOf("child-a", approval("a")),
      childOf("child-b", finished),
      childOf("child-c", {}),
      shell("grandchild", { arrangedParentThreadId: ThreadId.make("child-c"), ...approval("g") }),
    ]);
    const sections = rankAttention({
      candidates: derived.candidates,
      inputsOf: () => ({ preferences: null, learning: [], nowMs: NOW }),
      limit: 5,
      rootOf: derived.rootOf,
    });
    expect(sections.now).toHaveLength(1);
    const [group] = sections.now;
    expect(group!.descendantCount).toBe(4);
    expect(group!.members.map((member) => member.kind)).toEqual([
      "approval",
      "approval",
      "completed",
    ]);
  });

  it("hides dismissed items until they change and parks snoozed ones in Later", () => {
    const pr = item();
    const state: AttentionServerState = {
      ...EMPTY_ATTENTION_SERVER_STATE,
      items: new Map([
        [pr.id, pr],
        ["other", item({ id: "other", kind: "ci_failing" })],
        ["changed", item({ id: "changed", updatedAt: "2026-11-19T11:00:00.000Z" })],
      ]),
      itemStates: new Map([
        [pr.id, { itemId: pr.id, snoozedUntil: null, dismissedVersion: itemVersion(pr) }],
        [
          "other",
          { itemId: "other", snoozedUntil: "2026-11-20T09:00:00.000Z", dismissedVersion: null },
        ],
        // Dismissed at an older version, so the update brings it back.
        ["changed", { itemId: "changed", snoozedUntil: null, dismissedVersion: itemVersion(pr) }],
      ]),
    };
    const derived = derive([], state);
    expect(derived.candidates.map((entry) => entry.id)).toEqual([
      itemAttentionId(environmentId, "changed"),
    ]);
    expect(derived.candidates[0]).toMatchObject({
      source: "github",
      author: "bob",
      project: "Web",
    });
    expect(derived.later.map((entry) => [entry.entry.id, entry.wakeAt])).toEqual([
      [itemAttentionId(environmentId, "other"), "2026-11-20T09:00:00.000Z"],
    ]);
  });

  it("folds pull request items into the thread that links them, even a settled one", () => {
    const link = {
      host: "github.com",
      repository: "Acme/Web",
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      source: "created" as const,
      linkedAt: "2026-11-19T08:00:00.000Z",
      snapshot: null,
      stack: null,
    };
    const ci = item({ id: "ci", kind: "ci_failing" });
    const loose = item({ id: "loose", number: 8 });
    const derived = derive(
      [
        shell("owner", {
          ...finished,
          pullRequests: [link],
          updatedAt: at("2026-11-19T10:00:00.000Z"),
        }),
        shell("quiet", { pullRequests: [link], settledOverride: "settled" }),
      ],
      {
        ...EMPTY_ATTENTION_SERVER_STATE,
        items: new Map([
          [ci.id, ci],
          [loose.id, loose],
        ]),
      },
    );
    expect(
      derived.candidates.map((entry) => [
        entry.id,
        entry.kind,
        entry.payload.type === "thread" ? entry.payload.items.map((folded) => folded.id) : null,
      ]),
    ).toEqual([
      [itemAttentionId(environmentId, "loose"), "review_requested", null],
      // The most recently active thread linking the pull request owns it.
      ["thread:env:owner", "completed", ["ci"]],
    ]);

    const settledOnly = derive(
      [shell("quiet", { pullRequests: [link], settledOverride: "settled" })],
      {
        ...EMPTY_ATTENTION_SERVER_STATE,
        items: new Map([[ci.id, ci]]),
      },
    );
    expect(settledOnly.candidates.map((entry) => [entry.id, entry.source, entry.kind])).toEqual([
      ["thread:env:quiet", "github", "ci_failing"],
    ]);

    // The alert comes from this machine while the agent runs on the devbox, which links the
    // pull request only through its branch; both machines watch the repository.
    const devbox = EnvironmentId.make("devbox");
    const remote = presentThreadShell(devbox, {
      ...shell("remote").source,
      branchPullRequest: { projectId, repository: "acme/web", number: 7, url: link.url },
      latestRunId: RunId.make("run"),
      activeRunId: RunId.make("run"),
      status: "running",
    });
    const state = { ...EMPTY_ATTENTION_SERVER_STATE, items: new Map([[ci.id, ci]]) };
    const handled = deriveAttention({
      threads: [remote],
      projectTitle: () => "Web",
      servers: [
        { environmentId, state },
        { environmentId: devbox, state },
      ],
      nowMs: NOW,
    });
    expect(handled.candidates).toEqual([]);
    expect(handled.running.map((entry) => [entry.id, entry.items.map((i) => i.id)])).toEqual([
      ["thread:devbox:remote", ["ci"]],
    ]);
  });
});
