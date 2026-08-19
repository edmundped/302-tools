(function () {
  function proxyFetchUrl(proxyBase, targetUrl) {
    const base = proxyBase.trim();
    if (!base) throw new Error("Add a proxy base URL first.");
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}url=${encodeURIComponent(targetUrl)}`;
  }

  async function discoverSite(targetUrl, proxyBase) {
    const response = await fetch(proxyFetchUrl(proxyBase, targetUrl));
    if (!response.ok) throw new Error(`Proxy fetch failed: ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = new URL(targetUrl);

    const pdfs = Array.from(doc.querySelectorAll("a[href]"))
      .map((link) => {
        const url = new URL(link.getAttribute("href"), base).href;
        const label = link.textContent.trim() || url.split("/").pop() || "PDF";
        return { url, label, filename: filenameFromUrl(url) };
      })
      .filter((link) => /\.pdf($|[?#])/i.test(link.url));

    const tables = Array.from(doc.querySelectorAll("table")).map((table, index) => htmlTableToModel(table, index + 1, targetUrl));
    return { pdfs: dedupeByUrl(pdfs), tables };
  }

  function htmlTableToModel(table, tableId, sourceFile) {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
      Array.from(row.children).map((cell) => cell.textContent.replace(/\s+/g, " ").trim())
    ).filter((row) => row.length);
    const headers = rows[0] || [];
    return {
      sourceFile,
      page: "html",
      tableId,
      headers,
      rows: rows.slice(1),
      selected: true
    };
  }

  function dedupeByUrl(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  }

  function filenameFromUrl(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "download.pdf";
    } catch {
      return "download.pdf";
    }
  }

  async function downloadPdfViaProxy(proxyBase, pdfUrl) {
    const response = await fetch(proxyFetchUrl(proxyBase, pdfUrl));
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return response.blob();
  }

  window.Scraper = { discoverSite, downloadPdfViaProxy };
})();
