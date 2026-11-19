import type { AttentionMatcher, AttentionPreferences, AttentionWeight } from "@t3tools/contracts";

/**
 * The preferences file is markdown the user edits by hand. Three `##` sections matter:
 * Rules (free text bullets), Mutes (`- field: value, field: value`) and Weights
 * (`- more: field: value` or `- less: ...`). Everything else is kept and ignored.
 */
export const ATTENTION_PREFERENCES_FILE_NAME = "attention-preferences.md";

const MATCHER_FIELDS = ["source", "kind", "repo", "author", "channel", "project"] as const;
type MatcherField = (typeof MATCHER_FIELDS)[number];

type Section = "rules" | "mutes" | "weights";
const SECTION_TITLES: Record<Section, string> = {
  rules: "Rules",
  mutes: "Mutes",
  weights: "Weights",
};

export const DEFAULT_ATTENTION_PREFERENCES = `# Attention preferences

Tune the attention panel here. It reloads as soon as you save.

## Rules

Plain-English notes about what matters to you. The optional AI re-ranker reads these.

- Requests from my agents come before GitHub notifications.

## Mutes

Hide matching items. Fields: source, kind, repo, author, channel, project.
Example: \`- source: github, author: dependabot[bot]\`

## Weights

Rank matching items higher (more) or lower (less).
Example: \`- more: source: github, kind: review_requested\`
`;

const HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;

function sectionOf(heading: string): Section | null {
  const title = heading.toLowerCase();
  if (title === "rules") return "rules";
  if (title === "mutes") return "mutes";
  if (title === "weights") return "weights";
  return null;
}

const isMatcherField = (value: string): value is MatcherField =>
  (MATCHER_FIELDS as ReadonlyArray<string>).includes(value);

/** `source: github, author: bob` → matcher; null when any part is unreadable. */
function parseMatcher(text: string): AttentionMatcher | null {
  const matcher: Partial<Record<MatcherField, string>> = {};
  for (const part of text.split(",")) {
    const separator = part.indexOf(":");
    if (separator < 0) return null;
    const field = part.slice(0, separator).trim().toLowerCase();
    const value = part
      .slice(separator + 1)
      .trim()
      .replace(/^`|`$/g, "");
    if (!isMatcherField(field) || value.length === 0) return null;
    matcher[field] = value;
  }
  return Object.keys(matcher).length === 0 ? null : matcher;
}

export function formatMatcher(matcher: AttentionMatcher): string {
  return MATCHER_FIELDS.flatMap((field) => {
    const value = matcher[field];
    return value === undefined ? [] : [`${field}: ${value}`];
  }).join(", ");
}

function parseWeight(text: string): AttentionWeight | null {
  const match = /^(more|less)\s*:\s*(.+)$/i.exec(text);
  if (match === null) return null;
  const parsed = parseMatcher(match[2]!);
  if (parsed === null) return null;
  return { direction: match[1]!.toLowerCase() === "more" ? "more" : "less", match: parsed };
}

export function parseAttentionPreferences(text: string, path: string): AttentionPreferences {
  const rules: string[] = [];
  const mutes: AttentionMatcher[] = [];
  const weights: AttentionWeight[] = [];
  const problems: string[] = [];
  let section: Section | null = null;
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      section = sectionOf(heading[1]!);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet === null || section === null) continue;
    const content = bullet[1]!;
    if (section === "rules") {
      rules.push(content);
    } else if (section === "mutes") {
      const matcher = parseMatcher(content);
      if (matcher === null) problems.push(line.trim());
      else mutes.push(matcher);
    } else {
      const weight = parseWeight(content);
      if (weight === null) problems.push(line.trim());
      else weights.push(weight);
    }
  }
  return { path, rules, mutes, weights, problems };
}

const sameMatcher = (left: AttentionMatcher, right: AttentionMatcher) =>
  formatMatcher(left) === formatMatcher(right);

/** Adds `- <entry>` as the last bullet of `section`, creating the section when missing. */
function appendToSection(text: string, section: Section, entry: string): string {
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const heading = HEADING.exec(lines[index]!);
    if (heading === null) continue;
    if (start >= 0) {
      end = index;
      break;
    }
    if (sectionOf(heading[1]!) === section) start = index;
  }
  const bullet = `- ${entry}`;
  if (start < 0) {
    const body = text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
    return `${body}\n## ${SECTION_TITLES[section]}\n\n${bullet}\n`;
  }
  let insertAt = start + 1;
  for (let index = start + 1; index < end; index++) {
    if (lines[index]!.trim().length > 0) insertAt = index + 1;
  }
  const previous = lines[insertAt - 1] ?? "";
  const needsGap = !BULLET.test(previous) && previous.trim().length > 0;
  lines.splice(insertAt, 0, ...(needsGap ? ["", bullet] : [bullet]));
  return lines.join("\n");
}

export function addMute(text: string, matcher: AttentionMatcher): string {
  const current = parseAttentionPreferences(text, "");
  if (current.mutes.some((mute) => sameMatcher(mute, matcher))) return text;
  return appendToSection(text, "mutes", formatMatcher(matcher));
}

export function addWeight(text: string, weight: AttentionWeight): string {
  const current = parseAttentionPreferences(text, "");
  const duplicate = current.weights.some(
    (existing) =>
      existing.direction === weight.direction && sameMatcher(existing.match, weight.match),
  );
  if (duplicate) return text;
  return appendToSection(text, "weights", `${weight.direction}: ${formatMatcher(weight.match)}`);
}

/** Removes every Mutes bullet equal to `matcher`, leaving the rest of the file untouched. */
export function removeMute(text: string, matcher: AttentionMatcher): string {
  let section: Section | null = null;
  return text
    .split("\n")
    .filter((line) => {
      const heading = HEADING.exec(line);
      if (heading !== null) {
        section = sectionOf(heading[1]!);
        return true;
      }
      const bullet = BULLET.exec(line);
      if (section !== "mutes" || bullet === null) return true;
      const parsed = parseMatcher(bullet[1]!);
      return parsed === null || !sameMatcher(parsed, matcher);
    })
    .join("\n");
}
