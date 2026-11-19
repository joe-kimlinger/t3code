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
>;

export interface ThreadAskInputs {
  readonly shell: ThreadAskShell;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  /** The latest run's items, in order. */
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}

/**
 * The ask a request, plan or failure states outright. `summarize` is set when only a finished
 * run explains it, so the caller may ask a model; `text` then holds the reply's first line.
 */
export function deterministicThreadAsk(input: ThreadAskInputs): {
  readonly ask: AttentionThreadAsk;
  readonly summarize: boolean;
} {
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
        summarize: false,
        ask: {
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
        },
      };
    }
    const item = input.turnItems.findLast(
      (entry) => entry.type === "approval_request" && entry.requestId === pending.id,
    );
    const detail =
      item?.type === "approval_request" ? (item.prompt ?? item.reason ?? item.appName) : undefined;
    return {
      summarize: false,
      ask: {
        text: detail === undefined ? null : oneLine(detail),
        generated: false,
        approval: {
          requestId: pending.id,
          live: request?.responseCapability.type === "live",
        },
      },
    };
  }
  if (shell.hasActionableProposedPlan) {
    const plan = input.turnItems.findLast((entry) => entry.type === "proposed_plan");
    return {
      summarize: false,
      ask:
        plan?.type === "proposed_plan"
          ? { text: planTitle(plan.markdown), generated: false, plan: { planId: plan.planId } }
          : { text: null, generated: false },
    };
  }
  if (shell.status === "failed") {
    return {
      summarize: false,
      ask: { text: shell.lastError ? oneLine(shell.lastError) : null, generated: false },
    };
  }
  const reply = lastReply(input);
  return {
    summarize: true,
    ask: { text: reply === null ? null : oneLine(reply), generated: false },
  };
}

/** The agent's last reply in the latest run, or the shell's latest message when it has one. */
export function lastReply(input: ThreadAskInputs): string | null {
  const item = input.turnItems.findLast(
    (entry) => entry.type === "assistant_message" && entry.text.trim().length > 0,
  );
  if (item?.type === "assistant_message") return item.text;
  const message = input.shell.latestVisibleMessage;
  return message !== null && message.role === "assistant" ? message.text : null;
}

const SUMMARY_SOURCE_LIMIT = 6_000;

/** Prompt for one line on what a finished run did or needs; the reply fills `transcription`. */
export function buildCompletionSummaryPrompt(input: {
  readonly threadTitle: string;
  readonly lastMessage: string;
}): string {
  const message =
    input.lastMessage.length > SUMMARY_SOURCE_LIMIT
      ? `…${input.lastMessage.slice(-SUMMARY_SOURCE_LIMIT)}`
      : input.lastMessage;
  return [
    "A coding agent finished a turn. Write one line, at most 90 characters, telling its user",
    "what they need to do next, or what was finished when nothing is needed. Start with a verb.",
    "No quotes, no markdown, no trailing period.",
    'Reply with JSON only: {"transcription": "<the line>"}.',
    "",
    `Thread: ${input.threadTitle}`,
    "Agent's final message:",
    "<<<",
    message,
    ">>>",
  ].join("\n");
}
