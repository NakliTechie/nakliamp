# Agent face: NakliAmp against cliamp's IPC v2

This page maps cliamp's remote-control protocol (version 2) to NakliAmp's agent face. cliamp is a
terminal music player; its protocol is newline-delimited JSON over a Unix socket. Sources, read on
2026-11-17 from `github.com/bjarneo/cliamp` (MIT): `docs/remote-control.md`, `ipc/v2.go` (the
envelope, error codes and `RuntimeSnapshot`), `ipc/protocol.go` (`TrackInfo`), `ipc/pubsub.go`
(the event envelope) and `ui/model/ipc_runtime.go` (the event topics).

## How NakliAmp is reached

NakliAmp is a browser tab, so it has no socket. It offers the same commands on four doors, all
built from one list, `app/commands/commands.mjs` (published as `commands.json`):

- **The page itself**: buttons and keys run the commands through `bindCommands`.
- **NakliOS**: `host.registerCommands` gives the host every command; the host asks the person
  before a destructive one.
- **WebMCP**: an in-browser agent gets the read and reversible commands as tools
  (`app/agent/webmcp.mjs`).
- **The `nakliamp` BroadcastChannel**: other tabs and windows of the same origin send commands and
  receive events (`app/agent/events.mjs`). This is the door that matches cliamp's socket.

### The channel protocol

| Direction | Message |
| --- | --- |
| to NakliAmp | `{ type: 'command', name, input, id, target? }` |
| from NakliAmp | `{ type: 'result', id, instance, ok: true, value }` or `{ ..., ok: false, error: { code, message } }` |
| to NakliAmp | `{ type: 'capabilities', id }`; the result's `value.commands` lists the accepted names |
| from NakliAmp | `{ type: 'event', event, seq, revision, time, instance, data }` |

- The channel runs read and reversible commands. It refuses every destructive command with code
  `refused`, because the person cannot see who asked; they run in the app, behind its confirm step.
  It also refuses `network.grant`, because turning on a network service is the person's consent.
- An unknown name returns `not-found`; input that fails the JSON Schema returns `invalid-input`.
- Each open NakliAmp tab answers. `instance` names the tab; send `target: <instance>` to address one.
- The channel is same-origin. On `naklios.dev` every NakliOS app shares one origin and so already
  shares NakliAmp's IndexedDB; the channel adds control, not data access.

### Where else events go

- **NakliOS host: no sink.** The SDK (`naklios-universe/naklios/sdk/naklios.js`, read 2026-11-17)
  offers `experimental_commands.register`, `search` and `call`, and no app-to-host event or emit
  call. A NakliOS agent reads state with `player.snapshot` instead.
- **WebMCP: no sink.** The WebMCP draft (`document.modelContext.registerTool`) defines tools only;
  it has no notification or resource-update call. A WebMCP agent reads state with `player.snapshot`.

## Methods

| cliamp method | NakliAmp | Notes |
| --- | --- | --- |
| `capabilities` | `{ type: 'capabilities' }` on the channel; `commands.json` for the full list | Names only; schemas are in `commands.json` |
| `state.get` | `player.snapshot` | Field map below |
| `spectrum.get` | `spectrum.get { bands? }` | One frame per call: 32 log-spaced bands (4 to 128 with `bands`), 20 Hz to 20 kHz, each 0 to 1, from the analyser the visualiser draws; empty while nothing plays |
| `operation.submit` | `{ type: 'command' }` | Answered once, with the result; no job record |
| `job.get`, `job.cancel` | Not applicable in a browser tab | Each command answers with its outcome in one reply, so there is no job to look up |
| `subscribe` | Not needed | Every listener on the channel receives every event; filter on `event` |

## Operations

| cliamp operation | NakliAmp command | Notes |
| --- | --- | --- |
| `play` | `player.play` | |
| `pause` | `player.pause` | |
| `toggle` | `player.toggle` | |
| `stop` | `player.pause` | NakliAmp has no separate stop; pause keeps the position |
| `next` | `player.next` | |
| `prev` | `player.previous` | |
| `volume` (absolute dB) | `player.volume_db { db }` | `player.volume { level }` takes the slider position 0 to 1 |
| `volume.adjust` | `player.volume_db { step }` | |
| `seek` (relative) | `player.seek_relative { seconds }` | |
| `seek.absolute` | `player.seek { seconds }` or `{ percent }` | |
| `speed` | `player.speed { rate }` | 0.5 to 2 |
| `speed.adjust` | `player.speed { step }` | |
| `shuffle` | `queue.shuffle` | Modes off, tracks, albums; no `mode` toggles |
| `repeat` | `queue.repeat` | off, all, one; no `mode` cycles |
| `mono` | `sound.mono` | |
| `eq` (preset, or band and value) | `eq.preset { preset }` or `{ custom: [10 values] }`; `eq.enable` | cliamp's band table, 10 bands |
| `device` | `sound.output { deviceId }`; `sound.devices` lists them | Only where the browser can pick an output |
| `theme` | `ui.theme` | system, light, dark |
| `vis` | `visualiser.mode { mode }` or `{ step }` | The mode list is in `commands.json` and in `invalid-input` messages; `visualiser.picker` opens the live picker |
| `queue` (append) | `queue.add { ids }` | |
| `queue.list` | `queue.read { offset, limit }` | Pages by 20 |
| `queue.play` | `queue.play { index }` or `{ id }` | Jumps to an entry already queued (by position, or the first entry holding that track id) and plays it; the queue itself is unchanged |
| `queue.enqueue` | `queue.play_next { ids }` | NakliAmp has one queue; play-next inserts after the current entry |
| `queue.remove` | `queue.remove` | Reversible: `queue.undo` restores it |
| `queue.move` | `queue.move` | Allowed while shuffled; cliamp refuses with `conflict` |
| `queue.clear` | `queue.clear` | Reversible |
| `track.play` | `queue.set { ids, play: true }` | Takes library ids, never paths |
| `track.queue` | `queue.add { ids }` | |
| `playnext.list`, `playnext.remove`, `playnext.move`, `playnext.clear` | Not applicable | NakliAmp has no second play-next list; the queue holds both |
| `load` (a playlist file or folder by path) | `library.browse` then `queue.set` | Agents never see paths |
| `url.load` | Not applicable in a browser tab today | Streams are the opt-in network tranche (M4), not built |
| `save` (copy a track to `~/Music`) | Not applicable in a browser tab | A tab writes only into a folder the person grants; no command exists |
| `lyrics` | `lyrics.fetch` | Opt-in network (LRCLIB); embedded and `.lrc` lyrics need no network |
| `history` | `library.browse { by: 'recentlyPlayed' }` | |
| `history.clear` | `history.clear` | Destructive: resets every play count and last-played time after the person approves; ratings and favourites stay. Refused on the channel |
| `provider.*` (12 operations) | Not applicable today | Remote libraries and radio are the opt-in network tranche (M4) |
| `playlist.create` | `playlist.create` | |
| `playlist.rename` | `playlist.rename { name, to }` | Writes the M3U8 under the new file name through the folder handle and removes the old file; refuses a taken name; undo puts the old file back |
| `playlist.delete` | `playlist.delete` | Destructive: refused on the channel |
| `playlist.add`, `playlist.add_many` | `playlist.add { ids }` | |
| `playlist.replace` | `queue.save_playlist` | Saves the queue as a playlist |
| `playlist.remove` | `playlist.remove { name, index }` | Destructive, as cliamp's "remove a saved playlist track": rewrites only the playlist file without that entry, never the audio file. `playlist.list { name }` gives the positions. Refused on the channel |
| `playlist.bookmark` | `track.favourite` | |
| `plugin.call`, `plugin.commands` | Not applicable | NakliAmp has no plugin host |

## Snapshot fields (`player.snapshot`)

| cliamp field | NakliAmp field | Notes |
| --- | --- | --- |
| `revision` | `revision` | Moves when any published event except `position` fires |
| `playlist_revision` | `queue.revision` | Moves on every queue change, including a move with the same length; also in `queue.read`. Send it back as `if_revision` |
| `state` | `state` | playing, paused, stopped |
| `track` | `track` | `{ id, title, artist, album, year, durationS }`; never a path |
| `logical_track`, `playback_detached` | Not applicable | One playing track; no detached playback |
| `position` | `positionS` | |
| `duration` | `durationS` | |
| `seekable` | `seekable` | True when a track is loaded with a known length |
| `volume` (dB) | `volumeDb`; also `volume` (slider 0 to 1) and `muted` | |
| `playlist` | `playlist` | The saved playlist the queue was loaded from (playing a row of a playlist in the library or the browse view), or null; a rename follows it, a queue replaced from elsewhere or cleared drops it. Also in the `queue-changed` event |
| `index` | `queue.index` | -1 when empty, as cliamp |
| `total` | `queue.length` | |
| `play_next_total` | Not applicable | No separate play-next list |
| `shuffle` | `shuffle` | A mode string, not a boolean |
| `repeat` | `repeat` | |
| `mono` | `mono` | |
| `speed` | `speed` | |
| `eq_preset` | `eq.preset`; also `eq.enabled` | |
| `eq_bands` | Not in the snapshot | `eq.export_eqf` exports the curve |
| `device` | Not in the snapshot | `sound.devices` |
| `visualizer` | `visualiser.mode`; also `visualiser.linkVolume` | |
| `theme` | Not in the snapshot | The theme follows NakliOS or the page |
| `stream_error` | `error` | `{ code, message }` of the last playback refusal, cleared on the next load |
| (none) | `dsp` | `{ route, chain, lane, gapless, crossfading, gainDb }`, the honesty strip's facts |
| (none) | `instance`, `version` | The tab's id and the snapshot format version (1) |

## Events

cliamp publishes the whole snapshot on four retained topics when anything changes, and no event
for position ticks. NakliAmp publishes smaller typed events, in this order within one change, plus
position once a second while playing, because a page has no cheap way to poll another tab.

| cliamp topic | NakliAmp event | `data` |
| --- | --- | --- |
| `runtime.state` | `track-changed` | `{ track, durationS }` |
| `runtime.state`, `runtime.playback` | `state-changed` | `{ state, playing }` |
| `runtime.playlist` | `queue-changed` | `{ queue, playlist, shuffle, repeat }` |
| `runtime.state` (volume) | `volume-changed` | `{ volume, volumeDb, muted }` |
| `runtime.settings` | `settings-changed` | `{ speed, mono, eq, visualiser, dsp }` |
| (none) | `position` | `{ positionS, durationS }`, 1 Hz while playing |
| `stream_error` in the snapshot | `error` | `{ code, message }` when the engine refuses a file |
| `runtime.job` | Not applicable | No jobs |
| `plugin.*` | Not applicable | No plugins |
| `system.overflow` | Not applicable | BroadcastChannel has no per-client queue; a late listener calls `player.snapshot` |

## Error codes

| cliamp code | NakliAmp code |
| --- | --- |
| `invalid_params` | `invalid-input` |
| `unknown_operation`, `not_found` | `not-found` |
| `unavailable` | `unavailable` |
| `internal_error` | `refused` |
| `conflict` | `conflict`: queue edits (`queue.set`, `add`, `play_next`, `move`, `remove`, `clear`, `shuffle`, `play`) take `if_revision`, the snapshot's `queue.revision`; a stale one is refused before the command runs |
| `invalid_version`, `invalid_request`, `canceled` | Not applicable: messages that are not commands are ignored, and nothing is cancellable |
| (none) | `declined` (the person said no in the app), `refused` (destructive or consent command on the channel) |
