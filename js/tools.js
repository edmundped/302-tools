(function () {
  function textLines(value) {
    return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  function parseCsv(text) {
    const parsed = Papa.parse(text, { skipEmptyLines: true });
    return parsed.data;
  }

  function rowsToCsv(rows) {
    return Papa.unparse(rows, { newline: "\r\n" });
  }

  function mergeCsvFiles(files) {
    return Promise.all(Array.from(files).map((file) => file.text())).then((texts) => {
      const merged = [];
      let canonicalHeader = null;
      const warnings = [];

      texts.forEach((text, index) => {
        const rows = parseCsv(text);
        if (!rows.length) return;
        const header = rows[0].join("|");
        if (!canonicalHeader) {
          canonicalHeader = header;
          merged.push(rows[0]);
        } else if (header !== canonicalHeader) {
          warnings.push(`Header mismatch in file ${index + 1}`);
        }
        merged.push(...rows.slice(1));
      });

      return { csv: rowsToCsv(merged), warnings };
    });
  }

  function mapHeaders(csvText, mapText) {
    const rows = parseCsv(csvText);
    const map = {};
    textLines(mapText).forEach((line) => {
      const [messy, canonical] = line.split("=").map((part) => part && part.trim());
      if (messy && canonical) map[messy.toLowerCase()] = canonical;
    });
    if (!rows.length) return "";
    rows[0] = rows[0].map((header) => map[String(header).toLowerCase()] || header);
    return rowsToCsv(rows);
  }

  function stampCsv(csvText, source, page) {
    const rows = parseCsv(csvText);
    if (!rows.length) return "";
    const today = new Date().toISOString().slice(0, 10);
    rows[0] = ["source", "page", "date_pulled"].concat(rows[0]);
    for (let index = 1; index < rows.length; index += 1) {
      rows[index] = [source, page, today].concat(rows[index]);
    }
    return rowsToCsv(rows);
  }

  function validateSchema(csvText, requiredText) {
    const rows = parseCsv(csvText);
    if (!rows.length) return "No CSV rows found.";
    const headers = rows[0].map((header) => String(header).trim().toLowerCase());
    const required = requiredText.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    const missing = required.filter((column) => !headers.includes(column));
    return missing.length
      ? `Missing required columns: ${missing.join(", ")}`
      : `Schema valid. ${rows.length - 1} data rows checked.`;
  }

  window.UtilityTools = {
    textLines,
    mergeCsvFiles,
    mapHeaders,
    stampCsv,
    validateSchema
  };
})();
