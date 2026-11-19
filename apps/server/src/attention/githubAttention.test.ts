import {
  ProjectId,
  SourceControlProviderKind,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { githubAttentionItems, type GitHubAttentionFilters } from "./githubAttention.ts";

const ALL: GitHubAttentionFilters = {
  githubReviewRequested: true,
  githubFailingCi: true,
  githubChangesRequested: true,
  githubReadyToMerge: true,
};

const entry = (
  number: number,
  overrides: Partial<PullRequestListEntry> = {},
): PullRequestListEntry => ({
  provider: SourceControlProviderKind.make("github"),
  host: "github.com",
  projectId: ProjectId.make("web"),
  projectTitle: "Web",
  repository: "acme/web",
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  author: { login: "alice", name: null, avatarUrl: null },
  headBranch: `feature-${number}`,
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "unknown",
  additions: 0,
  deletions: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  viewerReviewRequested: false,
  labels: [],
  ...overrides,
});

describe("githubAttentionItems", () => {
  it("maps review requests and the most urgent need of each authored PR", () => {
    const items = githubAttentionItems({
      reviewing: [
        entry(1, { viewerReviewRequested: true }),
        // Drafts and PRs whose request was already answered are not asks.
        entry(2, { viewerReviewRequested: true, isDraft: true }),
        entry(3, { viewerReviewRequested: false }),
      ],
      authored: [
        entry(10, { reviewDecision: "changes-requested", checksState: "failing" }),
        entry(11, { checksState: "failing" }),
        entry(12, {
          reviewDecision: "approved",
          mergeability: "mergeable",
          checksState: "passing",
        }),
        // Pending checks and conflicts are not ready yet.
        entry(13, {
          reviewDecision: "approved",
          mergeability: "mergeable",
          checksState: "pending",
        }),
        entry(14, { reviewDecision: "approved", mergeability: "conflicting" }),
        entry(15, { state: "merged", checksState: "failing" }),
      ],
      filters: ALL,
    });
    expect(items.map((item) => [item.id, item.kind])).toEqual([
      ["github:github.com/acme/web#1", "review_requested"],
      ["github:github.com/acme/web#10", "changes_requested"],
      ["github:github.com/acme/web#11", "ci_failing"],
      ["github:github.com/acme/web#12", "ready_to_merge"],
    ]);
    expect(items[1]).toMatchObject({
      source: "github",
      repo: "acme/web",
      author: "alice",
      number: 10,
      detail: "acme/web#10",
      signals: ["review:changes-requested", "checks:failing", "mergeable:unknown"],
      actions: ["open_url", "prepare_thread", "hand_to_agent", "snooze", "dismiss"],
    });
  });

  it("falls through to the next need when a kind is filtered out", () => {
    const items = githubAttentionItems({
      reviewing: [entry(1, { viewerReviewRequested: true })],
      authored: [entry(10, { reviewDecision: "changes-requested", checksState: "failing" })],
      filters: { ...ALL, githubReviewRequested: false, githubChangesRequested: false },
    });
    expect(items.map((item) => item.kind)).toEqual(["ci_failing"]);
  });
});
