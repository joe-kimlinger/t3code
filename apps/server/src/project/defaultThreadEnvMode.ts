import { T3_PROJECT_FILE_NAME, type ThreadEnvMode } from "@t3tools/contracts";
import { resolveProjectFileBackedSetting } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** The composer falls back to the project's t3.json when no setting picks the mode. */
export const defaultThreadEnvMode = Effect.fn("project.defaultThreadEnvMode")(function* (
  setting: ThreadEnvMode | null,
  workspaceRoot: string,
) {
  if (setting !== null) return setting;
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(`${workspaceRoot}/${T3_PROJECT_FILE_NAME}`)
    .pipe(Effect.orElseSucceed(() => null));
  return resolveProjectFileBackedSetting(
    "defaultThreadEnvMode",
    null,
    contents === null ? null : parseT3ProjectFile(contents),
  ).value;
});
