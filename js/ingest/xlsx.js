/**
 * ingest/xlsx.js — SheetJS -> Tables.
 *
 * Real analyst workbooks are not one grid per sheet. The sample
 * (Fan Milk PLc.xlsx, 18 sheets) is typical:
 *   - 13 sheets are named _TM_* and hold Left/Top/Right/Bottom/Ref rectangles.
 *     They are ThinkCell/link metadata, not data, and must not be emitted.
 *   - 'Historical Positions' has two blank leading columns, three blank leading
 *     rows, a 3-row header starting at row 4, and several blocks of data laid
 *     out SIDE BY SIDE across the sheet.
 *
 * So: find the used range, find the islands inside it, and treat each island as
 * its own table with its own header rows.
 *
 * The island/header logic below is pure and takes a plain string[][] matrix, so
 * it is testable without SheetJS.
 */

import { parseNumber, isPeriodLabel } from '../core/numbers.js';
import { createDoc, createPage, createTable, uuid } from '../core/model.js';
import { classifyGrid } from '../extract/classify.js';
import { matcher, progressReporter, throwIfAborted } from './index.js';

export const XLSX_DEFAULTS = Object.freeze({
  maxHeaderRows: 4,
  minIslandRows: 2,
  minIslandCols: 2,
  minIslandCells: 4,
  /** islands separated by at least this many blank columns/rows are distinct */
  blankRun: 1
});

/** _TM_* sheets, and anything with the Left/Top/Right/Bottom/Ref signature. */
export const METADATA_SHEET_NAME = /^_TM_|^_xl|^Sheet\d+_meta$/i;
const METADATA_HEADER = ['left', 'top', 'right', 'bottom', 'ref'];

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return String(v.w ?? v.v ?? '').trim();
  return String(v).trim();
}

export function isMetadataSheet(name, matrix) {
  if (METADATA_SHEET_NAME.test(String(name || ''))) return true;
  const firstFilled = (matrix || []).find((row) => row && row.some((c) => cellText(c)));
  if (!firstFilled) return false;
  const head = firstFilled.map(cellText).filter(Boolean).slice(0, 5).map((s) => s.toLowerCase());
  return head.length === 5 && METADATA_HEADER.every((h, i) => head[i] === h);
}

/* ------------------------------------------------------------------ */
/* Used range + islands                                                 */
/* ------------------------------------------------------------------ */

/** Bounding box of the non-empty cells: skips blank leading rows and columns. */
export function usedRange(matrix) {
  let r0 = Infinity;
  let r1 = -1;
  let c0 = Infinity;
  let c1 = -1;
  matrix.forEach((row, r) => {
    (row || []).forEach((cell, c) => {
      if (!cellText(cell)) return;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
    });
  });
  if (r1 < 0) return null;
  return { r0, r1, c0, c1 };
}

function occupiedColumns(matrix, range) {
  const cols = [];
  for (let c = range.c0; c <= range.c1; c += 1) {
    let filled = 0;
    for (let r = range.r0; r <= range.r1; r += 1) {
      if (cellText((matrix[r] || [])[c])) filled += 1;
    }
    cols.push(filled > 0);
  }
  return cols;
}

function runsOf(flags, offset, blankRun) {
  const runs = [];
  let start = -1;
  let blanks = 0;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) {
      if (start < 0) start = i;
      blanks = 0;
    } else if (start >= 0) {
      blanks += 1;
      if (blanks >= blankRun) {
        runs.push([start + offset, i - blanks + offset]);
        start = -1;
        blanks = 0;
      }
    }
  }
  if (start >= 0) runs.push([start + offset, flags.length - 1 - (flags[flags.length - 1] ? 0 : blanks) + offset]);
  return runs;
}

/**
 * Rectangular blocks of data separated by blank columns and blank rows.
 * Returns [{ r0, r1, c0, c1 }] shrunk to their own non-empty bounds.
 */
export function findIslands(matrix, opts = {}) {
  const o = { ...XLSX_DEFAULTS, ...opts };
  const range = usedRange(matrix);
  if (!range) return [];

  const colRuns = runsOf(occupiedColumns(matrix, range), range.c0, o.blankRun);
  const islands = [];

  for (const [c0, c1] of colRuns) {
    // Within this column strip, split on blank rows.
    const rowFlags = [];
    for (let r = range.r0; r <= range.r1; r += 1) {
      let filled = 0;
      for (let c = c0; c <= c1; c += 1) if (cellText((matrix[r] || [])[c])) filled += 1;
      rowFlags.push(filled > 0);
    }
    for (const [r0, r1] of runsOf(rowFlags, range.r0, Math.max(o.blankRun, 2))) {
      const island = shrink(matrix, { r0, r1, c0, c1 });
      if (!island) continue;
      const cells = countCells(matrix, island);
      const rows = island.r1 - island.r0 + 1;
      const cols = island.c1 - island.c0 + 1;
      if (rows < o.minIslandRows || cols < o.minIslandCols || cells < o.minIslandCells) continue;
      islands.push(island);
    }
  }
  return islands.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
}

function shrink(matrix, box) {
  let { r0, r1, c0, c1 } = box;
  const filled = (r, c) => Boolean(cellText((matrix[r] || [])[c]));
  const rowEmpty = (r) => {
    for (let c = c0; c <= c1; c += 1) if (filled(r, c)) return false;
    return true;
  };
  const colEmpty = (c) => {
    for (let r = r0; r <= r1; r += 1) if (filled(r, c)) return false;
    return true;
  };
  while (r0 <= r1 && rowEmpty(r0)) r0 += 1;
  while (r1 >= r0 && rowEmpty(r1)) r1 -= 1;
  while (c0 <= c1 && colEmpty(c0)) c0 += 1;
  while (c1 >= c0 && colEmpty(c1)) c1 -= 1;
  return r1 >= r0 && c1 >= c0 ? { r0, r1, c0, c1 } : null;
}

function countCells(matrix, box) {
  let n = 0;
  for (let r = box.r0; r <= box.r1; r += 1) {
    for (let c = box.c0; c <= box.c1; c += 1) if (cellText((matrix[r] || [])[c])) n += 1;
  }
  return n;
}

export function sliceIsland(matrix, island) {
  const out = [];
  for (let r = island.r0; r <= island.r1; r += 1) {
    const row = [];
    for (let c = island.c0; c <= island.c1; c += 1) row.push(cellText((matrix[r] || [])[c]));
    out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Headers                                                              */
/* ------------------------------------------------------------------ */

/** A magnitude, i.e. data — as opposed to a year, which is a header label. */
function isDataFigure(text) {
  const p = parseNumber(text);
  return p.isNumeric && !isPeriodLabel(text);
}

/**
 * How many leading rows of a grid are headers.
 *
 * A row is a header while fewer than half its filled cells are magnitudes.
 * Rows of years ('2023 2024 2025') and rows of qualifiers ('Audited Audited
 * CAGR') both qualify, which is exactly the 3-row header the sample workbook
 * carries at rows 4-6 of 'Historical Positions'.
 */
export function detectHeaderRows(grid, opts = {}) {
  const o = { ...XLSX_DEFAULTS, ...opts };
  let n = 0;
  const limit = Math.min(o.maxHeaderRows, Math.max(0, grid.length - 1));
  while (n < limit) {
    const row = grid[n];
    const filled = row.filter(Boolean);
    if (!filled.length) {
      n += 1;
      continue;
    }
    const magnitudes = filled.filter(isDataFigure).length;
    if (magnitudes / filled.length >= 0.5) break;
    n += 1;
  }
  // A grid that is all header is not a table; keep at least one body row.
  return Math.min(n, Math.max(0, grid.length - 1));
}

/**
 * Forward-fill merged header cells so every column carries its group label.
 * `merges` are SheetJS ranges ({ s:{r,c}, e:{r,c} }) in sheet coordinates.
 */
export function applyMerges(matrix, merges) {
  if (!merges || !merges.length) return matrix;
  const out = matrix.map((row) => (row || []).slice());
  for (const m of merges) {
    const value = cellText((out[m.s.r] || [])[m.s.c]);
    if (!value) continue;
    for (let r = m.s.r; r <= m.e.r; r += 1) {
      if (!out[r]) out[r] = [];
      for (let c = m.s.c; c <= m.e.c; c += 1) out[r][c] = value;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sheet -> Tables                                                      */
/* ------------------------------------------------------------------ */

export function sheetToTables(sheetName, matrix, ctx = {}, opts = {}) {
  if (isMetadataSheet(sheetName, matrix)) return [];
  const islands = findIslands(matrix, opts);
  const tables = [];

  islands.forEach((island, i) => {
    const grid = sliceIsland(matrix, island);
    const headerCount = detectHeaderRows(grid, opts);
    const headers = grid.slice(0, headerCount);
    const rows = grid.slice(headerCount);
    if (!rows.length) return;

    const columnCount = Math.max(...grid.map((r) => r.length));
    const verdict = classifyGrid({
      grid,
      columns: pseudoColumns(grid, columnCount),
      metrics: { medianHeight: 10 }
    });

    const warnings = [...verdict.warnings];
    if (!headerCount) warnings.push('no header row detected; columns are positional');

    const table = createTable({
      docId: ctx.docId,
      sourceFile: ctx.fileName,
      page: ctx.sheetIndex ?? 0,
      index: i,
      origin: 'xlsx',
      title: sheetName,
      section: 'other',
      headers,
      rows,
      columnCount,
      // A spreadsheet is already a grid; the only real risk is mis-cut islands.
      confidence: Math.max(verdict.confidence, 0.75),
      warnings,
      signals: verdict.signals
    });
    table.id = `${ctx.docId}-s${ctx.sheetIndex ?? 0}-t${i}`;
    table.sheetName = sheetName;
    table.range = island;
    tables.push(table);
  });

  return tables;
}

/** classifyGrid wants column objects; a spreadsheet has no geometry, so fake it. */
function pseudoColumns(grid, columnCount) {
  const cols = [];
  for (let c = 0; c < columnCount; c += 1) {
    const cells = grid.map((r) => r[c]).filter(Boolean);
    const figures = cells.filter((t) => parseNumber(t).isNumeric || parseNumber(t).isNil).length;
    cols.push({
      index: c,
      cells: cells.map((t) => ({ text: t, x: c * 100, x1: c * 100 + 80, isFigure: true })),
      align: 'right',
      numericFraction: cells.length ? figures / cells.length : 0,
      anchor: c * 100 + 80,
      left: c * 100,
      right: c * 100 + 80
    });
  }
  return cols;
}

/* ------------------------------------------------------------------ */
/* Extractor                                                            */
/* ------------------------------------------------------------------ */

export const SHEETJS_VERSION = '0.20.3';
const SHEETJS_CDN = `https://cdn.sheetjs.com/xlsx-${SHEETJS_VERSION}/package/xlsx.mjs`;

export async function loadSheetJs(opts = {}) {
  if (opts.XLSX) return opts.XLSX;
  if (globalThis.XLSX) return globalThis.XLSX;
  const m = await import(/* @vite-ignore */ opts.sheetjsCdn || SHEETJS_CDN);
  return m.default || m;
}

/** SheetJS worksheet -> string matrix, with merged cells forward-filled. */
export function worksheetToMatrix(XLSX, sheet) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
  return applyMerges(raw, sheet['!merges']);
}

export async function extractXlsx(file, opts = {}, onProgress) {
  const report = progressReporter(onProgress);
  const XLSX = await loadSheetJs(opts);
  const buffer = await file.arrayBuffer();
  throwIfAborted(opts.signal);

  const wb = XLSX.read(buffer, { type: 'array', cellDates: true, cellStyles: false });
  const docId = opts.docId || uuid();
  const tables = [];
  const pages = [];
  const skipped = [];

  wb.SheetNames.forEach((name, sheetIndex) => {
    throwIfAborted(opts.signal);
    report('xlsx', sheetIndex + 1, wb.SheetNames.length, `Reading sheet "${name}" (${sheetIndex + 1}/${wb.SheetNames.length})`);
    const matrix = worksheetToMatrix(XLSX, wb.Sheets[name]);

    if (isMetadataSheet(name, matrix)) {
      skipped.push(name);
      pages.push(createPage({ number: sheetIndex + 1, textChars: 0, hasTextLayer: true, section: 'other' }));
      return;
    }

    const sheetTables = sheetToTables(name, matrix, { docId, fileName: file.name, sheetIndex: sheetIndex + 1 }, opts);
    tables.push(...sheetTables);
    pages.push(
      createPage({
        number: sheetIndex + 1,
        textChars: matrix.reduce((n, row) => n + row.reduce((m, c) => m + String(c || '').length, 0), 0),
        hasTextLayer: true,
        section: 'other'
      })
    );
  });

  const doc = createDoc({
    id: docId,
    fileName: file.name,
    fileType: 'xlsx',
    pageCount: wb.SheetNames.length,
    pages,
    tables
  });
  if (skipped.length) {
    doc.warnings.push(
      `Skipped ${skipped.length} metadata sheet(s) that hold link rectangles rather than data: ${skipped.join(', ')}`
    );
  }
  report('xlsx', wb.SheetNames.length, wb.SheetNames.length, `${tables.length} table(s) from ${wb.SheetNames.length} sheet(s)`);
  return doc;
}

export const extractor = {
  id: 'xlsx',
  label: 'Excel workbook',
  priority: 10,
  accepts: matcher({
    extensions: ['xlsx', 'xlsm', 'xls', 'ods'],
    mimes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.oasis.opendocument.spreadsheet'
    ]
  }),
  extract: extractXlsx
};

export default {
  extractor,
  extractXlsx,
  sheetToTables,
  findIslands,
  usedRange,
  sliceIsland,
  detectHeaderRows,
  isMetadataSheet,
  applyMerges,
  worksheetToMatrix
};
