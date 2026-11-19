---
name: record-guidance
description: Record a standing preference from this fork's owner in .agents/GUIDANCE.md. Use whenever the user states general guidance that should apply to future work on this product, not just the current task, such as "when you build stuff I want screenshots", "always ...", "never ...", or "from now on ...".
---

# Record owner guidance

`.agents/GUIDANCE.md` holds the owner's standing rules. `AGENTS.md` points every agent at it, so a rule recorded there shapes all later work in this repository.

## Decide whether it is guidance

Record it when it is about how work on this product should be done in general: what to show, how to test, how to communicate, what to avoid. Do not record a one-off instruction for the task in front of you, a fact about the code (the code records that), or a personal detail. When unsure, record it; the owner can delete a line.

## Record it

1. Read `.agents/GUIDANCE.md`. If a rule already covers the point, sharpen that rule instead of adding a second one. If the new statement contradicts a rule, replace the old rule.
2. Write one bullet under the closest section, adding a section only when none fits. Lead with a short bold summary, then the rule as an instruction to an agent, then an italic `_Why:_` line in the owner's terms. Keep the owner's intent, not their wording; fix typos.
3. Apply the rule to the current task straight away.
4. Commit the change on its own, as `docs(agents): <the rule in a few words>`, on the current branch, without other work in the commit. Push only when the current task already pushes.
5. Tell the owner in one line that you recorded it and where.
