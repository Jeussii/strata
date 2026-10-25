/**
 * The folders that are in the vault but not in the graph, and what each is for.
 *
 * They used to be one folder, `Full/`, holding three different things under a
 * name that said none of them: originals that atoms were split from, material
 * taken in whole and never split (an article, a podcast), and superseded
 * versions. The first two are worth finding; the third must not compete with
 * the page that replaced it. One folder could not be both searched and not.
 *
 *   Library  taken in whole — originals, articles, transcripts, recordings,
 *            brainstorms. Searched, never drawn: a 30,000-word original sits
 *            close to every atom taken out of it and would bury them as a hub.
 *   Archive  replaced — superseded plans, pre-rewrite copies, absorbed
 *            duplicates. Searched, ranked below everything current.
 *   Inbox    written, not yet filed. Searched, never drawn: it has no topics
 *            yet, so it would arrive in the graph as an orphan every time.
 */
export const LIBRARY = "Library";
export const ARCHIVE = "Archive";
export const INBOX = "Inbox";

const UNDRAWN = [`${LIBRARY}/`, `${ARCHIVE}/`, `${INBOX}/`];

/** In the vault and in search, but never a node. */
export function searchOnly(path: string): boolean {
  return UNDRAWN.some((prefix) => path.startsWith(prefix));
}

export function archived(path: string): boolean {
  return path.startsWith(`${ARCHIVE}/`);
}

/** A filed page: the only kind a capture or a filing suggestion should be compared with. */
export function filed(path: string): boolean {
  return !searchOnly(path) && !path.startsWith("session:");
}
