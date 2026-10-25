#!/usr/bin/env python3
"""
The judging pass: statistics propose links, something that can read decides.

The Maybe layer is three kinds of guess — notes that share two topics but never
link (Suggested), passages that sound alike across topics (Resonance), and
passages that sound the same (Echo). Every one of them is a measurement, and
none of them can tell a real connection from a coincidence of register. On
2026-10-25, 191 of the 217 Echo pairs were two journal entries that read alike
because days do, and the one genuine duplicate in the vault — one journal entry
transcribed twice — was not among them, because the two
copies differed in a few words and an embedding never noticed.

So the work is split. This file finds candidates, cheaply and permissively, and
writes what a judge decided to `judgements.json` beside the index. The plugin
honours that file — `no` hides a pair, `duplicate` draws it as Echo, `link`
keeps it with the reason on its card — and the MCP server does the same.

The judge is whoever runs it. An assistant session reads the candidates and
writes verdicts (in the author's setup, a `tend-links` skill does this); `auto` hands them to a local model instead.
A verdict is pinned to the content hashes of both pages and is dropped as soon
as either changes, so an edited note is judged again rather than trusted.

    judge.py candidates [--out FILE]   pairs that need a verdict, as JSON
    judge.py apply FILE                merge [{key, v, why}] into judgements.json
    judge.py auto [--model M] [--limit N]
    judge.py status
"""

import argparse
import base64
import datetime
import json
import math
import os
import re
import struct
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import indexer  # noqa: E402

JUDGEMENTS = os.path.join(indexer.PLUGIN, "judgements.json")
VERDICTS = ("duplicate", "link", "no")
# Two pages share this much of their own wording (not the vault's templates)
# and it is the same text twice, whatever the embeddings say.
SAME_WORDS = 0.5
SHINGLE = 6

# Exactly the plugin's rules, so the candidates are the pairs the graph draws.
# The values come from `indexer.semantic_settings()`; these are only the keys.
DEFAULTS = ("k", "floor", "echoAt")
ECHO_COVERAGE = 0.5


# -------------------------------------------------------------------- store


def load_judgements():
    try:
        raw = json.loads(indexer.read_exact(JUDGEMENTS))
        return raw.get("pairs") or {}
    except (OSError, ValueError):
        return {}


def save_judgements(pairs):
    tmp = f"{JUDGEMENTS}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        json.dump({"version": 1, "pairs": dict(sorted(pairs.items()))}, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, JUDGEMENTS)


def pair_key(a, b):
    return f"{a}|{b}" if a < b else f"{b}|{a}"


def current(pairs, entries):
    """Only the verdicts whose two pages are still exactly what was judged."""
    out = {}
    for key, verdict in pairs.items():
        a, b = key.split("|", 1)
        ha, hb = (entries.get(a) or {}).get("c"), (entries.get(b) or {}).get("c")
        if ha is not None and hb is not None and verdict.get("h") == [ha, hb]:
            out[key] = verdict
    return out


# ------------------------------------------------------------------- vault


def plugin_data():
    try:
        return json.loads(indexer.read_exact(indexer.DATA_PATH))
    except (OSError, ValueError):
        return {}


def front(raw):
    m = re.match(r"^---\r?\n(.*?)\r?\n---", raw, re.S)
    return m.group(1) if m else ""


def field(fm, name):
    m = re.search(rf"^{name}:\s*(.*)$", fm, re.M)
    return m.group(1).strip().strip("\"'") if m else ""


def listed(fm, name):
    m = re.search(rf"^{name}:\s*\n((?:\s+-.*\n?)+)", fm, re.M)
    items = re.findall(r"^\s+-\s*(.+)$", m.group(1), re.M) if m else []
    inline = field(fm, name)
    if inline.startswith("["):
        items += [x.strip() for x in inline.strip("[]").split(",") if x.strip()]
    return [re.sub(r"^\[\[|\]\]$", "", x.strip().strip("\"'")) for x in items]


def pages():
    """Every page the graph draws as a note, with what a judge needs to read it."""
    out = {}
    for doc in indexer.vault_docs():
        key = doc["key"]
        # The graph's own exclusions: Library, Archive and Inbox are searched,
        # never drawn, and loose files at the root are unfiled.
        if key.startswith(("Library/", "Archive/", "Inbox/")) or "/" not in key:
            continue
        raw = doc["text"]
        fm = front(raw)
        out[key] = {
            "title": doc["title"],
            "origin": field(fm, "origin"),
            "horizon": field(fm, "horizon"),
            "captured": field(fm, "captured"),
            "topics": listed(fm, "topics"),
            "body": indexer.body_of(raw),
        }
    return out


def wikilinks(info):
    by_stem = {os.path.basename(k)[:-3]: k for k in info}
    linked = set()
    for key, page in info.items():
        for m in re.finditer(r"\[\[([^\]|#]+)", page["body"]):
            other = by_stem.get(m.group(1).strip())
            if other and other != key:
                linked.add(pair_key(key, other))
    return linked


# --------------------------------------------------------------- candidates


def vectors(entries, keys):
    out = {}
    for key in keys:
        segs = (entries.get(key) or {}).get("segs") or []
        vecs = []
        for seg in segs:
            blob = base64.b64decode(seg["v"])
            vecs.append(struct.unpack(f"<{len(blob) // 4}f", blob))
        if vecs:
            out[key] = vecs
    return out


def dot(a, b):
    return math.sumprod(a, b) if hasattr(math, "sumprod") else sum(x * y for x, y in zip(a, b))


def semantic_pairs(vecs, situational, explained, settings):
    """The plugin's mutual-k-nearest pass, rule for rule (semantic.ts buildEdges)."""
    ids = sorted(vecs)
    n = len(ids)
    tau = min(settings["echoAt"] - 0.06, 0.85)
    best, cover, at = {}, {}, {}
    for i in range(n):
        va = vecs[ids[i]]
        for j in range(i + 1, n):
            vb = vecs[ids[j]]
            score, hit_b, hits_a, where = -1.0, [False] * len(vb), 0, (0, 0)
            for x, a in enumerate(va):
                row_best = -1.0
                for y, b in enumerate(vb):
                    s = dot(a, b)
                    if s > row_best:
                        row_best = s
                    if s >= tau:
                        hit_b[y] = True
                    if s > score:
                        score, where = s, (x, y)
                if row_best >= tau:
                    hits_a += 1
            best[(i, j)] = score
            if score >= settings["floor"]:
                cover[(i, j)] = min(hits_a / len(va), sum(hit_b) / len(vb))
                at[(i, j)] = where
    near = []
    for i in range(n):
        row = []
        for j in range(n):
            if i == j:
                continue
            s = best[(min(i, j), max(i, j))]
            if s < settings["floor"] or (ids[i] in situational and ids[j] in situational):
                continue
            row.append((s, j))
        row.sort(reverse=True)
        near.append({j for _s, j in row[: settings["k"]]})
    out = {}
    for i in range(n):
        for j in near[i]:
            if j < i or i not in near[j]:
                continue
            s = best[(i, j)]
            cov = cover.get((i, j), 0.0)
            echo = s >= settings["echoAt"] and cov >= ECHO_COVERAGE
            key = pair_key(ids[i], ids[j])
            if not echo and key in explained:
                continue
            x, y = at.get((i, j), (0, 0))
            a, b = (ids[i], ids[j]) if ids[i] < ids[j] else (ids[j], ids[i])
            xa, yb = (x, y) if ids[i] < ids[j] else (y, x)
            out[key] = {"layer": "echo" if echo else "resonance", "similarity": round(s, 3),
                        "coverage": round(cov, 2), "at": [xa, yb]}
    return out


def shingles(text, boiler):
    lines = [ln for ln in text.split("\n") if indexer.boiler_norm(ln) not in boiler]
    words = re.findall(r"\w+", re.sub(r"!\[\[[^\]]*\]\]", " ", "\n".join(lines)).lower())
    return {tuple(words[i:i + SHINGLE]) for i in range(max(0, len(words) - SHINGLE + 1))}


def same_words(info, boiler):
    """Pairs where most of one page's own wording is in the other — duplicates by text."""
    sh = {k: shingles(p["body"], boiler) for k, p in info.items()}
    owners = {}
    for key, grams in sh.items():
        for g in grams:
            owners.setdefault(g, []).append(key)
    shared = {}
    for g, keys in owners.items():
        if 1 < len(keys) <= 5:   # in more pages than that, it is a phrase, not a copy
            for i in range(len(keys)):
                for j in range(i + 1, len(keys)):
                    k = pair_key(keys[i], keys[j])
                    shared[k] = shared.get(k, 0) + 1
    out = {}
    for key, n in shared.items():
        a, b = key.split("|", 1)
        smaller = min(len(sh[a]), len(sh[b])) or 1
        if n / smaller >= SAME_WORDS:
            out[key] = round(n / smaller, 2)
    return out


def suggested_pairs(info, linked, situational):
    """Shared two or more topics and no link either way — model.ts suggestLinks."""
    by_topic = {}
    for key, page in info.items():
        if not key.startswith("Notes/"):
            continue
        for t in page["topics"]:
            by_topic.setdefault(t, []).append(key)
    shared = {}
    for group in by_topic.values():
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                k = pair_key(group[i], group[j])
                shared[k] = shared.get(k, 0) + 1
    out = set()
    for key, n in shared.items():
        a, b = key.split("|", 1)
        if n >= 2 and key not in linked and not (a in situational and b in situational):
            out.add(key)
    return out


def excerpt(text, limit):
    text = re.sub(r"!\[\[[^\]]*\]\]", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + " …"


def candidates():
    index = indexer.load_index()
    entries = index.get("entries", {})
    _rev, boiler = indexer.load_boilerplate()
    data = plugin_data()
    sem = indexer.semantic_settings()
    settings = {k: sem[k] for k in DEFAULTS}
    dismissed = set(data.get("dismissed") or [])

    info = pages()
    situational = {k for k, p in info.items() if p["horizon"] == "situational"}
    linked = wikilinks(info)
    suggested = suggested_pairs(info, linked, situational)
    sem = semantic_pairs(vectors(entries, info), situational, linked | suggested, settings)
    words = same_words(info, boiler)

    judged = current(load_judgements(), entries)
    keys = (set(sem) | suggested | set(words)) - dismissed - set(judged)

    out = []
    for key in sorted(keys):
        a, b = key.split("|", 1)
        if a not in info or b not in info:
            continue
        found = sem.get(key, {})
        layers = ([found["layer"]] if found else []) + (["suggested"] if key in suggested else []) \
            + (["same-words"] if key in words else [])
        sides = []
        for side, path in enumerate((a, b)):
            page = info[path]
            segs = (entries.get(path) or {}).get("segs") or []
            matched = ""
            if found and segs:
                seg = segs[min(found["at"][side], len(segs) - 1)]
                matched = (f"[{seg['h']}] " if seg.get("h") else "") + seg.get("p", "")
            sides.append({
                "path": path, "title": page["title"], "origin": page["origin"],
                "horizon": page["horizon"], "captured": page["captured"], "topics": page["topics"],
                "opening": excerpt(page["body"], 700), "matched": matched,
            })
        out.append({"key": key, "found_by": layers, "similarity": found.get("similarity"),
                    "coverage": found.get("coverage"), "shared_words": words.get(key),
                    "a": sides[0], "b": sides[1]})
    return out, judged, entries


# ------------------------------------------------------------------- verdicts


def apply(verdicts, by):
    index = indexer.load_index()
    entries = index.get("entries", {})
    pairs = current(load_judgements(), entries)
    today = datetime.date.today().isoformat()
    written = 0
    for item in verdicts:
        key, v = item.get("key"), item.get("v")
        if v not in VERDICTS or not key or "|" not in key:
            raise SystemExit(f"not a verdict: {item}")
        a, b = key.split("|", 1)
        key = pair_key(a, b)
        ha, hb = (entries.get(min(a, b)) or {}).get("c"), (entries.get(max(a, b)) or {}).get("c")
        if ha is None or hb is None:
            print(f"skipped, not in the index: {key}", file=sys.stderr)
            continue
        pairs[key] = {"v": v, "why": (item.get("why") or "").strip(), "h": [ha, hb], "by": by, "at": today}
        written += 1
    save_judgements(pairs)
    return written, len(pairs)


PROMPT = """You are judging whether two pages in a personal knowledge vault should be connected.
The owner may write in several languages. Journals are dated entries; atoms are single ideas.

Answer with one of:
- "duplicate": the same text or the same idea written twice — one should absorb the other.
- "link": a reader of one would genuinely benefit from being sent to the other. Name the actual
  connection in one plain sentence (what the second adds to the first), not "both are about X".
- "no": they only sound alike — same author, same template, same register, a shared broad
  subject. Most candidates are this. Two different days are not linked by being days.

Reply as JSON: {"v": "duplicate"|"link"|"no", "why": "<one sentence>"}"""


def render(c):
    def side(s):
        return (f"{s['title']} ({s['origin'] or 'no origin'}, {s['horizon'] or 'no horizon'}, "
                f"{s['captured']}; topics: {', '.join(s['topics']) or 'none'})\n"
                + (f"Matched passage: {s['matched']}\n" if s["matched"] else "")
                + f"Opening:\n{s['opening']}")
    return f"A — {side(c['a'])}\n\nB — {side(c['b'])}"


def auto(model, limit):
    host, _ = indexer.settings()
    found, _j, _e = candidates()
    found = found[:limit] if limit else found
    verdicts = []
    for i, c in enumerate(found, 1):
        body = json.dumps({"model": model, "stream": False, "format": "json", "think": False,
                           "messages": [{"role": "system", "content": PROMPT},
                                        {"role": "user", "content": render(c)}]}).encode()
        req = urllib.request.Request(f"{host}/api/chat", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as res:
            reply = json.loads(json.loads(res.read())["message"]["content"])
        if reply.get("v") in VERDICTS:
            verdicts.append({"key": c["key"], "v": reply["v"], "why": reply.get("why", "")})
        print(f"{i}/{len(found)} {reply.get('v')}: {c['key']}", file=sys.stderr)
    return apply(verdicts, model)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("candidates")
    c.add_argument("--out")
    a = sub.add_parser("apply")
    a.add_argument("file")
    a.add_argument("--by", default="claude")
    au = sub.add_parser("auto")
    au.add_argument("--model", default="qwen3:14b")
    au.add_argument("--limit", type=int)
    sub.add_parser("status")
    args = ap.parse_args()

    if args.cmd == "candidates":
        found, judged, _e = candidates()
        text = json.dumps(found, ensure_ascii=False, indent=1)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
        else:
            print(text)
        print(f"{len(found)} pairs need a verdict; {len(judged)} verdicts still current.", file=sys.stderr)
    elif args.cmd == "apply":
        with open(args.file, encoding="utf-8") as fh:
            written, total = apply(json.load(fh), args.by)
        print(f"wrote {written} verdicts; {total} current in {JUDGEMENTS}")
    elif args.cmd == "auto":
        written, total = auto(args.model, args.limit)
        print(f"wrote {written} verdicts; {total} current")
    elif args.cmd == "status":
        entries = indexer.load_index().get("entries", {})
        stored = load_judgements()
        live = current(stored, entries)
        counts = {}
        for v in live.values():
            counts[v["v"]] = counts.get(v["v"], 0) + 1
        print(f"{len(live)} current verdicts {counts}; {len(stored) - len(live)} gone stale")


if __name__ == "__main__":
    main()
