/**
 * test/tools-check.mjs — pure-logic checks for the tools, the scraper and zip.
 *
 * Run:  node test/tools-check.mjs
 *
 * Covers only functions that are pure: no DOM, no CDN globals, no network.
 * That is deliberate — those are the ones where a silent bug corrupts a grid,
 * which is what happened in v1's merge.
 *
 * Needs Node >= 22.7 (ES module syntax detection in .js files) or a root
 * package.json carrying `"type": "module"`.
 *
 * test/run-tests.mjs belongs to the extraction agent. This file is separate on
 * purpose; do not merge them.
 */
import assert from 'node:assert/strict';

import { rectangularise, normaliseKey, uniqueHeaders, indexOfHeader } from '../js/tools/_shared.js';
import { mergeGrids } from '../js/tools/merge-csv.js';
import { joinGrids } from '../js/tools/join-csv.js';
import { dedupeGrid, resolveKeyColumns } from '../js/tools/dedupe-rows.js';
import { transposeGrid, transposeWithHeader } from '../js/tools/transpose.js';
import { wideToLong, longToWide, resolveCols } from '../js/tools/reshape.js';
import { trimGrid, cleanCell, toSnake } from '../js/tools/trim-whitespace.js';
import { parseSpec, validateRows, looksLikeDate } from '../js/tools/schema-check.js';
import { applyScale, resolveColumns } from '../js/tools/number-clean.js';
import { safeSheetName, buildIndexRows } from '../js/tools/csv-excel.js';
import { stampGrid } from '../js/tools/provenance.js';
import { parseMap, applyMap, similarity, suggestMapping } from '../js/tools/header-map.js';
import { getGroups, getTools, GROUPS } from '../js/tools/index.js';

import {
  sniffKind,
  formatBytes,
  buildProxyUrl,
  parseRobots,
  isAllowed,
  filenameFromUrl,
  createLimiter
} from '../js/scraper/fetchers.js';
import {
  expandGrid,
  collectCandidates,
  looksLikeIndexLink,
  worthSniffing,
  groupByKind
} from '../js/scraper/discover.js';

import { buildManifestRows, kindFromName, uniqueEntryNames, contentSize } from '../js/core/zip.js';

/* ------------------------------------------------------------------ */
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, err });
  }
}

/* ------------------------------------------------------------------ *
 * Shared grid helpers
 * ------------------------------------------------------------------ */

check('rectangularise pads short rows and stringifies', () => {
  assert.deepEqual(rectangularise([['a', 'b', 'c'], ['1'], []]), [
    ['a', 'b', 'c'],
    ['1', '', ''],
    ['', '', '']
  ]);
});

check('normaliseKey collapses case, punctuation and NBSP', () => {
  assert.equal(normaliseKey('Acct. Code'), 'acct code');
  assert.equal(normaliseKey('Total Assets'), 'total assets');
  assert.equal(normaliseKey('  AMOUNT (GH¢000) '), 'amount gh 000');
});

check('uniqueHeaders suffixes repeats and names blanks', () => {
  // case is preserved on the renamed duplicate — 'A' stays 'A_3', not 'a_3'
  assert.deepEqual(uniqueHeaders(['a', 'a', '', 'A']), ['a', 'a_2', 'column_3', 'A_3']);
});

check('indexOfHeader matches exactly first, then loosely', () => {
  const header = ['Acct. Code', 'Amount'];
  assert.equal(indexOfHeader(header, 'Acct. Code'), 0);
  assert.equal(indexOfHeader(header, 'acct code'), 0);
  assert.equal(indexOfHeader(header, 'missing'), -1);
});

/* ------------------------------------------------------------------ *
 * merge  — the v1 corruption bug
 * ------------------------------------------------------------------ */

check('mergeGrids unions mismatched headers instead of appending blindly', () => {
  const result = mergeGrids(
    [
      { name: 'a.csv', grid: [['a', 'b'], ['1', '2']] },
      { name: 'b.csv', grid: [['b', 'c'], ['3', '4']] }
    ],
    { addSourceColumn: true }
  );
  assert.deepEqual(result.rows[0], ['source_file', 'a', 'b', 'c']);
  assert.deepEqual(result.rows[1], ['a.csv', '1', '2', '']);
  // The critical assertion: b.csv's "3" must land under b, not under a.
  assert.deepEqual(result.rows[2], ['b.csv', '', '3', '4']);
});

check('mergeGrids reports which columns each file was missing', () => {
  const result = mergeGrids([
    { name: 'a.csv', grid: [['a', 'b'], ['1', '2']] },
    { name: 'b.csv', grid: [['b', 'c'], ['3', '4']] }
  ]);
  assert.deepEqual(result.report[0].missing, ['c']);
  assert.deepEqual(result.report[1].missing, ['a']);
});

check('mergeGrids treats case/punctuation variants as one column, and says so', () => {
  const result = mergeGrids(
    [
      { name: 'a.csv', grid: [['Total Assets'], ['1']] },
      { name: 'b.csv', grid: [['total assets'], ['2']] }
    ],
    { addSourceColumn: false }
  );
  assert.deepEqual(result.rows, [['Total Assets'], ['1'], ['2']]);
  assert.ok(result.changes.some((line) => line.includes('same column')));
});

check('mergeGrids exact mode keeps near-identical headers apart', () => {
  const result = mergeGrids(
    [
      { name: 'a.csv', grid: [['Total Assets'], ['1']] },
      { name: 'b.csv', grid: [['total assets'], ['2']] }
    ],
    { addSourceColumn: false, matchBy: 'exact' }
  );
  assert.deepEqual(result.rows[0], ['Total Assets', 'total assets']);
});

check('mergeGrids output is rectangular', () => {
  const result = mergeGrids([
    { name: 'a.csv', grid: [['a', 'b', 'c'], ['1']] },
    { name: 'b.csv', grid: [['d'], ['9']] }
  ]);
  const width = result.rows[0].length;
  result.rows.forEach((row) => assert.equal(row.length, width));
});

/* ------------------------------------------------------------------ *
 * join
 * ------------------------------------------------------------------ */

const LEFT = { name: 'l', grid: [['code', 'name'], ['A', 'Alpha'], ['B', 'Beta'], ['C', 'Gamma']] };
const RIGHT = { name: 'r', grid: [['code', 'amount'], ['A', '10'], ['B', '20'], ['D', '40']] };

check('joinGrids left join keeps unmatched left rows with blanks', () => {
  const result = joinGrids(LEFT, RIGHT, { leftKey: 'code', rightKey: 'code', type: 'left' });
  assert.deepEqual(result.rows[0], ['code', 'name', 'amount']);
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows[3], ['C', 'Gamma', '']);
  assert.equal(result.stats.matched, 2);
  assert.equal(result.stats.leftOnly, 1);
});

check('joinGrids inner join drops unmatched and warns about it', () => {
  const result = joinGrids(LEFT, RIGHT, { leftKey: 'code', rightKey: 'code', type: 'inner' });
  assert.equal(result.rows.length, 3);
  assert.ok(result.warnings.some((w) => w.includes('dropped')));
});

check('joinGrids full join adds right-only rows', () => {
  const result = joinGrids(LEFT, RIGHT, { leftKey: 'code', rightKey: 'code', type: 'full' });
  assert.equal(result.rows.length, 5);
  assert.deepEqual(result.rows[4], ['D', '', '40']);
});

check('joinGrids detects and reports many-to-many fan-out', () => {
  const dupes = { name: 'r', grid: [['code', 'amount'], ['A', '10'], ['A', '11']] };
  const result = joinGrids(LEFT, dupes, { leftKey: 'code', rightKey: 'code', type: 'left' });
  assert.equal(result.stats.fanout, 1);
  assert.equal(result.stats.dupKeysRight, 1);
  assert.ok(result.warnings.some((w) => w.includes('double-count')));
});

check('joinGrids renames colliding right columns rather than overwriting', () => {
  const right = { name: 'r', grid: [['code', 'name'], ['A', 'other']] };
  const result = joinGrids(LEFT, right, { leftKey: 'code', rightKey: 'code', type: 'left' });
  assert.deepEqual(result.rows[0], ['code', 'name', 'name_right']);
});

check('joinGrids rejects an unknown key column', () => {
  assert.throws(() => joinGrids(LEFT, RIGHT, { leftKey: 'nope', rightKey: 'code' }), /Left key column/);
});

/* ------------------------------------------------------------------ *
 * dedupe
 * ------------------------------------------------------------------ */

const DUPES = [
  ['code', 'amount'],
  ['A', '1'],
  ['a', '1'],
  ['B', '2'],
  ['A', '9']
];

check('dedupeGrid removes whole-row duplicates, case-insensitively', () => {
  const result = dedupeGrid(DUPES, { ignoreCase: true, mode: 'remove', keep: 'first' });
  assert.equal(result.rows.length, 4);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].index, 2);
});

check('dedupeGrid keeps case differences when asked to', () => {
  const result = dedupeGrid(DUPES, { ignoreCase: false, mode: 'remove' });
  assert.equal(result.rows.length, 5);
});

check('dedupeGrid on a key column collapses rows that differ elsewhere', () => {
  const result = dedupeGrid(DUPES, { keyColumns: [0], ignoreCase: true, mode: 'remove' });
  assert.equal(result.rows.length, 3); // header + A + B
  assert.equal(result.removed.length, 2);
});

check('dedupeGrid keep=last picks the later row', () => {
  const result = dedupeGrid(DUPES, { keyColumns: [0], ignoreCase: true, mode: 'remove', keep: 'last' });
  assert.deepEqual(result.rows[1], ['B', '2']);
  assert.deepEqual(result.rows[2], ['A', '9']);
});

check('dedupeGrid flag mode removes nothing and adds a pointer column', () => {
  const result = dedupeGrid(DUPES, { ignoreCase: true, mode: 'flag' });
  assert.equal(result.rows.length, 5);
  assert.deepEqual(result.rows[0], ['code', 'amount', 'duplicate_of_row']);
  assert.equal(result.rows[2][2], '1');
  assert.equal(result.rows[1][2], '');
});

check('resolveKeyColumns accepts names and 1-based numbers', () => {
  assert.deepEqual(resolveKeyColumns(['code', 'amount'], 'code'), [0]);
  assert.deepEqual(resolveKeyColumns(['code', 'amount'], '2'), [1]);
  assert.equal(resolveKeyColumns(['code'], ''), null);
});

/* ------------------------------------------------------------------ *
 * transpose
 * ------------------------------------------------------------------ */

const WIDE = [
  ['line', '2011', '2010'],
  ['Revenue', '100', '90'],
  ['Cost', '50', '45']
];

check('transposeGrid flips the matrix', () => {
  assert.deepEqual(transposeGrid(WIDE), [
    ['line', 'Revenue', 'Cost'],
    ['2011', '100', '50'],
    ['2010', '90', '45']
  ]);
});

check('transposeGrid is its own inverse', () => {
  assert.deepEqual(transposeGrid(transposeGrid(WIDE)), WIDE);
});

check('transposeGrid rectangularises ragged input', () => {
  const out = transposeGrid([['a', 'b'], ['1']]);
  assert.deepEqual(out, [['a', '1'], ['b', '']]);
});

check('transposeWithHeader promotes the first column and names the corner', () => {
  const out = transposeWithHeader(WIDE, 'period');
  assert.deepEqual(out[0], ['period', 'Revenue', 'Cost']);
  assert.deepEqual(out[1], ['2011', '100', '50']);
});

check('transposeWithHeader keeps repeated labels distinct', () => {
  const out = transposeWithHeader([['line', 'x'], ['Total', '1'], ['Total', '2']], 'field');
  assert.deepEqual(out[0], ['field', 'Total', 'Total_2']);
});

/* ------------------------------------------------------------------ *
 * reshape
 * ------------------------------------------------------------------ */

check('wideToLong melts the period columns', () => {
  const result = wideToLong(WIDE, { idColumns: [0], variableName: 'period', valueName: 'value' });
  assert.deepEqual(result.rows[0], ['line', 'period', 'value']);
  assert.equal(result.rows.length, 5);
  assert.deepEqual(result.rows[1], ['Revenue', '2011', '100']);
  assert.deepEqual(result.rows[4], ['Cost', '2010', '45']);
});

check('wideToLong drops or keeps empty values as asked', () => {
  const grid = [['line', '2011'], ['Revenue', ''], ['Cost', '5']];
  assert.equal(wideToLong(grid, { idColumns: [0], dropEmpty: true }).rows.length, 2);
  assert.equal(wideToLong(grid, { idColumns: [0], dropEmpty: false }).rows.length, 3);
});

check('longToWide is the inverse of wideToLong', () => {
  const long = wideToLong(WIDE, { idColumns: [0], variableName: 'period', valueName: 'value' }).rows;
  const wide = longToWide(long, { idColumns: [0], variableColumn: 1, valueColumn: 2 });
  assert.deepEqual(wide.rows, WIDE);
  assert.equal(wide.collisions.length, 0);
});

check('longToWide reports clashes instead of silently overwriting', () => {
  const long = [
    ['line', 'period', 'value'],
    ['Revenue', '2011', '100'],
    ['Revenue', '2011', '101']
  ];
  const first = longToWide(long, { idColumns: [0], variableColumn: 1, valueColumn: 2, aggregate: 'first' });
  assert.equal(first.rows[1][1], '100');
  assert.equal(first.collisions.length, 1);
  assert.equal(first.collisions[0].discarded, '101');

  const last = longToWide(long, { idColumns: [0], variableColumn: 1, valueColumn: 2, aggregate: 'last' });
  assert.equal(last.rows[1][1], '101');
});

check('longToWide output is rectangular with sparse input', () => {
  const long = [
    ['line', 'period', 'value'],
    ['Revenue', '2011', '100'],
    ['Cost', '2010', '45']
  ];
  const wide = longToWide(long, { idColumns: [0], variableColumn: 1, valueColumn: 2 });
  assert.deepEqual(wide.rows, [
    ['line', '2011', '2010'],
    ['Revenue', '100', ''],
    ['Cost', '', '45']
  ]);
});

check('resolveCols accepts names and numbers', () => {
  assert.deepEqual(resolveCols(['line', '2011', '2010'], '2011, 3'), [1, 2]);
  assert.deepEqual(resolveCols(['line'], ''), []);
});

/* ------------------------------------------------------------------ *
 * trim
 * ------------------------------------------------------------------ */

check('cleanCell strips NBSP, zero-width and soft hyphens', () => {
  assert.equal(cleanCell('Total Assets'), 'Total Assets');
  assert.equal(cleanCell('Re​venue'), 'Revenue');
  assert.equal(cleanCell('soft­hyphen'), 'softhyphen');
  assert.equal(cleanCell('  spaced   out  '), 'spaced out');
});

check('trimGrid records every cell it changed', () => {
  const result = trimGrid([['a ', 'b'], [' 1', '2']]);
  assert.deepEqual(result.rows, [['a', 'b'], ['1', '2']]);
  assert.equal(result.changed.size, 2);
  assert.ok(result.changed.has('0,0'));
  assert.ok(result.changed.has('1,0'));
});

check('trimGrid drops empty rows but never the header', () => {
  const result = trimGrid([['a', 'b'], ['', ''], ['1', '2']], { dropEmptyRows: true });
  assert.equal(result.rows.length, 2);
  assert.equal(result.removedRows, 1);
});

check('trimGrid drops empty columns only when asked', () => {
  const grid = [['a', '', 'c'], ['1', '', '3']];
  assert.equal(trimGrid(grid, { dropEmptyCols: false }).rows[0].length, 3);
  assert.equal(trimGrid(grid, { dropEmptyCols: true }).rows[0].length, 2);
});

check('toSnake produces stable column names', () => {
  assert.equal(toSnake('Acct. Code'), 'acct_code');
  assert.equal(toSnake('Amount (GH¢000)'), 'amount_gh_000');
  assert.equal(toSnake('totalAssets'), 'total_assets');
});

/* ------------------------------------------------------------------ *
 * schema check  — the tool v1 faked
 * ------------------------------------------------------------------ */

const stubParseNumber = (raw) => {
  const text = String(raw).replace(/[, ]/g, '').trim();
  if (!text) return { value: null };
  const value = Number(text);
  return { value: Number.isNaN(value) ? null : value };
};

check('parseSpec reads types, flags and settings', () => {
  const { rules, warnings } = parseSpec(
    'code: text, required, unique\namount: number, required, min=0, max=100\nsegment: enum=up|down'
  );
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], { column: 'code', type: 'text', required: true, unique: true });
  assert.equal(rules[1].min, 0);
  assert.equal(rules[1].max, 100);
  assert.deepEqual(rules[2].enum, ['up', 'down']);
  assert.equal(warnings.length, 0);
});

check('parseSpec warns rather than throwing on a malformed line', () => {
  const { rules, warnings } = parseSpec('this line has no colon');
  assert.equal(rules.length, 0);
  assert.equal(warnings.length, 1);
});

check('validateRows checks every data row, not just the header', () => {
  const grid = [
    ['code', 'amount', 'period', 'segment'],
    ['A1', '100', '2011-12-31', 'upstream'],
    ['', 'abc', '31/13/2011', 'sideways'],
    ['A1', '5', '2011-12-31', 'upstream']
  ];
  const { rules } = parseSpec(
    'code: text, required, unique\namount: number, required, min=0\nperiod: date\nsegment: enum=upstream|downstream'
  );
  const result = validateRows(grid, rules, { parseNumber: stubParseNumber });

  assert.equal(result.stats.rowsChecked, 3);
  assert.equal(result.stats.rulesApplied, 4);
  assert.equal(result.stats.issueCount, 5);
  assert.deepEqual([...result.badRows].sort(), [3, 4]);

  const row3 = result.issues.filter((issue) => issue.row === 3).map((issue) => issue.column).sort();
  assert.deepEqual(row3, ['amount', 'code', 'period', 'segment']);
  assert.ok(result.issues.some((issue) => issue.row === 4 && /duplicate value/.test(issue.message)));
});

check('validateRows flags min/max and pattern breaches with the row number', () => {
  const grid = [['amount', 'note_ref'], ['-5', '12'], ['10', 'abc']];
  const { rules } = parseSpec('amount: number, min=0\nnote_ref: text, pattern=^\\d{1,2}$');
  const result = validateRows(grid, rules, { parseNumber: stubParseNumber });
  assert.equal(result.stats.issueCount, 2);
  assert.ok(result.issues.some((i) => i.row === 2 && /below min/.test(i.message)));
  assert.ok(result.issues.some((i) => i.row === 3 && /does not match/.test(i.message)));
});

check('validateRows names declared columns that the CSV does not have', () => {
  const { rules } = parseSpec('missing_col: text, required');
  const result = validateRows([['a'], ['1']], rules, { parseNumber: stubParseNumber });
  assert.deepEqual(result.missingColumns, ['missing_col']);
  assert.equal(result.stats.issueCount, 0);
});

check('looksLikeDate accepts real dates and rejects impossible ones', () => {
  assert.equal(looksLikeDate('2011-12-31'), true);
  assert.equal(looksLikeDate('31/12/2011'), true);
  assert.equal(looksLikeDate('31/13/2011'), false);
  assert.equal(looksLikeDate('Q4'), false);
});

/* ------------------------------------------------------------------ *
 * number cleaner helpers (the parser itself lives in core/numbers.js)
 * ------------------------------------------------------------------ */

check('applyScale scales and rounds without float dust', () => {
  assert.equal(applyScale(1.234, 1000, ''), '1234');
  assert.equal(applyScale(12442697, 0.001, 2), '12442.70');
  assert.equal(applyScale(null, 1000, ''), '');
  assert.equal(applyScale(0.1 + 0.2, 1, ''), '0.3');
});

check('resolveColumns returns null for "decide per cell"', () => {
  assert.equal(resolveColumns(['a', 'b'], ''), null);
  assert.deepEqual(resolveColumns(['2011', '2010'], '2011'), [0]);
});

/* ------------------------------------------------------------------ *
 * csv <-> excel helpers
 * ------------------------------------------------------------------ */

check('safeSheetName respects Excel limits and stays unique', () => {
  const taken = new Set();
  assert.equal(safeSheetName('Fan Milk PLc', taken), 'Fan Milk PLc');
  assert.equal(safeSheetName('Fan Milk PLc', taken), 'Fan Milk PLc_2');
  assert.equal(safeSheetName('a/b:c*d?e[f]g', taken), 'a_b_c_d_e_f_g');
  const long = safeSheetName('x'.repeat(50), taken);
  assert.equal(long.length, 31);
});

check('buildIndexRows carries every sheet', () => {
  const rows = buildIndexRows([{ sheet: 's1', source: 'a.csv', rows: 3, columns: 2, notes: '' }]);
  assert.deepEqual(rows[0], ['sheet', 'source', 'rows', 'columns', 'notes']);
  assert.deepEqual(rows[1], ['s1', 'a.csv', '3', '2', '']);
});

/* ------------------------------------------------------------------ *
 * provenance
 * ------------------------------------------------------------------ */

check('stampGrid prepends the provenance columns', () => {
  const result = stampGrid([['a'], ['1']], [
    { name: 'source', value: 'goil.pdf' },
    { name: 'page', value: '32' }
  ]);
  assert.deepEqual(result.rows[0], ['source', 'page', 'a']);
  assert.deepEqual(result.rows[1], ['goil.pdf', '32', '1']);
  assert.deepEqual(result.added, ['source', 'page']);
});

check('stampGrid does not create a second source column on a re-stamp', () => {
  const once = stampGrid([['a'], ['1']], [{ name: 'source', value: 'x' }]);
  const twice = stampGrid(once.rows, [{ name: 'source', value: 'y' }]);
  assert.deepEqual(twice.rows[0], ['source', 'a']);
  assert.deepEqual(twice.skipped, ['source']);
  assert.equal(twice.rows[1][0], 'x');
});

check('stampGrid overwrites when told to', () => {
  const once = stampGrid([['a'], ['1']], [{ name: 'source', value: 'x' }]);
  const twice = stampGrid(once.rows, [{ name: 'source', value: 'y' }], { overwrite: true });
  assert.equal(twice.rows[1][0], 'y');
  assert.deepEqual(twice.overwritten, ['source']);
});

/* ------------------------------------------------------------------ *
 * header mapper
 * ------------------------------------------------------------------ */

check('parseMap reads messy = canonical and warns on the rest', () => {
  const { map, warnings } = parseMap('Acct. Code = account_code\nbroken line');
  assert.equal(map.get('acct code').canonical, 'account_code');
  assert.equal(warnings.length, 1);
});

check('applyMap renames and reports mapped, unmapped and unused rules', () => {
  const { map } = parseMap('Acct. Code = account_code\nNever Seen = nope');
  const result = applyMap([['Acct. Code', 'Amount'], ['A', '1']], map, {});
  assert.deepEqual(result.rows[0], ['account_code', 'Amount']);
  assert.deepEqual(result.unmapped, ['Amount']);
  assert.deepEqual(result.unusedRules, ['Never Seen']);
});

check('applyMap reorders to the canonical schema and pads what is missing', () => {
  const { map } = parseMap('Acct. Code = account_code');
  const result = applyMap([['Amount', 'Acct. Code'], ['1', 'A']], map, {
    canonicalOrder: ['account_code', 'description', 'Amount'],
    dropUnmapped: false
  });
  assert.deepEqual(result.rows[0], ['account_code', 'description', 'Amount']);
  assert.deepEqual(result.rows[1], ['A', '', '1']);
  assert.ok(result.addedCols.has(1));
});

check('applyMap can drop columns outside the canonical schema', () => {
  const { map } = parseMap('Acct. Code = account_code');
  const result = applyMap([['Amount', 'Acct. Code'], ['1', 'A']], map, {
    canonicalOrder: ['account_code'],
    dropUnmapped: true
  });
  assert.deepEqual(result.rows, [['account_code'], ['A']]);
});

check('similarity and suggestMapping propose sane matches only', () => {
  assert.equal(similarity('Acct. Code', 'acct code'), 1);
  assert.ok(similarity('Amount (GH¢000)', 'amount') > 0.45);
  assert.ok(similarity('Segment', 'date_pulled') < 0.45);
  const suggestions = suggestMapping(['Amount (GH¢000)', 'Segment'], ['amount', 'date_pulled']);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].canonical, 'amount');
});

/* ------------------------------------------------------------------ *
 * the registry
 * ------------------------------------------------------------------ */

check('registry groups render in the contract order', () => {
  const groups = getGroups().map((group) => group.id);
  const expected = GROUPS.map((group) => group.id).filter((id) => groups.includes(id));
  assert.deepEqual(groups, expected);
  assert.deepEqual(groups, ['clean', 'combine', 'convert', 'verify', 'annotate']);
});

check('every registered tool has the fields the UI renders', () => {
  const tools = getTools();
  assert.ok(tools.length >= 12, `expected at least 12 tools, got ${tools.length}`);
  tools.forEach((tool) => {
    assert.ok(tool.id && tool.label && tool.group, `incomplete tool: ${JSON.stringify(tool)}`);
    assert.equal(typeof tool.mount, 'function');
    assert.ok(tool.description.length > 10, `${tool.id} needs a real description`);
    assert.ok(Number.isFinite(tool.order));
  });
});

check('tools are ordered inside their group', () => {
  getGroups().forEach((group) => {
    const orders = group.tools.map((tool) => tool.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), `${group.id} is out of order`);
  });
});

check('the clean group leads with the number cleaner', () => {
  const clean = getGroups().find((group) => group.id === 'clean');
  assert.deepEqual(clean.tools.map((tool) => tool.id), [
    'number-clean',
    'trim-whitespace',
    'dedupe-rows',
    'transpose'
  ]);
});

/* ------------------------------------------------------------------ *
 * scraper — content-type sniffing
 * ------------------------------------------------------------------ */

check('sniffKind trusts a specific Content-Type over the extension', () => {
  assert.deepEqual(sniffKind('https://x.com/download?id=9', 'application/pdf'), {
    kind: 'pdf',
    basis: 'content-type',
    mime: 'application/pdf'
  });
  assert.equal(sniffKind('https://x.com/a.html', 'application/pdf').kind, 'pdf');
});

check('sniffKind falls back to the extension when the Content-Type is vague', () => {
  assert.equal(sniffKind('https://x.com/report.pdf', 'application/octet-stream').kind, 'pdf');
  assert.equal(sniffKind('https://x.com/book.xlsx', 'binary/octet-stream').kind, 'spreadsheet');
  assert.equal(sniffKind('https://x.com/data.csv', 'text/plain; charset=utf-8').kind, 'csv');
});

check('sniffKind identifies the extensionless and the unknown', () => {
  assert.equal(sniffKind('https://x.com/download?id=9', '').kind, 'unknown');
  assert.equal(sniffKind('https://x.com/download?id=9', 'application/octet-stream').kind, 'unknown');
  assert.equal(sniffKind('https://x.com/page', 'text/html; charset=utf-8').kind, 'html');
  assert.equal(sniffKind('https://x.com/scan.PNG', '').kind, 'image');
  assert.equal(
    sniffKind('https://x.com/f', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').kind,
    'document'
  );
});

check('formatBytes reads like a file listing', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3_500_000), '3.3 MB');
  assert.equal(formatBytes(null), '');
});

check('buildProxyUrl encodes the target and any range probe', () => {
  assert.equal(
    buildProxyUrl('https://p.workers.dev', 'https://x.com/a b'),
    'https://p.workers.dev?url=https%3A%2F%2Fx.com%2Fa%20b'
  );
  assert.equal(
    buildProxyUrl('https://p.workers.dev/?k=1', 'https://x.com/', { range: 'bytes=0-0' }),
    'https://p.workers.dev/?k=1&url=https%3A%2F%2Fx.com%2F&range=bytes%3D0-0'
  );
  assert.throws(() => buildProxyUrl('', 'https://x.com'), /proxy/i);
  assert.throws(() => buildProxyUrl('not a url', 'https://x.com'), /valid absolute/i);
});

check('filenameFromUrl recovers a usable name', () => {
  assert.equal(filenameFromUrl('https://x.com/a/b/GOIL%202011.pdf'), 'GOIL 2011.pdf');
  assert.equal(filenameFromUrl('https://x.com/', 'fallback'), 'fallback');
});

/* ------------------------------------------------------------------ *
 * scraper — robots.txt
 * ------------------------------------------------------------------ */

const ROBOTS = parseRobots(`
# comment
User-agent: *
Disallow: /private
Allow: /private/public
Crawl-delay: 2

User-agent: 302-tools
Disallow: /
`);

check('parseRobots groups rules per user-agent', () => {
  assert.deepEqual(ROBOTS.get('*').disallow, ['/private']);
  assert.deepEqual(ROBOTS.get('*').allow, ['/private/public']);
  assert.equal(ROBOTS.get('*').crawlDelay, 2);
  assert.deepEqual(ROBOTS.get('302-tools').disallow, ['/']);
});

check('isAllowed prefers our own user-agent group', () => {
  assert.equal(isAllowed(ROBOTS, '/reports', '302-tools').allowed, false);
  assert.equal(isAllowed(ROBOTS, '/reports', 'other-bot').allowed, true);
});

check('isAllowed uses longest-match-wins with Allow beating Disallow', () => {
  assert.equal(isAllowed(ROBOTS, '/private/x', 'other-bot').allowed, false);
  assert.equal(isAllowed(ROBOTS, '/private/public/a', 'other-bot').allowed, true);
});

check('isAllowed handles wildcards and end anchors', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /*.pdf$');
  assert.equal(isAllowed(robots, '/files/a.pdf', 'x').allowed, false);
  assert.equal(isAllowed(robots, '/files/a.pdf.html', 'x').allowed, true);
});

check('an empty robots.txt allows everything', () => {
  assert.equal(isAllowed(parseRobots(''), '/anything', 'x').allowed, true);
});

/* ------------------------------------------------------------------ *
 * scraper — HTML tables, colspan / rowspan
 * ------------------------------------------------------------------ */

check('expandGrid expands colspan and rowspan into a rectangle', () => {
  const cells = [
    [
      { text: 'Item', rowspan: 2, isHeader: true },
      { text: 'Period', colspan: 2, isHeader: true }
    ],
    [
      { text: '2011', isHeader: true },
      { text: '2010', isHeader: true }
    ],
    [{ text: 'Revenue' }, { text: '100' }, { text: '90' }]
  ];
  const { grid, spannedCells, headerRowCount } = expandGrid(cells);
  assert.deepEqual(grid, [
    ['Item', 'Period', 'Period'],
    ['Item', '2011', '2010'],
    ['Revenue', '100', '90']
  ]);
  assert.equal(spannedCells, 2);
  assert.equal(headerRowCount, 2);
  grid.forEach((row) => assert.equal(row.length, 3));
});

check('expandGrid handles a rowspan that reaches past the last declared row', () => {
  const { grid } = expandGrid([[{ text: 'A', rowspan: 3 }, { text: 'B' }]]);
  assert.equal(grid.length, 3);
  assert.deepEqual(grid[2], ['A', '']);
});

check('expandGrid keeps ragged rows rectangular', () => {
  const { grid } = expandGrid([[{ text: 'a' }, { text: 'b' }, { text: 'c' }], [{ text: '1' }]]);
  assert.deepEqual(grid[1], ['1', '', '']);
});

check('expandGrid on a plain table is an identity', () => {
  const { grid, spannedCells } = expandGrid([
    [{ text: 'a' }, { text: 'b' }],
    [{ text: '1' }, { text: '2' }]
  ]);
  assert.deepEqual(grid, [['a', 'b'], ['1', '2']]);
  assert.equal(spannedCells, 0);
});

/* ------------------------------------------------------------------ *
 * scraper — link discovery
 * ------------------------------------------------------------------ */

check('collectCandidates resolves, dedupes and skips non-http links', () => {
  const candidates = collectCandidates(
    [
      { href: '/reports/2011.pdf', text: 'Annual Report 2011' },
      { href: 'https://x.com/reports/2011.pdf', text: 'same again' },
      { href: 'mailto:a@b.com', text: 'mail' },
      { href: '#top', text: 'top' },
      { href: 'data.xlsx', text: 'Data' }
    ],
    'https://x.com/reports/'
  );
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].url, 'https://x.com/reports/2011.pdf');
  assert.equal(candidates[0].kind, 'pdf');
  assert.equal(candidates[1].kind, 'spreadsheet');
  assert.equal(candidates[1].filename, 'data.xlsx');
});

check('looksLikeIndexLink follows same-origin report indexes only', () => {
  const base = 'https://x.com/about';
  assert.equal(looksLikeIndexLink('https://x.com/investor-relations', 'Investors', base), true);
  assert.equal(looksLikeIndexLink('https://other.com/reports', 'Reports', base), false);
  assert.equal(looksLikeIndexLink('https://x.com/careers', 'Careers', base), false);
  assert.equal(looksLikeIndexLink('https://x.com/reports/a.pdf', 'A report', base), false);
  assert.equal(looksLikeIndexLink('https://x.com/about', 'self', base), false);
});

check('worthSniffing spends HEAD requests on documents and likely files only', () => {
  const make = (url, label) => ({ url, label, kind: sniffKind(url, '').kind });
  assert.equal(worthSniffing(make('https://x.com/a.pdf', 'A')), true);
  assert.equal(worthSniffing(make('https://x.com/download/98', 'Annual report')), true);
  assert.equal(worthSniffing(make('https://x.com/page.html', 'Page')), false);
  assert.equal(worthSniffing(make('https://x.com/careers/', 'Careers')), false);
});

check('groupByKind buckets documents in a stable display order', () => {
  const groups = groupByKind([
    { kind: 'image' },
    { kind: 'pdf' },
    { kind: 'csv' },
    { kind: 'pdf' }
  ]);
  assert.deepEqual(groups.map((group) => group.kind), ['pdf', 'csv', 'image']);
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].label, 'PDF');
});

/* ------------------------------------------------------------------ *
 * scraper — the polite limiter
 * ------------------------------------------------------------------ */

check('createLimiter caps concurrency', async () => {
  const limit = createLimiter(2, 0);
  let active = 0;
  let peak = 0;
  const job = () =>
    limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
  return Promise.all([job(), job(), job(), job(), job()]).then(() => {
    assert.ok(peak <= 2, `peak concurrency was ${peak}`);
  });
});

/* ------------------------------------------------------------------ *
 * core/zip manifest
 * ------------------------------------------------------------------ */

check('buildManifestRows describes every file in the archive', () => {
  const rows = buildManifestRows(
    [
      { name: 'goil_data.csv', content: 'a,b\n1,2', source: 'goil.pdf', page: 32 },
      { name: 'goil_p32_t1_review.csv', content: 'x', source: 'goil.pdf', page: 32, note: 'OCR' }
    ],
    { created: '2026-08-19T00:00:00.000Z' }
  );
  assert.deepEqual(rows[0], ['file', 'kind', 'bytes', 'source', 'page', 'created', 'note']);
  assert.equal(rows[1][1], 'machine csv (tidy/long)');
  assert.equal(rows[1][2], '7'); // 'a,b\n1,2' is 7 bytes
  assert.equal(rows[2][1], 'analyst csv (wide, faithful)');
  assert.equal(rows[2][6], 'OCR');
});

check('kindFromName recognises the contract filenames', () => {
  assert.equal(kindFromName('x_data.csv'), 'machine csv (tidy/long)');
  assert.equal(kindFromName('x_p1_t2_review.csv'), 'analyst csv (wide, faithful)');
  assert.equal(kindFromName('x_notes.xlsx'), 'notes-only export');
  assert.equal(kindFromName('other.txt'), 'text');
});

check('uniqueEntryNames stops a ZIP silently overwriting a file', () => {
  const out = uniqueEntryNames([{ name: 'a.csv' }, { name: 'a.csv' }, { name: 'a.csv' }]);
  assert.deepEqual(out.map((entry) => entry.name), ['a.csv', 'a_2.csv', 'a_3.csv']);
});

check('contentSize counts bytes, not characters', () => {
  assert.equal(contentSize('abc'), 3);
  assert.equal(contentSize('GH₵'), 5); // ₵ is 3 UTF-8 bytes, G and H one each
  assert.equal(contentSize(null), 0);
});

/* ------------------------------------------------------------------ */
const asyncChecks = [];

Promise.all(asyncChecks).then(() => {
  const total = passed + failures.length;
  if (failures.length) {
    console.error(`\n${failures.length} of ${total} checks FAILED\n`);
    failures.forEach(({ name, err }) => {
      console.error(`  ✗ ${name}`);
      console.error(`      ${err.message.split('\n').join('\n      ')}`);
    });
    process.exitCode = 1;
  } else {
    console.log(`tools-check: ${passed} checks passed`);
  }
});
