/**
 * ingest/html-table.js — DOM <table> -> Table[].
 *
 * Shared by the scraper (live pages fetched through the proxy) and by docx.js
 * (mammoth converts .docx to HTML). Pure DOM work: no network, no pdf.js.
 *
 * colspan/rowspan are expanded into a genuinely rectangular grid because
 * model.validateTable() rejects anything ragged. A cell spanning three columns
 * is written into all three; a cell spanning two rows is written into both.
 */

import { createDoc, createTable, uuid, warn } from '../core/model.js';
import { detectHeaders } from '../extract/tables.js';
import { classifyGrid } from '../extract/classify.js';
import { parseNoteHeading, detectUnits, sectionForText } from '../extract/financial.js';
import { matcher, progressReporter, throwIfAborted } from './index.js';

const CELL = 'td,th';

/** Collapse runs of whitespace, including the &nbsp; that HTML tables are full of. */
export function cellText(el) {
  return String(el.textContent || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Expand one <table> into a rectangular string grid.
 * Returns { grid, headerRowCount } — headerRowCount counts leading <thead>/<th> rows.
 */
export function expandTable(tableEl) {
  const rowEls = Array.from(tableEl.querySelectorAll('tr'));
  const grid = [];
  // pending[colIndex] = { text, rowsLeft } for cells still spanning downward
  const pending = new Map();
  let headerRowCount = 0;
  let sawBody = false;

  rowEls.forEach((tr, rowIndex) => {
    const cells = Array.from(tr.querySelectorAll(CELL));
    if (!cells.length) return;

    const isHeaderRow =
      !sawBody &&
      (tr.closest('thead') !== null || cells.every((c) => c.tagName.toLowerCase() === 'th'));
    if (isHeaderRow) headerRowCount = grid.length + 1;
    else sawBody = true;

    const row = [];
    let col = 0;
    const place = (text) => {
      while (pending.has(col)) {
        const held = pending.get(col);
        row[col] = held.text;
        held.rowsLeft -= 1;
        if (held.rowsLeft <= 0) pending.delete(col);
        col += 1;
      }
      row[col] = text;
      return col++;
    };

    cells.forEach((cell) => {
      const text = cellText(cell);
      const colspan = Math.max(1, Math.min(64, parseInt(cell.getAttribute('colspan') || '1', 10) || 1));
      const rowspan = Math.max(1, Math.min(256, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1));
      for (let c = 0; c < colspan; c += 1) {
        const at = place(text);
        if (rowspan > 1) pending.set(at, { text, rowsLeft: rowspan - 1 });
      }
    });

    // drain any spans sitting past the last real cell of this row
    while (pending.has(col)) {
      const held = pending.get(col);
      row[col] = held.text;
      held.rowsLeft -= 1;
      if (held.rowsLeft <= 0) pending.delete(col);
      col += 1;
    }

    grid.push(row.map((c) => (c === undefined ? '' : c)));
    void rowIndex;
  });

  const width = Math.max(0, ...grid.map((r) => r.length));
  const rect = grid.map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
  return { grid: rect, headerRowCount };
}

/** Caption / preceding heading, used for title, note ref and units. */
function titleFor(tableEl) {
  const caption = tableEl.querySelector('caption');
  if (caption && cellText(caption)) return cellText(caption);
  let node = tableEl.previousElementSibling;
  let hops = 0;
  while (node && hops < 4) {
    const text = cellText(node);
    if (text && text.length <= 200 && /^(h[1-6]|p|div|strong|b)$/i.test(node.tagName)) return text;
    node = node.previousElementSibling;
    hops += 1;
  }
  return '';
}

/**
 * Convert every <table> in a Document (or DocumentFragment) into Tables.
 * ctx: { docId, sourceFile, page, origin }
 */
export function tablesFromDocument(dom, ctx = {}, opts = {}) {
  const docId = ctx.docId || uuid();
  const origin = ctx.origin || 'html';
  const sourceFile = ctx.sourceFile || '';
  const page = ctx.page ?? 'html';
  const minRows = opts.minRows ?? 1;

  const out = [];
  Array.from(dom.querySelectorAll('table')).forEach((tableEl, index) => {
    // A table used purely for layout holds another table; skip the outer one.
    if (tableEl.querySelector('table')) return;

    const { grid, headerRowCount } = expandTable(tableEl);
    if (!grid.length) return;

    const columnCount = grid[0].length;
    if (columnCount < 2 || grid.length < minRows + headerRowCount) return;

    let headers = grid.slice(0, headerRowCount);
    let rows = grid.slice(headerRowCount);
    if (!headers.length) {
      // No <th>/<thead> — fall back to the same detector the PDF path uses.
      const detected = detectHeaders(grid, columnCount, opts);
      headers = detected.headers || [];
      rows = detected.rows || grid;
    }
    if (!rows.length) return;

    const title = titleFor(tableEl);
    const note = parseNoteHeading(title) || { number: null, title: null };
    const scored = classifyGrid({ grid: rows, columnCount, headers });

    out.push(
      createTable({
        docId,
        index,
        sourceFile,
        page,
        origin,
        title: note.title || title || null,
        noteRef: note.number || null,
        section: sectionForText(title) || (note.number ? 'notes' : null),
        units: detectUnits(title) || null,
        headers,
        rows,
        columnCount,
        confidence: typeof scored?.confidence === 'number' ? scored.confidence : 0.8,
        warnings: scored?.warnings || [],
        signals: scored?.signals || null
      })
    );
  });
  return out;
}

/** Parse an HTML string and pull its tables. Used by the scraper and docx.js. */
export function tablesFromHtml(html, ctx = {}, opts = {}) {
  const dom = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return tablesFromDocument(dom, ctx, opts);
}

export async function extractHtml(file, opts = {}, onProgress) {
  const report = progressReporter(onProgress);
  throwIfAborted(opts.signal);
  report('html', 0, 1, `Reading ${file.name}`);
  const html = await file.text();
  const docId = uuid();
  const tables = tablesFromHtml(html, { docId, sourceFile: file.name, page: 1, origin: 'html' }, opts);

  const doc = createDoc({
    id: docId,
    fileName: file.name,
    fileType: 'html',
    pageCount: 1,
    pages: [{ number: 1, textChars: html.length, hasTextLayer: true, needsOcr: false }],
    tables
  });
  if (!tables.length) warn(doc, 'No <table> elements found. A page that builds its tables in JavaScript will look empty to a static fetch.');
  report('html', 1, 1, `Found ${tables.length} table(s)`);
  return doc;
}

export const extractor = {
  id: 'html',
  label: 'HTML page',
  priority: 10,
  accepts: matcher({ extensions: ['html', 'htm'], mimes: ['text/html'] }),
  extract: extractHtml
};

export default { extractor, extractHtml, tablesFromHtml, tablesFromDocument, expandTable, cellText };
