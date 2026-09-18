// MediSim ER — run recorder.
//
// Builds one record per completed case: the player's de-identified orders, the engine's
// response, the per-clause decision trace, the debrief, and any critical actions the
// player convicted the simulator of misgrading. Shipped once at case end to whichever
// sink the build has (serve_app.py locally, the collector Worker publicly).
//
// Classic browser script (sets globalThis.RunLog) so tests can load it in Node the
// same way instant-engine.js does. No dependencies, no build step.
(function(root){
'use strict';

const SCHEMA = 2;
const MAX_BYTES = 256 * 1024;      // matches both sinks' hard limit
const OUTBOX_KEY = 'ms_runlog_outbox';
const OUTBOX_MAX = 20;             // a full trace runs tens of KB; localStorage is a few MB

// Local-time ISO stamp. toISOString() is UTC and mislabels evening sessions with
// tomorrow's date — the same reason localISO() exists in the app.
function localISO(when){
  const d = when || new Date();
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString();
}

// Sortable, path-safe, collision-resistant enough for one player's runs.
function makeRunId(when, rand){
  const stamp = localISO(when).replace(/[-:T]/g, '').slice(0, 14);
  if(!rand && root.crypto && typeof root.crypto.randomUUID === 'function')
    return 'r-' + stamp + '-' + root.crypto.randomUUID().replace(/-/g, '');
  const r = Math.floor((rand || Math.random)() * 0x10000).toString(16).padStart(4, '0');
  return 'r-' + stamp + '-' + r;
}

// Best-effort removal of common identifiers before a record ever reaches an
// outbox or network sink. The UI separately warns users not to enter PHI.
function redactText(value){
  return String(value == null ? '' : value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email removed]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, '[phone removed]')
    .replace(/\b(?:MRN|medical record(?: number)?|patient id)\s*[:#-]?\s*[A-Z0-9-]{4,}\b/gi, '[identifier removed]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[identifier removed]');
}

function redactValue(value, depth){
  const level = depth || 0;
  if(level > 10) return null;
  if(typeof value === 'string') return redactText(value);
  if(Array.isArray(value)) return value.map(v => redactValue(v, level + 1));
  if(value && typeof value === 'object'){
    const out = {};
    for(const key of Object.keys(value)) out[key] = redactValue(value[key], level + 1);
    return out;
  }
  return value;
}

function Recorder(){ this._run = null; }

Recorder.prototype.current = function(){ return this._run; };

Recorder.prototype.start = function(meta, opts){
  const m = meta || {}, o = opts || {};
  this._run = {
    schema: SCHEMA,
    runId: makeRunId(o.now, o.rand),
    startedAt: localISO(o.now),
    endedAt: null,
    source: m.source || 'local',
    engine: m.engine || null,
    model: m.model || null,
    difficulty: m.difficulty || null,
    caps: m.caps || null,
    case: { goldId: m.goldId || null, title: /\.pdf$/i.test(m.title||'') ? 'uploaded educational PDF' : redactText(m.title), diagnosis: m.diagnosis || '',
            criticalActions: (m.criticalActions || []).slice() },
    turns: [], debrief: null, flags: [], receipts: []
  };
  return this._run;
};

Recorder.prototype.turn = function(action, response, trace, tSimMin){
  if(!this._run) return null;
  const r = response || {};
  const t = {
    n: this._run.turns.length + 1,
    tSimMin: (tSimMin == null) ? null : Math.round(tSimMin),
    action: redactText(action),
    trace: trace ? redactValue(trace) : null,
    response: {
      narrative: redactText(r.narrative || ''),
      speech: redactValue(r.speech || []),
      labResults: redactValue(r.labResults || []),
      // Resolved images are data URIs measured in hundreds of KB. Title and body
      // carry all the diagnostic signal; the picture carries none of it.
      diagnosticReports: (r.diagnosticReports || []).map(x => ({ title: redactText(x.title), body: redactText(x.body) })),
      physicalExam: redactValue(r.physicalExam || []),
      dosingFlags: redactValue(r.dosingFlags || []),
      vitals: r.updatedVitals || null,
      trend: r.vitalTrend || null
    }
  };
  this._run.turns.push(t);
  return t;
};

Recorder.prototype.flag = function(caIndex, caText, note, myOrders){
  if(!this._run) return null;
  const f = { caIndex: Number.isInteger(caIndex) ? caIndex : null,
              caText: String(caText || ''), note: redactText(note),
              myOrders: (myOrders || []).map(redactText) };
  this._run.flags.push(f);
  return f;
};

// The per-order receipts the app already shows the learner — performed / done in general
// terms / not understood / blocked — copied onto the record so the analyzer can inventory
// them. Replaces, never appends: the app hands the whole list on every ship, and a re-ship
// after a player flag must not double it. `objectiveIds` is the engine's name; `credits`
// is the record's, so a reader of the file need not know the app's internals.
Recorder.prototype.receipts = function(list){
  if(!this._run) return null;
  this._run.receipts = (list || []).slice(-300).map(r => ({
    text: redactText(r.rawText || r.orderText || r.text || ''),
    status: r.status || null,
    reasonCode: r.reasonCode || null,
    credits: Array.isArray(r.objectiveIds) ? r.objectiveIds.map(String) : [],
    simMin: (r.simMin == null) ? null : Math.round(r.simMin)
  }));
  return this._run.receipts;
};

Recorder.prototype.finish = function(debrief){
  if(!this._run) return null;
  const d = debrief || {};
  this._run.endedAt = localISO();
  this._run.debrief = {
    score: Math.round(d.score || 0),
    outcome: d.outcome || '',
    met: (d.criticalActionsMet || []).slice(),
    missed: (d.criticalActionsMissed || []).slice(),
    creditBasis: d.creditBasis || null,
    missedOpportunities: (d.missedOpportunities || []).slice()
  };
  return this._run;
};

// ---------- feedback ----------
// Kim, 2026-09-16: "Create a way for users to leave feedback for improvement on the case and
// for it to generate a document that my LLM can continuously learn from." A second record
// type beside the run: what the player says went wrong, and what should have happened.
//
// Its id is its own ("f-", never "r-"): the note and the run it is about are different
// files, and an id that could equal a run id would let one overwrite the other anywhere
// records are keyed by id. Free text is redacted like every other string and capped, and a
// note with nothing in it is refused rather than shipped blank.
const FEEDBACK_SCHEMA = 3, FEEDBACK_TEXT_MAX = 8000;
function feedback(f){
  const o = f || {};
  const clip = v => redactText(String(v == null ? '' : v).trim()).slice(0, FEEDBACK_TEXT_MAX);
  const happened = clip(o.happened), should = clip(o.should);
  if(!happened && !should) throw new Error('nothing to send');
  return {
    schema: FEEDBACK_SCHEMA, kind: 'feedback',
    id: 'f' + makeRunId(o.now, o.rand).slice(1),
    createdAt: localISO(o.now),
    runId: o.runId || null,
    source: o.source || 'local', engine: o.engine || null, version: o.version || null,
    case: { goldId: o.caseId || null, title: redactText(String(o.caseTitle || '')) },
    at: { turn: Number.isFinite(o.turn) ? o.turn : null,
          order: redactText(String(o.order || '').trim()) || null,
          receipt: o.receipt ? redactValue(o.receipt, 0) : null },
    happened, should,
  };
}
const isFeedback = rec => !!(rec && rec.kind === 'feedback');

// ---------- size ----------
function tooBig(rec){ return JSON.stringify(rec).length > MAX_BYTES; }

// Shed traces oldest-first until it fits, and record what was shed. A truncated
// record that says so beats a rejected one that says nothing.
function fit(rec){
  if(!tooBig(rec)) return rec;
  const c = JSON.parse(JSON.stringify(rec));
  c.trimmed = [];
  for(let i = 0; i < c.turns.length && tooBig(c); i++){
    if(c.turns[i].trace){ c.turns[i].trace = null; c.trimmed.push('trace:' + c.turns[i].n); }
  }
  return c;
}

// ---------- outbox ----------
function store(){ try{ return root.localStorage || null; }catch(_){ return null; } }
function outboxRead(){
  const s = store(); if(!s) return [];
  try{ const v = JSON.parse(s.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch(_){ return []; }
}
function outboxWrite(list){
  const s = store(); if(!s) return false;
  try{ s.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-OUTBOX_MAX))); return true; }
  catch(_){ return false; }   // quota exceeded: the run is lost, the case is not
}
// Same runId replaces rather than duplicates — a late flag re-ships the same run.
// Runs only. A feedback note carries its run's runId, so letting one in here would replace
// that run's record, and each later note the one before. Notes are sent while the player
// waits and the form says what happened; they are refused here, loudly, with false.
function outboxPush(rec){
  if(isFeedback(rec)) return false;
  const l = outboxRead();
  const i = l.findIndex(x => x && x.runId === rec.runId);
  if(i >= 0) l[i] = rec; else l.push(rec);
  return outboxWrite(l);
}
async function outboxFlush(send){
  const l = outboxRead(); if(!l.length) return 0;
  const keep = []; let sent = 0;
  for(const rec of l){
    let ok = false;
    try{ ok = await send(rec); }catch(_){ ok = false; }
    if(ok) sent++; else keep.push(rec);
  }
  outboxWrite(keep);
  return sent;
}

// Ship once; on any failure the record waits in the outbox for the next load.
// Never throws — a logging failure must never surface in the middle of a debrief.
async function ship(rec, send){
  const payload = fit(rec);
  let ok = false;
  try{ ok = await send(payload); }catch(_){ ok = false; }
  if(!ok) outboxPush(payload);
  return ok;
}

root.RunLog = { SCHEMA, MAX_BYTES, OUTBOX_KEY, OUTBOX_MAX,
                Recorder, makeRunId, localISO, redactText, redactValue, tooBig, fit,
                outboxRead, outboxWrite, outboxPush, outboxFlush, ship,
                FEEDBACK_SCHEMA, FEEDBACK_TEXT_MAX, feedback, isFeedback };
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.RunLog;
})(typeof globalThis !== 'undefined' ? globalThis : this);
