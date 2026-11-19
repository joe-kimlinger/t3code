import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    /**
     * One thread deletion plans and commits at a time: each decides what its deleted fork
     * sources keep for the forks still alive. Take it before any thread lock.
     */
    readonly withDeletionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * One thread arrangement per project at a time, so two moves cannot each pass the cycle
     * check against the other's old state. Take it before the moved thread's lock.
     */
    readonly withArrangementLock: <A, E, R>(
      projectId: ProjectId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const make = Effect.gen(function* () {
  const deletion = yield* Semaphore.make(1);
  const arrangement = yield* KeyedLock.make<ProjectId>();
  return ThreadCommandExecutor.of({
    ...(yield* KeyedLock.make<ThreadId>()),
    withDeletionLock: Effect.fn("ThreadCommandExecutor.withDeletionLock")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* deletion.withPermit(effect);
    }),
    withArrangementLock: arrangement.withLock,
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
