# daredevil

**Accessibility audits you can measure, compare and hand to an AI to fix.**

Give daredevil a URL, optionally with a path (`https://www.mysite.com/shop`), and you get:

1. **A score from 0 to 100.** It is reproducible and fine-grained enough to show progress after each fix, and comparable between websites.
2. **An audit report** in two layers: a human-readable summary, and a structured list of anomalies grouped by root cause and ranked by impact. Another AI can build a fix plan directly from it.

daredevil has two parts:

| Part | What it does | Deterministic? |
|---|---|---|
| **Engine**: a TypeScript CLI ([Playwright](https://playwright.dev) + [axe-core](https://github.com/dequelabs/axe-core)) | Crawls the pages, runs the WCAG checks, scores, groups and writes `report.json` / `report.md` | Yes. The score comes only from here |
| **Agent**: a Claude Code subagent (`.claude/agents/daredevil.md`) | Runs the engine, reviews what automation can't decide (alt-text quality, keyboard behaviour, undecided items), writes `summary.md` and `handoff.md` | No. It is AI judgement, kept separate from the score |

---

## Quick start

```bash
npm install
npx playwright install chromium
```

**With the agent** (in Claude Code, from this directory):

> daredevil, audit https://www.mysite.com/shop
>
> daredevil, I fixed the image alts, re-audit the shop and tell me if it improved
>
> daredevil, compare the accessibility of site-a.com and site-b.com

**Engine only:**

```bash
npm run -s audit -- https://www.mysite.com/shop --max-pages 25
```

```json
{
  "reportDir": "reports/www.w3.org_WAI_demos_bad_before/20261118-195027",
  "score": 45.6,
  "delta": 0,
  "comparableWithPrevious": true,
  "pagesScanned": 8,
  "pagesFailed": 0,
  "issueGroups": 16,
  "violationNodes": 439
}
```

### Scope

The URL's path bounds the crawl. daredevil starts at the URL and follows links breadth-first, staying inside the scope:

| Start URL | Audited | Not audited |
|---|---|---|
| `https://www.mysite.com/shop` | `/shop`, `/shop/cart`, `/shop/item/42` | `/shopping`, `/blog`, other domains |
| `https://www.mysite.com/shop/index.html` | the `/shop` directory, as above | |
| `https://www.mysite.com` | the whole site, up to `--max-pages` | |

Fragments (`#…`) and query strings are ignored for de-duplication; use `--keep-query` to keep query strings. Non-HTML resources (PDF, images…) are skipped. Redirects of the start URL (e.g. `mysite.com` to `www.mysite.com`) are followed before the scope is fixed.

---

## What you get

Each run writes to `reports/<site-and-path>/<timestamp>/`:

| File | Audience | Produced by |
|---|---|---|
| `report.json` | machines and AIs: the full structured result | engine |
| `report.md` | humans who want detail: score, prioritised issues, evidence | engine |
| `assets/*.png` | element screenshots of images, for alt-text review | engine |
| `summary.md` | humans: a one-page executive summary | agent |
| `assisted.json` | machines: the agent's findings, with confidence levels | agent |
| `handoff.md` | an AI fixer: one task per root cause, with fix guidance and acceptance criteria | agent |

## Report samples

The samples below are real output from auditing W3C's [Before and After Demonstration](https://www.w3.org/WAI/demos/bad/), a site built to be inaccessible on purpose, with a repaired "after" version (8 pages each).

### Score (`report.md`)

```markdown
## Score: 45.6 / 100

| Dimension | Score |
|---|---:|
| **Overall (WCAG A+AA)** | **45.6** |
| Level A | 53.2 |
| Level AA | 84.3 |
| Perceivable | 63.3 |
| Operable | 79.5 |
| Understandable | 96.3 |
| Robust | 88.1 |
| Best practices (not in overall) | 88.7 |

Violations: **439 nodes in 16 root-cause groups** (critical 201, serious 71, moderate 166, minor 1).
Needs review: 25 nodes in 7 groups.
```

### Issues by priority (`report.md`)

439 failing elements collapse into 16 root causes. They are ranked by **estimated score gain**: how many points the site would gain if that group were fixed.

| # | Gain | Impact | Rule | WCAG | Root cause | Nodes | Pages |
|---:|---:|---|---|---|---|---:|---:|
| 1 | +18.63 | critical | image-alt | 1.1.1 (A) | `<img>` | 183 | 6 |
| 2 | +4.08 | serious | link-name | 2.4.4, 4.1.2 (A) | `<a>` | 30 | 6 |
| 3 | +2.74 | critical | select-name | 4.1.2 (A) | `<select>` | 7 | 6 |
| 4 | +2.38 | serious | target-size | 2.5.8 (AA) | `<a.page>` | 4 | 2 |
| 5 | +2.12 | serious | target-size | 2.5.8 (AA) | `<a.report>` | 12 | 6 |
| 6 | +1.25 | serious | color-contrast | 1.4.3 (AA) | `fg #41545d on bg #a9b8bf, 9.8pt (13px) bold` | 6 | 3 |
| 7 | +1.18 | serious | html-has-lang | 3.1.1 (A) | `page structure` | 6 | 6 |

Each group then gets a detail section with selector patterns, affected pages, HTML evidence and axe's failure summary:

````markdown
### 2. Links must have discernible text — `link-name` [3f7eeba29a]

- Impact: **serious** · WCAG 2.4.4, 4.1.2 (A) · operable
- Root cause: `<a>` · 30 nodes on 6 page(s)
- Where: `#home > a[onfocus="blur();"]`, `#news > a[onfocus="blur();"]`, `#tickets > a[onfocus="blur();"]`, …
- Pages: `/WAI/demos/bad/before/home.html`, `/WAI/demos/bad/before/news.html`, …

  - `/WAI/demos/bad/before/annotated/home.html` `#home > a[onfocus="blur();"]`
    ```html
    <a href="javascript:location.href='home.html';" onfocus="blur();"><img name="nav_home" src="../img/nav_home.gif" width="88" height="27" hspace="15" border="0px"></a>
    ```

  Fix all of the following: / Element is in tab order and does not have accessible text / …
````

### Keyboard probe (`report.md`, heuristic, not scored)

| Page | Tab stops / tabbable | Skip link | No visible focus | Possible trap |
|---|---:|---|---:|---|
| `/WAI/demos/bad/before/home.html` | 12 / 56 | yes | 0 | `div#mnav > ul > li > a` |
| `/WAI/demos/bad/before/news.html` | 14 / 48 | yes | 0 | |

The probe tabs through each page. Here it found the demo's real defect: the navigation links call `onfocus="blur()"`, which throws keyboard focus away. Only 12 of the 56 tabbable elements are ever reached.

### One issue group (`report.json`)

Every group carries everything a fixing agent needs. Its `id` is stable across runs, so a fix can be verified by checking that the id disappears.

```json
{
  "id": "760a27b401",
  "ruleId": "color-contrast",
  "impact": "serious",
  "help": "Elements must meet minimum color contrast ratio thresholds",
  "helpUrl": "https://dequeuniversity.com/rules/axe/4.14/color-contrast?application=playwright",
  "wcag": ["1.4.3"],
  "level": "AA",
  "principle": "perceivable",
  "scored": true,
  "signature": "fg #41545d on bg #a9b8bf, 9.8pt (13px) bold",
  "occurrences": 6,
  "pageCount": 3,
  "pages": ["/WAI/demos/bad/before/annotated/home.html", "/WAI/demos/bad/before/home.html", "/WAI/demos/bad/before/template.html"],
  "patterns": ["tr[height=\"#px\"] > td[bgcolor=\"#A#B#BF\"][width=\"#px\"] > font[color=\"##D\"][size=\"#\"] > b"],
  "examples": [
    {
      "page": "/WAI/demos/bad/before/annotated/home.html",
      "selector": "tr[height=\"25px\"]:nth-child(2) > td[bgcolor=\"#A9B8BF\"][width=\"150px\"] > font[color=\"#41545D\"][size=\"2\"] > b",
      "html": "<b>Free Penguins</b>",
      "failureSummary": "Fix any of the following:\n  Element has insufficient color contrast of 3.88 (foreground color: #41545d, background color: #a9b8bf, font size: 9.8pt (13px), font weight: bold). Expected contrast ratio of 4.5:1",
      "data": { "fgColor": "#41545d", "bgColor": "#a9b8bf", "contrastRatio": 3.88, "expectedContrastRatio": "4.5:1", "fontSize": "9.8pt (13px)", "fontWeight": "bold" }
    }
  ],
  "estimatedScoreGain": 1.25
}
```

The top level of `report.json`:

```text
schemaVersion, tool {version, axeVersion, scoringVersion, browser}, generatedAt, config
summary      score breakdown, page counts, violation counts by impact
issues[]     violation groups, sorted by estimatedScoreGain
needsReview[] axe "incomplete" groups: undecidable automatically, not scored
pages[]      per page: score, raw violations, incomplete, passes, keyboard probe, images
```

### Before/after and benchmarking (`npm run diff`)

Comparing W3C's inaccessible demo with its repaired version:

```markdown
**Overall: 45.6 → 89.5 (+43.9)**

> ⚠️ page sets differ (8 only in before, 8 only in after); re-run with --same-pages for a strict comparison

| Score | Before | After | Δ |
|---|---:|---:|---:|
| overall | 45.6 | 89.5 | +43.9 |
| level A | 53.2 | 100 | +46.8 |
| level AA | 84.3 | 89.5 | +5.2 |
| perceivable | 63.3 | 100 | +36.7 |
| operable | 79.5 | 89.5 | +10 |
| understandable | 96.3 | 100 | +3.7 |
| robust | 88.1 | 100 | +11.9 |
| best-practice | 88.7 | 87.6 | -1.1 |

Issue groups: **10 fixed**, **1 new**, 1 changed in size.

Fixed:
- ✅ `image-alt` <img> (183 nodes)
- ✅ `link-name` <a> (30 nodes)
- ✅ `select-name` <select> (7 nodes)
- ✅ `color-contrast` fg #41545d on bg #a9b8bf, 9.8pt (13px) bold (6 nodes)
- ✅ `html-has-lang` page structure (6 nodes)
  …
New:
- ❌ `label-title-only` <select> (1 nodes, serious)
```

The repaired site still loses points. Its links fail WCAG 2.2's `target-size` (2.5.8), a criterion published after the demo was made.

When the same site is re-audited, this comparison is added automatically to `report.md` as "Change since previous run".

### Agent outputs

`assisted.json` holds findings the engine cannot score. Each has a confidence level so a fixer can weigh it:

```json
{
  "id": "A1",
  "category": "keyboard",
  "wcag": ["2.1.1", "2.4.7"],
  "impact": "serious",
  "confidence": "high",
  "page": "/WAI/demos/bad/before/home.html",
  "selector": "div#mnav > ul > li > a",
  "evidence": "Navigation links have onfocus=\"blur();\"; the keyboard probe reached only 12 of 56 tabbable elements",
  "recommendation": "Remove the onfocus blur handlers; style focus with :focus-visible instead of suppressing it"
}
```

`handoff.md` is written for an AI that will plan and apply the fixes. It contains:
1. **Context**: site, scope, score, file paths, and the verification command.
2. **Tasks**: one per issue group, in priority order. Each task has Where (patterns, pages), Evidence (HTML, failure summary), Fix guidance (specific to the evidence) and Done when (the group id is gone from a `--same-pages` re-run).
3. **Cautions**: fixes that probably belong in a design system, CMS content or a third-party widget, not in page markup.

---

## Scoring model

The headline score covers the **WCAG 2.0 / 2.1 / 2.2, level A and AA** rules of axe-core.

```text
rulePenalty = weight(impact) × (1 + log2(failingNodes))     weights: critical 10, serious 5, moderate 2, minor 1
pageScore   = 100 × exp(−Σ rulePenalty / 100)
siteScore   = mean(pageScore) over scanned pages
```

| Design choice | Why |
|---|---|
| Impact weights | One critical blocker costs as much as ten minor issues. |
| `log2` of node count | 200 broken buttons cost more than 1, but not 200 times more. Fixing half of them still moves the score, which keeps progress visible. |
| `exp(−P/100)` | A continuous 0–100 scale that never collapses to 0, so two bad sites can still be told apart. |
| Mean over pages | Sites of different sizes stay comparable, and fixing a shared template (header, footer) lifts every page. |
| Best practices excluded | axe best-practice rules (`region`, `landmark-*`…) are not WCAG requirements. They get their own sub-score. |
| `needsReview` excluded | Undecided results are never counted as failures (no false positives in the score). |

Worked examples for a single page:

| Page state | Penalty | Score |
|---|---:|---:|
| No WCAG violation | 0 | 100 |
| 1 image without alt (critical, 1 node) | 10 | 90.5 |
| 4 low-contrast texts, same rule (serious, 4 nodes) | 5 × (1 + 2) = 15 | 86.1 |
| Both of the above | 25 | 77.9 |

Sub-scores use the same formula, restricted to one WCAG level or one POUR principle (Perceivable, Operable, Understandable, Robust).

**Comparability.** A score is only meaningful alongside the versions that produced it. Every report records the scoring version, the axe-core version (pinned in `package.json`), the browser, the viewport and the page list. `diff` warns when any of these differ.

## Root-cause grouping

Fix plans should target causes, not individual elements. Failing nodes are grouped by rule plus a signature:

| Kind of rule | Grouped by | Example signature |
|---|---|---|
| Page structure (`html-has-lang`, `document-title`, `region`, `landmark-*`, `bypass`…) | the rule alone | `page structure` |
| Colour contrast | foreground/background colour and font (≈ one design token) | `fg #41545d on bg #a9b8bf, 9.8pt (13px) bold` |
| Element with classes | tag + classes (≈ one component) | `<button.icon-btn>` |
| Element without classes | tag (+ role/type) | `<input[type=radio]>` |

The precise selector patterns of each group are kept in `patterns`, so the fixer knows where to look. Changing these rules changes group ids. That breaks diffs across the change, so note it when you do.

## Measuring improvement and benchmarking

- **After a fix:** re-run with `--same-pages`, so the crawl can't drift (new products, changed links) and blur the comparison:
  ```bash
  npm run -s audit -- https://www.mysite.com/shop --same-pages reports/www.mysite.com_shop/<timestamp>/report.json
  ```
- **Between sites:** use the same options for each (`--max-pages`, viewport), then compare `summary.score`. Comparing the same section type (e.g. `/shop` against `/shop`) is fairer than comparing whole sites.
- **Determinism:** pages load with reduced motion, a fixed viewport, `networkidle` plus `--wait-ms` of settle time, and a fresh browser context per page. Highly dynamic pages (A/B tests, rotating banners, cookie walls) can still vary slightly between runs.

## CLI reference

```text
npm run -s audit -- <url> [options]
  --max-pages <n>        Max pages to scan (default 25)
  --concurrency <n>      Parallel pages (default 2)
  --viewport <WxH>       Viewport (default 1280x800)
  --wait-ms <ms>         Extra settle time after load (default 1000)
  --timeout <ms>         Navigation timeout (default 30000)
  --user-agent <ua>      Override the browser user agent
  --keep-query           Treat ?query variants as distinct pages
  --same-pages <json>    Re-scan exactly the pages of a previous report.json
  --skip-best-practice   Do not run axe best-practice rules
  --skip-keyboard        Skip the keyboard probe
  --skip-images          Skip image screenshots for alt-text review
  --out <dir>            Reports root (default ./reports)

npm run -s diff -- <before/report.json> <after/report.json>
```

**User agent.** Many sites reject headless browsers (W3C returns HTTP 403). By default daredevil sends the regular Chrome user agent plus a `daredevil-a11y/0.1` token, so it stays identifiable in server logs. Audit only sites you are allowed to crawl, and keep `--concurrency` low on production sites.

## Limits

- Automated rules detect only part of WCAG failures: Deque estimates about 57% by volume, and fewer by number of success criteria. A score of 100 means **no detectable violation**, not WCAG conformance.
- The keyboard probe and the alt-text review are heuristics or AI judgement. They are reported with confidence levels and never scored.
- Not covered yet: screen-reader behaviour, authenticated pages, multi-step flows (checkout, forms), mobile viewports in a single run, PDFs.

A conformance claim still needs manual testing with assistive technologies.

## Development

```bash
npm test            # unit tests + an end-to-end audit of test/fixtures/site
npm run typecheck
```

```text
src/cli.ts       arguments, report directory, automatic comparison with the previous run
src/crawl.ts     URL normalisation and scope
src/audit.ts     browser, breadth-first crawl, axe scan, conversion of axe results
src/probes.ts    keyboard probe, image inventory and screenshots
src/group.ts     root-cause signatures and grouping
src/score.ts     scoring model (bump SCORING_VERSION on any change)
src/report.ts    report.json assembly, diff, markdown rendering
.claude/agents/daredevil.md   the Claude Code agent
```

See `CLAUDE.md` for the project's rules: the scoring versioning, and the constraint on code run inside the browser.
