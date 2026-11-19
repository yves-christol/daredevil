import { readFileSync } from 'node:fs';

/** The daredevil logo (assets/logo.svg), read once. Reports embed it so they stay self-contained. */
let svg = '';
try {
  svg = readFileSync(new URL('../assets/logo.svg', import.meta.url), 'utf8').trim();
} catch {
  /* logo missing: reports render without it */
}

/** Logo for inline use next to the visible "daredevil" name: decorative, hidden from assistive tech. */
export function logoInline(): string {
  if (!svg) return '';
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(role|aria-label|width|height)="[^"]*"/g, '')
    .replace('<svg', '<svg aria-hidden="true" focusable="false"');
}

/** Logo as a favicon data URI. */
export function faviconDataUri(): string {
  return svg ? `data:image/svg+xml,${encodeURIComponent(svg.replace(/<!--[\s\S]*?-->/g, ''))}` : '';
}
