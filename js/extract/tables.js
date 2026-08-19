/**
 * extract/tables.js — assemble grids, detect headers, trim ONCE per table.
 *
 * Two v1 defects are fixed here:
 *   - trimEmptyEdges ran per row, so a row with a blank first cell shifted one
 *     column left and row[0] stopped meaning the same thing on every row.
 *     Trimming is now a table-level decision applied uniformly.
 *   - chooseHeaderRow rejected any row whose cells start with a digit, so the
 *     commonest financial header of all — `2011  2010` — was never detected.
 */

import { parseNumber, isPeriodLabel } from '../core/numbers.js';
import { createTable, normaliseTable, MIN_TABLE_CONFIDENCE } from '../core/model.js';
import {
  DEFAULTS,
  pageMetrics,
  groupLines,
  cellsForLines,
  inferColumns,
  assignGrid
} from './geometry.js';
import { classifyGrid } from './classify.js';

/** Words that mark a row as a column heading regardless of digits. */
const HEADER_KEYWORDS =
  /^(note|notes|ref|year|period|restated|audited|unaudited|group|company|parent|consolidated|total|%|change|var(iance)?|budget|actual|forecast|q[1-4]|h[12]|fy)$/i;

const UNIT_IN_HEADER = /GH[¢C₵]|US\$|\bGHS\b|\bUSD\b|['’]?000\b|thousand|million|percent|%/i;

/* ------------------------------------------------------------------ */
/* Vertical banding                                                     */
/* ------------------------------------------------------------------ */

/**
 * Split a page's lines into candidate table bands on unusually large vertical
 * gaps. The threshold scales with the page's own line spacing, not a fixed 28pt.
 */
export function splitBands(lines, metrics, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const threshold = Math.max(
    metrics.medianLineSpacing * o.bandGapSpacings,
    metrics.medianHeight * o.bandGapHeights
  );
  const bands = [];
  let current = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) {
      const gap = lines[i].center - lines[i - 1].center;
      if (gap > threshold) {
        if (current.length) bands.push(current);
        current = [];
      }
    }
    current.push(lines[i]);
  }
  if (current.length) bands.push(current);
  return bands;
}

/* ------------------------------------------------------------------ */
/* Table-level trimming                                                 */
/* ------------------------------------------------------------------ */

function filledCount(row) {
  return row.filter((c) => String(c || '').trim()).length;
}

/**
 * Decide the table's extent ONCE, for the whole table.
 *
 * Rows: keep from the first row that spans two or more columns to the last one.
 * Interior single-column rows (section headings such as "Current assets") are
 * kept, because they carry meaning and dropping them would break the sequence.
 * Leading and trailing single-column rows are captions or body text and belong
 * outside the table.
 *
 * Columns: drop only columns that are empty across EVERY row.
 */
export function trimGrid(grid) {
  const coreIndices = grid.map((r, i) => (filledCount(r) >= 2 ? i : -1)).filter((i) => i >= 0);
  if (!coreIndices.length) {
    return { grid: [], rowOffset: 0, keptColumns: [], leading: grid.slice(), trailing: [] };
  }
  const first = coreIndices[0];
  const last = coreIndices[coreIndices.length - 1];
  const leading = grid.slice(0, first);
  const trailing = grid.slice(last + 1);
  const body = grid.slice(first, last + 1);

  const width = body[0] ? body[0].length : 0;
  const keptColumns = [];
  for (let c = 0; c < width; c += 1) {
    if (body.some((row) => String(row[c] || '').trim())) keptColumns.push(c);
  }

  return {
    grid: body.map((row) => keptColumns.map((c) => row[c])),
    rowOffset: first,
    keptColumns,
    leading,
    trailing
  };
}

/* ------------------------------------------------------------------ */
/* Header detection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Score one row as a header.
 *
 * A four-digit year IS a header cell — that was v1's fatal assumption in
 * reverse. What distinguishes `2011` from data is that it is a bare period
 * label while the body of the same column carries grouped magnitudes.
 */
export function scoreHeaderRow(row, body, columnCount) {
  const cells = row.map((c) => String(c || '').trim());
  const filled = cells.filter(Boolean);
  if (filled.length < 2) return { score: 0, reasons: ['fewer than two filled cells'] };

  let score = 0;
  const reasons = [];

  const labelish = filled.filter(
    (c) => isPeriodLabel(c) || HEADER_KEYWORDS.test(c) || UNIT_IN_HEADER.test(c)
  );
  if (labelish.length === filled.length) {
    score += 0.5;
    reasons.push('every filled cell is a period or column label');
  } else if (labelish.length / filled.length >= 0.6) {
    score += 0.3;
    reasons.push('most filled cells are period or column labels');
  }

  // Classic financial header: blank label cell, filled data cells.
  if (!cells[0] && filled.length >= 2) {
    score += 0.2;
    reasons.push('label cell blank while data cells are filled');
  }

  // Data columns non-numeric here but numeric below.
  let contrast = 0;
  let considered = 0;
  for (let c = 1; c < columnCount; c += 1) {
    const belowFigures = body.filter((r) => parseNumber(r[c]).isNumeric).length;
    if (belowFigures < 2) continue;
    considered += 1;
    const here = parseNumber(cells[c] || '');
    const magnitude = here.isNumeric && !isPeriodLabel(cells[c] || '');
    if (!magnitude) contrast += 1;
  }
  if (considered && contrast === considered) {
    score += 0.3;
    reasons.push('cells are not magnitudes where the column below is numeric');
  } else if (considered && contrast === 0) {
    score -= 0.5;
    reasons.push('cells are ordinary figures — this is a data row');
  }

  // A row label that reads like data pushes back.
  if (cells[0] && /\b(total|assets|liabilities|equity|cash|revenue|profit|loss|inventor|receivab|payab)/i.test(cells[0])) {
    score -= 0.35;
    reasons.push('label cell reads as a line item');
  }

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/**
 * Detect up to two stacked header rows at the top of the trimmed grid.
 * Returns { headers, rows }.
 */
export function detectHeaders(grid, columnCount, opts = {}) {
  const maxHeaderRows = opts.maxHeaderRows ?? 2;
  const threshold = opts.headerThreshold ?? 0.5;
  const headers = [];
  let i = 0;
  while (i < Math.min(maxHeaderRows, grid.length - 1)) {
    const body = grid.slice(i + 1);
    const { score } = scoreHeaderRow(grid[i], body, columnCount);
    if (score < threshold) break;
    headers.push(grid[i]);
    i += 1;
  }
  return { headers, rows: grid.slice(i) };
}

/* ------------------------------------------------------------------ */
/* Candidate assembly                                                   */
/* ------------------------------------------------------------------ */

function bandBBox(lines) {
  if (!lines.length) return null;
  const x = Math.min(...lines.map((l) => l.x));
  const x1 = Math.max(...lines.map((l) => l.x1));
  const y = Math.min(...lines.map((l) => l.top));
  const y1 = Math.max(...lines.map((l) => l.bottom));
  return { x, y, w: x1 - x, h: y1 - y };
}

/**
 * Build one candidate table from a band of lines.
 *
 * Columns are inferred twice: once over the whole band to locate the core, and
 * again over the trimmed rows only, so a caption spanning the page width cannot
 * distort the column bands of the table beneath it.
 */
export function bandToCandidate(band, metrics, ctx = {}, opts = {}) {
  const no = (reason) => ({ rejected: true, reason, ctx });

  const withCells = cellsForLines(band, metrics, opts);
  const columns0 = inferColumns(withCells, metrics, opts);
  if (columns0.length < 2) return no('no vertical gutter separates two columns — continuous text');

  const grid0 = assignGrid(withCells, columns0, metrics);
  const trimmed0 = trimGrid(grid0);
  if (!trimmed0.grid.length) return no('no row spans two or more columns');

  // Re-infer on the trimmed line range only.
  const coreLines = withCells.slice(trimmed0.rowOffset, trimmed0.rowOffset + trimmed0.grid.length);
  const columns = inferColumns(coreLines, metrics, opts);
  if (columns.length < 2) return no('columns collapse once captions are trimmed away');

  const grid1 = assignGrid(coreLines, columns, metrics);
  const trimmed = trimGrid(grid1);
  if (!trimmed.grid.length) return no('no row spans two or more columns after trimming');

  const keptColumns = trimmed.keptColumns.map((i) => columns[i]).filter(Boolean);
  const columnCount = trimmed.grid[0].length;

  const verdict = classifyGrid({ grid: trimmed.grid, columns: keptColumns, metrics });
  const { headers, rows } = detectHeaders(trimmed.grid, columnCount, opts);

  const usedLines = coreLines.slice(trimmed.rowOffset, trimmed.rowOffset + trimmed.grid.length);
  // Lines the table-level trim pushed out of the top of the band: the caption
  // region ("Statement of Financial Position", "GH¢ thousands", "15. Inventories").
  const contextLines = withCells.slice(0, trimmed0.rowOffset + trimmed.rowOffset);

  return {
    grid: trimmed.grid,
    headers,
    rows,
    columns: keptColumns,
    columnCount,
    verdict,
    bbox: bandBBox(usedLines.length ? usedLines : coreLines),
    lines: usedLines.length ? usedLines : coreLines,
    contextLines: dedupeLines(contextLines),
    ctx
  };
}

function dedupeLines(lines) {
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const key = `${l.center}:${l.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out.sort((a, b) => a.center - b.center);
}

/**
 * Full page pipeline: words -> Table[].
 *
 * @param {object} input
 * @param {object[]} input.words   normalised words for the page
 * @param {number}   input.page
 * @param {string}   input.docId
 * @param {string}   input.sourceFile
 * @param {string}   input.origin
 */
export function buildPageTables(input, opts = {}) {
  const { words = [], page = 1, docId = null, sourceFile = '', origin = 'pdf-text' } = input;
  const minConfidence = opts.minConfidence ?? MIN_TABLE_CONFIDENCE;
  if (!words.length) return { tables: [], rejected: [], metrics: null, lines: [] };

  const metrics = pageMetrics(words, opts);
  const lines = groupLines(words, metrics, opts);
  const withCells = cellsForLines(lines, metrics, opts);
  const bands = splitBands(withCells, metrics, opts);

  const tables = [];
  const rejected = [];
  let index = 0;

  bands.forEach((band, bandIndex) => {
    const candidate = bandToCandidate(band, metrics, { page, bandIndex }, opts);
    if (!candidate) return;
    if (candidate.rejected) {
      rejected.push({
        page,
        bandIndex,
        confidence: 0,
        reasons: [candidate.reason],
        preview: band.slice(0, 2).map((l) => [l.text])
      });
      return;
    }
    if (!candidate.verdict.isTable || candidate.verdict.confidence < minConfidence) {
      rejected.push({
        page,
        bandIndex,
        confidence: candidate.verdict.confidence,
        reasons: candidate.verdict.reasons,
        preview: candidate.grid.slice(0, 3)
      });
      return;
    }

    const table = createTable({
      docId,
      sourceFile,
      page,
      index,
      origin,
      headers: candidate.headers,
      rows: candidate.rows,
      columnCount: candidate.columnCount,
      confidence: candidate.verdict.confidence,
      warnings: candidate.verdict.warnings,
      bbox: candidate.bbox,
      signals: candidate.verdict.signals
    });
    table._lines = candidate.lines;
    table._contextLines = candidate.contextLines;
    table._columns = candidate.columns;
    if (!candidate.headers.length) {
      table.warnings.push('no header row detected; columns are positional');
    }
    normaliseTable(table);
    tables.push(table);
    index += 1;
  });

  return { tables, rejected, metrics, lines: withCells };
}

export default {
  splitBands,
  trimGrid,
  scoreHeaderRow,
  detectHeaders,
  bandToCandidate,
  buildPageTables
};
