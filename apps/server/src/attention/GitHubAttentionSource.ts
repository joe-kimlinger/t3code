import { AttentionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import type { AttentionSource } from "./AttentionSource.ts";
import { githubAttentionItems } from "./githubAttention.ts";

const LIST_LIMIT = 50;

/** Open PRs on the environment's projects' GitHub repositories, read through the PR list. */
export const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  return {
    id: "github",
    intervalMs: 3 * 60_000,
    maxBackoffMs: 15 * 60_000,
    enabled: (settings) => settings.githubEnabled,
    poll: Effect.fn("GitHubAttentionSource.poll")(function* (settings) {
      const [reviewing, authored] = yield* Effect.all(
        [
          settings.githubReviewRequested
            ? pullRequests.list({ state: "open", involvement: "reviewing", limit: LIST_LIMIT })
            : Effect.succeed(null),
          settings.githubFailingCi || settings.githubChangesRequested || settings.githubReadyToMerge
            ? pullRequests.list({ state: "open", involvement: "authored", limit: LIST_LIMIT })
            : Effect.succeed(null),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(
          (cause) => new AttentionError({ message: "Could not list pull requests.", cause }),
        ),
      );
      const results = [reviewing, authored].filter((result) => result !== null);
      const githubProviders = results
        .flatMap((result) => result.providers)
        .filter((provider) => provider.kind === "github");
      const errors = results.flatMap((result) => result.errors);
      const items = githubAttentionItems({
        reviewing: (reviewing?.entries ?? []).filter((entry) => entry.provider === "github"),
        authored: (authored?.entries ?? []).filter((entry) => entry.provider === "github"),
        filters: settings,
      });
      if (results.length > 0 && githubProviders.length === 0) {
        return {
          items,
          status: { state: "unavailable", detail: "No project uses a GitHub repository." },
        } as const;
      }
      const unconfigured = githubProviders.find((provider) => !provider.configured);
      return {
        items,
        status:
          unconfigured !== undefined
            ? { state: "unavailable", detail: unconfigured.detail ?? "GitHub is not signed in." }
            : errors.length > 0
              ? { state: "error", detail: errors.map((error) => error.message).join("; ") }
              : { state: "ok", detail: null },
      } as const;
    }),
  } satisfies AttentionSource;
});
