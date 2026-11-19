import {
  WS_METHODS,
  type AttentionItem,
  type AttentionItemState,
  type AttentionLearningStat,
  type AttentionPreferences,
  type AttentionSourceStatus,
  type AttentionStreamEvent,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** What one environment's attention stream has said so far. */
export interface AttentionServerState {
  readonly items: ReadonlyMap<string, AttentionItem>;
  readonly itemStates: ReadonlyMap<string, AttentionItemState>;
  readonly preferences: AttentionPreferences | null;
  readonly learning: ReadonlyArray<AttentionLearningStat>;
  readonly sources: ReadonlyArray<AttentionSourceStatus>;
}

export const EMPTY_ATTENTION_SERVER_STATE: AttentionServerState = {
  items: new Map(),
  itemStates: new Map(),
  preferences: null,
  learning: [],
  sources: [],
};

function applyDelta<V>(
  current: ReadonlyMap<string, V>,
  upserted: ReadonlyArray<V>,
  removedIds: ReadonlyArray<string>,
  idOf: (value: V) => string,
): ReadonlyMap<string, V> {
  if (upserted.length === 0 && removedIds.length === 0) return current;
  const next = new Map(current);
  for (const id of removedIds) next.delete(id);
  for (const value of upserted) next.set(idOf(value), value);
  return next;
}

function applyAttentionStreamEvent(
  state: AttentionServerState,
  event: AttentionStreamEvent,
): AttentionServerState {
  switch (event.type) {
    case "snapshot":
      return {
        items: new Map(event.items.map((item) => [item.id, item])),
        itemStates: new Map(event.itemStates.map((itemState) => [itemState.itemId, itemState])),
        preferences: event.preferences,
        learning: event.learning,
        sources: event.sources,
      };
    case "items":
      return {
        ...state,
        items: applyDelta(state.items, event.upserted, event.removedIds, (item) => item.id),
      };
    case "item-states":
      return {
        ...state,
        itemStates: applyDelta(
          state.itemStates,
          event.upserted,
          event.removedIds,
          (itemState) => itemState.itemId,
        ),
      };
    case "preferences":
      return { ...state, preferences: event.preferences };
    case "learning":
      return { ...state, learning: event.learning };
    case "sources":
      return { ...state, sources: event.sources };
  }
}

export function createAttentionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:attention:live",
      tag: WS_METHODS.attentionSubscribe,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(() => EMPTY_ATTENTION_SERVER_STATE, applyAttentionStreamEvent),
          // The seed is not something the server said.
          Stream.drop(1),
        ),
    }),
    /** Read once per need: the key changes when the thread's need does. */
    threadAsk: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:attention:thread-ask",
      tag: WS_METHODS.attentionThreadAsk,
      staleTimeMs: Number.POSITIVE_INFINITY,
      idleTtlMs: 10 * 60_000,
    }),
    preferencesFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:attention:preferences-file",
      tag: WS_METHODS.attentionReadPreferences,
      staleTimeMs: 0,
    }),
    rerank: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:attention:rerank",
      tag: WS_METHODS.attentionRerank,
      staleTimeMs: Number.POSITIVE_INFINITY,
      idleTtlMs: 5 * 60_000,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:attention:act",
      tag: WS_METHODS.attentionAct,
    }),
    writePreferences: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:attention:write-preferences",
      tag: WS_METHODS.attentionWritePreferences,
    }),
    resetLearning: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:attention:reset-learning",
      tag: WS_METHODS.attentionResetLearning,
    }),
  };
}
