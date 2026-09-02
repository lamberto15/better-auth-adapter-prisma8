---
"better-auth-adapter-prisma8": patch
---

Fixed a TOCTOU file-system race in contract discovery (`readIfExists`, used by the `generate` CLI path): it checked a file with `stat(path)` and then read it with a separate `readFile(path)` call, so whatever the path resolved to could change between the two operations. Now checks and reads through a single open file handle instead, so both operations are pinned to the exact file that was opened. Flagged by CodeQL (`js/file-system-race`); real-world exploitability was narrow (a local CLI reading the developer's own project file, not a networked or multi-tenant surface), but the fix was simple and correct so no reason not to take it.
