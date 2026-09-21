---
type: entry
kind: idea
origin: my-thought
for:
  - "[[notes-app-rebuild]]"
about:
  - storage
horizon: timeless
captured: 2026-02-03
bridges:
  - "knowledge/Notes/note-error-is-a-design-problem.md"
---

# Undo Is a Feature, Not a Buffer

Treating undo as a stack of recent keystrokes makes it a convenience. Treating
it as the guarantee that no action is final makes it a design constraint, and
the storage layer has to be built for it rather than around it.
