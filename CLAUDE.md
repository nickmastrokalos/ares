# CLAUDE.md

## Core Principles
- Do not use CDNs for any dependencies. All assets must be installed and managed locally.
- Maintain strict consistency across the codebase (patterns, naming, structure, and UI).
- Prefer clarity and maintainability over clever or complex implementations.
- Do not introduce new patterns if an existing one already solves the problem.

---

## Workflow Rules
- Always create and checkout a new branch before starting work.
- Do not begin implementation immediately.
- First:
  1. Review relevant documentation in /docs
  2. Understand existing architecture and patterns
  3. Propose a plan
- Only proceed with implementation after the plan is clear and aligned.

---

## Documentation Requirements
- A /docs directory must exist and be actively maintained.
- Documentation should be organized by concern, including but not limited to:
  - /docs/backend.md
  - /docs/frontend.md
  - /docs/styles.md
  - /docs/database.md
- These documents are the source of truth for system design decisions.
- AGENTS.md must reference and reinforce these documents.
- Any change in behavior, architecture, or patterns must be reflected in the appropriate doc.

---

## Styling & UI Consistency
- All styles must be centralized (no scattered or inline styling unless justified).
- Use a single, consistent design system across the application.
- Avoid duplicating layout or component patterns.
- Reuse components wherever possible.
- Ensure visual consistency across all views (spacing, typography, colors, interactions).

---

## Code Organization
- Follow the existing project structure strictly.
- Do not introduce new top-level patterns or directories without justification.
- Group related logic by domain (e.g., connectors, services, widgets).
- Avoid duplication — refactor shared logic into reusable modules.

---

## Performance & Efficiency
- Be mindful of performance, especially:
  - Database access patterns
  - Rendering performance (frontend)
  - Network usage (connectors, polling)
- Avoid unnecessary re-renders, queries, or polling loops.
- Prefer efficient data handling over convenience.

---

## Safety & Discipline
- Do not make assumptions about missing context — ask or investigate.
- Do not modify unrelated code.
- Keep changes scoped and intentional.
- If something is unclear or inconsistent, flag it before proceeding.

---

## Agent Behavior Expectations
- Act like a senior engineer, not an autocomplete tool.
- Think before coding.
- Explain reasoning when making non-obvious decisions.
- Default to refactoring and improving consistency when touching existing code.
