import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";

const layerTest = KnownWorkspaces.layer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provide(
    Layer.mock(GitVcsDriver.GitVcsDriver)({ listWorktreePaths: () => Effect.succeed([]) }),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "known-workspaces-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest)("KnownWorkspaces", (it) => {
  it.effect("knows a project's linked folders only while the project links them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const workspaces = yield* KnownWorkspaces.KnownWorkspaces;
      const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "known-linked-" });
      const app = `${fixture}/app`;
      const api = `${fixture}/api`;
      const other = `${fixture}/other`;
      for (const folder of [app, `${api}/src`, other]) {
        yield* fileSystem.makeDirectory(folder, { recursive: true });
      }
      const projectId = ProjectId.make("project-known-linked");
      const at = "2026-03-24T00:00:00.000Z";
      const event = { aggregateKind: "project", aggregateId: projectId, occurredAt: at } as const;
      const meta = { commandId: null, causationEventId: null, correlationId: null, metadata: {} };
      yield* projects.apply({
        ...event,
        ...meta,
        sequence: 1,
        eventId: EventId.make("event-known-linked-created"),
        type: "project.created",
        payload: {
          projectId,
          title: "Linked",
          workspaceRoot: app,
          additionalRoots: [api],
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      });

      yield* workspaces.assertContains(`${api}/src`);
      const unrelated = yield* workspaces.assertContains(other).pipe(Effect.flip);
      assert.equal(unrelated._tag, "UnknownWorkspaceError");

      yield* projects.apply({
        ...event,
        ...meta,
        sequence: 2,
        eventId: EventId.make("event-known-linked-unlinked"),
        type: "project.meta-updated",
        payload: { projectId, additionalRoots: [], updatedAt: at },
      });
      const unlinked = yield* workspaces.assertContains(`${api}/src`).pipe(Effect.flip);
      assert.equal(unlinked._tag, "UnknownWorkspaceError");
    }).pipe(Effect.scoped),
  );
});
