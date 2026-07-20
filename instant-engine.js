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
  'us':'ultrasound', 'ruq':'right upper quadrant', 'tvus':'transvaginal ultrasound',
  'fast':'fast exam', 'echo':'echocardiogram', 'tte':'echocardiogram',
  'ivf':'iv fluids', 'ns':'normal saline', 'lr':'lactated ringers', 'd50':'dextrose 50',
  'asa':'aspirin', 'ntg':'nitroglycerin', 'nitro':'nitroglycerin', 'abx':'antibiotics',
  'o2':'oxygen', 'nrb':'non rebreather', 'bipap':'bipap', 'hfnc':'high flow nasal cannula',
  'tylenol':'acetaminophen', 'motrin':'ibuprofen', 'zofran':'ondansetron', 'toradol':'ketorolac',
  'rocephin':'ceftriaxone', 'zosyn':'piperacillin tazobactam', 'vanc':'vancomycin', 'vanco':'vancomycin',
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
  'pocus':'point of care ultrasound', 'cardiogram':'electrocardiogram',
  'ncct':'non contrast computed tomography'
};
// Phrase-level rewrites applied BEFORE tokenization: protect compounds from clause
// splitting ("abdomen and pelvis" must not split at "and") and normalize spellings.
const PHRASES = [
  [/\babd(omen)?\s+and\s+pelvis\b/g, 'abdomen pelvis'],
  [/\bhead\s+and\s+neck\b/g, 'head neck'],
  [/\ba\s*&\s*p\b/g, 'abdomen pelvis'],
  [/\b12\s*[- ]?\s*lead\b/g, '12 lead'],
  [/\bpt\s*\/\s*inr\b/g, 'prothrombin time inr'],
  [/\bt\s*&\s*s\b/g, 'type and screen'],
  [/\bx\s*-?\s*ray\b/g, 'x ray'],
  [/\bu\s*\/\s*a\b/g, 'urinalysis'],
  [/\bblood\s+gas\b/g, 'blood gas'],
  // playtest audit: common spoken forms of studies that never reached their
  // pack responder because no rule mapped them to the canonical wording
  [/\bcat\s+scan\b/g, 'computed tomography'],
  [/\btwelve\s+lead\b/g, '12 lead'],
  [/\bfilms?\b/g, 'x ray'],            // "chest film", "plain film" → x ray
  [/\bradiographs?\b/g, 'x ray'],
  [/\bu\s*\/\s*s\b/g, 'ultrasound'],
  // must run before token expansion: bare "ct" would expand to "computed
  // tomography" and turn a cardiothoracic-surgery consult into a CT order
  [/\bct\s+surgery\b/g, 'cardiothoracic surgery']
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
  s = s.replace(/(?<!\d)\.(?!\d)/g, ' ');              // strip periods but keep decimals (0.4 mg)
  s = s.replace(/[^\w\s/&%.,-]/g, ' ');                // strip remaining punctuation
  for(const [re, rep] of PHRASES) s = s.replace(re, rep);
  // "ct angiography" is what normalize() ITSELF produces from "cta"/"ctpa".
  // Protect it (same join/restore trick as AND_PROTECT below) so that
  // re-normalizing already-normalized text doesn't retokenize it and let the
  // leading "ct" independently re-expand via its OWN separate abbreviation
  // ("ct"->"computed tomography") — which would corrupt "ct angiography
  // chest" (CTA, PE protocol) into "computed tomography angiography chest"
  // (a different, generic CT chest study). Verified: without this,
  // normalize(normalize('cta chest')) !== normalize('cta chest').
  s = s.replace(/\bct angiography\b/g, 'ct&angiography');
  s = s.split(/\s+/).filter(Boolean)
       .map(t => ABBREV[t] || t)
       .join(' ');
  s = s.replace(/ct&angiography/g, 'ct angiography');
  return s.replace(/\s+/g,' ').trim();
}

function splitClauses(normText){
  let s = ' '+normText+' ';
  for(const re of AND_PROTECT) s = s.replace(re, m => m.replace(/ and /g,' & '));
  return s.split(/\s*,\s*|[;\n]| and | then | plus | also /)
          .map(c => c.replace(/ & /g,' and ').trim())
          // restore the placeholders runTurn's dynamic protection writes for
          // pack aliases containing then/plus/also/commas (see rawNorm there)
          .map(c => c.replace(/&(and|then|plus|also)\b/g,'$1').replace(/\s*&comma\s*/g,' , ').trim())
          .map(c => c.replace(/^(and|then|plus|also)\s+/,''))   // ", and X" → "X"
          .filter(c => c.length > 1);
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
function fuzzyHas(tokens, phrase){
  const pts = phrase.split(' ').filter(Boolean);
  return pts.every(pt => tokens.some(ct => {
    if(ct === pt) return true;
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
  'fibrinogen':      {name:'Fibrinogen', value:'320', unit:'mg/dL'}
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
  {aliases:['computed tomography abdomen pelvis','computed tomography abdomen'], title:'CT Abdomen/Pelvis', type:'ct', minutes:35, query:'normal CT abdomen pelvis with contrast', read:'No acute inflammatory change, obstruction, or free air. Solid organs unremarkable. IMPRESSION: No acute abdominopelvic process.'},
  {aliases:['computed tomography chest'], title:'CT Chest', type:'ct', minutes:30, query:'normal CT chest', read:'Lungs clear. No effusion or pneumothorax. Mediastinum normal in caliber. IMPRESSION: No acute chest pathology.'},
  {aliases:['computed tomography cervical spine','computed tomography c spine'], title:'CT Cervical Spine', type:'ct', minutes:25, query:'normal cervical spine CT', read:'No acute fracture or malalignment. IMPRESSION: No acute cervical spine injury.'},
  {aliases:['right upper quadrant ultrasound'], title:'RUQ Ultrasound', type:'us', minutes:20, query:'normal right upper quadrant gallbladder ultrasound', read:'Gallbladder normal in caliber without stones, wall thickening, or pericholecystic fluid. No sonographic Murphy sign. Common bile duct normal caliber. IMPRESSION: No sonographic evidence of cholecystitis or cholelithiasis.'},
  {aliases:['fast exam'], title:'FAST Exam', type:'us', minutes:6, query:'negative FAST exam ultrasound', read:'No free fluid in the hepatorenal, splenorenal, or pelvic views. No pericardial effusion. IMPRESSION: Negative FAST examination.'},
  {aliases:['echocardiogram','bedside echocardiogram'], title:'Bedside Echo', type:'us', minutes:10, query:'normal bedside echocardiogram parasternal long axis', read:'Grossly normal left ventricular systolic function. No pericardial effusion. No right ventricular dilation. IMPRESSION: No acute echocardiographic abnormality.'},
  {aliases:['transvaginal ultrasound','pelvic ultrasound'], title:'Pelvic Ultrasound', type:'us', minutes:25, query:'normal pelvic ultrasound', read:'Uterus and adnexa unremarkable. No adnexal mass or free fluid. Normal ovarian flow bilaterally. IMPRESSION: No acute pelvic abnormality.'},
  {aliases:['renal ultrasound'], title:'Renal Ultrasound', type:'us', minutes:20, query:'normal renal ultrasound', read:'Kidneys normal in size and echogenicity. No hydronephrosis, calculus, or perinephric fluid. IMPRESSION: No acute renal abnormality.'},
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
  {aliases:['pelvic exam','pelvic','genitourinary'], system:'Pelvic/GU', normal:'No external lesions. No cervical motion tenderness, no discharge.'},
  {aliases:['back','flank'], system:'Back/Flank', normal:'No midline spinal tenderness, no CVA tenderness.'}
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
const MEDS_REQUIRING_DOSE = ['epinephrine','heparin','insulin','alteplase','tenecteplase',
  'norepinephrine','amiodarone','adenosine','ketamine','rocuronium','succinylcholine',
  'morphine','fentanyl','hydromorphone','midazolam','lorazepam','vancomycin','dopamine'];

const MED_WORDS = ['aspirin','nitroglycerin','heparin','morphine','fentanyl','ondansetron','ketorolac',
  'acetaminophen','ibuprofen','ceftriaxone','vancomycin','piperacillin','azithromycin','cefepime','meropenem',
  'doxycycline','metronidazole','albuterol','ipratropium','epinephrine','norepinephrine','insulin','dextrose',
  'naloxone','normal saline','lactated ringers','iv fluids','bolus','oxygen','non rebreather','magnesium',
  'potassium','amiodarone','adenosine','diltiazem','metoprolol','labetalol','esmolol','nicardipine',
  'hydralazine','furosemide','lasix','steroids','methylprednisolone','dexamethasone','prednisone',
  'tranexamic','alteplase','tenecteplase','ketamine','midazolam','lorazepam','propofol','etomidate',
  'rocuronium','succinylcholine','antibiotics','tetanus','glucagon','calcium','bicarbonate','octreotide',
  'pantoprazole','famotidine','droperidol','haloperidol','olanzapine'];

const PROCEDURE_WORDS = ['intubate','intubation','central line','arterial line','chest tube','thoracostomy',
  'lumbar puncture','paracentesis','thoracentesis','cardiovert','cardioversion','defibrillate','shock',
  'pace','pacing','cpr','reduce','reduction','splint','suture','foley','ng tube','nasogastric',
  'io access','intraosseous','cricothyrotomy','pericardiocentesis','iv access','second iv','two large bore'];

const CONSULT_WORDS = ['consult','page','call'];
const CONSULT_SERVICES = ['cardiology','surgery','gastroenterology','neurology','neurosurgery','orthopedics',
  'urology','obstetrics','gynecology','psychiatry','nephrology','pulmonology','infectious disease',
  'toxicology','poison control','anesthesia','trauma','interventional radiology','ent',
  'cardiothoracic surgery',
  'social work','adult protective services','child protective services','case management','palliative care'];
// Services that are the same on-call team in practice — "consult OB" must
// reach a responder whose aliases only say "gyn" and vice versa.
const SERVICE_FAMILY = { obstetrics:'obgyn', gynecology:'obgyn' };
// A "get the family out of the room" request, however phrased. Used to bridge
// the player's phrasing ("ask the daughter to step out") to a pack privacy
// responder authored with different words ("ask the son to step out",
// "interview alone") — playtest: guessing the caregiver's relationship wrong
// silently cost the private-interview critical action.
const PRIVACY_RE = /\b(step (out|outside)|in private|privately|alone with|leave the room|clear the room|without (mom|mother|dad|father|the (parents?|family|caregiver|son|daughter))|separate the (family|caregiver|parents?)|speak .* (outside|alone))\b/;
// Word-bounded: 'or ' as a substring classified "monitor the patient" as a
// disposition (and dispositions END the case). Real dispo phrases only.
const DISPO_RE = /\b(admit|discharge|transfer|observation|stepdown)\b|intensive care|operating room|cath lab|to the or\b/;
const ASSESS_WORDS = ['i think','my diagnosis','this is likely','concern for','i suspect','my assessment','working diagnosis','i believe'];
const EXAM_VERBS = ['examine','exam','auscultate','palpate','percuss','inspect','look at','listen to','check','assess','feel'];
const HISTORY_VERBS = ['ask','any ','does she','does he','tell me','when did','how long','what ','where ','has she','has he','do you','history'];

const MINUTES = {history:3, exam:4, lab:18, med:5, procedure:10, consult:10, disposition:5, assessment:2, other:3};

function findImaging(clause){
  const toks = clause.split(' ');
  // longest-alias-first so 'ct angiography chest' beats 'computed tomography chest'
  const sorted = [...IMAGING_STUDIES].sort((a,b)=>b.aliases[0].length - a.aliases[0].length);
  for(const st of sorted) if(st.aliases.some(a=>fuzzyHas(toks,a))) return st;
  return null;
}
function findPanel(clause){
  const toks = clause.split(' ');
  for(const key of Object.keys(PANELS)) if(fuzzyHas(toks,key)) return key;
  return null;
}
function findSolo(clause){
  const toks = clause.split(' ');
  for(const key of Object.keys(SOLO_TESTS)) if(fuzzyHas(toks,key)) return key;
  return null;
}
function classifyIntent(clause){
  const toks = clause.split(' ');
  if(DISPO_RE.test(clause)) return 'disposition';
  if(CONSULT_WORDS.some(w=>toks.includes(w)) && CONSULT_SERVICES.some(s=>fuzzyHas(toks,s))) return 'consult';
  if(ASSESS_WORDS.some(w=>clause.includes(w))) return 'assessment';
  if(findImaging(clause) || clauseModality(clause) || /\bimag(e|ing)\b/.test(clause)) return 'imaging';   // bare "ct scan"/"image the abdomen" is still an imaging order
  if(findPanel(clause) || findSolo(clause) || /\blabs\b|\bbloodwork\b|\blab work\b/.test(clause)) return 'lab';
  if(PROCEDURE_WORDS.some(w=>clause.includes(w))) return 'procedure';
  // Bare service name with no consult verb ("trauma", "neurology") — checked
  // AFTER the study checks, because several services are also the first word
  // of a real study order: "trauma ultrasound" is a FAST exam, not a trauma
  // consult (it was routing to the consult team). Whole-word match only, so
  // the short services can't swallow longer words ('ent' vs "enter the room").
  if(CONSULT_SERVICES.some(s => clause===s || clause.startsWith(s+' '))) return 'consult';
  // exam BEFORE med: an explicit exam verb outranks a fuzzy med-word hit
  if(EXAM_VERBS.some(w=>clause.includes(w))) return 'exam';
  if(MED_WORDS.some(w=>fuzzyHas(toks,w)) || /\b(give|administer|push|hang|start|bolus)\b/.test(clause) || /\d+\s*(mg|mcg|g|units|ml|l)\b/.test(clause)) return 'med';
  if(EXAM_REGIONS.some(r=>r.aliases.some(a=>fuzzyHas(toks,a)))) return 'exam';
  if(clause.includes('?') || HISTORY_VERBS.some(w=>clause.includes(w)) || HISTORY_TOPICS.some(t=>t.aliases.some(a=>fuzzyHas(toks,a)))) return 'history';
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
  if(/electrocardiogram|12 lead/.test(clause)) return 'ekg';
  if(/x ray|skeletal survey|bone survey|fracture survey|babygram|shunt series|skull series|catheter series|obstruction series/.test(clause)) return 'xr';
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
function matchScore(r, toks){
  let best = 0;
  for(const a of ((r.match&&r.match.any)||[])){
    const na = normalize(a); if(!na) continue;
    const parts = na.split(' ');
    if(fuzzyHas(toks, na)) best = Math.max(best, parts.length + na.length/100);
  }
  return best;
}
// Filler tokens that don't change WHAT is being ordered — stripped before
// deciding that a typed clause IS one of a responder's authored aliases.
const FILLER_TOKENS = new Set(['order','obtain','get','send','check','draw','repeat','perform','do','run',
  'please','now','a','an','the','of','for','to','on','in','at','with','and','her','his','their','my',
  'patient','bedside','portable']);
// The clause is essentially one of this responder's own aliases: every alias
// token appears in the clause (the normal match direction) AND every
// non-filler clause token appears in the alias — the player typed what the
// pack authored, give or take order verbs and typos. Such a hit outranks the
// intent/modality heuristics: the classifier guesses, the pack KNOWS.
// (Playtest audit: 506 authored-alias phrasings across 77 cases earned no
// credit because a heuristic gate excluded the very responder whose alias
// matched — "pocus", "cat scan", "chest film", "kub" on a CT-typed responder…)
function strongAliasHit(r, toks){
  const core = toks.filter(t => !FILLER_TOKENS.has(t));
  if(!core.length) return false;
  const corePhrase = core.join(' ');
  for(const a of ((r.match&&r.match.any)||[])){
    const na = normalize(a); if(!na) continue;
    if(fuzzyHas(toks, na) && fuzzyHas(na.split(' '), corePhrase)) return true;
  }
  return false;
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
  const strong = scored.filter(h => strongAliasHit(h.r, toks));
  if(isImaging){
    // imaging order → ONLY imaging content, of a compatible modality, best match only
    let hits = scored.filter(h => responderHasImaging(h.r))
      .filter(h => { if(!mod) return true; const rm = responderModality(h.r);
                     return !rm || (MODALITY_COMPAT[mod]||[mod]).includes(rm); });
    // An exact-alias imaging hit outranks modality inference: a pack often
    // authors one responder for several studies ("kub" on a responder whose
    // stored report is typed ct) — the alias says what the player asked for
    // even when the report's stored type disagrees.
    const strongImg = strong.filter(h => responderHasImaging(h.r));
    if(strongImg.length) hits = strongImg;
    hits.sort((a,b)=>b.s-a.s);
    if(hits.length > 1) hits = [hits[0]];
    // exact-alias NON-imaging matches ride along (a lab/procedure/consult
    // alias that merely LOOKS like imaging: "bladder ultrasound" the PVR lab,
    // "ct surgery" the consult, "push hard and fast" the CPR coaching) —
    // as do stated recognitions, as before.
    const seen = new Set(hits.map(h=>h.r));
    for(const h of strong.concat(scored.filter(x => x.r.intent==='assessment'))){
      if(!responderHasImaging(h.r) && !seen.has(h.r)){ seen.add(h.r); hits.push(h); }
    }
    return hits.map(h=>h.r);
  }
  // non-imaging order → everything that matches EXCEPT imaging-study responders
  // (so "give X" / "examine Y" / "ask Z" never surfaces a stray CT).
  const hits = scored.filter(h => !responderHasImaging(h.r)).map(h=>h.r);
  // …unless the clause IS an authored imaging alias the classifier couldn't
  // recognize as imaging ("pocus", "chest film", "twelve lead", "old tracing"):
  // exact-alias hits reach their imaging responder regardless of intent.
  for(const h of strong) if(responderHasImaging(h.r) && !hits.includes(h.r)) hits.push(h.r);

  // CONSULT bridging: "consult ob emergently" must reach a responder whose
  // aliases say "gyn consult"/"call ob" — the verb and spelling differ but the
  // SERVICE is the same. If the clause names a consult service, include any
  // consult responder that names the same service (or the same on-call family,
  // e.g. OB≈GYN), even when no alias fuzzy-matched. (Playtest: an emergent OB
  // consult in a ruptured ectopic earned zero credit purely on phrasing.)
  if(CONSULT_WORDS.some(w=>toks.includes(w)) || CONSULT_SERVICES.some(s=>norm.startsWith(s))){
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
function catalogAliasList(catalog){
  if(catalog._aliasList) return catalog._aliasList;
  const list = [];
  for(const entry of catalog){
    const canonical = ' '+normalize(entry.canonical)+' ';
    for(const alias of (entry.aliases||[])){
      const na = normalize(alias);
      if(na && na !== entry.canonical) list.push({needle:' '+na+' ', canonical});
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
function applyCatalogAliases(normText, catalog){
  if(!catalog || !catalog.length) return normText;
  let s = ' '+normText+' ';
  for(const {needle, canonical} of catalogAliasList(catalog)) s = s.split(needle).join(canonical);
  return s.trim().replace(/\s+/g,' ');
}
function catalogExactHit(entry, clause){
  const s = ' '+clause+' ';
  for(const alias of [entry.canonical, ...(entry.aliases||[])]){
    const na = normalize(alias);
    if(na && s.includes(' '+na+' ')) return true;
  }
  return false;
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
    const exact = candidates.find(e => catalogExactHit(e, clause));
    if(exact) return {clause, intent, tier:'high', suggestion:{id:exact.id, label:exact.label, canonical:exact.canonical}};
    const best = bestCatalogMatch(candidates, toks);
    if(best) return {clause, intent, tier:'medium', suggestion:{id:best.id, label:best.label, canonical:best.canonical}};
    return {clause, intent, tier:'none', suggestion:null};
  });
}

// ---------- Value generation for generic (fallback) labs ----------
function genValue(row){
  if(row.fixed !== undefined) return row.fixed;
  const v = row.lo + Math.random()*(row.hi - row.lo);
  return v.toFixed(row.dp);
}
function panelRows(key){ return PANELS[key].map(r=>({name:r.name, value:String(genValue(r)), unit:r.unit, flag:''})); }

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
const TREND_RANK = {stable:0, improving:1, worsening:2, critical:3};
function strongerTrend(a, b){ if(!a) return b; if(!b) return a; return TREND_RANK[b] > TREND_RANK[a] ? b : a; }

// ---------- Fallback (no pack responder matched) — NEVER dead-end ----------
function fallbackFor(clause, opts, state, pack){
  const intent = classifyIntent(clause);
  const fb = {intent, labResults:[], diagnosticReports:[], physicalExam:[], speech:[], dosingFlags:[], _minutes:MINUTES[intent]||3};
  const toks = clause.split(' ');
  if(intent === 'lab'){
    if(/\blabs\b|\bbloodwork\b|\blab work\b|\broutine\b/.test(clause) && !findPanel(clause) && !findSolo(clause)){
      fb._routine = true;   // caller composes CBC+BMP (order-only rule), preferring pack rows
    } else {
      const p = findPanel(clause); const s = findSolo(clause);
      if(p) fb.labResults.push(...panelRows(p));
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
    const reg = EXAM_REGIONS.find(r=>r.aliases.some(a=>fuzzyHas(toks,a))) || EXAM_REGIONS[0];
    // Pack-first: if THIS case authored findings for the same region, show
    // those — never the generic normal. Playtest: "examine the child" on an
    // obtunded toddler answered "alert, in no acute distress" (the generic
    // General normal) while the pack's own General finding said obtunded —
    // contradicting the case AND hiding the teaching finding. The generic
    // normals remain the fallback for regions the case says nothing about.
    const want = reg.system.toLowerCase();
    const packExam = pack && (pack.responders||[]).find(r =>
      Array.isArray(r.physicalExam) && !r.gate && r.physicalExam.some(e => {
        const sys = String(e.system||'').toLowerCase();
        return sys===want || sys.includes(want) || want.includes(sys) ||
               sys.slice(0,4)===want.slice(0,4) ||
               ((want==='cardiac'||want==='lungs') && /cardio|pulmonary|chest/.test(sys));
      }));
    if(packExam) fb.physicalExam.push(...packExam.physicalExam);
    else fb.physicalExam.push({system:reg.system, finding:reg.normal});
  } else if(intent === 'history'){
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
        const lines = ['It started like I told you — nothing else has changed since we got here.',
                       'Nothing new since we talked — same story.',
                       '(shakes head) Nothing more to add, honestly.'];
        const i = state ? (state.saidNoNew++) : 0;
        fb.speech.push({speaker:'patient', text: lines[i % lines.length]});
      }
    }
  } else if(intent === 'med'){
    const med = MED_WORDS.find(w=>fuzzyHas(toks,w)) || 'the medication';
    fb.speech.push({speaker:'nurse', text:(med==='the medication'?'That':med.charAt(0).toUpperCase()+med.slice(1))+' is in.'});
    if(MEDS_REQUIRING_DOSE.some(m=>fuzzyHas(toks,m)) && !/\d/.test(clause))
      fb.dosingFlags.push('Medication ordered without a dose/route — specify dose, route, and rate.');
  } else if(intent === 'procedure'){
    fb.speech.push({speaker:'nurse', text:'Done — set up at the bedside and completed without complication.'});
  } else if(intent === 'consult'){
    const svc = CONSULT_SERVICES.find(s=>fuzzyHas(toks,s)) || 'the consultant';
    fb.speech.push({speaker:'consultant', text:`This is ${svc}. I've looked at the chart — what's your assessment, and what specifically do you need from me?`});
  } else if(intent === 'disposition'){
    fb._ends = 'good';
    fb.speech.push({speaker:'nurse', text:'Understood — I\'ll get the paperwork moving.'});
  } else if(intent === 'assessment'){
    fb.speech.push({speaker:'nurse', text:'Noted. What do you want to do next?'});
  } else {
    fb.speech.push({speaker:'nurse', text:'Okay. Anything else you want while we\'re at it?'});
  }
  return fb;
}

// Rotating pools keyed by turn count — deterministic (testable), never the same
// stock phrase two turns running.
function defaultNarrative(out, n){
  const pick = arr => arr[(n||0) % arr.length];
  if(out.diagnosticReports.length){
    const t = out.diagnosticReports.map(d=>d.title).join(', ');
    return pick([t+' — on the chart.', t+' — up on the viewer.', t+' back — images are up.']);
  }
  if(out.labResults.length) return pick(['Results are back and on the chart.','Lab results just posted to the chart.','The lab called — results are up.']);
  if(out.physicalExam.length) return out.physicalExam[0].finding;
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
const ABSTAIN_RE = /^(do not|don'?t|avoid|never|defer|withhold|minimi[sz]e|hold off)\b/i;
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

function buildDebrief(pack, state, opts, outcome){
  const CA = opts.criticalActions || [];
  const total = CA.length || 1;
  const met = state.satisfied.slice().sort((a,b)=>a-b);
  // "Actionable" = the CAs you prove by DOING something (not recognition, not
  // abstinence). The share of those you performed is the evidence that you
  // both recognized the diagnosis and acted on it in time.
  const actionableIdx = CA.map((a,i)=>(!RECOGNIZE_RE.test(a) && !ABSTAIN_RE.test(a)) ? i : null).filter(x=>x!==null);
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
    if(met.includes(i) || !ABSTAIN_RE.test(a)) return null;
    const timeliness = /\b(delay|defer|await|awaiting|wait)\w*\b/i.test(a);
    return (!timeliness || provedByMgmt) ? i : null;
  }).filter(x=>x!==null);
  const recognized = provedByMgmt
    ? CA.map((a,i)=>(!met.includes(i) && RECOGNIZE_RE.test(a)) ? i : null).filter(x=>x!==null)
    : [];
  const metAll = met.concat(abstained, recognized).sort((a,b)=>a-b);
  const metS = metAll.map(i=>CA[i]).filter(Boolean);
  const missedS = CA.filter((a,i)=>!metAll.includes(i));
  let score = Math.round(60*metS.length/total)
            + Math.max(0, 15 - 5*state.stagesFired.length)
            + Math.max(0, 15 - 5*state.dosing)
            + (outcome==='good' ? 10 : 0);
  if(outcome==='death') score = Math.min(score, 35);
  score = Math.max(0, Math.min(100, score));
  const dbf = (pack && pack.debrief) || {};
  const stages = (pack && pack.deterioration && pack.deterioration.stages) || [];
  return {
    outcome: outcome==='death' ? 'The patient died in the ED.'
           : outcome==='good' ? (dbf.outcomeGood || 'Stabilized and dispositioned appropriately.')
           : (dbf.outcomePoor || 'Dispositioned, with significant gaps in care.'),
    score,
    summary: (outcome==='good' ? dbf.goodOutcome : dbf.badOutcome) || 'Case complete.',
    criticalActionsMet: metS,
    criticalActionsMissed: missedS,
    criticalEvents: metAll.map(i=>({event:CA[i],
        feedback: abstained.includes(i) ? 'Correctly avoided — the harmful action was never taken.'
                : recognized.includes(i) ? 'Credited from your management — your workup and treatment fit this diagnosis. Still say your working assessment out loud: committing to it is what aligns the team and it is scored explicitly on the boards.'
                : 'Performed during the case.', type:'positive'}))
      .concat(state.stagesFired.map(i=>({event:(stages[i]&&stages[i].event)||'The patient deteriorated', feedback:(stages[i]&&stages[i].feedback)||'This was preventable with timely intervention.', type:'negative'}))),
    missedOpportunities: (dbf.missedOpportunities||[]).filter((_,i)=>i<4),
    learningPoints: dbf.learningPoints || opts.learningPoints || []
  };
}

// ---------- The turn ----------
// state (MUTATED): {flags:{}, satisfied:[int], stagesFired:[int], dosing:int}
// opts: {vitals, simMin, criticalActions, learningPoints, difficulty}
function runTurn(pack, state, action, opts){
  // Defensive init for fields added after the original state shape shipped.
  state.labsSeen = state.labsSeen || {};
  state.reportsSeen = state.reportsSeen || {};
  state.turnCount = (state.turnCount || 0) + 1;
  state.saidNoNew = state.saidNoNew || 0;
  const out = {narrative:'', speech:[], simMinutes:0,
               updatedVitals:{...opts.vitals}, vitalTrend:'stable',
               labResults:[], diagnosticReports:[], physicalExam:[], dosingFlags:[],
               clinicalRationale:'instant engine — deterministic turn', isCaseOver:false, debrief:{}};
  let minutes = 2, trend = null, targets = {}, endedBy = null, wantRoutine = false;
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
      if(!/ (and|then|plus|also) |,/.test(a)) continue;
      const na = normalize(a);
      // placeholders (&and/&plus/…/&comma) survive splitClauses' separators;
      // splitClauses restores them so the whole-alias clause matches as typed
      if(na && rawNorm.includes(na)) rawNorm = rawNorm.split(na).join(
        na.replace(/ (and|then|plus|also) /g,' &$1 ').replace(/ , /g,' &comma '));
    }
  }
  const rawClauses = splitClauses(rawNorm);
  const clauseList = rawClauses.length ? rawClauses : [rawNorm];
  const hasCatalog = !!(opts.catalog && opts.catalog.length);
  for(const rawClause of clauseList){
    let clause = rawClause;
    let matched = matchResponders(pack, rawClause);
    if(!matched.length && hasCatalog){
      const canon = applyCatalogAliases(rawClause, opts.catalog);
      if(canon !== rawClause){
        const m2 = matchResponders(pack, canon);
        if(m2.length) matched = m2;
        clause = canon;               // canonical form for the match or the fallback
      }
    }
    if(matched.length){
      for(const r0 of matched){
        if(r0.gate){
          const need = r0.gate.requires || [];
          if(!need.every(f=>state.flags[f])){
            if(r0.gate.elseSpeech) out.speech.push(...r0.gate.elseSpeech);
            // HARD gate for information disclosures (history): the info truly
            // cannot be obtained until the prerequisite is met (a private sexual
            // history needs the parent to step out) — don't reveal or credit.
            // SOFT gate for treatments/tests that physically happen regardless
            // and satisfy a critical action: the player DID perform the action,
            // so credit and apply it — the elseSpeech stands as the sequencing
            // caution, and the prerequisite itself is graded as its own critical
            // action. (Fixes: giving vancomycin+clindamycin before cultures still
            // counts as the antibiotics critical action.)
            const softGate = Number.isInteger(r0.satisfies) && r0.intent !== 'history';
            if(!softGate) continue;
          }
        }
        if(r0.setState) Object.assign(state.flags, r0.setState);
        if(Array.isArray(r0.labResults)) out.labResults.push(...r0.labResults);
        if(Array.isArray(r0.diagnosticReports)) out.diagnosticReports.push(...r0.diagnosticReports.map(enforceReadRules));
        if(Array.isArray(r0.physicalExam)) out.physicalExam.push(...r0.physicalExam);
        if(Array.isArray(r0.speech)) out.speech.push(...r0.speech);
        if(r0.narrative) out.narrative += (out.narrative?' ':'') + r0.narrative;
        if(r0.dose && r0.dose.required && !/\d/.test(clause) && r0.dose.flagIfUnspecified) out.dosingFlags.push(r0.dose.flagIfUnspecified);
        if(r0.vitals) Object.assign(targets, r0.vitals);
        if(r0.trend) trend = strongerTrend(trend, r0.trend);
        if(Number.isInteger(r0.satisfies) && !state.satisfied.includes(r0.satisfies)) state.satisfied.push(r0.satisfies);
        if(r0.ends) endedBy = r0.ends === true ? 'good' : r0.ends;
        minutes = Math.max(minutes, r0.minutes || MINUTES[r0.intent] || 3);
      }
    } else {
      const fb = fallbackFor(clause, opts, state, pack);
      out.labResults.push(...fb.labResults);
      out.diagnosticReports.push(...fb.diagnosticReports);
      out.physicalExam.push(...fb.physicalExam);
      out.speech.push(...fb.speech);
      out.dosingFlags.push(...fb.dosingFlags);
      if(fb._routine) wantRoutine = true;
      if(fb._ends) endedBy = endedBy || fb._ends;
      minutes = Math.max(minutes, fb._minutes || 3);
    }
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
  // value drifts ~12% in the bad direction — repeat labs track the patient.
  let repeatRow = null, repeatWorse = false;
  out.labResults = out.labResults.map(l => {
    const seen = state.labsSeen[l.name];
    if(seen === undefined){ state.labsSeen[l.name] = {s: state.stagesFired.length, v: l.value}; return l; }
    let v = seen.v;
    if(state.stagesFired.length > seen.s){
      const num = parseFloat(String(seen.v).replace(/[<>]/g,''));
      if(isFinite(num) && num !== 0){
        const dir = l.flag === 'L' ? -1 : 1;
        v = (num * (1 + 0.12*dir)).toFixed(String(seen.v).includes('.') ? 1 : 0);
        repeatWorse = true;
      }
      state.labsSeen[l.name] = {s: state.stagesFired.length, v};
    }
    repeatRow = {name:l.name, value:String(v), unit:l.unit};
    return {...l, value:String(v), repeat:true};
  });
  // Re-ordered studies replace their old card instead of duplicating it.
  out.diagnosticReports = out.diagnosticReports.map(rep => {
    if(state.reportsSeen[rep.title]) return {...rep, repeat:true};
    state.reportsSeen[rep.title] = true; return rep;
  });
  // One order can legitimately reach the same responder twice (a multi-clause
  // line where both clauses match it, an assessment riding along) — the
  // player must never see the same spoken line or finding twice in one turn.
  out.speech = out.speech.filter((s,i,arr)=>i===arr.findIndex(x=>x.speaker===s.speaker && x.text===s.text));
  out.physicalExam = out.physicalExam.filter((e,i,arr)=>i===arr.findIndex(x=>x.system===e.system && x.finding===e.finding));
  out.simMinutes = minutes;
  // deterioration stages (fire once, unless the guarding critical actions were met)
  const newMin = (opts.simMin||0) + minutes;
  const stages = (pack && pack.deterioration && pack.deterioration.stages) || [];
  stages.forEach((st, i) => {
    if(state.stagesFired.includes(i)) return;
    if(newMin < (st.afterMin||9999)) return;
    const guards = st.unlessMet || [];
    if(guards.length && guards.every(ix=>state.satisfied.includes(ix))) return;  // averted
    state.stagesFired.push(i);
    if(st.vitals) Object.assign(targets, st.vitals);
    trend = strongerTrend(trend, st.trend || 'worsening');
    if(st.nurse) out.speech.push({speaker:'nurse', text:st.nurse});
    if(st.ends) endedBy = st.ends;
  });
  // A disposition always ends the encounter (admit/ICU/OR/transfer/discharge hand off
  // care) — even when a pack responder matched the clause but forgot `ends`.
  if(!endedBy && clauseList.some(c=>classifyIntent(c)==='disposition')) endedBy='good';
  Object.assign(out.updatedVitals, targets);
  out.vitalTrend = trend || 'stable';
  state.dosing += out.dosingFlags.length;
  // WOW: the nurse reads back the worst flagged lab if nobody spoke about results;
  // repeat draws get an explicit unchanged/worse readback.
  if(out.labResults.length && !out.speech.length){
    if(repeatRow && out.labResults.every(l=>l.repeat)){
      out.speech.push({speaker:'nurse', text: repeatWorse
        ? `Repeat ${repeatRow.name} is worse — ${repeatRow.value}${repeatRow.unit?' '+repeatRow.unit:''}.`
        : `Repeat ${repeatRow.name} is back — unchanged.`});
    } else {
      const worst = out.labResults.find(l=>l.flag==='CRITICAL') || out.labResults.find(l=>l.flag);
      if(worst) out.speech.push({speaker:'nurse', text:`Labs are back — ${worst.name} is ${worst.value}${worst.unit?' '+worst.unit:''}.`});
    }
  }
  if(!out.narrative) out.narrative = defaultNarrative(out, state.turnCount);
  if(endedBy){ out.isCaseOver = true; out.debrief = buildDebrief(pack, state, opts, endedBy); }
  return out;
}

root.InstantEngine = { normalize, splitClauses, lev, fuzzyHas, ABBREV,
  PANELS, SOLO_TESTS, IMAGING_STUDIES, EXAM_REGIONS, HISTORY_TOPICS, MINUTES,
  MED_WORDS, PROCEDURE_WORDS, CONSULT_SERVICES,
  classifyIntent, matchResponders, findImaging, findPanel, findSolo,
  clauseModality, responderModality, matchScore, MODALITY_COMPAT, INTENT_COMPAT,
  runTurn, buildDebrief, fallbackFor, enforceReadRules, panelRows, resolveOrders };
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') module.exports = root.InstantEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
