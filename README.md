<h1 align="center">NakliAmp</h1>

<p align="center">
  <strong>A music player in a browser tab that plays the folder of music you already own,<br>
  with the index kept on your device and nothing uploaded.</strong>
</p>

<p align="center">
  NakliAmp is one web page or one HTML file. It has no account, no server and no telemetry.
</p>

<p align="center">
  <img alt="account: none" src="https://img.shields.io/badge/account-none-3fb950?style=flat-square">
  <img alt="network: opt-in only" src="https://img.shields.io/badge/network-opt--in%20only-3fb950?style=flat-square">
  <img alt="build: one HTML file" src="https://img.shields.io/badge/build-one%20HTML%20file-3fb950?style=flat-square">
  <img alt="version 0.3.0-m2" src="https://img.shields.io/badge/version-0.3.0--m2-3fb950?style=flat-square">
</p>

## Install

| | |
|---|---|
| **NakliOS** | Open [naklios.dev](https://naklios.dev) and start **NakliAmp**, the system music player. |
| **Browser** | Open <https://naklios.dev/apps/nakliamp/>, the same app outside the NakliOS shell. |
| **One file, lean** | `node scripts/build-single-file.mjs` writes `dist/nakliamp.html` (2.5 MB). |
| **One file, full** | `node scripts/build-single-file.mjs --full` writes `dist/nakliamp-full.html` (4.9 MB), with the software decoder for WMA, WavPack, Monkey's Audio, Musepack, TTA, DSD and ALAC. |

Pick your music folder, or drag it onto the window. NakliAmp indexes it in a background worker,
subfolders included, and lists the tracks as it reads their tags. Press Space to play. Next time
you open NakliAmp the library is already there; if the browser asks to renew the folder
permission, one button restores it. There is no sign-up and no settings file. There are no
analytics: verify with the network tab.

## Why

Your music is a folder of files you bought, ripped or recorded. Most players want an account,
a cloud library or a desktop install before they will play it.

NakliAmp plays that folder in a tab. It has a play queue with shuffle and repeat, gapless playback
within an album, crossfade, ReplayGain, a 10-band equaliser, media keys, browse by album, artist,
genre, year and folder, smart playlists, tag editing, lyrics, 31 visualiser modes and classic `.wsz`
skins. The index is a cache over your folder; losing it costs a rescan. Playlists are `.m3u8` files
written into your folder, so any other player can open them. Tag edits write back to the file in
Chromium only; elsewhere the tag editor offers each edited file as a copy to download.

## What it plays

NakliAmp tries four decoders in order for each file and names the one that ran in the track
strip. The vendored Reel engine (WebCodecs) plays MP3, FLAC, AAC/M4A, Opus, Vorbis, WAV and
audio in Matroska and WebM. Next comes the browser's own audio element, which is not gapless,
and the strip says so. NakliAmp's own decoder then reads AIFF, AIFC, CAF and AU (8 to 32-bit
integer and float, G.711). The full build adds a libav.js decoder for WMA, WavPack, Monkey's
Audio, Musepack, TTA, DSD and ALAC. A file that none of them can play gets a dismissible banner
naming the file, the decoder and the reason. The 19 audio fixtures listed in `test/manifest.json` are played in Chromium by
`test/golden-audio.html`, `test/universal.html` and `test/wasm-decode.html`.

## Services you can turn on

NakliAmp itself never phones home. It contacts only the services you turn on in the Network
services panel, and each one is off until you do:

- **MusicBrainz** and **Cover Art Archive** fill in album tags and covers you approve.
- **LRCLIB** fetches lyrics for the playing track.
- **ListenBrainz** records what you play, with your token, and queues listens while offline.

The panel says what each service receives before you turn it on. The page's
Content-Security-Policy allows no other origin, and `scripts/verify-delivery.mjs` fails if
it does. `scripts/verify-boundary.mjs` calls every network feature with nothing turned on and
fails on any request; with one service on, it fails on a request to any other origin.

## Part of NakliOS

NakliAmp is the NakliOS music player; [Reel](https://github.com/NakliTechie/reel) is the media
player. Both run the Reel engine, which NakliAmp pins at one commit and `scripts/verify-vendor.mjs`
checks against the hashes in `VENDOR.md`. Inside NakliOS, NakliAmp follows the host theme and can
make a playlist from a description through the NakliOS model; without a model, every other feature
still works. Its 85 player actions are published in `commands.json`. When the browser offers
`document.modelContext`, they become WebMCP tools; destructive ones need its confirmation hook.

## Commands

```
?            # every keyboard shortcut, searchable
Mod+K        # command bar: type what you want ("shuffle by albums")
Space N P    # play or pause, next, previous
Left Right   # seek 5 seconds (Shift: 30); 0 to 9 jump to 0% to 90%
Up Down M    # volume in 2 dB steps, mute
Q Shift+Q    # add to queue, play next
S R E        # shuffle, repeat, equaliser on or off
[ ] Shift+S  # slower, faster, stop after this track
V Shift+V    # next visualiser, full-window visualiser
L / Y I      # library, search, lyrics, track inspector (Shift+M: mini player)
```

Every shortcut runs a command from the list that `commands.json` publishes.

## Verify it yourself

```
./scripts/verify-browser.sh                        # every gate below, then 10 browser harnesses, twice each
node --test test/*.test.mjs                        # the Node unit suites
node scripts/verify-boundary.mjs                   # engine boundary and the network check above
node scripts/verify-delivery.mjs                   # imports present, CSP allowlist, source notice
node scripts/verify-single-file.mjs [--full]       # the built file references nothing outside itself
python3 scripts/cdp-harness.py <harness-url>       # one harness in a running Chrome over CDP
```

Each harness fails on any console error and on any request to an origin other than the one
serving the page, whether or not the request succeeds. The release harness drives the two built
files through the DOM alone, because the test hooks are cut at build time. What each feature row
covers, and what was not checked in a browser, is in `docs/specs/nakliamp-parity-001.md`.
The committed release gate is Chromium-only. Safari and Firefox behaviour is not release evidence.

## License

NakliAmp's own code is MIT ([LICENSE](LICENSE)). Vendored code keeps its own licence (`VENDOR.md`):
Mediabunny MPL-2.0, libav.js LGPL-2.1 with its source notice, music-metadata, Butterchurn and Webamp MIT
(neutral skin art, bundled libraries in `vendor/webamp/LICENSES-bundled.txt`). The Reel engine is MIT (`engine/LICENSE-reel.txt`).

What shipped: [docs/specs/nakliamp-parity-001.md](docs/specs/nakliamp-parity-001.md) · vendored code: [VENDOR.md](VENDOR.md) · for agents: [commands.json](commands.json)
