# daredevil

Accessibility auditing. A deterministic TypeScript CLI (Playwright + axe-core) crawls a URL's
path, scores it and writes reports. The `daredevil` subagent (`.claude/agents/daredevil.md`)
runs the CLI and adds AI-assisted review, a human summary and a fix handoff.

## Commands
- `npm run -s audit -- <url> [--max-pages N] [--same-pages prev/report.json]`: writes `reports/<site-slug>/<timestamp>/`
- `npm run -s diff -- before.json after.json`
- `npm test` (unit tests + an e2e test against `test/fixtures/site`), `npm run typecheck`

## Layout
- `src/cli.ts`: argument parsing, report directory, auto-diff with the previous run of the same scope
- `src/crawl.ts`: URL normalisation and scope (`/shop` matches `/shop/**`, not `/shopping`)
- `src/audit.ts`: browser and BFS crawl, axe scan per page, conversion of axe results
- `src/probes.ts`: keyboard probe and image inventory (assisted, not scored)
- `src/group.ts`: root-cause signatures and grouping (group `id` is stable across runs)
- `src/score.ts`: scoring model, see the header comment
- `src/report.ts`: report.json assembly, diff, markdown

## Invariants
- Any change to the scoring formula or constants: bump `SCORING_VERSION` in `src/score.ts`. Changing grouping signatures changes group ids: note it, since diffs across that change show false "fixed/new".
- Code passed to `page.evaluate` must not contain named functions (`const f = () => …`): tsx/esbuild injects a `__name` helper that does not exist in the browser.
- The score is computed only by code; the agent never adjusts it.
- Keep dependency versions pinned (exact): axe-core upgrades change rules and therefore scores.
