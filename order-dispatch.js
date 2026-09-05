// MediSim ER — one way an order gets executed, and a receipt for every attempt.
//
// Task 4 of docs/superpowers/plans/2026-09-04-deterministic-simulator-reliability.md.
//
// THE PROBLEM. Signing a basket today walks two paths that answer differently. Each clause
// is offered to the code engine; whatever it does not claim is joined back into a sentence
// and run as one narrative turn. Nothing records what happened to any individual order, so
// the transcript, the timeline and the grading each re-derive it from prose — and an order
// that was refused, blocked by a prerequisite, or never understood looks the same on the
// way out as one that was performed.
//
// A receipt is that record: one per attempted action, created by the same call that
// changed the state. The plan's rule, and the reason this is worth doing at all: an
// exception must not leave a success receipt without an action, or an applied action with
// a silent retry.
//
// WHAT THIS IS NOT. A signed batch is not a database transaction. Valid orders run in
// order; a refused or blocked one gets its own receipt and the rest still happen. There is
// no rollback, because care that was given cannot be un-given.
//
// Everything the app does is injected, so this file has no DOM, no engines and no globals
// and can be run whole in a test. Classic script with guarded Node exports.
(function(root){
'use strict';

const SCHEMA = 1;
const STATUS = ['performed', 'pending', 'blocked', 'unsupported', 'failed'];

let _seq = 0;
function newBatchId(){
  _seq += 1;
  return 'b' + Date.now().toString(36) + '-' + _seq.toString(36);
}

function makeReceipt(o){
  const r = {
    schema: SCHEMA,
    actionId: o.actionId || null,
    batchId: o.batchId || null,
    catalogId: o.catalogId || null,
    rawText: o.rawText == null ? '' : String(o.rawText),
    interpretedLabel: o.interpretedLabel || o.rawText || '',
    engine: o.engine || null,              // instant | code | null when nothing ran
    status: STATUS.includes(o.status) ? o.status : 'failed',
    reasonCode: o.reasonCode || null,      // stable and machine-readable; copy lives in the UI
    simTime: typeof o.simTime === 'number' ? o.simTime : 0,
    evidence: Array.isArray(o.evidence) ? o.evidence : [],
    resultIds: Array.isArray(o.resultIds) ? o.resultIds : [],
    objectiveIds: Array.isArray(o.objectiveIds) ? o.objectiveIds : [],
  };
  return r;
}

// ------------------------------------------------------------------ the boundary
// intents  : OrderIntent[] (order-intents.js), in the order the learner signed them
// adapters : { codeAnswers(), tryCode(intent), runNarrative(intents), simTime() }
//
// tryCode returns null when the code engine does not claim the action, otherwise
//   { ok:boolean, reasonCode?, evidence?, objectiveIds? }
// runNarrative receives the intents it must run AS ONE TURN — splitting them into a turn
// each would change how much simulated time a signature costs, which is a clinical
// property and not this task's to change — and returns
//   { perAction: { [actionId]: { status, reasonCode?, evidence?, objectiveIds?, resultIds? } },
//     simTime }
async function run(intents, adapters, opts){
  const a = adapters || {};
  const o = opts || {};
  const batchId = o.batchId || newBatchId();
  const list = Array.isArray(intents) ? intents.filter(Boolean) : [];

  // A DELIBERATE REPEAT GETS A NEW ID; AN ACCIDENTAL DOUBLE DOES NOT RUN TWICE.
  // Two identical action IDs inside ONE signature are the same instruction entered twice,
  // not two doses — the second is receipted as a duplicate and never executed.
  const seen = new Set();
  const receipts = [];
  const toRun = [];
  for(const intent of list){
    const id = intent.actionId;
    if(id && seen.has(id)){
      receipts.push(makeReceipt({ actionId: id, batchId, catalogId: intent.catalogId,
        rawText: intent.rawText, interpretedLabel: intent.label,
        status: 'unsupported', reasonCode: 'duplicate-in-batch' }));
      continue;
    }
    if(id) seen.add(id);
    toRun.push(intent);
  }

  // The code engine gets first refusal, action by action and in order, exactly as the
  // clause loop did — so a shock clicked off the trolley still lands like one typed.
  const forNarrative = [];
  for(const intent of toRun){
    let claimed = null;
    if(a.codeAnswers && a.codeAnswers() && a.tryCode){
      try{ claimed = a.tryCode(intent); }
      catch(e){
        receipts.push(makeReceipt({ actionId: intent.actionId, batchId, catalogId: intent.catalogId,
          rawText: intent.rawText, interpretedLabel: intent.label, engine: 'code',
          status: 'failed', reasonCode: 'code-engine-threw' }));
        continue;
      }
    }
    if(claimed){
      receipts.push(makeReceipt({ actionId: intent.actionId, batchId, catalogId: intent.catalogId,
        rawText: intent.rawText, interpretedLabel: intent.label, engine: 'code',
        status: claimed.ok === false ? 'blocked' : 'performed',
        reasonCode: claimed.reasonCode || null,
        evidence: claimed.evidence || [], objectiveIds: claimed.objectiveIds || [],
        simTime: 0 }));   // a code order costs no clock: the ticker owns time during a code
    }else{
      forNarrative.push(intent);
    }
  }

  // Everything the code engine did not claim goes to the turn engine as ONE turn. An
  // unrelated order must not disappear because a different clause was handled elsewhere —
  // that was the defect behind "Intubate; cooling measure", where the second order was
  // dropped entirely once the first was claimed.
  if(forNarrative.length && a.runNarrative){
    let res = null;
    try{ res = await a.runNarrative(forNarrative); }
    catch(e){
      for(const intent of forNarrative)
        receipts.push(makeReceipt({ actionId: intent.actionId, batchId, catalogId: intent.catalogId,
          rawText: intent.rawText, interpretedLabel: intent.label, engine: 'instant',
          status: 'failed', reasonCode: 'turn-engine-threw' }));
      return { batchId, receipts, error: String(e && e.message || e) };
    }
    const per = (res && res.perAction) || {};
    for(const intent of forNarrative){
      const got = per[intent.actionId] || {};
      receipts.push(makeReceipt({ actionId: intent.actionId, batchId, catalogId: intent.catalogId,
        rawText: intent.rawText, interpretedLabel: intent.label, engine: 'instant',
        status: got.status || 'unsupported',
        reasonCode: got.reasonCode || (got.status ? null : 'no-responder'),
        evidence: got.evidence || [], resultIds: got.resultIds || [],
        objectiveIds: got.objectiveIds || [],
        simTime: typeof res.simTime === 'number' ? res.simTime : 0 }));
    }
  }
  return { batchId, receipts };
}

// A batch is frozen once submitted: the same batch cannot be run again, which is what
// makes a double-tap on Sign perform once. Kept here rather than in the UI so every
// caller inherits it.
function freezer(){
  const done = new Set();
  return {
    seen(batchId){ return done.has(batchId); },
    freeze(batchId){ done.add(batchId); return batchId; },
    size(){ return done.size; },
  };
}

// What a receipt means in one word, for a list the learner reads. Copy lives with the UI;
// this is only the mapping, so the same status cannot be described two ways in two places.
function summarise(receipts){
  const out = { performed: 0, pending: 0, blocked: 0, unsupported: 0, failed: 0 };
  for(const r of (receipts || [])) if(out[r.status] != null) out[r.status]++;
  return out;
}

root.OrderDispatch = { SCHEMA, STATUS, run, makeReceipt, newBatchId, freezer, summarise };
if(typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.OrderDispatch;
})(typeof globalThis !== 'undefined' ? globalThis : this);
