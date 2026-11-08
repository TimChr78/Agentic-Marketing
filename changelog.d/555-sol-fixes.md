---
section: Changed
issues: [555]
---
- Automatic scrolling is immediate rather than smooth: the copilot's newest message and the highlighted approvals proposal no longer request `behavior: 'smooth'`, so `prefers-reduced-motion: reduce` is honoured, and a source scan fails any future smooth scroll.
- A content or asset list on a phone reserves its compact 72 px row geometry while the read is pending instead of the desktop gallery's 170 px tiles, so the list no longer jumps when the rows arrive.
- Providers says what it did: a partial read's Retry now re-reads only the channels that failed, and the "Couldn’t load providers" notice appears only when every channel failed (or above a stale read), never after a fully successful one.
