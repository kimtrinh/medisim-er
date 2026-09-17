// MediSim ER — the quick-orders menu, built as a view over the order catalogue.
//
// Task 1 of docs/superpowers/plans/2026-09-16-order-menu-by-doing.md.
//
// Kim's complaint: "It can be confusing when to use the quick orders versus the Orders
// search bar." Today those are two vocabularies: the menu is three hard-coded JS objects
// (PALETTE, SECTIONS, CODE_PALETTE) inside medisim-er-local.html, and the search bar looks
// up order-catalog.json. A chip and a search result for the same action can drift apart,
// or exist under two different wordings, because nothing ties them together.
//
// This module is Task 1 of that fix: it does not touch the catalogue or the page. It just
// turns catalog entries that opt in — by carrying a `menu` place — into the grouped rows
// the menu panel will render. An entry opts in once and can appear in more than one place
// (a chip may legitimately belong in two rows, e.g. exam-gcs under both
// Resuscitate/Disability, where ABCDE calls for it, and Assess/Exam, where a learner
// browsing by task would look for it).
//
// Task 2 hand-writes menu-assignments.json — every group/row/order comes from a person
// typing exact strings and numbers into a file with no compiler behind it. Every mistake
// this module can catch (a misspelled row, a missing order, a pasted-twice place) throws
// with the entry's id in the message, because a menu chip that silently fails to appear,
// or appears twice, is a much harder bug to notice on a live page than a crash on load.
//
// Classic script with guarded Node exports, like order-intents.js and account.js.
(function(root){
'use strict';

// The menu's shape, fixed by the plan. Order here is display order: groups top to bottom,
// rows within a group top to bottom. Frozen because this table is meant to be edited on
// purpose, in a diff someone reviews — not nudged sideways by a stray push() elsewhere,
// and not silently ignored either: GROUPS.push(...) throws in strict mode against a
// frozen array rather than quietly doing nothing (see the test that pins this).
const GROUPS = Object.freeze([
  { group: 'Resuscitate', rows: Object.freeze(['Airway', 'Breathing', 'Circulation', 'Disability', 'Exposure']) },
  { group: 'Assess',      rows: Object.freeze(['History', 'Exam', 'Reassess']) },
  { group: 'Investigate', rows: Object.freeze(['Bedside', 'Labs', 'Imaging', 'Cultures']) },
  { group: 'Treat',       rows: Object.freeze(['Pain & nausea', 'Infection', 'Heart', 'Breathing', 'Brain & seizures',
                                               'Poisoning', 'Sugar & salts', 'Blood & clotting',
                                               'Pressors & rate control', 'Fluids']) },
  { group: 'Procedures',  rows: Object.freeze(['Lines', 'Airway & chest', 'Other']) },
  { group: 'Call & move', rows: Object.freeze(['Consults', 'Dispositions']) },
].map(Object.freeze));

// Turn catalog entries into `[{group, rows:[{row, chips:[chip]}]}]`. Leaves `entries` (and
// each entry's own `menu` field, array or not) untouched — the page is expected to call
// this on the live catalogue every render, so mutating the caller's data here would be a
// bug that only shows up the second time you call it.
//
// An entry is in the menu only if it has a `menu` field: either one place object
// `{group, row, order, label?}`, or an array of them.
function menuFromCatalog(entries){
  // group name -> row name -> chips, pre-built from GROUPS so lookups never have to guess
  // whether a bucket exists before pushing into it.
  const buckets = new Map();
  for(const g of GROUPS) buckets.set(g.group, new Map(g.rows.map(row => [row, []])));

  for(const entry of (entries || [])){
    if(!entry || !entry.menu) continue;
    const places = Array.isArray(entry.menu) ? entry.menu : [entry.menu];
    // Per entry, not per module: two entries are allowed to each use Resuscitate/Airway;
    // one entry using it twice is a copy-paste mistake in menu-assignments.json.
    const seen = new Set();
    for(const place of places){
      if(!place) throw new Error('menu place is missing (null or undefined) on ' + entry.id);
      const groupDef = GROUPS.find(g => g.group === place.group);
      if(!groupDef) throw new Error('unknown group "' + place.group + '" on ' + entry.id);
      if(!groupDef.rows.includes(place.row))
        throw new Error('unknown row "' + place.row + '" in group "' + place.group + '" on ' + entry.id);
      // A missing order used to compare as NaN, which is falsy, so the sort fell through
      // to the id tiebreak for that pair only — non-transitive, so the result depended on
      // the sort algorithm's internal comparison order rather than on anything the data
      // said. Treat a bad order exactly like a bad group or row: refuse to guess.
      if(!Number.isFinite(place.order)) throw new Error('menu place with no order on ' + entry.id);
      const placeKey = place.group + ' / ' + place.row;
      if(seen.has(placeKey))
        throw new Error('duplicate menu place "' + placeKey + '" on ' + entry.id);
      seen.add(placeKey);
      // The chip is a VIEW, not a record: Object.create(entry) makes entry its prototype,
      // so `menu` is the chip's only OWN property and everything else (id, label,
      // category, canonical, doses, sendCanonical…) is read through to the entry live —
      // edit entry.canonical after this and the chip sees the edit. That is convenient for
      // rendering and dangerous for anything that serialises: JSON.stringify(chip) is
      // `{"menu":{...}}`, and so is `{...chip}`, `Object.keys(chip)` or
      // `structuredClone(chip)` — every one of them walks own properties only and drops
      // id/label/doses on the floor. This repo serialises orders constantly (receipts,
      // run_log, exported case reports); do not hand a chip to any of that. Put chip.id in
      // the record instead and let the reader look the entry up — or call chipRecord()
      // below, which is the sanctioned way to turn a chip into something serialisable.
      const chip = Object.assign(Object.create(entry), { menu: place });
      buckets.get(place.group).get(place.row).push(chip);
    }
  }

  const out = [];
  for(const g of GROUPS){
    const rows = [];
    for(const row of g.rows){
      const chips = buckets.get(g.group).get(row);
      if(!chips.length) continue;
      chips.sort((a, b) => (a.menu.order - b.menu.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      rows.push({ row, chips });
    }
    if(rows.length) out.push({ group: g.group, rows });
  }
  return out;
}

// What the chip shows. A place can rename the entry for where it sits (exam-gcs reads
// "GCS (ABCDE)" under Disability and "GCS (exam)" under Exam). A raw catalog entry passed
// in before it has been placed — whose `menu` is still the array of places, not one
// emitted chip — has no `.label` on that array, so this falls through to the entry's own
// label, which is the right answer for "what is this entry called on its own".
function chipLabel(chip){
  if(!chip) return undefined;
  return (chip.menu && chip.menu.label) || chip.label;
}

// The sanctioned way to serialise a chip. A chip is a view over its entry — see the
// warning in menuFromCatalog — so anything that needs to write one down (a receipt, a
// run_log row, an exported report) should ask for this shape instead of spreading or
// JSON.stringify-ing the chip itself.
function chipRecord(chip){
  if(!chip) return null;
  const place = chip.menu || {};
  return { id: chip.id, label: chipLabel(chip), group: place.group, row: place.row };
}

root.OrderMenu = { GROUPS, menuFromCatalog, chipLabel, chipRecord };
if(typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.OrderMenu;
})(typeof globalThis !== 'undefined' ? globalThis : this);
