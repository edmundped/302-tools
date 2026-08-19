/**
 * extract/boilerplate.js — strip running headers, footers, page numbers and
 * download stamps BEFORE measuring how much real text a page has.
 *
 * This is why v1 never noticed the GOIL reports were scanned. Every page of the
 * 2011 report carries a 109-character download stamp:
 *
 *     302 Analytics
 *     benjamin@302analytics.com
 *     Downloaded: 2026-08-18 17:45:28 GMT
 *     Downloaded from www.annualreportsghana.com
 *
 * v1 counted text items and saw 10 per page, comfortably over its threshold of
 * 8, so all 44 pages were treated as text pages and the user was told nothing.
 * Measure AFTER removal, then compare against TEXT_LAYER_MIN.
 */

import { TEXT_LAYER_MIN } from '../core/model.js';
import { pageMetrics, groupLines } from './geometry.js';

export const DEFAULTS = Object.freeze({
  /** text repeating at the same spot on this share of pages is furniture */
  minPageFraction: 0.4,
  /** position quantisation in points when matching "the same spot" */
  positionBucket: 14,
  /** never treat a line longer than this as furniture, however often it repeats */
  maxBoilerplateChars: 120
});

/**
 * Unambiguous artefacts of distribution rather than content. Applied per page,
 * so they are caught even in a single-page extraction where nothing can repeat.
 */
export const STAMP_PATTERNS = [
  { id: 'email', re: /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/ },
  { id: 'download-stamp', re: /^downloaded\b.*$/i },
  { id: 'source-url', re: /^(https?:\/\/|www\.)[\w./?=&%#-]+$/i },
  { id: 'page-number', re: /^(page\s+)?\d{1,4}(\s+of\s+\d{1,4})?$/i },
  { id: 'copyright', re: /^(©|\(c\)\s)\s*\d{4}.*$/i }
];

function normText(text) {
  return String(text)
    .toLowerCase()
    .replace(/\d/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function bucket(v, size) {
  return Math.round(v / size);
}

/** Stable key for "this text, at roughly this spot on the page". */
export function boilerplateKey(line, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return `${bucket(line.center, o.positionBucket)}|${bucket(line.x, o.positionBucket)}|${normText(line.text)}`;
}

export function matchesStamp(text) {
  const s = String(text).trim();
  for (const p of STAMP_PATTERNS) {
    if (p.re.test(s)) return p.id;
  }
  return null;
}

/** Group each page's words into lines once, so callers do not repeat the work. */
export function linesForPages(pages, opts = {}) {
  return pages.map((page) => {
    const words = page.words || [];
    const metrics = words.length ? pageMetrics(words, opts) : { medianHeight: 10, medianSpace: 3, medianLineSpacing: 14 };
    return { page, metrics, lines: words.length ? groupLines(words, metrics, opts) : [] };
  });
}

/**
 * Find furniture across a document.
 * Returns { keys:Set, patterns:[{key, text, pages, kind}] }.
 */
export function findBoilerplate(pageLines, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const total = pageLines.length || 1;
  const counts = new Map();

  pageLines.forEach(({ page, lines }, i) => {
    const seen = new Set();
    for (const line of lines) {
      if (line.text.length > o.maxBoilerplateChars) continue;
      const key = boilerplateKey(line, o);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) || { key, text: line.text, pages: [], kind: 'repeated' };
      entry.pages.push(page.number ?? i + 1);
      counts.set(key, entry);
    }
  });

  const threshold = Math.max(2, Math.ceil(total * o.minPageFraction));
  const patterns = [];
  const keys = new Set();
  for (const entry of counts.values()) {
    if (total >= 2 && entry.pages.length >= threshold) {
      patterns.push(entry);
      keys.add(entry.key);
    }
  }
  return { keys, patterns, pageCount: total, threshold };
}

/**
 * Remove furniture from every page and re-measure.
 *
 * Mutates nothing: returns fresh page records carrying `words`, `bodyLines`,
 * `textChars`, `hasTextLayer`, `needsOcr` and the stripped lines for audit.
 */
export function stripBoilerplate(pages, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const textLayerMin = o.textLayerMin ?? TEXT_LAYER_MIN;
  const pageLines = linesForPages(pages, opts);
  const { keys, patterns } = findBoilerplate(pageLines, o);

  const stampHits = [];
  const result = pageLines.map(({ page, lines, metrics }, i) => {
    const kept = [];
    const removed = [];
    for (const line of lines) {
      const stamp = matchesStamp(line.text);
      const repeated = keys.has(boilerplateKey(line, o));
      if (stamp || repeated) {
        removed.push({ text: line.text, reason: stamp ? `stamp:${stamp}` : 'repeated-across-pages' });
        if (stamp) stampHits.push(line.text);
        continue;
      }
      kept.push(line);
    }

    const textChars = kept.reduce((n, l) => n + l.text.length, 0);
    const hasTextLayer = textChars >= textLayerMin;
    const words = kept.flatMap((l) => l.words);

    return {
      ...page,
      number: page.number ?? i + 1,
      words,
      bodyLines: kept,
      removedLines: removed,
      metrics,
      textChars,
      hasTextLayer,
      needsOcr: !hasTextLayer,
      ocrApplied: Boolean(page.ocrApplied),
      warnings: [
        ...(page.warnings || []),
        ...(hasTextLayer
          ? []
          : [`page ${page.number ?? i + 1}: ${textChars} chars of body text after boilerplate removal (min ${textLayerMin}) — treated as scanned, OCR required`])
      ]
    };
  });

  return { pages: result, patterns, stampHits, textLayerMin };
}

/**
 * Region hint for a partly-scanned page: a page WITH a text layer that also has
 * a large image and a vertical stretch of the page carrying no text. The 2010
 * GOIL report is exactly this — prose notes in text, every table a raster.
 */
export function findTextlessRegions(page, opts = {}) {
  const lines = page.bodyLines || [];
  const regions = page.imageRegions || [];
  if (!regions.length) return [];
  const gap = opts.minRegionHeight ?? 60;

  return regions
    .filter((r) => r.h >= gap && r.w >= gap)
    .filter((r) => {
      const overlapping = lines.filter((l) => l.bottom > r.y && l.top < r.y + r.h);
      const chars = overlapping.reduce((n, l) => n + l.text.length, 0);
      return chars < 40;
    })
    .map((r) => ({ ...r, reason: 'image region with no text over it — offer region OCR' }));
}

/** Convenience: flag pages without doing the stripping again. */
export function flagScannedPages(pages, textLayerMin = TEXT_LAYER_MIN) {
  return pages.map((p) => ({
    ...p,
    hasTextLayer: p.textChars >= textLayerMin,
    needsOcr: p.textChars < textLayerMin
  }));
}

export default {
  DEFAULTS,
  STAMP_PATTERNS,
  boilerplateKey,
  matchesStamp,
  linesForPages,
  findBoilerplate,
  stripBoilerplate,
  findTextlessRegions,
  flagScannedPages
};
