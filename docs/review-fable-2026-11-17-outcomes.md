# Outcomes of the Fable 5.2 review of 777e21a (2026-11-17)

Per-finding outcomes from the four fix groups, as each recorded them. The review itself is `plan/review-fable-2026-11-17.md`.

# Review-a outcomes (2026-11-17)

Scope: findings N1, N2, N10, N11, N12, N13, N14, N23, N31, N32, N33 and N37 from
`plan/review-fable-2026-11-17.md`. All 12 are fixed in the module layer, each with a regression test.
Six need a shell change to take full effect in the app; `plan/v1-build/requests-review-a.md` gives
the exact change for each.

Checks that ran:

- `node --test test/*.test.mjs`: 740 pass, 0 fail (the count includes other agents' new tests).
- `oxlint -c .oxlintrc.json` on every file I touched: 0 errors.
- `node scripts/verify-delivery.mjs`, `verify-source-hygiene.mjs`, `verify-single-file.mjs`: PASS.
- Old-code check: I put the original seven modules back, ran a probe per finding (10 probes), and
  all 10 failed; with my changes restored, all passed. N11 and N23 add new functions, so their tests
  fail on the old code at import.

Not run: a browser run against a real folder handle; the shell wiring itself.

| Finding | Outcome | Regression tests |
|---|---|---|
| N1 ID3v2.3 upgrade dropped frames after an odd id | Fixed. `TCP\0`-style ids map losslessly through the ID3v2.2 table (`TCP` to `TCMP`, plus the iTunes sort frames). Frames ID3v2.4 removed (`RVAD`, `TSIZ` and others) keep their old ids. A frame whose id ID3v2.4 cannot hold, or whose flags are malformed, is kept byte for byte inside a `PRIV` frame, and parsing continues. Compressed, encrypted and grouped frames are converted losslessly. Unfolded date frames are carried. A frame whose size runs past the tag (in both size readings) refuses the write with `invalid-file`, because the frames after it cannot be found. The writer checks in memory, and `saveTagsToHandle` checks again after re-reading the file, that every frame the patch did not replace is present byte for byte; a miss is `verify-failed` and the backup stays. Audio bytes stay unchanged. | `test/review-a-tags.test.mjs`: "N1: an iTunes ID3v2.3 tag with TCP\0 keeps APIC, USLT and TXXX ReplayGain through a save", plus 5 more N1 tests |
| N2 `#` paths lost | Fixed in `toM3u8`: a location starting with `#` or a space is written as `./...`. | `test/review-a-playlist.test.mjs`: "N2: a track whose relative path starts with # ...", "N2: appendToPlaylist adds a # track ..." |
| N10 Latin-1 playlists damaged | Fixed in the module: `decodePlaylistBytes` (strict UTF-8, then Windows-1252), `parsePlaylist` accepts bytes and records `encoding`, `encodePlaylistText` writes Windows-1252 back, and `toM3u8` refuses any location or kept line containing U+FFFD. Shell requests 1 and 2 switch the scan and the write to these. | "N10: a Windows-1252 .m3u decodes exactly, and text with U+FFFD is never written back" |
| N11 rewrite from stale entries | Fixed in the module: `assertPlaylistUnchanged(playlist, file)` compares `lastModified`, `size` and the re-parsed content. Shell request 3 calls it before each rewrite. | "N11: a rewrite is refused when the file changed on disk since the scan" |
| N12 comments and directives dropped | Fixed: the M3U parser keeps header, trailer and per-entry lines and EXTINF attributes (quoted commas included); `mergeEntry`, `toM3u8` and `appendToPlaylist` write them back. A playlist round-trips byte for byte. Shell request 4 passes the header and trailer in the shell's own rewrites. | "N12: comments, directives and EXTINF attributes survive a rewrite" |
| N13 new cover deleted other pictures | Fixed for MP3, FLAC, Ogg Vorbis/Opus and MP4: only the front cover is replaced; other pictures are passed back unchanged (`app/tags/pictures.mjs`), and the confirm notes name them. When the pictures cannot be listed, or when cover art is removed, the note says every picture goes. | "N13: a new FLAC front cover keeps the back cover ...", "N13: a new MP3 front cover keeps a back-cover APIC ...", "N13: parseFlacPicture reads every field" |
| N14 no undo, no recovery screen | Fixed in the module and the tag editor: backups now stay after a good write, with a record (track path, time, outcome); `listTagBackups`, `deleteTagBackup` and `pruneTagBackups` (2 GiB limit, good writes only, oldest first) are new. A written result row has Undo, and the tag editor has a "Tag backups" list with Restore. A failed write's backup is never pruned and offers no Delete. Shell request 6 supplies `handleForPath` or `findByPath` so Restore can open the file. | "N14: backups of good writes are listed ...", "N14: pruning removes the oldest ...", `test/review-a-rename.test.mjs` "N14: a written tag edit offers undo ...", "N14: backupLine ..." |
| N23 rename left playlists stale | Fixed in the module: `planPlaylistRenames` rewrites M3U/M3U8 entries to the new names and lists PLS, XSPF and JSPF ones to fix by hand; `sidecarRenames` renames a same-named `.lrc` and reports a `.cue`. Shell request 7 wires both into `tags.rename_files`. | "N23: playlists that name a renamed file are rewritten ...", "N23: a same-named .lrc follows the rename ..." |
| N31 stale ID3v1 | Fixed: a trailing ID3v1 tag gets the patched title, artist, album, year, genre and track; its other bytes stay; the confirm notes say so. | "N31: a trailing ID3v1 tag gets the new title; its other fields stay" |
| N32 newline in title | Fixed: control characters in the EXTINF label, attributes and `#PLAYLIST` name become a space; a location with a line break is refused. | "N32: a newline in a title or playlist name cannot add an entry ..." |
| N33 literal `%20` file | Fixed in the module: entries with `%` carry both readings in `candidates`; `pickEntryPath` tries the raw text first. `appendToPlaylist` uses it; shell request 5 uses it in the shell's lookups. | "N33: a file literally named Track%20One.mp3 is found ..." |
| N37 rename with no collision check | Fixed: `renameOnDisk` refuses without a `parent` directory handle (`ERR_NAKLIAMP_RENAME_UNCHECKED`), and the panel fallback passes `ctx.library.parentFor(track)`. Shell request 8 adds `parentFor`. | "N37: renameOnDisk refuses without the folder handle ..." |

Existing tests I updated, because the old behaviour was the defect: `test/tags-id3.test.mjs`
(RVAD and unknown ID3v2.2 frames are now kept, not dropped), `test/tags-save.test.mjs` (the backup
stays after a good write), `test/v1x-lib-rename.test.mjs` (a rename needs `parent`).

New files: `app/tags/pictures.mjs`, `app/tags/id3v1.mjs`, `test/review-a-fakes.mjs`,
`test/review-a-tags.test.mjs`, `test/review-a-playlist.test.mjs`, `test/review-a-rename.test.mjs`.
The two new modules must be added to the NakliOS mirror manifest (request 9).
# Review batch B outcomes (engine, audio, decode)

2026-11-17. Findings from `plan/review-fable-2026-11-17.md`. Every regression
test below failed on the code before its fix: I reverted one module at a time
(`git show HEAD:<file>`) or removed the single guard, ran the new tests, and
restored my version (byte-compared with `cmp`).

10 of 10 fixed. Two of them (N5's shell side and N20's large-file streaming)
also need the shell change in `plan/v1-build/requests-review-b.md` for the full
behaviour; the engine side of each is done and tested.

| ID | Outcome | Change | Regression test |
|---|---|---|---|
| N4 | fixed, confirmed in Chrome first | `app/audio/gapless.mjs`: each voice has a fade stage (crossfade curves only) and a level stage (ReplayGain only); scheduling a fade-out no longer cancels the current track's fade-in; unscheduling cancels only from the fade-out's start | `test/review-b-audio.test.mjs` "N4: preloading the next track during a fade-in keeps the incoming track audible", "N4: replacing the queued next track …"; browser `test/review-b-crossfade.html` |
| N5 | fixed (engine); shell event wiring requested | R3 end sets position to the duration, keeps status `'playing'`, sets `clock.ended`, emits `ended`; every route reports `clock.ended` | `test/review-b-engine.test.mjs` "N5: a software-route track that ends …" |
| N17 | fixed | `load()` bumps `preloadToken`, clears `pendingNext` and the lane's next before decoding | "N17: a preload still decoding when the next track is loaded …" |
| N18 | fixed | `stopSoftwareSource` clears `onended`; the handler checks it is still the current source; lane `silence()` does the same | "N18: a source stopped by a seek cannot end the track …"; "lane: a natural end is reported once; a stop from pause is not" |
| N19 | fixed | volume and mute held in the engine (`outputVolume`, `outputMuted`) and applied after every load on every route; R1 re-mutes after Reel's `setVolume` unmutes | "N19: mute holds … software route", "N19: mute holds … native element route" |
| N20 | fixed | `app/decode/pcm.mjs`: whole decode refused above 512 MiB of Float32, checked from the header before allocation (`ERR_NAKLIAMP_PCM_TOO_LARGE`); new streamed reader `streamPcm` and `pcmDecoder` (streams above 64 MiB) | "N20: a whole decode over the size limit …", "N20: large PCM files stream …", "N20: the streamed reader returns the same samples …", "N20: the engine plays a streamed PCM file …" |
| N21 | fixed | `app/audio/chain.mjs`: output stage lowered by the largest EQ band boost; clipping prevention takes an unknown peak as full scale | "N21: an EQ boost lowers the output stage …", "N21: clipping prevention treats an unknown peak as full scale" |
| N22 | fixed | `app/decode/libav.mjs`: decoded frames appended in a loop; `readAllFrames` exported for the gate | "N22: one batch that decodes to 300,000 frames …" |
| N40 | fixed | PCM headers outside 3,000 to 768,000 Hz refused by name; `softwarePlayback` closes its context when `createBuffer` throws | "N40: a sample rate outside what an AudioBuffer accepts …"; engine "N40: a sample rate the AudioContext refuses closes that context" |
| N41 | fixed | ReplayGain goes to the level stage, so it applies mid-fade | "N41: a ReplayGain change during a fade-in is applied …", "N41: a ReplayGain change while the next crossfade is scheduled …" |

Support for N3 (owned by the shell agent): the `ended` event from audio-clock
callbacks and a 250 ms interval, tested by "N3: the lane reports ended from its
source callback and from the watch timer" and "N3: the lane source callback
reports the end without any polling"; the R2 element path is covered inside the
second N19 test.

## N4 browser confirmation

`python3 scripts/cdp-harness.py "http://127.0.0.1:8878/test/review-b-crossfade.html?runner=cli&run=1" 240`,
Chrome over the CDP daemon. Three tones on the lane with a 1 s crossfade; C is
preloaded the moment the engine moves to B; the engine analyser is sampled every
50 ms at each tone's bin.

- Before the fix: status `fail`. B's bin held at -59.3 dB for all 42 samples of
  its solo stretch against its own loudest -26.9 dB (about 32 dB down), and
  rose to full level only when C's crossfade began. The finding is confirmed.
- After the fix: status `pass`. B's quietest solo sample was -25.3 dB, equal to
  its loudest (43 samples).

## Other changes

- `test/audio-gapless.test.mjs`: the lane-gain test follows one more node,
  because the track gain now sits on the level stage after the fade stage.
- `test/pcm-hostile.test.mjs`: the AIFF builder's 80-bit rate encoder started
  its exponent 31 too low, so "48000 Hz" was written as 0.000022 Hz. The new rate
  range refused that file; I corrected the encoder.

## Checks that ran

- `node --test test/*.test.mjs`: 728 pass, 0 fail (one earlier run showed 727 of
  728 while other agents were editing in parallel; the rerun passed in full).
- `node scripts/verify-boundary.mjs`: PASS.
- `oxlint -c .oxlintrc.json` on the 5 source files, 4 test files and the test
  page: 0 errors (warnings only, all of kinds already present in these files).
- Browser harnesses through `scripts/cdp-harness.py`: golden-audio, universal,
  wasm-decode and v1x-features (29 of 29) all `pass`, with no console errors and
  no remote requests.

## Not checked

- Whether Chrome fires `ended` on a BufferSource after `stop()` and
  `disconnect()` (the review's N18 open question). The fix holds either way,
  because the handler is cleared before `stop()`.
- Hidden-tab behaviour of the new `ended` event in a real browser; it depends
  on the shell change in the requests file.
- Streamed PCM in a browser: the stream contract ran in Node against the
  engine with a fake context only, because the shell does not register
  `pcmDecoder` yet.
- No timing or speed measurements, because the GPU is shared.
# Review outcomes, batch C (2026-11-17)

Source: `plan/review-fable-2026-11-17.md`. Scope: N3, N6, N7, N8, N9, N15, N16, N27, N28, N30, N34,
N36, N42, N43, N44, plus the shell requests in `requests-review-a.md`, `requests-review-b.md` and
`review-outcomes-d.md`.

Result: 14 of 15 fixed with a regression test. N36 is stated, not changed in code (the review allows
that), and its existing gate is `scripts/verify-boundary.mjs`. All request items are applied except
request A9, which edits the NakliOS repository's manifest.

## Checks that ran

All after the last code edit, on 2026-11-17:

- `node --test test/*.test.mjs`: 758 pass, 0 fail (740 before this batch, plus 18 new review-C tests).
- Every `scripts/verify-*.mjs`: PASS (boundary, delivery, fixtures, r2-sessions, single-file,
  source-hygiene, vendor). `verify-delivery.mjs` prints the NOTE lines for the NakliOS manifest.
- `node scripts/build-single-file.mjs` then `verify-single-file.mjs`: PASS, 2,572,733 bytes.
  `--full` build and verify: PASS, 4,972,041 bytes.
- `node scripts/build-commands-json.mjs --check`: up to date (85 commands).
- `node scripts/vendor-naklios-sdk.mjs --check`: OK. The canonical SDK in naklios-universe changed
  during this session (commit 73b50b3, `naklios.review.withdraw`), so I refreshed the vendored copy
  in `index.html` with the script and rebuilt both single files.
- oxlint with `.oxlintrc.json` on `app/`, `scripts/build-single-file.mjs`, the new and edited tests,
  and (through the shadow-file lint) `index.html`, `test/review-c-keys.html`, `test/agent-face.html`,
  `test/library-e2e.html`, `test/v1-features.html`: 0 errors.
- Old-code check: I put the pre-batch files back (HEAD for files that were clean at the session
  start; `app/net/listenbrainz.mjs` rebuilt by reversing my edits, keeping batch D's work), moved the
  three new modules aside, and ran `node --test test/review-c-*.test.mjs`: 4 of 4 files failed (3 at
  import of the new exports, `review-c-shell` on its first assertions). A direct probe of the old
  `matchShortcut` gave `player.toggle` for Space on a button (N7) and `queue.repeat` for R inside a
  modal (N8). I then restored my files; the same tests passed 18 of 18.
- Browser harnesses, each twice, in Chirag's Chrome over the CDP daemon (see Browser notes for the
  port): golden-audio, ui-smoke, library, library-e2e, universal, analyser, wasm-decode,
  single-file, v1x-features, review-b-crossfade and the new review-c-keys passed on both runs.
  v1-features and agent-face failed their first run on two stale expectations (below), passed on
  runs 2 and 3 after the fix. After the SDK refresh I reran ui-smoke, single-file, v1-features,
  agent-face and review-c-keys once more; all 5 passed. Three of those first timed out in
  `cdp-harness.py`'s storage clear, which was blocked by tabs from my hidden-tab runs. I unloaded
  those tabs and reran the three, and they passed.

## Design for the shared origin (N9, N15, N16)

On `naklios.dev` every mirrored app shares one origin, and the browser's security boundary is the
origin. Code on the same origin that is written against NakliAmp can open its databases and use its
keys, so no design inside the page stops a deliberate same-origin attack; only a separate origin
does. The design below stops silent and generic access and makes every consent the person's own.

- **Channel (N9).** The `nakliamp` BroadcastChannel is closed until the person turns it on in Tools,
  Agent channel. The switch is per tab, held in memory, not stored, and not a command, so no app can
  turn it on by writing a setting or calling NakliAmp. On, it answers read commands. A reversible
  command runs only with `auth`, an HMAC-SHA256 keyed with a pairing code the person makes in that
  dialog and pastes into the other tab. The code never crosses the channel, a command must name the
  tab in `target`, and each id runs once, so a listener cannot learn the code or replay a command.
  Destructive commands and `network.grant` stay refused, paired or not. Protocol:
  `docs/agent-face.md`, "The channel protocol".
- **Grants (N15).** The grant record in localStorage now carries an HMAC signature made with a
  non-extractable WebCrypto key kept in IndexedDB (`nakliamp-vault`, `app/net/vault.mjs`). A record
  whose signature fails is not trusted: its services stay off and the Network panel marks each one as
  turned on outside the panel until the person turns it on there. Nothing is granted until the
  signature is checked.
- **Token (N15).** The ListenBrainz token left localStorage. It is sealed with a non-extractable
  AES-GCM key in the same vault. A token an older version stored moves into the vault and out of
  localStorage on first load. No command reads or sets the token; `scrobble.status` reports only
  `tokenSet`.
- **network.grant (N16).** The command carries `askEveryTime`, so NakliAmp's own confirm dialog
  (which names the service, what it receives and who asked) appears on every door: WebMCP, the
  NakliOS host rail (even though host calls arrive approved), the keyboard and the command bar. Only
  the Network panel's switch skips it, because that click is the person's answer. The channel still
  refuses it. `commands.json` lists its `approval` as `consent`.

## Per finding

| ID | Outcome | Regression test |
|---|---|---|
| N3 | Fixed. `maybeAdvance` and `tickTimers` moved out of `renderClock` into `tickPlayback`, run by a 250 ms `setInterval`; the shell also advances on the engine's new `ended` event. The animation frame only paints. | `test/review-c-shell.test.mjs` "N3: ..."; browser: hidden-tab run below |
| N6 | Fixed. The `#drop` keydown handler is gone, so Enter and Space on "Open a music folder" reach the button. | `test/review-c-keys.html` "N6 N30 ..." |
| N7 | Fixed. `matchShortcut` leaves Space and Enter to a focused button, link, summary or element with an activating role (`ownsActivationKeys`). | `test/review-c-keys.test.mjs` "N7 ..."; `test/review-c-keys.html` "N7 ..." |
| N8 | Fixed. `matchShortcut` returns nothing while the key's target is inside `[aria-modal="true"]` or `[role="menu"]`, or while its document holds an open modal; the shell also checks the main document, for keys sent from the pop-out window. | `test/review-c-keys.test.mjs` "N8 ..."; `test/review-c-keys.html` "N8 ..." |
| N9 | Fixed as designed above. | `test/review-c-channel.test.mjs` (3 tests); `test/review-c-keys.html` "N9 ..."; `test/agent-face.html` "N9 ..." checks |
| N15 | Fixed as designed above, within the stated same-origin limit. | `test/review-c-consent.test.mjs` "N15: a grant record ...", "N15: the ListenBrainz token is sealed ...", "N15: no command reads or sets ..." |
| N16 | Fixed as designed above. | `test/review-c-consent.test.mjs` "N16 ..."; `test/review-c-keys.html` "N16 ..." |
| N27 | Fixed. Tools, Licences (`app/ui/licences.mjs`) prints the inert licence blocks of a single-file build, or fetches the licence files of the hosted page when the person opens one. | `test/review-c-shell.test.mjs` "N27 ..."; `test/review-c-keys.html` "N27 ..." |
| N28 | Fixed. A single-file build (detected by its module loader) removes the Classic skin menu item, and `view.skins` refuses with `unavailable`. | `test/review-c-shell.test.mjs` "N28 ..." |
| N30 | Fixed. Playlist row tools are siblings of the row button inside the list item; `#drop` is `role="group"` with no tabindex. | `test/agent-face.html` playlist check; `test/review-c-keys.html` "N6 N30 ..." |
| N34 | Fixed. `lyricsSidecar` (in `app/ui/v1x-network.mjs`) returns a `not-found` refusal for an instrumental track or empty lyrics. | `test/review-c-shell.test.mjs` "N34 ..." |
| N36 | Won't change in code: one page's CSP cannot change while it runs. I wrote the limit beside the CSP in `index.html`: the browser enforces "no other origin", and `consentedFetch` enforces "only services you turned on", gated by `scripts/verify-boundary.mjs`. | existing `scripts/verify-boundary.mjs` (PASS) |
| N42 | Fixed. The seek slider sets `aria-valuetext` such as "2:17 of 4:05", written only when it changes. | `test/review-c-shell.test.mjs` "N42 ..."; `test/review-c-keys.html` "N42 ..." |
| N43 | Fixed. Light `--accent` #9a590e (4.65:1 or more), dark `--faint` #968c7c (4.86:1 or more), and a new `--field-line` (light #8c7e69, dark #7a6d60, 3:1 or more) for text-field and select borders. | `test/review-c-shell.test.mjs` "N43 ..." computes every pair from `index.html` |
| N44 | Fixed. A polite, atomic live region `#now-announce` says "Now playing: title by artist" once per new track. | `test/review-c-shell.test.mjs` "N44 ..."; `test/review-c-keys.html` "N44 ..." |

## Request items applied

| Request | Applied | Where |
|---|---|---|
| A1 N10 bytes at scan | yes | `app/library/scan-core.mjs` `scanPlaylistFile` |
| A2 N10 write in the code page | yes | `readLibraryText` decodes with `decodePlaylistBytes`; `writeLogged(path, text, encoding)` encodes; undo stores and reuses the encoding |
| A3 N11 refuse a changed file | yes | `assertPlaylistFresh` before `persistPlaylist`, `renamePlaylistFile`, `playlist.remove`, `playlist.add` and the rename follow-ups; on a change it rescans and refuses with the module's message |
| A4 N12 header and trailer | yes | every shell `toM3u8` rewrite |
| A5 N33 entry lookup | yes | `tracksForPlaylist`, `playlistLines`, `playlistEntriesFor` use `pickEntryPath` |
| A6 N14 tag editor lookups | yes | `ctx.library.handleForPath`, `ctx.library.findByPath` |
| A7 N23 rename follow-ups | yes | `tags.rename_files`: confirm lines for playlists, `.lrc` and `.cue`; `renameWithSidecars`, `rewriteRenamedPlaylists` from rows that renamed |
| A8 N37 `parentFor` | yes | `ctx.library.parentFor` |
| A9 mirror manifest | no: it is in the NakliOS repository | `verify-delivery.mjs` NOTE lists `app/net/vault.mjs`, `app/tags/id3v1.mjs`, `app/tags/pictures.mjs`, `app/ui/agent-channel.mjs`, `app/ui/licences.mjs` for the NakliOS session to add |
| B1 N3/N5 `ended` and 250 ms interval | yes, with the optional `clock.ended` acceptance | `tickPlayback`, `engine.on('ended', ...)`, `trackFinished` |
| B2 N20 `pcmDecoder` | yes | `index.html` imports and registers `pcmDecoder`; `scripts/build-single-file.mjs` patterns updated and now throw when they do not match |
| D scrobble `saveError` | yes | `scrobble.status` returns `saveError`; the Network panel status line says when listens last only until reload |
| D EQF picker text | yes | `'EQF preset'` |
| D command labels | yes | "Import EQF preset", "Export EQF preset" in `commands.mjs` and `commands.json` |

## Files outside the listed set

- `app/net/listenbrainz.mjs` (batch D's file): the token moved to an injected `tokenStore`; N15 needs it.
- `app/net/vault.mjs`, `app/ui/agent-channel.mjs`, `app/ui/licences.mjs`: new.
- `docs/agent-face.md`: the channel section now describes the switch and pairing.
- Existing tests updated because the old behaviour was the defect: `test/agent-events.test.mjs` and
  `test/agent-face-gaps.test.mjs` (reversible channel commands need pairing),
  `test/v1x-svc-listenbrainz.test.mjs` (the token is not in localStorage).

## Browser notes

- Harness tests updated because their expectation was the old behaviour:
  `test/library-e2e.html` (a same-name playlist rename can now write identical bytes, because the
  rewrite keeps every line, N12; it now waits for the "Renamed to" report),
  `test/v1-features.html` T4 (the backup of a good tag write now stays, batch A's N14), and
  `test/agent-face.html` (the channel must be turned on and paired first, and reversible names are in
  `value.paired`; it also checks N30's row structure).
- Port: the 8878 origin's IndexedDB could not be cleared. Chrome answered `Target.closeTarget` with
  success and kept every tab (mine and other sessions' tabs on 8878, about 15), so a pending
  `deleteDatabase` on 8878 never fired an event and `scripts/cdp-harness.py` timed out in its
  storage clear. I closed nothing that was not mine. I ran every harness on a fresh origin,
  `http://127.0.0.1:8879`, through a scratchpad wrapper around `cdp-harness.py` that also navigates
  each tab it created to about:blank before closing it, so a tab that stays open holds no database.
  Tabs I created that Chrome kept open are now about:blank or idle: C4F1BDFD..., 9159E28B...,
  F04C64C8..., my hidden-tab runs on 8879, and the harness tabs of this batch's runs. One VENDOR.md tab from my first timed-out
  run on 8878 is among the 8 VENDOR.md tabs there and I could not tell it apart from other sessions'
  tabs, so I left all of them.
- N3 hidden tab: I opened the app tab and then a second tab of my own in front of it. Chrome did not
  switch tabs here (the app tab still reported `visibilityState` "visible" and kept running animation
  frames, with focus emulation on or off), so that run is not a hidden-tab observation. I then
  stopped animation frames in the app tab the way a hidden tab does (`requestAnimationFrame` never
  calls back). With the new shell, over 9 s the queue went from track 1 to track 3 of three 4 s
  tones (3 loads, status playing) with 3 animation frames counted after the stop, and a 3 s sleep
  timer paused playback. With the old shell, the same run stayed on track 1 (1 load) and the sleep
  timer reached 0 s remaining without pausing. A true hidden-tab run is still to be done on a Chrome
  that switches tabs.
- N6 and N7 with trusted keys were not run; the harness uses synthetic keys and checks that NakliAmp
  leaves the key to the button (no `preventDefault`, no picker call, no playback change).
# Review outcomes, batch D (2026-11-17)

Source: `plan/review-fable-2026-11-17.md`. Scope: N24, N25, N26, N29, N35, N38, N39, N45, N46, N47, N48.
Result: 10 of 11 fixed; N24 has its notice shipped and its licence gap left open for the Reel owner.

## Checks that ran (2026-11-17, after the last edit)

- `node --test test/*.test.mjs`: 716 pass, 0 fail.
- `node scripts/verify-vendor.mjs`: PASS, 18 files match SHA-256.
- `node scripts/verify-delivery.mjs`, `verify-boundary.mjs`, `verify-fixtures.mjs`, `verify-r2-sessions.mjs`,
  `verify-source-hygiene.mjs`: PASS.
- `node scripts/build-single-file.mjs` then `verify-single-file.mjs`: PASS, 2,507,345 bytes.
- `node scripts/build-single-file.mjs --full` then `verify-single-file.mjs --full`: PASS, 4,906,653 bytes.
- `oxlint -c .oxlintrc.json` on every touched script, module and test: exit 0, 0 errors.
- Regression proof: I replaced `app/net/musicbrainz.mjs`, `app/net/listenbrainz.mjs` and `app/player/queue.mjs`
  with their `HEAD` versions and ran the new tests. 12 of the 16 new tests failed; the 4 that passed are
  guards that the fix keeps existing behaviour (a small cover, plain repeat all, peek stability, shuffle off).
  I then restored the new files and the tests passed again.

## Per finding

| ID | Outcome | Proof |
|---|---|---|
| N24 | Notice shipped; licence gap open. Reel has no LICENSE at commit `292b091` and its README says so. I added `engine/LICENSE-reel.txt` stating that, the author (Chirag Patnaik, every commit to the file) and that NakliAmp's MIT licence does not by itself cover the file. VENDOR.md says the same; both single-file builds carry block `reel-licence`; README's licence section names it. `engine/reel-engine.mjs` is unchanged. | `verify-vendor.mjs` (hash and VENDOR.md name), `verify-single-file.mjs` (block present) |
| N25 | Fixed. `vendor/webamp/LICENSES-bundled.txt` holds the licence text of all 38 third-party package versions in the bundle, each from its npm tarball at the version the webamp 2.3.1 source map names; pako 1.0.11 and setimmediate 1.0.5 come from JSZip's prebuilt file, and pako's zlib licence is included. VENDOR.md lists them and pins the file's hash. | `verify-vendor.mjs` (hash, sections for React, react-dom, Redux, react-redux, JSZip, pako) |
| N26 | Fixed. `vendor/libav/LICENSE-LGPL-NOTICE.md` now names the corresponding source: libav.js tag `v6.10.9.0` (FFmpeg 9.0), the full component configuration, `make build-nakliamp`, the emsdk digest, the NakliAmp repository URL and how to replace the library. New SHA-256 in `verify-vendor.mjs` and VENDOR.md. | `verify-vendor.mjs` (6 facts), `verify-single-file.mjs --full` (5 facts inside block `libav-lgpl-notice`) |
| N29 | Fixed. README: 85 player actions (was 76); sizes 2.5 MB and 4.9 MB (were 2.3 and 4.7); outside Chromium the tag editor offers edited copies to download (was "read-only"); WebMCP registers every command, destructive ones only with a confirmation hook. README stays at 120 lines. | `verify-delivery.mjs` (action count equals `commands.json`, no "read-only" claim), `verify-single-file.mjs` (README size within 0.1 MB of each artifact) |
| N35 | Fixed. `createRateQueue` holds the Web Lock `nakliamp:musicbrainz` (from `navigator.locks`) until the 1 s interval has passed, so pages on one origin share the rate; a 503 or 429 pauses the queue for Retry-After (capped at 60 s) or 5 s; covers are refused by `content-length` before reading and by a running count while streaming. | `test/review-d-net.test.mjs`, 5 N35 tests that fail on the old code |
| N38 | Fixed. With repeat all and shuffle on, moving past the last entry reshuffles the whole queue for the next pass, added tracks included, and never starts on the entry that just played. `peekNext` returns the same entry `next` then plays, so the gapless preload matches. | `test/review-d-queue.test.mjs`, 2 N38 tests that fail on the old code, 3 guards |
| N39 | Fixed. A restored shuffle order is de-duplicated and completed: each key once, missing entries appended in play order, so turning shuffle off loses no entry. Duplicate keys in `entries` still keep the first use, as `test/queue-model.test.mjs` expects. | `test/review-d-queue.test.mjs`, 2 N39 tests that fail on the old code |
| N45 | Fixed in this repository. VENDOR.md now says the hosted page and lean build never load libav, and that a mirror which copies the files must copy the LGPL text and notice with them; that holds with or without the manifest change below. `verify-delivery.mjs` prints a NOTE while the mirror lists libav files or lacks a licence notice. | `verify-delivery.mjs` NOTE lines |
| N46 | Fixed for the two places named. README says "classic `.wsz` skins"; the sound panel says "EQF preset (.eqf)" in its labels. | `verify-delivery.mjs` (no "Winamp" in README or `app/ui/sound-panel.mjs`) |
| N47 | Fixed. The single-file banner now says the file makes no network request until you turn on a service in the Network services panel, names the four services, and lists no analytics, fonts, CDN or update check. | `verify-single-file.mjs` (new wording present, old wording absent) |
| N48 | Fixed by reporting, not by IndexedDB. `QUEUE_MAX` is 2,000 listens (a full queue of typical listens is under 2 MiB as UTF-16; 10,000 could pass the 5 MB origin quota that other mirrored apps share). A failed save is kept in `saveError()`, `enqueue` returns `{ queued, saved }`, and every flush result carries `saved`. | `test/review-d-net.test.mjs`, 3 N48 tests that fail on the old code |

## For other owners

- **Reel owner (Chirag):** Reel has no licence. Adding one (for example MIT, matching NakliAmp) to
  `NakliTechie/reel` would let NakliAmp replace `engine/LICENSE-reel.txt` with that text at the next engine pin.
  Until then the published NakliAmp repository carries an engine file with no grant.
- **Shell owner (`index.html`):** `scrobble.status` (index.html:4884) should add `saveError: listenbrainz.saveError()`
  and the Network panel should show it, so a person sees that queued listens last only until reload.
  The EQF picker description at index.html:4210 still reads `'Winamp EQ'`; "EQF preset" matches N46.
- **Commands owner (`app/commands/commands.mjs`):** the labels "Import Winamp EQ" and "Export Winamp EQ" and
  their descriptions (lines 285 to 289, and `commands.json`) are user-visible in the command bar; "Import EQF
  preset" and "Export EQF preset" match N46.
- **Size claims:** the README sizes are checked within 0.1 MB. Batches still adding modules may move the lean
  file past 2.6 MB; `verify-single-file.mjs` then names the new size to write.

## Exact manifest change for the NakliOS session (N45, N24, N25)

File: `naklios/apps/manifest.json`, the app entry with `"id": "nakliamp"`, array `files`. I did not edit it.

Remove these five entries, because the hosted page never imports them (`index.html` has no libav import;
only `dist/nakliamp-full.html` adds `libavDecoder`):

```json
{ "source": "app/decode/libav-stream.mjs", "destination": "app/decode/libav-stream.mjs" },
{ "source": "app/decode/libav.mjs", "destination": "app/decode/libav.mjs" },
{ "source": "vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs", "destination": "vendor/libav/libav-6.10.9.0-nakliamp.loader.mjs" },
{ "source": "vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs", "destination": "vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs" },
{ "source": "vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm", "destination": "vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm" }
```

Then also remove the two libav licence entries, which no longer accompany any libav code on the mirror:

```json
{ "source": "vendor/libav/LICENSE-LGPL-2.1.txt", "destination": "vendor/libav/LICENSE-LGPL-2.1.txt" },
{ "source": "vendor/libav/LICENSE-LGPL-NOTICE.md", "destination": "vendor/libav/LICENSE-LGPL-NOTICE.md" }
```

Add these two entries, because the mirror ships the Reel engine and the Webamp bundle:

```json
{ "source": "engine/LICENSE-reel.txt", "destination": "engine/LICENSE-reel.txt" },
{ "source": "vendor/webamp/LICENSES-bundled.txt", "destination": "vendor/webamp/LICENSES-bundled.txt" }
```

`verify-delivery.mjs` also reports `app/tags/id3v1.mjs` and `app/tags/pictures.mjs` as missing from the
manifest; those come from another review batch and need adding too once that batch lands. After the change,
`node scripts/verify-delivery.mjs` in this repository prints no libav or notice NOTE.
