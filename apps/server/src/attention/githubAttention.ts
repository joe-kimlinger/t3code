import type {
  AttentionGitHubKind,
  AttentionItem,
  AttentionSettings,
  PullRequestListEntry,
} from "@t3tools/contracts";

export type GitHubAttentionFilters = Pick<
  AttentionSettings,
  "githubReviewRequested" | "githubFailingCi" | "githubChangesRequested" | "githubReadyToMerge"
>;

const githubAttentionItemId = (
  entry: Pick<PullRequestListEntry, "host" | "repository" | "number">,
) => `github:${entry.host}/${entry.repository}#${entry.number}`;

function signalsOf(entry: PullRequestListEntry): string[] {
  return [
    ...(entry.viewerReviewRequested ? ["review-requested"] : []),
    ...(entry.reviewDecision === undefined ? [] : [`review:${entry.reviewDecision}`]),
    ...(entry.checksState === undefined ? [] : [`checks:${entry.checksState}`]),
    `mergeable:${entry.mergeability}`,
    ...(entry.isDraft ? ["draft"] : []),
  ];
}

/** The one thing a PR the user wrote needs from them, most urgent first. */
function authoredKind(
  entry: PullRequestListEntry,
  filters: GitHubAttentionFilters,
): AttentionGitHubKind | null {
  if (filters.githubChangesRequested && entry.reviewDecision === "changes-requested") {
    return "changes_requested";
  }
  if (filters.githubFailingCi && entry.checksState === "failing") return "ci_failing";
  if (
    filters.githubReadyToMerge &&
    !entry.isDraft &&
    entry.reviewDecision === "approved" &&
    entry.mergeability === "mergeable" &&
    entry.checksState !== "failing" &&
    entry.checksState !== "pending"
  ) {
    return "ready_to_merge";
  }
  return null;
}

function toItem(entry: PullRequestListEntry, kind: AttentionGitHubKind): AttentionItem {
  return {
    id: githubAttentionItemId(entry),
    source: "github",
    kind,
    title: entry.title,
    detail: `${entry.repository}#${entry.number}`,
    url: entry.url,
    repo: entry.repository,
    author: entry.author?.login ?? null,
    projectId: entry.projectId,
    number: entry.number,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    signals: signalsOf(entry),
    actions: ["open_url", "prepare_thread", "hand_to_agent", "snooze", "dismiss"],
  };
}

/** Maps open PR listings to items, at most one per PR. */
export function githubAttentionItems(input: {
  readonly reviewing: ReadonlyArray<PullRequestListEntry>;
  readonly authored: ReadonlyArray<PullRequestListEntry>;
  readonly filters: GitHubAttentionFilters;
}): AttentionItem[] {
  const items = new Map<string, AttentionItem>();
  if (input.filters.githubReviewRequested) {
    for (const entry of input.reviewing) {
      if (entry.state !== "open" || entry.isDraft || !entry.viewerReviewRequested) continue;
      items.set(githubAttentionItemId(entry), toItem(entry, "review_requested"));
    }
  }
  for (const entry of input.authored) {
    if (entry.state !== "open") continue;
    const kind = authoredKind(entry, input.filters);
    if (kind !== null) items.set(githubAttentionItemId(entry), toItem(entry, kind));
  }
  return [...items.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}
