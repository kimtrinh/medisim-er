// MediSim ER — what the learner actually chose, kept as an identity rather than a sentence.
//
// Task 2 of docs/superpowers/plans/2026-09-04-deterministic-simulator-reliability.md.
//
// THE PROBLEM THIS SOLVES. Today a known button becomes a string. Click "Normal Saline
// 1 L" and the basket stores the sentence it composed; signing joins those sentences with
// "; " and hands the result back to the resolver, which parses them again as if a human
// had typed them. So a control whose identity was never in doubt is re-derived from
// English, and anything that can go wrong with free text — a fuzzy match, a clause split,
// an alias that eats a dose — can go wrong with a button too. Kim has hit exactly that
// twice: a bicarbonate chip that split into three orders on its own commas, and an alias
// that swallowed the number beside a drug's short name.
//
// An OrderIntent carries the identity forward instead: which catalog entry, which dose,
// where the learner said it, and the raw text unchanged. Free text still resolves into
// the same shape, so there is one representation downstream rather than two.
//
// WHAT THIS DELIBERATELY DOES NOT DO. A known ID skips the FUZZY MATCH. It does not skip
// prerequisites, dose checks, gates, or grading — those are the engine's, and Task 2 does
// not touch them. It also invents no IDs: an unmapped button is reported as unmapped
// (see `inventory`) so a human can bind it, because an ID minted from a label at runtime
// is an identity that changes when someone edits the wording of a button.
//
// Classic script with guarded Node exports, like runlog.js and account.js.
(function(root){
'use strict';

const SCHEMA = 1;

// ---------------------------------------------------------------- small helpers
function norm(s){
  return String(s == null ? '' : s).toLowerCase().trim()
    .replace(/\s*\.\s*$/, '').replace(/\s+/g, ' ');
}
// The dose a learner picked, reduced to the part that makes two orders different. A
// different dose or a different route is a DIFFERENT order and must never collapse into
// the one already in the basket — 500 mL and 2 L are not the same instruction.
function paramKey(p){
  if(!p) return '';
  const keys = Object.keys(p).sort();
  return keys.map(k => k + '=' + norm(p[k])).join('&');
}

// ------------------------------------------------------------------ construction
// A stable local action ID. For a catalog order it is the catalog's own ID plus the dose
// that distinguishes one order of that entry from another. For free text it is the
// normalised text, which is stable for as long as the text is — and is marked as text so
// nothing downstream mistakes it for a bound identity.
function actionId(source, catalogId, parameters, rawText){
  if(catalogId) return catalogId + (paramKey(parameters) ? '#' + paramKey(parameters) : '');
  return 'text:' + norm(rawText);
}

function make(o){
  const parameters = o.parameters || {};
  const catalogId = o.catalogId || null;
  return {
    schema: SCHEMA,
    actionId: o.actionId || actionId(o.source, catalogId, parameters, o.rawText),
    source: o.source,                       // catalog | order-set | text | emergency-control
    rawText: String(o.rawText == null ? '' : o.rawText),
    catalogId,
    kind: o.kind || null,                   // the engine's intent vocabulary
    parameters,
    interpretation: o.interpretation || (catalogId ? 'resolved' : 'needs-clarification'),
    candidates: Array.isArray(o.candidates) ? o.candidates : [],
    label: o.label || o.rawText,            // what the learner sees in the basket
    orderText: o.orderText || o.rawText,    // what the engine is given, unchanged by this module
  };
}

// A catalog entry the learner picked, with the dose they picked beside it.
function fromCatalog(entry, dose, orderText, label){
  if(!entry) return null;
  const parameters = {};
  if(dose){
    if(dose.label) parameters.dose = dose.label;
    if(dose.text)  parameters.doseText = dose.text;
    if(dose.perKg != null) parameters.perKg = String(dose.perKg);
  }
  return make({ source: 'catalog', catalogId: entry.id, kind: entry.category || null,
                parameters, rawText: orderText || entry.canonical || entry.label,
                orderText: orderText || entry.canonical || entry.label,
                label: label || entry.label, interpretation: 'resolved' });
}
// One line of an order set. Bound to a catalog entry when one is known; when it is not,
// the intent says so rather than pretending.
function fromOrderSet(setName, label, orderText, entry){
  return make({ source: 'order-set', catalogId: entry ? entry.id : null,
                kind: entry ? (entry.category || null) : null,
                parameters: { set: setName }, rawText: orderText, orderText,
                label: label || orderText,
                interpretation: entry ? 'resolved' : 'needs-clarification' });
}
// Something the learner typed. Resolution is the resolver's job, not this module's; pass
// the entry in when it is already known.
function fromText(rawText, entry, label){
  return make({ source: 'text', catalogId: entry ? entry.id : null,
                kind: entry ? (entry.category || null) : null,
                rawText, orderText: rawText, label: label || rawText,
                interpretation: entry ? 'resolved' : 'needs-clarification' });
}
// A control that executes immediately. Carried in the same shape so the receipt path in
// Task 4 has one kind of thing to talk about, not two.
function fromEmergency(label, orderText){
  return make({ source: 'emergency-control', rawText: orderText, orderText,
                label: label || orderText, interpretation: 'resolved' });
}

// ---------------------------------------------------------------------- adapter
// A basket item written before intents existed, or by a control not yet bound. Never
// throws and never guesses an ID.
function upgrade(item){
  if(!item) return null;
  if(item.intent && item.intent.schema === SCHEMA) return item.intent;
  return make({ source: 'text', rawText: item.text || item.label || '',
                orderText: item.text || item.label || '',
                label: item.label || item.text || '', interpretation: 'resolved' });
}

// ------------------------------------------------------------------ identity
// Two intents are the same ORDER when they name the same action with the same parameters.
// Same drug at two doses is two orders; the same drug twice at one dose is one.
function keyOf(intent){
  if(!intent) return '';
  return intent.actionId;
}
function sameAction(a, b){ return !!a && !!b && keyOf(a) === keyOf(b); }

// What the learner is told they ordered — the confirmed action including their modifiers,
// never a canonical that has quietly dropped them.
function describe(intent){
  if(!intent) return '';
  const d = intent.parameters && intent.parameters.dose;
  return d && intent.label && !new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(intent.label)
    ? intent.label + ' ' + d : intent.label;
}

// ---------------------------------------------------------------------- inventory
// Which of the app's own controls are bound to a catalog entry and which are not. The
// plan is explicit that unmapped buttons get INVENTORIED, not given invented IDs: a
// label can be reworded, and an identity that moves when the wording moves is not one.
// `resolve` is injected so this module never depends on the engine.
function inventory(controls, resolve){
  const mapped = [], unmapped = [];
  for(const c of (controls || [])){
    let entry = null;
    try{ entry = resolve ? resolve(c.orderText) : null; }catch(_){ entry = null; }
    (entry ? mapped : unmapped).push({ label: c.label, orderText: c.orderText,
                                       source: c.source || 'unknown',
                                       catalogId: entry ? entry.id : null });
  }
  return { total: (controls || []).length, mapped, unmapped };
}

root.OrderIntents = { SCHEMA, make, fromCatalog, fromOrderSet, fromText, fromEmergency,
                      upgrade, keyOf, sameAction, describe, inventory, actionId, paramKey, norm };
if(typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.OrderIntents;
})(typeof globalThis !== 'undefined' ? globalThis : this);
