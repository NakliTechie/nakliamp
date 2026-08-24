# Vendored playback engine

NakliAmp vendors Reel's public engine boundary without modification.

- Upstream repository: `https://github.com/NakliTechie/reel`
- Reel commit: `e1fbff5432587bb194cb0e1a7d7efbaf1da7f13b`
- Reel engine: `engine/reel-engine.mjs`
- Mediabunny release: `1.51.0`
- Mediabunny license: MPL-2.0

## Integrity

| Path | SHA-256 |
|---|---|
| `engine/reel-engine.mjs` | `fbe028453dda8dffda69af7fac4d14a700e182b62b03eb0c8ddfd455170b1a3b` |
| `vendor/mediabunny/mediabunny-1.51.0.min.mjs` | `1cd761e442a173c461b1a63cba29cb0816383f3b93b78d64b6e44c6dbce85d2b` |
| `vendor/mediabunny/LICENSE-MPL-2.0.txt` | `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04` |

Keep the three paths together. NakliAmp imports only `engine/reel-engine.mjs`.
The engine remains the sole Mediabunny ingress. Engine changes land upstream in
Reel, pass Reel's gate, then arrive here as a new exact commit and hash set.

Corresponding Mediabunny source is available from the upstream release and
package URLs recorded in Reel's `VENDOR.md` at the pinned commit. Recipients may
also obtain the source from `https://github.com/Vanilagy/mediabunny/tree/v1.51.0`.
