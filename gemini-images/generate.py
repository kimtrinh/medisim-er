#!/usr/bin/env python3
"""Generate the case photos with Gemini, into gemini-images/downloads/.

Each shot is an EDIT of the case's own base photo (patient/<base>.jpg), not a fresh
image. That is what keeps the framing: the app draws its equipment overlays and its
clickable exam regions at fixed pixel coordinates over that 1200x670 frame, so a
picture generated from scratch — however good — puts the ET tube on the patient's
cheek. Editing the base returns the same room, the same trolley, the same body in the
same pixels, with only the findings changed.

Standard library only; no pip install.

    export GEMINI_API_KEY=AIza...            # free key: aistudio.google.com/apikey
    python3 gemini-images/generate.py --list-models
    python3 gemini-images/generate.py --course ATLS
    python3 gemini-images/generate.py --only resus-nrp --force

Nothing is overwritten without --force, so an interrupted run resumes where it stopped
and a picture you have already accepted is never silently replaced.
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PLAN = os.path.join(HERE, "plan.json")
DOWNLOADS = os.path.join(HERE, "downloads")

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"

# Gemini's image model ("Nano Banana"). Google renames these, so --list-models asks the
# API what your key can actually reach rather than trusting this default.
DEFAULT_MODEL = "gemini-2.5-flash-image"

RETRY_STATUS = {429, 500, 502, 503, 504}


def die(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


def api_key():
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        die("set GEMINI_API_KEY (a free key takes about a minute: "
            "https://aistudio.google.com/apikey)")
    return key


def request(url, key, payload=None, timeout=180):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("x-goog-api-key", key)
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def request_with_retry(url, key, payload, attempts=4):
    """Retry only what is worth retrying: rate limits and transient server errors.

    A 400 is a bad request and a 403 is a bad key — both come straight back, because
    retrying them just burns the free tier's daily quota.
    """
    delay = 4
    for i in range(attempts):
        try:
            return request(url, key, payload)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code in RETRY_STATUS and i < attempts - 1:
                print("    HTTP %d — retrying in %ds" % (e.code, delay))
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError("HTTP %d: %s" % (e.code, body[:600]))
        except urllib.error.URLError as e:
            if i < attempts - 1:
                print("    %s — retrying in %ds" % (e.reason, delay))
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(str(e.reason))
    raise RuntimeError("unreachable")


def list_models(key):
    out = request(API_ROOT + "/models", key)
    rows = []
    for m in out.get("models", []):
        name = m.get("name", "").replace("models/", "")
        methods = m.get("supportedGenerationMethods", [])
        if "image" in name or "image" in " ".join(m.get("supportedActions", []) or []):
            rows.append((name, ",".join(methods)))
    if not rows:
        print("No image-capable model names found. All models your key can reach:")
        for m in out.get("models", []):
            print("  " + m.get("name", "").replace("models/", ""))
        return
    print("Image-capable models your key can reach:")
    for name, methods in sorted(rows):
        print("  %-40s %s" % (name, methods))


def extract_image(response):
    """Pull the image bytes out of a generateContent response.

    A refusal comes back as a normal 200 with text parts and no image — for medical
    trauma that is a real outcome, not a bug, so the caller is told what was said
    rather than being handed an empty file.
    """
    candidates = response.get("candidates") or []
    if not candidates:
        fb = response.get("promptFeedback") or {}
        return None, "no candidates (promptFeedback: %s)" % json.dumps(fb)[:400]

    cand = candidates[0]
    texts = []
    for part in (cand.get("content") or {}).get("parts") or []:
        blob = part.get("inlineData") or part.get("inline_data")
        if blob and blob.get("data"):
            mime = blob.get("mimeType") or blob.get("mime_type") or "image/png"
            return (base64.b64decode(blob["data"]), mime), None
        if part.get("text"):
            texts.append(part["text"].strip())

    reason = cand.get("finishReason") or "unknown"
    said = " / ".join(texts)[:500] if texts else "(no text returned)"
    return None, "no image — finishReason=%s; model said: %s" % (reason, said)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help="image model (default: %s)" % DEFAULT_MODEL)
    ap.add_argument("--only", metavar="TEXT",
                    help="only shots whose case id contains TEXT")
    ap.add_argument("--course", metavar="NAME",
                    help="only one course: ACLS, ATLS, PALS or NRP")
    ap.add_argument("--force", action="store_true",
                    help="regenerate shots that already have a download")
    ap.add_argument("--limit", type=int, metavar="N", help="stop after N shots")
    ap.add_argument("--pause", type=float, default=6.0, metavar="SECONDS",
                    help="wait between calls (default 6; the free tier is metered)")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be generated, call nothing")
    ap.add_argument("--list-models", action="store_true",
                    help="ask the API which image models this key can reach, then exit")
    args = ap.parse_args()

    if args.list_models:
        list_models(api_key())
        return

    if not os.path.exists(PLAN):
        die("no plan.json — run: python3 gemini-images/build_plan.py")
    with open(PLAN) as f:
        shots = json.load(f)["shots"]

    if args.only:
        shots = [s for s in shots if args.only.lower() in s["case_id"].lower()]
    if args.course:
        shots = [s for s in shots if s["course"].upper() == args.course.upper()]
    if not shots:
        die("no shots match those filters")

    os.makedirs(DOWNLOADS, exist_ok=True)
    url = "%s/models/%s:generateContent" % (API_ROOT, args.model)

    queued, skipped = [], 0
    for shot in shots:
        stem = "%s__%s" % (shot["case_id"], shot["view"])
        if not args.force and any(
                os.path.exists(os.path.join(DOWNLOADS, stem + ext))
                for ext in (".png", ".jpg", ".jpeg", ".webp")):
            skipped += 1
            continue
        queued.append(shot)
    if args.limit:
        queued = queued[:args.limit]

    print("%d shot(s) to generate, %d already downloaded%s"
          % (len(queued), skipped, " (use --force to redo)" if skipped else ""))
    if args.dry_run:
        for shot in queued:
            print("  %-8s %-32s -> downloads/%s__%s.png"
                  % (shot["course"], shot["case_id"], shot["case_id"], shot["view"]))
        return
    if not queued:
        return

    key = api_key()
    ok, failed = 0, []

    for i, shot in enumerate(queued, 1):
        stem = "%s__%s" % (shot["case_id"], shot["view"])
        ref_path = os.path.join(REPO, shot["reference"])
        if not os.path.exists(ref_path):
            failed.append((stem, "reference photo missing: " + shot["reference"]))
            print("[%d/%d] %-40s MISSING REFERENCE" % (i, len(queued), stem))
            continue

        with open(ref_path, "rb") as f:
            ref_bytes = f.read()
        ref_mime = mimetypes.guess_type(ref_path)[0] or "image/jpeg"

        print("[%d/%d] %-40s editing %s" % (i, len(queued), stem, shot["reference"]))

        payload = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": shot["prompt"]},
                    {"inline_data": {"mime_type": ref_mime,
                                     "data": base64.b64encode(ref_bytes).decode()}},
                ],
            }],
        }

        try:
            response = request_with_retry(url, key, payload)
        except RuntimeError as e:
            failed.append((stem, str(e)))
            print("    FAILED: %s" % e)
            continue

        image, why = extract_image(response)
        if not image:
            failed.append((stem, why))
            print("    NO IMAGE: %s" % why)
            continue

        data, mime = image
        ext = {"image/png": ".png", "image/jpeg": ".jpg",
               "image/webp": ".webp"}.get(mime, ".png")
        out = os.path.join(DOWNLOADS, stem + ext)
        with open(out, "wb") as f:
            f.write(data)

        # Sidecar: which prompt and which model made this file. Without it there is no
        # way to tell a picture built from the current shot list from one left over
        # from an older wording.
        with open(os.path.join(DOWNLOADS, stem + ".json"), "w") as f:
            json.dump({
                "case_id": shot["case_id"],
                "view": shot["view"],
                "course": shot["course"],
                "model": args.model,
                "reference": shot["reference"],
                "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "bytes": len(data),
                "prompt": shot["prompt"],
            }, f, indent=1)

        ok += 1
        print("    saved downloads/%s (%.0f KB)" % (os.path.basename(out), len(data) / 1024))

        if i < len(queued) and args.pause > 0:
            time.sleep(args.pause)

    print("\n%d generated, %d failed" % (ok, len(failed)))
    for stem, why in failed:
        print("  %-40s %s" % (stem, why))
    if ok:
        print("\nLook at every picture before installing it:")
        print("  gemini-images/downloads/   then: python3 gemini-images/install.py")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
