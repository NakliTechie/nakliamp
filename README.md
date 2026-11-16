# NakliAmp

A music player that runs in a browser tab and never uploads a byte.

Point it at your music folder. It indexes what it finds, plays it, and keeps
the index on your device. There is no account, no cookie, and no telemetry.
There are **no analytics — verify with the network tab.**

`v0.3.0-m2`

---

## Where it comes from

Winamp, obviously — the compact player that sat on top of your own collection
and answered to nobody. NakliAmp takes the gene, not the pixels: a persistent
player, a library behind it, playlists as files you own, and a spectrum
bouncing away in the corner.

The nearer influence is [cliamp](https://github.com/bjarneo/cliamp), a terminal
Winamp that got the shape right — the picker with live preview, the keyboard
map, playlists as artifacts, the honest refusal. Where cliamp reaches thirteen
streaming services, NakliAmp deliberately does not — a browser tab cannot run
`yt-dlp`, and the services that a tab *could* reach are refused on charter
rather than on feasibility.

The part neither of them had: **the player tells you the truth about itself.**
Every track shows its real path — container, codec, which decoder actually ran,
what came out — including when it fell off the fast path and why.

## What it does

**Library.** Attach a folder — pick it, or drag it onto the window — and
NakliAmp indexes it in a background worker, subfolders included: ID3v2, Vorbis
comments, MP4 atoms, FLAC pictures, embedded art. Search is fuzzy and ranked,
so `skr` finds "Sakura". Playback remembers where you stopped.

The folder is remembered between sessions. Reopen NakliAmp and your library is
already there; if the browser wants its permission renewed, your indexed tracks
still list and one button restores access. Storage persistence is requested so
the browser does not evict the grant or the index.

**The index is a cache, not the truth.** Your folder is the truth. Losing the
index costs a rescan and nothing else.

**Playlists are files in your folder**, not rows in a database — an artifact
any other player can open, and one that NakliAmp's disappearance cannot take
from you. Reads **M3U**, **M3U8** (with `EXTINF`), **PLS**, **XSPF** and
**JSPF**; writes **M3U8**. Create, rename, reorder, delete; every edit rewrites
the file. An entry naming a remote stream, or one that tries to climb above the
folder you granted, is kept and counted as unresolved rather than followed.

**A persistent player.** The transport never goes away. Starting a track from
the library leaves you in the library — what is playing and what you could play
next are both on screen, always.

**A visualiser**, 14 modes plus None: Bars, Bars Dot, Bars Outline, Classic
Peak, Classic LED, Wave, Scope, Stereo, Pulse, Bricks, Columns, Scatter, Flame,
Matrix. **Stereo means stereo** — the engine splits whichever rung is playing
into two taps, so a mono file shows one side silent rather than a picture
invented from half a spectrum.

`v` cycles, the picker selects, `V` goes full window. Reduced motion slows it
rather than stopping it — that removes the movement, not the information.

## What it plays

NakliAmp tries every rung before it gives up on a file:

| Rung | Path | What it means |
|---|---|---|
| **R1** | WebCodecs via the Reel engine | Hardware decode, sample-accurate clock, full detail in the strip |
| **R2** | Native element passthrough | The browser's own decoder. Plays, loses gapless, and says so |
| **R3** | Software decode | NakliAmp decodes it itself when nothing else will |
| **R4** | Named refusal | Which file, which rung, and why |

**On the engine rung:** MP3, FLAC, AAC/M4A, Opus, Vorbis/OGG, WAV, and audio in
Matroska and WebM.

**On the native rung:** whatever your browser can decode, including containers
the engine has never heard of. An unrecognised container is not the same thing
as an unplayable one, so the browser gets to decide — and the strip tells you
it fell back.

**On the software rung:** AIFF, AIFC, CAF and AU, in 8/16/24/32-bit integer and
float, with G.711 companding. None of these are exotic — AIFF is what a Mac
rips to, CAF is what Logic and QuickTime write, AU is decades of Unix audio —
and Chrome decodes none of them by either other path. They are uncompressed, so
closing that gap needed a header parser rather than a codec, and it costs no
download.

**On the software rung, heavy build only:** WMA (v1, v2, Pro, Lossless),
WavPack, Monkey's Audio, Musepack (SV7 and SV8), TTA and DSD — through a custom
1.2 MB libav build carrying exactly those decoders and nothing else. The lean
build refuses them by name; a build's decoders are a property of that build.

Two more consequences worth knowing: **a file carrying video plays its audio**
rather than being refused, and **a refusal is a dismissible banner**, not a
screen that destroys your library and stops the music.

## Keyboard

| Key | Action |
|---|---|
| Space | Play or pause |
| Left / Right | Seek backward or forward 5 seconds (Shift: 30) |
| Up / Down | Raise or lower volume |
| M | Mute or unmute |
| N / P | Next or previous track |
| L | Open the library |
| v | Cycle visualiser mode |
| Shift+V | Full-window visualiser |
| Esc | Leave the full-window visualiser |
| ? | Show every shortcut |

## Part of naklios

NakliAmp is the **system music player of [naklios](https://naklios.dev)**. The
desktop model: an OS ships both a media player and a music player, and they are
not the same app.

- **[Reel](https://github.com/NakliTechie/reel) is the system media player** —
  open a file, watch it, close it. **NakliAmp owns the collection** — library,
  queue, playlists, resume, search. Different shape, same engine.
- **One media core, two apps.** NakliAmp is the first external consumer of
  Reel's engine, which is what proves that engine is separable at all.
- The standalone URL and the in-shell app are the same file.

Engine changes land upstream in Reel first and are pulled down; NakliAmp never
patches its vendored copy. The audio-graph seam the visualiser needs was added
to Reel, not worked around here.

## Two builds

**Single file, lean.** `dist/nakliamp.html` — the app, the engine and the
demuxer, about 0.9 MB, no external references. Save it anywhere and open it,
including straight off your filesystem over `file://`.

**Single file, full.** `dist/nakliamp-full.html` — the same plus the wasm
software decoder, about 2.8 MB. Adds WMA, WavPack, Monkey's Audio, Musepack, TTA and DSD. The wasm is embedded as
bytes, so it still fetches nothing.

```sh
node scripts/build-single-file.mjs
node scripts/build-single-file.mjs --full
```

**Hosted.** The same app deploys as Cloudflare Worker Static Assets at
<https://naklios.dev/apps/nakliamp/>. The published package contains only the
app, its modules, the engine, the Mediabunny runtime and licence, and the
corresponding-source notice in `VENDOR.md`.

## Vendored engine

NakliAmp pins Reel commit `292b0916d7f139f6f27fe14661772a7dee43da7d` and does
not patch it. See `VENDOR.md` for file hashes and the corresponding-source
notice. NakliAmp never imports Mediabunny directly; the pinned engine is the
only ingress, and a gate enforces it.

## Verification

```sh
./scripts/verify-browser.sh
```

That runs the static gates, the Node unit suites, and eight Chromium harnesses
twice each, cold and warm: golden audio, UI smoke, the library scan gate, the
library end-to-end gate, universal playback, the analyser tap, wasm decode,
and the single-file release.

**Any console error fails the run, and so does any request to an origin other
than the one serving the page** — whether or not it succeeds. That last part is
what actually backs the no-analytics claim above; checking only for *failed*
requests, which is what it used to do, would pass a working beacon.

The release gate drives the two artifacts through the DOM alone. There is no
test seam in them to drive: it is cut at build time, so the file the gate opens
is the file you download, byte for byte.

The end-to-end gate attaches a real folder and plays from it. A folder grant
needs a user gesture no harness can give, so it uses an OPFS directory:
`navigator.storage.getDirectory()` returns a real directory handle with no
prompt, and every line of app code after that point is the one a granted folder
runs.

The committed release gate is Chromium-only. Safari and Firefox behaviour is
not release evidence.

## No CI

There is no continuous integration and no GitHub Actions workflow. Every gate
that matters needs a real browser, because the harnesses drive Chromium against
committed fixtures and fail on any console error or network request. A green
tick from a runner that cannot open an audio context would mean less than
nothing.

## Since the v1 parity build (2026-11-16)

Built and checked in Chrome: a play queue with shuffle and repeat, gapless
playback between tracks of one album, crossfade, ReplayGain from tags and from
an on-device loudness scan, a 10-band equaliser, Media Session (media keys and
the system now-playing panel), browse views by album, artist, genre, year and
folder, ratings and favourites, smart playlists, tag editing written back to
the file (Chromium), lyrics (embedded and `.lrc`), folder art, a Milkdrop
visualiser, light and dark themes, a mini player, a keyboard-map overlay (`?`),
AI playlists from a description through the NakliOS model, and a command list
(`commands.json`) that NakliOS and agents can call.

Since v1.x (2026-11-17): cue sheets, several music folders, duplicates, rename and
find-and-replace in tags, playback speed, sleep timer, mono, volume in dB, output
device choice, Winamp `.eqf` presets, ALAC, classic `.wsz` skins through Webamp,
31 visualiser modes, "More like this", genre fill, a command bar, WebMCP, and three
opt-in services that are off until you turn each one on: MusicBrainz tags and
covers, LRCLIB lyrics and ListenBrainz scrobbling. The full matrix and how each row
was checked: `docs/specs/nakliamp-parity-001.md`.
