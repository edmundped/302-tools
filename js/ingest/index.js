/**
 * ingest/index.js — the extractor registry.
 *
 * Adding a format means adding one file and calling register(). No shared file
 * is edited. See docs/ARCHITECTURE.md § Ingest registry.
 *
 *   register({ id, label, accepts(file) -> boolean,
 *              async extract(file, opts, onProgress) -> Doc })
 *   pickExtractor(file) -> extractor | null
 */

const registry = [];

export function register(extractor) {
  if (!extractor || typeof extractor.extract !== 'function' || typeof extractor.accepts !== 'function') {
    throw new TypeError('register: extractor needs { id, accepts(file), extract(file, opts, onProgress) }');
  }
  const existing = registry.findIndex((e) => e.id === extractor.id);
  const entry = { priority: 0, ...extractor };
  if (existing >= 0) registry[existing] = entry;
  else registry.push(entry);
  registry.sort((a, b) => b.priority - a.priority);
  return entry;
}

export function unregister(id) {
  const i = registry.findIndex((e) => e.id === id);
  if (i >= 0) registry.splice(i, 1);
}

export function listExtractors() {
  return registry.slice();
}

export function pickExtractor(file) {
  return registry.find((e) => {
    try {
      return e.accepts(file);
    } catch {
      return false;
    }
  }) || null;
}

export function pickExtractors(file) {
  return registry.filter((e) => {
    try {
      return e.accepts(file);
    } catch {
      return false;
    }
  });
}

/* ---------------------------------------------------------------- */
/* helpers shared by the extractors                                   */
/* ---------------------------------------------------------------- */

export function extensionOf(file) {
  const name = String((file && file.name) || '');
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

export function mimeOf(file) {
  return String((file && file.type) || '').toLowerCase();
}

/** Matcher factory used by every extractor's accepts(). */
export function matcher({ extensions = [], mimes = [] }) {
  const exts = extensions.map((e) => e.toLowerCase().replace(/^\./, ''));
  return (file) => {
    if (!file) return false;
    const ext = extensionOf(file);
    if (ext && exts.includes(ext)) return true;
    const mime = mimeOf(file);
    return Boolean(mime) && mimes.some((m) => (m.endsWith('/*') ? mime.startsWith(m.slice(0, -1)) : mime === m));
  };
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error('Cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

/** Progress reporter that never throws when the caller passed nothing. */
export function progressReporter(onProgress) {
  return (phase, current, total, message) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ phase, current, total, message });
    } catch {
      /* the UI is not allowed to break extraction */
    }
  };
}

/**
 * Run the right extractor for a file.
 * Throws a clear error rather than returning an empty Doc when no extractor
 * claims the file — silence is the one thing this app must not do.
 */
export async function extract(file, opts = {}, onProgress) {
  const extractor = pickExtractor(file);
  if (!extractor) {
    throw new Error(`No extractor for "${(file && file.name) || 'file'}" (${mimeOf(file) || 'unknown type'})`);
  }
  return extractor.extract(file, opts, onProgress);
}

/**
 * Register everything. Called by the UI at start-up; kept out of module scope
 * so importing a single extractor in a test does not drag in pdf.js.
 */
export async function registerBuiltins() {
  const mods = await Promise.all([
    import('./pdf-text.js'),
    import('./xlsx.js'),
    import('./docx.js'),
    import('./image.js'),
    import('./html-table.js')
  ]);
  for (const m of mods) {
    if (m.extractor) register(m.extractor);
  }
  return listExtractors();
}

export default { register, unregister, pickExtractor, pickExtractors, listExtractors, extract, registerBuiltins, matcher };
