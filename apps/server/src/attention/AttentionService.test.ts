import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { AttentionItemFeatures, AttentionStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AttentionService from "./AttentionService.ts";
import * as AttentionStore from "./AttentionStore.ts";

const layer = AttentionService.layer.pipe(
  Layer.provideMerge(AttentionStore.layer),
  Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
  Layer.provide(Layer.mock(TextGeneration.TextGeneration)({})),
  Layer.provide(Layer.mock(PullRequestService.PullRequestService)({})),
  Layer.provide(
    ServerSettings.ServerSettingsService.layerTest({ attention: { githubEnabled: false } }),
  ),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-attention-test-" })),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const features: AttentionItemFeatures = {
  itemId: "github:github.com/acme/web#7",
  source: "github",
  kind: "review_requested",
  repo: "acme/web",
  author: "renovate[bot]",
  project: null,
  itemCreatedAt: null,
};

/** Starts the service and collects its stream, so a test can await the event it causes. */
const started = Effect.gen(function* () {
  const service = yield* AttentionService.AttentionService;
  yield* service.start();
  const events = yield* Queue.unbounded<AttentionStreamEvent>();
  yield* Stream.runForEach(service.subscribe(), (event) => Queue.offer(events, event)).pipe(
    Effect.forkScoped,
  );
  const next = <T extends AttentionStreamEvent["type"]>(type: T) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === type) return event as Extract<AttentionStreamEvent, { type: T }>;
      }
    });
  return { service, next };
});

describe("AttentionService", () => {
  // Real file watching, so the clock must be real too.
  it.live("hot-reloads a hand edit of the preferences file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { next } = yield* started;
        const snapshot = yield* next("snapshot");
        assert.deepStrictEqual(snapshot.preferences.mutes, []);
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(snapshot.preferences.path);
        yield* fs.writeFileString(
          snapshot.preferences.path,
          text.replace("## Mutes\n", "## Mutes\n\n- repo: acme/legacy\n"),
        );
        const reloaded = yield* next("preferences");
        assert.deepStrictEqual(reloaded.preferences.mutes, [{ repo: "acme/legacy" }]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.live("records decisions, edits preferences for feedback and keeps item states", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, next } = yield* started;
        yield* next("snapshot");

        yield* service.act({ features, action: "less" });
        const weighted = yield* next("preferences");
        assert.deepStrictEqual(weighted.preferences.weights.at(-1), {
          direction: "less",
          match: { source: "github", kind: "review_requested", author: "renovate[bot]" },
        });
        const learned = yield* next("learning");
        assert.deepInclude(learned.learning, {
          feature: "author:github/renovate[bot]",
          acted: 0,
          dismissed: 1,
          ignored: 0,
        });

        yield* service.act({
          features,
          action: "snoozed",
          itemState: {
            itemId: features.itemId,
            snoozedUntil: "2026-11-20T09:00:00.000Z",
            dismissedVersion: null,
          },
        });
        assert.deepStrictEqual((yield* next("item-states")).upserted, [
          {
            itemId: features.itemId,
            snoozedUntil: "2026-11-20T09:00:00.000Z",
            dismissedVersion: null,
          },
        ]);
        yield* service.act({
          features,
          action: "unsnoozed",
          itemState: { itemId: features.itemId, snoozedUntil: null, dismissedVersion: null },
        });
        assert.deepStrictEqual((yield* next("item-states")).removedIds, [features.itemId]);
        const store = yield* AttentionStore.AttentionStore;
        assert.deepStrictEqual(yield* store.listItemStates, []);

        yield* service.act({ features, action: "muted", match: { author: "renovate[bot]" } });
        assert.deepStrictEqual((yield* next("preferences")).preferences.mutes.at(-1), {
          author: "renovate[bot]",
        });
        yield* service.act({ features, action: "unmuted", match: { author: "renovate[bot]" } });
        assert.deepStrictEqual((yield* next("preferences")).preferences.mutes, []);

        yield* service.resetLearning;
        let cleared = yield* next("learning");
        while (cleared.learning.length > 0) cleared = yield* next("learning");
        assert.deepStrictEqual(cleared.learning, []);
      }),
    ).pipe(Effect.provide(layer)),
  );
});
