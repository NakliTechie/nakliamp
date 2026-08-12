# NakliAmp

NakliAmp plays music files from your device in a browser tab. Drop one track or
open it from the file picker. The current engine proof supports MP3, FLAC,
AAC/M4A, Opus, Vorbis/OGG, WAV, and Opus-in-MKA. WMA is refused with a named
reason.

Your audio stays on your device. NakliAmp has no account, no cookies, and no
telemetry. There are **no analytics — verify with the network tab.**

## Current milestone

Version `0.1.0-m0` is the single-track engine proof. Chromium uses the pinned
Reel engine with `AudioDecoder` and Web Audio. Browsers without `AudioDecoder`
use their native audio path when the codec is supported. The honesty strip names
the active path and states when gapless playback is unavailable.

The public M0 build is a preview. The committed release gate is Chromium-only.
Safari and Firefox behavior is not release evidence for this milestone.

The library, metadata scanner, queue, playlists, EQ, compact player, Media
Session integration, sidecar, and agent face remain later milestones.

## Keyboard map

| Key | Action |
|---|---|
| Space | Play or pause |
| Left / Right | Seek backward or forward 10 seconds |
| Up / Down | Raise or lower volume |
| M | Mute or unmute |

## Vendored engine

NakliAmp pins Reel commit `28e871525b766d1ae84790e150eb447cc396badc`.
See `VENDOR.md` for file hashes and the corresponding-source notice. NakliAmp
does not patch the copied engine or import Mediabunny directly.

## Verification

Run the committed checks from the repository root:

```sh
./scripts/verify-browser.sh
```

## Publication

The standalone preview deploys as Cloudflare Worker Static Assets at
<https://nakliamp.naklitechie.com/>. The public package contains only the app,
the NakliAmp and pinned Reel engine modules, the Mediabunny runtime and license,
and the corresponding-source notice in `VENDOR.md`.

Validate the package without changing Cloudflare state:

```sh
node scripts/verify-delivery.mjs
wrangler deploy --dry-run
```

After starting `wrangler dev`, verify the served boundary with:

```sh
node scripts/verify-deployment.mjs http://127.0.0.1:8787/
```
