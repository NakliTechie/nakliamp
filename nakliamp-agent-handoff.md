# NakliAmp — Agent Handoff

> Status: **handoff-ready, build gated on Reel M0 shipped.** Do not open until
> the Reel engine exists as a vendorable module and its golden-file audio
> fixtures pass upstream.

## 0. Precondition & upstream contract

- Vendor the Reel engine (layers 2–5) per Reel's VENDOR.md. **Wrap, don't
  modify.** No direct Mediabunny imports anywhere in this repo — the engine's
  wrapper is the only door.
- Engine gaps found here (audio-only clock, MKA quirks, AudioDecoder config)
  → **escalate to be fixed in Reel's repo**, then pull. Local engine patches
  are a build failure.
- Pin the engine to an exact commit; record it in VENDOR.md.

## 1. Repo / build / deploy

- Repo: `nakliamp`. Single self-contained HTML file, vanilla JS, no build step,
  no framework, no npm at runtime. Engine + parsers as ES modules inlined or
  co-located per Reel's convention.
- Deploy: Cloudflare Pages → nakliamp.naklitechie.com. Offline after first load.
- Visible version string in UI + meta tag, bumped before every push.
- README scope: what it does for a user, formats, sovereignty posture, keyboard
  map. States zero-telemetry explicitly: "no analytics — verify with the
  network tab." No model names, no line counts.

## 2. Browser floor

- **Full experience (R1):** Chromium-class — File System Access + WebCodecs
  AudioDecoder + Web Audio + Media Session.
- **R2 fallback:** Firefox/Safari — native `<audio>` / `decodeAudioData` path.
  Library where FSA absent: **opt-in IDB-copy** — files copied into IndexedDB
  for a real persistent library at 2x storage cost, disclosed plainly at
  opt-in and in the honesty strip; default without opt-in is directory input,
  session-scoped. Honesty strip states R2 degradation (no gapless).
- **R3:** named refusal per format (WMA, APE, any DRM). Refusal names the codec
  and the reason. Never a silent failure or spinner.

## 3. Architecture spine (invariants before features — write these first)

**Standing rule: the playback core (engine wrapper + Web Audio graph + queue
state machine) has zero imports from UI layers and is callable headlessly.**
Same class of invariant as Reel's; a UI leak into the core is a build failure.

1. **Storage façade** — FSA (granted music folder, source of truth) → OPFS
   (scan staging, extracted art cache) → IndexedDB (library index mirror,
   always written, survives revoked grant). Playlists write to the *user's
   folder* as `.m3u8`; the index is a cache, rebuildable, never authoritative.
2. **Library index schema + validator** — versioned schema; every record:
   stable track id (content-hash of stream head + size), path, tags, duration,
   art ref, `resume_position`, `added_at` (ISO). Rebuild-from-folder must be
   deterministic (index-hash gate).
3. **Single ingress validator** — everything from outside (imported .m3u8,
   parsed tag blocks, sidecar proposals, agent-face calls) passes one schema
   validator before touching state. One door, checks coats.
4. **Event bus + play-history log** — append-only history (track, ts, actor
   attribution: direct / via:agent / proposed-by:sidecar). Replay reconstructs
   queue + resume state (walkthrough gate uses this).
5. **Queue state machine** — explicit states (idle, playing, paused, seeking,
   advancing, refused); gapless handoff is a transition, not a hack in the
   ended-handler.
5b. **Audio graph owns the EQ** — 10-band BiquadFilter chain as a fixed stage
   in the Web Audio graph (source → EQ → gain → destination); presets +
   custom curve persisted; R2 path bypasses honestly (strip says "EQ —").
6. **Keyboard guard** — single registry. Map: space play/pause, ←/→ seek,
   ↑/↓ volume, `/` search, `j`/`k` queue nav, `m` mute, `c` compact toggle.
   Conflict rule: search field focus suspends all single-key bindings.
7. **Cross-cutting helper** — one `ctx()` helper for actor/locale/mode; no
   parameter threading.

## 4. Metadata parsing (D2 locked: minimal in-house)

- Scope: ID3v2.3/2.4 (MP3), Vorbis comments (OGG/Opus/FLAC), MP4 `ilst`
  (M4A/AAC), FLAC METADATA_BLOCK_PICTURE. Nothing else in v1.
- Runs in the scan Worker. Malformed tag blocks: parse what's parseable, flag
  the record, never abort the scan. Parser output goes through the ingress
  validator like any external data.
- Album art: extract → OPFS cache → accent color derived (reuse Reel's accent
  extraction approach; per-album, cached in index).

## 5. Persistence rules

- **localStorage allow-list:** settings, volume, EQ curve/preset, compact/full
  state + capsule corner, last-queue pointer, intro-modal-seen. Nothing else.
- **IndexedDB:** library index, play history, resume positions, art refs.
- **Forbidden:** audio bytes duplicated into IDB/OPFS — *sole exception:* the
  disclosed R2 opt-in IDB-copy library path (§2); any key material anywhere but
  the VaultMind pattern; anything leaving the machine.
- Write-lock during index writes so rescan never fights a save.

## 6. Security posture / CSP

- CSP: no remote script origins except model CDN when sidecar explicitly
  invoked; no inline-eval; connect-src limited to BYOK provider domains +
  bridge localhost + relay (when configured). Default state: zero network after
  load.
- No telemetry, no accounts, no cookies. Non-negotiable.

## 7. Empty + error UX

- Empty state: drop zone + "grant a music folder" + recent-tracks row (from IDB
  mirror) — mirrors Reel's empty state, shared visual language.
- Revoked grant on relaunch: library renders from IDB mirror immediately
  (cache-first), banner offers re-grant; playback of un-granted files prompts.
- Refusal (R3): inline card naming codec + reason. Decode error mid-track:
  advance queue, log to history, toast — never a modal wall.
- Sidecar unavailable mid-use: sidecar affordances dim (never hide), tool
  degrades to full no-AI state cleanly.

## 8. Sidecar spec

- **Invocation:** explicit action only. No ambient calls. Cost opt-in.
- **Playlist-from-prompt:** input = prompt + *metadata index slice* (titles,
  artists, durations, tags — never audio bytes, never full paths beyond
  relative). Output = draft `.m3u8` with `#`-comment rationale lines →
  **staged** in a review pane → person edits/commits → written to folder.
  Validates through ingress like any import.
- **Tag repair:** proposals as per-field staged change-set; person accepts
  per-field or wholesale; accepted writes go through the engine of record
  (index + optional tag-write later — v1 fixes index only, file tag writing is
  out of scope, document the gap).
- **Power ladder:** per Edge-First — detect bridge/Ollama (L1) → WebGPU (L2) →
  BYOK (VaultMind pattern, key never to our servers, fingerprint shown) →
  relay. Detected, not configured. Model download asks before fetching.
- i18n: all sidecar UI strings through the same string table as everything else.

## 9. Agent face + naklios

- `window.nakliamp` — opt-in, developer-setting gated, off by default. Verbs:
  `search`, `play(trackId)`, `queue(trackIds)`, `pause`, `next`, `prev`,
  `seek(s)`, `playlists.list/create/append` (create/append are **staged**,
  person commits), `state()`. Cross-tab channel mirrors the verbs.
- All agent actions attributed `via:agent` in play history.
- naklios agent-registry manifest declares the same verbs. Standalone URL and
  in-shell app: same file.
- Same hooks drive headless testing — gates run through this face.

## 10. i18n / a11y

- i18n baseline: string table from day one; RTL-safe layout; locale-aware
  duration/date formatting.
- a11y verification: full keyboard operability, focus-visible, ARIA on
  transport + queue list, reduced-motion respected (accent transitions,
  future visualizer). Verified in walkthrough.

## 11. What NOT to do — hard rules

1. No direct Mediabunny import; no engine modification; no parallel decode path.
2. No server, no account, no telemetry, no cookies, ever.
3. No audio bytes to any model, any rung, any reason. Metadata slice only.
4. No auto-committed sidecar output — everything stages.
5. No fake gapless on R2 — honesty strip tells the truth.
6. No format zoo creep — v1 formats are the golden-file list, full stop.
6b. Visualizer (v1.1): **vendor Butterchurn (MIT)**, lazy-loaded, VENDOR.md
   discipline — do not build a Milkdrop. Capsule spectrum bars stay in-house
   (AnalyserNode, trivial).
7. No hiding — dim unavailable affordances (sidecar offline, R2 limitations).
8. No surprise model downloads — ask first.
9. Playlists never stored *only* in IDB — the .m3u8 in the folder is truth.

## 12. Build cadence + escalation

- Loop per Build Doctrine: chunk → `/forward-pass` (fresh context) → fix list →
  next chunk → `/walkthrough` at end (every role: person, agent, system-scan).
  Maker never grades own homework; "done" is the verifier's word.
- No-progress exit: same failure ~3× → tried-trail to state file → escalate.
  Per-chunk budget cap as second exit. Autopilot in isolated worktree.
- **Stop ONLY for:** locked-decision conflict (D1–D6 all locked), new
  dependency need, genuine scope ambiguity that changes the product. Engine
  gaps = escalate upstream (§0), don't stop the world.

## 13. Gate artifacts per milestone

| Milestone | Artifact | Machine-checkable condition |
|---|---|---|
| M0 | golden-file audio suite + honesty-strip snapshots | `test/golden-audio` green: 7 formats play via engine headlessly; WMA fixture yields named R3 refusal |
| M1 | 1k-track fixture + scan bench + index tests | scan-bench under long-task budget; rebuild index-hash identical across two scans; revoked-grant relaunch renders from mirror (scripted) |
| M2 | .m3u8 round-trip + gapless analysis + EQ sweep + Media Session harness | export→import path-stable; rendered gap < 1 frame on gapless fixture pair; offline-context sine-sweep through EQ matches expected per-band gain; session handlers respond headlessly |
| M3 | removability script + agent-face conformance + ingress fuzz | no-key boot passes all M2 gates; sidecar output rejected/accepted correctly by validator against fixture set; `window.nakliamp` conformance green |

## 14. Portfolio integration

- UX/UI reference: **gated — build does not open until it exists and is linked
  here** (produced at build-open, after Reel ships, per Build Doctrine).
- Add to NAKLITECHIE-PROJECT-STATE.md: specced-queued, blocked-on Reel M0.
- Update portfolio + profile after ship, plain user-facing description.
