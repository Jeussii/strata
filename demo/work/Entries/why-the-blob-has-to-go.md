---
type: entry
kind: decision
origin: my-thought
for:
  - "[[notes-app-rebuild]]"
about:
  - storage
  - concurrency
horizon: situational
captured: 2026-01-20
bridges:
  - "knowledge/Notes/note-interface-debt.md"
---

# Why the Blob Has to Go

One document, one blob, one writer. Every feature we have shipped since has been
a workaround for that sentence, and each workaround made the next one harder to
write. This is interface debt in the storage layer: the shape was decided before
we knew what we were building, and it has been charging interest ever since.
