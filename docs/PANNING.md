# Week 3 (Day 17) — Stereo Panning in the Audio Mixer

Week 3 (Day 17) adds left/right stereo panning to each remote peer's audio. The mixer now places each peer's voice on the side of the screen where that avatar is, by a pure pan law computed from the two 2D positions. It is client-only: no server file, no protocol message and no environment variable changed.

Company plan item: "Refine & Polish: Add 3D audio panning (left/right ear stereo separation)" (plan Week 4). This was delivered in calendar Week 3 (Day 17). See `docs/REQUIREMENTS_TRACE.md`.

---

## 1. Scope Statement (what this is and is not)

The company text says "3D panning (left/right ear stereo separation)". What is implemented is **left/right stereo panning from the relative position on the 2D map**. Specifically:

* **Implemented:** a `StereoPannerNode` per remote peer whose `pan` value (in `[-0.85, 0.85]`) comes from `dx = speaker.x - listener.x` on the top-down map.
* **Not implemented:** HRTF binaural rendering, `PannerNode` 3D spatialization, elevation (no height axis), head orientation (avatar facing is not in the protocol and is not used), room reverb, low-pass filtering, or any server-side audio.

Gain and panning are independent. Distance attenuation and obstacle transmission (`docs/OCCLUSION.md`) still set how loud a peer is. Panning sets which side the voice comes from.

---

## 2. Semantics

1. **Screen axes.** The map is a top-down 2D view with fixed screen axes. A speaker to the **right** of the listener on screen (larger `x`) is heard in the **right** ear. A speaker to the **left** (smaller `x`) is heard in the **left** ear.
2. **Orientation is not used.** Avatar facing is not part of the protocol, so it does not change the pan. Turning an avatar around does nothing to the stereo image.
3. **Centred.** A speaker directly above or below the listener (same `x`, different `y`) is centred. So is a speaker at the same position.
4. **Independent of occlusion.** A blocked speaker is quieter (lower gain) but keeps the same pan sign and value. Walls change loudness, not side.

### The map (listener in the centre)

```
                 smaller y (top of screen)
          +-----------------------------------------+
          |                                         |
          |              C (dx 0, dy -70)           |
          |              pan C                      |
          |                                         |
          |   B (dx -70, dy 0)      (me)     D (dx 70, dy 0)
          |   pan L 100%            +        pan R 100%
          |   ear: LEFT    <--------+--------> ear: RIGHT
          |                                         |
          |              A (dx 0, dy 70)            |
          |              pan C                      |
          |                                         |
          +-----------------------------------------+
                 larger y (bottom of screen)

   x grows to the right, y grows downward (canvas convention).
   Facing is ignored: the same speaker gives the same pan whatever the avatar is pointing at.
```

---

## 3. The Pan Law

Named constants live in `client/src/audio/panning.js`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_PAN` | `0.85` | Largest pan magnitude. Never `1`, so a voice is never hard-panned into one ear only. |
| `PAN_INNER_PX` | `30` | Distance below which the slope is held constant. |
| `PAN_TIME_CONSTANT` | `0.05` s | Glide time for pan changes after the first connection. |

With `dx = speaker.x - listener.x`, `dy = speaker.y - listener.y` and `dist = hypot(dx, dy)`:

```
pan = MAX_PAN * dx / max(dist, PAN_INNER_PX)
```

Properties (all tested in `client/test/audio.panning.test.js`):

* **Continuous everywhere**, including at zero distance (`pan = 0`) and across `dist = PAN_INNER_PX`.
* **Antisymmetric**: mirroring `x` negates the pan, and swapping listener and speaker negates it.
* **Bounded** in `[-0.85, 0.85]`. Each step is continuous: on the test sweeps (0.01 px steps through zero distance and across `PAN_INNER_PX`), the largest change between adjacent samples was `0.000283` in a one-off run of the same sweeps (the test asserts `< 0.001`).
* **No dead zone.** Any horizontal offset moves the pan.
* **Translation invariant.**
* **Sign equals the sign of `dx`.**
* **Invalid input** (missing position, `NaN`, `Infinity`, non-number) returns `0` and never throws.

**Why `PAN_INNER_PX = 30`?** Without it, two avatars that overlap (`dist` near 0) would give `dx / dist` as a ratio of two tiny numbers, which jumps around. Clamping the denominator at 30 px keeps the slope finite and continuous. The value matches the inner radius of distance attenuation (30 px), but `attenuation.js` does not export that constant and must stay untouched, so the number is repeated here on purpose.

**Why `MAX_PAN = 0.85`?** A full `±1` would put the voice in one ear only. `0.85` keeps the far side audible in both ears while still giving a clear left/right image.

---

## 4. Worked Table (numbers produced by the code)

Output of `node --expose-gc client/scripts/panning-report.js` (listener at `(0, 0)`; gain column uses the distance curve with no walls):

```
case                                 dx      dy     dist(px)  pan       overlay      gain(d, no walls)
right, near (inside inner radius)       10      0      10.00    0.28333  pan R 33%    1.00000
right, at inner radius                  30      0      30.00    0.85000  pan R 100%   1.00000
right, far (dy = 0)                     70      0      70.00    0.85000  pan R 100%   0.39359
left, far (dy = 0)                     -70      0      70.00   -0.85000  pan L 100%   0.39359
directly below (dx = 0)                  0     70      70.00    0.00000  pan C        0.39359
diagonal down-right, far                70     70      98.99    0.60104  pan R 71%    0.00061
diagonal down-right, inner              20     20      28.28    0.56667  pan R 67%    1.00000
same position                            0      0       0.00    0.00000  pan C        1.00000
```

Notes:

* `dx = 10` gives `0.85 * 10 / 30 = 0.28333`, because the denominator is held at `PAN_INNER_PX`.
* `dx = 70, dy = 70` gives `0.85 * 70 / hypot(70, 70) = 0.6010408`. The test asserts `0.60104`. The earlier planning note listed `0.60098`, which does not match the formula (it is 6.4e-5 away, outside the `1e-5` tolerance); the formula was kept and the expected value corrected to what it produces.
* The overlay strength is a percentage of `MAX_PAN`, so `pan R 100%` means the largest pan the law can give, not a fully silent ear.
* `gain(d)` at 70 px is `0.39359`, and the same speaker behind `wall-core` is about `0.04723` (see `docs/OCCLUSION.md`). Panning is the same either way.

---

## 5. Smoothing Constant and Why

* **First connection.** The pan is set with `pan.setValueAtTime(pan, currentTime)`. The peer appears on its correct side straight away, with no sweep from the centre.
* **Later updates.** `pan.setTargetAtTime(target, currentTime, PAN_TIME_CONSTANT)` with `PAN_TIME_CONSTANT = 0.05` s. The mixer never writes `pan.value` directly after the first connection.
* **Why 0.05 s.** It matches the gain smoothing (`TARGET_TIME_CONSTANT = 0.05` s in `audioMixer.js`), so pan and loudness move together as an avatar walks. It is fast enough to follow a walking avatar (updates arrive at most 20 Hz, every 50 ms) and slow enough that a sudden jump of the target cannot be heard as a click.
* **Occlusion changes** keep their own `0.08` s constant for gain, as before. Pan is not smoothed differently when an obstacle appears.

---

## 6. Per-Peer Audio Chain

```
                 accepted tick, at most 20 Hz (existing 50 ms gate)
                                  |
                                  v
  MediaStreamAudioSourceNode --> StereoPannerNode --> GainNode --> AudioContext.destination
  (remote WebRTC track)          pan: setValueAtTime    gain: 0 until first update,
                                 then setTargetAtTime   then setTargetAtTime (distance x occlusion)
                                 (PAN_TIME_CONSTANT)    (TARGET or OCCLUSION time constant)

  No createStereoPanner in the browser (very old):
  MediaStreamAudioSourceNode --> GainNode --> destination   (one warning, nothing throws)

  Web Audio unavailable:
  <audio> element, full volume (existing fallback, no panner, overlay shows "pan n/a")
```

Other rules (unchanged from the existing mixer):

* One shared `AudioContext`.
* The muted hidden `<audio>` element stays attached (Chrome WebRTC quirk).
* The gain connects to the destination only after the first computed value, so a new peer starts silent.
* An unknown remote position gives gain `0` and pan `0`.
* `remove`, `closeAll` and the failed-setup rollback disconnect the source, panner and gain nodes.

**Mono and stereo input.** WebRTC remote audio is usually mono. The Web Audio spec pans a mono input with the equal-power law (`x = (pan + 1) / 2`, left gain `cos(x·π/2)`, right gain `sin(x·π/2)`), so a centred mono voice reaches each ear at about 0.707 of its level (-3 dB). A stereo input uses the spec's separate stereo-to-stereo rule (balance-like), so it is not summed to mono first. The mixer does not need to know which kind it gets, so both work with the same chain. The audible level of each case was not measured here (no audio rendering in this sandbox).

---

## 7. Overlay

Each peer row in the status overlay now shows the side and the strength, e.g. `pan R 62%`, `pan L 40%`, or `pan C` when centred. The text is produced by `formatPeerPan` from the mixer's last applied pan. It refreshes with the existing once-per-second overlay poll. There are no new controls and no per-frame React state. With no panner in the browser the row shows `pan n/a`.

---

## 8. Measured Performance

Measured with `node --expose-gc client/scripts/panning-report.js` on the sandbox (Node v22.22.3, Linux x64, Intel Xeon @ 2.60 GHz, a shared VM so timings are noisy). The benchmark drives the real `createAudioMixer().updateGains` with **8 peers and 200 seeded obstacles** in a 1920×1080 room. Web Audio is replaced by a counting fake, so these numbers are the JavaScript cost of one tick, **not** audio-render cost.

```
Full updateGains tick (occlusion + gain + pan), 5000 ticks: p50=12.87 us, p95=15.07 us, max=1175 us
  accepted ticks=5000, pan writes=47992, gain writes=48000
Pan only (8 panForPositions per tick), 5000 ticks: p50=0.57 us, p95=0.8 us, max=348.59 us
50000 ticks: heapUsed before=4719920 B, after=4658568 B, delta=-61352 B (-1.227 B/tick)
```

* **Panning cost** is about `0.6 µs` per tick for 8 peers (p50). Occlusion and gain dominate.
* **Pan writes** are `47,992` = 8 peers × 6,000 accepted ticks minus the 8 first-connection `setValueAtTime` calls. **Gain writes** are `48,000` = 8 × 6,000.
* **Before/after comparison.** The same benchmark on the pre-panning tree (`112ff8c`, extracted to a temp directory) gave full-tick `p50 = 17.21 µs` and `p50 = 11.06 µs` on two runs. Runs with panning gave `11.83 µs` and `10.85 µs` (p50). The spread between runs is larger than any difference, so **no measurable overhead** was detected.
* **Heap.** Over 50,000 ticks after forced GC (`--expose-gc`), retained heap changed by `-61,352 B` (`-1.2 B/tick`). That is no growth. It measures retained heap only, not transient garbage per tick, so the "no per-tick allocation" claim rests on the code path (plain arithmetic on the two positions; the obstacle cache is reused) rather than on a separate allocation profiler.
* **Max values** (e.g. `1175 µs`) are single outliers from OS or GC scheduling on a shared VM. The p50/p95 figures are the ones to compare.

The 60 FPS rendering work is a separate later task and was not measured here.

---

## 9. Manual Test (two windows, headphones)

> **Status in this sandbox: NOT VERIFIED.** No browser or audio output is installed, so nobody has heard the result here. The steps below are for a workstation.

1. Start the server and client as in `README.md` (MongoDB seeded with `npm run seed`). Open `http://localhost:5173` in **two windows** and join `lobby` as two users.
2. Use **headphones**. A laptop speaker gives weak separation (see Section 10).
3. Put avatar A on the left and avatar B on the right, about 60 px apart on the same row. From A, B's voice should come from the **right**. From B, A's voice should come from the **left**. The overlay should read `pan R …` / `pan L …` on the matching rows.
4. Move B straight above A (same `x`). The voice should centre. The overlay reads `pan C`.
5. Walk B in a circle around A. The voice should move smoothly across the head with **no clicks**. The overlay side flips as B crosses above or below A.
6. To hear a tone instead of a voice, start Chrome with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (see `docs/DAY11.md`). The fake microphone produces a beep, which makes the left/right position easy to hear.
7. Optional: stand B behind `wall-core` (`docs/OCCLUSION.md`). B should be quieter but still come from its own side.

Expected result (to be checked by a human): the side of the voice matches the side of the avatar on screen, pan changes are continuous, and there are no clicks.

---

## 10. Honest Limitations

* **No head orientation.** Facing is not in the protocol and is ignored. Turning does not change the pan.
* **No HRTF, no elevation, no reverb.** This is stereo left/right, not binaural 3D. Speakers above or below the listener are centred (`pan C`), not moved up or down.
* **Top-down 2D only.** The map has no height axis.
* **Laptop speakers give weak separation.** Stereo separation needs headphones (or a proper stereo setup) to be heard.
* **Mono sources.** WebRTC voice is usually mono, so the stereo image comes from the panner's equal-power law, not from separate recorded channels.
* **Not audibly verified here.** The maths, chain, cleanup and throttling are proven in Node tests. Whether the voice audibly moves to the correct ear needs the manual test above.
* **Pan is set from the mixer's tick.** It follows the 20 Hz update cadence, so very fast movement is smoothed at 50 ms steps, not every frame.
* **Old browsers** without `createStereoPanner` get centred audio and one warning.
