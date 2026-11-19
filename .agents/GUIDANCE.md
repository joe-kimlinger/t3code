# Owner guidance

Standing rules from this fork's owner. They apply to every task in this repository and override the defaults in AGENTS.md where the two disagree. Add to this file with the [record-guidance](skills/record-guidance/SKILL.md) skill.

## Showing work

- **Screenshot new UI.** When you build or change something a user can see (a control, panel, settings section, dialog, or layout), capture screenshots of each new surface in a real client and show them in your final report and in the PR body. A text description or DOM check is not enough. Use [test-t3-app](skills/test-t3-app/SKILL.md); if its Browser panel cannot take a screenshot, use headless Chrome through the repo's `playwright` package instead of skipping the screenshots.
  _Why: the owner wants to see what new things look like, not read about them._
