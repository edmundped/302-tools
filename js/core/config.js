/**
 * core/config.js — brand tokens mirrored for JS, pinned CDN versions,
 * and persisted user settings.
 *
 * Persistence rule (non-negotiable): only *preferences* are written to
 * localStorage. File contents, extracted tables and page images never are.
 */

/* ------------------------------------------------------------------ brand */

export const BRAND = {
  navy: '#1D3756',
  gold: '#D4B784',
  cream: '#F2F1EF',
  paper: '#FBFAF8'
};

/* ------------------------------------------------------- pinned CDN libs  */
/* Exact versions only. Mirrored in index.html <script> tags; kept here so
   modules can build worker URLs without hard-coding a second version. */

export const CDN = {
  base: 'https://cdnjs.cloudflare.com/ajax/libs',
  pdfjs: '3.11.174',
  papaparse: '5.4.1',
  jszip: '3.10.1',
  filesaver: '2.0.5',
  xlsx: '0.18.5',
  tesseract: '5.1.0',
  mammoth: '1.6.0'
};

export const PDFJS_WORKER_SRC = `${CDN.base}/pdf.js/${CDN.pdfjs}/pdf.worker.min.js`;
export const TESSERACT_CDN = `${CDN.base}/tesseract.js/${CDN.tesseract}/tesseract.min.js`;

/* ------------------------------------------------------------- constants  */

export const LIMITS = {
  /** chars of non-boilerplate body text below which a page needs OCR
   *  (ARCHITECTURE.md § Scanned-page detection) */
  TEXT_LAYER_MIN: 180,
  /** rows rendered in the preview grid before it virtualises to a notice */
  PREVIEW_MAX_ROWS: 400,
  /** confidence below which a table is flagged as needing a hard look */
  LOW_CONFIDENCE: 0.55,
  /** foot-check tolerance, absolute, in the table's own units */
  FOOT_TOLERANCE: 0.5
};

/**
 * bbox coordinate convention consumed by the crop preview.
 * 'top-left'  → bbox.y measured down from the top of the page (pdf.js viewport)
 * 'bottom-left' → PDF user space, y measured up from the page foot
 * See the contract note in docs/ — preview.js handles both, this is the default
 * assumed when a Doc does not declare `bboxOrigin`.
 */
export const BBOX_ORIGIN = 'top-left';

export const ACCEPT = {
  pdf: { ext: ['pdf'], mime: ['application/pdf'], label: 'PDF' },
  image: {
    ext: ['png', 'jpg', 'jpeg', 'webp'],
    mime: ['image/png', 'image/jpeg', 'image/webp'],
    label: 'Image'
  },
  xlsx: {
    ext: ['xlsx', 'xls', 'csv'],
    mime: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ],
    label: 'Spreadsheet'
  },
  docx: {
    ext: ['docx'],
    mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    label: 'Word'
  }
};

/** flat accept string for <input type="file"> */
export const ACCEPT_ATTR = Object.values(ACCEPT)
  .flatMap((group) => [...group.ext.map((e) => `.${e}`), ...group.mime])
  .join(',');

export function classifyFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  for (const [kind, group] of Object.entries(ACCEPT)) {
    if (group.ext.includes(ext) || (file.type && group.mime.includes(file.type))) {
      return { kind, label: group.label, ext };
    }
  }
  return { kind: null, label: ext ? ext.toUpperCase() : 'Unknown', ext };
}

/* -------------------------------------------------------------- settings  */

const STORAGE_KEY = '302tools.settings.v2';

export const DEFAULT_SETTINGS = {
  /** scraper CORS proxy (Cloudflare Worker) */
  proxyUrl: '',
  /** which emitters run on download */
  outputs: {
    machine: true,   // tidy/long  {base}_data.csv
    analyst: true,   // wide/faithful  {base}_p{n}_t{n}_review.csv
    notes: false,    // notes-only  {base}_notes.csv
    workbook: false  // single .xlsx, one sheet per table
  },
  /** extraction defaults, reused as the seed for "apply to the rest" */
  extract: {
    ocrMode: 'auto',        // 'off' | 'auto' | 'always'
    ocrLang: 'eng',
    ocrDpi: 200,
    dropLowConfidence: false,
    expectedColumns: []     // "say the columns" — analyst-declared schema
  },
  /** preview chrome */
  preview: {
    showCrop: true,
    showFootCheck: true,
    density: 'compact'      // 'compact' | 'roomy'
  }
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object'
        ? deepMerge(base[key], value)
        : value;
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false; // private mode / quota — the app still works, just forgets
  }
}

export function clearSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export { deepMerge };
