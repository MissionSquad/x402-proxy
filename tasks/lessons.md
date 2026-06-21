# Lessons

## Use dedicated file tools, never shell, for edits (2026-06-19)
**Correction:** Used `perl -0pi -e` (and earlier `cat`/`echo`-style shell) for a text replacement, which
triggered an approval prompt. The user runs unattended and treats every approval prompt as a defect.
**Rule:** For file edits ALWAYS use the Edit/Write tools (they never prompt). Never use `perl`, `sed`, `awk`,
`cat >`, redirects, or heredocs to modify files. Reserve Bash for atomic read-only/verification commands
(`yarn build`, `yarn test`, `yarn typecheck`, `node -e` checks) — run them as single commands, not chained.

## Verify runtime behavior before relying on it (2026-06-19)
Before depending on `fetch` `redirect:"manual"` and Node IPv6 normalization for the SSRF fix, confirmed both
with one-off `node -e` checks (`redirect:"manual"` returns the real 3xx + Location; `URL` normalizes
`::ffff:127.0.0.1` to hex `::ffff:7f00:1` and brackets IPv6 hostnames so `net.isIP` returns 0). This caught
that the guard must strip brackets and match the hex-mapped form, not the dotted form.
