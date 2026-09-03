// MediSim ER — who you are, and where your training log lives.
//
// Kim: "I don't want everybody to see my training log. I want everybody to have their
// individual training logs."
//
// The log has always been one browser's localStorage: private to the machine, shared by
// anyone who uses it, invisible from any other device. Signing in with Google moves it to
// a row-level-secured table where each person can read only their own rows, and it follows
// them to the phone. NOTHING ELSE IS GATED — every case plays signed out, exactly as before.
//
// The whole app touches the log through two functions, getCaseLog() and saveCaseLog(), and
// twelve consumers read it SYNCHRONOUSLY (game-layer's computeProgress among them). So the
// log stays an in-memory array that is hydrated on sign-in, never fetched on read.
//
// Classic browser script (sets globalThis.Account) so tests can load it in node the same
// way instant-engine.js and runlog.js do. No dependencies; supabase-js is injected.
(function(root){
'use strict';

const LOG_KEY   = 'ms_log';                        // the signed-out log, as it always was
const userKey   = uid => 'ms_log:' + uid;          // one cache per person, for instant paint
const outboxKey = uid => 'ms_log_outbox:' + uid;   // writes the server has not taken yet
const mergedKey = uid => 'ms_merged:' + uid;       // this browser has offered its runs once
const OUTBOX_MAX = 200;

function store(){
  try{ return root.localStorage || null; }catch(_){ return null; }   // some embeds throw
}
function readJSON(key, fallback){
  const s = store(); if(!s) return fallback;
  try{ const v = JSON.parse(s.getItem(key) || 'null'); return v == null ? fallback : v; }
  catch(_){ return fallback; }
}
function writeJSON(key, value){
  const s = store(); if(!s) return false;
  try{ s.setItem(key, JSON.stringify(value)); return true; }catch(_){ return false; }
}
function drop(key){ const s = store(); if(s){ try{ s.removeItem(key); }catch(_){ } } }

// A stable id for an entry, so the same run can never be uploaded twice. New entries carry
// a uuid stamped when they are written; the runs already in a browser predate the field, so
// they get one derived from their own content — identical entries collapse to one row, and
// a merge that is interrupted and retried does not duplicate them.
function entryId(e){
  if(e && e.entry_id) return e.entry_id;
  const seed = [e && e.when, e && e.id, e && e.label, e && e.diagnosis,
                e && e.score, e && e.simMin, e && e.died].join('|');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for(let i = 0; i < seed.length; i++){
    const c = seed.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c) * 2246822519 + h1) >>> 0;
  }
  return 'legacy-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
function newId(){
  try{ if(root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); }catch(_){ }
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const A = {
  ready: false,        // init() has settled
  enabled: false,      // a project is configured at all
  client: null,
  _user: null,
  _log: null,          // the in-memory array every consumer reads
  _uid: null,
  _onChange: null,
  _pending: false,     // a sign-in redirect is in flight
  _syncing: false,
  _offline: false,     // the last server call failed; the cache is still good
};

function emit(){ try{ if(A._onChange) A._onChange(A._user); }catch(_){ } }

// ------------------------------------------------------------------ the log, synchronously
function log(){
  if(A._uid) return A._log || (A._log = readJSON(userKey(A._uid), []));
  return readJSON(LOG_KEY, []);
}
function append(entry){
  const e = Object.assign({}, entry);
  if(!e.entry_id) e.entry_id = newId();
  if(!A._uid){                                   // signed out: exactly the old behaviour
    const l = readJSON(LOG_KEY, []); l.push(e);
    writeJSON(LOG_KEY, l.slice(-500));
    return e;
  }
  const l = log(); l.push(e);
  A._log = l;
  writeJSON(userKey(A._uid), l);                 // the server keeps everything; so does this
  push(e);                                       // …and it goes up, or waits in the outbox
  return e;
}

// ------------------------------------------------------------------------ the server side
function rows(uid, entries){
  return entries.map(e => ({ user_id: uid, entry_id: entryId(e), entry: e }));
}
async function upsert(uid, entries){
  if(!A.client || !entries.length) return false;
  try{
    const { error } = await A.client.from('case_log')
      .upsert(rows(uid, entries), { onConflict: 'user_id,entry_id', ignoreDuplicates: true });
    return !error;
  }catch(_){ return false; }
}
// One entry. On any failure it waits in this user's outbox for the next load or the next
// flush — a case is never lost because the network was.
async function push(e){
  const uid = A._uid; if(!uid) return false;
  const ok = await upsert(uid, [e]);
  if(!ok){
    const q = readJSON(outboxKey(uid), []);
    if(!q.some(x => entryId(x) === entryId(e))) q.push(e);
    writeJSON(outboxKey(uid), q.slice(-OUTBOX_MAX));
    A._offline = true; emit();
  }else if(A._offline){ A._offline = false; emit(); }
  return ok;
}
async function flush(){
  const uid = A._uid; if(!uid) return 0;
  const q = readJSON(outboxKey(uid), []);
  if(!q.length) return 0;
  const ok = await upsert(uid, q);
  if(ok){ drop(outboxKey(uid)); A._offline = false; emit(); return q.length; }
  return 0;
}
// Everything this person has ever done, oldest first — the order every consumer of
// getCaseLog() already assumes.
async function hydrate(uid){
  if(!A.client) return false;
  A._syncing = true;
  try{
    const { data, error } = await A.client.from('case_log')
      .select('entry_id, entry, created_at').order('created_at', { ascending: true });
    if(error || !Array.isArray(data)) throw error || new Error('no rows');
    const l = data.map(r => Object.assign({}, r.entry, { entry_id: r.entry_id }));
    A._log = l; writeJSON(userKey(uid), l);
    A._offline = false;
    return true;
  }catch(_){
    // A paused free-tier project, or no signal. The cache is still this person's log —
    // keep showing it, keep them signed in, and try again later. Losing the session here
    // would read as "you have been signed out", which is both wrong and alarming.
    A._offline = true;
    return false;
  }finally{ A._syncing = false; A._syncing = false; emit(); }
}

// ------------------------------------------------------------------------------- merging
// The runs sitting in this browser from before anyone signed in. Offered ONCE per person
// per browser, and never taken silently: on a shared computer a silent merge would file a
// stranger's cases under whoever signs in next, and delete them from under them.
function pendingMerge(){
  if(!A._uid) return null;
  const s = store(); if(s && s.getItem(mergedKey(A._uid))) return null;
  const local = readJSON(LOG_KEY, []);
  if(!local.length) return null;
  return { count: local.length, first: local[0].when || '', last: local[local.length - 1].when || '' };
}
// Take them. The local copy is cleared ONLY after the upload has actually succeeded; if it
// fails, nothing is lost and the offer comes back next time.
async function mergeLocal(){
  const uid = A._uid; if(!uid) return false;
  const local = readJSON(LOG_KEY, []);
  if(!local.length){ writeJSON(mergedKey(uid), 1); return true; }
  const ok = await upsert(uid, local);
  if(!ok) return false;
  drop(LOG_KEY);
  writeJSON(mergedKey(uid), 1);
  await hydrate(uid);
  return true;
}
// Leave them where they are. The offer is not repeated; the local runs stay readable to
// anyone who uses this browser signed out, which is what "leave them here" means.
function declineMerge(){
  if(A._uid) writeJSON(mergedKey(A._uid), 1);
  emit();
}

// ---------------------------------------------------------------------------- the session
function shapeUser(u){
  if(!u) return null;
  const m = u.user_metadata || {};
  const name = m.full_name || m.name || '';
  return { id: u.id, email: u.email || '', name,
           first: (name.split(/\s+/)[0] || (u.email || '').split('@')[0] || 'you'),
           avatar: m.avatar_url || m.picture || '' };
}
// Keyed on WHO, never on the event name: SIGNED_IN fires again whenever a tab regains
// focus after a token refresh, and the OAuth return delivers SIGNED_IN and INITIAL_SESSION
// for the same session. Re-hydrating on each of those would be a wasted round trip at best
// and a flicker at worst.
function onSession(session){
  const u = shapeUser(session && session.user);
  const uid = u ? u.id : null;
  if(uid === A._uid){ if(u) A._user = u; return; }
  A._user = u; A._uid = uid; A._log = null;
  if(uid){
    A._log = readJSON(userKey(uid), []);   // paint from cache immediately…
    emit();
    setTimeout(async () => {               // …then catch up, off the auth callback
      await hydrate(uid);
      await flush();
    }, 0);
  }else emit();
}

async function init(opts){
  const o = opts || {};
  A._onChange = o.onChange || null;
  A.enabled = !!(o.url && o.anonKey);
  A.ready = true;
  if(!A.enabled){ emit(); return null; }
  // Only reach for the library when it can do something: a visitor who has never signed in
  // and is not signing in now should not fetch a third-party script at all.
  const s = store();
  const ref = String(o.url).replace(/^https?:\/\//, '').split('.')[0];
  const hasSession = !!(s && s.getItem('sb-' + ref + '-auth-token'));
  const returning = /[?&](code|error)=/.test(String(o.search || ''));
  if(!hasSession && !returning && !o.force){ emit(); return null; }
  try{
    const create = o.createClient || (root.supabase && root.supabase.createClient) ||
      (o.loadScript ? await o.loadScript(o.script, o.integrity).then(() => root.supabase && root.supabase.createClient) : null);
    if(!create) throw new Error('supabase-js unavailable');
    // PKCE must be asked for — the library still defaults to the implicit flow, which
    // returns tokens in the URL fragment.
    A.client = create(o.url, o.anonKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    A.client.auth.onAuthStateChange((_evt, session) => onSession(session));
    const { data } = await A.client.auth.getSession();
    onSession(data && data.session);
    return A._user;
  }catch(_){
    A.client = null; A.enabled = A.enabled && false;
    emit(); return null;
  }
}

async function signIn(redirectTo){
  if(A._pending) return;
  A._pending = true; emit();
  try{
    if(!A.client) throw new Error('not initialised');
    const { error } = await A.client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectTo, queryParams: { prompt: 'select_account' } }
    });
    if(error) throw error;
  }catch(_){ A._pending = false; emit(); }
}
async function signOut(){
  try{
    // 'local', not the default 'global': signing out on the laptop must not sign you out
    // on the phone in your pocket.
    if(A.client) await A.client.auth.signOut({ scope: 'local' });
  }catch(_){ }
  const uid = A._uid;
  if(uid){ drop(userKey(uid)); drop(outboxKey(uid)); }
  A._user = null; A._uid = null; A._log = null; A._offline = false;
  emit();
}

function status(){
  const uid = A._uid;
  return { enabled: A.enabled, ready: A.ready, user: A._user, pending: A._pending,
           offline: A._offline, syncing: A._syncing,
           waiting: uid ? readJSON(outboxKey(uid), []).length : 0 };
}

root.Account = { init, signIn, signOut, log, append, flush, status,
                 pendingMerge, mergeLocal, declineMerge,
                 entryId, newId, _state: A };
if(typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.Account;
})(typeof globalThis !== 'undefined' ? globalThis : this);
