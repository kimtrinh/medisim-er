// TRAINING COACH — Task 10 of docs/superpowers/plans/2026-09-04-deterministic-simulator-reliability.md
//
// A learner who is stuck has two bad options today: guess, or lose the case. This module
// gives a third, without turning the simulator into a walkthrough.
//
// The rules the plan sets, and why each one is here:
//
//  * HINTS ARE TIERED AND ASKED FOR. Tier 1 names the PHASE of the resuscitation, which is
//    true of every case and gives nothing away. Tier 2 names the CATEGORY the outstanding
//    work sits in. Only tier 3 names the step, and only when the learner asks for it a
//    third time. A learner who wants a nudge does not have to accept the answer.
//  * A HINT NEVER REPEATS WORK ALREADY DONE, and never proposes a step the case has not
//    opened yet. Both come from the run's own receipts through ObjectiveRules, not from a
//    static script — so a hint cannot tell someone to draw the cultures they drew ten
//    minutes ago, and cannot tell them to reassess a bolus they have not given.
//  * NO DIAGNOSIS LEAKS. The phase vocabulary is fixed and case-independent; the category
//    and step come from authored per-case metadata whose wording is a clinician's to
//    choose. Nothing here reads the diagnosis, and nothing ranks cases by it.
//  * TRAINING PAUSES; EXAM DOES NOT. In training the clock stops while a hint is open and
//    says so on screen. In exam mode the clock runs continuously and hints are off. The
//    difference is declared, never silent.
//  * ASSISTANCE IS RECORDED. A run that took hints or used a retry is marked, and the
//    unassisted record stays separate — a trophy has to mean you did it alone.
//
// Pure and browser-compatible: no DOM, no timers, no I/O. Node gets it through the guarded
// export at the bottom, the same shape as objective-rules.js and order-dispatch.js.
(function(root){
'use strict';

const SCHEMA = 1;

// The whole spoiler-free vocabulary, in the order a resuscitation actually runs. A phase
// name is safe to show on any case because it is true of every case: saying "you are still
// in the stabilize phase" tells a learner about THEIR OWN progress, not about the patient's
// diagnosis. The plan names these five; they are not extended per case.
const PHASES = ['assess', 'stabilize', 'investigate', 'reassess', 'disposition'];
const PHASE_LINE = {
  assess:      'You are still in the assessment phase — airway, breathing, circulation and a look at the patient come before anything else.',
  stabilize:   'The stabilizing work is not finished. Something that keeps this patient alive is still outstanding.',
  investigate: 'The patient is stable enough to work up. There is a study or a specimen still outstanding.',
  reassess:    'You have treated. Now find out whether it worked — the reassessment is the outstanding step.',
  disposition: 'The work-up is done. This patient still needs somewhere to go.',
};
const MODES = ['training', 'exam'];

// Tier 2 says WHERE to look, and this fixed list is what stops it saying WHAT to do. A
// category names a system or a kind of action and is drawn from the same nine words on
// every case, so it cannot carry a diagnosis: "look at circulation" is the same sentence
// on a septic patient and a bleeding one. Authored metadata is validated against this list.
const CATEGORIES = ['airway and breathing', 'circulation', 'medications', 'laboratory',
                    'imaging', 'procedures', 'consultation', 'monitoring and reassessment',
                    'disposition'];

// Context flags the COACH supplies about the run, as opposed to the flags a pack sets.
// Underscore-prefixed so an authored `notWhen` can name one without any chance of
// colliding with a pack's own flag name.
const CTX_FLAGS = ['__pulse', '__arrest', '__rosc'];

// ---------------------------------------------------------------- session

function newSession(mode){
  return { v: SCHEMA, mode: MODES.includes(mode) ? mode : 'training',
           hints: 0, maxTier: 0, retries: 0, paused: false, asked: [] };
}
// Exam mode is a promise about timing, so it is also a promise about help: no hints, no
// pause, no retry. Anything that would change the outcome is refused rather than quietly
// downgraded, because a learner who thinks they got a hint and did not is worse off.
function helpAllowed(session){ return !!session && session.mode === 'training'; }

// ---------------------------------------------------------------- what is outstanding

// One objective's status, from the run's own receipts. `after` is the case's authored
// sequencing: an objective that waits on another is NOT outstanding yet, it is simply not
// this learner's turn — hinting it would be the coach getting ahead of the case.
function statusOf(caseRules, receipts){
  const OR = root.ObjectiveRules;
  if(!OR || !caseRules) return [];
  const rows = OR.evaluateCase(caseRules, receipts || []);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const rules = Object.fromEntries(((caseRules.objectives) || []).map(r => [r.id, r]));
  return rows.map(r => {
    const rule = rules[r.id] || {};
    const dep = rule.after ? byId[rule.after] : null;
    return { ...r, blockedBy: (dep && !dep.met) ? rule.after : null };
  });
}

// The hintable set, in the order a coach would raise them.
//
// Three exclusions, each one a way the coach could otherwise say something false:
//   met        — already done; naming it wastes the learner's one question
//   blockedBy  — the case has not opened this step yet
//   notWhen    — an authored flag says this step is contraindicated in the state the
//                patient is actually in (a clinician writes these; the coach never infers
//                a contraindication for itself)
function outstanding(caseRules, meta, ctx){
  const flags = (ctx && ctx.flags) || {};
  const m = (meta && meta.objectives) || {};
  return statusOf(caseRules, (ctx && ctx.receipts) || [])
    .filter(r => !r.met && !r.blockedBy)
    .filter(r => !((m[r.id] || {}).notWhen || []).some(f => !!flags[f]))
    .sort((a, b) => {
      // Authored priority first, because clinical order is a clinical judgement and not
      // something a phase label can carry: on this septic patient the cultures come before
      // the antibiotics, and only a clinician can say so.
      const ra = (m[a.id] || {}).priority, rb = (m[b.id] || {}).priority;
      if(ra != null || rb != null) return (ra == null ? 999 : ra) - (rb == null ? 999 : rb);
      const pa = PHASES.indexOf((m[a.id] || {}).phase), pb = PHASES.indexOf((m[b.id] || {}).phase);
      if(pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      return (a.legacyIndex || 0) - (b.legacyIndex || 0);
    });
}

// The current phase, for the countdown caption and for tier 1. It is the phase of the most
// urgent OUTSTANDING objective — not a clock reading — so it moves when the learner moves.
function phaseFor(caseRules, meta, ctx){
  const open = outstanding(caseRules, meta, ctx);
  if(!open.length) return 'disposition';
  const p = ((meta && meta.objectives && meta.objectives[open[0].id]) || {}).phase;
  return PHASES.includes(p) ? p : 'assess';
}

// ---------------------------------------------------------------- the hint itself

// Tier 1 is case-independent. Tier 2 names the authored category. Tier 3 names the step —
// and names only the parts still MISSING, which is what stops it repeating completed work
// on a half-done compound objective ("you have the lactate; the cultures are outstanding").
function nextHint(caseRules, meta, ctx, session){
  if(!helpAllowed(session)) return { tier: 0, text: 'Hints are off in exam mode. Switch to training mode to use them.', refused: true };
  const open = outstanding(caseRules, meta, ctx);
  if(!open.length) return { tier: 0, text: 'Nothing is outstanding that this case is tracking. If the patient is worked up and stable, they need a disposition.', done: true };
  const top = open[0];
  const m = ((meta && meta.objectives) || {})[top.id] || {};
  const tier = Math.min(3, (session.maxTier || 0) + 1);
  let text;
  if(tier === 1){
    text = PHASE_LINE[phaseFor(caseRules, meta, ctx)] || PHASE_LINE.assess;
  }else if(tier === 2){
    text = m.category
      ? 'Look at ' + m.category + '. Something there is still outstanding.'
      : 'Something in this patient’s active problem is still outstanding.';
  }else{
    // The step, stated once. `missing` is the substeps not yet evidenced, so a compound
    // objective half-done reads as the half that is left.
    const left = (top.missing || []).filter(Boolean);
    text = m.step ? m.step
         : left.length ? ('Still outstanding: ' + left.join(', ') + '.')
         : ('Still outstanding: ' + (top.label || 'the next step in this case') + '.');
    if(m.step && left.length && left.length < (top.total || 0))
      text += ' You already have ' + (top.total - left.length) + ' of ' + top.total + ' parts of this.';
  }
  return { tier, text, objectiveId: top.id, phase: phaseFor(caseRules, meta, ctx) };
}

// Recording a hint is separate from producing one, so the UI can show a hint and only
// charge for it once — and so a test can ask for the same tier twice without inflating it.
function recordHint(session, hint){
  if(!session || !hint || hint.refused || !hint.tier) return session;
  session.hints = (session.hints || 0) + 1;
  session.maxTier = Math.max(session.maxTier || 0, hint.tier);
  session.asked = (session.asked || []).concat([{ tier: hint.tier, objectiveId: hint.objectiveId || null }]);
  return session;
}

// ---------------------------------------------------------------- pacing and the pause

// The countdown is the ENGINE'S OWN deadline arithmetic rendered, never a second
// calculation that could drift from it — so this takes the landmark the engine returned
// and only decides the words. It is labelled as pacing because it is: it is when this
// authored case changes, not a statement about how long a real patient has.
function pacingCaption(lm, simMin, opts){
  const o = opts || {};
  // A death stage has fired and the next order decides the case. The old behaviour was to
  // hide the countdown entirely, which read as "no time pressure" at the single most
  // time-pressured moment in the run. Say what is actually true instead.
  if(o.pendingDeath) return { kind: 'rescue', label: 'RESCUE NOW', detail: 'The next order decides this case.', urgent: true };
  if(o.paused)       return { kind: 'paused', label: 'PAUSED', detail: 'Simulation time is stopped while you read.', urgent: false };
  if(!lm)            return { kind: 'none', label: '', detail: '', urgent: false };
  const rem = Math.max(0, (lm.afterMin || 0) - (simMin || 0));
  return { kind: 'countdown', label: '~' + Math.round(rem) + ' min', urgent: rem <= 5,
           detail: 'Simulation pacing: about ' + Math.round(rem) + ' minutes of case time until this case changes. It is not a prognosis.',
           remaining: rem, fraction: Math.max(0, Math.min(1, rem / Math.max(1, lm.window || 1))) };
}

// A pause is only real if the thing that consumes time actually stops. In training the code
// ticker asks this before every tick; in exam mode it is always false, which is what makes
// exam timing continuous rather than continuous-by-convention.
function paused(session){ return !!(session && session.mode === 'training' && session.paused); }
function setPaused(session, on){
  if(!session) return session;
  session.paused = !!on && session.mode === 'training';
  return session;
}

// ---------------------------------------------------------------- checkpoint and retry

// Everything a turn reads, captured in one object. Missing any of these makes a "retry"
// into a different run wearing the same name: the seed decides the illustrative lab
// values, the receipts decide what is already credited, and the code state decides whether
// there is a pulse. A checkpoint that restored only the clock would replay differently and
// look like a simulator bug.
const CHECKPOINT_KEYS = ['instantState', 'code', 'simMin', 'trend', 'vitals', 'shown',
                         'receipts', 'labs', 'reports', 'timeline', 'messages', 'diagnosisHeld'];

function clone(v){
  if(v === undefined) return undefined;
  try{ return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  catch(_){ try{ return JSON.parse(JSON.stringify(v)); }catch(_e){ return null; } }
}
function checkpoint(src, label){
  const data = {};
  for(const k of CHECKPOINT_KEYS) if(src && src[k] !== undefined) data[k] = clone(src[k]);
  return { v: SCHEMA, label: label || '', at: (src && src.simMin) || 0, data };
}
// Restore writes back onto the same object the app already holds, because half the app
// holds references into S. Keys absent from the checkpoint are left alone rather than
// deleted — a checkpoint taken before a code started must not invent a code state.
function restore(dst, cp){
  if(!dst || !cp || !cp.data) return dst;
  for(const k of CHECKPOINT_KEYS) if(cp.data[k] !== undefined) dst[k] = clone(cp.data[k]);
  return dst;
}
function recordRetry(session){
  if(session) session.retries = (session.retries || 0) + 1;
  return session;
}

// ---------------------------------------------------------------- the record

// What goes into the run log. `assisted` is the one field the progression reads, and it is
// deliberately narrow: choosing training mode is not assistance, taking a hint or a retry
// is. A learner should be able to practise with the safety net available and still earn the
// trophy by not using it.
function assistRecord(session){
  if(!session) return null;
  const hints = session.hints || 0, retries = session.retries || 0;
  return { mode: session.mode, hints, retries, maxTier: session.maxTier || 0,
           assisted: session.mode === 'training' && (hints > 0 || retries > 0) };
}
function isAssisted(entry){ return !!(entry && entry.assist && entry.assist.assisted); }

const api = { SCHEMA, PHASES, MODES, PHASE_LINE, CATEGORIES, CTX_FLAGS, CHECKPOINT_KEYS,
  newSession, helpAllowed, statusOf, outstanding, phaseFor, nextHint, recordHint,
  pacingCaption, paused, setPaused, checkpoint, restore, recordRetry,
  assistRecord, isAssisted };
root.TrainingCoach = api;
if(typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
