# Reads render-report-<typeface>.json and prints, per capture, the changed labels' state, the fonts drawn, and the
# items that wrapped, were clipped or have under 8% spare width, marking which appear only at head.
import json, sys, collections
out = sys.argv[1]
for tf in ["roboto", "liberation-sans"]:
    try: rep = json.load(open(f"{out}/render-report-{tf}.json"))
    except FileNotFoundError: continue
    fonts = collections.Counter()
    by = {(e["page"], e["build"], e["width"]): e for e in rep}
    print(f"=== {tf}")
    for (page, build, w), e in sorted(by.items()):
        for s in e["shots"]:
            for v in s["platformFonts"].values():
                if isinstance(v, list):
                    for f in v: fonts[f.split(" (")[0]] += 1
            bad = [l for l in s["labels"] if l["nameLines"] != 1 or l["nameClipped"] or any(b["lines"] != 1 or b["clipped"] for b in l["badges"])]
            print(f"{page:12} {build} {w:4} {s['tag']:22} labels {len(s['labels']):2} badLabels {len(bad)} fail {len(s['itemFailures']):2} tight {len(s['tight']):2} ov {len(s['overlaps'])} hov {s['horizontalOverflow']} {s.get('replayTime') or ''} {e['errors'] or ''}")
            for l in bad: print("   BAD", l)
    print("fonts", dict(fonts))
    # Items failing or tight at head that base does not have, per page/width (by kind, text).
    for page in sorted({k[0] for k in by}):
        for w in (1280, 390):
            b, h = by.get((page, "base", w)), by.get((page, "head", w))
            if not b or not h: continue
            key = lambda x: (x["kind"], x["text"])
            bf = {key(x) for s in b["shots"] for x in s["itemFailures"]}; hf = {key(x) for s in h["shots"] for x in s["itemFailures"]}
            bt = {key(x) for s in b["shots"] for x in s["tight"]}
            ht = {(key(x), x["spare"], x["need"], x["avail"]) for s in h["shots"] for x in s["tight"]}
            print(f"{page} {w}: failures head-only {sorted(hf - bf)} base-only {sorted(bf - hf)} | failures in both {len(hf & bf)}")
            for t in sorted(ht): print(f"   tight {'NEW ' if t[0] not in bt else ''}{t}")
