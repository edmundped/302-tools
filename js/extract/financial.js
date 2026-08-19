/**
 * extract/financial.js — statement / note detection, note numbering, units.
 *
 * This drives the notes-only CSV: find the "Notes to the Financial Statements"
 * section, parse note headings such as "15.  Inventories", and attach noteRef,
 * title, section and units to every table underneath.
 */

import { parseNumber, unitScale } from '../core/numbers.js';

export const STATEMENT_PATTERNS = [
  /statement\s+of\s+financial\s+position/i,
  /balance\s+sheet/i,
  /statement\s+of\s+(comprehensive\s+)?income/i,
  /income\s+statement/i,
  /profit\s+and\s+loss/i,
  /statement\s+of\s+cash\s*flows?/i,
  /cash\s*flow\s+statement/i,
  /statement\s+of\s+changes\s+in\s+equity/i,
  /statement\s+of\s+value\s+added/i
];

export const NOTES_HEADING = /notes?\s+to\s+(the\s+)?(financial\s+statements|accounts)/i;

export const FRONT_PATTERNS = [
  /corporate\s+information/i,
  /notice\s+of\s+(annual\s+general\s+)?meeting/i,
  /chairman'?s?\s+(statement|report|review)/i,
  /report\s+of\s+the\s+directors/i,
  /(independent\s+)?auditors?'?\s+report/i,
  /managing\s+director'?s?\s+(review|report)/i,
  /five\s+year\s+(financial\s+)?summary/i
];

/**
 * Note headings seen in Ghanaian annual reports:
 *   "15.  Inventories"        "15 Inventories"
 *   "NOTE 15 - INVENTORIES"   "Note 15: Inventories"
 *   "15.2  Impairment"
 */
const NOTE_PATTERNS = [
  /^note\s*(\d{1,2}(?:\.\d{1,2})?)\s*[.:—–-]?\s*(.{2,90})$/i,
  /^(\d{1,2}(?:\.\d{1,2})?)\.\s+(\S.{1,89})$/,
  /^(\d{1,2}(?:\.\d{1,2})?)\s+([A-Z][^\d].{1,88})$/
];

/**
 * parseNoteHeading('15.  Inventories') -> { number: '15', title: 'Inventories' }
 * Returns null for ordinary data rows and for prose that merely starts with a number.
 */
export function parseNoteHeading(text) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 110) return null;

  for (const re of NOTE_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    const number = m[1];
    const title = m[2].trim().replace(/[.:;,]+$/, '');
    if (!title || title.length < 2) continue;
    // A title that is itself a figure is a data row, not a heading.
    if (parseNumber(title).isNumeric) continue;
    // Headings do not end mid-sentence with a lowercase connective.
    if (/\b(the|of|and|to|a|in|for|is|are|was|were)$/i.test(title)) continue;
    // Sentences, not headings.
    if (title.split(' ').length > 12) continue;
    if (Number.parseFloat(number) > 99) continue;
    return { number, title };
  }
  return null;
}

/** 'GH¢ thousands', "GH¢'000", 'in thousands of Ghana cedis' */
export function detectUnits(text) {
  const s = String(text || '');
  const patterns = [
    /(GH[¢C₵]|US\s*\$|\$|£|€)\s*['’]?\s*0{3}(?:'?0{3})?/i,
    /(GH[¢C₵]|US\s*\$|\$|£|€)\s*(thousands?|millions?|billions?)/i,
    /in\s+(thousands?|millions?|billions?)\s+of\s+([A-Za-z¢₵$£€ ]{2,24})/i,
    /\(\s*(GH[¢C₵]|US\$|\$|£|€)\s*['’]?0{3}\s*\)/i,
    /amounts?\s+in\s+(GH[¢C₵]|US\$|\$|£|€)\s*['’]?0{3}/i
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

export function detectCurrency(text) {
  const m = String(text || '').match(/GH[¢C₵]|₵|\bGHS\b|\bUSD\b|US\$|\$|£|€|\bNGN\b/i);
  if (!m) return null;
  const t = m[0].toUpperCase();
  if (/GH|₵/.test(t)) return 'GHS';
  if (/US|\$/.test(t)) return 'USD';
  if (t === '£') return 'GBP';
  if (t === '€') return 'EUR';
  if (t === 'NGN') return 'NGN';
  return null;
}

/** Section a single line of text belongs to, or null when it says nothing. */
export function sectionForText(text) {
  const s = String(text || '');
  if (NOTES_HEADING.test(s)) return 'notes';
  if (STATEMENT_PATTERNS.some((re) => re.test(s))) return 'statements';
  if (FRONT_PATTERNS.some((re) => re.test(s))) return 'front';
  return null;
}

/**
 * Walk the document assigning a section to every page.
 * Sections are sticky: once the notes begin they run to the end of the report
 * unless another section heading intervenes.
 *
 * @param {Array<{number:number, bodyLines:Array<{text:string}>}>} pages
 */
export function assignSections(pages) {
  let current = null;
  return pages.map((page) => {
    const lines = page.bodyLines || [];
    let hit = null;
    // Headings live at the top of a page; scan the first quarter of it.
    const scan = lines.slice(0, Math.max(6, Math.ceil(lines.length * 0.25)));
    for (const line of scan) {
      const s = sectionForText(line.text);
      if (s) {
        hit = s;
        break;
      }
    }
    if (hit) current = hit;
    else if (current === 'front') current = 'front';
    return { ...page, section: current ?? 'other' };
  });
}

/**
 * Attach financial context to a page's tables.
 *
 * `contextLines` are the lines the table-level trim pushed above the grid —
 * exactly where the caption, the note heading and the units line live.
 */
export function annotateTables(tables, page, opts = {}) {
  const pageLines = page.bodyLines || [];
  const noteHeadings = [];
  for (const line of pageLines) {
    const note = parseNoteHeading(line.text);
    if (note) noteHeadings.push({ ...note, center: line.center });
  }

  for (const table of tables) {
    const context = table._contextLines || [];
    const contextText = context.map((l) => l.text);

    // Caption: the last context line that is not a note heading, not a units
    // line and not a running section title.
    let title = null;
    let noteRef = null;

    // The nearest note heading above the table wins.
    const top = table.bbox ? table.bbox.y : Infinity;
    const above = noteHeadings.filter((n) => n.center < top).sort((a, b) => b.center - a.center)[0];
    if (above) {
      noteRef = above.number;
      title = above.title;
    }

    if (!title) {
      for (let i = contextText.length - 1; i >= 0; i -= 1) {
        const t = contextText[i].trim();
        if (!t || detectUnits(t) === t || NOTES_HEADING.test(t)) continue;
        if (/^for the (year|period)/i.test(t) || /^as at\b/i.test(t)) continue;
        title = t;
        break;
      }
    }

    const unitsSource = [...contextText, ...(page.captionText || [])].join(' \n ');
    const units = detectUnits(unitsSource);

    table.title = title || table.title || null;
    table.noteRef = noteRef ?? table.noteRef ?? null;
    table.units = units || table.units || null;
    table.section = table.noteRef ? 'notes' : page.section === 'front' ? 'other' : page.section || null;

    if (table.section === 'notes' && !table.noteRef) {
      table.warnings.push('table sits in the notes section but no note number was found above it');
    }
    if (opts.requireUnits && !table.units) {
      table.warnings.push('no units caption found; figures are as printed');
    }
  }
  return tables;
}

/** Document-level metadata harvested from the first few pages. */
export function docMeta(pages) {
  const meta = { title: null, company: null, periodLabel: null, currency: null, unitsScale: null };
  const head = pages.slice(0, 4).flatMap((p) => (p.bodyLines || []).map((l) => l.text));
  for (const line of head) {
    if (!meta.company && /\b(limited|ltd|plc|company|group)\b/i.test(line) && line.length < 80) meta.company = line.trim();
    if (!meta.periodLabel) {
      const m = line.match(/(?:year|period)\s+ended\s+([\w\s]{4,30}(?:19|20)\d{2})/i) || line.match(/as at\s+([\w\s]{4,30}(?:19|20)\d{2})/i);
      if (m) meta.periodLabel = m[1].trim();
    }
    if (!meta.currency) meta.currency = detectCurrency(line);
    if (!meta.unitsScale) {
      const u = detectUnits(line);
      if (u) meta.unitsScale = unitScale(u);
    }
  }
  return meta;
}

export default {
  parseNoteHeading,
  detectUnits,
  detectCurrency,
  sectionForText,
  assignSections,
  annotateTables,
  docMeta,
  NOTES_HEADING,
  STATEMENT_PATTERNS
};
