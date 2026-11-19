# daredevil

Accessibility auditing. A deterministic TypeScript CLI (Playwright + axe-core) crawls a URL's
path, scores it and writes reports. The `daredevil` subagent (`.claude/agents/daredevil.md`)
runs the CLI and adds AI-assisted review, a human summary and a fix handoff.

## Commands
- `npm run -s audit -- <url> [<url>...] [--max-pages N] [--same-pages prev/report.json] [--auth .auth/<host>.json]`: writes `reports/<site-slug>/<timestamp>/` (`<site-slug>_auth` when logged in). Several URLs (any hosts) = one combined audit: scopes `+`-joined in the slug, `--max-pages` shared evenly; in batch files, `url + url [label]` (.txt) or `"url": [..]` (.json)
- `npm run -s batch -- <list.txt|list.json> [--base URL] [--parallel N] [--same-pages-from <batch.json|dir|latest>] [audit options]`: one audit per entry, each in its usual `reports/<site-slug>/<timestamp>/`, plus `reports/_batches/<name>/<timestamp>/` with `batch.json`, `index.html` (every score, linking to each `report.html`) and `index.md` (file formats: `src/batch.ts` header)
- `npm run -s render-batch -- <batchDir>`: rebuilds `index.html` / `index.md` from `batch.json`, including the agent's `summary.md` if present and an "AI review" link for entries whose folder has one
- `... | npm run -s batch -- - --name <name> [--base URL]`: the list from stdin (how the agent runs batches: it cannot write files)
- `npm run -s login -- <url>`: headed browser, the user logs in by hand, saves the Playwright storage state to `.auth/<host>.json` (0600, git-ignored)
- `npm run -s diff -- before.json after.json`
- `npm run -s render -- <reportDir>`: rebuilds `report.md` / `report.html` / `fix-prompt.md`, including the agent's files if present
- `npm test` (unit tests + an e2e test against `test/fixtures/site`), `npm run typecheck`

## Layout
- `src/cli.ts`: argument parsing, the screenshot question, command dispatch
- `src/run.ts`: one audit end to end (option checks, config, crawl, report files); shared by `audit` and `batch`
- `src/batch.ts`: batch file parsing, option precedence, pre-flight checks, run pool (`--parallel`, one audit per origin at a time), `--same-pages-from`, `batch.json`, shared root causes (same group id in 2+ audits), comparison with the previous complete batch of the same name
- `src/crawl.ts`: URL normalisation and scope (`/shop` matches `/shop/**`, not `/shopping`); several scopes per audit (`startUrls` / `scopes` in the config, only when 2+), conflicts (same / nested scopes)
- `src/audit.ts`: browser and BFS crawl, axe scan per page, conversion of axe results
- `src/probes.ts`: keyboard probe and image inventory (assisted, not scored)
- `src/keyboard.ts`: plain-language reading of the keyboard probe (one verdict per check: finding, why it matters, what to do), shared by `report.html` and `report.md`
- `src/group.ts`: root-cause signatures and grouping (group `id` is stable across runs)
- `src/score.ts`: scoring model, see the header comment
- `src/report.ts`: report.json assembly, diff, markdown
- `src/fixprompt.ts`: `fix-prompt.md`, the AI fix prompt: findings bucketed by fix category (rule table, then WCAG fallback), one merge request per category
- `src/htmlkit.ts`: shared by both pages: escaping, score bands, ring/meter/badges, agent-markdown subset, page shell, base CSS (design tokens)
- `src/batchhtml.ts`: batch page (`index.html`, sortable table, worst first, no combined score) and `index.md`
- `src/html.ts`: self-contained HTML report (escapes all site-derived content; must itself stay accessible)
- `src/explain.ts` + `assets/explanations.json`: plain-language "for dummies" explanation per axe rule (what is at stake, who is affected, fix, before/after), written by the daredevil agent; shown behind a "?" button on each defect in `report.html`. A unit test requires an entry for every in-scope axe rule, so an axe-core upgrade that adds rules means adding entries
- `src/auth.ts`: session capture (`login`), session loading, login-page and logout-link detection
- `src/consent.ts`: cookie-dialog dismissal ("reject", never "accept")
- `src/brand.ts`: embeds `assets/logo.svg` (inline header logo + favicon)
- `docs/ux-guidelines.md`: brand and UX guidelines; its "Implementation notes" list the verified contrast values to use

## Before launching a logged-in audit (or a batch with logged-in entries)
Ask the user explicitly (AskUserQuestion) whether image screenshots may be taken: they are saved in the report and can show personal data from the account; without them alt texts are still listed and reviewed from text only. Put the answer in the agent's task ("screenshots: yes" / "screenshots: no"). If the agent returns `QUESTION: screenshots`, ask, then relaunch it with the answer.

## When the daredevil subagent returns
Subagents cannot write report files, so the agent returns its deliverables as text. When its final message arrives:
1. Take `REPORT_DIR:` from it, and check that the folder exists and contains `report.json`.
2. For each `<<<FILE name>>> … <<<END FILE>>>` block, write the content verbatim to `<REPORT_DIR>/<name>`. Only accept `assisted.json`, `summary.md` and `handoff.md`. Make sure `assisted.json` parses as JSON.
3. Run `npm run -s render -- <REPORT_DIR>`, then give the user the brief and the path of `report.html`.

For a batch, the message starts with `BATCH_DIR:` instead:
1. Check that the folder exists and contains `batch.json`.
2. `<<<FILE summary.md>>>` goes to `<BATCH_DIR>/summary.md`.
3. `<<<FILE entries/<n>/<name>>>>` (`<name>` one of `assisted.json`, `summary.md`, `handoff.md`) goes to entry `n` (1-based) of `batch.json` `entries[]`: its folder is `<BATCH_DIR>/<entries[n-1].reportDir>`, and must contain `report.json`. Reject any other file name, and any `n` out of range. Make sure each `assisted.json` parses as JSON.
4. Run `npm run -s render -- <entry folder>` for each entry that received files, then `npm run -s render-batch -- <BATCH_DIR>`. Give the user the brief and the path of `<BATCH_DIR>/index.html`.

When the user lists several URLs or paths, give the agent the list as-is (it pipes it into `batch -`) and, if they said so, the review depth (`review: worst N`, `all`, `none` or entry labels; default: the 3 worst).

## Invariants
- UI (report.html, batch index.html) follows `docs/ux-guidelines.md`. Check contrast numerically before adding a colour: the original token table overstates some ratios.
- Any change to the scoring formula or constants: bump `SCORING_VERSION` in `src/score.ts`. Changing grouping signatures changes group ids: note it, since diffs across that change show false "fixed/new" (in reports, and in batch shared root causes and previous-batch comparisons).
- Code passed to `page.evaluate` must not contain named functions (`const f = () => …`): tsx/esbuild injects a `__name` helper that does not exist in the browser.
- The score is computed only by code; the agent never adjusts it.
- Logged-in audits: never handle credentials (the user logs in in the headed window), never put session-file content in a report or a message, never follow logout or account-changing links (`LOGOUT_URL`), and never take image screenshots without the user's explicit yes (`--images`, or the CLI's question); the alt-text inventory is collected either way.
- Keep dependency versions pinned (exact): axe-core upgrades change rules and therefore scores.
