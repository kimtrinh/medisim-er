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
const STATUS_SEC = 90;          // the soonest the nurse calls the time again while a pulse remains
// …and the longest she will go without saying anything. A change-driven callout with no
// floor makes a steady patient a silent one, which reads as the sim having stopped.
const STATUS_MAX_SILENCE = 300;
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
    // When the current pulseless episode began (null while there is a pulse). The shock
    // interval counts only this episode's shocks: the first shock after a pulse is lost
    // is never "too soon", whatever happened before it.
    episodeT: st.pulse ? null : 0, episode: st.pulse ? 0 : 1,
    episodes: st.pulse ? [] : [{ n: 1, t: 0, rhythm: st.rhythm || 'sinus' }],
    airway: 'none', capnography: false, ivAccess: false, io: false,
    // Arrays, not Sets: the whole state is JSON.stringify'd for the determinism
    // test, the run log and the debrief, and a Set serialises to {}.
    causesTreated: [], events: [], flags: {}, ended: null, credited: [], hintsFired: [],
    checksDone: 0
  };
}

function ev(state, kind, text, extra){
  const e = Object.assign({ t: state.t, kind, text: text || '',
    patient: { t:state.t, phase:state.phase, pulse:state.pulse, rhythm:state.rhythm,
      hr:state.hr, bpSys:state.bpSys, bpDia:state.bpDia, spo2:state.spo2, rr:state.rr }
  }, extra || {});
  state.events.push(e);
  return e;
}

function tick(state, script, dt){
  const out = [];
  if(state.ended) return out;
  const hadCharge = !!pendingCharge(state);      // see chargeEnded, at the end
  const step = Math.max(0, dt || 0);
  state.t += step;
  // (R9, Kim's J2) Her question closes a minute after she asked it; a charge made at a pulse disarms after one, as the
  // machine does, and she says so — "Still charged, doctor — call the shock" into a stable SVT minutes later was the bug.
  openQuestion(state);
  if(state.charged && state.charged.pulse && state.pulse && state.t - state.charged.t > PULSE_CHARGE_SEC){
    state.charged = null;
    out.push(ev(state, 'note', 'The charge timed out, doctor — dumped.', { disarmed: true, chargeEnd: 'expired' }));
  }
  // Compression seconds count whenever hands are on the chest. A newborn receives 3:1
  // compressions at a heart rate under 60 — a rate, not an absent pulse — so counting
  // only while pulseless reported 0% CPR on a textbook-perfect resuscitation.
  if(state.cpr) state.cprSecs += step;
  if(state.cpr) state.cprSinceFirst = (state.cprSinceFirst || 0) + step;
  if(state.cpr && state.firstCprT == null) state.firstCprT = state.t - step;
  // The code runs its course on this tick unless a pulse comes back first. Known before the rhythm
  // check, so the last check does not invite a shock ("Shockable — charge") and the nurse does not
  // offer another epi in the same breath as the time of death.
  const deathDue = !!(script.end && script.end.deathAfterSec != null && state.t >= script.end.deathAfterSec);
  if(!state.pulse){
    state.pulselessSecs += step;
    state.cycleT += step;
    if(state.cycleT >= CYCLE_SEC){
      state.cycleT -= CYCLE_SEC;
      out.push(...closeCycle(state, script, deathDue));
    }
  }
  out.push(...runDegrade(state, script));
  out.push(...runCrash(state, script));
  runRecover(state);
  // A minute of numbers, kept so trendOf() can say which way she is going. Sixty entries
  // at dt=6 is six minutes — enough for the one-minute lookback and nothing more.
  (state.history = state.history || []).push({ t: state.t, hr: state.hr, bpSys: state.bpSys, spo2: state.spo2 });
  if(state.history.length > 60) state.history.shift();
  if(!(deathDue && !state.pulse)) out.push(...epiTiming(state, script));
  out.push(...adenosineReady(state, script));
  out.push(...newbornReassess(state, script));
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
    // SAY IT WHEN IT CHANGES. On a timer alone the nurse called "sinus tachycardia at 140,
    // pressure 84" seventeen times in twenty-three minutes of Kim's blunt-trauma run — and
    // each one interrupted whoever was speaking, so she could hear neither the paramedic's
    // handover nor the consultants. She calls the numbers when a number has moved, and once
    // in a long silence so a steady patient is not a silent one.
    const last = state.lastCall || null;
    const moved = !last || last.rhythm !== state.rhythm || Math.abs(last.hr - state.hr) >= 8
      || Math.abs(last.bpSys - state.bpSys) >= 8 || Math.abs(last.spo2 - state.spo2) >= 3;
    const due = state.statusT >= STATUS_SEC;
    const silent = (state.t - ((last && last.t) || 0)) >= STATUS_MAX_SILENCE;
    if(due && (moved || silent)){
      state.statusT = 0;
      out.push(ev(state, 'statusCall', statusLine(state, last)));
      state.lastCall = { t: state.t, rhythm: state.rhythm, hr: state.hr, bpSys: state.bpSys, spo2: state.spo2 };
    }
  }
  chargeEnded(state, hadCharge, out);
  return out;
}
// A CHARGE THAT ENDS IS SEEN TO END (round 7). The room showed the defibrillator charged for a second and a half
// because nothing said when a charge stopped waiting: pendingCharge forgot it lazily, the next time it was asked.
// Now every end is on an event — 'delivered' (the shock that spent it), 'dumped' (by the doctor, or at the
// check), or 'expired' (the pulse came or went, the case ended, its check and the cycle after passed) — and a
// charge that has gone stale is forgotten at once. `hadCharge`: one was waiting before this tick or order.
function chargeEnded(state, hadCharge, events){
  if(!hadCharge || pendingCharge(state) || !events || !events.length || events.some(e => e && e.chargeEnd)) return;
  events[events.length - 1].chargeEnd = 'expired';
}

// THE RHYTHM CHECK. One place, whoever brings it on: the team at the two-minute mark (tick), the
// player's own pulse check in the last seconds of the cycle, or a shock ordered in those seconds.
//
// The engine has always performed this check; the team reports what it finds, because the only way
// to see a rhythm named at the cycle boundary used to be clicking Pulse check, which stopped
// compressions with nothing to restart them (Kim's run: four clicks, one forgotten restart, 67%
// compression fraction). So the boundary speaks twice: the pause, then the finding. The learner's
// job at a rhythm check is shock or no shock, and that decision needs the rhythm said out loud.
// Built from the clock, not a constant; she only announces stopping compressions when somebody is
// doing them. The pause is paid, five seconds (a team checking with the defibrillator charged is
// off the chest for about five; ten is the guideline ceiling for any interruption, and charging ten
// put the PALS respiratory-arrest model answer at 79% against an 80% bar).
function closeCycle(state, script, final){
  const out = [];
  const charged = pendingCharge(state);          // before the check: a pulse found forgets it (achieveRosc)
  // (R10, M3: compressions the leader paused in this cycle's own last seconds were paused FOR this check — it is not one
  // reached with no compressions running, and the team goes back on the chest after it, as after any check.)
  const pausedForCheck = state.cprPausedForCheck === state.cycle && !state.cpr;
  state.cprPausedForCheck = null;
  state.cycle += 1;
  // The ARREST's rhythm checks, and only those: this is the one place a check is counted (a check
  // made with a pulse, or a newborn's heart-rate check, is counted apart — see actInner).
  state.checksDone += 1;                       // the team checks; the player need not type it
  if(!state.cpr && !pausedForCheck) state.cyclesWithoutCpr = (state.cyclesWithoutCpr || 0) + 1;
  out.push(ev(state, 'rhythmCheck', 'Cycle ' + state.cycle + ' — ' + spokenTime(state.t) +
    ' on the clock' + (state.cpr ? ', pausing compressions for the pulse check.' : ', pulse check.')));
  if(state.cpr) state.cprSecs -= Math.min(5, state.cprSecs);
  out.push(...checkAndRosc(state, script, final));
  if(pausedForCheck && !state.pulse && !state.ended) state.cpr = true;
  // THE CHECK DUMPS A CHARGE NOBODY WILL DELIVER (round 7, Kim). A pre-charge that met a pulse, or a rhythm the
  // doctor has called that is not shockable, is dumped at the check and said — it waited, and the next "clear"
  // put 200 J into PEA. So is one charged for a rhythm that has changed since (the team said so when it
  // changed): VF that fell to asystole at 1:50 took the 1:48 pre-charge at the check, where live's charge had
  // gone into the VF. Any change, shockable or not, so the dump reads nothing off the strip. An uncalled rhythm
  // that has not changed keeps it: dumping would read the strip for the doctor (the blind-rhythm rule; the first
  // shock into PEA is flagged, as on live). A charge the check leaves stale — the check it was for AND the cycle
  // after have passed — ends quietly, on the check (`chargeEnd`).
  if(charged){
    const check = out.filter(e => e.kind === 'check').pop();
    if(state.pulse || state.ended){
      state.charged = null;
      out.push(ev(state, 'note', 'Dumping the charge.', { disarmed: true, chargeEnd: 'dumped' }));
    } else if(!SHOCKABLE.has(state.rhythm) && heardName(state)){
      state.charged = null;
      if(check){ check.text = check.text.replace(/Not shockable\.?/, 'Not shockable — dumping the charge.'); check.chargeEnd = 'dumped'; check.disarmed = true; }
    } else if(charged.rhythm && charged.rhythm !== state.rhythm){
      state.charged = null;
      out.push(ev(state, 'note', 'The rhythm changed after we charged — dumping the charge.', { disarmed: true, chargeEnd: 'dumped' }));
    } else if(!pendingCharge(state) && check) check.chargeEnd = 'expired';
  }
  // (R8, Kim: at a called shockable rhythm with the shock due the team charges — teamCharge. A charge of its own
  // from the check before, gone stale at this one, is charged again: the machine stays charged, nothing ended.)
  const check = out.filter(e => e.kind === 'check').pop();
  if(teamCharge(state, script, check, final) && check && check.chargeEnd === 'expired') delete check.chargeEnd;
  return out;
}
// THE FINDING IS WHAT THE CHECK FOUND. Built before the ROSC rows ran, a check that brought the pulse
// back said "No pulse — torsades. Shockable — charge. Back on the chest." and then "We have a pulse" in
// the same breath — and when the doctor's shock was what opened the check, she then held the shock she
// had just told them to charge for. So the rows are asked first: a check that is about to find a pulse
// sees an organized rhythm and feels for it (deliverShock's words for a converting shock), and the
// ROSC line follows as the consequence. Still a 'check' event, so the page pauses compressions for it.
function checkAndRosc(state, script, final){
  if(!state.pulse && roscRowAtCheck(state, script))
    return [ev(state, 'check', 'Organized rhythm on the monitor — checking for a pulse.')].concat(resolveChecks(state, script));
  return [ev(state, 'check', checkFinding(state, script, final))].concat(resolveChecks(state, script));
}
// What a pulse check finds, said the way the nurse says it. "Shockable — charge" only when a shock
// is actually due: straight after a shock the same rhythm means back on the chest, and telling the
// player to charge then refusing the shock they ask for is the contradiction this must never make.
// Uncalled, she reports the pulse, which is hers to report, and leaves the strip to the doctor — and
// says nothing about the next shock, because "next shock at the rhythm check" tells the doctor that
// the strip they have not read is shockable (for asystole the phrase was simply absent).
// `final`: the check on the tick the code runs its course — no invitation to charge, nothing to come
// back to the chest for.
function checkFinding(state, script, final){
  if(state.pulse) return 'I have a pulse' + (heardName(state) ? ' — ' + heardName(state) : '') + ' at ' + state.hr + '.';
  if(final) return heardName(state) ? 'No pulse — ' + heardName(state) + '.' : 'No pulse.';
  const shockWait = readyIn(state, script, 'shock');
  if(!heardName(state))
    return 'No pulse. Rhythm is up on the monitor, doctor — what is it? Back on the chest.';
  // (Round 7: pre-charged for this check, she says so — the doctor's call-out delivers it. R8, Kim: otherwise the
  // team charges now — teamCharge, on the same conditions — and she says that: "Shockable — charge." was answered
  // "clear", and nothing had been charged.)
  const charged = pendingCharge(state);
  return 'No pulse — ' + heardName(state) + '. ' +
    (!SHOCKABLE.has(state.rhythm) ? 'Not shockable. Back on the chest.'
      : shockWait ? 'Back on the chest — next shock at the rhythm check in ' + spokenTime(shockWait) + '.'
      : charged && (charged.auto || charged.rhythm === state.rhythm) ? 'Shockable — we are charged, doctor.'
      : isNeonate(script) ? 'Shockable — charge. Back on the chest.'
      : 'Shockable — charging, doctor.');
}

// A rhythm check is where the non-shockable algorithms are decided: the pulse is
// felt at the end of a cycle, not the moment the drug goes in. Firing these rows
// on the drug instead would let a player push epi and get an instant pulse, which
// is the opposite of what two-minute cycles are meant to teach.
function roscRowAtCheck(state, script){
  for(const r of (script.rosc || [])){
    if(r.rhythm && r.rhythm !== state.rhythm) continue;
    if(r.requires && !r.requires.every(k => rowHas(state, k))) continue;
    if(r.atNextCheck === false) continue;
    return r;
  }
  return null;
}
function resolveChecks(state, script){
  const r = roscRowAtCheck(state, script);
  if(!r) return [];
  const out = achieveRosc(state, script, 'algorithm');
  if(r.to) setRhythm(state, r.to);
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
  const halted = c.halt && c.halt.some(k => hasAction(state, k));
  const out = [];
  for(const row of (c.path || [])){
    // Guarded rows own their cause. The legacy global halt applies only to older,
    // unguarded rows; a decompressed chest cannot turn off a pelvic bleeding row.
    if(row.unless || row.unlessAll){
      if(row.unless && row.unless.some(k => hasAction(state,k))) continue;
      if(row.unlessAll && row.unlessAll.every(k => hasAction(state,k))) continue;
    } else if(halted) continue;
    if(state.t < row.atSec || state.flags['_crash' + row.atSec]) continue;
    state.flags['_crash' + row.atSec] = true;
    // A newly authored deterioration supersedes earlier recovery on these numbers.
    state.ramps = (state.ramps || []).filter(r => row[r.k] == null && !row.arrest);
    if(row.hr != null) state.hr = row.hr;
    if(row.bpSys != null){ state.bpSys = row.bpSys; state.bpDia = Math.round(row.bpSys * 0.6); }
    if(row.spo2 != null) state.spo2 = row.spo2;
    if(row.rr != null) state.rr = row.rr;
    if(row.rhythm) setRhythm(state, row.rhythm);
    if(row.arrest){ state.pulse = false; state.phase = 'arrest'; state.rhythm = row.arrest;
      state.cycleT = 0; state.cycle = 1; startEpisode(state, row.arrest);
      loseThePulse(state);
      // The team started compressions if the nurse says so — the ATLS arrests announce it.
      if(/\bcompressions started\b/i.test(row.text || '')) state.cpr = true;
      out.push(ev(state, 'arrest', row.text || 'She has lost her pulse.')); }
    else if(row.text) out.push(ev(state, 'crash', row.text));
  }
  return out;
}

// A TREATED CAUSE RESTORES WHAT IT BROKE. runCrash slides the vitals down an authored
// path until a halting action lands, and a halt only ever STOPPED the slide — nothing put
// anything back. The one route to improvement was a `convert` row requiring every cause
// at once, so a doctor who fixed three of four watched "sinus tachycardia at 140, pressure
// 84" for twenty-three minutes after a decompression, a chest tube, blood and a binder.
// Kim: "the oxygen saturation did not improve after those procedures… the pelvic binder did
// not work either… massive transfusion did not seem to improve the vital signs."
//
// A `crash.recover` row is authored per cause, in the shape of a `crash.path` row, and its
// numbers are TARGETS reached by a linear ramp over `overSec` — a decompressed chest does
// not read 92% the same second. A row fires once, when its cause is first treated. Causes
// still untreated keep their damage: a later crash row on one of them still applies.
function startRecover(state, script, cause){
  // ROSC IS NOT THE END OF THE RESUSCITATION. `ended` carries two very different meanings:
  // 'death', after which nothing can improve, and 'rosc', after which almost everything the
  // player does is post-arrest care. Bailing on both froze the patient at her postRosc
  // numbers for the rest of the case — Kim, 2026-09-20: "no change in vital when put on
  // naloxone or drip … never improved her oxygen saturation despite intubation." The page
  // already draws this distinction for the same reason (codeAnswers: `ended !== 'death'`,
  // "post-arrest care is the rest of the resuscitation, not an epilogue"); the engine that
  // moves the numbers did not.
  if(state.ended === 'death' || !state.pulse) return [];
  const rows = ((script.crash || {}).recover || []).filter(r => r.cause === cause);
  const out = [];
  for(const r of rows){
    const key = '_recover:' + cause;
    if(state.flags[key]) continue;
    state.flags[key] = true;
    if(!state.recoveryBaseline) state.recoveryBaseline = { t:state.t, hr:state.hr, bpSys:state.bpSys, spo2:state.spo2 };
    const over = Math.max(6, r.overSec || 120);
    state.ramps = state.ramps || [];
    for(const k of ['hr', 'bpSys', 'spo2', 'rr'])
      if(r[k] != null){
        // These restoration rows describe recovery toward the authored baseline,
        // not adverse effects. Do not pull an already better value backwards.
        const direction = (k === 'hr' || k === 'rr') ? -1 : 1;
        if((r[k] - state[k]) * direction <= 0) continue;
        state.ramps.push({ k, from: state[k], to: r[k], direction, cause, t0: state.t, t1: state.t + over });
      }
    if(r.text) out.push(ev(state, 'recover', r.text, { cause }));
  }
  return out;
}
function runRecover(state){
  if(state.ended || !state.pulse){ state.ramps = []; return; }
  if(!state.ramps || !state.ramps.length) return;
  const keep = [];
  for(const rp of state.ramps){
    const f = Math.min(1, Math.max(0, (state.t - rp.t0) / (rp.t1 - rp.t0)));
    const v = Math.round(rp.from + (rp.to - rp.from) * f);
    // A directional envelope composes simultaneous restoration without adding
    // absolute targets, stacking duplicate benefit, or depending on insertion order.
    state[rp.k] = rp.direction < 0 ? Math.min(state[rp.k], v) : Math.max(state[rp.k], v);
    if(rp.k === 'bpSys') state.bpDia = Math.round(state.bpSys * 0.6);
    if(f < 1) keep.push(rp);
  }
  state.ramps = keep;
}

// POST-ARREST CARE MOVES THE NUMBERS. Kim, 2026-09-22: "When I intubate the patient, I don't
// see the vitals get better in the cardiac arrest case." After ROSC the monitor belongs to the
// turn engine, but a tube, a bag or naloxone is still claimed HERE — and this engine answered
// "Tube is in" and changed nothing, so the opioid arrest sat at sats 93, rate 10 for the rest
// of the case whatever was done. No case says what post-arrest care does to the numbers, so
// these are the defaults; `postRosc.care.<kind>` in a script replaces one wholesale.
//   ett / sga — on the ventilator: FiO2 100%, a set rate for the patient's age
//   bvm       — bagged at the recommended rate
//   naloxone  — only in a case where naloxone earns credit (an opioid arrest), and only while
//               nothing is breathing FOR her: a ventilated patient's rate is the ventilator's
// A newborn gets no default: NRP oxygen targets run by minute of life and full oxygen is wrong
// there, so a neonatal case must author its own.
const POST_ROSC_CARE = {
  adult:  { ett: { spo2: 98, rr: 16 }, sga: { spo2: 97, rr: 16 }, bvm: { spo2: 96, rr: 10 }, naloxone: { spo2: 95, rr: 14 } },
  child:  { ett: { spo2: 97, rr: 20 }, sga: { spo2: 97, rr: 20 }, bvm: { spo2: 95, rr: 20 }, naloxone: { spo2: 95, rr: 20 } },
  infant: { ett: { spo2: 97, rr: 30 }, sga: { spo2: 97, rr: 30 }, bvm: { spo2: 95, rr: 30 }, naloxone: { spo2: 95, rr: 30 } },
};
const AIRWAY_RANK = { bvm: 1, sga: 2, ett: 3 };
function postRoscCareRow(script, kind){
  const authored = (((script || {}).postRosc || {}).care || {})[kind];
  if(authored) return authored;
  const p = (script || {}).patient || {};
  if(p.neonate) return null;
  const band = p.child ? ((+p.weightKg || 0) < 10 ? 'infant' : 'child') : 'adult';
  return POST_ROSC_CARE[band][kind] || null;
}
function careText(kind, v){
  if(kind === 'naloxone') return 'She\'s breathing on her own now — rate ' + v.rr + ', sats ' + v.spo2 + '.';
  if(kind === 'bvm') return 'Bagging at ' + v.rr + ' a minute — sats up to ' + v.spo2 + '.';
  return 'On the ventilator, rate ' + v.rr + ', 100% oxygen — sats coming up to ' + v.spo2 + '.';
}
function postRoscCare(state, script, before){
  if(state.ended !== 'rosc' || !state.pulse) return [];
  let kind = null;
  if(state.airway !== before.airway && (AIRWAY_RANK[state.airway] || 0) > (AIRWAY_RANK[before.airway] || 0)) kind = state.airway;
  else if(state.drugs.length > before.drugs){
    const d = state.drugs[state.drugs.length - 1];
    if(d && d.name === 'naloxone' && d.ok !== false && script && script.credits && script.credits.naloxone != null
       && state.airway !== 'ett' && state.airway !== 'sga') kind = 'naloxone';
  }
  const row = kind && postRoscCareRow(script, kind);
  if(!row) return [];
  const v = {};
  // Oxygenation only ever improves here — sats already better are not pulled back to a target.
  if(row.spo2 != null){ v.spo2 = Math.max(state.spo2 || 0, row.spo2); state.spo2 = v.spo2; }
  if(row.rr != null){ v.rr = row.rr; state.rr = row.rr; }
  if(row.hr != null){ v.hr = row.hr; state.hr = row.hr; }
  if(row.bpSys != null){ v.bpSys = row.bpSys; state.bpSys = row.bpSys; state.bpDia = Math.round(row.bpSys * 0.6); }
  return [ev(state, 'care', row.text || careText(kind, v), { vitals: v, care: kind })];
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
  // (R9: for a minute, and while the rhythm she asked it over lasts — openQuestion.)
  state.pendingQuestion = 'epi'; state.questionT = state.t; state.questionRhythm = state.rhythm;
  return [ev(state, 'epiDue', 'It has been five minutes — do you want another epi?')];
}

// THIRTY SECONDS OF VENTILATION (R11, NRP): a newborn reassessed before them is reassessed again when they are up — the rate the
// breaths have made, and whatever the case does with it. Only while the breaths go on.
const NRP_VENT_SEC = 30;
function newbornReassess(state, script){
  if(state.reassessAt == null || state.t < state.reassessAt) return [];
  state.reassessAt = null;
  if(state.ended || !state.flags.ppv) return [];
  const cause = reassessCause((script.causes || {}).actions || {});
  const conv = cause ? checkConversion(state, script, cause) : [];
  return conv.length ? conv : [ev(state, 'note', 'Thirty seconds of ventilation — heart rate ' + state.hr + (state.spo2 ? ', saturation ' + state.spo2 + '%' : '') + '.', { reassess: true })];
}
// READY FOR THE 12 (R11, Kim). A repeat adenosine asked for inside its minute is held — "the next dose can go in eighteen
// seconds" — and if the doctor never asked again the SVT ran on to deterioration (live gave it at once). When the held repeat
// comes due, she says so once, and asks: the yes gives it (her question 'adenosine', QUESTION_SEC like "synchronized?").
function adenosineReady(state, script){
  const a = state.adenosineAsk;
  if(!a) return [];
  const given = state.drugs.filter(d => d.name === 'adenosine').length;
  if(state.ended || !state.pulse || !CARDIOVERTABLE.has(state.rhythm) || given !== a.n || state.t - a.t > QUESTION_SEC){ state.adenosineAsk = null; return []; }
  if(readyIn(state, script, 'adenosine') !== 0 || state.pendingQuestion) return [];
  state.adenosineAsk = null;
  state.pendingQuestion = 'adenosine'; state.questionDrug = 'adenosine'; state.questionT = state.t; state.questionRhythm = state.rhythm;
  const mg = expectedDoseMg(state, script, 'adenosine');
  return [ev(state, 'note', !isChild(script) && mg === 12 ? 'Ready for the 12, doctor.'
    : 'Ready for the next adenosine, doctor' + (mg != null ? ' — ' + doseSaid(mg) + '.' : '.'), { question: 'adenosine', ack: 'ready' })];
}
function adenosineOrderFor(state, script){ const mg = expectedDoseMg(state, script, 'adenosine'); return 'adenosine ' + (mg != null ? mg + ' mg ' : '') + 'IV rapid push'; }
// "Yes, give it", "push it", "give the 12" — to her "ready for the 12".
const ADENO_YES_RE = /^(?:(?:yes|yeah|yep|ok|okay|sure|go ahead|please)\s+)*(?:give|push|go with)\s+(?:it|that|the (?:12|twelve|adenosine|next dose|second dose|next one))(?:\s+(?:now|please|then))*$/;

// ---------- NOT YET: the intervals a resuscitation runs on ----------
// Kim, 2026-09-25: "it is not recommended to give medication back to back. You have to wait a
// certain amount of time … epinephrine is between 3 to 5 minutes … You cannot defibrillate back
// to back … right now if you defibrillate three times in a row the patient will regain pulses
// without waiting any time in between … if you give medication too soon or you defibrillate too
// soon the nurse will stop you and say it's not time yet."
//
// Orders cost no clock time, so three clicks landed three shocks on the same second and walked
// the shock table to ROSC. Now the team holds what the algorithm says is not due yet (AHA 2025
// ACLS/PALS/NRP): one shock, then two minutes of CPR to the rhythm check; epinephrine every 3-5
// minutes; a second amiodarone only after another shock; adenosine given a minute to work;
// atropine every 3-5 minutes to its maximum. What the guideline leaves to judgement — the first
// epinephrine before the second shock in VF, amiodarone before the third — is coached in the
// debrief, not refused.
//
// A refusal is a 'withheld' event and NOTHING ELSE: no record, no ladder rung, no clock reset,
// no credit. The page reads exactly that as "Refused — nothing was done" and runs no animation
// (codeOutcome), and the debrief counts the held orders against the timing it scores.
// Lidocaine is the ACLS drug table's "0.5-0.75 mg/kg every 5-10 minutes": five minutes for every
// repeat with a pulse, and for the third arrest bolus on. The SECOND arrest bolus is the algorithm
// card's second antiarrhythmic dose — its box reads "amiodarone 150 mg OR lidocaine 0.5-0.75 mg/kg",
// with no interval of its own — so it is timed like the second amiodarone, the cycle's 108 s and the
// next shock (antiRepeat): five minutes there held the q4-minute megacode's second lidocaine and
// failed it (round 5, Kim's call).
// Magnesium (torsades; the asthmatic child): a repeat no sooner than five minutes (readyIn).
const DRUG_FLOOR = { epinephrine: 180, amiodarone: 108, lidocaine: 300, adenosine: 60, atropine: 180, naloxone: 120, magnesium: 300 };
// The last twelve code-seconds of a cycle are the rhythm check: the defibrillator is charged
// during the last compressions and the shock goes in at the check, so a shock or a pulse check
// asked for in that window is on time. One tolerance for both, so the nurse can never answer a
// check with "Shockable — charge" and then refuse the shock asked for straight after it.
const CHECK_GRACE = 12;
const DUE = CYCLE_SEC - CHECK_GRACE;
// The leader's pause for the check said this early — four real seconds before its window — is the pause for it, early (R11):
// the team stays on the chest until the check (actInner). And the words that stop the code for good, which are not a pause.
const EARLY_PAUSE_SEC = 24;
const STOP_FOR_GOOD_RE = /\b(?:for good|stop the code|stop resuscitation|stop the resuscitation|cease|terminat\w*|time of death|call it|calling it|we re done|we are done|stop all|end the code|no more cpr)\b/;
function isChild(script){ const p = (script && script.patient) || {}; return !!(p.child || p.neonate); }
function isNeonate(script){ return !!(script && script.patient && script.patient.neonate); }
function floorOf(rule, kind){
  const e = rule && rule.everySec;
  return Array.isArray(e) && Number.isFinite(e[0]) ? e[0] : DRUG_FLOOR[kind];
}
// Compressions are what make an epinephrine bolus an ARREST dose: pulseless, or a child or a
// newborn on compressions for a rate under sixty.
function compressionsIndicated(state, script){
  if(!state.pulse) return true;
  return !!state.cpr && isChild(script) && state.hr < 60;
}
// Which epinephrine is on the three-to-five-minute clock: every bolus in a child (PALS gives it
// every 3-5 minutes for bradycardia with a pulse too) and every arrest bolus in an adult. An
// infusion is titrated, and a 10-20 mcg push at a perfusing adult is a pressor, not an arrest
// dose — neither starts the clock, and neither is held.
// An intramuscular or subcutaneous dose is not on that clock either: 0.01 mg/kg IM is the
// anaphylaxis and severe-asthma dose, not an arrest or bradycardia bolus (see systemicEpi).
function epiTimed(state, script, text){ return !isInfusion(text) && !offAlgorithmRoute(routeOf(text)) && (isChild(script) || compressionsIndicated(state, script)); }
// The route an order names. A newborn's line is the umbilical vein, and "via the ETT" is the tube.
function routeOf(text){
  const n = norm(text);
  return /\bio\b|intraosseous/.test(n) ? 'io'
       : /\biv\b|intravenous|\buvc\b|umbilical/.test(n) ? 'iv'
       : /\bet\b|\bett\b|down the tube|via the tube|endotracheal|intratracheal/.test(n) ? 'et'
       : /\bim\b|intramuscular/.test(n) ? 'im'
       : /\b(?:sc|sq|subq|subcut)\b|subcutaneous/.test(n) ? 'sc' : null;
}
// THE EPINEPHRINE THE ALGORITHMS COUNT is a systemic bolus: IV, IO, or down the tube when there is
// no line. IM and SC are another indication's route — no circulation absorbs them in an arrest, and
// with a pulse they treat anaphylaxis or asthma, not the rhythm. Such a dose opens no ROSC or shock
// row, starts no clock and earns no arrest-epinephrine credit.
function offAlgorithmRoute(route){ return route === 'im' || route === 'sc'; }
function systemicEpi(d){ return d.name === 'epinephrine' && !offAlgorithmRoute(d.route); }
// AN INFUSION IS A RATE. The word alone is not one: "epinephrine 1 mg IV, titrate to effect" and
// "amiodarone 150 mg IV infusion over 10 minutes" deliver a bolus whatever they are called, and
// reading them as drips let every repeat past its hold — 1500 mg of amiodarone in a minute at a
// perfusing VT, epinephrine every six seconds in an arrest. So an infusion is a stated rate
// (mcg/min, mg/min, mcg/kg/min, mg/h, mL/h, "per minute", "over six hours"), or drip words with
// no bolus dose in the order. A concentration ("1 mg in 250 mL", "0.1 mg/mL") is not a bolus dose.
// Round 5: a rate is said "per minute", "/min" — and "a minute", "an hour", "each minute" (voice input
// says it that way): "20 micrograms per kilo a minute" was read as a 0.02 mg bolus and the child's
// PALS infusion refused as "not a second bolus". A bag is mL or cc, or just its number ("4 mg in 250").
// Round 6: ...but "a minute LATER" is a time, not a rate. "Adenosine 6 mg now and 12 mg a minute later"
// became an adenosine infusion at 12 mg/min, scored correct and credited — a drug never run as a drip.
// "Later", "apart", "after", "ago", "from now" and "wait" after the minute say when, not how fast.
const RATE_RE = /(\d+(?:\.\d+)?(?:\s*(?:-|to)\s*\d+(?:\.\d+)?)?)\s*(mcg|micrograms?|ug|mg|g|units?|mls?|cc)\s*(?:(?:\/|per)\s*(kg|kilo(?:gram)?s?)\s*)?(?:\/|\b(?:per|a|an|each|every)\b)\s*(min(?:ute)?s?|h(?:r|our)?s?)\b(?!\s+(?:later|apart|after|afterwards|ago|from now|wait|in between)\b)/;
// (Round 9: "over the next 8 hours" is the same drip as "over 8 hours".)
const RATE_WORDS_RE = /\bper (?:min(?:ute)?|h(?:r|our)?)\b|\bover (?:the )?(?:next )?\d+(?:\.\d+)?\s*(?:h|hrs?|hours?)\b/;
const DRIP_RE = /\b(drip|gtt|infusion|continuous|hang)\b|\binfuse\b(?!\s+rapid)/;
const BOLUS_DOSE_RE = /\d+(?:\.\d+)?\s*(?:mg|mcg|micrograms?|ug|g)\b(?!\s*(?:\/|in|per)\s*(?:\d+(?:\.\d+)?\s*)?(?:ml|mls|cc|l)\b|\s*in\s+\d+(?:\.\d+)?(?![\d.]|\s*(?:min|mins|minutes?|h|hrs?|hours?|secs?|seconds?|mg|mcg|g|kg)\b))/;
const ANY_DOSE_RE = /\d+(?:\.\d+)?\s*(?:mg|mcg|micrograms?|ug|g)\b/;
// A DOSE RUN IN OVER MINUTES IS A LOADING DOSE. "Amiodarone 150 mg in 100 mL over 10 minutes" is the
// perfusing VT's 150 however it is hung — the bag was read as a concentration, the drip word made it
// an infusion, and ten of them (1500 mg) went in in a minute. Under an hour it is a bolus given slowly,
// on the bolus's clock and in its band; "over 6 hours" is a drip (RATE_WORDS_RE).
const LOAD_OVER_RE = /\bover\s+(\d+(?:\.\d+)?)(?:\s*(?:-|to)\s*\d+(?:\.\d+)?)?\s*(?:min|mins|minutes?)\b/;
function loadingOver(s){ const m = s.match(LOAD_OVER_RE); return !!m && parseFloat(m[1]) < 60; }
// A bolus dose in (what is left of) an order: a dose that is not a concentration — or any dose, when
// the order runs it in over minutes.
function bolusDoseIn(s){ return BOLUS_DOSE_RE.test(s) || (loadingOver(s) && ANY_DOSE_RE.test(s)); }
// AN ORDER IS A PURE INFUSION ONLY WHEN ITS ONLY DOSE IS THE RATE. "Amiodarone 300 mg IV then 1 mg/min
// infusion", "lidocaine 1 mg/kg IO then 20 mcg/kg/min infusion" (the PALS box's own words) name the
// loading bolus AND the drip; read as a drip, the bolus was lost — flagged "the infusion follows the
// bolus", no credit, and the VF went on two more minutes. Such an order is split (giveDrug): the bolus
// takes the bolus's path (its holds, its band, its credit, the shock ladder) and the drip is recorded
// after it as the infusion it is.
function isInfusion(text){
  const s = pctNorm(text), r = s.match(RATE_RE);
  if(r){ const rest = s.replace(r[0], ' '); return !bolusDoseIn(rest) && !bareBolusIn(rest); }
  if(loadingOver(s)) return false;
  // (Round 9: a dose said before "then ... over N hours" is the bolus before the drip — overHoursParts.)
  if(overHoursParts(s)) return false;
  // (Round 7: a bare number said before the drip words is a bolus too — bareBolusIn.)
  return RATE_WORDS_RE.test(s) || (DRIP_RE.test(s) && !BOLUS_DOSE_RE.test(s) && !bareBolusIn(s.slice(0, s.search(DRIP_RE))));
}
// norm(), keeping a percentage as a word: "10% calcium" is a strength, and "10 calcium" would read as a number.
function pctNorm(text){ return norm(String(text == null ? '' : text).replace(/%/g, ' percent ')); }
// A BARE NUMBER AFTER THE DRUG'S NAME IS ITS BOLUS (round 7). "Amiodarone 300 then a drip" reaches the engine as
// "amiodarone 300 drip" (the page's clause split drops "then a"). With no unit the 300 was no bolus dose, so the
// drip words made the whole order an infusion: flagged "the infusion follows the bolus", no antiarrhythmic
// credit, and the 150 after it flagged as an underdose of a 300 that had never gone in. Live gave it as the
// bolus. A number said straight after the name — "amiodarone 300", "amio bolus 300", "lidocaine 100 push" — is
// the bolus, its dose unstated exactly as "amiodarone 300" alone always was. A number after the drip word ("epi
// drip 2") is the drip's; dextrose's number is its strength (D10), and a percentage is a strength, not a dose.
let BARE_BOLUS_RE = null;
function bareBolusRe(){
  if(!BARE_BOLUS_RE){
    const names = [].concat(...Object.keys(DRUG_ALIASES).filter(k => k !== 'dextrose').map(k => DRUG_ALIASES[k]))
      .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    BARE_BOLUS_RE = new RegExp('\\b(?:' + names + ')\\s+(?:(?:iv|io|ivp|bolus|push|stat|now|of)\\s+){0,3}\\d+(?:\\.\\d+)?'
      + '(?!\\s*(?:[\\d.,:/]|(?:mg|mcg|micrograms?|ug|g|grams?|milligrams?|meq|units?|ml|mls|cc|l|kg|kilos?|j|joules?|x|times|min\\w*|h|hrs?|hours?|sec\\w*|percent)\\b))');
  }
  return BARE_BOLUS_RE;
}
function bareBolusIn(s){ return bareBolusRe().test(s); }
// ...AND DRIP WORDS AFTER A BOLUS DOSE ARE THE DRIP THAT FOLLOWS IT, rate or no rate (round 7): "amiodarone 300 mg
// then a drip", "lidocaine 1 mg/kg IO followed by an infusion". "Infusion" can be how a dose goes in
// ("amiodarone 150 mg infusion" is the perfusing load run in, "magnesium 2 g IV infusion" the 2 g), so it is the
// drip after the bolus only with a word between that says so — then, followed by, and, with, start — or after it
// ("drip to follow"). (A dose run in over minutes, or a drip "over six hours", is one thing, as before.)
// ROUND 8 (Kim): SO IS "DRIP". Round 7 read any drip word after a dose as a second order, and in ED usage
// "magnesium 900 mg drip", "amiodarone 150 mg drip" is that dose run in: the asthmatic child was given her 900 mg
// AND an open-ended magnesium drip nobody ordered, and "epinephrine 1 mg drip" in an arrest a flagged epinephrine
// drip. "<dose> drip" is the dose, a bolus-equivalent on the bolus's clock; "... then a drip" is the dose and a drip.
// (The page hands a one-clause line over as typed, "then" and all; inside a longer line its clause split drops
// "then a" — "amiodarone 300 mg drip" — and that clause is read as the dose.)
function dripAfterBolus(s){
  if(loadingOver(s) || RATE_WORDS_RE.test(s)) return false;
  const d = s.match(/\b(?:drip|gtt|infusion|infuse|continuous)\b/);
  if(!d) return false;
  const head = s.slice(0, d.index);
  let end = -1;
  for(const m of head.matchAll(new RegExp(BOLUS_DOSE_RE.source, 'g'))) end = m.index + m[0].length;
  if(end === -1){ const b = bareBolusRe().exec(head); if(b) end = b.index + b[0].length; }
  if(end === -1) return false;
  return /\b(?:then|followed|after|afterwards|and|with|plus|also|start|starting|begin|hang|run|running)\b/.test(head.slice(end))
    || /^\s*(?:to follow|after|afterwards|following|next|thereafter)\b/.test(s.slice(d.index + d[0].length));
}
// ROUND 9 (K1): A BOLUS, THEN A DOSE RUN OVER HOURS. "Magnesium 2 g then 1 g over 1 hour", "naloxone 2 mg then 1.3 mg
// over 1 hour", "TXA 1 g then 1 g over 8 hours", "amiodarone 150 mg then 900 mg over 24 hours": the "over N hours"
// (RATE_WORDS_RE) made the WHOLE order an infusion and the bolus was lost. Pulseless torsades and the opioid arrest died on
// a drip that was never their push (a drip is not what their ROSC rows wait for), and the bleeding patient's TXA step went
// unticked; live gave the bolus. A dose said before then / followed by / and / plus / start is the bolus, down the bolus's
// path; what follows the connector — "1 g over 8 hours", "an infusion of 2/3 of that per hour" — is the drip. Only an
// order whose one dose is the dose run over hours ("amiodarone 360 mg over 6 hours", "magnesium 2 g over 2 hours") is a
// pure infusion. Returns { bolus, tail } in the order's own words, or null.
const THEN_DRIP_RE = /\b(?:then|followed by|and|plus|start|starting|begin|with|after that|afterwards)\b/gi;
const HEAD_DOSE_RE = /\d+(?:\.\d+)?\s*(?:mg|mcg|micrograms?|ug|g|grams?|milligrams?|meq|units?|ml|mls|cc)\b/;
function overHoursParts(text){
  const raw = String(text == null ? '' : text), w = raw.match(new RegExp(RATE_WORDS_RE.source, 'i'));
  if(!w) return null;
  for(const c of raw.slice(0, w.index).matchAll(THEN_DRIP_RE)){
    const head = pctNorm(raw.slice(0, c.index));
    if(HEAD_DOSE_RE.test(head) || bareBolusIn(head))
      return { bolus: raw.slice(0, c.index).replace(/[\s,;:.—–-]+$/, ''), tail: raw.slice(c.index + c[0].length).trim() };
  }
  return null;
}
// The two halves of a bolus-then-drip order: the bolus as ordered (the rate taken out of the words, so
// the strength and the route stay as they were said), and the drip as its own order. null when the order
// is not both.
function splitBolusDrip(name, text){
  const s = pctNorm(text), r = s.match(RATE_RE);
  const route = routeOf(text);
  // No rate said: the bolus is the order as said (giveDrug gives it as the bolus), the drip's rate unstated.
  // (Round 9: a bolus, then a dose "over N hours" — the bolus as said up to "then", the drip the rest: overHoursParts.)
  if(!r){
    const o = overHoursParts(text);
    if(o) return { bolus: o.bolus, drip: name + ' infusion ' + o.tail + (route && !routeOf(o.tail) ? ' ' + route : '') };
    return dripAfterBolus(s) ? { bolus: String(text == null ? '' : text), drip: name + ' infusion' + (route ? ' ' + route : '') } : null;
  }
  const rest = s.replace(r[0], ' ');
  if(!bolusDoseIn(rest) && !bareBolusIn(rest)) return null;
  const raw = String(text == null ? '' : text), low = raw.toLowerCase(), at = low.indexOf(r[0]);
  const bolus = at === -1 ? rest : raw.slice(0, at) + ' ' + raw.slice(at + r[0].length);
  return { bolus, drip: name + ' infusion ' + r[0] + (route ? ' ' + route : '') };
}
// The order the clock and the dose checks read: the bolus of a bolus-then-drip order, else the order.
function bolusPart(text){ const p = splitBolusDrip('', text); return p ? p.bolus : text; }
// A clause that is only a drip ("start drip", "hang a drip", "drip to follow", "continuous infusion", "start drip
// at 1 mg/min"), straight after a bolus of a drug that is run as a drip, in the same code second — the second
// half of one typed order: that drug's drip. Anything else in the clause (a fluid, a bag of blood) is not it.
const DRIP_ONLY_RE = /^(?:(?:and|then|start|starting|begin|hang|hanging|run|running|put|set|up|a|an|the|to|follow|followed|by|after|afterwards|maintenance|continuous|with|plus|also|please|now)\s+)*(?:drip|gtt|infusion)(?:\s+(?:to follow|after|afterwards|running|please|now|next|too|as well))*(?:\s+(?:at|of)\s+.+)?$/;
// ...and (round 9) a clause that is only a dose run over hours — the page splits "TXA 1 g now and 1 g over the next 8
// hours" at its "and", and "1 g over next 8 hours" names no drug — is that same drug's drip. Tranexamic acid is run as
// one: 1 g over ten minutes, then 1 g over eight hours (CRASH-2).
const DOSE_OVER_HOURS_RE = /^(?:(?:and|then|followed by|plus|start|starting|begin|with|a|an|the|another|maintenance|infusion of|drip of)\s+)*\d+(?:\.\d+)?\s*(?:mg|mcg|micrograms?|ug|g|grams?|milligrams?)\s+(?:(?:iv|io|infusion|drip|maintenance)\s+)*over\s+(?:the\s+)?(?:next\s+)?\d+(?:\.\d+)?\s*(?:h|hrs?|hours?)(?:\s+(?:iv|io|please|now))*$/;
const DRIP_DRUGS = ['amiodarone', 'lidocaine', 'epinephrine', 'magnesium', 'naloxone', 'tranexamic'];
function dripOfLastBolus(state, s){
  if(!DRIP_ONLY_RE.test(s) && !DOSE_OVER_HOURS_RE.test(s)) return null;
  // (Round 9, K2: a bolus the team held this same second, nothing given since, is the one this drip follows — when the
  // drip still starts after that hold: dripFollowsHold.)
  const h = state.heldBolus;
  if(h && h.t === state.t && h.n === state.drugs.length) return DRIP_DRUGS.indexOf(h.name) !== -1 && dripFollowsHold(state, h.name, h) ? h.name : null;
  const last = state.drugs[state.drugs.length - 1];
  return last && !last.infusion && last.t === state.t && DRIP_DRUGS.indexOf(last.name) !== -1 ? last.name : null;
}
// The rate as ordered, for the read-back: "20 mcg/kg/min", "15 mL/h" — or null when none was given.
function rateText(text){
  const m = norm(text).match(RATE_RE);
  if(!m) return null;
  const unit = /^(mcg|micro|ug)/.test(m[2]) ? 'mcg' : /^unit/.test(m[2]) ? 'units' : /^(ml|cc)/.test(m[2]) ? 'mL' : m[2];
  return m[1].replace(/\s*(?:-|to)\s*/, '-') + ' ' + unit + (m[3] ? '/kg' : '') + '/' + (/^m/.test(m[4]) ? 'min' : 'h');
}
// The pulseless episodes. A shock or a drug is stamped with the episode it was given in, so the
// first shock after a pulse is lost is never "too soon" and a pre-arrest dose is not an arrest dose.
function startEpisode(state, rhythm){
  state.episode = (state.episode || 0) + 1;
  state.episodeT = state.t;
  (state.episodes = state.episodes || []).push({ n: state.episode, t: state.t, rhythm: rhythm || state.rhythm });
}
// The pulse is lost: what belonged to the perfusing patient goes with it — her "synchronized?", a charge
// made at the pulse, sync mode (round 6). There is nothing to synchronize to now.
function loseThePulse(state){
  if(state.pendingQuestion === 'sync') state.pendingQuestion = null;
  state.charged = null; state.syncMode = false;
}
function episodeDefibs(state){
  if(state.pulse || state.episodeT == null) return [];
  return state.shocks.filter(s => !s.sync && s.episode === state.episode);
}
// Seconds until the next thing of this kind is allowed: 0 is now, Infinity is never again (the
// maximum is reached). Shared with the page, so the Hint, the drug buttons and the nurse can
// never disagree about what is due.
// `order` (optional) is the order's own words. Two holds turn on the dose asked for, not the clock —
// a further underdose, and a second arrest-dose epinephrine at a patient with a pulse (doseHold) — and
// only the words carry the dose. Without them the answer is for the dose the page's button offers
// (expectedDoseMg), which is never either: after a flagged underdose the full dose is due NOW.
function readyIn(state, script, kind, route, order){
  if(order == null || !DRUG_FLOOR[kind]) return dueIn(state, script, kind, route);
  return orderWait(state, script, kind, order, route).wait;
}
// The clock and the ceilings — whatever dose is asked for.
function dueIn(state, script, kind, route){
  // ROSC IS NOT THE END OF THE RULES. The page keeps sending orders after the pulse comes back (or
  // the case converts to 'stable'), and this returned "now" for everything once the case had ended:
  // 6 mg/kg of lidocaine, 900 mg of amiodarone in 36 s, adenosine 6 and 12 in the same second, all
  // scored clean. The repeat rules are the PATIENT's — only death ends them.
  if(!state || !script || state.ended === 'death') return 0;
  if(kind === 'shock'){
    // Only a shockable rhythm waits for the check. A shock into PEA or asystole is answered by
    // what it is — the wrong therapy — not by the clock (deliverShock flags it). The first goes in;
    // once this arrest has had one, the team gives no more electricity to a rhythm that is not
    // shockable (heldShock, reason 'notShockable') — never again, not "now", on the page's button.
    // The same with a pulse: an unsynchronized shock into a perfusing VT (or a rhythm that is never
    // shocked) is delivered and flagged once; 304 of them went in one after another. Torsades with a
    // pulse is shocked unsynchronized — there is no single QRS to synchronize to — and is not held.
    // Round 6: after ROSC, or a case that ended 'stable', no shock at all (actInner refuses every shock
    // word there). This said "now" while the nurse answered "There is a pulse, doctor — no shock.":
    // held for the pulse, for good (holdReason 'pulse').
    if(state.ended) return Infinity;
    if(state.pulse) return !SHOCKABLE.has(state.rhythm) && shockedAtPulse(state) ? Infinity : 0;
    if(!SHOCKABLE.has(state.rhythm)) return shockedNotShockable(state) ? Infinity : 0;
    // Shocks live on the two-minute grid: the next one is due at the next rhythm check, and once a
    // check has read the rhythm since the last shock it is due now. Counting 108 s from the shock
    // instead let a shock at the end of a cycle (which carries the cycle back below zero) be followed
    // by one mid-cycle, 12 s early, that skipped a rhythm check and slid the grid.
    const d = episodeDefibs(state), last = d[d.length - 1];
    if(!last || state.checksDone > (last.check || 0)) return 0;
    return Math.max(0, DUE - state.cycleT);
  }
  if(kind === 'check') return checkWindow(state, script).wait;
  const rule = (script.drugs && script.drugs[kind]) || {};
  const given = state.drugs.filter(d => d.name === kind && !d.infusion);
  if(kind === 'epinephrine'){
    // An IM or SC dose is another indication's (anaphylaxis, asthma) and is never on this clock (epiTimed).
    if(offAlgorithmRoute(route)) return 0;
    // NOT INDICATED IS NOT "NOT YET" (round 6). A child or a newborn with a pulse and a rate of sixty or
    // more is not an epinephrine patient (giveDrug flags the bolus). After ROSC the clock still ran, and
    // the nurse promised "the next one is due in sixty-six seconds" — a dose the team then flagged. Once
    // epinephrine has gone in, no more while the rate holds: 'notIndicated', no time promised. (The first
    // at a perfusing child still goes in, flagged — the teaching, as with the adult's arrest dose, A12.)
    if(epiNotIndicated(state, script)) return state.lastEpiT != null ? Infinity : 0;
    if(state.lastEpiT == null || !(isChild(script) || compressionsIndicated(state, script))) return 0;
    const timed = state.drugs.filter(d => d.name === 'epinephrine' && d.timed);
    const lastT = timed[timed.length - 1];
    // NRP: a dose down the tube while the line goes in is followed by an IV/IO dose as soon as
    // the line is in, whatever the interval.
    // Only the IV/IO dose that FOLLOWS a tube dose (the page's button is IV); a second dose down
    // the tube keeps the three-to-five-minute clock.
    // Round 6: an order with no route is that IV dose (giveDrug reads it as IV, and the page's button
    // sends IV), line or no line — the button counted three minutes down while pressing it gave the dose
    // at once. The engine models no "line first" gate for any drug, so neither does this.
    if(isNeonate(script) && lastT && lastT.route === 'et' && route !== 'et') return 0;
    return Math.max(0, floorOf(rule, 'epinephrine') - (state.t - state.lastEpiT));
  }
  if(kind === 'amiodarone' || kind === 'lidocaine') return antiRepeat(state, script, kind).wait;
  // AN UNDERDOSE WAS NOT THE DOSE, for every drug on a clock (antiRepeat, giveDrug): it starts no floor
  // and is not one of the doses a maximum counts, so the corrective dose goes straight in. (It went in,
  // so an adult's atropine and magnesium milligrams still count it.)
  const doses = given.filter(d => !d.under);
  if(kind === 'adenosine'){
    // ADENOSINE IS FOR A TACHYCARDIA WITH A PULSE. Into pulseless VT or VF it went in and scored "all
    // correct" — and the maximum line then said "no more adenosine, there is no pulse now". No pulse,
    // no adenosine: held for the rhythm, first dose or not (heldDrug, 'notIndicated').
    if(!state.pulse) return Infinity;
    // Round 6: ...and once the tachycardia has broken there is nothing for it to break. After a
    // cardioversion ended the SVT in sinus at 82, a second adenosine was held "the next dose can go in
    // fifty-four seconds" — and then flagged when it went in. Once adenosine has gone in, no more into a
    // rhythm that is not a tachyarrhythmia: 'notIndicated', no time promised. (The first still goes in,
    // flagged — giveDrug says why.)
    if(!CARDIOVERTABLE.has(state.rhythm) && given.length) return Infinity;
    const last = doses[doses.length - 1];
    if(!last) return 0;
    if(doses.length >= (rule.maxDoses || 2)) return Infinity;      // 6 then 12 (0.1 then 0.2 mg/kg)
    return Math.max(0, DRUG_FLOOR.adenosine - (state.t - last.t));
  }
  if(kind === 'naloxone'){
    const last = doses[doses.length - 1];
    return last ? Math.max(0, floorOf(rule, 'naloxone') - (state.t - last.t)) : 0;
  }
  if(kind === 'atropine'){
    // In arrest the first dose is given and flagged (it left the algorithm in 2010); a repeat is held.
    if(!state.pulse) return given.some(d => d.pulseless) ? Infinity : 0;
    const withPulse = given.filter(d => !d.pulseless), counted = withPulse.filter(d => !d.under), last = counted[counted.length - 1];
    if(isChild(script)){ if(counted.length >= (rule.maxDoses || 2)) return Infinity; }
    else {
      const mg = withPulse.reduce((s, d) => s + (d.doseMg != null ? d.doseMg : (rule.mg || 1)), 0);
      if(mg >= (rule.max || 3) * 0.97) return Infinity;
    }
    if(!last) return 0;
    return Math.max(0, floorOf(rule, 'atropine') - (state.t - last.t));
  }
  if(kind === 'magnesium'){
    // MAGNESIUM HAS A CLOCK AND A CEILING TOO (Kim's complaint was back-to-back medication; 20 g went in
    // in a minute and scored "all correct"). Defaults for Kim to confirm: an adult 1-2 g a dose (torsades),
    // a repeat no sooner than five minutes, 4 g in all; a child 25-50 mg/kg a dose (2 g at most) and one
    // repeat after five minutes. A script may set `maxDoses`, `maxMg` or `everySec`.
    const last = doses[doses.length - 1];
    if(isChild(script)){ if(doses.length >= (rule.maxDoses || 2)) return Infinity; }
    else if(given.reduce((s, d) => s + (d.doseMg != null ? d.doseMg : (rule.mg || 2000)), 0) >= (rule.maxMg || 4000) * 0.97) return Infinity;
    if(!last) return 0;
    return Math.max(0, floorOf(rule, 'magnesium') - (state.t - last.t));
  }
  return 0;
}
// THE HOLD ON ONE ORDER, for the drugs: { wait, reason }. The clock first, for an order it applies to,
// then what only the dose decides (doseHold). readyIn and holdReason answer with it when they are given
// the order's words, and heldDrug says it — one reckoning for all three.
function orderWait(state, script, kind, order, route){
  if(!state || !script || state.ended === 'death') return { wait: 0, reason: null };
  const text = bolusPart(order);
  if(route == null) route = routeOf(text);
  if(clockApplies(state, script, kind, text, route)){
    const wait = dueIn(state, script, kind, route);
    // ...and when this dose would still be held once the clock has run — a further underdose whose own
    // window runs longer (a newborn's IV dose goes in off the clock after a tube dose, and may be small) —
    // the time she gives is the later one (round 6): "due in two minutes six", then at 3:24 "under the
    // dose" for the same order.
    const dh = wait && wait !== Infinity ? doseHold(state, script, kind, text) : null;
    if(wait) return { wait: dh && dh.wait !== Infinity && dh.wait > wait ? dh.wait : wait, reason: clockReason(state, script, kind, wait) };
  }
  return doseHold(state, script, kind, text) || { wait: 0, reason: null };
}
// Which orders the clock holds: a bolus. A drip is titrated and never held as a repeat. Epinephrine is
// on its clock only as an arrest (or a child's) systemic bolus (epiTimed); a newborn's IV dose that
// follows a tube dose goes in as soon as the line is in.
function clockApplies(state, script, kind, text, route){
  if(kind !== 'epinephrine') return !isInfusion(text);
  if(!epiTimed(state, script, text) || state.lastEpiT == null) return false;
  // Not indicated (a child or newborn with a pulse at sixty or more): held for that, whatever the route.
  if(epiNotIndicated(state, script)) return true;
  const timed = state.drugs.filter(d => d.name === 'epinephrine' && d.timed), lastT = timed[timed.length - 1];
  // (An order with no route is the IV dose — see dueIn.)
  return !(isNeonate(script) && lastT && lastT.route === 'et' && (route == null || route === 'iv' || route === 'io'));
}
// A child or a newborn with a pulse and a heart rate of sixty or more: PALS and NRP give an epinephrine
// bolus for a rate under sixty despite ventilation (and compressions), so this patient is not one — after
// ROSC as much as before an arrest. (An adult with a pulse is A12's: one arrest dose flagged, the rest
// held on the dose — doseHold; push-dose epinephrine and a drip are that patient's.)
function epiNotIndicated(state, script){ return !!state.pulse && isChild(script) && state.hr >= 60; }
// WHAT ONLY THE DOSE DECIDES.
//   underdose     The last dose of this drug was UNDER its range, and so is this order. The first was not
//                 the dose — it starts no clock, and the full dose goes straight in — but a second small
//                 one inside the drug's floor is the same error again, and nothing held it: epinephrine
//                 0.5 mg ten times in a minute was 5 mg, amiodarone 150 ten times 1500 mg. Held, and the
//                 nurse names the full dose. Past the floor another underdose goes in, and is flagged.
//   notIndicated  A second cardiac-arrest dose of epinephrine — a bolus of 0.5 mg or more — at an adult
//                 with a pulse. The first is given and flagged (giveDrug); the rest piled up without limit.
//                 Push-dose epinephrine and a drip are the perfusing patient's, and go in.
function doseHold(state, script, kind, text){
  if(isInfusion(text)) return null;
  const bol = state.drugs.filter(d => d.name === kind && !d.infusion && !(kind === 'epinephrine' && offAlgorithmRoute(d.route)));
  if(kind === 'epinephrine' && codeDoseAtPulse(state, script, parseDose(text, script).mg, routeOf(text))
     && bol.some(d => !d.pulseless && d.ok === false && codeDoseAtPulse(state, script, d.doseMg, d.route) && sincePulseLost(state, d)))
    return { wait: Infinity, reason: 'notIndicated' };
  const last = bol[bol.length - 1];
  // A child's "under" means something only against the case's own weight-based rule: with none, the
  // adult number stood in (150 mg of amiodarone for a newborn) and is no dose to hold anyone to.
  // (An adult lidocaine bolus of 1 mg/kg or more was the dose, however it was graded — lidoCounts.)
  if(!last || !last.under || (isChild(script) && !((script.drugs || {})[kind]))) return null;
  const adultLido = kind === 'lidocaine' && !isChild(script);
  if(adultLido && lidoCounts(last, script)) return null;
  // THE LIDOCAINE REPEAT IS NOT AN UNDERDOSE (round 6). The ACLS card gives 1-1.5 mg/kg, then 0.5-0.75
  // mg/kg. Once a first dose of 1 mg/kg or more is in, an order inside the repeat band is the repeat —
  // it was held as "under the dose, the full dose is 123 mg", and that button then offered 2.5 mg/kg in
  // four minutes. (What the repeat's timing is, antiRepeat decides.)
  if(adultLido && lidoFirstIn(state, script) && lidoRepeatDose(text, script)) return null;
  // How long a further underdose is held: the drug's own floor — and for an adult's arrest lidocaine the
  // second antiarrhythmic's slot (A6), the cycle's 108 s and the next shock, not the five minutes of the
  // drug table (which held the card's repeat three minutes after it was due).
  let left, andShock = false;
  if(kind === 'amiodarone') left = (state.pulse ? 600 : DRUG_FLOOR.amiodarone) - (state.t - last.t);
  else if(adultLido && !state.pulse && SHOCKABLE.has(state.rhythm)){
    const floorLeft = Math.max(0, DRUG_FLOOR.amiodarone - (state.t - last.t));
    andShock = !shockSince(state, last);
    left = andShock ? Math.max(floorLeft, readyIn(state, script, 'shock'), 1) : floorLeft;
  } else left = floorOf((script.drugs || {})[kind], kind) - (state.t - last.t);
  if(left <= 0 || !giveDrug(state, script, kind, text, 'dry').under) return null;
  // `andShock`: the window also waits for the next shock (the event carries it, as a child's lidocaine
  // infusion hold does) — its time alone is not when another small dose would go in.
  return Object.assign({ wait: left, reason: 'underdose' }, andShock ? { andShock } : {});
}
// ACLS LIDOCAINE, 1-1.5 mg/kg THEN 0.5-0.75 mg/kg (round 6). An adult bolus of 1 mg/kg or more (about 5%
// slack) IS the first dose — whatever band giveDrug grades it against — so the repeat after it is the
// repeat: timed as one (antiRepeat), offered as one (expectedDoseMg), and never held as an underdose.
function lidoCounts(d, script){ return !d.under || (d.doseMg != null && d.doseMg >= 0.95 * weightOf(script)); }
function lidoFirstIn(state, script){ return state.drugs.some(d => d.name === 'lidocaine' && !d.infusion && lidoCounts(d, script)); }
// An order inside the 0.5-0.75 mg/kg repeat band (the same slack giveDrug gives the repeat).
function lidoRepeatDose(text, script){ const mg = parseDose(text, script).mg; return mg != null && mg >= 0.5 * weightOf(script) * 0.95; }
// An arrest-size epinephrine bolus at an adult with a pulse — the dose giveDrug flags there: 0.5 mg or
// more, not IM or SC, not a drip (the caller has said which).
function codeDoseAtPulse(state, script, mg, route){
  return !!state.pulse && !isChild(script) && !compressionsIndicated(state, script) && mg != null && mg >= 0.5 && !offAlgorithmRoute(route);
}
// Given since the patient last lost a pulse (a dose or a shock from before an arrest is not this pulse's).
function sincePulseLost(state, x){
  const eps = state.episodes || [], e = eps[eps.length - 1];
  return !e || x.t >= e.t;
}
// An unsynchronized shock already given to this patient WITH a pulse, and flagged, since the pulse was
// last lost.
function shockedAtPulse(state){
  return state.shocks.some(x => !x.sync && x.episode == null && x.ok === false && sincePulseLost(state, x));
}
// THE REPEAT ANTIARRHYTHMIC, worked out once for readyIn, holdReason and the nurse's words, so the
// button, the Hint and what she says can never part company. Returns the wait and why:
//   clock          a timed wait — the one-fifty running over ten minutes, lidocaine's five minutes
//                  (its SECOND arrest bolus: the cycle's floor, like the second amiodarone — `second`)
//   afterShock     waiting ONLY on the next shock: the floor will have run out by the time a shock
//                  is allowed, so "after the next shock" is the whole truth
//   clockAndShock  a shock AND a time: the floor outlasts the next shock ("the next dose goes in
//                  after the next shock" used to be refused straight after that shock, 48 s in)
//   max            the arrest's doses, or 3 mg/kg of lidocaine, are in
//   notIndicated   the arrest is in PEA or asystole: amiodarone and lidocaine are for VF/pVT
//   infusion       a child's lidocaine: the infusion is next (PALS); `andShock` when the fifteen-minute
//                  repeat bolus would also wait for the next shock
// Which dose it is timed from: amiodarone, this arrest's doses (the perfusing 150 over ten minutes
// is not the arrest's 300); lidocaine, every bolus the patient has had — its maximum is hers, not the
// arrest's. A dose the team flagged as UNDER the range was not the dose (see giveDrug): it neither
// starts the clock nor counts as the first, and the corrective dose goes straight in.
function antiRepeat(state, script, kind){
  const rule = (script.drugs && script.drugs[kind]) || {};
  const bol = state.drugs.filter(d => d.name === kind && !d.infusion);
  // (An adult's lidocaine of 1 mg/kg or more was the first dose, however it was graded — lidoCounts.)
  const counted = bol.filter(d => kind === 'lidocaine' && !isChild(script) ? lidoCounts(d, script) : !d.under);
  const R = (wait, reason, extra) => Object.assign({ wait, reason: wait ? reason : null }, extra || {});
  if(kind === 'amiodarone' && state.pulse){
    // 150 mg for a perfusing tachycardia runs over ten minutes; another bolus waits for it.
    const perf = counted.filter(d => !d.pulseless), lastP = perf[perf.length - 1];
    return R(lastP ? Math.max(0, 600 - (state.t - lastP.t)) : 0, 'clock', { last: lastP });
  }
  const pool = kind === 'amiodarone' ? counted.filter(d => d.pulseless) : counted;
  const last = pool[pool.length - 1];
  if(!last) return R(0);
  // Amiodarone and lidocaine are the drugs of refractory VF/pVT. In PEA or asystole a repeat is not
  // "after the next shock" — no shock is coming — it is not indicated (the first is given and, into
  // asystole, flagged; a repeat is held, like atropine).
  if(!state.pulse && !SHOCKABLE.has(state.rhythm)) return R(Infinity, 'notIndicated', { last });
  let floorLeft;
  if(kind === 'amiodarone'){
    if(pool.length >= (rule.maxDoses || (isChild(script) ? 3 : 2))) return R(Infinity, 'max', { last });
    floorLeft = Math.max(0, DRUG_FLOOR.amiodarone - (state.t - last.t));
  } else if(isChild(script)){
    // PALS: the bolus is followed by an infusion (20-50 mcg/kg/min). A repeat bolus only when the
    // infusion is started more than fifteen minutes after the first bolus — so once 900 s have gone
    // by with no infusion running, one repeat 1 mg/kg bolus; never with the infusion on, never a third.
    const infusing = state.drugs.some(d => d.name === 'lidocaine' && d.infusion);
    if(pool.length >= 2) return R(Infinity, 'max', { last });
    if(infusing) return R(Infinity, 'infusion', { last });
    floorLeft = Math.max(0, 900 - (state.t - pool[0].t));
    // In the arrest that repeat also waits for the next shock, as every antiarrhythmic repeat does.
    // The wait said only the fifteen minutes (864 s), and at 864 s with no shock she held it again:
    // `andShock` carries the shock, as clockAndShock does for the adult (the words stay the infusion's —
    // the infusion, not a second bolus, is what PALS wants next).
    const andShock = !state.pulse && !shockSince(state, last);
    if(floorLeft) return R(Math.max(floorLeft, andShock ? readyIn(state, script, 'shock') : 0, 1), 'infusion', { last, andShock });
  } else {
    // ACLS: 1-1.5 mg/kg, then 0.5-0.75 mg/kg every 5-10 minutes, to 3 mg/kg. Every bolus counts
    // toward the maximum, the flagged ones too — they went in. Held when the NEXT repeat would pass
    // 3 mg/kg, not after it has.
    const kg = weightOf(script);
    const mg = bol.reduce((s, d, i) => s + (d.doseMg != null ? d.doseMg : (i === 0 ? (rule.perKg || 1.5) * kg : 0.625 * kg)), 0);
    if(mg + 0.625 * kg > 3 * kg * 1.03) return R(Infinity, 'max', { last });
    // The arrest's SECOND bolus is the algorithm card's second antiarrhythmic dose (amiodarone 150 mg
    // OR lidocaine 0.5-0.75 mg/kg): the cycle's floor and the next shock, like the second amiodarone.
    // Only when the first bolus was this patient's first, given in an arrest; a third bolus, and every
    // repeat with a pulse, keeps the drug table's five minutes (see DRUG_FLOOR).
    const second = !state.pulse && pool.length === 1 && last.pulseless;
    floorLeft = Math.max(0, (second ? DRUG_FLOOR.amiodarone : DRUG_FLOOR.lidocaine) - (state.t - last.t));
    if(second) return afterNextShock(R, state, script, last, floorLeft, { second });
  }
  return afterNextShock(R, state, script, last, floorLeft);
}
// With a pulse there is no shock to wait for. In the arrest the repeat also waits for the next
// shock, if the rhythm is still shockable after it (AHA: after the next shock).
function afterNextShock(R, state, script, last, floorLeft, extra){
  if(state.pulse || shockSince(state, last)) return R(floorLeft, 'clock', Object.assign({ last, floorLeft }, extra));
  const shockWait = readyIn(state, script, 'shock');
  return R(Math.max(floorLeft, shockWait, 1), floorLeft <= shockWait ? 'afterShock' : 'clockAndShock', Object.assign({ last, floorLeft, shockWait }, extra));
}
// A defibrillation since this dose — one given in an arrest (a shock at a patient with a pulse is
// not the "next shock" of VF). Any arrest, not only the dose's own: a dose from the arrest before a
// ROSC, looked for only in that arrest, never found its shock in the next one, and the repeat stayed
// "after the next shock" through every shock that followed.
// Ordered by the record, not the clock: a shock ordered straight after the dose, in the same code
// second, is the next shock (compared by time it never was, and "after the next shock" outlived it).
function shockSince(state, last){
  return state.shocks.some((x, i) => !x.sync && x.episode != null && (last.shocksBefore != null ? i >= last.shocksBefore : x.t > last.t));
}
// This arrest has already had a shock into PEA or asystole — the one the team gives, and flags.
function shockedNotShockable(state){ return episodeDefibs(state).some(x => !SHOCKABLE.has(x.rhythmBefore)); }
// WHY an order would be held now, for the page: null when readyIn is 0, else one of 'clock' (a timed
// wait), 'afterShock' (waiting only on the next shock), 'clockAndShock', 'max', 'notIndicated',
// 'notShockable' or 'infusion' (a child's lidocaine: the infusion is next). The same reckoning the
// nurse uses, so the page can say what she will say. Given the order's words (`order`, as readyIn),
// also 'underdose' (a further underdose inside its floor) and 'notIndicated' for a second arrest-dose
// epinephrine at a patient with a pulse (doseHold).
// 'notShockable' covers a shock at a patient WITH a pulse too — the engine's own word for it ("Not a
// shockable rhythm — there is a pulse…", deliverShock): held for the rhythm, not the clock, and so
// never scored as a shock asked for before the rhythm check.
function holdReason(state, script, kind, route, order){
  if(order != null && DRUG_FLOOR[kind]) return orderWait(state, script, kind, order, route).reason;
  return clockReason(state, script, kind, dueIn(state, script, kind, route));
}
function clockReason(state, script, kind, wait){
  if(!wait) return null;
  // After ROSC or a 'stable' ending a shock is held for the pulse (round 6): 'pulse'.
  if(kind === 'shock') return wait === Infinity ? (state.ended && state.pulse ? 'pulse' : 'notShockable') : 'clock';
  if(kind === 'amiodarone' || kind === 'lidocaine') return antiRepeat(state, script, kind).reason;
  // Atropine in an arrest, adenosine with no pulse: the wrong drug for a pulseless patient.
  if((kind === 'atropine' || kind === 'adenosine') && wait === Infinity && !state.pulse) return 'notIndicated';
  // Round 6: adenosine once the tachycardia has broken, epinephrine at a child or newborn with a pulse at
  // sixty or more — the wrong drug for the patient as she is now, not a maximum or a time (dueIn).
  if(kind === 'adenosine' && wait === Infinity && !CARDIOVERTABLE.has(state.rhythm)) return 'notIndicated';
  if(kind === 'epinephrine' && wait === Infinity && epiNotIndicated(state, script)) return 'notIndicated';
  return wait === Infinity ? 'max' : 'clock';
}
// The dose the next order of this drug should carry, in mg (null when there is no single right
// number — a titrated or perfusing epinephrine). The page's drug buttons read it, so a button can
// never offer a dose giveDrug would flag (the lidocaine button kept offering the first dose).
// Calcium's number is calcium CHLORIDE, as the script states it; pass `salt` 'gluconate' (or the
// order's own words) for the gluconate dose — three times the weight, for the same calcium.
function expectedDoseMg(state, script, name, salt){
  if(name === 'calcium' && /gluconate/i.test(String(salt || ''))){
    const cl = expectedDoseMg(state, script, 'calcium');
    return cl == null ? null : round2(cl * 3);
  }
  const rule = (script && script.drugs && script.drugs[name]) || {};
  const kg = weightOf(script || {});
  const given = (state.drugs || []).filter(d => d.name === name && !d.infusion);
  // A flagged underdose was not the dose (antiRepeat): after 150 mg as the first arrest amiodarone
  // the button still offers the 300.
  // (An adult's lidocaine of 1 mg/kg or more WAS the first dose, however it was graded: after the card's
  // 1 mg/kg the button offered 123 mg — 1.5 mg/kg again, 2.5 mg/kg in four minutes. Round 6, lidoCounts.)
  const counted = given.filter(d => name === 'lidocaine' && !isChild(script) ? lidoCounts(d, script) : !d.under);
  // Lidocaine's second bolus is the 0.5-0.75 mg/kg repeat, with a pulse or without. A child has none
  // to offer while the infusion is next — only the PALS repeat once fifteen minutes have gone by.
  if(name === 'lidocaine' && counted.length){
    if(!isChild(script)) return round2(0.625 * kg);
    return antiRepeat(state, script, 'lidocaine').reason === 'infusion' || counted.length >= 2 ? null : round2((rule.perKg || 1) * kg);
  }
  if(name === 'amiodarone' && rule.perKg == null)
    return state.pulse ? (rule.perfusing || 150) : (counted.some(d => d.pulseless) ? (rule.second || 150) : (rule.first || 300));
  // ...and after a flagged 3 mg of adenosine the next is still the 6 mg, then the 12.
  if(name === 'adenosine' && (rule.perKg == null || rule.first != null)) return counted.length ? (rule.second || 12) : (rule.first || 6);
  if(name === 'epinephrine' && state.pulse && rule.perKg == null) return null;
  // A child's magnesium is 25-50 mg/kg, never more than 2 g (see readyIn).
  if(name === 'magnesium' && rule.perKg != null) return round2(Math.min(rule.perKg * kg, 2000));
  if(rule.perKg != null) return round2(rule.perKg * kg * (name === 'adenosine' && counted.length ? 2 : 1));
  return rule.mg != null ? rule.mg : null;
}
// When a player's pulse check is allowed, and what it does. `wait` > 0 is held; `full` closes the
// cycle and can find a pulse; otherwise it only reports what the team already knows. A check
// never finds a pulse early — the ROSC rows resolve at the end of a cycle, whoever calls it.
function checkWindow(state, script){
  if(state.pulse || isNeonate(script) || state.ended) return { wait: 0, full: true };
  if(state.cycleT >= DUE) return { wait: 0, full: true };                       // the rhythm check
  if(state.episodeT != null && state.t - state.episodeT < CHECK_GRACE) return { wait: 0, confirm: true };  // confirming the arrest
  // ...and the twelve seconds after that, like the twelve after the team's own check (below): the arrest
  // has just been confirmed, so a check repeats what it found. Held there, the check the Hint offered
  // in the confirming seconds was refused one tick later.
  if(state.episodeT != null && state.cycle === 1 && state.t - state.episodeT < 2 * CHECK_GRACE) return { wait: DUE - state.cycleT, justChecked: true };
  // The team just checked. A check asked for now only repeats what it found (actInner answers it, and
  // holds nothing) — but it is not DUE: the next check is at the end of this cycle. Reading 0 here, the
  // Hint offered a pulse check that the nurse held six seconds later; the wait is the cycle's.
  if(state.cycle > 1 && state.cycleT <= CHECK_GRACE) return { wait: DUE - state.cycleT, justChecked: true };
  return { wait: DUE - state.cycleT };
}
// What the nurse says. The chat gets the full sentence; she SAYS the short one, so a burst of
// refusals cannot hold the next rhythm check behind ten seconds of explanation. Times are CODE
// time, the clock on the wall.
// `reason` is holdReason's word for it, carried on the event so the log says what the nurse said.
// `afterEnd`: held once the case had ended (ROSC, or 'stable'). The arrest's debrief does not score it
// (round 6, summary) — an ask after the ending is post-arrest care, not the arrest's timing — and the
// flag, not the clock, says so: after ROSC the code clock stands still until the page moves it, so an
// ask in the ROSC second has the ROSC's own time.
function held(state, kind, long, short, wait, reason, extra){
  const again = state.lastHeld && state.lastHeld.kind === kind && state.t - state.lastHeld.t < 18;
  state.lastHeld = { kind, t: state.t };
  return ev(state, 'withheld', again ? short : long,
    Object.assign({ held: kind, say: short, waitSec: wait === Infinity ? null : Math.round(wait) }, reason ? { reason } : {},
      state.ended ? { afterEnd: true } : {}, extra || {}));
}
// "Ninety seconds ago", or "just now" — never "zero seconds ago".
function agoText(sec){ return sec < 6 ? 'just now' : spokenTime(sec) + ' ago'; }
function chestLine(state){ return state.cpr ? 'Staying on the chest.' : 'Compressions are off — back on the chest, please.'; }
// `joules`: the energy the held order asked for — what "yes" to her question delivers, synchronized.
function heldShock(state, script, joules){
  const wait = readyIn(state, script, 'shock');
  if(!wait) return null;
  // A second shock into a rhythm that is not shockable: the first was delivered and flagged — that
  // is the teaching — and the team will not do it again. Held for the rhythm, not the clock.
  // With a pulse the same: one unsynchronized shock into a perfusing rhythm went in, flagged, and said
  // what the rhythm needs; no second one. (What she says follows that shock's own words.)
  // Round 6: her "do you want it synchronized?" is a question, and "yes" (or "sync it") answers it —
  // it went to the turn engine and nothing happened (askSync, actInner).
  // After ROSC or a 'stable' ending (round 6): held for the pulse, a hold like any other — it used to be
  // a bare refusal the page could not tell from its own "now".
  if(wait === Infinity && state.ended && state.pulse)
    return held(state, 'shock', 'There is a pulse, doctor — no shock.', 'There is a pulse, doctor — no shock.', Infinity, 'pulse');
  if(wait === Infinity && state.pulse && CARDIOVERTABLE.has(state.rhythm)){
    askSync(state, joules);
    return held(state, 'shock', 'There is a pulse, doctor — do you want it synchronized? An unsynchronized shock has already gone in.',
      'There is a pulse, doctor — synchronized?', Infinity, 'notShockable', { question: 'sync' });
  }
  if(wait === Infinity && state.pulse)
    return held(state, 'shock', 'There is a pulse, doctor, and this rhythm is not treated with a shock — no more electricity.',
      'There is a pulse, doctor — no shock.', Infinity, 'notShockable');
  if(wait === Infinity)
    return held(state, 'shock', 'That is still not a shockable rhythm, doctor — no more electricity. ' + chestLine(state) +
      ' Compressions, epinephrine, and the reversible causes.', 'Not shockable, doctor — back on the chest.', Infinity, 'notShockable');
  const d = episodeDefibs(state), gap = state.t - d[d.length - 1].t;
  // (R8: with a pre-charge waiting she does not promise to charge a machine that is already charged. R10, M4: nor to charge
  // one that is not — "I will have it charged for the rhythm check" was a promise nobody kept for an uncalled rhythm.)
  return held(state, 'shock',
    'Not yet, doctor — ' + (gap < 6 ? 'we just shocked' : 'we shocked ' + spokenTime(gap) + ' ago') +
      '. Two full minutes of compressions first — ' + (pendingCharge(state) ? 'we are charged for the rhythm check in ' : 'shock at the rhythm check in ')
      + spokenTime(wait) + '. ' + chestLine(state),
    'Not yet — rhythm check in ' + spokenTime(wait) + '.', wait, 'clock');
}
function heldCheck(state, script){
  const wait = readyIn(state, script, 'check');
  // Straight after the team's check the wait runs, but a check asked for is answered, not held: it
  // repeats what the check found (actInner) — a note, not scored.
  if(!wait || checkWindow(state, script).justChecked) return null;
  const d = episodeDefibs(state), lastShock = d[d.length - 1];
  const where = lastShock && state.t - lastShock.t < 6 ? 'We just shocked, doctor'
    : state.cycleT < 6 ? 'We are at the start of the cycle, doctor'
    : 'We are ' + spokenTime(state.cycleT) + ' into the cycle, doctor';
  return held(state, 'check',
    where + ' — the rhythm check comes at the end of the cycle, in ' + spokenTime(wait) + '. ' + chestLine(state),
    'Rhythm check in ' + spokenTime(wait) + '.', wait, 'clock');
}
// The team holds an order for its clock (heldDrugClock), or for its dose (heldDrugDose, doseHold) — after
// ROSC and a 'stable' ending as well: the pulse coming back does not reset the repeat rules (dueIn).
function heldDrug(state, script, name, text, route){
  if(state.ended === 'death') return null;
  return heldDrugClock(state, script, name, text, route) || heldDrugDose(state, script, name, text);
}
// Round 9 (K2, giveDrug): the holds after which the drip ordered with a bolus still starts. The bolus it follows is in —
// a dose that was the dose, not a flagged underdose — no drip of that drug is running yet, and it is a drug that is run
// as a drip (DRIP_DRUGS: never atropine or adenosine — with the bolus held there is nothing to give).
const DRIP_AFTER_HOLD = ['clock', 'afterShock', 'clockAndShock', 'max', 'infusion'];
function dripFollowsHold(state, name, h){
  return DRIP_AFTER_HOLD.indexOf(h.reason) !== -1 && DRIP_DRUGS.indexOf(name) !== -1 && !state.drugs.some(d => d.name === name && d.infusion)
    && state.drugs.some(d => d.name === name && !d.infusion && !d.under);
}
function heldDrugDose(state, script, name, text){
  const h = DRUG_FLOOR[name] && doseHold(state, script, name, text);
  if(!h) return null;
  if(h.reason === 'notIndicated') return held(state, name,
    'That is a cardiac-arrest dose, doctor, and there is a pulse — push-dose epinephrine is 10-20 mcg, or run an infusion.',
    'That is a code dose, doctor — push-dose is 10-20 mcg.', Infinity, 'notIndicated');
  const full = expectedDoseMg(state, script, name);
  const tube = etDoseSaid(state, script, name, text);
  const says = tube ? 'the full dose is ' + tube : full != null ? 'the full dose is ' + doseSaid(full) : 'give the full dose';
  return held(state, name, 'That was under the dose, doctor — ' + says + '.', 'Under the dose — ' + says + '.', h.wait, 'underdose',
    h.andShock ? { andShock: true } : null);
}
// THE TUBE HAS ITS OWN DOSE (round 6). Down the tube she named the IV dose — "the full dose is 1 mg" — and
// then held that same 1 mg down the tube, because the tube's band is 2-2.5 mg. Whatever she names, ordered
// by the same route, goes in: the adult 2-2.5 mg; a child 0.1 mg/kg, 2.5 mg at most (PALS "if no IV/IO
// access"); a newborn 0.1 mg/kg, the top of NRP's 0.05-0.1 (the case's own tube dose). null when the
// order is not the tube dose (giveDrug's tubeEpi).
function etDoseSaid(state, script, name, text){
  if(name !== 'epinephrine' || routeOf(text) !== 'et' || !(isChild(script) || !state.pulse)) return null;
  const kg = weightOf(script);
  // With a line in, the tube is not the route at all (giveDrug flags a tube dose then): she names the dose
  // for the line, and says so.
  if(state.ivAccess || state.io || state.flags.uvc){
    const full = expectedDoseMg(state, script, name);
    return full != null ? doseSaid(full) + (isNeonate(script) ? ' through the line' : ' IV or IO') : null;
  }
  if(isNeonate(script)) return doseSaid(0.1 * kg) + ' down the tube';
  if(isChild(script)) return doseSaid(Math.min(0.1 * kg, 2.5)) + ' down the tube';
  return '2 to 2.5 mg down the tube';
}
// A dose as she says it: grams from a gram up, whole milligrams from ten.
function doseSaid(mg){ return mg >= 1000 ? round2(mg / 1000) + ' g' : (mg >= 10 ? Math.round(mg) : doseNum(mg)) + ' mg'; }
function heldDrugClock(state, script, name, text, route){
  // An infusion is a rate, started after the bolus — never held as a repeat bolus; epinephrine is held
  // only as an arrest (or a child's) bolus. One test, shared with readyIn (clockApplies).
  if(!DRUG_FLOOR[name] || !clockApplies(state, script, name, text, route)) return null;
  if(name === 'epinephrine'){
    if(!readyIn(state, script, 'epinephrine', route)) return null;
    // (This order's own wait: the clock, or longer when the dose would be held after it — orderWait.)
    const wait = orderWait(state, script, 'epinephrine', text, route).wait;
    // Not indicated, not "not yet" (round 6): no time promised for a dose the team would then flag. Said by
    // the rate — the rhythm is the doctor's to call.
    if(wait === Infinity && epiNotIndicated(state, script)) return held(state, 'epinephrine',
      'The heart rate is ' + state.hr + ', doctor — epinephrine is for a rate under 60 despite ventilation' +
        (isNeonate(script) ? ' and compressions' : '') + '. No more epinephrine while the rate holds.',
      'Rate is ' + state.hr + ' — no epinephrine, doctor.', Infinity, 'notIndicated');
    return held(state, 'epinephrine',
      'Not yet, doctor — the last epi went in ' + agoText(state.t - state.lastEpiT) + '. ' +
        'It goes every three to five minutes; the next one is due in ' + spokenTime(wait) + '.',
      'Not yet — epi is due in ' + spokenTime(wait) + '.', wait, 'clock');
  }
  const child = isChild(script);
  // NEVER PROMISE WHAT SHE THEN REFUSES. "If it is still shockable after the next shock, the next dose
  // goes in then" was said while the floor still had a minute and a half to run past that shock, and
  // the dose was held again straight after it. So the words follow antiRepeat's reason: the shock
  // alone only when the floor will have run out by the time a shock is allowed; otherwise the time
  // AND the shock.
  if(name === 'amiodarone' || name === 'lidocaine'){
    const a = antiRepeat(state, script, name), wait = a.wait;
    if(!wait) return null;
    const ago = a.last ? agoText(state.t - a.last.t) : '';
    const Name = name === 'amiodarone' ? 'Amiodarone' : 'Lidocaine';
    const went = (name === 'amiodarone' ? 'The amiodarone' : 'Lidocaine') + ' went in ' + ago + ', doctor';
    const next = name === 'amiodarone' ? 'the next dose' : 'the repeat';
    // No shock wording: no shock is coming. Uncalled, she does not read the strip for the doctor —
    // she asks for the call that decides it.
    if(a.reason === 'notIndicated') return held(state, name, heardName(state)
      ? Name + ' is for VF and pulseless VT, doctor — not for ' + heardName(state) + '. ' + chestLine(state) +
        ' Compressions, epinephrine, and the reversible causes.'
      : 'Another ' + name + ' is for VF and pulseless VT, doctor — what is the rhythm on the monitor? ' + chestLine(state),
      heardName(state) ? 'No ' + name + ' for this rhythm, doctor.' : 'Call the rhythm first, doctor.', wait, 'notIndicated');
    if(a.reason === 'max') return held(state, name, name === 'amiodarone'
      ? 'That is the maximum amiodarone for an arrest, doctor — ' + (child ? 'three doses are' : 'two doses are') +
        ' in. Keep shocking at the checks, and look again at the pads and the reversible causes.'
      : child ? 'That is the lidocaine bolus and its one repeat, doctor — it goes on as an infusion now, twenty to fifty micrograms per kilo per minute.'
      : 'Another dose would take the lidocaine past three milligrams per kilo, doctor — that is the maximum.',
      Name + ' is at its maximum, doctor.', wait, 'max');
    if(a.reason === 'infusion'){
      const e = held(state, name, wait === Infinity
        ? 'The lidocaine infusion is running, doctor — no more boluses.'
        : 'In a child the lidocaine bolus is followed by an infusion, doctor — twenty to fifty micrograms per kilo per minute, not a second bolus.',
        'Lidocaine goes on as an infusion now, doctor.', wait, 'infusion');
      if(a.andShock) e.andShock = true;           // the fifteen-minute repeat would also wait for a shock
      return e;
    }
    if(name === 'amiodarone' && state.pulse) return held(state, name,
      went + ' — the one-fifty runs over ten minutes. Another dose can go in ' + spokenTime(wait) + ' from now.',
      'Amiodarone again in ' + spokenTime(wait) + '.', wait, 'clock');
    if(a.reason === 'afterShock'){
      const e = held(state, name, went + '. If it is still shockable after the next shock, ' + next + ' goes in then.',
        Name + ' again after the next shock, doctor.', wait, 'afterShock');
      e.afterShock = true;
      return e;
    }
    // Lidocaine repeats on the drug table's clock — 0.5-0.75 mg/kg every five to ten minutes — except
    // the arrest's second bolus, which is on the cycle's, like the second amiodarone.
    const every = name === 'lidocaine' && !a.second ? '. It repeats every five to ten minutes' : '';
    if(a.reason === 'clockAndShock') return held(state, name,
      went + every + '. ' + capitalize(next) + ' can go in ' + spokenTime(wait) + ' from now, after the next shock if it is still shockable.',
      Name + ' again in ' + spokenTime(wait) + ', after the next shock.', wait, 'clockAndShock');
    return held(state, name,
      went + every + ' — ' + next + ' can go in ' + spokenTime(wait) + ' from now.',
      Name + ' again in ' + spokenTime(wait) + '.', wait, 'clock');
  }
  const wait = readyIn(state, script, name, route);
  if(!wait) return null;
  // "Went in … ago" is timed from the dose the clock runs from — never a flagged underdose (dueIn).
  const given = state.drugs.filter(d => d.name === name && !d.infusion && !d.under);
  const pool = name === 'atropine' && state.pulse ? given.filter(d => !d.pulseless)
    : name === 'adenosine' || name === 'naloxone' || name === 'magnesium' ? given : given.filter(d => d.pulseless);
  const last = pool[pool.length - 1];
  const ago = last ? agoText(state.t - last.t) : '';
  if(name === 'magnesium'){
    if(wait === Infinity) return held(state, name, child
      ? 'That is the magnesium and its one repeat, doctor — the maximum for a child.'
      : 'That is four grams of magnesium, doctor — the maximum.',
      'Magnesium is at its maximum, doctor.', wait, 'max');
    return held(state, name,
      'Magnesium went in ' + ago + ', doctor — a repeat waits five minutes. Next dose in ' + spokenTime(wait) + '.',
      'Magnesium again in ' + spokenTime(wait) + '.', wait, 'clock');
  }
  if(name === 'naloxone')
    return held(state, name,
      'Naloxone went in ' + ago + ', doctor — it can be repeated every two to three minutes; next dose in ' + spokenTime(wait) + '.',
      'Naloxone again in ' + spokenTime(wait) + '.', wait, 'clock');
  if(name === 'adenosine'){
    // Cardioversion is next only while there is a pulse to synchronize to. Once the tachycardia has
    // lost its pulse, "cardioversion is next" sent the player to a synchronized shock the team then
    // flagged — pulseless VT/VF is defibrillated, PEA and asystole get compressions and epinephrine.
    // Uncalled, she reports the pulse and asks for the read: "a shockable arrest" would read the strip
    // for the doctor (the blind-rhythm rule, as in checkFinding).
    // Round 5: with no pulse there is no adenosine at all — the first dose too (dueIn). It is the wrong
    // drug for the patient, not a maximum reached: 'notIndicated'.
    const no = state.drugs.some(d => d.name === 'adenosine') ? 'No more adenosine' : 'No adenosine';
    if(wait === Infinity && !state.pulse) return held(state, name, !heardName(state)
      ? no + ', doctor — there is no pulse now. Compressions — and the rhythm is up on the monitor: what is it?'
      : SHOCKABLE.has(state.rhythm)
      ? no + ', doctor — there is no pulse now. This is a shockable arrest: defibrillate, unsynchronized, and compressions.'
      : no + ', doctor — there is no pulse now. Compressions and epinephrine, and the reversible causes.',
      !heardName(state) ? 'No pulse, doctor — compressions, and read the rhythm.'
      : SHOCKABLE.has(state.rhythm) ? 'No pulse, doctor — defibrillate, and compressions.' : 'No pulse, doctor — compressions and epinephrine.', wait, 'notIndicated');
    // Round 6: the tachycardia has broken (dueIn). Said by the rate, never an invitation to another dose.
    if(wait === Infinity && !CARDIOVERTABLE.has(state.rhythm)) return held(state, name,
      'There is no tachycardia running for adenosine to break, doctor — the rate is ' + state.hr + '. No more adenosine.',
      'No tachycardia to break, doctor — no adenosine.', wait, 'notIndicated');
    if(wait === Infinity) return held(state, name,
      'That is both doses of adenosine, doctor. If the rhythm has not broken, the next step is synchronized cardioversion.',
      'Adenosine is done, doctor — cardioversion is next.', wait, 'max');
    return held(state, name,
      'The adenosine went in ' + ago + ' — give it a minute and watch the strip, doctor. The next dose can go in ' + spokenTime(wait) + '.',
      'Watch the strip — next adenosine in ' + spokenTime(wait) + '.', wait, 'clock');
  }
  if(name === 'atropine' && !state.pulse)
    return held(state, name, 'Atropine is not part of the arrest algorithm, doctor — compressions and epinephrine. ' + chestLine(state),
      'No atropine in an arrest, doctor.', wait, 'notIndicated');
  if(name === 'atropine'){
    if(wait === Infinity) return held(state, name, child
      ? 'That is two doses of atropine, doctor — the maximum. Epinephrine or pacing next.'
      : 'That is three milligrams of atropine, doctor — the maximum. Pace, or start a drip?',
      'Atropine is at its maximum, doctor.', wait, 'max');
    return held(state, name,
      'Atropine went in ' + ago + ', doctor — it goes every three to five minutes. Next dose in ' + spokenTime(wait) + '. ' +
        (child ? 'Keep ventilating — if the rate stays under sixty with poor perfusion, compressions and epinephrine.' : 'The pads are there if you want to pace.'),
      'Atropine again in ' + spokenTime(wait) + '.', wait, 'clock');
  }
  return null;
}

// EtCO2 is the one number that tells the player whether the compressions are
// working, so it follows what is happening rather than the script: perfusion
// while hands are on the chest, next to nothing when they come off.
function updateEtco2(state){
  if(state.ended === 'death'){ state.etco2 = 0; return; }
  if(state.pulse){ state.etco2 = Math.max(state.etco2, 35); return; }
  state.etco2 = state.cpr ? 12 : 6;
}

// ---------- parsing ----------
// Keeps '.', '/' and '-' because every dose and energy the player types leans on
// them: "0.1 mg/kg", "2 j/kg", "i-gel". Everything else becomes a space so the
// word-boundary patterns below cannot be defeated by punctuation.
function norm(s){ return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9./ -]/g, ' ').replace(/\s+/g, ' ').trim(); }
function num(re, text){ const m = norm(text).match(re); return m ? parseFloat(m[1]) : null; }

// Energy: "shock 200", "200 joules", "charge to 150 and shock", "2 j/kg", "max energy"
function shockEnergy(text, script, sync){
  const perKg = num(/(\d+(?:\.\d+)?)\s*(?:j|joules?)\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?\b/, text);
  if(perKg != null) return roundJoules(perKg * weightOf(script));
  // One digit too, when the unit is said: an infant's synchronized shock is 3-12 J (0.5-2 J/kg at 6 kg),
  // and "6 joules" read as no energy at all delivered the 3 J default.
  // ...and a decimal whole: "3.5 joules" for that infant was read from the digit after the point, and
  // 5 J — an energy nobody ordered — was delivered and read back.
  const stated = num(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:j\b|joules?)/, text);
  if(stated != null) return roundJoules(stated);
  // A bare number beside the electrical word is the energy. Round 6: the synchronized words too — "sync
  // 200 again" after a failed 200 J delivered 250 J (the next step) and "sync 150" the band's bottom, the
  // 200 and the 150 unheard — and a number right before "again". Not a number that is plainly something
  // else ("a 12 lead", "150 mg").
  const NOT_J = '(?!\\.\\d|\\s*(?:mg|mcg|micrograms?|ml|cc|kg|lead|leads|%|percent|bpm|beats|breaths|min|minutes?|sec|seconds?|times|x)\\b)';
  const bare = num(new RegExp('(?:shock|charge|defibrillate|sync|synch|synchroni[sz]\\w*|cardiover\\w*|again)(?:\\s+\\w+){0,3}?\\s+(\\d{2,3})\\b' + NOT_J), text);
  if(bare != null) return bare;
  // R9 (Kim's J8): an infant's energy is one digit — "charge to 6", "shock at 6" for a 6-kg SVT was dropped, and the 3 J
  // default went in. Read when it falls inside a child's bands (0.5 J/kg synchronized to 10 J/kg), never for an adult.
  const oneM = norm(text).match(new RegExp('(?:shock|charge|defibrillate|sync|synch|synchroni[sz]\\w*|cardiover\\w*|again)(?:\\s+\\w+){0,3}?\\s+(\\d|' + W_ONES.slice(1).join('|') + ')\\b' + NOT_J));
  const one = oneM ? (/^\d$/.test(oneM[1]) ? +oneM[1] : W_ONES.indexOf(oneM[1])) : null;
  if(one != null && infantJoules(one, script)) return one;
  const again = num(new RegExp('(?<![\\d.])(\\d{2,3})\\s+again\\b'), text);
  if(again != null) return again;
  // Round 7: "shock at max energy", "maximum joules" — the top of the band (the synchronized band for a
  // synchronized shock, `sync`). It went in at the 120 a charge was waiting at.
  return MAX_ENERGY_RE.test(norm(text)) ? maxJoules(script, !!sync) : null;
}
// An energy as the record and the read-back carry it: a whole joule from 10 J up (no dial offers
// 147.6 J), a tenth below that, where a newborn's or an infant's half-joule is a real difference.
function roundJoules(j){ return j >= 10 ? Math.round(j) : Math.round(j * 10) / 10; }
// A one-digit number that is a joule for this patient (R9, J8): a child's, inside 0.45-10 J/kg.
function infantJoules(n, script){ const kg = weightOf(script); return kg < 40 && n >= 0.45 * kg && n <= 10 * kg; }

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
  // The rung is this ARREST's defibrillation count. Counting every shock on record let two flagged
  // synchronized shocks, or a wrong shock while there was still a pulse, carry a child's FIRST
  // defibrillation up to the third rung — and 10 J/kg as a first shock was scored correct.
  const band = energyBand(script, episodeDefibs(state).length + 1);
  let ok = true, note = '';
  // With a pulse the rhythm is cardioverted, synchronized — "CPR and epinephrine" is the pulseless teaching.
  if(!shockable){ ok = false; note = !state.pulse
    ? 'Not a shockable rhythm — ' + before + ' is treated with CPR and epinephrine, not electricity.'
    : CARDIOVERTABLE.has(before)
      ? 'Not a shockable rhythm — there is a pulse, and ' + rhythmName(before) + ' is treated with synchronized cardioversion, not an unsynchronized shock.'
      : 'Not a shockable rhythm — there is a pulse, and ' + rhythmName(before) + ' is not treated with a shock.'; }
  else if(band && (j < band.lo || j > band.hi)){ ok = false;
    note = 'Energy out of range: ' + j + ' J for ' + band.says + '.'; }
  const rec = { t: state.t, joules: j, sync: false, rhythmBefore: before, rhythmAfter: before, ok, note,
    episode: state.pulse ? null : state.episode, check: state.checksDone };
  state.shocks.push(rec);
  // A charge waiting is spent by this shock; its event says so (round 7: `chargeEnd` — actInner marks it).
  rec.spentCharge = spendCharge(state);
  // Compressions resume immediately after a shock — in an ARREST. A patient with a pulse gets none.
  // The new cycle starts at the shock, unless the shock closed the last one on the two-minute grid
  // (cycleT already carried back below zero). A shock into PEA or asystole does not restart it:
  // it was the wrong therapy, and pushing back the rhythm check would punish the patient twice.
  if(!state.pulse){ state.cpr = true; if(shockable && state.cycleT > 0) state.cycleT = 0; }
  // What she says matches the note. "Does not respond to electricity" is true of PEA and asystole
  // only: a tachycardia WITH a pulse is exactly what electricity treats — synchronized — and telling
  // the player otherwise taught the opposite of the record's own correction.
  if(!shockable){
    return [ev(state, 'shock', !state.pulse
      ? 'Shock delivered — no change, that rhythm does not respond to electricity.'
      : CARDIOVERTABLE.has(before)
        ? 'Shock delivered, unsynchronized — no change on the monitor. There is a pulse, doctor: this rhythm needs a synchronized shock.'
        : 'Shock delivered — no change on the monitor. There is a pulse, doctor, and this rhythm is not treated with a shock.', { ok: false })];
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
  // A shock that CHANGES the rhythm says so, without naming the new one (setRhythm has made it
  // uncalled): "no change on the monitor" over torsades turning to VF hid the change the doctor must
  // now read.
  else if(row && row.to){ setRhythm(state, row.to); rec.rhythmAfter = row.to;
    out.push(ev(state, 'shock', 'Shock delivered — ' +
      (row.to !== before ? 'the rhythm has changed on the monitor' : heardName(state) ? 'still ' + heardName(state) : 'no change on the monitor') +
      '. Back on the chest.', { ok })); }
  else out.push(ev(state, 'shock', 'Shock delivered — no change on the monitor. Compressions.', { ok }));
  return out;
}

// "Shock him" with no number still has to fire — refusing it would make the
// engine argue with the player instead of showing them the consequence.
// The synchronized-shock band: the script's own, or for a child with none authored PALS 0.5-1 J/kg
// escalating to 2 J/kg (see the cardioversion branch in actInner).
function syncBand(script){ return (script.shock && script.shock.sync) || (weightOf(script) < 40 ? { perKg: [0.5, 2] } : null); }
// One step up from the last synchronized shock, and never past the top of the band: the adult
// steps a monophasic or biphasic device offers, or double the energy in a child (0.5 → 1 → 2 J/kg).
function nextSyncJoules(script, lastJ){
  const e = syncBand(script);
  if(e && e.perKg) return Math.min(Math.round(e.perKg[1] * weightOf(script)), Math.round((lastJ || 0) * 2) || Math.round(e.perKg[0] * weightOf(script)));
  const lo = e ? e[0] : 50, hi = e ? e[1] : 360;
  const next = [50, 70, 100, 120, 150, 200, 250, 300, 360].find(j => j > (lastJ || 0) && j >= lo);
  return Math.min(hi, next || hi);
}
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
  // ...and only THIS pulseless episode's: a wrong defibrillation into a perfusing VT before the
  // arrest is not a rung of the arrest's ladder.
  const nth = state.pulse ? state.shocks.filter(x => !x.sync && x.episode == null).length : episodeDefibs(state).length;
  const rows = (script.shock && script.shock.results) || [];
  // The arrest's antiarrhythmic is a dose given in THIS arrest: 150 mg for the perfusing VT before
  // it is not the arrest's 300.
  // ...and a BOLUS: a drip with no loading dose is not the antiarrhythmic that converts refractory VF.
  const has = k => (k === 'amiodarone' || k === 'lidocaine') && !state.pulse
    ? state.drugs.some(d => d.name === k && d.pulseless && !d.infusion && d.episode === state.episode) : rowHas(state, k);
  for(const r of rows){
    if(r.n !== nth) continue;
    if(r.requires && !r.requires.every(has)) continue;
    return r;
  }
  let best = null;
  for(const r of rows){ if(r.n <= nth && (!r.requires || r.requires.every(has))) if(!best || r.n > best.n) best = r; }
  return best;
}

function hasAction(state, key){
  if(key === 'shock') return state.shocks.length > 0;
  if(key === 'cpr') return state.cprSecs > 0;
  if(key === 'causeTreated') return state.causesTreated.length > 0;
  // An IM or SC dose is not the epinephrine a ROSC or shock row is waiting for (see systemicEpi).
  // Nor is a drip run during the arrest: arrest epinephrine is a bolus (see giveDrug, arrestDrip).
  if(key === 'epinephrine') return state.drugs.some(d => systemicEpi(d) && !(d.infusion && d.pulseless));
  if(state.drugs.some(d => d.name === key)) return true;
  return !!state.flags[key];
}
// What a ROSC or shock row waits for. Its epinephrine is the arrest drug, a BOLUS — however the drip
// began: an infusion started for a bradycardia with a pulse, still running when the child arrested,
// brought the pulse back at the first check with no arrest dose ever given. (A drip with a pulse still
// halts a crash or answers a hint through hasAction: there it is the right treatment.)
function rowHas(state, key){
  if(key === 'epinephrine') return state.drugs.some(d => systemicEpi(d) && !d.infusion);
  // ...and no drip run WITHOUT A PULSE is the drug a ROSC or shock row waits for (round 7). A magnesium drip in
  // pulseless torsades with no push before it — flagged "with no pulse magnesium goes in as a push" — still
  // brought the pulse back at the next shock; so did a naloxone drip in the opioid arrest. The push given
  // before such a drip counts, and a drip started while there was a pulse counts as before. (From the records
  // alone: giveDrug sets the drug's flag for a drip too.)
  if(DRUG_ALIASES[key]) return state.drugs.some(d => d.name === key && !(d.infusion && d.pulseless));
  return hasAction(state, key);
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
  // (R9, J8: "polymorphic VT", "pulseless polymorphic VT" name it too — she asked "what is it?" and never charged.)
  torsades: /\b(torsade|polymorphic\s+(?:v\s?tach|vtach|vt|ventricular tachycardia))/i,
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
  state.ramps = [];
  const p = script.postRosc || {};
  state.pulse = true; state.phase = 'rosc'; state.episodeT = null;
  // The nurse's "another epi?" belonged to the arrest. Left open, a "yes" after ROSC pushed 1 mg
  // into a patient with a pulse and flagged the doctor for it.
  // ...and so did the defibrillator's charge (round 6): nobody delivers it into a pulse.
  state.pendingQuestion = null; state.charged = null; state.syncMode = false;
  setRhythm(state, p.rhythm || 'sinus-tachy');
  state.hr = p.hr || 110; state.bpSys = p.bpSys || 95; state.bpDia = p.bpDia || Math.round((p.bpSys || 95) * 0.6);
  state.spo2 = p.spo2 || 94; state.rr = p.rr || 14; state.etco2 = 38; state.cpr = false;
  // The breathing already being done for her carries across the pulse. Most runs put the tube
  // in DURING the arrest, and the pulse came back at the authored post-arrest numbers as if
  // nobody were ventilating — the VF case at sats 94 with a tube in. Same rows as postRoscCare.
  const vent = AIRWAY_RANK[state.airway] && postRoscCareRow(script, state.airway);
  if(vent){
    if(vent.spo2 != null) state.spo2 = Math.max(state.spo2, vent.spo2);
    if(vent.rr != null) state.rr = vent.rr;
    if(vent.hr != null) state.hr = vent.hr;
    if(vent.bpSys != null){ state.bpSys = vent.bpSys; state.bpDia = Math.round(vent.bpSys * 0.6); }
  }
  state.ended = 'rosc';
  // The moment the arrest ended, kept separately from state.t. Post-arrest orders now
  // advance the clock (see actInner), so reading state.t at summary time would report a
  // ROSC two hours after it happened.
  state.endedT = state.t;
  return [ev(state, 'rosc', 'We have a pulse — ' + rhythmName(state.rhythm) + ', pressure ' + state.bpSys + '.', { via })];
}

function die(state, why){
  state.ramps = []; state.rr = 0; state.cpr = false;
  state.ended = 'death'; state.endedT = state.t; state.phase = 'dead'; state.pulse = false;
  state.pendingQuestion = null;          // nothing is asked of a doctor once the code has ended
  state.charged = null; state.syncMode = false;
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
  // Dextrose is ordered by its strength: D10 and D25 for a child (PALS: 2-4 mL/kg of D25W,
  // 5-10 mL/kg of D10W), D50 for an adult. "D25 2 mL/kg IO" and "D10W 5 mL/kg IO" had no alias here,
  // so the access branch took them on the word "IO" and the sugar was never given.
  dextrose:    ['dextrose', 'd50', 'd10', 'd25', 'd5', 'd50w', 'd25w', 'd10w', 'd5w'],
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
  for(const name of Object.keys(DRUG_ALIASES)){
    if(name === 'epinephrine' && INHALED_EPI_RE.test(s)) continue;
    for(const a of DRUG_ALIASES[name])
      if(new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(s)) return name;
  }
  return null;
}
// NEBULISED EPINEPHRINE IS AN AIRWAY TREATMENT, NOT THE ARREST DRUG.
//
// Racemic or nebulised epinephrine treats upper-airway swelling (croup, post-extubation stridor).
// The croup case names it as a critical action — "Treat the upper airway obstruction itself with
// nebulised epinephrine and dexamethasone" — and its pack has a responder that credits it. But
// every "epinephrine" was the arrest bolus here: the neb started the three-to-five-minute clock,
// made the nurse hold the real IV dose, was flagged "No dose stated", counted toward a pulse
// coming back — and, claimed by this engine, never reached that responder. So the code engine lets
// it go: unclaimed, the order falls through to the turn engine (fireCodeOrder), which answers it
// from the pack.
const INHALED_EPI_RE = /\b(?:nebuli[sz]\w*|nebs?|racemic|inhal\w*|aerosoli[sz]\w*)\b/;
// Lidocaine for a procedure — infiltrated for the chest tube, the line, the wound — is a local
// anaesthetic, not the antiarrhythmic, and is not judged as one. (A nerve block — not a heart block.)
function localAnaesthetic(text, route){
  return route === 'sc' || /\b(?:local|infiltrat\w*|topical|jelly|gel|intradermal|subcut\w*|(?<!heart )block|anaesthe\w*|anesthe\w*)\b|\bfor (?:the )?(?:chest tube|thoracostomy|line|central line|art(?:erial)? line|procedure|wound|laceration|repair|incision|io)\b/.test(norm(text));
}

// UNITS SAID IN FULL ARE THE SAME UNITS. "Magnesium 2 grams IV over 15 minutes", "2 gm", "900
// milligrams" read as no dose at all (round 6): in torsades that scored ok with credit and no band
// check, and the asthmatic child's stated 900 mg was flagged "No dose stated". Voice input spells the
// unit out, so each is written the way the patterns below read it. The micro sign too: norm() strips
// "µ", so "10 µg" of epinephrine became "10 g" — ten grams.
function unitWords(text){
  return String(text == null ? '' : text)
    .replace(/[µμ]\s*g\b/gi, 'mcg')
    .replace(/(\d)\s*(?:micrograms?|mcgs)\b/gi, '$1 mcg')
    .replace(/(\d)\s*(?:milligrams?|mgs)\b/gi, '$1 mg')
    .replace(/(\d)\s*(?:grams?|gms?)\b/gi, '$1 g')
    .replace(/(\d)\s*(?:milliequivalents?|meqs)\b/gi, '$1 meq')
    .replace(/(\d)\s*(?:millilit(?:er|re)s?)\b/gi, '$1 ml');
}
// The strength a dextrose order names, in percent: D10W is 10, "an amp of D50" 50, "dextrose 25%" 25.
function dextroseStrength(text){
  const raw = String(text == null ? '' : text).toLowerCase();
  const d = raw.match(/\bd\s?(5|10|12\.5|25|50|70)\s?w?\b/);
  if(d) return +d[1];
  const p = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  return p ? +p[1] : null;
}

// Dose: "1 mg", "0.1 mg/kg", "300 mg", "2 g", "10 ml/kg"
function parseDose(text, script){
  text = unitWords(text);
  const kg = weightOf(script);
  // A VOLUME OF A KNOWN STRENGTH IS A DOSE; THE STRENGTH ALONE IS NOT. PALS and NRP write
  // epinephrine as a volume — "0.1 mL/kg of 0.1 mg/mL", "2.4 mL of 1:10,000" — and the number
  // that ends in "mg" there is the strength of the syringe. Read as the dose, a correct 0.24 mg
  // became 0.1 mg and was flagged. So the strength is found first and taken out of the order:
  // with a volume beside it the dose is volume × strength (× weight), and without one the rest
  // of the order is read exactly as before. Only a per-millilitre strength counts ("1 mg/10 mL"
  // is a whole prefilled syringe, and stays the 1 mg it always read as). A ratio is grams in so
  // many millilitres — 1:10,000 is 0.1 mg/mL, 1:1000 is 1 mg/mL — and a percentage is grams per
  // 100 mL: 10% calcium chloride is 100 mg/mL, 8.4% bicarbonate 84 mg/mL (1 mEq/mL). Dextrose is
  // named by its percentage: D10 is 100 mg/mL, so "D10 5 mL/kg" is the PALS 0.5 g/kg.
  let t = norm(String(text == null ? '' : text).toLowerCase()
    .replace(/\b1\s*(?::|in)\s*(10,?000|1,?000)\b/g, (m, d) => ' ' + (1000 / +d.replace(',', '')) + ' mg/ml ')
    .replace(/(\d+(?:\.\d+)?)\s*%(?!\s*(?:oxygen|o2|fio2|sat))/g, (m, p) => ' ' + (+p * 10) + ' mg/ml ')
    .replace(/\bd(5|10|25|50)w?\b/g, (m, p) => ' ' + (+p * 10) + ' mg/ml '));
  const sm = t.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|micrograms?|ug|g|grams?|meq)\s*(?:\/|per)\s*(?:1\s*)?(?:ml|cc)\b/);
  let strength = null;
  if(sm){
    const v = parseFloat(sm[1]), u = sm[2];
    strength = u === 'meq' ? { mEq: v } : { mg: /^(?:mcg|micro|ug)/.test(u) ? v / 1000 : /^g/.test(u) ? v * 1000 : v };
    t = t.replace(sm[0], ' ');
  }
  // Milliequivalents first: bicarbonate is ordered in mEq at the bedside, and "1 mEq/kg"
  // must not fall through to a pattern that reads it as milligrams. norm() lowercases,
  // so mEq arrives here as "meq".
  const PER_KG = '\\s*(?:\\/|per)\\s*k(?:g|ilo|ilogram)s?\\b';
  const meqPerKg = num(new RegExp('(\\d+(?:\\.\\d+)?)\\s*meq' + PER_KG), t);
  if(meqPerKg != null) return { mg: null, mEq: meqPerKg * kg, perKg: meqPerKg, stated: 'mEqPerKg' };
  const meq = num(/(\d+(?:\.\d+)?)\s*meq\b/, t);
  if(meq != null) return { mg: null, mEq: meq, stated: 'mEq' };
  // Per kilo in whatever unit the clinician says it: "0.01 mg per kg", "10 mcg/kg" of epinephrine,
  // "0.5 g/kg" of dextrose. Only "mg/kg" was read, so the other two fell to the plain-unit patterns
  // below — 10 mcg/kg in a 24 kg child became 0.01 mg, a correct dose flagged as a 24-fold
  // underdose. A rate ("20 mcg/kg/min") is not a dose per kilo and is left to them, as before.
  const pk = t.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*(mg|mcg|micrograms?|ug|g|grams?)' + PER_KG + '(?!\\s*(?:\\/|per)\\s*(?:min|h))'));
  if(pk){
    const perKg = parseFloat(pk[1]) * (/^(?:mcg|micro|ug)/.test(pk[2]) ? 0.001 : /^g/.test(pk[2]) ? 1000 : 1);
    return { mg: Math.round(perKg * kg * 1e6) / 1e6, perKg, stated: 'perKg' };
  }
  const mcg = num(/(\d+(?:\.\d+)?)\s*(?:mcg|micrograms?|ug)\b/, t);
  if(mcg != null) return { mg: mcg / 1000, stated: 'mcg' };
  const g = num(/(\d+(?:\.\d+)?)\s*g\b/, t);
  if(g != null) return { mg: g * 1000, stated: 'g' };
  const mg = num(/(\d+(?:\.\d+)?)\s*mg\b/, t);
  if(mg != null) return { mg, stated: 'mg' };
  if(strength){
    const mlPerKg = num(/(\d+(?:\.\d+)?)\s*(?:ml|mls|cc)\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?\b/, t);
    const ml = mlPerKg != null ? mlPerKg * kg : num(/(\d+(?:\.\d+)?)\s*(?:ml|mls|cc)\b(?!\s*(?:\/|per)\s*(?:h|hr|hour|min))/, t);
    // To the microgram: 0.1 mL/kg × 24 kg × 0.1 mg/mL is 0.24 mg, not 0.24000000000000005.
    const r6 = x => Math.round(x * 1e6) / 1e6;
    if(ml != null) return strength.mEq != null
      ? { mg: null, mEq: r6(ml * strength.mEq), stated: 'volume' }
      : { mg: r6(ml * strength.mg), stated: 'volume' };
  }
  return { mg: null, stated: null };
}

// Does this arrest have a reason for calcium or magnesium? Read from the case, never from its id:
// the rule says `indicated: true`; or the case credits the drug as a critical action, so its author
// made it the treatment (the crush injury's calcium against a potassium of 6.9, the torsades case's
// magnesium, the asthma child's magnesium); or a cause the case declares names the indication
// (hyperkalaemia, a low calcium, a calcium-channel blocker; torsades, a long QT, a low magnesium).
// Calcium also answers the citrate of a massive transfusion once blood has gone in (the trauma
// cases' own note: "after roughly every 4 units of citrated blood"), and magnesium the torsades on
// the monitor.
function arrestAdjunctIndicated(state, script, name){
  const rule = (script.drugs && script.drugs[name]) || {};
  if(rule.indicated) return true;
  if(script.credits && script.credits[name] != null) return true;
  const causes = Object.keys((script.causes || {}).actions || {}).join(' ');
  if(name === 'calcium') return /hyperk|hypocalc|calciumchannel|\bccb/i.test(causes) || !!state.flags.bloodGiven;
  return state.rhythm === 'torsades' || !!(script.start && script.start.rhythm === 'torsades') || /torsade|longqt|hypomag/i.test(causes);
}

// WHO, AND WHAT KIND OF CASE — for the teaching keys (2026-09-27). The adult, child and newborn guidelines are different
// documents with different classes, so a lesson is keyed by the population it is read to.
function populationOf(script){ return isNeonate(script) ? 'newborn' : isChild(script) ? 'child' : 'adult'; }
// A trauma case is one whose declared causes include the bleed itself (the three ATLS scripts).
function traumaScript(script){ return !!(((script || {}).causes || {}).actions || {}).exsanguination; }
// Any of the case's required causes still untreated: the life-saving steps a vasopressor must not come before.
function causesOutstanding(state, script){
  return (((script || {}).causes || {}).required || []).some(c => state.causesTreated.indexOf(c) === -1);
}
// Naloxone has an opioid to reverse: the case says so (`indicated`), credits it, or names an opioid cause.
function naloxoneIndicated(script){
  const rule = ((script || {}).drugs || {}).naloxone || {};
  if(rule.indicated || (script.credits && script.credits.naloxone != null)) return true;
  return /opioid|opiate|overdose|heroin|fentanyl|methadone/i.test(Object.keys(((script || {}).causes || {}).actions || {}).join(' '));
}
// Tranexamic acid has a bleed to treat: the case doses it, or names a bleed or blood loss as a cause.
function tranexamicIndicated(script){
  if(((script || {}).drugs || {}).tranexamic) return true;
  return /exsanguin|hypovol|bleed|haemorrh|hemorrh/i.test(Object.keys(((script || {}).causes || {}).actions || {}).join(' '));
}
// The narrow rhythms with a pulse that lidocaine, a ventricular drug, does not treat.
const SUPRAVENTRICULAR = new Set(['SVT', 'AF', 'aflutter']);
// Atropine ordered as a premedication for intubation ("atropine before we intubate", "premed with atropine", "RSI atropine"): PALS
// allows it where bradycardia is likely (2020: 2b), so the fast-heart and hypoxic-bradycardia lessons stand down (review, 2026-09-27).
const ATROPINE_PREMED_RE = /\bpre ?-?med\w*|\b(?:before|for|prior to|ahead of)\s+(?:the\s+)?(?:intubat\w*|tube|rsi)\b|\brsi\b|\bpre ?-?intubat\w*/;
// A drug named in a thought, not an order: "consider calcium", "thinking about bicarb", "maybe some magnesium" (actInner).
const DRUG_MUSING_RE = /^(?:(?:ok|okay|so|and|um|uh|er|hmm|well|now|also|alright|doctor)\s+)*(?:consider\w*|contemplat\w*|think\w*|wonder\w*|maybe|perhaps|possibly|might)\b/;
// A script's `wrongFor` (drug and rhythm) and the card that teaches it.
const WRONG_FOR_TEACH = { 'adenosine|AF': 'adenosine-af', 'adenosine|aflutter': 'adenosine-af', 'amiodarone|torsades': 'antiarrhythmic-torsades' };
// THE GRADE STAYS WHERE IT WAS (review of 2026-09-27). The reasons this build added — naloxone with no opioid, tranexamic acid
// with no bleed, atropine into a fast heart or a child's hypoxic one, lidocaine into a narrow rhythm, an epinephrine drip into a
// tachycardia, adenosine into an unstable wide complex, epinephrine in trauma before its causes, lidocaine in torsades, an
// antiarrhythmic before the cardioversion an unstable tachycardia needs, an adult epinephrine down the tube — went in "all
// correct" on the live version. They are taught in the debrief (a `lesson`: the record keeps ok, its credit and dose accuracy,
// and carries the key of its card), not marked down, until Kim decides they should cost the dose-accuracy points and the credit.
// true makes every lesson a flag (ok=false, read back by the nurse, named under dose accuracy).
const LESSONS_SCORED = false;
// A cardiac arrest in one of the trauma scripts: the ordinary arrest cards' "…then epinephrine" is the wrong advice there (the
// causes come first), and the debrief swaps in the trauma lesson (drug-teaching.json `trauma`).
function traumaArrest(state, script){ return traumaScript(script) && !state.pulse; }
// EVERY TEACHING KEY THIS ENGINE CAN PUT ON A RECORD (medicationReview, giveDrug's flags, the off-list drugs, the newborn's
// volume), so tests/drug-teaching.test.cjs can hold drug-teaching.json to it: each one has a card there, or is listed as
// having no verified source. A key added below without one fails that test. (Built lazily: DRUG_ALIASES is declared later.)
function teachKeys(){
  const keys = new Set([
    'calcium-routine-arrest', 'calcium-routine-arrest-child', 'calcium-newborn',
    'bicarbonate-routine-arrest', 'bicarbonate-routine-arrest-child', 'bicarbonate-no-indication', 'bicarbonate-trauma-acidosis', 'bicarbonate-newborn',
    'magnesium-routine-arrest', 'magnesium-routine-arrest-child', 'magnesium-drip-in-arrest',
    'atropine-in-arrest', 'atropine-in-arrest-child', 'atropine-no-bradycardia', 'atropine-no-bradycardia-child', 'atropine-hypoxic-bradycardia-child',
    'atropine-infusion', 'atropine-infusion-child',
    'adenosine-no-tachycardia', 'adenosine-no-tachycardia-child', 'adenosine-unstable-wct', 'adenosine-infusion', 'adenosine-infusion-child',
    'antiarrhythmic-nonshockable', 'antiarrhythmic-nonshockable-child', 'antiarrhythmic-bradycardia', 'antiarrhythmic-bradycardia-child',
    'antiarrhythmic-drip-no-bolus', 'antiarrhythmic-drip-no-bolus-child', 'lidocaine-supraventricular', 'lidocaine-supraventricular-child',
    'lidocaine-torsades', 'drug-instead-of-cardioversion', 'drug-instead-of-cardioversion-wct', 'calcium-trauma-with-blood', 'epi-tube-adult', 'wrong-rhythm',
    'epi-arrest-dose-at-pulse', 'epi-child-rate-60', 'epi-newborn-rate-60', 'epi-before-ventilation-child', 'epi-before-ventilation-newborn',
    'epi-before-compressions-newborn', 'epi-drip-tachycardia', 'epi-drip-tachycardia-child', 'epi-drip-newborn', 'epi-drip-in-arrest',
    'epi-drip-in-arrest-child', 'epi-traumatic-arrest-first', 'vasopressor-haemorrhagic-shock', 'epi-tube-line-in', 'epi-tube-line-in-child',
    'epi-tube-line-in-newborn', 'epi-im-in-arrest', 'epi-im-in-arrest-child', 'route-iv-io', 'route-iv-io-child', 'route-uvc-io-newborn',
    'epi-dose-adult', 'epi-high-dose', 'epi-dose-adult-tube', 'epi-dose-child', 'epi-dose-child-tube', 'epi-dose-newborn', 'epi-dose-newborn-tube',
    'epi-dose-im', 'dose-not-stated-child', 'dose-not-stated-newborn',
    'naloxone-no-opioid', 'naloxone-no-opioid-child', 'naloxone-drip-in-arrest', 'txa-no-bleeding', 'dextrose-newborn-strength', 'newborn-volume',
    'epi-before-second-shock', 'epi-before-second-shock-child', 'antiarrhythmic-before-third-shock', 'antiarrhythmic-before-third-shock-child',
    // (medicationReview's key for a flagged record that carries none — not expected, and shown by its note.)
    'flagged']);
  // Each dosed drug's own dose card, adult and child (a newborn's is the child's).
  for(const name of Object.keys(DRUG_ALIASES)) if(name !== 'epinephrine' && name !== 'surfactant'){ keys.add(name + '-dose'); keys.add(name + '-dose-child'); }
  for(const k of Object.values(WRONG_FOR_TEACH)) keys.add(k);
  for(const o of OFF_LIST) for(const k of o.keys || [o.key]) keys.add(k);
  return [...keys].sort();
}

// `mode`: 'dry' only reads the dose against its range and returns { under, ok } — nothing is held or
// recorded (doseHold asks it whether an order is an underdose); 'drip' records the infusion half of a
// bolus-then-drip order, which converts nothing (the bolus before it already had that chance); 'bolus' is
// its bolus half, given as any bolus is — only not split again (its words may still name the drip).
// NRP gives epinephrine only as 1:10,000 (0.1 mg/mL), IV and down the tube: a volume said with no strength is that strength.
function newbornEpiStrength(text, script){
  const t = norm(text);
  if(!/\d\s*(?:ml|mls|cc)\b/.test(t) || /\bmg\s*(?:\/|per)\s*(?:ml|cc)\b|\b1\s*(?::|in)\s*\d|%/.test(String(text).toLowerCase())) return text;
  return parseDose(text, script).mg != null ? text : text + ' of 0.1 mg/ml';
}
function giveDrug(state, script, name, text, mode){
  // THE BOLUS, THEN ITS DRIP (see isInfusion): the bolus first, down the bolus's own path. Then the drip, recorded as
  // the infusion that follows it.
  // ROUND 9 (K2): IF THE TEAM HOLDS THE BOLUS, THE DRIP STILL STARTS — when the bolus it follows is already in. After
  // ROSC in torsades, "magnesium 2 g then an infusion" was held whole on the five-minute clock: her line said the repeat
  // waits, and the maintenance infusion the doctor ordered never ran. Held for the clock or the next shock ('clock',
  // 'afterShock', 'clockAndShock'), at the maximum ('max'), or because the child's lidocaine goes on as an infusion now
  // ('infusion'), she says her usual line and starts the drip. Not after an underdose (the bolus the drip follows is
  // not in yet — she names the full dose), nor a drug not indicated for this patient, nor a drug never run as a drip
  // (atropine, adenosine), nor a second drip of a drug already running (dripFollowsHold).
  // (One spelling of the units for every check below: the rate, the bolus, the band — see unitWords.)
  text = unitWords(text);
  // (R11: a newborn's epinephrine by volume with no strength — "epinephrine 0.1 ml/kg IV" — is NRP's only one, 1:10,000 (0.1
  // mg/mL): it was flagged "No dose stated".)
  if(name === 'epinephrine' && isNeonate(script)) text = newbornEpiStrength(text, script);
  const both = !mode && splitBolusDrip(name, text);
  if(both){
    const out = giveDrug(state, script, name, both.bolus, 'bolus');
    const h = out.find(e => e.kind === 'withheld');
    return !h || dripFollowsHold(state, name, h) ? out.concat(giveDrug(state, script, name, both.drip, 'drip')) : out;
  }
  const rule = (script.drugs && script.drugs[name]) || {};
  const kg = weightOf(script);
  const dose = parseDose(text, script);
  const route = routeOf(text);
  // NOT YET: a dose that is not due is held, and nothing is recorded (see readyIn).
  const hold = mode !== 'dry' && heldDrug(state, script, name, text, route);
  // (Round 9: remembered for this code second — "magnesium 2 g, then start a drip" reaches the engine as two clauses,
  // and the second is the drip of this held bolus: dripOfLastBolus.)
  if(hold){
    state.heldBolus = { name, t: state.t, reason: hold.reason, n: state.drugs.length };
    // (R11: a repeat adenosine asked for before its minute is up — the nurse says when it is ready: adenosineReady.)
    if(name === 'adenosine' && hold.reason === 'clock') state.adenosineAsk = { t: state.t, n: state.drugs.filter(d => d.name === 'adenosine').length };
    return [hold];
  }
  const infusion = isInfusion(text);
  let ok = true, note = '';
  // WHY IT WAS WRONG, FOR THE DEBRIEF (Kim, 2026-09-27: "if I order the wrong meds … explain in the debrief why they were
  // wrong, based on the latest ACLS guideline"). Every flag below names its reason with a stable teaching key — the key of its
  // card in drug-teaching.json (the guideline, in plain words, and what to do instead) — and the note the nurse reads back.
  // `kind` ranks the reasons for the card that leads: the wrong drug for this patient ('indication') before the wrong way of
  // giving it ('route') before the wrong amount ('dose') — bicarbonate in VF is taught as no indication, not as the 82 mEq
  // its note also names. The note itself is every reason, in the order found, as the nurse has always read it back.
  const why = [];
  const pop = populationOf(script);
  const flag = (key, text, kind) => { ok = false; why.push({ key, text, kind: kind || 'indication' }); };
  // A reason taught, not marked down (LESSONS_SCORED): the dose keeps its credit, the nurse reads back nothing new, and the
  // debrief's card says why. (Ranked with the flags for the card that leads.)
  const lesson = (key, text, kind) => LESSONS_SCORED ? flag(key, text, kind) : why.push({ key, text, kind: kind || 'indication', lesson: true });

  // expected dose in mg: per-kg rule wins for children and neonates
  let want = null;
  // An adult lidocaine REPEAT is 0.5-0.75 mg/kg, not the 1-1.5 mg/kg first dose; checked
  // against the first-dose rule, the correct repeat was flagged as an underdose.
  // Any adult second bolus, with a pulse or without: the repeat is the patient's, not the arrest's.
  // (A flagged underdose was not the first dose — see antiRepeat.)
  // (Round 6: a first dose of 1 mg/kg or more WAS the first dose, whatever band graded it — lidoFirstIn, the
  // same count antiRepeat and expectedDoseMg use, so the repeat the button offers is graded as the repeat.)
  const lidoRepeat = name === 'lidocaine' && !isChild(script) && !isInfusion(text) && lidoFirstIn(state, script);
  // DOWN THE TUBE, while there is no line: NRP 0.05-0.1 mg/kg while the umbilical line goes in;
  // PALS 0.1 mg/kg, maximum 2.5 mg ("if no IV/IO access"); the adult tube dose 2-2.5 mg. The tube
  // is an accepted route for these, each checked against its own band — ten times the IV dose is
  // the right tube dose for a child, not a tenfold overdose. A child on compressions for a rate
  // under sixty counts too: PALS gives the same tube dose for that bradycardia.
  const tubeEpi = name === 'epinephrine' && route === 'et' && (isChild(script) || !state.pulse);
  const nrpEt = tubeEpi && isNeonate(script);
  // A newborn's IV/UVC dose is a RANGE, 0.01-0.03 mg/kg (NRP 2020 and 2025, and the case's own
  // learning point) — not 0.8-1.25 × the 0.02 mg/kg the script names as its usual dose.
  const nrpIv = name === 'epinephrine' && isNeonate(script) && !tubeEpi && !offAlgorithmRoute(route);
  // IM or SC epinephrine is another indication's dose — anaphylaxis, severe asthma: 0.01 mg/kg,
  // 0.3-0.5 mg in an adult. In an arrest (or a child on compressions) the route is the error. With a
  // pulse it is graded as that dose only where the case HAS that indication — the script says so
  // (`drugs.epinephrine.im`, the severe-asthma child). Everywhere else an IM dose is what it always
  // was: the wrong route ("Give it IV or IO"), and in a child with a rate over sixty the wrong drug —
  // graded as the anaphylaxis dose, 0.06 mg IM into an infant's SVT at 240 read "all correct".
  // A newborn is never given it: there it is simply the wrong route.
  const imRoute = name === 'epinephrine' && offAlgorithmRoute(route) && !isNeonate(script);
  const imInArrest = imRoute && compressionsIndicated(state, script);
  const imEpi = imRoute && !imInArrest && !!rule.im;
  // Calcium comes as two salts. The script's dose is calcium CHLORIDE (1 g; 20 mg/kg); the same
  // calcium as GLUCONATE is three times the weight (3 g; 60 mg/kg), and was flagged as an overdose.
  const salt = name !== 'calcium' ? null : /\bgluconate\b/.test(norm(text)) ? 'gluconate' : /\bchloride\b/.test(norm(text)) ? 'chloride' : null;
  const saltX = salt === 'gluconate' ? 3 : 1;
  if(lidoRepeat) want = 0.625 * kg;
  else if(tubeEpi || imEpi || imInArrest) want = null;
  else if(rule.perKg != null) want = rule.perKg * kg;
  else if(rule.mg != null) want = rule.mg;
  // Amiodarone's standard dose depends on whether there is a pulse: 300 mg push (then
  // 150) in VF/pVT arrest, but 150 mg over ten minutes for a tachycardia that is still
  // perfusing. One expected value for both taught players to push 300 at a patient
  // with a blood pressure.
  else if(name === 'amiodarone') want = state.pulse ? (rule.perfusing || 150)
    // The ARREST's doses: 150 mg given for a perfusing VT is not the arrest's first 300.
    : (state.drugs.some(d => d.name === 'amiodarone' && d.pulseless && !d.infusion && !d.under) ? (rule.second || 150) : (rule.first || 300));
  // Epinephrine's fixed 1 mg is the ARREST expectation. With a pulse (and no
  // weight-based rule — PALS bradycardia legitimately doses 0.01 mg/kg at a pulse)
  // there is no single right number: push-dose runs 10-20 mcg and infusions are
  // titrated, so the range check stands down and the arrest-bolus flag above is the
  // only line — a milligram at a perfusing patient is the error worth catching.
  if(name === 'epinephrine' && state.pulse && rule.perKg == null) want = null;
  // The second adenosine follows the first DOSE: after a flagged 3 mg the next is still the 6 mg, then
  // the 12 (an underdose was not the dose — see antiRepeat).
  else if(name === 'adenosine') want = rule.perKg != null && rule.first == null
    ? rule.perKg * kg * (state.drugs.some(d => d.name === 'adenosine' && !d.under && !d.infusion) ? 2 : 1)
    : state.drugs.some(d => d.name === 'adenosine' && !d.under && !d.infusion) ? (rule.second || 12) : (rule.first || 6);

  // A rule may state its dose in milliequivalents. Bicarbonate is the only drug here
  // that is: paediatric arrest dosing is 1 mEq/kg, and 1 mEq of NaHCO3 is 84 mg (an
  // 8.4% ampoule is 1 mEq/mL). Without this the engine compared 1 mg/kg against a dose
  // given in mEq, refused the correct answer and accepted an eighty-four-fold underdose.
  const unit = rule.unit === 'mEq' ? 'mEq' : 'mg';
  const given = unit === 'mEq'
    ? (dose.mEq != null ? dose.mEq : (dose.mg != null && MEQ_MG[name] ? dose.mg / MEQ_MG[name] : null))
    : (dose.mg != null ? dose.mg : (dose.mEq != null && MEQ_MG[name] ? dose.mEq * MEQ_MG[name] : null));

  if(want != null) want *= saltX;
  // Epinephrine's own ranges (above), each with about 5% slack, checked in place of 0.8-1.25 × one number.
  const epiBand = infusion ? null
    : nrpEt ? { lo: 0.05 * kg * 0.95, hi: 0.1 * kg * 1.05, where: ' down the tube',
        says: '0.05-0.1 mg/kg (' + doseNum(0.05 * kg) + '-' + doseNum(0.1 * kg) + ' mg)' }
    : tubeEpi && isChild(script) ? { lo: Math.min(0.1 * kg, 2.5) * 0.8, hi: Math.min(0.1 * kg * 1.25, 2.5 * 1.05), where: ' down the tube',
        says: 'about ' + doseNum(Math.min(0.1 * kg, 2.5)) + ' mg (0.1 mg/kg × ' + kg + ' kg, maximum 2.5 mg)' }
    : tubeEpi ? { lo: 2 * 0.95, hi: 2.5 * 1.05, where: ' down the tube', says: '2-2.5 mg' }
    : nrpIv ? { lo: 0.01 * kg * 0.95, hi: 0.03 * kg * 1.05, where: '',
        says: '0.01-0.03 mg/kg (' + doseNum(0.01 * kg) + '-' + doseNum(0.03 * kg) + ' mg)' }
    : imEpi ? { lo: Math.min(0.01 * kg, 0.3) * 0.8, hi: Math.min(0.01 * kg * 1.25, 0.5 * 1.05), where: ' IM',
        says: isChild(script) ? '0.01 mg/kg, about ' + doseNum(Math.min(0.01 * kg, 0.5)) + ' mg' : '0.3-0.5 mg' }
    : null;
  // DEXTROSE IS A RANGE TOO: PALS 0.5-1 g/kg (D10W 5-10 mL/kg, D25W 2-4 mL/kg), an adult 25-50 g (half
  // to one amp of D50), about 5% slack. Checked against 0.8-1.25 × the 0.5 g/kg a script names, the
  // PALS 1 g/kg was flagged as an overdose; an adult order was not checked at all. A newborn's dose
  // is smaller again (NRP's D10W 2 mL/kg) and no newborn script doses it, so it is left unjudged.
  const dexBand = name !== 'dextrose' || infusion || isNeonate(script) ? null
    : isChild(script) ? { lo: Math.min(0.5 * kg, 25) * 1000 * 0.95, hi: Math.min(1 * kg, 50) * 1000 * 1.05, where: '',
        says: '0.5-1 g/kg (' + round2(Math.min(0.5 * kg, 25)) + '-' + round2(Math.min(1 * kg, 50)) + ' g)' }
    : { lo: 25000 * 0.95, hi: 50000 * 1.05, where: '', says: '25-50 g (half to one amp of D50)' };
  // MAGNESIUM IS A RANGE (round 5 defaults, for Kim): an adult 1-2 g a dose (torsades), a child 25-50
  // mg/kg and never more than 2 g (PALS, torsades and asthma alike), about 5% slack. Against 0.8-1.25 ×
  // the script's 2 g the ACLS 1 g read as an underdose — so torsades waved every dose through as correct,
  // 20 g in a minute included. The repeats and the 4 g ceiling are the clock's (readyIn).
  const magBand = name !== 'magnesium' || infusion ? null
    : isChild(script) ? { lo: Math.min(25 * kg, 2000) * 0.95, hi: Math.min(50 * kg, 2000) * 1.05, where: '',
        says: '25-50 mg/kg (' + doseSaid(Math.min(25 * kg, 2000)) + '-' + doseSaid(Math.min(50 * kg, 2000)) + '), 2 g at most' }
    : { lo: 1000 * 0.95, hi: 2000 * 1.05, where: '', says: '1-2 g' };
  // ACLS LIDOCAINE IS A RANGE TOO (round 6): the first dose is 1-1.5 mg/kg on the card, about 5% slack.
  // Against 0.8-1.25 × the script's 1.5 mg/kg the card's own 1 mg/kg (82 mg for 82 kg) read as an
  // underdose "expected about 123 mg" — and the card's 0.5-0.75 mg/kg repeat after it was then held as a
  // further underdose. (The repeat keeps its own number, lidoRepeat above; a child's is PALS's 1 mg/kg,
  // from the case. A drip is a rate. Nor is 5 mL of 1% for a chest tube an antiarrhythmic dose — the
  // local anaesthetic is not graded against the arrest card: localAnaesthetic.)
  const lidoBand = name !== 'lidocaine' || infusion || isChild(script) || lidoRepeat || localAnaesthetic(text, route) ? null
    : { lo: 1 * kg * 0.95, hi: 1.5 * kg * 1.05, where: '', says: '1-1.5 mg/kg (' + doseNum(kg) + '-' + doseNum(1.5 * kg) + ' mg)' };
  // TRANEXAMIC ACID'S FIRST DOSE IS 1-2 g (review, 2026-09-27): CRASH-2's 1 g over ten minutes, then 1 g over eight hours — or
  // the single 2 g dose of military (TCCC) and several prehospital protocols, the same total. Against 0.8-1.25 × the scripts'
  // 1 g, "tranexamic acid 2 g" was flagged "Tranexamic acid is 1 g, then 1 g". (A child's is left to the script's own number.)
  const txaBand = name !== 'tranexamic' || infusion || isChild(script) ? null
    : { lo: 1000 * 0.95, hi: 2000 * 1.05, where: '', says: '1-2 g (1 g, then 1 g over 8 hours — or 2 g once)' };
  // A SCRIPT MAY GIVE ITS DOSE AS A RANGE — `band: [lo, hi]` in mg (review, 2026-09-27). The opioid arrest's naloxone is AHA 2025
  // Table 4's 0.2-2 mg IV/IO: against 2 mg ±25% the guideline's 0.4 mg read "Dose out of range — expected about 2 mg".
  const ruleBand = !Array.isArray(rule.band) || infusion || unit !== 'mg' || rule.perKg != null ? null
    : { lo: rule.band[0] * 0.95, hi: rule.band[1] * 1.05, where: '', says: doseNum(rule.band[0]) + '-' + doseSaid(rule.band[1]) };
  const band = epiBand || dexBand || magBand || lidoBand || txaBand || ruleBand;
  // Said in the unit the drug is ordered in: dextrose and tranexamic acid in grams, the rest in milligrams.
  const bandDose = mg => dexBand ? round2(mg / 1000) + ' g' : magBand || txaBand || ruleBand ? doseSaid(mg) : doseNum(mg) + ' mg';
  // Which salt the calcium number is for, said with it.
  const saltSays = name !== 'calcium' ? '' : salt === 'gluconate'
    ? ' of calcium gluconate — three times the chloride dose, for the same calcium'
    : ' of calcium chloride — or three times that as calcium gluconate';
  // AN UNDERDOSE IS NOT THE DOSE. Epinephrine 0.1 mg in an arrest (a tenth of it), or 150 mg as the
  // first arrest amiodarone, was flagged — and then started the repeat clock, so the corrective dose
  // the flag asked for was held for three minutes and scored as asked for early. Only a dose at or
  // above the low end of its band starts the epinephrine clock or counts as the arrest's
  // antiarrhythmic (antiRepeat, expectedDoseMg). An overdose went in, and counts.
  let under = false;
  // Which dose card: each drug's own, for the patient's population — the adult, child and newborn doses are different
  // guideline lines. Epinephrine's has its forms: down the tube, IM, and the high dose (AHA 2025: Class 3, No Benefit).
  const doseKey = over => name === 'epinephrine'
    ? (nrpEt ? 'epi-dose-newborn-tube' : nrpIv ? 'epi-dose-newborn' : tubeEpi && isChild(script) ? 'epi-dose-child-tube'
      : tubeEpi ? 'epi-dose-adult-tube' : imEpi ? 'epi-dose-im' : pop === 'newborn' ? 'epi-dose-newborn'
      // (Review, 2026-09-27: "high-dose" is the trials' 0.1-0.2 mg/kg — 5 mg or more here. 1.5 or 2 mg is an overdose of the
      // standard dose, and its card says so, not the Class 3 of a regimen nobody gave.)
      : pop === 'child' ? 'epi-dose-child' : over && given >= Math.min(5, 0.1 * kg) * 0.95 ? 'epi-high-dose' : 'epi-dose-adult')
    : name + '-dose' + (pop === 'adult' ? '' : '-child');
  if(band && given != null){
    if(given < band.lo) under = true;
    if(given < band.lo || given > band.hi)
      flag(doseKey(given > band.hi), 'Dose out of range: ' + bandDose(given) + band.where + ' — expected ' + band.says + '.', 'dose');
  // An infusion is a rate, not a bolus: the bolus band does not apply to it.
  } else if(want != null && given != null && !infusion){
    // The adult lidocaine repeat is the card's 0.5-0.75 mg/kg with the same ~5% slack as the first dose and as
    // doseHold (lidoRepeatDose) — round 7: the rounded 40 mg after 80 mg in 82 kg (0.49 mg/kg) was given as the
    // repeat and then flagged "expected about 51 mg".
    const lo = lidoRepeat ? 0.5 * kg * 0.95 : want * 0.8, hi = lidoRepeat ? 0.75 * kg * 1.05 : want * 1.25;
    if(given < lo) under = true;
    if(given < lo || given > hi)
      flag(doseKey(given > hi), 'Dose out of range: ' + doseNum(given) + ' ' + unit + ' — expected about ' + doseNum(want) + ' ' + unit
           + (lidoRepeat ? ' (0.5-0.75 mg/kg repeat × ' + kg + ' kg)'
              : rule.perKg != null ? ' (' + rule.perKg * saltX + ' ' + unit + '/kg × ' + kg + ' kg)' : '') + saltSays + '.', 'dose');
  } else if((want != null || band) && given == null && !infusion && (script.patient && (script.patient.child || script.patient.neonate))){
    // An adult can be given "an amp of epi" and everyone knows what that is. A
    // child cannot: the number IS the order, and leaving it out is the error.
    flag(pop === 'newborn' ? 'dose-not-stated-newborn' : 'dose-not-stated-child',
      'No dose stated — ' + (isNeonate(script) ? 'a newborn' : 'a child') + ' needs a weight-based dose' +
      (band ? ': ' + band.says
      : ' (' + (rule.perKg != null ? rule.perKg * saltX + ' ' + unit + '/kg' + saltSays : doseNum(want) + ' ' + unit) + ')') + '.', 'dose');
  }

  // THE CAUSE COMES FIRST IN TRAUMA (2026-09-27). Epinephrine before the case's life-saving steps are done — the chest
  // decompressed, the bleeding stopped, the blood going in — was accepted in all three ATLS cases (the scripts' own notes on
  // it were never read). In a traumatic arrest the 2025 joint statement (NAEMSP/ACS-COT/ACEP) and ERC 2025 say it is not
  // routine and never before those interventions; with a pulse, in haemorrhagic shock, a vasopressor is no substitute for
  // blood (AAST/ACS-COT 2024). Once every required cause is treated it is not flagged: that is the bridge they allow.
  // (Review, 2026-09-27: a lesson, not a flag — the traumatic-arrest script's own note says "Accepted, but…", and the grade is
  // the live version's: LESSONS_SCORED.)
  if(name === 'epinephrine' && pop === 'adult' && traumaScript(script) && !state.ended && !imRoute && causesOutstanding(state, script))
    lesson(state.pulse ? 'vasopressor-haemorrhagic-shock' : 'epi-traumatic-arrest-first', state.pulse
      ? 'A vasopressor in uncontrolled bleeding squeezes an empty tank — stop the bleeding and give blood first.'
      : 'In a traumatic arrest the cause comes first — decompress the chest, stop the bleeding and give blood before epinephrine.');
  // (Not the IM anaphylaxis dose, which is 0.5 mg in an adult, nor a child's dose down the tube. An IM
  // dose with no IM indication is flagged for its route below — "push-dose 10-20 mcg" is advice for a vein.)
  // Nor a drip: "4 mg in 250 mL" is the bag, not a dose (round 5 — the standard epinephrine drip was flagged).
  // (2026-09-27: an ADULT's. A child's or a newborn's milligram at a pulse is judged by its own weight-based band above —
  // the adult push-dose advice after it was the wrong lesson for a 3 kg baby.)
  // DOWN THE TUBE IS NO LONGER AN ADULT ROUTE (review, 2026-09-27). With no line, the adult tube dose (2-2.5 mg) went in credited
  // and taught nothing, while the 2025 adult guidelines have removed endotracheal drug delivery: IV first, IO if IV fails. (With
  // a line in it is flagged below, epi-tube-line-in, as it always was; a child's and a newborn's tube doses are still guideline.)
  if(tubeEpi && pop === 'adult' && !(state.ivAccess || state.io || state.flags.uvc))
    lesson('epi-tube-adult', 'Down the tube is no longer an adult route — blood levels after it are low and unpredictable; place an IO and give 1 mg IV or IO.', 'route');
  if(name === 'epinephrine' && pop === 'adult' && state.pulse && dose.mg != null && dose.mg >= 0.5 && !imRoute && !tubeEpi && !infusion)
    flag('epi-arrest-dose-at-pulse', 'That is a cardiac-arrest dose at a patient with a pulse — ' +
      'push-dose epinephrine is 10-20 mcg, or run an infusion.');
  // ARREST RULES ARE FOR THE ARREST. Kim's crush case names treating the hyperkalaemia as
  // a critical action; she gave bicarbonate after ROSC and it was flagged four times with
  // the case's own note, which actually ENDORSES it ("Adjunct for a hyperkalaemic arrest").
  // The engine has no post-arrest drug rules, so applying the arrest ones is applying the
  // wrong rule — worse than applying none. The checks that are about the PATIENT rather
  // than the phase (a missing weight-based dose, an arrest dose at a perfusing patient, a
  // route, a drug wrong for the rhythm) still apply throughout.
  const inArrest = !state.ended;
  // (An epinephrine inside three minutes no longer reaches here: heldDrug refuses it above.)
  // Right drug, wrong rhythm. Adenosine into atrial fibrillation and amiodarone into a
  // long QT are two of the errors these cases exist to rehearse, and until the script
  // could say so they were recorded as correct and cost the player nothing.
  // Routine bicarbonate in arrest is not recommended (AHA 2025): it is for hyperkalaemia,
  // a sodium-channel-blocker overdose or a known severe metabolic acidosis. A script
  // that wants it says `indicated: true`; otherwise the dose is delivered and flagged.
  // (2026-09-27: which lesson depends on who and where. The adult's arrest reasons — hyperkalaemia, a tricyclic — were read to
  // a newborn and to patients with a pulse ("not part of routine ARREST care" at a heart block); a trauma script says its own:
  // perfusion, not bicarbonate, clears haemorrhagic acidosis.)
  if(inArrest && name === 'bicarbonate' && !rule.indicated){
    const onCpr = compressionsIndicated(state, script);
    if(traumaScript(script))
      flag('bicarbonate-trauma-acidosis', rule.note || 'Perfusion clears this acidosis — bicarbonate treats the number, not the bleeding.');
    else if(pop === 'newborn')
      flag('bicarbonate-newborn', 'Bicarbonate is not part of the newborn resuscitation algorithm — ventilation that moves the chest is what corrects a newborn\'s acidosis.');
    // (Review, 2026-09-27: not "or a known severe acidosis" — the 2025 guidelines give it no such indication, and the opioid
    // arrest's gas reads a pH of 6.98 beside a card that says it is not routine.)
    else if(onCpr)
      flag(pop === 'adult' ? 'bicarbonate-routine-arrest' : 'bicarbonate-routine-arrest-child',
        rule.note || 'Bicarbonate is not part of routine arrest care, even with a low pH — it is for hyperkalaemia or a sodium-channel-blocker (tricyclic) overdose.');
    else flag('bicarbonate-no-indication', rule.note || 'Bicarbonate has no indication here — it is for hyperkalaemia or a sodium-channel-blocker (tricyclic) overdose.');
  }
  // ...and neither are routine calcium or routine magnesium (AHA 2025: routine calcium, Class 3 No
  // Benefit; magnesium only for torsades or a low magnesium). Both went in unflagged beside a flagged
  // bicarbonate — the VF case whose gas reads "potassium four point one" scored them "all correct".
  // When the case gives the arrest a reason for them, they are right (arrestAdjunctIndicated).
  if(inArrest && (name === 'calcium' || name === 'magnesium') && compressionsIndicated(state, script)
     && !arrestAdjunctIndicated(state, script, name)){
    // IN BLEEDING TRAUMA, CALCIUM GOES WITH THE BLOOD (review, 2026-09-27). The penetrating and blunt cases, pulseless before the
    // transfusion, read the routine-arrest card — "no massive transfusion… keep to the algorithm, epinephrine" — to a patient
    // whose missing treatment IS the transfusion, and whose own script says calcium goes in with the citrated blood. Still
    // flagged (as on the live version); taught as what it goes with.
    if(name === 'calcium' && traumaScript(script))
      flag('calcium-trauma-with-blood', 'In bleeding trauma calcium goes in with the blood — the citrate of a transfusion binds it. Stop the bleeding and give blood first.'
        + (rule.note ? ' ' + rule.note : ''));
    else if(name === 'calcium') flag(pop === 'newborn' ? 'calcium-newborn' : pop === 'child' ? 'calcium-routine-arrest-child' : 'calcium-routine-arrest',
      pop === 'newborn' ? 'Calcium is not part of the newborn resuscitation algorithm.' + (rule.note ? ' ' + rule.note : '')
      : 'Calcium is not part of routine arrest care — it is for hyperkalaemia, a low calcium, a calcium-channel-blocker overdose or the citrate of a massive transfusion.'
        + (rule.note ? ' ' + rule.note : ''));
    else flag(pop === 'adult' ? 'magnesium-routine-arrest' : 'magnesium-routine-arrest-child',
      'Magnesium is not part of routine arrest care — it is for torsades de pointes or a low magnesium.');
  }
  // Read once and used twice — here to flag the dose, and below to stop it converting the
  // rhythm it is wrong for. Two copies of the condition could be edited apart.
  const wrongForRhythm = !!(rule.wrongFor && rule.wrongFor.indexOf(state.rhythm) !== -1);
  if(wrongForRhythm)
    flag(WRONG_FOR_TEACH[name + '|' + state.rhythm] || 'wrong-rhythm', rule.wrongForNote ||
      (capitalize(name) + ' is the wrong drug for ' + rhythmName(state.rhythm) + '.'));
  // AN ANTIARRHYTHMIC IS FOR VF/pVT, OR A TACHYCARDIA WITH A PULSE. Only amiodarone into asystole was
  // flagged: the first amiodarone or lidocaine into PEA (the repeat is held — antiRepeat), lidocaine
  // into asystole, and amiodarone at complete heart block or the hypoxic child's bradycardia all went in
  // "all correct". At a slow rate it is worse than useless — it suppresses the escape rhythm the
  // patient is living on. The note is read back to the doctor at once, so it does not name a rhythm
  // nobody has called (the blind-rhythm rule): in the arrest it asks for the call; with a pulse it says
  // the rate. Lidocaine as a local anaesthetic (for a chest tube, a line) is not an antiarrhythmic.
  // (With a pulse only a BRADYCARDIA is judged here — a rate under 60 that is not a tachyarrhythmia.
  // Lidocaine at a sinus tachycardia may be an intubation premedication, and amiodarone there is Kim's
  // call; neither was asked for.)
  const antiArrhythmic = (name === 'amiodarone' || name === 'lidocaine') && !(name === 'lidocaine' && localAnaesthetic(text, route));
  // (One rule, exported for the page's Hint — antiarrhythmicNotIndicated; round 7.)
  const antiNotIndicated = antiArrhythmic && antiarrhythmicNotIndicated(state);
  if(antiNotIndicated)
    flag((state.pulse ? 'antiarrhythmic-bradycardia' : 'antiarrhythmic-nonshockable') + (pop === 'adult' ? '' : '-child'), state.pulse
      ? capitalize(name) + ' is for VF, pulseless VT or a tachyarrhythmia with a pulse — the rate is ' + state.hr +
        ', and an antiarrhythmic can suppress the escape rhythm the patient is living on.'
      : capitalize(name) + ' is for VF and pulseless VT' + (heardName(state)
        // (A traumatic arrest's next step is its cause, not epinephrine — review, 2026-09-27.)
        ? ' — not for ' + heardName(state) + '. ' + (traumaArrest(state, script)
          ? 'Here the causes come first: decompress the chest, stop the bleeding, give blood.' : 'Compressions, epinephrine and the reversible causes.')
        : ' — call the rhythm on the monitor before an antiarrhythmic.'));
  // LIDOCAINE IS A VENTRICULAR DRUG (2026-09-27). Into a narrow-complex tachycardia or atrial fibrillation it was judged only
  // on its dose — "all correct" at 1-1.5 mg/kg. The guidelines give it for VF, pulseless VT and ventricular tachycardia;
  // the narrow rhythms have their own drugs. (Said by what it is for, not by the rhythm — the blind-rhythm rule.)
  // (Review, 2026-09-27: the infant's SVT reads the PALS card, not the adult's "rate control with diltiazem"; and a lesson, not a
  // flag — LESSONS_SCORED.)
  else if(name === 'lidocaine' && antiArrhythmic && state.pulse && !state.ended && SUPRAVENTRICULAR.has(state.rhythm))
    lesson(pop === 'adult' ? 'lidocaine-supraventricular' : 'lidocaine-supraventricular-child', 'Lidocaine is for ventricular arrhythmias — it will not slow or convert this rhythm.');
  // IN TORSADES THE DRUG IS MAGNESIUM (review, 2026-09-27). Lidocaine before the third shock in the pulseless torsades read the
  // VF card — "amiodarone 300 mg or lidocaine after the third shock" — in the case whose own lesson is that amiodarone feeds
  // torsades. AHA 2025 polymorphic VT: magnesium for a long QT; lidocaine or amiodarone only when the QT is normal. Taught, not
  // marked down (the script doses lidocaine, and the live version accepted it).
  if(name === 'lidocaine' && antiArrhythmic && state.rhythm === 'torsades' && !state.ended && pop === 'adult')
    lesson('lidocaine-torsades', 'Lidocaine is for polymorphic VT with a normal QT — here the drug is magnesium.');
  // CARDIOVERSION BEFORE THE DRUG (review, 2026-09-27). An adult with a pulse, a tachycardia that shocks, a systolic under 90 and
  // no synchronized shock yet: amiodarone 150 mg and lidocaine went in with no lesson, while procainamide, digoxin, a beta-blocker
  // or diltiazem at the same moment were taught "an unstable tachycardia needs cardioversion, not a drug" — whose own source names
  // amiodarone. Taught, not marked down: the drug may still be the right one once the patient is stable. (Not once a synchronized
  // shock has been tried: amiodarone for a critically ill AF after cardioversion has failed is the guideline's 2a.)
  if(antiArrhythmic && !antiNotIndicated && pop === 'adult' && state.pulse && !state.ended && CARDIOVERTABLE.has(state.rhythm)
     && state.bpSys < 90 && !state.shocks.some(x => x.sync) && !(name === 'lidocaine' && SUPRAVENTRICULAR.has(state.rhythm)))
    lesson(state.rhythm === 'VT' ? 'drug-instead-of-cardioversion-wct' : 'drug-instead-of-cardioversion',
      capitalize(name) + ' is for a stable patient — at a pressure of ' + state.bpSys + ' this tachycardia needs synchronized cardioversion first.');
  // (Magnesium in torsades was forced ok here, whatever the dose — 20 g scored correct. Its range is now
  // its own band, 1-2 g, and torsades is its indication for the routine-adjunct rule above.)
  // PALS and NRP give epinephrine for a rate under sixty despite effective ventilation (and
  // compressions). A child with a pulse and a rate of sixty or more is not an epinephrine patient.
  // (An IM dose for anaphylaxis or asthma is not that bradycardia dose, and is not judged on the rate.)
  if(name === 'epinephrine' && isChild(script) && state.pulse && state.hr >= 60 && !infusion && !imEpi)
    flag(pop === 'newborn' ? 'epi-newborn-rate-60' : 'epi-child-rate-60',
      'The heart rate is ' + state.hr + ' — epinephrine is for a rate under 60 despite effective ventilation and compressions.');
  // AN EPINEPHRINE DRIP HAS ITS PATIENTS, AND THESE ARE NOT THEM. Once a drip was read as a drip (round
  // 5) the rate rules above stood down for it, and an infusion into the infant's tachycardia at 240, or
  // the newborn at 70, scored "all correct". A child's tachyarrhythmia is made faster by it — the
  // tachycardia itself is what needs treating. NRP has no epinephrine infusion at all during the
  // resuscitation: a newborn's epinephrine is the bolus, for a rate under 60 despite ventilation and
  // compressions. (Once the pulse is back — ROSC, or the case ended stable — a pressor drip is
  // post-resuscitation care, and correct. A pulseless newborn's drip is the arrest-drip flag below.)
  // (2026-09-27: an adult's tachyarrhythmia too. A drip into a stable SVT at 190 or an unstable AF at 170 scored "all
  // correct": the guideline's epinephrine infusion is for a bradycardia atropine has not fixed.)
  // (Review: the adult's is a lesson, not a flag — the live version accepted it. The child's and the newborn's were flags there.)
  else if(name === 'epinephrine' && infusion && state.pulse && !state.ended
          && (isNeonate(script) || CARDIOVERTABLE.has(state.rhythm)))
    (pop === 'adult' ? lesson : flag)(pop === 'newborn' ? 'epi-drip-newborn' : pop === 'child' ? 'epi-drip-tachycardia-child' : 'epi-drip-tachycardia', isNeonate(script)
      ? 'A newborn is not given an epinephrine infusion during the resuscitation — NRP gives epinephrine as a bolus, 0.01-0.03 mg/kg IV, for a rate under 60 despite ventilation and compressions.'
      : 'The heart rate is ' + state.hr + ' — an epinephrine infusion drives a tachycardia faster. The tachycardia itself is what needs treating.');
  // VENTILATION FIRST. A newborn's heart rate, and a bradycardic child's, falls because the child is
  // not breathing: NRP gives epinephrine only for a rate under 60 after 30 seconds of ventilation that
  // moves the chest and 60 seconds of compressions coordinated with it, and PALS only for a rate under
  // 60 despite oxygenation and ventilation. Epinephrine before a single breath was accepted and earned
  // the epinephrine critical action — in the cases built to teach that order (the apnoeic newborn, the
  // hypoxic bradycardic child). Given, and flagged, so that dose earns nothing. A newborn needs the
  // compressions given too. (A pulseless child's arrest dose is not judged here: in cardiac arrest
  // epinephrine goes in as soon as there is a line, alongside the breaths.)
  // Ventilation is whatever the doctor called it (asksToVentilate, read in act() for every order).
  // Compressions GIVEN, not running this second: NRP pauses them briefly to count the heart rate, and
  // the epinephrine goes in in that pause — flagged "Compressions first" it lost its credit (round 6).
  else if(name === 'epinephrine' && !imEpi && (isNeonate(script) || (isChild(script) && state.pulse)) && (!state.pulse || state.hr < 60)){
    const ventilated = !!state.flags.ppv || (state.flags.ppv !== false && (state.airway !== 'none' || !!state.flags.altAirway));
    if(!ventilated)
      flag(pop === 'newborn' ? 'epi-before-ventilation-newborn' : 'epi-before-ventilation-child',
        'Ventilation first — epinephrine is for a rate under 60 despite effective ventilation and compressions.');
    else if(isNeonate(script) && !state.cpr && !(state.cprSecs > 0))
      flag('epi-before-compressions-newborn', 'Compressions first — a newborn is given epinephrine for a rate under 60 after 30 seconds of ventilation that moves the chest and 60 seconds of compressions coordinated with it.');
  }
  // ADENOSINE BREAKS A RE-ENTRANT TACHYCARDIA THAT IS RUNNING. Once the SVT had been cardioverted to
  // sinus, 6 and 12 mg ordered after it went in unflagged and ticked the adenosine step. Into a rate
  // with nothing to break it is flagged (said by the rate — the rhythm is the doctor's to call).
  // (Review, 2026-09-27: not torsades with a pulse — a tachycardia is running there, and "no tachycardia to break" was the
  // wrong reason; its own reason follows, flagged as it was.)
  if(name === 'adenosine' && state.pulse && !CARDIOVERTABLE.has(state.rhythm) && state.rhythm !== 'torsades')
    flag(pop === 'adult' ? 'adenosine-no-tachycardia' : 'adenosine-no-tachycardia-child',
      'There is no tachycardia running for adenosine to break — the rate is ' + state.hr + '.');
  // ADENOSINE INTO AN UNSTABLE WIDE-COMPLEX TACHYCARDIA (2026-09-27). The unstable VT at 82 systolic took it "all correct"
  // (the case's own row answers that it does nothing). AHA 2025: not for an unstable, irregular or polymorphic wide-complex
  // tachycardia — Class 3: Harm; it will not stop VT and can bring on hypotension or VF. (A stable, regular, monomorphic one
  // may be given it: 2b. The irregular one — atrial fibrillation — is the script's own wrongFor.)
  // (Review, 2026-09-27: a lesson, not a flag — LESSONS_SCORED; and said by the pressure and the drug's effect, never by the
  // complex the doctor has not called — the blind-rhythm rule. Torsades with a pulse at a normal pressure is not "unstable":
  // there adenosine simply does not treat it.)
  else if(name === 'adenosine' && pop === 'adult' && state.pulse && !state.ended
          && (state.rhythm === 'torsades' || (state.rhythm === 'VT' && state.bpSys < 90)))
    (state.rhythm === 'torsades' ? flag : lesson)('adenosine-unstable-wct', state.rhythm === 'torsades'
      ? 'Adenosine will not break this rhythm and can bring on VF — ' + (state.bpSys < 90 ? 'at a pressure of ' + state.bpSys + ' it needs a shock.' : 'magnesium, and a shock if the pressure falls.')
      : 'At a pressure of ' + state.bpSys + ' adenosine can drop the pressure further or bring on VF — this needs synchronized cardioversion.');
  // Atropine left the cardiac-arrest algorithm in 2010. Given, and said so in the debrief.
  if(inArrest && name === 'atropine' && !state.pulse)
    flag(pop === 'adult' ? 'atropine-in-arrest' : 'atropine-in-arrest-child', 'Atropine is not part of cardiac arrest care — it is for a bradycardia with a pulse.');
  // ATROPINE IS FOR A SLOW HEART (2026-09-27). At 170, 190 and 240 it went in "all correct". Said by the rate.
  // (Review: a lesson, not a flag — LESSONS_SCORED. Nor atropine ordered as a premedication for intubation, which PALS allows
  // where bradycardia is likely: ATROPINE_PREMED_RE.)
  else if(name === 'atropine' && pop !== 'newborn' && state.pulse && !state.ended && !infusion && state.hr >= 100 && !ATROPINE_PREMED_RE.test(norm(text)))
    lesson(pop === 'adult' ? 'atropine-no-bradycardia' : 'atropine-no-bradycardia-child',
      'Atropine speeds the heart — the rate is ' + state.hr + ' already.');
  // ...AND NOT FOR A CHILD'S HYPOXIC ONE. PALS 2025 gives it only for a bradycardia from vagal tone or a primary AV block
  // (Class 1); a slow heart from hypoxia is treated with oxygen and breaths, then CPR and epinephrine. The bradycardic
  // child with croup took it before a single breath, and after them, "all correct" — the case's own action says it has no
  // place. Read from the case: a child whose declared cause is the hypoxia.
  else if(name === 'atropine' && pop === 'child' && state.pulse && !state.ended && state.hr < 100
          && ((script.causes || {}).actions || {}).hypoxia && !ATROPINE_PREMED_RE.test(norm(text)))
    lesson('atropine-hypoxic-bradycardia-child', 'This slow heart is from hypoxia — oxygen and breaths first; atropine is for a vagal or heart-block bradycardia.');
  // A NEWBORN GETS D10. NRP treats a newborn's low sugar with D10W, 2 mL/kg (0.2 g/kg), through the
  // umbilical line. D25 and D50 are hypertonic: they damage a newborn's veins, swing the glucose (the
  // rebound low follows the spike) and are linked to intraventricular haemorrhage. "D25 2 mL/kg" went
  // in unjudged (the amount is still left unjudged — no newborn script doses it).
  const dexPct = name === 'dextrose' ? dextroseStrength(text) : null;
  if(dexPct != null && dexPct > 12.5 && isNeonate(script))
    flag('dextrose-newborn-strength', 'A newborn is given D10, not D' + dexPct + ' — 2 mL/kg (0.2 g/kg) of D10W through the umbilical line. Stronger dextrose is hypertonic: it damages a newborn\'s veins and swings the glucose.');
  // (A child's second lidocaine bolus that reaches here is the PALS repeat — fifteen minutes on, no
  // infusion running; any sooner, antiRepeat holds it.)
  // A DRIP IS NOT ARREST CARE. In cardiac arrest epinephrine is a bolus every 3-5 minutes; its
  // infusion is for the pressure once the pulse is back. Given and flagged with the reason — it starts
  // no clock (epiTimed) and is not the epinephrine a ROSC or shock row waits for (hasAction). An
  // amiodarone or lidocaine drip with no bolus in this arrest is flagged the same way and never opens
  // the shock ladder's antiarrhythmic row (pickShockResult). A child's lidocaine infusion after its
  // bolus is PALS, and is not flagged. (Into PEA or asystole an antiarrhythmic drip is simply not
  // indicated — the note above says so, and "a bolus in VF/pVT" would teach the wrong thing there.)
  // Nor is a naloxone drip: in an opioid arrest naloxone is a bolus; the infusion is for the re-sedation
  // that follows once the pulse is back. Ticked "naloxone 2 mg" during the arrest (round 6).
  // Nor magnesium with no push before it: pulseless torsades gets 1-2 g over a minute or two, and "2 g
  // an hour" gives it 67 mg in that time. Live read that drip as a 2 g push and credited it (round 6).
  // ROUND 10 (Kim's N3): THE FLAG IS FOR A DRIP INSTEAD OF THE BOLUS. "Naloxone 2 mg then 1.3 mg over 1 hour", "naloxone
  // 2 mg IV then a drip": the bolus went in, correctly, and the drip ordered in the same breath is the maintenance that
  // follows it — recorded, not flagged (live dropped it silently; round 9 FAILed doseAccuracy on it). The same order is
  // `mode` 'drip' (the second half of one order — splitBolusDrip — or the drip clause the page split off it naming no
  // drug — dripOfLastBolus), or a clause that names it straight after its bolus in the same code second ("naloxone 2 mg IV,
  // then a naloxone infusion at 0.4 mg/h" reaches the engine as two orders) — its bolus given or, on its clock, held (K2).
  // And a bolus of it went in this arrest as the dose, unflagged. (Amiodarone, lidocaine and magnesium were already exempt
  // after any bolus in the arrest.)
  // NALOXONE IS FOR AN OPIOID (2026-09-27). In the VF arrest, the croup child and the heart block it went in "all correct".
  // AHA 2025 gives it for a suspected opioid overdose — respiratory arrest with a pulse (Class 1), cardiac arrest (2b, and
  // only if it does not get in the way of CPR); it does not reverse VF. Where the case gives no opioid, it is flagged; where
  // it does (the opioid arrest, which credits it), it is the drug. A newborn is left alone: the neonatal guideline does not
  // address it, and nothing here verifies the older advice.
  // (Review: these two are lessons, not flags — LESSONS_SCORED.)
  if(name === 'naloxone' && pop !== 'newborn' && !state.ended && !naloxoneIndicated(script))
    lesson(pop === 'adult' ? 'naloxone-no-opioid' : 'naloxone-no-opioid-child', 'Naloxone is for a suspected opioid overdose, and nothing in this case points to one.');
  // TRANEXAMIC ACID IS FOR BLEEDING TRAUMA (2026-09-27). A medical VF took it "all correct". CRASH-2 and the trauma
  // protocols give it to the bleeding trauma patient within three hours of injury — a case with no bleed has no use for it.
  if(name === 'tranexamic' && !state.ended && !tranexamicIndicated(script))
    lesson('txa-no-bleeding', 'Tranexamic acid is for a bleeding trauma patient, within three hours of the injury — nothing here is bleeding.');
  const lastRec = state.drugs[state.drugs.length - 1], hb = state.heldBolus;
  const sameOrder = mode === 'drip' || (!!lastRec && lastRec.name === name && !lastRec.infusion && lastRec.t === state.t)
    || (!!hb && hb.name === name && hb.t === state.t && hb.n === state.drugs.length);
  const maintenance = sameOrder && state.drugs.some(d => d.name === name && d.pulseless && !d.infusion && !d.under && d.ok
    && d.episode === state.episode);
  const arrestDrip = infusion && !state.pulse && !maintenance && (name === 'epinephrine' || name === 'naloxone'
    || ((name === 'amiodarone' || name === 'lidocaine' || name === 'magnesium') && !antiNotIndicated
        && !state.drugs.some(d => d.name === name && d.pulseless && !d.infusion && d.episode === state.episode)));
  if(arrestDrip)
    flag(name === 'epinephrine' ? (pop === 'newborn' ? 'epi-drip-newborn' : pop === 'child' ? 'epi-drip-in-arrest-child' : 'epi-drip-in-arrest')
      : name === 'naloxone' ? 'naloxone-drip-in-arrest' : name === 'magnesium' ? 'magnesium-drip-in-arrest'
      : 'antiarrhythmic-drip-no-bolus' + (pop === 'adult' ? '' : '-child'), (name === 'epinephrine'
      ? 'An epinephrine infusion is not arrest care — in cardiac arrest epinephrine is a bolus every 3-5 minutes (' +
        (isNeonate(script) ? '0.01-0.03 mg/kg' : isChild(script) ? '0.01 mg/kg' : '1 mg') + '); the drip is for the pressure after the pulse comes back.'
      : name === 'naloxone'
      ? 'A naloxone infusion is not arrest care — in an opioid arrest naloxone is a bolus (' + (isChild(script) ? '0.1 mg/kg, up to 2 mg' : '2 mg') +
        ' IV or IO); the drip is for re-sedation once the pulse is back.'
      : name === 'magnesium'
      ? 'A magnesium infusion is not arrest care — with no pulse magnesium goes in as a push (' +
        (isChild(script) ? '25-50 mg/kg, 2 g at most' : '1-2 g') + ' over 1-2 minutes); the drip is for once the pulse is back.'
      // (The rhythm by name only once the doctor has called it — the note is read back at once.)
      : capitalize(name) + ' goes in as a bolus ' + (heardName(state) ? 'in VF/pVT' : 'first in an arrest') + ' (' + (name === 'amiodarone' ? (isChild(script) ? '5 mg/kg' : '300 mg') : (isChild(script) ? '1 mg/kg' : '1-1.5 mg/kg')) +
        ') — the infusion follows the bolus, it does not replace it.'), 'route');
  // ADENOSINE IS NEVER A DRIP. Its half-life is under ten seconds: it works only as a rapid push chased
  // by a flush. "Adenosine 12 mg a minute" was read as an infusion (round 5) and scored correct, where
  // live had flagged it; given and flagged, it earns nothing and breaks nothing (round 6).
  if(infusion && name === 'adenosine')
    flag(pop === 'adult' ? 'adenosine-infusion' : 'adenosine-infusion-child', 'Adenosine is not run as an infusion — it is a rapid IV push with an immediate flush' +
      (isChild(script) ? ' (0.1 mg/kg, then 0.2 mg/kg).' : ' (6 mg, then 12 mg).'), 'route');
  // NOR IS ATROPINE (round 8, Kim). A bradycardia's atropine is a bolus, repeated to its maximum; "atropine 1 mg then
  // a drip" at complete heart block recorded "Atropine infusion running", unflagged. When the boluses fail, the next
  // step is the pacer or an epinephrine (or dopamine) drip.
  if(infusion && name === 'atropine')
    flag(pop === 'adult' ? 'atropine-infusion' : 'atropine-infusion-child', 'Atropine is not run as an infusion — it is a bolus' +
      (isChild(script) ? ' (0.02 mg/kg, repeated once).' : ' (1 mg every 3-5 minutes, to 3 mg).') + ' When it fails, pace or start an epinephrine drip.', 'route');
  // (2026-09-27: "Give it IV OR IO." — each route in capitals, not the word between them.)
  if(rule.route && route && rule.route.indexOf(route) === -1 && !tubeEpi && !imEpi && !imInArrest)
    flag(pop === 'newborn' ? 'route-uvc-io-newborn' : pop === 'child' ? 'route-iv-io-child' : 'route-iv-io',
      'Give it ' + rule.route.map(r => r.toUpperCase()).join(' or ') + '.', 'route');
  // The tube is for when there is NO line. With IV/IO access in, absorption down the tube is
  // unreliable and the dose belongs in the vein: given, and flagged — the choice of route is the
  // error, and it is a real one (PALS/NRP: "if no IV/IO access").
  if(tubeEpi && (state.ivAccess || state.io || state.flags.uvc))
    flag(pop === 'newborn' ? 'epi-tube-line-in-newborn' : pop === 'child' ? 'epi-tube-line-in-child' : 'epi-tube-line-in',
      'The line is in — epinephrine goes IV or IO now. The tube is only for when there is no line: absorption down it is unreliable.', 'route');
  // IM in an arrest, or a child on compressions for a rate under sixty: there is too little
  // circulation to carry it from the muscle.
  if(imInArrest)
    flag(pop === 'adult' ? 'epi-im-in-arrest' : 'epi-im-in-arrest-child', state.pulse
      ? 'On compressions epinephrine goes IV or IO — an intramuscular or subcutaneous dose is barely absorbed at this circulation.'
      : 'In an arrest epinephrine goes IV or IO — an intramuscular or subcutaneous dose is not absorbed without a circulation.', 'route');

  // The note: every reason, in the order found. The lesson that leads (see `why` above): the wrong drug first, then the wrong
  // way of giving it, then the dose; the rest stay on the record (`teachAll`).
  // (A lesson — LESSONS_SCORED — is not read back: the nurse's words are the live version's.)
  note = why.filter(w => !w.lesson).map(w => w.text).join(' ');
  const RANK = { indication: 3, route: 2, dose: 1 };
  const lead = why.slice().sort((a, b) => RANK[b.kind] - RANK[a.kind])[0] || null;
  const rec = { t: state.t, name, doseMg: dose.mg, route, ok, note, pulseless: !state.pulse, episode: state.pulse ? null : state.episode };
  // ...and the lead's own words (review, 2026-09-27): a card with no verified source, or with no table at all, is built from the
  // reason that leads it — not from the joined note, whose first clause is often the dose ("Dose out of range … expected 82 mEq"
  // on a bicarbonate whose lesson is that it had no indication).
  if(lead){ rec.teach = lead.key; rec.teachAll = why.map(w => w.key); rec.teachText = lead.text; }
  // A traumatic arrest: its cards say the causes come first, not "…then epinephrine" (medicationReview, drug-teaching `trauma`).
  if(traumaArrest(state, script)) rec.traumaArrest = true;
  // What went in, as it was said ("1 g", "50 mEq") — the debrief's card names the dose it teaches about.
  const doseWords = spokenDose(dose).trim();
  if(doseWords) rec.dose = doseWords;
  // ...and the rhythm it went into, for the debrief's timing lessons (medicationReview).
  rec.rhythm = state.rhythm;
  if(mode === 'dry') return { under, ok, note };
  if(infusion){ rec.infusion = true; rec.rate = rateText(text); }
  if(under) rec.under = true;
  // Where it falls among the shocks: "after the next shock" is decided by ORDER, not by the clock's
  // second — a dose and then the arrest's first shock in the same second is a dose the shock followed.
  rec.shocksBefore = state.shocks.length;
  // Only an arrest bolus (any bolus in a child) starts the three-to-five-minute clock — and only one
  // that was the dose, not a flagged underdose.
  if(name === 'epinephrine' && epiTimed(state, script, text) && !under){ rec.timed = true; state.lastEpiT = state.t; }
  if(name === 'epinephrine' && state.pendingQuestion === 'epi') state.pendingQuestion = null;   // (not the sync question)
  // (R12: and her offer of this drug — "Shall I give it?", "Ready for the 12" — is answered by the dose itself.)
  if((state.pendingQuestion === 'drug' || state.pendingQuestion === 'adenosine') && state.questionDrug === name && !infusion) state.pendingQuestion = null;
  state.drugs.push(rec);
  if(name === 'amiodarone') state.amioDoses += 1;
  state.flags[name] = true;

  if(salt) rec.salt = salt;

  // A drip is read back as the rate it runs at — "Lidocaine infusion running at 20 mcg/kg/min" —
  // never as the tiny bolus its microgram number would make ("Lidocaine 0.02 mg is in").
  const out = [ev(state, 'drug', infusion
    ? capitalize(name) + ' infusion running' + (rec.rate ? ' at ' + rec.rate : '') + '.'
    : capitalize(name) + (salt ? ' ' + salt : '') + spokenDose(dose) + ' is in.', { ok, name })];
  // A DOSE THAT IS WRONG FOR THIS RHYTHM DOES NOT CONVERT IT. The record already says
  // ok:false; letting the conversion rule fire regardless taught that adenosine converts
  // atrial fibrillation — the one thing the script's own wrongForNote says it cannot do.
  // Nor does an IM epinephrine: the conversion rows are written for the systemic dose.
  // Nor an UNDERDOSE (it was not the dose: a flagged 3 mg of adenosine is not the "first dose" the SVT
  // case's rows count, so the 6 mg and then the 12 still come), nor the drip after a bolus.
  if(!wrongForRhythm && !under && mode !== 'drip' && !(name === 'epinephrine' && offAlgorithmRoute(route))) out.push(...checkConversion(state, script, name));
  return out;
}

// THE DRUGS THIS ENGINE DOES NOT DOSE, CLAIMED ONLY WHERE THEY ARE WRONG (2026-09-27 — see actInner). Each has the words a
// lead says, the context the guideline rules it out in, the teaching key, and the nurse's line. Nothing here is held,
// timed, converted or credited: the dose goes in and the record says why it was the wrong drug.
const OFF_LIST = [
  { name: 'vasopressin', re: /\b(?:vasopressin|pitressin|vasostrict)\b/, key: 'vasopressin-arrest',
    when: (state, script) => !state.pulse && populationOf(script) === 'adult',
    // (A traumatic arrest's vasopressor is no vasopressor at all until the causes are fixed — review, 2026-09-27.)
    note: (d, state, script) => traumaArrest(state, script)
      ? 'Vasopressin adds nothing in a traumatic arrest — the causes come first: decompress the chest, stop the bleeding, give blood.'
      : 'Vasopressin adds nothing to epinephrine in cardiac arrest — epinephrine 1 mg every 3-5 minutes is the vasopressor.' },
  { name: 'thrombolytic', re: /\b(?:alteplase|tenecteplase|reteplase|t\s?pa|rt\s?pa|tnk|tnkase|activase|thrombolys[ie]s|thrombolytics?|fibrinolys[ie]s|fibrinolytics?|lytics)\b/,
    key: 'thrombolytic-no-pe', named: s => (s.match(/\b(alteplase|tenecteplase|reteplase)\b/) || [])[1]
      || (/\b(?:t\s?pa|rt\s?pa|activase)\b/.test(s) ? 'alteplase' : /\b(?:tnk|tnkase)\b/.test(s) ? 'tenecteplase' : 'thrombolytic'),
    when: (state, script) => !state.pulse && populationOf(script) === 'adult'
      && !/\bpe\b|embol|thrombo/i.test(Object.keys(((script.causes || {}).actions || {})).join(' ')),
    note: 'A thrombolytic is for a pulmonary embolism, and nothing in this arrest points to one — in an undifferentiated arrest it has not improved survival.' },
  // (Review, 2026-09-27: said by the drug's effect — it lengthens the QT — and by the rhythm only once the doctor has called it:
  // the note is read back at once, and the blind-rhythm rule holds. The debrief's card names it.)
  { name: 'antiarrhythmic', re: /\b(?:procainamide|sotalol|ibutilide)\b/, key: 'antiarrhythmic-torsades',
    named: s => (s.match(/\b(procainamide|sotalol|ibutilide)\b/) || [])[1],
    when: state => state.rhythm === 'torsades',
    note: (d, state) => capitalize(d) + ' lengthens the QT' + (heardName(state)
      ? ' — it feeds ' + heardName(state) + ' rather than breaking it.' : ' — here that feeds the arrhythmia rather than breaking it.') },
  // (Resumed build, 2026-09-27.) Any other drug that lengthens the QT, into torsades: the guideline's advice is to stop them
  // (AHA 2025 polymorphic VT; the torsades case's own step 4). Ondansetron and haloperidol went in "is in — pushed and flushed".
  { name: 'qt-drug', re: /\b(?:ondansetron|zofran|haloperidol|haldol|droperidol|methadone|azithromycin|erythromycin)\b/, key: 'qt-drug-torsades',
    named: s => ({ zofran: 'ondansetron', haldol: 'haloperidol' })[(s.match(/\b(ondansetron|zofran|haloperidol|haldol|droperidol|methadone|azithromycin|erythromycin)\b/) || [])[1]]
      || (s.match(/\b(ondansetron|zofran|haloperidol|haldol|droperidol|methadone|azithromycin|erythromycin)\b/) || [])[1],
    when: state => state.rhythm === 'torsades',
    note: (d, state) => capitalize(d) + ' lengthens the QT — ' + (heardName(state) ? 'in ' + heardName(state) : 'here') + ' every QT-prolonging drug is stopped, not given.' },
  // VERAPAMIL OR DILTIAZEM INTO VT (review, 2026-09-27) — AHA 2025's Class 3: Harm in a wide-complex tachycardia, and the one
  // error of the unstable-VT case that taught nothing in the debrief. The case's own pack answers the order (a falling pressure,
  // a lost action) as it always did: this only RECORDS it for the debrief — `recordOnly`, the order still falls through to the
  // turn engine. (Placed before the rate-control rule, which leaves this pair to the pack.)
  { name: 'ccb-wct', re: /\b(?:diltiazem|cardizem|verapamil)\b/, key: 'ccb-wct', recordOnly: true,
    named: s => /\bverapamil\b/.test(s) ? 'verapamil' : 'diltiazem',
    when: (state, script) => state.pulse && populationOf(script) === 'adult' && state.rhythm === 'VT',
    note: d => capitalize(d) + ' will not stop a wide-complex tachycardia and drops the pressure — synchronized cardioversion.' },
  // A RATE-SLOWING DRUG INTO AN UNSTABLE TACHYCARDIA (resumed build, 2026-09-27). Diltiazem, a beta-blocker, digoxin or
  // procainamide into the atrial fibrillation at 78 systolic went in "is in" with no lesson: AHA 2025 — an unstable tachycardia
  // with a pulse needs immediate synchronized cardioversion (Class 1), and drugs are for the stable patient. (Unstable is read
  // as the case's own threshold, a systolic under 90, as adenosine-unstable-wct reads it. Verapamil or diltiazem into VT is left
  // to the pack: the unstable-VT case answers it with its own consequence and critical action.)
  // (Review, 2026-09-27: into VT its card is the wide-complex one — synchronized cardioversion, then amiodarone or procainamide
  // if it recurs — not the atrial fibrillation's "rate control with a beta-blocker or diltiazem".)
  { name: 'rate-control', re: /\b(?:diltiazem|cardizem|verapamil|metoprolol|lopressor|esmolol|labetalol|propranolol|digoxin|procainamide)\b/,
    key: state => state.rhythm === 'VT' ? 'drug-instead-of-cardioversion-wct' : 'drug-instead-of-cardioversion',
    keys: ['drug-instead-of-cardioversion', 'drug-instead-of-cardioversion-wct'],
    named: s => ({ cardizem: 'diltiazem', lopressor: 'metoprolol' })[(s.match(/\b(diltiazem|cardizem|verapamil|metoprolol|lopressor|esmolol|labetalol|propranolol|digoxin|procainamide)\b/) || [])[1]]
      || (s.match(/\b(diltiazem|cardizem|verapamil|metoprolol|lopressor|esmolol|labetalol|propranolol|digoxin|procainamide)\b/) || [])[1],
    when: (state, script, s) => state.pulse && populationOf(script) === 'adult' && CARDIOVERTABLE.has(state.rhythm) && state.bpSys < 90
      && !(state.rhythm === 'VT' && /\b(?:diltiazem|cardizem|verapamil)\b/.test(s)),
    note: (d, state) => capitalize(d) + ' is for a stable patient — at a pressure of ' + state.bpSys + ' this tachycardia needs synchronized cardioversion.' },
  // A VASOPRESSOR INTO UNCONTROLLED BLEEDING (resumed build, 2026-09-27) — epinephrine's rule (giveDrug) for the pressors this
  // engine does not dose: norepinephrine, phenylephrine, dopamine went in with no lesson while the bleeding was not yet stopped.
  { name: 'vasopressor', re: /\b(?:norepinephrine|noradrenaline|norepi|levophed|phenylephrine|neosynephrine|neo-synephrine|dopamine)\b/,
    key: 'vasopressor-haemorrhagic-shock',
    named: s => (/\b(?:phenylephrine|neo-?synephrine)\b/.test(s) ? 'phenylephrine' : /\bdopamine\b/.test(s) ? 'dopamine' : 'norepinephrine'),
    dripOnly: /^(?:norepinephrine|dopamine)$/,   // never a push: "start levophed" is its drip
    when: (state, script) => state.pulse && populationOf(script) === 'adult' && traumaScript(script) && causesOutstanding(state, script),
    note: 'A vasopressor in uncontrolled bleeding squeezes an empty tank — stop the bleeding and give blood first.' }
];
// Only an ORDER is claimed. "Should we give vasopressin?", "what about lytics", "consider alteplase", "is she on methadone?", "send
// a digoxin level" are questions and mentions: they fall through to the turn engine as before, and nothing goes in.
const OFF_LIST_NOT_AN_ORDER_RE = /\?|^\s*(?:should|shall|do|does|did|can|could|would|will|is|are|was|were|what|why|how|when|any|anything|consider\w*|think\w*|thinking|maybe|perhaps|if)\b|\b(?:what about|how about|level|levels|history|home med\w*|allerg\w*|on (?:her|his) list)\b/;
// (Review, 2026-09-27.) ...AND ONLY AN ORDER SHAPED LIKE ONE: a dose, a rate or a route, or an order verb. The page splits the
// torsades model answer "stop the methadone and ondansetron" into "stop methadone" and "ondansetron" — and the bare second clause
// was given as ondansetron, flagged, and cost dose accuracy; the pack's own history word "methadone" was given too. A clause that
// is only a drug's name falls through to the turn engine, as on the live version.
const OFF_LIST_ORDER_SHAPE_RE = /\d|\b(?:give|giving|push|pushing|start|starting|hang|hanging|run|running|administer\w*|bolus\w*|load\w*|infus\w*|drip|iv|io|im|intravenous\w*|intraosseous\w*|intramuscular\w*|stat|units?|mg|mcg|micrograms?|milligrams?|grams?|amps?|vials?)\b/;
// ...AND NEVER ONE THAT SAYS NOT TO, OR ONLY TALKS ABOUT IT: a negation, a contrast, a discontinuation, a cause, a home drug, a
// statement. "Synchronized cardioversion at 150 joules instead of diltiazem" gave the diltiazem and no shock (the rhythm stayed
// AF); "d/c methadone", "methadone is the cause", "she takes methadone 90 mg daily", "diltiazem is contraindicated", "we won't
// give tPA", "norepinephrine is contraindicated" were each given. On the live version all fell through and nothing went in.
const OFF_LIST_NOT_GIVEN_RE = /\b(?:not|no|never|none|nothing|instead|rather|avoid\w*|contraindicat\w*|hold|holding|held|stop\w*|d\.?\/?c\.?|discontinu\w*|cancel\w*|strike|struck|scratch|remove|won t|wont|don t|dont|do not|didn t|isn t|shouldn t|without|cause|caused|causes|causing|culprit|takes|taking|took|toxicity|toxic|overdose\w*|home|chronic|daily|nightly|regular|usual|is|was|were|are|has|had|been)\b/;
// ...nor a clause that names an engine action — a shock, a cardioversion, pacing, compressions: that branch is the order's
// ("cardiovert, not diltiazem" is a cardioversion), and actInner reaches the drugs first.
const OFF_LIST_ENGINE_ACTION_RE = /\b(?:cardiover\w*|sync\w*|synch|shock\w*|defib\w*|pace|pacing|pacer|paced|joules?|compressions?|cpr)\b/;
function offListDrug(state, script, s, text){
  if(state.ended || findDrug(s)) return null;
  const raw = String(text == null ? s : text).toLowerCase();
  if(OFF_LIST_NOT_AN_ORDER_RE.test(raw)) return null;
  if(!OFF_LIST_ORDER_SHAPE_RE.test(s) || OFF_LIST_NOT_GIVEN_RE.test(s) || OFF_LIST_ENGINE_ACTION_RE.test(s)) return null;
  if(CODE_WITHHOLD_RE.test(String(text == null ? s : text))) return null;
  for(const o of OFF_LIST) if(o.re.test(s) && o.when(state, script, s))
    return Object.assign({}, o, { drug: o.named ? o.named(s) : o.name, key: typeof o.key === 'function' ? o.key(state, script) : o.key });
  return null;
}
// The record of an off-list drug. Not scored: it is left out of dose accuracy (summary) — on the live version these went to the
// turn engine and nothing was recorded — and it earns no credit (ok: false). The debrief teaches it (medicationReview).
function offListRecord(state, script, off, text){
  const note = typeof off.note === 'function' ? off.note(off.drug, state, script) : off.note;
  // A drip is read back as its rate ("Norepinephrine running at 10 mcg/min"), not as a bolus of the rate's number.
  const infusion = isInfusion(text) || !!(off.dripOnly && off.dripOnly.test(off.drug)), rate = infusion ? rateText(text) : null;
  const said = (String(text).match(/(\d+(?:\.\d+)?)\s*(units?|u|mg|mcg|g)\b/i) || []);
  const doseWords = !infusion && said[1] ? said[1] + ' ' + (/^u/i.test(said[2]) ? 'units' : said[2].toLowerCase()) : '';
  const rec = { t: state.t, name: off.drug, doseMg: null, route: routeOf(text), ok: false, offList: true, note, pulseless: !state.pulse,
    episode: state.pulse ? null : state.episode, shocksBefore: state.shocks.length, teach: off.key, teachAll: [off.key], teachText: note,
    rhythm: state.rhythm };
  if(traumaArrest(state, script)) rec.traumaArrest = true;
  if(doseWords) rec.dose = doseWords;
  if(infusion){ rec.infusion = true; rec.rate = rate; }
  state.drugs.push(rec);
  return { rec, infusion, rate, doseWords };
}
function giveOffListDrug(state, script, off, text){
  const { infusion, rate, doseWords } = offListRecord(state, script, off, text);
  return [ev(state, 'drug', capitalize(off.drug) + (infusion ? (rate ? ' running at ' + rate + '.' : ' infusion running.')
    : (doseWords ? ' ' + doseWords : '') + ' is in.'), { ok: false, name: off.drug })];
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
  return ' ' + doseNum(dose.mg) + ' mg';
}

function round2(x){ return Math.round(x * 100) / 100; }
// A dose as a number to say. Two decimals read a newborn's 0.068 mg back as "0.07 mg" and a
// 0.034 mg underdose as "0.03" — the readback is the check that catches a decimal error, so it
// must say what went in: three significant figures below 0.1 mg, two decimals above.
function doseNum(x){ return x > 0 && x < 0.1 ? Number(x.toPrecision(3)) : round2(x); }
function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

// A drug can convert a peri-arrest rhythm on its own (magnesium for torsades,
// adenosine for SVT) — the script's `convert` rows say so.
function checkConversion(state, script, action){
  const rows = (script.convert || []);
  for(const r of rows){
    if(r.rhythm && r.rhythm !== state.rhythm) continue;
    if(r.action !== action) continue;
    // The nth DOSE: an underdose and a drip are not one of the doses a row counts (giveDrug).
    if(r.nth != null && state.drugs.filter(d => d.name === action && !d.under && !d.infusion).length !== r.nth) continue;
    if(r.requires && !r.requires.every(k => hasAction(state, k))) continue;
    if(r.to === 'ROSC') return achieveRosc(state, script, action);
    setRhythm(state, r.to);
    // `pulse` is a deliberate authoring decision, never a side effect. It used to
    // default to TRUE, so a row written to say "nothing changed" — amiodarone in
    // torsades, atropine in complete block — quietly resuscitated a pulseless
    // patient. Omit it and the pulse is left exactly as it was.
    if(r.pulse === true){ state.pulse = true; state.phase = 'stable'; state.episodeT = null; state.pendingQuestion = null; }
    else if(r.pulse === false){
      // A pulse lost here is a new arrest, on the same footing as a crash row: its own episode
      // and its own first cycle.
      if(state.pulse){ state.pulse = false; startEpisode(state, r.to || state.rhythm); state.cycleT = 0; state.cycle = 1; loseThePulse(state); }
      state.phase = 'arrest'; }
    if(r.hr != null) state.hr = r.hr;
    if(r.bpSys != null){ state.bpSys = r.bpSys; state.bpDia = Math.round(r.bpSys * 0.62); }
    if(r.spo2 != null) state.spo2 = r.spo2;
    // Nothing is asked of the doctor, and no charge waits, once the case has ended (round 6). An ask the
    // team holds from here on is marked `afterEnd` (held) and is not the case's timing (summary). No
    // endedT for a 'stable' ending, on purpose: with one, the debrief's arrestEra would also drop the
    // doses FLAGGED after it — epinephrine 1 mg into the sinus rhythm a cardioversion left — which live
    // scores and the nurse reads back.
    if(r.ends){ state.ended = r.ends; state.pendingQuestion = null; state.charged = null; state.syncMode = false; }
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
// THE DOSE SHE OFFERED (R11). An epinephrine order that answers her "another epi?" and says no dose — "yes, give epi", "give
// the epinephrine" — is the dose she offered (a bare "yes" gives it; these went in with no dose at all). An IO or tube route
// said is kept; a dose, a volume, a drip or an IM route said is the order as said.
function epiAsOffered(script, text){
  const t = norm(text);
  if(findDrug(t) !== 'epinephrine' || /\d/.test(t) || isInfusion(text) || offAlgorithmRoute(routeOf(text)) || parseDose(text, script).mg != null) return text;
  const route = routeOf(text);
  return epiOrderFor(script).replace(/ IV$/, route === 'io' ? ' IO' : route === 'et' ? ' via the ET tube' : ' IV');
}
// R12 (Z3): A DOSE, OR "PUSH", IS AN ANSWER TO HER DRUG QUESTION. After "Ready for the 12", "Ready for the next adenosine — 1.2 mg",
// "Shall I give it?" or "another epi?", the doctor who answered with the dose — "yes, 12 mg", "push 12", "yep, push", "0.24 mg",
// "push 0.24", "1 mg", "yes, 0.2 mg/kg", "0.7 ml via the UVC" — was not heard: nothing went in, and the turn engine then said
// "Another dose of that is in." An answer made only of a yes, a give/push, the drug's own name, its route and a dose is that
// drug: at the dose said (graded as any order is), or with no dose, the dose she offered. A bare number is read in the drug's own
// unit only when it is near that dose ("yes, 12" to the 12; "yes 120" to "another epi?" is an energy, not 120 mg). Another drug
// named, an energy, a hold or a condition — anything else in the line — is not this answer. `name`: the drug asked about.
const DOSE_ANSWER_YES_RE = /^(?:(?:yes|yeah|yep|yup|ok|okay|sure|please|go ahead|do it|alright|all right|right|absolutely|of course|and|then)\b[\s,.;:!-]*)+/i;
const DOSE_ANSWER_WORDS_RE = /\b(?:give|giving|push|pushing|go with|it|that|the|a|an|dose|next|second|repeat|another|one|now|please|then|and|rapid|rapidly|fast|quick|quickly|flush(?:ed)?|with|saline|via|through|down|into|in|iv|io|intravenous(?:ly)?|intraosseous(?:ly)?|uvc|umbilical|venous|vein|line|catheter|et|ett|tube|endotracheal|bolus|slow(?:ly)?|of|mg|mgs|milligrams?|mcg|micrograms?|ug|g|gm|grams?|ml|mls|cc|meq|kg|kilos?|kilograms?|per|thanks|thank you)\b/g;
function doseAnswerOrder(state, script, name, text){
  const raw = String(text == null ? '' : text).trim().replace(DOSE_ANSWER_YES_RE, '').trim().replace(/^[\s,.;:!-]+/, '');
  const t = norm(raw);
  const other = findDrug(t);
  if((other && other !== name) || negatedDrug(t) || CODE_WITHHOLD_RE.test(raw) || /\b(?:if|after|once|first|before|until|when|joules?|j)\b/.test(t)) return null;
  const aliases = (DRUG_ALIASES[name] || [name]).slice().sort((x, y) => y.length - x.length);
  let left = t.replace(/\bover\s+\d+(?:\.\d+)?\s*(?:min|mins|minutes?)\b/g, ' ')
    .replace(/\b1\s*(?:in\s*)?10,?000\b|\b1\s*(?:in\s*)?1,?000\b|\b\d+(?:\.\d+)?\s*mg\s*(?:\/|per)\s*ml\b/g, ' ');
  for(const a of aliases) left = left.replace(new RegExp('\\b' + a + '\\b', 'g'), ' ');
  left = left.replace(DOSE_ANSWER_WORDS_RE, ' ').replace(/\//g, ' ');
  const nums = left.match(/\d+(?:\.\d+)?/g) || [];
  if(left.replace(/\d+(?:\.\d+)?/g, ' ').trim() || nums.length > 1) return null;
  if(!nums.length){
    // No dose: the dose she offered — only when the line gives or pushes it, or names it ("push", "yes, push it", "give the dose").
    if(t && !/\b(?:give|push|pushing|go with)\b/.test(t) && !other) return null;
    return name === 'epinephrine' ? epiAsOffered(script, 'epinephrine ' + raw) : drugOrderFor(state, script, name);
  }
  let order = raw;
  if(!/\d\s*(?:mg|mgs|milligrams?|mcg|micrograms?|ug|g|gm|grams?|ml|mls|cc|meq)\b/.test(t)){
    const n = parseFloat(nums[0]), want = expectedDoseMg(state, script, name);
    const u = ((script.drugs || {})[name] || {}).unit === 'mEq' ? 'mEq' : 'mg';
    if(/\d\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?\b/.test(t)) order = raw.replace(/(\d+(?:\.\d+)?)\s*(?=(?:\/|per)\s*k)/i, '$1 ' + u + ' ');
    else if(want != null && n >= want * 0.5 && n <= want * 2) order = raw.replace(/(\d+(?:\.\d+)?)(?![\d.])/, '$1 ' + u);
    else return null;
  }
  // (Spoken "1 of epi" — the dose of the drug: "of" and the name are not a strength.)
  order = order.replace(new RegExp('\\bof\\s+(?:the\\s+)?(?:' + aliases.join('|') + ')\\b', 'ig'), ' ').replace(/\s+/g, ' ').trim();
  return findDrug(norm(order)) === name ? order : (DRUG_ALIASES[name] || [name])[0] + ' ' + order;
}
// "GIVE IT AFTER THE SHOCK" (R11, Kim) — at her "another epi?": "after the shock", "give it after the shock", "let's shock
// first", "shock him first". The shock now (or held for the check, as "shock" is), and the epinephrine right after it goes in.
const EPI_AFTER_SHOCK_RE = /\bafter (?:the |this |that |a |our |his |her )?(?:next |second |third |2nd |3rd |following )?(?:shock|defib\w*)\b|\b(?:shock|defibrillate|defib)\s+(?:him |her |them |the patient )?first\b|\bfirst\s+(?:the\s+|a\s+)?shock\b|\bonce (?:we (?:ve|have) |he s been |she s been )?shock\w*\b/;
// (Only the epinephrine: "amiodarone after the shock" names another drug, and "no epi after the shock" refuses it.)
function epiAfterShockSaid(s){ const d = findDrug(s); return EPI_AFTER_SHOCK_RE.test(s) && !negatedDrug(s) && (!d || d === 'epinephrine'); }
// The epinephrine queued for right after the next shock, still waiting in this arrest.
function epiQueued(state){ const q = state.epiAfterShock; return !!q && !state.pulse && !state.ended && q.episode === state.episode; }
function epiAfterTheShock(state, script, now){
  state.pendingQuestion = null;
  state.epiAfterShock = { t: state.t, episode: state.episode };
  const r = actInner(state, script, 'shock', now) || {};
  const events = (r.events || []).slice();
  // (Delivered: the shock branch gave the dose after it. Otherwise it waits for the shock that is.)
  if(state.epiAfterShock) events.unshift(ev(state, 'note', 'Epinephrine right after the shock, doctor.', { ack: 'queued' }));
  return { handled: true, events };
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
// "Unsynchronized" (or non-synchronized) is an unsynchronized shock whatever noun follows it —
// "unsynchronized cardioversion" is a defibrillation, and is routed and refused as one.
const UNSYNC_RE = /\b(?:un|non)-?\s?(?:synchroni[sz]ed|sync)\b/;
// ONE SET OF WORDS FOR "SHOCK". Round 3 taught the defibrillation branch "hit him again", "charge
// then deliver" and "escalate the energy", but this refusal still knew only defib/shock/zap — so after
// ROSC "hit him again" shocked a sinus tachycardia, and after a successful cardioversion it shocked the
// sinus rhythm. The refusal and the branch now ask the same question. The pads are read as a noun
// first, as the branch does: placing them after ROSC is not a shock.
// ("Shocking" is the call-out that goes with the button — "clear, shocking" is a shock order. Round 6.)
const DEFIB_WORD_RE = /\b(defibrillat\w*|defib|shock|shocking|clear and shock|zap|dsed)\b/;
const SHOCK_PHRASE_RE = /\bcharge (?:and|then) (?:shock|deliver)\b|\bhit (?:him|her|them|the patient) again\b|\b(?:escalate|increase|go up on|bump)(?: up)?(?: the)? (?:energy|joules)\b/;
function stripPads(s){ return s.replace(/\b(?:defib(?:rillat\w*)?|pacing|pacer|external|transcutaneous)\s+pads?\b/g, ' pads '); }
// (Round 7: every wording of more energy — "more energy", "turn up the joules" — is the same shock word; "more
// energy" in VF reached no branch and was lost. ESCALATE_RE, below.)
function asksForShock(s){ return UNSYNC_RE.test(s) || DEFIB_WORD_RE.test(stripPads(s)) || SHOCK_PHRASE_RE.test(s) || ESCALATE_RE.test(s); }
// "Again", or more energy: the same therapy as last time, one step up.
const AGAIN_RE = /\bagain\b|\b(?:escalate|increase|go up on|bump|turn up|raise)(?: up)?(?: the)? (?:energy|joules)\b|\bmore (?:energy|joules)\b|^up the (?:energy|joules)\b|\bhigher (?:energy|joules)\b/;
// A CHARGE IS NOT A SHOCK. Charging during the last compressions, so that the only pause is the rhythm
// check itself, is AHA high-performance CPR — and the nurse's own "Shockable — charge" asks for it. But
// "charge the defibrillator to 200 joules" reached the shock branch on the word "defibrillator" ("charge
// to 200 joules" through the bare-energy rewrite): at 1:42 it was held and scored as a shock asked for
// before the check; at 1:54 it FIRED, and the doctor's own shock at the check was then refused. An order
// that charges and names no delivery (shock, deliver, defibrillate, fire, cardiovert…) is a charge: the
// team charges, says so, and delivers nothing. "Charge and shock", "charge then deliver" are still shocks.
const CHARGE_RE = /\b(?:pre-?charg\w*|charg(?:e|es|ed|ing))\b/;
const NOT_CHARGE_RE = /\bcharge nurse\b|\bin charge\b|\btake charge\b|\bcharge of\b/;
const DELIVER_RE = /\b(?:shock|shocks|shocking|deliver\w*|defibrillate|fire|discharge|zap|hit|cardiover\w*)\b/;
function chargeOnly(s){ return CHARGE_RE.test(s) && !NOT_CHARGE_RE.test(s) && !DELIVER_RE.test(s); }
// R12 (Z1): ELECTRICITY UNDER A NEGATION IS NEVER A SHOCK OR A CHARGE. "Asystole, we're not shocking, back on the chest" is the
// ACLS megacode's own announcement at a non-shockable check, and "we're not shocking" put a flagged 360 J into the asystole (and
// an unsynchronized shock into complete heart block): the refusal guard read only a negation that OPENED the clause, and the
// shock branch read the word "shocking". A shock, charge, defibrillation or cardioversion word that a negation governs — the
// negation, then only the words that carry it to the verb ("we are not GOING TO shock", "no NEED TO defibrillate", "don't
// charge YET", "no MORE shocks") — is the order not to shock, in every state: acknowledged, a charge waiting dumped. A noun
// between them ends the negation's reach ("no pulse, shock", "no change — shock again" are shocks), and so does a pause: the
// line is read one phrase at a time, at its punctuation ("No, shock him." at her question is a no, then a shock order).
const NEG_WORD_SRC = '(?:not|no|never|none|nothing|nobody|no one|without|stop|stopping|hold off(?: on)?|holding off(?: on)?|don t|dont|won t|wont|can t|cant|cannot|shouldn t|shouldnt|mustn t|isn t|aren t|wasn t|didn t|doesn t)';
const NEG_BRIDGE_SRC = '(?:going|gonna|to|be|being|do|doing|need|needed|needs|want|wanting|plan|planning|further|any|anymore|another|more|a|an|the|this|again|yet|now|just|deliver|delivering|give|giving|point|reason|indication|for|at|time|we|you|i|ll|re|s|are|is|will|able|allowed|ready|him|her|them|patient)';
const NEG_ELECTRIC_RE = new RegExp('\\b' + NEG_WORD_SRC + '(?:\\s+' + NEG_BRIDGE_SRC + ')*\\s+(?:shock\\w*|defib\\w*|pre-?charg\\w*|charg(?:e|es|ed|ing)|cardiover\\w*|zap\\w*|electricity)\\b');
function negatedElectricity(text){
  return String(text == null ? '' : text).split(/[,;:.!?—–]+|\s-+\s/).some(p => { const t = norm(p); return NEG_ELECTRIC_RE.test(t) && !/\bcharge nurse\b/.test(t); });
}
// What she says to a charge. Mid-cycle it waits for the check; at the check (or straight after one) it
// is ready now. Never a word about the rhythm: the doctor who charged has not necessarily called it.
// THE CHARGE WAITS FOR ITS SHOCK (round 6). She said "Charged to 200 joules, doctor." and then "clear",
// "everybody clear, shocking", "deliver", "fire" went to the turn engine: no shock at the check. So the
// charge is kept — its energy and its mode — until a shock, the end of the cycle after the check it was
// for, a change of pulse, or the end of the case; while it waits, the words that go with the button
// deliver it at the charged energy, down the ordinary path (its holds apply). A charge that says sync is
// a pending SYNCHRONIZED shock: "sync mode on, charge to 200", then "shock", went in unsynchronized.
// `text` is the charge order. A charge with a pulse and no word for the mode is asked about (askSync).
// Round 7: with no pulse there is nothing to synchronize to — a sync charge in VF went in synchronized at
// the next "shock", fired into nothing, and the ROSC came two minutes late. It is charged unsynchronized,
// and she says so. (A charge when the shock is due NOW never reaches here: it is delivered — actInner.)
function chargeNote(state, script, text){
  const j = shockEnergy(text, script), to = j != null ? ' to ' + j + ' joules' : '';
  const s = norm(text);
  // At a pulse a charge again keeps the mode of the one waiting (the machine stays in its mode) — unless her
  // "synchronized?" is still open about it; words for the mode win, and answer her question.
  const was = state.pulse && state.pendingQuestion !== 'sync' ? pendingCharge(state) : null;
  // (R9: a charge whose mode she asked about, and nobody answered, has no mode to keep — she asks again.)
  const unsync = wantsUnsync(s) || (!wantsSync(s) && !state.syncMode && !!was && !was.sync && !was.modeOpen);
  const syncOff = !state.pulse && wantsSync(s);
  const sync = !unsync && !!state.pulse && (wantsSync(s) || !!state.syncMode || (!!was && was.sync));
  const extra = { charge: j != null ? j : true };
  if(state.pulse){
    // Nothing to shock at this rhythm (complete heart block, a sinus rhythm): nothing is charged for it.
    if(!CARDIOVERTABLE.has(state.rhythm) && !SHOCKABLE.has(state.rhythm))
      return ev(state, 'withheld', 'There is a pulse, doctor, and a rate of ' + state.hr + ' — nothing to shock.');
    if((sync || unsync) && state.pendingQuestion === 'sync') state.pendingQuestion = null;
    armCharge(state, j, sync);
    if(sync) return ev(state, 'note', 'Charging' + to + ', synchronized, doctor.', Object.assign(extra, { sync: true }));
    if(unsync || !CARDIOVERTABLE.has(state.rhythm)) return ev(state, 'note', 'Charging' + to + ' — there is a pulse, doctor.', extra);
    askSync(state, j, true);
    // (R9, J2: the mode is still open — once her question has closed, the next shock word asks it again; it is never
    // delivered unsynchronized by default.)
    state.charged.modeOpen = true;
    return ev(state, 'note', 'Charging' + to + ' — there is a pulse, doctor: synchronized?', Object.assign(extra, { question: 'sync' }));
  }
  armCharge(state, j, false);
  if(syncOff) extra.syncOff = true;
  const win = checkWindow(state, script);
  return ev(state, 'note', (syncOff ? SYNC_OFF_TEXT + ' ' : '') + (!win.wait || win.justChecked ? 'Charged' + to + ', doctor.'
    : 'Charging' + to + ' — ready for the rhythm check. ' + chestLine(state)), extra);
}
// What she says to a synchronized shock or charge with no pulse (round 7, Kim): the machine will not fire
// in sync on a rhythm with no R wave to find, so the team switches it off and defibrillates.
const SYNC_OFF_TEXT = 'No pulse — sync won\'t fire; unsynchronized.';
const SYNC_WORD_RE = /\b(?:synchroni[sz]\w*|synch?)\b/;
// "Sync", "sync mode on", "turn on sync", "put it in sync mode" — the mode, with no shock and no charge.
const SYNC_MODE_RE = /^(?:(?:turn|switch|put|press)\s+(?:on\s+)?(?:it\s+|the\s+)?(?:defib\w*\s+|machine\s+|monitor\s+)?(?:in(?:to)?\s+|on\s+)?)?(?:the\s+)?(?:sync|synch|synchroni[sz]e|synchroni[sz]ed|synchroni[sz]ation)(?:\s+(?:mode|button))?(?:\s+on)?(?:\s+please)?$/;
// (`rhythm`: what it was charged for — a check that finds another dumps it, closeCycle.)
function armCharge(state, joules, sync){
  state.charged = { joules: joules != null ? joules : null, sync: !!sync, t: state.t, pulse: !!state.pulse,
    episode: state.episode, check: state.checksDone, rhythm: state.rhythm };
}
// The charge still waiting, or null (and forgotten) once it has gone stale: the case ended, the pulse
// came or went, or — in an arrest — the check it was charged for AND the cycle after it have closed. (The
// team's own charge at a check, `auto`, is for that check: the next one ends it — R8.)
function pendingCharge(state){
  const c = state.charged;
  if(!c) return null;
  // (R9: at a pulse, a minute — the machine disarms itself; tick says so.)
  const live = !state.ended && c.pulse === !!state.pulse
    && (state.pulse ? state.t - c.t <= PULSE_CHARGE_SEC : (c.episode === state.episode && state.checksDone <= c.check + (c.auto ? 0 : 1)));
  if(!live) state.charged = null;
  return live ? c : null;
}
// The page's view of it (round 7): { joules, sync, t } while a charge waits, else null. One rule — the room,
// the Hint and the nurse can no longer disagree about whether the defibrillator is charged.
function chargePending(state){
  const c = state && pendingCharge(state);
  return c ? Object.assign({ joules: c.joules, sync: !!c.sync, t: c.t }, c.auto ? { auto: true } : {}) : null;
}
// An amiodarone or lidocaine now would be the wrong drug (giveDrug flags it; the page's Hint skips it): during
// the case, no pulse and a rhythm that is not shockable — or a pulse at a rate under sixty that is neither a
// tachyarrhythmia nor shockable, where it suppresses the escape rhythm. After ROSC or a 'stable' ending it
// does not apply (the unstable VT's amiodarone after conversion is that case's own step).
function antiarrhythmicNotIndicated(state){
  if(!state || state.ended) return false;
  return state.pulse ? state.hr > 0 && state.hr < 60 && !CARDIOVERTABLE.has(state.rhythm) && !SHOCKABLE.has(state.rhythm)
    : !SHOCKABLE.has(state.rhythm);
}
// A shock of either kind spends the charge, and answers her question about synchronizing. True when a
// charge was waiting — the shock that spent it says so (`chargeEnd: 'delivered'`), and the next few
// seconds' bare "shock" is that same shock (shockEcho).
function spendCharge(state){
  const had = !!pendingCharge(state);
  state.charged = null; state.syncMode = false;
  if(state.pendingQuestion === 'sync') state.pendingQuestion = null;
  return had;
}
// The shock a charge just delivered: its event says so, and it is remembered for shockEcho.
// `byWords`: the NURSE fired it — on the words that go with the button (a call-out, "go ahead", an answer) or on the
// charge itself — and the doctor's own shock order in the next ten real seconds is that same shock (R8). A shock
// ORDER that spent a charge is not remembered: another one at a later second is a second order, held for the clock
// as it always was (Kim's stacking rule).
function markChargeShot(state, e, byWords){
  if(e) e.chargeEnd = 'delivered';
  state.chargeShot = byWords ? { t: state.t, n: state.shocks.length, nurse: true } : null;
}
// Her question "synchronized?" — with the energy it would be given at (asked, or charged). `mode`: she asked
// the MODE (a charge or a shock with no word for it, "more energy") — "no" is then an answer, an
// unsynchronized shock; false for sync mode's "at what energy?", where "no" turns sync off.
function askSync(state, joules, mode){
  state.pendingQuestion = 'sync'; state.questionT = state.t; state.questionRhythm = state.rhythm;
  state.syncAsk = { joules: joules != null ? joules : null, mode: mode !== false };
}
// ---------- THE DEFIBRILLATOR DIALOGUE (round 7) ----------
// Rounds 5 and 6 taught the engine the defibrillator one phrase at a time — a charge, the call-outs, her
// "synchronized?", sync mode, "increase the energy", the pacer's dials, "dump the charge" — and every
// re-verification found the next edge: a call-out after a shock became a second, stacked shock and failed the
// debrief; "yes" to "another epi?" delivered a waiting charge instead; "increase the energy on the pacer"
// defibrillated an asystolic patient at 360 J; a synchronized charge went into VF synchronized and cost two
// minutes. So the dialogue is written down ONCE, as a table: what the doctor's words do in every state the
// patient and the machine can be in (Kim's rules, round 7; round 8's changes are marked R8, round 9's R9, round 10's R10).
// tests/defib-dialogue.test.cjs runs this table.
//
// R10 — THREE PRINCIPLES, NOT MORE PHRASES. Nine rounds of phrase rules each fixed their targets and made new edges; round 10
// reads the dialogue through three rules and removed the special cases that contradicted them:
//   P1. readyIn(state, script, 'shock') is the ONE truth for electricity in a pulseless patient. A charge, a call-out on a
//       charge waiting, or a shock order is delivered exactly when it is 0 — in every rhythm, called or not (the first shock
//       into an uncalled PEA goes in flagged, as "shock" does there and as on live). Otherwise a charge is a pre-charge and a
//       call-out a quiet "Charged — shock at the rhythm check in N." (R9's cycle-based blind rule, checkNow, is gone: "charge
//       to 200" at 0:30 in uncalled VF never shocked, and the debrief said "Never defibrillated".)
//   P2. A hold never costs points (summary): the nurse stopping an early order IS the teaching.
//   P3. Read generously: an answer to her open question is an answer, explicit words (an energy, sync, a drug named) win over
//       defaults, and she never promises what she will not do.
//
// R11 — THE ROUND-10 RELEASE GATE, READ THROUGH THE SAME PRINCIPLES (scratchpad r10-result.md):
//   Q1 (P3) a line is a question only when it asks for information and carries no order (questionLine): "can he get …", "have
//       someone …", "do we want to …", "are we going to …", "is everybody clear?" are orders. "Is epi due?" before the first
//       dose opens "another epi?" (drugAnswer). A question the record cannot answer truthfully is passed on.
//   Q2 (P1, P3) the doctor's CORRECT call of a shockable rhythm when the shock is due, after a check or a shock, charges as a
//       called check does ("Shockable — charging, doctor."; the words still go on to the turn engine, `passOn`); in the arrest,
//       with the shock due, "yes", "ok", "do it", "go" on a charge waiting are the go-ahead, as "go ahead" is (mid-cycle and at a
//       pulse, the quiet line as before).
//   Q3 "Shockable — we will charge for the rhythm check in N" counts to the team's own check (the end of the cycle).
//   Q4 the leader's pause said in the EARLY_PAUSE_SEC before the check's window — or with a check the team holds — is held:
//       "Staying on the chest — the check is in N." Never held as an order, never scored.
//   Q5 a child's shock with no energy is the next rung (nextDefibJoules), as the button; "what energy?" is the energy.
//   Q6 "yes, give epi" is the dose she offered (epiAsOffered); "after the shock", "let's shock first" at "another epi?" — the
//       shock, and the epinephrine right after it goes in (epiAfterTheShock).
//   Q7 "hit him again", "shock again" at a pulse and a rhythm that is neither shocked nor cardioverted: nothing to shock.
//   Q8 "sync on, 100 joules" as one line: the synchronized shock at it (SYNC_THEN_ENERGY_RE).
//   Q9 a held repeat adenosine that comes due: "Ready for the 12, doctor." once (adenosineReady), and the yes gives it.
//
// R12 — THE ROUND-11 RELEASE GATE (scratchpad r11-result.md), the same principles:
//   Z1 (a table rule) a shock, charge, defibrillation or cardioversion word that a negation governs — "we're not shocking", "we are
//      not charging", "no shock for now", "we won't shock" — is the order not to shock in every state (negatedElectricity).
//   Z2 (P3) any case drug asked about is answered from readyIn/holdReason, and offered when due ("Shall I give it?", her question
//      'drug' or 'adenosine' — drugAnswer, drugOffer). Z3 a dose or a push answering her drug question is that dose (doseAnswerOrder).
//   Z4 (P3) a request with the patient as its subject that names a treatment is an order whatever its verb (askSentence).
//   Z5 (P1, P3) at a due shock with a charge waiting, a line opening with OK/Yes is read whole (joinAnswers): an energy after the
//      go-ahead is the charge delivered AT it; a hold, a dump or a negation after it holds it.
//   Z6 "epi after the next shock" with no question open queues the epinephrine; any refusal of it calls a queued dose off; a hold
//      after the question ("Is epi due? Not yet.") answers it (trailingHold).
//   Z7 the doctor's call in the check's own seconds charges once, for that check (teamCharge); "Rhythm check in N" and "the check
//      is in N" count to the team's check (toCheckSec); "what energy?" is the energy the team charges (standardJoules).
//
// THE PATIENT
//   (a) no pulse, shockable (VF, pVT, torsades), a shock due NOW (readyIn 0): none yet in this arrest, or a check has
//       read the rhythm since the last one
//   (b) no pulse, shockable, mid-cycle: the next shock waits for the rhythm check (readyIn > 0). Its last twelve seconds
//       are the check's own: readyIn is 0 there, and a shock, a charge or a call-out on a charge opens the check (R10).
//   (c) no pulse, not shockable (PEA, asystole)
//   (d) a pulse and a tachyarrhythmia that is cardioverted (SVT, AF, flutter, VT — CARDIOVERTABLE)
//   (e) a pulse and a bradycardia, in a case that paces (pacerHere)
//   (f) a pulse and a bradycardia, no pacer (the newborn, the hypoxic child: NRP and PALS ventilate)
//   (g) a pulse and any other rhythm (sinus tachycardia in trauma, a respiratory arrest)
//   (h) the case has ended with a pulse: ROSC, or 'stable'
// THE MACHINE AND THE ROOM: nothing waiting | an unsynchronized charge waiting | a synchronized charge
// waiting (at a pulse only) | her "synchronized?" open (d only) | her "another epi?" open (no pulse only)
//
// A SHOCK VERB — shock, deliver the shock, defibrillate, hit him again
//   a: a defibrillation, at the energy said, else the charge's, else the ladder's ("again" and more energy: the
//   next rung — R8). b: held for the check, and listed as a shock asked for early (R10, P2: listed, never scored); she
//   promises no charge unless one is waiting — "Shock at the rhythm check in N." (R10, M4). c: the first goes in and is
//   flagged; no second. d: no word for the mode — she asks "synchronized?" and keeps the energy;
//   "defibrillate"/"unsynchronized" — one flagged shock, then held (A12). e f g: one flagged shock, then held.
//   h: held for the pulse (not the arrest's timing).
// ECHOES ARE NOT SECOND SHOCKS (R8, Kim) — never held, never scored, a quiet acknowledgement:
//   (1) the SAME CODE SECOND as a shock delivered or held (the clauses of one line arrive together): any shock
//   word, a charge, a call-out, more energy, an energy — "increase the energy and shock", "charge and shock",
//   "defibrillate … shocking" are one shock. "Shock is in, doctor." (or her held line again). R10 (M6): a shock ORDER
//   within ECHO_TAP_SEC (6 code s — one real second, across a clock tick) after a shock DELIVERED is the same shock too:
//   two taps of the Defibrillate button were a held, scored second shock. At a pulse the same for a synchronized shock
//   (never held otherwise): "increase the energy and cardiovert" after one that failed gave two synchronized shocks in one
//   second. (Two seconds on it is a second order, held for the clock in an arrest — Kim's stacking rule.)
//   (2) the NURSE FIRED a charge (a charge when the shock was due, a call-out or "go ahead" on a charge waiting),
//   and within NURSE_ECHO_SEC (R9: 90 code s, fifteen real seconds — it was 60, and a doctor who waited for her whole
//   line and then said "shock" 66 s on was held and FAILed), the doctor's own "shock", "defibrillate", the room's
//   Defibrillate button, more energy, a charge — any energy: "Already delivered, doctor — back on the chest."
//   Not "again" (a second shock, asked for by name).
//   Both while the ARREST runs — where a second order is held and scored as stacking. At a pulse a synchronized
//   shock is never held (the next step is the doctor's to ask for); after ROSC a shock is held for the pulse,
//   unscored. A shock ORDER followed by another shock order at a later second stays a held early shock (Kim's
//   stacking rule).
// A CHARGE — charge, charge to 200, charge to 200 joules, precharge
//   R10 (P1): pulseless, a charge is delivered at once exactly when readyIn('shock') is 0 — "Charged to 200 joules —
//   everyone clear — shock delivered…", as live shocked on the charge line — called or not, in every rhythm: a doctor who
//   charges when the shock is due is never left waiting for a call-out, and the blind rhythm is kept because the same words
//   do the same thing whatever the strip shows (uncalled, the first into PEA goes in flagged, as "shock" there does). When
//   readyIn is not 0 it is a pre-charge, waiting. (R9's J5 made the uncalled charge fire only in the cycle's "check window",
//   so "charge to 200" at 0:30 in uncalled VF waited for a check that never delivered it — REMOVED.) CALLED not shockable (c):
//   "It's not shockable, doctor — no charge.", nothing arms (a decline by the doctor's own reading of the strip, not a time).
//   d: sync said — waiting, synchronized; unsync said — waiting, unsynchronized; no mode — waiting,
//   and she asks "synchronized?". e f g h: nothing to charge for. A charge is a charge, with or without its unit.
// THE TEAM CHARGES AT A SHOCKABLE CHECK (R8, Kim): a check that finds a CALLED shockable rhythm with the shock
//   due says "Shockable — charging, doctor." and a charge arms at the standard energy for the next shock (the
//   last defibrillation's; a child 2 then 4 J/kg): a call-out, "shock" or the Defibrillate button delivers it,
//   and it expires at the next check. Uncalled, no charge (the blind rule) — she asks what the rhythm is.
// A CALL-OUT — clear, all clear, everybody's clear, I'm clear you're clear everybody's clear, stand clear,
//   shocking, deliver, fire, discharge; R8: hands off, oxygen away, everyone off the bed, stand back, I'm clear
//   With a charge waiting: delivers it when readyIn('shock') is 0 (R10, P1 — called or not). While the shock waits for
//   the check (0 < readyIn < ∞) a call-out is a quiet "Charged — shock at the rhythm check in N." — never held, never
//   scored (R9, J6: R8 held "hands off", "oxygen away" with a pre-charge waiting as early shocks and FAILed rhythmChecks;
//   COACHED says them before the leader has read the strip); "go ahead" the same (R10). When no more electricity will go
//   into this rhythm (∞: a shock has already gone into a PEA) it is held for the rhythm, as "shock" is. With her
//   "synchronized?" open: the synchronized shock (there is a pulse). Otherwise it is a call-out and nothing more — "Nothing is
//   charged, doctor.", or "Shock is in, doctor." just after a shock: never a shock, never a held shock, never
//   scored. So "defibrillate at 200 joules, everybody clear, shocking" is ONE shock however the page splits it.
//   ("Clear, shock" names the shock itself: a shock order when nothing has just gone in.) A CALLED rhythm that is
//   not shockable with a charge still waiting: the call-out dumps it — "It's not shockable, doctor — dumping the
//   charge." (R8).
// YES, DO IT — answers, never delivery words: the most recent open question ("another epi?": the dose;
//   "synchronized?": the synchronized shock). None open, a charge waiting: "Still charged, doctor — call the
//   shock." only when the shock is due (readyIn 0) — mid-cycle "Charged — shock at the rhythm check in N." (R8: she never
//   invites a shock that is not due). GO AHEAD — the same, and with no question open it is a call-out on a charge
//   waiting (R10, P1: delivered at readyIn 0, else the quiet line). R10 (P3): "of course", "absolutely", "right" are yes too;
//   a yes after a yes ("Yes, give it.", "ok, go ahead") is one answer.
//   R8: a line that OPENS with yes/yeah/ok/go ahead while a question is open answers it, and the rest of the line
//   is its own order ("yes, shock" at "another epi?": the epinephrine, then the shock order).
//   R9 (Kim's J1): ...only when nothing after it holds, says no, cancels, puts something first or asks (answerIntent) —
//   "ok, wait", "ok hold on", "yes but not yet" (hold): "Holding, doctor.", the question stays; "ok no", "ok stop", "ok
//   never mind", "ok, cancel that" (decline): as "no"; "yes, sedate him first", "ok, give etomidate first", "yes after
//   sedation", a sedative named (first): "Holding the shock — ready when you are, doctor.", the question stays and the
//   order runs; "okay, what is the pressure?" (question): held. R8 answered all of them with the shock. The engine reads
//   the line whole — the page joins a lone "ok" with the clause after it (CodeEngine.joinAnswers); split, the "ok"
//   alone is a yes, and nothing later in the line can take the shock back. What the code engine does not carry out
//   comes back as `passOn`, for the turn engine ("sedate him").
//   R9 (J8): none open, a lone yes/ok/go ahead is a quiet "Okay, doctor." while the case runs — not "Not understood".
//   R10 (M5): the call-out words ride with the answer — "Yes, synchronized, everybody clear." is the synchronized shock; a
//   lone yes and an energy or a synchronized shock said after it are one answer (joinAnswers), and the words said win —
//   "Yes, synchronized cardioversion at 100 joules." with 120 charged is 100 J; "sure, in a moment" holds; leading
//   punctuation ("ok - no", "yes - wait") is not a word; "ok, wait" with a charge waiting and no question holds it.
//   R10 (M2): at "synchronized?" a yes that is followed by a competing treatment — "ok, adenosine 6 mg", "yes, and give
//   adenosine" — is not a yes: the drug is given, her question closes and the charge is dumped.
// NO — to "synchronized?" (or sync mode's "at what energy?"), R8, Kim: a decline. Nothing is delivered, the
//   question closes, sync is off, any charge is dumped: "Holding — no shock." The rest of the line is its own
//   order ("no, give adenosine first") — R9 (J3): only when it IS an order (a verb, "first", "instead", or said after
//   a pause: "no — adenosine"). "No adenosine", "no amiodarone yet", "no more adenosine", "no bagging", "no, not the
//   adenosine" name what the doctor is refusing: nothing is done (R8 pushed the epinephrine of "no epi"). The same
//   everywhere a drug is named: "let's hold off on the epi", "skip the amiodarone", "don't give epi" (negatedDrug) —
//   "Holding off on that", never given, never held, never scored; at "another epi?" it is her answer.
//   "No", "nope", "no thanks", "not synchronized", "no sync" all decline.
//   Only the words that NAME the unsynchronized shock — "unsynchronized", "unsync", "defibrillate" — give one,
//   flagged. To "another epi?": held.
// HOLD, WAIT, NOT YET — to "synchronized?": "Holding." and the question stays (and restarts). To "another epi?": "Holding
//   the epinephrine for now." and — R10 (M2) — the question stays: the yes after a pause gives it. A charge waiting
//   stays charged.
// HER QUESTIONS CLOSE (R9, Kim's J2; R10, M2). "Synchronized?" lingered: minutes later "ok, adenosine 12 mg" gave a flagged
//   synchronized shock into a stable SVT and the adenosine was refused. But R9's minute (60 code s = ten real seconds) was
//   shorter than typing an answer: a "yes" to "another epi?" got "Okay, doctor." and no epinephrine. So (R10):
//   "ANOTHER EPI?" never closes by time. It closes when epinephrine is given or refused ("no", "hold the epi"), at ROSC or
//   death — and she asks again only after the next dose. A pause ("hold on", "one sec") or another order before the yes
//   does not lose it.
//   (Her "another epi?" and a charge waiting in the arrest: "yes"/"ok" is the epinephrine; the charge still waits for its
//   call-out — as R7 made it.)
//   "SYNCHRONIZED?" and A CHARGE MADE AT A PULSE last QUESTION_SEC and PULSE_CHARGE_SEC (180 code s, thirty real seconds),
//   restarted by the procedure's own steps — sedation, analgesia, consent, the pads, the airway — and by a hold. They close
//   at a competing treatment (a drug that is not sedation or analgesia, a vagal manoeuvre — the doctor has moved on: the
//   charge is dumped, "Dumping the charge, doctor."), at a rhythm change, at ROSC or death. Past its time the machine
//   disarms, as it does: "The charge timed out — dumped." A charge whose mode she asked about is never delivered
//   unsynchronized by default once her question has closed: the next shock word asks again.
// AN ENERGY — 120, one twenty, yes 120, 3 joules, 100 j please, go up to 200, try 200, sync 200 again
//   To "synchronized?": the synchronized shock at that energy. With a charge waiting and no question (R8): the
//   charge again at that energy — "Charging to 300 instead." — with or without its unit. With a unit and nothing
//   waiting: no pulse, a defibrillation; a pulse at a tachycardia, she asks "Synchronized at N joules, doctor?"
//   (R8 — it went in synchronized, out of band and unasked) — unless a synchronized shock has already failed: the
//   mode is settled, and any energy on its own is the next synchronized shock. "Go up to 200", "try 200", "200 again" after a
//   shock: the next shock of the same kind at 200. "200 joules synchronized", "200 J sync" (the mode after the
//   energy, R8): a synchronized shock. Words win: an energy said beats the charge's, "max" is the top of the band
//   (a child: 10 J/kg, never past the adult 200 J — R8). R9 (J8): "same energy", "again at the same energy" repeat
//   the last shock's energy (they climbed); an energy past the device's 360 J is 360 J, and she says so (5000 J went in
//   as 5000); an infant's one-digit energy — "charge to 6", "shock at 6" — is read (it was dropped, and 3 J went in).
// SYNC WORDS — sync, synch, synchronize, synchronized shock at 200, cardiovert
//   d: synchronized ("sync" alone turns sync on and she asks the energy). No pulse: there is nothing to
//   synchronize to — "No pulse — sync won't fire; unsynchronized." and the shock or the charge is unsynchronized,
//   never a synchronized shock into VF. e g h: nothing to cardiovert. R8, out of the synchronized band: BELOW it
//   the shock does nothing ("No change — that energy is too low."); ABOVE it converts. Both flagged, uncredited.
// MORE ENERGY — escalate, increase, go up on, bump the energy or the joules
//   a b: a defibrillation at the NEXT RUNG above this arrest's last one (R8: a child 2 → 4 → 6 → 8 → 10 J/kg,
//   never past 200 J; an adult up the device's ladder 120-150-200-300-360), only once one has been given in this
//   arrest (b: held for the check); before that "No shock has gone in yet — say the energy", in every uncalled
//   rhythm alike (R8). c called: never a shock ("No shock for this rhythm"). d: "Synchronized, doctor — at what
//   energy?"; after a synchronized shock — or "again", "go up", "higher" (R8) — the next synchronized step.
//   e: the pacer. f: "We don't have a pacer on this patient." g: nothing to shock. h: the pacer if one is
//   running, else held for the pulse.
// PACER WORDS — pacer, pacing, mA, output, capture — NEVER a shock
//   A pulse: the pacer where the case paces (torsades after ROSC: overdrive pacing), else "We don't have a pacer
//   on this patient, doctor." No pulse, any rhythm (R8): "Pacing isn't used in an arrest, doctor." The page asks
//   CodeEngine.pacerHere(state, script) — whether pacing would be done now — for its Pacing chip and its Hint.
// THE MACHINE BY NAME (R8, Kim) — get the defibrillator, bring the defib to the bedside, put the patient on the
//   defibrillator, attach the defibrillator, pads on — "Pads on, defibrillator attached." Never a shock.
//   "Shock if VF", "shock if shockable", and "shock at the next check", "shock at the pulse check" (R10, P1 and M4 — one
//   rule for both): a called rhythm that is not shockable, or a pulse — "Not shockable — holding."; readyIn 0 — the shock
//   now, as "shock" (uncalled, whatever the strip: the condition is not read for the doctor); waiting for the check —
//   called shockable, "Shockable — we will charge for the rhythm check in N." (the team does: teamCharge), or with a
//   charge waiting "Charged — shock at the rhythm check in N."; uncalled, "Call it at the rhythm check, doctor." Never held,
//   never scored, and no promise she will not keep (R9's "Will do at the rhythm check if it is VF." was one: at the check she
//   only asked what the rhythm was).
// PLANNED CHECKS (R9, J4; R10, M3) — a pulse or rhythm check said with a time or a plan ("rhythm check in 2 minutes",
//   "pulse check in two", "check in two minutes", "next check at 4:00", "at the end of the cycle", "after two minutes of
//   CPR"), asked about ("when is the next rhythm check?", "is it time for a pulse check?"), or said bare in the same line
//   as a resume-CPR order or a duration ("two minutes of CPR then rhythm check" — the page splits it at "then"):
//   "Rhythm check in N, at the end of the cycle." Never held, never scored, in every pulseless rhythm. (A bare "pulse
//   check" mid-cycle on its own is still held — that one asks for the pause now.)
// THE LEADER'S OWN PAUSE (R10, M3) — "stop CPR, check the rhythm", "hold compressions, check pulse", "pause compressions for
//   a rhythm check" in the check's own seconds IS the check: compressions ran until the leader paused for it, so the check
//   is not counted as one reached with no compressions running.
// PREPARING FOR CARDIOVERSION (R9, J7) — prepare for synchronized cardioversion, get ready to cardiovert, set up for
//   cardioversion, consent for cardioversion, cardiovert after sedation: d — "Pads on, sync on — ready when you are,
//   doctor.", her question open, the energy kept; nothing delivered (it cardioverted at once, unsedated). Elsewhere the
//   pads. ("Ready to cardiovert", "we're ready" are the go-ahead.)
// "POLYMORPHIC VT" names torsades (R9, J8).
// DUMP THE CHARGE, DISARM, CANCEL THE CHARGE, NEVER MIND, CANCEL THAT ORDER — the charge dumped, her question
//   closed ("Nothing is charged, doctor." when there was none).
// DON'T SHOCK, HOLD THE SHOCK, NO SHOCK, DO NOT DEFIBRILLATE — "Holding the shock, doctor.", any charge dumped;
//   never a held shock, never scored.
// THE CHECK dumps a waiting charge by itself when it finds a pulse, or a rhythm the doctor has called that is not
// shockable ("Not shockable — dumping the charge."); an uncalled one keeps it (the blind-rhythm rule). Every
// charge's end is on an event for the page: `chargeEnd` 'delivered', 'dumped' or 'expired'.
//
// THE CALL-OUTS THAT GO WITH THE BUTTON — the whole order made of them. (norm() has made "I'm" "i m", "you're"
// "you re" and "everybody's" "everybody s".) "Go ahead", "yes", "do it" are answers (GO_AHEAD_RE, YES_RE).
const CALLOUT_WORDS_RE = /^(?:(?:i|m|im|am|you|re|youre|are|we|s|is|everybody|everyone|all|stand|stay|step|back|hands|off|of|oxygen|o2|away|the|bed|patient|ok|okay|and|then|now|please|go|ahead|yes|yeah|yep|do|it|clear|shocking|shock|deliver\w*|fire|firing|discharg\w*|from|get|keep)\b\s*)+$/;
// (R8: "hands off", "oxygen away", "everyone off the bed", "stand back" are the same call-out — they said nothing.)
const CALLOUT_KEY_RE = /\b(?:clear|shocking|deliver\w*|fire|firing|discharg\w*)\b|\bhands off\b|\b(?:oxygen|o2) (?:away|off)\b|\boff (?:the )?bed\b|\b(?:stand|step|stay|get|keep) back\b/;
function deliveryCallout(s){ return CALLOUT_WORDS_RE.test(s) && CALLOUT_KEY_RE.test(s); }
// The line without its call-out words (R10, M5): what is left of "yes synchronized everybody clear" is the answer.
const CALLOUT_PHRASE_RE = /\b(?:(?:i|you|we)\s+(?:m|re|am|are)\s+|(?:everybody|everyone|all|stand|stay|step)\s+(?:s\s+|is\s+|are\s+)?)?clear\b|\b(?:shocking|delivering|firing)\b|\bhands off\b|\b(?:oxygen|o2)\s+(?:away|off)\b|\b(?:stand|step|stay|get|keep)\s+back\b|\beveryone off the bed\b/g;
function withoutCallout(s){ return s.replace(CALLOUT_PHRASE_RE, ' ').replace(/\b(?:and|then|now)\b|[.!]/g, ' ').replace(/\s+/g, ' ').trim(); }
// A line that opens with a yes and then holds — "ok wait", "okay, hold on" (answerIntent).
function leadHold(s, raw){ const m = s.match(LEAD_YES_RE); return !!m && answerIntent(m[1], raw) === 'hold'; }
// "Go ahead" on its own: an answer, and with no question open the word that delivers a charge.
const GO_AHEAD_RE = /^(?:(?:um|uh|so|well)\s+)?(?:(?:ok|okay|yes|yeah|alright|all right|sure)\s+)?go ahead(?:\s+(?:please|now))?$/;
// "No" and "wait", on their own — answers to her question (never orders).
const BARE_NO_RE = /^(?:no|nope|no thanks|no thank you)$/;
const HOLD_WORD_RE = /^(?:not yet|hold|hold it|hold off|hold on|wait|wait a (?:sec|second|moment)|not now|one (?:sec|second|moment)|stand by|standby|(?:just )?(?:in )?(?:a|one|just a) (?:sec|second|moment|minute)|in (?:a )?(?:sec|second|moment|minute|bit))$/;
// The seconds after a shock during which a call-out with nothing charged is that shock's own ("Shock is in"): three
// real seconds on the page's clock, long enough for "clear" and then "shocking" typed or said as two orders.
const CALLOUT_ECHO_SEC = 18;
// ...and after a shock the NURSE fired on a charge (R8, Kim), the doctor's own shock order is its echo for fifteen real
// seconds (R9: it was ten — an uncalled pre-charge fired at the check, and the doctor's own "shock" 66 code seconds later
// was held and FAILed rhythmChecks): her spoken line takes longer than three, and a doctor who waits for it and then
// calls the shock was scored for stacking.
const NURSE_ECHO_SEC = 90;
// HER "SYNCHRONIZED?" CLOSES, AND A CHARGE MADE AT A PULSE DISARMS (R9, Kim's J2; R10, M2): 180 code seconds — thirty real
// seconds on the page's clock. R9's minute was sixty CODE seconds, ten real ones: shorter than typing "everybody clear,
// shocking" after her spoken line, so half of typed cardioversions converted nothing ("The charge timed out", "Okay,
// doctor."). The procedure's own steps restart both (sedation, analgesia, consent, the pads, the airway, a hold) — the team
// keeps the machine charged while the patient is made ready. ("Another epi?" has no time limit at all: openQuestion.)
const QUESTION_SEC = 180;
const PULSE_CHARGE_SEC = 180;
// ONE TAP, ONE SHOCK (R10, M6): a shock order this many code seconds after a shock — one real second, across a clock tick —
// is the same shock (the Defibrillate button pressed twice; a line whose clauses straddle a tick).
const ECHO_TAP_SEC = 6;
// The most any defibrillator in the room delivers (R9, J8): "shock 5000 joules" went in as 5000 J.
const DEVICE_MAX_J = 360;
// "No" to her "synchronized?" (R8, Kim) — a decline, and what follows it is its own order: "no, give adenosine
// first". Group 1 is the rest of the line.
const DECLINE_RE = /^(?:no thanks|no thank you|not synchroni[sz]ed|not synch?|no synchroni[sz]ation|no synch?|nope|nah|negative|no)\b[.! ]*(.*)$/;
// A line that OPENS with an answer while a question is open (R8, Kim): "yes, shock" — group 1 is the rest.
const LEAD_YES_RE = /^(?:yes|yeah|yep|yup|ok|okay|sure|go ahead|do it)\.?(?:\s+(?:please|thanks|thank you)\.?)?\s+([^\s.].*)$/;
// Sync said, or unsync said. "Synchronize", "synch", "synchronised" are sync too (round 7: "synchronize and
// shock at 120 joules" went in UNSYNCHRONIZED); "not synchronized", "no sync", "defibrillate" are not.
const NOT_SYNC_RE = /\b(?:no|not|without|don t|dont|do not|never)\s+(?:the\s+)?(?:synchroni[sz]\w*|synch?)\b/;
function wantsSync(s){ return SYNC_WORD_RE.test(s) && !UNSYNC_RE.test(s) && !NOT_SYNC_RE.test(s); }
// ("Defibrillate" is the unsynchronized verb; "the defibrillator", "charge the defib" name the machine.)
const DEFIB_VERB_RE = /\bdefibrillat(?:e|es|ed|ing|ion)\b|(?<!\b(?:the|a|your|our|this) )\bdefib\b(?!\s+(?:pads?|machine|to)\b)/;
function wantsUnsync(s){ return UNSYNC_RE.test(s) || NOT_SYNC_RE.test(s) || DEFIB_VERB_RE.test(stripPads(s)); }
// THE ELECTRICITY IS DUE (R10, P1): readyIn('shock') is 0 — the one truth for a charge, a call-out on a charge waiting and a
// shock order in a pulseless patient, called or not, in every rhythm. (R9 had three: shockDueNow for a called charge,
// checkNow — a "check window" — for an uncalled one, and calloutDue choosing between them; the uncalled charge at 0:30 in VF
// was held for a window that never delivered it. Removed.) `wait`: readyIn's answer, when the caller has it.
function electricityDue(state, script, wait){
  if(state.pulse || state.ended) return false;
  return (wait != null ? wait : readyIn(state, script, 'shock')) === 0;
}
// Seconds to the team's own check — the end of the cycle — for what she says while she keeps a plan for it: "Rhythm check in N",
// "the check is in N", "we feel again at the rhythm check in N". (R12, Z7: they counted to the start of the check's window, 108 s,
// while the team checks and charges at 120 — a call-out made at exactly N met "Nothing is charged, doctor." Round 11 made "we will
// charge … in N" count to the team's check; these now say the same moment. The doctor's own check or shock is allowed from the
// window's start, as readyIn says — "Next shock at the rhythm check in N" and "Not yet — rhythm check in N" keep that time.)
function toCheckSec(state){ return Math.max(0, CYCLE_SEC - state.cycleT); }
// WHAT SHE SAYS WHILE THE NEXT SHOCK WAITS FOR THE CHECK (R10, M4) — never a promise she will not keep. A charge waiting:
// it goes in at the check. Called shockable: the team charges at the check (teamCharge) — "we will charge". Uncalled: she
// cannot charge for a rhythm nobody has read, so she asks for the call.
// (R11: "we will charge … in N" counts to the team's own check — the end of the cycle, where closeCycle charges — not to the
// start of its grace window: a call-out at exactly N met "Nothing is charged, doctor." and the team charged twelve seconds
// later. A charge already waiting goes in from the window's start, as readyIn says.)
function waitForCheckLine(state, wait){
  if(pendingCharge(state)) return 'Charged — shock at the rhythm check in ' + spokenTime(wait) + '.';
  if(heardName(state)) return 'Shockable — we will charge for the rhythm check in ' + spokenTime(toCheckSec(state)) + '.';
  return 'Call it at the rhythm check, doctor.';
}

// ---------- HER QUESTIONS (R9) ----------
// HER QUESTION, IF IT IS STILL OPEN (Kim's J2). "Synchronized?" never closed: minutes after she asked, "ok, adenosine 12 mg"
// gave a flagged synchronized shock into a stable SVT, and the adenosine the doctor had ordered was refused. A question
// closes QUESTION_SEC after she asks it and at a rhythm change (ROSC, death and a lost pulse close it where they happen).
// Returns 'sync', 'epi' or null, and forgets a stale one.
// R10 (M2): "ANOTHER EPI?" HAS NO CLOCK. It was closed a minute (ten real seconds) after she asked, or at any other order, and
// the doctor's "yes" then got "Okay, doctor." and no epinephrine — one dose in thirteen minutes of refractory VF. The dose she
// offered is due until it is given; so her question stays until the epinephrine is given (giveDrug) or refused (actInner), or
// the arrest ends (ROSC, death, a pulse). She asks again only after the next dose. "Synchronized?" keeps its clock
// (QUESTION_SEC) and its rhythm: a tachycardia that has changed is not the one she asked about.
function questionStale(state){
  const q = state.pendingQuestion;
  if(!q || state.ended) return true;
  // (R11: a child or a newborn on compressions for a rate under sixty keeps it — epinephrine is due there too.)
  if(q === 'epi') return !!state.pulse && !(state.cpr && state.hr > 0 && state.hr < 60);
  // (R12, Z2: her offer of another drug — "Shall I give it?" — lasts QUESTION_SEC, and only over the patient she offered it for:
  // the pulse and the rhythm as they were.)
  if(q === 'drug') return !state.questionDrug || (state.questionT != null && state.t - state.questionT > QUESTION_SEC)
    || state.questionPulse !== !!state.pulse || (state.questionRhythm != null && state.questionRhythm !== state.rhythm);
  return (state.questionT != null && state.t - state.questionT > QUESTION_SEC)
    || (state.questionRhythm != null && state.questionRhythm !== state.rhythm)
    || !state.pulse || !CARDIOVERTABLE.has(state.rhythm);
}
function openQuestion(state){
  if(!state.pendingQuestion) return null;
  if(questionStale(state)){ state.pendingQuestion = null; return null; }
  return state.pendingQuestion;
}
// (R11: QUESTION_START_RE, unused since round 10 — questionLine reads questions — is gone.)
// Sedation, analgesia and consent — the cardioversion's own steps, which come before the shock.
const SEDATION_RE = /\b(?:sedat\w*|etomidate|midazolam|versed|propofol|ketamine|ketofol|fentanyl|morphine|hydromorphone|analgesi\w*|pain relief|anxiolysis|consent\w*)\b/;
// WHAT CLOSES HER "SYNCHRONIZED?" (J2; R10, M2): a COMPETING TREATMENT — a drug that is not the procedure's sedation or
// analgesia, or a vagal manoeuvre. The doctor has moved on: "adenosine 12 mg" is not a yes to "synchronized?", and "ok,
// adenosine 6 mg" is the adenosine, not the shock. Everything else leaves it as it was — an answer, a question, the
// defibrillator itself, a line, a lab, a 12-lead (R9 closed it at any of those, and the typed "yes" a moment later got
// "Okay, doctor."). `s` is norm()'d.
const VAGAL_RE = /\b(?:vagal|valsalva|ice to the face|diving reflex|carotid (?:sinus )?massage)\b/;
function competingTreatment(s, raw){
  // (R10, P3: a request — "can I get adenosine?" — is the order, and competes; only a question about the state does not.
  // `raw`, when the caller has the line as said, keeps its question mark for questionLine.)
  if(!s || questionLine(raw != null ? raw : s) || negatedDrug(s) || NEGATED_LEAD_RE.test(s)) return false;
  return (!!findDrug(s) && !SEDATION_RE.test(s)) || VAGAL_RE.test(s);
}
// THE PROCEDURE'S OWN STEPS (R10, M2): sedation, analgesia, consent, the pads, the airway — what the team does to make the
// patient ready for the shock. Each restarts her "synchronized?" and the charge made at a pulse.
const PROCEDURE_STEP_RE = new RegExp(SEDATION_RE.source + '|\\bpads?\\b|\\b(?:airway|oxygen|o2|suction\\w*|bag|bvm|bag[ -]mask|non-?rebreather|nrb|nasal cannula|high[ -]flow|pre-?oxygenat\\w*|preox\\w*|jaw thrust|capnograph\\w*|end[ -]tidal|etco2|intubat\\w*|rsi)\\b');
function keepsQuestion(state, script, q, text){
  // ("Another epi?" is closed only by the epinephrine itself, given or refused, and by the arrest's end.)
  if(q === 'epi') return true;
  // (R12, Z3: the drug she offered, named in the answer — "yes, adenosine 12 mg", "amiodarone 300" — is the answer, not a
  // treatment that competes with it.)
  const own = q === 'adenosine' ? 'adenosine' : q === 'drug' ? state.questionDrug : null;
  if(own && findDrug(norm(text)) === own) return true;
  return !competingTreatment(norm(text), text);
}
// A LEADING YES THAT IS NOT A YES (Kim's J1). R8 answered her question with any line that opened with yes/ok: "ok, wait",
// "ok hold on", "yes but not yet", "ok no", "ok stop", "ok never mind", "yes, sedate him first" and "okay, what is the
// pressure?" each gave the synchronized shock — unsedated, the sedation critical action still credited. The yes answers only
// when nothing after it holds, says no, cancels, puts something first, or asks. answerIntent(what follows the yes):
// 'decline' | 'hold' | 'first' | 'question' | null.
const LEAD_FILLER_SRC = '(?:(?:but|just|and|so|um|uh|er|actually|well|hmm|then|let s|lets|let us|we ll|we will|i ll|i d|maybe|please)\\s+)*';
const ANSWER_DECLINE_RE = new RegExp('^' + LEAD_FILLER_SRC + '(?:no|nope|nah|negative|stop|cancel|never ?mind|nevermind|abort|forget (?:it|that|about it)|scratch that|belay that|don t|dont|do not|hold off|holding off|hold the shock|skip|not synch?|not synchroni\\w*)\\b');
const ANSWER_HOLD_RE = new RegExp('^' + LEAD_FILLER_SRC + '(?:not yet|not now|not just yet|wait|hold on|hold it|hold up|hold|hang on|hang tight|one (?:sec|second|moment|minute)|a (?:sec|second|moment)|give me (?:a|one) (?:sec|second|moment|minute)|in (?:a |one |just a )?(?:sec|second|moment|minute|bit)|stand ?by|standby|pause)\\b\\s*');
// ("<order> then shock" puts the order first; "yes, then shock" and "ok and then shock" are the yes.)
const ANSWER_FIRST_RE = /\b(?:first|before|beforehand|after|once|until|till)\b/;
const THEN_SHOCK_RE = /\S\s+(?:and\s+)?then\s+(?:shock|cardiovert|sync\w*|synch|deliver|go)\b/;
// An order, by its verb — what may follow a "no" or a hold and still be carried out.
const ORDER_VERB_RE = /^(?:(?:but|and|then|so|just|instead|rather|please|we ll|we will|i ll|let s|lets|let us|go ahead and)\s+)*(?:give|giving|push|start|run|hang|use|try|get|draw up|load|bolus|administer|repeat|call|page|place|put|prepare|set up|sedate|intubate|bag|ventilate|begin|continue|resume|increase|titrate|obtain|order|send|consult|do|check|recheck)\b|\b(?:first|instead)$/;
// `q` (R10, P3): her open question. What comes FIRST is the cardioversion's business — sedation, analgesia, consent, the pads,
// the airway (R10: "ok, pads on" at "synchronized?" was the shock, then the pads) — and only while nothing in the rest says to
// go ahead ("yes, he's sedated, go ahead", a call-out; "ok, he is asleep" is done, not to do). To "another epi?" a sedation named after
// the yes is its own order ("yes, and etomidate 20 mg": the epinephrine, then the etomidate) — R9 held the epinephrine.
const SEDATION_DONE_RE = /\b(?:he|she|they|patient|pt)\s+(?:s|is|are|has been|have been)\s+(?:(?:now|well|adequately|fully|already)\s+)?(?:sedated|asleep|out|comfortable)\b/;
function answerIntent(rest, raw, q){
  // (R10, M5: punctuation that is not a word — "ok - no", "yes - wait", "ok... wait" — is not what follows the yes.)
  const r = String(rest || '').replace(/^[\s,.;:!?—–-]+/, '').trim();
  if(!r) return null;
  if(/\bnot yet\b|\byet$/.test(r) && !new RegExp('^' + LEAD_FILLER_SRC + '(?:no|nope|nah|negative)\\b').test(r)) return 'hold';
  // (R10, M5: "ok, hold the epi", "yes, let's hold the epi" — a drug named to be refused is a no.)
  if(ANSWER_DECLINE_RE.test(r) || negatedDrug(r)) return 'decline';
  if(ANSWER_HOLD_RE.test(r)) return 'hold';
  const goes = /\bgo ahead\b|\bdo it\b/.test(r) || CALLOUT_KEY_RE.test(r) || SEDATION_DONE_RE.test(r);
  if(ANSWER_FIRST_RE.test(r) || THEN_SHOCK_RE.test(r.replace(new RegExp('^' + LEAD_FILLER_SRC), ''))
     || (q !== 'epi' && !goes && (SEDATION_RE.test(r) || PROCEDURE_STEP_RE.test(r) || cardiovertPrep(r)))) return 'first';
  // (R10, P3 — questionLine: only a question about the state is a question. "Ok, can I get the epi?" at "another epi?" is a
  // request, the epinephrine; "okay, what is the pressure?" asks. The question mark decides nothing.)
  if(questionLine(r)) return 'question';
  return null;
}
// The order a "first" names: "sedate him first", "first give etomidate", "give fentanyl then shock", "let's give fentanyl"
// — or nothing, when what comes first is a condition ("after sedation", "once he is asleep").
function firstOrder(rest){
  const r = String(rest || '').replace(new RegExp('^' + LEAD_FILLER_SRC), '').trim();
  let m;
  if((m = r.match(/^first\s+(.+)$/))) return m[1];
  if((m = r.match(/^(.+?)\s+(?:and\s+)?then\s+(?:shock|cardiovert|sync\w*|synch|deliver|go)\b.*$/))) return m[1].replace(/\s+(?:first|beforehand)$/, '');
  if((m = r.match(/^(.+?)\s+(?:first|beforehand)$/))) return m[1];
  if(/^(?:after|once|until|till|when|before|following)\b/.test(r)) return '';
  if(cardiovertPrep(r) || SEDATION_RE.test(r) || ORDER_VERB_RE.test(r)) return r.replace(/\s+(?:first|beforehand)\b.*$/, '');
  return '';
}
// What follows a hold, if it is an order: "hold on, sedate him first" → "sedate him".
function afterHold(rest){
  const r = String(rest || '').replace(ANSWER_HOLD_RE, '').trim();
  return r ? firstOrder(r) || (ORDER_VERB_RE.test(r) ? r : '') : '';
}
// WHAT FOLLOWS A "NO" (Kim's J3): its own order only when it IS one — a verb, "first", "instead", or said after a pause
// ("no — adenosine"). "No adenosine", "no amiodarone yet", "no more adenosine", "no bagging", "no, not the adenosine" name
// what the doctor is saying no TO: R8 ran them as orders, and "no epi" at her "synchronized?" pushed epinephrine into a
// tachycardia with a pulse, "no bagging" started the bag-mask. `punctuated`: a pause after the "no" in the words as said.
const NEGATED_LEAD_RE = new RegExp('^' + LEAD_FILLER_SRC + '(?:no|not|nope|none|nothing|never|without|skip|skipping|hold off|holding off|avoid|withhold\\w*|forget|cancel|stop|don t|dont|do not)\\b');
function orderAfterNo(rest, punctuated){
  const r = String(rest || '').trim();
  if(!r || NEGATED_LEAD_RE.test(r) || ANSWER_HOLD_RE.test(r)) return '';
  return punctuated || ORDER_VERB_RE.test(r) ? r : '';
}
// A DRUG NAMED TO BE REFUSED (J3), wherever it is said — "let's hold off on the epi", "skip the amiodarone", "don't give
// epi", "no more adenosine", "without epi". At "another epi?" "ok, let's hold off on the epi" gave the epinephrine, then held
// "hold off on epinephrine" as an early dose and FAILed drugTiming. Never given, never held. The drug, or null.
const DRUG_ALIAS_OF = (() => { const m = {}; for(const [name, words] of Object.entries(DRUG_ALIASES)) for(const w of words) m[w] = name; return m; })();
// (R10, M5: "let's hold the epi", "hold the epinephrine for now" — "hold" with the drug named after it; not "hold on, give
// epi", a pause and then the order.)
// (R11: and "hold epinephrine" — the page's split drops the "the" of "hold the epi", and at "another epi?" it was given.)
const NEGATED_DRUG_RE = new RegExp('\\b(?:no|not|don t|dont|do not|never|without|skip|skipping|hold off(?: on)?|holding off(?: on)?|hold(?:ing)?(?=\\s+(?:the|that|any|all|further|more|another|' + Object.keys(DRUG_ALIAS_OF).sort((a, b) => b.length - a.length).join('|') + ')\\b)|withhold\\w*|avoid|defer|forget(?: about)?|cancel|no more|no further)'
  + '(?:\\s+(?:the|any|more|further|another|giving|give|on|that|with|a|an|second|next|extra|additional|repeat|dose|doses|of|yet))*\\s+('
  + Object.keys(DRUG_ALIAS_OF).sort((a, b) => b.length - a.length).join('|') + ')\\b');
function negatedDrug(s){ const m = String(s || '').match(NEGATED_DRUG_RE); return m ? DRUG_ALIAS_OF[m[1]] : null; }
// PREPARING FOR CARDIOVERSION IS NOT THE CARDIOVERSION (Kim's J7). "Prepare for synchronized cardioversion", "get ready to
// cardiovert", "set up for cardioversion", "consent for cardioversion", "cardiovert him after sedation" each delivered it at
// once, unsedated. ("Ready to cardiovert", "we're ready for cardioversion" are the go-ahead, and are not this.)
const CV_WORD_RE = /\bcardiover\w*|\b(?:synchroni[sz]\w*|synch?)\s+(?:shock|cardioversion)\b/;
const CV_PREP_RE = /\b(?:prepare|preparing|prep|prepping|get ready|getting ready|be ready|set up|setting up|setup|stand by|standby|consent\w*)\b|\b(?:after|once|when|following)\s+(?:\w+\s+){0,3}?(?:sedat\w*|etomidate|midazolam|versed|propofol|ketamine|ketofol|fentanyl|analgesi\w*|asleep|consent\w*)\b/;
function cardiovertPrep(s){ return CV_WORD_RE.test(s) && CV_PREP_RE.test(s); }
// FOR THE PAGE (J1): a line splits into clauses at its commas, and a lone "ok" then reaches the engine alone — a yes — before
// the "wait" after it. While a question is open, a lone yes/ok followed by a clause that holds, says no, cancels, puts
// something first or asks is ONE answer: joinAnswers(state, ['ok', 'wait', 'etomidate 20 mg']) → ['ok, wait', 'etomidate 20
// mg']. The engine's own rule (answerIntent), so the page and the nurse cannot disagree; the state is only read.
// A dose, or the push of one, as an answer to her drug question says it (doseAnswerOrder reads it whole).
const DOSE_SHAPE_RE = /^(?:give|push|pushing|go with)\b|\d\s*(?:mg|mgs|milligrams?|mcg|micrograms?|ug|g|gm|grams?|ml|mls|cc|meq)\b|\d\s*(?:\/|per)\s*k(?:g|ilo)/;
// R12 (Z5): and with NO question open, at a shock that is due with a charge waiting — where a lone "ok" is the go-ahead that
// delivers it — a lone yes followed by what holds it ("wait", "actually wait", "no"), calls it off ("dump the charge", "we're not
// shocking") or names the energy ("shock at 360", "go up to 360", "300 joules", "increase the energy") is ONE line: split, the
// "ok" delivered the 200 charged before the rest was read. (R12, Z3: and to her question about a drug, a yes followed by the dose
// or a push — "yes, 12 mg", "yep, push" — is one answer.)
function joinAnswers(state, clauses){
  const list = [].concat(clauses || []);
  const q0 = state && state.pendingQuestion;
  const q = q0 && !questionStale(state) ? q0 : null;
  const c = !q && state && !state.pulse && !state.ended ? pendingCharge(state) : null;
  const goNow = !!c && !c.sync && dueIn(state, {}, 'shock') === 0;
  if(!q && !goNow) return list;
  const qDrug = q === 'epi' ? 'epinephrine' : q === 'adenosine' ? 'adenosine' : q === 'drug' ? state.questionDrug : null;
  const out = [];
  for(let i = 0; i < list.length; i++){
    const a = norm(list[i]), next = list[i + 1];
    const nn = next != null ? norm(next).replace(/^[\s.\-]+|[\s.!]+$/g, '') : '';
    // (...and, to "another epi?", the epinephrine order after the yes — "yes, and give epi" is ONE dose: split, the "give
    // epi" after the yes was held as an early dose and FAILed drugTiming.)
    // (R10, M5: to "synchronized?", the energy or the synchronized shock said after the yes — "Yes, synchronized cardioversion
    // at 100 joules." with 120 charged: split, the lone "yes" delivered the 120 and the doctor's 100 was an echo. Joined, the
    // words said win.)
    // (R10: and a yes after the yes — "Yes, give it.", "ok, go ahead" — is one answer: split, the second yes met a question
    // already answered, and a charge waiting heard "call the shock".)
    const jn = spokenJoules(nn);
    if(next != null && goNow && (YES_RE.test(a) || GO_AHEAD_RE.test(a))
       && (['hold', 'decline', 'question'].includes(answerIntent(nn, String(next), null)) || DISARM_RE.test(nn) || GENERIC_CANCEL_RE.test(nn) || negatedElectricity(next) || ESCALATE_RE.test(jn)
         || energyOnly(jn, {}) != null || energyStep(jn, {}) != null || ((asksForShock(jn) || CHARGE_RE.test(jn)) && shockEnergy(jn, {}) != null))){
      out.push(String(list[i]).trim().replace(/[\s,.;:!]+$/, '') + ', ' + String(next).trim());
      i++; continue;
    }
    if(!q){ out.push(list[i]); continue; }
    if(next != null && (YES_RE.test(a) || GO_AHEAD_RE.test(a))
       && (answerIntent(nn, String(next), q) || YES_RE.test(nn) || GO_AHEAD_RE.test(nn) || (q === 'epi' && /\b(?:epi\w*|adrenalin\w*)\b/.test(nn))
         || (qDrug && (findDrug(nn) === qDrug || (DOSE_SHAPE_RE.test(nn) && !findDrug(nn))))
         || (q === 'adenosine' && (/\badenosine\b/.test(nn) || ADENO_YES_RE.test(nn)))
         || (q === 'sync' && (DEFIB_TALK_RE.test(nn) || /^(?:at\s+)?\d+(?:\.\d+)?(?:\s+please)?$/.test(spokenJoules(nn)) || competingTreatment(nn, String(next)))))){
      // (R10, M2: and a competing treatment — "ok, adenosine 6 mg": joined, the line is the drug, not the yes.)
      out.push(String(list[i]).trim().replace(/[\s,.;:!]+$/, '') + ', ' + String(next).trim());
      i++; continue;
    }
    out.push(list[i]);
  }
  return out;
}
// AN ENERGY PAST THE MACHINE (R9, J8) — "shock 5000 joules", "charge to 1000", "400 joules" — is the machine's maximum:
// { from, text } with the energy rewritten to 360, or null.
function clampEnergy(text){
  const s = norm(text);
  if(!s || findDrug(s) || !(DEFIB_TALK_RE.test(s) || /^(?:(?:yes|ok|okay|use|at|to|try)\s+)?\d+(?:\.\d+)?\s*(?:j|joules?)?(?:\s+please)?$/.test(s))) return null;
  const m = s.match(/(?<![\d.])(\d{3,6})(?:\.\d+)?(?=\s*(?:j|joules?)\b)/) || s.match(/\b(?:shock|charge|charging|defibrillate|defib|sync|synch|synchroni[sz]\w*|cardiover\w*|energy|at|to)(?:\s+\w+){0,2}?\s+(\d{3,6})\b(?!\s*(?:mg|mcg|ml|cc|kg|%|units?|mmhg|bpm|times))/)
    || s.match(/^(?:(?:yes|ok|okay|use|try)\s+)?(\d{3,6})(?:\s+please)?$/);
  const n = m ? parseFloat(m[1]) : NaN;
  if(!(n > DEVICE_MAX_J)) return null;
  return { from: n, text: s.replace(new RegExp('(?<![\\d.])' + m[1] + '(?:\\.\\d+)?(?![\\d])'), String(DEVICE_MAX_J)) };
}
// WHAT SHE DOES WITH A LEADING YES THAT IS NOT ONE (J1). `q`: her open question, 'sync' or 'epi'; `rest`: the words after
// the yes. Nothing is given for the yes. A decline is "no" (the charge dumped, the question closed); a hold or a "first"
// keeps her "synchronized?" open another minute — the doctor is saying "not yet", not "no"; a question is the turn
// engine's to answer. The order that rides with it (a verb after the "no" or the hold, the thing that comes "first") runs;
// what the code engine does not carry out comes back as `passOn`, for the turn engine ("sedate him").
// A PLANNED CHECK IS A PLAN (R9, Kim's J4). "Resume CPR, rhythm check in 2 minutes", "rhythm check at the end of the
// cycle", "pulse check at the next cycle", "when is the next rhythm check?" were held as pulse checks asked for mid-cycle
// and FAILed rhythmChecks — 70 of 70 cells. A check said with a time or a plan, or asked about, is the team's own plan:
// "Rhythm check in N, at the end of the cycle." — the same in every pulseless rhythm. (A bare "pulse check" mid-cycle still
// asks for the pause now, and is held.) Compressions the line orders are started, as the CPR branch would.
// (R10, M3: "next check at 4:00", "check in two minutes" — the check said bare, with its time.)
const CHECK_WORDS_RE = /\b(?:pulse|rhythm)\s+checks?\b|\bcheck\s+(?:for\s+)?(?:the\s+|a\s+)?(?:pulse|rhythm)\b|\b(?:re-?assess|re-?evaluate|reevaluate|analy[sz]e)\s+(?:the\s+)?rhythm\b|\bnext\s+check\b|^(?:(?:ok|okay|and|then|so)\s+)*check\s+(?:again\s+)?(?:in|at)\b/;
const CHECK_PLAN_RE = new RegExp('\\b(?:in|at|after|every)\\s+(?:about\\s+|another\\s+|the\\s+next\\s+|a\\s+further\\s+)?(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|a|a couple of)\\s*(?:more\\s+)?(?:minutes?|mins?|m|seconds?|secs?|s)\\b'
  + '|\\b(?:end|close)\\s+of\\s+(?:the\\s+|this\\s+)?(?:cycle|round|two minutes)\\b|\\bat\\s+the\\s+end\\b|\\bnext\\s+(?:cycle|round|rhythm\\s+check|pulse\\s+check|check)\\b|\\bat\\s+the\\s+next\\b'
  + '|\\b(?:after|following)\\s+(?:the\\s+|this\\s+|another\\s+|a\\s+)?(?:(?:two|2)\\s+(?:minutes?|mins?)\\s+of\\s+)?(?:cycle|round|cpr|compressions)\\b'
  + '|\\bat\\s+(?:the\\s+)?(?:two|2)[- ]minutes?(?:\\s+mark)?\\b|\\bq\\s?2\\s?min\\w*\\b|\\bevery\\s+(?:two|2)\\b|\\bon\\s+the\\s+(?:two|2)[- ]minute\\b'
  // (R10, M3: a bare number — "pulse check in two", "rhythm check in 2" — and a clock time, "next check at 4:00".)
  + '|\\b(?:in|at)\\s+(?:about\\s+|another\\s+)?(?:one|two|three|four|five|a couple|[1-5])\\b(?!\\s*(?:mg|mcg|ml|j|joules?|kg|percent)\\b)|\\bat\\s+\\d{1,2}\\s+\\d{2}\\b');
// (R10, M3: "is it time for a pulse check?" asks about the plan.)
const CHECK_ASK_RE = /^(?:when|how long|how much (?:longer|time)|what time|how soon|how many (?:seconds|minutes))\b|\buntil\s+(?:the\s+)?(?:next\s+)?(?:pulse|rhythm)\s+check\b|^(?:(?:ok|okay|so)\s+)?(?:is it|is this|are we) (?:time|due|ready) (?:for|to)\b/;
// A bare check — "rhythm check", "then pulse check", "check the rhythm" — in the same code second as a resume-CPR order or a
// duration (act: planCueT) is the planned one: "two minutes of CPR then rhythm check" reaches here split at "then".
const BARE_CHECK_RE = /^(?:(?:and|then|ok|okay|so|a|the)\s+)*(?:(?:pulse|rhythm)\s+check|check\s+(?:for\s+)?(?:the\s+|a\s+)?(?:pulse|rhythm))(?:\s+(?:again|please))?$/;
function plannedCheck(state, script, s){
  if(state.pulse || state.ended || isNeonate(script) || !CHECK_WORDS_RE.test(s)) return null;
  // (Not in the check's own last seconds — there the check is the check.)
  const bare = s.replace(/[.\s]+$/, '');
  const cued = BARE_CHECK_RE.test(bare) && state.cycleT < DUE && (state.planCueT === state.t || (/^then\b/.test(bare) && state.cprCueT === state.t));
  if(!(CHECK_PLAN_RE.test(s) || CHECK_ASK_RE.test(s) || cued)) return null;
  const out = [];
  if(!state.cpr && /\b(?:start|resume|continue|begin)\b.*\b(?:cpr|compressions)\b|\bcpr\b|\bcompressions\b/.test(s) && !/\b(?:stop|hold|pause)\b/.test(s)){
    state.cpr = true;
    out.push(ev(state, 'cpr', 'Compressions running — hard and fast, full recoil.', { on: true }));
  }
  const n = toCheckSec(state);
  out.push(ev(state, 'note', n >= 6 ? 'Rhythm check in ' + spokenTime(n) + ', at the end of the cycle.' : 'Rhythm check now, at the end of the cycle.', { ack: 'hold', planned: true }));
  return out;
}
// A lone yes with nothing asked and nothing charged (R9, Kim's J8): heard, quietly — never "Not understood".
function quietOk(state){ return { handled: true, events: [ev(state, 'note', 'Okay, doctor.', { ack: 'ok', quiet: true })] }; }
// A HOLD AT "SYNCHRONIZED?" (R10, M2): the doctor is saying "not yet", not "no" — her question starts again, and so does the
// charge made at the pulse (the team keeps it charged while the patient is made ready).
function holdTheShock(state){
  state.questionT = state.t;
  const c = pendingCharge(state);
  if(c && c.pulse) c.t = state.t;
}
function notYet(state, script, q, intent, rest, now){
  if(intent === 'question') return { handled: false };
  const out = [];
  let order = '';
  if(intent === 'decline'){
    if(q === 'sync'){
      const had = !!pendingCharge(state);
      state.pendingQuestion = null; state.syncMode = false; state.charged = null;
      out.push(ev(state, 'note', 'Holding — no shock.', Object.assign({ ack: 'hold', declined: true }, had ? { disarmed: true, chargeEnd: 'dumped' } : {})));
    } else {
      state.pendingQuestion = null;
      out.push(ev(state, 'note', 'Holding the epinephrine for now.', { ack: 'hold' }));
    }
    order = orderAfterNo(rest.replace(ANSWER_DECLINE_RE, ''), false);
  } else if(q === 'sync'){
    holdTheShock(state);
    out.push(ev(state, 'note', intent === 'first' ? 'Holding the shock — ready when you are, doctor.' : 'Holding, doctor.', { ack: 'hold' }));
    order = intent === 'first' ? firstOrder(rest) : afterHold(rest);
  } else {
    // (To "another epi?" a hold or "X first" keeps her question — R10, M2: the "yes" after the pause gives the dose; R9 closed
    // it, and the "ok" a moment later got "Okay, doctor." and nothing.)
    out.push(ev(state, 'note', 'Holding the epinephrine for now.', { ack: 'hold' }));
    order = intent === 'first' ? firstOrder(rest) : afterHold(rest);
  }
  const res = { handled: true, events: out };
  if(order){
    const r = actInner(state, script, order, now);
    if(r && r.handled) out.push(...(r.events || []));
    else res.passOn = order;
  }
  return res;
}
// The case paces: a conversion row or a credit for pacing, or a pacer already running. The newborn and the
// hypoxic child have none — NRP and PALS ventilate a bradycardia there, and "capture at 70" with the monitor
// still at 48 taught nothing true.
function casePaces(state, script){
  return !!state.flags.pacing || !!(script.credits && script.credits.pacing != null)
    || (script.convert || []).some(r => r.action === 'pacing');
}
// WOULD THE TEAM PACE NOW? (R8, for the page's Pacing chip and its Hint.) A case that paces, and a pulse: pacing is
// for a bradycardia, or — the torsades case — overdrive pacing for runs that recur WITH a pulse. With no pulse it is
// refused in every rhythm ("Pacing isn't used in an arrest"), and the Hint offered pulseless torsades a Pacing chip
// the nurse then refused.
function pacerHere(state, script){
  return !!state && !!script && !!state.pulse && state.ended !== 'death' && casePaces(state, script);
}
// ECHOES ARE NOT SECOND SHOCKS (R8, Kim) — the table's rule, for an order `s` as said. Returns what she says
// ({ text }), or null when the order is not an echo.
//   (1) The same code second as a shock delivered or held: the clauses of one line arrive together, so "increase
//   the energy and shock" went in at 360 and then held its "shock" as a stacked shock (FAIL rhythmChecks); so did
//   "charge and shock", "go up to 300 and shock". One line, one shock.
//   (2) A shock the NURSE fired on a charge (a charge when the shock was due; a call-out or "go ahead" on a charge
//   waiting): the doctor's own shock order in the next ten real seconds, at any energy — "shock", "defibrillate",
//   the room's Defibrillate button (it always says 120 J), more energy — is the doctor catching up with her, never
//   a second shock. So is a charge: "charge to 200, everybody clear, shock" said just after she fired is the line
//   she has already carried out (nobody pre-charges for a check two minutes off), and its "clear" then delivered a
//   fresh pre-charge, held and scored as stacking. Not "again" (a second shock, asked for by name), not a call-out
//   (the call-out rule answers those, below).
function shockWords(s, script){
  return asksForShock(s) || (CHARGE_RE.test(s) && !NOT_CHARGE_RE.test(s)) || deliveryCallout(s) || ESCALATE_RE.test(s)
    || energyAnswer(s, script) != null || /\bcardiover/.test(s) || (SYNC_WORD_RE.test(s) && /\d/.test(s));
}
// The page's view (R8): what the nurse would answer this order with if it is an echo — { text } — else null. The
// room's Defibrillate button reads it: pressed in the ten seconds after the nurse fired a charge, it is her quiet
// "Already delivered", not a held shock (its readyIn still says the next shock is not due).
function echoOf(state, script, text){ return state && script ? shockEcho(state, script, spokenJoules(norm(text))) : null; }
function shockEcho(state, script, s){
  // (While the arrest runs: that is where a second order is held and scored as stacking. At a pulse a synchronized
  // shock is never held; after ROSC a shock is held for the pulse, unscored — and there the clock stands still
  // between orders unless the page moves it, so "the same second" would swallow every later order.)
  if(state.ended || !shockWords(s, script)) return null;
  const last = state.shocks[state.shocks.length - 1];
  // (R10, M6: a shock ORDER one real second after the shock — the Defibrillate button tapped twice across a clock tick — is
  // the same shock. Not "again": a second shock asked for by name. A charge or a call-out a second later keeps its own rule.)
  const tap = last && state.t - last.t <= ECHO_TAP_SEC && (last.t === state.t || (asksForShock(s) && !/\bagain\b/.test(s)));
  // AT A PULSE (R10, M6): a synchronized shock is never held — the next step is the doctor's to ask for — so a second in the
  // same breath went in: "increase the energy and cardiovert" after one that did not convert gave two synchronized shocks in
  // one second. The shock words of that line, or that tap, are the synchronized shock just given.
  if(state.pulse) return tap && last.sync && (last.t === state.t || asksForShock(s) || /\bcardiover/.test(s) || wantsSync(s)) ? { text: 'Shock is in, doctor.' } : null;
  // (A defibrillation of THIS arrest: a synchronized shock that took the pulse away in the same second was the
  // perfusing patient's, and the first shock of the arrest it started is its own.)
  const ours = tap && last.episode != null && last.episode === state.episode;
  if(ours && last.t === state.t) return { text: 'Shock is in, doctor.' };
  for(let i = state.events.length - 1; i >= 0 && state.events[i].t === state.t; i--){
    const e = state.events[i];
    if(e.kind === 'withheld' && e.held === 'shock') return { text: e.say || e.text };
  }
  const c = state.chargeShot;
  if(c && c.nurse && state.shocks.length === c.n && state.t - c.t <= NURSE_ECHO_SEC
     && !/\bagain\b/.test(s) && !deliveryCallout(s))
    return { text: 'Already delivered, doctor — back on the chest.' };
  if(ours) return { text: 'Shock is in, doctor.' };
  return null;
}
// The shock that just went in, if one did (for what a call-out with nothing charged is answered with): three real
// seconds — ten after a shock the nurse fired on a charge (R8).
function shockJustIn(state){
  const last = state.shocks[state.shocks.length - 1], c = state.chargeShot;
  return !!last && state.t - last.t <= (c && c.nurse && c.n === state.shocks.length ? NURSE_ECHO_SEC : CALLOUT_ECHO_SEC);
}
// THE NEXT RUNG (R8, Kim): "increase the energy", "more energy", "hit him again" in an arrest is the next step
// above this arrest's last defibrillation — never the ladder's first energy again. The child's went back to 2 J/kg
// (48 J) after a 96 J shock: a decrease, unflagged. PALS 2 → 4 → up to 10 J/kg, never past the adult dose (200 J);
// an adult up the biphasic device's ladder to 360 (Zoll 120-150-200, Lifepak 200-300-360).
const DEFIB_LADDER = [120, 150, 200, 300, 360];
// `above` (optional): an energy already set (a charge waiting) — the rung above that too.
function nextDefibJoules(state, script, above){
  const e = (script.shock && script.shock.energy) || {};
  const d = episodeDefibs(state), last = d[d.length - 1];
  if(!last) return defaultJoules(script);
  const from = Math.max(last.joules, above || 0);
  if(e.perKg){
    const kg = weightOf(script), cap = childMaxJoules(script);
    for(let x = e.perKg[0]; x <= e.perKg[1] + 1e-9; x += e.perKg[0]){ const j = roundJoules(Math.min(x * kg, cap)); if(j > from + 0.5) return j; }
    return roundJoules(cap);
  }
  const band = e.adult || [120, 360], hi = band[band.length - 1];
  const next = DEFIB_LADDER.find(j => j > from && j >= band[0]);
  return next != null ? Math.min(next, hi) : hi;
}
// A child's most: 10 J/kg (the band's top), never past the adult dose (R8, Kim: 200 J).
function childMaxJoules(script){
  const e = (script.shock && script.shock.energy) || {};
  return e.perKg ? Math.min(e.perKg[1] * weightOf(script), 200) : 360;
}
// THE STANDARD ENERGY FOR THE NEXT SHOCK — what the team charges to at a shockable check (R8, teamCharge): an adult,
// the last defibrillation's own energy (the doctor escalates by saying so), 200 J before any; a child, PALS 2 J/kg
// for the first and 4 J/kg after (never below the last, never past the child's most).
function standardJoules(state, script){
  const e = (script.shock && script.shock.energy) || {};
  const d = episodeDefibs(state), last = d[d.length - 1];
  if(e.perKg){
    const kg = weightOf(script);
    return roundJoules(Math.min(Math.max((d.length ? 2 : 1) * e.perKg[0] * kg, last && last.ok ? last.joules : 0), childMaxJoules(script)));
  }
  if(last && last.ok) return last.joules;
  const band = e.adult || [120, 360];
  return Math.min(Math.max(200, band[0]), band[band.length - 1]);
}
// THE TEAM CHARGES AT A SHOCKABLE CHECK (R8, Kim). Her line was "Shockable — charge.", and doctors answered it the
// way it is answered at a real bedside — "clear", "everybody clear, shocking" — and nothing was delivered: nothing
// was charged. So at a check that finds a CALLED shockable rhythm with the shock due, the team charges ("Shockable —
// charging, doctor.") at the standard energy for the next shock; a call-out, "shock" or the Defibrillate button
// delivers it, and it expires at the next check (`auto`, pendingCharge). Uncalled, nothing: the charge would read the
// strip for the doctor. `e`: the check event, which carries the charge for the page. True when it charged.
function teamCharge(state, script, e, final){
  if(final || state.pulse || state.ended || isNeonate(script) || !SHOCKABLE.has(state.rhythm) || !heardName(state)
     || readyIn(state, script, 'shock') || pendingCharge(state)) return false;
  const J = standardJoules(state, script);
  armCharge(state, J, false);
  state.charged.auto = true;
  // (R12, Z7: made in the check's own last seconds — the doctor's call there — the charge is FOR the check about to close the
  // cycle, and it lasts through it. It was counted as the check before's, went stale at this one, and the check charged again:
  // "Shockable — charging, doctor." twice and two charges on the Code Record for one shock.)
  if(!final && state.cycleT >= DUE) state.charged.check = state.checksDone + 1;
  if(e){ e.charge = J; e.autoCharge = true; }
  return true;
}
// THE MACHINE BY NAME IS NOT A SHOCK (R8, Kim). "Get the defibrillator", "bring the defib to the bedside", "put the
// patient on the defibrillator" reached the shock branch on the word "defibrillator" — 360 J into complete heart
// block, 7 J into an apnoeic newborn, on both engines. An order that only fetches, attaches or switches on the
// machine (or its pads) places the pads; "defib" on its own, and every word that delivers, charges, synchronizes or
// names an energy, are still what they say.
const MACHINE_NOUN_RE = /\b(?:defibrillator|defib|aed|pads?|zoll|lifepak|crash cart)\b/;
const MACHINE_VERB_RE = /\b(?:get|grab|bring|fetch|wheel|roll|put|attach\w*|connect\w*|hook\w*|plac\w*|apply|applied|stick|set up|turn on|switch on|power on|on)\b|\bpads?\b/;
const MACHINE_FILLER_RE = /\b(?:get|getting|grab|bring|fetch|wheel|roll|put|attach\w*|connect\w*|hook\w*|up|plac\w*|apply|applied|stick|set|turn|switch|power|on|onto|in|into|over|to|the|a|an|our|your|this|that|him|her|them|patient|baby|child|bedside|room|here|now|please|and|ready|have|me|us|lets|let s|can|could|you|we|i|need|want|go|somebody|someone|chest|anterior|lateral|posterior|anterolateral|anteroposterior|ap|al|position|positioned|of|some|set of|is|are|at|standby|standing|by|available|crash|cart|machine|monitor|defibrillator|defib|aed|pads?|zoll|lifepak|mode|manual|leads?|and the)\b/g;
function namesMachine(s){
  const t = stripPads(s);
  if(!MACHINE_NOUN_RE.test(t) || !MACHINE_VERB_RE.test(t)) return false;
  if(DELIVER_RE.test(t) || CHARGE_RE.test(t) || /\d/.test(t) || SYNC_WORD_RE.test(t) || UNSYNC_RE.test(t) || CALLOUT_KEY_RE.test(t)
     || ESCALATE_RE.test(t) || /\bdefibrillat(?:e|es|ed|ing|ion)\b/.test(t)) return false;
  return !t.replace(MACHINE_FILLER_RE, ' ').trim();
}
// "Shock at the next check", "shock at the rhythm check" — a time, not a shock now (R8): mid-cycle she keeps it for
// the check, in every rhythm alike ("yes please, shock at the next check" was held and scored as a stacked shock).
const SHOCK_AT_CHECK_RE = /\b(?:at|on|for|with)\s+(?:the\s+)?(?:next\s+)?(?:rhythm\s+|pulse\s+)?check\b|\bnext\s+(?:rhythm\s+|pulse\s+)?check\b|\bat\s+(?:the\s+)?(?:two|2)[- ]minutes?(?:\s+mark)?\b/;
// "Shock if VF", "shock if it's shockable", "defibrillate if still in VF" — a condition, not a shock (R8, Kim).
// (R10: the condition said on its own — "if VF", "if it's still shockable" — the clause before the shock in the same line.)
const IF_SHOCKABLE_RE = /^if\s+(?:(?:it|its|it s|it is|he s|she s|he is|she is|they re|they are|there s|there is|we re|we are|we have|still|in|a|still in)\s+){0,3}(?:v\s?fib|vfib|vf|ventricular fibrillation|pulseless vt|pulseless v\s?tach|vt|v\s?tach|torsades?|shockable(?:\s+rhythm)?)[.\s]*$/;
const SHOCK_IF_RE = /\b(?:shock|defibrillate|defib)\b.*\bif\s+(?:(?:it|its|it s|it is|he s|she s|he is|she is|they re|they are|there s|there is|we re|we are|we have|still|in|a|still in)\s+){0,3}(?:v\s?fib|vfib|vf|ventricular fibrillation|pulseless vt|pulseless v\s?tach|vt|v\s?tach|torsades?|shockable(?:\s+rhythm)?)\b|^if\s+(?:(?:it|its|it s|it is|he s|she s|he is|she is|they re|they are|there s|there is|we re|we are|we have|still|in|a|still in)\s+){0,3}(?:v\s?fib|vfib|vf|ventricular fibrillation|pulseless vt|pulseless v\s?tach|vt|v\s?tach|torsades?|shockable(?:\s+rhythm)?)\b.*\b(?:shock|defibrillate|defib)\b/;
// "The same energy" (R9, J8): the last shock's energy again — never the next rung.
const SAME_ENERGY_RE = /\bsame (?:energy|joules|setting|settings|level|power|dose)\b|\b(?:at|with|on) the same\b|\bsame again\b|\bsame as (?:before|last time|the last(?: one)?)\b|\brepeat (?:the )?(?:same )?(?:energy|joules)\b/;
// "Again", "go up", "higher" after a synchronized shock that did not convert (R8): the next synchronized step.
const SYNC_AGAIN_RE = /^(?:(?:ok|okay|then|and|lets|let s)\s+)*(?:again|go up|go higher|higher|up it|bump it(?: up)?|increase it|one more|once more|same again|repeat(?: it)?|try again|do it again)(?:\s+please)?$/;
// "200 joules synchronized", "200 J sync", "shock 150 joules synchronized" — the mode after the energy (R8).
const ENERGY_THEN_SYNC_RE = /^(?:(?:shock|cardiovert|deliver)\s+)?(?:at\s+)?(\d+(?:\.\d+)?)\s*(?:j|joules?)?\s+(?:synchroni[sz]ed|sync|synch)(?:\s+(?:mode|please))*$/;
// "Sync on, 100 joules", "sync mode 100 J", "turn on sync at 100 joules" (R11) — the mode, then its energy (with its unit).
const SYNC_THEN_ENERGY_RE = /^(?:(?:turn|switch|put)\s+(?:on\s+)?(?:it\s+|the\s+)?(?:defib\w*\s+|machine\s+)?(?:in(?:to)?\s+|on\s+)?)?(?:the\s+)?(?:sync|synch|synchroni[sz]e|synchroni[sz]ed|synchroni[sz]ation)(?:\s+(?:mode|button))?(?:\s+on)?\s*[,.;:-]?\s*(?:(?:and|then|at|to|deliver|shock)\s+)*(\d+(?:\.\d+)?)\s*(?:j|joules?)(?:\s+please)?$/;
// An energy on its own, with or without its unit — what re-charges a charge waiting (R8): "200", "360", "yes 120",
// "go up to 300", "try 300", "300 joules please". A number with no unit needs two or three digits.
const RECHARGE_FILLER_RE = /\b(?:yes|yeah|yep|ok|okay|sure|please|at|to|go|up|try|make|it|use|set|lets|let s|do|then|and|now|instead|the|energy)\b/g;
function energyOnly(s, script){
  const t = s.replace(/[.!\s]+$/, '').replace(/\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?\b/, ' perkg').replace(RECHARGE_FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(j|joules?)?(\s*perkg)?$/);
  // (R9, J8: an infant's one digit too — "6" to a 6-kg infant's charge.)
  if(!m || (!m[2] && !m[3] && !/^\d{2,3}$/.test(m[1]) && !(/^\d$/.test(m[1]) && infantJoules(+m[1], script)))) return null;
  return m[3] ? roundJoules(parseFloat(m[1]) * weightOf(script)) : roundJoules(parseFloat(m[1]));
}
// A number of joules as it is spoken — "one twenty", "two hundred", "three sixty", "a hundred and fifty",
// "six joules" — written as digits. Only in a defibrillator order or an answer to her question (actInner).
const W_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const W_TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const W_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function spokenJoules(s){
  const one = '(' + W_ONES.join('|') + ')', teen = '(' + Object.keys(W_TEENS).join('|') + ')', tens = '(' + Object.keys(W_TENS).join('|') + ')';
  const v = w => W_ONES.indexOf(w);
  return s
    // (R10: "hundred joules" with no "a" or "one" before it is a hundred too.)
    .replace(new RegExp('\\b(?:(a|' + W_ONES.join('|') + ')\\s+)?hundred(?:\\s+(?:and\\s+)?(?:' + tens + '(?:\\s+' + one + ')?|' + teen + '|' + one + '))?\\b', 'g'),
      (m, h, t, t1, tn, o) => String((!h || h === 'a' ? 1 : v(h)) * 100 + (t ? W_TENS[t] + (t1 ? v(t1) : 0) : tn ? W_TEENS[tn] : o ? v(o) : 0)))
    .replace(new RegExp('\\b' + one + '\\s+' + tens + '(?:\\s+' + one + ')?\\b', 'g'), (m, h, t, o) => String(v(h) * 100 + W_TENS[t] + (o ? v(o) : 0)))
    .replace(new RegExp('\\b' + tens + '(?:\\s+' + one + ')?\\b', 'g'), (m, t, o) => String(W_TENS[t] + (o ? v(o) : 0)))
    .replace(new RegExp('\\b(?:' + one + '|' + teen + ')(?=\\s*(?:j|joules?)\\b)', 'g'), (m, o, tn) => String(o ? v(o) : W_TEENS[tn]));
}
// A defibrillator order, or talk of one — where spoken numbers are joules.
const DEFIB_TALK_RE = /\b(?:shock\w*|defib\w*|charg\w*|joules?|sync\w*|synch\w*|cardiover\w*|energy|again|go up to|go to|try)\b/;
// An order that is nothing but an energy — what "at what energy?" is answered with: "120", "yes 120", "at 120
// please", "100 j please", "3 joules", "0.5 j/kg", "go up to 200", "200 again". The joules, or null.
// (R10, P3: "bump it to 200", "move to 200", "raise it to 200" name the energy too.)
const ENERGY_FILLER_RE = /\b(?:yes|yeah|yep|yup|ok|okay|sure|please|at|to|use|give|go|going|up|lets|let s|let|us|do|try|make|it|the|energy|of|with|then|and|now|again|increase|escalate|bump|move|raise|synchroni[sz]ed|synchroni[sz]e|sync|synch|shock|cardiover\w*)\b/g;
function energyAnswer(s, script){
  // (R10, P3: a spoken line ends with a full stop — "Go up to 200.", "One hundred." were no energy at all.)
  const t = s.replace(/[.!\s]+$/, '').replace(/\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?\b/, ' perkg').replace(ENERGY_FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(?:j|joules?)?(\s*perkg)?$/);
  if(!m) return null;
  const n = parseFloat(m[1]);
  return m[2] ? roundJoules(n * weightOf(script)) : roundJoules(n);
}
// "Go up to 200", "try 200", "200 again", "increase to 200 synchronized" — the next shock of the same kind, at
// that energy (only after a shock of that kind: actInner).
const ENERGY_STEP_RE = /^(?:(?:ok|okay|then|and|lets|let s)\s+)*(?:go(?:ing)? up to|go to|up to|increase (?:it )?to|escalate (?:it )?to|bump (?:it )?(?:up )?to|move to|try(?: at)?)\s+\d|^\d+(?:\.\d+)?\s*(?:j|joules?)?\s+again$/;
function energyStep(s, script){ return ENERGY_STEP_RE.test(s) ? energyAnswer(s, script) : null; }
// The top of the band: "shock at max energy", "maximum joules".
const MAX_ENERGY_RE = /\b(?:max|maximum|highest)\b|\bfull\s+(?:energy|joules|output|power)\b/;
function maxJoules(script, sync){
  const kg = weightOf(script);
  const e = sync ? syncBand(script) : (script.shock && script.shock.energy) || null;
  if(!e) return 360;
  // (A child's defibrillation: 10 J/kg, never past the adult dose — R8, Kim: 200 J.)
  if(e.perKg) return roundJoules(Math.min(e.perKg[1] * kg, sync ? 360 : childMaxJoules(script)));
  const band = Array.isArray(e) ? e : e.adult;
  return band ? band[band.length - 1] : 360;
}
// The case's energy words only; generic cancels ("never mind", "cancel that order", "abort", "belay that") call
// off the charge waiting, if there is one — they were "Holding off on that" and the next "clear" still shocked.
const GENERIC_CANCEL_RE = /^(?:(?:no|ok|okay|actually|wait|sorry)\s+)*(?:never ?mind|nevermind|cancel(?: that)?(?: order)?|abort(?: that)?|belay that|forget (?:it|that)|scratch that|disregard(?: that)?)$/;
// "Yes" to a question, as the doctor says it.
// (R10, P3: "of course", "absolutely", "right", "that's right" are a yes to her question too — they reached no branch.)
// (...and a spoken yes with its hesitation — "um, okay", "uh, yes" — or "alright", "please do", "push it".)
const YES_RE = /^(?:(?:um|uh|er|erm|so|well|oh|hmm)\s+)?(?:yes|yeah|yep|yup|ok|okay|sure|please|please do|go ahead|do it|go|give it|push it|another one|another round|correct|affirmative|of course|absolutely|right|that s right|alright|all right)(?:\s+(?:please|do it|go ahead|thanks|thank you))*[.! ]*$/;
// The answer to "synchronized?": yes, "yes, synchronized", "sync it", "synchronize it" — with an energy,
// or without one.
// (R10, P3: the yes after the mode too — "synchronized, yes", "sync, go ahead", "synced".)
const SYNC_ANSWER_RE = /^(?:(?:yes|yeah|yep|yup|ok|okay|sure|please|correct|affirmative|go ahead|do it)\s*)*(?:(?:synchroni[sz]e?d?|synch?|synced)\b(?:\s+(?:it|mode|on|the shock|that|please|shock|cardioversion|yes|yeah|yep|ok|okay|go ahead|do it))*)?(?:\s*(?:at\s*)?\d+(?:\.\d+)?\s*(?:j|joules?)\b(?:\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?)?)?(?:\s*please)?$/;
const SYNC_ANSWER_KEY_RE = /\b(?:yes|yeah|yep|yup|ok|okay|sure|correct|affirmative|go ahead|do it|synch?|synced|synchroni\w*)\b/;
function syncAnswer(s){ return SYNC_ANSWER_RE.test(s) && SYNC_ANSWER_KEY_RE.test(s); }
// THE CHARGE, DUMPED. "Disarm the defibrillator" reached the shock branch on the word "defibrillator" and
// SHOCKED; "dump the charge" charged again; "disarm" was not heard, and the next "clear" delivered the
// charge the doctor had just called off (round 6). Any state: nothing is delivered, the charge is gone.
const DISARM_RE = /\b(?:disarm\w*|dump(?:s|ed|ing)? (?:the )?(?:charge|energy|shock)|(?:cancel|abort) (?:the )?(?:charge|shock)|(?:turn|switch|power)(?:ed|ing)? off (?:the )?(?:defib\w*|machine)|(?:turn|switch|power) (?:the )?(?:defib\w*|machine) off)\b/;
// MORE ENERGY AT A PATIENT WITH A PULSE IS NEVER A DEFIBRILLATION (round 6). "Increase the energy",
// "escalate the joules", "go up on the energy" at a pulse, before any synchronized shock, delivered an
// unsynchronized 360 J into atrial fibrillation, 28 J into a bradycardic child, 3 J into the infant's SVT —
// and "increase the energy on the pacer" in complete heart block shocked at 360 J where the pacer was
// meant. At a slow rhythm, or with the pacer named or running, it is the pacer's output; at a rhythm that
// is cardioverted she asks the one thing she needs; after a synchronized shock it is the next step up
// (AGAIN_RE). In an arrest these stay defibrillation words, with the shock's timing.
// (R8: "shock at higher energy" too — it went in at the child's first rung again after 4 J/kg.)
const ESCALATE_RE = /\b(?:escalate|increase|go up on|bump|turn up|raise)(?: up)?(?: the)? (?:energy|joules)\b|\bmore (?:energy|joules)\b|^up the (?:energy|joules)\b|\bhigher (?:energy|joules)\b/;
// The pacer by name, or its milliamps or its capture — whatever the rhythm.
const PACER_NAME_RE = /\b(?:pace|paced|pacing|pacer|transcutaneous|tcp|ma|milliamps?|milliamperes?|capture)\b/;
// "Increase the mA", "turn up the output to 90": the pacer's own dials — its output and current only at a
// patient being paced or slow (a defibrillator has an energy "output" too).
const PACER_DIAL_RE = /\b(?:increase|turn up|up|raise|set|go up on|bump)\b[^.;]*\b(?:ma|milliamps?|milliamperes?|output|current)\b/;
// Round 7 (Kim): the pacer's words — pacer, pacing, mA, output, capture — are the pacer's in every state, and
// never a shock ("increase the energy on the pacer" defibrillated asystole at 360 J). Not an order to stop it
// (the pacer-off branch), not the pads named ("pacing pads": the pads branch), not the pace of compressions.
const PACER_WORD_RE = /\b(?:pace|paced|pacing|pacer|transcutaneous|tcp|ma|milliamps?|milliamperes?|capture|output)\b/;
const HOLD_PACER_RE = /\b(?:stop|stopping|hold|holding|pause|pausing|turn off|discontinue)\b.*\b(?:pacing|pacer|tcp|transcutaneous)\b/;
// A slow rhythm with a pulse — the pacer's patient, not the defibrillator's.
function bradycardic(state){
  return !!state.pulse && !CARDIOVERTABLE.has(state.rhythm) && !SHOCKABLE.has(state.rhythm)
    && (/brady|CHB|degree|paced/.test(state.rhythm) || (state.hr > 0 && state.hr < 60));
}
const POST_ROSC_REFUSE = [
  [{ test: s => asksForShock(s) || chargeOnly(s) }, 'There is a pulse, doctor — no shock.'],
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
  // A shock asked for is a shock held, for the pulse (round 6): held 'shock', reason 'pulse', as readyIn
  // and holdReason now say. (A bare charge is refused with the same words, and holds nothing.)
  // (Round 7: "charge the defibrillator" names the machine — a charge, refused, holding nothing.)
  if(asksForShock(s) && !chargeOnly(s)) return held(state, 'shock', 'There is a pulse, doctor — no shock.', 'There is a pulse, doctor — no shock.', Infinity, 'pulse');
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
// VENTILATION, HOWEVER IT IS SAID. The airway branch heard "bag", "BVM", "ventilate", "PPV" — and not
// "start bagging", "rescue breaths", "mouth to mask", "breaths via the tube". Those went to the turn
// engine, flags.ppv stayed unset, and the correct epinephrine that followed was flagged "Ventilation
// first" and lost its credit (round 6) in the two cases built to teach that order. Breaths count when
// they are GIVEN ("give two breaths", "40 breaths a minute", "breaths via the tube") — not "take deep
// breaths" at a patient who is awake. A bag of saline, a pressure bag, hanging a bag are fluids, and
// "breath sounds" is listening; CPAP supports a newborn's own breathing and is not ventilation.
const VENT_RE = new RegExp('\\b(?:bag(?:s|ged|ging)?|bvm|ambu|ventilat\\w*|positive[ -]pressure|i?ppv|rescue breath\\w*'
  + '|breathe for|breathing for|mouth[ -]to[ -](?:mask|mouth|nose)|pocket mask|t[ -]piece|neopuff|inflation breaths?|inflate the lungs)\\b'
  + '|\\b(?:give|giving|deliver|delivering|start|begin|provide|assist|assisted|two|2)\\b[^.;]{0,24}\\bbreaths\\b'
  + '|\\d+\\s*breaths\\b|\\bbreaths\\s+(?:via|through|with|by|down|at|every)\\b'
  // "Assist his breathing" (the catalogue's drowning wording), "vent him", "put her on the vent".
  + '|\\bassist(?:ed|ing)?\\s+(?:\\w+\\s+){0,2}?breathing\\b|\\bvent (?:him|her|them|the (?:patient|baby|child))\\b|\\b(?:on|to) (?:the |a )?vent\\b'
  // Round 8: "check that the chest rises with each breath" — NRP's own words for watching the breaths being
  // given. The breaths are going on; the order counts. (The chest's rise, not "retractions with each breath" —
  // a child breathing for herself.)
  + '|\\bchest\\s+(?:rise|rises|rising|moves|moving|movement|expansion)\\b[^.;]{0,24}?\\b(?:with|on|for)\\s+(?:each|every)\\s+(?:breath|inflation|squeeze)\\b');
// (The fluids by name too — "an NS bag", "LR bag" placed a bag-mask and said "Bagging at ten a
// minute" — and the plastic bag a preterm newborn is wrapped in to keep warm.)
const NOT_VENT_RE = /\b(?:pressure|banana|fluid|fluids|saline|ns|lr|ringer s|ringers|hartmann s|d5w?|d10w?|iv|blood|urine|foley|drainage|collection|specimen|body|ice|plastic|polyethylene|zip|ziploc|sandwich|ostomy|colostomy|leg|drip)\s+bags?\b|\bbags?\s+of\b|\bhang(?:ing)?\s+(?:up\s+)?(?:an?\s+|the\s+|another\s+)?bags?\b/g;
// ...nor breaths declined: "compressions only, no ventilation", "don't bag him" — nor the asthmatic's
// circuit taken off to let the trapped air out ("disconnect the ventilator").
const NO_VENT_RE = /\b(?:no|not|without|don t|dont|do not|never|avoid|stop|stopping|hold|holding|pause|pausing|disconnect|disconnecting|off)\s+(?:the\s+|any\s+|further\s+|more\s+)?(?:bag\w*|bvm|ventilat\w*|vent|rescue breath\w*|breaths|i?ppv|positive[ -]pressure)\b/;
// ...NOR A MENTION OF IT (round 7). "Reassess the heart rate after thirty seconds of ventilation" (the meconium
// case's own last step) names the ventilation already given; "prepare to bag", "BVM ready", "have the bag-mask
// at the bedside" name the one to come. Each switched the flag on — after "stop bagging" the newborn still came
// up to 136 on breaths nobody was giving.
// ROUND 8 (Kim): WORDS THAT CHECK THE BREATHS RIDE WITH THEM. Round 7 also took out any clause that opened by
// assessing ("check", "watch", "look", "reassess"), up to its "and" — and with it "watch the chest rise as you
// bag", "look for chest rise while bagging", "reassess while continuing PPV", "check that the chest rises when we
// bag". Those are how PPV is ordered and watched at once: the breaths were never given, and the meconium newborn
// died where live ended stable. An order that names the breaths going on counts, whatever checking rides with it.
// What does not: an order to stop them (NO_VENT_RE, HOLD_VENT_RE), the breaths already given ("after thirty
// seconds of ventilation"), the ones to come ("prepare to bag") — and the breaths named inside a CONDITION with no
// order to give them: "if no chest rise with bagging", "if the rate stays under 60 despite ventilation". (A
// condition that holds the order itself — "if not breathing, start PPV" — still orders it.)
const VENT_MENTION_RE = new RegExp(
  '\\b(?:after|following|despite)\\s+(?:\\S+\\s+){0,3}?(?:seconds?|secs?|minutes?|mins?)\\s+of\\s+(?:good\\s+|effective\\s+|adequate\\s+)?'
    + '(?:ventilat\\w*|ppv|bagging|breaths|positive[ -]pressure(?:\\s+ventilation)?)\\b'
  // (Round 10, P3: not the "have" of a request — "can I have PPV?", "may I have bag-mask ventilation please" ask for it.)
  // (R11: whoever it is for — "can the baby have PPV?", "can he have bag mask ventilation?" — R12, Z4: "should the baby have PPV?".)
  + '|\\b(?:prepare|preparing|prep|prepping|get ready|getting ready|be ready|ready|set up|setting up|stand by|standby|(?<!\\b(?:can|could|may|might|would|will|shall|should)\\s+(?:i|we|you|he|she|they|someone|somebody|the (?:baby|patient|child|infant|newborn|kid)|baby|patient|child|infant|newborn)\\s+(?:please\\s+|just\\s+)?)have)\\s+'
    + '(?:to\\s+|for\\s+)?(?:the\\s+|a\\s+)?(?:bag(?:ging)?|bvm|bag[ -]valve[ -]mask|bag[ -]mask|ambu(?:\\s+bag)?|ventilat\\w*|ppv|positive[ -]pressure(?:\\s+ventilation)?)'
    + '(?:\\s+(?:him|her|them|the (?:baby|patient|child)))?\\b'
  + '|\\b(?:the\\s+|a\\s+)?(?:bag|bvm|bag[ -]valve[ -]mask|bag[ -]mask|ambu(?:\\s+bag)?)\\s+(?:is\\s+)?(?:ready|at the bedside|to the bedside|on standby|standing by|set up|available|nearby|in the room)\\b'
  + '|\\b(?:if|unless)\\s+(?:(?!ppv\\b|bag|ventilat|bvm\\b|start|begin|give|continue|keep)[^,;])*?'
    + '\\b(?:with|despite|after|on|during|when|while|as)\\s+(?:\\w+\\s+){0,2}?(?:i?ppv|bag(?:ging)?|ventilat\\w*|positive[ -]pressure(?:\\s+ventilation)?|breaths|bvm)\\b', 'g');
// `s` is norm()'d text.
function asksToVentilate(s){ const t = s.replace(NOT_VENT_RE, ' ').replace(VENT_MENTION_RE, ' '); return VENT_RE.test(t) && !NO_VENT_RE.test(t); }
// ROUND 9 (K3): A QUESTION IS NOT AN ORDER. Round 8 heard "check that the chest rises with each breath" as NRP's own order
// to bag and watch — and with it "is the chest rising with each breath?" and "does the chest rise with each breath": the
// mask went on and the ventilation step was ticked, in seven cases (the meconium newborn's rate 70 → 94). A line that ASKS
// — it ends with a question mark, or opens with is / are / was / were / does / did / has / should, "do" or "have" + you /
// we, "can" or "could" + you / we + see / hear / feel / tell — is left to be answered, as on live (the turn engine), and
// never carried out: no bag-mask, no tube. A request is still an order: "can you bag him", "can someone bag the baby",
// "could we get some rescue breaths going". (`text` is the order as typed: norm() takes the question mark away.)
// ROUND 10 (Kim's P3): READ GENEROUSLY — A REQUEST IS AN ORDER, HOWEVER IT IS PUNCTUATED. Round 9 took any single order
// ending in "?" for a question, and "Can I get a tourniquet?", "Can I get PPV?", "Could I get MTP activated?" — the everyday
// ED ask, and speech-to-text adds the "?" itself — did nothing: seven textbook runs died where live saved them. The question
// mark decides nothing now. A line is a question only when every sentence in it ASKS ABOUT THE STATE: it opens with is /
// are / was / were / does / did / has / had, "do" or "have" + a subject, what / how / when / where / why / who / which,
// "can" / "could" / "will" + the patient or a thing ("can he breathe", "will it convert"), or "can you see / hear / feel /
// tell". Everything else is an order: "can / could / would / will / may I / we / you / someone …", "shall we", "should we",
// "let's", "please …", "do you want to …", "why don't we …", "how about …", "are you able to …", "is it OK to …" — and a
// bare "PPV?". "Is he breathing? If not, bag him." is the order. A question is answered where the nurse can answer it — the
// drug clock, the shocks, the check (answerQuestion) — and otherwise left to the turn engine; it is never carried out, never
// held and never scored.
// ROUND 11 (Kim): THE SPLIT IS CONSERVATIVE — A LINE IS A QUESTION ONLY WHEN IT ASKS FOR INFORMATION AND CARRIES NO ORDER.
// Round 10 read "Can he get epinephrine 1 mg?", "Could she have 10 mL/kg of O-negative?", "Can the baby have PPV?", "Can the
// nurse cardiovert?", "Have someone start compressions", "Do we want to give TXA?", "Are we going to put on a binder?" and "Is
// everybody clear? Shocking." as questions: the nurse answered "No epinephrine yet, doctor." or "No, doctor — that has not been
// done." and nothing was given — 133 cells of the adult matrix, and 8 of 8 paediatric textbook runs worse than live (5 deaths).
// So a request is an order whoever its subject is: the patient ("can he get / have / receive …", "could she be bagged"), the
// team ("can the nurse …", "could the RT …"), a delegation ("have someone …", "have the RT …"), a proposal ("do we want to
// …", "are we going to …", "are we good to shock?"), a need asked aloud ("does he need a tourniquet?", "do we need to give
// calcium?" — the team cannot answer a clinical need from its record, and the leader asking it is deciding it; not
// electricity, whose questions the nurse answers from the record: shockAnswer), and a call-out asked ("is everybody clear?").
// What stays a question: what / how / when / why / which / who, and is / are / does / did / has / have + a subject + the state
// ("is he breathing?", "is epi due?", "is the tourniquet on?", "did we give amiodarone?", "can he breathe?", "could it be a
// tension?"). A question she cannot answer truthfully from her own record is passed on (answerQuestion), never answered "not
// done".
const ASK_LEAD_SRC = '(?:(?:ok|okay|so|and|um|uh|er|hey|doctor|nurse|then|now|alright|all right|right|yes|yeah|well|guys|team|folks|sorry)\\s+)*';
// (The patient as the subject, and the participles of care a request may ask for: "can he be intubated?".)
const ASK_PATIENT_SRC = '(?:he|she|they|him|her|them|the (?:patient|pt|baby|child|kid|infant|newborn|boy|girl|man|woman|lady|guy|mother|mum|mom)|patient|baby|child|infant|newborn)';
const CARE_PARTICIPLE_SRC = '(?:bagged|ventilated|intubated|tubed|cardioverted|shocked|defibrillated|paced|transfused|sedated|decompressed|given|started on|put on|placed on|treated|resuscitated|compressed|oxygenated|suctioned|stimulated|warmed|dried|bolused|loaded|pushed|bound|splinted|packed|reintubated)';
const REQUEST_RE = new RegExp('^' + ASK_LEAD_SRC + '(?:'
  + '(?:can|could|would|will|may|might)\\s+(?:you|we|i|someone|somebody|anyone|anybody|y all|you all|you guys|one of you|the team)\\b(?!\\s+(?:see|hear|feel|tell|notice)\\b)'
  + '|(?:shall|should)\\b|let s\\b|lets\\b|let us\\b|please\\b'
  + '|(?:do|would) you (?:want|wanna|mind|like)\\b|why (?:don t|dont|not)\\b|how about\\b|what about\\b|what if (?:we|you|i)\\b'
  + '|(?:are|is) (?:you|we|someone|somebody|anyone|anybody|one of you) able to\\b|is it (?:ok|okay|alright|all right) (?:to|if)\\b'
  + '|i d like\\b|i would like\\b|i want\\b|i need\\b|we need\\b'
  // (R11) the patient as the subject — "can he get …", "could she have …", "can the baby be bagged".
  + '|(?:can|could|would|will|may|might|shall)\\s+' + ASK_PATIENT_SRC + '\\s+(?:please\\s+|just\\s+|also\\s+|now\\s+)?(?:get|have|receive|go on|go onto|be\\s+' + CARE_PARTICIPLE_SRC + ')\\b'
  // ...the team — "can the nurse …", "could the RT …";
  + '|(?:can|could|would|will|may)\\s+(?:the\\s+|our\\s+|a\\s+)?(?:nurse|nurses|team|tech|rt|respiratory(?: therapist)?|resident|registrar|medic|paramedic|pharmacist|pharmacy|charge nurse|anaesthetist|anesthetist|anaesthesia|anesthesia|someone else|anyone else|somebody else)\\b'
  // ...a delegation — "have someone start compressions", "have the RT bag him" (not "have you given epi?", "have we got access?");
  + '|have\\s+(?:someone|somebody|one of you|a nurse|the (?:nurse|rt|tech|team|resident|respiratory therapist|charge nurse|pharmacist|registrar)|rt|respiratory|nursing)\\s+(?!(?:been|got|gotten|done|given|placed|started|checked|tried|seen|had|called|taken|pushed|drawn|sent|already)\\b)(?!\\w+ed\\b)'
  // ...a proposal — "do we want to …", "are we going to …", "are we good to shock?".
  + '|(?:do|don t|would)\\s+(?:we|you)\\s+(?:want|wanna)\\b'
  + '|(?:are|is|am|aren t)\\s+(?:we|you|i|someone|somebody|anyone|anybody|one of you|the team)\\s+(?:going to|gonna|about to)\\b'
  + '|(?:are|is)\\s+(?:we|you|everyone|everybody|all)\\s+(?:ok|okay|good|ready|set|clear)\\s+(?:to|for)\\b'
  + '|any chance\\b)');
// (R11) A NEED ASKED ALOUD — "does he need …", "do we need to …", "will she need …". An order, except for the electricity (the
// nurse answers "do we shock?" from the record without reading the strip: shockAnswer).
const NEED_ASK_RE = new RegExp('^' + ASK_LEAD_SRC + '(?:does|do|doesn t|don t|will|would|is|are|isn t)\\s+(?:' + ASK_PATIENT_SRC + '|we|you)\\s+(?:still\\s+|really\\s+|now\\s+|also\\s+|then\\s+)?(?:need|needs|require|requires|going to need|gonna need)\\b');
// (The bare shock decision — "does he need a shock?", "do we need to defibrillate?" — is asked; an energy, a charge or a synchronized
// shock named is the order: "does he need synchronized cardioversion at 100 joules?".)
const ELECTRIC_WORD_RE = /\b(?:shock\w*|defib\w*|zap)\b/;
const ELECTRIC_ORDER_RE = /\d|\b(?:cardiover\w*|joules?|energy|sync\w*|synch|charg\w*)\b/;
const QUESTION_OPEN_RE = new RegExp('^' + ASK_LEAD_SRC + '(?:'
  + '(?:is|isn t|are|aren t|was|wasn t|were|weren t|does|doesn t|did|didn t|has|hasn t|had|hadn t)\\b'
  + '|(?:do|don t|have|haven t)\\s+(?:you|we|they|i|he|she|anyone|anybody|someone|somebody|everyone|everybody)\\b'
  + '|(?:what|whats|how|hows|when|whens|where|wheres|why|who|whos|which|whose)\\b'
  + '|(?:can|could|will|would)\\s+(?:the|it|he|she|there|his|her|this|that|they)\\b'
  + '|(?:can|could)\\s+(?:you|we|anyone|someone|somebody|i)\\s+(?:see|hear|feel|tell|notice)\\b)');
// A sentence of nothing but these carries no ask and no order: "Is he breathing? Thanks."
const ASK_FILLER_RE = /^(?:(?:ok|okay|thanks|thank you|please|good|great|right|alright|all right|yes|yeah|no|doctor|nurse|so|um|uh|er|hmm|guys|team|folks|now)\s*)+$/;
function questionLine(text){
  // Sentences at ? ! and a full stop — never the point of a decimal ("epinephrine 0.1 mg").
  const said = String(text == null ? '' : text).split(/[?!]+|\.(?!\d)/).map(norm).filter(x => x && !ASK_FILLER_RE.test(x));
  // (R12, Z6: a hold said after the question — "Is epi due? Not yet.", "is epi due? hold it" — is its answer (trailingHold), not an
  // order: read as one, the line gave the epinephrine.)
  const asks = said.filter((x, i) => !(i > 0 && i === said.length - 1 && HOLD_WORD_RE.test(x)));
  return asks.length > 0 && asks.every(askSentence);
}
// A hold or a no said after the question, in the same line (R12, Z6): "Is epi due? Not yet.", "is it time for amio? no", or,
// spoken, "is epi due not yet". The words of it, or null.
function trailingHold(text){
  const parts = String(text == null ? '' : text).split(/[?!]+|\.(?!\d)/).map(norm).filter(Boolean);
  if(parts.length > 1){ const x = parts[parts.length - 1]; return (HOLD_WORD_RE.test(x) || BARE_NO_RE.test(x)) && !HOLD_WORD_RE.test(parts[0]) && !BARE_NO_RE.test(parts[0]) ? x : null; }
  const m = parts.length === 1 && parts[0].match(/\S\s+(not yet|hold it|hold off|hold on|not now)$/);
  return m ? m[1] : null;
}
// A yes said after the question, in the same line (R11): "Is it time for epi? Yes." — or, spoken, "is it time for epi yes".
function trailingYes(text){
  const parts = String(text == null ? '' : text).split(/[?!]+|\.(?!\d)/).map(norm).filter(Boolean);
  if(parts.length > 1) return YES_RE.test(parts[parts.length - 1]) && !YES_RE.test(parts[0]);
  return parts.length === 1 && /\S\s+(?:yes|yeah|yep)$/.test(parts[0]);
}
// A line that is nothing but a call of a shockable rhythm (R11): "VF", "it's VF", "this is VF", "still in VF", "pulseless VT",
// "polymorphic VT", "coarse VF, shockable". (What the call is of is callsRhythm's; this only asks that nothing else was said.)
const SHOCKABLE_CALL_SRC = '\\b(?:pulseless\\s+(?:polymorphic\\s+)?(?:v\\s?tach|vtach|vt|ventricular tachycardia)|polymorphic\\s+(?:v\\s?tach|vtach|vt|ventricular tachycardia)|torsades?(?:\\s+de\\s+pointes)?|v\\s?fib|vfib|ventricular fibrillation|vf|v\\s?tach|vtach|vt|ventricular tachycardia)\\b';
const SHOCKABLE_CALL_RE = new RegExp(SHOCKABLE_CALL_SRC), SHOCKABLE_CALLS_RE = new RegExp(SHOCKABLE_CALL_SRC, 'g');
const CALL_FILLER_RE = /\b(?:it s|it is|its|this is|this s|that s|that is|thats|we have|we ve got|we got|we re in|we are in|looks like|look s like|i see|i think|there s|there is|still|now|again|the rhythm is|rhythm s|rhythm is|rhythm|on the monitor|monitor shows|monitor|showing|shows|he s in|she s in|he is in|she is in|in|it|is|a|an|the|coarse|fine|shockable|ok|okay|so|doctor|nurse|guys|team|yep|yes|yeah|call it|calling it|i m calling|i call|i d call)\b/g;
function bareRhythmCall(text){
  const t = norm(text);
  return SHOCKABLE_CALL_RE.test(t) && !t.replace(SHOCKABLE_CALLS_RE, ' ').replace(CALL_FILLER_RE, ' ').replace(/[.\s-]+/g, ' ').trim();
}
// One sentence that asks (R11): a question opening, and no request, need, or call-out in it.
function askSentence(x){
  if(!QUESTION_OPEN_RE.test(x) || REQUEST_RE.test(x) || deliveryCallout(x)) return false;
  if(NEED_ASK_RE.test(x) && !(ELECTRIC_WORD_RE.test(x) && !ELECTRIC_ORDER_RE.test(x))) return false;
  // (R12, Z4: the patient as the subject and a treatment named — whatever the verb.)
  if(PATIENT_ASK_RE.test(x) && namesTreatment(x) && !EFFECT_ASK_RE.test(x)) return false;
  return true;
}
// (...but a question about what a treatment would do for him — "would he benefit from calcium?", "will she respond to
// adenosine?" — asks about the patient, and is answered.)
const EFFECT_ASK_RE = /\b(?:benefit\w*|respond\w*|improv\w*|react\w*|help|helped|work|worked|survive|do better|get better|be better|be allergic|be eligible|be a candidate|be harmed|be hurt)\b/;
// R12 (Z4): A REQUEST NAMING A TREATMENT IS AN ORDER, WHATEVER ITS VERB. Round 11 made "can he get / have / receive / go on / be
// <treated>" orders one verb at a time, and the next verbs were still questions: "Could she try a modified Valsalva?", "Could she
// do with a pelvic binder?", "Can he try some TXA?" — answered, or passed on as a proposal ("The team holds off for now.") — and
// the vagal step, the binder and the tranexamic acid never happened (live did them). So the rule is on the TREATMENT, not the
// verb: "can / could / would / will / may / might / shall" + the patient + a treatment named — a drug, a vagal manoeuvre, the
// breaths or an airway, or a procedure by its noun (TREATMENT_NOUN_RE: the code cases' own steps) — is the order. What names no
// treatment is still a question about the patient: "can he breathe?", "could she be bleeding into the pelvis?", "could she be in
// tamponade?".
const PATIENT_ASK_RE = new RegExp('^' + ASK_LEAD_SRC + '(?:can|could|would|will|may|might|shall)\\s+' + ASK_PATIENT_SRC + '\\b');
const TREATMENT_NOUN_RE = /\b(?:binder|tourniquet|packing|wound packing|pack the wound|(?:haemostatic|hemostatic|combat) gauze|pressure dressing|direct pressure|splint|needle decompression|needle thoracostomy|finger thoracostomy|thoracostomy|decompression|chest tube|chest drain|thoracotomy|clamshell|pericardiotomy|pericardiocentesis|transfusion|massive transfusion|mtp|blood products|packed (?:red )?cells|prbcs?|o neg(?:ative)?(?: blood)?|whole blood|fluid bolus|fluids|normal saline|saline|crystalloid|lactated ringers|hartmanns|hypertonic saline|mannitol|warm blankets|bair hugger|forced air warmer|fluid warmer|rewarm\w*|pacing|pacer|pads|cardioversion|compressions|cpr|uvc|umbilical (?:venous )?(?:line|catheter)|io|intraosseous|ivs?|large bore|line|access|suction\w*|ppv|bag[ -]mask|capnograph\w*|capno|etco2|end tidal|pulse ox\w*|oximet\w*|sat probe|preductal|laryngeal mask|supraglottic|head of (?:the )?bed|head up|elevate the head|reverse trendelenburg|sniffing position|reposition\w*|jaw thrust|mask seal|mr ?sopa|corrective steps|expiratory time|volume (?:bolus|expansion)|\d+(?:\.\d+)?\s*ml\s*(?:\/|per)\s*kg)\b/;
function namesTreatment(x){
  return !!findDrug(x) || VAGAL_RE.test(x) || asksToVentilate(x) || ADVANCED_AIRWAY_RE.test(x) || TREATMENT_NOUN_RE.test(x)
    || (ELECTRIC_WORD_RE.test(x) && ELECTRIC_ORDER_RE.test(x));
}
// A QUESTION ABOUT WHETHER A STEP WAS DONE (R11) — "did we decompress the chest?", "has he had a binder?", "have we packed
// it?", "is the tourniquet on?", "is the UVC in?", "is the chest decompressed?" — not about the patient ("is he breath
// stacking?", "is there a pericardial effusion?", "is a UVC needed?"). `s` is norm()'d.
const DONE_ASK_RE = new RegExp('^' + ASK_LEAD_SRC + '(?:did|didn t|has|hasn t|have|haven t|had|hadn t)\\b'
  + '|\\b(?:been|got|gotten|already)\\b'
  + '|\\b(?:done|placed|in|on|given|applied|started|running|up|finished|complete|completed|performed|inserted|secured|tight|tightened|activated|going|hung|bound|packed|sited)\\s*$'
  + '|\\b(?!(?:needed|indicated|required|recommended|warranted|compromised|obstructed|distended|distressed|tired|scared|worried|concerned|bleed)\\b)\\w+ed\\s*$');
function asksDone(s){ return DONE_ASK_RE.test(String(s || '').replace(/[.?!\s]+$/, '')); }
// WHAT SHE ANSWERS (round 10, P3). A question about the state is answered from the record — how long since the last dose
// and when the next is due, the shocks so far, when the check comes — or passed to the turn engine ({ handled: false });
// null when the question is itself the step: a case's own words that ask ("how is the heart rate", the bradycardic child's
// reassessment), and a pulse or rhythm question where the check is due or has just been made, or where there is no arrest's
// check to wait for (a pulse, a newborn) — the check branch answers it by checking. `text` is the line as said.
function answerQuestion(state, script, text){
  const s = norm(text);
  if(state.ended === 'death') return { handled: false };
  const hit = matchCause(script, s);
  if(hit && (hit.asks || questionLine(hit.phrase))) return null;
  const say = line => ({ handled: true, credits: [], events: [ev(state, 'note', line, { ack: 'answer' })] });
  // THE CASE'S OWN STEPS, ASKED ABOUT — "did we decompress the chest?", "is the tourniquet on?", "is the UVC in?" — from the
  // record. Passed on, the turn engine narrated them done ("Angiocath into the fifth space … big rush of air") and ticked the
  // critical action while the patient stayed untreated.
  const step = hit || uvcOrder(script, s);
  // (R11: only a question about whether the step was DONE is the record's to answer — "did we …", "has he had …", "is the
  // binder on?", "is the chest decompressed?". "Is he breath stacking?" names the asthmatic child's step, but asks about the
  // patient: "No, doctor — that has not been done." was false. Passed on.)
  if(step && !asksDone(s)) return { handled: false };
  // (...and only when it names the step as a step: "mask seal" is not "is the mask sealed?" — the seal, not the step.)
  if(hit && !new RegExp('(?:^|\\s)' + noArticles(norm(hit.phrase)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)').test(noArticles(s))) return { handled: false };
  if(step){
    const done = state.events.find(e => e.kind === 'cause' && e.cause === step.cause);
    return say(done ? 'Yes, doctor — that was done at ' + fmt(done.t) + '.'
      : state.causesTreated.indexOf(step.cause) !== -1 || state.flags[step.cause] ? 'Yes, doctor — that is done.' : 'No, doctor — that has not been done.');
  }
  const drug = findDrug(s);
  if(drug){
    // "What dose of epi?" — the nurse knows the dose (the turn engine said "Epinephrine is in — pushed and flushed" and nothing
    // went in). Then what the record says of it.
    const mg = /\b(?:dose|dosing|how much|how many (?:mg|milligrams|micrograms|mcg))\b/.test(s) ? expectedDoseMg(state, script, drug) : null;
    return say((mg != null ? capitalize(drug) + ' is ' + doseSaid(mg) + ' here, doctor. ' : '') + drugAnswer(state, script, drug));
  }
  const arrest = !state.pulse && !state.ended && !isNeonate(script);
  // (R11: "what energy?", "how many joules?" — the energy, not the count of shocks: a charge waiting, else the next standard
  // energy the team would charge to — below.)
  // (R11: "is it charged?", "are we charged?" — the machine, from the record.)
  if(!state.ended && /\bcharged\b/.test(s) && !/\bdischarged\b/.test(s) && (arrest || (state.pulse && CARDIOVERTABLE.has(state.rhythm)))){
    const c = pendingCharge(state);
    return say(c ? 'Charged' + (c.joules != null ? ' to ' + c.joules + ' joules' : '') + (c.sync ? ', synchronized' : '') + ', doctor.' : 'Nothing is charged, doctor.');
  }
  // (R12, Z7: the energy the team will actually charge — standardJoules, what teamCharge charges at the check: a child's 4 J/kg
  // after the first shock. She said the ladder's next rung, 144 J, and the team then charged 96.)
  if(arrest && /\b(?:energy|joules?)\b/.test(s) && /\b(?:what|which|how much|how many|how high|what s|whats)\b/.test(s)){
    const c = pendingCharge(state);
    return say(c && c.joules != null ? 'Charged to ' + c.joules + ' joules, doctor.' : standardJoules(state, script) + ' joules for the next shock, doctor.');
  }
  if(arrest && (asksForShock(s) || /\b(?:shocks?|shocked|joules|energy)\b/.test(s))) return say(shockAnswer(state, script));
  // (The pulse, not the pulse oximeter.)
  const pulseWord = /\bpulses?\b(?!\s*(?:ox|oximet))/.test(s);
  if(CHECK_WORDS_RE.test(s) || pulseWord){
    const win = arrest ? checkWindow(state, script) : null;
    if(!win || !win.wait || win.confirm || win.justChecked) return null;
    const n = toCheckSec(state);
    return say((pulseWord && !CHECK_WORDS_RE.test(s) && !/\brhythm\b/.test(s) ? 'No pulse, doctor — we feel again at the rhythm check in ' : 'Rhythm check in ')
      + spokenTime(n) + ', at the end of the cycle.');
  }
  // The airway, the access, the compressions — from the record. (The breaths themselves are left to the turn engine: whether
  // the chest rises is the case's to say, not the record's.)
  // (R11: not the airway's patency — "is the airway clear?", "is it patent?" — which the record does not know: passed on.)
  if(!asksToVentilate(s) && (ADVANCED_AIRWAY_RE.test(s) || /\b(?:intubated|airway|tubed)\b|(?<!\b(?:chest|ng|og|nasogastric|orogastric|feeding)\s)\btube\b/.test(s))
     && !(/\b(?:clear|patent|open|obstructed|blocked|compromised|maintained|protected)\b/.test(s) && !/\b(?:tube|intubated|lma|igel|i-gel|supraglottic|ett)\b/.test(s)))
    return say(state.airway === 'ett' ? 'The tube is in, doctor' + (state.capnography ? ' — waveform capnography on it.' : '.')
      : state.airway === 'sga' ? 'The supraglottic airway is in, doctor.' : state.airway === 'bvm' ? 'No advanced airway, doctor — bag and mask.' : 'No airway placed yet, doctor.');
  if(/\b(?:iv|ivs|io|intraosseous|access|line)\b/.test(s))
    return say(state.io ? 'The IO is in, doctor.' : state.ivAccess ? 'IV access is in, doctor.' : 'No access yet, doctor.');
  if(/\b(?:cpr|compressions?|compressing)\b/.test(s))
    return say(state.cpr ? 'Compressions are running, doctor.' : state.pulse ? 'There is a pulse, doctor — no compressions.' : 'Nobody is on the chest, doctor.');
  return { handled: false };
}
// "Two minutes ten since the last epi, doctor — the next is due in fifty seconds." With an arrest's epinephrine due, she
// offers it — "another epi?" — and her question is open for the yes (epiTiming's, the same fields).
function drugAnswer(state, script, name){
  const label = name === 'epinephrine' ? 'epi' : name;
  const given = state.drugs.filter(d => d.name === name && !d.infusion);
  const drip = state.drugs.some(d => d.name === name && d.infusion) ? (/^[aeiou]/.test(name) ? ' An ' : ' A ') + name + ' infusion is running.' : '';
  // BEFORE THE FIRST DOSE (R11): "is epi due?" in PEA, or after the second shock, got "No epinephrine yet, doctor." — never that
  // it was due, and no question open, so the doctor's "ok, give it" gave nothing (live gave the dose). The arrest's first dose
  // is due at once: she says so and offers it, her "another epi?" open for the yes. In a CALLED shockable rhythm before the
  // second shock she says the algorithm's order instead (the debrief coaches it) — uncalled she reads nothing off the strip.
  // (A child or a newborn on compressions for a rate under sixty is on the same footing — after the breaths: epinephrine is
  // for a rate under sixty despite effective ventilation.)
  if(!given.length && name === 'epinephrine' && !state.ended && state.pulse && isChild(script) && compressionsIndicated(state, script)
     && readyIn(state, script, 'epinephrine') === 0 && !state.flags.ppv)
    return 'No epinephrine yet, doctor — ventilation first: epinephrine is for a rate under 60 despite effective ventilation' + (isNeonate(script) ? ' and compressions.' : '.') + drip;
  // (R12, Z6: a dose queued for right after the shock is that dose — she says so, and asks nothing.)
  if(name === 'epinephrine' && epiQueued(state)) return (given.length ? capitalize(spokenTime(state.t - given[given.length - 1].t)) + ' since the last epi, doctor. The next' : 'No epinephrine yet, doctor — it')
    + ' goes in right after the shock.' + drip;
  if(!given.length && name === 'epinephrine' && !state.ended && (!state.pulse || (isChild(script) && compressionsIndicated(state, script)))
     && readyIn(state, script, 'epinephrine') === 0){
    if(heardName(state) && SHOCKABLE.has(state.rhythm) && episodeDefibs(state).length < 2)
      return 'No epinephrine yet, doctor — in a shockable rhythm the first dose goes in after the second shock.' + drip;
    state.pendingQuestion = 'epi'; state.questionT = state.t; state.questionRhythm = state.rhythm;
    return 'No epinephrine yet, doctor — ' + (heardName(state) ? 'it is due now' : 'it can go in now') + '. Shall I give it?' + drip;
  }
  // R12 (Z2): EVERY CASE DRUG, AS EPINEPHRINE. "Is it time for amio?", "is mag due?", "do we give naloxone now?" got "No
  // amiodarone yet, doctor." — no word of whether it was due and no question open, so the "ok, give it" after it gave nothing
  // (live gave the drug). She answers from readyIn and holdReason, and when the case's drug is due she offers its standard dose
  // (drugOffer) with her question open for the yes — or says why not.
  const w = readyIn(state, script, name), r = holdReason(state, script, name);
  const off = name !== 'epinephrine' && w === 0 ? drugOffer(state, script, name) : null;
  if(!given.length){
    if(off && off.order){ openDrugQuestion(state, name); return 'No ' + name + ' yet, doctor — it can go in now. Shall I give it?' + drip; }
    if(off && off.why) return 'No ' + name + ' yet, doctor — ' + off.why + drip;
    if(name !== 'epinephrine' && r === 'notIndicated') return 'No ' + name + ' yet, doctor — it is not indicated now.' + drip;
    return 'No ' + (name === 'epinephrine' ? 'epinephrine' : name) + ' yet, doctor.' + drip;
  }
  const last = given[given.length - 1], ago = state.t - last.t;
  let line = (ago < 6 ? 'The last ' + label + ' went in just now, doctor' : capitalize(spokenTime(ago)) + ' since the last ' + label + ', doctor')
    + (given.length > 1 ? ' — ' + spoken(given.length) + ' doses so far.' : '.') + drip;
  if(name === 'epinephrine'){
    const onClock = !state.pulse && !state.ended && (isChild(script) || compressionsIndicated(state, script));
    if(!onClock) return line;
    if(w === 0){
      state.pendingQuestion = 'epi'; state.questionT = state.t; state.questionRhythm = state.rhythm;
      return line + ' It is due now — another epi?';
    }
    return w === Infinity ? line : line + ' The next is due in ' + spokenTime(w) + '.';
  }
  // (Only what the clock says — never the rhythm: "after the next shock" is said as the nurse's hold says it, conditionally.)
  if(off && off.order){ openDrugQuestion(state, name); return line + ' The next can go in now — shall I give it?'; }
  if(off && off.why) return line + ' ' + capitalize(off.why);
  if(r === 'max') return line + ' That is its maximum.';
  if(r === 'afterShock') return line + ' If it is still shockable after the next shock, the next dose can go in then.';
  if(r === 'clockAndShock' || r === 'clock') return line + ' The next can go in ' + spokenTime(w) + ' from now' + (r === 'clockAndShock' ? ', after the next shock if it is still shockable.' : '.');
  return line;
}
// R12 (Z2): THE CASE'S STANDARD DOSE OF A DRUG, as the page's drug button words it (codeDrugOrder) — the dose the next order
// should carry (expectedDoseMg), in the case's unit and on its first route. Null when the case has no rule or no single dose.
function drugOrderFor(state, script, name){
  if(name === 'epinephrine') return epiOrderFor(script);
  if(name === 'adenosine') return adenosineOrderFor(state, script);
  const rule = (script.drugs || {})[name];
  const mg = rule ? expectedDoseMg(state, script, name) : null;
  if(mg == null) return null;
  const route = (rule.route && rule.route[0]) || 'iv';
  return (DRUG_ALIASES[name] || [name])[0] + ' ' + (rule.unit === 'mEq' ? round2(mg) + ' mEq' : doseSaid(mg)) + ' ' + route.toUpperCase();
}
// R12 (Z2): WHETHER SHE OFFERS IT — a case drug that is due (the caller has asked readyIn): { order } when its standard dose would
// go in unflagged; { why } when it would not; null when there is nothing to say. Never reading the strip for the doctor: in a
// pulseless rhythm nobody has called, a drug whose use turns on the rhythm (amiodarone into PEA, magnesium outside torsades)
// is answered as before, "No amiodarone yet, doctor." — the same words in every rhythm, as "shock" is. In a CALLED shockable rhythm the
// antiarrhythmic waits for the third shock, as the first epinephrine waits for the second (the debrief coaches both).
function drugOffer(state, script, name){
  if(state.ended || name === 'epinephrine' || !(script.drugs || {})[name]) return null;
  const order = drugOrderFor(state, script, name);
  if(!order) return null;
  const dry = rh => { const was = state.rhythm; if(rh) state.rhythm = rh; try { return giveDrug(state, script, name, order, 'dry'); } finally { state.rhythm = was; } };
  if(!state.pulse && !heardName(state)){
    const v = Array.from(PULSELESS).map(rh => !!dry(rh).ok);
    if(v.some(x => x !== v[0])) return null;
  }
  const anti = name === 'amiodarone' || name === 'lidocaine';
  if(anti && !state.pulse && heardName(state) && SHOCKABLE.has(state.rhythm) && episodeDefibs(state).length < 3
     && !state.drugs.some(d => (d.name === 'amiodarone' || d.name === 'lidocaine') && d.pulseless && !d.infusion))
    return { why: 'in a shockable rhythm it goes in after the third shock.' };
  const d = dry();
  if(d.ok) return { order };
  const note = String(d.note || '').split(/(?<=[.!?])\s/)[0];
  return { why: note ? note.charAt(0).toLowerCase() + note.slice(1) : 'it is not indicated now.' };
}
// Her question about a drug she offered (R12, Z2): 'adenosine' (as her "ready for the 12"), else 'drug' with the drug named.
function openDrugQuestion(state, name){
  state.pendingQuestion = name === 'adenosine' ? 'adenosine' : 'drug';
  state.questionDrug = name; state.questionT = state.t; state.questionRhythm = state.rhythm; state.questionPulse = !!state.pulse;
}
// The shocks so far, and the next — the strip read only once the doctor has read it.
function shockAnswer(state, script){
  const d = episodeDefibs(state), last = d[d.length - 1];
  const so = !d.length ? 'No shock yet, doctor.'
    : (d.length === 1 ? 'One shock' : capitalize(spoken(d.length)) + ' shocks') + ' so far — the last at ' + last.joules + ' joules, ' + agoText(state.t - last.t) + '.';
  const w = readyIn(state, script, 'shock');
  if(!heardName(state)) return so + (w > 0 && w !== Infinity ? ' Rhythm check in ' + spokenTime(toCheckSec(state)) + '.' : '') + ' What is the rhythm, doctor?';
  if(!SHOCKABLE.has(state.rhythm)) return so + ' ' + capitalize(heardName(state)) + ' is not shockable, doctor.';
  return so + (w === 0 ? ' A shock is due now, doctor.' : w === Infinity ? '' : ' Next shock at the rhythm check in ' + spokenTime(w) + '.');
}
// "Stop bagging", "hold ventilations" — the order that turns it OFF (the actInner branch).
const HOLD_VENT_RE = /\b(stop|stopping|hold|holding|pause|pausing|turn off|discontinue)\b.*\b(bag\w*|bvm|ventilat\w*|ppv|positive pressure)\b/;
// An advanced airway by name (the SGA and tube branches of actInner), and the words that only set one up (round 8):
// "prepare to intubate", "get ready for RSI", "set up the LMA", "preoxygenate for intubation", "intubation kit",
// "RSI drugs", "ready to tube him". (Global, for replace: the caller tests what is left.)
const ADVANCED_AIRWAY_RE = /\b(?:lma|igel|i-gel|supraglottic|king tube|intubate|intubation|ett|endotracheal tube|rsi|et tube)\b|\btube (?:him|her|the patient|them)\b/;
// ROUND 9 (K6): "READY TO INTUBATE" IS THE GO-AHEAD. Round 8 read "ready to intubate", "I'm ready to intubate", "we are
// ready to intubate" and "ready for intubation" as setting up: no tube, no airway credit, in five cases (live intubated).
// Said by the one holding the laryngoscope they mean "now": they place the tube. Getting ready is still getting ready —
// "prepare to intubate", "set up for intubation", "get ready to intubate", "be ready to intubate".
const AIRWAY_PREP_RE = new RegExp('\\b(?:prepare|preparing|prep|prepping|get ready|getting ready|be ready|set up|setting up|setup|stand by|standby'
    + '|pre-?oxygenat\\w*|preox\\w*|draw up|drawing up)\\s+(?:to\\s+|for\\s+|before\\s+)?(?:an?\\s+|the\\s+)?'
    + '(?:intubat\\w*|rsi|rapid sequence(?:\\s+intubation)?|ett|et tube|endotracheal (?:tube|intubation)|tube|lma|igel|i-gel|supraglottic(?:\\s+airway)?|king tube)\\b'
    + '(?:\\s+(?:him|her|them|the (?:patient|baby|child)))?'
  + '|\\b(?:intubation|rsi|airway|ett|tube|lma)\\s+(?:kit|tray|cart|equipment|box|drugs|meds|medications|supplies)\\b'
    + '(?:\\s+(?:ready|out|open|to the bedside|at the bedside))?', 'g');
const PLACE_IT_RE = /^(?:(?:and|then|now|ok|okay|go ahead and)\s+)*(?:place|insert|put|pass|drop)\s+it(?:\s+in)?(?:\s+(?:now|please))*$/;
// A pulse or rhythm check asked for now (actInner's check branch; R10: and the leader's own pause for it).
// (R10: "check rhythm" too — the page's split drops "the", and "Stop CPR, check the rhythm." left its check unheard.)
const CHECK_ORDER_RE = /\b(pulse check|rhythm check|check (for )?a? ?pulse|check (the )?rhythm|feel for a pulse|is there a pulse|any pulse|do we have a pulse|palpate a pulse)\b/;

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
  // (Not "charge to 200 joules": that charges and delivers nothing — chargeOnly. Round 7: with a pulse too —
  // "charge to 120 joules" cardioverted at once while "charge to 120" charged and asked; a charge is a charge.)
  // Round 7: any number of joules — the infant's "3 joules", "6j", "3.5 joules" — and "please" after it; an
  // energy said as it is spoken ("one twenty", "two hundred") is read as digits in a defibrillator order or an
  // answer to her question (spokenJoules), never in a drug order.
  // "Synchronized?" is the perfusing patient's (round 6): open while there is a pulse and the case runs — and
  // while the tachycardia she asked about is still running (adenosine may have broken it since: a "yes" then
  // would cardiovert a sinus rhythm).
  // (R9, J2: and for a minute after she asked it, over the rhythm she asked it about — openQuestion.)
  openQuestion(state);
  const syncAsked = state.pendingQuestion === 'sync' && !!state.pulse && !state.ended && CARDIOVERTABLE.has(state.rhythm);
  if(state.pendingQuestion === 'sync' && !syncAsked) state.pendingQuestion = null;
  // (R8: and while a charge waits, or after a synchronized shock — where an energy on its own is heard, below.)
  const prevShock = state.shocks[state.shocks.length - 1];
  if((syncAsked || DEFIB_TALK_RE.test(s) || pendingCharge(state) || (prevShock && prevShock.sync && state.pulse)) && !findDrug(s)) s = spokenJoules(s);
  const bareKg = /^(?:use |give |deliver |do |try |go to |go up to |at )?\d+(?:\.\d+)?\s*(?:j|joules?)\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?(?: please)?$/.test(s);
  const bareJ = /^(?:use |give |deliver |do |try |go to |go up to |at )?\d+(?:\.\d+)?\s*(?:j|joules?)(?: please)?$/.test(s);
  const charge = chargeOnly(s);
  // (R8: before the rewrite — with a charge waiting an energy on its own charges again at it, below.)
  const saidOnly = energyOnly(s, script);
  if(bareKg || bareJ)
    s = (state.pulse ? 'synchronized cardioversion at ' : 'defibrillate at ') + s.replace(/^[a-z ]*?(?=\d)/, '').replace(/ please$/, '');
  // "200 joules synchronized", "200 J sync", "shock 150 joules synchronized" — the mode said after the energy (R8):
  // a synchronized shock (with no pulse, the sync-off defibrillation below). Both engines left them unheard.
  { const m = s.match(ENERGY_THEN_SYNC_RE); if(m) s = 'synchronized cardioversion at ' + m[1] + ' joules'; }
  // (R11: and the mode first, as one line — "sync on, 100 joules", "sync mode, 100 joules", "turn on sync at 100 J": the
  // synchronized shock at it. Neither engine understood them, and the patient was never cardioverted.)
  { const m = s.match(SYNC_THEN_ENERGY_RE); if(m) s = 'synchronized cardioversion at ' + m[1] + ' joules'; }
  // The nurse asks questions ("do you want another epi?") and a doctor answers them
  // with a word. "yes" used to fall through to the turn engine and do nothing — a
  // playtested run typed it twice and lost both turns. A bare yes/no is only ever an
  // answer to the last open question; with none open it stays unhandled.
  // The epi question is the ARREST's: answered only while she is pulseless and the code is running.
  // (achieveRosc and die close it; this is the second lock on the same door.)
  const epiAsked = state.pendingQuestion === 'epi' && !state.ended && (!state.pulse || (isChild(script) && compressionsIndicated(state, script)));
  if(state.pendingQuestion === 'epi' && !epiAsked) state.pendingQuestion = null;
  // (R11: her "ready for the 12" — adenosineReady; openQuestion has closed it if the tachycardia or the minute has gone.)
  const adenoAsked = state.pendingQuestion === 'adenosine' && !!state.pulse && !state.ended && CARDIOVERTABLE.has(state.rhythm);
  // (R12, Z2: her offer of another case drug — drugOffer; openQuestion has closed it once the pulse, the rhythm or its time went.)
  const drugAsked = state.pendingQuestion === 'drug' && !state.ended && !!state.questionDrug;
  // R12 (Z6): THE EPINEPHRINE QUEUED FOR AFTER THE SHOCK IS CALLED OFF BY ANY REFUSAL OF IT — "no epi", "hold the epi", "cancel
  // the epi", "don't give the epi": she said "Holding off on that, doctor." and gave it after the next shock anyway.
  if(state.epiAfterShock && negatedDrug(s) === 'epinephrine') state.epiAfterShock = null;
  // R12 (Z3): A DOSE, OR "PUSH", ANSWERS HER DRUG QUESTION — the drug, at the dose said (doseAnswerOrder) — before anything else
  // reads the line.
  { const qd = syncAsked ? null : epiAsked ? 'epinephrine' : adenoAsked ? 'adenosine' : drugAsked ? state.questionDrug : null;
    const order = qd ? doseAnswerOrder(state, script, qd, text) : null;
    if(order){
      state.pendingQuestion = null;
      if(qd === 'epinephrine') state.epiAfterShock = null;
      return { handled: true, events: giveDrug(state, script, qd, order) };
    } }
  // A LINE THAT OPENS WITH AN ANSWER (R8, Kim): "yes, shock", "go ahead and shock", "yes, sync" at "another epi?"
  // gave no epinephrine and left her question open (the page folds the "yes" into the call-out that follows it).
  // The open question is answered, and the rest of the line is its own order — before anything else reads the line.
  // (At "synchronized?" an energy, a sync or shock word, or a call-out after the "yes" is part of the answer — "yes,
  // 120", "yes, shock" — and the answers below read it whole. "Yes, epi 1 mg", "ok, hold the epi": the rest is about
  // the epinephrine itself, and it alone answers.)
  { const leadYes = (epiAsked || syncAsked) && !YES_RE.test(s) && !GO_AHEAD_RE.test(s) ? s.match(LEAD_YES_RE) : null;
    if(leadYes){
      // (R10, M5: "ok - no", "yes - wait": the punctuation after the yes is not a word.)
      const rest = leadYes[1].replace(/^[\s,.;:!?—–-]+/, '').trim();
      // (R11: "yes, after the shock", "ok, give it after the shock" — the shock, then the epinephrine: epiAfterTheShock.)
      if(epiAsked && epiAfterShockSaid(rest)) return epiAfterTheShock(state, script, now);
      // R9 (Kim's J1): ...but not when what follows it holds, says no, cancels, puts something first or asks.
      const intent = answerIntent(rest, text, syncAsked ? 'sync' : 'epi');
      if(intent) return notYet(state, script, syncAsked ? 'sync' : 'epi', intent, rest, now);
      // (R10: a yes after the yes — "yes, give it", "ok, go ahead", "yes, please do" — is the one yes.)
      if(YES_RE.test(rest) || GO_AHEAD_RE.test(rest)) return actInner(state, script, 'yes', now);
      const partOfAnswer = syncAsked && (DEFIB_TALK_RE.test(rest) || deliveryCallout(rest) || syncAnswer(rest)
        || energyAnswer(rest, script) != null || SYNC_MODE_RE.test(rest) || GO_AHEAD_RE.test(rest) || YES_RE.test(rest));
      if(!partOfAnswer){
        const out = [];
        const epiNamed = epiAsked && /\b(?:epi\w*|adrenalin\w*)\b/.test(rest);
        if(epiNamed) state.pendingQuestion = null;
        else { const a = actInner(state, script, 'yes', now); if(a && a.handled) out.push(...(a.events || [])); }
        // (R11: "yes, give epi", "yes, give epinephrine" — the dose she offered, as a bare yes gives: it went in with no dose.)
        const r = actInner(state, script, epiNamed ? epiAsOffered(script, rest) : rest, now);
        if(r && r.handled) out.push(...(r.events || []));
        return { handled: true, events: out };
      }
    } }
  if(DISARM_RE.test(s) && !/\b(?:and|then) (?:shock|defibrillate|deliver|cardiovert)/.test(s)){
    const had = !!pendingCharge(state);
    state.charged = null;
    if(state.pendingQuestion === 'sync') state.pendingQuestion = null;
    return { handled: true, events: [ev(state, 'note', had ? 'Charge dumped, doctor — nothing delivered.' : 'Nothing is charged, doctor.',
      Object.assign({ disarmed: true }, had ? { chargeEnd: 'dumped' } : {}))] };
  }
  // AN ORDER NOT TO SHOCK (round 7): "don't shock", "hold the shock", "no shock", "do not defibrillate", "not
  // shockable". Acknowledged, a charge waiting is dumped, her "synchronized?" is closed — and nothing is held:
  // after ROSC it was recorded as a shock held for the pulse, so the Code Record read "Shock held" for an order
  // NOT to shock. (Not a bare "no", "hold", "wait": those answer her questions, below.)
  const withholding = CODE_WITHHOLD_RE.test(text) && !CODE_HOLD_ACTION_RE.test(text) && !codeStopIsTreatment(script, s)
    && !BARE_NO_RE.test(s) && !HOLD_WORD_RE.test(s);
  // (R12, Z1: and a negation anywhere before the shock word it governs — "we're not shocking", "we are not charging", "no shock
  // for now", "we won't shock" — negatedElectricity.)
  if((withholding && /\b(?:shock\w*|defib\w*|charg\w*|cardiover\w*|zap)\b/.test(s)) || /\b(?:not|non)[ -]?shockable\b/.test(s) || negatedElectricity(text)){
    const had = !!pendingCharge(state);
    state.charged = null;
    if(state.pendingQuestion === 'sync') state.pendingQuestion = null;
    return { handled: true, events: [ev(state, 'note', had ? 'Holding the shock, doctor — charge dumped.' : 'Holding the shock, doctor.',
      Object.assign({ ack: 'hold' }, had ? { disarmed: true, chargeEnd: 'dumped' } : {}))] };
  }
  // "Never mind", "cancel that order", "abort", "belay that" — with a charge waiting, or her question open, they
  // call off the shock: the charge is dumped (they said "Holding off on that" and the next "clear" still shocked).
  if(GENERIC_CANCEL_RE.test(s) && (pendingCharge(state) || syncAsked)){
    const had = !!pendingCharge(state);
    state.charged = null; state.pendingQuestion = null;
    return { handled: true, events: [ev(state, 'note', had ? 'Charge dumped, doctor — nothing delivered.' : 'Holding off on that, doctor.',
      Object.assign({ ack: 'hold' }, had ? { disarmed: true, chargeEnd: 'dumped' } : {}))] };
  }
  // R12 (Z6): "EPI AFTER THE NEXT SHOCK", "give epi after the second shock" — said with no question of hers open — is the
  // epinephrine, queued for right after the next shock (as "give it after the shock" at her "another epi?" is). It was read as a
  // shock order and held for the clock, and the epinephrine was dropped. The shock is not ordered by it: it goes in when the
  // doctor calls it. (Shock words that put the shock first — "shock first, then epi" — are still the shock.)
  if(!epiAsked && !syncAsked && !state.pulse && !state.ended && findDrug(s) === 'epinephrine' && /\bafter\b/.test(s) && epiAfterShockSaid(s)){
    state.epiAfterShock = { t: state.t, episode: state.episode };
    return { handled: true, events: [ev(state, 'note', 'Epinephrine right after the next shock, doctor.', { ack: 'queued' })] };
  }
  // R12 (Z5): AT A SHOCK THAT IS DUE, WITH A CHARGE WAITING, THE GO-AHEAD IS READ WITH THE REST OF ITS LINE. "OK, shock at 360",
  // "OK, go up to 360", "Yes, 300 joules" put in the 200 J charged — the "ok" delivered before the energy was read (the page's
  // split). An energy said after the go-ahead wins: the charge goes in at it (joinAnswers keeps such a line whole; a hold, a
  // "no", "dump the charge" or a negation after the "ok" hold it — below, and above).
  { const m = !syncAsked && !epiAsked && !adenoAsked && !drugAsked ? s.match(LEAD_YES_RE) : null, c = m ? pendingCharge(state) : null;
    if(c && !c.sync && electricityDue(state, script)){
      const rest = m[1].replace(/^[\s,.;:!?—–-]+/, '').trim();
      const J = energyOnly(rest, script) != null ? energyOnly(rest, script) : energyStep(rest, script) != null ? energyStep(rest, script)
        : (asksForShock(rest) || CHARGE_RE.test(rest)) && !ESCALATE_RE.test(rest) ? shockEnergy(rest, script)
        : ESCALATE_RE.test(rest) ? (c.auto && !c.set ? nextDefibJoules(state, script) : nextDefibJoules(state, script, c.joules)) : null;
      if(J != null){ c.joules = J; c.set = true; return actInner(state, script, 'go ahead', now); }
    } }
  // THE PACER'S WORDS ARE NEVER A SHOCK (round 7, Kim). With a pulse: the pacer where the case paces, else there
  // is none. With no pulse there is nothing to pace — said without naming a rhythm (R8, Kim: "not in an arrest",
  // in every rhythm; "isn't used in torsades" was untrue, and the Hint offered pulseless torsades the pacer). The
  // torsades case's overdrive pacing is for runs that recur WITH a pulse: after ROSC its pacer answers (pacerHere).
  if(PACER_WORD_RE.test(stripPads(s)) && !HOLD_PACER_RE.test(s) && !CODE_WITHHOLD_RE.test(text)
     && !/\b(?:cpr|compressions?|chest)\b/.test(s)){
    if(!state.pulse)
      return { handled: true, events: [ev(state, 'withheld', 'Pacing isn\'t used in an arrest, doctor.')] };
    if(casePaces(state, script))
      return { handled: true, events: startPacing(state, script, ESCALATE_RE.test(s) || PACER_DIAL_RE.test(s) || /\b(?:more|increase|up)\b/.test(s)) };
    return { handled: true, events: [ev(state, 'withheld', 'We don\'t have a pacer on this patient, doctor.')] };
  }
  // THE MACHINE BY NAME (R8, Kim): the pads go on — never a shock (namesMachine).
  if(namesMachine(s)){
    const already = !!state.padsOn;
    state.padsOn = true;
    return { handled: true, events: [ev(state, 'pads', already ? 'Pads are already on, doctor.' : 'Pads on, defibrillator attached.')] };
  }
  // PREPARING FOR CARDIOVERSION (R9, Kim's J7 — cardiovertPrep): the pads on, sync on, her question open and the energy
  // kept; nothing delivered. The shock waits for the doctor's word after the sedation. Elsewhere, the pads.
  if(cardiovertPrep(s)){
    const already = !!state.padsOn;
    state.padsOn = true;
    if(state.pulse && !state.ended && CARDIOVERTABLE.has(state.rhythm)){
      const armed = pendingCharge(state), J = shockEnergy(s, script, true);
      state.syncMode = true;
      if(armed){ armed.sync = true; armed.modeOpen = false; if(J != null) armed.joules = J; }
      askSync(state, J != null ? J : armed ? armed.joules : null, false);
      return { handled: true, events: [ev(state, 'pads', 'Pads on, sync on — ready when you are, doctor.', Object.assign({ question: 'sync', syncOn: true }, J != null ? { joules: J } : {}))] };
    }
    return { handled: true, events: [ev(state, 'pads', already ? 'Pads are already on, doctor.' : 'Pads on, defibrillator attached.')] };
  }
  // "SHOCK IF VF" (R8, Kim) IS A CONDITION, AND "SHOCK AT THE NEXT CHECK" (R8) A TIME — R10 (P1, M4): one rule for both.
  // A pulse (for the condition), or a called rhythm that is not shockable: "Not shockable — holding." (R9 promised "Shock at
  // the rhythm check in N." into a called PEA.) readyIn 0: the shock now, as "shock" — uncalled whatever the strip shows,
  // since answering the condition would read it for the doctor (the first into an uncalled PEA goes in flagged, as "shock"
  // does there, and as on live); ∞: held for the rhythm, as "shock" is. While the next shock waits for the check: kept for
  // it, with no promise she will not keep (waitForCheckLine) — never held, never scored. R9 told the uncalled doctor "Will
  // do at the rhythm check if it is VF." and then only asked at the check what the rhythm was; R8 held both as early shocks
  // and FAILed rhythmChecks. ("If VF, shock" — the condition first — and "shock again at the next rhythm check if still in
  // VF" are the same order.)
  { const cond = SHOCK_IF_RE.test(s) || (state.condCueT === state.t && asksForShock(s) && !CHARGE_RE.test(s)),
      atCheck = asksForShock(s) && SHOCK_AT_CHECK_RE.test(s) && !state.pulse && !state.ended && !isNeonate(script);
    if(cond || atCheck){
      const wait = readyIn(state, script, 'shock');
      if((cond && state.pulse) || (!state.pulse && heardName(state) && !SHOCKABLE.has(state.rhythm)))
        return { handled: true, events: [ev(state, 'note', 'Not shockable — holding.', { ack: 'hold' })] };
      if(!state.pulse && !state.ended && !isNeonate(script) && wait > 0 && wait !== Infinity)
        return { handled: true, events: [ev(state, 'note', waitForCheckLine(state, wait), { ack: 'hold' })] };
      if(cond) s = /^if\b/.test(s) ? s.replace(/^.*?(?=\b(?:shock|defibrillate|defib)\b)/, '').trim() : s.replace(/\s*\bif\b.*$/, '').trim();
      s = s.replace(SHOCK_AT_CHECK_RE, ' ').replace(/\s+/g, ' ').trim();
    } }
  // ECHOES ARE NOT SECOND SHOCKS (R8, Kim — shockEcho): the same code second as a shock delivered or held, or the
  // doctor's own shock order just after the nurse fired a charge. A quiet acknowledgement: never held, never scored.
  { const echo = shockEcho(state, script, s);
    if(echo) return { handled: true, events: [ev(state, 'note', echo.text, { ack: 'echo', quiet: true })] }; }
  // AN ENERGY ON ITS OWN (R8, Kim). With a charge waiting and no question open — "200", "360", "yes 120", "go up to
  // 300", "try 300" — the team charges again at it: they were unheard, or they fired the charge at once. With nothing
  // waiting, at a tachycardia with a pulse, an energy with its unit is asked about — "Synchronized at N joules?" — not
  // delivered: "use 6 j" went in synchronized at 6 J into VT, out of band, and converted it.
  if(!syncAsked && saidOnly != null && !state.ended){
    const waiting = pendingCharge(state), prev = state.shocks[state.shocks.length - 1];
    if(waiting){
      waiting.joules = saidOnly; waiting.set = true;
      return { handled: true, events: [ev(state, 'note', 'Charging to ' + saidOnly + ' instead.', Object.assign({ charge: saidOnly }, waiting.sync ? { sync: true } : {}))] };
    }
    // (After a synchronized shock that did not convert the mode is settled: an energy on its own — "200", "use 200 j"
    // — is the next synchronized shock at it, as "try 200" is. Kim's AF run: "use 200 j" after "cardiovert" failed.)
    if(prev && prev.sync && state.pulse && CARDIOVERTABLE.has(state.rhythm) && !wantsUnsync(s)) s = 'synchronized cardioversion at ' + saidOnly + ' joules';
    else if((bareKg || bareJ) && state.pulse && CARDIOVERTABLE.has(state.rhythm)){
      askSync(state, saidOnly, true);
      return { handled: true, events: [ev(state, 'withheld', 'Synchronized at ' + saidOnly + ' joules, doctor?', { question: 'sync' })] };
    }
  }
  // "AGAIN" IS THE LAST THING AGAIN. With a pulse, straight after a synchronized shock that did not
  // convert, "hit him again" or "escalate the energy" is the next cardioversion one step up the sync
  // band — at a patient with a pulse an unsynchronized shock is the one thing it cannot mean. Only
  // the explicit words (defibrillate, unsynchronized) still reach the defibrillation branch. "Cardiovert
  // again" is the same step up (it went back to the bottom of the band, the energy that had just failed).
  // Round 7: "go up to 200", "try 200", "200 again" — an energy step with no unit — are the next shock of the
  // same kind as the last, at that energy: a synchronized one at the tachycardia it did not convert, a
  // defibrillation in an arrest that has had one. With no such shock they are no order at all.
  const step = !syncAsked ? energyStep(s, script) : null;
  const lastShock = state.shocks[state.shocks.length - 1];
  // (R8: "again", "go up", "higher" on their own too, and "again at 200 joules".)
  if(state.pulse && !state.ended && CARDIOVERTABLE.has(state.rhythm) && !wantsUnsync(s) && lastShock && lastShock.sync
     && (step != null || SYNC_AGAIN_RE.test(s)
       || (AGAIN_RE.test(s) && (asksForShock(s) || wantsSync(s) || /\bcardiover/.test(s) || shockEnergy(s, script, true) != null)))){
    const j = step != null ? step : shockEnergy(s, script, true);
    // (R9, J8: "same again", "again at the same energy" — the energy that just went in, not the next step.)
    s = 'synchronized cardioversion at ' + (j != null ? j : SAME_ENERGY_RE.test(s) ? lastShock.joules : nextSyncJoules(script, lastShock.joules)) + ' joules';
  } else if(step != null && !state.pulse && !state.ended && SHOCKABLE.has(state.rhythm) && episodeDefibs(state).length){
    s = (wantsSync(s) ? 'synchronized shock at ' : 'shock at ') + step + ' joules';
  }
  // (R11: "hit him again", "shock again" at a pulse and a rhythm that is neither shocked nor cardioverted — sinus tachycardia,
  // complete heart block — asks for a shock that never was: refused, as "charge the defibrillator" there is. It delivered a
  // flagged unsynchronized shock.)
  // (Once a shock has gone into this pulse anyway, the team's hold says it — heldShock: readyIn is Infinity.)
  if(state.pulse && !state.ended && !CARDIOVERTABLE.has(state.rhythm) && !SHOCKABLE.has(state.rhythm) && asksForShock(s) && /\bagain\b/.test(s)
     && !ESCALATE_RE.test(s) && !PACER_WORD_RE.test(stripPads(s)) && readyIn(state, script, 'shock') === 0)
    return { handled: true, events: [ev(state, 'withheld', 'There is a pulse, doctor, and a rate of ' + state.hr + ' — nothing to shock.')] };
  // MORE ENERGY (round 6 at a pulse; round 7, Kim, everywhere): a defibrillation only in an arrest with a
  // shockable rhythm that has already had one — otherwise her question, the pacer, or a plain line. Never a shock.
  // (After ROSC or a 'stable' ending the pacer still answers; the rest is held below with the shocks. Torsades
  // with a pulse is shocked unsynchronized, as ever. "Escalate the energy and shock" names the shock.)
  if(ESCALATE_RE.test(s) && !wantsUnsync(s)){
    if(state.pulse){
      if(state.flags.pacing || (bradycardic(state) && pacerHere(state, script))) return { handled: true, events: startPacing(state, script, true) };
      if(bradycardic(state)) return { handled: true, events: [ev(state, 'withheld', 'We don\'t have a pacer on this patient, doctor.')] };
      if(!state.ended && CARDIOVERTABLE.has(state.rhythm)){
        const armed = pendingCharge(state);
        askSync(state, armed ? armed.joules : null, true);
        return { handled: true, events: [ev(state, 'withheld', 'Synchronized, doctor — at what energy?', { question: 'sync' })] };
      }
      if(!state.ended && !SHOCKABLE.has(state.rhythm))
        return { handled: true, events: [ev(state, 'withheld', 'There is a pulse, doctor, and a rate of ' + state.hr + ' — nothing to shock.')] };
    } else if(!state.ended){
      // (Once a shock has gone into this rhythm the team holds any more, for the rhythm — the same hold, and the
      // same words, as "shock" here; the button reads it. Before that, a plain line that names no rhythm.)
      // R8, the blind rhythm: UNCALLED, the same answer in every pulseless rhythm — "No shock has gone in yet" until
      // one has, and then what "shock" does there (the next rung; held as "shock" is). VF said "say the energy" and
      // PEA "what is the rhythm?", which read the strip for the doctor at no cost.
      if(heardName(state) && !SHOCKABLE.has(state.rhythm))
        return { handled: true, events: [readyIn(state, script, 'shock') === Infinity ? heldShock(state, script, null)
          : ev(state, 'withheld', 'No shock for this rhythm, doctor.')] };
      if(!episodeDefibs(state).length && !DEFIB_WORD_RE.test(stripPads(s)))
        return { handled: true, events: [ev(state, 'withheld', 'No shock has gone in yet, doctor — say the energy.')] };
      // WITH A CHARGE WAITING, MORE ENERGY CHARGES AGAIN, A RUNG UP (R8, as an energy on its own does — H9): the machine
      // is turned up and re-charged, and the call-out or "shock" delivers it. "Turn up the energy" at the check, then
      // "shock" six seconds later, fired at once and then held the "shock" as a stacked shock. (A line that also says
      // "shock" is the shock, at the next rung — below.)
      const waiting = pendingCharge(state);
      // (The rung above the last defibrillation, as Kim's rule says — the team's own charge at the check is already
      // the next standard energy, a child's 4 J/kg; once the doctor has set the energy, a rung above that.)
      if(waiting && !waiting.sync && !DEFIB_WORD_RE.test(stripPads(s)) && !/\bagain\b|\bcharge (?:and|then) (?:shock|deliver)\b/.test(s)){
        const J = waiting.auto && !waiting.set ? nextDefibJoules(state, script) : nextDefibJoules(state, script, waiting.joules);
        const same = J === waiting.joules;
        waiting.joules = J; waiting.set = true;
        return { handled: true, events: [ev(state, 'note', same ? 'Charged to ' + J + ' joules, doctor.' : 'Charging to ' + J + ' instead.', { charge: J })] };
      }
    }
  }
  const armed = pendingCharge(state);
  // THE CALL-OUT WITH NOTHING CHARGED (round 7, Kim): a call-out, and nothing more — never a shock, never a
  // held shock, never scored. Straight after a shock it is that shock's own call-out ("defibrillate at 200
  // joules" … "everybody clear, shocking"); otherwise she says there is nothing to deliver. (With her
  // "synchronized?" open it is her answer — below. "Clear, shock" names the shock: a shock order.) (A shock order
  // just after a shock went in is that same shock: shockEcho, above.)
  if(!armed && !syncAsked && deliveryCallout(s) && (shockJustIn(state) || !/\bshock\b/.test(s)))
    return { handled: true, events: [ev(state, 'note', shockJustIn(state) ? 'Shock is in, doctor.' : 'Nothing is charged, doctor.',
      { ack: shockJustIn(state) ? 'echo' : 'callout', quiet: true })] };
  // A CALLED RHYTHM THAT IS NOT SHOCKABLE, A CHARGE STILL WAITING (R8): the reflexive "clear" (or "go ahead", "yes")
  // dumps it — "clear" after "this is PEA" put 200 J into the PEA the doctor had just named. ("Shock", "deliver the
  // shock", "clear, shock" are still shock orders: the first into PEA goes in, flagged, as "shock" does.)
  if(armed && !state.pulse && !state.ended && heardName(state) && !SHOCKABLE.has(state.rhythm) && !syncAsked
     && ((deliveryCallout(s) && !/\bshock\b/.test(s)) || GO_AHEAD_RE.test(s) || (YES_RE.test(s) && !epiAsked))){
    state.charged = null;
    return { handled: true, events: [ev(state, 'note', 'It\'s not shockable, doctor — dumping the charge.', { ack: 'hold', disarmed: true, chargeEnd: 'dumped' })] };
  }
  // ...and the call-outs of a line whose shock was just held for the clock are that same held order ("defibrillate
  // at 200 joules, everybody clear, shocking" mid-cycle with a pre-charge waiting was held twice and counted as two
  // early shocks): acknowledged, the charge still waiting.
  if(armed && !syncAsked && (deliveryCallout(s) || GO_AHEAD_RE.test(s)) && state.lastHeld && state.lastHeld.kind === 'shock'
     && state.t - state.lastHeld.t <= CALLOUT_ECHO_SEC && !state.shocks.some(x => x.t >= state.lastHeld.t)){
    const wait = readyIn(state, script, 'shock');
    if(wait > 0 && wait !== Infinity)
      return { handled: true, events: [ev(state, 'note', 'Not yet — rhythm check in ' + spokenTime(wait) + '.', { ack: 'echo', quiet: true })] };
  }
  // ...and so does a patient the case converted to 'stable'. Only 'rosc' was gated, so
  // after Kim's cardioversion an unsynchronized shock still reached deliverShock and was
  // logged as a delivered-but-flagged shock at a perfusing patient.
  if(state.ended && state.ended !== 'death' && !postRoscAllows(s))
    return { handled: true, events: [postRoscRefusal(state, s)] };
  // (The nurse's questions — "another epi?", "synchronized?" — are read at the top: epiAsked, syncAsked.)
  // THE ANSWERS (round 7, Kim). "Yes", "do it", "go ahead" answer the question she has open, and are never
  // delivery words — "yes" to "another epi?" with a pre-charge waiting delivered the charge, 84 s early, and no
  // epinephrine went in. Her "synchronized?" is answered by yes, sync, an energy, "shock", a call-out, "go
  // ahead" — the synchronized shock (the patient has a pulse); by "no", "not synchronized", "defibrillate" —
  // an unsynchronized one; by "hold", "wait", "not yet" — nothing, and the question stays.
  const yes = YES_RE.test(s) && !GO_AHEAD_RE.test(s), goAhead = GO_AHEAD_RE.test(s);
  let goAheadNow = false;               // R11: a yes that is the go-ahead on a charge waiting (below)
  const no = BARE_NO_RE.test(s), wait = HOLD_WORD_RE.test(s);
  // (R12: a lead yes that holds or says no — "ok, wait", "yes, not yet", "ok, no" — to her offer of a drug.)
  const leadIntent = (adenoAsked || drugAsked) ? (m => { const i = m ? answerIntent(m[1], text, 'drug') : null; return i === 'question' ? null : i; })(s.match(LEAD_YES_RE)) : null;
  let answered = false, via = null;     // via 'chargeNow': a charge made when the shock was due (below)
  const lead = [];                      // what she says before the shock (sync won't fire with no pulse)
  if(syncAsked){
    const ask = state.syncAsk || {};
    const said = shockEnergy(s, script, true), heard = said != null ? said : energyAnswer(s, script);
    const J = heard != null ? heard : ask.joules != null ? ask.joules : armed && armed.joules != null ? armed.joules : null;
    const at = J != null ? ' at ' + J + ' joules' : '';
    // (R9: a hold keeps her question — the doctor is saying "not yet", not "no". R10: and restarts it, and the charge.)
    if(wait){ holdTheShock(state); return { handled: true, events: [ev(state, 'note', 'Holding, doctor.', { ack: 'hold' })] }; }
    // NO MEANS DON'T SHOCK (R8, Kim). "No", "no thanks", "nope", "not synchronized" — and the page's split of "no, not
    // yet", "no, wait", "no, don't shock", "no, dump the charge", "no, give adenosine first" — gave an UNSYNCHRONIZED
    // shock into a patient with a pulse. A decline delivers nothing: the question closes, sync goes off, a charge
    // waiting is dumped, and the rest of the line is its own order. Only the words that NAME the unsynchronized
    // shock give one, flagged: "unsynchronized", "unsync", "defibrillate", or a shock with "not synchronized".
    const explicitUnsync = UNSYNC_RE.test(s) || DEFIB_VERB_RE.test(stripPads(s)) || (NOT_SYNC_RE.test(s) && asksForShock(s));
    const decline = !explicitUnsync ? s.match(DECLINE_RE) : null;
    if(no || decline){
      const had = !!armed;
      state.pendingQuestion = null; state.syncMode = false; state.charged = null;
      const out = [ev(state, 'note', 'Holding — no shock.', Object.assign({ ack: 'hold', declined: true }, had ? { disarmed: true, chargeEnd: 'dumped' } : {}))];
      // (R9, Kim's J3: what follows the "no" is carried out only when it is an order — orderAfterNo. "No epi", "no
      // amiodarone", "no bagging" did the thing the doctor had said no to.)
      const paused = /^\s*(?:no thanks|no thank you|not synchroni[sz]ed|not synch?|no synchroni[sz]ation|no synch?|nope|nah|negative|no)\s*[,.;:!—–-]/i.test(String(text));
      const rest = decline ? orderAfterNo(decline[1], paused) : '';
      const res = { handled: true, events: out };
      if(rest){ const r = actInner(state, script, rest, now); if(r && r.handled) out.push(...(r.events || [])); else res.passOn = rest; }
      return res;
    }
    if(explicitUnsync && asksForShock(s)){
      state.pendingQuestion = null; answered = true;
      if(!(asksForShock(s) && said != null)) s = 'unsynchronized shock' + at;
    } else if(!CHARGE_RE.test(s) && !ESCALATE_RE.test(s)
       && (yes || goAhead || syncAnswer(s) || syncAnswer(withoutCallout(s)) || heard != null || deliveryCallout(s) || asksForShock(s) || SYNC_MODE_RE.test(s))){
      // (R10, M5: the call-outs ride with the answer — "Yes, synchronized, everybody clear." reached no branch, and the other
      // engine reported an unsynchronized shock.)
      state.pendingQuestion = null; answered = true;
      s = 'synchronized cardioversion' + at;
    }
  } else if(adenoAsked && (yes || goAhead || ADENO_YES_RE.test(s))){
    state.pendingQuestion = null;
    return { handled: true, events: giveDrug(state, script, 'adenosine', adenosineOrderFor(state, script)) };
  } else if((adenoAsked || drugAsked) && (no || wait || negatedDrug(s) === (adenoAsked ? 'adenosine' : state.questionDrug) || leadIntent)){
    // (R12: her offer of any drug, as her "ready for the 12": a no, or the drug refused, closes it; a hold — "wait", "ok, not
    // yet" — keeps it for the yes after the pause.)
    const nm = adenoAsked ? 'adenosine' : state.questionDrug;
    const keep = wait || leadIntent === 'hold' || leadIntent === 'first';
    if(!keep) state.pendingQuestion = null;
    return { handled: true, events: [ev(state, 'note', 'Holding the ' + nm + ', doctor.', { ack: 'hold' })] };
  } else if(epiAsked && epiAfterShockSaid(s)){
    // R11 (Kim): "GIVE IT AFTER THE SHOCK", "AFTER THE SHOCK", "LET'S SHOCK FIRST" at "another epi?" gave the shock and the
    // epinephrine never came. The shock goes in (or is held, as "shock" is), and the dose right after it.
    return epiAfterTheShock(state, script, now);
  } else if(epiAsked && (yes || goAhead)){
    state.pendingQuestion = null;
    return { handled: true, events: giveDrug(state, script, 'epinephrine', epiOrderFor(script)) };
  } else if(epiAsked && findDrug(s) === 'epinephrine' && !negatedDrug(s) && !CODE_WITHHOLD_RE.test(text) && epiAsOffered(script, text) !== text){
    // (R11: "give epi", "push the epi" to her "another epi?" — the dose she offered; it went in with no dose.)
    state.pendingQuestion = null;
    return { handled: true, events: giveDrug(state, script, 'epinephrine', epiAsOffered(script, text)) };
  } else if(epiAsked && (no || negatedDrug(s) === 'epinephrine')){
    // (R9, J3: "no epi", "let's hold off on the epi", "skip the epi" are her answer too.)
    state.pendingQuestion = null;
    return { handled: true, events: [ev(state, 'note', 'Holding the epinephrine for now.', { ack: 'hold' })] };
  } else if(epiAsked && wait){
    // (R10, M2: a pause — "hold on", "wait", "one sec", "not yet" — keeps her question: the yes after it gives the dose.)
    return { handled: true, events: [ev(state, 'note', 'Holding the epinephrine for now.', { ack: 'hold' })] };
  } else if(yes){
    // No question open: with nothing charged "yes" is not an order; with a charge waiting it is not the shock.
    // R8 (Kim): she never invites a shock that is not due — mid-cycle "call the shock" was answered, and held.
    // R9 (Kim's J8): with nothing charged and nothing asked, a quiet "Okay, doctor." while the case runs — the turn
    // engine's "Not understood" for a doctor's "ok" read as an error. (After ROSC the turn engine may have asked.)
    if(!armed) return state.ended ? { handled: false } : quietOk(state);
    // (R10, P1: readyIn says when, called or not — R9's "check window" for the uncalled rhythm is gone.)
    const w = readyIn(state, script, 'shock');
    // R11 (P3): IN THE ARREST, WITH THE SHOCK DUE, "YES", "OK", "DO IT", "GO" ON A CHARGE WAITING IS THE GO-AHEAD. After "Shockable
    // — charging, doctor." a doctor's "ok" or "yes" got "Still charged, doctor — call the shock." and nothing went in; "OK,
    // shock" (split by the page) was told the same before its "shock". Delivered, as "go ahead" is. (At a pulse the words for
    // the shock are still asked for: the patient may not be sedated.)
    if(w === 0 && !state.pulse && !state.ended) goAheadNow = true;
    else return { handled: true, events: [ev(state, 'note', w === Infinity ? 'Still charged, doctor.'
      : w > 0 ? 'Charged — shock at the rhythm check in ' + spokenTime(w) + '.' : 'Still charged, doctor — call the shock.', { ack: 'charged' })] };
  } else if(wait || (armed && !syncAsked && !epiAsked && leadHold(s, text))){
    // (R10, M5: "ok wait", "okay, hold on" with a charge waiting and no question open — a hold; the charge kept.)
    if(!armed) return { handled: false };
    if(state.pulse) holdTheShock(state);
    return { handled: true, events: [ev(state, 'note', 'Holding — still charged, doctor.', { ack: 'hold' })] };
  } else if(goAhead && !armed) return state.ended ? { handled: false } : quietOk(state);
  else if(no) return { handled: false };
  // A withheld order is not an order, and this must sit ABOVE every branch that
  // performs something — placed lower, "hold the shock" still shocked, because
  // defibrillation is matched first. The one exemption is holding an action already
  // running (compressions, pacing): that is an instruction to the team, not a refusal.
  // A bare "no"/"not yet" is the ANSWER to the nurse's open question (above), which consumes the
  // question. Guarding it here left the question open, so a later "yes" gave an epi nobody had just
  // been offered. (An order not to shock was acknowledged above. Round 7: one that declines her
  // "synchronized?" — "no, adenosine instead" — closes it, and a charge waiting for it is dumped.)
  // (R9, Kim's J3: a drug named to be refused anywhere in the line — "let's hold off on the epi", "skip the amiodarone" —
  // is this too: never given, never held as an early dose. negatedDrug.)
  if(!answered && ((CODE_WITHHOLD_RE.test(text) && !CODE_HOLD_ACTION_RE.test(text) && !codeStopIsTreatment(script, s)) || negatedDrug(s))){
    const dumped = syncAsked && !!armed;
    if(syncAsked){ state.pendingQuestion = null; if(dumped) state.charged = null; }
    return { handled: true, events: [ev(state, 'withheld', 'Holding off on that, doctor.', dumped ? { disarmed: true, chargeEnd: 'dumped' } : {})] };
  }
  // A CHARGE: charged, said, nothing delivered — never a shock held or given (chargeOnly). After ROSC it was
  // refused above with the shocks. Round 7 (Kim): a charge when the shock is due NOW (state a) is delivered at
  // once, as live did — "Charged to 200 joules — everyone clear — shock delivered" — so a doctor who charges at
  // the check is never left waiting for a call-out. At the energy said, else the charge's already waiting.
  // R8, THE BLIND RHYTHM (Kim): a CALLED rhythm that is not shockable — nothing to charge for, nothing arms. Otherwise
  // (R10, P1) a charge is exactly a "shock" wherever readyIn('shock') is 0 — called or not, in every pulseless rhythm (the
  // first into an uncalled PEA goes in flagged, as that shock does, and as live's did) — and a pre-charge wherever it is not:
  // the same words in every rhythm. (R9's J5 fired an uncalled charge only in the cycle's "check window": "charge to 200"
  // at 0:30 in uncalled VF waited for a check that never delivered it, and the debrief said "Never defibrillated".)
  if(charge){
    if(!state.pulse && !state.ended && heardName(state) && !SHOCKABLE.has(state.rhythm))
      return { handled: true, events: [ev(state, 'withheld', 'It\'s not shockable, doctor — no charge.')] };
    if(!electricityDue(state, script)) return { handled: true, events: [chargeNote(state, script, s)] };
    const said = shockEnergy(s, script), J = said != null ? said : armed && armed.joules != null ? armed.joules : null;
    if(wantsSync(s)) lead.push(ev(state, 'note', SYNC_OFF_TEXT, { syncOff: true }));
    via = 'chargeNow';
    s = 'shock' + (J != null ? ' at ' + J + ' joules' : '');
  }
  // THE CHARGE, DELIVERED (round 6, chargeNote). While a charge waits, the call-outs deliver it, and so
  // does a plain "shock" (and "go ahead", with no question open) — at the charged energy unless another is
  // said; a synchronized charge goes in synchronized ("shock" in sync mode is a synchronized shock).
  // "Defibrillate", "unsynchronized", "synchronized" and an energy are still what they say (round 7: words win —
  // "shock at max energy" went in at the 120 charged). Every hold still applies.
  // "Sync mode on", "turn on sync": at a tachycardia with a pulse the defibrillator goes into sync and she
  // asks for the energy. Until the next shock, a charge is a synchronized charge and "shock" a synchronized
  // shock — as on the machine. With no pulse there is nothing for it to find (round 7).
  // A CALL-OUT BEFORE THE SHOCK IS DUE (R9, Kim's J6). "Hands off", "oxygen away", "everyone off the bed", "clear" with a
  // pre-charge waiting mid-cycle were held as early shocks and FAILed rhythmChecks — and in COACHED they are said before the
  // leader has read the strip. A call-out is not the order to shock: she keeps the charge for the check and says so,
  // quietly. Never held, never scored. R10 (P1): readyIn decides, called or not — 0, it delivers, as ever; while the next shock
  // waits for the check, the quiet line ("go ahead" too); ∞ (no more electricity into this rhythm), held for the rhythm
  // below, as "shock" is — never a promise to shock at a check. ("Clear, shock" names the shock itself: a shock order, below.)
  if(!via && armed && !state.pulse && !state.ended && !syncAsked && (deliveryCallout(s) || goAhead) && !/\bshock\b/.test(s)){
    const w = readyIn(state, script, 'shock');
    if(w > 0 && w !== Infinity)
      return { handled: true, events: [ev(state, 'note', 'Charged — shock at the rhythm check in ' + spokenTime(w) + '.', { ack: 'charged', quiet: true })] };
  }
  const syncOn = !!state.syncMode && !!state.pulse && !state.ended;
  if(!via && !answered && state.pulse && !state.ended && SYNC_MODE_RE.test(s) && CARDIOVERTABLE.has(state.rhythm)){
    state.syncMode = true;
    if(armed) armed.sync = true;
    askSync(state, armed ? armed.joules : null, false);
    return { handled: true, events: [ev(state, 'note', 'Sync is on, doctor — at what energy?', { question: 'sync' })] };
  }
  if(!via && !state.pulse && !state.ended && SYNC_MODE_RE.test(s))
    return { handled: true, events: [ev(state, 'note', SYNC_OFF_TEXT, { syncOff: true, ack: 'sync' })] };
  const explicitDefib = wantsUnsync(s);
  // (In an arrest "hit him again", "shock again" name the next rung — R8 — not the charge's energy.)
  if(!via && (armed || syncOn) && !ESCALATE_RE.test(s) && !(!state.pulse && AGAIN_RE.test(s))
     && ((armed && (deliveryCallout(s) || goAhead || goAheadNow)) || (asksForShock(s) && !explicitDefib))){
    if(armed && (deliveryCallout(s) || goAhead || goAheadNow)) via = 'callout';
    const said = shockEnergy(s, script, !!state.pulse), J = said != null ? said : armed ? armed.joules : null;
    s = ((wantsSync(s) || (armed ? armed.sync : syncOn)) && !explicitDefib ? 'synchronized cardioversion' : 'shock') + (J != null ? ' at ' + J + ' joules' : '');
  }
  // NO PULSE, NOTHING TO SYNCHRONIZE TO (round 7, Kim): "synchronized shock at 200", "sync 200", "cardiovert" in
  // VF went in as a synchronized shock into VF — flagged, wasted, the ROSC two minutes late. The machine would
  // not fire; the team switches sync off, says so, and defibrillates (with the shock's timing).
  if(!state.pulse && !state.ended && !UNSYNC_RE.test(s) && (wantsSync(s) || /\bcardiover/.test(s))
     && (asksForShock(s) || /\bcardiover/.test(s) || /\b(?:synchroni[sz]\w*|synch?)\b\s*(?:at\s*)?\d/.test(s))){
    const J = shockEnergy(s, script);
    lead.push(ev(state, 'note', SYNC_OFF_TEXT, { syncOff: true }));
    s = 'defibrillate' + (J != null ? ' at ' + J + ' joules' : '');
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
  // PADS ARE NOT A SHOCK. "Place the defib pads" reached the branch below on the word "defib"
  // and shocked the patient — then flagged the player for an inappropriate shock (measured
  // 2026-09-18 on resus-atls-penetrating). "defib pads", "defibrillation pads", "pacing pads"
  // NAME the pads; they are not an instruction to shock. So the pads phrase is read as a noun
  // first, and only a real instruction ("shock", "clear", "at 200 J", "defibrillate") shocks.
  // An order that is ONLY about pads places them; one that also shocks still shocks.
  const sNoPads = s.replace(/\b(?:defib(?:rillat\w*)?|pacing|pacer|external|transcutaneous)\s+pads?\b/g, ' pads ');
  if(/\bpads?\b/.test(sNoPads)){
    // (Round 10, P3: and the words of a request — "let's apply pacer pads", "could you put the pads on?" — are the order.)
    const rest = sNoPads.replace(/\b(pads?|place|put|apply|attach|stick|get|hook up|connect|the|a|an|set of|some|on|onto|to|chest|him|her|them|patient|please|now|anterior|lateral|posterior|anterolateral|anteroposterior|ap|al|position|positioned|and|let s|lets|let us|can|could|would|will|may|shall|you|we|i|someone)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ').trim();
    if(!rest){
      const already = !!state.padsOn;
      state.padsOn = true;
      // (R8: one line for the pads and the machine by name — namesMachine.)
      return { handled: true, events: [ev(state, 'pads', already
        ? 'Pads are already on, doctor.'
        : 'Pads on, defibrillator attached.')] };
    }
  }
  // "UNSYNCHRONIZED CARDIOVERSION" IS A DEFIBRILLATION. The cardioversion noun sent it to the sync
  // branch, which delivered a SYNCHRONIZED shock and flagged it "a pulseless rhythm needs
  // unsynchronized defibrillation" — the very thing the player asked for — and it never counted as
  // a defibrillation. "un-synchronized shock" went the same way on its hyphen. The word decides,
  // and it takes this branch's timing hold with it.
  const unsync = UNSYNC_RE.test(s);
  // (asksForShock is the post-ROSC refusal's test too: one set of words for a shock.)
  // (Round 7: "synchronize", "synch", "synchronised" are sync words too — wantsSync.)
  if(asksForShock(s) && (unsync || !(wantsSync(s) || /\bcardiover/.test(s)))){
    // One shock, then two minutes on the chest to the rhythm check (see readyIn) — and no second
    // shock into a rhythm that is not shockable (heldShock, reason 'notShockable').
    // The energy said — read from the order as routed (an energy on its own, a charge's call-out, arrive
    // rewritten above) — else the unsynchronized charge's (round 6: "charge to 200", then "shock" went in
    // at the default 360).
    const said = shockEnergy(s, script);
    // (R8, Kim: "increase the energy", "more energy", "hit him again" in an arrest — the next rung above this arrest's
    // last defibrillation; the child's went back to 2 J/kg after 4.)
    // (R9, Kim's J8: "shock again at the same energy", "same energy" — the last one's energy again; they climbed.)
    const lastDefib = episodeDefibs(state).slice(-1)[0];
    const same = said == null && !state.pulse && !!lastDefib && SAME_ENERGY_RE.test(s);
    const climb = !same && said == null && !state.pulse && (ESCALATE_RE.test(s) || AGAIN_RE.test(s)) && episodeDefibs(state).length > 0;
    // (R11: a child's shock with no energy said is the next rung of the ladder — the Defibrillate button's and the team's own
    // charge's — not 2 J/kg again: "VF, shock" at the second check put 48 J into a 24-kg child after a 48 J shock.)
    const joules = said != null ? said : same ? lastDefib.joules : climb ? nextDefibJoules(state, script)
      : armed && !armed.sync && !ESCALATE_RE.test(s) ? armed.joules
      : !state.pulse && ((script.shock || {}).energy || {}).perKg ? nextDefibJoules(state, script) : null;
    // A SHOCK WITH NO WORD FOR THE MODE, AT A PULSE (round 7, Kim): she asks — "synchronized?" — and keeps the
    // energy for the answer. "Shock 200 joules" at atrial fibrillation with a pulse went in unsynchronized and
    // flagged; the doctor's word was only ever missing the mode. "Defibrillate", "unsynchronized" and an
    // unsynchronized charge still say it: one flagged shock, then held (A12).
    // (After one has already gone in, heldShock holds it and asks the same — the page's button reads that hold.)
    const hold = heldShock(state, script, joules);
    if(hold) return { handled: true, events: lead.concat(hold) };
    // (R9, J2: a charge whose mode she asked about and nobody answered — her question has closed — is asked about again,
    // never delivered unsynchronized by default.)
    if(state.pulse && !state.ended && CARDIOVERTABLE.has(state.rhythm) && !wantsUnsync(s) && !(armed && !armed.sync && !armed.modeOpen)){
      askSync(state, joules, true);
      return { handled: true, events: lead.concat(ev(state, 'withheld', 'There is a pulse, doctor — synchronized' +
        (joules != null ? ', at ' + joules + ' joules' : '') + '?', { question: 'sync' })) };
    }
    // A shock ordered in the last seconds of the cycle IS the rhythm check: the team pauses, reads
    // the rhythm and shocks — the same bookkeeping as the two-minute mark, and the next cycle stays
    // on the two-minute grid, so shocking the moment it is allowed never shortens the cycles.
    const pre = [];
    if(!state.pulse && !isNeonate(script) && state.cycleT >= DUE && SHOCKABLE.has(state.rhythm)){
      state.cycleT -= CYCLE_SEC;
      pre.push(...closeCycle(state, script));
      // `heldShock: 'pulse'` says it without the sentence: the page reads the field, not the words.
      if(state.ended || state.pulse) return { handled: true, events: lead.concat(pre, ev(state, 'note', 'Holding the shock — there is a pulse.', { heldShock: 'pulse' })) };
    }
    const dsed = /\b(double|dual)\b.*\bsequential\b|\bdsed\b|\bsequential (defib|shock)/.test(s);
    const out = lead.concat(pre, deliverShock(state, script, joules));
    const firstShock = out.find(e => e.kind === 'shock');
    if(dsed && firstShock) firstShock.text = 'Double sequential defibrillation — second set of pads anterior-posterior, both charged, fired together. ' + firstShock.text;
    // The charge that went in at once (state a): said as one breath, as live said it, and remembered — the
    // "clear", "shocking" or "shock" that follows it is this shock (shockEcho), never a second one.
    const rec = state.shocks[state.shocks.length - 1];
    if(via === 'chargeNow' && firstShock){
      firstShock.text = 'Charged to ' + rec.joules + ' joules — everyone clear — '
        + firstShock.text.charAt(0).toLowerCase() + firstShock.text.slice(1);
      firstShock.chargeNow = true;
    }
    if(firstShock && (via === 'chargeNow' || rec.spentCharge)) markChargeShot(state, firstShock, via === 'chargeNow' || via === 'callout');
    if(rec) delete rec.spentCharge;
    // (R11: the epinephrine the doctor asked for "after the shock" — epiAfterTheShock — right after it, while the arrest runs.)
    const q = state.epiAfterShock;
    if(q && firstShock){
      state.epiAfterShock = null;
      if(!state.pulse && !state.ended && q.episode === state.episode && !state.drugs.some(d => d.name === 'epinephrine' && !d.infusion && d.t >= q.t)){
        out.push(...giveDrug(state, script, 'epinephrine', epiOrderFor(script)));
        state.epiQueuedAt = state.t;
      }
    }
    return { handled: true, events: out };
  }
  // A PLANNED CHECK IS A PLAN (R9, Kim's J4 — plannedCheck): acknowledged, never held, never scored.
  { const plan = plannedCheck(state, script, s); if(plan) return { handled: true, events: plan }; }
  // CPR
  if(/\b(start|resume|continue|begin)\b.*\b(cpr|compressions)\b|\bcpr\b|\bcompressions\b|\bhands on the chest\b/.test(s) && !/\b(stop|hold|pause)\b/.test(s)){
    // COMPRESSIONS ARE FOR NO PULSE — or, in a child or a newborn, a pulse under sixty (PALS: with
    // poor perfusion despite oxygenation and ventilation; NRP: after 30 seconds of ventilation). With a
    // pulse and a rate above that the team does not start them, as after ROSC: the asthmatic child at
    // 168 was compressed, credited the CPR critical action, and scored "100% of the pulseless time"
    // with no pulseless time at all. Said by the numbers, not the rhythm — that is the doctor's call.
    if(state.pulse && !(isChild(script) && state.hr > 0 && state.hr < 60))
      return { handled: true, events: [ev(state, 'withheld', 'There is a pulse, doctor — rate ' + state.hr +
        (state.bpSys > 0 ? ', pressure ' + state.bpSys : '') + '. No compressions' +
        (isChild(script) ? ' unless the rate falls under 60.' : ' while there is a pulse.'))] };
    state.cpr = true;
    return { handled: true, events: [ev(state, 'cpr', 'Compressions running — hard and fast, full recoil.', { on: true })] };
  }
  // THE LEADER'S OWN PAUSE FOR THE CHECK (R10, M3). "Pause compressions for a rhythm check", "stop CPR and check the
  // rhythm" in one breath is the check (below): held mid-cycle with the chest kept on, the check itself in its own seconds —
  // where it was only "Compressions held.", and the check two minutes on found "no compressions running". Split ("stop CPR"
  // … "check the rhythm"), the pause said in the check's own seconds is the pause for it: that check is not one reached with
  // no compressions running, and the team goes back on the chest after it (closeCycle).
  // R11 (Kim): THE LEADER'S PAUSE A FEW SECONDS EARLY IS HELD. "Stop CPR, check the rhythm", "hold CPR, pulse check", "stop
  // compressions" said in the last EARLY_PAUSE_SEC before the check's window (cycle 84-107) stopped the chest; the check was
  // held as early and nobody went back on, so the check found "no compressions running" and the debrief FAILed where live
  // did not. The team stays on the chest until the check — "Staying on the chest — the check is in N." — never held as an
  // order, never scored. (Earlier in the cycle a pause is still a pause; said in the same breath as a check the team holds,
  // it is held with it: the check branch below. A code being stopped for good is not a pause.)
  const arrestHere = !state.pulse && !state.ended && !isNeonate(script);
  if(/\b(stop|hold|pause)\b.*\b(cpr|compressions)\b/.test(s) && !(arrestHere && CHECK_ORDER_RE.test(s))){
    if(arrestHere && state.cpr && state.cycleT < DUE && state.cycleT >= DUE - EARLY_PAUSE_SEC && !STOP_FOR_GOOD_RE.test(s))
      return { handled: true, events: [ev(state, 'note', 'Staying on the chest — the check is in ' + spokenTime(toCheckSec(state)) + '.', { ack: 'hold', earlyPause: true })] };
    if(arrestHere && state.cycleT >= DUE) state.cprPausedForCheck = state.cycle;
    // (Remembered for this code second: a check said with it and held takes the pause back — the check branch.)
    state.cprPause = arrestHere && state.cpr ? { t: state.t } : null;
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
  if(HOLD_VENT_RE.test(s)){
    state.flags.ppv = false;
    return { handled: true, events: [ev(state, 'airway', 'Holding ventilations, doctor.', { on: false })] };
  }
  // rhythm / pulse check
  if(CHECK_ORDER_RE.test(s)){
    // Mid-cycle it is a pause the algorithm does not want, and it was a shortcut: a check straight
    // after the treatment ran the ROSC rows six seconds in. Now a check is held mid-cycle; at the
    // start of an arrest it confirms it; straight after the team's own check it repeats the
    // finding; only at the end of a cycle does it close the cycle and find a pulse.
    // (R11: the pause said in the same breath — "stop CPR, check the rhythm", split by the page — was FOR this check: held
    // with it, the team back on the chest before she says why.)
    const paused = !!state.cprPause && state.cprPause.t === state.t && !state.cpr && !state.pulse && !state.ended
      && !!readyIn(state, script, 'check') && !checkWindow(state, script).justChecked;
    if(paused){ state.cpr = true; state.cprPause = null; }
    const hold = heldCheck(state, script);
    if(hold) return { handled: true, events: paused
      ? [ev(state, 'cpr', 'Staying on the chest — the check is in ' + spokenTime(toCheckSec(state)) + '.', { on: true, earlyPause: true }), hold] : [hold] };
    if(paused) state.cpr = false;
    const win = checkWindow(state, script);
    const finding = checkFinding(state, script);
    if(win.justChecked)
      return { handled: true, events: [ev(state, 'note', 'We just checked, doctor — ' + finding.charAt(0).toLowerCase() + finding.slice(1))] };
    // (Confirming the arrest at a called shockable rhythm with the shock due, the team charges as at a check — R8.)
    if(win.confirm){ const e = ev(state, 'check', finding); teamCharge(state, script, e); return { handled: true, events: [e] }; }
    // At the rhythm check the player's check IS the check: it closes this cycle on the two-minute
    // grid, so the team does not pause again seconds later, and the next shock is due.
    if(!state.pulse && !isNeonate(script)){
      state.cycleT -= CYCLE_SEC;
      return { handled: true, events: closeCycle(state, script) };
    }
    // NOT state.cpr = false: see closeCycle.
    // Neither of these is one of the arrest's rhythm checks — those are closeCycle's alone, so
    // checksDone is always the count of the team's rhythmCheck events, and the debrief's "compressions
    // running into every one" is measured where it is counted. A check made WITH a pulse: sixty of
    // them on a perfusing VT reached the arrest debrief as "63 rhythm check(s)". A pulseless NEWBORN's
    // heart-rate check: NRP reassesses every 30-60 s on its own rhythm, not on the two-minute cycle
    // that row scores. Each is counted apart.
    if(state.pulse) state.perfusingChecks = (state.perfusingChecks || 0) + 1;
    else state.newbornChecks = (state.newbornChecks || 0) + 1;
    return { handled: true, events: checkAndRosc(state, script) };
  }
  // Reversible causes come before the drug lookup because the script names them
  // in the case author's own words, and an author may well name a drug ("calcium
  // for the hyperkalaemia") as the treatment for a cause.
  {
    // "Epinephrine via the umbilical line" names a ROUTE: the drug is the order, not placing the line.
    // ROUND 9 (K4): SO DOES A VOLUME. "Give 30 ml saline through the UVC" placed the umbilical line and gave no volume —
    // the hypovolaemic newborn's volume step unticked. A newborn's volume (or a fluid bolus) through a line is the
    // volume, read against her weight as any volume is (newbornVolume); the line is its route, not an order to place it.
    const viaRoute = /\b(via|through|down)\s+(?:the\s+|an?\s+)?(umbilical|uvc|line|catheter|tube|ett|io|iv|central)\b/.test(s) && !!findDrug(s);
    const viaVolume = !viaRoute && VIA_LINE_RE.test(s) && !findDrug(s) && (!!newbornVolume(state, script, text, false)
      || (isNeonate(script) && NEWBORN_FLUID_RE.test(s) && /\b(?:bolus|boluses|push|give|run|infuse|transfus\w*)\b/.test(s)));
    // (Round 9, K3: a question — "is the UVC in?", "did we decompress the chest?" — treats nothing: questionLine. Round 10:
    // unless the case's own words for the step ask it — "how is the heart rate" IS the bradycardic child's reassessment.)
    const asked = questionLine(text);
    let hit = viaRoute ? null
      : viaVolume ? matchCause(script, s.replace(new RegExp(VIA_LINE_RE.source, 'g'), ' '))
      : (matchCause(script, s) || uvcOrder(script, s));
    if(asked && hit && !hit.asks && !questionLine(hit.phrase)) hit = null;
    // (A mention of ventilation is not the newborn's PPV step either — "if no chest rise with bagging" holds the
    // phrase "bagging". Round 7: read the causes again without the mention — VENT_MENTION_RE.)
    if(hit && hit.cause === 'ppv') hit = matchCause(script, s.replace(VENT_MENTION_RE, ' '));
    // A newborn's volume in mL, named or not, is read against her weight (newbornVolume, round 7).
    const vol = !asked && !viaRoute && (!hit || hit.cause === 'volume') ? newbornVolume(state, script, text, !!hit) : null;
    // Round 8 (Kim): the wrong amount goes in, flagged — a dose error, not a timing one — and is not her step.
    if(vol && !vol.ok) return { handled: true, events: wrongNewbornVolume(state, script, vol) };
    if(vol){ state.volumeAsk = null; if(!hit) hit = { cause: 'volume', phrase: 'volume bolus' }; }
    if(hit){ if(state.causesTreated.indexOf(hit.cause) === -1) state.causesTreated.push(hit.cause);
      state.flags[hit.cause] = true;
      // ...and the names the PACK's gates know that cause by. The script declares them, so
      // there is one vocabulary for "done" instead of two. Kim's blunt-trauma run, 2026-09-05:
      // she had decompressed the chest, bound the pelvis and transfused, and the nurse said
      // "No unit will take her mid-resuscitation. Chest, pelvis, blood — then a bed" — because
      // the engine had recorded pelvicBleed and hypovolemia while the ICU gate was asking for
      // binderApplied and bloodGiven, and the app's hand-written bridge only knew about the
      // chest. The pack's own responders set those flags, but during a code they never fire:
      // this branch claims "pelvic binder" and "massive transfusion" before the turn engine
      // ever sees them. tests/one-vocabulary.test.cjs sweeps every script for the next one.
      for(const f of (((script.causes || {}).flags || {})[hit.cause] || [])) state.flags[f] = true;
      const out = [ev(state, 'cause', hit.phrase.charAt(0).toUpperCase() + hit.phrase.slice(1) + ' done.', { cause: hit.cause })];
      // What the nurse says when it works. Two scripts authored `haltText` and nothing
      // ever spoke it: "the sats are climbing and the trachea is back in the middle" was
      // written for this exact moment and the learner got "Needle decompression done."
      const rec = startRecover(state, script, hit.cause);
      const halts = ((script.crash || {}).halt || []);
      // Asked of the SCRIPT, not of this call. Replaying Kim's own orders caught it: the
      // needle at 3:54 spoke the recover line and the chest tube at 5:18 — the same cause
      // under a different phrase, so startRecover returns nothing the second time — then
      // spoke haltText, and the nurse announced the rush of air twice for one chest.
      const authored = ((script.crash || {}).recover || []).some(r => r.cause === hit.cause && r.text);
      if(!authored && halts.includes(hit.cause) && script.crash.haltText && !state.flags['_haltSaid']){
        state.flags['_haltSaid'] = true;
        out.push(ev(state, 'recover', script.crash.haltText, { cause: hit.cause }));
      }
      out.push(...rec);
      // (R11, NRP: A NEWBORN IS REASSESSED AFTER THIRTY SECONDS OF VENTILATION. Every wording of the reassessment reaches her step
      // now — "check heart rate", "HR check", "check chest rise" — and one said eighteen seconds into the breaths ended the
      // meconium case "stable" on "Thirty seconds of good ventilation and she is 136". Said sooner, she gives the rate now and
      // calls the reassessment herself at thirty seconds of ventilation: newbornReassess, in tick.)
      const reassess = hit.cause === reassessCause((script.causes || {}).actions || {});
      const early = reassess && isNeonate(script) && state.flags.ppv && state.ppvT != null && state.t - state.ppvT < NRP_VENT_SEC;
      if(early) state.reassessAt = state.ppvT + NRP_VENT_SEC;
      const conv = early ? [] : checkConversion(state, script, hit.cause);
      out.push(...conv);
      // (R11: the heart-rate reassessment — asked "what is the heart rate?" or ordered — says the rate, where it said "Reassess the
      // heart rate done." and "How is the heart rate done."; a conversion says its own.)
      if(reassess)
        out[0].text = conv.length ? 'Reassessing the heart rate.' : 'Heart rate ' + state.hr + (state.spo2 ? ', saturation ' + state.spo2 + '%' : '') + '.'
          + (early ? ' I will call it again at thirty seconds of ventilation, doctor.' : '');
      return { handled: true, events: out }; }
  }
  // Drugs beat airway and access on purpose. "Epi 1 mg IO" and "epi down the
  // tube" name a route, not a procedure; with the access branch first they were
  // logged as placing an IO and the dose vanished from the code record.
  {
    const d = findDrug(s);
    // (R11: "shock first, then epi" — the page splits it at "then": the epinephrine that went in right after that shock
    // (epiAfterTheShock) is this one, in the same breath — not a second dose held as early.)
    if(d === 'epinephrine' && state.epiQueuedAt === state.t && !isInfusion(text) && !negatedDrug(s) && !CODE_WITHHOLD_RE.test(text))
      return { handled: true, events: [ev(state, 'note', 'Epinephrine is in, doctor.', { ack: 'echo', quiet: true })] };
    // A THOUGHT IS NOT A DOSE (review, 2026-09-27). "Consider calcium", "thinking about bicarb", "maybe magnesium" went in — and the
    // debrief's card now told the learner a drug they only thought aloud about was given. The nurse asks instead; nothing goes in,
    // nothing is held or scored (`ack: 'answer'`). A REQUEST IS STILL AN ORDER, however it is punctuated — "should we give epi?",
    // "what about bicarb", "can I get 1 mg of epi?", "do we need calcium?" — Kim's round 10/11 rule (questionLine, REQUEST_RE: seven
    // textbook runs died when those were read as questions); the nurse said "… is in" to each, and the card says what happened.
    if(d && DRUG_MUSING_RE.test(s))
      return { handled: true, events: [ev(state, 'note', 'Do you want ' + (d === 'tranexamic' ? 'tranexamic acid' : d) + ' given, doctor? Say the dose and it goes in.', { ack: 'answer' })] };
    if(d) return { handled: true, events: giveDrug(state, script, d, text) };
    // A DRUG THIS ENGINE DOES NOT DOSE, WHERE THE GUIDELINE SAYS IT IS WRONG (2026-09-27): vasopressin in an adult arrest,
    // a thrombolytic in an arrest with no pulmonary embolism, a QT-prolonging antiarrhythmic into torsades. Each went to the
    // turn engine and came back "… is in — pushed and flushed", with no lesson and nothing in the debrief. Given, flagged,
    // named in the debrief with its reason. Anywhere else these words still fall through to the turn engine, as before.
    const off = offListDrug(state, script, s, text);
    // (Review, 2026-09-27: verapamil or diltiazem into VT is the pack's to answer — recorded for the debrief, and left to fall
    // through, as on the live version.)
    if(off && off.recordOnly) offListRecord(state, script, off, text);
    else if(off) return { handled: true, events: giveOffListDrug(state, script, off, text) };
    // "...THEN START A DRIP" (round 7). The page splits "amiodarone 300 mg then start a drip" in two, and the
    // second half names no drug: it is the drip of the bolus that went in this same second (dripOfLastBolus).
    const dripOf = dripOfLastBolus(state, s);
    if(dripOf) return { handled: true, events: giveDrug(state, script, dripOf, dripOf + ' infusion ' + text, 'drip') };
  }
  // airway
  // The stems take \w* rather than a closing \b: "capnograph\b" cannot match
  // "capnography" at all, because there is no boundary between the h and the y.
  // (Every wording of ventilation — asksToVentilate. The rate she says is the patient's: a newborn is
  // ventilated at 40-60 a minute (NRP), a child with a pulse at a breath every 2-3 seconds (PALS).)
  // Round 7: a child with NO pulse was told "Bagging at ten a minute" — the adult's number. With a bag and mask
  // PALS 2020 gives two breaths after every fifteen compressions (two rescuers); a breath every 2-3 seconds is
  // for once an advanced airway is in, and ten a minute is the adult's.
  // Round 8 (Kim): and the ADULT in arrest was told "ten a minute" too, even for "bag mask ventilation 30 to 2". This
  // branch only ever puts a bag and mask on — no advanced airway — and without one ACLS gives two breaths every
  // thirty compressions; ten a minute (a breath every six seconds) is for a tube or LMA, or an adult with a pulse.
  // (Round 9, K3: a QUESTION about the breaths or the airway — "is the chest rising with each breath?", "is the tube in?" —
  // is answered, never carried out: left to the turn engine, as on live. questionLine.)
  if(questionLine(text) && (asksToVentilate(s) || ADVANCED_AIRWAY_RE.test(s))) return { handled: false };
  if(asksToVentilate(s) && state.airway === 'none'){
    state.airway = 'bvm'; state.flags.ppv = true;
    const out = [ev(state, 'airway', isNeonate(script) ? 'Bagging at forty to sixty a minute, the chest is rising.'
      : isChild(script) && state.pulse ? 'Bagging, a breath every two to three seconds — good chest rise.'
      : isChild(script) ? 'Bagging, two breaths after every fifteen compressions — good chest rise.'
      : state.pulse ? 'Bagging at ten a minute, good chest rise.'
      : 'Bagging, two breaths every thirty compressions — good chest rise.')];
    // THE CASE'S OWN PPV ROW (round 7). The newborn cases name positive-pressure ventilation as a cause with its
    // own phrases ("start ppv", "bag the baby") and the meconium case answers it — "the rate is already climbing
    // — 94". "PPV", "BVM", "bag her" reached this branch instead: the mask went on and the action was credited,
    // but the heart rate never answered the breaths. Routed here, every wording of ventilation is that cause.
    out.push(...ventilationCause(state, script));
    return { handled: true, events: out };
  }
  // SETTING UP IS NOT THE PROCEDURE (round 8, Kim — the airway's twin of round 7's "prepare to bag"). "Prepare to
  // intubate" put the tube in and credited the airway, on live too. The kit, the drugs, the preoxygenation are
  // acknowledged and nothing is placed; the order to intubate ("set up for RSI and intubate") still places it.
  { const left = s.replace(AIRWAY_PREP_RE, ' ');
    if(left !== s && ADVANCED_AIRWAY_RE.test(s) && !ADVANCED_AIRWAY_RE.test(left)){
      const sga = /\b(?:lma|igel|i-gel|supraglottic|king tube)\b/.test(s);
      state.airwayPrep = { kind: sga ? 'sga' : 'ett', t: state.t };
      return { handled: true, events: [ev(state, 'note', sga ? 'Setting up the supraglottic airway.' : 'Setting up for intubation.', { ack: 'prep' })] };
    } }
  // ...AND "PLACE IT" IS THE AIRWAY JUST SET UP (round 9). The page splits "prepare the LMA and place it" in two, and "place
  // it" named nothing: the LMA was set up and never went in (live placed it). Within thirty code seconds of her "Setting
  // up...", "place it", "insert it", "put it in" place that airway.
  if(state.airwayPrep && state.t - state.airwayPrep.t <= 30 && PLACE_IT_RE.test(s)){
    s = state.airwayPrep.kind === 'sga' ? 'lma' : 'intubate'; state.airwayPrep = null; }
  if(/\b(lma|igel|i-gel|supraglottic|king tube)\b/.test(s)){
    state.airway = 'sga'; state.flags.ppv = true;
    return { handled: true, events: [ev(state, 'airway', 'Supraglottic airway is in.')] };
  }
  // (R11: "can I get her intubated?", "let's get him intubated", "can he be intubated?" — the request for the tube.)
  if(/\b(intubate|intubation|ett|endotracheal tube|rsi)\b/.test(s)
     || (/\b(et tube|tube (him|her|the patient|them))\b/.test(s) && !/\bchest tube\b/.test(s))
     || /\b(?:get|getting|have|be)\s+(?:(?:him|her|them|the (?:patient|baby|child))\s+)?intubated\b/.test(s)){
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
  // (Round 7: "synchronize", "synch", "synchronised" too, and any number — the infant's "sync 3".)
  if(/\b(?:synchroni[sz]\w*|synch?)\b.*\b(?:shock|cardiover)|\bcardiover(?:t|s)|\b(?:synchroni[sz]\w*|synch?)\b\s*(?:at\s*)?\d+(?:\.\d+)?\b/.test(s)){
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
    const e = syncBand(script);
    // Read from `s`: an energy on its own, or "again" after a sync shock, arrives rewritten above.
    // (...then a synchronized charge's energy — round 6 — then the band's start.)
    // ("Synchronized at max energy": the top of the synchronized band — round 7.)
    const joules = shockEnergy(s, script, true) || (armed && armed.sync && armed.joules) || (e ? (e.perKg ? Math.round(e.perKg[0] * kg) : e[0]) : 100);
    let ok = true, note = '', tooLow = false;
    if(e){
      const lo = e.perKg ? e.perKg[0] * 0.9 * kg : e[0], hi = e.perKg ? e.perKg[1] * 1.1 * kg : e[1];
      tooLow = joules < lo;
      if(joules < lo || joules > hi){ ok = false;
        note = 'Energy out of range for a synchronized shock: ' + joules + ' J, expected ' +
          (e.perKg ? (e.perKg[0] + '-' + e.perKg[1] + ' J/kg for ' + kg + ' kg') : (e[0] + '-' + e[1] + ' J')) + '.'; }
    }
    if(!state.pulse){ ok = false;
      note = (note ? note + ' ' : '') + 'There is no pulse to synchronize to — a pulseless rhythm needs unsynchronized defibrillation.'; }
    else if(state.hr > 0 && state.hr < 100){ ok = false;
      note = (note ? note + ' ' : '') + 'The rate is ' + state.hr +
        ' — this is not a rate-related emergency, so there is nothing cardioversion can fix.'; }
    // A STABLE PATIENT IS NOT CARDIOVERTED FIRST. With a pressure and a narrow regular tachycardia,
    // ACLS starts with a vagal manoeuvre and adenosine; electricity is for instability (hypotension,
    // an altered mental state, shock, ischaemic chest pain, heart failure) or for drugs that have
    // failed, and then under sedation. Cardioverting at 0:00 won the stable SVT case unflagged and
    // even ticked "Reserve electricity for instability". The script names what comes first
    // (`shock.stableFirst`, in order); once the last of them has run its course and failed — for
    // adenosine that is BOTH doses, 6 then 12 mg, not a 6 mg that did not work — the shock is the
    // next step, and the nurse says so ("That is both doses of adenosine… synchronized
    // cardioversion"). The monitor carries one sign of instability, the pressure, and under 90
    // systolic the shock is the right call at once. The shock still converts — electricity does
    // break a re-entrant tachycardia, and pretending otherwise would teach something false — but it
    // is flagged, named in the debrief, and earns none of the cardioversion credit.
    const first = (script.shock && script.shock.stableFirst) || null;
    // A step the team has moved past (adenosine given without a vagal manoeuvre) is not asked for.
    const tried = k => k === 'adenosine' ? readyIn(state, script, 'adenosine') === Infinity : hasAction(state, k);
    const from = Array.isArray(first) ? Math.max(0, first.map(k => hasAction(state, k)).lastIndexOf(true)) : 0;
    const untried = Array.isArray(first) ? first.slice(from).filter(k => !tried(k)) : [];
    if(state.pulse && state.bpSys >= 90 && untried.length){ ok = false;
      const says = { vagal: 'a vagal manoeuvre',
        adenosine: hasAction(state, 'adenosine') ? 'the second, larger dose of adenosine' : 'adenosine' };
      note = (note ? note + ' ' : '') + 'The patient is stable — pressure ' + state.bpSys + ' — and ' +
        untried.map(k => says[k] || k).join(' and ') + (untried.length > 1 ? ' come' : ' comes') + ' first. ' +
        'Synchronized cardioversion is for instability (hypotension, altered mental state, shock, ischaemic chest pain, heart failure) or for drugs that have failed, and then under sedation.'; }
    const rec = { t: state.t, joules: joules, sync: true, rhythmBefore: state.rhythm, rhythmAfter: state.rhythm, ok, note };
    state.shocks.push(rec);
    const spent = spendCharge(state);
    state.flags.cardioversion = true;
    // BELOW THE BAND IT DOES NOTHING (R8, Kim): 3 J into an adult's atrial fibrillation, 10 J into VT, converted the
    // rhythm and ended the case 'stable'. Too little energy does not capture the circuit: no change, flagged,
    // uncredited — and the doctor can go up. ABOVE the band the shock still converts (electricity does break the
    // tachycardia), flagged and uncredited. A not-yet-indicated shock (the stable SVT) converts, flagged, as before.
    const out = [ev(state, 'cardiovert', 'Synchronized shock at ' + joules + ' J delivered.' + (tooLow && state.pulse ? ' No change — that energy is too low.' : ''), { ok })];
    if(spent) markChargeShot(state, out[0], via === 'callout' || answered);
    // (creditKeysFor reads `ok`: a flagged shock earns nothing.)
    if(!(tooLow && state.pulse)) out.push(...checkConversion(state, script, 'cardioversion'));
    rec.rhythmAfter = state.rhythm;
    return { handled: true, events: out };
  }
  // (The pacer's words are routed at the top of actInner — round 7; this is what they leave: a case that paces.)
  if(/\b(pace|pacing|transcutaneous|tcp|pacer)\b/.test(s) && state.pulse && pacerHere(state, script)) return { handled: true, events: startPacing(state, script) };
  if(/\b(vagal|valsalva|ice to the face|carotid massage)\b/.test(s)){
    state.flags.vagal = true;
    const out = [ev(state, 'vagal', 'Vagal manoeuvre — no change on the monitor.')];
    out.push(...checkConversion(state, script, 'vagal'));
    return { handled: true, events: out };
  }
  return { handled: false };
}

// The pacer: on (or its output up), and whatever converting row the case has for it. One place, for the
// pacer order and for "increase the energy" at a slow rhythm or a pacer already running (round 6).
// `more`: the order asked for more output — said as that when the pacer is already running.
function startPacing(state, script, more){
  const was = !!state.flags.pacing;
  state.flags.pacing = true;
  const out = [ev(state, 'pacing', more && was ? 'Pacer output up — capture at 70.' : 'Pacer on — capture at 70.')];
  out.push(...checkConversion(state, script, 'pacing'));
  return out;
}

function matchCause(script, s){
  const acts = (script.causes && script.causes.actions) || {};
  for(const cause of Object.keys(acts))
    for(const p of acts[cause]) if(s.indexOf(norm(p)) !== -1) return { cause, phrase: p };
  // R11: THE PAGE'S SPLIT DROPS "THE" AND "A" — and doctors do too. "Reassess heart rate", "check heart rate", "suction mouth
  // and nose" matched none of the newborn's phrases ("reassess the heart rate"), and the baby never ended stable. The case's
  // own phrases, read without their articles.
  const sb = noArticles(s);
  for(const cause of Object.keys(acts))
    for(const p of acts[cause]){ const pb = noArticles(norm(p)); if(pb && sb.indexOf(pb) !== -1) return { cause, phrase: p }; }
  // ...and the heart-rate reassessment however it is said — "HR check", "what is the heart rate?", "reassess HR", "check chest
  // rise" — where the case has that step (the newborns' `reassess`, the bradycardic child's): the step, asked or ordered
  // (`asks`: a question that IS the step, as the child's own "how is the heart rate").
  const rc = HR_REASSESS_RE.test(s) && !/\b(?:ventilat\w*|bag\w*|ppv|breaths?|bvm|inflat\w*)\b/.test(s) ? reassessCause(acts) : null;
  if(rc) return { cause: rc, phrase: acts[rc].find(p => /heart rate/.test(p)) || acts[rc][0], asks: true };
  return null;
}
function noArticles(x){ return String(x || '').replace(/\b(?:the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
const HR_REASSESS_RE = /\b(?:re-?assess\w*|re-?check\w*|check\w*|assess\w*|count|auscultate|listen (?:to|for)|what(?: s| is)?|whats|how(?: s| is)?|hows|give me|get me|tell me)\s+(?:(?:the|her|his|baby s|a|an)\s+)?(?:heart rate|hr)\b|\b(?:heart rate|hr)\s+(?:check|re-?check|reassess\w*|now|please)\b|^(?:(?:and|then|ok|okay|now)\s+)*(?:heart rate|hr)\s*$|^(?:(?:and|then|ok|okay|now|so)\s+)*(?:check|re-?check|reassess|assess|is there|any)\s+(?:for\s+)?(?:good\s+|the\s+)?chest (?:rise|movement)\s*$/;
function reassessCause(acts){
  for(const cause of Object.keys(acts)) if(acts[cause].some(p => /\b(?:re-?assess|re-?check|check)\s+(?:the\s+)?(?:heart rate|hr)\b/.test(norm(p)))) return cause;
  return null;
}
// Ventilation given through the bag-mask branch, in a case that names ventilation as a cause of its own (the
// newborns' `ppv`): that cause, treated once, exactly as its own phrases treat it in actInner — recorded, its
// flags set, and its conversion row asked. Nothing in a case without one.
function ventilationCause(state, script){
  const cause = 'ppv';
  if(!((script.causes || {}).actions || {})[cause] || state.causesTreated.indexOf(cause) !== -1) return [];
  state.causesTreated.push(cause);
  state.flags[cause] = true;
  for(const f of (((script.causes || {}).flags || {})[cause] || [])) state.flags[f] = true;
  return startRecover(state, script, cause).concat(checkConversion(state, script, cause));
}
// THE UMBILICAL LINE, HOWEVER IT IS ASKED FOR (round 7). The newborn cases list their phrases for it ("place a
// uvc", "umbilical line"), and "emergency UVC", "emergent UVC", "UVC now", "umbilical venous line" matched none:
// unhandled, the line never went in, and the epinephrine after it went "via the UVC" regardless. Any order that
// names the line and no drug places it, where the case has the line as a step. (Epinephrine "via the UVC" names
// a route — the drug branch has it; a refusal, "no UVC yet", is held above.)
const UVC_RE = /\b(?:uvc|umbilical (?:venous |vein )?(?:line|catheter|cath|access))\b/;
// A line named as the ROUTE of a newborn's volume (round 9, K4): "through the UVC", "via the umbilical line", "into the IO".
const VIA_LINE_RE = /\b(?:via|through|down|into)\s+(?:the\s+|an?\s+|her\s+|his\s+)?(?:umbilical\s+(?:venous\s+|vein\s+)?(?:line|catheter|cath)|umbilical|uvc|line|catheter|io|iv|central\s+line|central)\b/;
function uvcOrder(script, s){
  const acts = ((script.causes || {}).actions || {}).uvc;
  // (Flushing it, checking where it sits, taking it out: the line is already there — or going.)
  return acts && acts.length && UVC_RE.test(s) && !findDrug(s)
    && !/\b(?:flush\w*|remove|removing|pull|pulling|withdraw\w*|check\w*|confirm\w*|x ?ray|position\w*|secure|tape)\b/.test(s)
    ? { cause: 'uvc', phrase: acts[0] } : null;
}
// A NEWBORN'S VOLUME IS 10 mL/kg (round 7). NRP gives normal saline or O-negative blood, 10 mL/kg over 5-10
// minutes. The hypovolaemic newborn's volume phrases are words ("saline bolus", "10 ml/kg", "transfuse"), so
// "normal saline 31 ml over 5 minutes" — the dose itself, for 3.1 kg — was unhandled and the case's volume
// action could not be earned; and a named phrase took any amount ("saline bolus 20 ml/kg", the PALS habit, or
// 310 mL). An amount in mL, or mL/kg, of a fluid a newborn is given for volume is read against the weight:
// 8-12.5 mL/kg (with about 5% slack) is the bolus; anything else the nurse checks back before it goes in.
// Returns null when the order is not a newborn's volume in mL: a flush is not volume, a drug is the drug's, and
// hypertonic saline (3%, 23.4%) or a lipid emulsion is a treatment of its own, not volume resuscitation.
// ROUND 8 (Kim): LITRES AND UNITS ARE AMOUNTS, AND THE WRONG AMOUNT GOES IN, FLAGGED. The menu's own Normal
// Saline chip, "Give a 1 liter normal saline bolus." — 322 mL/kg in a 3.1 kg newborn — was read as no amount at
// all, so its name made it the volume step: credited, and she came back, while "500 mL" and "20 mL/kg" were held.
// A litre is 1000 mL; a unit of red cells an adult unit, about 300 mL. A wrong amount is a dose error, not an
// order that is not due yet: it goes in and is flagged under dose accuracy (wrongNewbornVolume), uncredited, and
// it is not her volume step — nothing converts on it. She says the bolus she needs ("10 mL/kg: 31 mL"), and a
// doctor who types that back naming no fluid ("31 mL", "10 mL/kg") is giving the same fluid (state.volumeAsk).
const NEWBORN_FLUID_RE = /\b(?:normal saline|saline|ns|nss|crystalloid|ringer s?|ringers|lactated ringer s?|lr|hartmann s?|blood|prbcs?|packed (?:red )?cells|red cells|o neg(?:ative)?|volume|fluids?|transfus\w*)\b/;
const NEWBORN_ML_RE = /(\d+(?:\.\d+)?)\s*(?:ml|mls|cc)\b(?!\s*(?:\/|per)\s*(?:h|hr|hour|min))/;
// (Not oxygen's "10 L/min" or a rate "per hour".)
const NEWBORN_LITRE_RE = /(\d+(?:\.\d+)?)\s*(?:l|lt|ltr|litres?|liters?)\b(?!\s*(?:\/|per|a|an)\s*(?:h|hr|hour|min))/;
const NEWBORN_UNIT_RE = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four)\s+units?\b/;
const NEWBORN_WORD_N = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
function newbornFluidName(v){
  return /\b(?:blood|prbcs?|packed|red cells|o neg\w*|transfus\w*)\b/.test(v) ? 'O-negative blood'
    : /\b(?:ringer\w*|lr|hartmann\w*)\b/.test(v) ? 'lactated Ringer\'s' : 'normal saline';
}
// ROUND 9 (K5): AN AMOUNT SAID IN WORDS IS THAT AMOUNT. Voice input writes "thirty one mls", "ten mls per kilo", "a hundred
// ml": with no digit no volume was read, and her own 31 mL said back was not understood. Number words (0-999) before a
// volume unit are read as the number.
const ONES_W = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS_W = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNDER_100_W = '(?:(?:' + Object.keys(TENS_W).join('|') + ')(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|(?:' + Object.keys(ONES_W).join('|') + '))';
const SPOKEN_ML_RE = new RegExp('\\b((?:a|one|two|three|four|five|six|seven|eight|nine)\\s+hundred(?:\\s+(?:and\\s+)?' + UNDER_100_W + ')?|' + UNDER_100_W + ')'
  + '(?=\\s*(?:ml|mls|cc|milliliters?|millilitres?)\\b)', 'g');
function spokenMl(t){
  return String(t == null ? '' : t).toLowerCase().replace(SPOKEN_ML_RE, w => {
    let n = 0;
    for(const p of w.split(/[\s-]+/)) n = p === 'hundred' ? (n || 1) * 100 : n + (TENS_W[p] || ONES_W[p] || 0);
    return String(n);
  });
}
function newbornVolume(state, script, text, named){
  if(!isNeonate(script) || !((script.causes || {}).actions || {}).volume) return null;
  const v = norm(unitWords(spokenMl(text)));
  if(findDrug(v) || /\b(?:flush\w*|hypertonic|lipid|intralipid|mannitol)\b/.test(v)) return null;
  if(/(\d+(?:\.\d+)?)\s*%/.test(String(text)) && !/\b0?\.9\s*%/.test(String(text))) return null;
  const fluidNamed = NEWBORN_FLUID_RE.test(v);
  // (Her ask is the answer's for three code minutes — half a real minute — after she said it.)
  const asked = state.volumeAsk && state.t - state.volumeAsk.t <= 180 ? state.volumeAsk : null;
  if(!(named || fluidNamed || asked)) return null;
  const kg = weightOf(script);
  const perKg = num(/(\d+(?:\.\d+)?)\s*(?:ml|mls|cc)\s*(?:\/|per)\s*k(?:g|ilo|ilogram)s?\b/, v);
  let ml = perKg != null ? perKg * kg : num(NEWBORN_ML_RE, v);
  if(ml == null){
    const l = num(NEWBORN_LITRE_RE, v);
    ml = l != null ? l * 1000 : /\bhalf (?:a )?(?:litre|liter)\b/.test(v) ? 500 : /\b(?:a|an|one) (?:litre|liter)\b/.test(v) ? 1000 : null;
  }
  if(ml == null){ const u = v.match(NEWBORN_UNIT_RE); if(u) ml = (NEWBORN_WORD_N[u[1]] || parseFloat(u[1])) * 300; }
  if(ml == null) return null;
  const mlKg = ml / kg;
  // A NEWBORN'S VOLUME BOLUS IS 10-20 mL/kg (review, 2026-09-27): saline or O-negative blood over 5-10 minutes, AHA/AAP 2025 Part 5
  // (Class 2b; C-EO) — the 2025 Korean ILCOR-aligned guideline says the same; 2020 said 10 mL/kg. 20 mL/kg was flagged, and the
  // nurse said 10 was the dose. (The low end keeps its old slack.)
  return { ml, mlKg, ok: mlKg >= 10 * 0.8 * 0.95 && mlKg <= 20 * 1.05,
    fluid: fluidNamed ? newbornFluidName(v) : asked ? asked.fluid : 'normal saline', route: routeOf(text) };
}
// The wrong amount, given: a record the debrief's dose accuracy names (it is not a drug the engine knows, so no
// clock, row or credit reads it), her line with the bolus she needs, and her ask left open for the typed-back dose.
// ROUND 9 (K5): HER VOLUME, AGREED TO. After her line — "Normal saline 1000 mL going in — that is 322.6 mL/kg, doctor. A
// newborn's volume bolus is 10 mL/kg: 31 mL, over five to ten minutes." — "yes", "ok", "give it", "go ahead" were not
// understood: nothing went in, and her step waited for the number to be typed back. While her ask is open (three code
// minutes, as newbornVolume reads it) and nothing else is asked or charged, the agreement is the dose she named — read
// exactly as "31 mL" typed back is. Returns that order, or null.
const VOLUME_YES_RE = new RegExp('^(?:(?:yes|yeah|yep|yup|ok|okay|sure|alright|all right|right|please|correct|agreed|fine|go ahead|do it|do that)\\s*)+'
  + '(?:(?:give|push|run|hang|start|do)\\s+(?:it|that|them|the (?:bolus|volume|fluid|fluids|saline|blood))(?:\\s+(?:in|now|then|please))*)?$'
  + '|^(?:give|push|run|hang|start)\\s+(?:it|that|the (?:bolus|volume|fluid|fluids|saline|blood))(?:\\s+(?:in|now|then|please))*$');
function volumeAgreed(state, script, text){
  const a = state.volumeAsk;
  if(!a || state.t - a.t > 180 || state.pendingQuestion || pendingCharge(state) || !isNeonate(script)) return null;
  return VOLUME_YES_RE.test(norm(text)) ? Math.round(10 * weightOf(script)) + ' ml' : null;
}
function wrongNewbornVolume(state, script, vol){
  const kg = weightOf(script), want = Math.round(10 * kg), most = Math.round(20 * kg), perKg = Math.round(vol.mlKg * 10) / 10,
    volume = { ml: round2(vol.ml), perKg: round2(vol.mlKg) };
  const note = perKg + ' mL/kg — a newborn\'s volume bolus is 10-20 mL/kg (' + want + '-' + most + ' mL) over 5-10 minutes.';
  state.drugs.push({ t: state.t, name: vol.fluid, doseMg: null, route: vol.route || null, ok: false, volume, note,
    pulseless: !state.pulse, episode: state.pulse ? null : state.episode, shocksBefore: state.shocks.length,
    teach: 'newborn-volume', teachAll: ['newborn-volume'], teachText: note, dose: Math.round(vol.ml) + ' mL', rhythm: state.rhythm });
  state.volumeAsk = { fluid: vol.fluid, t: state.t };
  // (Her "yes" is still the 10 mL/kg she names first — volumeAgreed.)
  return [ev(state, 'drug', capitalize(vol.fluid) + ' ' + Math.round(vol.ml) + ' mL going in — that is ' + perKg + ' mL/kg, doctor. A newborn\'s volume bolus is 10 to 20 mL/kg — '
    + want + ' mL to start, over five to ten minutes.', { ok: false, name: vol.fluid, volume })];
}

// ---------- metrics ----------
// Every row carries the guideline line it teaches, so the debrief can say WHY a
// cross is a cross instead of just scoring it.
function summary(state, script){
  const m = [];
  // THE SHOCKABLE ARREST, measured from when it began. A case that starts with a pulse and
  // arrests into VF later (cv-unstable-vt, the unstable AF) is scored from the arrest, not from
  // the start of the case, and only on that arrest's own defibrillations — never a sync shock or
  // a shock given while there was still a pulse.
  const eps = state.episodes || [];
  const shockEp = eps.find(e => SHOCKABLE.has(e.rhythm))
    || eps.find(e => state.shocks.some(x => !x.sync && x.episode === e.n && SHOCKABLE.has(x.rhythmBefore)));
  const shockable = !!shockEp;
  const epDefibs = shockEp ? state.shocks.filter(x => !x.sync && x.episode === shockEp.n) : [];
  const first = epDefibs[0];
  const since = first ? first.t - shockEp.t : null;
  if(shockable) m.push({ name: 'timeToFirstShock', value: since, ok: !!first && since <= 120,
    detail: !first ? 'Never defibrillated'
      : shockEp.t > 0 ? 'First shock ' + (since < 6 ? 'at the arrest' : spokenTime(since) + ' after the arrest') + ' (' + fmt(first.t) + ')' : 'First shock at ' + fmt(first.t),
    teach: 'Defibrillate a shockable rhythm as soon as the pads are on — every minute of delay costs survival.' });
  // Many clicks, one line: the first three times and a count.
  const times = list => list.slice(0, 3).map(e => fmt(e.t)).join(', ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '');
  // Denominator: the pulseless time. A case where compressions were never indicated is not
  // scored on them at all — failing a metric the algorithm did not ask for is not teaching, it is
  // noise. Nor is one with no pulseless time: it read "100% of the pulseless time" of a patient who
  // never lost the pulse (the time since compressions began was the stand-in). A newborn's, or a
  // bradycardic child's, compressions for a rate under sixty stop when the rate comes up, and timing
  // them against the time since they began would score that right decision as a pause. (Those
  // compression seconds can outnumber a later arrest's pulseless ones, hence the cap at 100%.)
  const cprWindow = state.pulselessSecs > 0 ? state.pulselessSecs : 0;
  const frac = cprWindow > 0 ? Math.min(1, Math.round(state.cprSecs / cprWindow * 100) / 100) : 0;
  if(cprWindow > 0) m.push({ name: 'cprFraction', value: frac, ok: frac >= 0.8,
    detail: Math.round(frac * 100) + '% of the pulseless time had compressions running',
    teach: 'Chest compression fraction should be at least 80% — minimise every pause.' });
  // The arrest's epinephrine: an IM dose for the asthma before it is not one (a flagged IM dose in
  // the arrest is still named under dose accuracy).
  // Nor is a drip: the interval is the boluses' (an arrest drip is named under dose accuracy).
  const epi = state.drugs.filter(d => systemicEpi(d) && !d.infusion);
  // Only scored where the algorithm actually wants adrenaline. A stable SVT converted
  // with adenosine must not lose points for the epinephrine it correctly withheld.
  // Scored on what the player DID with adrenaline, not on whether they reached for it.
  // A case answered correctly with magnesium, pacing or adenosine must not lose code
  // points for the epinephrine it rightly withheld — and a case that genuinely needed
  // it already loses the far larger critical-action credit for missing it.
  const epiIndicated = epi.length > 0;
  // What the team HELD because it was not due yet. Nothing was done, so there is no record — and (round 10, P2) no
  // score: the rows below LIST the held asks, and the nurse stopping them is the lesson, but only what went in is scored.
  // Round 6: an ask the team held after the case had ended (ROSC, or 'stable') is post-arrest care, not the
  // arrest's timing — never scored here (held() marks it `afterEnd`; at the ROSC second the clock alone
  // cannot tell before from after).
  const endedAtH = state.endedT != null ? state.endedT : Infinity;
  const heldOf = kind => state.events.filter(e => e.kind === 'withheld' && e.held === kind && e.t <= endedAtH && !e.afterEnd);
  // (Round 7: not an ask held as NOT INDICATED — a second arrest dose at an adult with a pulse, a child's at a
  // rate of sixty or more. That is the wrong drug for the patient, not an early one, and it was counted here as
  // an "early ask" in the arrest that followed.)
  const heldEpi = heldOf('epinephrine').filter(e => e.reason !== 'notIndicated');
  // Scored on the doses that went in. An early ask the team held is named here and in the drugTiming row below, and
  // (round 10, P2) scored nowhere — one double-click on Epi must not cost anything: nothing went in.
  // THE INTERVAL ROW SCORES THE INTERVAL (round 6). It failed on any flagged epinephrine — ventilation
  // first, an arrest dose at a pulse, a wrong dose — under the teach line "every 3-5 minutes, not sooner",
  // which none of them had broken. A dose is a timing fault when it went in sooner than the floor after
  // the dose before it (the NRP IV dose that follows a tube dose is due at once, and is not one); every
  // other flag is doseAccuracy's.
  const epiTimedDoses = epi.filter(d => d.timed), epiFloor = floorOf((script.drugs || {}).epinephrine, 'epinephrine');
  const epiSoon = epiTimedDoses.filter((d, i) => i > 0 && d.t - epiTimedDoses[i - 1].t < epiFloor
    && !(isNeonate(script) && epiTimedDoses[i - 1].route === 'et' && d.route !== 'et'));
  if(epiIndicated) m.push({ name: 'epiInterval', value: epi.length, ok: epi.length > 0 && !epiSoon.length,
    detail: (epi.length ? epi.length + ' dose(s), ' + (epiSoon.length ? epiSoon.length + ' sooner than every 3 minutes' : 'on time') : 'No epinephrine given')
      + (heldEpi.length ? '; ' + heldEpi.length + ' early ask(s) held by the team (see drug timing)' : ''),
    teach: 'Epinephrine every 3-5 minutes throughout the arrest — not sooner.'
      // Coached, not held: in VF/pVT the algorithm gives the first dose after the second shock —
      // this arrest's doses against this arrest's shocks.
      + (shockable && (() => { const e1 = epi.find(d => d.pulseless && d.episode === shockEp.n); if(!e1) return false;
          const d2 = epDefibs[1]; return !d2 || e1.t < d2.t; })()
        ? ' In a shockable rhythm the first dose goes in after the second shock — electricity first.' : '') });
  if(state.pulselessSecs > 0){
    const missed = state.cyclesWithoutCpr || 0;
    // A second shock into PEA or asystole was held for the rhythm, not the clock: that is not stacking.
    const early = heldOf('shock').filter(e => e.reason !== 'notShockable'), earlyChecks = heldOf('check');
    // ROUND 10 (P2): A HOLD NEVER COSTS POINTS. The nurse stopping an early shock or a mid-cycle check IS the lesson —
    // nothing happened to the patient. The row still lists the held asks, with the teach line, but it FAILs only for what
    // went on: a cycle that reached its check with nobody compressing, or a STACKED SHOCK DELIVERED — a second
    // defibrillation into a shockable rhythm in the same arrest with no rhythm check between (the same `check` count).
    const stacked = state.shocks.filter((x, i) => !x.sync && x.episode != null && SHOCKABLE.has(x.rhythmBefore)
      && state.shocks.slice(0, i).some(y => !y.sync && y.episode === x.episode && y.check === x.check && SHOCKABLE.has(y.rhythmBefore)));
    const bits = [];
    if(stacked.length) bits.push(stacked.length + ' shock(s) delivered before the two-minute rhythm check (' + times(stacked) + ')');
    if(early.length) bits.push(early.length + ' shock(s) asked for before the two-minute rhythm check (' + times(early) + ') — the team held ' + (early.length === 1 ? 'it' : 'them'));
    if(earlyChecks.length) bits.push(earlyChecks.length + ' pulse check(s) asked for mid-cycle (' + times(earlyChecks) + ') — the team held ' + (earlyChecks.length === 1 ? 'it' : 'them'));
    const stackLesson = 'One shock, then two full minutes of compressions to the next rhythm check — shocks are never stacked, and the pulse is checked only at the end of the cycle.';
    const cprLesson = 'Compressions run right up to the rhythm check and restart immediately after — the pause is ten seconds, not the cycle.';
    m.push({ name: 'rhythmChecks', value: state.checksDone, ok: missed === 0 && !stacked.length,
      detail: (missed === 0 ? state.checksDone + ' rhythm check(s), compressions running into every one'
            : missed + ' cycle(s) reached the rhythm check with no compressions running')
            + (bits.length ? '; ' + bits.join('; ') : ''),
      teach: bits.length ? (missed ? stackLesson + ' ' + cprLesson : stackLesson) : cprLesson });
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
                             // (Not the drugs this engine does not dose — offListRecord: on the live version they were never recorded,
                             // and scoring them was a change nobody signed off. The debrief teaches them. Review, 2026-09-27.)
                             state.drugs.filter(d => !d.ok && !d.offList && arrestEra(d)));
  const bad = problems.length;
  const seenNote = new Set();
  const named = problems.map(x => (x.name ? capitalize(x.name) : (x.sync ? 'Synchronized shock' : 'Shock')) + (x.t != null ? ' at ' + fmt(x.t) : '') + ': ' + (x.note || 'flagged'))
    .filter(line => { const key = line.replace(/ at \d+:\d+:/, ':'); if(seenNote.has(key)) return false; seenNote.add(key); return true; });
  m.push({ name: 'doseAccuracy', value: bad, ok: bad === 0,
    detail: bad === 0 ? 'Energies and doses all correct' : named.join(' '),
    teach: bad === 0 ? '' : 'Every energy and every drug has a reason and a dose — in children weight-based, in adults fixed — and a drug without an indication costs time and can do harm.' });
  // THE OTHER DRUGS' TIMING, in a row of its own. ROUND 10 (P2): it lists what the team held — the early asks, the drugs
  // not indicated, the underdoses asked again — with their lessons, and it never fails: a held ask gave the patient
  // nothing, and the nurse stopping it is the teaching. An informational row (`info`), of no weight (instant-engine
  // CODE_WEIGHTS drugTiming: 0). What went in is scored where it is scored: a wrong dose under dose accuracy, a broken
  // epinephrine interval under epiInterval.
  // It also carries the coached antiarrhythmic timing: in VF/pVT it goes in after the third shock.
  // (Not the asks held after the ending — round 6, heldOf.)
  const heldDrugs = state.events.filter(e => e.kind === 'withheld' && e.held && DRUG_FLOOR[e.held] && arrestEra(e) && !e.afterEnd);
  const timedGiven = state.drugs.filter(d => ['epinephrine', 'amiodarone', 'lidocaine', 'adenosine', 'atropine', 'naloxone'].indexOf(d.name) !== -1 && arrestEra(d));
  // (Not in torsades — review, 2026-09-27: its drug is magnesium, and the VF ladder's "antiarrhythmic after the third shock" is
  // the wrong lesson there.)
  const firstAnti = shockable ? state.drugs.find(d => (d.name === 'amiodarone' || d.name === 'lidocaine') && d.pulseless && !d.infusion && d.episode === shockEp.n
    && d.rhythm !== 'torsades') : null;
  // The lesson is built from what the team actually held — the naloxone a player asked for early was
  // missing from a line that named every other drug. Each clock is said once, in the order asked.
  const LESSON = { epinephrine: 'epinephrine every 3-5 minutes', atropine: 'atropine every 3-5 minutes, to its maximum',
    adenosine: 'adenosine a minute apart, and twice at most', naloxone: 'naloxone every 2-3 minutes',
    amiodarone: 'a second amiodarone after the next shock', amioPerfusing: 'the perfusing amiodarone runs over ten minutes before another',
    lidocaine: 'a second lidocaine after the next shock in an arrest, then every 5-10 minutes, to 3 mg/kg',
    magnesium: 'magnesium no sooner than every five minutes, to its maximum' };
  const clocks = [];
  for(const e of heldDrugs){
    if(e.reason === 'notIndicated' || e.reason === 'infusion' || e.reason === 'underdose') continue;
    const k = e.held === 'amiodarone' && e.patient && e.patient.pulse ? 'amioPerfusing' : e.held;
    if(LESSON[k] && clocks.indexOf(k) === -1) clocks.push(k);
  }
  const notInd = k => heldDrugs.some(e => e.held === k && e.reason === 'notIndicated');
  const lessons = [].concat(
    clocks.length ? ['Repeat doses have a clock: ' + clocks.map(k => LESSON[k]).join(', ') + '.'] : [],
    notInd('atropine') ? ['Atropine has no place in PEA or asystole.'] : [],
    notInd('amiodarone') || notInd('lidocaine') ? ['Amiodarone and lidocaine are for VF and pulseless VT — not PEA or asystole.'] : [],
    notInd('adenosine') ? ['Adenosine is for a tachycardia with a pulse — never for a pulseless arrest, nor once the tachycardia has broken.'] : [],
    notInd('epinephrine') ? [isChild(script)
      ? 'With a pulse, a child is given epinephrine for a rate under 60 despite ventilation — not at a rate of 60 or more.'
      : 'With a pulse, epinephrine is 10-20 mcg push-dose or an infusion — not the 1 mg arrest dose.'] : [],
    heldDrugs.some(e => e.reason === 'underdose') ? ['An underdose is not the dose: give the full dose, not another small one.'] : [],
    heldDrugs.some(e => e.reason === 'infusion') ? ['In a child the lidocaine bolus is followed by an infusion, not a second bolus.'] : []);
  const earlyAnti = !!(firstAnti && (!epDefibs[2] || firstAnti.t < epDefibs[2].t));
  if(heldDrugs.length || timedGiven.length){
    // AN ASK HELD AS NOT INDICATED IS NOT A TIMING ERROR (round 7). Adenosine into a pulseless arrest, a second
    // arrest-dose epinephrine at a patient with a pulse, amiodarone again in PEA: the wrong drug for the patient
    // as she is, not a right drug asked for too soon. The row named them and FAILED on them under "repeat doses
    // have a clock"; they are still named here, with their lesson. (The first such dose that went in is flagged under
    // dose accuracy, where the indication is scored.) Round 10 (P2): the early asks no longer fail it either.
    const byDrug = {};
    heldDrugs.forEach(e => { const key = e.held + (e.reason === 'notIndicated' ? '|notIndicated' : ''); (byDrug[key] = byDrug[key] || []).push(e); });
    const said = key => { const k = key.split('|')[0], list = byDrug[key];
      return capitalize(k) + ' asked for ' +
        // "Again" only when some went in: adenosine into a pulseless arrest is held the first time.
        (/\|notIndicated$/.test(key) ? (state.drugs.some(d => d.name === k) ? 'again ' : '') + 'when it is not indicated'
          : list.every(e => e.reason === 'underdose') ? 'again under the dose, instead of the full dose'
          : (list.some(e => e.waitSec == null) ? 'past its maximum or ' : '') + 'before it was due') +
        ' (' + times(list) + ') — the team held it'; };
    const keys = Object.keys(byDrug).sort((a, b) => /\|notIndicated$/.test(a) - /\|notIndicated$/.test(b));
    m.push({ name: 'drugTiming', value: heldDrugs.length, ok: true, info: true,
      detail: heldDrugs.length ? keys.map(said).join('; ') : 'Repeat doses given on time',
      teach: lessons.concat(earlyAnti ? ['In VF/pVT the antiarrhythmic goes in after the third shock.'] : []).join(' ') });
  }
  const need = (script.causes && script.causes.required) || [];
  if(need.length) m.push({ name: 'reversibleCause', value: state.causesTreated.length,
    ok: need.every(c => state.causesTreated.indexOf(c) !== -1),
    detail: state.causesTreated.length ? 'Treated: ' + state.causesTreated.join(', ') : 'The reversible cause was never treated',
    teach: 'Search for and treat the Hs and Ts — a cause left untreated is a code that cannot be won.' });
  if(state.ended === 'rosc'){
    // A shockable arrest that needed more than three shocks with no antiarrhythmic on
    // board converted LATE: the script let the fourth shock succeed so the case could
    // still be won, but the debrief has to say what would have shortened it.
    const defibs = shockable ? epDefibs.length : state.shocks.filter(x => !x.sync).length;
    const anti = state.drugs.some(d => (d.name === 'amiodarone' || d.name === 'lidocaine') && !d.infusion && (!shockable || (d.pulseless && d.episode === shockEp.n)));
    const late = shockable && defibs >= 4 && !anti;
    const roscAt = state.endedT != null ? state.endedT : state.t;
    m.push({ name: 'timeToRosc', value: roscAt, ok: !late,
      detail: 'ROSC at ' + fmt(roscAt) + ' after ' + defibs + ' shock' + (defibs === 1 ? '' : 's')
        + (late ? ' — converted late, with no antiarrhythmic given' : ''),
      teach: late ? 'VF that persists after three shocks is refractory: amiodarone 300 mg (or lidocaine 1-1.5 mg/kg) after the third shock is what shortens a code like this one.' : '' });
  }
  return m;
}

// MEDICATIONS TO REVIEW (Kim, 2026-09-27: "if I order the wrong meds … explain in the debrief why they were wrong, based on
// the latest ACLS guideline — for example calcium and bicarbonate not routinely indicated").
//
// Every dose the team gave that was the wrong drug, the wrong way or the wrong amount for this patient at that moment, one
// entry per drug and reason: its teaching key (drug-teaching.json holds the card — the guideline in plain words, its class,
// and what to do instead), what went in, and every time it went in. The debrief (InstantEngine.buildDebrief) turns each into
// a card. Nothing here is scored — dose accuracy scores what it always scored — and what the team HELD is not here: nothing
// went into the patient, and the drug-timing row already lists it with its lesson.
//
// Two lessons are not flags but timing, read from the arrest as it ran: in VF or pulseless VT the first epinephrine goes in
// after the second shock (AHA 2025 adult Class 2a, upgraded from 2b; children after two shocks, 2b), and the antiarrhythmic
// after the third (the algorithm's shock-refractory VF). Given sooner, the dose went in and counted — but the debrief says
// when it belongs. (A dose already flagged is taught by its flag.)
// REVIEW, 2026-09-27:
//   · A dose that counted can carry a lesson (giveDrug's `lesson`, LESSONS_SCORED): it is here with its card, marked `counted`.
//   · Not the antiarrhythmic timing in torsades: its drug is magnesium, and amiodarone feeds it (lidocaine-torsades says so).
//   · One entry per drug, reason, era — in the arrest, or after it ended — and kind of arrest (a traumatic one reads its own
//     `trauma` lesson): a dose in the arrest and one after the pulse came back no longer fold into one entry marked "after".
//     Each dose keeps its own note (`perDose`), so two different expectations are both shown.
//   · `teachText`: the leading reason's own words, for a card with no verified source (or no table).
function medicationReview(state, script){
  const pop = populationOf(script);
  const endedAt = state.endedT != null ? state.endedT : Infinity;
  const out = [], byKey = {};
  const defibsBefore = d => state.shocks.slice(0, d.shocksBefore != null ? d.shocksBefore : state.shocks.length)
    .filter(x => !x.sync && x.episode === d.episode && SHOCKABLE.has(x.rhythmBefore)).length;
  const timingKey = d => {
    if(!d.ok || !d.pulseless || d.infusion || d.under || !SHOCKABLE.has(d.rhythm) || d.t > endedAt || isNeonate(script)) return null;
    if(d.name === 'epinephrine' && systemicEpi(d) && defibsBefore(d) < 2) return pop === 'adult' ? 'epi-before-second-shock' : 'epi-before-second-shock-child';
    if((d.name === 'amiodarone' || d.name === 'lidocaine') && d.rhythm !== 'torsades' && defibsBefore(d) < 3)
      return pop === 'adult' ? 'antiarrhythmic-before-third-shock' : 'antiarrhythmic-before-third-shock-child';
    return null;
  };
  for(const d of state.drugs){
    const lessonKey = d.ok ? d.teach || null : null, tKey = d.ok && !lessonKey ? timingKey(d) : null;
    const key = d.ok ? lessonKey || tKey : (d.teach || 'flagged');
    if(!key) continue;
    const after = d.t > endedAt, trauma = !!d.traumaArrest;
    const id = [d.name, key, after ? 'after' : 'arrest', trauma ? 'trauma' : ''].join('|');
    let g = byKey[id];
    if(!g){
      g = byKey[id] = { key, name: d.name, salt: d.salt || null, doses: [], times: [], notes: [], perDose: [], timing: !!tKey, counted: true,
        infusion: !!d.infusion, teachText: d.teachText || d.note || '' };
      if(trauma) g.trauma = true;
      if(after) g.after = state.ended === 'rosc' ? 'rosc' : state.ended || 'end';
      out.push(g);
    }
    g.times.push(d.t);
    if(!d.ok) g.counted = false;
    const said = d.infusion ? (d.rate ? 'infusion at ' + d.rate : 'infusion') : (d.dose || '');
    if(said && g.doses.indexOf(said) === -1) g.doses.push(said);
    if(d.note && g.notes.indexOf(d.note) === -1) g.notes.push(d.note);
    g.perDose.push({ t: d.t, dose: said, note: d.note || '' });
    if(d.salt && g.salt && d.salt !== g.salt) g.salt = null;
  }
  return out;
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
  // "Ninety seconds", but "one minute forty-eight" — never "108 seconds".
  if(s < 100) return spoken(s) + (s === 1 ? ' second' : ' seconds');
  const m = Math.floor(s / 60), r = s % 60;
  const mm = spoken(m) + (m === 1 ? ' minute' : ' minutes');
  return r === 0 ? mm : mm + ' ' + spoken(r);
}

// WHICH WAY SHE IS GOING, from the numbers — not a constant. The app's re-eval line read
// "Holding steady since the last set" for the whole of a code because nothing ever derived
// a trend from the engine. Compares now with a minute ago on the three numbers a nurse
// would name; `critical` is the app's own threshold set.
function trendOf(state){
  // A patient WITH a pulse is never measured against the arrest. At ROSC the minute-ago sample
  // was asystole — heart rate 0 — so "58, up from 0" scored as a rising heart rate, i.e. WORSE,
  // and the page drifts a 'worsening' patient down in real time: every ROSC began sliding the
  // monitor, including the sats a tube had just raised (Kim, 2026-09-22). Pulseless samples are
  // the ones with no pressure; with none left to compare against, a pulse coming back is better.
  const all = state.history || [];
  const h = state.pulse ? all.filter(x => x.bpSys > 0) : all;
  if(state.pulse && all.length && !h.length) return 'improving';
  const ago = h.filter(x => state.t - x.t >= 60).pop() || h[0];
  const crit = state.spo2 < 88 || state.bpSys < 80 || state.hr > 150 || state.hr < 40 || !state.pulse;
  if(!ago) return crit ? 'critical' : 'stable';
  const better = (state.spo2 - ago.spo2) >= 3 || (state.bpSys - ago.bpSys) >= 8 || (ago.hr - state.hr) >= 8;
  const worse  = (ago.spo2 - state.spo2) >= 3 || (ago.bpSys - state.bpSys) >= 8 || (state.hr - ago.hr) >= 8;
  // DIRECTION BEATS SEVERITY while she is moving. A patient at 78% and still falling is
  // both critical and worsening, and the app already knows the first: isCritical() ORs the
  // raw thresholds (o2<88, bp<80, hr>150, hr<40) on its own, and 'worsening' is already
  // flagged bad by acuityChip. What nothing could say was WHICH WAY she was going — so a
  // moving number names the movement, and 'critical' is what a patient in trouble who is
  // not moving is called.
  if(worse) return 'worsening';
  if(better) return 'improving';
  return crit ? 'critical' : 'stable';
}

// A flat one-minute trend does not erase a sustained response to earlier treatment.
// Report measured differences, not an invented claim that the patient is now safe.
function responseNote(state){
  const b=state && state.recoveryBaseline;
  if(!b || !state.pulse || state.ended === 'death') return '';
  const bits=[];
  for(const [key,label,unit] of [['spo2','saturation','%'],['bpSys','systolic pressure',''],['hr','heart rate','']])
    if(b[key] !== state[key]) bits.push(label+' '+b[key]+unit+' to '+state[key]+unit);
  return bits.length ? 'Since treatment began at '+fmt(b.t)+': '+bits.join(', ')+'. Ongoing problems still need reassessment.' : '';
}

// What the monitor already shows, said out loud with the time attached. It reports
// this moment and never asserts that a state persists — the player may have just
// changed it, which is the whole reason they are being told the clock.
// `last` is the numbers she called last time, or null the first time.
function statusLine(state, last){
  let head = rhythmName(state.rhythm);
  if(state.hr > 0) head += ' at ' + state.hr;
  const bits = [head];
  if(state.bpSys > 0) bits.push('pressure ' + state.bpSys);
  // THE SATURATION IS THE NEWS after a decompression, and this line never said it. Kim
  // heard "sinus tachycardia at 140, pressure 84" while the sats she had just bought went
  // 78 to 92 on the monitor next to her. Named when it has moved since the last callout,
  // or when there has not been one — and left out otherwise, so the line stays short.
  if(state.spo2 > 0 && (!last || Math.abs((last.spo2 || 0) - state.spo2) >= 3))
    bits.push('sats ' + state.spo2);
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
  // A bolus-then-drip order records two doses (giveDrug); the bolus is the one a critical action asks
  // for — a flagged bolus is not rescued by the drip recorded after it.
  // A DRIP IS NOT THE BOLUS. An infusion pushed the drug's own name, so once an infusion was read as
  // one (round 5) an epinephrine drip after a drug-free ROSC ticked "epinephrine 1 mg every 3-5
  // minutes", an amiodarone or lidocaine drip "an antiarrhythmic for refractory VF", and a naloxone
  // drip "naloxone 2 mg" — boluses the arrest never had. The drip has its own key, `<drug>Infusion`,
  // and a case whose critical action IS the drip names it (complete heart block's epinephrine
  // infusion, the unstable VT's amiodarone after conversion); everywhere else a drip earns nothing.
  const freshDrugs = state.drugs.slice(before.drugs), lastDrug = freshDrugs.find(d => !d.infusion) || null;
  const lastDrugOk  = !!lastDrug && lastDrug.ok;
  if(lastShockOk) keys.push('shock');
  // deliverShock sets cpr=true (compressions resume immediately after a shock), so a
  // FLAGGED shock used to earn the compressions credit through that side effect —
  // "shock 50 joules" was refused as out of band and ticked "high-quality CPR". Credit
  // compressions only when the player asked for them.
  // Credit compressions when the player ASKED for them — matching the order, not the
  // resulting state, so a shock cannot earn it by side effect and asking for them right
  // after a shock (the correct ACLS move) still earns it even though cpr was already on.
  if(state.cpr && /\b(cpr|compressions)\b/.test(s) && !/\b(stop|hold|pause)\b/.test(s)) keys.push('cpr');
  // An IM epinephrine graded correct as an anaphylaxis or asthma dose is still not the IV/IO
  // epinephrine a critical action asks for (see systemicEpi).
  if(lastDrugOk && !(lastDrug.name === 'epinephrine' && !systemicEpi(lastDrug))) keys.push(lastDrug.name);
  // (...and as before, a flagged bolus is not rescued by the drip after it: 300 mg of amiodarone at a
  // perfusing VT "then 1 mg/min" earns nothing, even where the drip is the action.)
  if(!lastDrug || lastDrugOk) for(const d of freshDrugs) if(d.infusion && d.ok) keys.push(d.name + 'Infusion');
  if(state.airway !== before.airway) keys.push('airway', state.airway);
  if(state.capnography && !before.capnography) keys.push('capnography');
  if((state.ivAccess && !before.ivAccess) || (state.io && !before.io)) keys.push('access');
  if(state.causesTreated.length > before.causes){
    keys.push('causeTreated');
    keys.push(state.causesTreated[state.causesTreated.length - 1]);
  }
  if(state.flags.pacing && !before.pacing) keys.push('pacing');
  // A vagal manoeuvre is a step of the tachycardia's algorithm only while the tachycardia runs: after
  // the cardioversion had ended the stable SVT in sinus, a Valsalva still ticked "vagal first".
  // (Adenosine into that sinus rhythm is flagged in giveDrug, so it earns nothing through lastDrugOk.)
  if(state.flags.vagal && !before.vagal && !before.ended && CARDIOVERTABLE.has(before.rhythm)) keys.push('vagal');
  // Only a SYNCHRONIZED shock is a cardioversion: "unsynchronized cardioversion" is a defibrillation.
  // (Round 6: whatever the words were. "Yes" to her "synchronized?", "clear" after a synchronized charge,
  // "shock" in sync mode — and "synchronized shock at 100 J", or Kim's "use 200 j" — each delivered a
  // correct synchronized shock that never ticked the cardioversion action, which read "cardiovert" in
  // the order. The shock record says what went in.)
  if(lastShockOk && state.shocks[state.shocks.length - 1].sync) keys.push('cardioversion');
  return keys;
}

function act(state, script, text, now){
  // AN ENERGY PAST THE MACHINE IS THE MACHINE'S MOST (R9, Kim's J8): "shock 5000 joules" went in as 5000 J, "shock 1000"
  // at the default. It is 360 J, and she says so (below).
  const clamp = clampEnergy(text);
  if(clamp) text = clamp.text;
  // HER QUESTION CLOSES AT AN ORDER THAT IS NOT AN ANSWER TO IT (R9, Kim's J2 — keepsQuestion), and a minute after she
  // asked it (openQuestion). Read on the line as the doctor said it, before anything acts on it: "adenosine 12 mg" is the
  // doctor moving on, and the "ok" that followed it minutes later was no longer a yes to anything.
  // (A sedation order at "synchronized?" restarts her minute, as a hold does: etomidate takes that long to work, and the
  // "ok" after it is the yes the doctor was waiting to give.)
  // R10 (M2): so do the procedure's other steps — analgesia, consent, the pads, the airway — and they restart the charge made
  // at the pulse too. A COMPETING TREATMENT (a drug that is not sedation or analgesia, a vagal manoeuvre) at a tachycardia
  // closes her question and dumps that charge: the doctor has moved on, and a charged machine left waiting is how "ok,
  // adenosine 6 mg" became an unsedated synchronized shock into a stable SVT.
  let dumped = null;
  { const q = openQuestion(state), sv = norm(text), competing = competingTreatment(sv, text), c = pendingCharge(state);
    if(q && !keepsQuestion(state, script, q, text)) state.pendingQuestion = null;
    else if(!competing && PROCEDURE_STEP_RE.test(sv)){ if(q === 'sync') state.questionT = state.t; if(c && c.pulse) c.t = state.t; }
    if(competing && c && c.pulse && state.pulse && !state.ended && CARDIOVERTABLE.has(state.rhythm)){
      state.charged = null;
      dumped = ev(state, 'note', 'Dumping the charge, doctor.', { disarmed: true, chargeEnd: 'dumped' });
    } }
  // THE PLAN FOR THE CHECK (R10, M3): a duration said in this code second — "two minutes of CPR", "CPR for 2 minutes", "two
  // more minutes", "back on the chest, two minutes" — makes a bare check after it in the same line the planned one, and so does
  // "then rhythm check" after a CPR order: the page splits "… then rhythm check" at "then". ("Start CPR, pulse check" at the
  // arrest's start is still the check that confirms it.)
  { const sv = norm(text);
    if(!/\b(?:stop|hold|pause|pausing|holding|stopping)\b/.test(sv)){
      if(/\b(?:one|two|three|a couple of|[1-3])\s+(?:more\s+)?min(?:ute)?s?\b/.test(sv)) state.planCueT = state.t;
      if(/\b(?:cpr|compressions|chest)\b/.test(sv)) state.cprCueT = state.t;
    }
    // (...and "if VF" said on its own makes the shock after it in the same line the conditional one — "If VF, shock" is split
    // at its comma by the page, and the bare "shock" was held as an early shock.)
    if(IF_SHOCKABLE_RE.test(sv)) state.condCueT = state.t; }
  // A correct call reveals the rhythm from here on. Done in act() rather than as an
  // actInner branch on purpose: actInner would CLAIM the order, and the Call it chips
  // have to keep falling through to the turn engine, where naming the rhythm is what
  // earns the recognition critical action. This only listens.
  // (R8: not a rhythm named as a condition — "shock if VF" is not the doctor's reading of the strip, and it called VF
  // while the same words in PEA called nothing.)
  const callsNow = !state.ended && callsRhythm(String(text || '').replace(/\bif\b[\s\S]*$/i, ''), state.rhythm);
  if(callsNow) state.rhythmCalled = true;
  // THE DOCTOR'S CALL AT A SHOCK THAT IS DUE (R11, Kim). "Call it at the rhythm check, doctor." — and at the check the doctor
  // called it ("VF", "it's VF", "this is VF", "pulseless VT") and nothing followed: nothing charged, "go ahead" got "Okay,
  // doctor." The team adopts a correct call as it does at a called check: a shockable rhythm with the shock due (readyIn 0)
  // and nothing charged — "Shockable — charging, doctor." (teamCharge). The words still go on to the turn engine (`passOn`),
  // where naming the rhythm earns its recognition action. Only a line that is nothing but the call.
  // (Not at the arrest's very start, before any check or shock: there the call is the recognition, and "shock" follows it —
  // the team charges when the doctor confirms the arrest with a check, as ever.)
  if(callsNow && bareRhythmCall(text) && !questionLine(text) && (state.checksDone > 0 || episodeDefibs(state).length > 0)){
    const e = ev(state, 'note', 'Shockable — charging, doctor.', { ack: 'charge' });
    if(teamCharge(state, script, e)) return { handled: true, events: [e], credits: [], passOn: String(text) };
  }
  // A QUESTION IS ANSWERED, NEVER CARRIED OUT (round 10, Kim's P3 — questionLine, answerQuestion): "how long since the last
  // epi?" held an epinephrine dose and FAILed drugTiming; "do we have a pulse?" mid-cycle was held as a check. She answers
  // from the record, or the turn engine does. Nothing is given, held or scored. (A request — "can I get …?" — is an order.)
  // (R11: and a yes said after the question, in the same line — "Is it time for epi? Yes." — answers what her answer opened.)
  if(questionLine(text)){
    const a = answerQuestion(state, script, text);
    if(a && a.handled && trailingYes(text) && openQuestion(state)){
      const y = act(state, script, 'yes', now);
      if(y && y.handled) return { handled: true, events: (a.events || []).concat(y.events || []), credits: y.credits || [] };
    }
    // (R12, Z6: and a hold or a no after it — "Is epi due? Not yet.", "is epi due? hold it" — answers what her answer opened, and
    // calls off an epinephrine she has queued for after the shock. Read as an order, the line gave the epinephrine.)
    const hold = a && a.handled ? trailingHold(text) : null;
    if(hold){
      const events = (a.events || []).slice();
      if(findDrug(norm(text)) === 'epinephrine' && epiQueued(state)){
        state.epiAfterShock = null;
        events.push(ev(state, 'note', 'Holding the epinephrine, doctor.', { ack: 'hold' }));
      } else if(openQuestion(state) && state.pendingQuestion !== 'sync'){
        const h = act(state, script, hold, now);
        if(h && h.handled) events.push(...(h.events || []));
      }
      return { handled: true, events, credits: [] };
    }
    if(a) return a;
  }
  // ...and so is ventilating. Whatever branch claims the order — a cause ("jaw thrust and bag her" is
  // the newborn's open-mouth step), compressions ("3 to 1 compressions with ventilation"), a drug in the
  // same clause — or none of them (the turn engine answers "bag her" once a mask is on), the breaths
  // were ordered, and the ventilation-first check (giveDrug) and the newborn's heart-rate rows (ppv)
  // read this flag. Not an order to stop them, nor one refused ("don't bag her yet") — nor one the team
  // held whole ("3 to 1 compressions with ventilation" at a pulse of 190 is refused, breaths and all).
  const ppvWas = state.flags.ppv;
  { const sv = norm(text);
    // (Nor a question about them — round 9, questionLine.)
    if(state.ended !== 'death' && asksToVentilate(sv) && !HOLD_VENT_RE.test(sv) && !CODE_WITHHOLD_RE.test(text) && !questionLine(text)) state.flags.ppv = true; }
  const before = { shocks: state.shocks.length, drugs: state.drugs.length, cpr: state.cpr,
    airway: state.airway, capnography: state.capnography, ivAccess: state.ivAccess,
    io: state.io, causes: state.causesTreated.length,
    pacing: !!state.flags.pacing, vagal: !!state.flags.vagal, rhythm: state.rhythm, ended: state.ended };
  const hadCharge = !!pendingCharge(state);
  // (Round 9: "yes", "ok", "give it" to her newborn-volume line is the dose she named — volumeAgreed.)
  const out = actInner(state, script, volumeAgreed(state, script, text) || text, now);
  // (R11: when the breaths began — a newborn is reassessed after thirty seconds of them, newbornReassess.)
  if(state.flags.ppv && !ppvWas && state.ppvT == null) state.ppvT = state.t;
  if(!state.flags.ppv) state.ppvT = null;
  if(!out || !out.handled) return dumped ? { handled: true, events: [dumped], credits: [] } : out || { handled: false };
  // (The charge dumped for a competing treatment is said first — and is not the order's own event: a held drug is still held.)
  if(dumped) out.events = [dumped].concat(out.events || []);
  const own = dumped ? out.events.slice(1) : (out.events || []);
  if(clamp && (out.events || []).some(e => e.kind === 'shock' || e.kind === 'cardiovert' || e.charge != null || e.question === 'sync'))
    out.events.unshift(ev(state, 'note', 'Our maximum is ' + DEVICE_MAX_J + ' joules, doctor — at ' + DEVICE_MAX_J + '.', { clamped: clamp.from }));
  chargeEnded(state, hadCharge, out.events);
  // A held order earns nothing — not even the compressions key, which reads the order's words.
  if(own.length && own.every(e => e.kind === 'withheld')){
    if(ppvWas === undefined) delete state.flags.ppv; else state.flags.ppv = ppvWas;
    if(!state.flags.ppv) state.ppvT = null;
    out.credits = []; return out; }
  const cared = postRoscCare(state, script, before);
  if(cared.length) out.events = (out.events || []).concat(cared);
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

root.CodeEngine = { newState, tick, act, actInner, creditKeysFor, summary, rhythmName, fmt, trendOf, responseNote,
  // 2026-09-27 — the wrong medications, one per drug and reason, for the debrief's "Medications to review" (with the keys of
  // their cards in drug-teaching.json).
  medicationReview, teachKeys,
  // What is due when: the page's Hint and drug buttons ask the same rule the nurse applies.
  readyIn, DRUG_FLOOR, expectedDoseMg,
  // ...and why it is not due yet, in the nurse's own reckoning (clock, afterShock, clockAndShock, max,
  // notIndicated, notShockable, infusion).
  holdReason,
  CYCLE_SEC, STATUS_SEC, STATUS_MAX_SILENCE, statusLine,
  spokenTime, parseDose, SHOCKABLE, PULSELESS, CARDIOVERTABLE, DRUG_ALIASES,
  // Exported so the app can apply the same rule to the 155 cases that have no code script.
  // Reading the strip is the exercise in an atrial fibrillation case too.
  callsRhythm, RHYTHM_CALLS,
  // Round 7 — the rules the page used to copy (codeChargeLive, codeAntiNotIndicated), so the room, the Hint and
  // the nurse cannot drift apart: the charge still waiting ({ joules, sync, t } or null), and whether an
  // amiodarone or lidocaine now would be the wrong drug for the patient as she is.
  chargePending, antiarrhythmicNotIndicated,
  // R8 — whether the team would pace now (a case that paces, and a pulse): the Pacing chip and the Hint's pacing step;
  // and whether a shock order now would be an echo of the shock just given (the Defibrillate button: quiet, not held).
  pacerHere, echoOf,
  // R9 — the page's clause split joins a lone "ok" to the hold, the "no" or the "first" after it while her question is open
  // (joinAnswers: the engine's own rule); openQuestion says whether one still is (a minute, the rhythm she asked about).
  joinAnswers, openQuestion, QUESTION_SEC, NURSE_ECHO_SEC,
  // R10 (M7) — the energy ladder the engine climbs ("more energy", "hit him again"): the page's Defibrillate button reads
  // the same rung instead of a copy of it, and a child's most (10 J/kg, never past the adult 200 J).
  nextDefibJoules, childMaxJoules, ECHO_TAP_SEC,
  // R10 (P3) — whether a line asks about the state (answered, never carried out) rather than orders; a request is an order.
  questionLine };
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.CodeEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
