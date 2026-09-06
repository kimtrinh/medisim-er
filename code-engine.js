// MediSim ER — LIVE CODE ENGINE
// A resuscitation runs on a clock, not on turns. This interprets a per-case
// declarative `codeScript` (see docs/superpowers/specs/2026-08-22-live-code-mode-design.md)
// and owns rhythm/pulse/cycle/drug state. It has NO DOM and NO timers of its own:
// the page calls tick(state, script, dtSeconds) once a real second with dt=6.
// Deterministic by design — no Math.random and no Date.now anywhere — so the same
// play always produces the same code, which is what makes the debrief fair.
//
// Loaded as a classic browser <script> (sets globalThis.CodeEngine) and, for tests,
// via Node's vm in this same global — one file, both environments, like instant-engine.js.
(function(root){
'use strict';

const CYCLE_SEC = 120;          // one CPR cycle between rhythm checks
const STATUS_SEC = 90;          // how often the nurse calls the time while a pulse remains
const SHOCKABLE = new Set(['VF', 'pVT', 'torsades']);
const PULSELESS = new Set(['VF', 'pVT', 'torsades', 'PEA', 'asystole']);
// The rhythms a synchronized shock is FOR. Everything else with a pulse — sinus, a
// bradycardia, complete heart block, a paced rhythm — has nothing to cardiovert, and
// sinus tachycardia is the one it is most dangerous to try, because the rate is the
// compensation and not the disease.
const CARDIOVERTABLE = new Set(['SVT', 'AF', 'VT', 'aflutter']);

function newState(script){
  const st = script.start || {};
  return {
    t: 0, phase: st.pulse ? 'peri' : 'arrest',
    rhythm: st.rhythm || 'sinus', pulse: !!st.pulse,
    hr: st.hr || 0, bpSys: st.bpSys || 0, bpDia: st.bpDia || 0,
    spo2: st.spo2 || 0, rr: st.rr || 0, etco2: st.etco2 || 0,
    cycle: 1, cycleT: 0, statusT: 0, cpr: false, cprSecs: 0, pulselessSecs: 0, firstCprT: null, cyclesWithoutCpr: 0,
    // The doctor has not read the strip yet, so nobody names it. See RHYTHM_CALLS.
    rhythmCalled: false,
    shocks: [], drugs: [], lastEpiT: null, amioDoses: 0,
    airway: 'none', capnography: false, ivAccess: false, io: false,
    // Arrays, not Sets: the whole state is JSON.stringify'd for the determinism
    // test, the run log and the debrief, and a Set serialises to {}.
    causesTreated: [], events: [], flags: {}, ended: null, credited: [], hintsFired: [],
    checksDone: 0
  };
}

function ev(state, kind, text, extra){
  const e = Object.assign({ t: state.t, kind, text: text || '' }, extra || {});
  state.events.push(e);
  return e;
}

function tick(state, script, dt){
  const out = [];
  if(state.ended) return out;
  const step = Math.max(0, dt || 0);
  state.t += step;
  // Compression seconds count whenever hands are on the chest. A newborn receives 3:1
  // compressions at a heart rate under 60 — a rate, not an absent pulse — so counting
  // only while pulseless reported 0% CPR on a textbook-perfect resuscitation.
  if(state.cpr) state.cprSecs += step;
  if(state.cpr) state.cprSinceFirst = (state.cprSinceFirst || 0) + step;
  if(state.cpr && state.firstCprT == null) state.firstCprT = state.t - step;
  if(!state.pulse){
    state.pulselessSecs += step;
    state.cycleT += step;
    if(state.cycleT >= CYCLE_SEC){
      state.cycleT -= CYCLE_SEC;
      state.cycle += 1;
      state.checksDone += 1;                       // the team checks; the player need not type it
      if(!state.cpr) state.cyclesWithoutCpr = (state.cyclesWithoutCpr || 0) + 1;
      // THE TEAM CHECKS, AND SAYS WHAT IT FINDS.
      //
      // The engine has always performed this check — the line above is older than this
      // comment. What it never did was report the RESULT, so the only way to see a
      // rhythm named at the cycle boundary was to click the Pulse check button, which
      // stopped compressions with nothing to restart them. Kim's run: four clicks, one
      // forgotten restart, 67% compression fraction and both scored metrics failed.
      // Clicking it was strictly worse than ignoring it.
      //
      // So the boundary now speaks twice: the pause, then the finding. The learner's job
      // at a rhythm check is to decide shock or no shock, and that decision needs the
      // rhythm said out loud — hence "Shockable — charge."
      //
      // Built from the clock, not a constant: CYCLE_SEC can change and the nurse says
      // whatever has actually elapsed. She only announces stopping compressions when
      // somebody is doing them.
      out.push(ev(state, 'rhythmCheck', 'Cycle ' + state.cycle + ' — ' + spokenTime(state.t) +
        ' on the clock' + (state.cpr ? ', pausing compressions for the pulse check.' : ', pulse check.')));
      // A pause is a pause, and it is paid rather than mimed: the nurse says she is
      // pausing, so the compression fraction must show one. Five seconds, not ten —
      // ten is the guideline CEILING for any interruption, while a team that checks
      // with the defibrillator already charged is off the chest for about five, and
      // this pause is the sim team's, not the learner's. Charging the maximum put the
      // PALS respiratory-arrest case's own model answer at 79% against an 80% bar,
      // which would have taught that a textbook run is substandard CPR.
      // Nothing to subtract if nobody had hands on the chest.
      if(state.cpr) state.cprSecs -= Math.min(5, state.cprSecs);
      out.push(ev(state, 'check', state.pulse
        ? 'I have a pulse' + (heardName(state) ? ' — ' + heardName(state) : '') + ' at ' + state.hr + '.'
        : heardName(state)
          ? 'No pulse — ' + heardName(state) + '. ' +
            (SHOCKABLE.has(state.rhythm) ? 'Shockable — charge.' : 'Not shockable.') + ' Back on the chest.'
          // Uncalled: she reports the pulse, which is hers to report, and leaves the
          // strip to the doctor. Naming it here took the ACLS branch for them.
          : 'No pulse. Rhythm is up on the monitor, doctor — what is it? Back on the chest.'));
      // AFTER the finding: a rosc row that resolves here reads as the consequence of the
      // check, not as something that happened before anyone felt for a pulse.
      out.push(...resolveChecks(state, script));
    }
  }
  out.push(...runDegrade(state, script));
  out.push(...runCrash(state, script));
  out.push(...epiTiming(state, script));
  out.push(...runHints(state, script));
  updateEtco2(state);
  if(script.end && script.end.deathAfterSec != null && state.t >= script.end.deathAfterSec && !state.pulse && !state.ended)
    out.push(...die(state, 'The code has run its course — time of death called.'));
  // Evaluated LAST, after runDegrade/runCrash/the death check have landed this tick's
  // changes. Pushed earlier it reported the state as it was a moment ago, so a callout
  // landing on a crash row had the nurse announcing a perfusing rhythm and a pressure
  // in the same breath as "she has lost her output".
  //
  // Deliberately NOT CYCLE_SEC: that constant is the ACLS rhythm-check interval and it
  // scores the rhythmChecks metric. Newborns are excluded because NRP assesses every
  // thirty seconds, and pacing a player against ninety would teach an interval their
  // algorithm does not use.
  if(!state.pulse || state.ended){
    state.statusT = 0;
  } else if(!(script.patient && script.patient.neonate)){
    state.statusT = (state.statusT || 0) + step;
    if(state.statusT >= STATUS_SEC){
      state.statusT -= STATUS_SEC;
      out.push(ev(state, 'statusCall', statusLine(state)));
    }
  }
  return out;
}

// A rhythm check is where the non-shockable algorithms are decided: the pulse is
// felt at the end of a cycle, not the moment the drug goes in. Firing these rows
// on the drug instead would let a player push epi and get an instant pulse, which
// is the opposite of what two-minute cycles are meant to teach.
function resolveChecks(state, script){
  const out = [];
  for(const r of (script.rosc || [])){
    if(r.rhythm && r.rhythm !== state.rhythm) continue;
    if(r.requires && !r.requires.every(k => hasAction(state, k))) continue;
    if(r.atNextCheck === false) continue;
    out.push(...achieveRosc(state, script, 'algorithm'));
    if(r.to) setRhythm(state, r.to);
    break;
  }
  return out;
}

// Doing nothing has to cost something, or a code has no clock. Each row is the
// deadline after which an untreated rhythm decays, cancelled by any action in
// `unless`.
function runDegrade(state, script){
  const out = [];
  for(const d of (script.degrade || [])){
    if(state.rhythm !== d.from) continue;
    if(state.t < d.afterSec) continue;
    if(d.unless && d.unless.some(k => hasAction(state, k))) continue;
    if(d.to === 'dead'){ out.push(...die(state, d.text)); break; }
    setRhythm(state, d.to);
    // The authored line, when a case supplies one, is the case's own voice and stays.
    // The generated fallback must not name what the doctor has not called.
    out.push(ev(state, 'degrade', d.text ||
      (heardName(state) ? 'Rhythm has deteriorated to ' + rhythmName(d.to) + '.'
                        : 'The rhythm has changed on the monitor, doctor.')));
    break;
  }
  return out;
}

// Non-arrest scripts: vitals slide along `crash.path` until a halting action lands.
// Each row is stamped once — without the stamp a row at atSec 120 would re-apply
// on every later tick and pin the vitals to it forever.
function runCrash(state, script){
  const c = script.crash;
  if(!c || state.ended) return [];
  if(c.halt && c.halt.some(k => hasAction(state, k))) return [];
  const out = [];
  for(const row of (c.path || [])){
    if(state.t < row.atSec || state.flags['_crash' + row.atSec]) continue;
    state.flags['_crash' + row.atSec] = true;
    if(row.hr != null) state.hr = row.hr;
    if(row.bpSys != null){ state.bpSys = row.bpSys; state.bpDia = Math.round(row.bpSys * 0.6); }
    if(row.spo2 != null) state.spo2 = row.spo2;
    if(row.rr != null) state.rr = row.rr;
    if(row.rhythm) setRhythm(state, row.rhythm);
    if(row.arrest){ state.pulse = false; state.phase = 'arrest'; state.rhythm = row.arrest;
      state.cycleT = 0; state.cycle = 1;
      out.push(ev(state, 'arrest', row.text || 'She has lost her pulse.')); }
    else if(row.text) out.push(ev(state, 'crash', row.text));
  }
  return out;
}

// One nudge per dose, not one per second. The guard remembers WHICH dose it has
// already nagged about, so the next epi re-arms it.
// Authored nudges on a timer, each cancelled by the action it exists to prompt.
// From a played PEA arrest: the lung exam named a silent right chest at eight minutes,
// but nothing ever pushed the player toward the Hs and Ts, and the two-minute window
// that decided the case closed in silence. A hint row is
//   { afterSec, unless: ['causeTreated', ...], text }
// and fires once. `unless` uses the same vocabulary as degrade rows, so "the player
// already did it" reads identically in both places.
function runHints(state, script){
  const out = [];
  if(state.ended) return out;
  (script.hints || []).forEach((h, i) => {
    if(state.t < h.afterSec) return;
    if((state.hintsFired || []).indexOf(i) !== -1) return;
    if(h.unless && h.unless.some(k => hasAction(state, k))) return;
    (state.hintsFired = state.hintsFired || []).push(i);
    out.push(ev(state, 'hint', h.text));
  });
  return out;
}

function epiTiming(state, script){
  if(state.pulse || state.ended) return [];
  const rule = (script.drugs && script.drugs.epinephrine) || {};
  const win = rule.everySec || [180, 300];
  if(state.lastEpiT == null) return [];
  if(state.t - state.lastEpiT < win[1]) return [];
  if(state.flags._epiDueAt === state.lastEpiT) return [];
  state.flags._epiDueAt = state.lastEpiT;
  // Remember that a question is open: the player answers "yes", not "epinephrine 1 mg".
  state.pendingQuestion = 'epi';
  return [ev(state, 'epiDue', 'It has been five minutes — do you want another epi?')];
}

// EtCO2 is the one number that tells the player whether the compressions are
// working, so it follows what is happening rather than the script: perfusion
// while hands are on the chest, next to nothing when they come off.
function updateEtco2(state){
  if(state.pulse){ state.etco2 = Math.max(state.etco2, 35); return; }
  state.etco2 = state.cpr ? 12 : 6;
}

// ---------- parsing ----------
// Keeps '.', '/' and '-' because every dose and energy the player types leans on
// them: "0.1 mg/kg", "2 j/kg", "i-gel". Everything else becomes a space so the
// word-boundary patterns below cannot be defeated by punctuation.
function norm(s){ return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9./ -]/g, ' ').replace(/\s+/g, ' ').trim(); }
function num(re, text){ const m = norm(text).match(re); return m ? parseFloat(m[1]) : null; }

// Energy: "shock 200", "200 joules", "charge to 150 and shock", "2 j/kg"
function shockEnergy(text, script){
  const perKg = num(/(\d+(?:\.\d+)?)\s*(?:j|joules?)\s*\/\s*kg/, text);
  if(perKg != null) return perKg * weightOf(script);
  const stated = num(/(\d{2,3})\s*(?:j\b|joules?)/, text);
  if(stated != null) return stated;
  return num(/(?:shock|charge|defibrillate)(?:\s+\w+){0,3}?\s+(\d{2,3})\b/, text);
}

function weightOf(script){ return (script.patient && script.patient.weightKg) || 70; }

// Paediatric defibrillation is a LADDER, not a range: AHA 2025 asks for 2 J/kg
// first, 4 J/kg next, then 4 J/kg or more and never past 10 J/kg or the adult
// dose. Checking the delivered energy against the script's whole [2,10] band
// would wave through 200 J in a 24 kg child — 8 J/kg, four times the first-shock
// energy — and the flag would teach nothing. So the band narrows to the rung the
// player is standing on, with room above it for the escalation the guideline
// allows and a little slack below for a rounded-off number.
function energyBand(script, shockNumber){
  const e = (script.shock && script.shock.energy) || {};
  if(e.perKg){
    // A paediatric range is an ESCALATION LADDER, not a flat band: PALS is 2 J/kg for
    // the first shock, 4 J/kg for the second, and up to 10 J/kg (or the adult dose)
    // from the third on. Treating [2,10] as a flat band would wave through an adult
    // 200 J on a 24 kg child at the very first shock — the error these cases exist to
    // catch. Capping every later shock at 2.5x would do the opposite and flag a
    // guideline-correct 10 J/kg rescue shock, so the ceiling opens up at shock three.
    const kg = weightOf(script);
    const first = e.perKg[0], ceiling = e.perKg[1];
    const hi = shockNumber <= 1 ? Math.min(ceiling, first * 2)
             : shockNumber === 2 ? Math.min(ceiling, first * 3)
             : ceiling;
    return { lo: first * 0.9 * kg, hi: hi * kg,
      says: kg + ' kg (' + first + '-' + ceiling + ' J/kg)' };
  }
  if(e.adult) return { lo: e.adult[0], hi: e.adult[1], says: e.adult[0] + '-' + e.adult[1] + ' J' };
  return null;
}

function deliverShock(state, script, joules){
  const before = state.rhythm;
  const shockable = SHOCKABLE.has(before);
  const j = joules == null ? defaultJoules(script) : joules;
  const band = energyBand(script, state.shocks.length + 1);
  let ok = true, note = '';
  if(!shockable){ ok = false; note = 'Not a shockable rhythm — ' + before + ' is treated with CPR and epinephrine, not electricity.'; }
  else if(band && (j < band.lo || j > band.hi)){ ok = false;
    note = 'Energy out of range: ' + j + ' J for ' + band.says + '.'; }
  const rec = { t: state.t, joules: j, sync: false, rhythmBefore: before, rhythmAfter: before, ok, note };
  state.shocks.push(rec);
  state.cpr = true; state.cycleT = 0;              // compressions resume immediately after a shock
  if(!shockable){
    return [ev(state, 'shock', 'Shock delivered — no change, that rhythm does not respond to electricity.', { ok: false })];
  }
  const row = pickShockResult(state, script);
  const out = [];
  if(row && row.to === 'ROSC'){
    // The converting shock is still a shock: log it before the ROSC line, or the
    // timeline shows a pulse appearing from nowhere and the summary counts one short.
    rec.rhythmAfter = 'ROSC';
    out.push(ev(state, 'shock', 'Shock delivered — organized rhythm on the monitor, checking for a pulse.', { ok }));
    out.push(...achieveRosc(state, script, 'shock'));
  }
  else if(row && row.to){ setRhythm(state, row.to); rec.rhythmAfter = row.to;
    out.push(ev(state, 'shock', 'Shock delivered — ' +
      (heardName(state) ? 'still ' + heardName(state) : 'no change on the monitor') +
      '. Back on the chest.', { ok })); }
  else out.push(ev(state, 'shock', 'Shock delivered — no change on the monitor. Compressions.', { ok }));
  return out;
}

// "Shock him" with no number still has to fire — refusing it would make the
// engine argue with the player instead of showing them the consequence.
function defaultJoules(script){
  const e = (script.shock && script.shock.energy) || {};
  if(e.adult) return e.adult[e.adult.length - 1];
  if(e.perKg) return Math.round(e.perKg[0] * weightOf(script));
  return 200;
}

// First matching row wins; a row with `requires` only matches once every named drug
// or action has been given. Rows are matched at shock number >= n so a late player
// still reaches the converting shock.
function pickShockResult(state, script){
  // Only DEFIBRILLATIONS advance the ladder. Synchronized cardioversions live in the
  // same log (the debrief counts them and their energy is checked) but they are a
  // different intervention: letting one consume a rung would hand the player the
  // scripted converting shock a shock early.
  const nth = state.shocks.filter(x => !x.sync).length;
  const rows = (script.shock && script.shock.results) || [];
  for(const r of rows){
    if(r.n !== nth) continue;
    if(r.requires && !r.requires.every(k => hasAction(state, k))) continue;
    return r;
  }
  let best = null;
  for(const r of rows){ if(r.n <= nth && (!r.requires || r.requires.every(k => hasAction(state, k)))) if(!best || r.n > best.n) best = r; }
  return best;
}

function hasAction(state, key){
  if(key === 'shock') return state.shocks.length > 0;
  if(key === 'cpr') return state.cprSecs > 0;
  if(key === 'causeTreated') return state.causesTreated.length > 0;
  if(state.drugs.some(d => d.name === key)) return true;
  return !!state.flags[key];
}

// The nurse says these out loud, so they are spoken English, not monitor labels.
// READING THE STRIP IS THE LEARNER'S JOB.
//
// Kim: "I would like to be able to interpret the rhythm myself. You are divulging the
// results of the case by calling ventricular fibrillation."
//
// She is right, and it is the whole of ACLS. The monitor caption read
// "RHYTHM: VENTRICULAR FIBRILLATION" from the first second, and the nurse announced
// "No pulse — ventricular fibrillation. Shockable — charge." before the player had
// looked at anything. Every branch the algorithm turns on had already been taken.
//
// So the team no longer names it. The nurse reports what she can feel — no pulse — and
// the strip is on the wall to be read. Once the doctor CALLS it, and calls it right, the
// team adopts the reading and says it out loud from then on: that is what a resuscitation
// sounds like, and it gives the call a consequence.
//
// A rhythm that CHANGES is uncalled again. Nobody gets to keep a stale read.
const RHYTHM_CALLS = {
  VF: /\b(v\s?fib|vfib|ventricular fibrillation|coarse vf|fine vf|\bvf\b)/i,
  pVT: /\b(pulseless v\s?tach|pulseless vt|pulseless ventricular tachycardia)/i,
  VT: /\b(v\s?tach|vtach|ventricular tachycardia|\bvt\b)/i,
  torsades: /\btorsade/i,
  PEA: /\b(pea|pulseless electrical activity|organized rhythm)/i,
  asystole: /\b(asystole|flat\s?line|flatline)/i,
  SVT: /\b(svt|supraventricular)/i,
  AF: /\b(a\s?fib|afib|atrial fibrillation|\baf\b)/i,
  CHB: /\b(complete heart block|third degree|3rd degree|chb)/i,
  'sinus-brady': /\b(sinus brady|bradycardia)/i,
  'sinus-tachy': /\b(sinus tach|sinus tachycardia)/i,
  sinus: /\b(sinus rhythm|normal sinus|nsr)/i,
  '2nd-degree-I': /\b(mobitz i\b|wenckebach)/i,
  '2nd-degree-II': /\b(mobitz ii\b)/i,
  paced: /\bpaced\b/i,
  agonal: /\bagonal\b/i,
};
// Did this order call the rhythm the monitor is actually showing? Longest keys first so
// "pulseless VT" is not read as plain VT, and VF is checked before VT for the same
// reason ("\bvf\b" cannot match inside "pulseless vt", but the order is cheap insurance).
function callsRhythm(text, rhythm){
  const t = String(text || '');
  const re = RHYTHM_CALLS[rhythm];
  if(!re || !re.test(t)) return false;
  // "shockable" alone is a category, not a reading — it is a legitimate call and it
  // narrows the algorithm, but it does not name the rhythm, so it does not reveal it.
  if(rhythm === 'VT' && /pulseless/i.test(t)) return false;      // that is pVT, not VT
  return true;
}
// Every rhythm change makes the doctor's read stale — they call it again. One helper, so
// a future rhythm transition cannot forget to clear it.
function setRhythm(state, to){
  if(to && to !== state.rhythm) state.rhythmCalled = false;
  if(to) state.rhythm = to;
}
// The name, but only once the doctor has earned it.
function heardName(state){
  return state.rhythmCalled ? rhythmName(state.rhythm) : null;
}
function rhythmName(r){
  return ({ VF: 'ventricular fibrillation', pVT: 'pulseless VT', torsades: 'torsades',
    VT: 'ventricular tachycardia',
    PEA: 'an organized rhythm with no pulse', asystole: 'asystole', 'sinus-tachy': 'sinus tachycardia',
    'sinus-brady': 'sinus bradycardia', sinus: 'sinus rhythm', SVT: 'SVT', AF: 'atrial fibrillation',
    CHB: 'complete heart block', agonal: 'an agonal rhythm', paced: 'a paced rhythm',
    '2nd-degree-I': 'Mobitz I', '2nd-degree-II': 'Mobitz II' })[r] || r;
}

function achieveRosc(state, script, via){
  const p = script.postRosc || {};
  state.pulse = true; state.phase = 'rosc';
  setRhythm(state, p.rhythm || 'sinus-tachy');
  state.hr = p.hr || 110; state.bpSys = p.bpSys || 95; state.bpDia = p.bpDia || Math.round((p.bpSys || 95) * 0.6);
  state.spo2 = p.spo2 || 94; state.rr = p.rr || 14; state.etco2 = 38; state.cpr = false;
  state.ended = 'rosc';
  // The moment the arrest ended, kept separately from state.t. Post-arrest orders now
  // advance the clock (see actInner), so reading state.t at summary time would report a
  // ROSC two hours after it happened.
  state.endedT = state.t;
  return [ev(state, 'rosc', 'We have a pulse — ' + rhythmName(state.rhythm) + ', pressure ' + state.bpSys + '.', { via })];
}

function die(state, why){
  state.ended = 'death'; state.endedT = state.t; state.phase = 'dead'; state.pulse = false;
  state.rhythm = 'asystole'; state.hr = 0; state.bpSys = 0; state.bpDia = 0; state.spo2 = 0; state.etco2 = 0;
  return [ev(state, 'death', why || 'No return of spontaneous circulation.')];
}

// ---------- drugs ----------
// Aliases are what a resuscitation lead actually says out loud. Longest-first
// inside each family so "calcium chloride" is not shortened to "calcium" before
// the dose check sees which salt was asked for.
// Milligrams per milliequivalent, for rules that state a dose in mEq. Sodium
// bicarbonate has a molar mass of 84, so 1 mEq is 84 mg and the familiar 8.4%
// ampoule is 1 mEq/mL.
const MEQ_MG = { bicarbonate: 84 };

const DRUG_ALIASES = {
  epinephrine: ['epinephrine', 'epi', 'adrenaline'],
  amiodarone:  ['amiodarone', 'amio', 'cordarone'],
  lidocaine:   ['lidocaine', 'lignocaine'],
  naloxone:    ['naloxone', 'narcan'],
  calcium:     ['calcium chloride', 'calcium gluconate', 'calcium'],
  bicarbonate: ['sodium bicarbonate', 'bicarb', 'bicarbonate'],
  magnesium:   ['magnesium sulfate', 'magnesium', 'mag'],
  adenosine:   ['adenosine', 'adenocard'],
  atropine:    ['atropine'],
  tranexamic:  ['tranexamic acid', 'txa'],
  dextrose:    ['dextrose', 'd50', 'd10'],
  surfactant:  ['surfactant']
};

// A GLUCOSE CHECK IS A MEASUREMENT, NOT A DRUG.
//
// 'glucose' was an alias of dextrose, so "Fingerstick Glucose" and "check a bedside
// glucose" each pushed dextrose into the code record and then penalised it for having no
// weight-based dose — twice, in a 6 kg infant, in Kim's own run, and again on the
// commotio case.
//
// The engine's job here is to get OUT OF THE WAY. Checking the sugar is one of the Hs;
// ten of the eighteen live-code packs already answer it with a value their author wrote
// and three of them credit a critical action for it, while no code script credits
// dextrose at all. So an unclaimed glucose order falls through to the turn engine, which
// answers it from the pack — rather than the code engine inventing a number it was never
// given, which it is not allowed to do.
//
// The verb decides. "Give glucose" is still sugar; "check a glucose" is a fingerstick;
// bare "glucose" is a lab order, which is what a pack answers.
const GLUCOSE_CHECK_RE = /\b(?:fingerstick|finger stick|point of care|poc|bedside|check|checking|recheck|measure|send|draw|obtain|get)\b[^.;]{0,24}\bglucose\b|\bglucose\b[^.;]{0,16}\b(?:check|level|stick)\b|\bdextrostick\b/;
const GLUCOSE_GIVE_RE = /\b(?:give|giving|push|pushing|administer|hang|run|start|amp of)\b[^.;]{0,24}\bglucose\b|\bglucose\b\s+\d/;

function findDrug(text){
  const s = norm(text);
  if(GLUCOSE_GIVE_RE.test(s)) return 'dextrose';
  if(GLUCOSE_CHECK_RE.test(s)) return null;
  for(const name of Object.keys(DRUG_ALIASES))
    for(const a of DRUG_ALIASES[name])
      if(new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(s)) return name;
  return null;
}

// Dose: "1 mg", "0.1 mg/kg", "300 mg", "2 g", "10 ml/kg"
function parseDose(text, script){
  const kg = weightOf(script);
  // Milliequivalents first: bicarbonate is ordered in mEq at the bedside, and "1 mEq/kg"
  // must not fall through to a pattern that reads it as milligrams. norm() lowercases,
  // so mEq arrives here as "meq".
  const meqPerKg = num(/(\d+(?:\.\d+)?)\s*meq\s*\/\s*kg/, text);
  if(meqPerKg != null) return { mg: null, mEq: meqPerKg * kg, perKg: meqPerKg, stated: 'mEqPerKg' };
  const meq = num(/(\d+(?:\.\d+)?)\s*meq\b/, text);
  if(meq != null) return { mg: null, mEq: meq, stated: 'mEq' };
  const perKg = num(/(\d+(?:\.\d+)?)\s*mg\s*\/\s*kg/, text);
  if(perKg != null) return { mg: perKg * kg, perKg, stated: 'perKg' };
  const mcg = num(/(\d+(?:\.\d+)?)\s*(?:mcg|micrograms?|ug)\b/, text);
  if(mcg != null) return { mg: mcg / 1000, stated: 'mcg' };
  const g = num(/(\d+(?:\.\d+)?)\s*g\b/, text);
  if(g != null) return { mg: g * 1000, stated: 'g' };
  const mg = num(/(\d+(?:\.\d+)?)\s*mg\b/, text);
  if(mg != null) return { mg, stated: 'mg' };
  return { mg: null, stated: null };
}

function giveDrug(state, script, name, text){
  const rule = (script.drugs && script.drugs[name]) || {};
  const kg = weightOf(script);
  const dose = parseDose(text, script);
  const route = /\bio\b|intraosseous/.test(norm(text)) ? 'io'
              : /\biv\b|intravenous/.test(norm(text)) ? 'iv'
              : /\bet\b|down the tube|endotracheal/.test(norm(text)) ? 'et'
              : /\bim\b|intramuscular/.test(norm(text)) ? 'im' : null;
  let ok = true, note = '';

  // expected dose in mg: per-kg rule wins for children and neonates
  let want = null;
  if(rule.perKg != null) want = rule.perKg * kg;
  else if(rule.mg != null) want = rule.mg;
  // Amiodarone's standard dose depends on whether there is a pulse: 300 mg push (then
  // 150) in VF/pVT arrest, but 150 mg over ten minutes for a tachycardia that is still
  // perfusing. One expected value for both taught players to push 300 at a patient
  // with a blood pressure.
  else if(name === 'amiodarone') want = state.pulse ? (rule.perfusing || 150)
    : (state.amioDoses === 0 ? (rule.first || 300) : (rule.second || 150));
  // Epinephrine's fixed 1 mg is the ARREST expectation. With a pulse (and no
  // weight-based rule — PALS bradycardia legitimately doses 0.01 mg/kg at a pulse)
  // there is no single right number: push-dose runs 10-20 mcg and infusions are
  // titrated, so the range check stands down and the arrest-bolus flag above is the
  // only line — a milligram at a perfusing patient is the error worth catching.
  if(name === 'epinephrine' && state.pulse && rule.perKg == null) want = null;
  else if(name === 'adenosine') want = state.drugs.some(d => d.name === 'adenosine') ? (rule.second || 12) : (rule.first || 6);

  // A rule may state its dose in milliequivalents. Bicarbonate is the only drug here
  // that is: paediatric arrest dosing is 1 mEq/kg, and 1 mEq of NaHCO3 is 84 mg (an
  // 8.4% ampoule is 1 mEq/mL). Without this the engine compared 1 mg/kg against a dose
  // given in mEq, refused the correct answer and accepted an eighty-four-fold underdose.
  const unit = rule.unit === 'mEq' ? 'mEq' : 'mg';
  const given = unit === 'mEq'
    ? (dose.mEq != null ? dose.mEq : (dose.mg != null && MEQ_MG[name] ? dose.mg / MEQ_MG[name] : null))
    : (dose.mg != null ? dose.mg : (dose.mEq != null && MEQ_MG[name] ? dose.mEq * MEQ_MG[name] : null));

  if(want != null && given != null){
    const lo = want * 0.8, hi = want * 1.25;
    if(given < lo || given > hi){ ok = false;
      note = 'Dose out of range: ' + round2(given) + ' ' + unit + ' — expected about ' + round2(want) + ' ' + unit
           + (rule.perKg != null ? ' (' + rule.perKg + ' ' + unit + '/kg × ' + kg + ' kg)' : '') + '.'; }
  } else if(want != null && given == null && (script.patient && (script.patient.child || script.patient.neonate))){
    // An adult can be given "an amp of epi" and everyone knows what that is. A
    // child cannot: the number IS the order, and leaving it out is the error.
    ok = false; note = 'No dose stated — a child needs a weight-based dose (' + (rule.perKg != null ? rule.perKg + ' ' + unit + '/kg' : round2(want) + ' ' + unit) + ').';
  }

  if(name === 'epinephrine' && state.pulse && dose.mg != null && dose.mg >= 0.5){
    ok = false;
    note = (note ? note + ' ' : '') + 'That is a cardiac-arrest dose at a patient with a pulse — ' +
      'push-dose epinephrine is 10-20 mcg, or run an infusion.';
  }
  // ARREST RULES ARE FOR THE ARREST. Kim's crush case names treating the hyperkalaemia as
  // a critical action; she gave bicarbonate after ROSC and it was flagged four times with
  // the case's own note, which actually ENDORSES it ("Adjunct for a hyperkalaemic arrest").
  // The engine has no post-arrest drug rules, so applying the arrest ones is applying the
  // wrong rule — worse than applying none. The checks that are about the PATIENT rather
  // than the phase (a missing weight-based dose, an arrest dose at a perfusing patient, a
  // route, a drug wrong for the rhythm) still apply throughout.
  const inArrest = !state.ended;
  if(inArrest && name === 'epinephrine' && state.lastEpiT != null){
    const gap = state.t - state.lastEpiT, win = rule.everySec || [180, 300];
    if(gap < win[0]){ ok = false; note = (note ? note + ' ' : '') + 'Only ' + Math.round(gap) + ' s since the last dose — epinephrine goes every ' + (win[0]/60) + '-' + (win[1]/60) + ' minutes.'; }
  }
  // Right drug, wrong rhythm. Adenosine into atrial fibrillation and amiodarone into a
  // long QT are two of the errors these cases exist to rehearse, and until the script
  // could say so they were recorded as correct and cost the player nothing.
  // Routine bicarbonate in arrest is not recommended (AHA 2025): it is for hyperkalaemia,
  // a sodium-channel-blocker overdose or a known severe metabolic acidosis. A script
  // that wants it says `indicated: true`; otherwise the dose is delivered and flagged.
  if(inArrest && name === 'bicarbonate' && !rule.indicated){ ok = false;
    note = (note ? note + ' ' : '') + (rule.note || 'Bicarbonate is not part of routine arrest care — it is for hyperkalaemia, a sodium-channel-blocker overdose or a known severe acidosis.'); }
  // Read once and used twice — here to flag the dose, and below to stop it converting the
  // rhythm it is wrong for. Two copies of the condition could be edited apart.
  const wrongForRhythm = !!(rule.wrongFor && rule.wrongFor.indexOf(state.rhythm) !== -1);
  if(wrongForRhythm){ ok = false;
    note = (note ? note + ' ' : '') + (rule.wrongForNote ||
      (capitalize(name) + ' is the wrong drug for ' + rhythmName(state.rhythm) + '.')); }
  if(inArrest && name === 'amiodarone' && state.rhythm === 'asystole'){ ok = false;
    note = (note ? note + ' ' : '') + 'Amiodarone is for a shockable rhythm; this is asystole.'; }
  if(name === 'magnesium' && state.rhythm === 'torsades') ok = true;
  if(rule.route && route && rule.route.indexOf(route) === -1){ ok = false;
    note = (note ? note + ' ' : '') + 'Give it ' + rule.route.join(' or ').toUpperCase() + '.'; }

  const rec = { t: state.t, name, doseMg: dose.mg, route, ok, note };
  state.drugs.push(rec);
  if(name === 'epinephrine'){ state.lastEpiT = state.t; state.pendingQuestion = null; }
  if(name === 'amiodarone') state.amioDoses += 1;
  state.flags[name] = true;

  const out = [ev(state, 'drug', capitalize(name) + spokenDose(dose) + ' is in.', { ok, name })];
  // A DOSE THAT IS WRONG FOR THIS RHYTHM DOES NOT CONVERT IT. The record already says
  // ok:false; letting the conversion rule fire regardless taught that adenosine converts
  // atrial fibrillation — the one thing the script's own wrongForNote says it cannot do.
  if(!wrongForRhythm) out.push(...checkConversion(state, script, name));
  return out;
}

// SAY THE DOSE THE WAY IT WAS ORDERED. An amp of D50 is 25 g; reading it back as
// "Dextrose 25000 mg is in" makes a correct order sound like a decimal error at the one
// moment nobody has time to do the arithmetic. Milliequivalents are what bicarbonate is
// ordered in at the bedside, so they are read back that way too. The record still stores
// milligrams — only the sentence changes.
function spokenDose(dose){
  if(!dose) return '';
  if(dose.mEq != null) return ' ' + round2(dose.mEq) + ' mEq';
  if(dose.mg == null) return '';
  if(dose.mg >= 1000) return ' ' + round2(dose.mg / 1000) + ' g';
  return ' ' + round2(dose.mg) + ' mg';
}

function round2(x){ return Math.round(x * 100) / 100; }
function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

// A drug can convert a peri-arrest rhythm on its own (magnesium for torsades,
// adenosine for SVT) — the script's `convert` rows say so.
function checkConversion(state, script, action){
  const rows = (script.convert || []);
  for(const r of rows){
    if(r.rhythm && r.rhythm !== state.rhythm) continue;
    if(r.action !== action) continue;
    if(r.nth != null && state.drugs.filter(d => d.name === action).length !== r.nth) continue;
    if(r.requires && !r.requires.every(k => hasAction(state, k))) continue;
    if(r.to === 'ROSC') return achieveRosc(state, script, action);
    setRhythm(state, r.to);
    // `pulse` is a deliberate authoring decision, never a side effect. It used to
    // default to TRUE, so a row written to say "nothing changed" — amiodarone in
    // torsades, atropine in complete block — quietly resuscitated a pulseless
    // patient. Omit it and the pulse is left exactly as it was.
    if(r.pulse === true){ state.pulse = true; state.phase = 'stable'; }
    else if(r.pulse === false){ state.pulse = false; state.phase = 'arrest'; }
    if(r.hr != null) state.hr = r.hr;
    if(r.bpSys != null){ state.bpSys = r.bpSys; state.bpDia = Math.round(r.bpSys * 0.62); }
    if(r.spo2 != null) state.spo2 = r.spo2;
    if(r.ends) state.ended = r.ends;
    // The author writes what the nurse says. Without this, every conversion — and
    // every deliberate NON-conversion — came out as the same flat sentence.
    return [ev(state, 'convert', r.text || ('Rhythm is now ' + rhythmName(r.to) + '.'), { via: action })];
  }
  return [];
}

function epiOrderFor(script){
  const r = (script.drugs || {}).epinephrine || {};
  const kg = weightOf(script);
  const mg = r.perKg != null ? Math.round(r.perKg * kg * 100) / 100 : (r.mg || 1);
  return 'epinephrine ' + mg + ' mg IV';
}

// A withheld order is not an order. Same vocabulary the narrative engine uses
// (instant-engine.js WITHHOLD_RE), anchored to the START of the order so "hold
// compressions" — a real instruction — is untouched while "hold the decompression" is
// not performed. Found by audit: "do not decompress the chest", "hold the needle
// decompression" and "no chest tube" each marked the tension pneumothorax treated,
// credited the critical action, and unlocked the ROSC path. The learner is told they
// did the one thing they explicitly refused to do.
// HOLDING PRESSURE IS AN ORDER, NOT A REFUSAL. "Hold direct pressure" is how the
// haemorrhage-control order is said out loud in a trauma bay, and the withhold guard read
// the leading verb and answered "Holding off on that, doctor" — the sim declining the one
// thing the player had just asked for. Only "hold pressure" exactly was safe, because the
// blunt-trauma pack happens to author that phrase; "hold direct pressure", "hold firm
// pressure", "holding manual pressure" were all refusals. "Hold off pressure" is still a
// refusal: the exemption needs the word pressure to follow the verb (through an article
// and an adjective, not through "off").
const CODE_WITHHOLD_RE = /^\s*(?:(?:ok(?:ay)?|fine|alright|right|yeah|yes|actually|wait|no wait)[\s,-]+)*(no|not|hold(?!\s+(?:on\b|(?:the\s+)?(?:direct|firm|manual|steady|continuous|constant|hard)?\s*pressure\b))|holding(?!\s+(?:the\s+)?(?:direct|firm|manual|steady|continuous|constant|hard)?\s*pressure\b)|hold off|holding off|stop|stopping|discontinue|discontinuing|withhold|withholding|avoid|avoiding|defer|deferring|skip|skipping|omit|omitting|scrap|scratch|cancel|don'?t|dont|do not|without|refrain from|no need for|not giving|never mind|forget)\b/i;
// "hold cpr" / "hold compressions" / "hold the pacer" are instructions to the team, not
// refusals — the engine has explicit branches for them and they must reach those.
// "stop" and "discontinue" were missing from the list above, which made the most
// natural way to call a drug off mid-arrest do the opposite: "stop the epinephrine"
// pushed epinephrine, "stop the amiodarone" pushed amiodarone, and the nurse answered
// "Epinephrine is in." The same order phrased "hold the epinephrine" correctly held,
// so the gap was invisible unless you happened to say it the other way.
//
// Adding them is safe only because CODE_HOLD_ACTION_RE below is checked FIRST and wins:
// "stop compressions" and "stop the pacing" are instructions to stop something already
// running, not refusals of something not yet started, and they must keep working.
// A case may author a TREATMENT in refusal-shaped language. Torsades from a long QT is
// treated by STOPPING the offending drug, and resus-acls-torsades writes its cause
// phrases exactly that way: "stop the methadone", "hold the ondansetron", "stop all qt
// prolonging". Those are orders, and the refusal guard swallowed them — "hold the
// methadone" has been dead since the guard shipped, and adding "stop" to it would have
// killed the rest of the list too. The case's own authored phrases are the authority on
// what counts as treating its cause.
//
// Guarded on the LEADING verb so a real refusal of that same treatment still refuses:
// the player's line has to open with the verb the author used, which "stop the
// methadone" does and "don't stop the methadone" does not.
// After ROSC the patient has a pulse, and three orders become wrong rather than merely
// unnecessary: an unsynchronised shock, chest compressions, and cardioversion of a
// perfusing sinus rhythm. Everything else the engine models — airway, capnography,
// access, drugs (which carry their own perfusing-patient dose checks), the pulse check,
// pacing, treating a reversible cause — is exactly what post-arrest care consists of.
//
// Matched on the same shapes the performing branches use, so a phrase that would have
// reached one of those three branches is the phrase that gets refused here.
const POST_ROSC_REFUSE = [
  [/\b(defibrillat\w*|defib|shock|clear and shock|zap|dsed)\b/, 'There is a pulse, doctor — no shock.'],
  [/\b(start|resume|continue|begin)\b.*\b(cpr|compressions)\b|\bcpr\b|\bcompressions\b|\bhands on the chest\b/,
   'There is a pulse and a pressure — no compressions.'],
];
function postRoscAllows(s){
  // A stop/hold order is always allowed through: it is an instruction to the team about
  // something already running, and refusing it would strand a pacer or a bag.
  if(CODE_HOLD_ACTION_RE.test(s)) return true;
  for(const [re] of POST_ROSC_REFUSE) if(re.test(s)) return false;
  return true;
}
function postRoscRefusal(state, s){
  for(const [re, text] of POST_ROSC_REFUSE) if(re.test(s)) return ev(state, 'withheld', text);
  return ev(state, 'withheld', 'There is a pulse, doctor.');
}
function codeStopIsTreatment(script, s){
  const hit = matchCause(script, s);
  if(!hit || !CODE_WITHHOLD_RE.test(hit.phrase)) return false;
  const verb = norm(hit.phrase).split(' ')[0];
  return new RegExp('^' + verb + '\\b').test(s);
}
const CODE_HOLD_ACTION_RE = /^\s*(?:hold|holding|stop|stopping|pause|pausing)\s+(?:the\s+)?(cpr|compressions|chest compressions|pacing|pacer|bagging|ventilation|ventilations)\b/i;

function actInner(state, script, text, now){
  // EVERYTHING AFTER ROSC USED TO CARRY THE ROSC TIMESTAMP.
  //
  // tick() returns early once the case has ended, so state.t stops. Kim's crush report
  // shows four bicarbonates, two IV lines and a chest tube all at 12:00, given across the
  // next 110 minutes of her run; the opioid reports show the same at 4:00. The caller
  // knows the real clock — fireCodeOrder passes it — and only ever moves it forward.
  if(state.ended && typeof now === 'number' && isFinite(now) && now > state.t) state.t = now;
  // THE ENGINE DOES NOT RETIRE AT ROSC.
  //
  // This was a blanket `if(state.ended) return {handled:false}`, and achieveRosc sets
  // ended='rosc' BEFORE the handoff, so from the instant a pulse came back the code
  // engine refused every order: airway, capnography, access, drugs, the pulse check,
  // all of it. Kim intubated at T+12 on a case whose credits map says airway/ett/sga/
  // capnography all satisfy critical action 4, and the debrief still marked "Secure the
  // airway and confirm it with waveform capnography" MISSED — because the order never
  // reached the engine, and no live-code pack has an airway responder to catch it.
  //
  // Post-arrest care IS the resuscitation. Securing the airway after ROSC is the
  // standard next move, not an epilogue. So the engine keeps answering; it simply
  // refuses the things a patient with a pulse must not be given.
  if(state.ended === 'death') return { handled: false };
  let s = norm(text);
  // A NUMBER OF JOULES, ON ITS OWN, IS AN ORDER FOR ELECTRICITY.
  // Kim's atrial-fibrillation run typed "use 200 j" after "cardiovert" had already
  // failed her; it matched no branch and came back "I didn't understand". A doctor who
  // has just been asked how much energy answers with the energy. Which therapy it means
  // is not ambiguous and never a matter of guessing: with a pulse it is a synchronized
  // cardioversion, without one it is a shock — the same rule the two branches below
  // already encode. The unit is required, so "give 200 mg" and "sats 200" cannot reach
  // this, and the clause must be nothing BUT the energy.
  // ...and so is a weight-based one. Kim's commotio run signed "Defibrillate" and "4J/kg"
  // as one basket, and 4 J/kg for a 24 kg child — the second-shock energy her own critical
  // action asks for — reached no branch at all and was lost.
  if(/^(?:use |give |deliver |do |try |go to |charge to |at )?\d+(?:\.\d+)?\s*(?:j|joules?)\s*\/\s*kg$/.test(s)){
    s = (state.pulse ? 'synchronized cardioversion at ' : 'defibrillate at ') + s.replace(/^[a-z ]*/, '');
  } else if(/^(?:use |give |deliver |do |try |go to |charge to |at )?\d{2,3}\s*(?:j|joules?)$/.test(s)){
    s = (state.pulse ? 'synchronized cardioversion at ' : 'defibrillate at ') + s.replace(/^\D+/, '');
  }
  // ...and so does a patient the case converted to 'stable'. Only 'rosc' was gated, so
  // after Kim's cardioversion an unsynchronized shock still reached deliverShock and was
  // logged as a delivered-but-flagged shock at a perfusing patient.
  if(state.ended && state.ended !== 'death' && !postRoscAllows(s))
    return { handled: true, events: [postRoscRefusal(state, s)] };
  // The nurse asks questions ("do you want another epi?") and a doctor answers them
  // with a word. "yes" used to fall through to the turn engine and do nothing — a
  // playtested run typed it twice and lost both turns. A bare yes/no is only ever an
  // answer to the last open question; with none open it stays unhandled.
  // A withheld order is not an order, and this must sit ABOVE every branch that
  // performs something — placed lower, "hold the shock" still shocked, because
  // defibrillation is matched first. The one exemption is holding an action already
  // running (compressions, pacing): that is an instruction to the team, not a refusal.
  // A bare "no"/"not yet" is the ANSWER to the nurse's open question and belongs to the
  // decline branch below, which consumes the question. Guarding it here left the
  // question open, so a later "yes" gave an epi nobody had just been offered.
  if(CODE_WITHHOLD_RE.test(text) && !CODE_HOLD_ACTION_RE.test(text)
     && !codeStopIsTreatment(script, s)
     && !/^(no|nope|not yet|hold|hold it|hold off|wait|not now)[.! ]*$/.test(s)){
    return { handled: true, events: [ev(state, 'withheld', 'Holding off on that, doctor.')] };
  }
  if(/^(yes|yeah|yep|yup|ok|okay|sure|please|go ahead|do it|go|give it|another one|another round)[.! ]*$/.test(s)){
    if(state.pendingQuestion === 'epi'){
      state.pendingQuestion = null;
      return { handled: true, events: giveDrug(state, script, 'epinephrine', epiOrderFor(script)) };
    }
    return { handled: false };
  }
  if(/^(no|nope|not yet|hold|hold it|hold off|wait|not now)[.! ]*$/.test(s)){
    if(state.pendingQuestion === 'epi'){
      state.pendingQuestion = null;
      return { handled: true, events: [ev(state, 'note', 'Holding the epinephrine for now.')] };
    }
    return { handled: false };
  }
  // Defibrillation, but never cardioversion: a synchronized shock is a different
  // order with a different energy ladder and its own conversion rows, and letting
  // the word "shock" inside "synchronized shock" reach the defibrillation table
  // would silently deliver an unsynchronized shock to a patient with a pulse.
  // The exclusion needs its word boundary: a bare /synchroni[sz]ed/ also fires
  // inside "UNsynchronized shock", which is the one phrase that means defibrillate
  // and nothing else — the SVT case scores the player for saying it by mistake.
  // "defibrillation" (the noun) and double/dual sequential defibrillation — DSED — are
  // both shocks. AHA 2025: DSED may be considered for VF refractory to standard
  // defibrillation, so the order gets a shock and an honest line, not silence.
  if(/\b(defibrillat\w*|defib|shock|clear and shock|zap|dsed)\b/.test(s) && !/\b(synchroni[sz]ed|sync)\b|cardiover/.test(s)){
    const dsed = /\b(double|dual)\b.*\bsequential\b|\bdsed\b|\bsequential (defib|shock)/.test(s);
    const out = deliverShock(state, script, shockEnergy(text, script));
    if(dsed && out.length) out[0].text = 'Double sequential defibrillation — second set of pads anterior-posterior, both charged, fired together. ' + out[0].text;
    return { handled: true, events: out };
  }
  // CPR
  if(/\b(start|resume|continue|begin)\b.*\b(cpr|compressions)\b|\bcpr\b|\bcompressions\b|\bhands on the chest\b/.test(s) && !/\b(stop|hold|pause)\b/.test(s)){
    state.cpr = true;
    return { handled: true, events: [ev(state, 'cpr', 'Compressions running — hard and fast, full recoil.', { on: true })] };
  }
  if(/\b(stop|hold|pause)\b.*\b(cpr|compressions)\b/.test(s)){
    state.cpr = false;
    return { handled: true, events: [ev(state, 'cpr', 'Compressions held.', { on: false })] };
  }
  // Stopping the pacer and holding ventilations are the twins of the line above, and
  // they have to sit ABOVE their own start branches — those match on the bare word
  // ("pacing", "ventilations") and would otherwise turn the thing on when asked to turn
  // it off. Both are reversible: ordering it again starts it again.
  if(/\b(stop|stopping|hold|holding|pause|pausing|turn off|discontinue)\b.*\b(pacing|pacer|tcp|transcutaneous)\b/.test(s)){
    state.flags.pacing = false;
    return { handled: true, events: [ev(state, 'pacing', 'Pacer off.', { on: false })] };
  }
  // The airway itself stays where it is — holding ventilations does not pull the tube.
  if(/\b(stop|stopping|hold|holding|pause|pausing|turn off|discontinue)\b.*\b(bag\w*|bvm|ventilat\w*|ppv|positive pressure)\b/.test(s)){
    state.flags.ppv = false;
    return { handled: true, events: [ev(state, 'airway', 'Holding ventilations, doctor.', { on: false })] };
  }
  // rhythm / pulse check
  if(/\b(pulse check|rhythm check|check (for )?a? ?pulse|check the rhythm|feel for a pulse|is there a pulse|any pulse|do we have a pulse|palpate a pulse)\b/.test(s)){
    state.checksDone += 1;   // NOT state.cpr = false: see the boundary block in tick()
    const out = [ev(state, 'check', state.pulse
      ? 'I have a pulse' + (heardName(state) ? ' — ' + heardName(state) : '') + ' at ' + state.hr + '.'
      : heardName(state)
        ? 'No pulse — ' + heardName(state) + '. ' +
          (SHOCKABLE.has(state.rhythm) ? 'Shockable — charge.' : 'Not shockable.') + ' Back on the chest.'
        : 'No pulse. Rhythm is up on the monitor, doctor — what is it? Back on the chest.')];
    out.push(...resolveChecks(state, script));
    return { handled: true, events: out };
  }
  // Reversible causes come before the drug lookup because the script names them
  // in the case author's own words, and an author may well name a drug ("calcium
  // for the hyperkalaemia") as the treatment for a cause.
  {
    const hit = matchCause(script, s);
    if(hit){ if(state.causesTreated.indexOf(hit.cause) === -1) state.causesTreated.push(hit.cause);
      state.flags[hit.cause] = true;
      const out = [ev(state, 'cause', hit.phrase.charAt(0).toUpperCase() + hit.phrase.slice(1) + ' done.', { cause: hit.cause })];
      out.push(...checkConversion(state, script, hit.cause));
      return { handled: true, events: out }; }
  }
  // Drugs beat airway and access on purpose. "Epi 1 mg IO" and "epi down the
  // tube" name a route, not a procedure; with the access branch first they were
  // logged as placing an IO and the dose vanished from the code record.
  {
    const d = findDrug(s);
    if(d) return { handled: true, events: giveDrug(state, script, d, text) };
  }
  // airway
  // The stems take \w* rather than a closing \b: "capnograph\b" cannot match
  // "capnography" at all, because there is no boundary between the h and the y.
  if(/\b(bag|bvm|bag valve mask|bag mask|ventilat\w*|positive pressure|ppv)\b/.test(s) && state.airway === 'none'){
    state.airway = 'bvm'; state.flags.ppv = true;
    return { handled: true, events: [ev(state, 'airway', 'Bagging at ten a minute, good chest rise.')] };
  }
  if(/\b(lma|igel|i-gel|supraglottic|king tube)\b/.test(s)){
    state.airway = 'sga'; state.flags.ppv = true;
    return { handled: true, events: [ev(state, 'airway', 'Supraglottic airway is in.')] };
  }
  if(/\b(intubate|intubation|ett|endotracheal tube|rsi)\b/.test(s)
     || (/\b(et tube|tube (him|her|the patient|them))\b/.test(s) && !/\bchest tube\b/.test(s))){
    state.airway = 'ett'; state.flags.ppv = true;   // a tube is a route for ventilation
    // The nurse asks for the confirmation rather than assuming it. The credits map lets
    // the tube alone satisfy the airway action, as the case authors wrote it, so this
    // withholds nothing the player earned — it just refuses to let the sim imply that a
    // tube is confirmed because it went in.
    return { handled: true, events: [ev(state, 'airway',
      state.capnography ? 'Tube is in, equal breath sounds — waveform trace confirms it.'
                        : 'Tube is in, equal breath sounds — get waveform capnography on it.')] };
  }
  if(/\b(capnograph\w*|capno|etco2|end tidal)\b/.test(s)){
    state.capnography = true;
    return { handled: true, events: [ev(state, 'airway', 'Waveform capnography on — EtCO2 ' + state.etco2 + '.')] };
  }
  // access
  if(/\b(io|intraosseous)\b/.test(s)){ state.io = true; state.ivAccess = true;
    return { handled: true, events: [ev(state, 'access', 'IO is in the tibia, flushed.')] }; }
  if(/\b(iv access|large bore|two large bore|peripheral iv|start an iv|iv line|get a line|place a line|get access|vascular access)\b/.test(s)
     || /^\s*iv\s*$/.test(s)){ state.ivAccess = true;
    return { handled: true, events: [ev(state, 'access', 'Two large-bore IVs are in.')] }; }
  // synchronized cardioversion / pacing / vagal — peri-arrest conversions.
  // "cardiovert" is not a substring of "cardioversion" (…vers…, not …vert…), and
  // "cardioversion" is how the order is actually written.
  if(/\b(synchroni[sz]ed|sync)\b.*\b(shock|cardiover)|\bcardiover(?:t|s)|\b(synchroni[sz]ed|sync)\b\s*(at\s*)?\d{2,3}\b/.test(s)){
    // A synchronized shock is a real intervention with a real energy: it belongs in the
    // shock log so the debrief can count it, and its energy must be checked against the
    // script's own sync band (50-100 J narrow regular, 120-200 J for AF, 0.5-1 J/kg in
    // a child) — it used to accept any number in silence. `sync:true` keeps it out of
    // the defibrillation ladder, which escalates on a different rule entirely.
    // NOTHING TO CARDIOVERT IS A REFUSAL, NOT A FLAGGED SHOCK.
    //
    // Kim's atrial-fibrillation run converted at 4:06 and her next three orders —
    // "Cardiovert", "cardiovert", "use 200 j" — each DELIVERED a synchronized shock into
    // a sinus rhythm at 92 and each earned the same penalty line, printed three times,
    // for a code that was otherwise run well. A record of a shock that should never have
    // been delivered is worse than no record: it is in the code sheet, in the debrief and
    // in the quality score, and the learner is charged for a repeated click the simulator
    // should have caught.
    //
    // A pulseless rhythm is deliberately NOT refused here: there, electricity is the right
    // idea and only the modality is wrong, so the shock is delivered and flagged and the
    // note teaches the difference. With a pulse and no tachyarrhythmia there is nothing to
    // fix, and the machine should not charge.
    if(state.pulse && !CARDIOVERTABLE.has(state.rhythm))
      return { handled: true, events: [ev(state, 'withheld',
        'There is a pulse and ' + rhythmName(state.rhythm) + ' at ' + state.hr +
        ' — nothing to cardiovert, doctor.')] };
    const kg = weightOf(script);
    // A CHILD WITH NO AUTHORED SYNC BAND IS STILL A CHILD. The range check only ran when
    // the script declared one, and not one paediatric script did — so 100 J into a 6 kg
    // infant, twenty times the starting dose in that case's own learning point, was
    // accepted in silence. PALS synchronized cardioversion is 0.5-1 J/kg escalating to
    // 2 J/kg; the band below is that, and it is a clinical statement for review.
    const e = (script.shock && script.shock.sync) || (kg < 40 ? { perKg: [0.5, 2] } : null);
    const joules = shockEnergy(text, script) || (e ? (e.perKg ? Math.round(e.perKg[0] * kg) : e[0]) : 100);
    let ok = true, note = '';
    if(e){
      const lo = e.perKg ? e.perKg[0] * 0.9 * kg : e[0], hi = e.perKg ? e.perKg[1] * 1.1 * kg : e[1];
      if(joules < lo || joules > hi){ ok = false;
        note = 'Energy out of range for a synchronized shock: ' + joules + ' J, expected ' +
          (e.perKg ? (e.perKg[0] + '-' + e.perKg[1] + ' J/kg for ' + kg + ' kg') : (e[0] + '-' + e[1] + ' J')) + '.'; }
    }
    if(!state.pulse){ ok = false;
      note = (note ? note + ' ' : '') + 'There is no pulse to synchronize to — a pulseless rhythm needs unsynchronized defibrillation.'; }
    else if(state.hr > 0 && state.hr < 100){ ok = false;
      note = (note ? note + ' ' : '') + 'The rate is ' + state.hr +
        ' — this is not a rate-related emergency, so there is nothing cardioversion can fix.'; }
    const rec = { t: state.t, joules: joules, sync: true, rhythmBefore: state.rhythm, rhythmAfter: state.rhythm, ok, note };
    state.shocks.push(rec);
    state.flags.cardioversion = true;
    const out = [ev(state, 'cardiovert', 'Synchronized shock at ' + joules + ' J delivered.', { ok })];
    out.push(...checkConversion(state, script, 'cardioversion'));
    rec.rhythmAfter = state.rhythm;
    return { handled: true, events: out };
  }
  if(/\b(pace|pacing|transcutaneous|tcp|pacer)\b/.test(s)){
    state.flags.pacing = true;
    const out = [ev(state, 'pacing', 'Pacer on — capture at 70.')];
    out.push(...checkConversion(state, script, 'pacing'));
    return { handled: true, events: out };
  }
  if(/\b(vagal|valsalva|ice to the face|carotid massage)\b/.test(s)){
    state.flags.vagal = true;
    const out = [ev(state, 'vagal', 'Vagal manoeuvre — no change on the monitor.')];
    out.push(...checkConversion(state, script, 'vagal'));
    return { handled: true, events: out };
  }
  return { handled: false };
}

function matchCause(script, s){
  const acts = (script.causes && script.causes.actions) || {};
  for(const cause of Object.keys(acts))
    for(const p of acts[cause]) if(s.indexOf(norm(p)) !== -1) return { cause, phrase: p };
  return null;
}

// ---------- metrics ----------
// Every row carries the guideline line it teaches, so the debrief can say WHY a
// cross is a cross instead of just scoring it.
function summary(state, script){
  const m = [];
  const shockable = SHOCKABLE.has((script.start || {}).rhythm);
  const first = state.shocks[0];
  if(shockable) m.push({ name: 'timeToFirstShock', value: first ? first.t : null, ok: !!first && first.t <= 120,
    detail: first ? 'First shock at ' + fmt(first.t) : 'Never defibrillated',
    teach: 'Defibrillate a shockable rhythm as soon as the pads are on — every minute of delay costs survival.' });
  // Denominator: the pulseless time for an arrest, otherwise the time since compressions
  // began. A case where compressions were never indicated is not scored on them at all —
  // failing a metric the algorithm did not ask for is not teaching, it is noise.
  const cprWindow = state.pulselessSecs > 0 ? state.pulselessSecs
                  : (state.firstCprT != null ? Math.max(1, state.t - state.firstCprT) : 0);
  const frac = cprWindow > 0 ? Math.round(state.cprSecs / cprWindow * 100) / 100 : 0;
  if(cprWindow > 0) m.push({ name: 'cprFraction', value: frac, ok: frac >= 0.8,
    detail: Math.round(frac * 100) + '% of the pulseless time had compressions running',
    teach: 'Chest compression fraction should be at least 80% — minimise every pause.' });
  const epi = state.drugs.filter(d => d.name === 'epinephrine');
  // Only scored where the algorithm actually wants adrenaline. A stable SVT converted
  // with adenosine must not lose points for the epinephrine it correctly withheld.
  // Scored on what the player DID with adrenaline, not on whether they reached for it.
  // A case answered correctly with magnesium, pacing or adenosine must not lose code
  // points for the epinephrine it rightly withheld — and a case that genuinely needed
  // it already loses the far larger critical-action credit for missing it.
  const epiIndicated = epi.length > 0;
  if(epiIndicated) m.push({ name: 'epiInterval', value: epi.length, ok: epi.length > 0 && epi.every(d => d.ok),
    detail: epi.length ? epi.length + ' dose(s), ' + epi.filter(d => !d.ok).length + ' off-interval or off-dose' : 'No epinephrine given',
    teach: 'Epinephrine every 3-5 minutes throughout the arrest.' });
  if(state.pulselessSecs > 0){
    const missed = state.cyclesWithoutCpr || 0;
    m.push({ name: 'rhythmChecks', value: state.checksDone, ok: missed === 0,
      detail: missed === 0 ? state.checksDone + ' rhythm check(s), compressions running into every one'
            : missed + ' cycle(s) reached the rhythm check with no compressions running',
      teach: 'Compressions run right up to the rhythm check and restart immediately after — the pause is ten seconds, not the cycle.' });
  }
  // Name the problems. "1 energy/dose problem(s)" told a player nothing about what it
  // was; the notes the engine wrote at the time are the teaching.
  // Only what happened DURING the arrest, and each problem named once. Kim's crush
  // debrief printed the identical bicarbonate sentence four times and her AF debrief
  // printed the identical cardioversion sentence three times; a wall of the same sentence
  // teaches nothing and reads as the simulator shouting.
  const endedAt = state.endedT != null ? state.endedT : Infinity;
  const arrestEra = x => x.t == null || x.t <= endedAt;
  const problems = [].concat(state.shocks.filter(x => !x.ok && arrestEra(x)),
                             state.drugs.filter(d => !d.ok && arrestEra(d)));
  const bad = problems.length;
  const seenNote = new Set();
  const named = problems.map(x => (x.name ? capitalize(x.name) : (x.sync ? 'Synchronized shock' : 'Shock')) + (x.t != null ? ' at ' + fmt(x.t) : '') + ': ' + (x.note || 'flagged'))
    .filter(line => { const key = line.replace(/ at \d+:\d+:/, ':'); if(seenNote.has(key)) return false; seenNote.add(key); return true; });
  m.push({ name: 'doseAccuracy', value: bad, ok: bad === 0,
    detail: bad === 0 ? 'Energies and doses all correct' : named.join(' '),
    teach: bad === 0 ? '' : 'Every energy and every drug has a reason and a dose — in children weight-based, in adults fixed — and a drug without an indication costs time and can do harm.' });
  const need = (script.causes && script.causes.required) || [];
  if(need.length) m.push({ name: 'reversibleCause', value: state.causesTreated.length,
    ok: need.every(c => state.causesTreated.indexOf(c) !== -1),
    detail: state.causesTreated.length ? 'Treated: ' + state.causesTreated.join(', ') : 'The reversible cause was never treated',
    teach: 'Search for and treat the Hs and Ts — a cause left untreated is a code that cannot be won.' });
  if(state.ended === 'rosc'){
    // A shockable arrest that needed more than three shocks with no antiarrhythmic on
    // board converted LATE: the script let the fourth shock succeed so the case could
    // still be won, but the debrief has to say what would have shortened it.
    const defibs = state.shocks.filter(x => !x.sync).length;
    const anti = state.drugs.some(d => d.name === 'amiodarone' || d.name === 'lidocaine');
    const late = shockable && defibs >= 4 && !anti;
    const roscAt = state.endedT != null ? state.endedT : state.t;
    m.push({ name: 'timeToRosc', value: roscAt, ok: !late,
      detail: 'ROSC at ' + fmt(roscAt) + ' after ' + defibs + ' shock' + (defibs === 1 ? '' : 's')
        + (late ? ' — converted late, with no antiarrhythmic given' : ''),
      teach: late ? 'VF that persists after three shocks is refractory: amiodarone 300 mg (or lidocaine 1-1.5 mg/kg) after the third shock is what shortens a code like this one.' : '' });
  }
  return m;
}

function fmt(sec){ const s = Math.round(sec); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

// fmt() is for the chips on screen. This is for the nurse's mouth: she says "four
// minutes thirty", not "4:30". Cases run to thirty minutes, so the words have to hold
// up well past the first few callouts.
const SPOKEN_ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const SPOKEN_TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function spoken(n){
  if(n < 20) return SPOKEN_ONES[n];
  if(n < 100){ const t = Math.floor(n / 10), r = n % 10; return r === 0 ? SPOKEN_TENS[t] : SPOKEN_TENS[t] + '-' + SPOKEN_ONES[r]; }
  return String(n);
}
function spokenTime(sec){
  const s = Math.max(0, Math.round(sec));
  if(s === 60) return 'one minute';
  if(s < 120) return spoken(s) + (s === 1 ? ' second' : ' seconds');
  const m = Math.floor(s / 60), r = s % 60;
  const mm = spoken(m) + (m === 1 ? ' minute' : ' minutes');
  return r === 0 ? mm : mm + ' ' + spoken(r);
}

// What the monitor already shows, said out loud with the time attached. It reports
// this moment and never asserts that a state persists — the player may have just
// changed it, which is the whole reason they are being told the clock.
function statusLine(state){
  let head = rhythmName(state.rhythm);
  if(state.hr > 0) head += ' at ' + state.hr;
  const bits = [head];
  if(state.bpSys > 0) bits.push('pressure ' + state.bpSys);
  return capitalize(spokenTime(state.t)) + ' — ' + bits.join(', ') + '.';
}


// The two engines must agree on what the player has DONE. The turn engine credits a
// critical action when a responder with `satisfies` fires; a code order never reaches
// a responder, so compressions, shocks, drugs and airway work went uncredited and a
// code case was literally unwinnable on paper (caught by the winnability battery in
// tests/instant-engine.test.cjs). `codeScript.credits` maps a code action key to the
// critical-action index it credits, and act() reports them so the page can merge them
// into the turn engine's satisfied list.
// An order the engine itself flagged is not a performed critical action. Found by
// audit: "shock 50 joules" (out of band), a shock into asystole, "epinephrine 5 mg"
// and a 150 mg FIRST amiodarone each earned full credit while the same debrief
// printed the correction — the sim marking the box and scolding the dose on one page.
// The flagged record still reaches the debrief; only the credit is withheld.
function creditKeysFor(state, script, text, before){
  const keys = [];
  const s = norm(text);
  const lastShockOk = state.shocks.length > before.shocks && state.shocks[state.shocks.length - 1].ok;
  const lastDrugOk  = state.drugs.length  > before.drugs  && state.drugs[state.drugs.length - 1].ok;
  if(lastShockOk) keys.push('shock');
  // deliverShock sets cpr=true (compressions resume immediately after a shock), so a
  // FLAGGED shock used to earn the compressions credit through that side effect —
  // "shock 50 joules" was refused as out of band and ticked "high-quality CPR". Credit
  // compressions only when the player asked for them.
  // Credit compressions when the player ASKED for them — matching the order, not the
  // resulting state, so a shock cannot earn it by side effect and asking for them right
  // after a shock (the correct ACLS move) still earns it even though cpr was already on.
  if(state.cpr && /\b(cpr|compressions)\b/.test(s) && !/\b(stop|hold|pause)\b/.test(s)) keys.push('cpr');
  if(lastDrugOk) keys.push(state.drugs[state.drugs.length - 1].name);
  if(state.airway !== before.airway) keys.push('airway', state.airway);
  if(state.capnography && !before.capnography) keys.push('capnography');
  if((state.ivAccess && !before.ivAccess) || (state.io && !before.io)) keys.push('access');
  if(state.causesTreated.length > before.causes){
    keys.push('causeTreated');
    keys.push(state.causesTreated[state.causesTreated.length - 1]);
  }
  if(state.flags.pacing && !before.pacing) keys.push('pacing');
  if(state.flags.vagal && !before.vagal) keys.push('vagal');
  if(/\bcardiover/.test(s) && lastShockOk) keys.push('cardioversion');
  return keys;
}

function act(state, script, text, now){
  // A correct call reveals the rhythm from here on. Done in act() rather than as an
  // actInner branch on purpose: actInner would CLAIM the order, and the Call it chips
  // have to keep falling through to the turn engine, where naming the rhythm is what
  // earns the recognition critical action. This only listens.
  if(!state.ended && !state.rhythmCalled && callsRhythm(text, state.rhythm)) state.rhythmCalled = true;
  const before = { shocks: state.shocks.length, drugs: state.drugs.length, cpr: state.cpr,
    airway: state.airway, capnography: state.capnography, ivAccess: state.ivAccess,
    io: state.io, causes: state.causesTreated.length,
    pacing: !!state.flags.pacing, vagal: !!state.flags.vagal };
  const out = actInner(state, script, text, now);
  if(!out || !out.handled) return out || { handled: false };
  const map = (script && script.credits) || {};
  const credits = [];
  for(const k of creditKeysFor(state, script, text, before)){
    const ix = map[k];
    if(Number.isInteger(ix) && credits.indexOf(ix) === -1) credits.push(ix);
  }
  if(!state.credited) state.credited = [];
  for(const ix of credits) if(state.credited.indexOf(ix) === -1) state.credited.push(ix);
  out.credits = credits;
  return out;
}

root.CodeEngine = { newState, tick, act, actInner, creditKeysFor, summary, rhythmName, fmt,
  CYCLE_SEC, STATUS_SEC, spokenTime, parseDose, SHOCKABLE, PULSELESS, CARDIOVERTABLE, DRUG_ALIASES,
  // Exported so the app can apply the same rule to the 155 cases that have no code script.
  // Reading the strip is the exercise in an atrial fibrillation case too.
  callsRhythm, RHYTHM_CALLS };
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.CodeEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
