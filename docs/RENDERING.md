# Week 3 (Day 18) — Steady 60 FPS Canvas Rendering

Company plan item: *"Refine & Polish ... Ensure Canvas animations render at a steady 60 FPS"* (company plan Week 4), delivered in calendar **Week 3 (Day 18)**. See `docs/REQUIREMENTS_TRACE.md`.

---

## 1. Step 0 Baseline — Before Optimization (`4188ced`)

Measured on the unmodified tree before any Week 3 (Day 18) code changes (`Node v22.22.3`, Linux x64, `Intel(R) Xeon(R) Processor @ 2.60GHz`, viewport `1440 × 900` CSS px on a `1920 × 1080` room so `scale = 0.75 > 0.25`).

### 1.1 What is drawn per frame today

`WorldCanvas.jsx` owns a single `requestAnimationFrame` loop. On every callback `frame(now)`:

1. `deltaSeconds = Math.max(0, (now - lastFrameTime) / 1000)` is passed to `updateFrame(deltaSeconds)` (`App.jsx`), which runs `movement.update(deltaSeconds)` (`client/src/movement/controller.js`: local prediction + 10 Hz `move` throttle + remote `1 - exp(-12 * dt)` interpolation) and `updateAudioGains()` (`client/src/audio/audioMixer.js`, internally gated to 20 Hz).
2. `drawWorld(ctx, world.current, size)` (`client/src/canvas/renderer.js`) redraws the **entire static room** (`drawRoom`) from scratch on the main 2D context and then draws every avatar (`drawAvatars`):
   - **Clear & letterbox backdrop** (`drawRoom`): `1 × clearRect` + `1 × fillRect` (`#05070d`) across the full canvas.
   - **Room floor** (`drawRoom`): `computeViewport(1920, 1080, width, height)`, then `1 × fillRect` (`#151c2e`).
   - **Floor grid** (`drawRoom`, `GRID_STEP_WORLD = 120` px): `1 × beginPath`, `15` vertical grid lines (`15 × moveTo` + `15 × lineTo` at `x = 120 … 1800`), `8` horizontal grid lines (`8 × moveTo` + `8 × lineTo` at `y = 120 … 960`), `1 × stroke` = **48** path calls.
   - **Room border** (`drawRoom`): `1 × strokeRect` = **52** static 2D context calls before any obstacles.
   - **Obstacles** (`drawRoom`, `O` obstacles): per obstacle, `1 × fillRect` (at `globalAlpha = 0.85`), `1 × strokeRect` (at `globalAlpha = 1`), and when `scale > 0.25`, `1 × fillText` for the obstacle type label = **`3 × O`** calls (`82` static calls in the 10-obstacle seeded `lobby`, `652` static calls at `200` obstacles).
   - **Avatars** (`drawAvatars`, `A` avatars = `1` local `selfId` + `A - 1` remote):
     - Each remote avatar issues **7** calls: `beginPath`, `arc`, `fill`, `stroke`, initial `fillText`, name outline `strokeText`, name fill `fillText`.
     - The local avatar (`user.id === world.selfId`) issues **10** calls: the same 7 calls plus the highlight ring (`beginPath`, `arc(radius + 5)`, `stroke`).
     - Total dynamic calls for `A >= 1` avatars (with `selfId` present): **`7 × A + 3`** (`10`, `73`, `423` for `1`, `10`, `60` avatars).

#### Seeded `lobby` breakdown (`10` obstacles, `10` avatars, `1440 × 900` CSS px)

Recorded with a fake 2D context against `drawWorld` on the exact 10 obstacles from `buildDefaultRoom('lobby')`:

| 2D context method | Static (`drawRoom`) | Dynamic (`drawAvatars`, 10 users) | Frame total |
| --- | ---: | ---: | ---: |
| `clearRect` | 1 | 0 | 1 |
| `fillRect` | 12 | 0 | 12 |
| `strokeRect` | 11 | 0 | 11 |
| `beginPath` | 1 | 11 | 12 |
| `moveTo` | 23 | 0 | 23 |
| `lineTo` | 23 | 0 | 23 |
| `stroke` | 1 | 11 | 12 |
| `arc` | 0 | 11 | 11 |
| `fill` | 0 | 10 | 10 |
| `fillText` | 10 | 20 | 30 |
| `strokeText` | 0 | 10 | 10 |
| `drawImage` | 0 | 0 | 0 |
| **Total calls / frame** | **82** | **73** | **155** |

#### Baseline per-frame 2D context operation counts (before optimization)

| Obstacles (`O`) | Static calls (`drawRoom`) | `1` avatar (`self`) | `10` avatars (`1` self + `9` peers) | `60` avatars (`1` self + `59` peers) |
| ---: | ---: | ---: | ---: | ---: |
| `0` | 52 | 62 | 125 | 475 |
| `10` (seeded `lobby`) | 82 | 92 | 155 | 505 |
| `100` | 352 | 362 | 425 | 775 |
| `200` | 652 | 662 | 725 | 1,075 |

### 1.2 Every per-frame allocation found before optimization

Auditing `WorldCanvas.jsx`, `coords.js`, `renderer.js`, `movement/controller.js`, `movement/movement.js`, `movement/throttle.js`, and `realtime/worldState.js` revealed the following allocations inside the per-frame path:

1. **Fresh viewport object every frame (`client/src/canvas/coords.js:103`, called from `renderer.js:46`)**:
   - `computeViewport(room.width, room.height, width, height)` allocates a new 9-field object `{ scale, offsetX, offsetY, drawnWidth, drawnHeight, roomWidth, roomHeight, canvasWidth, canvasHeight }` on every frame.
2. **Obstacle fallback array & array iterator (`client/src/canvas/renderer.js:78`)**:
   - `for (const obstacle of room.obstacles ?? [])` allocates an empty fallback array `[]` whenever `room.obstacles` is nullish and uses iterator protocol (`ArrayIterator`) over up to 200 obstacles on every frame; `String(obstacle.type ?? '')` at `renderer.js:96` allocates when `type` is missing.
3. **Per-avatar initial font template string (`client/src/canvas/renderer.js:173`)**:
   - `` ctx.font = `700 ${Math.max(10, radius)}px system-ui, sans-serif` `` allocates a new template string **once per avatar per frame** (`60` strings/frame at 60 avatars), even though `radius` depends only on `viewport.scale` and is constant across every avatar in the frame (and across frames until resize).
4. **Per-avatar initial slicing & uppercasing (`client/src/canvas/renderer.js:176`)**:
   - `label.slice(0, 1).toUpperCase()` allocates substring/uppercase strings **once per avatar per frame** (`60` times/frame at 60 avatars) for static user names.
5. **Local avatar `" (you)"` template string (`client/src/canvas/renderer.js:181`)**:
   - `` isSelf ? `${label} (you)` : label `` allocates a fresh concatenated string on every frame for `selfId`.
6. **Per-avatar label truncation strings (`client/src/canvas/renderer.js:133-136`, called at `181`)**:
   - `truncateLabel(...)` runs on every avatar every frame; for any label exceeding `MAX_AVATAR_LABEL_CHARS` (`18`), `` `${value.slice(0, Math.max(1, maxChars - 1))}…` `` allocates both a `.slice(...)` substring and a template string with ellipsis on every frame.
7. **Fallback user label template string (`client/src/canvas/renderer.js:126`)**:
   - `avatarLabel(user, world.selfId)` allocates `` `user-${String(user.id).slice(0, 4)}` `` on every frame for unnamed remote peers.
8. **Repeated per-avatar colour hashing (`client/src/canvas/renderer.js:116-120`, called at `156`)**:
   - `avatarColor(user)` coerces `String(user?.id ?? user?.name ?? '')` and re-hashes every character of `user.id` on every frame for every remote avatar instead of caching by user id.
9. **Other inspected per-frame paths (already allocation-free or non-allocating)**:
   - `WorldCanvas.jsx`: `size = { width: 0, height: 0 }` is allocated once in `useEffect` and mutated on resize; `frame` creates no closures or React state. Note however that `lastFrameTime` is seeded with `performance.now()` on mount rather than the first `requestAnimationFrame` timestamp, `resize` listeners are uncoalesced, `devicePixelRatio` changes across monitors are not watched via `matchMedia`, and `document.hidden` does not skip drawing.
   - `movement/controller.js`: reuses `direction = { x: 0, y: 0 }` and mutates `self.x`/`self.y` and remote `user.x`/`user.y` in place; `throttle.update` allocates nothing until a 10 Hz `move` emit fires.
   - `renderer.js`: `ctx.measureText` is not called (`textAlign = 'center'` + character-count truncation are used).

#### Measured baseline JS work & young-generation churn (`60` avatars, `200` obstacles, fake 2D context)

- **JS work time** (`5,000` frames after `1,000` warm-up, JavaScript cost only, not GPU rasterization/compositing): `p50 = 7.10 µs` (`0.0071 ms`), `p95 = 8.29 µs` (`0.0083 ms`), `max = 273.07 µs` (`0.2731 ms`).
- **Pre-scavenge heap burst** (`50` consecutive frames immediately after `gc()`): **`392,128 B`** (`7,842.56 B/frame`, ~`470 KB/s` of short-lived garbage at 60 FPS).

---

## 2. Two-Layer Rendering Architecture (Week 3, Day 18)

Rooms are static between layout saves (`layoutRevision` bumps) and viewport resizes, whereas avatars move continuously at display refresh rate. Week 3 (Day 18) splits rendering into a cached offscreen **static layer** and a zero-allocation **dynamic avatar pass**, driven by a single lifecycle-managed `requestAnimationFrame` loop:

```text
requestAnimationFrame(timestamp)   [client/src/canvas/frameLoop.js]
  │
  ├─ if document.hidden ──► skip movement + draw; markHidden() on frameStats
  │
  ├─ if needsResize ──────► syncCanvasSize() (coalesced <= 1x per frame)
  │                          └─ updateCanvasSize(view, innerWidth, innerHeight, dpr)
  │
  ├─ dtMs = min(MAX_FRAME_DT_MS = 50, max(0, timestamp - lastFrameTime))
  │   └─ updateFrame(dtMs / 1000)  [movement.update + 20 Hz audioMixer throttle]
  │
  ├─ drawFrame(ctx, staticLayer, view, world, labelCache)  [renderer.js]
  │   ├─ 1. staticLayer.ensure(view, room)                 [staticLayer.js]
  │   │     └─ cache hit: numeric + roomId checks only (0 ops, 0 allocations)
  │   │     └─ cache miss: resize offscreen canvas + drawStatic(offCtx, view, room)
  │   ├─ 2. ctx.drawImage(offscreenCanvas, 0, 0, view.width, view.height)  [1 op]
  │   └─ 3. drawDynamic(ctx, view, world, labelCache)      [7*A + 3 ops, 0 strings]
  │
  └─ if ?perf=1 ──────────► frameStats.record(intervalMs, workMs)
                             └─ <= 1 Hz: perfEl.textContent = formatPerfReadout(...)
```

### Module responsibilities

| Module | Role |
| --- | --- |
| `client/src/perf/frameStats.js` | Pure, DOM-free `Float64Array(240)` ring buffer for frame `intervalMs` and callback `workMs`, nearest-rank percentiles (`ceil(q * n) - 1`), and `DROPPED_FRAME_MS = 25` counting. |
| `client/src/perf/perfReadout.js` | `?perf=1` URL parser (`isPerfEnabled`) and readout formatter (`formatPerfReadout`). |
| `client/src/canvas/coords.js` | `MAX_BACKING_PIXELS = 16_000_000`, `MIN_CANVAS_SIZE_PX = 1`, zero-allocation `updateCanvasSize`, `updateViewport`, and `screenToWorldInto` (plus compatible allocating helpers). |
| `client/src/canvas/staticLayer.js` | Offscreen static `<canvas>` cache (`createStaticLayer`, `resolveBackingMetrics`) with injectable canvas factory and `destroy()` backing-store release. |
| `client/src/canvas/renderer.js` | `drawStatic`, `drawDynamic`, `drawFrame`, and per-user `createLabelCache()` (plus compatible `drawRoom`, `drawAvatars`, `drawWorld` wrappers). |
| `client/src/canvas/frameLoop.js` | Single `requestAnimationFrame` controller (`createCanvasLoop`, `MAX_FRAME_DT_MS = 50`) owning resize coalescing, DPR `matchMedia` re-arming, `visibilitychange`, click-to-walk translation, callback error isolation, and `<= 1 Hz` `?perf=1` DOM writes. |
| `client/src/components/WorldCanvas.jsx` | Thin React mount/unmount wrapper delegating the canvas lifecycle to `createCanvasLoop` with zero per-frame React state. |

---

## 3. `MAX_BACKING_PIXELS` (`16,000,000`) & Device Pixel Ratio Budget

Both the visible `<canvas>` and the offscreen static `<canvas>` size their pixel backing stores via `resolveBackingMetrics` / `updateCanvasSize`:

$$\text{effectiveDpr} = \min\!\left(\text{devicePixelRatio},\; \sqrt{\frac{16{,}000{,}000}{\text{cssWidth} \times \text{cssHeight}}}\right)$$

Why `MAX_BACKING_PIXELS = 16_000_000` is enforced:

1. **GPU / RAM budget**: Each RGBA pixel consumes `4` bytes. At `16,000,000` pixels, one canvas backing store uses at most `64 MB` (`128 MB` combined across the visible canvas and the cached static offscreen canvas). Without this cap, a `3840 × 2160` 4K window at `DPR 3` would allocate `11520 × 6480 = 74,649,600` pixels (`~298.6 MB` per canvas, `~597.2 MB` combined) and force the compositor to blit `74.6M` pixels every `16.67 ms`.
2. **Browser & mobile GPU texture limits**: WebKit/Safari and mobile tile GPUs silently refuse 2D canvas backing stores above `~16.7M` pixels (`4096 × 4096`), leaving the canvas blank. Lowering `effectiveDpr` proportionally preserves the exact aspect ratio while keeping ultrawide and 4K displays safely inside browser limits.

### Verified backing-store dimensions (`client/test/staticLayer.test.js`)

| Display profile | CSS size (`px`) | Native DPR | Effective DPR | Backing store (`px`) | Total pixels | Cap applied? |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 4K monitor | `3840 × 2160` | `3` | `1.388889` | `5333 × 3000` | `15,999,000` | Yes (`<= 16M`) |
| Phone | `390 × 844` | `3` | `3.000000` | `1170 × 2532` | `2,962,440` | No (native `3x`) |
| Retina laptop | `1440 × 900` | `2` | `2.000000` | `2880 × 1800` | `5,184,000` | No (native `2x`) |

---

## 4. Zero Per-Frame Allocation Design

Every per-frame allocation identified in Section 1.2 was removed from the steady-state render path:

1. **In-place viewport & canvas metrics (`coords.js`, `frameLoop.js`)**: `createCanvasLoop` allocates one `view` object on mount and mutates it in place via `updateCanvasSize` and `updateViewport`. Click-to-walk uses `screenToWorldInto`.
2. **Static room offscreen cache (`staticLayer.js`)**: `staticLayer.ensure(view, room)` checks five primitive/reference fields (`backingWidth`, `backingHeight`, `effectiveDpr`, `room.roomId`, `room.layoutRevision`, plus room dimensions) — zero string concatenation, zero key objects, and zero obstacle loop iterations on steady frames.
3. **Cached initial font string (`renderer.js`)**: `initialFontFor(scale, radius)` formats `` `700 ${Math.max(10, radius)}px system-ui, sans-serif` `` only when `viewport.scale` changes, reusing the cached string across every avatar and frame.
4. **Per-user avatar label & colour cache (`createLabelCache` in `renderer.js`)**:
   - Keyed by `user.id` in a `Map`. Each entry caches `{ rawName, isSelf, color, initial, text, measuredFont, measuredWidth, seenTag }`.
   - `avatarColor`, `avatarLabel`, `" (you)"` suffixing, `.slice(0, 1).toUpperCase()`, and `truncateLabel` run **only** when a user joins, renames (`entry.rawName !== rawName`), or changes self status (`entry.isSelf !== isSelf`).
   - `measureWidth(ctx, entry, font)` caches `ctx.measureText(entry.text).width` on the entry when text measurement is requested.
   - **Automatic pruning with zero steady-state overhead**: each frame advances a monotonic 31-bit SMI tag (`MAX_SMI_TAG = 0x3fffffff`) and counts unique seen user ids. When nobody left (`map.size === seenCount`), `finishFrame` returns in `O(1)` without iterating; when a user leaves (`map.size !== seenCount`), stale entries are deleted immediately (`50` join/leave cycles leave `labelCache.size === 0`).
5. **Stack-register avatar coordinates (`renderer.js`)**: `centreX` and `centreY` are computed as local `const` numbers inside `drawDynamic` rather than written to a module-global object property, avoiding V8 `HeapNumber` boxing across 60 avatars.

---

## 5. Frame Loop Discipline, Hidden Tabs, Resize Coalescing & DPR Watching

`createCanvasLoop` (`client/src/canvas/frameLoop.js`) enforces strict frame-loop hygiene:

- **Single `requestAnimationFrame` subscription**: `hasPendingRaf` guarantees at most one scheduled callback at a time; `stop()` calls `cancelAnimationFrame`, removes all window/document/canvas/`MediaQueryList` listeners, clears the label cache, and calls `staticLayer.destroy()` (`width = 0; height = 0`). Verified across 50 mount/unmount cycles with zero leaked listeners, zero pending callbacks, and zero live offscreen canvases.
- **Timestamp discipline & `MAX_FRAME_DT_MS = 50` ms clamp**: frame delta is computed exclusively from the `requestAnimationFrame` callback timestamp (never `Date.now()`). Any slow frame or OS stall clamps `dt` to `MAX_FRAME_DT_MS = 50` ms (`0.05` s → at most `15 px` at `300 px/s`), preventing avatars from teleporting across rooms. Movement remains frame-rate invariant (`60 Hz` and `144 Hz` reach the exact same world coordinates over `1.0 s`).
- **Hidden-tab suspension (`document.hidden`)**: while the tab is hidden, rAF callbacks skip both `updateFrame` and canvas drawing. On `visibilitychange`, `hasTimeBase` resets and `frameStats.markHidden()` marks the gap so returning after a 5-second background tab neither jumps the avatar nor records a false dropped frame.
- **Resize coalescing & cross-monitor DPR watching**:
  - `window` `resize` listeners only flip `needsResize = true`; `syncCanvasSize()` runs at most once at the top of the next animation frame (`100` resize events in one frame cause `1` canvas resize and `1` static-layer rebuild).
  - `matchMedia(\`(resolution: ${dpr}dppx)\`)` watches `devicePixelRatio` changes (such as dragging a window between a `1x` external display and a `2x` Retina panel), removes the old `MediaQueryList` listener, re-arms a fresh query for the new ratio, and marks `needsResize = true`.

---

## 6. Rolling Frame Statistics & Opt-In `?perf=1` Readout

### `client/src/perf/frameStats.js`

- Preallocates two `Float64Array(240)` ring buffers (`DEFAULT_RING_CAPACITY = 240`, ~4 seconds at `60 Hz`) plus two `Float64Array(240)` sort-scratch buffers for `snapshot()`.
- `DROPPED_FRAME_MS = 25`: at `60 Hz`, one refresh is `16.67 ms`. Intervals **strictly greater than `25 ms`** (`> 25.0 ms`, ~`1.5×` a `60 Hz` frame) count as dropped refreshes, avoiding false positives from normal `1–2 ms` vsync scheduling jitter (`25.0 ms` is not dropped; `25.1 ms` is dropped).
- Excludes non-finite numbers, negative work durations, first-frame sentinels (`EXCLUDED_INTERVAL_MS = -1` / `<= 0`), post-hidden intervals after `markHidden()`, and background timer stalls above `MAX_VALID_INTERVAL_MS = 1000` ms.
- `snapshot()` computes `fps = (1000 * samples) / sum(intervals)` and nearest-rank `p50` / `p95` / `max` (`ceil(q * n) - 1`, matching `server/src/services/spatialAudit.js`).

### `client/src/perf/perfReadout.js`

- Enabled **only** when the page URL contains `?perf=1` (`isPerfEnabled(window.location.search)`).
- When `?perf=1` is absent (default): `WorldCanvas` does not render the `.perf-readout` element, `createCanvasLoop` does not allocate or update `frameStats`, and zero DOM writes occur.
- When `?perf=1` is present: updates `perfElement.textContent` directly at most once per second (`PERF_READOUT_INTERVAL_MS = 1000` ms) with zero React state or component re-renders:

```text
fps 60 | frame p95 16.9 ms | work p95 0.8 ms | dropped 0
```

---

## 7. Before vs After Measurements (`2026-10-29`)

Reproduce all Node measurements with:

```bash
node --expose-gc client/scripts/render-report.js
```

Environment: `Node v22.22.3`, Linux x64, `Intel(R) Xeon(R) Processor @ 2.60GHz`, viewport `1440 × 900` CSS px (`DPR 2`), `1920 × 1080` room.

### 7.1 Per-frame 2D context operation counts (before vs after)

After the initial static build (`1` build), every steady frame blits the static room with **`1 × drawImage`** and draws only the dynamic avatars (`1 + 7 × A + 3 = 7 × A + 4` operations), making per-frame Canvas 2D command volume **completely independent of room obstacle count**:

| Obstacles (`O`) | Before (`1 / 10 / 60` avatars) | After (`1 / 10 / 60` avatars) | Reduction (`60` avatars) |
| ---: | ---: | ---: | ---: |
| `0` | `62 / 125 / 475` | **`11 / 74 / 424`** | `-51` calls (`-10.7%`) |
| `10` (seeded `lobby`) | `92 / 155 / 505` | **`11 / 74 / 424`** | `-81` calls (`-16.0%`) |
| `100` | `362 / 425 / 775` | **`11 / 74 / 424`** | `-351` calls (`-45.3%`) |
| `200` | `662 / 725 / 1,075` | **`11 / 74 / 424`** | **`-651` calls (`-60.6%`)** |

### 7.2 JavaScript callback work benchmark (`60` avatars × `200` obstacles, `5,000` frames)

> **Important measurement boundary**: This Node benchmark uses a counting fake 2D context (`client/scripts/render-report.js`) and measures **client JavaScript execution cost only** — it does **not** measure browser Canvas 2D Skia/GPU rasterization, texture upload, or display compositing.

| Pipeline | Static builds | `p50` | `p95` | `max` |
| --- | ---: | ---: | ---: | ---: |
| Before (`legacyDrawWorld`, uncached) | n/a (every frame) | `8.52 µs` (`0.0085 ms`) | `9.90 µs` (`0.0099 ms`) | `198.35 µs` (`0.1983 ms`) |
| After (`drawFrame`, cached static layer) | **`1`** | **`3.12 µs` (`0.0031 ms`)** | **`3.42 µs` (`0.0034 ms`)** | **`167.78 µs` (`0.1678 ms`)** |

### 7.3 Heap & allocation verification (`--expose-gc` + V8 `HeapProfiler` at 32 B sampling interval)

| Check | Result |
| --- | --- |
| `frameStats.record(16.67, 0.42)` × `100,000` calls | `sampledAlloc = 9,496 B` (`0.095 B/call`), `retainedDelta = 3,352 B` (zero per-call allocation) |
| `drawFrame` × `50,000` frames (`60` avatars, `200` obstacles) | `retainedBefore = 5,296,296 B` → `retainedAfter = 5,296,568 B`, **`retainedDelta = +272 B` (`0.0054 B/frame`)**, `sampledAlloc = 4,928 B` (`0.099 B/frame`) |
| `50`-frame pre-scavenge young-gen burst (`60` avatars, `200` obstacles) | `1,300,664 B` (`26,013.28 B/frame`) before → **`96,000 B` (`1,920.00 B/frame`)** after (**13.5× reduction**) |

---

## 8. Browser 60-Second Verification Status (`NOT VERIFIED`) & Manual Procedure

### Status in this verification sandbox: `NOT VERIFIED`

A real-browser or headless Chromium 60-second run could **not** be executed in this sandbox:

- Neither `chromium`, `google-chrome`, `firefox`, nor cached Playwright/Puppeteer browser binaries exist in the container image.
- Sandbox network egress is restricted to `github.com`, `codeload.github.com`, `api.github.com`, `registry.npmjs.org`, `pypi.org`, and `files.pythonhosted.org`; TLS connections to `deb.debian.org:443` and `cdn.playwright.dev:443` terminate at handshake (`SSL_ERROR_SYSCALL`).
- Furthermore, headless software rasterization without a hardware-composited 60 Hz display would not prove real GPU frame pacing. No browser FPS figure is claimed here.

### Reproducible manual browser verification (60 seconds)

Run these steps on a developer workstation with MongoDB, Node.js, and a hardware-accelerated desktop browser (Chrome, Edge, Firefox, or Safari):

1. Start MongoDB, seed rooms, and start the server and Vite client:
   ```bash
   npm run seed
   ROOM_ADMIN_TOKEN="dev-secret-token" npm start
   # second terminal:
   npm run dev:client
   ```
2. Load a 200-obstacle room layout into `lobby` via `npm run room:save` (or `PUT /api/rooms/lobby/layout` with `x-room-admin-token: dev-secret-token`) and connect 20 moving simulated peers into `lobby`.
3. Open `http://localhost:5173/?perf=1`, join `lobby`, and hold `WASD` / arrow keys or click-to-walk while the 20 remote avatars move continuously.
4. Record the bottom-left `.perf-readout` line every `10` seconds for `60` seconds (`t = 10s, 20s, 30s, 40s, 50s, 60s`):
   - Expect `fps 60` (or display native refresh rate such as `120` / `144`), `frame p95 ~16.7–17.2 ms` on a `60 Hz` panel, `work p95 < 1.5 ms`, and `dropped 0` in steady state.
5. **Live layout invalidation check**: run `npm run room:save -- --room lobby --file server/layouts/valid-office.json` while watching `?perf=1`; verify the obstacle layout repaints immediately on `room:layout` with at most a single static rebuild and no sustained dropped frames.
6. **Monitor DPR & resize check**: drag the browser window from a `1x` display onto a `2x` Retina/HiDPI display and resize the window rapidly; verify crisp text/grid lines and smooth coalesced resizing.
7. **Hidden-tab check**: switch to another tab for `5` seconds while holding or releasing movement, then return; verify the avatar does not teleport across the room and `dropped` does not spike from the `5 s` background gap.
8. Open `http://localhost:5173/` (without `?perf=1`) and confirm the `.perf-readout` element is absent from the DOM.

---

## 9. Scope Boundary & Known Limitations

- **Client Canvas 2D only**: `server/`, `client/src/audio/`, WebRTC signaling/media, Socket.io payloads, and environment variables are completely untouched.
- **Plain Canvas 2D API**: Uses standard main-thread 2D contexts (`document.createElement('canvas')`); does not introduce WebGL, PixiJS/Three.js, TypeScript, or `OffscreenCanvas` worker threads.
- **Continuous rAF for smooth interpolation**: The loop does not skip frames via dirty flags when local input is idle because remote avatars interpolate exponentially (`1 - exp(-12 * dt)`) between `10 Hz` server updates; with static room blitting, idle/moving per-frame JS work is ~`3 µs`.
- **No viewport frustum culling for avatars**: Rooms draw the full `1920 × 1080` letterboxed floor simultaneously (there is no scrolling camera), and `60` avatars require `423` lightweight 2D calls (`~3.1 µs` JS).
- **4K `@ DPR 3` pixel budget trade-off**: On `3840 × 2160` viewports at `DPR 3`, `MAX_BACKING_PIXELS = 16_000_000` clamps `effectiveDpr` from `3.0` to `1.39` (`5333 × 3000`) to keep backing memory `<= 64 MB` per canvas and avoid WebKit/GPU blank-canvas failures above `16.7M` pixels.
