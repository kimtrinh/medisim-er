// MediSim ER — what counts as having done the thing.
//
// Task 5 of docs/superpowers/plans/2026-09-04-deterministic-simulator-reliability.md.
//
// TODAY an objective is a numbered slot in an array, credited when some responder fires
// with `satisfies: n`. Two consequences the plan asks to fix. The identity is the array
// POSITION, so inserting an objective renumbers every score ever recorded against that
// case. And a compound objective — "obtain lactate and blood + urine cultures BEFORE
// antibiotics" is four requirements in one sentence — is all-or-nothing on whichever
// responder happens to carry the number, so a learner who sent two of the three cultures
// sees the same blank box as one who sent none, and is told nothing about which.
//
// A rule here gives an objective a STABLE ID, an explicit legacy index so historical
// scores still line up, and named substeps that are evaluated FROM RECEIPTS — the record
// of what was performed (Task 4) rather than the words that were typed. An order that was
// refused, blocked or never understood leaves a receipt too, and none of those count.
//
// THIS FILE GRADES NOTHING ON ITS OWN. Task 5 ships it in shadow: both gradings run, the
// differences are reported, and the legacy score is what a learner still sees. Nothing
// here may silently rewrite a score that has already been recorded.
(function(root){
'use strict';

const SCHEMA = 1;

// A receipt counts as evidence only if the action actually happened.
function performed(receipts){
  return (receipts || []).filter(r => r && r.status === 'performed');
}
// Does this receipt satisfy this substep? Identity first — a catalog ID is what the
// control WAS — and the interpreted label second, for actions not yet bound to one.
function receiptMeets(receipt, sub){
  if(!receipt || !sub) return false;
  const ids = sub.catalogIds || [];
  if(ids.length && receipt.catalogId && ids.includes(receipt.catalogId)) return true;
  if(sub.match){
    const hay = [receipt.interpretedLabel, receipt.rawText, receipt.catalogId]
      .filter(Boolean).join(' ').toLowerCase();
    try{ if(new RegExp(sub.match, 'i').test(hay)) return true; }catch(_){ }
  }
  if(Array.isArray(sub.objectiveIds) && Array.isArray(receipt.objectiveIds))
    if(sub.objectiveIds.some(o => receipt.objectiveIds.includes(String(o)))) return true;
  return false;
}

// One objective against one run's receipts.
//
// `mode` is allOf or anyOf and is authored per objective, never inferred: whether two
// halves of a sentence are both required or either will do is a clinical judgement, and
// guessing it is how a partially-treated patient gets full marks.
function evaluate(rule, receipts){
  const done = performed(receipts);
  const subs = (rule.substeps || []).map(sub => {
    const hit = done.find(r => receiptMeets(r, sub));
    return { id: sub.id, label: sub.label, met: !!hit,
             evidence: hit ? [hit.actionId] : [],
             // first qualifying time only: doing it twice is not worth twice
             firstAt: hit ? hit.simTime : null };
  });
  const mode = rule.mode === 'anyOf' ? 'anyOf' : 'allOf';
  const metCount = subs.filter(s => s.met).length;
  const met = mode === 'anyOf' ? metCount > 0 : (subs.length > 0 && metCount === subs.length);
  return {
    id: rule.id, legacyIndex: rule.legacyIndex, label: rule.label, mode,
    met, partial: !met && metCount > 0,
    metCount, total: subs.length,
    missing: subs.filter(s => !s.met).map(s => s.label || s.id),
    substeps: subs,
    evidence: subs.flatMap(s => s.evidence),
  };
}

function evaluateCase(caseRules, receipts){
  const rules = ((caseRules && caseRules.objectives) || []).filter(r => !r.legacyOnly);
  const out = rules.map(r => evaluate(r, receipts));
  // TIMING, where a case authored it. "Reassess AFTER decompression" is not met by a
  // reassessment done before it — the order is the teaching point. Applied after the
  // substeps so both objectives have a first-evidence time to compare.
  const firstOf = id => {
    const row = out.find(x => x.id === id);
    if(!row || !row.met) return null;
    const times = row.substeps.map(s => s.firstAt).filter(t => typeof t === 'number');
    return times.length ? Math.min(...times) : null;
  };
  for(const row of out){
    const rule = rules.find(r => r.id === row.id);
    if(!rule || !rule.after || !row.met) continue;
    const mine = Math.min(...row.substeps.map(s => s.firstAt).filter(t => typeof t === 'number'));
    const theirs = firstOf(rule.after);
    if(theirs == null || !(mine >= theirs)){
      row.met = false; row.partial = true;
      row.missing = row.missing.concat(['after ' + rule.after]);
      row.timingUnmet = rule.after;
    }
  }
  return out;
}

// SHADOW COMPARISON. The plan forbids switching a case over to new grading until the
// difference from the legacy path has been looked at and every intentional one written
// down. This returns those differences; it does not decide anything.
function shadow(caseRules, receipts, legacySatisfied){
  const legacy = new Set((legacySatisfied || []).map(Number));
  const rows = evaluateCase(caseRules, receipts).map(r => {
    const legacyMet = legacy.has(Number(r.legacyIndex));
    return { ...r, legacyMet, agrees: legacyMet === r.met,
             direction: legacyMet === r.met ? 'same' : (legacyMet ? 'legacy-only' : 'evidence-only') };
  });
  return { rows, disagreements: rows.filter(r => !r.agrees) };
}

// Identity must not come from array order or from an editable English sentence. This is
// the check that says so out loud.
function validate(all){
  const problems = [];
  for(const [caseId, spec] of Object.entries(all || {})){
    if(caseId.startsWith('_')) continue;
    const seen = new Set(), legacy = new Set();
    for(const r of (spec.objectives || [])){
      if(!r.id || !/^[a-z0-9][a-z0-9.\-]*$/.test(r.id)) problems.push(caseId + ': bad objective id ' + r.id);
      if(seen.has(r.id)) problems.push(caseId + ': duplicate objective id ' + r.id);
      seen.add(r.id);
      if(!Number.isInteger(r.legacyIndex)) problems.push(caseId + '/' + r.id + ': no legacy index');
      if(legacy.has(r.legacyIndex)) problems.push(caseId + ': two objectives claim legacy index ' + r.legacyIndex);
      legacy.add(r.legacyIndex);
      // A legacyOnly objective has no substeps ON PURPOSE: recognition and avoidance stay
      // on the legacy heuristics, which the plan keeps unmigrated. It still needs an id
      // and a legacy index so the mapping is complete and auditable.
      if(!r.legacyOnly && (!Array.isArray(r.substeps) || !r.substeps.length))
        problems.push(caseId + '/' + r.id + ': no substeps');
      for(const s of (r.substeps || [])){
        if(!s.id) problems.push(caseId + '/' + r.id + ': a substep with no id');
        if(!s.catalogIds && !s.match && !s.objectiveIds)
          problems.push(caseId + '/' + r.id + '/' + s.id + ': nothing can satisfy it');
      }
    }
  }
  return problems;
}

root.ObjectiveRules = { SCHEMA, evaluate, evaluateCase, shadow, validate, receiptMeets, performed };
if(typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.ObjectiveRules;
})(typeof globalThis !== 'undefined' ? globalThis : this);
