(function () {
  const state = {
    files: [],
    scrapeTables: []
  };

  const $ = (selector) => document.querySelector(selector);

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button, .tab-panel").forEach((node) => node.classList.remove("is-active"));
      button.classList.add("is-active");
      $(`#${button.dataset.tab}`).classList.add("is-active");
    });
  });

  const dropZone = $("#dropZone");
  const pdfInput = $("#pdfInput");
  dropZone.addEventListener("click", () => pdfInput.click());
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    handlePdfFiles(event.dataTransfer.files);
  });
  pdfInput.addEventListener("change", () => handlePdfFiles(pdfInput.files));

  $("#clearExtract").addEventListener("click", () => {
    state.files = [];
    pdfInput.value = "";
    $("#fileResults").innerHTML = "";
    $("#extractStatus").textContent = "";
    $("#downloadZip").disabled = true;
  });

  $("#downloadZip").addEventListener("click", async () => {
    const zip = new JSZip();
    syncEditedTables();
    state.files.forEach((fileResult) => {
      const csvs = CsvTools.tablesToCsvFiles(fileResult.fileName, fileResult.tables);
      zip.file(csvs.dataName, csvs.dataCsv);
      zip.file(csvs.reviewName, csvs.reviewCsv);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, "302-tools_exports.zip");
  });

  async function handlePdfFiles(fileList) {
    const files = Array.from(fileList).filter((file) => /\.pdf$/i.test(file.name));
    if (!files.length) return;
    $("#extractStatus").textContent = `Reading ${files.length} PDF file${files.length === 1 ? "" : "s"}...`;

    for (const file of files) {
      try {
        const result = await PdfExtract.extractPdfTables(file);
        state.files.push(result);
        renderFileResult(result);
      } catch (error) {
        renderError(file.name, error);
      }
    }

    const tableCount = state.files.reduce((total, file) => total + file.tables.length, 0);
    $("#extractStatus").textContent = `Detected ${tableCount} table${tableCount === 1 ? "" : "s"}. Review selections before download.`;
    $("#downloadZip").disabled = tableCount === 0;
  }

  function renderFileResult(fileResult) {
    const card = document.createElement("article");
    card.className = "file-card";
    card.dataset.fileName = fileResult.fileName;
    card.innerHTML = `
      <h3>${escapeHtml(fileResult.fileName)}</h3>
      <div class="file-meta">
        <span>${fileResult.pageCount} pages</span>
        <span>${fileResult.tables.length} tables detected</span>
        ${fileResult.scannedPages.length ? `<span class="warning">Scanned-like pages: ${fileResult.scannedPages.join(", ")}</span>` : "<span class=\"pill\">Text layer found</span>"}
      </div>
      <div class="result-list"></div>
    `;
    const list = card.querySelector(".result-list");
    fileResult.tables.forEach((table) => list.appendChild(renderTableCard(table, fileResult.fileName)));
    $("#fileResults").appendChild(card);
  }

  function renderTableCard(table, fileName) {
    const template = $("#tablePreviewTemplate").content.cloneNode(true);
    const card = template.querySelector(".table-card");
    const checkbox = template.querySelector("input[type='checkbox']");
    const label = template.querySelector(".check-label span");
    label.textContent = `Table ${table.tableId} on page ${table.page}`;
    card.dataset.sourceFile = fileName;
    card.dataset.tableId = table.tableId;
    checkbox.addEventListener("change", () => {
      table.selected = checkbox.checked;
    });
    template.querySelector(".download-data").addEventListener("click", () => downloadSingleTable(table, "data"));
    template.querySelector(".download-review").addEventListener("click", () => downloadSingleTable(table, "review"));
    template.querySelector(".table-scroll").appendChild(buildEditableTable(table));
    return template;
  }

  function buildEditableTable(table) {
    const htmlTable = document.createElement("table");
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    const headers = table.headers && table.headers.length ? table.headers : inferHeaders(table.rows);
    const headerRow = document.createElement("tr");

    headers.forEach((header, index) => {
      const th = document.createElement("th");
      th.contentEditable = "true";
      th.dataset.headerIndex = index;
      th.textContent = header;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    table.rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      headers.forEach((_, cellIndex) => {
        const td = document.createElement("td");
        td.contentEditable = "true";
        td.dataset.rowIndex = rowIndex;
        td.dataset.cellIndex = cellIndex;
        td.textContent = row[cellIndex] || "";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    htmlTable.append(thead, tbody);
    return htmlTable;
  }

  function syncEditedTables() {
    document.querySelectorAll(".table-card[data-source-file]").forEach((card) => {
      const file = state.files.find((item) => item.fileName === card.dataset.sourceFile);
      const table = file
        ? file.tables.find((item) => String(item.tableId) === card.dataset.tableId)
        : state.scrapeTables.find((item) => String(item.tableId) === card.dataset.tableId && item.sourceFile === card.dataset.sourceFile);
      if (!table) return;
      table.selected = card.querySelector("input[type='checkbox']").checked;
      table.headers = Array.from(card.querySelectorAll("th")).map((th) => th.textContent.trim());
      const rows = Array.from(card.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim())
      );
      table.rows = rows;
    });
  }

  function downloadSingleTable(table, type) {
    syncEditedTables();
    const base = `${CsvTools.filenameBase(table.sourceFile)}_table_${table.tableId}`;
    if (type === "data") {
      CsvTools.downloadText(`${base}_data.csv`, CsvTools.csvEscapeRows(CsvTools.tableToDataRows(table)));
    } else {
      CsvTools.downloadText(`${base}_review.csv`, CsvTools.csvEscapeRows(CsvTools.tableToReviewRows(table)));
    }
  }

  $("#discoverSite").addEventListener("click", async () => {
    const target = $("#scrapeUrl").value.trim();
    const proxy = $("#proxyUrl").value.trim();
    if (!target || !proxy) {
      $("#scrapeStatus").textContent = "Add both a target URL and your Cloudflare Worker proxy URL.";
      return;
    }

    $("#scrapeStatus").textContent = "Fetching through proxy and parsing links and tables...";
    $("#scrapeResults").innerHTML = "";
    try {
      const result = await Scraper.discoverSite(target, proxy);
      state.scrapeTables = result.tables;
      renderScrapeResults(result, proxy);
      $("#scrapeStatus").textContent = `Found ${result.pdfs.length} PDFs and ${result.tables.length} HTML tables.`;
    } catch (error) {
      $("#scrapeStatus").textContent = error.message;
    }
  });

  function renderScrapeResults(result, proxy) {
    const pdfPanel = document.createElement("article");
    pdfPanel.className = "result-panel";
    pdfPanel.innerHTML = `<h3>PDF links</h3>`;
    if (!result.pdfs.length) {
      pdfPanel.insertAdjacentHTML("beforeend", "<p>No direct PDF links found in the fetched HTML.</p>");
    } else {
      const list = document.createElement("div");
      list.className = "result-list";
      result.pdfs.forEach((pdf) => {
        const row = document.createElement("div");
        row.className = "action-row";
        row.innerHTML = `<span>${escapeHtml(pdf.label)}</span><button class="secondary-button small" type="button">Download</button>`;
        row.querySelector("button").addEventListener("click", async () => {
          const blob = await Scraper.downloadPdfViaProxy(proxy, pdf.url);
          saveAs(blob, pdf.filename);
        });
        list.appendChild(row);
      });
      pdfPanel.appendChild(list);
    }

    const tablePanel = document.createElement("article");
    tablePanel.className = "result-panel";
    tablePanel.innerHTML = `<h3>HTML tables</h3>`;
    result.tables.forEach((table) => tablePanel.appendChild(renderTableCard(table, table.sourceFile)));
    if (result.tables.length) {
      const download = document.createElement("button");
      download.className = "primary-button";
      download.type = "button";
      download.textContent = "Download selected table CSVs";
      download.addEventListener("click", () => {
        syncEditedTables();
        const csvs = CsvTools.tablesToCsvFiles("site_tables", result.tables);
        CsvTools.downloadText(csvs.dataName, csvs.dataCsv);
        CsvTools.downloadText(csvs.reviewName, csvs.reviewCsv);
      });
      tablePanel.prepend(download);
    } else {
      tablePanel.insertAdjacentHTML("beforeend", "<p>No static HTML tables found. JavaScript-rendered sites may need manual export.</p>");
    }

    $("#scrapeResults").append(pdfPanel, tablePanel);
  }

  function wireTools() {
    $("#cleanNumbers").addEventListener("click", () => {
      $("#numberOutput").textContent = UtilityTools.textLines($("#numberInput").value).map(CsvTools.normaliseNumber).join("\n");
    });
    $("#runFootCheck").addEventListener("click", () => {
      const values = UtilityTools.textLines($("#footValues").value).map(CsvTools.normaliseNumber).map(Number).filter((value) => !Number.isNaN(value));
      const sum = values.reduce((total, value) => total + value, 0);
      const expected = Number(CsvTools.normaliseNumber($("#footTotal").value));
      const delta = sum - expected;
      $("#footOutput").textContent = `Rows: ${values.length}\nSum: ${sum}\nExpected: ${expected}\nDelta: ${Number.isNaN(expected) ? "n/a" : delta}`;
    });
    $("#normaliseUnits").addEventListener("click", () => {
      const scale = Number($("#unitScale").value);
      const decimals = Number($("#unitDecimals").value);
      $("#unitOutput").textContent = UtilityTools.textLines($("#unitValues").value)
        .map(CsvTools.normaliseNumber)
        .map(Number)
        .map((value) => Number.isNaN(value) ? "" : (value * scale).toFixed(decimals))
        .join("\n");
    });
    $("#mergeCsvs").addEventListener("click", async () => {
      const result = await UtilityTools.mergeCsvFiles($("#mergeInput").files);
      CsvTools.downloadText("merged.csv", result.csv);
      $("#mergeOutput").textContent = result.warnings.length ? result.warnings.join("\n") : "Merged CSV downloaded.";
    });
    $("#csvToXlsx").addEventListener("click", async () => {
      const workbook = XLSX.utils.book_new();
      for (const file of Array.from($("#xlsxInput").files)) {
        const rows = Papa.parse(await file.text(), { skipEmptyLines: true }).data;
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, CsvTools.filenameBase(file.name).slice(0, 31));
      }
      XLSX.writeFile(workbook, "302-tools_workbook.xlsx");
      $("#xlsxOutput").textContent = "Workbook downloaded.";
    });
    $("#mapHeaders").addEventListener("click", () => {
      $("#headerOutput").textContent = UtilityTools.mapHeaders($("#headerInput").value, $("#headerMap").value);
    });
    $("#stampCsv").addEventListener("click", () => {
      $("#stampOutput").textContent = UtilityTools.stampCsv($("#stampInput").value, $("#stampSource").value, $("#stampPage").value);
    });
    $("#validateSchema").addEventListener("click", () => {
      $("#schemaOutput").textContent = UtilityTools.validateSchema($("#schemaCsv").value, $("#schemaRequired").value);
    });
  }

  function inferHeaders(rows) {
    const width = Math.max(0, ...rows.map((row) => row.length));
    return Array.from({ length: width }, (_, index) => (index === 0 ? "row_label" : `column_${index}`));
  }

  function renderError(fileName, error) {
    const card = document.createElement("article");
    card.className = "file-card";
    card.innerHTML = `<h3>${escapeHtml(fileName)}</h3><p class="danger">${escapeHtml(error.message)}</p>`;
    $("#fileResults").appendChild(card);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[character]));
  }

  wireTools();
})();
