# token-radar-01 — resubmission notes (Round 2)

## Why Round 1 was rejected

- `thinking_reproduces` failed: only 252/1291 authored lines (19.5%) vs the
  30% the transcript gate requires. The Round 1 code was largely written
  outside the recorded agent sessions.

## What changed in Round 2

- All five code/dashboard files were rewritten from scratch inside recorded
  Codex sessions (model gpt-6.1-sol via AgentRouter, harness codex 0.169.0):
  `main.ts`, `lib/model.ts`, `dashboard/app.js`, `dashboard/index.html`,
  `dashboard/app.css`. `vendor/makefun-board.ts` was NOT touched (kit copy,
  byte for byte).
- Value model (`lib/model.ts`): fully dynamic, derived from the snapshot's
  own figures only — no hardcoded protocol names or slugs anywhere.
  Score = 40% log TVL + 20% clipped 7-day growth + 20% listing age
  (time running with no token recorded) + 10% chain breadth + 10%
  snapshot-derived category prior (category medians computed from the
  snapshot itself). Implied values use a snapshot-derived anchor
  (about $6.07M). Every row carries its score breakdown.
- Board: 240 rows, ALL pre-token protocols (both token fields null),
  watchlist 40/40 covered, plus 200 early discoveries below the $50M floor.
  Token-bearing protocols are NOT board rows; the top 12 by market cap are
  shown only as an "Already launched — not farmable" reference in the
  dashboard data.
- Farm plans: 5–7 steps per row (1,542 steps, 1,492 distinct), generated
  from each protocol's own category, chains, TVL tier and age, with concrete
  costs and time windows. No identical boilerplate across rows.
- Dashboard: dark research-desk theme; stats header, methodology box with
  the formula in plain words, sortable table, search / category / chain /
  min-TVL / watchlist-only filters, per-protocol detail dialog (score
  breakdown, farm checklist, recorded chains), launched-reference section.
  Dashboard source total 54,663 bytes (under the 65,536-byte dossier cap).
- Screenshots: regenerated against the NEW dashboard (the old ones showed
  the Round 1 page). Captured with headless Chromium via playwright-core
  (the Codex sandbox could not launch a browser, so the coordinator ran the
  capture from the generated output): 1-board.png (board), 2-detail.png
  (detail dialog for rank 1), 3-filtered.png (watchlist-only + Risk
  Curators, 12 rows). All 1440x900, 224–304 KB.

## Verification (local, before submit)

- `main.ts` run twice to separate outputs: byte-identical (`diff -r` clean).
- Gate self-check: 240 rows, all pre-token, ranks 1..240, implied values
  non-increasing, 40/40 watchlist, every farm_steps array 3–12 strings of
  20–600 chars, dashboard files within caps, no network URLs in
  HTML/CSS/JS, dossier 1,111,704 bytes (cap 1.5 MB). GATE-OK.
- `makefun check` with the transcript bundle: see coordinator report
  (transcripts = the two Codex session bundles; this competition does not
  take `makefun record` — the server returns HTTP 400 for it and requires
  bundle/loose-file transcript uploads instead).
- Top 5 by implied value: steakhouse-financial $21.50M, gauntlet $20.40M,
  upshift $17.43M, veda $16.90M, usdd $10.03M (USDD is on the snapshot's own
  watchlist, so it is ranked as the snapshot records it).

## Notes

- No claim code or secret is stored in this file or in the repository.
- Submission, claim code and recording/bundle identifiers are in the
  coordinator's report, not here.
