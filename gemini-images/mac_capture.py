#!/usr/bin/env python3
"""Drive the Gemini desktop app through the shot list, one picture at a time.

The app is a nicer way to make these than the API — you can see the result, argue with
it, and re-roll — but it saves files as Gemini_Generated_Image_a4f9c2.png, which says
nothing about which case it belongs to. This walks the pending shots, puts each prompt
on the clipboard, reveals the base photo to drag in, and then files whatever new image
turned up in ~/Downloads under the right name.

    python3 gemini-images/mac_capture.py                 # every pending shot
    python3 gemini-images/mac_capture.py --course ATLS   # or --only resus-nrp
    python3 gemini-images/mac_capture.py --list          # what is still outstanding

Per shot: paste into a NEW Gemini chat, attach the base photo it names, send, download
the result, come back and press Enter. Then install as usual:

    python3 gemini-images/install.py

macOS only in the conveniences (pbcopy, Finder reveal); it still works elsewhere, it
just prints the prompt instead of copying it.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PLAN = os.path.join(HERE, "plan.json")
DOWNLOADS = os.path.join(HERE, "downloads")

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
DONE_EXTS = IMAGE_EXTS


def die(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


def have(cmd):
    return shutil.which(cmd) is not None


def to_clipboard(text):
    if not have("pbcopy"):
        return False
    p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
    p.communicate(text.encode("utf-8"))
    return p.returncode == 0


def reveal(path):
    """Show the file in Finder so it can be dragged into the chat."""
    if have("open"):
        subprocess.run(["open", "-R", path], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def images_in(directory):
    """Image files in a directory, with their modification times."""
    out = {}
    try:
        for name in os.listdir(directory):
            if name.startswith("."):
                continue
            if name.lower().endswith(IMAGE_EXTS):
                full = os.path.join(directory, name)
                try:
                    out[full] = os.path.getmtime(full)
                except OSError:
                    pass
    except FileNotFoundError:
        die("no such folder: " + directory)
    return out


def settled(path, tries=10):
    """Wait until a file stops growing, so a part-written download is not copied."""
    last = -1
    for _ in range(tries):
        try:
            size = os.path.getsize(path)
        except OSError:
            return False
        if size == last and size > 0:
            return True
        last = size
        time.sleep(0.3)
    return True


def already_done(shot):
    stem = "%s__%s" % (shot["case_id"], shot["view"])
    return any(os.path.exists(os.path.join(DOWNLOADS, stem + e)) for e in DONE_EXTS)


def ask(prompt):
    try:
        return input(prompt).strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return "q"


def capture_one(shot, watch_dir, move):
    """Run one shot end to end. Returns 'saved', 'skipped' or 'quit'."""
    stem = "%s__%s" % (shot["case_id"], shot["view"])
    base_abs = os.path.join(REPO, shot["reference"])

    print("\n" + "=" * 78)
    print("%s  %s" % (shot["course"], shot["title"]))
    print("%s   ->  downloads/%s.png" % (shot["case_id"], stem))
    print("=" * 78)
    print("  1. New chat in Gemini (a fresh one each time — old context leaks in).")
    print("  2. Attach this photo:  %s" % shot["reference"])
    print("  3. Paste the prompt%s and send." %
          (" (already on your clipboard)" if to_clipboard(shot["prompt"]) else
           " from " + shot["prompt_file"]))
    print("  4. Download the image, then come back here.")
    reveal(base_abs)

    before = images_in(watch_dir)
    t0 = time.time()

    while True:
        answer = ask("\n[Enter] I've downloaded it   [s] skip   [p] print prompt   [q] quit  > ")
        if answer == "q":
            return "quit"
        if answer == "s":
            print("  skipped — run again later to pick it up")
            return "skipped"
        if answer == "p":
            print("\n" + "-" * 78 + "\n" + shot["prompt"] + "\n" + "-" * 78)
            continue

        now = images_in(watch_dir)
        fresh = [p for p, m in now.items() if p not in before or m > before.get(p, 0)]
        fresh = [p for p in fresh if os.path.getmtime(p) >= t0 - 1]
        fresh.sort(key=os.path.getmtime, reverse=True)

        if not fresh:
            print("  nothing new in %s since we started." % watch_dir)
            print("  Save the image there (or pass --watch-dir), then press Enter again.")
            continue

        chosen = fresh[0]
        if len(fresh) > 1:
            print("  %d new images — which one?" % len(fresh))
            for i, p in enumerate(fresh[:9], 1):
                print("    %d. %s" % (i, os.path.basename(p)))
            pick = ask("  number (Enter for 1) > ")
            if pick.isdigit() and 1 <= int(pick) <= len(fresh[:9]):
                chosen = fresh[int(pick) - 1]

        settled(chosen)
        ext = os.path.splitext(chosen)[1].lower()
        dest = os.path.join(DOWNLOADS, stem + ext)
        os.makedirs(DOWNLOADS, exist_ok=True)
        (shutil.move if move else shutil.copy2)(chosen, dest)

        with open(os.path.join(DOWNLOADS, stem + ".json"), "w") as f:
            json.dump({
                "case_id": shot["case_id"],
                "view": shot["view"],
                "course": shot["course"],
                "model": "gemini-app",
                "source_file": os.path.basename(chosen),
                "reference": shot["reference"],
                "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "prompt": shot["prompt"],
            }, f, indent=1)

        print("  saved downloads/%s  (from %s)"
              % (os.path.basename(dest), os.path.basename(chosen)))
        return "saved"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", metavar="TEXT", help="only case ids containing TEXT")
    ap.add_argument("--course", metavar="NAME", help="ACLS, ATLS, PALS or NRP")
    ap.add_argument("--watch-dir", default=os.path.expanduser("~/Downloads"),
                    metavar="DIR", help="where the app saves (default ~/Downloads)")
    ap.add_argument("--move", action="store_true",
                    help="move the file out of the watch folder instead of copying it")
    ap.add_argument("--force", action="store_true",
                    help="include shots that already have a download")
    ap.add_argument("--list", action="store_true", help="list pending shots and exit")
    args = ap.parse_args()

    if not os.path.exists(PLAN):
        die("no plan.json — run: python3 gemini-images/build_plan.py")
    with open(PLAN) as f:
        shots = json.load(f)["shots"]

    if args.only:
        shots = [s for s in shots if args.only.lower() in s["case_id"].lower()]
    if args.course:
        shots = [s for s in shots if s["course"].upper() == args.course.upper()]
    if not args.force:
        shots = [s for s in shots if not already_done(s)]

    if not shots:
        print("nothing pending — every matching shot already has a download "
              "(--force to redo)")
        return

    if args.list:
        print("%d pending:" % len(shots))
        for s in shots:
            print("  %-6s %-32s attach %s" % (s["course"], s["case_id"], s["reference"]))
        return

    print("%d shot(s) to capture. Watching %s" % (len(shots), args.watch_dir))
    if not have("pbcopy"):
        print("(no pbcopy — prompts will be printed instead of copied)")

    tally = {"saved": 0, "skipped": 0}
    for shot in shots:
        result = capture_one(shot, args.watch_dir, args.move)
        if result == "quit":
            break
        tally[result] += 1

    print("\n%d captured, %d skipped" % (tally["saved"], tally["skipped"]))
    if tally["saved"]:
        print("\nLook at them in gemini-images/downloads/, then:")
        print("  python3 gemini-images/install.py --dry-run")
        print("  python3 gemini-images/install.py")


if __name__ == "__main__":
    main()
