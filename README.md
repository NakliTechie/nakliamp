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
| R3 | Software decode | NakliAmp decodes it itself when nothing else will |
| R4 | Named refusal | It says which file, which rung, and why |

Three consequences worth knowing:

- **A container the engine has never heard of is not automatically a dead end.**
  If your browser can play it, NakliAmp plays it and tells you it fell back.
- **A file with video plays its audio.** Music videos and rips are not refused.
- **R3 decodes what the browser will not.** AIFF, AIFC, CAF and AU play here.
  None of them are exotic — AIFF is what a Mac rips to, CAF is what Logic and
  QuickTime write, AU is decades of Unix audio — and Chrome decodes none of them
  by either path. They are uncompressed, so closing that gap needed a header
  parser, not a codec, and it costs no download.
- **A refusal stays a refusal.** WMA, Monkey's Audio, WavPack, Musepack and DSD
  are compressed formats no browser decodes, so they are still named and
  refused. They need a real decoder, which is what the second build artifact
  will carry.

The honesty strip names the actual path for every track — container, codec,
decode path, output — plus why a file left the engine path and whether a video
track went unplayed.

## Library

Attach a folder — pick it, or drag it onto the window — and NakliAmp indexes it
in a background worker, subfolders included: ID3v2, Vorbis comments, MP4 atoms,
FLAC pictures. Search is fuzzy and ranked, so `skr` finds "Sakura". Playback
remembers where you stopped.

The folder is remembered. Reopen NakliAmp and your library is already there; if
the browser needs its permission renewed, your indexed tracks still list and one
button restores access. Storage persistence is requested so the browser does not
evict the grant or the index.

The index is a cache, not the truth. Your folder is the truth. Losing the index
costs a rescan and nothing else.

A folder grant that a browser revokes between sessions is expected, not an
error: your indexed library still lists, and NakliAmp offers to reopen the
folder.

## Playlists

Playlists are files in your folder, not rows in a database. The index is a cache
you can throw away; the playlist is an artifact any other player can open and
NakliAmp's disappearance cannot take.

Reads **M3U**, **M3U8** (with `EXTINF`), **PLS**, **XSPF**, and **JSPF**. The
scan finds them beside your music and lists them. Writes **M3U8**, which every
player understands.

Entries are resolved relative to the playlist's own directory. An entry that
names a remote stream, or that tries to climb above the folder you granted, is
kept and counted as unresolved rather than followed or silently dropped.

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

R3 decoders are plugged in rather than built in, so which formats a build can
decode is a property of the build, not of the engine.

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

NakliAmp pins Reel commit `292b0916d7f139f6f27fe14661772a7dee43da7d` and does
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

Stated plainly rather than implied by omission: R3 for compressed formats
(WMA, APE, WavPack, Musepack, DSD — the second `nakliamp-full.html` artifact),
gapless playback, the equaliser, playlists as `.m3u8` files in your folder, Media
Session integration, and the compact player. See `plan/cliamp-parity.md` for
the full feature target and `plan/workplan.md` for the order.
