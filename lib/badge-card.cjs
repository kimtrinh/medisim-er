// lib/badge-card.cjs
//
// The share card is described as DATA — a size, a link, and a list of draw
// instructions — not drawn here. Two things fall out of that:
//   1. The layout is testable in plain Node (tests/badge-share.test.cjs),
//      no canvas, no browser, no screenshot diffing.
//   2. The page that actually paints the card (badges/*.html, a later task)
//      holds no layout logic of its own — it just replays these ops against
//      a canvas — so there is exactly one place layout can drift.
//
// Nothing personal goes on the card, on purpose. Kim: nobody's name is ever
// published. The card is generated on the learner's own device from data
// already in their browser (which badges they hold) and the page it links
// to is about the badge, not the person who earned it. That is why there is
// no server and no user record behind any of this — there is nothing to
// leak because nothing identifying was ever collected.
'use strict';

const WIDTH = 1200;
const HEIGHT = 630;
const SITE = 'https://kimtrinh.github.io/medisim-er';

// Tier colours match the medal metal. The untiered badge is not a fourth
// tier — a specialty with under 10 cases isn't "worse," it just doesn't
// have enough case library yet to support bronze/silver/gold banding — so
// it gets a colour that reads as its own thing rather than a rung on the
// bronze/silver/gold ladder. Teal keeps it out of that metal family
// entirely (no brown/grey/yellow relative) while still reading as a solid,
// earned badge rather than an error or a placeholder.
const TIER_INK = {
  bronze: '#c98c5a',
  silver: '#c8ccd2',
  gold: '#e8b830',
  flat: '#3fa9a0',
};

// A shareable badge id is either `expert-<sys>-<tier>` (a specialty with
// 10+ cases, tiered) or `expert-<sys>` (a specialty with fewer, untiered).
// Everything else — first-save, night-shift, spec-cv, a made-up tier like
// "platinum" — is a shelf badge, not a share badge, and is refused.
const TIERS = new Set(['bronze', 'silver', 'gold']);

function parse(badge){
  const id = badge && badge.id;
  if(typeof id !== 'string' || id === '' || !id.startsWith('expert-'))
    throw new Error('not a shareable badge: ' + id);
  const rest = id.slice('expert-'.length);
  const parts = rest.split('-');
  if(parts.length === 2 && TIERS.has(parts[1])){
    const [sys, tier] = parts;
    if(!sys) throw new Error('not a shareable badge: ' + id);
    return { sys, tier };
  }
  if(parts.length === 1){
    const sys = parts[0];
    if(!sys) throw new Error('not a shareable badge: ' + id);
    return { sys, tier: null };
  }
  // Anything else — an unknown tier word (expert-cv-platinum), an extra
  // segment, etc. — is not a shape this builder recognises.
  throw new Error('not a shareable badge: ' + id);
}

function artKey({ sys, tier }){
  return tier ? sys + '-' + tier : sys;
}

// ---- Text layout, done here so wrapping can never collide -----------------
//
// The page draws a wrapped text op by greedily packing words into lines no
// wider than `wrap` (wrapCanvasText in medisim-er-local.html, using the
// canvas's own measureText) and stacking those lines Math.round(size*1.25)
// px apart. That line count depends on the actual glyph widths of a real
// font in a real browser — this file has neither. So instead of hardcoding
// the next op's y (which is what let "Earned 2026-09-20" print straight
// through the last line of a wrapped description), every block's height is
// ESTIMATED here from an assumed character width, and the next block is
// placed after that estimate.
//
// The assumed width (0.65em, +10% for bold) is deliberately higher than a
// real system sans-serif's true average (~0.5-0.55em) — real text is
// narrower than this builder assumes, so it wraps to no more lines than
// estimated, so the space reserved for it is never less than it needs.
// Overshooting costs a few px of extra gap; undershooting is the bug that
// prompted this file to exist.
const CHAR_WIDTH_EM = 0.65;
const BOLD_WIDTH_BONUS = 1.10;

function estimatedWidth(str, size, weight){
  return str.length * size * CHAR_WIDTH_EM * (weight === 'bold' ? BOLD_WIDTH_BONUS : 1);
}

// Mirrors wrapCanvasText's own greedy packing so the line count it produces
// is the same shape of estimate, just fed an assumed width instead of a
// measured one.
function lineCount(text, size, wrap, weight){
  if(!wrap) return 1;
  const words = String(text == null ? '' : text).split(' ').filter(Boolean);
  if(!words.length) return 1;
  let lines = 1, line = '';
  for(const w of words){
    const test = line ? line + ' ' + w : w;
    if(line && estimatedWidth(test, size, weight) > wrap){ lines++; line = w; }
    else line = test;
  }
  return lines;
}

function lineHeight(size){ return Math.round(size * 1.25); } // matches wrapCanvasText exactly

// The vertical span a text op occupies, top to bottom, generous on both
// ends: `size` full px of headroom above the baseline (a real ascent is
// closer to 0.75em) and a full extra line's worth below the last baseline.
function textExtent(op){
  const lines = op.wrap ? lineCount(op.text, op.size, op.wrap, op.weight) : 1;
  const top = op.y - op.size;
  const bottom = top + lines * lineHeight(op.size);
  return { top, bottom, lines };
}

// ---- The card ---------------------------------------------------------

const BG = '#0f172a';
const TEXT_HEAD = '#f8fafc';
const TEXT_BODY = '#cbd5e1';
const TEXT_MUTED = '#94a3b8';
const TEXT_QUIET = '#64748b';

function build(badge, opts){
  const { sys, tier } = parse(badge);
  const key = artKey({ sys, tier });
  const date = (opts && opts.date) || '';
  const ink = tier ? TIER_INK[tier] : TIER_INK.flat;
  const url = SITE + '/badges/' + key + '.html';

  const ops = [];

  // Background panel + a top accent band in the tier colour, so the card
  // reads at a glance even before anyone looks at the medallion.
  ops.push({ op: 'rect', x: 0, y: 0, w: WIDTH, h: HEIGHT, fill: BG });
  ops.push({ op: 'rect', x: 0, y: 0, w: WIDTH, h: 14, fill: ink });

  // The medallion. It is the thing people look at, so it gets real size and
  // sits in its own colour, not a token-sized token in the corner — and it is
  // where Kim's Gemini artwork will actually live once it exists, not just on
  // the public badge page. The ring is a full 50px band (not a hairline) so it
  // reads as a deliberate frame at real card size, not just in a shrunk preview.
  const MED_CX = 250, MED_CY = 296, MED_R = 205, MED_INNER_R = 155;
  ops.push({ op: 'circle', x: MED_CX, y: MED_CY, r: MED_R, fill: ink });
  ops.push({ op: 'circle', x: MED_CX, y: MED_CY, r: MED_INNER_R, fill: BG });
  // The artwork itself, media/badge-<key>.png|svg (loadBadgeArt in
  // medisim-er-local.html) — `key` is carried on the op so anything replaying
  // these ops (the page, a test) knows which file this medallion is asking
  // for without separately re-deriving artKey(badge). `round` clips it to the
  // inner circle so real art fills the frame edge-to-edge, corners and all,
  // instead of floating inside it as a bare square. Art is a nice-to-have,
  // not a requirement (loadBadgeArt resolves a missing file to null), so
  // fallbackText/-Size/-Fill say what the medallion looks like without it —
  // the same badge icon that used to be the whole medallion, now sized to
  // fill it rather than sit small in the middle of a dark circle.
  ops.push({ op: 'image', key,
    x: MED_CX - MED_INNER_R, y: MED_CY - MED_INNER_R, w: MED_INNER_R * 2, h: MED_INNER_R * 2,
    round: true, fallbackText: badge.icon || '🏅', fallbackSize: 220, fallbackFill: ink });

  // The right-hand column: name, then the bar it took, then the date —
  // a headline over its own supporting lines, not three lines floating at
  // the same weight down the middle of the card. Each block's bottom is
  // computed from the one above it, via textExtent, so nothing can drift
  // into the line below it the way the date line drifted into the
  // description before this file tracked line counts at all.
  const COL_X = MED_CX + MED_R + 55;   // 510
  const COL_WRAP = WIDTH - 60 - COL_X; // right margin at 1140

  let cursorTop = 108;
  const place = (text, { size, weight = 'normal', fill, wrap, gap = 20 }) => {
    const y = cursorTop + size; // baseline, leaving `size` of headroom above cursorTop
    const op = { op: 'text', text, x: COL_X, y, size, weight, fill };
    if(wrap) op.wrap = wrap;
    ops.push(op);
    cursorTop = textExtent(op).bottom + gap;
    return op;
  };

  place(badge.name, { size: 58, weight: 'bold', fill: TEXT_HEAD, wrap: COL_WRAP, gap: 26 });
  // The bar it took — the desc line names it ("90 or better"), so surface
  // the desc rather than re-deriving the number here and risking drift.
  place(badge.desc || '', { size: 28, fill: TEXT_BODY, wrap: COL_WRAP, gap: 22 });
  place('Earned ' + date, { size: 24, fill: TEXT_MUTED, gap: 0 });

  // Footer: the link back and the not-a-certification line. Present and
  // legible, but quiet, and full-width — it is the one part of the card
  // that has to survive a screenshot at thumbnail size, so it does not sit
  // squeezed into the text column, it runs under everything, medallion
  // included. Its own top is held to below both the column above it and
  // the medallion, whichever reaches further down.
  const FOOTER_X = 90;
  const FOOTER_WRAP = WIDTH - 60 - FOOTER_X;
  let footerTop = Math.max(cursorTop, MED_CY + MED_R + 24);
  ops.push({ op: 'rect', x: FOOTER_X, y: footerTop, w: WIDTH - 60 - FOOTER_X, h: 2, fill: '#1e293b' });
  footerTop += 18;

  const placeFooter = (text, { size, fill, wrap, gap = 8 }) => {
    const y = footerTop + size;
    const op = { op: 'text', text, x: FOOTER_X, y, size, weight: 'normal', fill };
    if(wrap) op.wrap = wrap;
    ops.push(op);
    footerTop = textExtent(op).bottom + gap;
    return op;
  };

  // Provenance + the disclaimer that keeps a shared badge honest: this is
  // simulation practice, not a credential.
  placeFooter('MediSim ER — simulation practice, not a certification.',
    { size: 22, fill: TEXT_MUTED, wrap: FOOTER_WRAP });
  placeFooter(url, { size: 20, fill: TEXT_QUIET });

  return { width: WIDTH, height: HEIGHT, url, ops };
}

// ---- The case challenge card ("Can you save this patient?") -------------
//
// Kim, 2026-09-28. The card a player shares after a case: the patient (never the diagnosis — the link
// opens that case, and the answer is the point), their own result, and a link that starts the same case
// for whoever taps it. Like the badge card: built on the player's device, no name, nothing collected.

const SAVED_INK = '#10b981';
const LOST_INK = '#94a3b8';   // not red, and no celebration — a lost patient is still worth the challenge

// "58-year-old man", "7-year-old boy", "4-month-old girl", "Newborn boy". From the case's own patient
// record, so it can never say more than the case's opening line does.
function patientWords(p){
  const pt = p || {};
  const sex = String(pt.sex || '').toLowerCase();
  const age = pt.age;
  if(age === 'newborn' || (typeof age === 'number' && age < 1/12)) return 'Newborn ' + (sex === 'female' ? 'girl' : sex === 'male' ? 'boy' : 'baby');
  const kid = typeof age === 'number' && age < 18;
  const noun = sex === 'female' ? (kid ? 'girl' : 'woman') : sex === 'male' ? (kid ? 'boy' : 'man') : (kid ? 'child' : 'adult');
  if(typeof age === 'number' && age < 1) return Math.max(1, Math.round(age * 12)) + '-month-old ' + noun;
  if(typeof age === 'number') return Math.round(age) + '-year-old ' + noun;
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

const CASE_ID_RE = /^[a-z0-9-]{1,80}$/;
// The link names the case by a CODE, not its id: the ids carry the diagnosis ("resus-acls-torsades",
// "...-pea-tension"), and a link is read before the case is played. FNV-1a over the id, base 36 —
// stable across deploys, no table to keep in step; the page finds the case by coding every id it has
// (tests/case-challenge.test.cjs checks the whole library is collision-free).
function caseCode(id){
  let h = 0x811c9dc5;
  const s = String(id || '');
  for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

function buildCase(c){
  const o = c || {};
  if(!CASE_ID_RE.test(String(o.caseId || ''))) throw new Error('not a case id: ' + o.caseId);
  const saved = !!o.saved;
  const ink = saved ? SAVED_INK : LOST_INK;
  const url = SITE + '/?c=' + caseCode(o.caseId);
  const ops = [];
  ops.push({ op: 'rect', x: 0, y: 0, w: WIDTH, h: HEIGHT, fill: BG });
  ops.push({ op: 'rect', x: 0, y: 0, w: WIDTH, h: 14, fill: ink });

  const MED_CX = 230, MED_CY = 290, MED_R = 170, MED_INNER_R = 128;
  ops.push({ op: 'circle', x: MED_CX, y: MED_CY, r: MED_R, fill: ink });
  ops.push({ op: 'circle', x: MED_CX, y: MED_CY, r: MED_INNER_R, fill: BG });
  ops.push({ op: 'image', key: null, x: MED_CX - MED_INNER_R, y: MED_CY - MED_INNER_R, w: MED_INNER_R * 2, h: MED_INNER_R * 2,
    round: true, fallbackText: saved ? '🫀' : '🩺', fallbackSize: 150, fallbackFill: ink });

  const COL_X = MED_CX + MED_R + 60;   // 460
  const COL_WRAP = WIDTH - 60 - COL_X;
  let cursorTop = 52;
  const place = (text, { size, weight = 'normal', fill, wrap, gap = 18 }) => {
    const y = cursorTop + size;
    const op = { op: 'text', text, x: COL_X, y, size, weight, fill };
    if(wrap) op.wrap = wrap;
    ops.push(op);
    cursorTop = textExtent(op).bottom + gap;
    return op;
  };
  place('CAN YOU SAVE THIS PATIENT?', { size: 28, weight: 'bold', fill: ink, gap: 14 });
  place(String(o.title || 'An emergency'), { size: 46, weight: 'bold', fill: TEXT_HEAD, wrap: COL_WRAP, gap: 6 });
  place(patientWords(o.patient), { size: 28, fill: TEXT_BODY, gap: 22 });
  const score = Math.max(0, Math.min(100, Math.round(Number(o.score) || 0)));
  place((saved ? 'Patient saved' : 'Patient lost') + ' · ' + score + '/100', { size: 32, weight: 'bold', fill: TEXT_HEAD, gap: 8 });
  const bits = [];
  if(Number.isInteger(o.met) && Number.isInteger(o.total) && o.total > 0) bits.push(o.met + ' of ' + o.total + ' critical actions');
  if(Number.isInteger(o.hints)) bits.push(o.hints === 0 ? 'no hints' : o.hints + (o.hints === 1 ? ' hint' : ' hints'));
  if(bits.length) place(bits.join(' · '), { size: 24, fill: TEXT_BODY, wrap: COL_WRAP, gap: 8 });
  if(o.rateLine) place(String(o.rateLine), { size: 24, fill: TEXT_MUTED, wrap: COL_WRAP, gap: 8 });
  if(o.rank) place('Rank: ' + o.rank, { size: 20, fill: TEXT_QUIET, gap: 0 });

  const FOOTER_X = 60;
  const FOOTER_WRAP = WIDTH - 60 - FOOTER_X;
  let footerTop = Math.max(cursorTop + 8, MED_CY + MED_R + 24);
  ops.push({ op: 'rect', x: FOOTER_X, y: footerTop, w: WIDTH - 60 - FOOTER_X, h: 2, fill: '#1e293b' });
  footerTop += 12;
  const foot = (text, size, fill) => { const op = { op: 'text', text, x: FOOTER_X, y: footerTop + size, size, weight: 'normal', fill, wrap: FOOTER_WRAP };
    ops.push(op); footerTop = textExtent(op).bottom + 6; };
  foot('MediSim ER — emergency medicine simulation practice, not a certification.', 20, TEXT_MUTED);
  foot(url, 20, TEXT_QUIET);
  return { width: WIDTH, height: HEIGHT, url, ops, footerBottom: footerTop };
}

const api = { build, parse, artKey, buildCase, patientWords, caseCode, WIDTH, HEIGHT, SITE, TIER_INK, lineCount, lineHeight, textExtent };
// Assign the global FIRST. In a browser `module` does not exist, so the
// guarded CommonJS export below is a no-op there — but if it were written
// first and something in it ever threw, the global assignment beneath it
// would never run. Order makes the global assignment safe even if the
// export line stops being safe later.
if(typeof globalThis !== 'undefined') globalThis.BadgeCard = api;
if(typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = api;
