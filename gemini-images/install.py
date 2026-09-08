#!/usr/bin/env python3
"""Normalise the downloads to 1200x670 and install them for the app to serve.

    gemini-images/downloads/<case-id>__<view>.png   ->   case-media/<case-id>/<view>.jpg
                                                         case-media/manifest.json

Two things happen here that matter.

Geometry. The app lays its equipment overlays and its clickable exam regions over a
1200x670 frame at fixed pixel coordinates, so anything installed has to be exactly that
size and has to still be the same shot. The size is enforced (centre-crop to 1.791:1,
then resize). Whether it is the same SHOT is checked by comparing the top strip of the
picture — the tiled wall and the equipment on it, where no patient ever appears — with
the base photo it was edited from. A model that reframed, zoomed or redecorated the room
shows up there as a large difference, and this refuses to install it.

Provenance. Every installed picture gets a row in case-media/manifest.json naming the
case, the base photo, the model and the prompt file, so a picture can always be traced
back to the shot list entry that asked for it.

Needs Pillow (pip install Pillow).

    python3 gemini-images/install.py --dry-run
    python3 gemini-images/install.py
    python3 gemini-images/install.py --only resus-atls --allow-reframe
"""

import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PLAN = os.path.join(HERE, "plan.json")
DOWNLOADS = os.path.join(HERE, "downloads")
MEDIA = os.path.join(REPO, "case-media")
MANIFEST = os.path.join(MEDIA, "manifest.json")

TARGET_W, TARGET_H = 1200, 670
JPEG_QUALITY = 88

# How much the room may differ from the base photo before the shot is called reframed.
# Measured as mean absolute 8-bit difference over the top 24% of the frame, which is
# wall, poster, glove boxes, sharps bin and IV pump in every base photo, and is never
# patient. Editing a wound moves this by 1-3; reframing or redecorating moves it past 30.
REFRAME_LIMIT = 18.0
ROOM_STRIP = 0.24


def die(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


try:
    from PIL import Image, ImageChops, ImageStat
except ImportError:
    die("Pillow is needed to install pictures: pip install Pillow")


def to_frame(img):
    """Centre-crop to the target aspect, then resize to exactly 1200x670."""
    img = img.convert("RGB")
    want = TARGET_W / TARGET_H
    w, h = img.size
    have = w / h
    if abs(have - want) > 0.001:
        if have > want:                      # too wide — trim the sides
            new_w = int(round(h * want))
            left = (w - new_w) // 2
            img = img.crop((left, 0, left + new_w, h))
        else:                                # too tall — trim top and bottom
            new_h = int(round(w / want))
            top = (h - new_h) // 2
            img = img.crop((0, top, w, top + new_h))
    if img.size != (TARGET_W, TARGET_H):
        img = img.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    return img


def room_drift(candidate, base_path):
    """Mean absolute difference from the base photo over the room strip at the top."""
    with Image.open(base_path) as base_img:
        base = to_frame(base_img)
    strip = (0, 0, TARGET_W, int(TARGET_H * ROOM_STRIP))
    diff = ImageChops.difference(candidate.crop(strip), base.crop(strip))
    return sum(ImageStat.Stat(diff).mean) / 3.0


def load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            return json.load(f)
    return {"_comment": "", "cases": {}}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", metavar="TEXT", help="only case ids containing TEXT")
    ap.add_argument("--dry-run", action="store_true", help="report, install nothing")
    ap.add_argument("--allow-reframe", action="store_true",
                    help="install even when the room no longer matches the base photo")
    args = ap.parse_args()

    if not os.path.exists(PLAN):
        die("no plan.json — run: python3 gemini-images/build_plan.py")
    with open(PLAN) as f:
        by_stem = {"%s__%s" % (s["case_id"], s["view"]): s
                   for s in json.load(f)["shots"]}

    files = []
    for ext in ("png", "jpg", "jpeg", "webp"):
        files.extend(glob.glob(os.path.join(DOWNLOADS, "*." + ext)))
    if not files:
        die("nothing in gemini-images/downloads/ — run generate.py first")

    manifest = load_manifest()
    installed, skipped, refused = 0, 0, []

    for path in sorted(files):
        stem = os.path.splitext(os.path.basename(path))[0]
        shot = by_stem.get(stem)
        if not shot:
            skipped += 1
            print("%-40s SKIP — not in plan.json" % stem)
            continue
        if args.only and args.only.lower() not in shot["case_id"].lower():
            continue

        base_path = os.path.join(REPO, shot["reference"])
        with Image.open(path) as raw:
            src_size = raw.size
            img = to_frame(raw)

        drift = room_drift(img, base_path)
        note = "room drift %.1f" % drift
        if drift > REFRAME_LIMIT and not args.allow_reframe:
            refused.append((stem, drift))
            print("%-40s REFUSED — %s (limit %.0f): the room no longer matches "
                  "%s, so the overlays will not line up"
                  % (stem, note, REFRAME_LIMIT, shot["reference"]))
            continue

        out_rel = shot["output"]
        out_abs = os.path.join(REPO, out_rel)
        resized = " (was %dx%d)" % src_size if src_size != (TARGET_W, TARGET_H) else ""
        print("%-40s -> %s  %s%s" % (stem, out_rel, note, resized))
        if args.dry_run:
            continue

        os.makedirs(os.path.dirname(out_abs), exist_ok=True)
        img.save(out_abs, "JPEG", quality=JPEG_QUALITY, optimize=True,
                 progressive=True)

        sidecar = os.path.join(DOWNLOADS, stem + ".json")
        model = None
        if os.path.exists(sidecar):
            with open(sidecar) as f:
                model = json.load(f).get("model")

        entry = manifest["cases"].setdefault(shot["case_id"], {})
        entry[shot["view"]] = {
            "file": out_rel,
            "base": shot["reference"],
            "course": shot["course"],
            "title": shot["title"],
            "prompt_file": shot["prompt_file"],
            "model": model,
            "room_drift": round(drift, 2),
        }
        installed += 1

    if args.dry_run:
        print("\ndry run — nothing written")
        return

    if installed:
        manifest["_comment"] = (
            "Case-specific patient photos, generated by the gemini-images project and "
            "installed by gemini-images/install.py — do not hand-edit. index.html reads "
            "this at startup (caseImgFor) and shows cases[<gold case id>].<view> in place "
            "of the demographic base photo. A case with no row here falls back to "
            "patient/<base>.jpg exactly as before.")
        os.makedirs(MEDIA, exist_ok=True)
        with open(MANIFEST, "w") as f:
            json.dump(manifest, f, indent=1, sort_keys=True)
            f.write("\n")

    print("\n%d installed, %d skipped, %d refused" % (installed, skipped, len(refused)))
    for stem, drift in refused:
        print("  %-40s room drift %.1f" % (stem, drift))
    if refused:
        print("\nRegenerate those, or install anyway with --allow-reframe if you have "
              "looked at them and the framing is in fact unchanged.")
        sys.exit(1)


if __name__ == "__main__":
    main()
