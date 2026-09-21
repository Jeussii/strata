---
type: full
captured: 2026-03-14
---

# Interface debt, unsplit

The original long-form piece these atoms were taken from. A full text is an
archive, not a node: it carries no `topics`, never enters the graph, and is
never embedded. It exists so that splitting a long document costs nothing.

Every shipped interface carries two ledgers. The first is the familiar one —
the shortcuts in the code, the migration nobody finished, the test that was
skipped. That ledger is paid down by the team, in sprints, and it is at least
visible to the people who owe it.

The second ledger is the one the team never sees. It is the extra second the
user spends looking for the button that moved, the third of them who guess
wrong at a label, the support ticket that gets filed once a week forever. That
cost is real and it is paid outside the building, which is exactly why it never
gets prioritised: nothing in the repository records it, and no burndown chart
has a column for it.

The asymmetry is what makes it compound. Code debt is paid once by a team;
interface debt is paid once each by every person who uses the thing, for as
long as the thing exists. A confusing control shipped to ten thousand people is
not one mistake, it is ten thousand small ones, and the interest runs in a
currency the team does not hold.
