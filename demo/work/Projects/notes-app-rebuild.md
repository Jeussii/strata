---
type: project
status: active
started: 2026-01-15
---

# Notes App Rebuild

Replacing the editor's storage layer. The old one kept a single blob per
document, which made every concurrent edit a merge conflict and every undo a
full rewrite.
