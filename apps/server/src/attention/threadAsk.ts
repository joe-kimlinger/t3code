import type {
  AttentionThreadAsk,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

const MAX_ASK_LENGTH = 160;

/** First non-empty line, whitespace collapsed and cut to `max` characters. */
export function oneLine(text: string, max = MAX_ASK_LENGTH): string | null {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A plan's first heading, or its first line when it has none. */
export function planTitle(markdown: string): string | null {
  const heading = markdown
    .split(/\r?\n/)
    .map((line) => /^#{1,6}\s+(.+)$/.exec(line.trim())?.[1])
    .find((title) => title !== undefined);
  return oneLine(heading ?? markdown.replace(/^[#>*\-\s]+/gm, ""));
}

export type ThreadAskShell = Pick<
  OrchestrationV2ThreadShell,
  | "pendingRuntimeRequest"
  | "hasActionableProposedPlan"
  | "status"
  | "lastError"
  | "latestVisibleMessage"
  | "title"
  | "pullRequests"
>;

export interface ThreadAskInputs {
  readonly shell: ThreadAskShell;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  /** The latest run's items, in order. */
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}

/** The ask a request, plan or failure states outright, else the agent's last reply. */
export function deterministicThreadAsk(input: ThreadAskInputs): AttentionThreadAsk {
  const { shell } = input;
  const pending = shell.pendingRuntimeRequest;
  if (pending !== null) {
    const request = input.runtimeRequests.find((entry) => entry.id === pending.id);
    if (pending.kind === "user_input") {
      const item = input.turnItems.findLast(
        (entry) => entry.type === "user_input_request" && entry.requestId === pending.id,
      );
      const questions = item?.type === "user_input_request" ? item.questions : [];
      return {
        text: questions[0] === undefined ? null : oneLine(questions[0].question),
        generated: false,
        input: {
          requestId: pending.id,
          live: request !== undefined && request.responseCapability.type !== "not_resumable",
          questions: questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: question.options.map((option) =>
              option.value === undefined
                ? { label: option.label }
                : { label: option.label, value: option.value },
            ),
            multiSelect: question.multiSelect === true,
            allowCustomAnswer: question.allowCustomAnswer !== false,
            required: question.required !== false,
          })),
        },
      };
    }
    const item = input.turnItems.findLast(
      (entry) => entry.type === "approval_request" && entry.requestId === pending.id,
    );
    const detail =
      item?.type === "approval_request" ? (item.prompt ?? item.reason ?? item.appName) : undefined;
    return {
      text: detail === undefined ? null : oneLine(detail),
      generated: false,
      approval: {
        requestId: pending.id,
        live: request?.responseCapability.type === "live",
      },
    };
  }
  if (shell.hasActionableProposedPlan) {
    const plan = input.turnItems.findLast((entry) => entry.type === "proposed_plan");
    return plan?.type === "proposed_plan"
      ? { text: planTitle(plan.markdown), generated: false, plan: { planId: plan.planId } }
      : { text: null, generated: false };
  }
  if (shell.status === "failed") {
    return { text: shell.lastError ? oneLine(shell.lastError) : null, generated: false };
  }
  const reply = lastReply(input);
  return { text: reply === null ? null : oneLine(reply), generated: false };
}

/** The agent's last reply in the latest run, or the shell's latest message when it has one. */
function lastReply(input: ThreadAskInputs): string | null {
  const item = input.turnItems.findLast(
    (entry) => entry.type === "assistant_message" && entry.text.trim().length > 0,
  );
  if (item?.type === "assistant_message") return item.text;
  const message = input.shell.latestVisibleMessage;
  return message !== null && message.role === "assistant" ? message.text : null;
}

const SUMMARY_SOURCE_LIMIT = 4_000;

const clip = (text: string, max = SUMMARY_SOURCE_LIMIT) =>
  text.length > max ? `…${text.slice(-max)}` : text;

/** What the user last asked for in the latest run. */
function lastRequest(input: ThreadAskInputs): string | null {
  const item = input.turnItems.findLast(
    (entry) => entry.type === "user_message" && entry.text.trim().length > 0,
  );
  return item?.type === "user_message" ? item.text : null;
}

/** One line per linked pull request, with the state a user acts on. */
function pullRequestLines(shell: ThreadAskShell): string[] {
  return (shell.pullRequests ?? []).map((link) => {
    const snapshot = link.snapshot;
    const facts = [
      snapshot?.state ?? "unknown state",
      snapshot?.isDraft ? "draft" : null,
      snapshot?.checksState ? `checks ${snapshot.checksState}` : null,
      snapshot?.reviewDecision ? `review ${snapshot.reviewDecision}` : null,
      snapshot?.mergeability === "conflicting" ? "merge conflicts" : null,
    ].filter((fact) => fact !== null);
    return `- ${link.repository}#${link.number} ${snapshot?.title ?? ""} (${facts.join(", ")})`;
  });
}

/**
 * Prompt for a short status of the task: where it stands and what the user should decide.
 * The reply fills `transcription`, the field the free-form text operation returns.
 */
export function buildStatusSummaryPrompt(input: ThreadAskInputs, ask: AttentionThreadAsk): string {
  const request = lastRequest(input);
  const reply = lastReply(input);
  const waiting = ask.approval
    ? `The agent is waiting for approval: ${ask.text ?? "(no detail)"}`
    : ask.input
      ? `The agent asked: ${ask.input.questions.map((question) => question.question).join(" / ")}`
      : ask.plan
        ? `The agent proposed a plan: ${ask.text ?? "(untitled)"}`
        : input.shell.status === "failed"
          ? `The run failed: ${ask.text ?? "(no error text)"}`
          : null;
  const pullRequests = pullRequestLines(input.shell);
  return [
    "Summarize where this coding agent's task stands for its user, who is triaging many tasks.",
    "Write at most two short sentences, under 240 characters in all: what state the work is in,",
    "then what the user needs to decide or do next. Be concrete; name files, checks or numbers",
    "when they matter. No greeting, no markdown, no quotes.",
    'Reply with JSON only: {"transcription": "<the summary>"}.',
    "",
    `Task: ${input.shell.title}`,
    ...(request === null ? [] : ["User's latest request:", "<<<", clip(request, 1_500), ">>>"]),
    ...(reply === null ? [] : ["Agent's latest message:", "<<<", clip(reply), ">>>"]),
    ...(waiting === null ? [] : [waiting]),
    ...(pullRequests.length === 0 ? [] : ["Pull requests:", ...pullRequests]),
  ].join("\n");
}
