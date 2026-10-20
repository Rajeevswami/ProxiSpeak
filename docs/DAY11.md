# Week 3 — Day 11: Dynamic attenuation

Day 11 routes remote WebRTC audio through one shared Web Audio `AudioContext` and
one `GainNode` per peer. Avatar positions remain in the existing mutable world
ref: the local predicted position and remote rendered/interpolated positions
are read from the existing canvas animation frame. Audio updates are throttled
inside the mixer to at most 20 Hz; the read-only status overlay polls once per
second. No per-frame React state or extra animation loop was added.

## Gain curve

`client/src/audio/attenuation.js` exports pure `gainForDistance` and
`distanceBetween` helpers. The inner radius is 30 px. The outer radius comes
from `proximityRadiusPx` in the server's `joined` payload (`PROXIMITY_RADIUS_PX`;
100 px by default). Older servers without that field fall back to 100 px.
Between the radii, the smoothstep interpolation is
`1 - (3t² - 2t³)`, where `t = (distance - 30) / (outer - 30)`. Its slope is zero
at both ends, avoiding a sudden audible change.

For the default 100 px outer radius:

| Distance | Gain | Meaning |
| ---: | ---: | --- |
| 0 px | 100% | Full volume |
| 30 px | 100% | Inner boundary |
| 47.5 px | 84.375% | Smooth fade |
| 65 px | 50% | Midpoint |
| 82.5 px | 15.625% | Near silence |
| 100 px | 0% | Silent at the proximity radius |
| >100 px | 0% | Silent outside the radius |

## Audio chain and browser behavior

```text
remote MediaStream
    ├── muted hidden <audio autoplay playsinline> (kept attached for Chrome)
    └── MediaStreamAudioSourceNode -> GainNode -> AudioContext.destination
                                                ↑
                                target gain set from pixel distance
```

Chrome quirk: remote WebRTC streams can be silent through Web Audio unless the
same stream is also attached to an `HTMLMediaElement`. The hidden element stays
attached and muted; audible output comes only from the GainNode chain, so there
is no double playback. If Web Audio is unavailable, the element is unmuted and
plays at full volume, with one warning routed through the injected client
logger (by default a single `console.warn`); there is no new UI control.

The context is created/resumed synchronously from the Join click's user
activation. A suspended context is retried on the Join gesture and when the
page becomes visible again. Each peer's gain starts at zero; its source connects
to its gain immediately, but its gain connects to the destination only after
the first distance calculation. Changes use
`gain.setTargetAtTime(target, currentTime, 0.05)`.

## Two-window hearing test

1. Install the existing dependencies, start the project's local MongoDB, seed
   the rooms, then start the server and Vite client as described in the README
   Day 4 setup and [Day 9 audio test](../README.md#week-2--day-9-webrtc-audio).
2. Open two separate browser windows at the same client URL and join the same
   room using different names. Grant microphone permission, or choose
   **Listen only**; headphones are recommended to prevent feedback.
3. Wait for the WebRTC peer row in the status overlay. The overlay shows
   connection state, inbound bytes, avatar distance in px, and the calculated
   gain in percent (read-only, at most once per second).
4. Walk the avatars closer than 30 px: remote audio should be at full volume.
   Walk apart: volume should fade smoothly and reach silence exactly at the
   configured radius. Walk closer again: volume should return smoothly. Compare
   the overlay's distance and volume while testing; the radius is provided by
   the server's `joined` payload.
5. To test without physical microphones in Chrome, launch each browser with a
   separate user-data directory and these fake media flags:

   ```sh
   google-chrome \
     --user-data-dir=/tmp/proxispeak-a \
     --use-fake-device-for-media-stream \
     --use-fake-ui-for-media-stream \
     http://localhost:5173
   ```

   Use `/tmp/proxispeak-b` for the second window. The optional
   `--autoplay-policy=no-user-gesture-required` flag is for isolating autoplay
   troubleshooting only; omit it for the normal Join-gesture check.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Inbound bytes climb but there is silence | The muted HTML element is intentional. Check that its `srcObject` is the remote stream, that a source and gain node exist, that `AudioContext.state` is `running`, and that the overlay shows a non-zero gain inside the radius. Confirm the first gain update connected the GainNode to the destination. |
| `AudioContext` is `suspended` | Join using the Join button (the user gesture calls `resume()`); switch back to the tab so the visibility handler can retry. Browser autoplay policy can still refuse playback until a user gesture. |
| No audio after the peer connects / autoplay blocked | Allow microphone permission (or join listen-only), click Join, verify the remote element remains attached and muted, and check the browser's autoplay/audio permission indicators. Do not unmute the element while the Web Audio chain is active, or audio will play twice. |
| Audio stays loud outside the expected radius | Verify `joined.proximityRadiusPx` matches server `PROXIMITY_RADIUS_PX`; the overlay uses rendered remote positions and the local predicted position. |

## Verification and scope

- Fresh installs: `npm run install:all` succeeded. Production bundle:
  `npm run build --prefix client` succeeded.
- Root `npm test`: server **80 passed / 0 failed / 32 skipped**; client
  **145 passed / 0 failed / 0 skipped**. The server suite skips MongoDB-backed
  integration cases because no local MongoDB is available; therefore the
  `joined.proximityRadiusPx` live integration assertion is NOT VERIFIED here.
  With local MongoDB, skipped must be 0.
- The Node tests prove the curve, target values, throttling, node lifecycle,
  muted-element path, and suspended-context handling. No Chromium/browser is
  installed here, so real GainNode values at 10, 50 and 90 px and audible
  two-window playback are NOT VERIFIED. No real output measurements are claimed.
- Stereo panning (`StereoPannerNode`/`PannerNode`), left/right ear logic, and
  obstacle occlusion belong to Week 4 and are not part of Day 11.
- Redis/Pub/Sub multi-instance scaling (Day 12), mesh optimization (Day 13),
  persistence, deployment, TURN and new libraries remain out of scope.
