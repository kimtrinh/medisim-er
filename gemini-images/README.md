# gemini-images — case-faithful patient photos

The sim picks a patient photo from demographics alone. There are six: `young-m`,
`young-f`, `older-m`, `older-f`, `child`, `infant`. So a 44-year-old and a 63-year-old
share one face, a 76-year-old borrows it too, every stabbing gets the same picture, and
`older-m-gsw.jpg` — the "gunshot wound" — is a dry pink dot on the flank with no blood
on it.

This project generates a photo **per case** with Gemini, from that case's own brief: the
stab wound in the groin the case actually names, the seatbelt sign running shoulder to
opposite hip, the crush mark and the traumatic asphyxia, the newborn on a warmer with a
cord stump, the 76-year-old with the senile purpura of a 76-year-old.

First tranche is the 17 course cases: **7 ACLS, 3 ATLS, 4 PALS, 3 NRP**.

## How it works

Every picture is an **edit of the case's own base photo**, never a fresh image. That is
what keeps the framing. The app draws its equipment overlays (ETT, chest tube, pads,
collar…) and its clickable exam regions at fixed pixel coordinates over a 1200x670
frame; a from-scratch image, however good, puts the ET tube on the patient's cheek.
Editing the base returns the same room, the same trolley, the same body in the same
pixels, with only the findings changed.

```
case-shots.json        you edit this — the clinical findings, per case, per view
      │  build_plan.py — composes prompts, checks them against cases-gold.json
      ▼
plan.json + prompts/
      │  mac_capture.py — walks the shots through the Gemini desktop app
      │  generate.py    — or the same prompts through the API, if you have a key
      ▼
downloads/             raw returns, on your machine only (git-ignored)
      │  ← YOU LOOK AT EVERY ONE
      │  install.py    — 1200x670, geometry check, manifest row
      ▼
case-media/<case-id>/bed.jpg   +   case-media/manifest.json   ← the app reads this
```

A case with no entry in `case-media/manifest.json` falls back to the demographic base
photo exactly as before, so this is additive: nothing breaks if you generate nothing.

## Running it — the Gemini desktop app

No API key, no daily quota, and you get to see each picture and argue with it before
accepting it. The one snag is that the app saves files as
`Gemini_Generated_Image_a4f9c2.png`, which says nothing about which case it belongs to,
so `mac_capture.py` does the filing.

```bash
python3 gemini-images/build_plan.py                    # compose + check the prompts
python3 gemini-images/mac_capture.py --course ATLS     # or --only resus-nrp, or all 17
python3 gemini-images/install.py --dry-run
python3 gemini-images/install.py
```

`mac_capture.py` takes one shot at a time: it puts the prompt on your clipboard, reveals
the base photo in Finder so you can drag it in, and then — when you come back and press
Enter — finds whatever new image landed in `~/Downloads` and files it under the right
name with a provenance sidecar. Skip a shot with `s`, stop with `q`; re-run later and it
picks up exactly where you left off.

In the app, for each shot:

1. **Start a new chat every time.** Gemini carries context between turns, and the
   previous case's wounds turn up on the next patient.
2. **Attach the base photo it names** (`patient/older-m.jpg` and so on) before pasting.
   Without it you get a new person in a new room, and `install.py` will refuse it.
3. Paste, send, download the result.

Useful flags: `--watch-dir ~/Desktop` if you save somewhere else, `--move` to take the
file out of Downloads rather than copy it, `--list` to see what is still outstanding.

**Look at every picture before installing it.** These are pictures of injuries generated
by a model; some will be wrong, some will be anatomically silly, and some will come back
refused. Re-roll a bad one — in the app, just ask again in the same chat, then re-run
`mac_capture.py --only <case-id> --force`. If it is wrong the same way twice, the fix is
in `case-shots.json`, not in another re-roll.

Two things the app does that the API does not:

- **It refuses more.** Consumer Gemini is stricter about injury and blood than the API.
  If a trauma shot is refused, say what it is for — a clinical reference photograph for
  an ATLS-style training simulator — rather than rewording the wound.
- **It may hand back a different shape.** `install.py` centre-crops and resizes to
  1200x670, but a square regeneration that has genuinely reframed will trip the room
  drift check and be refused, which is the right outcome.

## Running it — the API instead

If you would rather batch all 17 without babysitting:

1. Get a key at <https://aistudio.google.com/apikey>. Free.
2. `export GEMINI_API_KEY=AIza...`
3. Check which image model your key can reach — Google renames these:
   ```
   python3 gemini-images/generate.py --list-models
   ```
   The default is `gemini-2.5-flash-image`. Pass `--model NAME` to use another.

```bash
python3 gemini-images/generate.py --course ATLS
```

The free tier is metered per day. `generate.py` waits 6s between calls (`--pause`), and
never regenerates a shot that already has a download unless you pass `--force`, so an
interrupted run resumes instead of starting over. Everything downstream is identical —
`install.py` does not care whether the bytes came from the API or from the app.

## What goes in a picture, and what must not

The photo carries what the app **cannot** draw. The app carries everything that changes
during the case. Getting this backwards is the main way to make a picture worse than the
generic one it replaced.

| Baked into the photo | Left to the app |
|---|---|
| Age, build, face, hair | Oxygen mask, ETT, chest tube, central line, defib pads, c-collar (`GEAR` overlays) |
| Wounds, blood, dressings, bruising, deformity | Cyanosis, shock pallor, sweat (`paintPatient`, driven by live vitals) |
| Mottling, jaundice, meconium staining | CPR rescuer, defibrillator discharge (room animations) |
| Clothing, posture, position | ECG leads, BP cuff, SpO₂ probe (already in every base photo) |

Two consequences worth spelling out:

- **Never bake in cyanosis or sweat.** The app tints the photo live from the current
  vitals. Bake it in and the patient stays blue after the learner fixes the hypoxia.
  (`resus-nrp-hypovolemic` is a deliberate exception, noted in its entry: the case turns
  on *white* versus *blue*, a distinction the app's grey shock veil cannot draw.)
- **Never show a treatment the learner is supposed to give.** No tourniquet on the
  stabbed groin, no pelvic binder on the crashed driver, no laryngoscope near the
  meconium baby. Each `avoid` list says which critical action it is protecting.

## Children

Gemini will not draw a real minor. The paediatric bases in this app are already
simulation manikins, which is what a real PALS or NRP lab puts on the trolley, so the
paediatric prompts ask for **a manikin with moulage** — a coin-shaped precordial
contusion for commotio cordis, mottling to the shoulders for the croup case, a barrel
chest with intercostal recession for the asthmatic. `build_plan.py` enforces that any
case landing on `child` or `infant` is marked `"manikin": true`, and that no adult case
is.

Manikin size is specified per case, because "a child" is not a size: 24 kg at seven,
14 kg at three, 6 kg at four months, 3.4 kg at term.

## The checks

`build_plan.py` reads each prompt's own stated age and sex back out of its prose and
compares them with `cases-gold.json`, and re-derives which base photo the app would pick
using a Python port of `patientBaseFor()`. A shot list that has drifted from the cases —
someone edits an age, and the picture is now of the wrong person — fails the build:

```
resus-pals-svt-infant/bed: shot says 0 days, the case says 4 months
```

`install.py` compares the top 24% of each returned picture — wall, poster, glove boxes,
sharps bin, IV pump, never patient — against the base photo it was edited from. Editing
a wound moves that number by 1–3. Reframing or redecorating the room moves it past 30,
and the install is refused, because the overlays would no longer line up:

```
resus-acls-pea-tension__bed  REFUSED — room drift 40.4 (limit 18)
```

Override with `--allow-reframe` only if you have looked at the picture and the framing
really is unchanged.

## Adding a case

Add an entry to `case-shots.json` — `id` must be a real gold case id — then
`build_plan.py`, `generate.py --only <id>`, look, `install.py`. The `shots` key takes
`bed` (the bedside panel, where findings actually read at that scale) and, if you want
them, `room`, `foot` and `airway` for the walkthrough scenes.

## One warning about editing index.html

`index.html` ships a Content-Security-Policy that allows its inline scripts **by sha256
hash** and nothing else. Change one character of the inline script and the browser
refuses to run all 11,000 lines of it: the page still loads and still looks styled, and
the app is completely dead. After any edit:

```
python3 tools/csp-hashes.py --check     # or --fix
```
