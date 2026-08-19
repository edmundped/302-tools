/**
 * extract/classify.js — is this a table, or is it prose?
 *
 * v1 asked "does this line have two or more text items?". Every sentence does.
 * Pages of continuous prose were emitted as confident multi-column tables,
 * which is worse than emitting nothing.
 *
 * Here a candidate is scored on six independent signals and must clear both a
 * set of hard gates and a confidence floor. Nothing is emitted silently: the
 * score and the reasons travel with the table.
 */

import { parseNumber, isPeriodLabel } from '../core/numbers.js';
import { alignmentQuality } from './geometry.js';

export const WEIGHTS = Object.freeze({
  columns: 0.2,
  coreRows: 0.2,
  numeric: 0.25,
  brevity: 0.15,
  alignment: 0.15,
  size: 0.05
});

export const GATES = Object.freeze({
  minColumns: 2,
  minRows: 2,
  /** fraction of rows that must actually span two or more columns */
  minCoreRowFraction: 0.35,
  /** a cell in a data column holding this many words is prose, not a figure */
  proseWordsPerCell: 6
});

function clamp01(n) {
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n;
}

function nonEmpty(row) {
  return row.filter((c) => String(c || '').trim()).length;
}

/**
 * A "core row" spans two or more columns — the thing that actually makes a
 * grid. Section headings inside a statement ("Current assets") are not core
 * rows, but they are legitimate table rows, so we measure the fraction rather
 * than requiring every row to qualify.
 */
export function coreRowFraction(grid) {
  if (!grid.length) return 0;
  return grid.filter((r) => nonEmpty(r) >= 2).length / grid.length;
}

/**
 * Score a candidate grid.
 *
 * @param {object} candidate
 * @param {string[][]} candidate.grid      rectangular rows (headers included)
 * @param {object[]}   candidate.columns   from geometry.inferColumns
 * @param {object}     candidate.metrics   from geometry.pageMetrics
 */
export function classifyGrid(candidate) {
  const { grid = [], columns = [], metrics = { medianHeight: 10 } } = candidate;
  const warnings = [];
  const reasons = [];

  const columnCount = columns.length || Math.max(0, ...grid.map((r) => r.length));
  const rowCount = grid.length;

  // ---- signals -----------------------------------------------------
  const sColumns = clamp01((columnCount - 1) / 2);
  const sCore = coreRowFraction(grid);

  // Numeric density across data columns only (column 0 is the label column).
  let dataCells = 0;
  let figureCells = 0;
  let wordTotal = 0;
  for (const row of grid) {
    for (let c = 1; c < columnCount; c += 1) {
      const text = String(row[c] || '').trim();
      if (!text) continue;
      dataCells += 1;
      wordTotal += text.split(/\s+/).length;
      const p = parseNumber(text);
      if (p.isNumeric || p.isNil || isPeriodLabel(text)) figureCells += 1;
    }
  }
  const sNumeric = dataCells ? figureCells / dataCells : 0;
  const avgWords = dataCells ? wordTotal / dataCells : 0;
  const sBrevity = dataCells ? clamp01(1 - (avgWords - 1) / 3) : 0;

  const numericCols = columns.filter((c) => (c.numericFraction || 0) >= 0.5);
  const sAlignment = numericCols.length
    ? numericCols.reduce((a, c) => a + alignmentQuality(c, metrics), 0) / numericCols.length
    : 0;

  const sSize = clamp01(rowCount / 3);

  const signals = {
    columns: sColumns,
    coreRows: sCore,
    numeric: sNumeric,
    brevity: sBrevity,
    alignment: sAlignment,
    size: sSize,
    columnCount,
    rowCount,
    dataCells,
    avgWordsPerDataCell: Number(avgWords.toFixed(2))
  };

  let confidence =
    WEIGHTS.columns * sColumns +
    WEIGHTS.coreRows * sCore +
    WEIGHTS.numeric * sNumeric +
    WEIGHTS.brevity * sBrevity +
    WEIGHTS.alignment * sAlignment +
    WEIGHTS.size * sSize;

  // ---- hard gates --------------------------------------------------
  let isTable = true;
  if (columnCount < GATES.minColumns) {
    isTable = false;
    reasons.push(`only ${columnCount} column(s)`);
  }
  if (rowCount < GATES.minRows) {
    isTable = false;
    reasons.push(`only ${rowCount} row(s)`);
  }
  if (sCore < GATES.minCoreRowFraction) {
    isTable = false;
    reasons.push(`only ${Math.round(sCore * 100)}% of rows span two or more columns — reads as prose or a list`);
  }
  if (dataCells && avgWords >= GATES.proseWordsPerCell) {
    isTable = false;
    reasons.push(`data cells average ${avgWords.toFixed(1)} words — reads as sentences, not figures`);
  }

  if (!isTable) confidence = Math.min(confidence, 0.25);

  // ---- honest warnings on the tables we do keep --------------------
  if (isTable) {
    if (sNumeric < 0.5) warnings.push(`only ${Math.round(sNumeric * 100)}% of data cells parse as figures`);
    if (sAlignment < 0.6 && numericCols.length) warnings.push('numeric columns are loosely aligned; check column splits');
    if (sCore < 0.6) warnings.push(`${Math.round((1 - sCore) * 100)}% of rows occupy a single column`);
    if (confidence < 0.6) warnings.push('low extraction confidence — review before use');
  }

  return {
    isTable,
    confidence: Number(clamp01(confidence).toFixed(3)),
    signals,
    warnings,
    reasons
  };
}

/**
 * Page-level verdict used by the UI and by region-OCR triage.
 * A page whose lines never split into cells is prose whatever else is true.
 */
export function classifyPage(lines) {
  const total = lines.length || 1;
  const multi = lines.filter((l) => (l.cells || []).length >= 2).length;
  const fraction = multi / total;
  return {
    tabularLineFraction: Number(fraction.toFixed(3)),
    verdict: fraction >= 0.35 ? 'tabular' : fraction >= 0.12 ? 'mixed' : 'prose'
  };
}

export default { classifyGrid, classifyPage, coreRowFraction, WEIGHTS, GATES };
