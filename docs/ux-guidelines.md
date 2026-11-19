# daredevil UX guidelines

<img src="../assets/logo.svg" width="96" alt="daredevil logo: two interlocking D's, red and white, inside yellow focus-ring corner brackets on a charcoal square">

The Interlocking "DD" Monogram sets a clear visual direction: high-contrast, precision-focused, and deeply rooted in actual assistive technology (specifically keyboard focus indicators and structural bounding boxes).

This UX guideline translates that logo's DNA into a cohesive product interface for Daredevil.

## 1. Color System & Contrast Tokens

The logo uses a dark charcoal canvas (`#18181B`), crisp white (`#FFFFFF`), crimson alert (`#EF4444`), and a high-visibility focus yellow (`#FACC15`). All UI states must meet WCAG AAA (7:1+) contrast ratios for primary text and WCAG AA (3:1+) for non-text UI components.

| Role | Token Name | Hex | Contrast (on #18181B) | Usage |
|---|---|---|---|---|
| Canvas Primary | `--bg-surface` | `#18181B` | — | Main dashboard background, code inspector |
| Canvas Elevated | `--bg-card` | `#27272A` | 1.3:1 (use 1px border) | Cards, modals, sidebar panels |
| Text Primary | `--text-primary` | `#FAFAFA` | 16.8:1 (AAA) | Headings, body copy, primary data |
| Text Muted | `--text-secondary` | `#A1A1AA` | 7.1:1 (AAA) | Metadata, timestamps, secondary labels |
| Focus & Active | `--accent-focus` | `#FACC15` | 12.4:1 (AAA) | Keyboard focus rings, active tab indicators |
| Critical Violation | `--status-error` | `#EF4444` | 4.6:1 (AA) | WCAG Level A/AA failures, broken ARIA |
| Passed Audit | `--status-pass` | `#4ADE80` | 11.2:1 (AAA) | Verified elements, resolved issues |

**Rule of Thumb:** Never rely on color alone. Pair `--status-error` with an icon (× or !) and explicit text labels (e.g., CRITICAL), and pair `--status-pass` with a checkmark (✓).

## 2. Typography & Information Hierarchy

An accessibility testing agent parses heavy DOM trees, ARIA attributes, and contrast ratios. Typography must separate human-readable insights from machine code.

- **UI Sans-Serif (Inter or Plus Jakarta Sans):** Used for navigation, audit summaries, and remediation instructions.
  - Page Titles: 24px / SemiBold / -0.02em tracking
  - Section Headers: 16px / SemiBold
  - Body Copy: 15px (never smaller than 14px) / 1.5 line-height for effortless scanning.
- **Code Monospace (JetBrains Mono or Fira Code):** Used strictly for DOM selectors, HTML snippets, ARIA roles, and contrast ratios.
  - Inline Code: 13px inside a subtle pill (`#27272A` fill, 1px solid `#3F3F46` border).

## 3. Signature UI Motifs (Inspired by the Logo)

Carry the visual language of the interlocking "DD" and corner brackets directly into the interface:

- **Corner-Bracket Focus Rings:** Replace standard browser outlines with the logo's signature yellow (`#FACC15`) 4-corner bracket reticle when a user tabs through interactive elements or inspects a DOM node on a target webpage.
- **Overlapping Layer Cards:** When displaying a parent-child DOM relationship (e.g., a `<button>` missing an accessible label inside a `<nav>`), use a subtle stacked/offset card layout (4px offset) echoing the interlocking "DD" geometry.
- **2px Structural Borders:** Because dark-mode surfaces blend together, define cards, inputs, and tables with crisp 1px or 2px borders (`#3F3F46`) rather than drop shadows.

## 4. Interaction & Accessibility Standards (Dogfooding)

Daredevil's own interface must serve as a gold-standard reference implementation for accessibility:

- **Full Keyboard Parity:** Every mouse hover action (such as previewing a highlighted DOM element) must trigger identically on keyboard `:focus-visible`.
- **Skip-to-Audit Links:** Provide an immediate skip link (Skip to violation list) at the top of every scan report so screen reader users bypass navigation chrome.
- **Predictable Live Regions:** When the agent runs a live crawl, announce scan completion and total issue counts politely via `aria-live="polite"` rather than interrupting the user on every single rule check.
- **Reduced Motion Respect:** Disable pulsing radar/scan animations and smooth scrolling automatically when `@media (prefers-reduced-motion: reduce)` is detected.

## 5. Microcopy & Tone of Voice

Daredevil should sound like a sharp, fearless QA engineer—direct, objective, and solution-oriented, never preachy.

- **Don't say:** "Oops! You forgot to add an alt attribute to this image, which makes it hard for blind users."
- **Do say:** "Missing alt attribute on `<img>`. Screen readers will announce the raw filename. Add a descriptive alt text or mark decorative with `alt=""`."

---

## Implementation notes (verified)

Sections 1–5 above are the original guidelines. This section records how they are implemented in `src/html.ts` (the HTML report), and where measured contrast required a deviation. Ratios were computed with the WCAG 2.x relative-luminance formula.

### Measured contrast vs. the table

| Token | Claimed | Measured on `#18181B` | Measured on card `#27272A` | Consequence |
|---|---|---|---|---|
| `#27272A` card | 1.3:1 | 1.19:1 | — | Fine for a surface; cards keep a 1px border as specified. |
| `#FAFAFA` text | 16.8:1 | 16.97:1 | 14.27:1 | As specified. |
| `#A1A1AA` muted | 7.1:1 (AAA) | **6.91:1** | **5.81:1** | Misses AAA. The report uses **`#B4B4BB`** (8.59:1 / 7.23:1), AAA on both surfaces. |
| `#FACC15` focus | 12.4:1 | 11.57:1 | 9.73:1 | As specified. |
| `#EF4444` error | 4.6:1 (AA) | 4.71:1 | **3.96:1** | Fails AA for text on cards. Kept for bars, rings and icons (non-text, 3:1); error **text** uses **`#F87171`** (6.40:1 / 5.38:1). |
| `#4ADE80` pass | 11.2:1 | 10.17:1 | 8.55:1 | As specified. |
| `#3F3F46` border | — | 1.70:1 | 1.43:1 | Fine for decorative card edges. Interactive control borders (buttons) use **`#71717A`** (3.67:1 / 3.08:1) to meet the 3:1 non-text requirement. |

### Additional tokens (not in the original table)

- Impact levels beyond "critical": serious `#FB923C`, moderate `#FBBF24`, minor `#D4D4D8`, all ≥ 6.5:1 on cards. Badges are outlined (1px border in the text colour) with an icon (✕ critical, ! serious/moderate, i minor) and an uppercase label.
- Links: primary text colour with a 2px yellow underline (yellow stays reserved for focus and active states).
- **Light theme.** The guidelines define the dark brand canvas only. To respect readers' OS preference (some users need light backgrounds), the report also has a light theme with the same motifs: canvas `#F4F4F5`, cards `#FFFFFF`, text `#18181B`, muted `#52525B` (7.03:1), focus brackets in `#18181B`, status colours `#B91C1C` / `#C2410C` / `#854D0E` / `#15803D` (all ≥ 4.5:1). A toggle in the header switches themes and remembers the choice.

### Motifs and standards as implemented

- Corner-bracket focus reticle on links, buttons and disclosure summaries (`:focus-visible`), with a transparent outline kept so Windows High Contrast mode still shows focus.
- Offset layer cards: each evidence example (page › element › markup) is a card with a 4px offset layer.
- Borders instead of shadows; the score panel and open issues use 2px borders.
- Skip link "Skip to violation list" as the first focusable element.
- Live region: the issue filter announces the number of issues shown (`aria-live="polite"`).
- Explanations: a round "?" button (2rem, 1.6rem inline; ≥ 24px target) next to each issue, outside the `<summary>` to avoid nested interactive controls. It opens a native modal `<dialog>` (focus moves in, Esc closes, focus returns to the button); its accessible name is "Explain “<title>”". Buttons stay hidden without JavaScript or `<dialog>` support.
- Smooth scrolling only when `prefers-reduced-motion: no-preference`.
- Fonts: Inter / JetBrains Mono are used when installed. Reports never load web fonts, so they stay self-contained, work offline and send no requests; the fallback is the system UI and monospace stacks.
