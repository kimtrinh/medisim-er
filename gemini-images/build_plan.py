#!/usr/bin/env python3
"""Compose the Gemini image prompts from case-shots.json, and check them against the cases.

Reads:  gemini-images/case-shots.json  (hand-authored clinical shot list)
        cases-gold.json                (the cases themselves — the source of truth)
Writes: gemini-images/plan.json        (one entry per shot: prompt, reference photo, output path)
        gemini-images/prompts/*.txt    (the same prompts as plain text, to paste into AI Studio by hand)

The checks matter more than the composing. A shot list drifts away from the cases the
moment somebody edits an age in cases-gold.json, and a picture of the wrong age is the
exact bug this project exists to fix — so every shot's stated age and sex is read back
out of its own prompt and compared with the seed, and the run fails if they disagree.

    python3 gemini-images/build_plan.py            # build and check
    python3 gemini-images/build_plan.py --check    # check only, write nothing
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

SHOTS = os.path.join(HERE, "case-shots.json")
GOLD = os.path.join(REPO, "cases-gold.json")
PLAN = os.path.join(HERE, "plan.json")
PROMPT_DIR = os.path.join(HERE, "prompts")

# Where a finished picture is installed for the app to serve. Mirrors case-media/manifest.json.
OUT_REL = "case-media/{case_id}/{view}.jpg"

WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}


def die(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# patientBaseFor(), in Python.
#
# A straight port of the function in index.html (search for "function patientBaseFor").
# It decides which of the six base photos a case gets, and the shot list has to agree
# with it: if a shot says base "young-m" but the app would render "older-m" for that
# patient, the generated picture is installed somewhere the app never looks.
# ---------------------------------------------------------------------------
def patient_base_for(patient):
    sex = patient.get("sex")
    sex = "female" if sex == "female" else ("male" if sex == "male" else None)
    if not sex:
        return "manikin"

    band = str(patient.get("ageBand") or "").lower()
    age_text = (band + " " + str(patient.get("age") or "")).lower()

    if re.search(r"\b(newborn|neonat\w*|infant\w*)\b", age_text):
        return "infant"
    mo = re.search(r"(\d+(?:\.\d+)?)\s*months?\b", age_text)
    if mo:
        return "child" if float(mo.group(1)) >= 12 else "infant"
    if re.search(r"\b(weeks?|days?)\b", age_text):
        return "infant"

    if band not in ("child", "young", "adult", "senior"):
        try:
            yrs = float(patient.get("age"))
        except (TypeError, ValueError):
            return "manikin"
        if yrs < 0:
            return "manikin"
        band = ("infant" if yrs < 1 else "child" if yrs < 13
                else "young" if yrs <= 35 else "adult" if yrs <= 64 else "senior")

    if band == "infant":
        return "infant"
    if band == "child":
        return "child"
    sex_key = "f" if sex == "female" else "m"
    return ("young-" if band == "young" else "older-") + sex_key


def stated_age_years(text):
    """Pull the age the prompt claims, in years, out of its own prose.

    Handles the forms the shot list actually uses: "58-year-old", "4-month-old",
    "term newborn at 39 weeks", "a 7-year-old boy". Returns None when the text
    states no age at all.
    """
    low = text.lower()
    # An explicit number wins over a keyword. The infant SVT shot says "a 4-month-old"
    # and then "Not a newborn" to hold the manikin's size apart from the NRP ones, and
    # a keyword-first reader scored that shot as a newborn.
    m = re.search(r"(\d+(?:\.\d+)?)[\s-]*month[\s-]*old", low)
    if m:
        return float(m.group(1)) / 12.0
    m = re.search(r"(\d+(?:\.\d+)?)[\s-]*year[\s-]*old", low)
    if m:
        return float(m.group(1))
    m = re.search(r"\b(?:aged|age)\s+(\d+(?:\.\d+)?)\b", low)
    if m:
        return float(m.group(1))
    if re.search(r"\bnewborn\b|\bneonat", low):
        return 0.0
    return None


def seed_age_years(patient):
    raw = str(patient.get("age") if patient.get("age") is not None else "").strip()
    low = (raw + " " + str(patient.get("ageBand") or "")).lower()
    m = re.search(r"(\d+(?:\.\d+)?)\s*(day|week|month|year)s?", raw, re.I)
    if m:
        n, unit = float(m.group(1)), m.group(2).lower()
        return n / {"day": 365.0, "week": 52.0, "month": 12.0, "year": 1.0}[unit]
    if re.search(r"\bnewborn\b|\bneonat", low):
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return None


def bullets(lines, marker="- "):
    return "\n".join(marker + line for line in lines)


def compose(shared, case, view, shot):
    """Build one full prompt.

    Order is deliberate. The edit instructions go near the top, where an image model
    weights them most heavily, and the two lists of prohibitions go at the bottom where
    they read as constraints on what was just asked for rather than as subjects in
    their own right — an image model asked for "no tourniquet" first will cheerfully
    paint a tourniquet.
    """
    parts = []
    parts.append(shared["medium"])
    parts.append("")
    parts.append("SUBJECT: " + shot["subject"])
    if shot.get("age_note"):
        parts.append("")
        parts.append("AGE: " + shot["age_note"])
    parts.append("")
    parts.append("MAKE THESE CHANGES, AND ONLY THESE:")
    parts.append(bullets(shot["edits"]))
    parts.append("")
    parts.append("HOLD THE FRAMING EXACTLY:")
    parts.append(bullets(shared["geometry_lock"]))
    parts.append("")
    parts.append("PHOTOGRAPHIC STYLE:")
    parts.append(bullets(shared["style"]))
    parts.append("")
    parts.append("MUST NOT APPEAR IN THIS PICTURE:")
    parts.append(bullets(list(shot.get("avoid", [])) + list(shared["never_render"])))
    parts.append("")
    parts.append(shared["aspect"])
    return "\n".join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="validate only; write nothing")
    args = ap.parse_args()

    with open(SHOTS) as f:
        spec = json.load(f)
    with open(GOLD) as f:
        seeds = {c["id"]: c for c in json.load(f)["cases"]}

    shared = spec["shared"]
    problems = []
    plan = []

    for case in spec["cases"]:
        cid = case["id"]
        seed = seeds.get(cid)
        if not seed:
            problems.append("%s: no such case in cases-gold.json" % cid)
            continue

        patient = seed.get("patient") or {}

        # The base photo the app will actually pick for this patient.
        want_base = patient_base_for(patient)
        if case["base"] != want_base:
            problems.append(
                "%s: shot list says base %r, but patientBaseFor() gives %r for "
                "age=%r sex=%r ageBand=%r"
                % (cid, case["base"], want_base, patient.get("age"),
                   patient.get("sex"), patient.get("ageBand")))

        ref = os.path.join(REPO, "patient", case["base"] + ".jpg")
        if not os.path.exists(ref):
            problems.append("%s: reference photo missing: %s"
                            % (cid, os.path.relpath(ref, REPO)))

        # A manikin case must say so, and an adult case must not: Gemini will not draw
        # a real minor, and the paediatric bases are simulation manikins in the app
        # already, so the two have to stay in step.
        is_paediatric = want_base in ("child", "infant")
        if is_paediatric and not case.get("manikin"):
            problems.append("%s: paediatric base %r must set \"manikin\": true"
                            % (cid, want_base))
        if case.get("manikin") and not is_paediatric:
            problems.append("%s: \"manikin\": true on adult base %r" % (cid, want_base))

        for view, shot in case["shots"].items():
            blob = shot["subject"] + " " + shot.get("age_note", "")

            # Age check.
            said = stated_age_years(blob)
            real = seed_age_years(patient)
            if said is None:
                problems.append("%s/%s: the shot states no age" % (cid, view))
            elif real is None:
                problems.append("%s/%s: the seed has no readable age (%r)"
                                % (cid, view, patient.get("age")))
            else:
                # Tolerance scales with age: half a month for a newborn, a year for an adult.
                tol = 0.05 if real < 1 else max(0.5, real * 0.02)
                if abs(said - real) > tol:
                    problems.append(
                        "%s/%s: shot says %s, the case says %s"
                        % (cid, view, fmt_age(said), fmt_age(real)))

            # Sex check.
            sex = patient.get("sex")
            if sex == "female" and re.search(r"\b(boy|man|male|his|him)\b", blob, re.I):
                problems.append("%s/%s: case patient is female, prompt uses male wording"
                                % (cid, view))
            if sex == "male" and re.search(r"\b(girl|woman|female|her|she)\b", blob, re.I):
                problems.append("%s/%s: case patient is male, prompt uses female wording"
                                % (cid, view))

            if not shot.get("edits"):
                problems.append("%s/%s: no edits listed" % (cid, view))

            plan.append({
                "case_id": cid,
                "course": case["course"],
                "title": case["title"],
                "view": view,
                "base": case["base"],
                "manikin": bool(case.get("manikin")),
                "reference": "patient/%s.jpg" % case["base"],
                "output": OUT_REL.format(case_id=cid, view=view),
                "prompt_file": "gemini-images/prompts/%s__%s.txt" % (cid, view),
                "prompt": compose(shared, case, view, shot),
            })

    if problems:
        print("%d problem(s):\n" % len(problems), file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        sys.exit(1)

    print("checked %d shot(s) across %d case(s) — all agree with cases-gold.json"
          % (len(plan), len(spec["cases"])))

    if args.check:
        return

    os.makedirs(PROMPT_DIR, exist_ok=True)
    for entry in plan:
        with open(os.path.join(REPO, entry["prompt_file"]), "w") as f:
            f.write(entry["prompt"] + "\n")

    with open(PLAN, "w") as f:
        json.dump({
            "_comment": "GENERATED by gemini-images/build_plan.py — do not hand-edit. "
                        "Change gemini-images/case-shots.json and rebuild.",
            "shots": plan,
        }, f, indent=1)
        f.write("\n")

    print("wrote %s and %d prompt file(s) in %s/"
          % (os.path.relpath(PLAN, REPO), len(plan), os.path.relpath(PROMPT_DIR, REPO)))


def fmt_age(years):
    if years < 1 / 12.0:
        return "%d days" % round(years * 365)
    if years < 1:
        return "%d months" % round(years * 12)
    return "%g years" % round(years, 1)


if __name__ == "__main__":
    main()
