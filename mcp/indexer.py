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
TRANSCRIPTS = os.path.realpath(
    os.environ.get("STRATA_TRANSCRIPTS") or os.path.join(HOME, ".claude", "projects")
)

SKIP_VAULT_FOLDERS = {"Topics", "Sources", "Full", "Inbox"}
SKIP_VAULT_TYPES = {"topic", "source", "full"}
SKIP_WORK_PREFIX = ("Projects/", "Courses/", "Admin/")


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


def for_embedding(title, seg):
    head = f"{title} — {seg['heading']}" if seg["heading"] else title
    return f"clustering: {head}. {seg['text']}"[:SEG_CHARS]


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


def settings():
    """Host and embedding model, read from the plugin's own settings."""
    host, model = "http://localhost:11434", "nomic-embed-text"
    try:
        data = json.loads(read_exact(DATA_PATH))
        sem = data.get("semantic") or {}
        host = sem.get("host") or host
        model = sem.get("model") or model
    except Exception:
        pass
    return host, model


def is_local(host):
    """Vault text goes to whatever host is configured. It should be this machine."""
    return re.match(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/?$", host.strip()) is not None


def survey(docs, index, model):
    """Which docs the index no longer speaks for, and which entries are orphans.

    mtime first because it is free, hash second because it is authoritative —
    the plugin's rule, so that re-saving a note without editing it costs
    nothing on either side. A changed model invalidates everything, because
    vectors from two models do not share a space.
    """
    if index.get("model") and index["model"] != model:
        return list(docs), set(), True, 0
    entries = index.get("entries", {})
    stale, touched = [], {}
    for doc in docs:
        entry = entries.get(doc["key"])
        if entry is None:
            stale.append(doc)
            continue
        if entry.get("m") == doc["mtime"]:
            continue
        if content_hash(doc["text"]) != entry.get("c"):
            stale.append(doc)
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
    stale, gone, model_changed, touched = survey(docs, index, model)
    if model_changed:
        index = {"version": CACHE_VERSION, "model": "", "entries": {}}

    entries = index.setdefault("entries", {})
    for key in gone:
        entries.pop(key, None)

    remaining = len(stale)
    if limit is not None and len(stale) > limit:
        stale = stale[:limit]
    done = 0
    for doc in stale:
        segs = segment(doc["text"])
        if not segs:
            # All title and no thought. Recorded empty so it is not retried.
            entries[doc["key"]] = {"m": doc["mtime"], "c": content_hash(doc["text"]), "segs": []}
            done += 1
            continue
        vectors = []
        for i in range(0, len(segs), BATCH):
            batch = segs[i:i + BATCH]
            vectors.extend(embed(host, model, [for_embedding(doc["title"], s) for s in batch]))
        entries[doc["key"]] = {
            "m": doc["mtime"],
            "c": content_hash(doc["text"]),
            "segs": [{"v": to_b64(vectors[i]), "h": s["heading"], "p": s["text"][:PREVIEW]}
                     for i, s in enumerate(segs)],
        }
        done += 1
        if log:
            log(doc["key"])

    index["model"] = model
    if done or gone or touched or not os.path.exists(INDEX_PATH):
        write_index(index)
    return {
        "indexed": done,
        "removed": sorted(gone),
        "left": max(0, remaining - done),
        "model": model,
        "pages": len(entries),
    }
