/**
 * ingest/pdf-text.js — pdf.js text-layer extraction.
 *
 * pdf.js hands back run-level items with a bottom-up baseline transform. Two
 * conversions happen here and nowhere else:
 *   1. runs are split into WORDS with real boxes (the geometry layer works on
 *      words, and word boxes are what OCR gives us too, so both paths agree);
 *   2. coordinates are flipped to the top-down convention geometry.js expects.
 *
 * The page is then measured honestly: boilerplate off first, THEN count chars.
 */

import { createDoc, createPage, uuid, TEXT_LAYER_MIN } from '../core/model.js';
import { buildPageTables } from '../extract/tables.js';
import { stripBoilerplate, findTextlessRegions } from '../extract/boilerplate.js';
import { assignSections, annotateTables, docMeta } from '../extract/financial.js';
import { matcher, progressReporter, throwIfAborted } from './index.js';

export const PDFJS_VERSION = '3.11.174';
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

let pdfjsPromise = null;

/** Lazy pdf.js. Uses an already-loaded global when the page provides one. */
export async function loadPdfjs(opts = {}) {
  if (opts.pdfjsLib) return opts.pdfjsLib;
  if (globalThis.pdfjsLib) {
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = opts.workerSrc || PDFJS_WORKER;
    return globalThis.pdfjsLib;
  }
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      await import(/* @vite-ignore */ opts.cdn || PDFJS_CDN);
      const lib = globalThis.pdfjsLib;
      if (!lib) throw new Error('pdf.js failed to load');
      lib.GlobalWorkerOptions.workerSrc = opts.workerSrc || PDFJS_WORKER;
      return lib;
    })();
  }
  return pdfjsPromise;
}

/* ------------------------------------------------------------------ */
/* text content -> words (pure, unit-testable)                          */
/* ------------------------------------------------------------------ */

/**
 * Split one pdf.js text item into words with proportional boxes.
 * Width is apportioned by character count — approximate, but the geometry layer
 * only ever compares edges within a page, and the error is well under a glyph.
 *
 * @param {object} item      pdf.js text item ({ str, transform, width, height })
 * @param {number} pageHeight viewport height, for the y flip
 */
export function itemToWords(item, pageHeight) {
  const str = String(item.str || '');
  if (!str.trim()) return [];

  const t = item.transform || [1, 0, 0, 1, 0, 0];
  const scaleX = Math.hypot(t[0], t[1]) || 1;
  const scaleY = Math.hypot(t[2], t[3]) || 1;
  const height = Number(item.height) || scaleY || 10;
  const totalWidth = Number(item.width) || str.length * height * 0.5;
  const left = t[4];
  const baseline = t[5];

  // pdf.js origin is bottom-left; geometry.js wants a top-down box.
  const top = pageHeight - baseline - height * 0.8;
  const bottom = top + height;

  const perChar = str.length ? totalWidth / str.length : 0;
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(str))) {
    const x = left + m.index * perChar;
    const x1 = x + m[0].length * perChar;
    words.push({ text: m[0], x, y: top, x1, y1: bottom, w: x1 - x, h: height, scaleX });
  }
  return words;
}

export function wordsFromTextContent(textContent, viewportHeight) {
  const items = (textContent && textContent.items) || [];
  return items.flatMap((item) => itemToWords(item, viewportHeight));
}

/**
 * Image XObject placements on a page, in top-down page space. Used to spot the
 * partly-scanned case: text prose above, a raster table below.
 */
export async function imageRegionsForPage(pdfPage, viewport) {
  try {
    const ops = await pdfPage.getOperatorList();
    const OPS = (globalThis.pdfjsLib && globalThis.pdfjsLib.OPS) || {};
    const paintOps = new Set(
      [OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].filter(
        (v) => v !== undefined
      )
    );
    if (!paintOps.size) return [];

    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const regions = [];
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      const fn = ops.fnArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i]);
      else if (paintOps.has(fn)) {
        const w = Math.abs(ctm[0]) || Math.abs(ctm[1]);
        const h = Math.abs(ctm[3]) || Math.abs(ctm[2]);
        const x = ctm[4];
        const yBottom = ctm[5];
        regions.push({ x, y: viewport.height - yBottom - h, w, h });
      }
    }
    return regions.filter((r) => r.w > 20 && r.h > 20);
  } catch {
    return [];
  }
}

function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

/* ------------------------------------------------------------------ */
/* Page-set -> Doc (pure; shared with the OCR and image paths)          */
/* ------------------------------------------------------------------ */

/**
 * Turn raw per-page word lists into a fully annotated Doc.
 * Order matters and is the whole point:
 *   strip boilerplate -> measure -> flag scanned -> sections -> tables -> notes.
 *
 * @param {object} input { fileName, fileType, pages:[{number, words, imageRegions}] }
 */
export function buildDoc(input, opts = {}) {
  const docId = input.docId || uuid();
  const origin = input.origin || 'pdf-text';
  const textLayerMin = opts.textLayerMin ?? TEXT_LAYER_MIN;

  const { pages: stripped, patterns, stampHits } = stripBoilerplate(input.pages || [], {
    ...opts,
    textLayerMin
  });
  const sectioned = assignSections(stripped);

  const tables = [];
  const rejected = [];
  const pageRecords = [];

  for (const page of sectioned) {
    const built = page.needsOcr
      ? { tables: [], rejected: [], metrics: null }
      : buildPageTables(
          { words: page.words, page: page.number, docId, sourceFile: input.fileName, origin },
          opts
        );
    annotateTables(built.tables, page, opts);
    tables.push(...built.tables);
    rejected.push(...built.rejected);

    const textlessRegions = findTextlessRegions(page, opts);
    const warnings = [...(page.warnings || [])];
    if (textlessRegions.length && !page.needsOcr) {
      warnings.push(
        `page ${page.number}: ${textlessRegions.length} image region(s) carry no text — likely a scanned table, region OCR offered`
      );
    }

    pageRecords.push(
      createPage({
        number: page.number,
        textChars: page.textChars,
        hasTextLayer: page.hasTextLayer,
        needsOcr: page.needsOcr,
        ocrApplied: page.ocrApplied,
        section: page.section,
        words: page.words,
        imageRegions: textlessRegions,
        warnings
      })
    );
  }

  const doc = createDoc({
    id: docId,
    fileName: input.fileName,
    fileType: input.fileType || 'pdf',
    pageCount: pageRecords.length,
    pages: pageRecords,
    tables,
    meta: docMeta(sectioned)
  });

  const scanned = pageRecords.filter((p) => p.needsOcr);
  if (scanned.length) {
    doc.warnings.push(
      `${scanned.length} of ${pageRecords.length} page(s) have no usable text layer (pages ${summarise(
        scanned.map((p) => p.number)
      )}). OCR is required for these — nothing was extracted from them.`
    );
  }
  if (patterns.length) {
    doc.warnings.push(
      `Removed ${patterns.length} repeated header/footer/stamp line(s) before measuring text: ${patterns
        .slice(0, 4)
        .map((p) => `"${p.text}"`)
        .join(', ')}${patterns.length > 4 ? '…' : ''}`
    );
  }
  if (stampHits.length && !patterns.length) {
    doc.warnings.push(`Removed ${stampHits.length} download-stamp line(s) before measuring text.`);
  }
  doc._rejected = rejected;
  return doc;
}

function summarise(numbers) {
  if (numbers.length <= 8) return numbers.join(', ');
  return `${numbers.slice(0, 6).join(', ')} … +${numbers.length - 6} more`;
}

/* ------------------------------------------------------------------ */
/* Extractor                                                            */
/* ------------------------------------------------------------------ */

export async function extractPdfText(file, opts = {}, onProgress) {
  const report = progressReporter(onProgress);
  const pdfjsLib = await loadPdfjs(opts);
  const data = await file.arrayBuffer();
  throwIfAborted(opts.signal);

  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];

  for (let n = 1; n <= pdf.numPages; n += 1) {
    throwIfAborted(opts.signal);
    report('pdf-text', n, pdf.numPages, `Reading text layer, page ${n} of ${pdf.numPages}`);
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const words = wordsFromTextContent(textContent, viewport.height);
    const imageRegions = opts.detectImages === false ? [] : await imageRegionsForPage(page, viewport);
    pages.push({ number: n, words, imageRegions, viewport: { width: viewport.width, height: viewport.height } });
    if (typeof page.cleanup === 'function') page.cleanup();
  }

  const doc = buildDoc({ fileName: file.name, fileType: 'pdf', origin: 'pdf-text', pages }, opts);
  doc._pdf = pdf; // kept so the OCR pass can reuse the parsed document
  report('pdf-text', pdf.numPages, pdf.numPages, `Read ${pdf.numPages} page(s), found ${doc.tables.length} table(s)`);
  return doc;
}

export const extractor = {
  id: 'pdf-text',
  label: 'PDF (text layer)',
  priority: 10,
  accepts: matcher({ extensions: ['pdf'], mimes: ['application/pdf'] }),
  extract: extractPdfText
};

export default { extractor, extractPdfText, buildDoc, wordsFromTextContent, itemToWords, loadPdfjs };
