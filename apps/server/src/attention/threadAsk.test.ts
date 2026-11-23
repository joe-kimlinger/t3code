import {
  MessageId,
  NodeId,
  PlanId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStatusSummaryPrompt,
  deterministicThreadAsk,
  oneLine,
  planTitle,
  type ThreadAskShell,
} from "./threadAsk.ts";

const now = DateTime.makeUnsafe("2026-11-19T12:00:00.000Z");
const threadId = ThreadId.make("thread");
const nodeId = NodeId.make("node");
const runId = RunId.make("run");
const requestId = RuntimeRequestId.make("request");

const itemBase = (id: string) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running" as const,
  title: null,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
});

const request = (
  kind: OrchestrationV2RuntimeRequest["kind"],
  responseCapability: OrchestrationV2RuntimeRequest["responseCapability"] = {
    type: "live",
    providerSessionId: ProviderSessionId.make("session"),
  },
): OrchestrationV2RuntimeRequest => ({
  id: requestId,
  nodeId,
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability,
  createdAt: now,
  resolvedAt: null,
});

const shell = (overrides: Partial<ThreadAskShell> = {}): ThreadAskShell => ({
  pendingRuntimeRequest: null,
  hasActionableProposedPlan: false,
  status: "completed",
  lastError: null,
  latestVisibleMessage: null,
  title: "Fix login",
  ...overrides,
});

describe("deterministicThreadAsk", () => {
  it("names the command an approval is for", () => {
    const items: OrchestrationV2TurnItem[] = [
      {
        ...itemBase("approval"),
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "vp run test\n--filter server",
      },
    ];
    expect(
      deterministicThreadAsk({
        shell: shell({
          pendingRuntimeRequest: { id: requestId, kind: "command", createdAt: now },
        }),
        runtimeRequests: [request("command")],
        turnItems: items,
      }),
    ).toEqual({ text: "vp run test", generated: false, approval: { requestId, live: true } });
  });

  it("carries the questions so the panel can answer, and marks lost sessions", () => {
    const items: OrchestrationV2TurnItem[] = [
      {
        ...itemBase("question"),
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which package should I change?",
            options: [
              { label: "Web", description: "The web app" },
              { label: "Server", description: "The server", value: "server" },
            ],
          },
        ],
      },
    ];
    const result = deterministicThreadAsk({
      shell: shell({
        pendingRuntimeRequest: { id: requestId, kind: "user_input", createdAt: now },
      }),
      runtimeRequests: [request("user_input", { type: "not_resumable", reason: "restarted" })],
      turnItems: items,
    });
    expect(result).toEqual({
      text: "Which package should I change?",
      generated: false,
      input: {
        requestId,
        live: false,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which package should I change?",
            options: [{ label: "Web" }, { label: "Server", value: "server" }],
            multiSelect: false,
            allowCustomAnswer: true,
            required: true,
          },
        ],
      },
    });
  });

  it("uses the plan title, the error, or the last reply in that order", () => {
    const plan: OrchestrationV2TurnItem = {
      ...itemBase("plan"),
      type: "proposed_plan",
      planId: PlanId.make("plan"),
      markdown: "Intro\n\n## Move auth to the server\n- step",
      streaming: false,
    };
    expect(
      deterministicThreadAsk({
        shell: shell({ hasActionableProposedPlan: true, status: "failed", lastError: "boom" }),
        runtimeRequests: [],
        turnItems: [plan],
      }),
    ).toEqual({
      text: "Move auth to the server",
      generated: false,
      plan: { planId: PlanId.make("plan") },
    });
    expect(
      deterministicThreadAsk({
        shell: shell({ status: "failed", lastError: "  Rate limited\nretry later" }),
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ text: "Rate limited", generated: false });
    expect(
      deterministicThreadAsk({
        shell: shell({
          latestVisibleMessage: {
            id: MessageId.make("message"),
            role: "assistant",
            text: "\nDone. Tests pass.\nDetails follow.",
            updatedAt: now,
          },
        }),
        runtimeRequests: [],
        turnItems: [],
      }),
    ).toEqual({ text: "Done. Tests pass.", generated: false });
    // The latest run's last reply wins over the shell, which servers often leave empty.
    expect(
      deterministicThreadAsk({
        shell: shell(),
        runtimeRequests: [],
        turnItems: [
          {
            ...itemBase("reply"),
            type: "assistant_message",
            messageId: MessageId.make("reply"),
            text: "Merged the fix.\nAll green.",
            streaming: false,
          },
        ],
      }).text,
    ).toBe("Merged the fix.");
  });
});

describe("buildStatusSummaryPrompt", () => {
  it("gives the model the request, the reply, what blocks and the pull requests", () => {
    const inputs = {
      shell: shell({
        pendingRuntimeRequest: { id: requestId, kind: "command" as const, createdAt: now },
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/app",
            number: 12,
            url: "https://github.com/acme/app/pull/12",
            source: "created" as const,
            linkedAt: "2026-11-19T12:00:00.000Z",
            snapshot: {
              state: "open" as const,
              title: "Fix login redirect",
              headBranch: "fix/login",
              baseBranch: "main",
              isDraft: false,
              updatedAt: null,
              syncedAt: "2026-11-19T12:00:00.000Z",
              checksState: "failing" as const,
            },
            stack: null,
          },
        ],
      }),
      runtimeRequests: [request("command")],
      turnItems: [
        {
          ...itemBase("ask"),
          createdAt: now,
          createdBy: null,
          type: "user_message",
          messageId: MessageId.make("ask"),
          inputIntent: "message",
          text: "Make the redirect keep the next param",
          textOmitted: false,
          attachments: [],
        },
        {
          ...itemBase("reply"),
          type: "assistant_message",
          messageId: MessageId.make("reply"),
          text: "Pushed the fix; CI is red on e2e.",
          streaming: false,
        },
        {
          ...itemBase("approval"),
          type: "approval_request",
          requestId,
          requestKind: "command",
          prompt: "git push --force",
        },
      ] as ReadonlyArray<OrchestrationV2TurnItem>,
    };
    const prompt = buildStatusSummaryPrompt(inputs, deterministicThreadAsk(inputs));
    expect(prompt).toContain("Task: Fix login");
    expect(prompt).toContain("Make the redirect keep the next param");
    expect(prompt).toContain("Pushed the fix; CI is red on e2e.");
    expect(prompt).toContain("waiting for approval: git push --force");
    expect(prompt).toContain("- acme/app#12 Fix login redirect (open, checks failing)");
  });
});

describe("ask text helpers", () => {
  it("cuts long lines and finds headings", () => {
    expect(oneLine("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
    expect(oneLine("  \n \n")).toBeNull();
    expect(planTitle("- first step\n- second")).toBe("first step");
  });
});
