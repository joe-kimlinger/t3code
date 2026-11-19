/**
 * Everything that decides attention placement lives here so it can be tuned in one place:
 * severities, the age curve, preference weights, learned act-rates and nested-thread rollups.
 */
import type {
  AttentionLearningStat,
  AttentionMatcher,
  AttentionPreferences,
  AttentionSourceId,
} from "@t3tools/contracts";

/** Base points by kind. Unknown kinds from newer servers get `DEFAULT_SEVERITY`. */
const ATTENTION_SEVERITY: Readonly<Record<string, number>> = {
  // Threads: the agent is blocked on the user.
  approval: 100,
  input: 95,
  request: 90,
  plan: 80,
  failed: 75,
  limited: 60,
  woke: 55,
  completed: 50,
  // GitHub
  review_requested: 70,
  changes_requested: 65,
  ci_failing: 60,
  ready_to_merge: 45,
};
const DEFAULT_SEVERITY = 40;
const MAX_AGE_POINTS = 20;
const WEIGHT_POINTS = 25;
const MAX_LEARNING_POINTS = 20;
/** Decisions on a feature before its act-rate counts at all, and before it counts fully. */
const MIN_LEARNING_SAMPLES = 3;
const FULL_LEARNING_SAMPLES = 10;
/** A rolled-up parent ranks as its most urgent child plus this per extra child. */
const ROLLUP_EXTRA_POINTS = 2;

export type AttentionReason =
  | { readonly code: "signal"; readonly kind: string; readonly points: number }
  | { readonly code: "age"; readonly hours: number; readonly points: number }
  | {
      readonly code: "weight";
      readonly direction: "more" | "less";
      readonly match: AttentionMatcher;
      readonly points: number;
    }
  | {
      readonly code: "learning";
      readonly feature: string;
      readonly acted: number;
      readonly total: number;
      readonly points: number;
    }
  | { readonly code: "mute"; readonly match: AttentionMatcher };

/** One candidate, from a thread or a server source. `T` carries the caller's own payload. */
export interface AttentionCandidate<T> {
  readonly id: string;
  readonly source: AttentionSourceId;
  readonly kind: string;
  /** When it started needing the user, as an ISO instant. */
  readonly since: string;
  readonly repo: string | null;
  readonly author: string | null;
  readonly project: string | null;
  readonly payload: T;
}

export interface RankedAttention<T> extends AttentionCandidate<T> {
  readonly score: number;
  readonly reasons: ReadonlyArray<AttentionReason>;
  readonly muted: boolean;
}

export interface AttentionRankingInputs {
  readonly preferences: AttentionPreferences | null;
  readonly learning: ReadonlyArray<AttentionLearningStat>;
  readonly nowMs: number;
}

function field(candidate: AttentionCandidate<unknown>, name: keyof AttentionMatcher) {
  switch (name) {
    case "source":
      return [candidate.source];
    case "kind":
      return [candidate.kind, `${candidate.source}/${candidate.kind}`];
    case "repo":
      return candidate.repo === null ? [] : [candidate.repo];
    case "author":
      return candidate.author === null ? [] : [candidate.author, `@${candidate.author}`];
    case "project":
      return candidate.project === null ? [] : [candidate.project];
    case "channel":
      return [];
  }
}

/** Every field the matcher names must match, case-insensitively. */
export function attentionMatches(
  matcher: AttentionMatcher,
  candidate: AttentionCandidate<unknown>,
): boolean {
  const names = Object.keys(matcher) as Array<keyof AttentionMatcher>;
  return (
    names.length > 0 &&
    names.every((name) => {
      const wanted = matcher[name]?.toLowerCase();
      return wanted !== undefined && field(candidate, name).some((v) => v.toLowerCase() === wanted);
    })
  );
}

/** Learning features, matching the server's decision-log grouping. */
function attentionFeatures(candidate: AttentionCandidate<unknown>): string[] {
  const { source } = candidate;
  return [
    `kind:${source}/${candidate.kind}`,
    ...(candidate.repo === null ? [] : [`repo:${source}/${candidate.repo}`]),
    ...(candidate.author === null ? [] : [`author:${source}/${candidate.author}`]),
    ...(candidate.project === null ? [] : [`project:${source}/${candidate.project}`]),
  ];
}

function ageHours(since: string, nowMs: number): number {
  const sinceMs = Date.parse(since);
  return Number.isNaN(sinceMs) ? 0 : Math.max(0, (nowMs - sinceMs) / 3_600_000);
}

export function scoreAttention<T>(
  candidate: AttentionCandidate<T>,
  inputs: AttentionRankingInputs,
): RankedAttention<T> {
  const reasons: AttentionReason[] = [];
  const severity = ATTENTION_SEVERITY[candidate.kind] ?? DEFAULT_SEVERITY;
  reasons.push({ code: "signal", kind: candidate.kind, points: severity });

  const hours = ageHours(candidate.since, inputs.nowMs);
  const agePoints = Math.min(MAX_AGE_POINTS, Math.round(4 * Math.log2(1 + hours)));
  if (agePoints > 0) reasons.push({ code: "age", hours, points: agePoints });

  const preferences = inputs.preferences;
  const mute = preferences?.mutes.find((matcher) => attentionMatches(matcher, candidate));
  if (mute !== undefined) reasons.push({ code: "mute", match: mute });
  let weightPoints = 0;
  for (const weight of preferences?.weights ?? []) {
    if (!attentionMatches(weight.match, candidate)) continue;
    const points = weight.direction === "more" ? WEIGHT_POINTS : -WEIGHT_POINTS;
    weightPoints += points;
    reasons.push({ code: "weight", direction: weight.direction, match: weight.match, points });
  }

  const stats = new Map(inputs.learning.map((stat) => [stat.feature, stat]));
  let learningPoints = 0;
  for (const feature of attentionFeatures(candidate)) {
    const stat = stats.get(feature);
    if (stat === undefined) continue;
    const total = stat.acted + stat.dismissed + stat.ignored;
    if (total < MIN_LEARNING_SAMPLES) continue;
    const rate = stat.acted / (stat.acted + stat.dismissed + 0.5 * stat.ignored);
    const confidence = Math.min(1, total / FULL_LEARNING_SAMPLES);
    const points = Math.round((rate - 0.5) * 2 * MAX_LEARNING_POINTS * confidence);
    if (points === 0) continue;
    learningPoints += points;
    reasons.push({ code: "learning", feature, acted: stat.acted, total, points });
  }
  learningPoints = Math.max(-MAX_LEARNING_POINTS, Math.min(MAX_LEARNING_POINTS, learningPoints));

  return {
    ...candidate,
    score: severity + agePoints + weightPoints + learningPoints,
    reasons,
    muted: mute !== undefined,
  };
}

/** Highest score first; ties go to the older need, then the id for a stable order. */
function compareRanked(left: RankedAttention<unknown>, right: RankedAttention<unknown>) {
  return (
    right.score - left.score ||
    Date.parse(left.since) - Date.parse(right.since) ||
    left.id.localeCompare(right.id)
  );
}

export interface AttentionGroup<T> {
  readonly lead: RankedAttention<T>;
  /** Every member, lead included, most urgent first. One member means no rollup. */
  readonly members: ReadonlyArray<RankedAttention<T>>;
  /** Threads under the group's root, for "2 of 5 subthreads". Zero when not a thread tree. */
  readonly descendantCount: number;
  readonly score: number;
}

/**
 * Collapses candidates sharing a root (the arranged parent at the top of their thread tree)
 * into one group led by the root's own entry when it has one, else the most urgent member.
 */
export function groupAttention<T>(
  ranked: ReadonlyArray<RankedAttention<T>>,
  rootOf: (candidate: RankedAttention<T>) => {
    readonly key: string;
    readonly descendantCount: number;
  } | null,
): AttentionGroup<T>[] {
  const groups = new Map<string, { members: RankedAttention<T>[]; descendantCount: number }>();
  const order: string[] = [];
  for (const candidate of ranked) {
    const root = rootOf(candidate);
    const key = root?.key ?? candidate.id;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { members: [candidate], descendantCount: root?.descendantCount ?? 0 });
      order.push(key);
    } else {
      group.members.push(candidate);
    }
  }
  return order
    .map((key) => {
      const { members, descendantCount } = groups.get(key)!;
      const sorted = [...members].sort(compareRanked);
      const lead = sorted.find((member) => member.id === key) ?? sorted[0]!;
      const score = sorted[0]!.score + ROLLUP_EXTRA_POINTS * (sorted.length - 1);
      return { lead, members: sorted, descendantCount, score };
    })
    .sort((left, right) => right.score - left.score || compareRanked(left.lead, right.lead));
}

export interface AttentionSections<T> {
  readonly now: ReadonlyArray<AttentionGroup<T>>;
  /** Groups past the Now limit, shown on request. */
  readonly overflow: ReadonlyArray<AttentionGroup<T>>;
  readonly muted: ReadonlyArray<RankedAttention<T>>;
}

/** Ranks needs, drops muted ones into their own list, and splits Now at `limit` groups. */
export function rankAttention<T>(input: {
  readonly candidates: ReadonlyArray<AttentionCandidate<T>>;
  /** Per candidate, since each environment has its own preferences and learning. */
  readonly inputsOf: (candidate: AttentionCandidate<T>) => AttentionRankingInputs;
  readonly limit: number;
  readonly rootOf: Parameters<typeof groupAttention<T>>[1];
  /** An optional re-ranker's order; ids it does not name keep their score order after it. */
  readonly preferredOrder?: ReadonlyArray<string> | null;
}): AttentionSections<T> {
  const ranked = input.candidates.map((candidate) =>
    scoreAttention(candidate, input.inputsOf(candidate)),
  );
  const muted = ranked.filter((entry) => entry.muted).sort(compareRanked);
  let groups = groupAttention(
    ranked.filter((entry) => !entry.muted),
    input.rootOf,
  );
  const preferred = input.preferredOrder;
  if (preferred && preferred.length > 0) {
    const position = new Map(preferred.map((id, index) => [id, index]));
    const rank = (group: AttentionGroup<T>) => position.get(group.lead.id) ?? Infinity;
    groups = groups
      .map((group, index) => ({ group, index }))
      .sort((left, right) => rank(left.group) - rank(right.group) || left.index - right.index)
      .map(({ group }) => group);
  }
  return {
    now: groups.slice(0, input.limit),
    overflow: groups.slice(input.limit),
    muted,
  };
}

/** The matcher a one-click mute or feedback writes for a field of this candidate. */
export function attentionMatcherFor(
  candidate: AttentionCandidate<unknown>,
  by: "author" | "repo" | "kind" | "project",
): AttentionMatcher | null {
  switch (by) {
    case "author":
      return candidate.author === null
        ? null
        : { source: candidate.source, author: candidate.author };
    case "repo":
      return candidate.repo === null ? null : { source: candidate.source, repo: candidate.repo };
    case "project":
      return candidate.project === null
        ? null
        : { source: candidate.source, project: candidate.project };
    case "kind":
      return { source: candidate.source, kind: candidate.kind };
  }
}
