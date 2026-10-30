# Change highlights and drag export

M6b implements the workflow decisions in `docs/PLAN.md`.

Each document session owns one optional in-memory baseline. A clean external reload captures the previous text on its first accepted rewrite. Later rewrites keep that baseline. Dirty-file conflict choices keep their existing behavior. Mark Seen clears the baseline. Returning to a tab clears watch marks only after that version was visible for at least one second before leaving. Updates received while away remain unread.

The Git HEAD toggle reads the repository root and committed file with bounded, timed argument-array git calls. It never writes git state. Unavailable git, untracked files, missing HEAD and files outside a repository disable the toggle with a reason. Turning it off returns to watch mode with the current version seen.

The render worker parses baseline and current text using the existing source ranges, without syntax highlighting. Source-content fingerprints match unchanged blocks. An ordered subsequence of those matches separates insertions, edits and deletions. Changed blocks get static gutter marks. Deletions get thin markers at the next block boundary. Only explicit next and previous commands scroll.

A footer export button prepares HTML or PDF through the existing export pipeline. The drag handle becomes available only after the complete temporary file exists. A document revision or format change invalidates the handle. Temporary files remain available for ten minutes after use and are removed on exit. A small export function isolates this from the shared export-job module planned for M6a.

Verification covers block diffs, session baseline lifetimes, bounded git reads, temporary export retention, native watch and conflict behavior, Git HEAD, and prepared export content. Required app checks and performance receipts are kept under `.audit/m6b/`.
