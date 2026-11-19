# daredevil

Accessibility auditing. A deterministic TypeScript CLI (Playwright + axe-core) crawls a URL's
path, scores it and writes reports. The `daredevil` subagent (`.claude/agents/daredevil.md`)
runs the CLI and adds AI-assisted review, a human summary and a fix handoff.

## Commands
- `npm run -s audit -- <url> [--max-pages N] [--same-pages prev/report.json] [--auth .auth/<host>.json]`: writes `reports/<site-slug>/<timestamp>/` (`<site-slug>_auth` when logged in)
- `npm run -s login -- <url>`: headed browser, the user logs in by hand, saves the Playwright storage state to `.auth/<host>.json` (0600, git-ignored)
- `npm run -s diff -- before.json after.json`
- `npm run -s render -- <reportDir>`: rebuilds `report.md` / `report.html` / `fix-prompt.md`, including the agent's files if present
- `npm test` (unit tests + an e2e test against `test/fixtures/site`), `npm run typecheck`

## Layout
- `src/cli.ts`: argument parsing, report directory, auto-diff with the previous run of the same scope
- `src/crawl.ts`: URL normalisation and scope (`/shop` matches `/shop/**`, not `/shopping`)
- `src/audit.ts`: browser and BFS crawl, axe scan per page, conversion of axe results
- `src/probes.ts`: keyboard probe and image inventory (assisted, not scored)
- `src/group.ts`: root-cause signatures and grouping (group `id` is stable across runs)
- `src/score.ts`: scoring model, see the header comment
- `src/report.ts`: report.json assembly, diff, markdown
- `src/fixprompt.ts`: `fix-prompt.md`, the AI fix prompt: findings bucketed by fix category (rule table, then WCAG fallback), one merge request per category
- `src/html.ts`: self-contained HTML report (escapes all site-derived content; must itself stay accessible)
- `src/explain.ts` + `assets/explanations.json`: plain-language "for dummies" explanation per axe rule (what is at stake, who is affected, fix, before/after), written by the daredevil agent; shown behind a "?" button on each defect in `report.html`. A unit test requires an entry for every in-scope axe rule, so an axe-core upgrade that adds rules means adding entries
- `src/auth.ts`: session capture (`login`), session loading, login-page and logout-link detection
- `src/consent.ts`: cookie-dialog dismissal ("reject", never "accept")
- `src/brand.ts`: embeds `assets/logo.svg` (inline header logo + favicon)
- `docs/ux-guidelines.md`: brand and UX guidelines; its "Implementation notes" list the verified contrast values to use

## When the daredevil subagent returns
Subagents cannot write report files, so the agent returns its deliverables as text. When its final message arrives:
1. Take `REPORT_DIR:` from it, and check that the folder exists and contains `report.json`.
2. For each `<<<FILE name>>> … <<<END FILE>>>` block, write the content verbatim to `<REPORT_DIR>/<name>`. Only accept `assisted.json`, `summary.md` and `handoff.md`. Make sure `assisted.json` parses as JSON.
3. Run `npm run -s render -- <REPORT_DIR>`, then give the user the brief and the path of `report.html`.

## Invariants
- UI (report.html) follows `docs/ux-guidelines.md`. Check contrast numerically before adding a colour: the original token table overstates some ratios.
- Any change to the scoring formula or constants: bump `SCORING_VERSION` in `src/score.ts`. Changing grouping signatures changes group ids: note it, since diffs across that change show false "fixed/new".
- Code passed to `page.evaluate` must not contain named functions (`const f = () => …`): tsx/esbuild injects a `__name` helper that does not exist in the browser.
- The score is computed only by code; the agent never adjusts it.
- Logged-in audits: never handle credentials (the user logs in in the headed window), never put session-file content in a report or a message, never follow logout links (`LOGOUT_URL`), and keep image screenshots off by default (personal data).
- Keep dependency versions pinned (exact): axe-core upgrades change rules and therefore scores.
