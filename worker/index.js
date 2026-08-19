/**
 * 302 Data Tools — CORS fetch proxy (Cloudflare Worker)
 *
 * The browser cannot fetch a third-party page, so the scraper sends everything
 * through here. This is deliberately more careful than the five-line proxy in
 * the original brief, because a naive `fetch(request.searchParams.get('url'))`
 * is an open relay: anyone who finds the Worker URL can use it to probe private
 * networks, pull unlimited data through your account, and hide their origin.
 *
 * What it does:
 *   - GET / HEAD / OPTIONS only
 *   - http and https schemes only
 *   - refuses loopback, private, link-local, CGNAT, multicast and cloud
 *     metadata addresses, and the obvious internal hostname suffixes (SSRF)
 *   - follows redirects manually, re-validating every hop, so a public URL
 *     cannot bounce you to 169.254.169.254
 *   - caps the response size, both by Content-Length and by counting bytes
 *   - passes Content-Type and Content-Length back to the browser and exposes
 *     them through CORS so the scraper can size and identify files
 *   - supports ranged probes (`&range=bytes=0-0`) so the client can learn a
 *     file's type and size when the origin refuses HEAD
 *   - returns JSON error bodies with a stable `code`
 *
 * Configure with Worker variables (all optional):
 *   MAX_BYTES      default 33554432 (32 MB)
 *   TIMEOUT_MS     default 30000
 *   ALLOW_ORIGIN   default "*" — set to your Pages origin to stop strangers using it
 *   ALLOW_HOSTS    comma-separated hostname allowlist; empty means "any public host"
 *   BLOCK_HOSTS    comma-separated hostname blocklist
 *   USER_AGENT     default "302-tools/1.0 (+https://github.com/302-analytics)"
 */

const DEFAULTS = {
  MAX_BYTES: 33554432,
  TIMEOUT_MS: 30000,
  ALLOW_ORIGIN: '*',
  MAX_REDIRECTS: 5,
  USER_AGENT: '302-tools/1.0 (+https://github.com/302-analytics)'
};

const ALLOWED_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const EXPOSED_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'x-302-proxy',
  'x-302-target-status',
  'x-302-final-url',
  'x-302-truncated'
].join(', ');

/* ------------------------------------------------------------------ *
 * SSRF guard
 * ------------------------------------------------------------------ */

const INTERNAL_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.localhost', '.lan', '.intranet'];

export function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // Bare decimal, octal or hex IPv4 (http://2130706433/ is 127.0.0.1)
  if (/^\d+$/.test(host) || /^0[xX][0-9a-fA-F]+$/.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;             // this-network, private, loopback
    if (a === 169 && b === 254) return true;                        // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;               // private
    if (a === 192 && b === 168) return true;                        // private
    if (a === 192 && b === 0) return true;                          // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;           // benchmarking
    if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT
    if (a >= 224) return true;                                      // multicast + reserved
    return false;
  }

  if (host === '::' || host === '::1') return true;
  if (/^::ffff:/i.test(host)) return isBlockedHost(host.replace(/^::ffff:/i, ''));
  if (/^f[cd][0-9a-f]{2}(:|$)/i.test(host)) return true;            // unique local
  if (/^fe[89ab][0-9a-f](:|$)/i.test(host)) return true;            // link-local
  if (host.includes(':') && !/^[0-9a-f:.]+$/i.test(host)) return true;

  return false;
}

export function validateTarget(rawUrl, env) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, code: 'BAD_URL', error: 'The url parameter is not a valid absolute URL.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      status: 400,
      code: 'BAD_SCHEME',
      error: `Only http and https are proxied. Got "${url.protocol}".`
    };
  }
  if (url.username || url.password) {
    return { ok: false, status: 400, code: 'CREDENTIALS_IN_URL', error: 'Credentials in the URL are not proxied.' };
  }
  if (!ALLOWED_PORTS.has(url.port) && Number(url.port) < 1024) {
    return { ok: false, status: 403, code: 'BLOCKED_PORT', error: `Port ${url.port} is not proxied.` };
  }
  if (isBlockedHost(url.hostname)) {
    return {
      ok: false,
      status: 403,
      code: 'BLOCKED_HOST',
      error: `"${url.hostname}" is a private, loopback or otherwise internal address and is not proxied.`
    };
  }

  const list = (value) =>
    String(value || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

  const blocked = list(env && env.BLOCK_HOSTS);
  if (blocked.some((entry) => url.hostname.toLowerCase() === entry || url.hostname.toLowerCase().endsWith(`.${entry}`))) {
    return { ok: false, status: 403, code: 'HOST_BLOCKLISTED', error: `"${url.hostname}" is on this proxy's blocklist.` };
  }

  const allowed = list(env && env.ALLOW_HOSTS);
  if (allowed.length && !allowed.some((entry) => url.hostname.toLowerCase() === entry || url.hostname.toLowerCase().endsWith(`.${entry}`))) {
    return {
      ok: false,
      status: 403,
      code: 'HOST_NOT_ALLOWLISTED',
      error: `This proxy is restricted to ${allowed.join(', ')}.`
    };
  }

  return { ok: true, url };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOW_ORIGIN) || DEFAULTS.ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function errorResponse(env, status, code, error, detail) {
  return new Response(JSON.stringify({ error, code, detail: detail || null, proxy: '302-tools' }, null, 2), {
    status,
    headers: {
      ...corsHeaders(env),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'x-302-proxy': '1'
    }
  });
}

/** Count bytes as they stream and fail the response if the cap is passed. */
function capStream(body, maxBytes) {
  let seen = 0;
  const transform = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new Error(`Response exceeded ${maxBytes} bytes.`));
        return;
      }
      controller.enqueue(chunk);
    }
  });
  return body.pipeThrough(transform);
}

/**
 * Follow redirects by hand so every hop is re-validated. `redirect: 'follow'`
 * would let a public URL 302 straight to an internal one.
 */
async function fetchWithGuardedRedirects(target, init, env, maxRedirects) {
  let url = target;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetch(url.href, { ...init, redirect: 'manual' });
    const status = response.status;
    if (status < 300 || status > 399) return { response, finalUrl: url, hops: hop };

    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: url, hops: hop };

    let next;
    try {
      next = new URL(location, url.href);
    } catch {
      return { error: errorResponse(env, 502, 'BAD_REDIRECT', `The target redirected to an unparseable location: ${location}`) };
    }
    const check = validateTarget(next.href, env);
    if (!check.ok) {
      return {
        error: errorResponse(env, 403, 'BLOCKED_REDIRECT', `The target redirected to a blocked address (${next.hostname}).`, check.code)
      };
    }
    url = next;
  }
  return { error: errorResponse(env, 508, 'TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects.`) };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const settings = {
      maxBytes: Number((env && env.MAX_BYTES) || DEFAULTS.MAX_BYTES),
      timeoutMs: Number((env && env.TIMEOUT_MS) || DEFAULTS.TIMEOUT_MS),
      maxRedirects: Number((env && env.MAX_REDIRECTS) || DEFAULTS.MAX_REDIRECTS),
      userAgent: (env && env.USER_AGENT) || DEFAULTS.USER_AGENT
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders(env), 'x-302-proxy': '1' } });
    }
    if (!ALLOWED_METHODS.includes(request.method)) {
      return errorResponse(env, 405, 'METHOD_NOT_ALLOWED', `${request.method} is not proxied. Use GET or HEAD.`);
    }

    const requestUrl = new URL(request.url);
    const raw = requestUrl.searchParams.get('url');

    if (!raw) {
      // A bare visit should explain itself rather than look broken.
      return new Response(
        JSON.stringify(
          {
            proxy: '302-tools',
            usage: `${requestUrl.origin}${requestUrl.pathname}?url=https%3A%2F%2Fexample.com%2Freports`,
            methods: ALLOWED_METHODS,
            maxBytes: settings.maxBytes,
            note: 'Paste this Worker URL into 302 Data Tools > Settings > proxy URL.'
          },
          null,
          2
        ),
        {
          status: 400,
          headers: { ...corsHeaders(env), 'Content-Type': 'application/json; charset=utf-8', 'x-302-proxy': '1' }
        }
      );
    }

    const check = validateTarget(raw, env);
    if (!check.ok) return errorResponse(env, check.status, check.code, check.error);
    const target = check.url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);

    // Range can arrive as a header (preflighted) or as ?range= (not preflighted).
    const range = requestUrl.searchParams.get('range') || request.headers.get('range');
    const outboundHeaders = {
      'User-Agent': settings.userAgent,
      Accept: '*/*',
      'Accept-Language': 'en'
    };
    if (range) outboundHeaders.Range = range;

    let result;
    try {
      result = await fetchWithGuardedRedirects(
        target,
        { method: request.method, headers: outboundHeaders, signal: controller.signal },
        env,
        settings.maxRedirects
      );
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return errorResponse(env, 504, 'TARGET_TIMEOUT', `The target did not respond within ${settings.timeoutMs} ms.`, target.hostname);
      }
      return errorResponse(env, 502, 'FETCH_FAILED', `Could not reach ${target.hostname}.`, String(err && err.message));
    }
    clearTimeout(timer);

    if (result.error) return result.error;
    const upstream = result.response;

    const headers = new Headers(corsHeaders(env));
    headers.set('x-302-proxy', '1');
    headers.set('x-302-target-status', String(upstream.status));
    headers.set('x-302-final-url', result.finalUrl.href);
    headers.set('Cache-Control', 'no-store');

    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((name) => {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    });
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');

    const declaredLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > settings.maxBytes) {
      return errorResponse(
        env,
        413,
        'TOO_LARGE',
        `That file is ${declaredLength} bytes; this proxy passes at most ${settings.maxBytes}. Download it directly and drop it into the Extract tab.`,
        result.finalUrl.href
      );
    }

    if (request.method === 'HEAD' || !upstream.body) {
      return new Response(null, { status: upstream.status, headers });
    }

    // Content-Length no longer describes what the browser will receive if the
    // stream is cut short, so drop it when we cannot vouch for it.
    if (!Number.isFinite(declaredLength)) headers.delete('content-length');

    return new Response(capStream(upstream.body, settings.maxBytes), {
      status: upstream.status,
      headers
    });
  }
};
