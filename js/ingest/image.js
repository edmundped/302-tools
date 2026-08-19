/**
 * ingest/image.js — PNG/JPG/WEBP screenshot -> OCR -> tables.
 *
 * This is the "screenshot" path: an analyst crops a table out of a report or a
 * viewer that will not give up its text, drops the image here, and gets the
 * same two CSVs as any other source.
 *
 * It reuses the OCR machinery in pdf-ocr.js and the geometry/table pipeline in
 * extract/, so a screenshot and a scanned PDF page go through identical code
 * once they are words on a plane.
 */

import { createDoc, createPage, uuid, warn } from '../core/model.js';
import { recogniseCanvas, OCR_DEFAULTS } from './pdf-ocr.js';
import { buildPageTables } from '../extract/tables.js';
import { annotateTables } from '../extract/financial.js';
import { matcher, progressReporter, throwIfAborted } from './index.js';

/** Upscale small screenshots — Tesseract wants roughly 300 DPI to read digits. */
export const MIN_WORKING_WIDTH = 1600;
export const MAX_WORKING_WIDTH = 4000;

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode "${file.name}". Is it a real image?`));
    };
    img.src = url;
  });
}

/**
 * Draw the image onto a canvas at a working size, optionally cropped.
 * Returns the raster descriptor recogniseCanvas() expects, so word coordinates
 * come back in original-image space.
 */
export function rasteriseImage(img, opts = {}) {
  const crop = opts.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const target = Math.min(
    MAX_WORKING_WIDTH,
    Math.max(crop.w, opts.minWidth ?? MIN_WORKING_WIDTH)
  );
  const scale = crop.w > 0 ? target / crop.w : 1;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(crop.w * scale);
  canvas.height = Math.round(crop.h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);

  if (opts.grayscale !== false) applyGrayscaleContrast(ctx, canvas, opts);

  return { canvas, scale, offsetX: crop.x * scale, offsetY: crop.y * scale };
}

/**
 * Light pre-processing. Screenshots of financial tables are usually clean, but
 * JPEG artefacts and coloured banding hurt digit recognition; flattening to
 * grey with a gentle contrast stretch is a reliable win and cheap.
 */
export function applyGrayscaleContrast(ctx, canvas, opts = {}) {
  const gain = opts.contrast ?? 1.25;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const stretched = Math.min(255, Math.max(0, (g - 128) * gain + 128));
    d[i] = d[i + 1] = d[i + 2] = stretched;
  }
  ctx.putImageData(image, 0, 0);
  return ctx;
}

export async function extractImage(file, opts = {}, onProgress) {
  const report = progressReporter(onProgress);
  throwIfAborted(opts.signal);

  report('image', 0, 3, `Decoding ${file.name}`);
  const img = await loadImage(file);
  throwIfAborted(opts.signal);

  report('image', 1, 3, 'Preparing image for OCR');
  const raster = rasteriseImage(img, opts);
  throwIfAborted(opts.signal);

  report('image', 2, 3, 'Reading text (OCR) — this is the slow part');
  const { words, meanConfidence } = await recogniseCanvas(raster.canvas, raster, {
    ...OCR_DEFAULTS,
    ...opts,
    logger: (m) => {
      if (m && m.status === 'recognizing text') {
        report('ocr', Math.round((m.progress || 0) * 100), 100, `OCR ${Math.round((m.progress || 0) * 100)}%`);
      }
    }
  });
  throwIfAborted(opts.signal);

  const docId = uuid();
  const built = buildPageTables(
    { words, page: 1, docId, sourceFile: file.name, origin: 'image' },
    opts
  );

  const page = createPage({
    number: 1,
    textChars: words.reduce((n, w) => n + w.text.length, 0),
    hasTextLayer: false,
    needsOcr: false,
    ocrApplied: true,
    words
  });
  annotateTables(built.tables, page, opts);

  const doc = createDoc({
    id: docId,
    fileName: file.name,
    fileType: 'image',
    pageCount: 1,
    pages: [page],
    tables: built.tables
  });

  warn(doc, 'Read by OCR from an image. Check every figure against the original before publishing.');
  if (Number.isFinite(meanConfidence) && meanConfidence < 80) {
    warn(doc, `Average OCR confidence ${Math.round(meanConfidence)}% — low. Try a larger or sharper screenshot.`);
  }
  if (!built.tables.length) {
    warn(doc, 'No table structure found. If the image is a table, crop it tighter and try again.');
  }

  report('image', 3, 3, `Found ${built.tables.length} table(s)`);
  return doc;
}

export const extractor = {
  id: 'image',
  label: 'Image / screenshot (OCR)',
  priority: 10,
  accepts: matcher({
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
    mimes: ['image/*']
  }),
  extract: extractImage
};

export default { extractor, extractImage, rasteriseImage, loadImage, applyGrayscaleContrast };
