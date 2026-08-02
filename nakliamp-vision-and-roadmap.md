# NakliAmp — Vision and Roadmap

> D1 locked: **NakliAmp**. Domain: nakliamp.naklitechie.com.
> The Winamp homage is the positioning: your music, your disk, no stream, no account.

## One-liner

A sovereign, browser-native music player and library. Point it at your music
folder; it indexes, plays gapless, and never uploads a byte. The system music
player of naklios.

## Positioning

- **Reel : NakliAmp :: system media player : system music player.** The desktop
  model — an OS ships both (QuickTime/iTunes). Reel opens a file and plays it;
  NakliAmp owns the *collection*: library, queue, playlists, resume, search.
- **Document app vs library app.** Reel is open-watch-close. NakliAmp is a
  standing surface over a granted folder. Different shape, same engine.
- **Audience:** people with actual music files — rippers, Bandcamp buyers,
  archivists, the streaming-refusers. The NakliTechie audience in its purest form:
  they already own the asset; every incumbent wants to rent it back to them.
- **Against:** streaming lock-in (Spotify), abandoned desktop players (Winamp,
  foobar2000 stagnant on the web), and "cloud lockers" that are uploads wearing a
  library UI.

## Rides Reel's engine — the consumption contract

NakliAmp is the **first external consumer of the Reel engine** (layers 2–5:
Mediabunny demux + WebCodecs decode + clock, headless, zero UI imports). This is
the proof of Reel's engine-separability invariant.

- Engine is **upstream**. NakliAmp vendors it as a module; wrap-don't-modify;
  VENDOR.md discipline; no direct Mediabunny imports outside Reel's wrapper.
- Any gap the audio path exposes (e.g., MKA edge cases, audio-only clock mode)
  is **fixed in Reel's repo and pulled downstream** — never patched locally.
- What NakliAmp adds on top is audio-native: Web Audio graph (gapless scheduling,
  crossfade later), metadata parsing (ID3v2 / Vorbis comments / MP4 atoms / FLAC),
  album-art extraction, library index.

## Playback ladder (audio flavour of Reel's R1–R3)

```
R1  Reel engine → AudioDecoder → Web Audio graph   (gapless, sample-accurate, honesty strip full detail)
R2  Native <audio> / decodeAudioData fallback       (plays, loses gapless; honesty strip says so)
    + opt-in IDB-copy library for non-FSA browsers   (real library at 2x storage — disclosed, user chooses)
R3  Named refusal                                   (e.g., WMA, APE, DRM'd anything — say why, no shrug)
```

Honesty strip carries over from Reel: per-track pipeline shown (container →
codec → decode path → output). Signature sovereignty UI, shared vocabulary
across both players.

## Product shape (v1)

1. **Library** — FSA grant on a music folder; background scan in a Worker;
   metadata index in IndexedDB; album/artist/track views; search; album-art
   grid with per-album accent color (Reel's accent-extraction pattern reused).
2. **Playback** — queue, shuffle, repeat, gapless, resume across sessions.
   **10-band EQ** (BiquadFilter chain in the Web Audio graph — the homage demands
   it). Media Session API: lock-screen art, hardware/media keys, background
   playback.
3. **Playlists as artifacts** — playlists are `.m3u8` files *in the user's
   folder*, relative paths, open standard. The library index is a cache; the
   playlist file is the source of truth. Closure lives in the artifact: readable
   by any player, survives NakliAmp's death.
4. **Compact / full duality** — the Winamp gene: a compact player capsule
   (art, transport, seek, queue peek) and a full library window; same file,
   one toggle.
5. **Drop-to-play** — a dropped file plays instantly, library or not. Zero-state
   is never a wall.

## Sidecar (removability holds)

The player and library work fully with no key, no model, no setup. The sidecar:

- **Playlist-from-prompt** — "45 minutes, mellow, no vocals, from my library" →
  the sidecar proposes an **editable .m3u8** (the tool's own language), staged,
  never auto-saved. Deterministic core plays it; person edits/reorders/commits.
- **Tag repair proposals** — scan finds inconsistent/missing tags; sidecar
  proposes fixes as a **staged change-set** the person reviews per-field.
  Flag-don't-reject: never auto-writes tags.
- Powered per Edge-First ladder (L1 bridge → L2 WebGPU → BYOK → relay). Explicit
  invocation only; context sent = library *metadata index slice*, never audio.

Pull the sidecar out → a complete music player remains. Sidecar ✓.

## naklios integration

- System music player of the shell. Standalone URL and in-shell app are the
  same file.
- Agent-registry manifest declaring the `window.nakliamp` verbs.
- Reel engine sharing is itself naklios plumbing: one media core, two apps.

## Roles (spine gate)

| Actor | Authority | Scope | Ownership | Trust boundary | Attribution |
|---|---|---|---|---|---|
| Person | everything | own library | full (delete, move, export) | inside | direct |
| Agent (window.nakliamp / naklios) | play, queue, search, playlist CRUD (staged) | library index, never raw grant escalation | none — proposes, person commits writes to disk | inside, opt-in gated | tagged `via:agent` in history |
| System (scan worker, art extractor) | read + index only | granted folder | none | inside | log-only |
| Sidecar model | propose artifacts | metadata slice per invocation | none | **outside** (cloud rungs) — metadata only, never audio bytes | proposals marked `proposed-by:sidecar` |

Missing-actor check: no reseller/operator tier (sovereign single-user), no
external party, no inspector. Re-fires if a future milestone adds sharing/sync.

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Name: **NakliAmp**, nakliamp.naklitechie.com | **locked** |
| D2 | Metadata parser: **minimal in-house** (ID3v2 + Vorbis comment + MP4 ilst + FLAC picture) | **locked** |
| D3 | Gapless: **R1-only**; R2 honestly reports no gapless | **locked** |
| D4 | Podcasts/long-form: **out of v1**; index schema carries `resume_position` per-track from day one (additive upgrade) | **locked** |
| D5 | Visualizer: **v1.1 via vendored Butterchurn (MIT, Milkdrop 2 WebGL)** — lazy-loaded full-window mode; AnalyserNode spectrum bars stay in the capsule | **locked** |
| D6 | Rescan: **manual + on-launch diff scan**, write-lock respected | **locked** |

## Landscape (scanned, resolved)

Category is populated, shape is not: Snae Player and local-music-pwa do
FSA-granted local libraries; Webamp is the pixel-faithful Winamp 2.9 homage
shipped as an embeddable library; OnlinePlayer bundles an audio player in its
utility suite. All ride native `<audio>` — no engine, no true gapless, playlists
locked in browser storage, and even the privacy-pitched entrant ships analytics.
Nobody has: engine decode, honesty strip, playlists-as-.m3u8-in-folder, sidecar,
agent face, shell integration. naklios makes build-vs-adopt moot regardless
(OS-layer infrastructure is owned) — same resolution as Reel. **Zero-telemetry
is a stated differentiator, not a silent one**: README and empty state say
"no analytics — verify with the network tab."

## Roadmap

**Sequencing note: build opens only after Reel M0 ships** — the engine must
exist and its audio path must be proven upstream first. Bundle sits
handoff-ready until then.

### M0 — Engine proof (audio path)
Drop-to-play single tracks via Reel engine. Honesty strip. R1/R2/R3 ladder wired.
**Gate:** golden-file suite decodes and plays — MP3, FLAC, AAC/M4A, Opus, Vorbis/OGG,
WAV, MKA — verified headlessly through the engine's agent face; R3 refusal named
for WMA fixture. Machine-checkable: golden-file test script green.

### M1 — Library
Folder grant, Worker scan, metadata index (D2 parser), album/artist/track views,
search, album art + accent, resume.
**Gate:** 1k-track fixture library scans without main-thread jank (long-task
budget), index round-trips (rebuild-from-folder produces identical index hash),
IDB mirror survives revoked-grant relaunch. Machine-checkable: scan-bench +
index-hash scripts green.

### M2 — Player proper
Queue, shuffle, repeat, gapless (D3), 10-band EQ, playlists as .m3u8 artifacts,
Media Session, compact/full duality.
**Gate:** .m3u8 export→reimport round-trip byte-stable on paths; gapless
verified by rendered-output gap analysis on a two-track fixture (silence gap
< 1 frame); EQ verified by offline-context sine-sweep render matching expected
per-band gain; Media Session handlers respond headlessly. Machine-checkable.

### M3 — Sidecar + agent face
Playlist-from-prompt, tag-repair proposals, `window.nakliamp`, naklios manifest,
i18n pass, guide.
**Gate:** removability test scripted (no-key boot → all M2 gates still green);
sidecar output validates through the single-ingress .m3u8 schema validator;
agent-face conformance script green.

---

*Add NakliAmp to NAKLITECHIE-PROJECT-STATE.md as specced-queued, blocked-on:
Reel M0.*
