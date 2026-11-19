import { describe, expect, it } from "vite-plus/test";

import {
  addMute,
  addWeight,
  DEFAULT_ATTENTION_PREFERENCES,
  parseAttentionPreferences,
  removeMute,
} from "./attentionPreferences.ts";

describe("parseAttentionPreferences", () => {
  it("reads rules, mutes and weights and reports lines it cannot read", () => {
    const text = [
      "# Attention preferences",
      "Intro text is ignored.",
      "## Rules",
      "Description lines are not rules.",
      "- Reviews for the platform team matter most",
      "## Mutes",
      "- author: dependabot[bot]",
      "- source: github, repo: `acme/legacy`",
      "- colour: blue",
      "```",
      "- author: inside-a-fence",
      "```",
      "## Weights",
      "- more: kind: review_requested",
      "- LESS: source: github, author: renovate[bot]",
      "- sometimes: kind: ci_failing",
      "## Notes",
      "- author: not-a-mute",
    ].join("\n");

    expect(parseAttentionPreferences(text, "/prefs.md")).toEqual({
      path: "/prefs.md",
      rules: ["Reviews for the platform team matter most"],
      mutes: [{ author: "dependabot[bot]" }, { source: "github", repo: "acme/legacy" }],
      weights: [
        { direction: "more", match: { kind: "review_requested" } },
        { direction: "less", match: { source: "github", author: "renovate[bot]" } },
      ],
      problems: ["- colour: blue", "- sometimes: kind: ci_failing"],
    });
  });

  it("parses the default file without problems or structured entries", () => {
    const parsed = parseAttentionPreferences(DEFAULT_ATTENTION_PREFERENCES, "p");
    expect(parsed.problems).toEqual([]);
    expect(parsed.mutes).toEqual([]);
    expect(parsed.weights).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
  });
});

describe("preference edits", () => {
  it("appends a mute as the section's last bullet and keeps other sections intact", () => {
    const text = ["## Mutes", "", "- author: a", "", "## Weights", "- more: kind: x", ""].join(
      "\n",
    );
    const next = addMute(text, { source: "github", repo: "acme/web" });
    expect(next).toBe(
      [
        "## Mutes",
        "",
        "- author: a",
        "- source: github, repo: acme/web",
        "",
        "## Weights",
        "- more: kind: x",
        "",
      ].join("\n"),
    );
    expect(addMute(next, { repo: "acme/web", source: "github" })).toBe(next);
    expect(removeMute(next, { source: "github", repo: "acme/web" })).toBe(text);
  });

  it("creates a missing section and leaves a gap after description lines", () => {
    expect(addWeight("# Prefs", { direction: "less", match: { author: "bot" } })).toBe(
      "# Prefs\n\n## Weights\n\n- less: author: bot\n",
    );
    const withDefault = addWeight(DEFAULT_ATTENTION_PREFERENCES, {
      direction: "more",
      match: { source: "github", kind: "review_requested" },
    });
    expect(parseAttentionPreferences(withDefault, "p").weights).toEqual([
      { direction: "more", match: { source: "github", kind: "review_requested" } },
    ]);
    expect(withDefault).toContain("`\n\n- more: source: github, kind: review_requested\n");
  });
});
