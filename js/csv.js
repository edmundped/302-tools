(function () {
  function normaliseNumber(raw) {
    if (raw === null || raw === undefined) return "";
    let value = String(raw).trim();
    if (!value || /^[-–—]$/.test(value)) return "";

    let negative = false;
    if (/^\(.*\)$/.test(value)) {
      negative = true;
      value = value.slice(1, -1);
    }

    const isPercent = /%$/.test(value);
    value = value
      .replace(/[,\s]/g, "")
      .replace(/[₵$£€¥]|GHS|USD|GBP|EUR/gi, "")
      .replace(/%$/g, "");

    if (!/^-?\d*\.?\d+$/.test(value)) return String(raw).trim();
    let number = Number(value);
    if (Number.isNaN(number)) return String(raw).trim();
    if (negative) number *= -1;
    if (isPercent) number /= 100;
    return String(number);
  }

  function csvEscapeRows(rows) {
    return Papa.unparse(rows, { quotes: false, newline: "\r\n" });
  }

  function filenameBase(name) {
    return String(name || "export").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "export";
  }

  function tableToReviewRows(table) {
    const headers = table.headers && table.headers.length ? table.headers : inferHeaders(table.rows);
    const rows = [["source_file", "page"].concat(headers).concat(["check_total"])];
    table.rows.forEach((row) => {
      rows.push([table.sourceFile, table.page].concat(row).concat([detectPrintedTotal(row)]));
    });
    return rows;
  }

  function tableToDataRows(table) {
    const headers = table.headers && table.headers.length ? table.headers : inferHeaders(table.rows);
    const rows = [["source_file", "page", "table_id", "row_label", "column", "value"]];
    table.rows.forEach((row) => {
      const rowLabel = row[0] || "";
      row.slice(1).forEach((cell, index) => {
        rows.push([
          table.sourceFile,
          table.page,
          table.tableId,
          rowLabel,
          headers[index + 1] || `column_${index + 1}`,
          normaliseNumber(cell)
        ]);
      });
    });
    return rows;
  }

  function tablesToCsvFiles(sourceFile, tables) {
    const selected = tables.filter((table) => table.selected !== false);
    const dataRows = [["source_file", "page", "table_id", "row_label", "column", "value"]];
    const reviewRows = [];

    selected.forEach((table, index) => {
      table.tableId = table.tableId || index + 1;
      const data = tableToDataRows(table).slice(1);
      dataRows.push(...data);

      if (reviewRows.length) reviewRows.push([]);
      reviewRows.push([`table_id: ${table.tableId}`, `page: ${table.page}`]);
      reviewRows.push(...tableToReviewRows(table));
    });

    const base = filenameBase(sourceFile);
    return {
      dataName: `${base}_data.csv`,
      reviewName: `${base}_review.csv`,
      dataCsv: csvEscapeRows(dataRows),
      reviewCsv: csvEscapeRows(reviewRows)
    };
  }

  function inferHeaders(rows) {
    const width = Math.max(0, ...rows.map((row) => row.length));
    return Array.from({ length: width }, (_, index) => (index === 0 ? "row_label" : `column_${index}`));
  }

  function detectPrintedTotal(row) {
    const label = String(row[0] || "").toLowerCase();
    return /\btotal\b|\bsubtotal\b|\bnet\b/.test(label) ? "printed_total" : "";
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type: type || "text/csv;charset=utf-8" });
    saveAs(blob, filename);
  }

  window.CsvTools = {
    normaliseNumber,
    csvEscapeRows,
    filenameBase,
    tableToReviewRows,
    tableToDataRows,
    tablesToCsvFiles,
    downloadText
  };
})();
