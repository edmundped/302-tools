/**
 * js/core/zip.js — bundle several outputs into one download.
 *
 * Every archive carries a manifest. An analyst who opens a ZIP three weeks
 * later needs to know what each file is, where it came from and when it was
 * pulled, without opening all of them.
 *
 * Depends on the JSZip and FileSaver globals loaded by index.html. It does not
 * import from js/tools/ — core must not depend on a feature layer.
 */

export const MANIFEST_CSV = 'MANIFEST.csv';
export const MANIFEST_JSON = 'manifest.json';

function globalScope() {
  return typeof globalThis !== 'undefined' ? globalThis : {};
}

function getJSZip() {
  const JSZip = globalScope().JSZip;
  if (!JSZip) throw new Error('JSZip is not loaded.');
  return JSZip;
}

function csv(rows) {
  const Papa = globalScope().Papa;
  // Quoting is never disabled — see docs/ARCHITECTURE.md.
  if (Papa) return Papa.unparse(rows, { quotes: true, newline: '\r\n' });
  return rows
    .map((row) => row.map((cell) => `"${String(cell === null || cell === undefined ? '' : cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

/** Pure: byte length of a string, Blob or ArrayBuffer. */
export function contentSize(content) {
  if (content === null || content === undefined) return 0;
  if (typeof content === 'string') {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(content).length;
    return content.length;
  }
  if (typeof Blob !== 'undefined' && content instanceof Blob) return content.size;
  if (content.byteLength !== undefined) return content.byteLength;
  return 0;
}

/** Pure: guess a kind from the file name when the caller did not say. */
export function kindFromName(name) {
  const lower = String(name || '').toLowerCase();
  if (/_data\.csv$/.test(lower)) return 'machine csv (tidy/long)';
  if (/_review\.csv$/.test(lower)) return 'analyst csv (wide, faithful)';
  if (/_notes\.(csv|xlsx)$/.test(lower)) return 'notes-only export';
  if (/\.csv$/.test(lower)) return 'csv';
  if (/\.xlsx?$/.test(lower)) return 'excel workbook';
  if (/\.json$/.test(lower)) return 'json';
  if (/\.txt$/.test(lower)) return 'text';
  if (/\.pdf$/.test(lower)) return 'pdf';
  return 'file';
}

/**
 * Pure: the manifest rows. Exported on its own so the shape is testable
 * without building an actual archive.
 *
 * @param entries [{ name, content, kind, source, page, note }]
 */
export function buildManifestRows(entries, meta) {
  const info = meta || {};
  const created = info.created || new Date().toISOString();
  const rows = [['file', 'kind', 'bytes', 'source', 'page', 'created', 'note']];
  entries.forEach((entry) => {
    rows.push([
      entry.name,
      entry.kind || kindFromName(entry.name),
      String(contentSize(entry.content)),
      entry.source || info.source || '',
      entry.page === undefined || entry.page === null ? '' : String(entry.page),
      entry.created || created,
      entry.note || ''
    ]);
  });
  return rows;
}

/** Pure: the JSON manifest object. */
export function buildManifestJson(entries, meta) {
  const info = meta || {};
  const created = info.created || new Date().toISOString();
  return {
    title: info.title || '302 Data Tools export',
    created,
    producedBy: '302 Data Tools',
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + contentSize(entry.content), 0),
    files: entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind || kindFromName(entry.name),
      bytes: contentSize(entry.content),
      source: entry.source || info.source || null,
      page: entry.page === undefined ? null : entry.page,
      note: entry.note || null
    }))
  };
}

/** Pure: make names unique inside the archive. */
export function uniqueEntryNames(entries) {
  const taken = new Set();
  return entries.map((entry) => {
    let name = String(entry.name || 'file').replace(/^\/+/, '');
    if (taken.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (taken.has(`${stem}_${n}${ext}`.toLowerCase())) n += 1;
      name = `${stem}_${n}${ext}`;
    }
    taken.add(name.toLowerCase());
    return { ...entry, name };
  });
}

/**
 * Build the archive.
 *
 * @param entries [{ name, content, kind, source, page, note }]
 * @param options { name, title, source, folder, manifest = true, onProgress }
 * @returns { blob, filename, manifest }
 */
export async function createBundle(entries, options) {
  const opts = { manifest: true, ...(options || {}) };
  const list = uniqueEntryNames((entries || []).filter((entry) => entry && entry.name));
  if (!list.length) throw new Error('Nothing to bundle.');

  const JSZip = getJSZip();
  const zip = new JSZip();
  const target = opts.folder ? zip.folder(opts.folder) : zip;

  list.forEach((entry) => target.file(entry.name, entry.content));

  const manifest = buildManifestJson(list, opts);
  if (opts.manifest) {
    target.file(MANIFEST_CSV, csv(buildManifestRows(list, opts)));
    target.file(MANIFEST_JSON, JSON.stringify(manifest, null, 2));
  }

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE' },
    opts.onProgress ? (state) => opts.onProgress({ phase: 'zip', current: state.percent, total: 100, message: state.currentFile || 'compressing' }) : undefined
  );

  const filename = String(opts.name || '302-tools_exports.zip').replace(/(\.zip)?$/i, '.zip');
  return { blob, filename, manifest };
}

/** Build and save in one call. */
export async function downloadBundle(entries, options) {
  const bundle = await createBundle(entries, options);
  const saveAs = globalScope().saveAs;
  if (saveAs) {
    saveAs(bundle.blob, bundle.filename);
  } else {
    const url = URL.createObjectURL(bundle.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = bundle.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return bundle;
}
