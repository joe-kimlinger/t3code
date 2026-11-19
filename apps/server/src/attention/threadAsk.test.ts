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

import { deterministicThreadAsk, oneLine, planTitle, type ThreadAskShell } from "./threadAsk.ts";

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
    ).toEqual({
      summarize: false,
      ask: { text: "vp run test", generated: false, approval: { requestId, live: true } },
    });
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
    expect(result.ask).toEqual({
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
      }).ask,
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
    ).toEqual({ summarize: false, ask: { text: "Rate limited", generated: false } });
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
    ).toEqual({ summarize: true, ask: { text: "Done. Tests pass.", generated: false } });
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
      }).ask.text,
    ).toBe("Merged the fix.");
  });
});

describe("ask text helpers", () => {
  it("cuts long lines and finds headings", () => {
    expect(oneLine("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
    expect(oneLine("  \n \n")).toBeNull();
    expect(planTitle("- first step\n- second")).toBe("first step");
  });
});
