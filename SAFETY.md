# 🛡️ Safety & Double-Approval Protocol

To ensure full user control, safety, and project permanence, the following protocol is MANDATORY for all future modifications to the **Miva Bot** project.

## The Two Levels of Manual Approval

### Level 1: Approval of the Concept (Plan)
Before any code is written, I (the AI) must present a detailed `implementation_plan.md`.
- **Content**: Must outline the goal, the strategy, and what files will be affected.
- **Action**: You must read and approve this plan before I proceed to Level 2.

### Level 2: Approval of the Final Diff (Proposed Code)
After the Plan is approved, I must prepare a `PROPOSED_CHANGES.md` (or a similar artifact).
- **Content**: A complete list of the exact lines I intend to change, presented as a "Draft Diff".
- **Action**: You must review the specific code changes and give a **second manual approval**. 
- **Rule**: I am strictly forbidden from using any `replace_file_content` or `multi_replace_file_content` tools until this second approval is received.

---

## Permanence through Version Control
- All approved changes must be immediately committed to **Git**.
- This creates a permanent, searchable record of every update.
- **Command**: `git add . && git commit -m "Description of change"`

## Crash Protection
- The bot is managed by **PM2**. It should stay online 24/7.
- **Command**: `npx pm2 status miva-bot`

---
*Protocol established on April 3rd, 2026.*
