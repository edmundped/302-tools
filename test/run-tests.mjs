/**
 * test/run-tests.mjs — correctness harness for the pure extraction core.
 *
 *   node test/run-tests.mjs
 *
 * No framework, no dependencies. Every assertion targets a defect named in
 * docs/AUDIT.md, so a regression here means a bug the first build shipped.
 *
 * Fixtures carry real word geometry (pdftotext -bbox, top-down y — the same
 * convention ingest/pdf-text.js produces), so these tests exercise the actual
 * column-inference maths rather than a mock.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseNumber } from '../js/core/numbers.js';
import { buildPageTables } from '../js/extract/tables.js';
import { stripBoilerplate } from '../js/extract/boilerplate.js';
import { parseNoteHeading, detectUnits } from '../js/extract/financial.js';
import { unparse, parse, computeCheckTotals, machineRows } from '../js/core/csv.js';
import { validateTable } from '../js/core/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(HERE, 'fixtures', n), 'utf8'));

let passed = 0;
const failures = [];
let group = '';

const describe = (name) => {
  group = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
};

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } catch (err) {
    failures.push({ group, label, message: err.message });
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}\n       ${err.message}`);
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}expected ${e}, got ${a}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

/* ------------------------------------------------------------------ */
describe('numbers — parseNumber');

const num = (s) => parseNumber(s).value;

check('thousands separators', () => eq(num('12,442,697'), 12442697));
check('parentheses mean negative', () => eq(num('(1,234)'), -1234));
check('trailing minus', () => eq(num('1234-'), -1234));
check('unicode minus', () => eq(num('−1234'), -1234));
check('percent becomes a fraction', () => eq(num('12.3%'), 0.123));
check('currency symbols stripped', () => eq(num('GH¢ 5,000'), 5000));
check('currency codes stripped', () => eq(num('GHS 5,000'), 5000));
check('dash means NOT APPLICABLE, never zero', () => {
  for (const dash of ['-', '–', '—']) {
    const r = parseNumber(dash);
    ok(r.value === null, `"${dash}" should parse to null, got ${r.value}`);
    eq(r.clean, '', `"${dash}" clean: `);
  }
});
check('footnote marker stripped, value kept', () => {
  const r = parseNumber('1,234²');
  eq(r.value, 1234);
});
check('plain text stays non-numeric', () => {
  const r = parseNumber('Cash and cash equivalents');
  ok(r.value === null, 'label should not parse as a number');
});
check('space as a thousands separator', () => eq(num('12 442 697'), 12442697));
check('zero is preserved, not treated as empty', () => {
  const r = parseNumber('0');
  eq(r.value, 0);
  eq(r.clean, '0');
});

/* ------------------------------------------------------------------ */
describe('geometry — right-aligned financial columns (AUDIT defect 1)');

const fin = fixture('sample_financial_textlayer.json');
const built = buildPageTables({
  words: fin.pages.page1,
  page: 1,
  docId: 'test',
  sourceFile: 'sample_financial_textlayer.pdf',
  origin: 'pdf-text'
});

check('a table is found on the statement page', () => ok(built.tables.length >= 1, `found ${built.tables.length}`));

const t = built.tables[0] || { rows: [], headers: [], columnCount: 0 };

check('four columns recovered (label, Note, 2011, 2010)', () => eq(t.columnCount, 4));

check('rectangularity invariant holds', () => {
  validateTable(t);
  t.rows.forEach((r, i) => eq(r.length, t.columnCount, `row ${i}: `));
});

check('all-numeric header row IS detected (AUDIT defect 4)', () => {
  const flat = t.headers.flat().join(' ');
  ok(/2011/.test(flat) && /2010/.test(flat), `headers were ${JSON.stringify(t.headers)}`);
});

const findRow = (needle) => t.rows.find((r) => r[0] && r[0].toLowerCase().includes(needle));

check('right-aligned figures land in the right columns', () => {
  const cash = findRow('cash and cash equivalents');
  ok(cash, 'cash row not found');
  // 12,442,697 and 10,110,425 differ in width by 2 glyphs — the exact case
  // left-edge clustering shattered in v1.
  eq(parseNumber(cash[2]).value, 12442697, '2011 column: ');
  eq(parseNumber(cash[3]).value, 10110425, '2010 column: ');
});

check('short and long numbers share a column', () => {
  const intangible = findRow('intangible');
  ok(intangible, 'intangible row not found');
  eq(parseNumber(intangible[2]).value, 8210, '2011: ');
  eq(parseNumber(intangible[3]).value, 9004, '2010: ');
});

check('a dash cell stays empty, it does not become 0', () => {
  const inv = findRow('investments');
  ok(inv, 'investments row not found');
  eq(parseNumber(inv[2]).value, null, 'dash cell: ');
  eq(parseNumber(inv[3]).value, 1250, '2010: ');
});

check('bracketed negative survives extraction', () => {
  const ret = findRow('retained earnings');
  ok(ret, 'retained earnings row not found');
  eq(parseNumber(ret[2]).value, -1204);
});

check('note-reference column is not merged into the label', () => {
  const ppe = findRow('property, plant');
  ok(ppe, 'PPE row not found');
  eq(ppe[1].trim(), '12', 'note column: ');
});

check('label column keeps whole labels intact', () => {
  const rec = findRow('trade and other receivables');
  ok(rec, 'receivables row not found');
  ok(/trade and other receivables/i.test(rec[0]), `got "${rec[0]}"`);
});

/* ------------------------------------------------------------------ */
describe('classify — prose must not become a table (AUDIT defect 5)');

const prose = fixture('goil_prose_page.json');
const proseBuilt = buildPageTables({
  words: prose.words,
  page: 43,
  docId: 'test',
  sourceFile: 'goil_2010.pdf',
  origin: 'pdf-text'
});

check('565 words of continuous prose yield no table', () =>
  eq(proseBuilt.tables.length, 0, `got ${proseBuilt.tables.length} table(s): `));

/* ------------------------------------------------------------------ */
describe('boilerplate — scanned page detection (AUDIT headline defect)');

const scanned = fixture('goil_scanned_page.json');
const { pages: strippedPages } = stripBoilerplate(
  [{ number: 20, words: scanned.words }],
  { textLayerMin: 180 }
);

check('download stamp is stripped from the text layer', () => {
  const remaining = strippedPages[0].words.map((w) => w.text).join(' ');
  ok(!/Downloaded:/i.test(remaining), `stamp survived: "${remaining}"`);
});

check('a page carrying only a stamp is flagged needsOcr', () =>
  ok(strippedPages[0].needsOcr === true, `needsOcr was ${strippedPages[0].needsOcr}`));

check('the same page is not claimed to have a text layer', () =>
  ok(strippedPages[0].hasTextLayer === false, `hasTextLayer was ${strippedPages[0].hasTextLayer}`));

/* ------------------------------------------------------------------ */
describe('financial — notes-only extraction');

check('note heading parses to a number and a title', () => {
  const r = parseNoteHeading('15.  Inventories');
  ok(r, 'returned null');
  eq(r.number, '15');
  ok(/inventories/i.test(r.title), `title was "${r.title}"`);
});

check('a plain heading is not mistaken for a note', () =>
  eq(parseNoteHeading('Statement of Financial Position'), null));

check('a sentence starting with a figure is not a note heading', () =>
  eq(parseNoteHeading('2011 was a year of significant growth for the group'), null));

check('units are read from the caption', () =>
  ok(/thousand/i.test(detectUnits('GH¢ thousands') || ''), 'units not detected'));

const notesBuilt = buildPageTables({
  words: fin.pages.page2,
  page: 2,
  docId: 'test',
  sourceFile: 'sample_financial_textlayer.pdf',
  origin: 'pdf-text'
});

check('both note tables on the notes page are found', () =>
  ok(notesBuilt.tables.length >= 2, `found ${notesBuilt.tables.length}`));

/* ------------------------------------------------------------------ */
describe('csv — quoting is never disabled (AUDIT defect 7)');

check('a value containing a comma survives as ONE field', () => {
  const csv = unparse([
    ['source_file', 'row_label', 'v2011'],
    ['H.pdf', 'Cash and cash equivalents', '12,442,697']
  ]);
  const back = parse(csv);
  eq(back[1].length, 3, 'field count: ');
  eq(back[1][2], '12,442,697', 'value: ');
});

check('a label containing a comma survives', () => {
  const back = parse(unparse([['a'], ['Property, plant and equipment']]));
  eq(back[1][0], 'Property, plant and equipment');
});

check('embedded quotes survive', () => {
  const back = parse(unparse([['a'], ['He said "hello"']]));
  eq(back[1][0], 'He said "hello"');
});

const inventoryTable = (total2011) => ({
  columnCount: 3,
  headers: [['label', '2011', '2010']],
  rows: [
    ['Finished goods', '201,455', '180,220'],
    ['Raw materials', '98,663', '84,556'],
    ['Goods in transit', '42,000', '34,000'],
    ['Total inventories', total2011, '298,776']
  ]
});

check('check_total foots a correct total and says so', () => {
  const totals = computeCheckTotals(inventoryTable('342,118'));
  const joined = JSON.stringify(totals);
  ok(!/printed_total/.test(joined), 'still emitting the v1 placeholder string');
  ok(/2011: ok/.test(totals[3]), `expected an ok on the total row, got "${totals[3]}"`);
  eq(totals[0], '', 'non-total rows carry no check: ');
});

check('check_total CATCHES a total that does not foot', () => {
  // 201,455 + 98,663 + 42,000 = 342,118. Printing 350,000 must be flagged.
  const totals = computeCheckTotals(inventoryTable('350,000'));
  ok(/calc 342118 vs printed 350000/.test(totals[3]), `mismatch not reported: "${totals[3]}"`);
});

check('machine rows carry provenance on every row', () => {
  const rows = machineRows([t]);
  ok(rows.length > 1, 'no machine rows produced');
  const header = rows[0].map(String);
  ['source_file', 'page', 'row_label', 'column', 'value'].forEach((col) =>
    ok(header.includes(col), `machine header missing "${col}"`)
  );
});

/* ------------------------------------------------------------------ */
const total = passed + failures.length;
console.log(`\n${'-'.repeat(58)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} of ${total} checks failed\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f.group} → ${f.label}\n      ${f.message}`));
  process.exit(1);
}
console.log(`\x1b[32mall ${total} checks passed\x1b[0m`);
