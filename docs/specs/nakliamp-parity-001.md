# NakliAmp: music player parity matrix

**Doc ID:** nakliamp-parity-001
**Status:** v1 APPROVED by Chirag (2026-11-16, "Approve NakliAmp") and BUILT (2026-11-16). Checks that ran: `node --test test/*.test.mjs` (557 pass), the static gates, both single-file builds, and nine browser harnesses run twice each in Chrome over CDP (`scripts/cdp-harness.py`), including the new `test/v1-features.html` (38 checks). Each v1 row says how it was checked and what was not. v1.x BUILT 2026-11-17 under Chirag's overnight instruction ("1, 1.x and whatever is left"): every v1.x row is checked by `test/v1x-features.html` (28 checks) or `test/wasm-decode.html`, run twice each with the other harnesses in Chrome over CDP; `node --test` 635 pass.
**Reference systems:** Winamp (skins, visualisers, keyboard heritage), foobar2000 (gapless, ReplayGain, components), MusicBee (library, tag editing, EQ), Swinsian (smart playlists, folder watching, CUE sheets), Plexamp (queue, fades, AI playlists), Apple Music in local-library mode, Doppler (album-first library), VLC's audio side (formats). cliamp (`plan/cliamp-parity.md`) stays the terminal baseline already adopted on 2026-08-24.
**Evidence:** the research run `naklios/plan/research/2026-11-16-nakliamp-music-player-parity/report.md` (VERIFIED 2026-11-16: 8 sections, all four gates pass; claim sample after one repair 7 supported, 3 partial, 0 unsupported). Rows marked R come from its architecture, limits or recommendation passages.

## How to read this matrix

NakliAmp's core job is one sentence: **point it at your own music folder and it plays your collection the way a good desktop player does (browse, queue, gapless, even loudness, EQ, media keys), with the index on your device, no account and no upload.**

Each row has one scope value:

- **Built (exists)**: NakliAmp already does this. The note says how I confirmed it: by reading the source (file and line), and where a test covers it, by `node --test test/*.test.mjs` (113 of 113 pass, run 2026-11-16).
- **v1**: in the parity release. The build ends when every v1 row passes its check.
- **v1.x**: wanted, built after v1, in the order listed.
- **Waived**: out of scope by default, because it needs a server or a streaming catalogue, sits outside the core job, or the browser cannot do it well. Chirag can un-waive any row.

`Src`: **W** Winamp, **F** foobar2000, **M** MusicBee, **S** Swinsian, **P** Plexamp, **A** Apple Music, **D** Doppler, **V** VLC, **C** cliamp, **B** most of them, **R** the research report.

## Architecture (from the research, decided here unless Chirag objects)

- **One audio graph that every decoder feeds** (R). The existing decode ladder stays: WebCodecs through the vendored Reel engine, the native element, NakliAmp's own PCM and libav software decoders, then a named refusal. Each rung hands PCM (or, for the element rung, a `MediaElementAudioSourceNode`) to one chain: per-track ReplayGain gain, 10-band peaking-filter EQ, crossfade gain, master gain, the analyser the visualisers already use, then the output. Gapless, EQ, ReplayGain and crossfade are built once, on that chain.
- **Gapless by scheduling, with the element rung as fallback** (R). On the engine and software rungs the next track's decoded audio is scheduled to start on the sample after the current one ends, with encoder delay and padding trimmed (LAME/Xing, iTunSMPB, Opus pre-skip) read by NakliAmp itself, since the research found no evidence that browser decoders trim them. The element rung keeps playing every file the browser can open and says in the honesty strip that it is not gapless. This is the hybrid Gapless-5 (MIT) uses. Engine changes land upstream in Reel first, as today.
- **A real play queue** separate from the visible library list. Today the queue is whatever rows are on screen (`index.html:845`); v1 gives the queue its own model, persisted, with shuffle and repeat.
- **The index stays a cache over the folder** (Built). IndexedDB records keyed by path, invalidated by size and `lastModified`. New per-file data (computed loudness, CUE virtual tracks, rating) hangs off the same key so a changed file drops it.
- **Tags: keep the in-house reader, add a lazily loaded writer.** The in-house parser already covers ID3v2, Vorbis comments, MP4 atoms, FLAC and WAV with 113 passing tests, so reading stays. Writing goes behind a separate module loaded only when the person edits a tag, using music-metadata (MIT), which the research found now writes FLAC, Ogg Vorbis and Opus, MP3 (ID3v2.4), MP4 and WAV. TagLib (LGPL and MPL) is not used, to avoid the relinking duty in a single file. Write-back is Chromium only (File System Access `createWritable`); elsewhere tags are read-only and an edited copy downloads.
- **Join NakliOS properly** (R). Vendor the NakliOS SDK between `naklios-sdk` markers as Chartella and Vocella do, follow the host theme, ship a `commands.json` that lists every player action, and reach the host model through `naklios.ai`. The standalone single file keeps working with the SDK calls as no-ops.
- **AI in plain JSON, grounded in the library** (R). The host model never invents tracks: NakliAmp filters the index first, sends a short candidate list with integer ids, and asks for `{"ids":[...]}` under a JSON Schema `responseConstraint`. Ids outside the candidate set are dropped. The research found the Prompt API explainer now defines tool calling, but no evidence on how reliably Gemini Nano uses it, so plain JSON is the design and tool calling is not relied on.
- **Libraries:** Butterchurn (MIT, WebGL 2) for Milkdrop, inlined only in the full build or loaded lazily. libebur128 or its Rust port ebur128 (both MIT) compiled to WASM for loudness scanning, in a worker. music-metadata (MIT) for tag writing. Webamp (MIT) only as an optional face after a spike (V5).

## 1. Library and browsing

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| L1 | Attach a folder (picker or drag onto the window), index it in a background worker, subfolders included | B | Built (exists) | Confirmed: `app/library/scan-worker.mjs`, `scan.mjs`; drop handlers `index.html:656`; README "Library"; gate `test/library-e2e.html` exists (not run in this pass) |
| L2 | Folder and index remembered between sessions; one button restores permission; storage persistence requested | B | Built (exists) | Confirmed: `persistStorage()` called at `index.html:1264` and `:1479`; `reclaimFolder` import at `:292`; README |
| L3 | Incremental rescan: unchanged files (same size and `lastModified`) are not re-read | F M S | Built (exists) | Confirmed: `app/library/scan-core.mjs:56`; `test/store.test.mjs` passes |
| L4 | Fuzzy ranked search over title, artist, album, album artist, file name, genre | B | Built (exists) | Confirmed: `app/library/search.mjs:52`; `test/search.test.mjs` passes |
| L5 | Album-grouped track list with album headings, disc and track order | D A | Built (exists) | Confirmed: `albumHeading` and grouping at `index.html:741` and `:861` |
| L6 | Browse views: Albums (cover grid), Artists, Album artists, Genres, Years, Folders, each drilling into its tracks | B | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("L6 L8: Browse lists Albums, Artists, Genres, Years, Folders, Recently added, Most played, Favourites"; "L6: drill into an album shows its tracks in order"). Design note: The gap users name first (R: the Plexamp forum thread on browsing and playlist management). Views are index queries; no new storage |
| L7 | Sort the track list by title, artist, album, year, date added, play count, last played, rating, duration | B C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("L7: sort by title, both directions, and by year"). Design note: `addedAt`, `playCount`, `lastPlayedAt` are already stored (`app/library/store.mjs:30`) |
| L8 | Recently added, recently played, most played lists | A M S C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("L6 L8: Browse lists Albums, Artists, Genres, Years, Folders, Recently added, Most played, Favourites"; "L8: Most played lists what was played"). Design note: Fields exist and are written (`index.html:1022`) but never shown |
| L9 | Ratings (0 to 5 stars) and a favourite (the stored `bookmarked` field) | B C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("L9: rating and favourite persist to the store"; "L9: favourite from Now playing"). Design note: `bookmarked` exists in the schema (`store.mjs:30`) with no UI. Stored in the index; optional write to the file's rating tag in T4 |
| L10 | Track inspector: every tag, path, codec, rung that played it, ReplayGain values | F C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S1 P8 T3 T6 L10: the tagged album track"). Design note: Extends the existing honesty strip into a panel |
| L11 | Folder watching: pick up added, changed and removed files without a manual rescan | S | v1 | Built (app/library/watch.mjs, wired in index.html). Checked: unit tests test/library-watch*.test.mjs only; the app disables the watcher under the harness flag, so no browser check ran. |
| L12 | Libraries of 50,000 tracks stay usable: scan in a worker, virtualised list, search under 100 ms | R | v1 | Built (virtualised browse list, views.mjs). Checked: Node test over 50,000 synthetic records (browse and search complete; no timing claim, shared machine). Not scrolled at that size in a browser. |
| L13 | More than one music folder in one library | M S A | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("L13: a second folder is added, scanned, listed and forgotten"). Design note: Each folder keeps its own handle; tracks keyed by folder id plus relative path |
| L14 | Duplicate finder (same tags and duration) | M | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("L14: duplicates found, keep one hides the copy"). Design note: Index query only |
| L15 | Library on a server (Plex, Navidrome, Jellyfin, Subsonic) | P | Waived | Needs a server. Kept as the M4 opt-in providers tranche in `plan/cliamp-parity.md`, not part of this parity pass |

## 2. Playback and transport

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| P1 | Persistent player bar: play, pause, previous, next, seek, elapsed and duration, volume, mute | B | Built (exists) | Confirmed: `#playerbar`, `#prev`, `#play`, `#next`, `#seek`, `#volume` in `index.html`; keys now through `app/commands/commands.mjs` |
| P2 | Resume a track where it stopped | M C | Built (exists) | Confirmed: `resumePositionS` restore at `index.html:1019` |
| P3 | Play counts and last-played time recorded | B | Built (exists) | Confirmed: `patchTrack(... playCount + 1, lastPlayedAt ...)` at `index.html:1022` |
| P4 | Honesty strip: container, codec, decoder rung, output, and why a file fell off the fast path | (NakliAmp) | Built (exists) | Confirmed: `#honesty` in `index.html`; README "What it plays". Not a reference-player feature; kept as NakliAmp's own |
| P5 | Play queue separate from the library view: play next, add to queue, reorder by drag, remove, clear, save as playlist | B C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("P5: playing from a list sets the queue to that list"; "P5 Y5: play next, add, move, remove, undo"; "P5 Y5: queue panel lists, removes and undoes"; "P5 Y2: save the queue as an M3U8 and add to it"). Design note: Today the queue is reassigned to the visible rows on every keystroke (`index.html:845`). The queue becomes its own persisted model |
| P6 | Shuffle (track and album) and repeat (off, all, one), persisted | B C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("P6: shuffle tracks and albums, persisted"; "P6: repeat one and all; next and previous follow the queue"; "P6: shuffle and repeat survive a reload"). |
| P7 | Gapless playback on the engine and software rungs, encoder delay and padding trimmed | F M S P | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("P7: gapless lane joins two tracks of one album without a reload"). Checked the `track-advanced` join event without a reload; not an audio-level gap or click measurement. Design note: Rank 4 in the research and one of the table-stakes features every fetched player page that discusses playback quality names. Element rung declared non-gapless in the strip. Check: a gapless album fixture (sine across track boundary) shows no gap and no click in a golden-audio harness |
| P8 | Media Session: title, artist, album, artwork, and play, pause, previous, next, seek handlers, so media keys and the OS now-playing panel work | B | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S1 P8 T3 T6 L10: the tagged album track"). Checked in a plain iframe; inside the real NakliOS shell is the NakliOS session's live check. Design note: Rank 2 in the research. Handlers wrapped in try and catch, as web.dev advises. Must be checked inside the NakliOS iframe as well as standalone |
| P9 | Playback speed (0.5x to 2x) | C V | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("P9: speed 2x doubles the clock on the normal route"; "P9: speed 2x on the gapless lane"). Not checked on the element rung (R2). Design note: `playbackRate` on the element rung, rate on the source on the others |
| P10 | Stop after current track, sleep timer | F V | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("P10: stop after current stops at the end of the track"; "P10: a short sleep timer stops playback and restores the volume"). |
| P11 | Mono downmix | C | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("P11: mono on and off in the dsp state"). Design note: ChannelMerger on the graph |
| P12 | Cue sheets: CUE plus one-file albums show and play as separate tracks | F S | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("P12: a cue sheet shows two tracks and hides the image"; "P12: Cue Two plays from its own start"; "P12: Cue One advances to Cue Two without a reload"). Design note: Virtual tracks in the index keyed by file plus track number (R). Gapless across virtual boundaries comes free from playing one file |
| P13 | DSD at length | S | Waived | Decodes today in the full build but a 5-minute track needs about 850 MB of float output (`plan/pending.md`). Streaming decode is a separate project |
| P14 | Bit-perfect or exclusive output, ASIO, WASAPI exclusive | M F | Waived | No web page can reach it (R) |

## 3. Sound: loudness, EQ, crossfade and output

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| S1 | ReplayGain from tags: track and album mode, preamp, clipping prevention from the peak value; `REPLAYGAIN_*` and Opus `R128_*` read | F S W V | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S1 P8 T3 T6 L10: the tagged album track"). Design note: Rank 3 in the research. Gain node per track. The reader needs the two new tag families; the R128 reference is -23 LUFS against ReplayGain 2.0's -18 LUFS (R) |
| S2 | Compute loudness for files with no gain tags (EBU R128 / BS.1770), in a worker, cached in the index | F M | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S2: loudness measured and stored for one track"). Recorded deviation: the scan runs on the main thread in 1 s chunks with yields, not in a worker. Design note: libebur128 or ebur128 (MIT) as WASM. Scan speed at 50,000 tracks is unmeasured (R); v1 measures it. Runs in the background at low priority and can be paused |
| S3 | 10-band graphic EQ with presets and a saved custom curve | W F M S C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S3: EQ on and a preset through the Sound panel change the engine"). Design note: Ten peaking `BiquadFilterNode`s. cliamp's bands and preset table, already chosen in `plan/cliamp-parity.md`. Winamp `.eqf` preset import through `winamp-eqf` is v1.x (S7) |
| S4 | Crossfade between tracks (off, or 1 to 12 s), equal-power curve; off by default and never across tracks of the same album when gapless applies | F W P | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S4: crossfade setting schedules a crossfade between different albums"). Design note: Two lanes on the graph during the overlap |
| S5 | Volume shown and stepped in dB with a floor | C | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("S5: volume in dB, 2 dB steps and the floor"). |
| S6 | Output device choice | M F | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("S6: output device control lists devices, or is hidden or disabled with a reason"). No device was selected, by instruction. Design note: `AudioContext.setSinkId` is experimental and can be blocked inside an iframe by Permissions Policy (R). Shown only where it works |
| S7 | Import Winamp `.eqf` EQ presets | W | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("S7: .eqf export then import round-trips the curve"). Design note: `winamp-eqf` parser from the Webamp monorepo (MIT) |
| S8 | DSP chains, plugins (foobar2000 components) | F | Waived | Outside the core job |

## 4. Formats

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| D1 | MP3, FLAC, AAC/M4A, Opus, Vorbis, WAV, audio in Matroska and WebM on the engine rung | B | Built (exists) | Confirmed: README "What it plays"; fixtures in `test/fixtures/`; gates `test/golden-audio.html`, `test/universal.html` exist (not run in this pass) |
| D2 | AIFF, AIFC, CAF, AU (integer, float, G.711) by NakliAmp's own decoder | S A | Built (exists) | Confirmed: `app/decode/pcm.mjs`; `test/pcm.test.mjs` and `test/pcm-hostile.test.mjs` pass |
| D3 | WMA, WavPack, Monkey's Audio, Musepack, TTA, DSD in the full build | F V | Built (exists) | Confirmed: `app/decode/libav.mjs`; `VENDOR.md` libav.js variant; gate `test/wasm-decode.html` exists (not run in this pass) |
| D4 | ALAC on Chrome and Firefox | A S D | v1.x | Built 2026-11-16 (libav rebuilt with demuxer-mov and decoder-alac). Checked: test/wasm-decode.html in Chrome over CDP: ALAC plays (Chrome's WebCodecs takes it on R1; the software rung carries it where WebCodecs does not, which Firefox needs and which was not run here). Design note: Safari plays ALAC natively; Chrome and Firefox do not (R). Needs the ALAC decoder in the libav variant, full build only. Today ALAC in M4A falls to the native rung |
| D5 | Opus in Safari | R | v1 (check only) | Not checked: needs Safari, and Safari's remote automation is a setting only Chirag can turn on. Chrome and Firefox paths unchanged. |

## 5. Playlists

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| Y1 | Playlists as files in the folder: read M3U, M3U8 (EXTINF), PLS, XSPF, JSPF; write M3U8; create, rename, reorder, delete; unresolved entries kept, never followed outside the folder | B | Built (exists) | Confirmed: `app/library/playlist.mjs` (`parsePlaylist`, `toM3u8`, `resolveEntry`); `test/playlist.test.mjs` passes |
| Y2 | Add to playlist from any track, album or selection (context menu and a key) | B | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("P5 Y2: save the queue as an M3U8 and add to it"; "Y2: Add to playlist from the context menu"). |
| Y3 | Smart playlists: rules over genre, artist, year, rating, play count, last played, date added, duration, path; match all or any; limit and sort; live update | S M A F | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("Y3: smart playlist with a live count, saved and listed"). Design note: Stored as a small JSON file beside the M3U8s (`.nakliamp-smart.json`), so the rule is also a file the person owns; "Export as M3U8" freezes it |
| Y4 | Multi-select in lists (Shift and Cmd/Ctrl click, select all) for queue, playlist and tag actions | B | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("Y4: multi-select with Shift and Ctrl click"). |
| Y5 | Undo for playlist and queue edits | C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("P5 Y5: play next, add, move, remove, undo"; "P5 Y5: queue panel lists, removes and undoes"). Design note: One step per edit; every playlist write is already one file rewrite |

## 6. Tags, art and lyrics

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| T1 | Read ID3v2 (2.2 to 2.4), Vorbis comments, MP4 atoms, FLAC pictures, WAV INFO, embedded art | B | Built (exists) | Confirmed: `app/library/metadata.mjs`; `test/metadata.test.mjs` passes (29 metadata cases) |
| T2 | Embedded album art in the player and the list | B | Built (exists) | Confirmed: `artUrlFor` at `index.html:731`, `#art-img`, `#pb-img` |
| T3 | Folder art: `cover.jpg`, `folder.jpg`, `front.*` beside the files when no art is embedded | F M D | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S1 P8 T3 T6 L10: the tagged album track"). Design note: The research did not establish a naming standard, so v1 uses the common names and says which it found |
| T4 | Tag editing: one track or many at once, title, artist, album, album artist, track and disc, year, genre, art, rating; written back to the file | M F S | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("T4: tag edit through the confirm writes the file and removes the backup"). Design note: Chromium only; elsewhere read-only plus "download edited copy". Safe sequence from the research: re-read and compare `lastModified`, write through `createWritable`, close, re-parse to confirm, keep a backup copy in OPFS until confirmed. music-metadata (MIT) writes; ID3v2.2 and 2.3 become ID3v2.4, and the editor says so before writing |
| T5 | Batch rename and find-and-replace in tags | S | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("T5: rename preview, then the rename on disk"; "T5: find and replace previews and writes one file"). |
| T6 | Lyrics: show embedded lyrics (USLT, SYLT, Vorbis `LYRICS`, MP4 `©lyr`), plain or synced with the current line highlighted | F P A | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("S1 P8 T3 T6 L10: the tagged album track"). Design note: The parser already reads them (`metadata.mjs:197`, `:239`, `:444`) but keeps only a `hasLyrics` flag (`scan-core.mjs:90`); the text is read on demand from the file |
| T7 | Lyrics from an `.lrc` file beside the track | F | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("T7: .lrc sidecar shows, synced highlight moves"). Design note: Same folder, same base name |
| T8 | Fetch tags or art from MusicBrainz and the Cover Art Archive | M | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("T8 T9 I1: with consent off every origin is off and nothing is sent"; "T8: MusicBrainz and the Cover Art Archive reach only their own origins"; "T8 T9 I1: revoking every origin stops requests, and no request left the page"). Design note: Opt-in network, per-origin, off by default, as the M4 rules in `plan/cliamp-parity.md` require. Never sends audio |
| T9 | Fetch lyrics from LRCLIB | C | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("T8 T9 I1: with consent off every origin is off and nothing is sent"; "T9: LRCLIB lyrics reach only lrclib.net"; "T8 T9 I1: revoking every origin stops requests, and no request left the page"). Design note: Same opt-in rules |

## 7. Visualisers and skins

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| V1 | 14 visualiser modes plus None, cycle with `v`, picker, full window with `Shift+V`, Escape leaves, reduced motion slows | W C | Built (exists) | Confirmed: `app/visualiser/modes.mjs`, `driver.mjs`; `test/visualiser.test.mjs` and `test/visualiser-driver.test.mjs` pass |
| V2 | True stereo analyser taps | (NakliAmp) | Built (exists) | Confirmed: README "Stereo means stereo"; gate `test/analyser.html` exists (not run in this pass) |
| V3 | Milkdrop presets through Butterchurn, attached to the same analyser chain | W F | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("V3: Milkdrop runs or refuses by name and falls back"). Only the run path executed (this Chrome has WebGL 2); the refusal path is unit-tested. Design note: The research ranks it the best-value Winamp item: MIT, WebGL 2, `connectAudio` takes the existing graph. Full build only, or lazily loaded. Preset redistribution rights are unconfirmed (R), so v1 ships a small set with checked rights and lets the person load more |
| V4 | Light and dark themes, following the NakliOS host theme | B | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("V4: light and dark themes, and the host theme on system"). Design note: Today the UI is dark only (`color-scheme:dark`, `index.html:13`). Light is the default standalone |
| V5 | Classic Winamp skin face (load a `.wsz` from disk) through Webamp | W | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("V5: a skin without PLEDIT.BMP is refused by name"; "V5: a complete skin mounts and its play button runs player.play"). Webamp's EQ sliders were not moved in the browser. Design note: Only after a spike confirms Webamp can play through NakliAmp's graph; the research could not confirm a pluggable audio backend or the bundle size. No skins bundled, never named "Winamp" (Webamp's README says the name and UI are Nullsoft's) |
| V6 | Compact mini-player layout | W C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("V6: mini player toggles"). Design note: Already on the backlog as the "compact/full duality"; matters in a small NakliOS window |
| V7 | Modern Winamp skins (`webamp-modern`) | W | Waived | A prototype with a to-do list (R) |

## 8. Integrations

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| I1 | Scrobble to ListenBrainz with a user token, offline queue that survives restarts, half-track or 4-minute rule | P F M | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("T8 T9 I1: with consent off every origin is off and nothing is sent"; "I1: a ListenBrainz scrobble reaches only api.listenbrainz.org"; "T8 T9 I1: revoking every origin stops requests, and no request left the page"). The offline queue across a restart is unit-tested only. Design note: Token auth needs no app secret (R). Whether `api.listenbrainz.org` allows cross-origin requests is unverified; the first build step is that live check. Opt-in network |
| I2 | Scrobble to Last.fm | F M S | Waived | Authenticated calls must be signed with the app's secret, which a serverless page cannot keep private (R). Needs a server |
| I3 | Remote control from a phone or another device | P V | Waived | Needs a relay server or a LAN listener a page cannot open |
| I4 | Streaming catalogues (Tidal, Spotify, Qobuz, YouTube) | P A | Waived | Streaming catalogue; refused on charter in `plan/cliamp-parity.md` |
| I5 | Internet radio, HTTP and HLS streams | V C | Waived | Already planned as the M4 opt-in providers tranche; not part of local-file parity |

## 9. AI (removable: the player works fully without a model)

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| Q1 | Playlist from a description ("quiet piano for working", "90s Hindi film songs"): filter the index, send up to a few hundred candidates as integer ids with artist, title, album, genre, year, get back `{"ids":[...]}`, drop unknown ids, one retry if short, preview before saving as M3U8 | P | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("Q1: without a host model the dialog uses the filter and says so"; "Q1: with a stubbed host model only candidate ids come back"). Design note: The research's main finding on Plexamp's Sonic Sage: asking the model for track names from its own knowledge returns tracks the library lacks; filtering first fixes it (MediaSage). Plain JSON under `responseConstraint`, so it runs on Gemini Nano. Without a model the same dialog runs as a tag and search filter |
| Q2 | "More like this": extend the queue from the playing track using tags and the model's reranking of candidates | P | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("Q2: more like this queues candidates from the playing track"). With a stubbed model only; a real host model is the NakliOS session's check. Design note: Same pipeline as Q1 |
| Q3 | Fill missing genres for untagged albums, as a suggestion the person approves before any tag is written | M | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("Q3: genre suggestions from a stubbed model; only the approved one is written"). Design note: Depends on T4; a destructive command, so it stages a diff |
| Q4 | Natural-language command bar ("play the last album I added", "shuffle my 5-star jazz") that turns text into one command from `commands.json` as JSON | R | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("Q4: the command bar runs a sentence by rules and refuses a destructive command"). Rules path in the browser; the model path is unit-tested. Design note: The JSON plan pattern Chartella uses with Gemini Nano: the model picks one command and arguments from a short list, NakliAmp validates and runs it |
| Q5 | Audio-content analysis (sonic similarity, mood from the waveform) | P | Waived | Needs an audio model download; revisit with a small on-device embedding model |

## 10. Agent door and NakliOS

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| N1 | `commands.json` lists every player action (play, pause, next, previous, seek, volume, mute, shuffle, repeat, queue add, queue clear, queue move, search, playlist create, playlist add, EQ preset, visualiser mode, rate track) with a label, shortcut and JSON Schema input | R | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("N1: every command in commands.json is bound"). Design note: The command set the research derives from MPD, MPRIS, beefweb and OpenSubsonic. One list drives buttons, keys, the keymap overlay (K2) and agent tools |
| N2 | Read commands for agents: `player.status`, `queue.read`, `library.search` (pages of 20), `track.read`. Results carry track ids and display metadata, never file paths | R | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("N2: read commands answer, page by 20 and carry no paths"). Design note: Paging and no paths, from the research's command-manifest section |
| N3 | Approval classes: read-only and reversible commands run; destructive commands (tag write-back, playlist delete) stage a diff and run only after the person approves | R | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("N3: a destructive command stages a confirm and does nothing on cancel"; "N3: host command list is built with approval classes"). |
| N4 | Vendored NakliOS SDK, host theme, `naklios.fs` where it helps (smart playlist and settings files), `naklios.ai` for the host model, and the iframe permission `allow="language-model"` or the host proxy | R | v1 | Built (SDK v2 inlined by scripts/vendor-naklios-sdk.mjs, app/host.mjs). Checked: `vendor-naklios-sdk.mjs --check` passes; test/v1-features.html with a stand-in host (theme, AI, command list). Inside the real NakliOS shell: the NakliOS session's live check. |
| N5 | WebMCP tool registration when the browser offers it | R | v1.x | Built 2026-11-17. Checked: test/v1x-features.html in Chrome over CDP ("N5: WebMCP registers read and reversible tools only"). Design note: A proposal today (R); register the same `commands.json` tools behind feature detection |
| N6 | Works offline after the first load | R | v1 | Built (sw.js, registered only over http(s) and never under the harness). Checked by the v1 verification agent in Chrome over CDP: registration at the page scope, then an offline reload booted from the cache; scope unregistered and cache deleted by name afterwards. |

## 11. Keyboard and accessibility

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| K1 | Keyboard map: Space, arrows for seek and volume, M, N, P, L, v, Shift+V, Esc; either letter case | W C | Built (exists) | Confirmed before v1 at the old `KEYMAP` in `index.html`. Since v1 every key comes from `app/commands/commands.mjs` through `matchShortcut`; Left and Right now seek 5 s (K3). Checked: test/commands-*.test.mjs (every old key still bound, no clash) |
| K2 | Keyboard-map overlay on `?`, generated from `commands.json` | C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("K2: ? opens the keymap with rows"). Design note: The last open UX-review finding in `plan/pending.md` (UX-13) |
| K3 | Full seek vocabulary: ±5 s, Shift ±30 s, number keys jump to 10% steps | C | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("K3: arrow keys seek 5 s, Shift+arrow 30 s"). |
| K4 | Every control has an accessible name; lists navigable by arrow keys; the queue and library usable without a mouse | B | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("K4: every control in every view and dialog has an accessible name"; "K4: browse list moves by arrow keys and Enter plays"). Design note: 18 `aria-label`s today; v1 makes it every control and checks it |
| K5 | Narrow window (NakliOS) layout down to 360 px with no horizontal scroll | R | v1 | Built 2026-11-16. Checked: test/v1-features.html in Chrome over CDP ("K5: at 360 px Library, Queue and Now have no horizontal scroll"). Design note: Partly fixed in commit e246b18; v1 checks every new view at 360 px |
| K6 | Custom key bindings | F | Waived | Low value for v1 |

## Counts

Built (exists): 18 rows. v1: 37 rows (36 plus D5, a check only). v1.x: 19 rows. Waived: 11 rows. 85 in all.

## Out of scope by design

Server libraries, streaming catalogues, Last.fm, remote control, internet radio, DSP plugin chains, exclusive or bit-perfect output, audio-content AI models and modern Winamp skins. Each needs a server, a catalogue, a model download or access a web page does not have. Radio, streams and self-hosted servers remain the separate opt-in M4 providers tranche already decided in `plan/cliamp-parity.md`.

## Build order (proposed)

From the research's ranking, adjusted to what NakliAmp already has:

1. Queue model, shuffle, repeat, multi-select, `commands.json` with the keymap overlay (P5, P6, Y4, Y5, N1 to N3, K2, K3).
2. Media Session and the NakliOS SDK, theme and light mode (P8, N4, V4, N6).
3. ReplayGain from tags, EQ, then gapless and crossfade on the shared graph (S1, S3, P7, S4), with gapless upstream in Reel first.
4. Browse views, sorts, ratings, recent and most played, inspector, folder watching, scale target (L6 to L12).
5. Smart playlists and add-to-playlist (Y2, Y3).
6. Lyrics, folder art, tag editing (T3, T4, T6, T7).
7. Computed loudness, Butterchurn, mini-player, AI playlists (S2, V3, V6, Q1).

Each step ships a working player, because the element rung keeps playing while the scheduled path matures.

## Line references

Line numbers in "Built (exists)" notes refer to the source at commit 5eb5937, before the v1 build.
