#!/usr/bin/env python3
"""Keep the CSP script hashes in index.html in step with its inline scripts.

index.html ships a Content-Security-Policy that allows its two inline scripts by
sha256 hash and nothing else — there is no 'unsafe-inline'. So ANY edit to the inline
script, down to one character, invalidates its hash and the browser silently refuses
to run the whole thing. The page loads, the styling is fine, and the app is dead: no
case list, no patient, no monitor, and one console line explaining why.

Run --check after editing index.html, and --fix to rewrite the stale hashes.

    python3 tools/csp-hashes.py --check
    python3 tools/csp-hashes.py --fix
"""

import argparse
import base64
import hashlib
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(REPO, "index.html")

# Inline <script> elements only: a tag carrying src= loads a file, which the CSP
# allows under 'self' and which is not hashed.
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.S)


def script_hashes(html):
    """The sha256-... tokens the browser will require, in document order."""
    return ["sha256-" + base64.b64encode(
        hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode()
        for m in INLINE_SCRIPT.finditer(html)]


def csp_hashes(html):
    meta = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)"', html)
    if not meta:
        return None, []
    return meta.group(1), re.findall(r"'(sha256-[^']+)'", meta.group(1))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fix", action="store_true", help="rewrite stale hashes in place")
    ap.add_argument("--check", action="store_true", help="report only (the default)")
    args = ap.parse_args()

    with open(INDEX, encoding="utf-8") as f:
        html = f.read()

    want = script_hashes(html)
    policy, have = csp_hashes(html)
    if policy is None:
        print("error: no Content-Security-Policy meta tag in index.html", file=sys.stderr)
        return 1

    if want == have:
        print("CSP is in step: %d inline script(s), %d hash(es), all matching"
              % (len(want), len(have)))
        return 0

    print("CSP is STALE — the browser will refuse to run the inline script(s):")
    for i, h in enumerate(want, 1):
        print("  script %d needs %s   %s" % (i, h, "ok" if h in have else "MISSING"))
    for h in have:
        if h not in want:
            print("  policy has  %s   (no script hashes to this any more)" % h)

    if not args.fix:
        print("\nRun with --fix to update them.")
        return 1

    if len(want) != len(have):
        print("\nerror: %d inline script(s) but %d hash(es) in the policy — the count "
              "changed, so fix the meta tag by hand." % (len(want), len(have)),
              file=sys.stderr)
        return 1

    new_policy = policy
    for old, new in zip(have, want):
        new_policy = new_policy.replace("'%s'" % old, "'%s'" % new)
    with open(INDEX, "w", encoding="utf-8") as f:
        f.write(html.replace(policy, new_policy, 1))
    print("\nfixed %d hash(es) in index.html"
          % sum(1 for o, n in zip(have, want) if o != n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
