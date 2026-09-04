// instant-engine.js — the Instant Mode engine for MediSim ER.
// Deterministic, zero-network, pure logic (no DOM): matches the player's typed
// orders against a pre-baked per-case "pack" and returns the SAME response JSON
// shape the AI engine (ENGINE_SYSTEM) returns.
//
// Loaded as a CLASSIC browser <script> (sets globalThis.InstantEngine) and, for
// the Node test suite, evaluated in-context via vm (also sets globalThis). Keep
// this file dependency-free and free of ESM/CommonJS syntax at top level so it
// runs verbatim in both places.
(function (root) {
'use strict';

// ---------- Abbreviation / synonym expansion (token-level, applied by normalize) ----------
// Keys are single lowercase tokens as typed; values are the canonical expansion.
// Multi-word phrases are handled by PHRASES below (applied before tokenization).
const ABBREV = {
  'cbc':'complete blood count', 'bmp':'basic metabolic panel', 'cmp':'comprehensive metabolic panel',
  'chem7':'basic metabolic panel', 'chem10':'comprehensive metabolic panel',
  'lfts':'liver function tests', 'lft':'liver function tests',
  'coags':'coagulation panel', 'inr':'inr', 'ptt':'partial thromboplastin time',
  'vbg':'venous blood gas', 'abg':'arterial blood gas', 'ua':'urinalysis',
  'ucx':'urine culture', 'bcx':'blood cultures', 'cx':'cultures',
  'trop':'troponin', 'dimer':'d dimer', 'bnp':'bnp', 'hcg':'pregnancy test', 'bhcg':'pregnancy test',
  'ekg':'electrocardiogram', 'ecg':'electrocardiogram',
  'cxr':'chest x ray', 'xray':'x ray', 'xr':'x ray', 'kub':'abdominal x ray',
  'ct':'computed tomography', 'cta':'ct angiography', 'ctpa':'ct angiography chest',
  'mri':'magnetic resonance imaging', 'mra':'mr angiography',
  // 'us' is NOT here: it is also the pronoun — "the PCC buys us hours" asked
  // "Ultrasound of what?". The phrase rules below expand it only in imaging contexts.
  'ruq':'right upper quadrant', 'tvus':'transvaginal ultrasound',
  'pocus':'point of care ultrasound',   // bedside ultrasound classified as an exam without this
  // Consult shorthand. "call peds", "call ortho", "call cards" are how the page actually
  // gets made; without these they classified as 'other' and reached no consult responder,
  // and "neuro" was worse than nothing — it read as a neurological EXAM.
  'peds':'pediatrics', 'ortho':'orthopedics', 'cards':'cardiology', 'neuro':'neurology',
  'psych':'psychiatry', 'onc':'oncology',
  'pulm':'pulmonology', 'ophtho':'ophthalmology', 'optho':'ophthalmology',
  'derm':'dermatology', 'rheum':'rheumatology', 'omfs':'oral maxillofacial surgery',
  'picu':'pediatric intensive care', 'nicu':'neonatal intensive care',
  // Expansions only where the expansion does NOT contain the abbreviation, or normalize
  // stops being idempotent (that is why 'inr' is a SOLO_TESTS key instead: its canonical
  // form 'prothrombin time inr' still contains the token 'inr').
  'ck':'creatine kinase', 'cpk':'creatine kinase', 'ldh':'lactate dehydrogenase',
  'retic':'reticulocyte count', 'retics':'reticulocyte count', 'hapto':'haptoglobin',
  'echo':'echocardiogram', 'tte':'echocardiogram',
  'ivf':'iv fluids', 'ns':'normal saline', 'lr':'lactated ringers', 'd50':'dextrose 50',
  'asa':'aspirin', 'ntg':'nitroglycerin', 'nitro':'nitroglycerin', 'abx':'antibiotics',
  'o2':'oxygen', 'nrb':'non rebreather', 'bipap':'bipap', 'hfnc':'high flow nasal cannula',
  'tylenol':'acetaminophen', 'motrin':'ibuprofen', 'zofran':'ondansetron', 'toradol':'ketorolac',
  'rocephin':'ceftriaxone', 'zosyn':'piperacillin tazobactam', 'vanc':'vancomycin', 'vanco':'vancomycin',
  'keflex':'cephalexin', 'ancef':'cefazolin', 'cipro':'ciprofloxacin', 'levaquin':'levofloxacin',
  'bactrim':'trimethoprim sulfamethoxazole', 'septra':'trimethoprim sulfamethoxazole',
  'unasyn':'ampicillin sulbactam', 'cleocin':'clindamycin', 'zyvox':'linezolid',
  'cubicin':'daptomycin', 'macrobid':'nitrofurantoin', 'pcn':'penicillin', 'zovirax':'acyclovir',
  // 'levo' is deliberately NOT here: in an ED "levo" is levophed, not levofloxacin.
  'levophed':'norepinephrine', 'epi':'epinephrine', 'narcan':'naloxone',
  'gtt':'drip', 'prn':'as needed', 'stat':'now', 'hx':'history', 'pmh':'past medical history',
  'fh':'family history', 'sh':'social history', 'ros':'review of systems', 'nkda':'allergies',
  'dre':'rectal exam', 'cpr':'cpr', 'icu':'intensive care', 'ob':'obstetrics', 'gi':'gastroenterology',
  // Unit-specific ICUs: without these, "admit to the CICU" ended the case but
  // never matched a pack responder keyed to "admit to icu", silently losing
  // the disposition critical action. Every expansion keeps the words
  // "intensive care" so it still matches those aliases, and normalize() is
  // applied to the pack's aliases too, so a pack keyed literally to "picu"
  // expands the same way and keeps matching.
  'cicu':'cardiac intensive care', 'ccu':'coronary intensive care',
  'micu':'medical intensive care', 'sicu':'surgical intensive care',
  'picu':'pediatric intensive care', 'nicu':'neonatal intensive care',
  'lp':'lumbar puncture', 'io':'intraosseous', 'ivp':'iv push', 'im':'intramuscular',
  'tnk':'tenecteplase', 'tpa':'alteplase', 'roc':'rocuronium', 'sux':'succinylcholine',
  'mag':'magnesium', 'k':'potassium', 'na':'sodium', 'dka':'dka',
  // imaging-study abbreviations a real player types bare ("get a TEE", "order
  // a CTV") — without these classifyIntent saw 'other' and matchResponders'
  // non-imaging path EXCLUDED the very imaging responder whose alias matched,
  // so the study's critical action was never credited (playtest audit).
  // (fully-expanded values on purpose: an expansion containing the bare token
  // "ct"/"mr" would re-expand on a second normalize() pass — the same
  // idempotency trap "cta" hit; see the ct&angiography protect below)
  'ctv':'computed tomography venography', 'mrv':'magnetic resonance venography',
  'tee':'transesophageal echocardiogram',
  // Playtest round 3: "trops" was dropped from a five-test order, "chemistry"
  // silently vanished from a trauma panel, "anticoag" reached no responder, and
  // "examine the pelvis" missed a responder aliased "pelvis exam" ('exam' ≠
  // 'examine' under fuzz: 4 letters is below typo tolerance). All symmetric —
  // normalize() runs on pack aliases too.
  'trops':'troponin', 'lytes':'electrolytes',
  'chemistry':'basic metabolic panel', 'chems':'basic metabolic panel',
  'anticoag':'anticoagulation',
  'bicarb':'sodium bicarbonate',
  'examine':'exam', 'examining':'exam', 'examination':'exam',
  'rsi':'rapid sequence intubation',
  // Round 4: 'angiogram' is beyond fuzz of 'angiography'; d-strings are dextrose;
  // 'temp' must reach aliases written 'core temperature'.
  'angiogram':'angiography', 'angiograms':'angiography',
  'd5':'dextrose 5', 'd5w':'dextrose 5', 'd10':'dextrose 10', 'd10w':'dextrose 10', 'd25':'dextrose 25',
  'temp':'temperature',
  'phos':'phosphorus',
  'tox':'toxicology',
  'nsgy':'neurosurgery',
  // The transfusion word-forms are ONE order written two ways, and they cannot
  // reach each other: lev('transfuse','transfusion') is 3, and the fuzz
  // tolerance at 9 letters is 1. The packs use both — 89 aliases say
  // "transfusion", 52 say "transfuse" — so a player typing one form silently
  // missed every alias written in the other, and "blood transfusion" reached
  // NOTHING in cv-aortic-dissection, cv-massive-pe, eb-acute-liver-failure,
  // eb-hemorrhagic-shock and more, while "give blood" worked in the same packs.
  // normalize() runs on the pack's aliases too, so folding the forms onto one
  // token makes the two sides meet from either direction.
  //
  // 'transfusion' is the canonical, not 'transfuse', for one measured reason:
  // it is 11 letters, so fuzz tolerance around it is 2 rather than 1, and that
  // is what catches the misspelling a real player actually typed —
  // lev('tranfusion','transfusion') is 1. Folding the other way would have left
  // "blood tranfusion" unrecognised all over again. Swept the corpus for
  // collisions first: across 6,803 distinct alias tokens the only token within
  // lev 2 of 'transfusion' is 'transfusions', which is the same word.
  //
  // MTP is deliberately NOT folded in here. Ordering blood and activating a
  // massive transfusion protocol are different acts, and a generic blood order
  // must never credit an MTP objective.
  'transfuse':'transfusion', 'transfused':'transfusion', 'transfuses':'transfusion',
  'transfusing':'transfusion', 'transfusions':'transfusion',
  // Same morphological gap, one row down: 'prbc' is 4 letters, and fuzzyHas
  // demands an EXACT match below 5, so a pack aliased "prbc" (23 aliases) was
  // unreachable by a player who typed "prbcs" (12 aliases) and vice versa.
  // Only the plural is folded — the product keeps its own identity and does not
  // become 'transfusion', because packs that name the product and packs that
  // name the protocol are crediting different things.
  'prbcs':'prbc'
};
// Phrase-level rewrites applied BEFORE tokenization: protect compounds from clause
// splitting ("abdomen and pelvis" must not split at "and") and normalize spellings.
const PHRASES = [
  [/\babd(omen)?\s+and\s+pelvis\b/g, 'abdomen pelvis'],
  [/\bhead\s+and\s+neck\b/g, 'head neck'],
  [/\ba\s*&\s*p\b/g, 'abdomen pelvis'],
  [/\b12\s*[- ]?\s*lead\b/g, '12 lead'],
  [/\bpt\s*\/\s*inr\b/g, 'prothrombin time inr'],
  [/\binr\s*\/\s*pt\b/g, 'prothrombin time inr'],   // clinicians write it both ways
  [/\bpt\s*\/\s*ptt\b/g, 'prothrombin time partial thromboplastin time'],
  [/\bt\s*&\s*s\b/g, 'type and screen'],
  [/\bx\s*-?\s*ray\b/g, 'x ray'],
  [/\bu\s*\/\s*a\b/g, 'urinalysis'],
  [/\bblood\s+gas\b/g, 'blood gas'],
  // Apostrophe stripping split contractions into two tokens, and every
  // negation regex silently failed: "don't slam narcan yet" GAVE the narcan.
  [/\bdon\s?t\b/g, 'dont'], [/\bwon\s?t\b/g, 'wont'], [/\bcan\s?t\b/g, 'cant'],
  [/\bdoesn\s?t\b/g, 'doesnt'], [/\bdidn\s?t\b/g, 'didnt'], [/\bisn\s?t\b/g, 'isnt'],
  [/\bshouldn\s?t\b/g, 'shouldnt'], [/\bwouldn\s?t\b/g, 'wouldnt'], [/\bhaven\s?t\b/g, 'havent'],
  // "CT angiogram of the head" returned the plain CT Head: 'angiogram' is three
  // edits from 'angiography', beyond fuzz. Collapse to 'cta' pre-tokenization.
  [/\bct\s+angiograms?\b/g, 'cta'],
  [/\bct\s+angio\b/g, 'cta'],
  // A three-region CT order silently dropped two regions (best-match-wins keeps
  // one study per imaging clause): split it into two orders up front.
  [/\b(ct|cat scan) (of )?(the )?chest,? (and )?abdomen,?( and)? pelvis\b/g, '$1 chest , $1 abdomen pelvis'],
  [/\bpan[- ]?scan\b/g, 'ct chest , ct abdomen pelvis'],
  // The drug contains the test: "prothrombin complex concentrate" re-fired the
  // coagulation panel and printed a drifted INR beside the nurse's post-reversal
  // value. Both sides collapse to 'pcc' (packs alias it too).
  [/\bprothrombin\s+complex(\s+concentrate)?\b/g, 'pcc'],
  // FAST is an exam only when it is one — "I want that INR back fast" produced a
  // FAST exam via the old token expansion (removed from ABBREV; phrases below).
  [/\be[- ]fast\b/g, 'efast'],
  [/\bfast\s+scan\b/g, 'fast exam'],
  // 'us' expands to ultrasound ONLY in imaging contexts (see ABBREV note).
  [/\b(bedside|pelvic|renal|transvaginal|scrotal|abdominal|cardiac|lung|aorta|compression|ruq|luq|fast|formal|repeat) us\b/g, '$1 ultrasound'],
  [/\b(get|order|do|obtain|perform) (an? )?us\b/g, '$1 ultrasound'],
  [/\bus (of )?(the )?(abdomen|abdominal|pelvis|chest|kidney|renal|gallbladder|aorta|leg|scrotum|heart)\b/g, 'ultrasound $3'],
  // Brand PCC names collapse with the phrase rule above them.
  [/\bkcentra\b/g, 'pcc'],
  [/\boctaplex\b/g, 'pcc'],
  // "Transfusion medicine" is the SERVICE, not an order to transfuse. Once
  // ABBREV folds the verb 'transfuse' onto the noun 'transfusion', the bare
  // service name contains a transfusion-order token, and the corpus sweep
  // caught what that costs: "transfusion medicine" and "get transfusion
  // medicine on the phone" credited the blood critical action — and improved
  // the patient — in eleven packs, including a newborn who was narrated
  // receiving 31 mL of O-negative because someone paged the blood bank.
  // Joined with an underscore (a word character, so no token boundary survives
  // inside it) exactly the way normalize protects "hepatitis a". Applied to the
  // pack's aliases by the same pass, so the four packs that alias the service on
  // a consult responder keep matching it — and two of them, eb-priapism and
  // heme-sickle-stroke, now match it for the first time: "page the transfusion
  // service" reaches the consult objective they authored for exactly that. Two
  // packs lose a credit they should never have had (ob-postpartum-hemorrhage and
  // colitis-newonset-uc-megacolon both announced units of packed cells running
  // because someone named the service), which is HEAD's behavior corrected, not
  // preserved.
  [/\btransfusion[\s-]+(medicine|service|services)\b/g, 'transfusion_medicine']
];
// Compounds containing " and " that are ONE order/concept and must survive clause
// splitting (rewrite ' and '→' & ' pre-split so "type and cross" isn't torn apart).
const AND_PROTECT = [/type and screen/g, /type and cross(match)?/g, /morbidity and mortality/g,
  /check and repl(ace|ete|ete the)?/g, /watch and wait/g, /nil by mouth and/g,
  /head and neck/g, /input and output/g, /signs and symptoms/g, /rate and rhythm/g,
  // textbook single-concept phrases players actually type — splitting them at
  // "and" orphaned both halves from the responder aliases that credit them
  // (playtest audit: "hs and ts", "cold and wet", "insulin and dextrose",
  // "separate mom and <child>" all lost their critical-action credit)
  /hs and ts/g, /cold and wet/g, /warm and dry/g, /insulin and dextrose/g,
  // must capture the word AFTER "and" — the ' and '→' & ' rewrite only fires
  // when the match contains ' and ' with BOTH spaces inside it
  /separate (mom|mother|dad|father) and \w+/g];

function normalize(text){
  let s = String(text||'').toLowerCase();
  s = s.replace(/[,;]/g, ' , ');                       // commas/semicolons become standalone split tokens
  s = s.replace(/\s\+\s/g, ' , ');                     // "vanc + zosyn" is two orders, and + is stripped below
  // Sentence periods SPLIT (keep decimals): "get him on pads. 500cc LR bolus"
  // was one clause, and the nursing pads ack swallowed the bolus.
  s = s.replace(/(?<!\d)\.(?!\d)/g, ' , ');
  s = s.replace(/[^\w\s/&%.,-]/g, ' ');                // strip remaining punctuation
  for(const [re, rep] of PHRASES) s = s.replace(re, rep);
  // Hyphenated compounds tokenize as ONE token, so "two large-bore IVs" contained
  // no token 'large' or 'bore' and the commonest access order in the ED fell to
  // filler in three of six playtests. Split them (x-ray et al. were consumed by
  // the phrase rules above).
  s = s.replace(/(\w)-(\w)/g, '$1 $2');
  // "ct angiography" is what normalize() ITSELF produces from "cta"/"ctpa".
  // Protect it (same join/restore trick as AND_PROTECT below) so that
  // re-normalizing already-normalized text doesn't retokenize it and let the
  // leading "ct" independently re-expand via its OWN separate abbreviation
  // ("ct"->"computed tomography") — which would corrupt "ct angiography
  // chest" (CTA, PE protocol) into "computed tomography angiography chest"
  // (a different, generic CT chest study). Verified: without this,
  // normalize(normalize('cta chest')) !== normalize('cta chest').
  // Clinicians separate orders with slashes as readily as commas — "cbc/bmp/lactate/coags"
  // was a SINGLE unmatched clause and four labs vanished without a word. Split only when
  // both sides are long enough to be real order words, so "w/", "n/v", "s/p" and "d/c"
  // survive; the phrase rules above have already consumed pt/inr and friends.
  // A RATE IS NOT TWO ORDERS. The split below turns "cbc/bmp" into two labs, and it caught
  // "5 mcg/min" with it: norepinephrine reached the engine as "start norepinephrine at 5
  // mcg" plus a second clause reading "min", which then showed up as an order the sim did
  // not understand. Both sides must be three letters for that rule to fire, so mcg/kg/min
  // and mL/hr escaped by the luck of "kg" and "hr" being two — mcg/min had no such luck.
  // Protect unit-over-time pairs first and restore them straight after.
  s = s.replace(/\b(mcg|mg|g|ml|l|cc|meq|mmol|units?|iu)\s*\/\s*(kg|hr|hour|h|min|minute|day|dose)\b/g, '$1&$2');
  s = s.replace(/([a-z]{3,})\s*\/\s*(?=[a-z]{3,})/g, '$1 , ');
  s = s.replace(/\b(mcg|mg|g|ml|l|cc|meq|mmol|units?|iu)&(kg|hr|hour|h|min|minute|day|dose)\b/g, '$1/$2');
  // Placement verbs are interchangeable. Pack aliases pair a verb with the device
  // ("place an lma"), so only that verb matched and "drop an LMA size 4 as rescue" — how
  // the rescue is actually called — missed entirely. That single false negative left the
  // bridge action uncredited, fired the stage it guards, and arrested a playtested patient
  // who already had a secured airway. "pass" is excluded: "did he pass out" is history.
  s = s.replace(/\b(drop|insert|deploy|slip|slide|introduce)\s+(in\s+)?/g, 'place ');
  s = s.replace(/\bct angiography\b/g, 'ct&angiography');
  s = s.split(/\s+/).filter(Boolean)
       .map(t => ABBREV[t] || t)
       .join(' ');
  s = s.replace(/ct&angiography/g, 'ct angiography');
  // Clinicians type telegraphically — "irrigate wound", not "irrigate the wound" — while
  // 1,610 authored aliases carry an article. matchScore uses fuzzyHas, which needs EVERY
  // token of the alias present, so that one word made the responder unreachable and the
  // critical action it satisfies uncreditable. Dropping articles from BOTH sides closes
  // the gap (reported from play: "irrigate wound" earned nothing on a dog-bite case).
  //
  // A bare "a" is clinical exactly once in 45,145 alias strings ("hepatitis a b c"), so
  // that family is joined with an underscore first — a word character, so the stripper
  // below cannot see a boundary around the "a" — then split back afterwards.
  s = s.replace(/\b(vitamin|hepatitis|influenza|parainfluenza|group|type|class|factor|apolipoprotein|strep\w*) a\b/g, '$1_a');
  s = s.replace(/\b(?:a|an|the)\b/g, ' ');
  s = s.replace(/_a\b/g, ' a');
  return s.replace(/\s+/g,' ').trim();
}

// "ID" is what every ED clinician says instead of "infectious disease", and
// without it "consult ID" classified as 'other', hit the not-understood dead
// end, and was recorded in state.unparsed — so the debrief blamed the player
// for an order the sim never understood. But 'id' is a two-letter token that
// also means the patient's ARMBAND: "check her ID", "the ID band", "confirm
// patient ID before transfusion" (a real ED safety action). A blanket ABBREV
// entry would corrupt all of those.
//
// So this is context-gated, in the spirit of DX_SHORT_FORMS below: the meaning
// is enabled only where the surrounding clause already establishes it. Three
// rules keep it safe:
//   1. CLAUSE-SCOPED. Gated per clause, after splitting, so a consult verb in
//      one clause can never license an 'id' in another ("check her ID, then
//      call surgery").
//   2. APPENDS, never replaces. 51 pack aliases are written with the bare
//      token ("id consult", "call the id doc", "id team"); rewriting 'id' away
//      would unmatch every one of them. Adding the long form on the end keeps
//      those aliases matching AND lets classifyIntent/consult-bridging see the
//      service.
//   3. VETOED by any identity marker. Verifying a name or an armband outranks
//      the shorthand, so a consult-shaped clause that is really an identity
//      check ("call the blood bank and confirm her ID") keeps today's exact
//      behavior. Losing a rare consult phrasing is an annoyance; corrupting a
//      transfusion identity check is not.
// Swept cases-offline.json first: identity-sense "ID" appears in exactly two
// strings, both nurse SPEECH ("No ID on him") which is never matched against.
// No pack alias uses 'id' in the identity sense.
const ID_TOKEN_RE = /\bid\b/;
// "ID team", "ID service", "ID fellow" carry no consult VERB at all, so the
// clause-shape gate alone would miss them; these are the fixed constructions
// the packs themselves are authored in.
const ID_CONSULT_NOUN_RE = /\bid (consults?|consultation|team|service|doc|docs|doctor|physician|fellow|attending|specialist|referral|recommendations)\b/;
// Three families of identity marker, any one of which vetoes the shorthand:
//   (a) the armband itself ("id band", "id badge"), plus the OTHER short sense
//       of the token — "id" as the verb identify ("id the cause", an authored
//       alias on endo-thyroid-storm);
//   (b) an identity object named anywhere in the clause;
//   (c) a verification verb anywhere in the clause — the giveaway that 'id' is
//       a thing being checked rather than a service being paged. (No pack
//       aliases the ID service behind a checking verb, so this costs nothing.)
const ID_IDENTITY_RE = new RegExp([
  /\bid (band|bands|bracelet|badge|number|card|sticker|label|tag|check|checks|verification|wristband|armband)\b/,
  // 'id' as the verb IDENTIFY, named by what is being identified. normalize()
  // strips articles, so endo-thyroid-storm's authored alias "id the cause"
  // arrives here as "id cause" — matching on the article would never fire.
  // Listed by object rather than by any following word, because the consult
  // sense also takes a noun ("id team", "id service", "id doc").
  /\bid (cause|causes|source|sources|organism|organisms|pathogen|pathogens|etiology|culprit|focus|trigger|triggers|rhythm|precipitant|underlying)\b/,
  /\b(armband|wristband|bracelet|badge|blood type|blood group|date of birth|dob|medical alert|two person|second nurse|bedside check|name band)\b/,
  /\b(verify|verifies|verified|verifying|confirm|confirms|confirmed|confirming|check|checks|checked|checking|recheck|match|matches|matching|scan|scans|scanning|read back|cross check)\b/,
  /\bno id\b/
].map(r => r.source).join('|'));
function expandConsultShorthand(clause){
  if(!ID_TOKEN_RE.test(clause)) return clause;
  if(clause.includes('infectious disease')) return clause;   // already said, or already expanded
  if(ID_IDENTITY_RE.test(clause)) return clause;
  const toks = clause.split(' ');
  const consultShaped = CONSULT_WORDS.some(w => toks.includes(w))
                     || CONSULT_PHRASE_RE.test(clause)
                     || ID_CONSULT_NOUN_RE.test(clause);
  return consultShaped ? clause + ' infectious disease' : clause;
}

function splitClauses(normText){
  let s = ' '+normText+' ';
  for(const re of AND_PROTECT) s = s.replace(re, m => m.replace(/ and /g,' & '));
  return s.split(/\s*,\s*|[;\n]| and | then | plus | also /)
          .map(c => c.replace(/ & /g,' and ').trim())
          .map(c => c.replace(/^(and|then|plus|also)\s+/,''))   // ", and X" → "X"
          .filter(c => c.length > 1)
          .map(expandConsultShorthand);
}

function lev(a, b){
  const m = a.length, n = b.length;
  if(!m) return n; if(!n) return m;
  let prev = Array.from({length:n+1}, (_,j)=>j);
  for(let i=1;i<=m;i++){
    const cur=[i];
    for(let j=1;j<=n;j++)
      cur[j] = Math.min(prev[j]+1, cur[j-1]+1, prev[j-1] + (a[i-1]===b[j-1]?0:1));
    prev = cur;
  }
  return prev[n];
}

// Does the token list contain EVERY token of `phrase` (typo-tolerant)?
// Tolerance scales with token length: <5 exact, 5–9 lev≤1, ≥10 lev≤2.
// (Tol 2 at 7–8 letters was too loose: 'examine' matched 'ketamine'.)
// Some near-identical tokens are DIFFERENT studies — 'efast' fuzzed onto 'fast'
// and a plain FAST order returned a thoracic-only scan. Those match exactly.
const FUZZ_EXACT = new Set(['fast', 'efast',
  // "a liter of LACTATED ringers" is not a LACTATE order (lev 1 apart);
  // "call RADIOLOGY" summoned CARDIOLOGY (lev 2); "I HEAR you, mom" fuzzed onto
  // a HEART exam (lev 1).
  'lactate', 'lactated', 'radiology', 'cardiology', 'hear', 'heart', 'neurology', 'nephrology',
  // AMPICILLIN and AMOXICILLIN are lev 2 apart, so on id-lemierre-syndrome an
  // ampicillin-sulbactam order (correct: broad-spectrum IV with anaerobic
  // coverage) fuzzed onto the bare 'amoxicillin' alias of the responder that
  // rebukes oral GABHS-only outpatient therapy. The player was credited and
  // punished for the same order, and the patient deteriorated for doing it right.
  // ACTIVATE and ACTIVASE are lev 1 apart. Both PE packs alias "activase" on the
  // thrombolysis responder, so "activate MTP", "activate the trauma team" and
  // "activate the cath lab" all credited SYSTEMIC THROMBOLYSIS and were answered
  // "the requested medication was administered as ordered" — a bleeding-risk drug
  // credited, and narrated as given, for calling a team. Nobody ordered a drug.
  'activate', 'activase',
  'ampicillin', 'amoxicillin',
  // HYPERTONIC and HYPOTONIC are lev 2 apart; THORACOSTOMY and THORACOTOMY are
  // lev 1. Both pairs name an ANTIDOTE and its OPPOSITE, so a fuzz match here
  // credits the player for an order that harms the patient — the direction of
  // this bug class that has to be shut. On eb-symptomatic-hyponatremia (and
  // peds-electrolyte-emergency) a seizing hyponatremic child given "hypotonic
  // fluids" — free water, which deepens the cerebral oedema — fuzzed onto the
  // 'hypertonic' alias: the sim credited the sodium-correction critical action,
  // narrated her waking up, and rebuked the order in the same breath. On
  // resus-atls-traumatic-arrest the pair is two different operations: finger
  // thoracostomy (decompress both chests) drew the "hold the knife" rebuke
  // aimed at resuscitative thoracotomy, and the thoracotomy was told it had
  // released two chests. Both orders credited both actions.
  'hypertonic', 'hypotonic', 'thoracostomy', 'thoracotomy',
  // HEMATOLOGY and RHEUMATOLOGY are lev 2 apart — the same trap 'neurology'
  // and 'nephrology' above are here for, one row down the consult list. On
  // eb-misc (MIS-C) critical action 5 is "involve pediatric cardiology,
  // RHEUMATOLOGY, and critical care"; "consult hematology" fuzzed onto the
  // pack's rheumatology responder, answered in Rheum's voice, and credited the
  // action. Paging heme in MIS-C is the wrong service, so that is false credit
  // for an objective the player never met. (SERVICE_FAMILY still bridges
  // heme≈onc: that comparison is on service NAMES in alias text, not fuzz.)
  'hematology', 'rheumatology',
  // RINGERS is one edit from FINGERS ("he can't feel his fingers" is history, not a
  // fluid order); SALINE is one edit from SALIVA/SPLINE. Both match exactly only.
  'ringers', 'fingers', 'saline']);
function fuzzyHas(tokens, phrase){
  const pts = phrase.split(' ').filter(Boolean);
  return pts.every(pt => tokens.some(ct => {
    if(ct === pt) return true;
    if(FUZZ_EXACT.has(pt) || FUZZ_EXACT.has(ct)) return false;
    if(pt.length < 5 || ct.length < 4) return false;
    const tol = pt.length >= 10 ? 2 : 1;
    return Math.abs(ct.length - pt.length) <= tol && lev(ct, pt) <= tol;
  }));
}

// ---------- Reference tables (canonical names are POST-normalize strings) ----------
// Lab panels: ordered rows with normal ranges. Values are generated mid-range with
// jitter for generic (non-pack) cases; packs override with case-specific rows.
const PANELS = {
  'complete blood count': [
    {name:'WBC', unit:'10^9/L', lo:4.5, hi:10.5, dp:1}, {name:'Hemoglobin', unit:'g/dL', lo:13.0, hi:16.0, dp:1},
    {name:'Hematocrit', unit:'%', lo:39, hi:47, dp:0}, {name:'Platelets', unit:'10^9/L', lo:150, hi:400, dp:0}],
  'basic metabolic panel': [
    {name:'Sodium', unit:'mmol/L', lo:136, hi:144, dp:0}, {name:'Potassium', unit:'mmol/L', lo:3.6, hi:4.8, dp:1},
    {name:'Chloride', unit:'mmol/L', lo:98, hi:106, dp:0}, {name:'CO2', unit:'mmol/L', lo:22, hi:28, dp:0},
    {name:'BUN', unit:'mg/dL', lo:8, hi:20, dp:0}, {name:'Creatinine', unit:'mg/dL', lo:0.6, hi:1.2, dp:2},
    {name:'Glucose', unit:'mg/dL', lo:75, hi:105, dp:0}],
  'coagulation panel': [
    {name:'PT', unit:'s', lo:12, hi:14, dp:1}, {name:'INR', unit:'', lo:0.9, hi:1.1, dp:1},
    {name:'PTT', unit:'s', lo:26, hi:34, dp:0}],
  'venous blood gas': [
    {name:'pH (venous)', unit:'', lo:7.32, hi:7.40, dp:2}, {name:'pCO2 (venous)', unit:'mmHg', lo:42, hi:50, dp:0},
    {name:'HCO3', unit:'mmol/L', lo:23, hi:27, dp:0}],
  'arterial blood gas': [
    {name:'pH', unit:'', lo:7.36, hi:7.42, dp:2}, {name:'pCO2', unit:'mmHg', lo:36, hi:44, dp:0},
    {name:'pO2', unit:'mmHg', lo:85, hi:100, dp:0}, {name:'HCO3', unit:'mmol/L', lo:23, hi:27, dp:0}],
  'urinalysis': [
    {name:'UA color', unit:'', fixed:'Yellow, clear'}, {name:'UA specific gravity', unit:'', lo:1.010, hi:1.025, dp:3},
    {name:'UA leukocyte esterase', unit:'', fixed:'Negative'}, {name:'UA nitrite', unit:'', fixed:'Negative'},
    {name:'UA blood', unit:'', fixed:'Negative'}, {name:'UA ketones', unit:'', fixed:'Negative'},
    {name:'UA glucose', unit:'', fixed:'Negative'}],
  'liver function tests': [
    {name:'AST', unit:'U/L', lo:12, hi:38, dp:0}, {name:'ALT', unit:'U/L', lo:10, hi:40, dp:0},
    {name:'Alk phos', unit:'U/L', lo:45, hi:115, dp:0}, {name:'Total bilirubin', unit:'mg/dL', lo:0.2, hi:1.1, dp:1}]
};
PANELS['comprehensive metabolic panel'] = [...PANELS['basic metabolic panel'],
  {name:'Calcium', unit:'mg/dL', lo:8.6, hi:10.2, dp:1}, {name:'Total protein', unit:'g/dL', lo:6.2, hi:7.9, dp:1},
  {name:'Albumin', unit:'g/dL', lo:3.6, hi:4.8, dp:1}, ...PANELS['liver function tests']];

// Solo tests: name → one generic-normal row.
const SOLO_TESTS = {
  // Analytes added after a playtest ordered "CBC, CMP, INR/PT, CK, albumin, TSH, UA" and
  // silently received nothing for the coags, the CK or the albumin — an unknown lab name
  // classifies as 'other', so it drew a shrug instead of a result. Values sit inside the
  // normal range; a case that cares about one authors its own responder, which wins.
  'prothrombin time inr': {name:'INR', value:'1.1', unit:''},
  'inr': {name:'INR', value:'1.1', unit:''},
  'partial thromboplastin time': {name:'PTT', value:'30', unit:'s'},
  'creatine kinase': {name:'Creatine Kinase', value:'118', unit:'U/L'},
  'albumin': {name:'Albumin', value:'4.1', unit:'g/dL'},
  'prealbumin': {name:'Prealbumin', value:'24', unit:'mg/dL'},
  'lactate dehydrogenase': {name:'LDH', value:'186', unit:'U/L'},
  'haptoglobin': {name:'Haptoglobin', value:'96', unit:'mg/dL'},
  'reticulocyte count': {name:'Reticulocyte Count', value:'1.4', unit:'%'},
  'phosphate': {name:'Phosphate', value:'3.4', unit:'mg/dL'},
  'uric acid': {name:'Uric Acid', value:'5.2', unit:'mg/dL'},
  // Point-of-care glucose. Cases that model a sugar (DKA, hypoglycaemia) answer this
  // from their own pack responder; this default is only the floor for cases that do
  // not — and fallbackFor prefers ANY glucose row the pack carries over this value, so
  // a fingerstick can never contradict the same case's chemistry panel.
  'fingerstick glucose': {name:'Fingerstick Glucose', value:'98', unit:'mg/dL'},
  'troponin':        {name:'Troponin I', value:'<0.04', unit:'ng/mL'},
  'lactate':         {name:'Lactate', value:'1.1', unit:'mmol/L'},
  'bnp':             {name:'BNP', value:'48', unit:'pg/mL'},
  'd dimer':         {name:'D-dimer', value:'0.32', unit:'µg/mL FEU'},
  'lipase':          {name:'Lipase', value:'32', unit:'U/L'},
  'pregnancy test':  {name:'Urine hCG', value:'Negative', unit:''},
  'blood cultures':  {name:'Blood cultures ×2', value:'Drawn — no growth (prelim)', unit:''},
  'urine culture':   {name:'Urine culture', value:'Sent — prelim no growth', unit:''},
  'tsh':             {name:'TSH', value:'2.1', unit:'mIU/L'},
  'magnesium':       {name:'Magnesium', value:'2.0', unit:'mg/dL'},
  'phosphorus':      {name:'Phosphorus', value:'3.4', unit:'mg/dL'},
  'ammonia':         {name:'Ammonia', value:'28', unit:'µmol/L'},
  'crp':             {name:'CRP', value:'4', unit:'mg/L'}, 'esr':{name:'ESR', value:'12', unit:'mm/h'},
  'acetaminophen':   {name:'Acetaminophen level', value:'<10', unit:'µg/mL'},
  'salicylate':      {name:'Salicylate level', value:'<5', unit:'mg/dL'},
  'ethanol':         {name:'Ethanol', value:'<10', unit:'mg/dL'},
  'type and screen': {name:'Type & screen', value:'O positive, antibody screen negative', unit:''},
  'urine drug screen':{name:'Urine drug screen', value:'Negative', unit:''},
  'procalcitonin':   {name:'Procalcitonin', value:'0.08', unit:'ng/mL'},
  'fibrinogen':      {name:'Fibrinogen', value:'320', unit:'mg/dL'},
  // Dual give/measure electrolytes: "recheck potassium" is a level; a dosed order
  // ("replete K 40 mEq", "mag 2g IV") is filtered out by the DUAL_GIVE_MEASURE
  // guard in findSolo, so these rows only answer genuine measurement requests.
  'potassium':       {name:'Potassium', value:'4.0', unit:'mmol/L'},
  'calcium':         {name:'Calcium', value:'9.2', unit:'mg/dL'},
  // "bicarb" inside an iStat analyte list gave IV bicarbonate — dual give/measure
  'sodium bicarbonate': {name:'CO2 (bicarbonate)', value:'24', unit:'mmol/L'}
};

// Imaging studies. type drives the app's read-gating: everything EXCEPT ekg/cxr
// carries a written radiology read (the ED physician self-reads their own 12-lead
// and chest film in real time; ultrasound, plain films, and cross-sectional
// studies come back with a formal read).
const IMAGING_STUDIES = [
  {aliases:['electrocardiogram','12 lead'], title:'12-Lead ECG', type:'ekg', minutes:5, query:'normal sinus rhythm 12-lead ECG'},
  {aliases:['chest x ray','portable chest'], title:'Portable Chest X-ray', type:'cxr', minutes:15, query:'normal portable chest x-ray'},
  {aliases:['abdominal x ray'], title:'Abdominal X-ray (KUB)', type:'xr', minutes:15, query:'normal abdominal x-ray KUB', read:'Nonobstructive bowel gas pattern. No dilated loops, air-fluid levels, or free air. No radiopaque foreign body. IMPRESSION: No acute abdominal series abnormality.'},
  {aliases:['pelvis x ray','pelvic x ray'], title:'Pelvis X-ray', type:'xr', minutes:15, query:'normal pelvis x-ray', read:'Pelvic ring intact. No fracture, dislocation, or diastasis. Hip joints congruent bilaterally. IMPRESSION: No acute osseous abnormality.'},
  {aliases:['computed tomography head','head computed tomography'], title:'CT Head', type:'ct', minutes:25, query:'normal head CT non-contrast', read:'No acute intracranial hemorrhage, mass effect, or midline shift. Gray-white differentiation preserved. IMPRESSION: No acute intracranial abnormality.'},
  {aliases:['ct angiography chest','ct angiography pulmonary'], title:'CTA Chest (PE protocol)', type:'ct', minutes:35, query:'normal CT pulmonary angiogram', read:'No filling defect in the main, lobar, or segmental pulmonary arteries. No right heart strain. IMPRESSION: No pulmonary embolism.'},
  {aliases:['ct angiography head neck','ct angiography head','ct angiography neck','ct angiography brain'], title:'CTA Head/Neck', type:'ct', minutes:35, query:'normal CT angiogram head and neck', read:'Cervical and intracranial vessels opacify normally. No aneurysm, dissection, stenosis, or vascular malformation identified. IMPRESSION: No acute cervico-cerebral vascular abnormality.'},
  {aliases:['computed tomography abdomen pelvis','computed tomography abdomen'], title:'CT Abdomen/Pelvis', type:'ct', minutes:35, query:'normal CT abdomen pelvis with contrast', read:'No acute inflammatory change, obstruction, or free air. Solid organs unremarkable. IMPRESSION: No acute abdominopelvic process.'},
  {aliases:['computed tomography chest'], title:'CT Chest', type:'ct', minutes:30, query:'normal CT chest', read:'Lungs clear. No effusion or pneumothorax. Mediastinum normal in caliber. IMPRESSION: No acute chest pathology.'},
  {aliases:['computed tomography cervical spine','computed tomography c spine'], title:'CT Cervical Spine', type:'ct', minutes:25, query:'normal cervical spine CT', read:'No acute fracture or malalignment. IMPRESSION: No acute cervical spine injury.'},
  {aliases:['right upper quadrant ultrasound'], title:'RUQ Ultrasound', type:'us', minutes:20, query:'normal right upper quadrant gallbladder ultrasound', read:'Gallbladder normal in caliber without stones, wall thickening, or pericholecystic fluid. No sonographic Murphy sign. Common bile duct normal caliber. IMPRESSION: No sonographic evidence of cholecystitis or cholelithiasis.'},
  {aliases:['fast exam','efast'], title:'FAST Exam', type:'us', minutes:6, query:'negative FAST exam ultrasound', read:'No free fluid in the hepatorenal, splenorenal, or pelvic views. No pericardial effusion. IMPRESSION: Negative FAST examination.'},
  {aliases:['echocardiogram','bedside echocardiogram'], title:'Bedside Echo', type:'us', minutes:10, query:'normal bedside echocardiogram parasternal long axis', read:'Grossly normal left ventricular systolic function. No pericardial effusion. No right ventricular dilation. IMPRESSION: No acute echocardiographic abnormality.'},
  {aliases:['transvaginal ultrasound','pelvic ultrasound'], title:'Pelvic Ultrasound', type:'us', minutes:25, query:'normal pelvic ultrasound', read:'Uterus and adnexa unremarkable. No adnexal mass or free fluid. Normal ovarian flow bilaterally. IMPRESSION: No acute pelvic abnormality.'},
  {aliases:['renal ultrasound'], title:'Renal Ultrasound', type:'us', minutes:20, query:'normal renal ultrasound', read:'Kidneys normal in size and echogenicity. No hydronephrosis, calculus, or perinephric fluid. IMPRESSION: No acute renal abnormality.'},
  {aliases:['right lower quadrant ultrasound','appendix ultrasound','appendiceal ultrasound'], title:'RLQ (Appendix) Ultrasound', type:'us', minutes:25, query:'normal appendix ultrasound right lower quadrant', read:'Tubular blind-ending structure not visualized; no dilated appendix, free fluid, or echogenic fat in the right lower quadrant. IMPRESSION: No sonographic evidence of appendicitis (non-visualized appendix).'},
  {aliases:['head ultrasound','cranial ultrasound'], title:'Cranial Ultrasound', type:'us', minutes:20, query:'normal neonatal cranial ultrasound', read:'Ventricles normal in size and configuration via the anterior fontanelle. No intraventricular or parenchymal hemorrhage, no midline shift. IMPRESSION: No acute intracranial abnormality.'},
  {aliases:['magnetic resonance imaging brain','magnetic resonance imaging head'], title:'MRI Brain', type:'mri', minutes:50, query:'normal brain MRI', read:'No acute infarct, hemorrhage, or mass. IMPRESSION: No acute intracranial abnormality.'}
];

// Physical exam regions with realistic normal findings (packs override abnormals).
const EXAM_REGIONS = [
  {aliases:['general','appearance'], system:'General', normal:'Alert, oriented, in no acute distress; speaking in full sentences.'},
  {aliases:['heent','head','throat','pupils'], system:'HEENT', normal:'Normocephalic, atraumatic. Pupils equal and reactive. Oropharynx clear, mucous membranes moist.'},
  {aliases:['neck'], system:'Neck', normal:'Supple, no midline tenderness, no JVD, no lymphadenopathy.'},
  {aliases:['heart','cardiac','cardiovascular','auscultate heart'], system:'Cardiac', normal:'Regular rate and rhythm, no murmurs, rubs, or gallops. Pulses 2+ and symmetric.'},
  {aliases:['lungs','chest','pulmonary','breath sounds','auscultate'], system:'Lungs', normal:'Clear to auscultation bilaterally, no wheezes, rales, or rhonchi. Symmetric expansion.'},
  {aliases:['abdomen','belly','abdominal'], system:'Abdomen', normal:'Soft, non-tender, non-distended. No rebound or guarding. Normal bowel sounds.'},
  {aliases:['neuro','neurologic','gcs','cranial nerves'], system:'Neuro', normal:'GCS 15. Cranial nerves II–XII intact. Strength 5/5 throughout, sensation intact, no focal deficit.'},
  {aliases:['skin'], system:'Skin', normal:'Warm and dry, no rash, no mottling. Capillary refill <2 seconds.'},
  {aliases:['extremities','legs','arms','calf'], system:'Extremities', normal:'No edema, no calf tenderness, no deformity. Distal pulses intact.'},
  {aliases:['rectal exam','rectal'], system:'Rectal', normal:'Normal tone, no gross blood, brown stool, guaiac negative.'},
  // BEFORE the gyn entry: "examine the pelvis for stability" on an open-book
  // fracture returned "no cervical motion tenderness, no discharge" — the trauma
  // pelvic-ring assessment must never map to a speculum template.
  {aliases:['pelvic stability','pelvis stability','pelvis','pelvic compression','compress the pelvis','rock the pelvis','pelvic ring','pelvic instability'], system:'Pelvis (MSK)', normal:'Pelvic ring stable to gentle anteroposterior and lateral compression. No crepitus, no focal bony tenderness.'},
  {aliases:['pelvic exam','pelvic','genitourinary'], system:'Pelvic/GU', normal:'No external lesions. No cervical motion tenderness, no discharge.'},
  {aliases:['back','flank'], system:'Back/Flank', motion:true, normal:'No midline spinal tenderness, no CVA tenderness.'}
];

// Generic history answers by topic (packs override with case-specific answers).
const HISTORY_TOPICS = [
  {aliases:['allergies'], answer:'No known drug allergies.'},
  {aliases:['medications','meds','medication list'], answer:'No regular medications.'},
  {aliases:['past medical history','medical problems','conditions'], answer:'No significant past medical history.'},
  {aliases:['surgical history','surgeries'], answer:'No prior surgeries.'},
  {aliases:['family history'], answer:'No significant family history.'},
  {aliases:['social history','smoke','smoking','alcohol','drugs','drug use'], answer:'Denies tobacco, alcohol, and recreational drug use.'},
  {aliases:['travel'], answer:'No recent travel.'},
  {aliases:['sick contacts','exposures'], answer:'No known sick contacts.'},
  {aliases:['last meal','ate'], answer:'Last ate this morning.'},
  {aliases:['immunizations','vaccines'], answer:'Immunizations up to date.'}
];

// Meds that must carry a dose (rule 15). Checked when a med clause has no digits.
// Paralytics specifically: giving one is a commitment, not a treatment on its own.
const PARALYTIC_RE = /\b(rocuronium|succinylcholine|suxamethonium|vecuronium|cisatracurium|atracurium|paralytic|paralyse|paralyze)\b/;
const MEDS_REQUIRING_DOSE = ['epinephrine','heparin','insulin','alteplase','tenecteplase',
  'norepinephrine','amiodarone','adenosine','ketamine','rocuronium','succinylcholine',
  'morphine','fentanyl','hydromorphone','midazolam','lorazepam','vancomycin','dopamine'];
// A dose spelled in words is still a dose: "TXA a gram IV" was flagged
// dose-not-specified (the article strips it to "txa gram iv" — no digit left).
const WORD_DOSE_RE = /\b(grams?|milligrams?|micrograms?|amps?|ampules?|ampoules?|meqs?|units?|milliliters?|liters?|litres?)\b|\bper (protocol|pharmacy|weight)\b|weight.based|\bper (kg|kilo)\b/;
function hasDoseEvidence(clause){ return /\d/.test(clause) || WORD_DOSE_RE.test(clause); }
// "continue ceftriaxone and the midazolam drip" re-demanded doses given turns
// earlier: a continuation is not a new order.
const CONTINUE_RE = /^\s*(continue|continuing|keep|maintain|resume|stay(s)? on|still on|remain(s)? on)\b/;
// Ordering language that marks an "and"-split fragment as a NEW positive order
// rather than the continuation of a preceding withhold.
const ORDERISH_RE = /\b(give|start|push|hang|order|get|send|place|repeat|recheck|check|draw|obtain|run|bolus)\b|\b(po|iv|im|pr|sl|neb)\b|\b\d+\s*(mg|mcg|g|meq|units?|ml|l)\b/;
// Forward-binding negators: reject the drug that FOLLOWS. Bare no/not may also
// bind backward ("kayexalate? no — lokelma"). hold/stop stay out of this set —
// clause-anchored WITHHOLD_RE covers them, and "hold pressure" is an action.
const NEG_FORWARD = new Set(['nobody','never','avoid','without','dont','cancel']);
// Negation window: how far ahead a forward negator reaches ("nobody gives this
// man fentanyl" put the drug at +4).
const NEG_REACH = 4;

const MED_WORDS = ['aspirin','nitroglycerin','heparin','morphine','fentanyl','ondansetron','ketorolac',
  'acetaminophen','ibuprofen','ceftriaxone','vancomycin','piperacillin','azithromycin','cefepime','meropenem',
  'doxycycline','metronidazole','albuterol','ipratropium','epinephrine','norepinephrine','insulin','dextrose',
  'naloxone','normal saline','lactated ringers','hypertonic','iv fluids','bolus','oxygen','non rebreather','magnesium',
  'potassium','amiodarone','adenosine','diltiazem','metoprolol','labetalol','esmolol','nicardipine',
  'hydralazine','furosemide','lasix','steroids','methylprednisolone','dexamethasone','prednisone',
  'tranexamic','alteplase','tenecteplase','ketamine','midazolam','lorazepam','propofol','etomidate',
  'rocuronium','succinylcholine','antibiotics','tetanus','glucagon','calcium','bicarbonate','octreotide',
  'pantoprazole','famotidine','droperidol','haloperidol','olanzapine',
  // Antibiotics beyond the original eight (plus acyclovir the antiviral) —
  // each checked against fuzzyHas tolerance so no pair collides.
  'cefazolin','cephalexin','clindamycin','levofloxacin','ciprofloxacin','ampicillin',
  'gentamicin','trimethoprim','nitrofurantoin','linezolid','daptomycin','aztreonam',
  'acyclovir','nafcillin','penicillin',
  // Bare fluid names: "saline" alone classified 'other' and hit the not-understood
  // dead end; "crystalloid" was narrated as "Bolus are in". Listed AFTER
  // 'normal saline'/'lactated ringers' so the nurse still names the full fluid.
  'saline','ringers','crystalloid','plasmalyte',
  // ATROPINE and LIDOCAINE were absent from this list entirely, so bare "atropine" hit
  // the not-understood dead end — on a library where 58 pack aliases mention it and one
  // of the six showcase cases IS a symptomatic bradycardia. The live-code engine knew
  // them (DRUG_ALIASES) so they worked mid-arrest and nowhere else.
  'atropine','lidocaine'];
// A fluid without a volume is not an order the nurse can hang (rule 15's fluid twin
// of MEDS_REQUIRING_DOSE). "bolus" alone credited the fluid critical action.
const FLUIDS_REQUIRING_VOLUME = ['normal saline','lactated ringers','saline','ringers','crystalloid','plasmalyte','iv fluids','bolus'];
// "wide open", "maintenance" and "KVO" are rates a nurse can hang without a number.
const VOLUME_RE = /\b(wide open|maintenance|kvo|tko|open (it|them) up|to gravity)\b/;
function hasVolumeEvidence(clause){ return hasDoseEvidence(clause) || VOLUME_RE.test(clause); }
const FLUID_VOLUME_FLAG = 'Fluids ordered without a volume — specify volume (mL or mL/kg) and rate.';
// A stated volume: "1 liter", "500 mL", "20 mL/kg", "2 l", "30 cc/kg".
const VOLUME_PHRASE_RE = /\b\d+(?:\.\d+)?\s*(?:ml|cc|l|liters?|litres?)\s*(?:\/\s*|per\s+)?(?:kg|kilo|kilogram)?\b/i;
// Swap the volume the pack author wrote for the one the doctor actually said. Only ever
// touches a number that is already there: a line with no volume in it is left alone, so
// authored prose that never promised a number cannot be mangled.
function readbackVolume(text, clause){
  const said = VOLUME_PHRASE_RE.exec(String(clause || ''));
  if(!said) return text;
  const mine = said[0].trim().replace(/\s+/g, ' ');
  return String(text || '').replace(VOLUME_PHRASE_RE, m => (m.trim().toLowerCase() === mine.toLowerCase() ? m : mine));
}

const PROCEDURE_WORDS = ['suction','suctioning','yankauer','yankauers','oropharyngeal suction',
  // 'extubate'/'extubation' are deliberately ABSENT: fuzzyHas treats them as identical to
  // 'intubation' (Levenshtein 2), so the catalog builder produced an entry that could
  // rewrite one into the other — the opposite action in an airway case. The catalog
  // validator caught it. 'peep' is out for the same reason: one edit from 'deep'.
  'ventilator','vent settings','mechanical ventilation','tidal volume',
  'bougie','stylet','jaw thrust','chin lift','oral airway','nasal trumpet','bag mask','end tidal',
  'capnography','etco2','secure the tube','confirm tube placement',
  'intubate','intubation','central line','arterial line','chest tube','thoracostomy',
  'lumbar puncture','paracentesis','thoracentesis','cardiovert','cardioversion','defibrillate','shock',
  'pace','pacing','cpr','reduce','reduction','splint','suture','foley','ng tube','nasogastric',
  'io access','intraosseous','cricothyrotomy','pericardiocentesis','iv access','second iv',
  'two large bore','large bore','hyperventilate','hyperventilation'];

// "get acute care surgery ON THE PHONE immediately" earned zero consult credit in a
// necrotizing fasciitis playthrough: the bridging verbs stopped at consult/call/page.
const CONSULT_WORDS = ['consult','consulting','call','calling','page','paging','phone',
  'notify','involve','involved','contact'];
const CONSULT_SERVICES = ['pediatrics','hematology','oncology','ophthalmology','dermatology',
  'endocrinology','rheumatology','vascular surgery','plastic surgery','burn','dental',
  'oral maxillofacial surgery','pharmacy','respiratory therapy','hospitalist','intensivist',
  'internal medicine',
  'child life','chaplain','ethics','cardiology','surgery','gastroenterology','neurology','neurosurgery','orthopedics',
  'urology','obstetrics','gynecology','psychiatry','nephrology','pulmonology','infectious disease',
  'toxicology','poison control','anesthesia','trauma','interventional radiology','ent',
  'pathology','blood bank','radiology','pediatric surgery','pediatric cardiology',
  'social work','adult protective services','child protective services','case management','palliative care'];
// "get pathology on the line" carries no consult verb-token at all. (normalize
// strips articles, so match with and without "the".)
const CONSULT_PHRASE_RE = /\bon (the )?(line|phone)\b/;
// Services that are the same on-call team in practice — "consult OB" must
// reach a responder whose aliases only say "gyn", an oncology call reaches
// heme, and a medicine admit reaches the hospitalist (and vice versa).
// This is a SCHEDULING claim (one pager, one team), not a claim that the two
// specialties are clinically interchangeable — keep it to services that
// genuinely share an on-call rota.
const SERVICE_FAMILY = { obstetrics:'obgyn', gynecology:'obgyn',
  hematology:'hemonc', oncology:'hemonc',
  'internal medicine':'medicine', hospitalist:'medicine' };
// A "get the family out of the room" request, however phrased. Used to bridge
// the player's phrasing ("ask the daughter to step out") to a pack privacy
// responder authored with different words ("ask the son to step out",
// "interview alone") — playtest: guessing the caregiver's relationship wrong
// silently cost the private-interview critical action.
const PRIVACY_RE = /\b(step (out|outside)|in private|privately|alone with|leave the room|clear the room|without (mom|mother|dad|father|the (parents?|family|caregiver|son|daughter))|separate the (family|caregiver|parents?)|speak .* (outside|alone))\b/;
// Word-bounded: 'or ' as a substring classified "monitor the patient" as a
// disposition (and dispositions END the case). Real dispo phrases only.
const DISPO_RE = /\b(admit|discharge|transfer|observation|stepdown)\b|intensive care|operating room|cath lab|\bto (?:the )?or\b/;
// The NOUN form of an admission order, kept separate from DISPO_RE on purpose.
// DISPO_RE works by enumerating surface forms, which is fine for "discharge",
// "transfer" and "observation" because each is spelled the same as verb and noun.
// "admit" is the exception — its noun is "admission", which does not contain the
// substring "admit" at all — so "call for admission" and "needs admission" fell
// through to 'other' and the encounter never closed (reported from real play).
// CALLING A SERVICE IS NOT MOVING THE PATIENT. DISPO_RE carries three bare destination
// nouns — cath lab, intensive care, operating room — and a noun cannot tell a summons from
// a departure. So "activate the cath lab" ENDED the case, on the very turn the consultant
// answered "start cooling and send him up to us": the patient left before the cooling that
// same sentence asked for, and the debrief then marked targeted temperature management
// missed. Reported by Kim as a missing critical action; it was a missing distinction.
//
// A clause that only summons someone is a consult. A clause that moves the patient is a
// disposition, and moving wins whenever both are present — "call medicine for admission"
// and "get him to the cath lab" are departures, not phone calls.
const SUMMON_RE = /\b(activate|activating|activation|call|calling|page|paging|consult|consulting|alert|notify|notifying|contact|ring|refer|referral|speak|talk|get)\b/;
const MOVE_RE = /\b(admit|admission|admissions|discharge|transfer|take|takes|taking|send|sending|move|moving|transport|bring|bringing|book|booking|straight)\b|\bto (?:the )?(?:or|cath lab|icu|ccu|ward|floor|unit|theatre|theater|operating room|intensive care)\b/;
const summonsOnly = clause => SUMMON_RE.test(clause) && !MOVE_RE.test(clause);
const ADMISSION_RE = /\badmissions?\b/;
// …but "admission" is also how a PAST hospitalisation is referred to, and closing
// the case on "what were her vitals on admission" would be a worse bug than leaving
// it open. Only the historical constructions are excluded, so a real disposition
// that merely mentions a prior admission still ends the case.
const PRIOR_ADMISSION_RE = /\b(?:on|at|since|during|from|prior|previous|last|recent|his|her|their|repeat|many|any|all|both|past|earlier|old)\s+(?:the\s+)?admissions?\b/;
const ASSESS_WORDS = ['i think','my diagnosis','this is likely','concern for','i suspect','my assessment','working diagnosis','i believe','working dx','most likely','this looks like','differential is'];
// "I think we should give aspirin" is an order wearing a hedge; "I think this is
// septic shock" is a diagnosis. Deciding on a flat verb list fails, because shock,
// dose, consult and bolus are all common clinical NOUNS. So look at structure: an
// explicit plan phrase anywhere, or an imperative verb leading what follows the frame.
const PLAN_PHRASE_RE = /\b(we should|we need|need to|needs|let'?s|should get|should start)\b/i;
const ASSESS_FRAME_RE = /^\s*(?:i think(?:\s+this\s+is)?|i suspect|i believe|my (?:working )?(?:diagnosis|assessment)(?:\s+is)?|working (?:diagnosis|dx)(?:\s+is)?|this (?:is likely|looks like)|most likely|concern for|differential is|dx|diagnosis|impression)\b\s*:?\s*/i;
// This runs on the NORMALIZED clause, where ABBREV has folded the verb
// 'transfuse' onto the noun 'transfusion', so the noun has to be listed or
// "I think transfuse him" stops looking like an order — and a diagnosisClause
// skips every med responder, which cost that phrasing its transfusion credit in
// 13 packs when the fold first landed. But the bare noun heads a DIAGNOSIS as
// readily as an order, so the three diagnosis phrases are excluded by name:
// transfusion reaction, transfusion-related acute lung injury, transfusion-
// associated circulatory overload. (This is the same care 'shock' gets by being
// left out of this list entirely; here the following word settles it.)
const LEADING_ORDER_RE = /^(give|start|push|hang|administer|intubate|cardiovert|transfus(?:e|ion(?!\s+(?:reactions?|related|associated)))|repeat|recheck|get|send|order)\b/i;
const EXAM_VERBS = ['examine','exam','auscultate','palpate','percuss','inspect','look at','listen to','check','assess','feel'];
const HISTORY_VERBS = ['ask','any ','does she','does he','tell me','when did','when exactly','when was','how long','what ','where ','has she','has he','has anyone','did she','did he','did the','do you','history'];

// 'go right BACK on it', 'bring the sodium BACK down' — motion uses of 'back'
// kept returning a spine exam.
const BACK_MOTION_RE = /\b(go|going|come|coming|call|be|way|right|bring|bringing|it) back\b|\bback (on|to|off|in|out|down|up|around)\b/;
const regionOK = (r, clause) => !(r.motion && BACK_MOTION_RE.test(clause));
const MINUTES = {history:3, exam:4, lab:18, med:5, procedure:10, consult:10, disposition:5, assessment:2, other:3};

function findImaging(clause){
  const toks = clause.split(' ');
  // A whole-clause bare "FAST" or the CONTIGUOUS phrase is the trauma exam; the
  // scattered tokens are not ("the exam tells us how fast we're losing him"
  // returned a full FAST report). The FAST aliases are excluded from the fuzzy
  // loop below for the same reason.
  if(clause.trim() === 'fast' || /\bfast exam\b/.test(clause) || /\befast\b/.test(clause))
    return IMAGING_STUDIES.find(s => s.aliases.includes('fast exam'));
  // longest-alias-first so 'ct angiography chest' beats 'computed tomography chest'
  const sorted = [...IMAGING_STUDIES].sort((a,b)=>b.aliases[0].length - a.aliases[0].length);
  for(const st of sorted)
    if(st.aliases.some(a => a !== 'fast exam' && a !== 'efast' && fuzzyHas(toks,a))) return st;
  return null;
}
function findPanel(clause){
  const toks = clause.split(' ');
  for(const key of Object.keys(PANELS)) if(fuzzyHas(toks,key)) return key;
  // A bare "blood gas" (no venous/arterial) ordered mid-crisis returned a
  // one-line "Within normal limits" shrug; "electrolytes" returned nothing at
  // all. Both are everyday orders with an obvious canonical panel.
  if(/\bblood gas\b/.test(clause)) return clause.includes('arterial') ? 'arterial blood gas' : 'venous blood gas';
  if(/\belectrolytes\b/.test(clause)) return 'basic metabolic panel';
  return null;
}
// Some drugs are both something you GIVE and something you MEASURE — acetaminophen above
// all. "tylenol 650 po" for a febrile patient came back as "Acetaminophen level: <10": the
// antipyretic was never given and the player got a tox result nobody ordered. An order
// carrying a dose, a route, or a giving verb is an administration; a level has to be asked
// for by name.
const DRUG_LEVEL_TESTS = ['acetaminophen','salicylate','ethanol','digoxin','lithium',
                          'valproate','phenytoin','carbamazepine','vancomycin','tobramycin','gentamicin'],
// Electrolytes are the same trap in the other direction: "mag 2g IV" in a TCA
// overdose returned "LAB Magnesium: 2.0 mg/dL" and the drug was never given.
      DUAL_GIVE_MEASURE = ['magnesium','potassium','calcium','phosphorus','phosphate','sodium bicarbonate'];
const ADMINISTERED_RE = /\b\d+\s*(mg|mcg|g|units?|ml|l|mg\/kg|mcg\/kg|meq)\b|\b(po|iv|im|pr|sl|sc|subq|ng|neb|inh|gtt|drip|bolus|replete|repletion)\b|\b(give|giving|administer|push|hang|start|started|dose|redose|amps?|ampules?)\b/i;
// ---------- Route awareness ----------
// Some orders are the SAME DRUG by a route that does or does not work. Oral
// vancomycin treats C. difficile colitis; the identical drug given IV never
// reaches the colon. Matching is route-blind, so "vancomycin 20 mg/kg IV"
// scored the oral-vancomycin critical action in the one case that exists to
// teach the difference. A pack responder can therefore declare which routes
// its action accepts (see ROUTE guard in runTurn); absent the field, nothing
// changes. Read from the RAW clause: the catalog rewrite canonicalises drug
// names and can drop the route the player actually typed.
const ROUTE_PATTERNS = {
  po: /\b(po|oral|orally|by mouth|per os|enteral|enterally|swallow)\b/i,
  ng: /\b(ng|nasogastric|og|orogastric|feeding tube|dobhoff|gastric tube)\b/i,
  pr: /\b(pr|rectal|rectally|per rectum|enema|retention enema)\b/i,
  iv: /\b(iv|intravenous|intravenously|iv push|ivp|central line|peripheral line|drip|infusion)\b/i,
  im: /\b(im|intramuscular|intramuscularly)\b/i,
  sc: /\b(sc|subq|subcutaneous|subcutaneously)\b/i,
  io: /\b(io|intraosseous)\b/i,
  neb: /\b(neb|nebulized|nebuliser|nebulizer|inhaled|inhalation)\b/i,
};
// Every route the clause names. Empty = the player did not say one, which is a
// DIFFERENT case from naming the wrong one: it stays with dose.flagIfUnspecified,
// whose whole job is to ask for the route.
function clauseRoutes(text){
  const t = String(text || '');
  return Object.keys(ROUTE_PATTERNS).filter(k => ROUTE_PATTERNS[k].test(t));
}
function findSolo(clause, rawClause){
  const toks = clause.split(' ');
  // A comma-list item "mg" is magnesium; the token can't expand globally because
  // it is also the milligram unit — only a whole clause of it is the test.
  if(clause.trim() === 'mg') return 'magnesium';
  // Administration evidence is read from the RAW clause: the catalog rewrite canonicalises
  // "acetaminophen 650 po" down to "acetaminophen", throwing away the dose and route this
  // check needs, and the drug level came back regardless.
  const evidence = rawClause || clause;
  const wantsLevel = /\b(level|levels|concentration|trough|peak|recheck|repeat)\b/.test(evidence);
  // "stop the potassium pills" is medication management, not a potassium level.
  const homeMedContext = /\b(stop|stopping|hold|holding|discontinue|discontinuing|home|pills?|tabs?|tablets?|supplements?)\b/.test(evidence);
  for(const key of Object.keys(SOLO_TESTS)){
    if(!fuzzyHas(toks,key)) continue;
    // A drug that is also an assay: only a lab when the player asked for the measurement.
    if((DRUG_LEVEL_TESTS.includes(key) || DUAL_GIVE_MEASURE.includes(key))
       && !wantsLevel && (ADMINISTERED_RE.test(evidence) || homeMedContext)) continue;
    return key;
  }
  return null;
}
// Talking ABOUT a plan is not enacting it. "consult social work for safe discharge
// planning" and "update the daughter — she needs the OR and ICU" are a consult and a
// family conversation, but each buries a disposition word, and the disposition check runs
// first and closed the case out from under three of four playtesters mid-workup. A clause
// that opens with a communication or referral verb is classified on its own merits.
const DISCUSS_RE = /^\s*(consult|call|page|refer|update|explain|discuss|counsel|talk|speak|tell|notify|inform|reassure|ask|advise|offer|sit (down )?with|meet with|gather)\b/i;
// ...unless the communication IS the disposition ("call for admission", "call the cath lab").
const DISCUSS_IS_DISPO_RE = /\b(for|arrange|arranging|request(?:ing)?)\s+(?:an?\s+)?(admission|transfer)\b|\b(cath lab|operating room|to the or)\b/i;
// Asking WHETHER to disposition is not dispositioning. A playtester presented to
// neurology — "...want your input on timing of anticoag and whether to admit to
// stroke svc" — and the engine matched "admit", closed the case mid-question, then
// scored him down for never addressing the thing he was asking about.
const DELIBERATE_RE = /\b(whether (to|we|i|he|she|they)|should (i|we|he|she|they)|do you (think|recommend|want|feel)|would you|your (input|thoughts|advice|take|call|opinion)|input on|thoughts on|advice on|opinion on|wondering (if|whether)|not sure (if|whether)|torn between|deciding (whether|if|between))\b/;
// A clause that OPENS interrogatively is a question, whatever keywords it holds:
// "any NICU time?" in a birth history dispositioned a BRUE at turn two, and
// "when exactly did the cold START" confirmed a phantom medication.
const INTERROG_RE = /^\s*(any|has|have|had|did|does|do|was|were|is|are|what|when|where|how|why|who|which|can|could|will|would|tell me about)\b/;
function classifyIntent(clause){
  const toks = clause.split(' ');
  const discussing = (DISCUSS_RE.test(clause) && !DISCUSS_IS_DISPO_RE.test(clause))
                     || DELIBERATE_RE.test(clause) || INTERROG_RE.test(clause);
  if(!discussing && DISPO_RE.test(clause) && !summonsOnly(clause)) return 'disposition';
  if(!discussing && ADMISSION_RE.test(clause) && !PRIOR_ADMISSION_RE.test(clause)) return 'disposition';
  if((CONSULT_WORDS.some(w=>toks.includes(w)) || CONSULT_PHRASE_RE.test(clause))
     && CONSULT_SERVICES.some(s=>fuzzyHas(toks,s))) return 'consult';
  // ASSESS_WORDS is a substring test over the whole clause, so "dx" cannot live in it —
  // it would fire inside other words. The anchored frame regex carries it instead.
  if(ASSESS_WORDS.some(w=>clause.includes(w)) || ASSESS_FRAME_RE.test(clause)) return 'assessment';
  if(findImaging(clause) || clauseModality(clause)) return 'imaging';   // bare "ct scan" is still an imaging order
  if(findPanel(clause) || findSolo(clause) || /\blabs\b|\bbloodwork\b|\blab work\b/.test(clause)) return 'lab';
  if(MED_WORDS.some(w=>fuzzyHas(toks,w)) &&
     /\b(drip|infusion|gtt|bolus|iv|im|po|pr|sl|sc|neb|mcg|mg|meq|units?|mg\/kg|mcg\/kg)\b/.test(clause))
    return 'med';
  if(PROCEDURE_WORDS.some(w=>clause.includes(w))) return 'procedure';
  // Bare service name with no consult verb ("trauma", "neurology") — checked
  // AFTER the study checks, because several services are also the first word
  // of a real study order: "trauma ultrasound" is a FAST exam, not a trauma
  // consult (it was routing to the consult team). Whole-word match only, so
  // the short services can't swallow longer words ('ent' vs "enter the room").
  if(CONSULT_SERVICES.some(s => clause===s || clause.startsWith(s+' '))) return 'consult';
  // exam BEFORE med: an explicit exam verb outranks a fuzzy med-word hit
  // Word boundaries, not substrings: "tranexamic acid" contains "exam", so ordering TXA in
  // a haemorrhaging patient returned a physical exam and the drug was never given.
  if(EXAM_VERBS.some(w=>new RegExp('\\b'+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(clause))) return 'exam';
  // The giving-verb heuristic needs the verb near the clause HEAD — "when
  // exactly did the cold START" is a question ending in the word, not an order.
  if(MED_WORDS.some(w=>fuzzyHas(toks,w)) ||
     (!INTERROG_RE.test(clause) && (/^(?:\w+\s+){0,3}(give|administer|push|hang|start|bolus)\b/.test(clause) || /\d+\s*(mg|mcg|g|units|ml|l)\b/.test(clause)))) return 'med';
  if(EXAM_REGIONS.some(r=>regionOK(r, clause) && r.aliases.some(a=>fuzzyHas(toks,a)))) return 'exam';
  if(clause.includes('?') || HISTORY_VERBS.some(w=>clause.includes(w)) || HISTORY_TOPICS.some(t=>t.aliases.some(a=>fuzzyHas(toks,a)))) return 'history';
  // Last, so a drug, a test or an imaging study is never mistaken for a diagnosis:
  // anything that is JUST the name of a condition is the player calling it.
  if(isBareDiagnosis(clause)) return 'assessment';
  return 'other';
}
// Which pack-responder intents may answer a clause of a given intent. An exam
// responder must never steal an imaging order (root cause of the CT-order bug:
// exam aliases like "abdomen" matched "ct abdomen" and suppressed the CT).
const INTENT_COMPAT = {
  imaging:['imaging'], exam:['exam'], lab:['lab'], consult:['consult'],
  med:['med','procedure'], procedure:['procedure','med'],
  disposition:['disposition'], assessment:['assessment','consult'], history:['history']
};
// Detect the imaging modality a clause is asking for (post-normalize tokens).
function clauseModality(clause){
  // mri BEFORE ct so "magnetic resonance venography" isn't claimed by the
  // generic "venogra" term below (compat would forgive it, but be precise).
  if(/magnetic resonance|mr angiography/.test(clause)) return 'mri';
  // nuclear-medicine scans (Meckel, HIDA, tagged-RBC…) ride the ct bucket:
  // packs author them as cross-sectional reports and MODALITY_COMPAT treats
  // ct/mri as interchangeable, so this is the right runtime behavior even if
  // scintigraphy isn't literally a CT.
  if(/ct angiography|computed tomography|venogra|meckel|technetium|pertechnetate|radionuclide|nuclear medicine|tc99m|scintigraph|hida/.test(clause)) return 'ct';
  if(/electrocardiogram|12 lead|posterior leads|right sided (leads|electrocardiogram)|\bv7\b|\bv4r\b|15 lead/.test(clause)) return 'ekg';
  if(/x ray|skeletal survey|bone survey|fracture survey|babygram|shunt series|skull series|catheter series/.test(clause)) return 'xr';
  if(/ultrasound|echocardiogram|fast exam|duplex|sonogram|sonography/.test(clause)) return 'us';
  return null;
}
const MODALITY_COMPAT = { ct:['ct','mri'], mri:['mri','ct'], xr:['xr','cxr'], cxr:['cxr','xr'], us:['us'], ekg:['ekg'] };
function responderModality(r){
  for(const rep of (r.diagnosticReports||[])){ const t=((rep.image&&rep.image.type)||'').toLowerCase(); if(t) return t; }
  return null;
}
// Score a responder's match against clause tokens: more matched alias tokens win,
// ties broken by alias length. (Fuzzy semantics identical to fuzzyHas — typo
// tolerance is a feature; the intent/modality gates provide the safety.)
// Tokens so generic that an alias made ONLY of them proves nothing when scattered:
// "start ceftriaxone 50 mg/kg IV now" contains {start, iv}, and the epiglottitis
// pack's punished start-an-IV responder fired on it — an intubated, settled child
// "screamed around the drool" in the same turn the antibiotic ran. An all-generic
// alias must appear as a contiguous phrase; one content word restores fuzzy matching.
const GENERIC_ALIAS_TOKENS = new Set(['start','give','push','hang','place','get','order',
  'obtain','send','check','recheck','repeat','draw','iv','im','po','pr','sl','sc','now',
  'stat','an','a','the','his','her','him','me','please','for','to','on','of','with','and',
  'up','two','set',
  // 'to the or' scatter-matched "go back TO ... surgicel OR combat gauze" and
  // dispositioned a hemorrhaging patient into an OR nobody sent her to
  'or','take']);
const LONE_DEAD_ALIASES = new Set(['or','and','to','of','the','a','an','on','in','for','with','at','by','it','is','me','his','her','him']);
// Authors often include urgency in an alias ("start broad-spectrum antibiotics
// now") while clinicians omit it because the surrounding case already makes the
// urgency obvious. It should not turn the same clinical order into a miss. Keep this
// deliberately small: route/dose/anatomy/service words are NEVER optional.
const OPTIONAL_ALIAS_MODIFIERS = new Set(['now','immediately','urgent','urgently','emergent','emergently','stat','asap','right','away']);
function matchScore(r, toks){
  let best = 0;
  const clauseStr = ' ' + toks.join(' ') + ' ';
  for(const a of ((r.match&&r.match.any)||[])){
    const na = normalize(a); if(!na) continue;
    const parts = na.split(' ');
    // a lone FUNCTION word (a bare 'or' alias) is never evidence; a lone verb
    // like 'recheck' still is
    if(parts.length === 1 && LONE_DEAD_ALIASES.has(parts[0])) continue;
    if(parts.length > 1 && parts.every(t => GENERIC_ALIAS_TOKENS.has(t))){
      if(clauseStr.includes(' ' + na + ' ')) best = Math.max(best, parts.length + na.length/100);
      continue;
    }
    if(fuzzyHas(toks, na)) best = Math.max(best, parts.length + na.length/100);
    else {
      const core = parts.filter(t => !OPTIONAL_ALIAS_MODIFIERS.has(t));
      // Do not turn a one-word generic alias such as "treat now" into "treat".
      // Two substantive words are the minimum signal for this relaxed comparison.
      if(core.length >= 2 && core.length < parts.length && fuzzyHas(toks, core.join(' ')))
        best = Math.max(best, core.length + core.join(' ').length/100);
    }
  }
  return best;
}
// Pack responders are authoritative, but selection is intent-scoped, modality-
// gated for imaging, and best-match-wins for the intents where multiple answers
// would pile up (imaging/exam/disposition). Unclassifiable clauses ('other')
// stay eligible against every responder — the safety valve for specific aliases
// like "naat" or "step out" that no generic classifier knows.
function responderHasImaging(r){ return r.intent==='imaging' || !!(r.diagnosticReports && r.diagnosticReports.length); }
// Match a typed clause to pack responders. The ONLY genuinely harmful cross-intent
// theft is the imaging boundary (an "abdomen" exam responder answering a "ct abdomen"
// order, or an "examine" order returning a CT). We enforce that boundary strictly and
// are PERMISSIVE everywhere else — because classifyIntent is necessarily imperfect
// ("tranexamic acid" contains "exam", "recheck glucose" contains "check", "cardiac
// history" hits an exam region) and a correct order must never be dropped just because
// its wording tripped the classifier. Any responder whose aliases actually match is
// eligible; multi-word aliases keep this from over-matching.
function matchResponders(pack, clause){
  if(!pack || !Array.isArray(pack.responders)) return [];
  const norm = normalize(clause), toks = norm.split(' ');
  const mod = clauseModality(norm);
  const isImaging = classifyIntent(norm)==='imaging' || !!mod;
  const scored = pack.responders.map(r => ({r, s: matchScore(r, toks)})).filter(h => h.s > 0);
  if(isImaging){
    // imaging order → ONLY imaging content, of a compatible modality, best match only
    let hits = scored.filter(h => responderHasImaging(h.r))
      .filter(h => { if(!mod) return true; const rm = responderModality(h.r);
                     return !rm || (MODALITY_COMPAT[mod]||[mod]).includes(rm); });
    hits.sort((a,b)=>b.s-a.s);
    if(hits.length > 1) hits = [hits[0]];
    // a stated recognition can ride along with an imaging order
    return hits.concat(scored.filter(h => h.r.intent==='assessment')).map(h=>h.r);
  }
  // non-imaging order → everything that matches EXCEPT imaging-study responders
  // (so "give X" / "examine Y" / "ask Z" never surfaces a stray CT).
  const hits = scored.filter(h => !responderHasImaging(h.r)).map(h=>h.r);

  // CONSULT bridging: "consult ob emergently" must reach a responder whose
  // aliases say "gyn consult"/"call ob" — the verb and spelling differ but the
  // SERVICE is the same. If the clause names a consult service, include any
  // consult responder that names the same service (or the same on-call family,
  // e.g. OB≈GYN), even when no alias fuzzy-matched. (Playtest: an emergent OB
  // consult in a ruptured ectopic earned zero credit purely on phrasing.)
  if(CONSULT_WORDS.some(w=>toks.includes(w)) || CONSULT_PHRASE_RE.test(norm) || CONSULT_SERVICES.some(s=>norm.startsWith(s))){
    const clauseSvc = CONSULT_SERVICES.filter(s=>fuzzyHas(toks, s)).map(s=>SERVICE_FAMILY[s]||s);
    if(clauseSvc.length){
      for(const r of pack.responders){
        if(r.intent!=='consult' || hits.includes(r)) continue;
        const aliasText = ((r.match&&r.match.any)||[]).map(a=>normalize(a)).join(' | ');
        const rSvc = CONSULT_SERVICES.filter(s=>aliasText.includes(s)).map(s=>SERVICE_FAMILY[s]||s);
        if(rSvc.some(s=>clauseSvc.includes(s))) hits.push(r);
      }
    }
  }
  // PRIVACY bridging: any "get the family out" phrasing reaches the pack's
  // privacy responder even when the player names the wrong relative — the
  // request is identical, only the wording differs.
  if(PRIVACY_RE.test(norm)){
    for(const r of pack.responders){
      if(hits.includes(r) || responderHasImaging(r)) continue;
      const aliasText = ((r.match&&r.match.any)||[]).map(a=>normalize(a)).join(' | ');
      if(PRIVACY_RE.test(aliasText)) hits.push(r);
    }
  }
  return hits;
}

// ---------- Order catalog integration (optional; absent = today's behavior) ----------
// Longest-alias-first substitution list, built once per catalog and memoized
// on the catalog array itself. This is a pure-result optimization only: the
// SAME (text, catalog) pair always produces the SAME output — the cache never
// changes what runTurn returns, only how fast it returns it on repeat turns.
// NOTE: treat `catalog` as immutable once passed in. This cache is keyed on
// the array reference, not its contents — mutating entries in place after
// first use (e.g. pushing a new alias onto an existing entry) will silently
// serve the stale substitution list. Not a concern for the current usage
// (load order-catalog.json once, never mutate), but worth knowing.
// Catalog aliases that are single common English words rewrite ordinary prose:
// "to be CLEAR, no D5W near her" became "to be DEFIBRILLATE" and the nurse
// delivered a phantom shock to a neonate in sinus tach.
const CATALOG_ALIAS_BLOCKLIST = new Set(['clear','shock','line','time','call','cold','wet','dry',
  'drip','push','scan','film','gas','fast','level','study','strip','tap','hold','mask',
  // A trailing route word is not an order for vascular access: "give 1 L normal saline
  // bolus IV" was being rewritten to "... iv access" and credited two packs for the
  // large-bore IVs it never asked for.
  'iv']);
function catalogAliasList(catalog){
  if(catalog._aliasList) return catalog._aliasList;
  const list = [];
  for(const entry of catalog){
    const canonical = ' '+normalize(entry.canonical)+' ';
    for(const alias of (entry.aliases||[])){
      const na = normalize(alias);
      if(!na || na === entry.canonical || CATALOG_ALIAS_BLOCKLIST.has(na)) continue;
      list.push({needle:' '+na+' ', canonical});
    }
  }
  list.sort((a,b)=> b.needle.length - a.needle.length);
  catalog._aliasList = list;
  return list;
}
// Rewrites known catalog aliases (slang/brand names) into their canonical
// phrase BEFORE the existing pipeline (splitClauses/classifyIntent/
// matchResponders) ever sees the text — so a pack responder keyed to the
// canonical phrase still fires without needing to know any slang itself.
// First-token index of every alias AND every canonical, longest phrase first.
// Canonicals are indexed as identity rewrites so text that is already canonical
// CONSUMES its own tokens: "give lactated ringers" was becoming "give lactated
// lactated ringers" because the bare alias "ringers" re-fired inside the
// canonical it maps to. An alias that itself contains its canonical ("1l bolus",
// "heparin drip", "10 units insulin") is not indexed: the canonical is already in
// the text, and rewriting would only delete the dose beside it.
// A number in an alias, and the connective that carries it. Used to tell a name that
// happens to contain a digit ("chem 7", "nh3", "12 lead") from a name with a dose bolted
// on ("amio 150", "fent 50mcg", "roc 1mg/kg") — only the second kind is a problem.
const ALIAS_DOSE_TOKEN = /^(?:\d+(?:\.\d+)?(?:mg|mcg|g|gm|ml|l|cc|units?|u|meq|iu|%)?(?:\/(?:kg|hr?|min|day|dose))?|of)$/i;

function catalogPhraseIndex(catalog){
  if(catalog._phraseIndex) return catalog._phraseIndex;
  const idx = Object.create(null);
  const add = (phrase, canonical) => {
    const toks = phrase.split(' ').filter(Boolean); if(!toks.length) return;
    (idx[toks[0]] = idx[toks[0]] || []).push({toks, canonical});
  };
  for(const entry of catalog){
    const canonical = normalize(entry.canonical); if(!canonical) continue;
    const own = new Set([canonical, ...(entry.aliases||[]).map(a => normalize(a))]);
    add(canonical, canonical);
    for(const alias of (entry.aliases||[])){
      const na = normalize(alias);
      if(!na || na === canonical || CATALOG_ALIAS_BLOCKLIST.has(na)) continue;
      if((' '+na+' ').includes(' '+canonical+' ')) continue;
      // NAME + DOSE aliases are deliberately left out of the index. Matching one swallows
      // the number — the canonical it maps to carries no dose — so "give amio 150" became
      // "give amiodarone" and the 150 was gone before anything could grade it, read it
      // back, or notice it was missing. Leaving the alias out costs nothing, because what
      // remains after the number ("amio") is itself an alias of the same entry and matches
      // on its own, so the name still canonicalises and the number stays in the clause.
      // The same rescues a CONCENTRATION, which is not a dose and matters more: "dextrose
      // 50" and "epinephrine 1 10000" used to arrive as bare "dextrose" and "epinephrine".
      if(/\d/.test(na)){
        const rest = na.split(' ').filter(t => !ALIAS_DOSE_TOKEN.test(t)).join(' ');
        if(rest && rest !== na && own.has(rest)) continue;
      }
      add(na, canonical);
    }
  }
  for(const k of Object.keys(idx)) idx[k].sort((a,b)=> b.toks.length - a.toks.length || b.toks.join(' ').length - a.toks.join(' ').length);
  catalog._phraseIndex = idx;
  return idx;
}
function applyCatalogAliases(normText, catalog){
  if(!catalog || !catalog.length) return normText;
  const idx = catalogPhraseIndex(catalog);
  const toks = normText.split(' ').filter(Boolean);
  const out = [];
  for(let i = 0; i < toks.length;){
    let hit = null;
    for(const c of (idx[toks[i]] || [])){
      if(c.toks.every((t, k) => toks[i+k] === t)){ hit = c; break; }
    }
    if(hit){ out.push(hit.canonical); i += hit.toks.length; }
    else { out.push(toks[i]); i++; }
  }
  return out.join(' ');
}
// The LONGEST alias that appears, not the first one listed. An entry's alias list is
// authored for recall, not precedence, so "ns" sitting above "normal saline bolus" would
// otherwise decide how much of the clause the match accounts for.
function catalogExactHit(entry, clause){
  const s = ' '+clause+' ';
  let best = null;
  for(const alias of [entry.canonical, ...(entry.aliases||[])]){
    const na = normalize(alias);
    if(na && s.includes(' '+na+' ') && (!best || na.length > best.length)) best = na;
  }
  return best;
}
// Order verbs, articles, routes and bedside quantities — words whose presence beside a
// matched alias says nothing about WHAT was ordered. Everything else left over is
// meaning the match failed to account for.
const CLAUSE_FILLER = new Set(['a','an','the','of','to','for','on','in','at','with','and',
  'please','stat','now','then','also','get','place','order','send','insert','put','start',
  'do','perform','obtain','check','draw','give','run','his','her','their','him','her',
  'right','left','side','bedside','iv','io','im','po','mg','ml','mcg','g','l','cc',
  'gauge','fr','french','space','mid']);
// Dose grammar — volume, weight basis, rate, route and the word "bolus" — says HOW
// MUCH of the matched thing, never WHAT. The app's own chip "Give a 1 liter normal
// saline bolus" left {liter, bolus} unexplained, capped at medium, and tripped
// the readback gate on every send.
const DOSE_TOKEN_RE = /^(l|ml|cc|liters?|litres?|mg|mcg|g|gm|grams?|meq|units?|iu|kg|kilos?|kilograms?|%|percent|hours?|hrs?|h|min|mins|minutes?|sec|secs|seconds?|bolus|boluses|amps?|ampoules?|ampules?|vials?|pushe?s?|drips?|gtt|infusions?|per|over|at|of|and|wide|open|rate|q\d*h?|(mg|mcg|ml|units?|meq|g)\/(kg|hr?|min|day|dose)(\/(hr?|min|day))?)$/;
function unexplainedTokens(clause, aliasText){
  const covered = new Set(String(aliasText||'').split(' ').filter(Boolean));
  return clause.split(' ').filter(t => t && !covered.has(t) && !CLAUSE_FILLER.has(t)
    && !/\d/.test(t) && !DOSE_TOKEN_RE.test(t)).length;
}
function scoreCatalogEntry(entry, toks){
  let best = 0;
  for(const alias of [entry.canonical, ...(entry.aliases||[])]){
    const na = normalize(alias); if(!na) continue;
    if(fuzzyHas(toks, na)) best = Math.max(best, na.split(' ').length + na.length/100);
  }
  return best;
}
function bestCatalogMatch(catalog, toks){
  let best = null, bestScore = 0;
  for(const entry of (catalog||[])){
    const s = scoreCatalogEntry(entry, toks);
    if(s > bestScore){ bestScore = s; best = entry; }
  }
  return best;
}
const ORDER_INTENTS = ['lab','imaging','med','procedure','consult'];
// Reports match confidence per clause of a typed action WITHOUT mutating
// anything — the UI calls this BEFORE running a turn to decide whether to
// proceed immediately ('high'/'skip') or show the nurse-readback
// confirmation first ('medium'/'none').
function resolveOrders(action, catalog){
  // Canonicalize first — same pre-pass runTurn applies — so an exact-alias
  // clause classifies by its CANONICAL wording (e.g. a slang phrase that
  // happens to contain a verb like "check" mustn't be misclassified as an
  // exam order before the catalog ever gets a chance to recognize it).
  const normText = applyCatalogAliases(normalize(action), catalog);
  const clauses = splitClauses(normText);
  const clauseList = clauses.length ? clauses : [normText];
  return clauseList.map(clause => {
    const intent = classifyIntent(clause);
    if(!ORDER_INTENTS.includes(intent)) return {clause, intent, tier:'skip', suggestion:null};
    if(!catalog || !catalog.length) return {clause, intent, tier:'none', suggestion:null};
    // Scope candidates to the clause's own classified intent. ORDER_INTENTS
    // names are IDENTICAL to catalog categories ('lab','imaging','med',
    // 'procedure','consult'), so this is a free, exact filter. Without it,
    // two entries sharing a canonical/alias across categories produce a
    // suggestion that depends on catalog ARRAY ORDER, not on the clause.
    const candidates = catalog.filter(e => e.category === intent);
    const toks = clause.split(' ');
    // An "exact" hit that leaves the clause mostly unexplained is not exact. Played
    // consequence: "insert IV thoracostctomy 4ICS mid axiallary line" hit the bare
    // alias "line", resolved to Arterial Line at tier HIGH, and sailed past the
    // confirmation gate — the resolver matched two stray words and ignored five it
    // could not account for. Leftover meaning caps the tier at medium, so the nurse
    // reads the order back and asks instead of quietly performing something else.
    // The exact hit that accounts for the MOST of the clause wins — never simply the
    // first candidate in the array. Played consequence of taking the first: "give a 1
    // liter normal saline bolus" matched the entry Bolus, left "normal saline"
    // unexplained, and was capped at medium — so the app's own fluid order tripped the
    // nurse's readback while a bare "bolus" sailed through.
    let exactAlias = null, exact = null, exactLeft = Infinity;
    for(const e of candidates){
      const na = catalogExactHit(e, clause);
      if(!na) continue;
      const lo = unexplainedTokens(clause, na);
      if(lo < exactLeft || (lo === exactLeft && na.length > (exactAlias||'').length)){
        exact = e; exactAlias = na; exactLeft = lo;
      }
      if(!exactLeft) break;
    }
    if(exact){
      const leftover = exactLeft;
      const tier = leftover >= 2 ? 'medium' : 'high';
      return {clause, intent, tier, leftover, suggestion:{id:exact.id, label:exact.label, canonical:exact.canonical}};
    }
    const best = bestCatalogMatch(candidates, toks);
    if(best) return {clause, intent, tier:'medium', suggestion:{id:best.id, label:best.label, canonical:best.canonical}};
    return {clause, intent, tier:'none', suggestion:null};
  });
}
// The order catalog is deliberately case-blind so it never hints at the diagnosis.
// The simulator still needs to know whether this particular case can score the clause.
// Keep that inspection pure and share it with the UI readback instead of maintaining a
// second, subtly different definition of "recognized" in the browser.
function inspectOrders(pack, action, catalog){
  return resolveOrders(action, catalog).map(row => {
    const matches = matchResponders(pack, row.clause);
    return {...row, caseMatch:matches.length>0,
      creditable:matches.some(r => Number.isInteger(r.satisfies)),
      satisfies:[...new Set(matches.filter(r=>Number.isInteger(r.satisfies)).map(r=>r.satisfies))]};
  });
}

// ---------- Value generation for generic (fallback) labs ----------
function genValue(row){
  if(row.fixed !== undefined) return row.fixed;
  const v = row.lo + Math.random()*(row.hi - row.lo);
  return v.toFixed(row.dp);
}
function panelRows(key){ return PANELS[key].map(r=>({name:r.name, value:String(genValue(r)), unit:r.unit, flag:''})); }
// Every panel and solo test a clause names, appended generically when the rows
// already gathered don't cover them (used by both matched and fallback paths).
function appendMissingLabs(clause, rawClause, out, state){
  const toks = clause.split(' ');
  const have = new Set(out.labResults.map(l => canonLabName(l.name)));
  // Cited values are not re-orders (same rule as the fallback path).
  const reorder = /\b(recheck|repeat|redraw|send|draw|order|get|obtain|another|again|redo|stat|level|add)\b/.test(rawClause || clause);
  const seen = k => state && state.labsSeen && (state.labsSeen[k]);
  for(const key of Object.keys(PANELS)){
    if(!fuzzyHas(toks, key)) continue;
    const rows = panelRows(key);
    if(rows.some(r => have.has(canonLabName(r.name)))) continue;
    out.labResults.push(...rows);
    rows.forEach(r => have.add(canonLabName(r.name)));
  }
  for(const key of Object.keys(SOLO_TESTS)){
    if(!fuzzyHas(toks, key)) continue;
    const evidence = rawClause || clause;
    if((DRUG_LEVEL_TESTS.includes(key) || DUAL_GIVE_MEASURE.includes(key))
       && !/\b(level|levels|recheck|repeat)\b/.test(evidence) && ADMINISTERED_RE.test(evidence)) continue;
    const row = SOLO_TESTS[key];
    if(have.has(canonLabName(row.name))) continue;
    if(!reorder && seen(canonLabName(row.name))) continue;
    out.labResults.push({...row, flag:''});
    have.add(canonLabName(row.name));
  }
}

// Every study carries a written radiology read EXCEPT the two the ED physician
// self-reads in real time: the 12-lead ECG and the chest X-ray (mirror of the
// app's gate). Ultrasound, plain films, CT, and MRI all come back with a read.
function enforceReadRules(rep){
  const t = ((rep.image && rep.image.type) || '').toLowerCase();
  if(t === 'ekg' || t === 'cxr'){
    const note = {ekg:'12-lead ECG obtained.', cxr:'Portable chest X-ray obtained.'}[t];
    return {...rep, body: note};
  }
  return rep;
}
// Normal ranges by analyte name, for repeat-lab physiology: improvement STOPS at
// the range edge (a round-5 playtest watched sodium compound 116→195, each step
// narrated "better"), and a still-abnormal value demotes CRITICAL→H/L instead of
// shedding its flag entirely.
const NORMAL_RANGE = (() => {
  const m = {};
  for(const rows of Object.values(PANELS)) for(const r of rows)
    if(typeof r.lo === 'number') m[r.name.toLowerCase()] = {lo: r.lo, hi: r.hi};
  Object.assign(m, {
    'fibrinogen': {lo: 200, hi: 400}, 'lactate': {lo: 0.5, hi: 2.0},
    'troponin': {lo: 0, hi: 0.04}, 'ammonia': {lo: 10, hi: 35}, 'cortisol': {lo: 5, hi: 23},
  });
  return m;
})();
const canonLabName = n => {
  let s = String(n).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')                      // 'Creatine Kinase (CK)' == 'Creatine Kinase'
    .replace(/^(repeat|poc|bedside|serum|random|ua|urine)\s+/, '')  // 'Repeat sodium' == 'Sodium'
    .replace(/\s*[x\u00d7]\s*\d+\s*$/, '')          // 'Blood cultures x2' == '...\u00d72'
    .replace(/\s+/g, ' ').trim();
  if(/^troponin( i| t)?$/.test(s)) s = 'troponin';
  return s;
};
const TREND_RANK = {stable:0, improving:1, worsening:2, critical:3};
function strongerTrend(a, b){ if(!a) return b; if(!b) return a; return TREND_RANK[b] > TREND_RANK[a] ? b : a; }

// ---------- Fallback (no pack responder matched) — NEVER dead-end ----------
// Bread-and-butter nursing orders — the commonest things an ED physician types —
// previously fell to "Okay. Anything else you want while we're at it?" in every
// playtest session. Each gets a concrete acknowledgment; the vitals entry reads the
// monitor back, and oxygen nudges the sat (packs still win when they authored one).
// Asking what a self-read study SHOWS (articles are stripped by normalize).
const READ_REQ_RE = /(read|interpret|describe).{0,20}(electrocardiogram|ecg|ekg|film|x ray|strip|tracing)|what (do(es)?|did) (the )?(electrocardiogram|ecg|ekg|film|x ray|chest x ray)|(electrocardiogram|ecg|ekg).{0,12}show/;
// "Vitals" and "vital signs" name the same order. The quick chip says "Recheck a full
// set of vital signs" and the recognition regex only knew "vitals", so the chip the app
// itself offers came back as filler and was then BLAMED in the debrief's "orders the sim
// couldn't interpret". Spelled once and spliced into every vitals phrasing below, so a
// player typing it in their own words gets the same answer as the chip.
const VITALS_NOUN = '(?:vitals|vital signs)';
// A tracheostomy is not the emergency front-of-neck airway. In a can't-intubate,
// can't-oxygenate patient the ED rescue is a CRICOTHYROTOMY; a tracheostomy is a
// slower, planned, usually operative procedure. A player on core-failed-airway (a
// Le Fort II/III midface fracture) typed "tracheostomy" twice: both landed in the
// not-understood bucket — no effect, no teaching — and the debrief then listed
// them as orders the sim could not read.
//
// So it is recognised and CORRECTED, never aliased, and it credits nothing —
// crediting a surgical airway here would credit an act the player never
// performed, and they still have to call for the right one. Swept all 172 packs
// first: no pack anywhere wants a tracheostomy as an action, and the only
// trach-adjacent aliases ("trach standby" on peds-epiglottitis, "trach tray" on
// resp-ace-angioedema) both mean "have it ready" and live on pack responders,
// which always beat the fallback this reply sits in.
//
// The corpus is dense with words this must NOT touch — endotracheal, endotracheal
// tube, trachea, tracheal, tracheal deviation, tracheal position, suction the
// trachea, tracheoesophageal — so the pattern matches only the bare noun and the
// -stomy/-otomy forms. 'trach' never fuzzes onto 'trachea' (lev 2 at 5 letters,
// tolerance 1), and no alternative here can reach a word ending -eal or -ea.
const TRACH_RE = /\btrach(s|es)?\b|\btrache?o(stom|tom)(y|ies)\b/;
const CRIC_RE = /\bcric\w*/;
// Blood ordered in a case whose pack never authored a transfusion responder.
// Deliberately narrow: 'blood' alone appears in 1,100 aliases and belongs to
// blood cultures, blood gas, blood pressure, blood sugar, blood thinners and the
// blood bank. MTP is deliberately absent — activating a massive transfusion
// protocol is its own act, and its behavior is left exactly as it was.
const BLOOD_PRODUCT_RE = /\btransfusion\b|\bprbcs?\b|\bpacked (red (blood )?cells?|cells?|rbcs?)\b|\bblood products?\b/;
// Both replies live at the DEAD END — the branch that used to answer "Okay.
// Anything else you want while we're at it?" and flag the clause `_unparsed`.
// Nowhere else. An earlier draft put them in NURSING_ACTIONS and the corpus
// sweep caught it: that table is consulted for 'med' intent too, and it
// intercepted the med branch's own guards — "if she keeps bleeding give 2 units
// of PRBCs" lost "staged and standing by" and was answered as though asked for
// now. Sited here, every clause that any other branch has a claim on — a
// contingency, a hold, a negation, a question, a real med order — reaches that
// branch exactly as it did before, and only the clauses that were about to be
// thrown away are rescued. Nothing here credits a critical action; credit comes
// only from pack responders, which are matched long before the fallback runs.
// The last stop for a clause NOTHING understood. This used to be "Okay. Anything
// else you want while we're at it?" — acceptance language for an order the engine had
// just flagged _unparsed. Played consequence: a typo'd "thoracostctomy" during a PEA
// arrest was answered "Okay", the doctor reasonably believed the chest was
// decompressed, and the two-minute window that decided the case closed in silence.
// The nurse now reads back exactly what she failed to catch, so a typo is visible in
// her mouth and the player knows to say it again.
function notUnderstoodReply(clause, turn){
  const said = String(clause || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const pick = arr => arr[(turn || 0) % arr.length];
  if(!said) return pick(['Say again, doctor?', 'Sorry — I did not catch that.']);
  return pick([
    `Sorry, doctor — I didn't catch "${said}". Give it to me again?`,
    `I didn't understand "${said}" — can you say it another way?`,
    `"${said}" — I'm not following. Once more?`]);
}

function deadEndReply(clause, turn){
  const pick = arr => arr[(turn||0) % arr.length];
  // A player who says both words has already named the right one — "cric or
  // trach" is a correct instinct spoken out loud, not a mistake to rebuke.
  if(TRACH_RE.test(clause) && !CRIC_RE.test(clause)) return pick([
    'A trach is an OR procedure — we can\'t do one here. If you want a surgical airway now, say cricothyrotomy and I\'ll open the cric kit: scalpel, bougie, size 6 tube.',
    'Not a trach, doctor — that\'s theatre and time we don\'t have. The bedside rescue is a cricothyrotomy, and the kit is at your right hand.']);
  // Blood asked for in a case whose pack never authored a transfusion
  // responder. This ANSWERS the order; it does not run it and it grants nothing.
  // The word itself is matched with fuzzyHas rather than by the regex, so the
  // typo tolerance here is exactly the tolerance a pack alias gets — otherwise
  // "blood tranfusion", which is what the player actually typed, reaches every
  // authored responder and is still called unreadable in the cases that
  // authored none.
  if(BLOOD_PRODUCT_RE.test(clause) || fuzzyHas(clause.split(' '), 'transfusion')) return pick([
    'Blood bank has the sample — crossmatched units are about twenty minutes out, and O-negative is in the fridge if you want it sooner.',
    'I can get product up here — O-negative now, or crossmatched in twenty. Which do you want?']);
  return null;
}
const NURSING_ACTIONS = [
  // strong: wins even when an exam-region alias also matches the clause —
  // "continuous cardiac monitoring" is not a cardiac exam, and "rectal probe"
  // is not a rectal exam (a hypothermia playtest got tone/stool/guaiac back).
  {re:/\b(cardiac )?monitor(ing)?\b|telemetry|hook (him|her|them)? ?up|leads on/, strong:true, text:'On the monitor — leads on, tracing up, vitals cycling.'},
  {re:/(rectal|esophageal|core|temperature) probe|core temperature\b/, strong:true, temp:true},
  // Read policy: the player self-reads ECG and CXR — asking for the read gets a
  // pointer at the tracing, never the family's HPI.
  {re:READ_REQ_RE, strong:true, text:[
    'Strip and films are up on the viewer — your read, doctor.',
    'It\'s printed and on the screen — take a look; fresh eyes if anything\'s changed.']},
  // Repeatable code actions carry text VARIANTS: a single static line collides
  // with the cross-turn dedupe and shocks 2-5 of a playtested VF code vanished
  // into filler.
  {re:/defibrillat\w*|unsynchronized shock|shock (him|her|them|at \d)|charge to \d|(everyone|all) clear|(?<!septic |cardiogenic |hemorrhagic |hypovolemic |neurogenic |spinal |obstructive |distributive |toxic |warm |cold |refractory |compensated |a |delivered |in )\bshock\b(?! (state|index|liver|question|syndrome))/, act:true, text:[
    'Shock delivered — resuming compressions, rhythm check at the next cycle.',
    'Charged, clear — shock delivered. Back on the chest.',
    'Another shock delivered. Compressions resumed, watching the rhythm.',
    'Shock given — no change yet on the monitor, compressions continue.']},
  {re:/\bcpr\b|chest compressions|(resume|start|continue) compressions/, act:true, text:[
    'Compressions running — two-minute cycles, rotating compressors.',
    'Chest is moving — good depth and recoil, minimal pauses.',
    'Compressions continue — fresh compressor on.']},
  {re:/tell me (when|if|the (delta|number|value|result))|let me know (when|if)|call me (when|if)|holler if|flag me (when|if)/, strong:true, text:[
    'Will do — I\'ll flag you the moment it happens.',
    'Got it — you\'ll hear from me the second that changes.']},
  {re:/\b(pull|review|look (at|through)|get) (up )?(the |his |her |their |all )*(records?|charts?|prior (visits?|encounters?)|old (charts?|records?|notes?))|previous (ed )?(encounters?|visits?)\b/, strong:true, text:[
    'Old charts are up on the screen — prior visits flagged and open for you.',
    'Records requested and on the viewer — every encounter we can reach.']},
  {re:/(sit|meet) (down )?with (the )?(parents?|family|mom|dad)|update the (family|parents)|talk (to|with) (the )?(family|parents)/, strong:true, speaker:'family', text:[
    'Thank you for sitting with us, doctor — we understand. Please do whatever she needs.',
    'We appreciate you explaining it — we\'re scared, but we\'re with you.']},
  {re:/\bweigh (her|him|the (baby|infant|child))\b|(actual|today.?s|birth) weight|weight first|(get|need|want) (me )?(a |the )?weight\b|weight in (kilos|kilograms|grams)|number in (kilos|kilograms|grams)|what.{0,14}weigh|on the (infant )?scale/, strong:true, text:[
    'On the scale now — weight\'s charted at the bedside and the dosing sheet is up.',
    'Weight\'s taken and charted — per-kilo doses are on the board.']},
  {re:/circumferen\w*|remeasure|measure the (leg|limb|calf|arm|thigh)/, text:[
    'Taped and charted — I\'ll remeasure with every check and flag any gain.',
    'Circumference re-taped and logged next to the last set.']},
  {re:/\bintubate\b|rapid sequence intubation/, act:true, prep:true, text:[
    'Tube\'s in — waveform capnography confirms it, bilateral breath sounds, secured at the lip.',
    'Airway\'s secured — tube confirmed and tied at the lip, bagging easily.']},
  {re:/to suction at|tube to suction|suction at (negative |-)?\d+/, text:'Tube to suction — set, swinging, and bubbling as expected.'},
  {re:/head of (the )?bed|\bhob\b|sit (him|her|them) up(right)?|semi ?fowler|reverse trendelenburg/, strong:true, text:'Head of the bed is up.'},
  {re:/\bpads\b|defib(rillator)? pads|pacer pads/, text:'Defib pads are on the chest and connected.'},
  // A bedside re-eval is its own action, not a vitals recheck: it answers with the
  // numbers AND the arc. "recheck" stays out of this regex — it is the lab-reorder
  // verb ("recheck the potassium") and must keep redrawing labs.
  {re:/\bre.?assess\w*\b|\bre.?evaluat\w*\b|\breeval\b|how (is|are|s) (he|she|they|patient) (doing|looking)/, reassess:true},
  // "recheck the potassium" must still be a lab reorder: the recheck alternative only
  // fires on a monitored parameter, never on a bare noun.
  {re:new RegExp('\\bset of ' + VITALS_NOUN + '\\b|repeat ' + VITALS_NOUN + '|recheck ' + VITALS_NOUN
    + '|' + VITALS_NOUN + ' now|cycle the (cuff|pressure|bp)|latest (pressure|' + VITALS_NOUN + ')'
    + '|full (?:set of )?' + VITALS_NOUN
    + '|recheck (her |his |the |a )?(pressure|bp|' + VITALS_NOUN + '|temp(erature)?)'
    + '|what.{0,2}s (her|his|the) (pressure|bp|temp(erature)?)\\b'), vitals:true},
  {re:/\b1 1\b|one to one|sitter|suicide precautions|safety precautions|belongings secured/, text:'1:1 sitter is at the bedside and safety precautions are in place.'},
  {re:/stroke (code|alert|team)|code stroke/, text:'Stroke code called overhead — the team\'s been activated.'},
  {re:/airway cart|difficult airway|crash cart|code cart|cart to the (room|bedside)/, text:'Cart\'s at the bedside — checked and open.'},
  {re:/mark (the )?(margins?|borders?|erythema|redness)|margins? marked/, text:'Margins marked and timed — we\'ll watch for spread.'},
  {re:/nasal cannula|blow by|face ?mask|liters? (of )?oxygen|oxygen at \d|supplemental oxygen/, text:'Oxygen\'s on — watching the sat.', o2:3},
];
function fallbackFor(clause, opts, state, pack, rawClause, withheld, lineFlags){
  let intent = classifyIntent(clause);
  // classifyIntent reads the canonical clause, which is right — "draw bottles" is only a
  // lab because the catalog rewrites it to "blood cultures". But that same rewrite reduces
  // "acetaminophen 650 po" to "acetaminophen", so an administration reads as a lab and the
  // player who asked for an antipyretic gets a drug level. When the raw text shows the drug
  // was GIVEN and no panel or assay survives the check, it is a medication order.
  if(intent === 'lab' && rawClause && !findPanel(clause) && !findSolo(clause, rawClause)
     && ADMINISTERED_RE.test(rawClause)) intent = 'med';
  const fb = {intent, labResults:[], diagnosticReports:[], physicalExam:[], speech:[], dosingFlags:[], _minutes:MINUTES[intent]||3};
  const toks = clause.split(' ');
  // A read request for a self-read study deflects to the viewer whatever intent
  // the clause classified as (imaging, history, other).
  if(lineFlags && lineFlags.readreq && READ_REQ_RE.test(clause)){
    const readLines = ['Strip and films are up on the viewer — your read, doctor.',
                       'It\'s printed and on the screen — take a look; fresh eyes if anything\'s changed.'];
    fb.speech.push({speaker:'nurse', text: readLines[((state && state.turnCount) || 0) % readLines.length]});
    fb._minutes = 1;
    return fb;
  }
  // A bare service name inside a QUESTION is review-of-systems, not a page:
  // "any fevers, abd pain, trauma?" summoned the trauma surgeon.
  if(intent === 'consult' && lineFlags && lineFlags.question
     && CONSULT_SERVICES.includes(clause.trim())){
    fb.intent = intent = 'history';
  }
  // Mentioning a study while DISCUSSING (an SBAR, a family update) is not a
  // re-order: "four ultrasounds all show the target sign" spawned a fifth.
  if(lineFlags && lineFlags.discussing && (intent === 'imaging' || intent === 'lab')){
    fb._minutes = 1;
    return fb;
  }
  // A refused non-med order is a HOLD, not a request: "do not wait for the x-ray"
  // was answered with "X-ray of which body part?" — offering back the very thing
  // the doctor declined. A conditional hold ("hold if SBP under 100") is a
  // PARAMETER, acknowledged as one. Pure rhetoric ("actual, not estimated")
  // matches nothing order-like and passes in silence rather than as a phantom
  // "holding off" with no referent.
  if(withheld && intent !== 'med' && intent !== 'history'){
    if(/\b(if|unless)\b/.test(clause) && /\d/.test(clause)){
      fb.speech.push({speaker:'nurse', text:'Got it — that\'s the cutoff. I\'ll hold it if we cross that line.'});
    } else if(intent === 'imaging' || intent === 'lab' || intent === 'procedure'){
      fb.speech.push({speaker:'nurse', text:'Understood — holding that.'});
    }
    fb._minutes = 1;
    return fb;
  }
  // Nursing-action interception (fallback only — an authored responder always wins).
  if(intent==='other' || intent==='procedure' || intent==='med' || intent==='exam' || intent==='history'){
    const regionHit = intent==='exam' && EXAM_REGIONS.some(r=>regionOK(r, clause) && r.aliases.some(a=>fuzzyHas(toks,a)));
    const blocked = (intent==='exam' && regionHit) || intent==='history';
    const NEGQ = INTERROG_RE.test(clause) || /\b(nobody|no one|never|dont|stop|cancel|who)\b/.test(clause);
    const na = NURSING_ACTIONS.find(n=>n.re.test(clause) && (n.strong || !blocked)
      && !(n.act && NEGQ) && !(n.prep && PREP_RE.test(clause)));
    if(na){
      const v = (opts && opts.vitals) || {};
      const tc = (state && state.turnCount) || 0;
      if(na.reassess){
        // A bedside re-eval: fresh numbers plus the nurse's honest read of the
        // arc. Rotating lead-ins keep back-to-back re-evals clear of the
        // cross-turn dedupe, same trick as the vitals lead-ins below.
        const lead = ['Re-eval at the bedside','Taking another look','Here is where we are','Eyes on the patient now'][tc % 4];
        const trendLine = ({ improving:'Better than the last set — trending the right way.',
                             stable:'Holding steady since the last set.',
                             worsening:'Slipping — this set is worse than the last one.',
                             critical:'Not holding — this is getting critical.' })[(opts && opts.trend) || 'stable']
                          || 'Holding steady since the last set.';
        const reevalLine = `${lead} — HR ${Math.round(v.hr||0)}, BP ${Math.round(v.bpSystolic||0)}/${Math.round(v.bpDiastolic||0)}, RR ${Math.round(v.rr||0)}, sat ${Math.round(v.o2||0)}%, temp ${(+(v.temp||37)).toFixed(1)}. ${trendLine}`;
        fb.speech.push({speaker:'nurse', text:reevalLine});
        // The transcript renders `narrative`; `speech` is only voiced, and the room
        // bubble clips at 90 characters — which lands exactly on the trend sentence.
        // Speech-only, the whole answer was invisible and the player read the generic
        // "Done — the team moves on it." Same trap the working-diagnosis ack fell into;
        // same fix: the words that ANSWER the order go on screen. Still spoken too.
        fb._narrative = reevalLine;
      } else if(na.vitals){
        // Rotating lead-in: identical numbers two rechecks running would otherwise
        // collide with the cross-turn dedupe and a vitals request would go silent.
        const lead = ['Latest set','Fresh set','Right now','Current numbers'][tc % 4];
        fb.speech.push({speaker:'nurse', text:`${lead} — HR ${Math.round(v.hr||0)}, BP ${Math.round(v.bpSystolic||0)}/${Math.round(v.bpDiastolic||0)}, RR ${Math.round(v.rr||0)}, sat ${Math.round(v.o2||0)}%, temp ${(+(v.temp||37)).toFixed(1)}.`});
      } else if(na.temp){
        fb.speech.push({speaker:'nurse', text:`Probe's in — core temp ${(+(v.temp||37)).toFixed(1)}°C on continuous read.`});
      } else {
        const t = Array.isArray(na.text) ? na.text[tc % na.text.length] : na.text;
        fb.speech.push({speaker: na.speaker || 'nurse', text:t});
      }
      if(na.o2) fb._o2Bump = na.o2;
      fb._minutes = 2;
      return fb;
    }
  }
  if(intent === 'lab'){
    if(/\blabs\b|\bbloodwork\b|\blab work\b|\broutine\b/.test(clause) && !findPanel(clause) && !findSolo(clause, rawClause)){
      fb._routine = true;   // caller composes CBC+BMP (order-only rule), preferring pack rows
    } else {
      const p = findPanel(clause); let s = findSolo(clause, rawClause);
      // A cited value is not a re-order: "CK's almost 4 grand — start a liter
      // of LR" must run the fluids, not redraw the CK.
      if(!p && s && state && state.labsSeen){
        const row = SOLO_TESTS[s];
        const seenKey = state.labsSeen[canonLabName(row.name)] || state.labsSeen[row.name];
        const reorder = /\b(recheck|repeat|redraw|send|draw|order|get|obtain|another|again|redo|stat|level)\b/.test(rawClause || clause);
        if(seenKey && !reorder){
          const mtoks = clause.split(' ');
          const cited = MED_WORDS.filter(w => fuzzyHas(mtoks, w)).find(w => w !== 'bolus');
          if(cited){
            fb.intent = 'med';
            fb.speech.push({speaker:'nurse', text: cited.charAt(0).toUpperCase()+cited.slice(1)+' is running.'});
          } else {
            fb.intent = 'assessment';
          }
          fb._minutes = 2;
          return fb;
        }
      }
      if(p) fb.labResults.push(...panelRows(p));
      else if(s === 'fingerstick glucose'){
        // Borrow the case's own glucose if it has one anywhere (e.g. inside its BMP),
        // so a bedside sugar always agrees with the chemistry the case will report.
        let row = null;
        for(const r of (pack && pack.responders) || []){
          for(const l of r.labResults || []) if(/glucose/i.test(l.name)) { row = l; break; }
          if(row) break;
        }
        fb.labResults.push(row ? {name:'Fingerstick Glucose', value:row.value, unit:row.unit||'mg/dL', flag:row.flag||''}
                               : {...SOLO_TESTS[s], flag:''});
      }
      else if(s) fb.labResults.push({...SOLO_TESTS[s], flag:''});
      else fb.labResults.push({name: clause.replace(/^(order|send|get|check|draw)\s+(a\s+|an\s+)?/,'').trim() || 'Requested test', value:'Within normal limits', unit:'', flag:''});
    }
  } else if(intent === 'imaging'){
    const st = findImaging(clause);
    if(!st){
      // Bare modality with no body region ("get a ct scan"): a real nurse asks —
      // never substitute a different study, never shrug.
      const ask = {ct:'CT of what — head, chest, or abdomen/pelvis?', mri:'MRI of what region?',
                   xr:'X-ray of which body part?', us:'Ultrasound of what — RUQ, pelvis, or a FAST?',
                   ekg:null}[clauseModality(clause)];
      if(ask){ fb.speech.push({speaker:'nurse', text:'Sure — '+ask}); fb._minutes=1; return fb; }
    }
    const study = st || {title:'Imaging study', type:'xr', minutes:15, query:'radiograph'};
    fb._minutes = study.minutes;
    fb.diagnosticReports.push(enforceReadRules({title:study.title, body:study.read || '', image:{type:study.type, query:study.query}}));
  } else if(intent === 'exam'){
    const reg = EXAM_REGIONS.find(r=>regionOK(r, clause) && r.aliases.some(a=>fuzzyHas(toks,a))) || EXAM_REGIONS[0];
    // Pack-first: if THIS case authored findings for the same region, show
    // those — never the generic normal. Playtest: "examine the child" on an
    // obtunded toddler answered "alert, in no acute distress" (the generic
    // General normal) while the pack's own General finding said obtunded —
    // contradicting the case AND hiding the teaching finding. The generic
    // normals remain the fallback for regions the case says nothing about.
    const want = reg.system.toLowerCase();
    // Any shared substantive word links the region to an authored system name
    // ("Pelvis (MSK)" ↔ "Musculoskeletal/Pelvis"); playtest: the generic
    // extremity normal denied a shortened, externally rotated leg the pack's own
    // Neurovascular exam described.
    const wantToks = want.split(/[^a-z]+/).filter(w => w.length >= 5);
    const packExam = pack && (pack.responders||[]).find(r =>
      Array.isArray(r.physicalExam) && !r.gate && r.physicalExam.some(e => {
        const sys = String(e.system||'').toLowerCase();
        return sys===want || sys.includes(want) || want.includes(sys) ||
               sys.slice(0,4)===want.slice(0,4) ||
               wantToks.some(w => sys.includes(w)) ||
               // split: a Cardiovascular-labeled pack row must not hijack a LUNGS
               // request (two direct crackle checks came back cardiac-only)
               (want==='cardiac' && /cardio|heart/.test(sys)) ||
               (want==='lungs' && /pulmonary|resp|lung|chest/.test(sys)) ||
               (want==='extremities' && /neurovasc|musculoskel|limb/.test(sys));
      }));
    if(packExam) fb.physicalExam.push(...packExam.physicalExam);
    else fb.physicalExam.push({system:reg.system, finding:reg.normal});
  } else if(intent === 'history'){
    if(lineFlags && lineFlags.readreq){ fb._minutes = 1; return fb; }
    const t = HISTORY_TOPICS.find(t=>t.aliases.some(a=>fuzzyHas(toks,a)));
    if(t){ fb.speech.push({speaker:'patient', text:t.answer}); }
    else {
      // Unmatched patient question: serve the pack's HPI once (most unmatched
      // questions are HPI paraphrases), then varied "nothing new" lines — never
      // the same canned sentence twice in a row.
      const hp = pack && state && !state.hpiServed &&
        (pack.responders||[]).find(r=>r.intent==='history' && !r.gate &&
          ((r.match&&r.match.any)||[]).some(a=>/hpi|history of present|what happened|tell me more/.test(a)));
      if(hp && Array.isArray(hp.speech)){ state.hpiServed = true; fb.speech.push(...hp.speech); }
      else {
        // The old defaults were "It started like I told you…" and "Nothing new since we
        // talked…" — both of which require the patient to REMEMBER the conversation. A
        // playtester asked a dense-anterograde-amnesia patient a question and was told
        // "nothing has changed since we got here", which contradicts the entire diagnosis.
        // The same assumption breaks delirium, intoxication, post-ictal states, aphasia and
        // small children, so the defaults are now memory-neutral. A case whose patient
        // cannot answer in the ordinary way supplies its own lines via unansweredHistory.
        const authored = pack && Array.isArray(pack.unansweredHistory) && pack.unansweredHistory.length
          ? pack.unansweredHistory : null;
        const i = state ? (state.saidNoNew++) : 0;
        if(authored){
          const line = authored[i % authored.length];
          fb.speech.push(typeof line === 'string' ? {speaker:'patient', text:line} : line);
        } else {
          const lines = ['(shakes head) I don\'t know what else to tell you.',
                         'I\'m not sure. I don\'t think so.',
                         'Nothing else comes to mind.'];
          fb.speech.push({speaker:'patient', text: lines[i % lines.length]});
        }
      }
    }
  } else if(intent === 'med'){
    // Counseling ABOUT a drug, a status mention ("on epinephrine and norepi"),
    // or a negated mention ("nobody gives this man fentanyl") must never
    // administer it.
    if(DISCUSS_RE.test(clause)){
      fb.speech.push({speaker:'nurse', text:'Counseling done at the bedside — they heard you.'});
      fb._minutes = 3;
      return fb;
    }
    if(/^on\b/.test(clause) || /\b(already )?on board\b/.test(clause)){ fb._minutes = 1; return fb; }
    // A contingency stages here too — the matched path already does this, but
    // "if her pressure fails I'd start norepinephrine" matched no responder
    // and the fallback administered it.
    if(/^if\b/.test(clause) || /\b(i d|i would) (start|give|add|push|hang|reach for|consider)\b/.test(clause) || /\bthreshold for\b/.test(clause)){
      fb.speech.push({speaker:'nurse', text:'Got it — staged and standing by; that runs only if we cross the line you set.'});
      fb._minutes = 1;
      return fb;
    }
    const medHits = MED_WORDS.filter(w=>fuzzyHas(toks,w));
    const med = medHits.find(w=>w!=='bolus') || medHits[0] || 'the medication';
    {
      const mi = toks.findIndex(t => fuzzyHas([t], med));
      if(mi > 0){
        const before = toks.slice(Math.max(0, mi-4), mi);
        if(before.some(t => ['no','not','nobody','never','dont','avoid','without','cancel','stop'].includes(t))){
          fb.speech.push({speaker:'nurse', text:'Understood — that stays OFF the chart.'});
          fb._minutes = 1;
          return fb;
        }
      }
    }
    // A paralytic commits the patient to an airway. The generic med fallback announced
    // "Rocuronium is in." in the same breath as the consultant refusing the intubation,
    // leaving a paralysed patient nobody would then intubate — the direct causal chain to
    // a playtested child arresting. If this case gates its intubation and the gate is
    // unmet, the nurse draws it up and waits.
    if(PARALYTIC_RE.test(clause)){
      const intub = ((pack && pack.responders) || []).find(r => r.gate &&
        ((r.match && r.match.any) || []).some(a => /\b(intubat|rsi|rapid sequence)/i.test(a)));
      const flags = (state && state.flags) || {};
      if(intub && !((intub.gate.requires) || []).every(f => flags[f])){
        fb.speech.push({speaker:'nurse', text:'Paralytic is drawn up — I\'m not pushing it until we\'re set to intubate.'});
        return fb;
      }
    }
    // The doctor declined this drug. Confirm the hold; never announce it as given.
    if(withheld){
      fb.speech.push({speaker:'nurse', text:(med==='the medication'?'Understood — holding that.'
        : 'Understood — holding the '+med+'.')});
      return fb;
    }
    const medCap = med==='the medication' ? 'That' : med.charAt(0).toUpperCase()+med.slice(1);
    const verb = /s$/.test(med) && med!=='the medication' ? 'are' : 'is';
    const medLines = [`${medCap} ${verb} in.`, `${medCap} ${verb} in — pushed and flushed.`,
                      `Another dose of ${med==='the medication'?'that':med} ${verb} in.`, `${medCap} given.`];
    fb.speech.push({speaker:'nurse', text: medLines[((state && state.turnCount) || 0) % medLines.length]});
    const dosedHere = hasDoseEvidence(clause) || (lineFlags && lineFlags.dosed);
    if(dosedHere && state){ state.dosedOnce = state.dosedOnce || {}; state.dosedOnce['g:'+med] = true; }
    if(MEDS_REQUIRING_DOSE.some(m=>fuzzyHas(toks,m)) && !dosedHere
       && !(lineFlags && lineFlags.continuing)
       && !(state && state.dosedOnce && state.dosedOnce['g:'+med]))
      // Name the drug: an anonymous warning on a two-drug RSI line left the player
      // unable to tell which agent was unconfirmed.
      fb.dosingFlags.push((med==='the medication' ? 'Medication' : med.charAt(0).toUpperCase()+med.slice(1))
        + ' ordered without a dose/route — specify dose, route, and rate.');
    else if(FLUIDS_REQUIRING_VOLUME.some(m=>fuzzyHas(toks,m)) && !dosedHere
       && !hasVolumeEvidence(clause) && !hasVolumeEvidence(String(rawClause||''))
       && !(lineFlags && lineFlags.continuing)
       && !(state && state.dosedOnce && state.dosedOnce['fluid']))
      fb.dosingFlags.push(FLUID_VOLUME_FLAG);
    if(FLUIDS_REQUIRING_VOLUME.some(m=>fuzzyHas(toks,m)) && (dosedHere || hasVolumeEvidence(String(rawClause||''))) && state){
      state.dosedOnce = state.dosedOnce || {}; state.dosedOnce['fluid'] = true; }
  } else if(intent === 'procedure'){
    const procLines = ['Done — set up at the bedside and completed without complication.',
                       'Done at the bedside — no complications.',
                       'Set up and completed — went smoothly.'];
    fb.speech.push({speaker:'nurse', text: procLines[((state && state.turnCount) || 0) % procLines.length]});
  } else if(intent === 'consult'){
    // Longest match wins: "pediatric surgery" is not answered by "pediatrics".
    const svc = CONSULT_SERVICES.filter(s=>fuzzyHas(toks,s)).sort((a,b)=>b.length-a.length)[0] || 'the consultant';
    // First contact asks for the assessment; CALLBACKS rotate (a static line
    // collided with the dedupe and "call toxicology" returned pure filler).
    if(state) state.consulted = state.consulted || {};
    const again = state && state.consulted[svc];
    if(state) state.consulted[svc] = true;
    const callbackLines = [
      `${svc.charAt(0).toUpperCase()+svc.slice(1)} here again — go ahead, what's changed?`,
      `Back on the line — talk to me. What do you need?`,
      `Still here. Give me the update.`];
    fb.speech.push({speaker:'consultant', text: again
      ? callbackLines[((state && state.turnCount) || 0) % callbackLines.length]
      : `This is ${svc}. I've looked at the chart — what's your assessment, and what specifically do you need from me?`});
    // Remember that the consultant asked: the next narrative/assessment clause is
    // their answer, and it must be acknowledged (playtest: three consultants asked
    // for an assessment and then ignored the player's full SBAR reply).
    if(state) state.consultPending = {svc, t: state.turnCount || 0};
  } else if(intent === 'disposition'){
    fb._ends = 'good';
    fb.speech.push({speaker:'nurse', text:'Understood — I\'ll get the paperwork moving.'});
  } else if(intent === 'assessment' || intent === 'other'){
    const cp = state && state.consultPending;
    if(cp && ((state.turnCount || 0) - cp.t) <= 2){
      const lines = [
        `Good summary — agreed with your read. We're on board; call me if anything changes.`,
        `That helps. Reasonable plan — we'll see the patient and get back to you with recommendations.`,
        `Understood. I agree with your assessment — go ahead, and keep us in the loop.`];
      fb.speech.push({speaker:'consultant', text: lines[(state.turnCount || 0) % lines.length]});
      state.consultPending = null;
    } else if(intent === 'assessment'){
      // Echo the read back rather than brushing it off. The player's own words make
      // the line specific without the nurse knowing anything, so a wrong call is
      // answered with the same weight as a right one and the reply never grades it.
      const read = String(rawClause || '').replace(/^.*?\b(?:i think(?: this is)?|i suspect|i believe|my (?:working )?(?:diagnosis|assessment) is|working (?:diagnosis|dx)(?: is)?|this (?:is likely|looks like)|most likely|concern for|differential is)\b\s*/i, '').replace(/[.?!]+$/, '').trim();
      // A diagnosis is a proper clinical term, so it is echoed the way it would be
      // written on the board: "Understood, STEMI", not "Understood, stemi". Short forms
      // stay upper case; ordinary words get a leading capital.
      const shown = dxDisplay(read);
      const board = shown
        ? [`Got it — working diagnosis ${shown}. I'll put it up on the board.`,
           `Understood, ${shown}. It's on the board — what do you want to do about it?`,
           `${shown} — noted as your working diagnosis. What next?`]
        // Nothing after the frame: ask, and do NOT also claim something went up on the
        // board. The basket used to sign "I think this is" as its own clause, and the
        // debrief carried a working-diagnosis row reading exactly that.
        : ["What's the diagnosis, doctor?"];
      const boardLine = board[(state && state.turnCount || 0) % board.length];
      fb.speech.push({speaker:'nurse', text: boardLine});
      // The transcript renders `narrative`, not `speech` — an acknowledgement that
      // lives only in speech is audible but invisible, and the player sees generic
      // filler instead of being answered. Same words either way, so nothing leaks.
      fb.narrative = boardLine;
    } else {
      const de = deadEndReply(clause, state && state.turnCount);
      const line = de || notUnderstoodReply(rawClause || clause, state && state.turnCount);
      fb.speech.push({speaker:'nurse', text: line});
      // _narrative (not narrative) is what runTurn folds into the visible line — and it
      // pre-empts the default "Done — the team moves on it.", which would otherwise
      // stamp acceptance over the correction.
      if(!de){ fb._unparsed = true; fb._narrative = line; }
    }
  } else {
    const de = deadEndReply(clause, state && state.turnCount);
    const line = de || notUnderstoodReply(rawClause || clause, state && state.turnCount);
    fb.speech.push({speaker:'nurse', text: line});
    if(!de){ fb._unparsed = true; fb._narrative = line; }   // see the note at the twin site above
  }
  return fb;
}

// Rotating pools keyed by turn count — deterministic (testable), never the same
// stock phrase two turns running.
function defaultNarrative(out, n, action){
  const pick = arr => arr[(n||0) % arr.length];
  if(out.diagnosticReports.length){
    const t = out.diagnosticReports.map(d=>d.title).join(', ');
    return pick([t+' — on the chart.', t+' — up on the viewer.', t+' back — images are up.']);
  }
  if(out.labResults.length){
    // Re-prints of results already on the chart must not masquerade as news.
    if(out.labResults.every(l => l.repeat))
      return pick(['Repeat results are up — the chart row is refreshed.','Repeats are back on the chart.','Updated numbers are posted.']);
    return pick(['Results are back and on the chart.','Lab results just posted to the chart.','The lab called — results are up.']);
  }
  if(out.physicalExam.length) return out.physicalExam[0].finding;
  // A pure bedside conversation is not an executed order — "Done — the team
  // moves on it" prefixed a patient answering a history question. (A nurse
  // aside may ride along; what matters is that nothing clinical was executed.)
  if(out.speech.some(s => s.speaker === 'patient' || s.speaker === 'family') && !out.dosingFlags.length)
    return pick(['You take the history at the bedside.','The story comes out piece by piece.','You get your answers at the bedside.']);
  // A treatment that draws no comment reads as "the sim ignored me" — which is
  // exactly how a credited epinephrine dose felt in a real game. If we know the
  // order was a medication, say it is in and that the team is watching, so the
  // player sees the drug was given even when the pack has no scripted narrative.
  // A line carrying a rejection must never be echoed into a "<Drug> is in"
  // template: "kayexalate? no - lokelma 10g po" narrated "Kayexalate? no -
  // lokelma given". Fall through to the generic pool instead.
  if(action && /\b(no|not|hold|holding|scrap|cancel|never|stop)\b/i.test(String(action))) action = null;
  if(action){
    const drug = String(action)
      .replace(/[+&]/g, ' ')
      .replace(/^(give|administer|start|push|order|begin)\s+(a\s+|an\s+|the\s+)?/i, '')
      .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|units?|ml|l|mg\/kg|mcg\/kg\/min)\b.*$/i, '')
      .replace(/\b(iv|im|po|sublingual|intramuscular|intravenous|nebulized|drip|infusion|gtt|bolus)\b/gi, '')
      // stripping the dose can strand its preposition — "Midazolam at is on board"
      .replace(/\b(and|then)\b.*$/i, '')
      .replace(/\b(at|to|of|over|in|on|with|for)\s*$/i, '')
      .replace(/\s+/g, ' ').trim();
    if(drug && drug.length < 40 && classifyIntent(String(action)) === 'med'
       && MED_WORDS.some(w => drug.toLowerCase().includes(w))){
      const d = drug.charAt(0).toUpperCase() + drug.slice(1);
      return pick([d + ' is in — the team watches for a response.',
                   d + ' given; the nurse keeps eyes on the monitor.',
                   d + ' is on board — reassess in a few minutes.']);
    }
  }
  return pick(['The team carries out your orders.','Done — the team moves on it.','Carried out at the bedside.']);
}

// An "abstinence" critical action ("Avoid nitrates", "Do not delay surgery
// for imaging", "Never give methotrexate in the ruptured ectopic") is met by
// NOT doing the thing. A player who correctly withholds never types anything
// a responder could credit, so at case end an unsatisfied abstinence CA
// counts as MET by default — 74 such CAs across 66 cases were silently
// scoring as missed for players who did the right thing (playtest audit).
// A pack CAN still record an explicit violation by authoring the
// contraindicated-action responder with `satisfies` on a different index and
// its own worsening consequences — the score hit then comes from the vitals
// arc and stage penalties, which is how those packs already punish it.
const ABSTAIN_RE = /^(do not|don'?t|avoid|never|defer|withhold|minimi[sz]e|limit|hold off)\b/i;
// "In arrest, limit repeated defibrillation…" is an abstinence action wearing a
// conditional lead-in — strip the lead-in before classifying, or a player who
// correctly avoided the shocks scores a miss.
const stripCond = a => String(a).replace(/^(in|during|if|when|while|should)\b[^,;:]*[,;:]\s*/i, '');
// A clause where the doctor DECLINES to do something. Matching on content words alone
// read "holding vanc for now — no mucositis" as an order for vancomycin and credited the
// critical action, and read "no DRE" as a rectal exam and lectured the player for it.
// Crediting an action the player explicitly withheld is the same failure as denying
// credit for one they performed, just pointing the other way. (Found by playtest.)
// A prerequisite that names a FAILED or ATTEMPTED action encodes a sequence, not a
// quality of execution: you cannot bridge with a rescue device before an attempt has
// failed, and crediting it anyway teaches exactly the wrong order. Contrast "sedated" or
// "echoObtained", where the procedure genuinely happens and the prerequisite is best
// practice — those stay soft, so cardioverting an unstable patient without sedation still
// counts as cardioversion with the caution attached. Three flags in the corpus match:
// firstAttemptFailed, anteriorAttempted, nippvAttempted.
const SEQUENCE_FLAG_RE = /(failed|attempted)$/i;
// Asking for equipment is not performing the procedure. "cric kit open on the tray"
// matched the cricothyrotomy responder on the bare word "cric", and the soft gate then
// PERFORMED a surgical airway — in the very same turn the consultant said "we're not at
// a scalpel yet". A playtester had a scalpel put in a neck for asking for a tray.
// A blocked gate used to repeat one canned line however many prerequisites were
// outstanding, so a playtester who had done three of four re-read the identical refusal
// four times and concluded the gate was broken. Name what is still missing, using the
// pack's own vocabulary: whichever responder SETS each flag supplies its label.
function unmetGateHint(pack, requires, flags){
  const missing = (requires || []).filter(f => !flags[f]);
  if(!missing.length) return null;
  const names = missing.map(f => {
    const setter = ((pack && pack.responders) || []).find(r => r.setState && (f in r.setState));
    const alias = setter && ((setter.match && setter.match.any) || [])[0];
    return alias || String(f).replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  });
  return 'Still outstanding — ' + names.join('; ') + '.';
}
const PREP_RE = /\b(kit|tray|cart|ready|readied|prepare|prepared|prep|open|opened|set up|setup|standby|stand by|backup|back up|available|nearby|bedside|on hand|in case|if needed|just in case|to hand)\b/;
// "ok scrap the hemabate — miso 800 per rectum" replayed the drug's asthma warning and
// re-applied its vitals: a leading interjection hid the cancellation from the anchor.
const WITHHOLD_RE = /^\s*(?:(?:ok(?:ay)?|fine|alright|right|yeah|yes|actually|wait|no wait)[\s,-]+)*(no|not|hold(?!\s+on\b)|holding|hold off|holding off|withhold|withholding|avoid|avoiding|defer|deferring|skip|skipping|omit|omitting|scrap|scratch|cancel|stop(?:ping)?(?!\s+(?:the\s+)?(?:bleed|blood|hemorrhag|seiz|vomit))|don'?t|dont|do not|without|refrain from|no need for|not giving|never mind|forget)\b/i;
// A "recognition" critical action grades diagnostic reasoning ("Recognize
// septic shock", "Consider LGV if severe proctocolitis"). The pack credits it
// when the player SAYS it, which is the right primary path — committing to an
// assessment out loud is a real skill. But a player who ran the whole correct
// management pathway has demonstrably recognized the diagnosis, and marking
// that "missed" reads as a grading bug (141 such CAs across 110 cases).
// So: credit it from management too, but only when the player actually earned
// it — two-thirds of the case's OTHER actionable actions — and label it
// differently in the debrief so the "state your assessment" lesson survives.
const RECOGNIZE_RE = /^(recogni[sz]e|identify|consider|anticipate|suspect|maintain a high|systematically search|search for)\b/i;
const RECOGNIZE_FROM_MGMT = 2/3;

// Does a static "missed opportunity" line describe something the player was already
// credited for? The pack's wording never matches the checklist's ("Rapid sequence
// intubation while avoiding hypoxia" vs "Protect the airway with RSI for GCS <=8"),
// so compare the clinically meaningful words rather than the strings.
const MO_STOP = new Set(['with','while','and','the','for','from','a','an','of','to','in','on','or','as','at','by','avoid','avoiding','early','emergent','emergently','give','giving','obtain','perform','consider','patient','signs','therapy','their','his','her']);
// Pack wording and checklist wording almost never share vocabulary for the same act
// ("Rapid sequence intubation" vs "Protect the airway with RSI"), so collapse the
// common ED synonym groups to one token before comparing. Without this the two lines
// overlap on only "hypoxia"/"hypotension" and the contradiction survives.
const MO_CONCEPTS = [
  [/\b(rsi|intubat\w*|endotracheal|\bett\b|airway|extubat\w*)\b/g, ' xxairway '],
  [/\b(hyperosmolar|hypertonic|mannitol)\b/g, ' xxhyperosm '],
  [/\b(ct|cat)\s*(scan|head|imaging)?\b/g, ' xxct '],
  [/\b(mri|mra|mrv)\b/g, ' xxmri '],
  [/\b(ecg|ekg|electrocardiogram|telemetry|cardiac monitor\w*)\b/g, ' xxecg '],
  [/\b(cta|angiograph\w*|angio)\b/g, ' xxcta '],
  [/\b(neurosurg\w*|nsgy)\b/g, ' xxnsgy '],
  [/\b(anticoagulation|warfarin|reversal|reverse|\bpcc\b|kcentra)\b/g, ' xxreversal '],
  [/\b(seizure|antiepileptic|keppra|levetiracetam|prophylaxis)\b/g, ' xxseizure '],
  [/\b(c-?spine|cervical|spinal|spine)\b/g, ' xxspine '],
  // acyclovir is deliberately absent — an antiviral must not satisfy an "antibiotics" concept.
  [/\b(antibiotic\w*|ceftriaxone|vancomycin|piperacillin|zosyn|cefepime|meropenem|azithromycin|doxycycline|metronidazole|cefazolin|cephalexin|clindamycin|levofloxacin|ciprofloxacin|ampicillin|gentamicin|trimethoprim|nitrofurantoin|linezolid|daptomycin|aztreonam|nafcillin|penicillin)\b/g, ' xxabx '],
  [/\b(normocapnia|hyperventilat\w*|capnograph\w*|etco2)\b/g, ' xxco2 '],
];
function moTokens(s){
  let t = String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ');
  for(const [re, tok] of MO_CONCEPTS) t = t.replace(re, tok);
  return new Set(t.split(/\s+/).filter(w => w.length > 3 && !MO_STOP.has(w)));
}
// Gold diagnoses are long and parenthetical — "Acute rheumatic fever (Jones
// criteria: ...) following unrecognized, untreated group A streptococcal
// pharyngitis" — so compare against the HEAD: the name a clinician would say.
// "/" is a stop char too — normalize() itself splits "beta-blocker / calcium-
// channel blocker overdose" into two clauses ahead of the comma logic below it,
// so a head that kept the slash would name a diagnosis the engine never sees whole.
// The head is the noun phrase before any qualifier — unchanged, and still what the
// debrief titles itself with.
function diagnosisHead(dx){
  return String(dx || '').split(/[(,:/]| following | due to | from | with /i)[0].trim();
}
// The parts are the things the answer NAMES. Only a cause word introduces a second
// nameable condition ("...cardiac arrest FROM acute coronary occlusion"); a parenthesis
// or a comma introduces a qualifier, and splitting on those produced fragments like
// "RSV)" and "EF ~20%)" that are not diagnoses anybody would say. Each piece is then
// reduced to its own head, so the qualifiers fall away either way.
function diagnosisParts(dx){
  return String(dx || '').split(/ following | due to | from | secondary to | caused by /i)
    .map(p => diagnosisHead(p)).filter(Boolean);
}
// TERMS THAT NAME THE SAME THING.
//
// Kim called the witnessed VF arrest a STEMI — which is the answer the case itself
// teaches: its learning point says "a sudden VF arrest in a middle-aged adult is
// coronary occlusion until proven otherwise" and its critical action says "activate the
// cath lab for the occlusion". The grader marked it wrong, four times, because
// diagnosisHead truncates the gold answer at " from ": "Ventricular fibrillation
// cardiac arrest from acute coronary occlusion" was compared as "Ventricular
// fibrillation cardiac arrest", and the half she named had been thrown away.
//
// Two fixes, both here. diagnosisParts keeps every part of the answer, and a group
// below counts as matched when the player names ANY member and the gold answer names
// any member — which is also how "VF" finally counts on a ventricular-fibrillation
// case, since moTokens drops tokens of three characters or fewer.
//
// These expand ONLY while grading a working diagnosis. In the global abbreviation
// table they would make ordinary orders ambiguous and could steal a drug or a test.
const DX_EQUIV = [
  ['stemi','st elevation mi','st elevation myocardial infarction','st elevation myocardial infarct',
   'acute coronary occlusion','coronary occlusion','occlusion mi','omi','acute mi',
   'acute myocardial infarction','myocardial infarction','heart attack','mi'],
  ['vf','v fib','vfib','ventricular fibrillation'],
  ['pvt','pulseless vt','pulseless ventricular tachycardia'],
  ['vt','v tach','vtach','ventricular tachycardia'],
  ['pe','pulmonary embolism','pulmonary embolus','saddle embolus'],
  ['dka','diabetic ketoacidosis'],
  ['tbi','traumatic brain injury'],
  ['pph','postpartum hemorrhage','post partum hemorrhage'],
  ['svt','supraventricular tachycardia','avnrt'],
  ['af','afib','a fib','atrial fibrillation'],
  ['chb','complete heart block','third degree av block','third degree heart block'],
  ['sah','subarachnoid hemorrhage','subarachnoid haemorrhage'],
  ['ich','intracranial hemorrhage','intracerebral hemorrhage'],
];
// Padded and punctuation-stripped so a term matches as a WHOLE phrase: "mi" must not
// fire inside "mild", and "af" must not fire inside "after".
function dxPad(t){
  return ' ' + String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
function dxEquivMatch(text, parts){
  const said = dxPad(text);
  const golds = parts.map(dxPad);
  for(const group of DX_EQUIV){
    if(!group.some(term => said.includes(' ' + term + ' '))) continue;
    if(golds.some(g => group.some(term => g.includes(' ' + term + ' ')))) return true;
  }
  return false;
}
// Every DX_EQUIV term, for recognising a bare diagnosis with no frame in front of it.
const DX_EQUIV_TERMS = new Set(DX_EQUIV.flat());
// The condition names this library actually contains, handed in by the page as
// opts.dxCatalog exactly the way the order catalog already arrives. The engine is
// loaded standalone by every test with no file access, so it must work without one:
// with no catalog supplied, DX_EQUIV alone is the vocabulary.
let _dxVocab = new Set();
function setDxVocab(list){
  _dxVocab = new Set();
  for(const e of (Array.isArray(list) ? list : [])){
    for(const term of [e && e.label, ...((e && e.aliases) || [])]){
      const t = dxPad(term).trim();
      if(t) _dxVocab.add(t);
    }
  }
}
// A bare condition name IS a diagnosis. Kim typed "stemi", then "acute STEMI", then
// "ST elevation MI", and all three were filed under ORDERS THE SIM DID NOT UNDERSTAND
// because classifyIntent required one of the ASSESS_WORDS somewhere in the clause. A
// player naming a disease is committing to it; the framing was never the point.
// Leading qualifiers a clinician says out loud and never means as a separate word.
// Kim typed "acute STEMI" as her second attempt; without this it is not the name of a
// condition, it is two words that happen to contain one.
// Short forms are said as letters and belong in capitals; everything else takes a
// leading capital. Kim saw "Understood, pea." on an earlier case and called it sloppy —
// it is the same echo.
const DX_UPPER = new Set(['stemi','nstemi','vf','vt','pvt','pea','svt','af','afib','dka','tbi','pph',
  'chb','sah','ich','pe','mi','omi','copd','chf','ards','aki','gi','ivh','nstemi','tia','cva','uti','dvt']);
function dxDisplay(text){
  const t = String(text || '').trim();
  if(!t) return '';
  return t.split(/\s+/).map(w => DX_UPPER.has(w.toLowerCase().replace(/[^a-z]/g,''))
    ? w.toUpperCase() : w).join(' ')
    .replace(/^([a-z])/, m => m.toUpperCase());
}
const DX_QUALIFIER_RE = /^(?:an?\s+|the\s+|acute\s+|chronic\s+|severe\s+|new\s+|old\s+|likely\s+|probable\s+|possible\s+|suspected\s+|presumed\s+|anterior\s+|inferior\s+|lateral\s+|posterior\s+|massive\s+|submassive\s+)+/;
function isBareDiagnosis(clause){
  const t = dxPad(clause).trim();
  if(!t) return false;
  if(DX_EQUIV_TERMS.has(t) || _dxVocab.has(t)) return true;
  const bare = t.replace(DX_QUALIFIER_RE, '').trim();
  return !!bare && bare !== t && (DX_EQUIV_TERMS.has(bare) || _dxVocab.has(bare));
}
// Diagnosis shorthand is deliberately expanded ONLY while comparing a working
// diagnosis to this case's ground truth. Putting these in the global ABBREV table
// would make ordinary orders ambiguous ("PE", "VT", "ARF") and could steal a
// medication, procedure, or test. Each short form is therefore enabled only when
// the case diagnosis itself establishes that meaning.
const DX_SHORT_FORMS = [
  {when:/\bdiabetic ketoacidosis\b/, short:/\bdka\b/, expands:'diabetic ketoacidosis'},
  {when:/\bsubarachnoid hemorrhage\b/, short:/\bsah\b/, expands:'subarachnoid hemorrhage'},
  {when:/\btricyclic antidepressant\b/, short:/\btca\b/, expands:'tricyclic antidepressant overdose'},
  {when:/\batrial fibrillation\b/, short:/\b(?:af|a fib|afib)\s*(?:with )?rvr\b/, expands:'atrial fibrillation rapid ventricular response'},
  {when:/\bintracerebral hemorrhage\b/, short:/\bich\b/, expands:'intracerebral hemorrhage'},
  {when:/\btransient ischemic attack\b/, short:/\btia\b/, expands:'transient ischemic attack'},
  {when:/\btraumatic brain injury\b/, short:/\btbi\b/, expands:'traumatic brain injury'},
  {when:/\bpneumocystis jirovecii pneumonia\b/, short:/\bpjp\b/, expands:'pneumocystis jirovecii pneumonia'},
  {when:/\bacute rheumatic fever\b/, short:/\barf\b/, expands:'acute rheumatic fever'},
  {when:/\bpulmonary embolism\b/, short:/\bpe\b/, expands:'pulmonary embolism'},
  {when:/\babdominal aortic aneurysm\b/, short:/\baaa\b/, expands:'abdominal aortic aneurysm'},
  {when:/\bventricular tachycardia\b/, short:/\bvt\b/, expands:'ventricular tachycardia'},
  {when:/\bst[- ]elevation mi\b|\bst[- ]elevation myocardial infarction\b/, short:/\bstemi\b/, expands:'st elevation myocardial infarction'},
  {when:/\bsympathetic crashing acute pulmonary edema\b/, short:/\bscape\b/, expands:'sympathetic crashing acute pulmonary edema'},
  {when:/\bpneumothorax\b/, short:/\bptx\b/, expands:'pneumothorax'},
  {when:/\bspinal epidural abscess\b/, short:/\bsea\b/, expands:'spinal epidural abscess'},
  {when:/\bcannabinoid hyperemesis syndrome\b/, short:/\bchs\b/, expands:'cannabinoid hyperemesis syndrome'},
  {when:/\bcerebral venous sinus thrombosis\b/, short:/\bcvst\b/, expands:'cerebral venous sinus thrombosis'},
  {when:/\bdelirium tremens\b/, short:/\bdts?\b/, expands:'delirium tremens'},
  {when:/\bthrombotic thrombocytopenic purpura\b/, short:/\bttp\b/, expands:'thrombotic thrombocytopenic purpura'},
  {when:/\bnecrotizing (?:soft tissue infection|fasciitis)\b/, short:/\bnec fasc\b/, expands:'necrotizing soft tissue infection'},
  {when:/\bpost[- ]streptococcal glomerulonephritis\b/, short:/\bpsgn\b/, expands:'post streptococcal glomerulonephritis'}
];
function diagnosisTokens(text, dx){
  let expanded = String(text || '').toLowerCase();
  const head = diagnosisHead(dx).toLowerCase();
  for(const f of DX_SHORT_FORMS) if(f.when.test(head) && f.short.test(expanded)) expanded += ' ' + f.expands;
  return moTokens(expanded);
}
// Correct when at least two thirds of the head's significant tokens appear in what
// the player typed. "Acute rheumatic fever" is three tokens, so "rheumatic fever"
// passes and "fever" alone does not. Deliberately approximate: an authored alias
// exists for packs that need a looser or tighter read.
function matchesDiagnosis(text, dx){
  const parts = diagnosisParts(dx);
  // Naming the same thing by another name is naming it. This is the clause that lets
  // "STEMI" answer "…from acute coronary occlusion", and "VF" answer a ventricular
  // fibrillation arrest.
  if(dxEquivMatch(text, parts)) return true;
  const got = diagnosisTokens(text, dx);
  // Every part of the answer counts, not only the head. A gold diagnosis that names a
  // condition AND its cause is asking for either; grading the head alone threw away the
  // half the case's own learning points are about.
  for(const part of parts){
    const want = moTokens(part);
    if(!want.size) continue;
    // The identity of a diagnosis sits in the tail of its noun phrase; everything
    // before it is qualifier a clinician drops out loud ("Acute Stanford type A
    // aortic dissection" is said as "aortic dissection"). So the tail alone counts,
    // alongside the two-thirds rule that catches partial and reordered phrasings.
    const tail = [...want].slice(-2);
    if(tail.length && tail.every(w => got.has(w))) return true;
    let hit = 0; for(const w of want) if(got.has(w)) hit++;
    if(hit / want.size >= 2/3) return true;
  }
  return false;
}
function coveredByMet(opportunity, metTexts){
  const o = moTokens(opportunity);
  // Short lines carry too few significant tokens for a ratio to mean anything, so
  // fall back to plain containment — identical wording must always be filtered.
  const flat = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const of = flat(opportunity);
  if(of) for(const m of metTexts){ const mf = flat(m);
    if(mf && (mf === of || mf.includes(of) || of.includes(mf))) return true; }
  // A short line like "MRI of the spine" reduces to one or two meaningful tokens.
  // Requiring two would let it through uncovered — which is exactly how a credited
  // MRI kept reappearing as a missed opportunity. If the line carries a clinical
  // concept token (xx*), a single shared concept is enough.
  const concepts = [...o].filter(w => w.startsWith('xx'));
  if(concepts.length){
    for(const m of metTexts){ const t = moTokens(m);
      if(concepts.some(c => t.has(c))) return true; }
  }
  if(o.size < 2) return false;
  for(const m of metTexts){
    const t = moTokens(m);
    let hit = 0; for(const w of o) if(t.has(w)) hit++;
    if(hit / o.size >= 0.5) return true;          // half its substance already credited
  }
  return false;
}
// The authored failure narrative asserts specifics — it names what was left undone
// ("...without anti-inflammatory therapy, penicillin, or cardiology involvement").
// Printed for a player who DID those things it denies credit the checklist grants two
// lines below, and reads as a grading error: a real rheumatic-fever run gave penicillin
// and consulted cardiology, was credited for both, and was told neither happened.
// A token shared with a MISSED action is ambiguous (the sentence may be describing that
// omission), so only vocabulary unique to the credited side counts as a false claim.
// Only DENIALS can contradict the checklist. "Antibiotics were given, or the HUS was
// under-supported" shares "HUS" with a credited recognition action while asserting
// nothing about it, and suppressing on bare vocabulary overlap threw away the authored
// narrative for 89% of the corpus. So scope the comparison to the span a denial governs:
// from the first denial marker to the end of its sentence, which is what carries
// "...progressed without anti-inflammatory therapy, penicillin, or cardiology involvement".
const DENIAL_RE = /\b(without|never|no|not|nor|failed|fail|missed|missing|absent|lack\w*|unrecogni[sz]ed|untreated|unaddressed|undiagnosed|unidentified|delay\w*|neglect\w*|omitted)\b/i;
function denialSpans(text){
  const out = [];
  for(const sentence of String(text).split(/(?<=[.;!?])\s+/)){
    const m = DENIAL_RE.exec(sentence);
    if(m) out.push(sentence.slice(m.index));
  }
  return out;
}
function deniesCredited(text, metTexts, missedTexts){
  const spans = denialSpans(text);
  if(!spans.length) return false;
  const t = new Set();
  for(const s of spans) for(const w of moTokens(s)) t.add(w);
  if(!t.size) return false;
  const missed = new Set();
  for(const m of missedTexts) for(const w of moTokens(m)) missed.add(w);
  for(const m of metTexts)
    for(const w of moTokens(m)) if(t.has(w) && !missed.has(w)) return true;
  return false;
}
// A stage's unlessMet lists the actions that prevent it, and requiring ALL of them is
// right when they are COMPLEMENTARY: the failed-airway case cannot avert recurrent
// desaturation without both assessing the airway and positioning the patient.
//
// But guards are sometimes ALTERNATIVES. That case's fatal stage is guarded by "bridge
// with a supraglottic airway" AND "escalate to a surgical airway" — either of which
// secures the airway — so a player who correctly went straight to the cric still arrested
// at sixty minutes, having done exactly the right thing.
//
// The pack already tells the two apart without new authoring: alternative routes set the
// SAME state flag, because that flag is the shared outcome they both produce (both the SGA
// and the cric set airwaySecured). Complementary actions set different flags and share
// none. So a stage is also averted when every flag common to all its guard actions is now
// true, by whatever route the player took to get there.
// Every pack authors `graceMinutes` — "sim-minutes of dithering before nurse pressure"
// in the Instant Mode spec — and for a year nothing read it: stages fired on their bare
// afterMin, so a case written as "20 minutes of grace, pressure at 20" pressured at 20.
// A player entering ten correct orders one at a time (18 sim-minutes for a lab panel,
// 10 for a procedure) ran out of clock before they ran out of knowledge. The grace is
// now added to every deadline in the case, in the ONE place both the runtime and the
// debrief read stages from — a debrief must never cite a deadline the player was not
// actually held to. Packs are untouched; 140 of 155 declare a grace, the rest take 15.
const DEFAULT_GRACE = 15;
function effectiveStages(pack){
  const d = (pack && pack.deterioration) || {};
  const g = Number.isFinite(d.graceMinutes) ? d.graceMinutes : DEFAULT_GRACE;
  return (d.stages || []).map(st => ({...st, afterMin: (st.afterMin || 0) + g}));
}
function stageAverted(pack, st, state){
  const guards = st.unlessMet || [];
  if(!guards.length) return false;
  if(guards.every(ix => state.satisfied.includes(ix))) return true;
  const flagSets = guards.map(ix => {
    const set = new Set();
    for(const r of (pack && pack.responders) || [])
      if(r.satisfies === ix && r.setState)
        for(const f of Object.keys(r.setState)) if(r.setState[f]) set.add(f);
    return set;
  });
  if(flagSets.some(fs => fs.size === 0)) return false;      // no shared outcome to reason about
  const shared = [...flagSets[0]].filter(f => flagSets.every(fs => fs.has(f)));
  return shared.length > 0 && shared.every(f => state.flags[f]);
}
// The player-facing countdown: the next un-fired, un-averted deterioration
// deadline in EFFECTIVE minutes (afterMin + grace — the deadline the engine
// actually holds the player to; raw afterMin already caused one debrief bug
// class). Returns {index, afterMin} or null. Time only, never stage content:
// the event text would spoil the hidden diagnosis.
function nextStageDeadline(pack, state){
  if(!pack || !pack.deterioration) return null;
  const s = state || {};
  // stageAverted reads state.satisfied and state.flags straight; a half-built
  // state from the UI must yield "no landmark averted", not a crash.
  const guardState = { satisfied: s.satisfied || [], flags: s.flags || {} };
  const stages = effectiveStages(pack);
  for(let i = 0; i < stages.length; i++){
    if((s.stagesFired || []).includes(i)) continue;
    if(stageAverted(pack, stages[i], guardState)) continue;
    return { index: i, afterMin: stages[i].afterMin };
  }
  return null;
}
// A code case's summary must say what happened in the code. "The patient stayed
// stable and was dispositioned" for a man who arrested and got ROSC at T+25 reads as
// if the arrest never happened — the single most important fact of the case.
function codeSummaryPrefix(pack, opts){
  const code = opts && opts.code; if(!code || !Array.isArray(code.events)) return '';
  const sc = (pack && pack.codeScript) || {};
  const start = (sc.start && sc.start.rhythm) || '';
  const label = { VF:'ventricular fibrillation', pVT:'pulseless VT', torsades:'torsades', PEA:'PEA',
    asystole:'asystole', CHB:'complete heart block', AF:'atrial fibrillation', SVT:'SVT',
    'sinus-brady':'bradycardia', 'sinus-tachy':'a tachycardia', sinus:'sinus rhythm' }[start] || start;
  const fmtS = x => { const n = Math.round(x || 0); return Math.floor(n/60) + ':' + String(n%60).padStart(2,'0'); };
  const shocks = code.events.filter(e => e.kind === 'shock').length;
  const syncs = code.events.filter(e => e.kind === 'cardiovert').length;
  const epi = code.events.filter(e => e.kind === 'drug' && e.name === 'epinephrine').length;
  const rosc = code.events.find(e => e.kind === 'rosc');
  const died = code.events.find(e => e.kind === 'death');
  const arrested = sc.start && sc.start.pulse === false;
  const parts = [];
  if(arrested){
    parts.push('Arrived in ' + label + '.');
    if(rosc) parts.push('Return of circulation at ' + fmtS(rosc.t) + ' after ' + shocks + ' shock' + (shocks === 1 ? '' : 's')
      + (epi ? ' and ' + epi + ' dose' + (epi === 1 ? '' : 's') + ' of epinephrine' : '') + '.');
    else if(died) parts.push('Never regained a pulse; the code was called at ' + fmtS(died.t) + '.');
    else parts.push('The code was still running at the end of the case.');
  } else if(start){
    const conv = code.events.find(e => e.kind === 'convert' || e.kind === 'rosc');
    parts.push('Presented in ' + label + (conv ? ', converted at ' + fmtS(conv.t) + (syncs ? ' by synchronized cardioversion' : '') + '.' : '.'));
    if(died) parts.push('Deteriorated and died at ' + fmtS(died.t) + '.');
  }
  return parts.length ? parts.join(' ') + ' ' : '';
}
function buildDebrief(pack, state, opts, outcome){
  const CA = opts.criticalActions || [];
  const total = CA.length || 1;
  const met = state.satisfied.slice().sort((a,b)=>a-b);
  // "Actionable" = the CAs you prove by DOING something (not recognition, not
  // abstinence). The share of those you performed is the evidence that you
  // both recognized the diagnosis and acted on it in time.
  const actionableIdx = CA.map((a,i)=>(!RECOGNIZE_RE.test(stripCond(a)) && !ABSTAIN_RE.test(stripCond(a))) ? i : null).filter(x=>x!==null);
  const actionableMet = actionableIdx.filter(i=>met.includes(i)).length;
  const provedByMgmt = actionableIdx.length >= 2 &&
                       (actionableMet / actionableIdx.length) >= RECOGNIZE_FROM_MGMT;
  // Two kinds of abstinence read very differently. Pure avoidance ("Avoid
  // nitrates", "Never give methotrexate") is satisfied by simply not doing it.
  // But a TIMELINESS phrasing ("Do not DELAY surgery", "Do not DEFER
  // debridement while awaiting imaging") presupposes you actually did the
  // thing promptly — a player who never did it at all did, in fact, delay it.
  // So the timeliness family needs the same management evidence.
  const abstained = CA.map((a,i)=>{
    if(met.includes(i) || !ABSTAIN_RE.test(stripCond(a))) return null;
    const timeliness = /\b(delay|defer|await|awaiting|wait)\w*\b/i.test(a);
    return (!timeliness || provedByMgmt) ? i : null;
  }).filter(x=>x!==null);
  const recognized = provedByMgmt
    ? CA.map((a,i)=>(!met.includes(i) && RECOGNIZE_RE.test(stripCond(a))) ? i : null).filter(x=>x!==null)
    : [];
  const metAll = met.concat(abstained, recognized).sort((a,b)=>a-b);
  // Why each credited item was credited. `responder` means an order actually reached a
  // responder that satisfies it; `provedByMgmt` means it was inferred from overall
  // management; `abstained` means the player correctly did not do the harmful thing.
  // An item credited only by inference marks a pack with thin responder coverage.
  const creditBasis = {};
  met.forEach(i => { creditBasis[i] = 'responder'; });
  abstained.forEach(i => { creditBasis[i] = 'abstained'; });
  recognized.forEach(i => { creditBasis[i] = 'provedByMgmt'; });
  const metS = metAll.map(i=>CA[i]).filter(Boolean);
  const missedS = CA.filter((a,i)=>!metAll.includes(i));
  // A code case is not graded on deterioration stages — it is graded on how the code was
  // RUN. The fifteen points the stages occupy become code quality, weighted the way a
  // resuscitation debrief weights it: shock early, keep hands on the chest, epi on the
  // clock, check the rhythm every two minutes, get the doses right, fix the cause.
  const CODE_WEIGHTS = { timeToFirstShock:3, cprFraction:3, epiInterval:3,
                         rhythmChecks:2, doseAccuracy:2, reversibleCause:2 };
  const codeMetrics = (opts.code && opts.code.metrics) || null;
  let codeQuality = null;
  if(codeMetrics){
    const present = codeMetrics.filter(m => CODE_WEIGHTS[m.name] != null);
    const max = present.reduce((a, m) => a + CODE_WEIGHTS[m.name], 0) || 1;
    const got = present.reduce((a, m) => a + (m.ok ? CODE_WEIGHTS[m.name] : 0), 0);
    codeQuality = { points: Math.round(got / max * 15),
      rows: present.map(m => ({ name:m.name, ok:!!m.ok, detail:m.detail || '', teach:m.teach || '' })) };
  }
  let score = Math.round(60*metS.length/total)
            + (codeQuality ? codeQuality.points : Math.max(0, 15 - 5*state.stagesFired.length))
            + Math.max(0, 15 - 5*state.dosing)
            + (outcome==='good' ? 10 : 0);
  if(outcome==='death') score = Math.min(score, 35);
  score = Math.max(0, Math.min(100, score));
  const dbf = (pack && pack.debrief) || {};
  const stages = effectiveStages(pack);   // afterMin already includes the case's grace
  // Packs author exactly two narratives — an ideal course and a failure course — and the
  // engine used to pick between them on how the case ENDED, nothing else. So any player
  // who dispositioned the patient got the ideal story: onc-febrile-neutropenia praised
  // "cefepime running well within the hour" when no antibiotic was ever given, and a
  // patient who crashed could still be described as walking out smiling.
  //
  // Neither string is safe as a fallback for the other, because both assert specifics:
  // printing outcomePoor for a stable patient would invent a deterioration that never
  // happened. So there are three states, and the middle one — patient fine, care
  // incomplete — is stated from the tally rather than borrowed from a narrative.
  const deteriorated = state.stagesFired.length > 0;
  // Stated from the tally rather than borrowed from a narrative. Deterioration-aware:
  // the old wording asserted "stable condition" outright, so a run where a stage fired
  // but most of the checklist was met still described the patient as stable.
  const tallyOutcome = () => 'Dispositioned '
    + (deteriorated ? 'after deteriorating during the case' : 'in stable condition') + ', with '
    + (gaps ? gaps + ' critical action' + (gaps===1?'':'s') + ' unaddressed' : 'every critical action addressed') + '.';
  const tallySummary = () => (deteriorated
      ? 'The patient deteriorated during the case'
      : 'The patient stayed stable and was dispositioned')
    + (gaps ? `, and ${gaps} of ${total} critical action${gaps===1?' was':'s were'} not completed — see the checklist below.` : '.');
  const gaps = missedS.length;
  let outcomeText, summaryText;
  if(outcome === 'death'){
    outcomeText = 'The patient died in the ED.';
    summaryText = dbf.badOutcome || 'Case complete.';
  // A deterioration stage firing is not the same as a badly-run case: stages fire on a
  // clock, so a player who was briefly behind and then did everything right still trips
  // one. Two playtesters met EVERY critical action, scored 80-90, and were told their
  // resuscitation lagged and the patient deteriorated into shock. The failure narrative
  // needs real gaps behind it, not just a timer.
  // outcomePoor asserts specifics ("the encounter ended without debridement") — it
  // needs a genuinely deficient run behind it, not a timer plus a nitpick. A player
  // who deteriorated once but met most of the actionable checklist gets the honest
  // tally instead (playtest: 5/7 met, patient rolling to the OR, and the debrief
  // said surgery never happened).
  } else if(outcome !== 'good' ||
            (deteriorated && gaps && actionableIdx.length > 0 &&
             (actionableMet / actionableIdx.length) <= 0.5)){
    // ...and the authored failure text only earns its place when it does not deny
    // something this run was credited for. When it does, state the tally instead.
    // Abstention credit is passive — "Avoid thrombolytics" scores for a player who did
    // nothing at all — so only actions actively performed can contradict a denial.
    const activeMetS = metAll.filter(i => !abstained.includes(i)).map(i => CA[i]).filter(Boolean);
    if(dbf.outcomePoor && !deniesCredited(dbf.outcomePoor, activeMetS, missedS)){
      outcomeText = dbf.outcomePoor;
      summaryText = dbf.badOutcome || 'Case complete.';
    } else {
      outcomeText = tallyOutcome();
      summaryText = tallySummary();
    }
  } else if(gaps){
    outcomeText = tallyOutcome();
    summaryText = tallySummary();
  } else {
    outcomeText = dbf.outcomeGood || 'Stabilized and dispositioned appropriately.';
    summaryText = dbf.goodOutcome || 'Case complete.';
  }
  // A stage fires on a CLOCK, so a player who was behind at the deadline and then did
  // exactly the right thing still trips one — and its authored feedback then sits
  // directly beside the same action checked off above it. Reported from real play: a
  // ruptured ectopic transfused at T+49, five minutes after the 40-minute stage, was
  // credited for blood products AND told blood products were the missing piece. When
  // every action guarding a stage was eventually credited, the deterioration is still
  // reported — it happened, and it still costs the score — but as a timing note rather
  // than an uncorrected failure. Nothing is softened when the guard was never met.
  const stageEvent = i => {
    const sg = stages[i] || {};
    const event = sg.event || 'The patient deteriorated';
    const guards = sg.unlessMet || [];
    if(!guards.length || !guards.every(ix => metAll.includes(ix)))
      return { event, feedback: sg.feedback || 'This was preventable with timely intervention.',
               type: 'negative' };
    const names = guards.map(ix => CA[ix]).filter(Boolean).join('; ');
    return { event,
      feedback: 'Corrected later in the case' + (names ? ': ' + names : '') + '. It came after the '
        + (sg.afterMin != null ? sg.afterMin + '-minute mark' : 'deadline')
        + ', so the patient deteriorated first — the lesson here is timing, not omission.',
      type: 'neutral' };
  };
  const fmtSec = x => { const n = Math.round(x || 0); return Math.floor(n/60) + ':' + String(n%60).padStart(2,'0'); };
  return {
    outcome: outcomeText,
    score,
    codeQuality: codeQuality || undefined,
    // The code, minute by minute. A resuscitation debrief without a timeline asks the
    // player to remember what they did under pressure, which is exactly what they cannot do.
    codeTimeline: (opts.code && opts.code.events)
      ? opts.code.events.filter(e => e && e.text).map(e => ({ at: fmtSec(e.t), kind: e.kind, text: e.text }))
      : undefined,
    creditBasis,
    summary: codeSummaryPrefix(pack, opts) + summaryText,
    criticalActionsMet: metS,
    criticalActionsMissed: missedS,
    // The reasoning arc, and the only place correctness is ever revealed.
    workingDiagnosis: (state.assessments || []).map(a => ({ text: a.text, minute: a.minute, correct: !!a.correct })),
    dxNotes: (state.dxHeld || []).slice(),
    dxCalled: (state.assessments || []).length
      ? ((state.assessments || []).some(a => a.correct) ? 'correct' : 'wrong')
      : null,
    dxFirstCorrect: !!((state.assessments || [])[0] || {}).correct,
    criticalEvents: metAll.map(i=>({event:CA[i],
        feedback: abstained.includes(i) ? 'Correctly avoided — the harmful action was never taken.'
                : recognized.includes(i) ? 'Credited from your management — your workup and treatment fit this diagnosis. Still say your working assessment out loud: committing to it is what aligns the team and it is scored explicitly on the boards.'
                : 'Performed during the case.', type:'positive'}))
      .concat(state.stagesFired.map(stageEvent)),
    // A pack's missedOpportunities are STATIC teaching text written before anyone
    // played it. Printed unfiltered they contradict the checklist above — a player
    // credited for "Protect the airway with RSI" was still told, on the same page,
    // that RSI was a missed opportunity. Drop any line the player actually did.
    // Prefer the mapping resolved offline (tools_tag_missed_opportunities.cjs):
    // each line carries the index of the critical action it restates, so a
    // credited action drops its line by exact lookup instead of word matching.
    // Lines tagged null belong to no checklist item and are always shown. Packs
    // without the mapping fall back to the text matcher.
    // Honesty about the sim's own blind spots: orders that fell to filler earned
    // nothing, and a player wondering whether they were robbed can now see the
    // list instead of guessing. (Capped at 8, deduplicated, verbatim clauses.)
    unrecognizedOrders: (state.unparsed || []).slice(),
    unrecognizedOrdersDropped: state.unparsedDropped || 0,
    missedOpportunities: (function(){
      const list = dbf.missedOpportunities || [];
      const tags = dbf.missedOpportunityFor;
      const metSet = new Set(metAll);
      if(Array.isArray(tags) && tags.length === list.length){
        // A tag is an index, an ARRAY of indices for a line that restates more
        // than one action, or null for a line that belongs to no checklist item.
        // A multi-action line is dropped as soon as ANY of its actions was
        // credited, because it overclaims: "Starting IV fluids, keeping the
        // patient NPO, and giving antibiotics" printed next to a ticked "Provide
        // analgesia, IV fluids, and keep the patient NPO" tells the player they
        // failed something the same page says they did. The still-missed part is
        // never lost — it is already listed verbatim under CRITICAL ACTIONS
        // MISSED, which is the authoritative list; this section is the softer
        // prose beneath it, and under-reporting there beats contradicting.
        return list.filter((m,i)=>{
          const t = tags[i];
          if(t == null) return !coveredByMet(m, metAll.map(j=>CA[j]));
          const idxs = Array.isArray(t) ? t : [t];
          return !idxs.some(j => metSet.has(j));
        }).slice(0,4);
      }
      return list.filter(m=>!coveredByMet(m, metAll.map(i=>CA[i]))).slice(0,4);
    })(),
    learningPoints: dbf.learningPoints || opts.learningPoints || []
  };
}

// ---------- The turn ----------
// state (MUTATED): {flags:{}, satisfied:[int], stagesFired:[int], dosing:int}
// opts: {vitals, simMin, criticalActions, learningPoints, difficulty, trend}
// Clause splitting strands connective fragments: "start N-acetylcysteine and drip"
// leaves "drip" as its own clause, which then reports as an order the sim did not
// understand. Listing those alongside a real miss like "lactulose" teaches the
// player to ignore the list, so they never enter it.
// THE definition of a stray fragment — the one every surface must use.
// Clause splitting strands connectives ("vancomycin and drip" -> "drip"), and reporting
// those as orders the sim did not understand is noise that teaches the player to ignore
// the list. This lived in three places: here, and twice more in the app with seven words
// missing (gtt, too, sq, one, two, both, plus, with), so the same clause could be called
// unrecognised in the timeline and be absent from the debrief. Exported, so there is one.
const ORDER_FRAGMENT = /^(drip|gtt|and|then|also|too|stat|now|please|iv|po|im|sq|it|that|this|one|two|both|plus|with)$/i;
function isOrderFragment(text){ return ORDER_FRAGMENT.test(String(text == null ? '' : text).trim()); }

function runTurn(pack, state, action, opts){
  // Defensive init for fields added after the original state shape shipped.
  state.labsSeen = state.labsSeen || {};
  state.reportsSeen = state.reportsSeen || {};
  state.turnCount = (state.turnCount || 0) + 1;
  state.saidNoNew = state.saidNoNew || 0;
  state.spokenSeen = state.spokenSeen || {};   // authored lines already delivered — never replay verbatim
  state.narrSeen = state.narrSeen || {};       // authored narratives already delivered
  state.medCount = state.medCount || 0;        // treatments applied — drives repeat-lab direction
  state.dosedOnce = state.dosedOnce || {};     // a dose, once given, stays given
  state.assessments = state.assessments || [];   // every working diagnosis committed, in order
  state.dxHeld = state.dxHeld || [];      // authored replies withheld in play, delivered in the debrief
  const out = {narrative:'', speech:[], simMinutes:0,
               updatedVitals:{...opts.vitals}, vitalTrend:'stable',
               labResults:[], diagnosticReports:[], physicalExam:[], dosingFlags:[],
               clinicalRationale:'instant engine — deterministic turn', isCaseOver:false, debrief:{}};
  let minutes = 2, trend = null, targets = {}, endedBy = null, wantRoutine = false;
  let reevalNarr = '';   // bedside re-eval answer, held for the transcript (see below)
  // Opt-in decision trace. Off by default and inert: every field below is written
  // from inside the branch that makes the decision, never recomputed alongside it,
  // so the trace cannot drift from what the matcher actually did.
  // Gate hints are deferred to the end of the turn: emitted inline they listed
  // prerequisites that a LATER clause in the same line went on to satisfy.
  const pendingGates = [];
  let firedThisTurn = false;
  const trace = opts.trace ? {raw:String(action), norm:'', clauses:[], satisfiedAfter:[], stagesFired:[]} : null;
  // Split on the player's OWN normalized wording and match pack responders on
  // it FIRST. Pack aliases are case-specific and authored richer than the
  // global catalog ("fluid bolus", "bedside echo", "epinephrine drip"), so
  // canonicalizing the whole line BEFORE matching silently moved orders away
  // from the very responder that credits their critical action (measured:
  // firing a satisfier's own alias failed to credit 1.2% of the time on raw
  // text, 5.9% after catalog canonicalization). The catalog rewrite is now a
  // per-clause FALLBACK, applied only when the pack doesn't recognize the raw
  // clause — exactly where slang ("banana bag", "rocephin") needs it to land
  // on a canonical the pack knows.
  let rawNorm = normalize(action);
  // Dynamic AND-protection: if the typed text contains a phrase that IS a
  // whole-concept alias of THIS pack ("pre and post ductal saturation",
  // "ceftriaxone and metronidazole", "pads and monitor"…), keep it as ONE
  // clause instead of splitting at its "and". Pack-driven, so it scales to
  // every authored alias without a hand-maintained list (a scan found 170
  // distinct " and "-containing aliases across the packs) and can never
  // false-positive: it only protects text the pack explicitly knows whole.
  if(pack && Array.isArray(pack.responders)){
    for(const r of pack.responders) for(const a of ((r.match&&r.match.any)||[])){
      if(!/ and /.test(a)) continue;
      const na = normalize(a);
      if(na && rawNorm.includes(na)) rawNorm = rawNorm.split(na).join(na.replace(/ and /g,' & '));
    }
  }
  if(trace) trace.norm = rawNorm;
  // Decided on the WHOLE typed action, before clause splitting. "update daughter — she
  // needs the OR and ICU" splits at "and", stranding "icu" as its own clause with no verb
  // left to explain it, and the case closes on a family conversation. Judging the opening
  // verb of the full line keeps that context. Communication that IS the disposition
  // ("call for admission", "call the cath lab") is excluded.
  const discussingAction = DISCUSS_RE.test(rawNorm) && !DISCUSS_IS_DISPO_RE.test(rawNorm);
  const rawClauses = splitClauses(rawNorm);
  const clauseList = rawClauses.length ? rawClauses : [rawNorm];
  setDxVocab(opts.dxCatalog);
  const hasCatalog = !!(opts.catalog && opts.catalog.length);
  const dosedMedInLine = clauseList.some(cl => hasDoseEvidence(cl) && classifyIntent(cl) === 'med');
  const questionLine = /\?/.test(String(action));
  // "admit ... continue ceftriaxone and the midazolam drip": the continuation verb
  // opens one clause but governs the whole line's dose expectations.
  const continuingLine = clauseList.some(cl => CONTINUE_RE.test(cl));
  const lineFlags = {dosed: dosedMedInLine, continuing: continuingLine,
                     question: questionLine, discussing: discussingAction,
                     readreq: READ_REQ_RE.test(rawNorm)};
  let anyApplied = false;
  let prevWithheld = false;
  const committed = [];   // {clause, matchedAssessment} per assessment clause this turn
  for(const rawClause of clauseList){
    let clause = rawClause;
    // A withhold carries across an "and"-split when the stranded clause has no
    // ordering language of its own: "hold further shocks and epi til core over 30"
    // split into "…hold further shocks" / "epi til core over 30", and the nurse
    // confirmed the hold then pushed the epi in the same reply.
    const inherited = prevWithheld && !ORDERISH_RE.test(rawClause);
    const withheld = WITHHOLD_RE.test(rawClause) || inherited;
    prevWithheld = withheld || /\b(hold(ing)?|withhold(ing)?)\b(?!\s+pressure)/.test(rawClause);
    const deliberating = DELIBERATE_RE.test(rawClause);
    // A contingency is staged, not executed: "IF her pressure fails I'd start
    // norepinephrine" was given to a normotensive patient; "my threshold for
    // intubating her" intubated her. Counseling about a drug is not giving it.
    const conditional = /^if\b/.test(rawClause)
      || /\b(i d|i would) (start|give|add|push|hang|reach for|consider)\b/.test(rawClause)
      || /\bthreshold for\b/.test(rawClause);
    const counseling = DISCUSS_RE.test(rawClause) && !DISCUSS_IS_DISPO_RE.test(rawClause);
    let matched = matchResponders(pack, rawClause);
    const ctoks = normalize(rawClause).split(' ');
    // Earliest clause position of EACH matched alias, per responder. A responder
    // often aliases several drugs of a class (kayexalate AND lokelma live on one
    // potassium-binder responder), so negation must reason per alias, not per
    // responder.
    const aliasPositionsOf = r => {
      const ps = [];
      for(const a of ((r.match && r.match.any) || [])){
        const na = normalize(a); if(!na || !fuzzyHas(ctoks, na)) continue;
        let best = Infinity;
        for(const pt of na.split(' ')){
          const ix = ctoks.indexOf(pt);
          if(ix >= 0) best = Math.min(best, ix);
        }
        if(best < Infinity) ps.push(best);
      }
      return ps;
    };
    const allPos = matched.map(aliasPositionsOf);
    const positions = allPos.map(ps => ps.length ? Math.min(...ps) : Infinity);
    // A withhold binds to the FIRST drug named after the verb; anything named
    // LATER in the clause is a separate positive order ("ok scrap the hemabate -
    // miso 800 per rectum" cancels carboprost AND gives misoprostol; "no i said
    // NOT kayexalate - give sodium zirconium…" holds one alias of the binder
    // responder and affirms another).
    let withholdSurvivors = null;
    if(withheld){
      const flat = allPos.flat();
      const globalMin = flat.length ? Math.min(...flat) : Infinity;
      withholdSurvivors = new Set(matched.filter((r, i) => allPos[i].some(p => p > globalMin)));
    }
    // Mid-clause negation binds to a drug by position. A bare no/not between two
    // drugs rejects the EARLIER one ("kayexalate? no - lokelma" gave kayexalate);
    // forward negators reject what follows ("nobody jostles him" fired the jostle
    // punisher on a gentle-handling order). A responder is skipped only when EVERY
    // matched alias sits inside a negated window; withhold-phrased aliases exempt.
    const negWindows = [];
    ctoks.forEach((tok, n) => {
      const subst = tok === 'no' || tok === 'not';
      if(!subst && !NEG_FORWARD.has(tok)) return;
      if(subst && allPos.some(ps => ps.some(p => p >= n - 2 && p < n))){ negWindows.push([n - 2, n - 1]); return; }
      let end = n + NEG_REACH;
      for(let k = n + 1; k <= end && k < ctoks.length; k++)
        if(['give','start','push','hang','run','use','add','switch'].includes(ctoks[k])){ end = k - 1; break; }
      if(end > n) negWindows.push([n + 1, end]);
    });
    const negSkips = new Set();
    if(negWindows.length) matched.forEach((r, i) => {
      const ps = allPos[i];
      if(ps.length && ps.every(p => negWindows.some(w => p >= w[0] && p <= w[1]))) negSkips.add(r);
    });
    let viaCatalog = false;
    if(!matched.length && hasCatalog){
      const canon = applyCatalogAliases(rawClause, opts.catalog);
      if(canon !== rawClause){
        const m2 = matchResponders(pack, canon);
        if(m2.length){ matched = m2; viaCatalog = true; }
        clause = canon;               // canonical form for the match or the fallback
      }
    }
    const intent = classifyIntent(clause);
    // An ASSESS frame followed by a thing is a diagnosis; followed by a plan it's
    // an order wearing a hedge ("I think we should give aspirin") — only the former
    // is a commitment. `clause` is already normalized (lowercased, articles
    // dropped), so match it as-is.
    // A frame with nothing after it commits nothing. The order catalog's one assessment
    // entry is labelled "I think this is", and the basket signed it as its own clause —
    // so Kim's debrief carried a working-diagnosis row reading "i think this is", graded
    // wrong, while the diagnosis she actually typed was filed as not understood.
    const framedBody = clause.replace(ASSESS_FRAME_RE, '').trim();
    const emptyFrame = intent === 'assessment' && !framedBody;   // fallbackFor asks for it
    const diagnosisClause = intent === 'assessment' && !emptyFrame && !PLAN_PHRASE_RE.test(clause)
      && !LEADING_ORDER_RE.test(framedBody);
    if(diagnosisClause) committed.push({ clause, matchedAssessment: false });
    // One trace row per clause. matchScore is a pure function of (responder, tokens),
    // so recomputing it here returns exactly the value matchResponders selected on.
    const tc = trace ? {text:clause, matched:[], scores:[], viaCatalog,
                        fallback:!matched.length, intent:classifyIntent(clause), satisfies:[]} : null;
    if(tc){
      trace.clauses.push(tc);
      const toks = normalize(clause).split(' ');
      for(const r of matched){ tc.matched.push(pack.responders.indexOf(r)); tc.scores.push(matchScore(r, toks)); }
    }
    if(matched.length){
      let clauseApplied = false, guardSkipped = false, gateBlocked = false;
      for(const r0 of matched){
        // A declined action must not be performed or credited. But withholding is often
        // exactly the right move — "hold apixaban", "hold steroids until GI weighs in" and
        // "no DRE" are aliases packs author deliberately — and "not ACS" is a diagnostic
        // assertion, not a refusal. The clause alone cannot tell these apart, so the
        // responder's OWN vocabulary decides: if it is phrased for withholding, a
        // withholding clause belongs to it; if its aliases are all positive ("vancomycin",
        // "give vanc"), then "holding vanc" is a mismatch and must not fire it.
        if((counseling || conditional) && (r0.intent === 'med' || r0.intent === 'procedure')){ guardSkipped = true; continue; }
        // A responder whose results are ALL already on the chart, reached by a
        // clause with no re-order language, is a citation, not an order.
        const reorderVerb = /\b(recheck|repeat|redraw|send|draw|order|get|obtain|another|again|redo|stat)\b/.test(rawClause);
        if(!reorderVerb && !(Number.isInteger(r0.satisfies) && !state.satisfied.includes(r0.satisfies))){
          const rows = r0.labResults || [], reps = r0.diagnosticReports || [];
          const allRows = rows.length && rows.every(l => state.labsSeen[canonLabName(l.name)] || state.labsSeen[l.name]);
          const allReps = reps.length && reps.every(rep => state.reportsSeen[rep.title]);
          if((rows.length || reps.length) && (!rows.length || allRows) && (!reps.length || allReps)){ guardSkipped = true; continue; }
        }
        const withholdPhrased = ((r0.match && r0.match.any) || []).some(a => WITHHOLD_RE.test(a));
        if(withheld && !(withholdSurvivors && withholdSurvivors.has(r0)) && !withholdPhrased) continue;
        if(negSkips.has(r0) && !withholdPhrased){ guardSkipped = true; continue; }
        // Talking ABOUT results is not re-ordering them: "explain the spinal
        // fluid shows a bacterial infection" re-ran the lumbar puncture.
        if(discussingAction && !Number.isInteger(r0.satisfies)
           && ((r0.labResults||[]).length || (r0.diagnosticReports||[]).length)){ guardSkipped = true; continue; }
        // Nor may a disposition responder close the case on a line that is discussing
        // or deliberating one ("whether to admit to stroke svc" is a question).
        if((discussingAction || deliberating) && r0.ends) continue;
        // ROUTE guard. Opt-in per responder: {route:{accepts:[...], elseSpeech:[...]}}.
        // Only fires when the player NAMED a route and none of the named routes
        // is accepted — an unstated route is the dose flag's job, not this one.
        // A rejected order is not performed: no credit, no vitals, no trend, so
        // it cannot avert the deterioration this case is built around. The
        // elseSpeech carries the teaching, because silence would read as assent.
        if(r0.route && Array.isArray(r0.route.accepts)){
          const said = clauseRoutes(rawClause);
          if(said.length && !said.some(x => r0.route.accepts.includes(x))){
            if(r0.route.elseSpeech) out.speech.push(...r0.route.elseSpeech);
            guardSkipped = true;
            continue;
          }
        }
        if(r0.gate){
          const need = r0.gate.requires || [];
          if(!need.every(f=>state.flags[f])){
            if(r0.gate.elseSpeech) out.speech.push(...r0.gate.elseSpeech);
            pendingGates.push(need); gateBlocked = true;
            // A REFUSED ORDER DOES NOT HAPPEN.
            //
            // This block used to let a gated treatment fall all the way through and
            // apply itself — vitals, trend, state, results and its own success speech —
            // on the reasoning that the player HAD performed the action and deserved the
            // critical-action credit. Credit was right; bundling the whole world state in
            // with it was not. The nurse ended up refusing and confirming in the same
            // breath, and the monitor took the refused treatment's side:
            //
            //   cv-unstable-vt, "synchronized cardioversion" before sedation
            //     "He's still wide awake, Doctor — we need sedation on board before we
            //      shock him."
            //     "Synchronized, 100 joules — shock delivered. He converts."
            //     monitor: VT 190, 82/54  ->  Sinus 78, 118/74
            //
            // 62 of the 76 gated treatments carrying vitals read that way. Kim's call:
            // refuse it and keep the credit. So the DECISION still scores — the player
            // named the right treatment and must not be punished twice, and the
            // prerequisite is graded as its own critical action — but nothing else
            // applies. The player does the prerequisite and orders again.
            //
            // The predicate below is the old softGate unchanged, so exactly the orders
            // that used to earn credit here still earn it. Only the world stops moving.
            // History stays hard-gated and uncredited: information that cannot be
            // obtained has not been obtained (a private sexual history needs the parent
            // to step out). A gated PROCEDURE reached through prep language is likewise
            // uncredited — prep is not performance.
            const creditIt = Number.isInteger(r0.satisfies) && r0.intent !== 'history'
                             && !(r0.intent === 'procedure' && PREP_RE.test(clause))
                             && !need.some(f => SEQUENCE_FLAG_RE.test(f));
            if(creditIt && !state.satisfied.includes(r0.satisfies)) state.satisfied.push(r0.satisfies);
            if(creditIt && tc) tc.satisfies.push(r0.satisfies);
            continue;
          }
        }
        // A dosed medication line is not an exam — "titrate to PERFUSION" fired
        // the skin-perfusion exam and stole the inotrope credit, which let a
        // death stage see its rescue as never given. Exam responders answer a
        // dosed line only when the clause itself is exam-shaped.
        if(r0.intent === 'exam' && dosedMedInLine && classifyIntent(clause) !== 'exam'){ guardSkipped = true; continue; }
        // Deliberation window: content named after "whether" is an option being
        // weighed, not an order — "that decides whether radiology can attempt an
        // air enema" PERFORMED the enema.
        {
          const wIdx = ctoks.indexOf('whether');
          if(wIdx >= 0){
            const ps = aliasPositionsOf(r0);
            if(ps.length && ps.every(p => p > wIdx)){ guardSkipped = true; continue; }
          }
        }
        // A clause that states a diagnosis is not an order, even when the diagnosis
        // NAMES a drug or test ("an aspirin overdose") — matchResponders is permissive
        // and lets that word alone match the drug's responder. A genuine diagnosis
        // clause may only be answered by assessment (or consult) responders; anything
        // else riding along on the same wording is a coincidental token hit, not a
        // stated order, and must not apply or credit. A hedged ORDER ("I think we
        // should give aspirin") is exempt — it is not a diagnosisClause — and fires
        // exactly as it did before this guard existed.
        if(diagnosisClause && r0.intent !== 'assessment' && r0.intent !== 'consult'){ guardSkipped = true; continue; }
        if(r0.setState) Object.assign(state.flags, r0.setState);
        anyApplied = true; clauseApplied = true;
        if(r0.intent === 'assessment' && diagnosisClause
           && committed.length && committed[committed.length-1].clause === clause)
          committed[committed.length-1].matchedAssessment = true;
        if(r0.intent === 'med' || r0.intent === 'procedure') state.medCount++;
        if(r0.intent === 'consult'){
          state.consultPending = null;
          // The accepting consultant remembers being called — a pack-responder
          // contact previously left `consulted` unset and the callback restarted
          // with "what's your assessment?"
          state.consulted = state.consulted || {};
          for(const svc of CONSULT_SERVICES) if(fuzzyHas(ctoks, svc)) state.consulted[svc] = true;
        }
        if(Array.isArray(r0.labResults)) out.labResults.push(...r0.labResults);
        if(Array.isArray(r0.diagnosticReports)) out.diagnosticReports.push(...r0.diagnosticReports.map(enforceReadRules));
        if(Array.isArray(r0.physicalExam)) out.physicalExam.push(...r0.physicalExam);
        // An authored assessment reply is written to confirm — richly, clinically —
        // that the diagnosis it's aliased to is the right one ("Documented —
        // migratory large-joint pattern... using the Jones criteria"). Firing it the
        // moment a diagnosisClause names that same condition would out the correct
        // answer mid-case, which the design forbids. Everything ELSE the responder
        // does (satisfies, setState, vitals, trend) still applies unchanged below —
        // only the words are withheld, and saved for the debrief instead.
        const withholdForDx = diagnosisClause && r0.intent === 'assessment';
        if(withholdForDx){
          if(Array.isArray(r0.speech)) state.dxHeld.push(...r0.speech.map(s => s.text));
          if(r0.narrative) state.dxHeld.push(r0.narrative);
          // The player still gets answered — same echo shape as an unmatched
          // commitment (below) — so a right call reads no differently in play
          // than a wrong one; only the debrief tells them apart.
          const read = String(rawClause || '').replace(ASSESS_FRAME_RE, '').replace(/[.?!]+$/, '').trim();
          // Same board wording, same capitalisation rule as the unmatched path below —
          // a right call must read no differently from a wrong one, and both write the
          // term the way it goes on the board.
          const shownDx = dxDisplay(read);
          const board = shownDx
            ? [`Got it — working diagnosis ${shownDx}. I'll put it up on the board.`,
               `Understood, ${shownDx}. It's on the board — what do you want to do about it?`,
               `${shownDx} — noted as your working diagnosis. What next?`]
            : ["What's the diagnosis, doctor?"];
          const boardLine = board[(state.turnCount || 0) % board.length];
          out.speech.push({speaker:'nurse', text: boardLine});
          out.narrative = boardLine;   // visible on screen; see fallbackFor for why
        } else {
          if(Array.isArray(r0.speech)){
            // For a fluid order, echo the doctor's own volume back at them.
            const fluid = r0.intent === 'med' && FLUIDS_REQUIRING_VOLUME.some(m => fuzzyHas(ctoks, m));
            out.speech.push(...(fluid
              ? r0.speech.map(sp => Object.assign({}, sp, { text: readbackVolume(sp.text, rawClause || clause) }))
              : r0.speech));
          }
          // An authored narrative paragraph is delivered ONCE — the epiglottitis OR
          // sequence printed three times when late clauses re-touched its responder.
          if(r0.narrative && !state.narrSeen[r0.narrative]){
            out.narrative += (out.narrative?' ':'') + r0.narrative;
            state.narrSeen[r0.narrative] = true;
          }
        }
        // The dose check used to read only the clause that matched, but a real order splits
        // the drug from its dose across clauses: "RSI - ketamine 100, roc 100, intubate"
        // matched the intubation responder on the bare word "intubate", saw no digit, and
        // scolded a player who had spelled out both doses one clause earlier. Each false
        // flag costs 5 of the 15 dosing points. Look across the whole line for a dosed
        // medication clause — and remember a dose across turns: the TCA player typed
        // "sodium bicarb 100 mEq IV bolus", then read "dose not specified" at the end of
        // the case because the disposition line mentioned bicarb without digits.
        if(r0.dose && r0.dose.required && r0.dose.flagIfUnspecified){
          const dk = 'r:' + r0.dose.flagIfUnspecified;
          if(hasDoseEvidence(clause) || dosedMedInLine) state.dosedOnce[dk] = true;
          else if(!continuingLine && !state.dosedOnce[dk]) out.dosingFlags.push(r0.dose.flagIfUnspecified);
        }
        // Fluid twin of rule 15 on the matched path: a bare "bolus" credited the
        // fluid critical action with no volume ever stated. Credit stands (the
        // decision was right); the dosing score records the missing volume.
        if(r0.intent === 'med' && !(r0.dose && r0.dose.required) && FLUIDS_REQUIRING_VOLUME.some(m => fuzzyHas(ctoks, m))
           && !((r0.match && r0.match.any) || []).some(a => WITHHOLD_RE.test(a))){
          if(hasVolumeEvidence(clause) || hasVolumeEvidence(rawClause) || dosedMedInLine) state.dosedOnce['fluid'] = true;
          else if(!continuingLine && !state.dosedOnce['fluid'] && !out.dosingFlags.includes(FLUID_VOLUME_FLAG)) out.dosingFlags.push(FLUID_VOLUME_FLAG);
        }
        if(r0.vitals) Object.assign(targets, r0.vitals);
        if(r0.trend) trend = strongerTrend(trend, r0.trend);
        if(Number.isInteger(r0.satisfies) && !state.satisfied.includes(r0.satisfies)) state.satisfied.push(r0.satisfies);
        // Recorded unconditionally: a repeat order still evidences that THIS clause
        // reaches this critical action, which is exactly what the analyzer needs.
        if(tc && Number.isInteger(r0.satisfies)) tc.satisfies.push(r0.satisfies);
        // Several packs carry a bare "admission" alias on their disposition responder,
        // which also matches a question about a PAST hospitalisation ("what were her
        // vitals on admission"). Closing there steals the rest of the case, so a
        // historical construction never ends it. A genuine disposition is unaffected:
        // it still closes via classifyIntent's disposition check after this loop.
        if(r0.ends && !PRIOR_ADMISSION_RE.test(clause)) endedBy = r0.ends === true ? 'good' : r0.ends;
        minutes = Math.max(minutes, r0.minutes || MINUTES[r0.intent] || 3);
      }
      // The doctor declined it and every matched responder was rightly skipped —
      // confirm the hold instead of saying nothing (the matched-path twin of the
      // fallback withhold acknowledgment).
      if(withheld && !clauseApplied)
        out.speech.push({speaker:'nurse', text:'Understood — holding that.'});
      if(conditional && !clauseApplied)
        out.speech.push({speaker:'nurse', text:'Got it — staged and standing by; that runs only if we cross the line you set.'});
      // A hard gate (for example, information that cannot be obtained until a
      // prerequisite happens) leaves the order unperformed. Preserve that fact
      // in the decision trace so the UI can distinguish it from a generic but
      // genuinely performed order.
      if(tc && gateBlocked && !clauseApplied) tc.gateBlocked = true;
      // A clause whose every match was guard-skipped must still be ANSWERED —
      // the first hyperosmolar order of a herniation case vanished when the
      // pupil-exam guard ate its only match.
      if(!clauseApplied && guardSkipped && !gateBlocked && !withheld && !conditional && !counseling){
        const fb2 = fallbackFor(clause, opts, state, pack, rawClause, withheld, lineFlags);
        out.labResults.push(...fb2.labResults);
        out.diagnosticReports.push(...fb2.diagnosticReports);
        out.physicalExam.push(...fb2.physicalExam);
        out.speech.push(...fb2.speech);
        out.dosingFlags.push(...fb2.dosingFlags);
        if(fb2._narrative) reevalNarr += (reevalNarr?' ':'') + fb2._narrative;
        anyApplied = true;
        if(fb2.intent === 'med' || fb2.intent === 'procedure') state.medCount++;
        minutes = Math.max(minutes, fb2._minutes || 3);
      }
      // A consult-shaped clause deserves a live consultant: when its matches are
      // all non-consult content (the TTP player "got pathology on the line" and
      // only re-heard the smear), OR when the matched consult responder has
      // nothing NEW to say (a callback re-fired a one-shot consult whose line the
      // dedupe then ate — "call toxicology" returned pure filler).
      const freshConsult = matched.some(r => r.intent === 'consult'
        && (r.speech||[]).some(s => !state.spokenSeen[s.speaker + '|' + s.text]));
      if(classifyIntent(clause) === 'consult' && !freshConsult){
        const cfb = fallbackFor(clause, opts, state, pack, rawClause, withheld, lineFlags);
        if(cfb.intent === 'consult') out.speech.push(...cfb.speech);
      }
      // A lab-shaped clause returns EVERY panel and solo it names, whether the
      // clause was stolen by a non-lab responder ("add LFTs since I'm worried
      // about HSV" matched the vesicle responder) or one multi-panel clause
      // out-ran the pack's coverage ("cbc bmp coags type and screen" returned
      // only CBC and BMP).
      if(classifyIntent(clause) === 'lab') appendMissingLabs(clause, rawClause, out, state);
    } else {
      const fb = fallbackFor(clause, opts, state, pack, rawClause, withheld, lineFlags);
      // Fallback mirror of the citation rule: "CK's almost 4 grand — start a
      // liter of LR" re-drew the CK and dropped the fluids.
      if(fb.intent === 'lab' && fb.labResults.length
         && fb.labResults.every(l => state.labsSeen[canonLabName(l.name)] || state.labsSeen[l.name])
         && !/\b(recheck|repeat|redraw|send|draw|order|get|obtain|another|again|redo|stat|level)\b/.test(rawClause)){
        fb.labResults = [];
        const mtoks = clause.split(' ');
        const cited = MED_WORDS.filter(w => fuzzyHas(mtoks, w)).find(w => w !== 'bolus');
        if(cited){
          fb.speech = [{speaker:'nurse', text: cited.charAt(0).toUpperCase()+cited.slice(1)+' is running.'}];
          fb.intent = 'med';
        } else { fb.speech = []; fb.intent = 'assessment'; }
      }
      out.labResults.push(...fb.labResults);
      out.diagnosticReports.push(...fb.diagnosticReports);
      out.physicalExam.push(...fb.physicalExam);
      out.speech.push(...fb.speech);
      out.dosingFlags.push(...fb.dosingFlags);
      if(fb._narrative) reevalNarr += (reevalNarr?' ':'') + fb._narrative;
      anyApplied = true;
      if(!withheld && (fb.intent === 'med' || fb.intent === 'procedure')) state.medCount++;
      // The player deserves to know what the sim never understood — an order that
      // drew only filler earned no effect and no credit, and until now that fact
      // was invisible. Collected here, surfaced in the debrief.
      if(fb._unparsed && !isOrderFragment(rawClause)){
        state.unparsed = state.unparsed || [];
        // The cap was 8, and the timeline had none — so a player's ninth distinct miss
        // was shown during the case and then quietly missing from the debrief that is
        // supposed to summarise it. Room for a genuinely bad run, and when even that
        // overflows the debrief says so rather than trimming in silence.
        if(!state.unparsed.includes(rawClause)){
          if(state.unparsed.length < 40) state.unparsed.push(rawClause);
          else state.unparsedDropped = (state.unparsedDropped || 0) + 1;
        }
        // Put it on the trace row too. The debrief's per-order "[NOT RECOGNISED]"
        // note used to re-derive this from the clause intent and got it wrong: an
        // unrecognised DRUG falls back with intent 'assessment', which that filter
        // excluded, so ordering lactulose in a pack that has no lactulose responder
        // vanished without a word. This flag is the engine's own answer.
        if(tc) tc.unparsed = true;
      }
      if(fb._o2Bump && targets.o2 === undefined && typeof opts.vitals.o2 === 'number' && opts.vitals.o2 < 96)
        targets.o2 = Math.min(96, opts.vitals.o2 + fb._o2Bump);
      if(fb.intent === 'lab') appendMissingLabs(clause, rawClause, out, state);
      if(fb._routine) wantRoutine = true;
      // A discussing/deliberating line must not close the case through the
      // fallback either: "call neurosurgery back — ... or medical management in
      // the neuro ICU" ended a case on the stranded "neuro icu" clause.
      if(fb._ends && !discussingAction && !deliberating) endedBy = endedBy || fb._ends;
      minutes = Math.max(minutes, fb._minutes || 3);
    }
  }
  // Intubation is a one-way door for patient dialogue: after "RSI, roc 100" and a
  // confirmed tube, the patient still answered a history question out loud.
  if(!state.intubated){
    if(state.flags.airwaySecured || state.flags.intubated) state.intubated = true;
    else if(/\b(intubate|intubated|intubation|rapid sequence intubation)\b/.test(rawNorm)
            && !WITHHOLD_RE.test(rawNorm) && !PREP_RE.test(rawNorm) && !/\?\s*$/.test(String(action)))
      state.intubated = true;
  }
  // bare "labs"/"routine labs" ⇒ CBC + BMP ONLY, preferring the pack's case-specific rows
  if(wantRoutine){
    for(const key of ['complete blood count','basic metabolic panel']){
      const pr = matchResponders(pack, key).find(r=>Array.isArray(r.labResults));
      out.labResults.push(...(pr ? pr.labResults : panelRows(key)));
    }
    minutes = Math.max(minutes, MINUTES.lab);
  }
  // Repeat-order semantics: a re-ordered test returns its ORIGINAL value (never a
  // fresh random draw), marked repeat:true so the app REPLACES the row instead of
  // stacking duplicates. If a deterioration stage fired since the first draw, the
  // value drifts in the bad direction; if treatment was given since and the patient
  // has NOT deteriorated, a flagged value tracks toward normal — seven amps of
  // bicarb returned four byte-identical gases in a TCA playtest, making the sim's
  // own "titrate to pH" coaching untestable. pH moves by hundredths, never by
  // percent (a 12% "worse" pH printed 6.4, a value incompatible with life).
  let repeatRow = null, repeatRowScore = -1, repeatWorse = false, repeatBetter = false;
  const clampPH = x => Math.max(6.75, Math.min(7.75, x));
  out.labResults = out.labResults.map(l => {
    // Canonical key: a pack recheck row named "Sodium (repeat)" and the BMP's
    // "Sodium" are the same analyte — two independent trajectories printed values
    // 73 mmol/L apart in the same quarter-hour.
    const key = canonLabName(l.name);
    const seen = state.labsSeen[key] || state.labsSeen[l.name];
    const firstNum = parseFloat(String(l.value).replace(/[<>]/g,''));
    if(seen === undefined){
      state.labsSeen[key] = {s: state.stagesFired.length, v: l.value, m: state.medCount,
                             o: isFinite(firstNum) ? firstNum : null};
      return l;
    }
    let v = seen.v;
    const num = parseFloat(String(seen.v).replace(/[<>]/g,''));
    // \b, not ^: "Venous pH" missed the guard and a 10% "improvement" printed 8.0.
    const isPH = /\bph\b/i.test(l.name);
    const range = NORMAL_RANGE[key];
    // Direction of WORSE: the range decides when known — a CRITICAL-low cortisol
    // was treated as high and its fall narrated as "better".
    const dir = (range && isFinite(num)) ? (num < range.lo ? -1 : num > range.hi ? 1 : (l.flag === 'L' ? -1 : 1))
                                        : (l.flag === 'L' ? -1 : 1);
    const dp = String(seen.v).includes('.') ? 1 : 0;
    if(state.stagesFired.length > seen.s){
      if(isFinite(num) && num !== 0){
        v = isPH ? clampPH(num + 0.06*dir).toFixed(2)
                 : (num * (1 + 0.12*dir)).toFixed(dp);
        repeatWorse = true;
      }
      state.labsSeen[key] = {...seen, s: state.stagesFired.length, v, m: state.medCount};
    } else if(state.medCount > (seen.m || 0) && l.flag && isFinite(num) && num !== 0){
      // Improvement tracks toward normal and STOPS at the range edge — it must
      // never compound past it (sodium 116 walked to 195, every step "better").
      const steps = Math.min(3, state.medCount - (seen.m || 0));
      let nv = isPH ? clampPH(num - 0.05*dir*steps)
                    : num * Math.pow(1 - 0.10*dir, steps);
      if(range){
        if(dir < 0 && nv > range.lo) nv = range.lo;   // low value recovering upward
        if(dir > 0 && nv < range.hi) nv = range.hi;   // high value recovering downward
      }
      const nvs = isPH ? nv.toFixed(2) : nv.toFixed(dp);
      if(nvs !== String(seen.v)){ v = nvs; repeatBetter = true; }
      state.labsSeen[key] = {...seen, s: state.stagesFired.length, v, m: state.medCount};
    }
    // Flags follow the value: inside the normal range the flag clears; a value
    // that has moved well off a CRITICAL original but is still abnormal DEMOTES
    // to H/L (an INR of 3.0 in an active bleed is not flag-free).
    let flag = l.flag;
    const cur = parseFloat(String(v).replace(/[<>]/g,''));
    if(!flag && range && isFinite(cur) && (cur < range.lo || cur > range.hi))
      flag = cur < range.lo ? 'L' : 'H';    // a drifted value out of range is flagged
    if(flag && isFinite(cur)){
      if(range && cur >= range.lo && cur <= range.hi) flag = '';
      else if(seen.o != null && seen.o !== 0
              && Math.abs(cur - seen.o) / Math.abs(seen.o) >= 0.15 && flag === 'CRITICAL')
        flag = dir < 0 ? 'L' : 'H';
    }
    // The spoken readback picks the most clinically notable repeat, not the last
    // one processed ("Repeat Glucose is better — 94" while sodium sat at 104).
    const score = (flag === 'CRITICAL' ? 2000 : flag ? 1000 : 0)
      + (isFinite(cur) && seen.o ? Math.abs(cur - seen.o) / Math.abs(seen.o) : 0);
    if(score > repeatRowScore){ repeatRowScore = score; repeatRow = {name:l.name, value:String(v), unit:l.unit}; }
    return {...l, value:String(v), flag, repeat:true};
  });
  // Re-ordered studies replace their old card instead of duplicating it.
  out.diagnosticReports = out.diagnosticReports.map(rep => {
    if(state.reportsSeen[rep.title]) return {...rep, repeat:true};
    state.reportsSeen[rep.title] = true; return rep;
  });
  // One order can legitimately reach the same responder twice (a multi-clause
  // line where both clauses match it, an assessment riding along) — the
  // player must never see the same spoken line or finding twice in one turn.
  // Two responders can legitimately answer one clause ("blood cultures" reaching both a
  // cultures responder and a panel that includes them), and each carried its own copy of
  // the same row — so a turn printed two identical blood cultures, or two identical CT
  // head reports. speech and exam were already deduped; results were not.
  // By canonical NAME alone: two responders each carrying a Glucose row printed
  // 104 and 114 [L] in one panel, and "Sodium (repeat)" beside "Sodium" — one
  // turn never shows two values for the same analyte.
  out.labResults = out.labResults.filter((l,i,arr)=>i===arr.findIndex(x=>canonLabName(x.name)===canonLabName(l.name)));
  out.diagnosticReports = out.diagnosticReports.filter((r,i,arr)=>i===arr.findIndex(x=>x.title===r.title && x.body===r.body));
  out.speech = out.speech.filter((s,i,arr)=>i===arr.findIndex(x=>x.speaker===s.speaker && x.text===s.text));
  out.physicalExam = out.physicalExam.filter((e,i,arr)=>i===arr.findIndex(x=>x.system===e.system && x.finding===e.finding));
  // ...and never ACROSS turns either: re-touching a responder replayed its authored
  // lines word-for-word ("First two units of O-positive PRBCs are running" on the
  // disposition turn; the consultant's asthma warning after the drug was cancelled).
  // Patient lines are exempt — a patient repeating themselves is human, and the
  // unanswered-history rotation depends on reuse.
  out.speech = out.speech.filter(s => s.speaker === 'patient' || !state.spokenSeen[s.speaker + '|' + s.text]);
  // An intubated patient does not talk. The nurse's redirect appears only when
  // the player actually asked something (it fired as a non-sequitur at ROSC).
  if(state.intubated){
    const hadPatient = out.speech.some(s => s.speaker === 'patient');
    out.speech = out.speech.filter(s => s.speaker !== 'patient');
    if(hadPatient && clauseList.some(c => classifyIntent(c) === 'history')){
      const note = {speaker:'nurse', text:'No verbal response — the patient\'s intubated. Family or EMS may be able to fill in the gaps.'};
      if(!state.spokenSeen[note.speaker + '|' + note.text]) out.speech.push(note);
    }
  }
  // Serial exams that haven't changed say so, instead of replaying identical
  // findings as if fresh (three sessions flagged frozen exam text as a top
  // immersion break — at minimum the sim must be honest that it is unchanged).
  state.examSeen = state.examSeen || {};
  if(out.physicalExam.length){
    const allSeen = out.physicalExam.every(e => state.examSeen[e.system + '|' + e.finding]);
    for(const e of out.physicalExam) state.examSeen[e.system + '|' + e.finding] = true;
    if(allSeen){
      const pool = ['Exam is unchanged from your last check.','No change on re-examination.','Same exam as before — nothing new.'];
      const line = pool[state.turnCount % pool.length];
      if(!state.spokenSeen['nurse|' + line]) out.speech.push({speaker:'nurse', text: line});
    }
  }
  // Chatting about results already on the chart is not a fresh 18-minute draw.
  if(out.labResults.length && out.labResults.every(l=>l.repeat) && minutes === MINUTES.lab)
    minutes = 8;
  // A code runs on two-minute cycles: single orders were costing 10 minutes each
  // and one playtested VF arrest ran 88 "minutes" before ROSC.
  if(/ventricular fibrillation|asystole|pulseless/i.test(String((opts.vitals||{}).rhythm||'')))
    minutes = Math.min(minutes, 3);
  out.simMinutes = minutes;
  // Correctness is decided here and never revealed: the debrief is the only place
  // the player learns whether the read was right.
  for(const c of committed)
    state.assessments.push({ text: c.clause, minute: (opts.simMin||0) + minutes,
                             correct: c.matchedAssessment || matchesDiagnosis(c.clause, opts.diagnosis) });
  // The transcript renders `narrative`; `speech` is only voiced. An acknowledgement
  // that lives solely in speech is audible but invisible, so a player who committed
  // to a diagnosis read the generic "the team moves on it" and still felt ignored.
  // Identical wording whichever way the call went, so nothing leaks.
  if(committed.length && !out.narrative){
    const last = committed[committed.length-1].clause;
    const read = String(last||'').replace(ASSESS_FRAME_RE,'').replace(/[.?!]+$/,'').trim();
    out.narrative = read
      ? `Got it — working diagnosis ${read}. It's on the board.`
      : 'Got it — that\'s up as the working diagnosis.';
  }
  // Same rule for a bedside re-eval: the numbers and the trend read ARE the answer to
  // that order, so they go on screen, appended after whatever else this turn narrated.
  // Placed after the diagnosis ack (which only fires on an empty narrative) and before
  // the default below, so a plain "reassess the patient" reads the vitals instead of
  // the generic "Done — the team moves on it."
  if(reevalNarr) out.narrative = out.narrative ? out.narrative + ' ' + reevalNarr : reevalNarr;
  // deterioration stages (fire once, unless the guarding critical actions were met)
  const newMin = (opts.simMin||0) + minutes;
  const stages = effectiveStages(pack);   // afterMin already includes the case's grace
  // A pending death from a prior turn resolves FIRST, after this turn's orders have
  // been credited: the player either performed the stage's own guard actions (the
  // rescue — the patient survives, crashed but alive) or they didn't, and the death
  // completes. Every death this round fired atomically — arrest announcement and
  // CASE OVER in one message — while the authored nurse lines literally asked
  // "what do you want me to do?". Now they mean it.
  let rescued = false;
  if(state.pendingDeath != null && !endedBy){
    const pd = stages[state.pendingDeath];
    if(pd && stageAverted(pack, pd, state)){
      state.pendingDeath = null; rescued = true;
      trend = strongerTrend(trend, 'critical');
    } else if(!state.deathExtended
              && /defibrillat|shock|cpr|compressions|epinephrine|amiodarone/.test(rawNorm)){
      // The player is actively running the code — one more cycle before the
      // death lands (a VF arrest that ends one order after it begins reads as a
      // scripted execution, not a resuscitation).
      state.deathExtended = true;
      trend = strongerTrend(trend, 'critical');
      const line = 'Still no pulse — the code keeps running. What else?';
      if(!state.spokenSeen['nurse|' + line]) out.speech.push({speaker:'nurse', text: line});
    } else {
      endedBy = 'death';
    }
  }
  stages.forEach((st, i) => {
    if(state.stagesFired.includes(i)) return;
    if(newMin < (st.afterMin||9999)) return;
    if(stageAverted(pack, st, state)) return;
    state.stagesFired.push(i); firedThisTurn = true;
    if(st.vitals) Object.assign(targets, st.vitals);
    trend = strongerTrend(trend, st.trend || 'worsening');
    if(st.nurse) out.speech.push({speaker:'nurse', text:st.nurse});
    if(st.ends === 'death' && state.pendingDeath == null && endedBy !== 'death'){
      // grace turn: the crash lands now; the case ends next turn unless rescued
      state.pendingDeath = i;
      if(!st.nurse) out.speech.push({speaker:'nurse', text:'No pulse — compressions started. Tell me what you want to do.'});
    } else if(st.ends){
      endedBy = st.ends;
    }
  });
  // A disposition always ends the encounter (admit/ICU/OR/transfer/discharge hand off
  // care) — even when a pack responder matched the clause but forgot `ends`.
  if(!endedBy && !discussingAction && clauseList.some(c=>classifyIntent(c)==='disposition')) endedBy='good';
  // A successful rescue restores a pulse: without a floor, an averted arrest left
  // the monitor reading asystole forever. The rescue responder's own vitals win
  // where authored; these fill only the gaps.
  if(rescued){
    const cur = opts.vitals || {};
    const pulseless = (cur.hr|0) <= 20 || /asystole|ventricular fibrillation|pulseless/i.test(String(cur.rhythm||''));
    if(pulseless){
      const floor = {hr:96, bpSystolic:88, bpDiastolic:54, rr:14, o2:90, rhythm:'Sinus Tachycardia'};
      for(const k of Object.keys(floor)) if(targets[k] === undefined) targets[k] = floor[k];
    }
    const line = 'We\'ve got a pulse back — keep going, doctor.';
    if(!state.spokenSeen['nurse|' + line]) out.speech.push({speaker:'nurse', text: line});
  }
  Object.assign(out.updatedVitals, targets);
  // Reconcile the label with the numbers the player can see. Trends come from authored
  // responder/stage labels combined worst-wins, so a turn where the patient measurably
  // improved could still print [worsening] — a playtester saw that tag while HR fell
  // 132→105, RR 30→20 and sats climbed 82→96. A label that contradicts the monitor beside
  // it destroys trust in the whole readout. If NO deterioration stage fired this turn and
  // the numbers moved clearly for the better, say so; the authored label still wins
  // whenever a stage fired, because then something genuinely did go wrong.
  out.vitalTrend = trend || 'stable';
  if(!firedThisTurn && (out.vitalTrend === 'worsening' || out.vitalTrend === 'critical')){
    const before = opts.vitals || {}, after = out.updatedVitals || {};
    const better = (a, b, min) => (typeof a === 'number' && typeof b === 'number') ? (b - a >= min) : false;
    const gains = [ better(before.o2, after.o2, 2),
                    better(before.bpSystolic, after.bpSystolic, 8),
                    better(after.hr, before.hr, 8),
                    better(after.rr, before.rr, 3) ].filter(Boolean).length;
    const losses = [ better(after.o2, before.o2, 2),
                     better(after.bpSystolic, before.bpSystolic, 8),
                     better(before.hr, after.hr, 8),
                     better(before.rr, after.rr, 3) ].filter(Boolean).length;
    if(gains >= 2 && losses === 0) out.vitalTrend = 'improving';
  }
  // The mirror lie: [improving] — or [worsening] — printed turn after turn while
  // every number sat frozen. A directional label needs the monitor to have moved.
  if(!firedThisTurn && (out.vitalTrend === 'improving' || out.vitalTrend === 'worsening')){
    const b = opts.vitals || {}, a = out.updatedVitals || {};
    const d = (x, y) => (typeof x === 'number' && typeof y === 'number') ? Math.abs(y - x) : 0;
    const moved = d(b.hr, a.hr) >= 3 || d(b.bpSystolic, a.bpSystolic) >= 3 || d(b.o2, a.o2) >= 1 || d(b.rr, a.rr) >= 2;
    if(!moved) out.vitalTrend = 'stable';
  }
  // Death is coherent: asystole has no heart rate, no respirations, no sat — the
  // pelvic playtest ended on "HR 40 BP 0/0 RR 6 SpO2 70% Asystole [improving]".
  if(/asystole/i.test(String(out.updatedVitals.rhythm || ''))){
    out.updatedVitals.hr = 0; out.updatedVitals.bpSystolic = 0; out.updatedVitals.bpDiastolic = 0;
    out.updatedVitals.rr = 0; out.updatedVitals.o2 = 0;
  }
  if(endedBy === 'death'){
    out.vitalTrend = 'critical';
    out.updatedVitals.rhythm = 'Asystole';
    out.updatedVitals.hr = 0; out.updatedVitals.bpSystolic = 0; out.updatedVitals.bpDiastolic = 0;
    out.updatedVitals.rr = 0; out.updatedVitals.o2 = 0;
  }
  // Sinus labels track the rate they caption: "Sinus Tachycardia" was still on the
  // banner at HR 96, ten turns after rate control worked. And a monitor can't show
  // VF beside a perfusing pressure — a rescue's authored vitals restore rate and
  // BP but packs rarely author the rhythm string, leaving arrest-stage remnants
  // ("HR 58 BP 102/64 RR 0 ... Ventricular Fibrillation").
  {
    const v = out.updatedVitals, hr = v.hr;
    if(typeof hr === 'number'){
      if(/ventricular fibrillation|asystole|pulseless/i.test(String(v.rhythm||'')) && hr >= 40 && (v.bpSystolic||0) >= 60){
        v.rhythm = hr < 60 ? 'Sinus Bradycardia' : hr > 100 ? 'Sinus Tachycardia' : 'Sinus Rhythm';
        if((v.rr||0) === 0) v.rr = 12;
      }
      // Only when the rate actually MOVED this turn: adult cutoffs relabeled a
      // 10-week-old's normal HR 148 as tachycardia on a static reading.
      const hrMoved = typeof (opts.vitals||{}).hr === 'number' && Math.abs(hr - opts.vitals.hr) >= 8;
      const rhy = String(v.rhythm || '');
      if(hrMoved){
        if(/^sinus tachycardia$/i.test(rhy) && hr < 100) v.rhythm = 'Sinus Rhythm';
        else if(/^sinus bradycardia$/i.test(rhy) && hr > 60) v.rhythm = 'Sinus Rhythm';
        else if(/^sinus rhythm$/i.test(rhy) && hr > 100) v.rhythm = 'Sinus Tachycardia';
      }
    }
    // Whatever the labels say, pulseless rhythms are critical, never [stable].
    if(/ventricular fibrillation|asystole|pulseless/i.test(String(v.rhythm||''))) out.vitalTrend = 'critical';
  }
  state.dosing += out.dosingFlags.length;
  // WOW: the nurse reads back the worst flagged lab if nobody spoke about results;
  // repeat draws get an explicit unchanged/worse readback.
  if(out.labResults.length && !out.speech.length){
    let line = null;
    if(repeatRow && out.labResults.every(l=>l.repeat)){
      line = repeatWorse
        ? `Repeat ${repeatRow.name} is worse — ${repeatRow.value}${repeatRow.unit?' '+repeatRow.unit:''}.`
        : repeatBetter
        ? `Repeat ${repeatRow.name} is better — ${repeatRow.value}${repeatRow.unit?' '+repeatRow.unit:''}.`
        : `Repeat ${repeatRow.name} is back — unchanged.`;
    } else {
      const worst = out.labResults.find(l=>l.flag==='CRITICAL') || out.labResults.find(l=>l.flag);
      if(worst) line = `Labs are back — ${worst.name} is ${worst.value}${worst.unit?' '+worst.unit:''}.`;
    }
    if(line && !state.spokenSeen['nurse|' + line]) out.speech.push({speaker:'nurse', text: line});
  }
  // When every matched responder REFUSED (hard gate) and nothing else ran, the
  // default narrative used to fabricate "<Drug> is in — the team watches for a
  // response" in the same breath as the consultant's refusal. Say nothing extra;
  // the elseSpeech tells the story.
  if(!out.narrative) out.narrative = (anyApplied || !out.speech.length)
    ? defaultNarrative(out, state.turnCount, action)
    : 'The team holds off for now.';
  for(const need of pendingGates){
    const hint = unmetGateHint(pack, need, state.flags);
    if(hint && !out.speech.some(sp => sp.text === hint)
            && !state.spokenSeen['nurse|' + hint]) out.speech.push({speaker:'nurse', text:hint});
  }
  for(const sp of out.speech) if(sp.speaker !== 'patient') state.spokenSeen[sp.speaker + '|' + sp.text] = true;
  if(trace){
    trace.satisfiedAfter = state.satisfied.slice().sort((a,b)=>a-b);
    trace.stagesFired = state.stagesFired.slice();
    out._trace = trace;
  }
  if(endedBy){ out.isCaseOver = true; out.debrief = buildDebrief(pack, state, opts, endedBy); }
  return out;
}

// Build a conservative, case-specific scoring pack for a newly AI-authored case.
// It deliberately does NOT invent clinical results or deterioration. It only
// derives narrow responder aliases from the case's own hidden checklist and the
// global order catalog, so an Instant fallback can credit actions deterministically
// without pretending the generated case received a hand-authored pack review.
function buildGeneratedPack(criticalActions, options){
  options = options || {};
  const catalog = Array.isArray(options.catalog) ? options.catalog : [];
  const responders = [];
  const seen = new Set();
  const add = (ca, intent, aliases) => {
    aliases = [...new Set((aliases || []).map(a => String(a || '').trim()).filter(Boolean))];
    if(!aliases.length) return;
    const key = ca + '|' + intent + '|' + aliases.map(normalize).sort().join('|');
    if(seen.has(key)) return;
    seen.add(key);
    responders.push({
      intent: intent || 'assessment',
      match: { any: aliases },
      satisfies: ca,
      speech: [{speaker:'nurse', text:'That case-specific action is documented.'}]
    });
  };
  const cutQualifier = clause => String(clause || '')
    .split(/\b(?:because|given that|since|rather than|so that|in order to)\b/i)[0]
    .replace(/\s+/g, ' ').trim();

  (Array.isArray(criticalActions) ? criticalActions : []).forEach((action, ca) => {
    const actionNorm = normalize(action);
    let specific = 0;
    for(const entry of catalog){
      const canonical = normalize(entry.canonical || entry.label || '');
      if(!canonical) continue;
      const terms = [entry.canonical, entry.label].concat(entry.aliases || [])
        .map(normalize).filter(Boolean);
      const inChecklist = terms.some(term => {
        const tokens = term.split(' ').filter(Boolean);
        return tokens.length <= 6 && fuzzyHas(actionNorm.split(' '), term);
      });
      if(!inChecklist) continue;
      add(ca, entry.category || classifyIntent(canonical),
        [entry.canonical, entry.label].concat(entry.aliases || []));
      specific++;
    }

    // Clause-level aliases cover disposition, history, examination, positioning,
    // and recognition actions that are intentionally absent from the order catalog.
    // Keep the full clause (minus an explanatory tail) so unrelated short orders
    // cannot earn credit through a broad keyword.
    for(const clause of splitClauses(actionNorm)){
      const core = cutQualifier(clause);
      if(!core || core.split(' ').length < 2) continue;
      let intent = classifyIntent(core);
      if(intent === 'other') intent = RECOGNIZE_RE.test(core) ? 'assessment' : 'assessment';
      add(ca, intent, [core]);
    }
    // Absolute fallback: a generated checklist item is never unreachable, but the
    // alias is deliberately the complete item and therefore biased to under-credit.
    if(!responders.some(r => r.satisfies === ca)) add(ca, 'assessment', [actionNorm]);
  });

  return {
    generated: true,
    reviewStatus: 'runtime-derived-unreviewed',
    startState: {}, responders,
    deterioration: {stages: []}
  };
}

root.InstantEngine = { normalize, splitClauses, lev, fuzzyHas, ABBREV,
  PANELS, SOLO_TESTS, IMAGING_STUDIES, EXAM_REGIONS, HISTORY_TOPICS, MINUTES,
  MED_WORDS, PROCEDURE_WORDS, CONSULT_SERVICES,
  classifyIntent, matchResponders, findImaging, findPanel, findSolo,
  RECOGNIZE_RE, ABSTAIN_RE,   // eval harness scores only ACTIONABLE critical actions

  clauseModality, responderModality, matchScore, MODALITY_COMPAT, INTENT_COMPAT,
  effectiveStages, DEFAULT_GRACE, nextStageDeadline, stageAverted, clauseRoutes,
  runTurn, buildDebrief, buildGeneratedPack, diagnosisHead, diagnosisParts, matchesDiagnosis,
  DX_EQUIV, setDxVocab, isBareDiagnosis, ASSESS_FRAME_RE,
  fallbackFor, enforceReadRules, panelRows, resolveOrders, inspectOrders,
  isOrderFragment };   // one definition of "not understood", shared with the app
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.InstantEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
