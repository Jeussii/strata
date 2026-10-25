"""
Bringing the semantic index up to date without Obsidian.

Strata has two consumers and they are not the same. You get the graph; an
assistant gets this server. Until now only one of them could keep the index
fresh, because the embedding pass lived inside the plugin — so an assistant
either read a stale index or asked you to open the app, which is exactly the
"navigate a UI" the design is supposed to make unnecessary.

This is a faithful port of the plugin's indexing half: same segmentation, same
hash, same embedding prompt, same on-disk format and version. The two can be
run in any order and neither invalidates the other's work — a page carries its
mtime and a content hash, so whichever process gets there first, the other sees
the entry as current and skips it.

Kept deliberately close to `src/segment.ts` and `src/semantic.ts` rather than
improved, because the moment the two disagree about where a passage starts, the
same note gets two different sets of vectors depending on who indexed it.
"""

import base64
import json
import os
import re
import struct
import unicodedata
import urllib.error
import urllib.request

CACHE_VERSION = 2          # semantic.ts
SEG_CHARS = 1800
PREVIEW = 240
BATCH = 8
TARGET, MAX_SEG, MIN_SEG, FLOOR = 1100, 1800, 220, 60   # segment.ts

HOME = os.path.expanduser("~")
# Configured, not discovered.
#
# `STRATA_ROOT` decides it, or `STRATA_VAULT` / `STRATA_WORK` individually.
# With none of them set the first of these that actually exists is used — a
# convenience for a single-machine setup, and if none exist the server says
# which paths it tried rather than failing somewhere further in.
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
PLUGIN = os.path.join(VAULT, ".obsidian", "plugins", "strata")
INDEX_PATH = os.path.join(PLUGIN, "semantic-index.json")
DATA_PATH = os.path.join(PLUGIN, "data.json")
BOILER_PATH = os.path.join(PLUGIN, "boilerplate.json")
TRANSCRIPTS = os.path.realpath(
    os.environ.get("STRATA_TRANSCRIPTS") or os.path.join(HOME, ".claude", "projects")
)

# Library, Archive and Inbox are read for search and nothing else (the graph
# never draws them; see places.ts in the plugin). They used to be skipped
# outright, as `Full/`, on the reasoning that an original is similar to every
# atom taken out of it — true of the graph, but skipping them here as well made
# twenty originals nobody had split simply unfindable: an article clipped on
# 2026-10-21, two recorded conversations, three long transcripts. Sixty thousand words.
# Only Topics and Sources stay out: their bodies are Dataview queries, not prose.
SKIP_VAULT_FOLDERS = {"Topics", "Sources"}

# A line is template rather than writing once it turns up in this many pages.
BOILER_MIN_DOCS = 6
BOILER_MIN_CHARS = 4
SKIP_VAULT_TYPES = {"topic", "source"}
# Admin is checklists, not thinking. Projects and courses each carry the one
# paragraph saying what the thing is, which is worth finding.
SKIP_WORK_PREFIX = ("Admin/",)


# ----------------------------------------------------------------- segmenting


def body_of(raw):
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    if not text.startswith("---"):
        return text
    end = text.find("\n---", 3)
    return text if end < 0 else text[end + 4:]


def clean(text):
    text = re.sub(r"<!--[\s\S]*?-->", " ", text)
    text = re.sub(r"\[\[([^\]|#]+)(\|[^\]]+)?\]\]", r"\1", text)
    text = re.sub(r"[*`_]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def segment(raw):
    body = body_of(raw)
    blocks, current = [], {"heading": "", "line": "", "lines": []}
    for line in body.split("\n"):
        h = re.match(r"^#{1,6}\s+(.+)$", line)
        if h:
            if current["lines"]:
                blocks.append(current)
            current = {"heading": re.sub(r"[*`#]", "", h.group(1)).strip(), "line": line, "lines": []}
            continue
        current["lines"].append(line)
    if current["lines"]:
        blocks.append(current)

    out = []
    for block in blocks:
        paras = []
        for p in re.split(r"\n\s*\n", "\n".join(block["lines"])):
            t = p.strip()
            if t:
                paras.append({"text": t, "raw": re.sub(r"\s+$", "", re.sub(r"^\n+", "", p))})

        buf = {"text": "", "raw": ""}
        state = {"first": True}

        def flush():
            if buf["text"]:
                raw_text = (f"{block['line']}\n\n{buf['raw']}"
                            if state["first"] and block["line"] else buf["raw"])
                out.append({"heading": block["heading"], "text": buf["text"], "raw": raw_text})
                state["first"] = False
            buf["text"], buf["raw"] = "", ""

        for para in paras:
            if not buf["text"] or len(buf["text"]) + len(para["text"]) < TARGET:
                if buf["text"]:
                    buf["text"] += "\n\n" + para["text"]
                    buf["raw"] += "\n\n" + para["raw"]
                else:
                    buf["text"], buf["raw"] = para["text"], para["raw"]
                if len(buf["text"]) > MAX_SEG:
                    flush()
                continue
            flush()
            buf["text"], buf["raw"] = para["text"], para["raw"]
        flush()

    merged = []
    for seg in out:
        if merged and len(seg["text"]) < MIN_SEG and merged[-1]["heading"] == seg["heading"]:
            merged[-1]["text"] += "\n\n" + seg["text"]
            merged[-1]["raw"] += "\n\n" + seg["raw"]
            continue
        merged.append(dict(seg))

    final = []
    for s in merged:
        text = clean(s["text"])
        if len(text) >= FLOOR:
            final.append({"heading": s["heading"], "text": text})
    return final


# ---------------------------------------------------------------- templates


# The segmenter's own test for a heading: unindented. A `###` inside a list
# item is part of the item, and a template pasted as a nested list is still a
# template.
HEADING = re.compile(r"^#{1,6}\s")


def boiler_norm(line):
    """A line reduced to its words, so a template prompt matches however it is quoted.

    Mirrors `boilerNorm` in segment.ts character for character. The two only
    have to agree on membership, but if they disagree on one line the same page
    hashes differently on each side and the two indexers re-embed it in turn.
    """
    s = line.strip()
    s = re.sub(r"^(>\s*)+", "", s)
    s = re.sub(r"^([-*+]|\d+[.)])\s+", "", s)
    s = re.sub(r"[*_`#]", "", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def _split_front(raw):
    """Frontmatter and body, cut exactly where `body_of` cuts, without normalising."""
    if not raw.startswith("---"):
        return "", raw
    end = raw.find("\n---", 3)
    return ("", raw) if end < 0 else (raw[:end + 4], raw[end + 4:])


def strip_boilerplate(raw, lines):
    """The page minus every line that is template rather than writing.

    Journals were the reason. Two hundred of them share a printed prompt —
    "my most important task today", "I am grateful for", a placeholder under
    every question left blank — and a passage that is mostly
    prompt is mostly the same passage. Measured on 2026-10-25: 178 of the 205
    pairs the Echo layer called near-duplicates were two journals sharing a
    template and nothing else.

    Headings stay, because they are where passages start and how a hit is
    addressed — the same unindented headings the segmenter splits on. A page with nothing removed comes back byte-identical, so its
    hash, and its vectors, do not move.
    """
    if not lines:
        return raw
    front, body = _split_front(raw)
    kept = [ln for ln in body.split("\n")
            if HEADING.match(ln) or boiler_norm(ln) not in lines]
    return front + "\n".join(kept)


def compute_boilerplate(docs):
    """Every line that recurs across enough pages to be a template, sorted."""
    counts = {}
    for doc in docs:
        if doc["key"].startswith("session:"):
            continue
        _front, body = _split_front(doc["text"])
        seen = set()
        for ln in body.split("\n"):
            if HEADING.match(ln):
                continue
            norm = boiler_norm(ln)
            if len(norm) >= BOILER_MIN_CHARS:
                seen.add(norm)
        for norm in seen:
            counts[norm] = counts.get(norm, 0) + 1
    return sorted(k for k, n in counts.items() if n >= BOILER_MIN_DOCS)


def load_boilerplate():
    """(rev, set of lines). Absent means no template is known yet, which is rev 0."""
    try:
        raw = json.loads(read_exact(BOILER_PATH))
        return int(raw.get("rev") or 0), set(raw.get("lines") or [])
    except (OSError, ValueError):
        return 0, set()


def save_boilerplate(lines):
    """Write the template list if it changed. Returns its revision either way."""
    rev = content_hash("\n".join(lines)) if lines else 0
    if load_boilerplate()[0] != rev:
        tmp = f"{BOILER_PATH}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            json.dump({"rev": rev, "minDocs": BOILER_MIN_DOCS, "lines": lines}, fh,
                      ensure_ascii=False, indent=1)
        os.replace(tmp, BOILER_PATH)
    return rev


def content_hash(text):
    """FNV-1a over UTF-16 code units, matching semantic.ts exactly.

    `charCodeAt` yields UTF-16 code units, so anything above the BMP — an emoji
    in a note — is two iterations in JavaScript and one in Python. Encoding to
    UTF-16 first makes the two agree; without it the hashes diverge on exactly
    the notes that contain emoji, and the two indexers would each think the
    other's entries were stale and re-embed the vault back and forth forever.
    """
    h = 2166136261
    units = memoryview(text.encode("utf-16-le")).cast("H")
    for unit in units:
        h = ((h ^ unit) * 16777619) & 0xFFFFFFFF
    return h


# What each model must be told, and what its numbers mean — `PROFILES` in
# semantic.ts. nomic wants a task prefix and bge-m3 none; and a cosine is not a
# unit, so the cutoffs that turn one into a decision live with the model.
PROFILES = {
    "nomic-embed-text": {"prefix": "clustering: ", "meaning_floor": 0.55, "meaning_span": 0.30},
    "bge-m3": {"prefix": "", "meaning_floor": 0.40, "meaning_span": 0.30},
}


def profile(model):
    return PROFILES.get(model.replace(":latest", ""), {"prefix": "", "meaning_floor": 0.40, "meaning_span": 0.30})


def for_embedding(title, seg, model):
    head = f"{title} — {seg['heading']}" if seg["heading"] else title
    return f"{profile(model)['prefix']}{head}. {seg['text']}"[:SEG_CHARS]


def read_exact(path):
    """Read a file the way Node does: no newline translation.

    Python's text mode rewrites CRLF to LF on the way in. Notes that came off
    a Windows machine still have CRLF, so a translated read hashes to something
    the plugin never computes — and the two indexers would each see the other's
    entries as stale and re-embed those files forever, taking turns. Measured
    on one such note: 3968046815 translated against the plugin's 273095317.
    """
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


# ---------------------------------------------------------------------- docs


def nfc(text):
    """Compose accents the way Obsidian stores them.

    macOS hands back decomposed filenames — an `ä` arrives as `a` plus a
    combining diaeresis — while Obsidian's vault API normalises to NFC. Left
    alone, every non-ASCII filename produces a key the plugin has never seen,
    so the same file is indexed twice under two spellings and each side
    reports the other's entry as an orphan. One such file is enough to find it,
    and it would have been every future one.
    """
    return unicodedata.normalize("NFC", text)


def nice_title(base):
    return re.sub(r"^note-", "", base).replace("-", " ")


def front_type(raw):
    m = re.match(r"^---\n(.*?)\n---\n", raw, re.S)
    if not m:
        return None
    t = re.search(r"^type:\s*(\S+)", m.group(1), re.M)
    return t.group(1).strip() if t else None


def vault_docs():
    """Every markdown file the plugin would embed, by the same rules."""
    out = []
    for dirpath, dirnames, filenames in os.walk(VAULT):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_VAULT_FOLDERS]
        for name in filenames:
            if not name.endswith(".md"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, VAULT)
            raw = read_exact(full)
            if front_type(raw) in SKIP_VAULT_TYPES:
                continue
            out.append({
                "key": nfc(rel),
                "title": nfc(nice_title(name[:-3])),
                "mtime": int(os.path.getmtime(full) * 1000),
                "text": raw,
            })
    return out


def work_docs():
    if not os.path.isdir(WORK):
        return []
    out = []
    for dirpath, dirnames, filenames in os.walk(WORK):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if not name.endswith(".md"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, WORK).replace(os.sep, "/")
            if rel.startswith(SKIP_WORK_PREFIX) or rel == "VAULT-MAP.md":
                continue
            out.append({
                "key": nfc(f"Work/{rel}"),
                "title": nfc(nice_title(name[:-3])),
                "mtime": int(os.path.getmtime(full) * 1000),
                "text": read_exact(full),
            })
    return out


def session_docs(render):
    """Only the sessions linked by hand. Nothing here discovers a transcript."""
    try:
        data = json.loads(read_exact(DATA_PATH))
    except Exception:
        return []
    out = []
    for sid, meta in (data.get("linkedSessions") or {}).items():
        path = (meta or {}).get("file")
        if not path or not os.path.exists(path):
            continue
        # A linked session is a Claude Code transcript, and this is the only
        # place the indexer opens a path it did not derive itself. Left
        # unconstrained it embeds whatever `data.json` names into
        # semantic-index.json, which lives inside the vault — so if the vault
        # is synced, a wrong or edited entry becomes a copy of that file in the
        # sync provider. Confining
        # it to the transcripts directory costs nothing and closes that.
        if os.path.commonpath([os.path.realpath(path), TRANSCRIPTS]) != TRANSCRIPTS:
            continue
        out.append({
            "key": f"session:{sid}",
            "title": (meta or {}).get("title") or sid,
            "mtime": int(os.path.getmtime(path) * 1000),
            "text": render(path),
        })
    return out


def all_docs(render_session):
    return vault_docs() + work_docs() + session_docs(render_session)


# ----------------------------------------------------------------- embedding


def embed(host, model, inputs, timeout=120):
    body = json.dumps({"model": model, "input": inputs}).encode("utf-8")
    req = urllib.request.Request(f"{host}/api/embed", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        payload = json.loads(res.read().decode("utf-8"))
    raw = payload.get("embeddings")
    if not raw or len(raw) != len(inputs):
        raise RuntimeError(f"Ollama returned {len(raw or [])} vectors for {len(inputs)} inputs")
    return [normalise(v) for v in raw]


def normalise(vec):
    total = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / total for x in vec]


def to_b64(vec):
    """Float32 little-endian, exactly what the plugin's Float32Array serialises."""
    return base64.b64encode(struct.pack(f"<{len(vec)}f", *vec)).decode("ascii")


# ------------------------------------------------------------------- refresh


class IndexUnreadable(Exception):
    """The index file is there and cannot be parsed. Never treat that as empty."""


def load_index():
    """Load the index, or start a new one — but only when there genuinely is none.

    This used to answer "empty index" to every failure, and that is the one
    answer it must not give. The plugin writes this file non-atomically, so a
    read taken mid-write returns truncated JSON; parsing that as an empty index
    makes every page look stale, and `refresh` then writes the empty base back
    over every real vector in it. Silently. A missing file is a first run; a file that
    exists and will not parse is a reason to stop and say so.
    """
    if not os.path.exists(INDEX_PATH):
        return {"version": CACHE_VERSION, "model": "", "entries": {}}
    try:
        raw = json.loads(read_exact(INDEX_PATH))
    except Exception as exc:
        raise IndexUnreadable(
            f"{INDEX_PATH} exists but does not parse ({exc}). That usually means it was "
            "read while Obsidian was writing it — try again in a moment. Nothing was changed."
        )
    if not isinstance(raw, dict) or not isinstance(raw.get("entries"), dict):
        raise IndexUnreadable(f"{INDEX_PATH} is not shaped like an index. Nothing was changed.")
    if raw.get("version") != CACHE_VERSION:
        return {"version": CACHE_VERSION, "model": "", "entries": {}}
    return raw


# The plugin's defaults and its one migration, mirrored (main.ts, semantic.ts).
SEMANTIC_VERSION = 2
DEFAULT_SEMANTIC = {"host": "http://localhost:11434", "model": "bge-m3", "k": 4,
                    "floor": 0.59, "echoAt": 0.85}


def semantic_settings():
    """The plugin's semantic settings, migrated exactly as the plugin migrates them.

    Applied on read rather than written back: data.json belongs to Obsidian while
    it runs. If the plugin has not yet moved a vault off nomic, this side reads
    the same file and lands on the same answer, so the two never index with
    different models — which would make each wipe the other's vectors in turn.
    """
    sem = dict(DEFAULT_SEMANTIC)
    try:
        data = json.loads(read_exact(DATA_PATH))
        sem.update({k: v for k, v in (data.get("semantic") or {}).items() if v not in (None, "")})
        if (data.get("semanticVersion") or 1) < SEMANTIC_VERSION and sem["model"].startswith("nomic-embed-text"):
            sem.update({k: DEFAULT_SEMANTIC[k] for k in ("model", "floor", "echoAt")})
    except Exception:
        pass
    return sem


def settings():
    """Host and embedding model."""
    sem = semantic_settings()
    return sem["host"], sem["model"]


def is_local(host):
    """Vault text goes to whatever host is configured. It should be this machine."""
    return re.match(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/?$", host.strip()) is not None


def survey(docs, index, model, boiler=None):
    """Which docs the index no longer speaks for, and which entries are orphans.

    mtime first because it is free, hash second because it is authoritative —
    the plugin's rule, so that re-saving a note without editing it costs
    nothing on either side. A changed model invalidates everything, because
    vectors from two models do not share a space.
    """
    if index.get("model") and index["model"] != model:
        return list(docs), set(), True, 0
    rev, lines = boiler if boiler is not None else load_boilerplate()
    # A new template list changes what a page embeds as without changing the
    # file, so the free mtime check cannot be trusted until every hash is redone.
    every = index.get("boilerRev", 0) != rev
    entries = index.get("entries", {})
    stale, touched = [], {}
    for doc in docs:
        entry = entries.get(doc["key"])
        if entry is None:
            stale.append(doc)
            continue
        if not every and entry.get("m") == doc["mtime"]:
            continue
        if content_hash(strip_boilerplate(doc["text"], lines)) != entry.get("c"):
            stale.append(doc)
            # Forget the mtime, so a page left over by `limit` is still found
            # once the revision below has been recorded.
            entry["m"] = -1
        else:
            touched[doc["key"]] = doc["mtime"]   # touched, not changed
    alive = {d["key"] for d in docs}
    gone = set(entries) - alive
    for key, mtime in touched.items():
        entries[key]["m"] = mtime
    # Reported so `refresh` knows the index changed even when nothing was
    # embedded. Without it a re-saved-but-unedited note is re-hashed on every
    # single call, forever, because the cheap mtime check never gets updated.
    return stale, gone, False, len(touched)


def write_index(index):
    """Atomically, because the plugin may be reading this file at any moment."""
    os.makedirs(os.path.dirname(INDEX_PATH), exist_ok=True)
    tmp = f"{INDEX_PATH}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        json.dump(index, fh, ensure_ascii=False)
    os.replace(tmp, INDEX_PATH)


def refresh(render_session, limit=None, log=None):
    """Bring the index up to date. Returns what it did.

    Incremental by construction: only pages whose content actually changed are
    re-embedded, so the ordinary case after a few edits is a handful of Ollama
    calls and well under a second. `limit` caps how many pages one call will
    embed, so a first run over a whole vault cannot hang a tool call — it makes
    progress and says how much is left.
    """
    host, model = settings()
    index = load_index()
    docs = all_docs(render_session)
    lines = compute_boilerplate(docs)
    rev = save_boilerplate(lines)
    lines = set(lines)
    stale, gone, model_changed, touched = survey(docs, index, model, (rev, lines))
    if model_changed:
        index = {"version": CACHE_VERSION, "model": "", "entries": {}}
    retemplated = index.get("boilerRev", 0) != rev
    index["boilerRev"] = rev

    entries = index.setdefault("entries", {})
    for key in gone:
        entries.pop(key, None)

    remaining = len(stale)
    if limit is not None and len(stale) > limit:
        stale = stale[:limit]
    done = 0
    for doc in stale:
        text = strip_boilerplate(doc["text"], lines)
        segs = segment(text)
        if not segs:
            # All title and no thought. Recorded empty so it is not retried.
            entries[doc["key"]] = {"m": doc["mtime"], "c": content_hash(text), "segs": []}
            done += 1
            continue
        vectors = []
        for i in range(0, len(segs), BATCH):
            batch = segs[i:i + BATCH]
            vectors.extend(embed(host, model, [for_embedding(doc["title"], s, model) for s in batch]))
        entries[doc["key"]] = {
            "m": doc["mtime"],
            "c": content_hash(text),
            "segs": [{"v": to_b64(vectors[i]), "h": s["heading"], "p": s["text"][:PREVIEW]}
                     for i, s in enumerate(segs)],
        }
        done += 1
        if log:
            log(doc["key"])

    index["model"] = model
    if done or gone or touched or retemplated or not os.path.exists(INDEX_PATH):
        write_index(index)
    return {
        "indexed": done,
        "removed": sorted(gone),
        "left": max(0, remaining - done),
        "model": model,
        "pages": len(entries),
    }
