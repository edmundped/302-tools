/**
 * ingest/pdf-ocr.js — rasterise + Tesseract, whole page or a region.
 *
 * Every GOIL annual report in the corpus is scanned. The 2011 report has 109
 * characters per page and they are a download stamp. OCR is the PRIMARY path
 * for these documents, not a fallback, and it is designed for accordingly:
 *
 *   - rasterise at >= 300 DPI equivalent (PDF user space is 72 dpi, so scale
 *     ~2.5-3.0; we clamp rather than trust a caller);
 *   - keep per-word confidence and carry it through to cell-level warnings;
 *   - numbers OCR badly (1/7, 0/8/O, 5/6, ,/.), so cells that land in numeric
 *     columns get a second pass with a digits-only allowlist, and any cell
 *     where the two passes disagree is FLAGGED, never silently resolved.
 */

import { uuid, TEXT_LAYER_MIN } from '../core/model.js';
import { parseNumber } from '../core/numbers.js';
import { buildDoc, loadPdfjs } from './pdf-text.js';
import { progressReporter, throwIfAborted } from './index.js';

export const TESSERACT_VERSION = '5.1.1';
const TESSERACT_CDN = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.esm.min.js`;

export const OCR_DEFAULTS = Object.freeze({
  targetDpi: 300,
  minScale: 2.5,
  maxScale: 4,
  lang: 'eng',
  /** per-word confidence below this is reported as unreliable */
  lowConfidence: 70,
  /** below this a word is not trusted at all */
  rejectConfidence: 40,
  numericAllowlist: '0123456789.,()-–%',
  numericPass: true
});

let tesseractPromise = null;

/** Lazy Tesseract.js. A page-provided global wins so an offline build can pin it. */
export async function loadTesseract(opts = {}) {
  if (opts.Tesseract) return opts.Tesseract;
  if (globalThis.Tesseract) return globalThis.Tesseract;
  if (!tesseractPromise) {
    tesseractPromise = import(/* @vite-ignore */ opts.tesseractCdn || TESSERACT_CDN)
      .then((m) => m.default || m)
      .catch((err) => {
        tesseractPromise = null;
        throw new Error(`Tesseract.js failed to load (${err.message}). OCR is unavailable offline.`);
      });
  }
  return tesseractPromise;
}

/** Scale that gets a 72 dpi page to targetDpi, clamped to something sane. */
export function scaleForDpi(opts = {}) {
  const o = { ...OCR_DEFAULTS, ...opts };
  const raw = o.targetDpi / 72;
  return Math.min(o.maxScale, Math.max(o.minScale, raw));
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('No canvas implementation available for rasterising');
}

/**
 * Render a pdf.js page (or a sub-rectangle of it) to a bitmap.
 *
 * @param {object} pdfPage
 * @param {object} opts  { region: {x,y,w,h} in top-down PDF user space, targetDpi }
 * @returns {{ canvas, scale, offsetX, offsetY, width, height }}
 */
export async function rasterise(pdfPage, opts = {}) {
  const scale = scaleForDpi(opts);
  const viewport = pdfPage.getViewport({ scale });
  const region = opts.region || null;

  const width = Math.max(1, Math.round(region ? region.w * scale : viewport.width));
  const height = Math.max(1, Math.round(region ? region.h * scale : viewport.height));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const offsetX = region ? region.x * scale : 0;
  const offsetY = region ? region.y * scale : 0;
  const transform = region ? [1, 0, 0, 1, -offsetX, -offsetY] : null;

  await pdfPage.render({ canvasContext: ctx, viewport, transform }).promise;
  return { canvas, scale, offsetX, offsetY, width, height };
}

/**
 * Recognise a bitmap and return words in PDF user space (top-down), each with
 * its Tesseract confidence attached so cells can be graded later.
 */
export async function recogniseCanvas(canvas, raster, opts = {}) {
  const o = { ...OCR_DEFAULTS, ...opts };
  const Tesseract = await loadTesseract(opts);
  const params = {};
  if (o.allowlist) params.tessedit_char_whitelist = o.allowlist;
  if (o.psm !== undefined) params.tessedit_pageseg_mode = String(o.psm);

  const { data } = await Tesseract.recognize(canvas, o.lang, {
    logger: o.logger,
    ...(Object.keys(params).length ? params : {})
  });

  const source = data.words && data.words.length ? data.words : collectWords(data);
  const words = source
    .filter((w) => String(w.text || '').trim())
    .map((w) => {
      const b = w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
      return {
        text: String(w.text).trim(),
        x: (b.x0 + raster.offsetX) / raster.scale,
        y: (b.y0 + raster.offsetY) / raster.scale,
        x1: (b.x1 + raster.offsetX) / raster.scale,
        y1: (b.y1 + raster.offsetY) / raster.scale,
        conf: Number.isFinite(w.confidence) ? w.confidence : null
      };
    })
    .filter((w) => w.conf === null || w.conf >= o.rejectConfidence);

  return { words, text: data.text || '', meanConfidence: Number.isFinite(data.confidence) ? data.confidence : null };
}

function collectWords(data) {
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) out.push(w);
      }
    }
  }
  return out;
}

/** OCR one whole page. */
export async function ocrPage(pdfPage, opts = {}) {
  const raster = await rasterise(pdfPage, opts);
  return recogniseCanvas(raster.canvas, raster, opts);
}

/**
 * OCR a caller-supplied region — the partly-scanned case, where a page has
 * prose in its text layer and a raster table underneath it.
 *
 * @param {object} bbox {x,y,w,h} in top-down PDF user space
 */
export async function ocrRegion(pdfPage, bbox, opts = {}) {
  if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) throw new TypeError('ocrRegion: bbox {x,y,w,h} required');
  const raster = await rasterise(pdfPage, { ...opts, region: bbox });
  return recogniseCanvas(raster.canvas, raster, opts);
}

/* ------------------------------------------------------------------ */
/* Numeric refinement                                                   */
/* ------------------------------------------------------------------ */

const CONFUSIONS = [
  [/O/g, '0'],
  [/o/g, '0'],
  [/[lI|]/g, '1'],
  [/S/g, '5'],
  [/B/g, '8'],
  [/[·•]/g, '.'],
  [/—|–/g, '-']
];

/** Digits-only reading of a token, used only to CHECK the general pass. */
export function coerceNumericReading(text) {
  let s = String(text);
  for (const [re, to] of CONFUSIONS) s = s.replace(re, to);
  return s;
}

/**
 * Re-OCR the numeric cells of a table with a digits-only allowlist and compare.
 *
 * Nothing is silently corrected. Where the two passes disagree the cell keeps
 * the general-pass text and the table gains a warning naming the cell. Where a
 * cell only becomes numeric under coercion, it is flagged as ambiguous.
 */
export async function refineNumericCells(table, pdfPage, opts = {}) {
  const o = { ...OCR_DEFAULTS, ...opts };
  if (!o.numericPass) return table;

  const columns = table._columns || [];
  const lines = table._lines || [];
  const numericCols = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.numericFraction || 0) >= 0.5)
    .map(({ i }) => i);
  if (!numericCols.length) return table;

  for (let r = 0; r < table.rows.length; r += 1) {
    const line = lines[r + table.headers.length];
    if (!line) continue;
    for (const c of numericCols) {
      const raw = String(table.rows[r][c] || '').trim();
      if (!raw) continue;
      const cell = (line.cells || []).find((cc) => cc.text === raw);
      const parsed = parseNumber(raw);

      if (parsed.isNumeric || parsed.isNil) {
        if (cell && Number.isFinite(cell.conf) && cell.conf < o.lowConfidence) {
          table.warnings.push(
            `OCR confidence ${Math.round(cell.conf)}% on "${raw}" (row ${r + 1}, column ${c + 1}) — verify against the page`
          );
        }
        continue;
      }

      // Non-numeric text sitting in a numeric column: try a targeted re-read.
      let resolved = null;
      if (cell && pdfPage) {
        try {
          const pad = 2;
          const region = { x: cell.x - pad, y: line.top - pad, w: cell.x1 - cell.x + pad * 2, h: line.bottom - line.top + pad * 2 };
          const { words } = await ocrRegion(pdfPage, region, { ...o, allowlist: o.numericAllowlist, psm: 7 });
          resolved = words.map((w) => w.text).join('');
        } catch {
          resolved = null;
        }
      }
      const coerced = coerceNumericReading(raw);

      if (resolved && parseNumber(resolved).isNumeric && resolved.replace(/\s/g, '') !== raw.replace(/\s/g, '')) {
        table.warnings.push(
          `OCR ambiguity at row ${r + 1}, column ${c + 1}: general pass read "${raw}", digits-only pass read "${resolved}" — left as "${raw}", check the page`
        );
      } else if (parseNumber(coerced).isNumeric) {
        table.warnings.push(
          `OCR ambiguity at row ${r + 1}, column ${c + 1}: "${raw}" is only numeric if letters are read as digits ("${coerced}") — left as printed`
        );
      } else {
        table.warnings.push(`row ${r + 1}, column ${c + 1}: "${raw}" sits in a numeric column but is not a figure`);
      }
    }
  }
  return table;
}

/* ------------------------------------------------------------------ */
/* Whole-document OCR                                                   */
/* ------------------------------------------------------------------ */

/**
 * OCR a PDF. `opts.pages` limits the run to specific page numbers — normally
 * the ones pdf-text.js already flagged needsOcr, so a hybrid document is only
 * rasterised where it has to be.
 */
export async function extractPdfOcr(file, opts = {}, onProgress) {
  const report = progressReporter(onProgress);
  const o = { ...OCR_DEFAULTS, ...opts };
  const pdfjsLib = await loadPdfjs(opts);
  const data = opts.pdf ? null : await file.arrayBuffer();
  const pdf = opts.pdf || (await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise);

  const wanted = opts.pages && opts.pages.length ? [...opts.pages].sort((a, b) => a - b) : range(1, pdf.numPages);
  const pages = [];
  const pageObjects = new Map();
  let lowConfidencePages = 0;

  for (let i = 0; i < wanted.length; i += 1) {
    throwIfAborted(opts.signal);
    const n = wanted[i];
    report('pdf-ocr', i + 1, wanted.length, `OCR page ${n} (${i + 1} of ${wanted.length}) at ${o.targetDpi} dpi`);
    const page = await pdf.getPage(n);
    pageObjects.set(n, page);
    const { words, meanConfidence } = await ocrPage(page, o);
    if (Number.isFinite(meanConfidence) && meanConfidence < o.lowConfidence) lowConfidencePages += 1;
    pages.push({
      number: n,
      words,
      imageRegions: [],
      ocrApplied: true,
      meanConfidence,
      warnings: Number.isFinite(meanConfidence) && meanConfidence < o.lowConfidence
        ? [`page ${n}: mean OCR confidence ${Math.round(meanConfidence)}% — treat figures as provisional`]
        : []
    });
  }

  const doc = buildDoc(
    { docId: opts.docId || uuid(), fileName: file.name, fileType: 'pdf', origin: 'pdf-ocr', pages },
    { ...opts, textLayerMin: opts.textLayerMin ?? 1 }
  );

  for (const table of doc.tables) {
    throwIfAborted(opts.signal);
    await refineNumericCells(table, pageObjects.get(table.page), o);
    if (table.warnings.length) table.confidence = Math.min(table.confidence, 0.85);
    table.confidence = Math.min(table.confidence, 0.9); // OCR is never as good as a text layer
    table.warnings.push('extracted by OCR — verify figures against the page image');
  }

  if (lowConfidencePages) {
    doc.warnings.push(`${lowConfidencePages} page(s) OCR'd below ${o.lowConfidence}% mean confidence.`);
  }
  report('pdf-ocr', wanted.length, wanted.length, `OCR complete: ${doc.tables.length} table(s) from ${wanted.length} page(s)`);
  return doc;
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

/**
 * Convenience for the common flow: read the text layer, then OCR exactly the
 * pages it could not read, and merge. TEXT_LAYER_MIN decides which those are.
 */
export async function ocrScannedPages(file, textDoc, opts = {}, onProgress) {
  const targets = textDoc.pages.filter((p) => p.needsOcr).map((p) => p.number);
  if (!targets.length) return textDoc;
  const ocrDoc = await extractPdfOcr(
    file,
    { ...opts, pages: targets, pdf: textDoc._pdf, docId: textDoc.id, textLayerMin: TEXT_LAYER_MIN },
    onProgress
  );
  const byNumber = new Map(ocrDoc.pages.map((p) => [p.number, p]));
  textDoc.pages = textDoc.pages.map((p) => (byNumber.has(p.number) ? { ...byNumber.get(p.number), ocrApplied: true } : p));
  textDoc.tables = [...textDoc.tables.filter((t) => !targets.includes(t.page)), ...ocrDoc.tables].sort(
    (a, b) => a.page - b.page
  );
  textDoc.warnings.push(...ocrDoc.warnings);
  return textDoc;
}

export const extractor = {
  id: 'pdf-ocr',
  label: 'PDF (OCR)',
  priority: -10, // never chosen automatically; the text path decides when to call it
  accepts: () => false,
  extract: extractPdfOcr
};

export default {
  extractor,
  extractPdfOcr,
  ocrPage,
  ocrRegion,
  rasterise,
  scaleForDpi,
  refineNumericCells,
  coerceNumericReading,
  ocrScannedPages,
  loadTesseract,
  OCR_DEFAULTS
};
