import type * as Effect from "effect/Effect";
import type {
  AttentionError,
  AttentionItem,
  AttentionSettings,
  AttentionSourceId,
  AttentionSourceStatus,
} from "@t3tools/contracts";

export interface AttentionSourcePoll {
  /** The source's complete current item set; the service diffs it against the last one. */
  readonly items: ReadonlyArray<AttentionItem>;
  readonly status: Omit<AttentionSourceStatus, "source" | "checkedAt">;
}

/**
 * A server-side item producer, polled only while a client subscribes, backing off on failure.
 * Threads are not a source: clients derive them from shells they already hold. Next sources:
 * Slack (DMs and mentions, keyed by permalink) and Linear (assigned issues and mentions).
 */
export interface AttentionSource {
  readonly id: AttentionSourceId;
  readonly intervalMs: number;
  readonly maxBackoffMs: number;
  readonly enabled: (settings: AttentionSettings) => boolean;
  /** Fails when the source cannot be read at all; the previous items then stay. */
  readonly poll: (
    settings: AttentionSettings,
  ) => Effect.Effect<AttentionSourcePoll, AttentionError>;
}
