/**
 * ingest/docx.js — Word documents -> tables.
 *
 * mammoth.js converts .docx to semantic HTML, which hands us real <table>
 * elements with their colspan/rowspan intact. From there html-table.js does the
 * work, so a Word table and a scraped web table go through identical code.
 *
 * Legacy .doc (the pre-2007 binary format) is NOT supported by mammoth. We
 * detect it and say so plainly rather than failing with a parser error.
 */

import { createDoc, uuid, warn } from '../core/model.js';
import { tablesFromHtml } from './html-table.js';
import { matcher, progressReporter, throwIfAborted, extensionOf } from './index.js';

export const MAMMOTH_VERSION = '1.6.0';
export const MAMMOTH_SRC = `https://cdnjs.cloudflare.com/ajax/libs/mammoth/${MAMMOTH_VERSION}/mammoth.browser.min.js`;

/** mammoth is loaded from index.html; fall back to injecting it if absent. */
export async function loadMammoth(opts = {}) {
  if (opts.mammoth) return opts.mammoth;
  if (typeof window !== 'undefined' && window.mammoth) return window.mammoth;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MAMMOTH_SRC;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load mammoth.js from the CDN.'));
    document.head.appendChild(s);
  });
  if (!window.mammoth) throw new Error('mammoth.js loaded but did not register.');
  return window.mammoth;
}

/** ZIP magic — a real .docx is a zip; a legacy .doc starts with the OLE header. */
export async function looksLikeDocx(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b; // 'PK'
}

export async function extractDocx(file, opts = {}, onProgress) {
  const report = progressReporter(onProgress);
  throwIfAborted(opts.signal);

  if (extensionOf(file) === 'doc' && !(await looksLikeDocx(file))) {
    throw new Error(
      `"${file.name}" is a legacy .doc file, which cannot be read in the browser. ` +
        'Open it in Word and save as .docx, then try again.'
    );
  }

  report('docx', 0, 2, `Converting ${file.name}`);
  const mammoth = await loadMammoth(opts);
  const buffer = await file.arrayBuffer();
  throwIfAborted(opts.signal);

  const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  const html = result && result.value ? result.value : '';
  throwIfAborted(opts.signal);

  report('docx', 1, 2, 'Reading tables');
  const docId = uuid();
  const tables = tablesFromHtml(
    html,
    { docId, sourceFile: file.name, page: 1, origin: 'docx' },
    opts
  );

  const text = html.replace(/<[^>]+>/g, ' ');
  const doc = createDoc({
    id: docId,
    fileName: file.name,
    fileType: 'docx',
    pageCount: 1,
    pages: [
      {
        number: 1,
        textChars: text.replace(/\s+/g, ' ').trim().length,
        hasTextLayer: true,
        needsOcr: false
      }
    ],
    tables
  });

  // mammoth reports style/structure it could not map — worth surfacing.
  (result.messages || []).slice(0, 5).forEach((m) => {
    if (m && m.message) warn(doc, `Word conversion: ${m.message}`);
  });
  if (!tables.length) {
    warn(
      doc,
      'No Word tables found. Figures laid out with tabs or spaces rather than a real table will not be detected — paste them into the Tools panel instead.'
    );
  }
  // Word has no pages until it is rendered, so page is always 1.
  warn(doc, 'Word documents have no fixed pagination; every table is recorded as page 1.');

  report('docx', 2, 2, `Found ${tables.length} table(s)`);
  return doc;
}

export const extractor = {
  id: 'docx',
  label: 'Word document',
  priority: 10,
  accepts: matcher({
    extensions: ['docx', 'doc'],
    mimes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ]
  }),
  extract: extractDocx
};

export default { extractor, extractDocx, loadMammoth, looksLikeDocx };
