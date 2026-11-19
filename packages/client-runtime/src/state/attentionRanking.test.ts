import type { AttentionPreferences } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionMatches,
  rankAttention,
  scoreAttention,
  type AttentionCandidate,
  type AttentionRankingInputs,
} from "./attentionRanking.ts";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const hoursAgo = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(NOW - hours * 3_600_000));

const candidate = (
  id: string,
  overrides: Partial<AttentionCandidate<null>> = {},
): AttentionCandidate<null> => ({
  id,
  source: "thread",
  kind: "completed",
  since: hoursAgo(0),
  repo: null,
  author: null,
  project: null,
  payload: null,
  ...overrides,
});

const preferences = (overrides: Partial<AttentionPreferences> = {}): AttentionPreferences => ({
  path: "prefs.md",
  rules: [],
  mutes: [],
  weights: [],
  problems: [],
  ...overrides,
});

const inputs = (overrides: Partial<AttentionRankingInputs> = {}): AttentionRankingInputs => ({
  preferences: null,
  learning: [],
  nowMs: NOW,
  ...overrides,
});

describe("scoreAttention", () => {
  it("adds severity, a capped age bonus, weights and learned act-rates, and says why", () => {
    const review = candidate("pr", {
      source: "github",
      kind: "review_requested",
      author: "bob",
      repo: "acme/web",
      since: hoursAgo(3),
    });
    const scored = scoreAttention(
      review,
      inputs({
        preferences: preferences({
          weights: [
            { direction: "more", match: { kind: "github/review_requested" } },
            { direction: "less", match: { repo: "acme/other" } },
          ],
        }),
        learning: [
          // Acts on everything bob sends: full confidence at 10 decisions.
          { feature: "author:github/bob", acted: 10, dismissed: 0, ignored: 0 },
          // Too few decisions to count.
          { feature: "repo:github/acme/web", acted: 0, dismissed: 2, ignored: 0 },
        ],
      }),
    );
    expect(scored.reasons).toEqual([
      { code: "signal", kind: "review_requested", points: 70 },
      { code: "age", hours: 3, points: 8 },
      {
        code: "weight",
        direction: "more",
        match: { kind: "github/review_requested" },
        points: 25,
      },
      { code: "learning", feature: "author:github/bob", acted: 10, total: 10, points: 20 },
    ]);
    expect(scored.score).toBe(70 + 8 + 25 + 20);
    expect(scored.muted).toBe(false);
    // Age points stop growing.
    expect(scoreAttention(candidate("old", { since: hoursAgo(10_000) }), inputs()).score).toBe(
      50 + 20,
    );
  });

  it("matches mutes on every named field, case-insensitively", () => {
    const bot = candidate("pr", { source: "github", kind: "ci_failing", author: "Renovate[bot]" });
    expect(attentionMatches({ author: "renovate[bot]" }, bot)).toBe(true);
    expect(attentionMatches({ author: "@renovate[bot]", source: "github" }, bot)).toBe(true);
    expect(attentionMatches({ author: "renovate[bot]", source: "thread" }, bot)).toBe(false);
    expect(attentionMatches({}, bot)).toBe(false);
    const muted = scoreAttention(
      bot,
      inputs({ preferences: preferences({ mutes: [{ author: "renovate[bot]" }] }) }),
    );
    expect(muted.muted).toBe(true);
    expect(muted.reasons).toContainEqual({ code: "mute", match: { author: "renovate[bot]" } });
  });
});

describe("rankAttention", () => {
  it("rolls nested threads up under their root and splits Now at the limit", () => {
    const tree: Record<string, { key: string; descendantCount: number }> = {
      parent: { key: "parent", descendantCount: 4 },
      childA: { key: "parent", descendantCount: 4 },
      childB: { key: "parent", descendantCount: 4 },
    };
    const sections = rankAttention({
      candidates: [
        candidate("childA", { kind: "approval" }),
        candidate("childB", { kind: "failed" }),
        candidate("parent", { kind: "completed" }),
        candidate("solo", { kind: "input" }),
        candidate("pr", { source: "github", kind: "ready_to_merge" }),
        candidate("noisy", { source: "github", kind: "ci_failing", repo: "acme/legacy" }),
      ],
      inputsOf: () => inputs({ preferences: preferences({ mutes: [{ repo: "acme/legacy" }] }) }),
      limit: 2,
      rootOf: (entry) => tree[entry.id] ?? null,
    });
    // The parent leads its group and ranks as its most urgent child plus 2 per extra member.
    expect(sections.now.map((group) => [group.lead.id, group.score, group.members.length])).toEqual(
      [
        ["parent", 104, 3],
        ["solo", 95, 1],
      ],
    );
    expect(sections.now[0]!.members.map((member) => member.id)).toEqual([
      "childA",
      "childB",
      "parent",
    ]);
    expect(sections.now[0]!.descendantCount).toBe(4);
    expect(sections.overflow.map((group) => group.lead.id)).toEqual(["pr"]);
    expect(sections.muted.map((entry) => entry.id)).toEqual(["noisy"]);
  });

  it("puts a re-ranker's order first and keeps score order for the rest", () => {
    const sections = rankAttention({
      candidates: [
        candidate("a", { kind: "approval" }),
        candidate("b", { kind: "input" }),
        candidate("c", { kind: "completed" }),
      ],
      inputsOf: () => inputs(),
      limit: 5,
      rootOf: () => null,
      preferredOrder: ["c", "missing"],
    });
    expect(sections.now.map((group) => group.lead.id)).toEqual(["c", "a", "b"]);
  });
});
