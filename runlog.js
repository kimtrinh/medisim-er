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

const SCHEMA = 1;
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
    case: { goldId: m.goldId || null, title: /\.pdf$/i.test(m.title||'') ? 'uploaded educational PDF' : redactText(m.title), diagnosis: m.diagnosis || '',
            criticalActions: (m.criticalActions || []).slice() },
    turns: [], debrief: null, flags: []
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
function outboxPush(rec){
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
                outboxRead, outboxWrite, outboxPush, outboxFlush, ship };
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.RunLog;
})(typeof globalThis !== 'undefined' ? globalThis : this);
