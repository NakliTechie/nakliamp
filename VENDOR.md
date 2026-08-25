# Vendored playback engine

NakliAmp vendors Reel's public engine boundary without modification.

- Upstream repository: `https://github.com/NakliTechie/reel`
- Reel commit: `292b0916d7f139f6f27fe14661772a7dee43da7d`
- Reel engine: `engine/reel-engine.mjs`
- Mediabunny release: `1.51.0`
- Mediabunny license: MPL-2.0
- libav.js release: `6.10.9.0`, variant `nakliamp`
- libav.js license: LGPL-2.1 (ffmpeg configured without `--enable-gpl`)

## Integrity

| Path | SHA-256 |
|---|---|
| `engine/reel-engine.mjs` | `791a691fd8d0d95c9cf7fd27adf3bad2469c918f15e30ed9e57f05d0dad4c175` |
| `vendor/mediabunny/mediabunny-1.51.0.min.mjs` | `1cd761e442a173c461b1a63cba29cb0816383f3b93b78d64b6e44c6dbce85d2b` |
| `vendor/mediabunny/LICENSE-MPL-2.0.txt` | `3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04` |
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm` | `78c9428535ab762fc928cd5126df402639f9e647e7777d649879ed9e29bf7bab` |
| `vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs` | `e5e97e424b6bc20549e82844ff82ff33ab15e8e2c3accb6f21ed913404c769aa` |
| `vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs` | `2a47ff87a4c25022c39bc6bf077e0400af5bdef7aa341e442537a9864c3709be` |
| `vendor/libav/LICENSE-LGPL-2.1.txt` | `20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95` |
| `vendor/libav/LICENSE-LGPL-NOTICE.md` | `afb8d248e345d343a45f74a5666f850d1920fb5a0006621a5a45e570687933bf` |

Keep the three paths together. NakliAmp imports only `engine/reel-engine.mjs`.
The engine remains the sole Mediabunny ingress. Engine changes land upstream in
Reel, pass Reel's gate, then arrive here as a new exact commit and hash set.

## libav.js — the R3 software decoder

Built from `https://github.com/Yahweasel/libav.js` at tag `v6.10.9.0` with a
custom variant, because no prebuilt variant carries these codecs:

```sh
node configs/mkconfig.js nakliamp '["audio-filters","demuxer-asf","decoder-wmav1",
  "decoder-wmav2","decoder-wmapro","decoder-wmalossless","demuxer-wavpack",
  "decoder-wavpack"]'
make build-nakliamp
```

Build it inside libav.js's own `emscripten/emsdk` Docker image. A local
Homebrew emscripten 6.0.1 produces an **empty `libavutil.a`** and the link
fails; the pinned toolchain is the supported path.

**LGPL-2.1 obligations.** The library must stay replaceable. In the hosted and
source builds the `.wasm` ships as its own file and can be swapped for another
build of the same interface. The full licence text travels alongside it, and
corresponding source is `https://github.com/Yahweasel/libav.js` at tag
`v6.10.9.0` plus the configuration above, which reproduces this binary. Do not
substitute a build configured with `--enable-gpl`: that would relicense
NakliAmp itself.

Corresponding Mediabunny source is available from the upstream release and
package URLs recorded in Reel's `VENDOR.md` at the pinned commit. Recipients may
also obtain the source from `https://github.com/Vanilagy/mediabunny/tree/v1.51.0`.
