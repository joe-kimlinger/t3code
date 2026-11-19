import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Where an attention item comes from. Threads are derived on the client from shells it already
 * holds; every other source runs on the environment's server. Slack and Linear are reserved.
 */
export const AttentionSourceId = Schema.Literals(["thread", "github", "slack", "linear"]);
export type AttentionSourceId = typeof AttentionSourceId.Type;

export const AttentionGitHubKind = Schema.Literals([
  "review_requested",
  "ci_failing",
  "changes_requested",
  "ready_to_merge",
]);
export type AttentionGitHubKind = typeof AttentionGitHubKind.Type;

export const AttentionItemAction = Schema.Literals([
  "open_url",
  "prepare_thread",
  "hand_to_agent",
  "snooze",
  "dismiss",
]);
export type AttentionItemAction = typeof AttentionItemAction.Type;

/** A server-sourced item. `kind` stays an open string so a newer server's kinds still decode. */
export const AttentionItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: AttentionSourceId,
  kind: TrimmedNonEmptyString,
  title: Schema.String,
  /** Source-provided context, such as a message excerpt. Clients compose the ask from `kind`. */
  detail: Schema.String,
  url: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  number: Schema.NullOr(PositiveInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Raw facts behind the item, shown in "why shown", such as `checks:failing`. */
  signals: Schema.Array(Schema.String),
  actions: ForwardCompatibleArray(AttentionItemAction),
});
export type AttentionItem = typeof AttentionItem.Type;

/** Snooze and dismissal of a server-sourced item. A dismissal holds until the item's `updatedAt` moves. */
export const AttentionItemState = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  dismissedVersion: Schema.NullOr(Schema.String),
});
export type AttentionItemState = typeof AttentionItemState.Type;

/** Fields an item is matched on by mutes, weights and learning. Absent fields match anything. */
export const AttentionMatcher = Schema.Struct({
  source: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
});
export type AttentionMatcher = typeof AttentionMatcher.Type;

export const AttentionWeight = Schema.Struct({
  direction: Schema.Literals(["more", "less"]),
  match: AttentionMatcher,
});
export type AttentionWeight = typeof AttentionWeight.Type;

/** The parsed preferences file. `rules` are the user's plain-English lines, for people and the re-ranker. */
export const AttentionPreferences = Schema.Struct({
  path: Schema.String,
  rules: Schema.Array(Schema.String),
  mutes: Schema.Array(AttentionMatcher),
  weights: Schema.Array(AttentionWeight),
  /** Lines the parser could not read, so the user can fix them. */
  problems: Schema.Array(Schema.String),
});
export type AttentionPreferences = typeof AttentionPreferences.Type;

/** How often the user acted on items sharing one feature, such as `kind:github/review_requested`. */
export const AttentionLearningStat = Schema.Struct({
  feature: Schema.String,
  acted: NonNegativeInt,
  dismissed: NonNegativeInt,
  ignored: NonNegativeInt,
});
export type AttentionLearningStat = typeof AttentionLearningStat.Type;

export const AttentionSourceStatus = Schema.Struct({
  source: AttentionSourceId,
  state: Schema.Literals(["ok", "disabled", "unavailable", "error"]),
  detail: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(IsoDateTime),
});
export type AttentionSourceStatus = typeof AttentionSourceStatus.Type;

export const AttentionStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    items: ForwardCompatibleArray(AttentionItem),
    itemStates: Schema.Array(AttentionItemState),
    preferences: AttentionPreferences,
    learning: Schema.Array(AttentionLearningStat),
    sources: ForwardCompatibleArray(AttentionSourceStatus),
  }),
  Schema.Struct({
    type: Schema.Literal("items"),
    upserted: ForwardCompatibleArray(AttentionItem),
    removedIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("item-states"),
    upserted: Schema.Array(AttentionItemState),
    removedIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("preferences"), preferences: AttentionPreferences }),
  Schema.Struct({
    type: Schema.Literal("learning"),
    learning: Schema.Array(AttentionLearningStat),
  }),
  Schema.Struct({
    type: Schema.Literal("sources"),
    sources: ForwardCompatibleArray(AttentionSourceStatus),
  }),
]);
export type AttentionStreamEvent = typeof AttentionStreamEvent.Type;

export const AttentionDecisionAction = Schema.Literals([
  "opened",
  "approved",
  "denied",
  "answered",
  "accepted_plan",
  "snoozed",
  "unsnoozed",
  "dismissed",
  "undismissed",
  "marked_unread",
  "handed_to_agent",
  "prepared_thread",
  "muted",
  "unmuted",
  "less",
  "more",
  "ignored",
]);
export type AttentionDecisionAction = typeof AttentionDecisionAction.Type;

/** What the decision log keeps about an item, so learning can generalize past one item. */
export const AttentionItemFeatures = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  source: AttentionSourceId,
  kind: TrimmedNonEmptyString,
  repo: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  project: Schema.NullOr(Schema.String),
  itemCreatedAt: Schema.NullOr(IsoDateTime),
});
export type AttentionItemFeatures = typeof AttentionItemFeatures.Type;

export const AttentionActInput = Schema.Struct({
  features: AttentionItemFeatures,
  action: AttentionDecisionAction,
  /** How long the item was visible before this, for `ignored`. */
  visibleMs: Schema.optionalKey(NonNegativeInt),
  /** Set with `snoozed`, `unsnoozed`, `dismissed` and `undismissed` on server-sourced items. */
  itemState: Schema.optionalKey(AttentionItemState),
  /** Set with `muted` and `unmuted`; also the weight's match for `less` and `more`. */
  match: Schema.optionalKey(AttentionMatcher),
});
export type AttentionActInput = typeof AttentionActInput.Type;

export const AttentionPreferencesFile = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
});
export type AttentionPreferencesFile = typeof AttentionPreferencesFile.Type;

export const AttentionWritePreferencesInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type AttentionWritePreferencesInput = typeof AttentionWritePreferencesInput.Type;

export const AttentionThreadAskInput = Schema.Struct({
  threadId: ThreadId,
  /** Changes whenever the thread's need changes, so each need is read once. */
  key: TrimmedNonEmptyString,
});
export type AttentionThreadAskInput = typeof AttentionThreadAskInput.Type;

export const AttentionAskQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, value: Schema.optionalKey(Schema.String) }),
  ),
  multiSelect: Schema.Boolean,
  allowCustomAnswer: Schema.Boolean,
  required: Schema.Boolean,
});
export type AttentionAskQuestion = typeof AttentionAskQuestion.Type;

export const AttentionThreadAsk = Schema.Struct({
  /**
   * The subject of the ask, such as the command to approve, the question, the plan's title or
   * the error. Clients add the verb in the user's language. Null when nothing more is known.
   */
  text: Schema.NullOr(Schema.String),
  /** Generated by a model rather than read from the request. */
  generated: Schema.Boolean,
  approval: Schema.optionalKey(
    Schema.Struct({ requestId: RuntimeRequestId, live: Schema.Boolean }),
  ),
  input: Schema.optionalKey(
    Schema.Struct({
      requestId: RuntimeRequestId,
      live: Schema.Boolean,
      questions: Schema.Array(AttentionAskQuestion),
    }),
  ),
  /** The proposed plan to implement when the user accepts it. */
  plan: Schema.optionalKey(Schema.Struct({ planId: PlanId })),
});
export type AttentionThreadAsk = typeof AttentionThreadAsk.Type;

export const AttentionRerankCandidate = Schema.Struct({
  id: Schema.String,
  source: AttentionSourceId,
  kind: Schema.String,
  title: Schema.String.check(Schema.isMaxLength(500)),
  ask: Schema.String.check(Schema.isMaxLength(500)),
});
export type AttentionRerankCandidate = typeof AttentionRerankCandidate.Type;

export const AttentionRerankInput = Schema.Struct({
  candidates: Schema.Array(AttentionRerankCandidate).check(Schema.isMaxLength(40)),
});
export type AttentionRerankInput = typeof AttentionRerankInput.Type;

export const AttentionRerankResult = Schema.Struct({
  orderedIds: Schema.Array(Schema.String),
});
export type AttentionRerankResult = typeof AttentionRerankResult.Type;

export class AttentionError extends Schema.TaggedError<AttentionError>()("AttentionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const enabledByDefault = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));

/** Per-environment: the sources run on the environment's server. */
export const AttentionSettings = Schema.Struct({
  githubEnabled: enabledByDefault,
  githubReviewRequested: enabledByDefault,
  githubFailingCi: enabledByDefault,
  githubChangesRequested: enabledByDefault,
  githubReadyToMerge: enabledByDefault,
  /** Summarize finished runs with the text generation model when no request explains the ask. */
  completionSummaries: enabledByDefault,
  /** Experimental: reorder Now with the text generation model, reading the preferences file. */
  llmRerank: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type AttentionSettings = typeof AttentionSettings.Type;

export const AttentionSettingsPatch = Schema.Struct({
  githubEnabled: Schema.optionalKey(Schema.Boolean),
  githubReviewRequested: Schema.optionalKey(Schema.Boolean),
  githubFailingCi: Schema.optionalKey(Schema.Boolean),
  githubChangesRequested: Schema.optionalKey(Schema.Boolean),
  githubReadyToMerge: Schema.optionalKey(Schema.Boolean),
  completionSummaries: Schema.optionalKey(Schema.Boolean),
  llmRerank: Schema.optionalKey(Schema.Boolean),
});

export const DEFAULT_ATTENTION_NOW_LIMIT = 5;
export const AttentionNowLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }));
