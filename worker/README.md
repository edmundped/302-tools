# 302 Data Tools — CORS fetch proxy

A Cloudflare Worker that lets the browser-side scraper read third-party pages
and documents. Browsers refuse cross-origin reads without CORS headers, and
almost no report site sends them, so every scraper request goes through here.

The deployed Worker URL goes into the app: **Scrape tab → proxy URL**, which is
persisted through `js/core/config.js` under the `proxyUrl` key. Nothing else in
the app needs changing.

---

## What it is not

It is not an open relay, and it should not become one. The five-line proxy in
the original brief will happily fetch `http://169.254.169.254/` — your cloud
metadata endpoint — or `http://192.168.1.1/`, for anyone who finds the URL.
This Worker refuses those, caps the response size, and re-checks every redirect
hop.

---

## Deploy with Wrangler

```sh
npm install -g wrangler          # or: npx wrangler
cd worker
wrangler login
wrangler deploy
```

`wrangler deploy` reads `wrangler.toml` in this directory and prints the
deployed URL, for example:

```
https://302-tools-proxy.<your-subdomain>.workers.dev
```

Paste that whole URL into the app's proxy field. Do not add `?url=` yourself —
the app appends it.

Verify before you paste it in:

```sh
curl -i "https://302-tools-proxy.<your-subdomain>.workers.dev?url=https%3A%2F%2Fexample.com"
# expect: 200, access-control-allow-origin: *, x-302-proxy: 1

curl -i "https://302-tools-proxy.<your-subdomain>.workers.dev?url=http%3A%2F%2F169.254.169.254%2F"
# expect: 403 with {"code":"BLOCKED_HOST"}
```

## Deploy from the dashboard

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it `302-tools-proxy`, **Deploy** the placeholder.
3. **Edit code**, delete the placeholder, paste all of `worker/index.js`, **Deploy**.
4. **Settings → Variables → Add variable** for anything in the table below.
5. Copy the `*.workers.dev` URL from the Worker's overview page.

### Putting it on your own domain (optional)

Worker → **Settings → Domains & Routes → Add → Custom domain**, or add a route
such as `proxy.example.com/*` with the zone selected. The domain must already
be on Cloudflare. Use the custom hostname in the app's proxy field.

---

## Configuration

All variables are optional. Set them under **Settings → Variables** (dashboard)
or in `[vars]` in `wrangler.toml`.

| Variable | Default | What it does |
|---|---|---|
| `MAX_BYTES` | `33554432` (32 MB) | Largest response passed through. Bigger files get a `413 TOO_LARGE`. |
| `TIMEOUT_MS` | `30000` | Abort the upstream fetch after this long. |
| `ALLOW_ORIGIN` | `*` | Set this to your Pages origin (e.g. `https://302-analytics.github.io`) so only your app can use the Worker. |
| `ALLOW_HOSTS` | empty | Comma-separated hostname allowlist. Empty means any public host. Subdomains of a listed host are allowed. |
| `BLOCK_HOSTS` | empty | Comma-separated hostname blocklist. |
| `MAX_REDIRECTS` | `5` | Redirect hops followed, each re-validated. |
| `USER_AGENT` | `302-tools/1.0 …` | Sent upstream. Keep it honest — sites block proxies that lie. |

**Set `ALLOW_ORIGIN` once the app is deployed.** It is the difference between a
proxy only your app can use and one anyone can.

---

## API

```
GET  /?url=<url-encoded absolute http(s) URL>[&range=bytes%3D0-0]
HEAD /?url=…
OPTIONS /            → 204 preflight
```

`range` exists so the app can learn a file's `Content-Type` and size when the
origin refuses `HEAD`. Passing it as a query parameter rather than a `Range`
header avoids a CORS preflight on every probe.

### Response headers

| Header | Meaning |
|---|---|
| `x-302-proxy: 1` | The response came from this Worker. The app uses its absence to say "that URL is not the proxy" rather than "network error". |
| `x-302-target-status` | The status the target returned. |
| `x-302-final-url` | Where the redirect chain ended. |
| `content-type`, `content-length`, `content-range`, `accept-ranges`, `last-modified`, `etag` | Passed through and CORS-exposed. |

`Content-Length` is dropped on streamed responses where the origin did not
declare one, because it would then be a guess.

### Error bodies

Errors are JSON with a stable `code`:

```json
{ "error": "\"169.254.169.254\" is a private, loopback or otherwise internal address and is not proxied.",
  "code": "BLOCKED_HOST", "detail": null, "proxy": "302-tools" }
```

| Code | Status | |
|---|---|---|
| `BAD_URL` | 400 | `url` missing or unparseable |
| `BAD_SCHEME` | 400 | not http/https |
| `CREDENTIALS_IN_URL` | 400 | `user:pass@` in the URL |
| `BLOCKED_HOST` | 403 | private / loopback / link-local / CGNAT / multicast / internal suffix |
| `BLOCKED_PORT` | 403 | privileged port other than 80/443/8080/8443 |
| `HOST_BLOCKLISTED` / `HOST_NOT_ALLOWLISTED` | 403 | your `BLOCK_HOSTS` / `ALLOW_HOSTS` |
| `BLOCKED_REDIRECT` | 403 | the target redirected somewhere blocked |
| `TOO_MANY_REDIRECTS` | 508 | past `MAX_REDIRECTS` |
| `TOO_LARGE` | 413 | declared `Content-Length` above `MAX_BYTES` |
| `FETCH_FAILED` | 502 | DNS or connection failure upstream |
| `TARGET_TIMEOUT` | 504 | past `TIMEOUT_MS` |
| `METHOD_NOT_ALLOWED` | 405 | anything other than GET/HEAD/OPTIONS |

---

## Known limits

- **DNS rebinding is not fully preventable here.** The Worker blocks IP
  *literals* in private ranges, but a hostname that resolves to a private
  address still resolves inside Cloudflare's network. Cloudflare's runtime does
  not expose a resolver, so the address cannot be checked before connecting. Set
  `ALLOW_HOSTS` if the Worker will ever sit next to something private.
- The byte cap is enforced by counting the stream. A response that passes the
  cap is *errored*, not truncated, so a partial file is never mistaken for a
  whole one.
- Cookies, `Authorization` and other credentials are never forwarded. That is
  deliberate: this must not become a way around a login. If a document needs a
  session, download it in your own browser and drop it into the Extract tab.
- Cloudflare's free plan has a daily request limit and a CPU-time limit per
  request. Large PDFs are streamed, so CPU is rarely the constraint; requests
  are.
