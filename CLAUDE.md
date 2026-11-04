# Working on Ask Lotus

## Model roles
- Opus is the lead: plans changes, makes design/architecture calls, reviews every diff before it is committed.
- Delegate to cheaper models via subagents:
  - Sonnet: end-to-end testing (Playwright against a local Postgres), multi-file builds Opus has specified.
  - Haiku: mechanical work: SOP data edits, copy changes, lint-level fixes, searching.
- Subagents report back; Opus verifies before merging their changes.

## Code map
- Use Graphify (repo akashp50-cpu/ask-lotus) for structure questions: where things are defined, callers/callees, change impact. Read the current file when a result looks stale.

## Layout
- `src/server.js` all API routes; `src/ai.js` provider layer; `src/match.js` keyword ranking; `src/crypto.js` key encryption; `src/db.js` pool.
- `db/schema.sql`, `db/migrate.js`, `db/seed.js`, `db/seed-data/hampton-sops.json` (234 SOPs).
- `public/index.html`, `public/style.css`, `public/app.js` (no inline scripts: CSP is script-src 'self').

## Rules
- Front desk wording: say "PEP" (HotelKey NextGen), folio is V2, "Copy Reservation", night audit = Night Audit tab, Start.
- Property is cashless.
- Never show [CHECK] text to staff.
