---
section: Fixed
issues: [1273]
---
- Approvals keeps its loaded pages only for the signed-in person and workspace: a decision clears every status tab's pages, a request that moved between queues is shown once, and signing out or switching workspace forgets them.
- Topics discards a Load more page that arrives after creating or archiving reset the list, so no topic appears twice or disappears.
- Previews reread topic names after a workspace switch, so a condition never shows another workspace's topic name.
- A segment review counts as viewed as soon as its rule is on screen: the live audience estimate no longer keeps the row on “Not yet viewed” when a reviewer closes the drawer before the count arrives.
