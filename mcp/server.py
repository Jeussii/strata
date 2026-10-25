#!/usr/bin/env python3
"""
Strata retrieval — the vault as a source an LLM can query instead of read.

Reading a whole notes folder costs six figures of tokens, every session,
forever. Eight retrieved passages cost a couple of thousand. That ~50x is the
entire point of this file: an assistant pointed at a vault should cite it
rather than skim it.

Three tools, because the shape wanted is a loop and not a lookup:

    search      find a door      — semantic, returns passages, not answers
    neighbours  see the corridors — what a page connects to, on every layer
    get         open one room     — full text, once something looks worth it

There is deliberately no `topic` tool. A topic page *is* a node and the notes
filed under it are one edge away, so `neighbours` already answers "everything
about X" — a separate tool would be a second way to ask the same question.

Design notes worth keeping:

  - **It does not need Obsidian running.** The index is read off disk. Strata
    writes it; this only ever reads. You can work in a terminal with Obsidian
    shut, and a retrieval tool that needs a GUI open is not a retrieval tool.
  - **It reports the index's age.** With Obsidian closed the index is as fresh
    as the last time the plugin ran, and stale results served silently are
    worse than stale results served honestly.
  - **Query vectors are embedded exactly as the documents were**, with the
    model's own prefix from `indexer.PROFILES` (nomic wants `clustering:`,
    bge-m3 wants none). Matching the document side matters more than using a
    notionally-correct query prefix.
  - **No dependencies.** stdlib only, so there is no venv to rot and nothing to
    reinstall in a year.
"""

import base64
import json
import math
import os
import re
import socket
import struct
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
# Configured, not discovered. STRATA_ROOT is the container the two vaults sit
# in side by side; STRATA_VAULT and STRATA_WORK override either one on its own.
#
# With none of them set the first of these that actually holds a vault is
# used — a convenience for a single-machine setup, not a search of the disk.
CANDIDATES = ("Obsidian", "OS", os.path.join("Documents", "Obsidian"))


def _root() -> str:
    env = os.environ.get("STRATA_ROOT")
    if env:
        return env
    for name in CANDIDATES:
        candidate = os.path.join(HOME, name)
        if os.path.isdir(os.path.join(candidate, "Vault")):
            return candidate
    return os.path.join(HOME, CANDIDATES[0])


OS_ROOT = _root()
VAULT = os.environ.get("STRATA_VAULT") or os.path.join(OS_ROOT, "Vault")
WORK = os.environ.get("STRATA_WORK") or os.path.join(OS_ROOT, "Work")
INDEX_PATH = os.path.join(VAULT, ".obsidian", "plugins", "strata", "semantic-index.json")
DATA_PATH = os.path.join(VAULT, ".obsidian", "plugins", "strata", "data.json")
OLLAMA = os.environ.get("STRATA_OLLAMA", "http://127.0.0.1:11434")

# Matches how Strata embeds a passage; the model's own prefix comes from
# indexer.PROFILES, so a query lands in the same space as the documents.
SEG_CHARS = 1800

# Token discipline. The loop runs several times per question, so a call that
# dumps forty neighbours costs more than reading the vault would have.
MAX_HITS = 20
DEFAULT_HITS = 8
MAX_NEIGHBOURS_PER_LAYER = 12
MAX_PASSAGE_CHARS = 1600
MAX_GET_CHARS = 20000


# --------------------------------------------------------------------- index


class Index:
    """The vectors, and the vault structure they sit in. Loaded once, lazily."""

    def __init__(self):
        self.loaded_at = 0.0
        self.index_mtime = 0.0
        self.model = ""
        self.paths = []          # parallel arrays, one entry per passage
        self.vectors = []
        self.headings = []
        self.previews = []
        self.by_path = {}        # path -> list of passage indices
        self.meta = {}           # path -> frontmatter-ish facts
        self.edges = []          # (a, b, layer)
        self.adj = {}            # path -> list of (other, layer)
        self.words = None        # Lexical, the keyword half of search

    # -- loading ---------------------------------------------------------

    def fresh(self):
        """Reload when the index file has changed underneath us."""
        try:
            mtime = os.path.getmtime(INDEX_PATH)
        except OSError:
            raise RuntimeError(
                f"No Strata index at {INDEX_PATH}. Open the Strata view in Obsidian once to build it."
            )
        if mtime != self.index_mtime:
            self._load(mtime)
        return self

    def _load(self, mtime):
        with open(INDEX_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        self.index_mtime = mtime
        self.loaded_at = time.time()
        self.model = raw.get("model", "")
        self.paths, self.vectors, self.headings, self.previews = [], [], [], []
        self.by_path = {}
        for path, entry in raw.get("entries", {}).items():
            for seg in entry.get("segs", []):
                blob = base64.b64decode(seg["v"])
                vec = struct.unpack(f"<{len(blob) // 4}f", blob)
                self.by_path.setdefault(path, []).append(len(self.paths))
                self.paths.append(path)
                self.vectors.append(vec)
                self.headings.append(seg.get("h") or "")
                self.previews.append(seg.get("p") or "")
        self._read_structure()
        self.words = None    # rebuilt on the next search, from the same pages

    # -- vault structure -------------------------------------------------

    def _read_structure(self):
        """
        Rebuild the graph from the files themselves.

        Strata builds this in the plugin; duplicating it here rather than
        exporting it keeps the server independent of whether Obsidian has run
        recently. Frontmatter and wikilinks are cheap to parse and always true.
        """
        self.meta, self.edges = {}, []
        by_name = {}

        def scan(root, prefix, kinds):
            for folder, kind in kinds:
                base = os.path.join(root, folder) if folder else root
                if not os.path.isdir(base):
                    continue
                for dirpath, _dirs, files in os.walk(base):
                    if os.sep + "." in dirpath:
                        continue
                    for name in sorted(files):
                        if not name.endswith(".md"):
                            continue
                        full = os.path.join(dirpath, name)
                        rel = os.path.relpath(full, root)
                        key = (prefix + rel).replace(os.sep, "/")
                        front, body = split_front(read_text(full))
                        self.meta[key] = {
                            "kind": kind,
                            "title": name[:-3],
                            "topics": [strip_link(t) for t in as_list(front.get("topics"))],
                            "source": strip_link(front.get("source") or ""),
                            "origin": front.get("origin") or "",
                            "horizon": front.get("horizon") or "",
                            "captured": front.get("captured") or "",
                            "bridges": as_list(front.get("bridges")),
                            "up": strip_link(front.get("up") or ""),
                            "for": [strip_link(x) for x in as_list(front.get("for"))],
                            "full": strip_link(front.get("full") or ""),
                            "path": full,
                            "body": body,
                        }
                        by_name.setdefault(name[:-3], key)

        scan(VAULT, "", [("Notes", "note"), ("Topics", "topic"), ("Sources", "source"),
                         ("Essays", "note"), ("Goals", "note"), ("Reference", "note"),
                         ("Research", "note"), ("Library", "full"), ("Archive", "archive"),
                         ("Inbox", "inbox")])
        scan(WORK, "Work/", [("Entries", "entry"), ("Projects", "project"),
                             ("Courses", "course"), ("People", "person")])

        # Linked sessions are nodes too, and their text lives in a transcript
        # rather than a file in either vault. Only the ones you picked appear
        # here: data.json is your curation, not a scan of the machine.
        for sid, session in linked_sessions().items():
            key = f"session:{sid}"
            topics = [str(t).strip("[]") for t in (session.get("topics") or [])]
            self.meta[key] = {
                "kind": "session", "title": session.get("title") or sid[:8],
                "topics": topics, "source": "", "origin": "", "horizon": "",
                "captured": "", "bridges": [], "up": "", "for": [], "full": "",
                "path": session.get("file", ""), "body": None,
                # What it wrote is an edge worth following: these are the notes
                # this conversation actually produced.
                "wrote": session.get("wrote") or [],
            }
            # "is about" edges are added by the generic pass below, which reads
            # meta["topics"] for every node. Only `wrote` is special here.
            for target in session.get("wrote") or []:
                if os.path.exists(os.path.join(VAULT, target)):
                    self.edges.append((key, target, "wrote"))

        for key, m in self.meta.items():
            for topic in m["topics"]:
                target = f"Topics/{topic}.md"
                if target in self.meta:
                    self.edges.append((key, target, "is about"))
            if m["source"]:
                target = f"Sources/{m['source']}.md"
                if target in self.meta:
                    self.edges.append((key, target, "came from"))
            if m["up"]:
                target = f"Topics/{m['up']}.md"
                if target in self.meta:
                    self.edges.append((key, target, "sits under"))
            for other in m["for"]:
                target = f"Work/Projects/{other}.md"
                if target in self.meta:
                    self.edges.append((key, target, "for"))
            for bridge in m["bridges"]:
                target = bridge.replace("Vault/", "", 1) if bridge.startswith("Vault/") else bridge
                if target in self.meta:
                    self.edges.append((key, target, "bridges"))
            # A session has no file body to scan — its text is rendered on demand.
            for match in re.finditer(r"\[\[([^\]|#]+)", m["body"] or ""):
                target = by_name.get(match.group(1).strip())
                if target and target != key:
                    self.edges.append((key, target, "links"))

        self.adj = {}
        seen = set()
        for a, b, layer in self.edges:
            if (a, b, layer) in seen:
                continue
            seen.add((a, b, layer))
            self.adj.setdefault(a, []).append((b, layer))
            self.adj.setdefault(b, []).append((a, layer))

    # -- queries ---------------------------------------------------------

    def degree(self, path):
        return len(self.adj.get(path, ()))

    def age_note(self):
        """Whether the index still speaks for the vault, and what to do if not.

        This used to answer with the file's age and tell the reader to go and
        open Obsidian. Age was only ever a proxy — an index untouched for a week
        is perfectly current if nothing was edited — and "open the app" is not
        an instruction an assistant can act on. Both are now answerable
        properly: count the pages that actually changed, and refresh them here.
        """
        behind, gone = stale_count()
        if behind is None:
            return f"cannot tell whether the index is current — {gone}"
        if not behind and not gone:
            return "index is current"
        parts = []
        if behind:
            parts.append(f"{behind} page{'' if behind == 1 else 's'} changed since indexing")
        if gone:
            parts.append(f"{gone} indexed page{'' if gone == 1 else 's'} no longer exist")
        return f"{' and '.join(parts)} — call `refresh` to bring it up to date"


INDEX = Index()


# ------------------------------------------------------------------- helpers


def linked_sessions():
    """The sessions you have added, straight out of Strata's own store."""
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh).get("linkedSessions") or {}
    except (OSError, ValueError):
        return {}


_SESSION_CACHE = {}


def session_markdown(path):
    """
    Re-render a transcript the way the indexer did.

    Mirrors `readable()` in sessions.ts: prose turns only, tool traffic dropped,
    one `## N · who` heading per turn. Kept in step with that function on
    purpose — the headings are the anchors, so if the two ever disagreed a
    session hit would open at the wrong turn.
    """
    # Keyed by mtime: a transcript only grows, and rendering a large one per
    # retrieval call would make the cheap path the expensive one.
    try:
        stamp = os.path.getmtime(path)
    except OSError:
        return ""
    cached = _SESSION_CACHE.get(path)
    if cached and cached[0] == stamp:
        return cached[1]

    out, turn = [], 0
    try:
        fh = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return ""
    with fh:
        for line in fh:
            if not line.startswith("{"):
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("type") not in ("user", "assistant") or entry.get("isSidechain"):
                continue
            content = (entry.get("message") or {}).get("content")
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text += (block.get("text") or "") + "\n"
            text = text.strip()
            if not text:
                continue
            if entry["type"] == "user" and (text.startswith("<") or text.startswith("Caveat:")):
                continue
            turn += 1
            who = "You" if entry["type"] == "user" else "Claude"
            out.append(f"## {turn} \u00b7 {who}\n\n{text}")
    body = "\n\n".join(out)
    _SESSION_CACHE[path] = (stamp, body)
    return body


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read().replace("\r\n", "\n")
    except OSError:
        return ""


def split_front(text):
    """Frontmatter as a flat dict, plus the body. Deliberately not a YAML parser."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 3)
    if end < 0:
        return {}, text
    block, body = text[4:end], text[end + 5:]
    out, key = {}, None
    for line in block.split("\n"):
        if not line.strip():
            continue
        match = re.match(r"^([A-Za-z_-]+):\s*(.*)$", line)
        if match:
            key = match.group(1)
            value = match.group(2).strip()
            out[key] = [] if value == "" else value.strip("\"'")
        elif re.match(r"^\s*-\s+", line) and key:
            if not isinstance(out.get(key), list):
                out[key] = []
            out[key].append(re.sub(r"^\s*-\s+", "", line).strip().strip("\"'"))
    return out, body


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def strip_link(value):
    match = re.match(r"^\[\[(.+?)\]\]$", str(value).strip())
    return match.group(1) if match else str(value).strip()


def cosine(a, b):
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    return dot / (math.sqrt(na) * math.sqrt(nb) or 1.0)


def embed(text):
    import indexer
    model = INDEX.model or indexer.settings()[1]
    body = json.dumps({"model": model,
                       "input": [indexer.profile(model)["prefix"] + text[:SEG_CHARS]]}).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/embed", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            payload = json.load(res)
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Could not reach Ollama at {OLLAMA} ({exc}). Start it with `ollama serve`."
        )
    vectors = payload.get("embeddings") or []
    if not vectors:
        raise RuntimeError(f"Ollama returned no embedding for the query: {payload}")
    return vectors[0]


def passage_text(path, heading, fallback):
    """
    The passage as written, pulled from the file rather than the index.

    The index stores a 240-character preview, which is enough to rank and far
    too little to reason with. The heading is the address, so the section can be
    lifted out of the file whole.
    """
    meta = INDEX.meta.get(path)
    body = body_of(path, meta)
    if not body:
        return fallback
    if not heading:
        return body[:MAX_PASSAGE_CHARS].strip()
    pattern = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.M)
    marks = list(pattern.finditer(body))
    want = plain_heading(heading)
    for i, mark in enumerate(marks):
        if plain_heading(mark.group(2)) != want:
            continue
        level = len(mark.group(1))
        stop = len(body)
        for later in marks[i + 1:]:
            if len(later.group(1)) <= level:
                stop = later.start()
                break
        return body[mark.end():stop].strip()[:MAX_PASSAGE_CHARS]
    return fallback


def body_of(path, meta):
    """A page's text, wherever it actually lives."""
    if meta and meta.get("kind") == "session":
        return session_markdown(meta.get("path") or "")
    if meta and meta.get("body") is not None:
        return meta["body"]
    return read_text(os.path.join(VAULT, path))


def plain_heading(text):
    return re.sub(r"\s+", " ", re.sub(r"[*_`~]", "", text)).strip().lower()


def label(path):
    meta = INDEX.meta.get(path)
    name = meta["title"] if meta else os.path.basename(path)[:-3]
    return re.sub(r"^note-", "", name)


def connects_summary(path):
    """One line of what a hit connects to, so the loop can skip a round trip."""
    counts = {}
    for _other, layer in INDEX.adj.get(path, ()):
        counts[layer] = counts.get(layer, 0) + 1
    if not counts:
        return "connects to nothing"
    return ", ".join(f"{n} {layer}" for layer, n in sorted(counts.items(), key=lambda kv: -kv[1]))


class Lexical:
    """
    The words half of search: BM25 over the same passages the vectors come from.

    Meaning alone could not find a page by its own name. An article's title
    embeds near everything loosely on its subject, so the article called that ranked
    nowhere — while a name, a course code or a phrase remembered word for word
    is exactly what gets asked. Mirrors `lexical.ts` in the plugin; the two do
    not have to agree to the digit, only in spirit, because nothing is stored.

    Built from the raw pages rather than the template-stripped text the vectors
    see: a recurring answer like "Leg day" is noise for similarity and exactly
    what a keyword search is for.
    """

    K1, B = 1.2, 0.75
    PREFIX_FANOUT = 20

    def __init__(self, docs):
        import indexer
        self.passages = []      # (path, heading, length)
        self.postings = {}
        total = 0
        for doc in docs:
            title = tokens(doc["title"])
            for seg in indexer.segment(doc["text"]):
                words = title + tokens(seg["heading"]) + tokens(seg["text"])
                if not words:
                    continue
                at = len(self.passages)
                self.passages.append((doc["key"], seg["heading"], len(words)))
                total += len(words)
                tf = {}
                for w in words:
                    tf[w] = tf.get(w, 0) + 1
                for w, n in tf.items():
                    self.postings.setdefault(w, []).append((at, n))
        self.avg = total / len(self.passages) if self.passages else 1.0

    def idf(self, term):
        n = len(self.postings.get(term, ()))
        return math.log(1 + (len(self.passages) - n + 0.5) / (n + 0.5)) if n else 0.0

    def search(self, query, limit=60):
        """Best passage per page as (path, heading, coverage), most coverage first.

        Coverage is the share of the query's distinctive vocabulary a passage
        holds — the idf of each query word it contains over the idf of all of
        them — so a passage matching only "the" and "day" of a long question
        scores near zero however often it says them. See `lexical.ts`.
        """
        words = list(dict.fromkeys(tokens(query)))
        if not words or not self.passages:
            return []
        accepts = [{w: 1.0} for w in words]
        last = words[-1]
        if len(last) >= 3:
            n = 0
            for term in self.postings:
                if term != last and term.startswith(last):
                    accepts[-1][term] = 0.6
                    n += 1
                    if n >= self.PREFIX_FANOUT:
                        break
        worth = [max(self.idf(t) for t in terms) for terms in accepts]
        total = sum(worth) or 1.0
        scores, held = {}, {}
        for i, terms in enumerate(accepts):
            credited = set()
            for term, weight in terms.items():
                hits = self.postings.get(term)
                if not hits:
                    continue
                idf = self.idf(term)
                for at, tf in hits:
                    length = self.passages[at][2]
                    scores[at] = scores.get(at, 0.0) + weight * idf * tf * (self.K1 + 1) / (
                        tf + self.K1 * (1 - self.B + self.B * length / self.avg))
                    if at not in credited:
                        credited.add(at)
                        held[at] = held.get(at, 0.0) + weight * worth[i]
        best = {}
        for at, score in scores.items():
            path, heading, _len = self.passages[at]
            cov = min(1.0, held.get(at, 0.0) / total)
            if path not in best or (cov, score) > best[path][:2]:
                best[path] = (cov, score, heading)
        ranked = sorted(((c, s, p, h) for p, (c, s, h) in best.items()), reverse=True)
        return [(p, h, c) for c, _s, p, h in ranked[:limit]]


def tokens(text):
    return [t for t in re.findall(r"[^\W_]+", (text or "").lower()) if len(t) > 1]


def lexical():
    """The keyword index for the pages the vectors cover, built once per index load."""
    if INDEX.words is None:
        import indexer
        INDEX.words = Lexical(indexer.all_docs(session_markdown))
    return INDEX.words


# What an Archive page's score is multiplied by: findable, never ahead of its replacement.
ARCHIVE_WEIGHT = 0.5
# Share of the score that comes from words, and how much of the query's
# distinctive vocabulary a passage must hold before its words count at all.
WORDS_WEIGHT, WORDS_GATE = 0.4, 0.6


def blend(cos, coverage, model):
    """One score from both halves. Mirrors `search` in semantic.ts.

    Measured on 34 searches with known answers (2026-10-25). Reciprocal-rank
    fusion lost the article whose title *was* the query, because the meaning
    half always offers sixty pages and any page both halves mention at middling
    rank beat it. Blending BM25 scaled to the best hit lost the other way: in an
    English question about a German journal, the common words matched dozens of
    English journals and outvoted the answer. What holds is meaning read
    absolutely, and words counted only when a passage holds most of the query's
    distinctive vocabulary — a name, a title, a rare term: 31 of 34.
    """
    import indexer
    p = indexer.profile(model)
    m = 0.0 if cos is None else max(0.0, min(1.0, (cos - p["meaning_floor"]) / p["meaning_span"]))
    w = max(0.0, (coverage - WORDS_GATE) / (1 - WORDS_GATE))
    return (1 - WORDS_WEIGHT) * m + WORDS_WEIGHT * w


# --------------------------------------------------------------------- tools


def tool_search(query, limit=DEFAULT_HITS, kind=None):
    # An empty query embeds to a point that means nothing, and the ranking it
    # produces looks like an answer. Refusing is the honest response.
    if not (query or "").strip():
        return {"error": "Give me something to search for."}
    idx = INDEX.fresh()
    if not idx.vectors:
        return {"error": "The index is empty. Open the Strata view in Obsidian to build it."}
    vector = embed(query)

    scored = []
    for i, candidate in enumerate(idx.vectors):
        path = idx.paths[i]
        if kind and (idx.meta.get(path, {}).get("kind") != kind):
            continue
        scored.append((cosine(vector, candidate), i))
    scored.sort(reverse=True)

    # Best passage per page — the meaning ranking.
    best = {}
    for score, i in scored:
        path = idx.paths[i]
        if path not in best:
            best[path] = (score, i)
    meaning = sorted(best.items(), key=lambda kv: -kv[1][0])[:60]

    # And the words ranking, over the same pages, blended by strength.
    words = [w for w in lexical().search(query)
             if (not kind or idx.meta.get(w[0], {}).get("kind") == kind) and w[2] > WORDS_GATE]
    import indexer
    floor = indexer.profile(idx.model)["meaning_floor"]

    fused = {}
    for path, (score, i) in meaning:
        fused[path] = {"score": score, "coverage": 0.0, "heading": idx.headings[i],
                       "preview": idx.previews[i], "by": ["meaning"] if score >= floor else []}
    for rank, (path, heading, coverage) in enumerate(words):
        row = fused.get(path)
        if row is None:
            row = fused[path] = {"score": None, "coverage": 0.0, "heading": heading,
                                 "preview": "", "by": []}
        row["coverage"] = coverage
        row["by"].append("words")
        # When the words rank a page near the top, theirs is the passage that
        # actually contains the query, so show that one.
        if rank < 3:
            row["heading"] = heading
    for row in fused.values():
        row["blend"] = blend(row["score"], row["coverage"], idx.model)

    # Deliberately *not* biased by origin. Everything in a curated vault is
    # there because someone put it there, so provenance is a label to report,
    # not a reason to rank. A little node degree still breaks near-ties: a hub
    # beats a passing mention as an entry point.
    # A replaced page stays findable but never ranks ahead of what replaced it.
    def rank_key(item):
        path, row = item
        weight = ARCHIVE_WEIGHT if path.startswith("Archive/") else 1.0
        return row["blend"] * weight * (1 + 0.05 * min(1.0, idx.degree(path) / 12.0))
    ranked = [p for p, _r in sorted(fused.items(), key=rank_key, reverse=True)]

    # An original in the Library says what its atoms say, at length. When an
    # atom drawn from it is already an answer, the original is a duplicate
    # result; when none is, it is the only way in, and it says which atoms exist.
    by_title = {m["title"]: p for p, m in idx.meta.items() if m.get("kind") in ("full", "archive")}
    atoms_of = {}
    for path, meta in idx.meta.items():
        original = by_title.get(meta.get("full") or "")
        if original:
            atoms_of.setdefault(original, []).append(path)
    hits = []
    shown = set()
    for path in ranked:
        if len(hits) >= max(1, min(limit, MAX_HITS)):
            break
        if any(a in shown for a in atoms_of.get(path, ())):
            continue
        row = fused[path]
        meta = idx.meta.get(path, {})
        heading = row["heading"]
        hit = {
            "path": path,
            "title": label(path),
            "heading": heading,
            "score": round(row["score"], 3) if row["score"] is not None else None,
            "matched_by": row["by"],
            "kind": meta.get("kind", "note"),
            "origin": meta.get("origin", ""),
            "topics": meta.get("topics", []),
            "open": f"{path}#{heading}" if heading else path,
            "connects": connects_summary(path),
            "passage": passage_text(path, heading, row["preview"]),
        }
        if atoms_of.get(path):
            hit["atoms_drawn_from_it"] = [label(a) for a in atoms_of[path]]
        hits.append(hit)
        shown.add(path)
    return {"note": idx.age_note(), "hits": hits}


def tool_neighbours(path, semantic=True):
    idx = INDEX.fresh()
    path = resolve(path)
    if path is None:
        return {"error": "No such page. Use search first, or pass the exact path a hit returned."}

    groups = {}
    for other, layer in idx.adj.get(path, ()):
        groups.setdefault(layer, [])
        if other not in [n["path"] for n in groups[layer]]:
            groups[layer].append({"path": other, "title": label(other),
                                  "kind": idx.meta.get(other, {}).get("kind", "note")})
    for layer in groups:
        groups[layer] = groups[layer][:MAX_NEIGHBOURS_PER_LAYER]

    # Semantic neighbours are computed for this one page rather than read from a
    # precomputed all-pairs table: one page against the corpus is a few thousand
    # comparisons, which is cheaper than keeping the table fresh.
    if semantic and path in idx.by_path:
        mine = [idx.vectors[i] for i in idx.by_path[path]]
        scores = {}
        for j, other_vec in enumerate(idx.vectors):
            other = idx.paths[j]
            if other == path:
                continue
            best = max(cosine(v, other_vec) for v in mine)
            if best > scores.get(other, 0):
                scores[other] = best
        near = sorted(scores.items(), key=lambda kv: -kv[1])[:MAX_NEIGHBOURS_PER_LAYER]
        import indexer
        rhyme_floor = indexer.semantic_settings()["floor"]
        linked = {n["path"] for group in groups.values() for n in group}
        rhymes = [{"path": p, "title": label(p), "similarity": round(s, 3),
                   "already_linked": p in linked}
                  for p, s in near if s >= rhyme_floor]
        if rhymes:
            groups["rhymes with (semantic)"] = rhymes

    meta = idx.meta.get(path, {})
    return {
        "note": idx.age_note(),
        "path": path,
        "title": label(path),
        "kind": meta.get("kind", ""),
        "origin": meta.get("origin", ""),
        "topics": meta.get("topics", []),
        "neighbours": groups,
    }


def tool_get(path, heading=None):
    idx = INDEX.fresh()
    path = resolve(path)
    if path is None:
        return {"error": "No such page. Use search first, or pass the exact path a hit returned."}
    meta = idx.meta.get(path, {})
    body = body_of(path, meta)
    if heading:
        return {"path": path, "title": label(path), "heading": heading,
                "text": passage_text(path, heading, "")}
    truncated = len(body) > MAX_GET_CHARS
    return {
        "path": path,
        "title": label(path),
        "kind": meta.get("kind", ""),
        "origin": meta.get("origin", ""),
        "topics": meta.get("topics", []),
        "source": meta.get("source", ""),
        "captured": meta.get("captured", ""),
        "truncated": truncated,
        "text": body[:MAX_GET_CHARS],
    }


def tool_refresh(limit=None):
    """Bring the index up to date without opening Obsidian.

    The index used to move only while the plugin was running, which meant an
    assistant either read stale answers or asked you to open the app — and
    "go and click something" is exactly what this server exists to avoid. The
    embedding pass is ported in `indexer.py`, verified against the plugin's own
    output down to identical vectors, so either side can keep the index current
    and neither invalidates the other's work.
    """
    try:
        import indexer
    except Exception as exc:
        raise ToolInput(f"The indexer is not importable: {exc}")
    host, _model = indexer.settings()
    if not indexer.is_local(host):
        raise ToolInput(
            f"The configured embedder is {host}, which is not this machine. Refreshing would "
            "send the text of both vaults there. Point Strata's host back at localhost first."
        )
    try:
        result = indexer.refresh(session_markdown, limit=limit)
    except indexer.IndexUnreadable as exc:
        raise ToolInput(str(exc))
    except urllib.error.URLError as exc:
        raise ToolInput(
            "Could not reach Ollama, so nothing was re-embedded. It is what computes "
            f"the vectors, and it runs locally: `ollama serve`. ({exc.reason})"
        )
    except (TimeoutError, socket.timeout) as exc:
        raise ToolInput(f"Ollama did not answer in time, so nothing was written. ({exc})")
    except RuntimeError as exc:
        raise ToolInput(f"Ollama answered with something unusable, so nothing was written. ({exc})")
    INDEX.fresh()
    note = "index is current"
    if result["left"]:
        note = f"{result['left']} pages still to do — call refresh again to continue"
    return {
        "indexed": result["indexed"],
        "removed": result["removed"],
        "pages": result["pages"],
        "model": result["model"],
        "note": note,
    }


def stale_count():
    """How many pages the index no longer speaks for. Cheap: mtime, then hash.

    Returns (behind, gone) or (None, reason). It used to swallow every
    exception and return None, which sent `age_note` back to guessing from the
    file's age — so if the refresh path broke, every answer still looked
    plausible and nobody found out. A failure here is worth saying out loud.
    """
    try:
        import indexer
        docs = indexer.all_docs(session_markdown)
        index = indexer.load_index()
        _host, model = indexer.settings()
        stale, gone, changed, _touched = indexer.survey(docs, index, model)
        return (len(docs) if changed else len(stale)), len(gone)
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def resolve(path):
    """Accept a full path, or a bare note name, since an LLM will guess both."""
    idx = INDEX
    if path in idx.meta:
        return path
    stem = re.sub(r"\.md$", "", path).split("/")[-1]
    for key, meta in idx.meta.items():
        if meta["title"] == stem:
            return key
    for key, meta in idx.meta.items():
        if meta["title"] == f"note-{stem}":
            return key
    return None


def changed_at(path, meta):
    """When a page last changed, wherever it lives."""
    target = (meta or {}).get("path") or os.path.join(VAULT, path)
    try:
        return os.path.getmtime(target)
    except OSError:
        return 0


def tool_status():
    """
    What is in here, and where it came from.
    
    The rule is that membership is yours: nothing enters the index that you did not
    put in the vault or explicitly link. That rule is only worth anything if it
    is checkable, so this is the check — a plain answer to "what do you actually
    have", rather than a multi-megabyte JSON file to read by eye.
    """
    idx = INDEX.fresh()
    stores = {}
    for path in set(idx.paths):
        if path.startswith("session:"):
            store = "sessions (linked by hand)"
        elif path.startswith("Work/"):
            store = "Work vault"
        else:
            store = f"Vault/{path.split('/')[0]}" if "/" in path else "Vault (root)"
        row = stores.setdefault(store, {"pages": 0, "passages": 0, "newest": 0})
        row["pages"] += 1
        row["passages"] += len(idx.by_path.get(path, ()))

    recent = []
    for path in idx.by_path:
        when = changed_at(path, idx.meta.get(path))
        recent.append((when, path))
        key = ("sessions (linked by hand)" if path.startswith("session:")
               else "Work vault" if path.startswith("Work/")
               else f"Vault/{path.split('/')[0]}" if "/" in path else "Vault (root)")
        if key in stores and when > stores[key]["newest"]:
            stores[key]["newest"] = when
    recent.sort(reverse=True)

    sessions = [
        {"title": m.get("title"), "topics": m.get("topics", []), "wrote": len(m.get("wrote", []))}
        for k, m in idx.meta.items() if m.get("kind") == "session"
    ]
    # Indexed but no longer on disk — the one failure mode a ledger must catch.
    missing = [p for p in idx.by_path if p not in idx.meta and not os.path.exists(os.path.join(VAULT, p))]

    # Proposed links nobody has judged yet, counted by the snapshot job.
    pending = None
    try:
        with open(os.path.join(os.path.dirname(INDEX_PATH), "pending-pairs.json"), encoding="utf-8") as fh:
            pending = len(json.load(fh))
    except (OSError, ValueError):
        pass

    return {
        "note": idx.age_note(),
        "model": idx.model,
        "totals": {"pages": len(idx.by_path), "passages": len(idx.paths)},
        "links_awaiting_judgement": (
            f"{pending} — run a judging pass (judge.py) when asked, or monthly" if pending else pending
        ),
        "deliberately_not_searched": "Topics/ and Sources/ (their bodies are Dataview queries), Work/Admin/ (checklists)",
        "by_store": {
            k: {"pages": v["pages"], "passages": v["passages"],
                "newest": time.strftime("%Y-%m-%d", time.localtime(v["newest"])) if v["newest"] else ""}
            for k, v in sorted(stores.items())
        },
        "sessions": sessions,
        "most_recently_changed": [p for _w, p in recent[:10]],
        "indexed_but_gone": missing,
    }


TOOLS = [
    {
        "name": "status",
        "description": (
            "What this index actually contains: how many pages and passages, broken down by "
            "store (the knowledge vault, the Work vault, linked Claude Code sessions), which "
            "sessions are linked and what they are about, what changed most recently, and how "
            "stale the index is. Use it to know what you have access to before searching, or "
            "when the user asks what is in their vault."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "search",
        "description": (
            "Search across both vaults by meaning AND by words at once — notes, Work entries, "
            "linked sessions, the Library (originals, articles, podcast and video transcripts, "
            "brainstorms), the Inbox, and the Archive of replaced versions (always ranked last). Names, titles and exact phrases work as well as questions. Returns the "
            "passages that match, with the heading they sit under, which half found each "
            "(`matched_by`), what each page connects to, and a path#heading you can pass to "
            "`get`. Use this FIRST for any question about what the user thinks, believes, has "
            "written or has decided; it is far cheaper than reading files and returns their own "
            "words rather than a summary."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What you are looking for, in natural language."},
                "limit": {"type": "integer", "description": f"How many pages to return (default {DEFAULT_HITS}, max {MAX_HITS})."},
                "kind": {"type": "string", "description": "Optional filter: note, full (Library), archive, inbox, topic, source, entry, project, session."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "neighbours",
        "description": (
            "What a page connects to, on every layer at once: what it is about (topics), where it "
            "came from (source), what it links to, what it bridges to in the Work vault, and what "
            "it rhymes with semantically. Call this after `search` to explore outward. Because a "
            "topic page is itself a node, this is also how you get 'everything about X' — find any "
            "note on the subject, then ask for the neighbours of its topic."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "A path from a search hit, or a bare note name."},
                "semantic": {"type": "boolean", "description": "Include semantically similar pages (default true)."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "refresh",
        "description": (
            "Bring the index up to date from the vault on disk, without opening Obsidian. "
            "Call it when `status` reports the index is stale, or before a search that has to "
            "be current. Incremental: only pages whose content actually changed are re-embedded, "
            "so the ordinary case is fast. Needs Ollama running locally."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Most pages to embed in one call. Omit for all of them.",
                },
            },
        },
    },
    {
        "name": "get",
        "description": (
            "Full text of one page, or of a single section when you pass a heading. Use only after "
            "search or neighbours has told you a page is worth reading — pulling whole files "
            "without that is the expensive habit this server exists to replace."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "A path from a search hit, or a bare note name."},
                "heading": {"type": "string", "description": "Optional: return only this section."},
            },
            "required": ["path"],
        },
    },
]

class ToolInput(Exception):
    """A caller mistake, reported as guidance rather than as a traceback."""


def want_str(args, name):
    """A required string argument, or a message the caller can act on.

    An LLM calls a tool wrong reasonably often — a missing `path`, a number
    where a query goes — and every one of those used to come back as a raw
    Python exception string: `'path'` for a KeyError, `'int' object has no
    attribute 'strip'` for a query that was not text. That is an internal
    detail presented as an answer, and it tells the caller nothing about what
    to do instead.
    """
    value = args.get(name)
    if value is None:
        raise ToolInput(f"`{name}` is required.")
    if not isinstance(value, str):
        raise ToolInput(f"`{name}` must be a string, not {type(value).__name__}.")
    if not value.strip():
        raise ToolInput(f"`{name}` cannot be empty.")
    return value


def want_int(args, name, default, low, high):
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ToolInput(f"`{name}` must be a whole number.")
    return max(low, min(high, value))


HANDLERS = {
    "status": lambda _a: tool_status(),
    "search": lambda a: tool_search(
        want_str(a, "query"), want_int(a, "limit", DEFAULT_HITS, 1, MAX_HITS), a.get("kind")
    ),
    "neighbours": lambda a: tool_neighbours(want_str(a, "path"), a.get("semantic", True)),
    "get": lambda a: tool_get(want_str(a, "path"), a.get("heading")),
    "refresh": lambda a: tool_refresh(
        want_int(a, "limit", None, 1, 10000) if a.get("limit") is not None else None
    ),
}


# ------------------------------------------------------------------ protocol


def respond(msg_id, result=None, error=None):
    payload = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        msg_id = msg.get("id")

        if method == "initialize":
            respond(msg_id, {
                # Echo the client's version rather than pinning one, so this
                # keeps working as the protocol moves.
                "protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "strata", "version": "0.1.0"},
            })
        elif method == "tools/list":
            respond(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params", {})
            name = params.get("name")
            handler = HANDLERS.get(name)
            if handler is None:
                respond(msg_id, error={"code": -32601, "message": f"Unknown tool: {name}"})
                continue
            try:
                result = handler(params.get("arguments") or {})
                respond(msg_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]})
            except ToolInput as exc:
                respond(msg_id, {"content": [{"type": "text", "text": json.dumps({"error": str(exc)})}],
                                 "isError": True})
            except Exception as exc:  # a failed lookup must not kill the server
                # Anything unplanned reports its type and nothing else. The
                # message of an arbitrary exception is an internal detail, and
                # handing it back as the answer both misleads the caller and
                # tells it more about this machine than it needs to know.
                sys.stderr.write(f"strata: {name} failed: {type(exc).__name__}: {exc}\n")
                respond(msg_id, {"content": [{"type": "text", "text": json.dumps(
                    {"error": f"That call failed inside the server ({type(exc).__name__}). "
                              "The details are on the server's stderr."})}],
                                 "isError": True})
        elif msg_id is not None:
            respond(msg_id, error={"code": -32601, "message": f"Unknown method: {method}"})
        # notifications (no id) need no reply


if __name__ == "__main__":
    main()
