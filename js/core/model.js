/**
 * core/model.js — Doc / Page / Table factories and validators.
 *
 * Nothing but Docs and Tables crosses a module boundary.
 * Rectangularity is a hard invariant: validateTable throws if any row length
 * differs from columnCount. Pad with ''. Never trim a single row on its own.
 */

/** Chars of non-boilerplate body text below which a page is assumed scanned. */
export const TEXT_LAYER_MIN = 180;

/** Tables scoring below this are not emitted without an explicit override. */
export const MIN_TABLE_CONFIDENCE = 0.4;

export const SECTIONS = ['statements', 'notes', 'front', 'other'];
export const ORIGINS = ['pdf-text', 'pdf-ocr', 'xlsx', 'docx', 'image', 'html'];

let counter = 0;

export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  counter += 1;
  return `id-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function str(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  const s = String(v);
  return s.length ? s : fallback;
}

export function createPage(init = {}) {
  return {
    number: Number(init.number) || 0,
    textChars: Number(init.textChars) || 0,
    hasTextLayer: Boolean(init.hasTextLayer),
    needsOcr: Boolean(init.needsOcr),
    ocrApplied: Boolean(init.ocrApplied),
    section: init.section ?? null,
    thumbnail: init.thumbnail ?? null,
    // working data, not part of the wire contract but carried between passes
    words: init.words || [],
    imageRegions: init.imageRegions || [],
    warnings: init.warnings ? [...init.warnings] : []
  };
}

export function createTable(init = {}) {
  const rows = (init.rows || []).map((r) => (r || []).map((c) => (c === null || c === undefined ? '' : String(c))));
  const headers = (init.headers || []).map((r) => (r || []).map((c) => (c === null || c === undefined ? '' : String(c))));
  const columnCount = Number(init.columnCount) || Math.max(0, ...rows.map((r) => r.length), ...headers.map((r) => r.length));

  const table = {
    id: init.id || `${init.docId || 'doc'}-p${init.page ?? 0}-t${init.index ?? 0}`,
    docId: init.docId ?? null,
    sourceFile: str(init.sourceFile, ''),
    page: Number(init.page) || 0,
    origin: init.origin || 'pdf-text',
    title: str(init.title),
    noteRef: str(init.noteRef),
    section: init.section ?? null,
    units: str(init.units),
    headers,
    rows,
    columnCount,
    confidence: typeof init.confidence === 'number' ? clamp01(init.confidence) : 0,
    warnings: init.warnings ? [...init.warnings] : [],
    bbox: init.bbox || null,
    selected: init.selected !== false,
    signals: init.signals || null
  };
  return normaliseTable(table);
}

export function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Pad every row and header row out to columnCount. Mutates and returns. */
export function normaliseTable(table) {
  const width = Math.max(
    Number(table.columnCount) || 0,
    ...table.rows.map((r) => r.length),
    ...table.headers.map((r) => r.length),
    0
  );
  table.columnCount = width;
  const pad = (r) => {
    const row = r.slice(0, width);
    while (row.length < width) row.push('');
    return row;
  };
  table.rows = table.rows.map(pad);
  table.headers = table.headers.map(pad);
  return table;
}

/** Throws unless the table satisfies the rectangularity invariant. */
export function validateTable(table) {
  if (!table || typeof table !== 'object') throw new TypeError('validateTable: not a table');
  if (!Number.isInteger(table.columnCount) || table.columnCount < 0) {
    throw new TypeError(`validateTable(${table.id}): columnCount must be a non-negative integer`);
  }
  if (!Array.isArray(table.rows) || !Array.isArray(table.headers)) {
    throw new TypeError(`validateTable(${table.id}): rows and headers must be arrays`);
  }
  table.rows.forEach((row, i) => {
    if (!Array.isArray(row)) throw new TypeError(`validateTable(${table.id}): row ${i} is not an array`);
    if (row.length !== table.columnCount) {
      throw new RangeError(
        `validateTable(${table.id}): row ${i} has ${row.length} cells, expected ${table.columnCount}`
      );
    }
  });
  table.headers.forEach((row, i) => {
    if (row.length !== table.columnCount) {
      throw new RangeError(
        `validateTable(${table.id}): header row ${i} has ${row.length} cells, expected ${table.columnCount}`
      );
    }
  });
  if (table.section !== null && !SECTIONS.includes(table.section)) {
    throw new RangeError(`validateTable(${table.id}): unknown section "${table.section}"`);
  }
  if (!ORIGINS.includes(table.origin)) {
    throw new RangeError(`validateTable(${table.id}): unknown origin "${table.origin}"`);
  }
  return table;
}

export function createDoc(init = {}) {
  const doc = {
    id: init.id || uuid(),
    fileName: str(init.fileName, 'untitled'),
    fileType: init.fileType || 'pdf',
    pageCount: Number(init.pageCount) || (init.pages ? init.pages.length : 0),
    pages: (init.pages || []).map(createPage),
    tables: init.tables || [],
    meta: {
      title: null,
      company: null,
      periodLabel: null,
      currency: null,
      unitsScale: null,
      ...(init.meta || {})
    },
    warnings: init.warnings ? [...init.warnings] : []
  };
  return doc;
}

export function validateDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new TypeError('validateDoc: not a doc');
  doc.tables.forEach(validateTable);
  return doc;
}

/** Add a warning without duplicating it. */
export function warn(target, message) {
  if (!target.warnings) target.warnings = [];
  if (!target.warnings.includes(message)) target.warnings.push(message);
  return target;
}

/** Flatten multi-row headers into one label per column, for CSV column names. */
export function flatHeaders(table) {
  const width = table.columnCount;
  const out = [];
  for (let c = 0; c < width; c += 1) {
    const parts = [];
    for (const row of table.headers) {
      const cell = (row[c] || '').trim();
      if (cell && parts[parts.length - 1] !== cell) parts.push(cell);
    }
    out.push(parts.join(' ').trim() || (c === 0 ? 'row_label' : `column_${c}`));
  }
  return out;
}

export default {
  TEXT_LAYER_MIN,
  MIN_TABLE_CONFIDENCE,
  uuid,
  createDoc,
  createPage,
  createTable,
  normaliseTable,
  validateTable,
  validateDoc,
  flatHeaders,
  warn
};
