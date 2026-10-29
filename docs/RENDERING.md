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
