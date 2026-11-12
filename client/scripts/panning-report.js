#!/usr/bin/env node
/**
 * Week 3 (Day 17) stereo panning: worked table, per-tick benchmark and heap check.
 *
 * Usage (heap check needs --expose-gc):
 *   node --expose-gc client/scripts/panning-report.js
 *
 * The benchmark drives the real `createAudioMixer().updateGains` with 8 peers
 * and 200 seeded obstacles (occlusion + gain + panning). Web Audio is replaced
 * by a counting fake, so the numbers are the JavaScript cost of one tick, not
 * audio-render cost. Nothing here plays sound.
 */
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { distanceBetween, gainForDistance } from '../src/audio/attenuation.js';
import { createAudioMixer } from '../src/audio/audioMixer.js';
import { MAX_PAN, PAN_INNER_PX, PAN_TIME_CONSTANT, formatPeerPan, panForPositions } from '../src/audio/panning.js';

const LISTENER = Object.freeze({ x: 0, y: 0 });

/** The worked-table cases; the same values are asserted in audio.panning.test.js. */
export const WORKED_CASES = Object.freeze([
  { name: 'right, near (inside inner radius)', dx: 10, dy: 0 },
  { name: 'right, at inner radius', dx: 30, dy: 0 },
  { name: 'right, far (dy = 0)', dx: 70, dy: 0 },
  { name: 'left, far (dy = 0)', dx: -70, dy: 0 },
  { name: 'directly below (dx = 0)', dx: 0, dy: 70 },
  { name: 'diagonal down-right, far', dx: 70, dy: 70 },
  { name: 'diagonal down-right, inner', dx: 20, dy: 20 },
  { name: 'same position', dx: 0, dy: 0 },
]);

export function computeWorkedTable() {
  return WORKED_CASES.map(({ name, dx, dy }) => {
    const speaker = { x: LISTENER.x + dx, y: LISTENER.y + dy };
    const distancePx = distanceBetween(LISTENER, speaker);
    const pan = panForPositions(LISTENER, speaker);
    return {
      name,
      dx,
      dy,
      distancePx: Number(distancePx.toFixed(2)),
      pan: Number(pan.toFixed(5)),
      overlay: formatPeerPan(pan),
      gainNoObstacles: Number(gainForDistance(distancePx, { innerPx: 30, outerPx: 100 }).toFixed(5)),
    };
  });
}

function makePrng(seed = 20261028) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function nearestRank(sorted, percentile) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function summarizeUs(samplesMs) {
  const sorted = Float64Array.from(samplesMs).sort();
  return {
    samples: sorted.length,
    p50Us: Number((nearestRank(sorted, 50) * 1000).toFixed(2)),
    p95Us: Number((nearestRank(sorted, 95) * 1000).toFixed(2)),
    maxUs: Number((sorted[sorted.length - 1] * 1000).toFixed(2)),
  };
}

/** 200 seeded blocking rectangles over a 1920x1080 room (same generator family as occlusion-bench). */
function makeObstacles(count = 200) {
  const rand = makePrng();
  return Array.from({ length: count }, (_, i) => ({
    id: `obs-${i}`,
    type: 'wall',
    x: Math.floor(rand() * 1840),
    y: Math.floor(rand() * 1000),
    w: 16 + Math.floor(rand() * 60),
    h: 16 + Math.floor(rand() * 60),
    blocksAudio: true,
    attenuation: 0.12 + (i % 7) * 0.1,
  }));
}

/**
 * Counting fake of the Web Audio surface the mixer touches. Allocation-free
 * on purpose so the benchmark measures the mixer, not the fake.
 */
function makeCountingContextClass(counters) {
  const noop = () => {};
  const node = () => ({ connect: noop, disconnect: noop });
  return class CountingContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    createMediaStreamSource() { return node(); }
    createStereoPanner() {
      return {
        connect: noop,
        disconnect: noop,
        pan: {
          setValueAtTime: noop,
          setTargetAtTime() { counters.panWrites += 1; },
        },
      };
    }
    createGain() {
      return {
        connect: noop,
        disconnect: noop,
        gain: {
          value: 0,
          setTargetAtTime() { counters.gainWrites += 1; },
        },
      };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
}

/**
 * Build a mixer with 8 attached peers and a preallocated room. Returns the
 * tick function that advances the clock 50 ms and runs one updateGains.
 */
function makeBenchHarness() {
  const counters = { panWrites: 0, gainWrites: 0 };
  let clock = 0;
  const mixer = createAudioMixer({
    AudioContextFactory: makeCountingContextClass(counters),
    document: null,
    logger: { warn() {} },
    now: () => clock,
  });
  const peerIds = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
  // Positions are preallocated and reused, as the app reuses world.users entries.
  const positions = new Map();
  const rand = makePrng(7);
  for (const id of peerIds) {
    const angle = rand() * Math.PI * 2;
    const dist = 40 + rand() * 90;
    positions.set(id, { x: LISTENER.x + Math.cos(angle) * dist, y: LISTENER.y + Math.sin(angle) * dist });
  }
  const local = { x: LISTENER.x, y: LISTENER.y };
  const getRemotePos = (id) => positions.get(id) ?? null;
  const room = { roomId: 'bench', layoutRevision: 1, obstacles: makeObstacles(200) };
  for (const id of peerIds) mixer.attach(id, { id }, { muted: false, srcObject: null });
  const tick = () => {
    clock += 50;
    return mixer.updateGains(local, getRemotePos, peerIds, room);
  };
  return { mixer, tick, counters, local, positions, peerIds };
}

/** Per-tick timings for the full mixer (occlusion + gain + pan), 8 peers x 200 obstacles. */
export function runFullTickBenchmark({ warmup = 1000, samples = 5000 } = {}) {
  const h = makeBenchHarness();
  for (let i = 0; i < warmup; i += 1) h.tick();
  const timings = new Float64Array(samples);
  let accepted = 0;
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    if (h.tick()) accepted += 1;
    timings[i] = performance.now() - start;
  }
  return { ...summarizeUs(timings), acceptedTicks: accepted, panWrites: h.counters.panWrites, gainWrites: h.counters.gainWrites };
}

/** Panning alone: 8 pan computations per tick, to separate the pan cost from occlusion. */
export function runPanOnlyBenchmark({ warmup = 1000, samples = 5000 } = {}) {
  const h = makeBenchHarness();
  const speakers = h.peerIds.map((id) => h.positions.get(id));
  let sink = 0;
  for (let i = 0; i < warmup; i += 1) for (let p = 0; p < speakers.length; p += 1) sink += panForPositions(h.local, speakers[p]);
  const timings = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    for (let p = 0; p < speakers.length; p += 1) sink += panForPositions(h.local, speakers[p]);
    timings[i] = performance.now() - start;
  }
  return { ...summarizeUs(timings), sinkGuard: sink !== 0 };
}

/**
 * Heap growth across many ticks. Forces GC before each reading. Measures
 * retained heap, not transient garbage, so it shows leaks, not per-tick churn.
 */
export function runHeapCheck({ ticks = 50000, warmup = 1000 } = {}) {
  if (typeof globalThis.gc !== 'function') {
    return { measured: false, reason: 'run with node --expose-gc' };
  }
  const h = makeBenchHarness();
  for (let i = 0; i < warmup; i += 1) h.tick();
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < ticks; i += 1) h.tick();
  globalThis.gc();
  globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  return {
    measured: true,
    ticks,
    heapBeforeBytes: before,
    heapAfterBytes: after,
    deltaBytes: after - before,
    deltaBytesPerTick: Number(((after - before) / ticks).toFixed(4)),
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out('=== Week 3 (Day 17) Stereo panning: worked table (listener at 0,0; screen axes; x grows right) ===');
  out(`MAX_PAN=${MAX_PAN}  PAN_INNER_PX=${PAN_INNER_PX}  PAN_TIME_CONSTANT=${PAN_TIME_CONSTANT}s`);
  out('case                                 dx      dy     dist(px)  pan       overlay      gain(d, no walls)');
  for (const row of computeWorkedTable()) {
    out(
      `${row.name.padEnd(36)} ${String(row.dx).padStart(5)}  ${String(row.dy).padStart(5)}  ${row.distancePx.toFixed(2).padStart(9)}  ${row.pan.toFixed(5).padStart(9)}  ${row.overlay.padEnd(11)}  ${row.gainNoObstacles.toFixed(5)}`,
    );
  }
  out('');
  out(`Node ${process.version} on ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model ?? 'unknown CPU'}`);
  out('=== Benchmark: 8 peers x 200 obstacles per tick (Web Audio replaced by a counting fake) ===');
  const full = runFullTickBenchmark();
  const panOnly = runPanOnlyBenchmark();
  out(`Full updateGains tick (occlusion + gain + pan), ${full.samples} ticks: p50=${full.p50Us} us, p95=${full.p95Us} us, max=${full.maxUs} us`);
  out(`  accepted ticks=${full.acceptedTicks}, pan writes=${full.panWrites}, gain writes=${full.gainWrites}`);
  out(`Pan only (8 panForPositions per tick), ${panOnly.samples} ticks: p50=${panOnly.p50Us} us, p95=${panOnly.p95Us} us, max=${panOnly.maxUs} us`);
  out('=== Heap check (retained heap after forced GC) ===');
  const heap = runHeapCheck();
  if (heap.measured) {
    out(`${heap.ticks} ticks: heapUsed before=${heap.heapBeforeBytes} B, after=${heap.heapAfterBytes} B, delta=${heap.deltaBytes} B (${heap.deltaBytesPerTick} B/tick)`);
  } else {
    out(`heap check NOT MEASURED: ${heap.reason}`);
  }
}
