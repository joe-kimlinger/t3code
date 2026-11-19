import type { AttentionReason } from "@t3tools/client-runtime/state/attention-ranking";
import type { AttentionMatcher } from "@t3tools/contracts";
import { msg } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";

const KIND_LABELS: Readonly<Record<string, string>> = {
  approval: msg("Approval needed"),
  input: msg("Question for you"),
  request: msg("Guest message waiting"),
  plan: msg("Plan ready for review"),
  failed: msg("Run failed"),
  limited: msg("Hit a usage limit"),
  woke: msg("Woke from snooze"),
  completed: msg("Finished"),
  review_requested: msg("Review requested"),
  changes_requested: msg("Changes requested"),
  ci_failing: msg("CI failing"),
  ready_to_merge: msg("Approved, ready to merge"),
};

export function attentionKindLabel(kind: string, resolve: MessageResolver): string {
  const label = KIND_LABELS[kind];
  return label === undefined ? resolve(msg("Needs you")) : resolve(label);
}

/** The "what I need from you" line: the verb in the user's language, then the subject. */
export function attentionAskLine(
  kind: string,
  detail: string | null,
  resolve: MessageResolver,
): string {
  if (detail === null || detail.length === 0) return attentionKindLabel(kind, resolve);
  switch (kind) {
    case "approval":
      return resolve(msg("Approve: {detail}"), { detail });
    case "input":
      return resolve(msg("Answer: {detail}"), { detail });
    case "plan":
      return resolve(msg("Review plan: {detail}"), { detail });
    case "failed":
      return resolve(msg("Failed: {detail}"), { detail });
    default:
      return detail;
  }
}

export function formatAttentionMatcher(matcher: AttentionMatcher): string {
  return Object.entries(matcher)
    .map(([field, value]) => `${field}: ${value}`)
    .join(", ");
}

const signed = (points: number) => (points > 0 ? `+${points}` : `${points}`);

/** One line per signal or rule that placed the item, for "why shown". */
export function attentionReasonLine(reason: AttentionReason, resolve: MessageResolver): string {
  switch (reason.code) {
    case "signal":
      return resolve(msg("{label} ({points})"), {
        label: attentionKindLabel(reason.kind, resolve),
        points: signed(reason.points),
      });
    case "age":
      return resolve(msg("Waiting {hours, plural, one {# hour} other {# hours}} ({points})"), {
        hours: Math.floor(reason.hours),
        points: signed(reason.points),
      });
    case "weight":
      return resolve(
        msg(
          "{direction, select, more {Your rule: more like} other {Your rule: less like}} {rule} ({points})",
        ),
        {
          direction: reason.direction,
          rule: formatAttentionMatcher(reason.match),
          points: signed(reason.points),
        },
      );
    case "learning":
      return resolve(msg("You acted on {acted} of {total} like this, {feature} ({points})"), {
        acted: reason.acted,
        total: reason.total,
        feature: reason.feature,
        points: signed(reason.points),
      });
    case "mute":
      return resolve(msg("Muted by your rule: {rule}"), {
        rule: formatAttentionMatcher(reason.match),
      });
  }
}
