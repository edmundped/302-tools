/**
 * core/csv.js — the three emitters.
 *
 *   1. machine  {base}_data.csv                 tidy/long, one row per cell
 *   2. analyst  {base}_p{page}_t{n}_review.csv  one file per table, faithful
 *   3. notes    {base}_notes.csv                notes tables only
 *
 * Quoting is NEVER disabled. v1 called Papa.unparse(rows, { quotes: false }),
 * which turned every 12,442,697 into two columns.
 *
 * Papa Parse is used when present (browser). A byte-compatible fallback keeps
 * this module importable in plain Node so the test harness needs no deps.
 */

import { parseNumber, sumCells, unitScale } from './numbers.js';
import { flatHeaders, validateTable } from './model.js';

const NEWLINE = '\r\n';

/** Row labels that mean "this row foots the ones above it". */
const TOTAL_RE = /\b(total|sub-?total|net\s+(assets|liabilities|position|cash)|aggregate|sum)\b/i;

/* ------------------------------------------------------------------ */
/* CSV encode / decode                                                 */
/* ------------------------------------------------------------------ */

function fallbackUnparse(rows, newline) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = cell === null || cell === undefined ? '' : String(cell);
          return `"${s.replace(/"/g, '""')}"`;
        })
        .join(',')
    )
    .join(newline);
}

/**
 * Always-quoted CSV. Delegates to Papa when available so the browser build
 * honours the contract literally; the fallback produces identical bytes.
 */
export function unparse(rows, opts = {}) {
  const newline = opts.newline || NEWLINE;
  const P = globalThis.Papa;
  if (P && typeof P.unparse === 'function') {
    return P.unparse(rows, { quotes: true, newline });
  }
  return fallbackUnparse(rows, newline);
}

function fallbackParse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  let sawField = false;

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      sawField = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      sawField = false;
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawField = false;
      i += 1;
      continue;
    }
    field += ch;
    sawField = true;
    i += 1;
  }
  if (field.length || sawField || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV back to string[][]. Used by the round-trip guarantee test. */
export function parse(text) {
  const P = globalThis.Papa;
  if (P && typeof P.parse === 'function') {
    return P.parse(String(text), { skipEmptyLines: false }).data;
  }
  return fallbackParse(String(text));
}

export function filenameBase(name) {
  return (
    String(name || 'export')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9_-]+/gi, '_')
      .replace(/^_+|_+$/g, '') || 'export'
  );
}

/* ------------------------------------------------------------------ */
/* check_total — computed, never the literal string 'printed_total'    */
/* ------------------------------------------------------------------ */

function isTotalRow(row) {
  return TOTAL_RE.test(String(row[0] || ''));
}

/**
 * Which columns hold figures? A column qualifies when at least half its
 * non-empty body cells parse as numbers or explicit nils.
 */
export function numericColumns(table) {
  const cols = [];
  for (let c = 1; c < table.columnCount; c += 1) {
    let filled = 0;
    let figures = 0;
    let magnitudes = 0;
    for (const row of table.rows) {
      const cell = String(row[c] || '').trim();
      if (!cell) continue;
      filled += 1;
      const p = parseNumber(cell);
      if (p.isNumeric || p.isNil) figures += 1;
      if (p.isNumeric && (Math.abs(p.value) >= 1000 || String(cell).includes('.'))) magnitudes += 1;
    }
    if (filled >= 2 && figures / filled >= 0.5 && magnitudes >= 1) cols.push(c);
  }
  return cols;
}

/**
 * For every total row, sum the figures in its group (the consecutive rows since
 * the last total row or the table start, ignoring label-only section rows) and
 * compare with the printed figure.
 *
 * A group with fewer than two contributing figures is not reported — a
 * one-member "sum" is noise, and we would rather say nothing than cry wolf.
 */
export function computeCheckTotals(table) {
  const cols = numericColumns(table);
  const labels = flatHeaders(table);
  const out = new Array(table.rows.length).fill('');
  if (!cols.length) return out;

  let groupStart = 0;
  table.rows.forEach((row, r) => {
    if (!isTotalRow(row)) return;

    const members = [];
    for (let i = groupStart; i < r; i += 1) {
      if (isTotalRow(table.rows[i])) continue;
      members.push(table.rows[i]);
    }
    groupStart = r + 1;

    const parts = [];
    for (const c of cols) {
      const printed = parseNumber(row[c]);
      if (!printed.isNumeric) continue;
      const { sum, count } = sumCells(members.map((m) => m[c]));
      if (count < 2) continue;
      const diff = Number((sum - printed.value).toPrecision(12));
      const label = labels[c] || `column_${c}`;
      parts.push(Math.abs(diff) < 0.005 ? `${label}: ok` : `${label}: calc ${sum} vs printed ${printed.value} (diff ${diff})`);
    }
    out[r] = parts.join('; ');
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* 1. Machine (tidy / long)                                            */
/* ------------------------------------------------------------------ */

export const MACHINE_HEADER = [
  'source_file',
  'page',
  'table_id',
  'table_title',
  'note_ref',
  'section',
  'row_label',
  'column',
  'value',
  'unit'
];

export function machineRows(tables) {
  const rows = [MACHINE_HEADER.slice()];
  for (const table of tables) {
    validateTable(table);
    const labels = flatHeaders(table);
    for (const row of table.rows) {
      const rowLabel = String(row[0] || '').trim();
      for (let c = 1; c < table.columnCount; c += 1) {
        const cell = String(row[c] || '');
        if (!cell.trim()) continue;
        const p = parseNumber(cell);
        rows.push([
          table.sourceFile,
          table.page,
          table.id,
          table.title || '',
          table.noteRef || '',
          table.section || '',
          rowLabel,
          labels[c],
          // nils are meaningful emptiness, not zero
          p.isNumeric ? p.clean : p.isNil ? '' : cell.trim(),
          table.units || ''
        ]);
      }
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 2. Analyst (wide, faithful) — one file per table                    */
/* ------------------------------------------------------------------ */

export function analystRows(table) {
  validateTable(table);
  const labels = flatHeaders(table);
  const checks = computeCheckTotals(table);
  const out = [['source_file', 'page', ...labels, 'check_total']];
  table.rows.forEach((row, r) => {
    out.push([table.sourceFile, table.page, ...row, checks[r]]);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. Notes only                                                       */
/* ------------------------------------------------------------------ */

function noteSortKey(table) {
  const n = Number.parseFloat(String(table.noteRef || '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

export function selectNoteTables(tables) {
  return tables
    .filter((t) => t.section === 'notes')
    .slice()
    .sort((a, b) => noteSortKey(a) - noteSortKey(b) || a.page - b.page || String(a.id).localeCompare(String(b.id)));
}

export const NOTES_HEADER = [
  'source_file',
  'page',
  'note_ref',
  'note_title',
  'table_id',
  'row_label',
  'column',
  'value',
  'raw',
  'unit'
];

export function notesRows(tables) {
  const rows = [NOTES_HEADER.slice()];
  for (const table of selectNoteTables(tables)) {
    const labels = flatHeaders(table);
    for (const row of table.rows) {
      const rowLabel = String(row[0] || '').trim();
      for (let c = 1; c < table.columnCount; c += 1) {
        const cell = String(row[c] || '');
        if (!cell.trim()) continue;
        const p = parseNumber(cell);
        rows.push([
          table.sourceFile,
          table.page,
          table.noteRef || '',
          table.title || '',
          table.id,
          rowLabel,
          labels[c],
          p.isNumeric ? p.clean : p.isNil ? '' : cell.trim(),
          cell,
          table.units || ''
        ]);
      }
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Bundling                                                            */
/* ------------------------------------------------------------------ */

export const INDEX_HEADER = [
  'table_id',
  'source_file',
  'page',
  'origin',
  'section',
  'note_ref',
  'title',
  'units',
  'columns',
  'rows',
  'confidence',
  'warnings'
];

export function indexRows(tables) {
  const rows = [INDEX_HEADER.slice()];
  for (const t of tables) {
    rows.push([
      t.id,
      t.sourceFile,
      t.page,
      t.origin,
      t.section || '',
      t.noteRef || '',
      t.title || '',
      t.units || '',
      t.columnCount,
      t.rows.length,
      t.confidence.toFixed(2),
      (t.warnings || []).join(' | ')
    ]);
  }
  return rows;
}

/**
 * Everything a download bundle needs: [{ name, text }].
 * Analyst output is one file per table — never one concatenated pseudo-CSV.
 */
export function emitAll(tables, sourceName, opts = {}) {
  const selected = tables.filter((t) => t.selected !== false);
  const base = filenameBase(sourceName);
  const files = [{ name: `${base}_data.csv`, text: unparse(machineRows(selected)) }];

  const counters = new Map();
  for (const table of selected) {
    const n = (counters.get(table.page) || 0) + 1;
    counters.set(table.page, n);
    files.push({
      name: `${base}_p${table.page}_t${n}_review.csv`,
      text: unparse(analystRows(table))
    });
  }

  if (selected.some((t) => t.section === 'notes')) {
    files.push({ name: `${base}_notes.csv`, text: unparse(notesRows(selected)) });
  }

  if (opts.includeIndex !== false) {
    files.push({ name: `${base}_index.csv`, text: unparse(indexRows(selected)) });
  }
  return files;
}

/** Wide grid for a spreadsheet sheet: header rows then body. */
export function tableGrid(table) {
  return [...table.headers, ...table.rows];
}

/**
 * SheetJS workbook: one sheet per table (p{page}_t{n}) plus an INDEX sheet.
 * Requires the XLSX global; throws a clear error when it is missing.
 */
export function toWorkbook(tables, opts = {}) {
  const XLSX = opts.XLSX || globalThis.XLSX;
  if (!XLSX) throw new Error('toWorkbook: SheetJS (XLSX) is not loaded');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(indexRows(tables)), 'INDEX');
  const counters = new Map();
  const used = new Set(['INDEX']);
  for (const table of tables) {
    const n = (counters.get(table.page) || 0) + 1;
    counters.set(table.page, n);
    let name = `p${table.page}_t${n}`.slice(0, 31);
    let suffix = 1;
    while (used.has(name)) name = `p${table.page}_t${n}_${suffix++}`.slice(0, 31);
    used.add(name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tableGrid(table)), name);
  }
  return wb;
}

/** Apply a caption's unit scale to a tidy value. Kept here so emitters agree. */
export function scaleValue(value, units) {
  if (!Number.isFinite(value)) return value;
  return value * unitScale(units);
}

export default {
  unparse,
  parse,
  filenameBase,
  machineRows,
  analystRows,
  notesRows,
  indexRows,
  emitAll,
  toWorkbook,
  computeCheckTotals,
  numericColumns,
  selectNoteTables
};
