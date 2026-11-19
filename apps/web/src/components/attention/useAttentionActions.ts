import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type {
  AttentionActInput,
  AttentionMatcher,
  AttentionThreadAsk,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { m } from "../../i18n/messages";
import { newMessageId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { attentionEnvironment } from "../../state/attention";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";
import { formatAttentionMatcher } from "./attentionLabels";
import { attentionFeaturesOf, itemVersion, type AttentionEntry } from "./AttentionPanel.logic";

// The agent reads this, so it stays in the agent's working language.
const ACCEPT_PLAN_MESSAGE = "Implement the plan.";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add({
    type: "error",
    title,
    description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
  });
}

/**
 * Panel actions. Each reuses the command the chat view or sidebar uses, then logs the decision.
 * `onAct` hears every decision but `ignored`, so the panel knows what the user handled.
 */
export function useAttentionActions(onAct: (entry: AttentionEntry) => void) {
  const router = useRouter();
  const act = useAtomCommand(attentionEnvironment.act, { reportFailure: false });
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const { settleThread, snoozeThread, unsnoozeThread, markThreadUnread } = useThreadActions();

  const record = (
    entry: AttentionEntry,
    action: AttentionActInput["action"],
    extra: Omit<AttentionActInput, "features" | "action"> = {},
  ) => {
    if (action !== "ignored") onAct(entry);
    return act({
      environmentId: entry.payload.environmentId,
      input: { features: attentionFeaturesOf(entry), action, ...extra },
    });
  };

  const threadRefOf = (entry: AttentionEntry) =>
    entry.payload.type === "thread"
      ? scopeThreadRef(entry.payload.environmentId, entry.payload.shell.id)
      : null;

  const open = async (entry: AttentionEntry) => {
    void record(entry, "opened");
    const ref = threadRefOf(entry);
    if (ref !== null) {
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
      return;
    }
    if (entry.payload.type === "item" && entry.payload.item.url !== null) {
      const url = entry.payload.item.url;
      const api = readLocalApi();
      if (api) await api.shell.openExternal(url).catch(() => undefined);
      else window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const respondApproval = async (
    entry: AttentionEntry,
    ask: AttentionThreadAsk,
    decision: Extract<ProviderApprovalDecision, "accept" | "decline">,
  ) => {
    const ref = threadRefOf(entry);
    if (ref === null || ask.approval === undefined) return;
    const result = await respondToApproval({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, requestId: ask.approval.requestId, decision },
    });
    if (result._tag === "Failure") {
      reportFailure(m(msg("Failed to submit approval decision.")), result);
      return;
    }
    void record(entry, decision === "accept" ? "approved" : "denied");
  };

  const answer = async (
    entry: AttentionEntry,
    ask: AttentionThreadAsk,
    answers: Record<string, string | ReadonlyArray<string>>,
  ) => {
    const ref = threadRefOf(entry);
    if (ref === null || ask.input === undefined) return false;
    const result = await respondToUserInput({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, requestId: ask.input.requestId, answers },
    });
    if (result._tag === "Failure") {
      reportFailure(m(msg("Failed to submit user input.")), result);
      return false;
    }
    void record(entry, "answered");
    return true;
  };

  const acceptPlan = async (entry: AttentionEntry, ask: AttentionThreadAsk) => {
    if (entry.payload.type !== "thread" || ask.plan === undefined) return;
    const { shell } = entry.payload;
    const result = await startTurn({
      environmentId: entry.payload.environmentId,
      input: {
        threadId: shell.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: ACCEPT_PLAN_MESSAGE,
          attachments: [],
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: "default",
        sourceProposedPlan: { threadId: shell.id, planId: ask.plan.planId },
        createdAt: new Date().toISOString(),
      },
    });
    if (result._tag === "Failure") {
      reportFailure(m(msg("Could not start the plan")), result);
      return;
    }
    void record(entry, "accepted_plan");
  };

  const setItemState = (
    entry: AttentionEntry,
    action: "snoozed" | "unsnoozed" | "dismissed" | "undismissed",
    state: { readonly snoozedUntil: string | null; readonly dismissedVersion: string | null },
  ) => {
    if (entry.payload.type !== "item") return;
    void record(entry, action, { itemState: { itemId: entry.payload.item.id, ...state } });
  };

  const snooze = (entry: AttentionEntry, snoozedUntil: string) => {
    const ref = threadRefOf(entry);
    if (ref !== null) {
      void snoozeThread(ref, snoozedUntil);
      void record(entry, "snoozed");
      return;
    }
    setItemState(entry, "snoozed", { snoozedUntil, dismissedVersion: null });
  };

  const unsnooze = (entry: AttentionEntry) => {
    const ref = threadRefOf(entry);
    if (ref !== null) {
      void unsnoozeThread(ref);
      void record(entry, "unsnoozed");
      return;
    }
    setItemState(entry, "unsnoozed", { snoozedUntil: null, dismissedVersion: null });
  };

  const dismiss = (entry: AttentionEntry) => {
    const ref = threadRefOf(entry);
    if (ref !== null) {
      // Settling shows its own undo.
      void settleThread(ref);
      void record(entry, "dismissed");
      return;
    }
    if (entry.payload.type !== "item") return;
    setItemState(entry, "dismissed", {
      snoozedUntil: null,
      dismissedVersion: itemVersion(entry.payload.item),
    });
    const toastId = toastManager.add({
      type: "success",
      title: m(msg("Dismissed until it changes")),
      actionProps: {
        children: m(msg("Undo")),
        onClick: () => {
          toastManager.close(toastId);
          setItemState(entry, "undismissed", { snoozedUntil: null, dismissedVersion: null });
        },
      },
    });
  };

  const markUnread = (entry: AttentionEntry) => {
    const ref = threadRefOf(entry);
    if (ref === null) return;
    markThreadUnread(ref);
    void record(entry, "marked_unread");
  };

  const feedback = (entry: AttentionEntry, direction: "less" | "more") => {
    // Scope the rule to who sent it, or for threads to their project, not the whole kind.
    const scope =
      entry.author !== null
        ? { author: entry.author }
        : entry.project !== null
          ? { project: entry.project }
          : {};
    void record(entry, direction, { match: { source: entry.source, kind: entry.kind, ...scope } });
    toastManager.add({
      type: "success",
      title:
        direction === "less"
          ? m(msg("Got it: fewer items like this"))
          : m(msg("Got it: more items like this")),
      description: m(msg("Saved as a rule in your attention preferences file.")),
    });
  };

  const mute = (entry: AttentionEntry, match: AttentionMatcher) => {
    void record(entry, "muted", { match });
    const toastId = toastManager.add({
      type: "success",
      title: m(msg("Muted {rule}"), { rule: formatAttentionMatcher(match) }),
      actionProps: {
        children: m(msg("Undo")),
        onClick: () => {
          toastManager.close(toastId);
          void record(entry, "unmuted", { match });
        },
      },
    });
  };

  const unmute = (entry: AttentionEntry, match: AttentionMatcher) =>
    void record(entry, "unmuted", { match });

  const ignored = (entry: AttentionEntry, visibleMs: number) =>
    void record(entry, "ignored", { visibleMs: Math.round(visibleMs) });

  const handedToAgent = (entry: AttentionEntry) => void record(entry, "handed_to_agent");
  const preparedThread = (entry: AttentionEntry) => void record(entry, "prepared_thread");

  return {
    open,
    respondApproval,
    answer,
    acceptPlan,
    snooze,
    unsnooze,
    dismiss,
    markUnread,
    feedback,
    mute,
    unmute,
    ignored,
    handedToAgent,
    preparedThread,
  };
}

export type AttentionActions = ReturnType<typeof useAttentionActions>;
