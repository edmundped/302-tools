/**
 * js/scraper/fetchers.js — proxy plumbing, content-type sniffing, robots.txt,
 * and the polite-request limiter.
 *
 * Everything the scraper sends goes through the Cloudflare Worker in worker/.
 * A browser cannot fetch a third-party page directly, so a missing or wrong
 * proxy is the single most common failure and it gets its own error code and
 * its own actionable message rather than a raw `TypeError: Failed to fetch`.
 */

/* ------------------------------------------------------------------ *
 * Config bridge
 *
 * core/config.js belongs to the UI agent. Import it lazily and fall back to a
 * localStorage shim with the same getConfig()/setConfig() shape so the scraper
 * still works in a build where that module has not landed.
 * ------------------------------------------------------------------ */
const FALLBACK_KEY = '302tools.config';
let configPromise = null;

function fallbackConfig() {
  return {
    getConfig() {
      try {
        return JSON.parse(localStorage.getItem(FALLBACK_KEY) || '{}');
      } catch {
        return {};
      }
    },
    setConfig(patch) {
      const next = { ...this.getConfig(), ...patch };
      try {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify(next));
      } catch {
        /* private mode — keep it in memory only */
      }
      return next;
    },
    __fallback: true
  };
}

function config() {
  if (!configPromise) {
    configPromise = import('../core/config.js')
      .then((mod) => (typeof mod.getConfig === 'function' ? mod : fallbackConfig()))
      .catch(() => fallbackConfig());
  }
  return configPromise;
}

export async function getProxyUrl() {
  const cfg = await config();
  const value = (cfg.getConfig() || {}).proxyUrl;
  return String(value || '').trim();
}

export async function setProxyUrl(url) {
  const cfg = await config();
  cfg.setConfig({ proxyUrl: String(url || '').trim() });
  return getProxyUrl();
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */
export class ScrapeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ScrapeError';
    this.code = code;
    this.detail = detail || null;
  }
}

export const ERROR_HELP = {
  NO_PROXY:
    'No proxy is configured. Deploy the Worker in worker/ and paste its URL into Settings — the browser cannot fetch another site directly.',
  BAD_URL: 'That URL could not be parsed. Include the scheme, for example https://example.com/reports.',
  BAD_PROXY_URL: 'The configured proxy URL is not a valid absolute http(s) URL.',
  PROXY_UNREACHABLE:
    'The proxy did not respond. Check the Worker URL, that the Worker is deployed, and that you are online.',
  NOT_A_PROXY:
    'That URL answered, but it is not the 302 Worker — the response did not carry the x-302-proxy header. Check you pasted the Worker URL and not the site URL.',
  PROXY_ERROR: 'The proxy refused the request.',
  TIMEOUT: 'The request timed out. The target site may be slow or blocking the proxy.',
  TARGET_NOT_FOUND: 'The target URL returned 404. Check the link — report indexes move often.',
  TARGET_FORBIDDEN:
    'The target returned 401/403. It is behind a login, a paywall or a bot block. Do not try to bypass it; download the file manually and drop it into the Extract tab.',
  TARGET_ERROR: 'The target site returned a server error.',
  NOT_HTML: 'The URL did not return an HTML page. If it is a document, send it straight to the extractor instead.',
  CORS_BLOCKED:
    'The browser blocked the response for cross-origin reasons. The proxy must return Access-Control-Allow-Origin: *.',
  TOO_LARGE: 'The file is larger than the proxy will pass through.',
  ABORTED: 'Cancelled.'
};

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/**
 * Pure: build the proxied URL.
 *
 * A byte range travels as a query parameter rather than a `Range` request
 * header on purpose: a custom header would make every probe a CORS preflight,
 * doubling the request count against a site we are trying to be polite to.
 */
export function buildProxyUrl(proxyBase, targetUrl, params) {
  const base = String(proxyBase || '').trim();
  if (!base) throw new ScrapeError('NO_PROXY', ERROR_HELP.NO_PROXY);
  if (!/^https?:\/\//i.test(base)) throw new ScrapeError('BAD_PROXY_URL', ERROR_HELP.BAD_PROXY_URL);
  const separator = base.includes('?') ? '&' : '?';
  let url = `${base}${separator}url=${encodeURIComponent(targetUrl)}`;
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  });
  return url;
}

export function absoluteUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

export function filenameFromUrl(url, fallback) {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    return last || fallback || parsed.hostname.replace(/\W+/g, '_');
  } catch {
    return fallback || 'download';
  }
}

const EXTENSION_KINDS = [
  [/\.pdf($|[?#])/i, 'pdf'],
  [/\.(xlsx|xlsm|xls|ods)($|[?#])/i, 'spreadsheet'],
  [/\.(csv|tsv)($|[?#])/i, 'csv'],
  [/\.(docx|doc|rtf|odt)($|[?#])/i, 'document'],
  [/\.(png|jpe?g|gif|webp|tiff?|bmp|svg)($|[?#])/i, 'image'],
  [/\.(zip|7z|tar|gz)($|[?#])/i, 'archive'],
  [/\.(html?|xhtml)($|[?#])/i, 'html']
];

const MIME_KINDS = [
  [/^application\/pdf/i, 'pdf'],
  [/spreadsheetml|ms-excel|vnd\.oasis\.opendocument\.spreadsheet/i, 'spreadsheet'],
  [/^text\/csv|^text\/tab-separated/i, 'csv'],
  [/wordprocessingml|msword|vnd\.oasis\.opendocument\.text|^application\/rtf/i, 'document'],
  [/^image\//i, 'image'],
  [/^application\/(zip|x-7z|x-tar|gzip)/i, 'archive'],
  [/^text\/html|^application\/xhtml/i, 'html'],
  [/^text\/plain/i, 'text']
];

const VAGUE_MIME = /^(application\/octet-stream|binary\/octet-stream|application\/force-download|application\/download|content\/unknown)$/i;

/**
 * Pure: decide what a link actually is.
 *
 * Content-Type wins when it says something specific; a great many report links
 * are extensionless or served as octet-stream, which is exactly why the HEAD
 * pass exists.
 *
 * @returns { kind, basis:'content-type'|'extension'|'unknown', mime }
 */
export function sniffKind(url, contentType) {
  const mime = String(contentType || '').split(';')[0].trim();

  if (mime && !VAGUE_MIME.test(mime)) {
    for (const [pattern, kind] of MIME_KINDS) {
      if (pattern.test(mime)) {
        // text/plain on a .csv link is really a CSV.
        if (kind === 'text') break;
        return { kind, basis: 'content-type', mime };
      }
    }
  }

  for (const [pattern, kind] of EXTENSION_KINDS) {
    if (pattern.test(String(url || ''))) return { kind, basis: 'extension', mime };
  }

  if (/^text\/plain/i.test(mime)) return { kind: 'text', basis: 'content-type', mime };
  return { kind: 'unknown', basis: 'unknown', mime };
}

export const DOCUMENT_KINDS = ['pdf', 'spreadsheet', 'csv', 'document', 'image'];

export function isDocumentKind(kind) {
  return DOCUMENT_KINDS.includes(kind);
}

/** Pure. */
export function formatBytes(bytes) {
  // An unknown size shows nothing at all. Number(null) is 0, so a bare
  // Number() check would render a missing Content-Length as a confident "0 B".
  if (bytes === null || bytes === undefined || bytes === '') return '';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/* ------------------------------------------------------------------ *
 * robots.txt
 * ------------------------------------------------------------------ */

/** Pure: parse robots.txt into per-user-agent rule groups. */
export function parseRobots(text) {
  const groups = new Map();
  let current = [];
  let expectingAgent = false;

  String(text || '')
    .split(/\r?\n/)
    .forEach((rawLine) => {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) return;
      const colon = line.indexOf(':');
      if (colon === -1) return;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();

      if (field === 'user-agent') {
        const agent = value.toLowerCase();
        if (!expectingAgent) {
          current = [];
          expectingAgent = true;
        }
        if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [], crawlDelay: null });
        current.push(groups.get(agent));
        return;
      }

      expectingAgent = false;
      if (!current.length) return;
      if (field === 'disallow') current.forEach((group) => group.disallow.push(value));
      else if (field === 'allow') current.forEach((group) => group.allow.push(value));
      else if (field === 'crawl-delay') {
        const delay = Number(value);
        if (Number.isFinite(delay)) current.forEach((group) => (group.crawlDelay = delay));
      }
    });

  return groups;
}

function matchLength(pattern, path) {
  if (pattern === '') return -1;
  // Support the * and $ wildcards that every major crawler honours.
  if (pattern.includes('*') || pattern.endsWith('$')) {
    const source =
      '^' +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$');
    try {
      return new RegExp(source).test(path) ? pattern.replace(/\*/g, '').length : -1;
    } catch {
      return -1;
    }
  }
  return path.startsWith(pattern) ? pattern.length : -1;
}

/**
 * Pure: standard longest-match-wins evaluation, Allow beating Disallow on ties.
 * @returns { allowed:boolean, rule:string|null, crawlDelay:number|null, matchedAgent:string|null }
 */
export function isAllowed(groups, path, userAgent) {
  if (!groups || !groups.size) return { allowed: true, rule: null, crawlDelay: null, matchedAgent: null };
  const ua = String(userAgent || '*').toLowerCase();
  const group = groups.get(ua) || groups.get('*');
  const matchedAgent = groups.has(ua) ? ua : groups.has('*') ? '*' : null;
  if (!group) return { allowed: true, rule: null, crawlDelay: null, matchedAgent: null };

  let best = { allowed: true, rule: null, length: -1 };
  group.disallow.forEach((pattern) => {
    const length = matchLength(pattern, path);
    if (length > best.length) best = { allowed: false, rule: `Disallow: ${pattern}`, length };
  });
  group.allow.forEach((pattern) => {
    const length = matchLength(pattern, path);
    if (length >= best.length) best = { allowed: true, rule: `Allow: ${pattern}`, length };
  });

  return { allowed: best.allowed, rule: best.rule, crawlDelay: group.crawlDelay, matchedAgent };
}

/* ------------------------------------------------------------------ *
 * Politeness
 * ------------------------------------------------------------------ */

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ScrapeError('ABORTED', ERROR_HELP.ABORTED));
        },
        { once: true }
      );
    }
  });
}

/**
 * Concurrency cap plus a minimum gap between request starts. Both matter:
 * concurrency alone still lets you open six sockets at once on the first tick.
 */
export function createLimiter(concurrency, minGapMs) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const gap = Math.max(0, Number(minGapMs) || 0);
  let active = 0;
  let lastStart = 0;
  const queue = [];

  function pump() {
    if (active >= limit || !queue.length) return;
    const wait = Math.max(0, lastStart + gap - Date.now());
    setTimeout(() => {
      if (active >= limit || !queue.length) return;
      const job = queue.shift();
      active += 1;
      lastStart = Date.now();
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
      pump();
    }, wait);
  }

  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  };
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

function classifyStatus(status, bodyText) {
  if (status === 404) return new ScrapeError('TARGET_NOT_FOUND', ERROR_HELP.TARGET_NOT_FOUND, bodyText);
  if (status === 401 || status === 403) return new ScrapeError('TARGET_FORBIDDEN', ERROR_HELP.TARGET_FORBIDDEN, bodyText);
  if (status === 413) return new ScrapeError('TOO_LARGE', ERROR_HELP.TOO_LARGE, bodyText);
  if (status >= 500) return new ScrapeError('TARGET_ERROR', `${ERROR_HELP.TARGET_ERROR} (${status})`, bodyText);
  return new ScrapeError('PROXY_ERROR', `${ERROR_HELP.PROXY_ERROR} (HTTP ${status})`, bodyText);
}

/**
 * Fetch a target URL through the configured proxy.
 * @returns Response — with `proxied` (bool) and `targetStatus` attached.
 */
export async function proxyFetch(targetUrl, options) {
  const opts = { method: 'GET', timeoutMs: 30000, ...(options || {}) };
  if (!absoluteUrl(targetUrl)) throw new ScrapeError('BAD_URL', ERROR_HELP.BAD_URL, targetUrl);

  const proxy = await getProxyUrl();
  const url = buildProxyUrl(proxy, targetUrl, opts.range ? { range: opts.range } : null);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch(url, { method: opts.method, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    clearTimeout(timer);
    if (opts.signal && opts.signal.aborted) throw new ScrapeError('ABORTED', ERROR_HELP.ABORTED);
    if (err.name === 'AbortError') throw new ScrapeError('TIMEOUT', ERROR_HELP.TIMEOUT, targetUrl);
    // A TypeError here is either the proxy being down or its CORS headers
    // missing; both look identical to the browser, so say both.
    throw new ScrapeError(
      'PROXY_UNREACHABLE',
      `${ERROR_HELP.PROXY_UNREACHABLE} (${err.message})`,
      proxy
    );
  }
  clearTimeout(timer);

  response.proxied = response.headers.get('x-302-proxy') !== null;
  const upstream = response.headers.get('x-302-target-status');
  response.targetStatus = upstream ? Number(upstream) : response.status;

  if (!response.ok) {
    let body = '';
    try {
      body = (await response.clone().text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    if (!response.proxied && response.status >= 400) {
      throw new ScrapeError('NOT_A_PROXY', ERROR_HELP.NOT_A_PROXY, body);
    }
    throw classifyStatus(response.targetStatus || response.status, body);
  }

  return response;
}

/**
 * HEAD a candidate to learn its type and size, falling back gracefully when
 * HEAD is refused — which a surprising number of CDNs and IIS sites do.
 *
 * @returns { ok, status, contentType, contentLength, kind, basis, method, error }
 */
export async function headInfo(targetUrl, options) {
  const opts = { timeoutMs: 15000, ...(options || {}) };

  const read = (response, method) => {
    const contentType = response.headers.get('content-type') || '';
    let contentLength = response.headers.get('content-length');
    const range = response.headers.get('content-range');
    if ((!contentLength || contentLength === '1' || contentLength === '0') && range) {
      const match = /\/(\d+)\s*$/.exec(range);
      if (match) contentLength = match[1];
    }
    const sniffed = sniffKind(targetUrl, contentType);
    return {
      ok: true,
      status: response.targetStatus || response.status,
      contentType,
      contentLength: contentLength === null || contentLength === undefined || contentLength === '' ? null : Number(contentLength),
      kind: sniffed.kind,
      basis: sniffed.basis,
      method,
      error: null
    };
  };

  try {
    return read(await proxyFetch(targetUrl, { ...opts, method: 'HEAD' }), 'HEAD');
  } catch (err) {
    if (err.code === 'ABORTED' || err.code === 'NO_PROXY' || err.code === 'BAD_PROXY_URL') throw err;
    // HEAD refused (405/501) or otherwise unhappy: try a one-byte ranged GET.
    try {
      const response = await proxyFetch(targetUrl, { ...opts, method: 'GET', range: 'bytes=0-0' });
      const info = read(response, 'GET');
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      return info;
    } catch (inner) {
      const sniffed = sniffKind(targetUrl, '');
      return {
        ok: false,
        status: null,
        contentType: '',
        contentLength: null,
        kind: sniffed.kind,
        basis: sniffed.basis,
        method: 'none',
        error: { code: inner.code || err.code, message: inner.message || err.message }
      };
    }
  }
}

/** Download a discovered document as a File, ready for bus.emit('ingest:files', [file]). */
export async function fetchAsFile(targetUrl, options) {
  const opts = options || {};
  const response = await proxyFetch(targetUrl, { timeoutMs: 120000, ...opts });
  const blob = await response.blob();
  const contentType = response.headers.get('content-type') || blob.type || 'application/octet-stream';
  let name = opts.fileName || filenameFromUrl(targetUrl, 'download');
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const kind = sniffKind(targetUrl, contentType).kind;
    const ext = { pdf: 'pdf', spreadsheet: 'xlsx', csv: 'csv', document: 'docx', image: 'png', html: 'html' }[kind];
    if (ext) name = `${name}.${ext}`;
  }
  return new File([blob], name, { type: contentType.split(';')[0].trim() });
}

/** Fetch an HTML page and hand back the parsed document. */
export async function fetchHtml(targetUrl, options) {
  const response = await proxyFetch(targetUrl, options);
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/text\/html|application\/xhtml|text\/plain|^$/i.test(contentType.split(';')[0].trim())) {
    const kind = sniffKind(targetUrl, contentType).kind;
    throw new ScrapeError(
      'NOT_HTML',
      `${ERROR_HELP.NOT_HTML} It looks like a ${kind} (${contentType.split(';')[0]}).`,
      contentType
    );
  }
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return { doc, html, finalUrl: targetUrl, contentType };
}

/** Fetch and evaluate robots.txt for an origin. Never throws — absence means allowed. */
export async function fetchRobots(originUrl, options) {
  let origin;
  try {
    origin = new URL(originUrl).origin;
  } catch {
    return { available: false, groups: null, error: 'bad url' };
  }
  try {
    const response = await proxyFetch(`${origin}/robots.txt`, { timeoutMs: 12000, ...(options || {}) });
    const text = await response.text();
    return { available: true, groups: parseRobots(text), text, origin };
  } catch (err) {
    return { available: false, groups: null, error: err.code || 'unavailable', origin };
  }
}
