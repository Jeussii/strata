---
type: topic
---

```dataview
TABLE WITHOUT ID link(file.link, file.name) AS Note, origin AS Origin, horizon AS Horizon
FROM "Notes"
WHERE contains(topics, this.file.link) AND status != "archived"
SORT captured DESC
```
