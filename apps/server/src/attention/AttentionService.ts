import {
  AttentionError,
  type AttentionActInput,
  type AttentionItem,
  type AttentionItemState,
  type AttentionLearningStat,
  type AttentionMatcher,
  type AttentionPreferences,
  type AttentionPreferencesFile,
  type AttentionRerankInput,
  type AttentionRerankResult,
  type AttentionSettings,
  type AttentionSourceId,
  type AttentionSourceStatus,
  type AttentionStreamEvent,
  type AttentionThreadAsk,
  type AttentionThreadAskInput,
  type AttentionWritePreferencesInput,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  addMute,
  addWeight,
  ATTENTION_PREFERENCES_FILE_NAME,
  DEFAULT_ATTENTION_PREFERENCES,
  parseAttentionPreferences,
  removeMute,
} from "./attentionPreferences.ts";
import { buildRerankPrompt, parseRerankReply } from "./attentionRerank.ts";
import type { AttentionSource } from "./AttentionSource.ts";
import * as AttentionStore from "./AttentionStore.ts";
import * as GitHubAttentionSource from "./GitHubAttentionSource.ts";
import {
  buildCompletionSummaryPrompt,
  deterministicThreadAsk,
  lastReply,
  oneLine,
} from "./threadAsk.ts";

const SUMMARY_TIMEOUT = Duration.seconds(30);
const RERANK_TIMEOUT = Duration.seconds(45);
const RECENT_DECISIONS_FOR_RERANK = 30;
const LEARNING_WINDOW_DAYS = 90;

export class AttentionService extends Context.Service<
  AttentionService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** A snapshot, then only what changed. */
    readonly subscribe: () => Stream.Stream<AttentionStreamEvent, AttentionError>;
    readonly act: (input: AttentionActInput) => Effect.Effect<void, AttentionError>;
    readonly threadAsk: (
      input: AttentionThreadAskInput,
    ) => Effect.Effect<AttentionThreadAsk, AttentionError>;
    readonly readPreferences: Effect.Effect<AttentionPreferencesFile, AttentionError>;
    readonly writePreferences: (
      input: AttentionWritePreferencesInput,
    ) => Effect.Effect<void, AttentionError>;
    readonly resetLearning: Effect.Effect<void, AttentionError>;
    readonly rerank: (
      input: AttentionRerankInput,
    ) => Effect.Effect<AttentionRerankResult, AttentionError>;
  }
>()("t3/attention/AttentionService") {}

const failure = (message: string) => (cause: unknown) => new AttentionError({ message, cause });

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Upserts and removals that turn `previous` into `next`. */
function diffAttentionItems(
  previous: ReadonlyMap<string, AttentionItem>,
  next: ReadonlyArray<AttentionItem>,
): { readonly upserted: AttentionItem[]; readonly removedIds: string[] } {
  const nextIds = new Set(next.map((item) => item.id));
  return {
    upserted: next.filter((item) => {
      const before = previous.get(item.id);
      return before === undefined || !sameJson(before, item);
    }),
    removedIds: [...previous.keys()].filter((id) => !nextIds.has(id)),
  };
}

/** The matcher "less"/"more" feedback records when the client sends none: kind plus who. */
const defaultFeedbackMatch = (input: AttentionActInput): AttentionMatcher => ({
  source: input.features.source,
  kind: input.features.kind,
  ...(input.features.author === null ? {} : { author: input.features.author }),
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* AttentionStore.AttentionStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const atomicWriteContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof writeFileStringAtomically>>>();
  const sources: ReadonlyArray<AttentionSource> = [yield* GitHubAttentionSource.make];

  const preferencesPath = path.join(config.stateDir, ATTENTION_PREFERENCES_FILE_NAME);
  const events = yield* PubSub.unbounded<AttentionStreamEvent>();
  const items = yield* Ref.make(new Map<AttentionSourceId, ReadonlyMap<string, AttentionItem>>());
  const statuses = yield* Ref.make(new Map<AttentionSourceId, AttentionSourceStatus>());
  const itemStates = yield* Ref.make(new Map<string, AttentionItemState>());
  const preferences = yield* Ref.make<AttentionPreferences>(
    parseAttentionPreferences(DEFAULT_ATTENTION_PREFERENCES, preferencesPath),
  );
  const learning = yield* Ref.make<ReadonlyArray<AttentionLearningStat>>([]);
  const subscribers = yield* Ref.make(0);
  // One per source: a first subscriber or a settings change should not wait out a sleep.
  const pollWakes = yield* Effect.forEach(sources, () => Queue.sliding<void>(1));
  const wakeSources = Effect.forEach(pollWakes, (wake) => Queue.offer(wake, undefined), {
    discard: true,
  });
  const fileLock = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const attentionSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.attention),
    Effect.mapError(failure("Could not read settings.")),
  );

  const publish = (event: AttentionStreamEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);

  const readPreferencesText = fs.readFileString(preferencesPath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    }),
  );

  const reloadPreferences = Effect.fn("AttentionService.reloadPreferences")(function* () {
    const text = yield* readPreferencesText;
    const next = parseAttentionPreferences(text ?? DEFAULT_ATTENTION_PREFERENCES, preferencesPath);
    const previous = yield* Ref.getAndSet(preferences, next);
    if (!sameJson(previous, next)) yield* publish({ type: "preferences", preferences: next });
  });

  const writePreferencesText = (text: string) =>
    writeFileStringAtomically({ filePath: preferencesPath, contents: text }).pipe(
      Effect.provideContext(atomicWriteContext),
      Effect.andThen(reloadPreferences()),
      Effect.mapError(failure("Could not write the preferences file.")),
    );

  const editPreferences = (edit: (text: string) => string) =>
    fileLock.withPermits(1)(
      Effect.gen(function* () {
        const text =
          (yield* readPreferencesText.pipe(
            Effect.mapError(failure("Could not read the preferences file.")),
          )) ?? DEFAULT_ATTENTION_PREFERENCES;
        const next = edit(text);
        if (next !== text) yield* writePreferencesText(next);
      }),
    );

  const refreshLearning = Effect.gen(function* () {
    const since = DateTime.subtract(yield* DateTime.now, { days: LEARNING_WINDOW_DAYS });
    const next = yield* store.learning(DateTime.formatIso(since));
    yield* Ref.set(learning, next);
    yield* publish({ type: "learning", learning: next });
  }).pipe(Effect.mapError(failure("Could not read the decision log.")));

  const applyPoll = Effect.fn("AttentionService.applyPoll")(function* (
    source: AttentionSource,
    nextItems: ReadonlyArray<AttentionItem>,
    status: Omit<AttentionSourceStatus, "source" | "checkedAt">,
  ) {
    const previous = (yield* Ref.get(items)).get(source.id) ?? new Map<string, AttentionItem>();
    const diff = diffAttentionItems(previous, nextItems);
    if (diff.upserted.length > 0 || diff.removedIds.length > 0) {
      yield* Ref.update(items, (current) =>
        new Map(current).set(source.id, new Map(nextItems.map((item) => [item.id, item]))),
      );
      yield* publish({ type: "items", ...diff });
    }
    const nextStatus: AttentionSourceStatus = {
      source: source.id,
      ...status,
      checkedAt: yield* nowIso,
    };
    const statusChanged = yield* Ref.modify(statuses, (current) => {
      const before = current.get(source.id);
      const changed =
        before === undefined ||
        before.state !== nextStatus.state ||
        before.detail !== nextStatus.detail;
      return [changed, new Map(current).set(source.id, nextStatus)];
    });
    if (statusChanged) {
      yield* publish({ type: "sources", sources: [...(yield* Ref.get(statuses)).values()] });
    }
  });

  /** Polls every source while someone watches; failures keep the last items and back off. */
  const runSource = Effect.fn("AttentionService.runSource")(function* (
    source: AttentionSource,
    pollWake: Queue.Queue<void>,
  ) {
    let failures = 0;
    while (true) {
      if ((yield* Ref.get(subscribers)) === 0) {
        yield* Queue.take(pollWake);
        continue;
      }
      const settings = yield* attentionSettings.pipe(
        Effect.orElseSucceed(() => null as AttentionSettings | null),
      );
      if (settings === null || !source.enabled(settings)) {
        yield* applyPoll(source, [], { state: "disabled", detail: null });
        yield* Queue.take(pollWake);
        continue;
      }
      const result = yield* source.poll(settings).pipe(Effect.exit);
      if (Exit.isSuccess(result)) {
        failures = 0;
        yield* applyPoll(source, result.value.items, result.value.status);
      } else {
        failures += 1;
        const previous = (yield* Ref.get(items)).get(source.id);
        yield* Effect.logWarning("attention source poll failed", {
          source: source.id,
          cause: result.cause,
        });
        yield* applyPoll(source, [...(previous?.values() ?? [])], {
          state: "error",
          detail: "Could not reach the source. Retrying.",
        });
      }
      const delay = Math.min(source.intervalMs * 2 ** failures, source.maxBackoffMs);
      yield* Effect.raceFirst(Effect.sleep(Duration.millis(delay)), Queue.take(pollWake));
    }
  });

  const start = Effect.fn("AttentionService.start")(function* () {
    const states = yield* store.listItemStates.pipe(Effect.orElseSucceed(() => []));
    yield* Ref.set(itemStates, new Map(states.map((state) => [state.itemId, state])));
    yield* refreshLearning.pipe(Effect.ignoreCause({ log: true }));
    const exists = yield* fs.exists(preferencesPath).pipe(Effect.orElseSucceed(() => true));
    if (!exists) {
      yield* writePreferencesText(DEFAULT_ATTENTION_PREFERENCES).pipe(
        Effect.ignoreCause({ log: true }),
      );
    }
    yield* reloadPreferences().pipe(Effect.ignoreCause({ log: true }));

    // Hot reload: watch the directory, since editors replace the file on save.
    const fileName = path.basename(preferencesPath);
    const directory = path.dirname(preferencesPath);
    const watching = yield* Deferred.make<void>();
    const markWatching = () => Deferred.doneUnsafe(watching, Exit.void);
    yield* Stream.runForEach(
      fs.watch(directory, { onReady: markWatching }).pipe(
        Stream.ensuring(Effect.sync(markWatching)),
        Stream.filter(
          (event) =>
            event.path === fileName ||
            event.path === preferencesPath ||
            path.resolve(directory, event.path) === preferencesPath,
        ),
        Stream.debounce(Duration.millis(100)),
      ),
      () => reloadPreferences().pipe(Effect.ignoreCause({ log: true })),
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    yield* Deferred.await(watching);

    yield* Stream.runForEach(yield* serverSettings.subscribeChanges, () => wakeSources).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );

    for (const [index, source] of sources.entries()) {
      yield* forkParked(runSource(source, pollWakes[index]!));
    }
  });

  const snapshot = Effect.gen(function* () {
    return {
      type: "snapshot",
      items: [...(yield* Ref.get(items)).values()].flatMap((bySource) => [...bySource.values()]),
      itemStates: [...(yield* Ref.get(itemStates)).values()],
      preferences: yield* Ref.get(preferences),
      learning: yield* Ref.get(learning),
      sources: [...(yield* Ref.get(statuses)).values()],
    } satisfies AttentionStreamEvent;
  });

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot; replayed deltas are idempotent upserts and removals.
        const subscription = yield* PubSub.subscribe(events);
        const first = (yield* Ref.getAndUpdate(subscribers, (count) => count + 1)) === 0;
        yield* Effect.addFinalizer(() => Ref.update(subscribers, (count) => count - 1));
        if (first) yield* wakeSources;
        return Stream.concat(Stream.fromEffect(snapshot), Stream.fromSubscription(subscription));
      }),
    );

  const setItemState = Effect.fn("AttentionService.setItemState")(function* (
    state: AttentionItemState,
  ) {
    yield* store
      .setItemState(state, yield* nowIso)
      .pipe(Effect.mapError(failure("Could not save the item.")));
    const cleared = state.snoozedUntil === null && state.dismissedVersion === null;
    yield* Ref.update(itemStates, (current) => {
      const next = new Map(current);
      if (cleared) next.delete(state.itemId);
      else next.set(state.itemId, state);
      return next;
    });
    yield* publish(
      cleared
        ? { type: "item-states", upserted: [], removedIds: [state.itemId] }
        : { type: "item-states", upserted: [state], removedIds: [] },
    );
  });

  const act = Effect.fn("AttentionService.act")(function* (input: AttentionActInput) {
    yield* store
      .recordDecision({
        features: input.features,
        action: input.action,
        visibleMs: input.visibleMs ?? null,
        at: yield* nowIso,
      })
      .pipe(Effect.mapError(failure("Could not record the decision.")));
    if (input.itemState !== undefined) yield* setItemState(input.itemState);
    switch (input.action) {
      case "muted":
        if (input.match !== undefined) {
          const match = input.match;
          yield* editPreferences((text) => addMute(text, match));
        }
        break;
      case "unmuted":
        if (input.match !== undefined) {
          const match = input.match;
          yield* editPreferences((text) => removeMute(text, match));
        }
        break;
      case "less":
      case "more": {
        const weight = {
          direction: input.action,
          match: input.match ?? defaultFeedbackMatch(input),
        };
        yield* editPreferences((text) => addWeight(text, weight));
        break;
      }
      default:
        break;
    }
    yield* refreshLearning;
  });

  const readAskInputs = Effect.fn("AttentionService.readAskInputs")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return null;
    const records = yield* threads.getThreadRecords(
      threadId,
      ["runtimeRequests", "turnItems"],
      shell.latestRunId === null ? undefined : { turnItemRunIds: [shell.latestRunId] },
    );
    return { shell, runtimeRequests: records.runtimeRequests, turnItems: records.turnItems };
  });

  const summaryCache = yield* Cache.makeWith<string, string | null, never, never>(
    (cacheKey) =>
      Effect.gen(function* () {
        const separator = cacheKey.indexOf("\n");
        const threadId = ThreadId.make(cacheKey.slice(0, separator));
        const key = cacheKey.slice(separator + 1);
        const cached = yield* store.getThreadAsk({ threadId, key });
        if (cached !== null) return cached;
        const inputs = yield* readAskInputs(threadId);
        const reply = inputs === null ? null : lastReply(inputs);
        if (inputs === null || reply === null) return null;
        const settings = yield* serverSettings.getSettings;
        const generated = yield* Effect.scoped(
          Effect.gen(function* () {
            // Providers run in a working directory; a summary must not read a checkout.
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attention-" });
            // The only free-form text operation; its output field is named for transcripts.
            return yield* textGeneration.generateTranscriptionPostProcessing({
              cwd,
              prompt: buildCompletionSummaryPrompt({
                threadTitle: inputs.shell.title,
                lastMessage: reply,
              }),
              modelSelection: settings.textGenerationModelSelection,
            });
          }),
        ).pipe(Effect.timeout(SUMMARY_TIMEOUT));
        const text = oneLine(generated.transcription.replace(/^["']|["']$/g, ""), 120);
        if (text === null) return null;
        yield* store.putThreadAsk({ threadId, key, text, at: yield* nowIso });
        return text;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("attention summary unavailable", { cause }).pipe(Effect.as(null)),
        ),
      ),
    {
      capacity: 512,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? Duration.hours(1) : Duration.minutes(5),
    },
  );

  const threadAsk = Effect.fn("AttentionService.threadAsk")(function* (
    input: AttentionThreadAskInput,
  ) {
    const inputs = yield* readAskInputs(input.threadId).pipe(
      Effect.mapError(failure("Could not read the thread.")),
    );
    if (inputs === null) return { text: null, generated: false } satisfies AttentionThreadAsk;
    const { ask, summarize } = deterministicThreadAsk(inputs);
    if (!summarize) return ask;
    const settings = yield* attentionSettings;
    if (!settings.completionSummaries) return ask;
    const summary = yield* Cache.get(summaryCache, `${input.threadId}\n${input.key}`);
    return summary === null ? ask : { ...ask, text: summary, generated: true };
  });

  const rerank = Effect.fn("AttentionService.rerank")(function* (input: AttentionRerankInput) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failure("Could not read settings.")),
    );
    if (!settings.attention.llmRerank) {
      return yield* new AttentionError({ message: "AI re-ranking is turned off." });
    }
    if (input.candidates.length < 2) {
      return { orderedIds: input.candidates.map((candidate) => candidate.id) };
    }
    const recent = yield* store
      .recentDecisions(RECENT_DECISIONS_FOR_RERANK)
      .pipe(Effect.mapError(failure("Could not read the decision log.")));
    const prompt = buildRerankPrompt({
      preferences: yield* Ref.get(preferences),
      recent,
      candidates: input.candidates,
    });
    const reply = yield* Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attention-" });
        return yield* textGeneration.generateTranscriptionPostProcessing({
          cwd,
          prompt,
          modelSelection: settings.textGenerationModelSelection,
        });
      }),
    ).pipe(Effect.timeout(RERANK_TIMEOUT), Effect.mapError(failure("The re-ranker failed.")));
    return { orderedIds: parseRerankReply(reply.transcription, input.candidates) };
  });

  return AttentionService.of({
    start,
    subscribe,
    act,
    threadAsk,
    readPreferences: fileLock.withPermits(1)(
      readPreferencesText.pipe(
        Effect.map((text) => ({
          path: preferencesPath,
          text: text ?? DEFAULT_ATTENTION_PREFERENCES,
        })),
        Effect.mapError(failure("Could not read the preferences file.")),
      ),
    ),
    writePreferences: Effect.fn("AttentionService.writePreferences")(function* (input) {
      yield* fileLock.withPermits(1)(writePreferencesText(input.text));
    }),
    resetLearning: store.resetLearning.pipe(
      Effect.mapError(failure("Could not reset learning.")),
      Effect.andThen(refreshLearning),
    ),
    rerank,
  });
});

export const layer = Layer.effect(AttentionService, make);
