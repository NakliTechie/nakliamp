# NakliAmp

A music player that runs in a browser tab and never uploads a byte.

Point it at your music folder. It indexes what it finds, plays it, and keeps
the index on your device. There is no account, no cookie, and no telemetry.
There are **no analytics — verify with the network tab.**

## Play anything

NakliAmp tries every rung before it gives up on a file:

| Rung | Path | What it means |
|---|---|---|
| R1 | WebCodecs via the Reel engine | Hardware decode, sample-accurate clock, full detail in the honesty strip |
| R2 | Native element passthrough | The browser's own decoder. Plays, loses gapless, and the strip says so |
| R3 | Software decode | Specced, not built. See below |
| R4 | Named refusal | It says which file, which rung, and why |

Three consequences worth knowing:

- **A container the engine has never heard of is not automatically a dead end.**
  If your browser can play it, NakliAmp plays it and tells you it fell back.
- **A file with video plays its audio.** Music videos and rips are not refused.
- **A refusal stays a refusal.** WMA and Monkey's Audio have no browser decoder,
  so they are named and refused rather than retried into a vaguer error. R3 is
  where they will eventually play.

The honesty strip names the actual path for every track — container, codec,
decode path, output — plus why a file left the engine path and whether a video
track went unplayed.

## Library

Open a folder and NakliAmp indexes it in a background worker: ID3v2, Vorbis
comments, MP4 atoms, FLAC pictures. Search is fuzzy and ranked — `skr` finds
"Sakura". Playback remembers where you stopped.

The index is a cache, not the truth. Your folder is the truth. Losing the index
costs a rescan and nothing else.

A folder grant that a browser revokes between sessions is expected, not an
error: your indexed library still lists, and NakliAmp offers to reopen the
folder.

## Keyboard

| Key | Action |
|---|---|
| Space | Play or pause |
| Left / Right | Seek backward or forward 10 seconds |
| Up / Down | Raise or lower volume |
| M | Mute or unmute |
| L | Open the library |
| N / P | Next or previous track in the queue |

## Two builds

**Single file.** `dist/nakliamp.html` is one self-contained file: the app, the
engine, and the demuxer, about 0.8 MB, with no external references at all. Save
it anywhere and open it, including straight off your filesystem over `file://`.
Build it with:

```sh
node scripts/build-single-file.mjs
```

**Hosted.** The same app deploys as Cloudflare Worker Static Assets at
<https://nakliamp.naklitechie.com/>. The published package contains only the
app, its modules, the engine, the Mediabunny runtime and licence, and the
corresponding-source notice in `VENDOR.md`.

## Vendored engine

NakliAmp pins Reel commit `28e871525b766d1ae84790e150eb447cc396badc` and does
not patch it. Engine changes land upstream in Reel first and are pulled down.
See `VENDOR.md` for file hashes and the corresponding-source notice. NakliAmp
never imports Mediabunny directly; the pinned engine is the only ingress.

## Verification

```sh
./scripts/verify-browser.sh
```

That runs the static gates, the Node unit suites, and five Chromium harnesses
twice each, cold and warm: golden audio, UI smoke, the library scan gate, the
universal playback gate, and the single-file release gate. Any console error or
network request fails the run.

The committed release gate is Chromium-only. Safari and Firefox behaviour is
not release evidence.

Validate the hosted package without changing Cloudflare state:

```sh
node scripts/verify-delivery.mjs
```

After starting `wrangler dev`, verify the served boundary with:

```sh
node scripts/verify-deployment.mjs http://127.0.0.1:8787/
```

## Not built yet

Stated plainly rather than implied by omission: R3 software decode, gapless
playback, the equaliser, playlists as `.m3u8` files in your folder, Media
Session integration, and the compact player. See `plan/cliamp-parity.md` for
the full feature target and `plan/workplan.md` for the order.
