import type { AttentionPreferences, AttentionRerankCandidate } from "@t3tools/contracts";

import { formatMatcher } from "./attentionPreferences.ts";
import type { AttentionRecentDecision } from "./AttentionStore.ts";

/**
 * Experimental, off by default (`attention.llmRerank`). The deterministic score already applied
 * mutes and weights; this only reorders what survived, using the user's plain-English rules.
 */
export function buildRerankPrompt(input: {
  readonly preferences: AttentionPreferences;
  readonly recent: ReadonlyArray<AttentionRecentDecision>;
  readonly candidates: ReadonlyArray<AttentionRerankCandidate>;
}): string {
  const rules = input.preferences.rules.map((rule) => `- ${rule}`);
  const weights = input.preferences.weights.map(
    (weight) => `- ${weight.direction}: ${formatMatcher(weight.match)}`,
  );
  const recent = input.recent.map(
    (decision) =>
      `- ${decision.action} ${decision.source}/${decision.kind}${decision.author ? ` by ${decision.author}` : ""}${decision.repo ? ` in ${decision.repo}` : ""}`,
  );
  const candidates = input.candidates.map(
    (candidate) =>
      `${candidate.id} | ${candidate.source}/${candidate.kind} | ${candidate.title} | ${candidate.ask}`,
  );
  return [
    "Order these items by how much they need the user right now, most urgent first.",
    "Follow the user's rules. Their recent decisions show what they act on and what they dismiss.",
    'Reply with JSON only: {"transcription": "<item ids, most urgent first, separated by newlines>"}.',
    "",
    "User's rules:",
    ...(rules.length > 0 ? rules : ["(none)"]),
    "Weights:",
    ...(weights.length > 0 ? weights : ["(none)"]),
    "Recent decisions, newest first:",
    ...(recent.length > 0 ? recent : ["(none)"]),
    "",
    "Items (id | source/kind | title | ask):",
    ...candidates,
  ].join("\n");
}

/** Known ids in the model's order, then any it left out in their original order. */
export function parseRerankReply(
  reply: string,
  candidates: ReadonlyArray<AttentionRerankCandidate>,
): string[] {
  const known = new Set(candidates.map((candidate) => candidate.id));
  const ordered: string[] = [];
  for (const token of reply.split(/[\n,]+/)) {
    const id = token
      .trim()
      .replace(/^[-*\d.)\s]+/, "")
      .replace(/^["'`]|["'`]$/g, "");
    if (known.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const candidate of candidates) {
    if (!ordered.includes(candidate.id)) ordered.push(candidate.id);
  }
  return ordered;
}
