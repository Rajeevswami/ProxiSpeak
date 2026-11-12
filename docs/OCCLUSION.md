# Week 3 (Day 16) — Sound-Blocking Obstacles in the Client Audio Path

Week 3 (Day 16) connects persisted room obstacles (`joined.room.obstacles` and live `room:layout` updates) to the browser Web Audio gain chain so walls, pillars, screens, desks, and plants attenuate remote voice along the 2D line of sight.

No server files, distance curves (`client/src/audio/attenuation.js`), or movement modules were modified.

---

## 1. Acoustic Semantics

### Meaning of `attenuation`

Across `docs/ROOM_PERSISTENCE.md`, `server/src/models/Room.js`, `server/src/validators/roomLayout.js`, and the seeded room blueprint in `server/src/services/roomService.js` (`buildDefaultRoom`), each obstacle's `attenuation` is a **transmission factor in `[0, 1]`** — the fraction of sound amplitude that **passes through** the obstacle (smaller values block more sound):

| Seeded obstacle type | `attenuation` (`T`) | Sound passing through | Sound blocked |
| --- | ---: | ---: | --- |
| `wall` (`wall-core`) | `0.12` | 12% | Heavy concrete spine |
| `pillar` (`pillar-1`, `pillar-2`) | `0.25` | 25% | Structural column |
| `screen` (`screen-1`, `screen-2`) | `0.45` | 45% | Light meeting partition |
| `desk` (`desk-a`, `desk-b`, `desk-c`) | `0.50` | 50% | Workstation cluster |
| `plant` (`plant-1`, `plant-2`) | `0.65` | 65% | Soft acoustic buffer |
| Transparent boundary | `1.00` | 100% | No effect |
| Opaque barrier | `0.00` | 0% | Complete acoustic block |

### Line-of-Sight & Intersection Rules

1. **Line-of-sight segment**: the closed straight line segment $[A, B]$ between the listener $A = (x_L, y_L)$ (the local avatar's current predicted position) and the speaker $B = (x_S, y_S)$ (the remote avatar's current interpolated position — the exact positions already used by `distanceBetween` and `gainForDistance`).
2. **Blocking predicate**: an obstacle participates in occlusion if and only if `blocksAudio === true` and the **closed** segment $[A, B]$ intersects the **closed** axis-aligned rectangle $[x, x + w] \times [y, y + h]$ (`w > 0`, `h > 0`).
   - **Standing inside an obstacle**: avatars have no movement collision with obstacles and may stand inside an obstacle rectangle. If either endpoint (or both) lies inside $[x, x + w] \times [y, y + h]$, the closed segment intersects the closed rectangle and the obstacle blocks sound.
   - **Boundary contact**: touching an edge or grazing a corner counts as intersecting.
   - **Zero-length segment ($A = B$)**: when both avatars occupy the exact same point, the degenerate segment intersects the obstacle if and only if that point lies inside or on the boundary of $[x, x + w] \times [y, y + h]$.
   - **Symmetry**: swapping listener and speaker produces bit-for-bit identical intersection and transmission results.
3. **Multiplicative transmission**:
   $$T(A, B) = \operatorname{clamp}_{[0, 1]}\!\left(\prod_{k \in \mathcal{I}(A, B)} \text{attenuation}_k\right)$$
   where $\mathcal{I}(A, B)$ is the set of blocking obstacles intersected by $[A, B]$.
   - Each obstacle is counted **at most once** (entering and exiting two edges of one rectangle counts that obstacle once; duplicate object references or duplicate string IDs in raw input are deduplicated in `prepareObstacles`).
   - Obstacles with `blocksAudio === false` (or non-boolean `blocksAudio`) are ignored.
   - When no blocking obstacle is intersected (or the obstacle list is empty), the empty product gives $T = 1$.
   - Any intersected obstacle with `attenuation === 0` yields $T = 0$ immediately.
4. **Combined target gain**:
   $$G_{\text{target}}(A, B) = \operatorname{gainForDistance}(\lVert A - B \rVert_2) \times T(A, B)$$
   The Day 11 smoothstep distance curve (`innerPx = 30`, `outerPx = proximityRadiusPx`, default `100`) is unchanged:
   $$\operatorname{gainForDistance}(d) = \begin{cases} 1, & d \le 30 \\ 1 - (3u^2 - 2u^3), & 30 < d < \text{outerPx},\; u = \dfrac{d - 30}{\text{outerPx} - 30} \\ 0, & d \ge \text{outerPx} \end{cases}$$

---

## 2. Geometry & Algorithm (`client/src/audio/occlusion.js`)

```text
  y
  ▲      Open path (same side of wall): T = 1.00
  │      A (850,540) ●───────────────● B (920,540)
  │
  │                      ┌──────────┐ (980,690)
  │                      │          │
  │      A (925,540) ●───┼─wall-core┼───● B (995,540)   Blocked path: T = 0.12
  │                      │  (0.12)  │
  │            (940,390) └──────────┘
  │
  │      Corner graze:   ╱┌────────┐
  │                    ●  │        │   Closed touch at (x, y) => intersects = true
  │                       └────────┘
  └────────────────────────────────────────────────────────► x
```

### Zero-Allocation Two-Stage Test

1. **Layout normalization & `layoutRevision` caching (`prepareObstacles`, `createObstacleCache`)**:
   - Filters raw room obstacles once per `layoutRevision` into a frozen array of compact objects `{ id, x, y, w, h, maxX, maxY, attenuation }`.
   - Skips non-objects, `blocksAudio !== true`, non-finite numbers (`NaN`, `±Infinity`), and non-positive dimensions (`w <= 0` or `h <= 0`) without throwing; clamps finite `attenuation` into `[0, 1]`.
   - Cached by `(roomId, layoutRevision)` so 20 Hz mixer ticks reuse the prepared array without rebuilding or allocating until `joined` or `room:layout` delivers a new revision.
2. **Endpoint canonicalization & bounding-box pre-check (`transmissionBetween`)**:
   - Endpoints are ordered lexicographically (`ax < bx`, or `ax === bx && ay <= by`) once per peer before scanning obstacles, guaranteeing exact symmetry under `listener <-> speaker` swap.
   - Each obstacle first runs a 4-comparison closed AABB check (`segMaxX < obs.x || segMinX > obs.maxX || segMaxY < obs.y || segMinY > obs.maxY`), rejecting ~99% of room obstacles in a few nanoseconds.
3. **Exact Liang-Barsky clipping (`segmentIntersectsRect`)**:
   - Axis-aligned (`dx === 0` or `dy === 0`) and zero-length (`dx === 0 && dy === 0`) segments whose closed bounding boxes overlap $[x, x+w] \times [y, y+h]$ return `true` immediately with **zero divisions**.
   - Diagonal segments (`dx > 0` and `dy !== 0`) clip parameter $t \in [0, 1]$ along $P(t) = A + t(B - A)$ against the X and Y slabs.
   - Uses relative parametric tolerance `PARAM_EPSILON = 4 * Number.EPSILON` ($\approx 8.88 \times 10^{-16}$) on $t_{\text{enter}} \le t_{\text{exit}} + \epsilon$ so corners touched at binary-inexact IEEE-754 decimals (such as `0.1`, `0.35`, `0.4`, `0.7`) are not missed by 1–2 ULP division rounding, without inflating pixel tolerance on long segments.
   - Cross-checked across **20,000** seeded random cases (uniform room floats, grid-snapped boundaries, axis-aligned segments, zero-length points, and $2 \times 10^5$ px long segments) against an independent 2D cross-product orientation (segment-versus-four-edges + point-in-rectangle) reference with **0 disagreements**.

---

## 3. Worked Examples (Seeded `1920 × 1080` Lobby)

Produced directly by `node client/scripts/occlusion-bench.js` against the seeded `lobby` obstacles from `server/src/services/roomService.js` (`innerPx = 30`, `outerPx = 100`):

At $d = 70\text{ px}$, $u = (70 - 30)/(100 - 30) = 4/7$, so $\operatorname{gainForDistance}(70) = 135/343 \approx 0.39359$.

| Scenario | Obstacle (`T`) | Listener | Speaker | Distance | `gainForDistance(d)` | `T` | Final target gain | Overlay text |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Open floor (same side of `wall-core`) | none (`1.00`) | `(850, 540)` | `(920, 540)` | `70 px` | `0.39359` | `1.00` | `0.39359` | `volume 39% (100%)` |
| Across `wall-core` (`x=940, y=390, w=40, h=300`) | `wall` (`0.12`) | `(925, 540)` | `(995, 540)` | `70 px` | `0.39359` | `0.12` | `0.04723` | `volume 5% (blocked 12%)` |
| Across `wall-core` at 73 px | `wall` (`0.12`) | `(923, 540)` | `(996, 540)` | `73 px` | `0.33156` | `0.12` | `0.03979` | `volume 4% (blocked 12%)` |
| Across `screen-1` (`x=345.6, y=237.6, w=180, h=14`) | `screen` (`0.45`) | `(435.6, 210)` | `(435.6, 280)` | `70 px` | `0.39359` | `0.45` | `0.17711` | `volume 18% (blocked 45%)` |
| Across `desk-c` (`x=422.4, y=777.6, w=200, h=60`) | `desk` (`0.50`) | `(522.4, 772.6)` | `(522.4, 842.6)` | `70 px` | `0.39359` | `0.50` | `0.19679` | `volume 20% (blocked 50%)` |
| Across `pillar-1` (`x=864, y=216, w=34, h=34`) | `pillar` (`0.25`) | `(846, 233)` | `(916, 233)` | `70 px` | `0.39359` | `0.25` | `0.09840` | `volume 10% (blocked 25%)` |
| Across `plant-1` (`x=1632, y=712.8, w=26, h=26`) | `plant` (`0.65`) | `(1610, 725.8)` | `(1680, 725.8)` | `70 px` | `0.39359` | `0.65` | `0.25583` | `volume 26% (blocked 65%)` |
| Speaker inside `desk-a` (inner radius) | `desk` (`0.50`) | `(1295, 250)` | `(1320, 250)` | `25 px` | `1.00000` | `0.50` | `0.50000` | `volume 50% (blocked 50%)` |

---

## 4. Gain Smoothing & Audio Mixer Integration (`client/src/audio/audioMixer.js`)

```text
remote MediaStream
    ├── muted hidden <audio autoplay playsinline>
    └── MediaStreamAudioSourceNode ──► GainNode ──► AudioContext.destination
                                          ▲
             gain.setTargetAtTime(gainForDistance(d) * T, currentTime, τ)
               • τ = TARGET_TIME_CONSTANT    (0.05 s) in unobstructed open space
               • τ = OCCLUSION_TIME_CONSTANT (0.08 s) while occluded or crossing out of shadow
```

### Why `OCCLUSION_TIME_CONSTANT = 0.08` s?

Distance attenuation changes gradually as an avatar walks at 300 px/s (at most 15 px per 50 ms mixer tick). By contrast, crossing the geometric edge of a `0.12` wall changes `T` instantaneously from `1.0` to `0.12` (or `0.12` back to `1.0` when emerging or when `room:layout` removes a wall) within a single tick.

Writing `gain.value` directly or stepping too abruptly causes an audible discontinuity (click/pop). `audioMixer.js` never writes `gain.gain.value` after initial node creation (`0` before connecting to `destination`); every update schedules an exponential approach via `setTargetAtTime(target, context.currentTime, timeConstant)`:

- **`TARGET_TIME_CONSTANT = 0.05` (50 ms)**: used when `T === 1` and the previous tick was also unobstructed (`peer.transmission === 1`), preserving exact Day 11 behavior whenever no obstacles block the pair (or when the room has no obstacles).
- **`OCCLUSION_TIME_CONSTANT = 0.08` (80 ms)**: exported named constant used whenever `T < 1` or `T !== peer.transmission` (both entering and leaving an obstacle's shadow, ~240 ms to reach 95% of the step), eliminating wall-edge clicks while remaining responsive to walking speed.

### Live `room:layout` Reactivity & Overlay

- `useSocket.js` passes `worldRef.current.room` into `audioMixer.updateGains` from the existing `requestAnimationFrame` callback (throttled to at most 20 Hz inside the mixer).
- When `PUT /api/rooms/:roomId/layout` or `npm run room:save` updates a room, the server broadcasts `room:layout` with the incremented `layoutRevision`. `updateRoomLayout` mutates `world.room.obstacles` and `world.room.layoutRevision` in place, and the very next mixer tick rebuilds the cached obstacle list and updates peer gains without re-joining or re-rendering React.
- `AudioStatus.jsx` continues polling at most once per second (`1000 ms`) and formats each peer's volume cell via `formatPeerVolume(volumePercent, transmission)` — e.g. `volume 39% (100%)` in the open and `volume 4% (blocked 12%)` behind `wall-core` — with no new controls and no per-frame React state.

---

## 5. Measured Performance (8 Peers × 200 Obstacles per Tick)

Measured in Node v22.22.3 (`x86_64` Linux) via `node client/scripts/occlusion-bench.js` (1,000 warmup ticks + 5,000 timed ticks; 8 peers × 200 obstacles = **1,600 obstacle checks per tick**):

| Benchmark workload (8 peers × 200 obstacles) | p50 | p95 | max | Notes |
| --- | ---: | ---: | ---: | --- |
| Spread 1920×1080 room (`transmissionBetween` only) | `11.04 µs` (`0.0110 ms`) | `12.41 µs` (`0.0124 ms`) | `145.92 µs` (`0.1459 ms`) | **1,595 / 1,600 (99.69%)** rejected by 4-compare AABB pre-check |
| Worst-case dense overlap (`transmissionBetween` only) | `16.11 µs` (`0.0161 ms`) | `22.13 µs` (`0.0221 ms`) | `205.21 µs` (`0.2052 ms`) | All 1,600 pairs overlap AABB and run full Liang-Barsky |
| Full `audioMixer.updateGains` tick (spread room) | `11.21 µs` (`0.0112 ms`) | `13.67 µs` (`0.0137 ms`) | `363.65 µs` (`0.3637 ms`) | `prepareObstacles` ran **1 time** across all 6,000 ticks |

At `p95 ≈ 0.014 ms` once every `50 ms` (20 Hz), maximum-capacity 8-peer × 200-obstacle occlusion consumes **< 0.03%** of main-thread time with zero per-tick heap allocations.

---

## 6. Manual Two-Window Verification Steps

> **Verification status in this environment**: Node unit/property/cross-check/mixer tests pass, but no browser or audio hardware is installed in this sandbox, so live audible volume drop and recovery in a real browser remain **NOT VERIFIED** here.

To verify audibly on a workstation with MongoDB and a browser:

1. Start MongoDB, seed rooms, set an admin token, and start the server and Vite client:
   ```bash
   cp .env.example .env
   # Set ROOM_ADMIN_TOKEN="local-dev-secret" in .env
   npm run seed
   ROOM_ADMIN_TOKEN="local-dev-secret" npm start
   ```
   In a second terminal:
   ```bash
   npm run dev:client
   ```
2. Open `http://localhost:5173` in two browser windows (use headphones or Chrome `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` flags from `docs/DAY11.md`) and join `lobby` as two users.
3. Walk both avatars to the left side of the central vertical wall (`wall-core` at `x = 940..980, y = 390..690`), about 70 px apart (e.g. near `(850, 540)` and `(920, 540)`). Confirm audible voice and overlay text around `volume 39% (100%)`.
4. Walk one avatar to the right side of `wall-core` (e.g. `(995, 540)` while the other stands at `(925, 540)`, still ~70 px apart). Confirm remote voice drops smoothly without clicking and the overlay updates within 1 second to `volume 5% (blocked 12%)` (or `volume 4% (blocked 12%)` at ~73 px).
5. Without reloading either browser window, save an empty obstacle layout using the CLI:
   ```bash
   # Read current layoutRevision first:
   npm run room:show -- --room lobby
   # Save a JSON file with {"obstacles": []} against the running server/DB:
   ROOM_ADMIN_TOKEN="local-dev-secret" npm run room:save -- --room lobby --file /tmp/open-lobby.json
   ```
6. Observe both browser windows immediately redraw without the wall (`room:layout`), audible volume smoothly return to ~39%, and the overlay return to `volume 39% (100%)` without re-joining or refreshing.

---

## 7. Known Limitations

- **2D straight line-of-sight only**: there is no acoustic diffraction around obstacle corners, no wall reflection or reverb, no frequency-dependent low-pass muffling (`BiquadFilterNode`), and no path-length thickness calculation (grazing a wall corner and crossing perpendicular through its center apply the same `attenuation` factor).
- **Obstacle height ignored**: obstacles are 2D floor-plan rectangles `[x, x + w] × [y, y + h]`; vertical elevation is not modeled.
- **Standing inside an obstacle blocks audio**: movement collision with obstacles is not implemented, so avatars can overlap furniture/walls; an endpoint inside a blocking rectangle intersects it and applies its `attenuation`.
- **Client-only gain reduction (network stream stays live)**: the server peer graph still depends solely on Euclidean radius and peer cap. A peer behind a `0.12` or `0.0` wall inside `PROXIMITY_RADIUS_PX` retains its WebRTC connection and continues transmitting RTP packets; only client playback gain drops.
- **Fallback element is unattenuated**: if the browser lacks Web Audio API support, playback falls back to an unmuted `<audio>` element at 100% volume without distance or obstacle attenuation.
- **Out of scope for Week 3 (Day 16)**: stereo panning (`StereoPannerNode`) and steady 60 FPS rendering/performance work are separate upcoming tasks and have not been started.
