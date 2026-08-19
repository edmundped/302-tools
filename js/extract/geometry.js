/**
 * extract/geometry.js — positioned text -> lines -> cells -> columns -> grid.
 *
 * Coordinate convention (normalise once, at ingest):
 *   Word = { text, x, y, x1, y1, w, h, conf? }
 *   x  = left edge      x1 = right edge
 *   y  = TOP edge       y1 = bottom edge      (y increases downwards)
 *
 * Three v1 defects are fixed here:
 *   - columns were clustered on the LEFT edge; financial numerics align on the
 *     RIGHT edge, so 1,234 and 12,442,697 shattered into separate columns.
 *   - anchors were the first x seen (greedy first-wins) rather than a centroid.
 *   - tolerances were hard-coded at 3.5pt / 18pt instead of scaling with type size.
 *
 * Column bands are found from the vertical WHITESPACE between them (gap
 * analysis), not by snapping items to anchors. Anchors are then computed as
 * cluster centroids and recomputed after assignment.
 */

import { parseNumber } from '../core/numbers.js';

export const DEFAULTS = Object.freeze({
  /** line grouping tolerance, as a fraction of median glyph height */
  lineTol: 0.45,
  /** a horizontal gap this many glyph-heights wide separates two cells */
  cellGapHeights: 1.1,
  /** ...or this many median word-spaces, whichever is larger */
  cellGapSpaces: 4,
  /** a whitespace column this wide is a real gutter between columns */
  gutterHeights: 1.0,
  gutterSpaces: 3,
  /** vertical gap this many median line-spacings apart splits two tables */
  bandGapSpacings: 2.0,
  bandGapHeights: 2.5,
  /** right edges within this many glyph-heights count as the same alignment */
  edgeTolHeights: 0.6
});

function median(values) {
  if (!values.length) return 0;
  const a = values.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/** Coerce any word-ish object into the normalised shape. */
export function normaliseWord(raw) {
  const text = String(raw.text ?? raw.str ?? '');
  const x = Number(raw.x) || 0;
  const y = Number(raw.y) || 0;
  const w = Number.isFinite(raw.w) ? Number(raw.w) : Number(raw.width) || 0;
  const h = Number.isFinite(raw.h) ? Number(raw.h) : Number(raw.height) || 0;
  const x1 = Number.isFinite(raw.x1) ? Number(raw.x1) : x + w;
  const y1 = Number.isFinite(raw.y1) ? Number(raw.y1) : y + h;
  return {
    text,
    x,
    y,
    x1,
    y1,
    w: x1 - x,
    h: y1 - y,
    conf: Number.isFinite(raw.conf) ? raw.conf : null
  };
}

export function normaliseWords(words) {
  return (words || [])
    .map(normaliseWord)
    .filter((w) => w.text.trim().length > 0)
    .map((w) => ({ ...w, text: w.text.trim() }));
}

/**
 * Page-level type metrics. Everything downstream scales off medianHeight and
 * medianSpace so an 8pt statement and a 14pt schedule behave the same.
 */
export function pageMetrics(words, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ws = normaliseWords(words);
  const heights = ws.map((w) => w.h).filter((h) => h > 0.5);
  const medianHeight = median(heights) || 10;

  // Provisional lines just to measure the typical inter-word space.
  const provisional = groupLines(ws, { medianHeight, medianSpace: 0, ...o }, o);
  const gaps = [];
  const spacings = [];
  for (const line of provisional) {
    for (let i = 1; i < line.words.length; i += 1) {
      const g = line.words[i].x - line.words[i - 1].x1;
      if (g > -medianHeight && g < medianHeight * 0.9) gaps.push(Math.max(g, 0));
    }
  }
  for (let i = 1; i < provisional.length; i += 1) {
    spacings.push(provisional[i].center - provisional[i - 1].center);
  }

  return {
    medianHeight,
    medianSpace: median(gaps) || medianHeight * 0.28,
    medianLineSpacing: median(spacings) || medianHeight * 1.4,
    lineCount: provisional.length,
    wordCount: ws.length,
    xMin: Math.min(...ws.map((w) => w.x), Infinity),
    xMax: Math.max(...ws.map((w) => w.x1), -Infinity),
    yMin: Math.min(...ws.map((w) => w.y), Infinity),
    yMax: Math.max(...ws.map((w) => w.y1), -Infinity)
  };
}

/**
 * Group words into lines by vertical centre. Tolerance is 0.45 glyph heights,
 * not a fixed 3.5pt.
 */
export function groupLines(words, metrics, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ws = normaliseWords(words).sort((a, b) => a.y - b.y || a.x - b.x);
  const tol = Math.max(1, (metrics?.medianHeight || 10) * o.lineTol);

  const lines = [];
  for (const w of ws) {
    const center = (w.y + w.y1) / 2;
    let line = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (Math.abs(lines[i].center - center) <= tol) {
        line = lines[i];
        break;
      }
      if (lines[i].center < center - tol * 4) break;
    }
    if (!line) {
      line = { center, top: w.y, bottom: w.y1, words: [] };
      lines.push(line);
    }
    line.words.push(w);
    line.top = Math.min(line.top, w.y);
    line.bottom = Math.max(line.bottom, w.y1);
    line.center = mean(line.words.map((q) => (q.y + q.y1) / 2));
  }

  return lines
    .map((line, index) => {
      const sorted = line.words.slice().sort((a, b) => a.x - b.x);
      return {
        index,
        center: line.center,
        top: line.top,
        bottom: line.bottom,
        x: Math.min(...sorted.map((w) => w.x)),
        x1: Math.max(...sorted.map((w) => w.x1)),
        words: sorted,
        text: sorted.map((w) => w.text).join(' ')
      };
    })
    .sort((a, b) => a.center - b.center)
    .map((line, index) => ({ ...line, index }));
}

/** The horizontal gap that separates two cells rather than two words. */
export function cellGapThreshold(metrics, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return Math.max(metrics.medianHeight * o.cellGapHeights, metrics.medianSpace * o.cellGapSpaces, 2);
}

/**
 * Split one line into cells on wide horizontal gaps.
 * Prose survives intact: ordinary word spaces are ~0.25 glyph heights, far
 * below the threshold, so a sentence stays a single cell and cannot masquerade
 * as a multi-column row.
 */
export function splitCells(line, metrics, opts = {}) {
  const threshold = cellGapThreshold(metrics, opts);
  const cells = [];
  let current = null;

  for (const w of line.words) {
    if (current && w.x - current.x1 < threshold) {
      current.words.push(w);
      current.x1 = Math.max(current.x1, w.x1);
    } else {
      current = { words: [w], x: w.x, x1: w.x1 };
      cells.push(current);
    }
  }

  return cells.map((c) => {
    const text = c.words.map((w) => w.text).join(' ');
    const p = parseNumber(text);
    const confs = c.words.map((w) => w.conf).filter((v) => Number.isFinite(v));
    return {
      text,
      x: c.x,
      x1: c.x1,
      words: c.words,
      wordCount: c.words.length,
      isNumeric: p.isNumeric,
      isNil: p.isNil,
      isFigure: p.isNumeric || p.isNil,
      conf: confs.length ? Math.min(...confs) : null
    };
  });
}

/** Attach a `cells` array to every line. */
export function cellsForLines(lines, metrics, opts = {}) {
  return lines.map((line) => ({ ...line, cells: splitCells(line, metrics, opts) }));
}

/* ------------------------------------------------------------------ */
/* Column inference                                                     */
/* ------------------------------------------------------------------ */

/**
 * Find column bands by looking at the WHITESPACE, not at the items.
 *
 * 1. Union all cell x-intervals across the candidate lines.
 * 2. Any uncovered interval wider than the gutter threshold is a column break.
 * 3. Bands that hold two distinct right-edge alignments (a numeric column
 *    printed too close to its neighbour to leave a wide gutter) are split by
 *    edge clustering.
 * 4. Anchors are cluster centroids, recomputed after assignment.
 */
export function inferColumns(lines, metrics, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cells = lines.flatMap((l) => l.cells || []);
  if (!cells.length) return [];

  const gutterMin = Math.max(metrics.medianHeight * o.gutterHeights, metrics.medianSpace * o.gutterSpaces, 2);

  // 1 + 2: interval union, then gaps.
  const intervals = cells.map((c) => [c.x, c.x1]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of intervals) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  let bands = [];
  let start = merged[0][0];
  let end = merged[0][1];
  for (let i = 1; i < merged.length; i += 1) {
    const gap = merged[i][0] - end;
    if (gap >= gutterMin) {
      bands.push({ left: start, right: end });
      start = merged[i][0];
    }
    end = Math.max(end, merged[i][1]);
  }
  bands.push({ left: start, right: end });

  // 3: split bands with two clear right-edge alignments.
  bands = bands.flatMap((band) => splitBandByEdges(band, cells, metrics, o));

  // 4: assign, then recompute anchors as centroids, then reassign once.
  let columns = bands.map((band, index) => ({
    index,
    left: band.left,
    right: band.right,
    align: 'left',
    anchor: band.left,
    cells: []
  }));

  columns = fitColumns(columns, cells, metrics);
  columns = fitColumns(columns, cells, metrics);
  return columns.map((c, index) => ({ ...c, index }));
}

function splitBandByEdges(band, cells, metrics, o) {
  const inBand = cells.filter((c) => c.x >= band.left - 0.5 && c.x1 <= band.right + 0.5);
  const figures = inBand.filter((c) => c.isFigure);
  if (figures.length < 4) return [band];

  const tol = metrics.medianHeight * o.edgeTolHeights;
  const clusters = clusterValues(figures.map((c) => c.x1), tol);
  const strong = clusters.filter((c) => c.values.length >= 2);
  if (strong.length < 2) return [band];

  // Only split where no cell straddles the proposed boundary.
  const out = [];
  let left = band.left;
  for (let i = 1; i < strong.length; i += 1) {
    const prevMax = Math.max(...strong[i - 1].values);
    const nextMin = Math.min(...strong[i].values);
    const boundary = (prevMax + nextMin) / 2;
    if (nextMin - prevMax < metrics.medianHeight * 2) continue;
    const straddles = inBand.some((c) => c.x < boundary - 0.5 && c.x1 > boundary + 0.5);
    if (straddles) continue;
    out.push({ left, right: boundary });
    left = boundary;
  }
  out.push({ left, right: band.right });
  return out.length > 1 ? out : [band];
}

/** 1-D single-link clustering with a tolerance. */
export function clusterValues(values, tolerance) {
  const sorted = values.slice().sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.values[last.values.length - 1] <= tolerance) {
      last.values.push(v);
      last.center = mean(last.values);
    } else {
      clusters.push({ values: [v], center: v });
    }
  }
  return clusters;
}

/** Assign every cell to a column, then recompute each column's centroid anchor. */
function fitColumns(columns, cells, metrics) {
  const next = columns.map((c) => ({ ...c, cells: [] }));
  for (const cell of cells) {
    const col = pickColumn(next, cell, metrics);
    if (col) col.cells.push(cell);
  }
  for (const col of next) {
    if (!col.cells.length) continue;
    const figures = col.cells.filter((c) => c.isFigure);
    const rightAligned = figures.length / col.cells.length >= 0.5;
    col.align = rightAligned ? 'right' : 'left';
    // centroid, recomputed — never the first value seen
    col.anchor = rightAligned ? mean(col.cells.map((c) => c.x1)) : mean(col.cells.map((c) => c.x));
    col.left = Math.min(...col.cells.map((c) => c.x));
    col.right = Math.max(...col.cells.map((c) => c.x1));
    col.numericFraction = figures.length / col.cells.length;
    col.edgeSpread = stdev(rightAligned ? col.cells.map((c) => c.x1) : col.cells.map((c) => c.x));
  }
  return next;
}

/** Overlap-first assignment; falls back to nearest centroid on the cell's own edge. */
export function pickColumn(columns, cell, metrics) {
  let best = null;
  let bestOverlap = 0;
  for (const col of columns) {
    const overlap = Math.min(cell.x1, col.right) - Math.max(cell.x, col.left);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = col;
    }
  }
  if (best && bestOverlap > 0) return best;

  const edge = cell.isFigure ? cell.x1 : cell.x;
  let nearest = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const anchor = col.align === 'right' ? col.anchor : col.anchor;
    const d = Math.abs(anchor - edge);
    if (d < bestDist) {
      bestDist = d;
      nearest = col;
    }
  }
  return nearest;
}

/**
 * Build the rectangular grid. Every row has exactly columns.length cells;
 * padding happens here so nothing downstream can shift a row.
 */
export function assignGrid(lines, columns, metrics) {
  return lines.map((line) => {
    const row = new Array(columns.length).fill('');
    for (const cell of line.cells || []) {
      const col = pickColumn(columns, cell, metrics);
      if (!col) continue;
      const i = col.index;
      row[i] = row[i] ? `${row[i]} ${cell.text}` : cell.text;
    }
    return row;
  });
}

/**
 * Alignment quality of a column: 1 when every figure lands on the same edge,
 * falling off as the spread approaches a glyph height.
 */
export function alignmentQuality(column, metrics) {
  if (!column || !column.cells || column.cells.length < 2) return 0;
  const edges = column.align === 'right' ? column.cells.map((c) => c.x1) : column.cells.map((c) => c.x);
  const spread = stdev(edges);
  return Math.max(0, 1 - spread / Math.max(metrics.medianHeight, 1));
}

export const _internals = { median, mean, stdev };

export default {
  DEFAULTS,
  normaliseWord,
  normaliseWords,
  pageMetrics,
  groupLines,
  splitCells,
  cellsForLines,
  cellGapThreshold,
  inferColumns,
  assignGrid,
  alignmentQuality,
  clusterValues
};
