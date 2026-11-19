import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type {
  AttentionDecisionAction,
  AttentionItemFeatures,
  AttentionItemState,
  AttentionLearningStat,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";

/** Actions that count toward an act-rate. Undo actions and mark-unread count for nothing. */
const ACTED_ACTIONS: ReadonlyArray<AttentionDecisionAction> = [
  "opened",
  "approved",
  "denied",
  "answered",
  "accepted_plan",
  "handed_to_agent",
  "prepared_thread",
  "more",
];
const DISMISSED_ACTIONS: ReadonlyArray<AttentionDecisionAction> = ["dismissed", "less", "muted"];
const IGNORED_ACTIONS: ReadonlyArray<AttentionDecisionAction> = ["ignored", "snoozed"];

const LearningRow = Schema.Struct({
  feature: Schema.String,
  acted: Schema.Number,
  dismissed: Schema.Number,
  ignored: Schema.Number,
});

const ItemStateRow = Schema.Struct({
  itemId: Schema.String,
  snoozedUntil: Schema.NullOr(Schema.String),
  dismissedVersion: Schema.NullOr(Schema.String),
});

const RecentDecisionRow = Schema.Struct({
  source: Schema.String,
  kind: Schema.String,
  action: Schema.String,
  repo: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type AttentionRecentDecision = typeof RecentDecisionRow.Type;

export class AttentionStore extends Context.Service<
  AttentionStore,
  {
    readonly recordDecision: (input: {
      readonly features: AttentionItemFeatures;
      readonly action: AttentionDecisionAction;
      readonly visibleMs: number | null;
      readonly at: string;
    }) => Effect.Effect<void, ProjectionRepositoryError>;
    /** Act, dismiss and ignore counts per feature for decisions made since `since`. */
    readonly learning: (
      since: string,
    ) => Effect.Effect<ReadonlyArray<AttentionLearningStat>, ProjectionRepositoryError>;
    readonly recentDecisions: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<AttentionRecentDecision>, ProjectionRepositoryError>;
    readonly resetLearning: Effect.Effect<void, ProjectionRepositoryError>;
    readonly listItemStates: Effect.Effect<
      ReadonlyArray<AttentionItemState>,
      ProjectionRepositoryError
    >;
    /** A state with neither field set deletes the row. */
    readonly setItemState: (
      state: AttentionItemState,
      at: string,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getThreadAsk: (input: {
      readonly threadId: string;
      readonly key: string;
    }) => Effect.Effect<string | null, ProjectionRepositoryError>;
    readonly putThreadAsk: (input: {
      readonly threadId: string;
      readonly key: string;
      readonly text: string;
      readonly at: string;
    }) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/attention/AttentionStore") {}

const sqlError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = (actions: ReadonlyArray<string>) => JSON.stringify(actions);

  const learningRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: LearningRow,
    execute: (since) => sql`
      WITH classified AS (
        SELECT
          source, kind, repo, author, project,
          action IN (SELECT value FROM json_each(${list(ACTED_ACTIONS)})) AS acted,
          action IN (SELECT value FROM json_each(${list(DISMISSED_ACTIONS)})) AS dismissed,
          action IN (SELECT value FROM json_each(${list(IGNORED_ACTIONS)})) AS ignored
        FROM attention_decisions
        WHERE created_at >= ${since}
      ),
      features AS (
        SELECT 'kind:' || source || '/' || kind AS feature, acted, dismissed, ignored FROM classified
        UNION ALL
        SELECT 'repo:' || source || '/' || repo, acted, dismissed, ignored FROM classified WHERE repo IS NOT NULL
        UNION ALL
        SELECT 'author:' || source || '/' || author, acted, dismissed, ignored FROM classified WHERE author IS NOT NULL
        UNION ALL
        SELECT 'project:' || source || '/' || project, acted, dismissed, ignored FROM classified WHERE project IS NOT NULL
      )
      SELECT
        feature AS "feature",
        SUM(acted) AS "acted",
        SUM(dismissed) AS "dismissed",
        SUM(ignored) AS "ignored"
      FROM features
      GROUP BY feature
      HAVING SUM(acted) + SUM(dismissed) + SUM(ignored) > 0
      ORDER BY feature
    `,
  });

  const recentRows = SqlSchema.findAll({
    Request: Schema.Number,
    Result: RecentDecisionRow,
    execute: (limit) => sql`
      SELECT source AS "source", kind AS "kind", action AS "action", repo AS "repo",
        author AS "author", created_at AS "createdAt"
      FROM attention_decisions
      ORDER BY id DESC
      LIMIT ${limit}
    `,
  });

  const itemStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ItemStateRow,
    execute: () => sql`
      SELECT item_id AS "itemId", snoozed_until AS "snoozedUntil",
        dismissed_version AS "dismissedVersion"
      FROM attention_item_states
    `,
  });

  const threadAskRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String, key: Schema.String }),
    Result: Schema.Struct({ text: Schema.String }),
    execute: (input) => sql`
      SELECT text AS "text" FROM attention_thread_asks
      WHERE thread_id = ${input.threadId} AND ask_key = ${input.key}
    `,
  });

  return AttentionStore.of({
    recordDecision: Effect.fn("AttentionStore.recordDecision")(
      function* (input) {
        const { features } = input;
        yield* sql`
          INSERT INTO attention_decisions (
            item_id, source, kind, action, repo, author, project, item_created_at, visible_ms,
            created_at
          ) VALUES (
            ${features.itemId}, ${features.source}, ${features.kind}, ${input.action},
            ${features.repo}, ${features.author}, ${features.project}, ${features.itemCreatedAt},
            ${input.visibleMs}, ${input.at}
          )
        `;
      },
      Effect.mapError(sqlError("recordAttentionDecision")),
    ),
    learning: Effect.fn("AttentionStore.learning")(
      function* (since) {
        const rows = yield* learningRows(since);
        return rows.map((row) => ({
          feature: row.feature,
          acted: Number(row.acted),
          dismissed: Number(row.dismissed),
          ignored: Number(row.ignored),
        }));
      },
      Effect.mapError(sqlError("readAttentionLearning")),
    ),
    recentDecisions: Effect.fn("AttentionStore.recentDecisions")(
      function* (limit) {
        return yield* recentRows(limit);
      },
      Effect.mapError(sqlError("readAttentionRecentDecisions")),
    ),
    resetLearning: sql`DELETE FROM attention_decisions`.pipe(
      Effect.asVoid,
      Effect.mapError(sqlError("resetAttentionLearning")),
    ),
    listItemStates: itemStateRows(undefined).pipe(
      Effect.mapError(sqlError("listAttentionItemStates")),
    ),
    setItemState: Effect.fn("AttentionStore.setItemState")(
      function* (state, at) {
        yield* state.snoozedUntil === null && state.dismissedVersion === null
          ? sql`DELETE FROM attention_item_states WHERE item_id = ${state.itemId}`
          : sql`
              INSERT INTO attention_item_states (item_id, snoozed_until, dismissed_version, updated_at)
              VALUES (${state.itemId}, ${state.snoozedUntil}, ${state.dismissedVersion}, ${at})
              ON CONFLICT (item_id) DO UPDATE SET
                snoozed_until = excluded.snoozed_until,
                dismissed_version = excluded.dismissed_version,
                updated_at = excluded.updated_at
            `;
      },
      Effect.mapError(sqlError("setAttentionItemState")),
    ),
    getThreadAsk: Effect.fn("AttentionStore.getThreadAsk")(
      function* (input) {
        const rows = yield* threadAskRows(input);
        return rows[0]?.text ?? null;
      },
      Effect.mapError(sqlError("getAttentionThreadAsk")),
    ),
    putThreadAsk: Effect.fn("AttentionStore.putThreadAsk")(
      function* (input) {
        yield* sql`
          INSERT INTO attention_thread_asks (thread_id, ask_key, text, created_at)
          VALUES (${input.threadId}, ${input.key}, ${input.text}, ${input.at})
          ON CONFLICT (thread_id, ask_key) DO UPDATE SET text = excluded.text
        `;
      },
      Effect.mapError(sqlError("putAttentionThreadAsk")),
    ),
  });
});

export const layer = Layer.effect(AttentionStore, make);
