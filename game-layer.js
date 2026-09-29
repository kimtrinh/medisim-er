// game-layer.js — progression for MediSim ER (XP, levels, badges, streaks).
// Deterministic pure functions over the ms_log array: the same log always
// yields the same progression, so history back-fills and a lost cache costs
// nothing. Loaded as a CLASSIC browser <script> (sets globalThis.GameLayer)
// and via vm in Node tests — keep it dependency-free, no ESM/CJS syntax.
(function (root) {
'use strict';

// Playful on purpose. Kim, 2026-09-28: the rank goes on a card people post, and "Attending" or
// "PGY-2" there reads as a real training level. Invented titles, clearly a game, same XP bands.
const LEVELS = [
  { xp: 0,     title: 'Rookie' },
  { xp: 500,   title: 'Monitor Watcher' },
  { xp: 1500,  title: 'Line Slinger' },
  { xp: 3500,  title: 'Code Runner' },
  { xp: 7000,  title: 'Airway Wrangler' },
  { xp: 12000, title: 'Shock Tamer' },
  { xp: 20000, title: 'Crash Cart Captain' },
  { xp: 32000, title: 'Resus Ace' },
  { xp: 50000, title: 'Resus Legend' },
];

function levelFor(xp){
  let idx = 0;
  for(let i = 0; i < LEVELS.length; i++) if(xp >= LEVELS[i].xp) idx = i;
  const next = LEVELS[idx + 1];
  return { idx, title: LEVELS[idx].title,
           into: xp - LEVELS[idx].xp,
           need: next ? next.xp - xp : 0 };
}

// XP for one log entry, given the best prior score on the same case (or null)
// and the win-streak length INCLUDING this entry (1 = first ≥80 in a row).
function xpForEntry(entry, prevBest, winLen){
  let xp = Math.max(0, Math.round(entry.score || 0));
  if(Array.isArray(entry.missed) && entry.missed.length === 0) xp += 25;   // clean sweep
  if(typeof entry.dosing === 'number' && entry.dosing === 0) xp += 15;      // safe prescriber
  if(entry.id){
    if(prevBest == null) xp += 10;                                          // first play
    else if((entry.score || 0) > prevBest) xp += 5;                         // beat your best
  }
  if(entry.dxCalled === 'correct') xp += 10;          // committed, and the read was right
  if(entry.dxFirstCorrect) xp += 10;                  // and it was the opening read
  const mult = (entry.score || 0) >= 80 && !entry.died ? Math.min(1 + 0.1 * (winLen - 1), 1.5) : 1;
  return Math.round(xp * mult);
}

// One definition of what "assisted" means, shared by the progression and the run record.
// TrainingCoach writes the field; this reads it. An entry with no `assist` is unassisted.
function isAssisted(entry){ return !!(entry && entry.assist && entry.assist.assisted); }
function computeProgress(log, goldIds, caseMeta){
  log = (Array.isArray(log) ? log : []).filter(e => e && typeof e === 'object');
  goldIds = Array.isArray(goldIds) ? goldIds : [];
  caseMeta = caseMeta && typeof caseMeta === 'object' ? caseMeta : {};
  const perCase = {};   // id -> {best, plays, mastered}
  const systems = {};   // prefix -> {played:Set-size, total}
  for(const id of goldIds){
    const sys = String(id).split('-')[0];
    systems[sys] = systems[sys] || { played: 0, total: 0, _seen: {} };
    systems[sys].total++;
  }
  // ASSISTED RUNS ARE COUNTED, BUT THEY ARE NOT THE RECORD (Task 10). A run that took a
  // hint or used a retry still earns XP and still counts as a play — practice is practice,
  // and hiding it would make the log lie about what the learner did. What it does not do is
  // set a personal best, unlock mastery, extend the unassisted win streak, or feed a badge.
  // A trophy has to mean you did it alone, or it means nothing.
  //
  // An entry with no `assist` field — every entry written before this existed — is
  // unassisted, so nothing about an existing log changes.
  const solo = e => !isAssisted(e);
  let xp = 0, winLen = 0;
  for(const entry of log){
    const isSolo = solo(entry);
    if(isSolo){ if((entry.score || 0) >= 80 && !entry.died) winLen++; else winLen = 0; }
    const prev = entry.id && perCase[entry.id] ? perCase[entry.id].best : null;
    // The streak bonus belongs to the unassisted streak, so an assisted run is scored as
    // if it stood alone rather than borrowing the run of wins before it.
    xp += xpForEntry(entry, entry.id ? prev : null, isSolo ? winLen : 0);
    if(entry.id){
      const pc = perCase[entry.id] = perCase[entry.id] || { best: -1, bestWin: -1, plays: 0, mastered: false, assistedPlays: 0 };
      pc.plays++;
      if(!isSolo){ pc.assistedPlays = (pc.assistedPlays || 0) + 1; }
      if(isSolo && (entry.score || 0) > pc.best) pc.best = entry.score || 0;
      if(isSolo && !entry.died && (entry.score||0)>=70 && (entry.score||0)>pc.bestWin) pc.bestWin=entry.score||0;
      pc.mastered = pc.bestWin >= 90;
      const sys = String(entry.id).split('-')[0];
      if(systems[sys] && !systems[sys]._seen[entry.id]){ systems[sys]._seen[entry.id] = true; systems[sys].played++; }
    }
  }
  // daily streak: consecutive calendar days ending at the last entry's day
  const days = [...new Set(log.map(e => e.when).filter(Boolean))].sort();
  let daily = 0;
  if(days.length){
    daily = 1;
    for(let i = days.length - 1; i > 0; i--){
      const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000;
      if(gap === 1) daily++; else break;
    }
  }
  for(const s of Object.values(systems)) delete s._seen;
  const soloLog = log.filter(solo);
  const badges = BADGES.filter(b => b.test(soloLog, perCase, systems, goldIds, caseMeta)).map(b => b.id);
  const caseBadges = caseBadgesFrom(soloLog, caseMeta);
  return { xp, level: levelFor(xp), badges, caseBadges, perCase, systems,
           streaks: { daily, win: winLen } };
}

// Badge table — plain descriptive names. Each test() is pure over
// (log, perCase, systems, goldIds); computeProgress calls them all.
const consec = (log, pred) => {          // longest run of entries satisfying pred
  let best = 0, cur = 0;
  for(const e of log){ if(pred(e)) best = Math.max(best, ++cur); else cur = 0; }
  return best;
};
const SPECIALTIES = [
  ['resus','Critical Care','🚨'], ['peds','Peds','🧸'], ['cv','Cardiology','🫀'],
  ['resp','Airway & Respiratory','🫁'], ['neuro','Neurology','🧠'], ['trauma','Trauma','🩸'],
  ['tox','Toxicology','☠️'], ['id','Infectious Disease','🦠'], ['gi','GI','🩻'],
  ['gu','Renal & GU','💧'], ['endo','Endocrine','⚗️'], ['heme','Hematology','🩸'],
  ['ent','Eye & ENT','👁️'], ['ob','Obstetrics','🤰'], ['geri','Geriatrics','🧓'],
  ['env','Environmental Medicine','🌡️']
];
const SYS_ALIAS = {colitis:'gi',metab:'endo',onc:'heme'};
function systemFor(id, caseMeta){
  if(caseMeta[id] && caseMeta[id].system) return caseMeta[id].system;
  const prefix=String(id||'').split('-')[0];
  return SYS_ALIAS[prefix] || prefix;
}
// How many cases the library actually has for a specialty. goldIds/caseMeta are the same
// runtime data (cases-gold.json + case-systems.json) computeProgress already receives —
// this file has no file access of its own, so it can only learn the count this way.
function specialtyCaseCount(sys, goldIds, caseMeta){
  return goldIds.filter(id => systemFor(id, caseMeta) === sys).length;
}
// Distinct cases in `sys` won unassisted, at 90+, with the patient alive. isAssisted is
// the one definition of "assisted" (see above, where TrainingCoach's field is read) —
// this does not reimplement it.
function specialtyMastered(log, sys, caseMeta){
  const won = new Set();
  for(const e of log){
    if(e && e.id && !isAssisted(e) && !e.died && (e.score||0) >= 90 && systemFor(e.id, caseMeta) === sys) won.add(e.id);
  }
  return won.size;
}
// The "Expert" badge(s) for every specialty, built once, statically — all four possible
// ids always exist (`expert-<sys>` and the `-bronze`/`-silver`/`-gold` tiers), so a badge
// lookup by id (medisim-er-local.html:4962,13436) always finds a shape, no matter what any
// earlier computeProgress call happened to compute. Each test decides for itself whether
// it applies, by checking the library size it is already handed (goldIds + caseMeta, the
// same arguments every badge test gets): the tiered tests fire only at ten or more cases,
// the bare test only below that. For any one library exactly one shape can ever fire —
// that's a property of the tests now, not of what got built into the array.
//
// A specialty with ten or more cases can support a three-rung ladder (Bronze 3 / Silver 6
// / Gold 10) without any rung being a coin flip away from unearnable; a specialty with
// fewer cases gets one badge instead of a thin ladder nobody can climb. Which shape fires
// is computed from the real count, not hardcoded, so a specialty that grows past the
// ten-case line later is promoted to tiers automatically.
//
// The single-badge bar is 3, not "every case in the specialty." A badge that requires the
// whole library becomes unearnable the moment any one case has a bug, and the player has
// no way to tell a broken case from a badge they simply haven't earned yet — three is
// robust to that.
function specialtyExpertBadges(){
  return SPECIALTIES.flatMap(([sys, name, icon]) => {
    const bare = {
      id: 'expert-' + sys, name: name + ' Expert', icon,
      desc: 'Score 90+ unassisted, patient alive, on three different ' + name.toLowerCase() + ' cases.',
      test: (log,perCase,systems,goldIds,caseMeta) =>
        specialtyCaseCount(sys, goldIds, caseMeta) < 10 && specialtyMastered(log, sys, caseMeta) >= 3,
    };
    const tiers = [['bronze','Bronze',3], ['silver','Silver',6], ['gold','Gold',10]].map(([tier,label,need]) => ({
      id: 'expert-' + sys + '-' + tier, name: name + ' Expert — ' + label, icon,
      desc: 'Score 90+ unassisted, patient alive, on ' + need + ' different ' + name.toLowerCase() + ' cases.',
      test: (log,perCase,systems,goldIds,caseMeta) =>
        specialtyCaseCount(sys, goldIds, caseMeta) >= 10 && specialtyMastered(log, sys, caseMeta) >= need,
    }));
    return [bare, ...tiers];
  });
}
function compactTitle(s){
  s=String(s||'').replace(/\s*\([^)]*\)\s*/g,' ').replace(/\s+/g,' ').trim();
  if(!s) return 'Mystery Case';
  return s.length>34 ? s.slice(0,31).replace(/\s+\S*$/,'')+'…' : s;
}
function caseBadgeFor(entry, caseMeta){
  const id=String(entry.id||'');
  const meta=caseMeta[id]||{};
  const title=compactTitle(meta.title || entry.label || entry.diagnosis || id.replace(/[-_]+/g,' '));
  if(id==='resp-tension-ptx') return {id:'case:'+id,name:'PTX Pro',icon:'🫁',
    desc:'Recognized and stabilized the tension pneumothorax case.',caseId:id,title};
  return {id:'case:'+id,name:title+' Save',icon:'🏆',
    desc:'Stabilized this case with a score of 70 or better.',caseId:id,title};
}
function caseBadgesFrom(log, caseMeta){
  const won={};
  for(const e of log){
    if(!e.id || e.died || (e.score||0)<70 || won[e.id]) continue;
    won[e.id]=caseBadgeFor(e,caseMeta);
  }
  return Object.values(won);
}
const BADGES = [
  { id: 'first-save', name: 'First Save', icon: '⚡', desc: 'Finish a case with a score of 70 or better.',
    test: log => log.some(e => (e.score || 0) >= 70) },
  { id: 'clean-sweep', name: 'Clean Sweep', icon: '✅', desc: 'Complete every critical action in a single case.',
    test: log => log.some(e => Array.isArray(e.missed) && e.missed.length === 0) },
  { id: 'perfect-100', name: 'Perfect 100', icon: '💯', desc: 'Score a perfect 100.',
    test: log => log.some(e => (e.score || 0) >= 100) },
  { id: 'comeback', name: 'Comeback', icon: '🔄', desc: 'Score 90+ on the very next case after a sub-50.',
    test: log => log.some((e, i) => i > 0 && (log[i - 1].score || 0) < 50 && (e.score || 0) >= 90) },
  { id: 'night-shift', name: 'Night Shift', icon: '🌙', desc: 'Five cases in a single day.',
    test: log => { const c = {}; return log.some(e => e.when && (c[e.when] = (c[e.when] || 0) + 1) >= 5); } },
  { id: 'iron-streak', name: 'Iron Streak', icon: '🔥', desc: 'Five consecutive cases at 80 or better.',
    test: log => consec(log, e => (e.score || 0) >= 80 && !e.died) >= 5 },
  { id: 'ten-day', name: 'Ten-Day Attending', icon: '📅', desc: 'Play on ten consecutive days.',
    test: log => {
      const days = [...new Set(log.map(e => e.when).filter(Boolean))].sort();
      let run = days.length ? 1 : 0, best = run;
      for(let i = 1; i < days.length; i++){
        run = (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000 === 1 ? run + 1 : 1;
        best = Math.max(best, run);
      }
      return best >= 10;
    } },
  { id: 'fast-hands', name: 'Fast Hands', icon: '⏱️', desc: 'Score 85+ in under 30 simulated minutes.',
    test: log => log.some(e => (e.score || 0) >= 85 && (e.simMin || 999) < 30) },
  { id: 'safe-prescriber', name: 'Safe Prescriber', icon: '💊', desc: 'Ten consecutive cases with zero dosing flags.',
    test: log => consec(log, e => typeof e.dosing === 'number' && e.dosing === 0) >= 10 },
  { id:'five-saves', name:'Five Lives', icon:'🖐️', desc:'Save five different patients with scores of 70 or better.',
    test:(log,perCase)=>Object.values(perCase).filter(p=>p.bestWin>=70).length>=5 },
  { id:'ten-saves', name:'Ten Lives', icon:'🔟', desc:'Save ten different patients with scores of 70 or better.',
    test:(log,perCase)=>Object.values(perCase).filter(p=>p.bestWin>=70).length>=10 },
  { id:'high-five', name:'High-Five', icon:'🙌', desc:'Score 90+ on five different cases.',
    test:(log,perCase)=>Object.values(perCase).filter(p=>p.mastered).length>=5 },
  { id:'clinical-elite', name:'Clinical Elite', icon:'💎', desc:'Score 90+ on ten different cases.',
    test:(log,perCase)=>Object.values(perCase).filter(p=>p.mastered).length>=10 },
  ...SPECIALTIES.map(([sys, name, icon]) => ({
    id: 'spec-' + sys, name: name + ' Specialist', icon,
    desc: 'Score 70+ on five different ' + name.toLowerCase() + ' cases.',
    // best >= 70 per case (not an average) so the badge can only be earned,
    // never revoked by attempting a new case and scoring low.
    test: (log, perCase, systems, goldIds, caseMeta) =>
      Object.keys(perCase).filter(id => systemFor(id,caseMeta) === sys && perCase[id].bestWin >= 70).length >= 5 })),
  // Expert badge(s) per specialty — all four ids per specialty always exist; each test
  // decides for itself whether it applies to the library it's handed. See
  // specialtyExpertBadges above.
  ...specialtyExpertBadges(),
  { id: 'first-call', name: 'Called It First', icon: '⚡', desc: 'Name the right diagnosis on your first try.',
    test: log => log.some(e => e.dxFirstCorrect) },
  { id: 'sharp-differential', name: 'Sharp Differential', icon: '🔍', desc: 'Open with the right diagnosis on twenty-five different cases.',
    test: log => new Set(log.filter(e => e.dxFirstCorrect && e.id).map(e => e.id)).size >= 25 },
  { id: 'half-board', name: 'Half the Board', icon: '🧭', desc: 'Treat half the cases in the library.',
    test: (log, perCase, systems, goldIds) =>
      goldIds.length > 0 && goldIds.filter(id => perCase[id]).length >= Math.ceil(goldIds.length / 2) },
  { id: 'board-certified', name: 'Board Certified', icon: '🏅', desc: 'Treat every case in the library.',
    test: (log, perCase, systems, goldIds) =>
      goldIds.length > 0 && goldIds.every(id => perCase[id]) },
  { id: 'mastery-collector', name: 'Mastery Collector', icon: '⭐', desc: 'Score 90+ on twenty-five different cases.',
    test: (log, perCase) => Object.values(perCase).filter(pc => pc.mastered).length >= 25 },
];

function diffProgress(before, after){
  return {
    xpGain: Math.max(0, after.xp - before.xp),   // a capped log can shrink total XP; never show "+-12 XP"
    newBadges: after.badges.filter(b => !before.badges.includes(b)),
    newCaseBadges: (after.caseBadges||[]).filter(b => !(before.caseBadges||[]).some(x=>x.id===b.id)),
    leveledUp: after.level.idx > before.level.idx,
    combo: after.streaks.win,
    comboBefore: (before.streaks && before.streaks.win) || 0,   // lets the loss overlay tell "no streak yet" from "streak just broke"
  };
}

root.GameLayer = { LEVELS, BADGES, SPECIALTIES, computeProgress, diffProgress, xpForEntry, levelFor, isAssisted,
                   caseBadgeFor, caseBadgesFrom, systemFor };
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.GameLayer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
