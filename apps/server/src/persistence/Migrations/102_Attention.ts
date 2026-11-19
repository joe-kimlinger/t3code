import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every action the user takes on an attention item, with the item's features, so ranking can
  // learn which sources, kinds, repos and people the user acts on. Reset learning deletes rows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS attention_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      repo TEXT,
      author TEXT,
      project TEXT,
      item_created_at TEXT,
      visible_ms INTEGER,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS attention_decisions_created_at
    ON attention_decisions (created_at)
  `;

  // Snooze and dismissal of items from server-side sources; threads keep their own snooze.
  yield* sql`
    CREATE TABLE IF NOT EXISTS attention_item_states (
      item_id TEXT PRIMARY KEY,
      snoozed_until TEXT,
      dismissed_version TEXT,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;

  // One-line asks generated for finished runs, keyed by what the thread needed at the time.
  yield* sql`
    CREATE TABLE IF NOT EXISTS attention_thread_asks (
      thread_id TEXT NOT NULL,
      ask_key TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, ask_key)
    ) WITHOUT ROWID
  `;
});
