# Golden audio gate

The eight files in `fixtures/` are copied without modification from Reel commit
`28e871525b766d1ae84790e150eb447cc396badc`. The manifest records byte counts and
SHA-256 digests. `scripts/verify-fixtures.mjs` rejects drift and undeclared media.

These committed artifacts are authoritative. Reel's fixture generator documents
how to create semantically equivalent inputs; byte-identical regeneration across
FFmpeg builds is not claimed.
