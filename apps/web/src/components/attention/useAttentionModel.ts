import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_ATTENTION_SERVER_STATE,
  type AttentionServerState,
} from "@t3tools/client-runtime/state/attention";
import {
  rankAttention,
  type AttentionRankingInputs,
} from "@t3tools/client-runtime/state/attention-ranking";
import type { AttentionRerankResult, EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";

import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { attentionEnvironment, attentionLiveListAtom } from "../../state/attention";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { deriveAttention, type AttentionEntry } from "./AttentionPanel.logic";

const RERANK_CANDIDATES = 12;
const NO_ORDER: ReadonlyArray<string> = [];
const NO_RERANK = Atom.make(
  AsyncResult.success<AttentionRerankResult>({ orderedIds: NO_ORDER }),
).pipe(Atom.keepAlive);

export interface AttentionServer {
  readonly environmentId: EnvironmentId;
  readonly state: AttentionServerState;
  /** False until the stream answers; stays false on servers without attention support. */
  readonly ready: boolean;
}

/** Everything the panel shows, derived on each render from state the client already holds. */
export function useAttentionModel() {
  // The tick is a UTC minute without a zone, which Date.parse would read as local time.
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  const threads = useQuietThreadShells();
  const projects = useProjects();
  const environmentIds = useConnectedEnvironmentIds();
  const limit = useClientSettings((settings) => settings.attentionNowLimit);
  const results = useAtomValue(attentionLiveListAtom(environmentIdsKey(environmentIds)));
  const servers: AttentionServer[] = environmentIds.map((environmentId, index) => {
    const result = results[index];
    const state = result === undefined ? null : AsyncResult.getOrElse(result, () => null);
    return { environmentId, state: state ?? EMPTY_ATTENTION_SERVER_STATE, ready: state !== null };
  });

  const titles = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const derived = deriveAttention({
    threads,
    projectTitle: (environmentId, projectId) => titles.get(`${environmentId}:${projectId}`) ?? null,
    servers,
    nowMs,
  });
  const stateOf = new Map(servers.map((server) => [server.environmentId, server.state]));
  const inputsOf = (entry: AttentionEntry): AttentionRankingInputs => {
    const state = stateOf.get(entry.payload.environmentId);
    return { preferences: state?.preferences ?? null, learning: state?.learning ?? [], nowMs };
  };
  const scored = rankAttention({
    candidates: derived.candidates,
    inputsOf,
    limit: Number.POSITIVE_INFINITY,
    rootOf: derived.rootOf,
  });
  const preferredOrder = useRerankOrder(
    scored.now.slice(0, RERANK_CANDIDATES).map((group) => group.lead),
  );
  const sections = rankAttention({
    candidates: derived.candidates,
    inputsOf,
    limit,
    rootOf: derived.rootOf,
    preferredOrder,
  });
  return {
    ...sections,
    running: derived.running,
    later: derived.later,
    servers,
    nowMs,
    reranked: preferredOrder.length > 0,
  };
}

export type AttentionModel = ReturnType<typeof useAttentionModel>;

/**
 * The experimental re-ranker's order for the top candidates, asked of the first candidate's
 * environment and only when it turned re-ranking on. One request per distinct candidate list.
 */
function useRerankOrder(leads: ReadonlyArray<AttentionEntry>): ReadonlyArray<string> {
  const environmentId = leads[0]?.payload.environmentId;
  const settings = useAtomValue(
    environmentId === undefined ? NO_SETTINGS : serverEnvironment.settingsValueAtom(environmentId),
  );
  const candidates = leads.map((lead) => ({
    id: lead.id,
    source: lead.source,
    kind: lead.kind,
    title: (lead.payload.type === "thread"
      ? lead.payload.shell.title
      : lead.payload.item.title
    ).slice(0, 500),
    ask: lead.payload.type === "item" ? lead.payload.item.detail.slice(0, 500) : "",
  }));
  const result = useAtomValue(
    environmentId !== undefined && settings?.attention.llmRerank === true && candidates.length > 1
      ? attentionEnvironment.rerank({ environmentId, input: { candidates } })
      : NO_RERANK,
  );
  return AsyncResult.getOrElse(result, () => null)?.orderedIds ?? NO_ORDER;
}

const NO_SETTINGS = Atom.make(null).pipe(Atom.keepAlive);
