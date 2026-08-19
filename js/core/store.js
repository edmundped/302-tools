/**
 * core/store.js — the single session state.
 *
 * Panels never hold their own copy of a table. They read from here and mutate
 * through these methods, which enforce the rectangularity invariant and emit
 * on the bus so every other panel re-renders.
 *
 * Nothing in here is persisted except `settings` (see core/config.js).
 * File bytes, page thumbnails and extracted rows stay in memory for the
 * session and die with the tab.
 */

import { bus, EVENTS } from './bus.js';
import { loadSettings, saveSettings, deepMerge, classifyFile } from './config.js';

let counter = 0;
const uid = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;

const state = {
  /** intake queue — one entry per dropped File */
  files: [],
  /** extracted documents, newest last */
  docs: [],
  /** persisted preferences */
  settings: loadSettings(),
  /** the doc the analyst tuned first — seeds "apply to the rest" */
  tunedDocId: null,
  /** scraper results, session only */
  scrape: { url: '', results: null, status: 'idle' },
  /** transient UI position */
  ui: { tab: null, activeDocId: null, busy: false }
};

/* ------------------------------------------------------------- invariants */

/** Pad/truncate every row to columnCount. Never trims a single row alone. */
function rectangularise(table) {
  const width =
    table.columnCount ||
    Math.max(
      0,
      ...(table.rows || []).map((r) => r.length),
      ...(table.headers || []).map((r) => r.length)
    );
  table.columnCount = width;
  table.rows = (table.rows || []).map((row) => {
    const next = row.slice(0, width);
    while (next.length < width) next.push('');
    return next;
  });
  table.headers = (table.headers || []).map((row) => {
    const next = row.slice(0, width);
    while (next.length < width) next.push('');
    return next;
  });
  return table;
}

/** Fill in anything an extractor left off, so the UI never reads undefined. */
function normaliseTable(table, doc, index) {
  const t = {
    id: table.id || `${doc.id}-p${table.page ?? 0}-t${index}`,
    docId: doc.id,
    sourceFile: table.sourceFile || doc.fileName,
    page: table.page ?? 1,
    origin: table.origin || doc.fileType || 'html',
    title: table.title ?? null,
    noteRef: table.noteRef ?? null,
    section: table.section ?? null,
    units: table.units ?? null,
    headers: table.headers || [],
    rows: table.rows || [],
    columnCount: table.columnCount || 0,
    confidence: typeof table.confidence === 'number' ? table.confidence : 0.5,
    warnings: [...(table.warnings || [])],
    bbox: table.bbox ?? null,
    selected: table.selected !== false,
    /** UI-owned, not part of the extractor contract */
    extractedAt: table.extractedAt || new Date().toISOString(),
    columnMap: table.columnMap || null
  };
  return rectangularise(t);
}

function normaliseDoc(doc) {
  const d = {
    id: doc.id || uid('doc'),
    fileName: doc.fileName || 'untitled',
    fileType: doc.fileType || 'pdf',
    pageCount: doc.pageCount ?? (doc.pages ? doc.pages.length : 0),
    pages: (doc.pages || []).map((p, i) => ({
      number: p.number ?? i + 1,
      textChars: p.textChars ?? 0,
      hasTextLayer: !!p.hasTextLayer,
      needsOcr: !!p.needsOcr,
      ocrApplied: !!p.ocrApplied,
      section: p.section ?? null,
      thumbnail: p.thumbnail ?? null,
      // optional page dimensions used by the crop preview; see config.BBOX_ORIGIN
      width: p.width ?? null,
      height: p.height ?? null
    })),
    tables: [],
    meta: doc.meta || {},
    warnings: [...(doc.warnings || [])],
    bboxOrigin: doc.bboxOrigin || null,
    receivedAt: new Date().toISOString()
  };
  d.tables = (doc.tables || []).map((t, i) => normaliseTable(t, d, i));
  return d;
}

/* ------------------------------------------------------------------ files */

function addFiles(fileList) {
  const added = [];
  for (const file of Array.from(fileList || [])) {
    const info = classifyFile(file);
    const entry = {
      id: uid('file'),
      file,
      name: file.name,
      size: file.size,
      kind: info.kind,
      typeLabel: info.label,
      ext: info.ext,
      supported: !!info.kind,
      status: info.kind ? 'queued' : 'error',
      error: info.kind ? null : `${info.label} files are not supported yet.`,
      pageCount: null,
      docId: null,
      progress: null
    };
    state.files.push(entry);
    added.push(entry);
  }
  bus.emit(EVENTS.FILES_CHANGED, { files: state.files, added });
  return added;
}

function updateFile(id, patch) {
  const entry = state.files.find((f) => f.id === id);
  if (!entry) return null;
  Object.assign(entry, patch);
  bus.emit(EVENTS.FILE_UPDATED, entry);
  bus.emit(EVENTS.FILES_CHANGED, { files: state.files, added: [] });
  return entry;
}

function getFile(id) {
  return state.files.find((f) => f.id === id) || null;
}

function removeFile(id) {
  const index = state.files.findIndex((f) => f.id === id);
  if (index < 0) return;
  const [entry] = state.files.splice(index, 1);
  if (entry.docId) removeDoc(entry.docId);
  bus.emit(EVENTS.FILES_CHANGED, { files: state.files, added: [] });
}

function pendingFiles() {
  return state.files.filter((f) => f.supported && f.status === 'queued');
}

function clearFiles() {
  state.files = [];
  state.docs = [];
  state.tunedDocId = null;
  state.ui.activeDocId = null;
  bus.emit(EVENTS.FILES_CHANGED, { files: state.files, added: [] });
  bus.emit(EVENTS.DOCS_CHANGED, { docs: state.docs });
}

/* ------------------------------------------------------------------- docs */

function addDoc(rawDoc) {
  const doc = normaliseDoc(rawDoc);
  state.docs.push(doc);
  if (!state.tunedDocId) state.tunedDocId = doc.id;
  if (!state.ui.activeDocId) state.ui.activeDocId = doc.id;
  bus.emit(EVENTS.DOC_ADDED, doc);
  bus.emit(EVENTS.DOCS_CHANGED, { docs: state.docs });
  return doc;
}

function getDoc(id) {
  return state.docs.find((d) => d.id === id) || null;
}

function removeDoc(id) {
  const index = state.docs.findIndex((d) => d.id === id);
  if (index < 0) return;
  const [doc] = state.docs.splice(index, 1);
  if (state.tunedDocId === id) state.tunedDocId = state.docs[0]?.id ?? null;
  if (state.ui.activeDocId === id) state.ui.activeDocId = state.docs[0]?.id ?? null;
  bus.emit(EVENTS.DOC_REMOVED, doc);
  bus.emit(EVENTS.DOCS_CHANGED, { docs: state.docs });
}

function allTables() {
  return state.docs.flatMap((d) => d.tables);
}

function selectedTables() {
  return allTables().filter((t) => t.selected);
}

function getTable(id) {
  for (const doc of state.docs) {
    const table = doc.tables.find((t) => t.id === id);
    if (table) return table;
  }
  return null;
}

function commit(table, reason) {
  rectangularise(table);
  bus.emit(EVENTS.TABLE_CHANGED, { table, reason });
  return table;
}

/* ---------------------------------------------------------- table edits   */

function setCell(tableId, rowIndex, colIndex, value) {
  const table = getTable(tableId);
  if (!table || !table.rows[rowIndex]) return null;
  if (table.rows[rowIndex][colIndex] === value) return table;
  table.rows[rowIndex][colIndex] = value;
  return commit(table, 'cell');
}

function setHeaderCell(tableId, rowIndex, colIndex, value) {
  const table = getTable(tableId);
  if (!table) return null;
  if (!table.headers[rowIndex]) table.headers[rowIndex] = new Array(table.columnCount).fill('');
  table.headers[rowIndex][colIndex] = value;
  return commit(table, 'header');
}

function setTableMeta(tableId, patch) {
  const table = getTable(tableId);
  if (!table) return null;
  Object.assign(table, patch);
  return commit(table, 'meta');
}

/** Promote a body row to be the (single) header row. */
function promoteRowToHeader(tableId, rowIndex) {
  const table = getTable(tableId);
  if (!table || !table.rows[rowIndex]) return null;
  const [row] = table.rows.splice(rowIndex, 1);
  table.headers = [row.slice()];
  table.warnings = table.warnings.filter((w) => !/header/i.test(w));
  return commit(table, 'promote-header');
}

/** Push the header row back down into the body. */
function demoteHeader(tableId) {
  const table = getTable(tableId);
  if (!table || !table.headers.length) return null;
  const rows = table.headers.slice();
  table.headers = [];
  table.rows.unshift(...rows);
  return commit(table, 'demote-header');
}

function deleteRow(tableId, rowIndex) {
  const table = getTable(tableId);
  if (!table || !table.rows[rowIndex]) return null;
  table.rows.splice(rowIndex, 1);
  return commit(table, 'delete-row');
}

function deleteColumn(tableId, colIndex) {
  const table = getTable(tableId);
  if (!table || table.columnCount <= 1) return null;
  table.rows = table.rows.map((row) => row.filter((_, i) => i !== colIndex));
  table.headers = table.headers.map((row) => row.filter((_, i) => i !== colIndex));
  table.columnCount -= 1;
  if (Array.isArray(table.columnMap)) table.columnMap.splice(colIndex, 1);
  return commit(table, 'delete-column');
}

function insertRowAfter(tableId, rowIndex) {
  const table = getTable(tableId);
  if (!table) return null;
  table.rows.splice(rowIndex + 1, 0, new Array(table.columnCount).fill(''));
  return commit(table, 'insert-row');
}

function toggleTable(tableId, selected) {
  const table = getTable(tableId);
  if (!table) return null;
  table.selected = selected === undefined ? !table.selected : !!selected;
  bus.emit(EVENTS.TABLE_SELECTION, { table });
  bus.emit(EVENTS.TABLE_CHANGED, { table, reason: 'selection' });
  return table;
}

function setDocSelection(docId, selected) {
  const doc = getDoc(docId);
  if (!doc) return;
  doc.tables.forEach((t) => {
    t.selected = !!selected;
  });
  bus.emit(EVENTS.TABLE_SELECTION, { doc });
  bus.emit(EVENTS.DOCS_CHANGED, { docs: state.docs });
}

/** "Say the columns" — map detected column i onto a declared name. */
function setColumnMap(tableId, map) {
  const table = getTable(tableId);
  if (!table) return null;
  table.columnMap = map;
  return commit(table, 'column-map');
}

/* --------------------------------------------------------------- settings */

function setSettings(patch) {
  state.settings = deepMerge(state.settings, patch);
  saveSettings(state.settings);
  bus.emit(EVENTS.SETTINGS_CHANGED, state.settings);
  return state.settings;
}

function setExtractOpts(patch) {
  const settings = setSettings({ extract: patch });
  bus.emit(EVENTS.EXTRACT_OPTS, settings.extract);
  return settings.extract;
}

/** Options object handed to `extractor.extract(file, opts, onProgress)`. */
function extractorOpts(extra = {}) {
  const { ocrMode, ocrLang, ocrDpi, expectedColumns } = state.settings.extract;
  return {
    ocrMode,
    ocrLang,
    ocrDpi,
    expectedColumns: [...expectedColumns],
    textLayerMin: undefined, // let ingest use its own constant
    ...extra
  };
}

/* ------------------------------------------------------------------ misc  */

function setUi(patch) {
  Object.assign(state.ui, patch);
}

function setScrape(patch) {
  Object.assign(state.scrape, patch);
}

function stats() {
  const tables = allTables();
  const docs = state.docs;
  return {
    files: state.files.length,
    docs: docs.length,
    tables: tables.length,
    selected: tables.filter((t) => t.selected).length,
    pages: docs.reduce((n, d) => n + (d.pageCount || 0), 0),
    ocrPages: docs.reduce((n, d) => n + d.pages.filter((p) => p.ocrApplied).length, 0),
    needsOcr: docs.reduce((n, d) => n + d.pages.filter((p) => p.needsOcr && !p.ocrApplied).length, 0),
    warnings: docs.reduce((n, d) => n + d.warnings.length, 0) +
      tables.reduce((n, t) => n + t.warnings.length, 0)
  };
}

export const store = {
  get state() {
    return state;
  },
  get settings() {
    return state.settings;
  },
  uid,
  // files
  addFiles,
  updateFile,
  getFile,
  removeFile,
  pendingFiles,
  clearFiles,
  // docs + tables
  addDoc,
  getDoc,
  removeDoc,
  allTables,
  selectedTables,
  getTable,
  // edits
  setCell,
  setHeaderCell,
  setTableMeta,
  promoteRowToHeader,
  demoteHeader,
  deleteRow,
  deleteColumn,
  insertRowAfter,
  toggleTable,
  setDocSelection,
  setColumnMap,
  // settings
  setSettings,
  setExtractOpts,
  extractorOpts,
  // misc
  setUi,
  setScrape,
  stats,
  rectangularise
};

export default store;
