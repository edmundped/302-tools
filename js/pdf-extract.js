(function () {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  async function extractPdfTables(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const tables = [];
    const scannedPages = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items = textContent.items
        .map((item) => ({
          text: item.str.trim(),
          x: item.transform[4],
          y: item.transform[5],
          width: item.width || 0
        }))
        .filter((item) => item.text);

      if (items.length < 8) {
        scannedPages.push(pageNum);
        continue;
      }

      detectTablesOnPage(items, pageNum, file.name).forEach((table) => {
        table.tableId = tables.length + 1;
        tables.push(table);
      });
    }

    return { fileName: file.name, pageCount: pdf.numPages, tables, scannedPages };
  }

  function detectTablesOnPage(items, page, sourceFile) {
    const rows = groupRows(items);
    const candidateBands = splitRowBands(rows);
    return candidateBands
      .map((band) => rowsToTable(band, page, sourceFile))
      .filter((table) => table.rows.length >= 2 && maxRowWidth(table.rows) >= 2);
  }

  function groupRows(items) {
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    const tolerance = 3.5;

    sorted.forEach((item) => {
      let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
      if (!row) {
        row = { y: item.y, items: [] };
        rows.push(row);
      }
      row.items.push(item);
      row.y = (row.y * (row.items.length - 1) + item.y) / row.items.length;
    });

    return rows
      .map((row) => ({
        y: row.y,
        items: row.items.sort((a, b) => a.x - b.x)
      }))
      .sort((a, b) => b.y - a.y);
  }

  function splitRowBands(rows) {
    const bands = [];
    let current = [];
    let lastY = null;

    rows.forEach((row) => {
      const textItems = row.items.length;
      const looksTabular = textItems >= 2 || row.items.some((item) => /\d/.test(item.text));
      const gap = lastY === null ? 0 : Math.abs(lastY - row.y);

      if (!looksTabular || gap > 28) {
        if (current.length >= 2) bands.push(current);
        current = looksTabular ? [row] : [];
      } else {
        current.push(row);
      }
      lastY = row.y;
    });

    if (current.length >= 2) bands.push(current);
    return bands;
  }

  function rowsToTable(rowBand, page, sourceFile) {
    const anchors = inferColumnAnchors(rowBand);
    const gridRows = rowBand
      .map((row) => rowToCells(row, anchors))
      .filter((row) => row.some(Boolean));

    const headerIndex = chooseHeaderRow(gridRows);
    const headers = headerIndex >= 0
      ? gridRows[headerIndex].map((cell, index) => cell || (index === 0 ? "row_label" : `column_${index}`))
      : [];
    const rows = gridRows.filter((_, index) => index !== headerIndex);

    return { sourceFile, page, headers, rows, selected: true };
  }

  function inferColumnAnchors(rows) {
    const xs = [];
    rows.forEach((row) => {
      row.items.forEach((item) => xs.push(item.x));
    });
    xs.sort((a, b) => a - b);

    const anchors = [];
    xs.forEach((x) => {
      const existing = anchors.find((anchor) => Math.abs(anchor - x) < 18);
      if (existing === undefined) anchors.push(x);
    });
    return anchors;
  }

  function rowToCells(row, anchors) {
    const cells = Array.from({ length: anchors.length }, () => "");
    row.items.forEach((item) => {
      let index = 0;
      let distance = Infinity;
      anchors.forEach((anchor, anchorIndex) => {
        const nextDistance = Math.abs(anchor - item.x);
        if (nextDistance < distance) {
          distance = nextDistance;
          index = anchorIndex;
        }
      });
      cells[index] = cells[index] ? `${cells[index]} ${item.text}` : item.text;
    });
    return trimEmptyEdges(cells);
  }

  function trimEmptyEdges(row) {
    let start = 0;
    let end = row.length;
    while (start < end && !row[start]) start += 1;
    while (end > start && !row[end - 1]) end -= 1;
    return row.slice(start, end);
  }

  function chooseHeaderRow(rows) {
    const index = rows.findIndex((row) => row.length >= 2 && row.filter(Boolean).every((cell) => !/^\(?[$₵£€]?\d/.test(cell)));
    return index >= 0 && index < 3 ? index : -1;
  }

  function maxRowWidth(rows) {
    return Math.max(0, ...rows.map((row) => row.length));
  }

  window.PdfExtract = { extractPdfTables };
})();
