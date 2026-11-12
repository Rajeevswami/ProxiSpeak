# Week 2 — Day 8: Peer graph and WebRTC signaling

## Scope and provenance

Built on `origin/Rajeev` tip `cf0f499` (Week 1, Days 1–7). Backend only: no
`client/` change, no `getUserMedia`, no browser `RTCPeerConnection`, no Web
Audio, no Redis, no TURN, no new dependency.

The server orchestrates **which peers should talk** and relays their signaling.
It never sees or touches audio: SDP and ICE candidates are opaque payloads
between two browsers.

Implementation commits (real dates, 2026-10-17):

- `d4a9492` — `server/src/services/peerGraph.js`: per-room vertices/edges,
  one edge per pair, per-user diffing, monotonic generations, deterministic
  initiator, idempotent leave.
- `ed51158` — gateway wiring for join / accepted move / disconnect / presence
  expiry, `peer:connect` and `peer:disconnect`.
- `66399fc` — `signal` relay + strict payload validation along a live edge only.
- `4abeee2` — `ICE_SERVERS` parsing/config, `joined.iceServers`, and the
  configurable per-socket signal bucket.
- `848bdf1` — 29 new tests (12 real-MongoDB socket integration, 8 peer-graph
  unit, 5 signal validation, 4 ICE config).

## Architecture

```
 Socket.IO gateway (server/src/sockets/index.js)
   join / move / disconnect ──► PeerGraph (server/src/services/peerGraph.js)
   signal ──► edge lookup ──► target socket (relay; no media)
                                   │
                         findNearby(roomId, userId, radiusPx)
                         server/src/services/proximityService.js
                                   │
                         MongoDB $near + exact pixel check
```

One `PeerGraph` instance exists per server process, with one sub-graph per
room. Vertices are Socket.IO session ids (also the public user ids). Edges are
in memory only; a second server instance has its own graph (multi-instance edge
sharing is Week 3 work). MongoDB remains the source of truth for positions.

## Event contract

| Event | Direction | Payload | When |
| --- | --- | --- | --- |
| `joined` | S → C | `{ selfId, room, users, iceServers }` | Join accepted. The existing snapshot is unchanged; `iceServers` is added for the future browser peer connection. |
| `peer:connect` | S → C | `{ peerId, name, initiator, generation, iceServers }` | A new edge was created for this user. Sent to **both** endpoints. `initiator` is `true` on exactly one side. |
| `peer:disconnect` | S → C | `{ peerId, generation }` | An edge the user still knew about was removed (left radius, disconnected, expired). Sent to **both** endpoints. |
| `signal` | C → S | `{ to, generation, data }` | Offer/answer or trickled candidate for an existing edge. |
| `signal` | S → C | `{ from, generation, data }` | Relay to `to`, only when the edge is live and the generation matches. |
| `error` | S → C | `{ code, message, field? }` | A rejected `signal`. Codes below. |

`data` is one of:

```json
{ "type": "offer",   "sdp": "v=0…" }
{ "type": "answer",  "sdp": "v=0…" }
{ "type": "candidate", "candidate": "candidate:…" }
{ "type": "candidate", "candidate": { "candidate": "…", "sdpMid": "0", "sdpMLineIndex": 0 } }
```

Candidate objects are whitelisted to `candidate`, `sdpMid`, `sdpMLineIndex` and
`usernameFragment`; unknown fields are stripped. `candidate: null` is accepted
as end-of-candidates. SDP is never parsed, only checked to be a non-empty
string. The whole `data` object is capped at **16 KB** (16,384 bytes).

### Signal rejection codes

| Code | Meaning |
| --- | --- |
| `invalid_payload` | Wrong shape/type, malformed candidate, or `data` over 16 KB. `field` names the offending part. |
| `no_peer_edge` | No live edge between sender and `to` in the sender's room (not in range, different room, self, or the peer is gone). |
| `stale_generation` | An edge exists, but its current generation differs from the one in the envelope. |
| `not_joined` | `signal` arrived before a successful `join`. |
| `session_expired` | The sender's presence was swept; reconnect to join again. |

A signal that exceeds the per-socket rate limit is dropped silently (debug log
only), exactly like a throttled `move`: answering a flood with one error per
event would amplify the traffic the limit exists to stop.

## Edge rules

- **One edge per pair.** The key is the two user ids sorted, so whichever user
  notices the other first, the same edge is stored and both adjacency maps
  point at it. A pair never has two edges.
- **Only the changed user is recomputed.** On join, an accepted `move`, a
  disconnect and a presence expiry the gateway calls one `sync`/`leave`; the
  service runs the existing `findNearby(roomId, userId, radiusPx)` and diffs
  the result against that user's current edges. Unchanged edges emit nothing;
  new neighbors add an edge; neighbors that left the radius remove it.
  The rest of the room is never scanned.
- **Monotonic generation.** Every newly created edge gets the next process-wide
  generation (1, 2, 3…). Re-entering the radius creates a new edge with a
  strictly larger generation. A delayed signal for an older edge is refused.
- **Deterministic initiator.** The endpoint with the lexicographically smaller
  user id is the initiator (`initiator: true`), so two peers never offer at the
  same time. This is a convention for the future browser code; Day 8 only
  reports it.
- **Distance 0 is valid.** A user standing on the same pixel as another is
  inside the radius (`distancePx <= radiusPx`), and `findNearby` excludes self,
  so nobody gets an edge to themselves.
- **Rooms are isolated.** Neighbor queries and graph maps are per room; users
  in different rooms never share an edge even at identical coordinates.
- **Disconnect / expiry / kill.** `leave` removes every edge the user owns,
  emits one removal per edge, and is idempotent (a disconnect after the expiry
  sweep does not emit a second `peer:disconnect`). A `SIGKILL`ed client is
  cleaned up by the normal socket disconnect path.
- **Reconnect.** Socket.IO assigns a new id, so the reconnecting tab is a new
  vertex with fresh edges; the old id is unregistered and keeps no edges.

A user registered in the room graph is required before an edge can be created.
A presence row can appear a few milliseconds before its socket finishes
joining; the peer's own join sync creates the edge then, instead of leaving an
orphan edge for a socket that never joined.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array in `RTCPeerConnection({ iceServers })` shape. STUN/STUNS only on Day 8; TURN is excluded (no relay credentials yet). |
| `SOCKET_SIGNAL_EPS` | `30` | Sustained `signal` events per socket per second. |
| `SOCKET_SIGNAL_BURST` | `100` | Token-bucket capacity: how many trickled candidates may arrive in one burst. |
| `PROXIMITY_RADIUS_PX` | `100` | Reused earshot radius (exact pixel check in `findNearby`). |

`ICE_SERVERS` is validated at config load. Malformed JSON, a non-array, an empty
array, more than 8 entries, a non-`stun:`/`stuns:` URL, or a non-string
username/credential falls back to the default list and records one warning.
The gateway prints that warning once at boot; boot never fails because of it.
Unknown entry fields are stripped before the list is sent to browsers.

Example:

```bash
ICE_SERVERS='[{"urls":"stun:stun.example.org:3478"},{"urls":["stun:a.example.org","stun:b.example.org"]}]' npm start
```

## Tests

```bash
# everything (needs a reachable MongoDB for the real-DB suites)
npm test

# just Day 8
node --test server/test/peerGraph.unit.test.js \
  server/test/peerGraph.integration.test.js \
  server/test/signal.validation.test.js \
  server/test/iceServers.test.js
```

`peerGraph.integration.test.js` uses a real Socket.IO server, real
`socket.io-client` sockets and a real isolated MongoDB database
(`proxispeak_day8_test_<pid>_<timestamp>`, dropped afterwards). It covers:

- one `peer:connect` per user with equal generations and exactly one initiator;
- a far user receiving nothing; in/out-of-range moves emitting exactly one
  connect/disconnect and no duplicate on a move that stays in range;
- 99/100 px connected, 101 px disconnected;
- offer → answer → candidate relay with `from`/generation, plus refusal for
  out-of-range, other-room, self, stale-generation, malformed, oversized and
  pre-join signals;
- a removed-then-recreated edge rejecting the old generation;
- disconnect, presence expiry and a `SIGKILL`ed client cleaning all edges;
- reconnect getting a new id and no edges for the old id;
- the A–B–C chain (A–B and B–C, no A–C);
- 50 users × 20 random moves: unique edges, exact brute-force edge set at the
  end, no crash, and printed p50/p95 recompute timing.

Local verification in this environment (MongoDB 6.0.29, 2 vCPU sandbox):

- server suite: **101 tests, 101 passed, 0 failed, 0 skipped**;
- client suite: **101 passed, 0 skipped**; `npm run build --prefix client` succeeded;
- stress run: 1,050 recomputes, 22 edges, **p50 ≈ 4.7 ms, p95 ≈ 11.4 ms**
  (timings are environment-dependent and printed by the test).

## Limits (deliberately out of this slice)

- No browser WebRTC/audio work: `getUserMedia`, `RTCPeerConnection`, Web Audio
  and the client UI are Day 9+.
- No TURN server and no audio relay; the server only forwards signaling text.
- Edges are in memory per process. Multi-instance rooms/edges (Redis) are Week 3.
- No obstacle occlusion; the graph uses straight-line pixel distance only.
