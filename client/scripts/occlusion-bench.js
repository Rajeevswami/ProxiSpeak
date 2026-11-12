#!/usr/bin/env node
/**
 * Reproducible worked-example table and 8-peers x 200-obstacles microbenchmark
 * for Week 3 (Day 16) client audio occlusion.
 *
 * Usage:
 *   node client/scripts/occlusion-bench.js
 */
import process from 'node:process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { distanceBetween, gainForDistance } from '../src/audio/attenuation.js';
import {
  derivePeerVolume,
  prepareObstacles,
  segmentIntersectsRect,
  transmissionBetween,
} from '../src/audio/occlusion.js';
import { createAudioMixer } from '../src/audio/audioMixer.js';

/** Exact seeded 1920x1080 lobby obstacles from server/src/services/roomService.js. */
export const SEEDED_LOBBY_OBSTACLES = Object.freeze([
  { id: 'wall-core', type: 'wall', x: 940, y: 390, w: 40, h: 300, blocksAudio: true, attenuation: 0.12 },
  { id: 'screen-1', type: 'screen', x: 345.6, y: 237.6, w: 180, h: 14, blocksAudio: true, attenuation: 0.45 },
  { id: 'screen-2', type: 'screen', x: 345.6, y: 594, w: 180, h: 14, blocksAudio: true, attenuation: 0.45 },
  { id: 'desk-a', type: 'desk', x: 1305.6, y: 216, w: 150, h: 70, blocksAudio: true, attenuation: 0.5 },
  { id: 'desk-b', type: 'desk', x: 1305.6, y: 345.6, w: 150, h: 70, blocksAudio: true, attenuation: 0.5 },
  { id: 'desk-c', type: 'desk', x: 422.4, y: 777.6, w: 200, h: 60, blocksAudio: true, attenuation: 0.5 },
  { id: 'pillar-1', type: 'pillar', x: 864, y: 216, w: 34, h: 34, blocksAudio: true, attenuation: 0.25 },
  { id: 'pillar-2', type: 'pillar', x: 1152, y: 734.4, w: 34, h: 34, blocksAudio: true, attenuation: 0.25 },
  { id: 'plant-1', type: 'plant', x: 1632, y: 712.8, w: 26, h: 26, blocksAudio: true, attenuation: 0.65 },
  { id: 'plant-2', type: 'plant', x: 153.6, y: 453.6, w: 26, h: 26, blocksAudio: true, attenuation: 0.65 },
]);

export function computeWorkedTable() {
  const prepared = prepareObstacles(SEEDED_LOBBY_OBSTACLES);
  const cases = [
    {
      scenario: 'Open floor (same side of wall-core)',
      obstacle: 'none',
      listener: { x: 850, y: 540 },
      speaker: { x: 920, y: 540 },
    },
    {
      scenario: 'Across wall-core (x=940,y=390,w=40,h=300)',
      obstacle: 'wall (0.12)',
      listener: { x: 925, y: 540 },
      speaker: { x: 995, y: 540 },
    },
    {
      scenario: 'Across wall-core at 73 px (overlay 4% example)',
      obstacle: 'wall (0.12)',
      listener: { x: 923, y: 540 },
      speaker: { x: 996, y: 540 },
    },
    {
      scenario: 'Across screen-1 (x=345.6,y=237.6,w=180,h=14)',
      obstacle: 'screen (0.45)',
      listener: { x: 435.6, y: 210 },
      speaker: { x: 435.6, y: 280 },
    },
    {
      scenario: 'Across desk-c (x=422.4,y=777.6,w=200,h=60)',
      obstacle: 'desk (0.50)',
      listener: { x: 522.4, y: 772.6 },
      speaker: { x: 522.4, y: 842.6 },
    },
    {
      scenario: 'Across pillar-1 (x=864,y=216,w=34,h=34)',
      obstacle: 'pillar (0.25)',
      listener: { x: 846, y: 233 },
      speaker: { x: 916, y: 233 },
    },
    {
      scenario: 'Across plant-1 (x=1632,y=712.8,w=26,h=26)',
      obstacle: 'plant (0.65)',
      listener: { x: 1610, y: 725.8 },
      speaker: { x: 1680, y: 725.8 },
    },
    {
      scenario: 'Speaker inside desk-a at 25 px (inner radius)',
      obstacle: 'desk (0.50)',
      listener: { x: 1295, y: 250 },
      speaker: { x: 1320, y: 250 },
    },
  ];

  return cases.map((entry) => {
    const distancePx = distanceBetween(entry.listener, entry.speaker);
    const distanceGain = gainForDistance(distancePx);
    const transmission = transmissionBetween(entry.listener, entry.speaker, prepared);
    const targetGain = distanceGain * transmission;
    const overlay = derivePeerVolume(entry.listener, entry.speaker, prepared);
    return {
      scenario: entry.scenario,
      obstacle: entry.obstacle,
      listener: `(${entry.listener.x}, ${entry.listener.y})`,
      speaker: `(${entry.speaker.x}, ${entry.speaker.y})`,
      distancePx: Number(distancePx.toFixed(2)),
      distanceGain: Number(distanceGain.toFixed(5)),
      transmission: Number(transmission.toFixed(4)),
      targetGain: Number(targetGain.toFixed(5)),
      overlayText: overlay.text,
    };
  });
}

function makePrng(seed = 20261027) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function nearestRankPercentile(sorted, percentile) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index];
}

function summarizeUs(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Us: Number((nearestRankPercentile(sorted, 50) * 1000).toFixed(2)),
    p95Us: Number((nearestRankPercentile(sorted, 95) * 1000).toFixed(2)),
    maxUs: Number((sorted[sorted.length - 1] * 1000).toFixed(2)),
    p50Ms: Number(nearestRankPercentile(sorted, 50).toFixed(4)),
    p95Ms: Number(nearestRankPercentile(sorted, 95).toFixed(4)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
  };
}

export async function runOcclusionBenchmark({ iterations = 5000, warmup = 1000 } = {}) {
  const rand = makePrng(20261027);
  const listener = { x: 960, y: 540 };
  const peers = Array.from({ length: 8 }, (_, idx) => {
    const angle = (idx / 8) * Math.PI * 2 + 0.2;
    const dist = 40 + (idx % 4) * 14;
    return {
      id: `peer-${idx}`,
      x: listener.x + Math.cos(angle) * dist,
      y: listener.y + Math.sin(angle) * dist,
    };
  });

  // 1. Spread 200 obstacles across 1920x1080 room (realistic layout: most rejected by AABB).
  const spreadRaw = Array.from({ length: 200 }, (_, i) => ({
    id: `spread-${i}`,
    type: 'wall',
    x: Math.floor(rand() * 1840),
    y: Math.floor(rand() * 1000),
    w: 16 + Math.floor(rand() * 60),
    h: 16 + Math.floor(rand() * 60),
    blocksAudio: true,
    attenuation: 0.12 + (i % 7) * 0.1,
  }));
  const spreadPrepared = prepareObstacles(spreadRaw);

  // Count exact AABB rejections vs exact Liang-Barsky evaluations in spread layout.
  let totalChecks = 0;
  let aabbRejected = 0;
  let intersectedCount = 0;
  for (const peer of peers) {
    const segMinX = Math.min(listener.x, peer.x);
    const segMaxX = Math.max(listener.x, peer.x);
    const segMinY = Math.min(listener.y, peer.y);
    const segMaxY = Math.max(listener.y, peer.y);
    for (let i = 0; i < spreadPrepared.length; i += 1) {
      totalChecks += 1;
      const obs = spreadPrepared[i];
      if (segMaxX < obs.x || segMinX > obs.maxX || segMaxY < obs.y || segMinY > obs.maxY) {
        aabbRejected += 1;
      } else if (segmentIntersectsRect(listener.x, listener.y, peer.x, peer.y, obs)) {
        intersectedCount += 1;
      }
    }
  }

  // 2. Worst-case dense cluster: 200 thin obstacles all overlapping the listener neighborhood
  //    so AABB rarely rejects and Liang-Barsky runs on almost every pair.
  const denseRaw = Array.from({ length: 200 }, (_, i) => ({
    id: `dense-${i}`,
    type: 'screen',
    x: listener.x - 45 + (i % 10) * 2,
    y: listener.y - 45 + Math.floor(i / 10) * 2,
    w: 80,
    h: 80,
    blocksAudio: true,
    attenuation: 0.99,
  }));
  const densePrepared = prepareObstacles(denseRaw);

  let sink = 0;
  for (let w = 0; w < warmup; w += 1) {
    for (let p = 0; p < peers.length; p += 1) {
      sink += transmissionBetween(listener, peers[p], spreadPrepared);
      sink += transmissionBetween(listener, peers[p], densePrepared);
    }
  }

  const spreadSamples = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    const t0 = performance.now();
    for (let p = 0; p < peers.length; p += 1) {
      sink += transmissionBetween(listener, peers[p], spreadPrepared);
    }
    spreadSamples[it] = performance.now() - t0;
  }

  const denseSamples = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    const t0 = performance.now();
    for (let p = 0; p < peers.length; p += 1) {
      sink += transmissionBetween(listener, peers[p], densePrepared);
    }
    denseSamples[it] = performance.now() - t0;
  }

  // 3. Full audioMixer.updateGains tick (8 peers x 200 spread obstacles, cached revision).
  let clock = 0;
  class BenchAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 1;
      this.destination = {};
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() {
      return {
        gain: { value: 0, setTargetAtTime() {} },
        connect() {},
        disconnect() {},
      };
    }
    async resume() {}
    async close() {}
  }
  const mixer = createAudioMixer({
    AudioContextFactory: BenchAudioContext,
    document: null,
    now: () => clock,
  });
  await mixer.resume();
  const peerMap = new Map();
  for (const peer of peers) {
    peerMap.set(peer.id, peer);
    mixer.attach(peer.id, { id: peer.id }, { muted: false, pause() {}, remove() {} });
  }
  const room = { roomId: 'lobby', layoutRevision: 1, obstacles: spreadRaw };
  const getRemotePos = (id) => peerMap.get(id) ?? null;

  for (let w = 0; w < warmup; w += 1) {
    clock += 50;
    mixer.updateGains(listener, getRemotePos, null, room);
  }
  const mixerSamples = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    clock += 50;
    const t0 = performance.now();
    mixer.updateGains(listener, getRemotePos, null, room);
    mixerSamples[it] = performance.now() - t0;
  }
  const cacheStats = mixer.obstacleCacheStats();
  await mixer.closeAll();

  return {
    sinkGuard: sink !== 0,
    peers: peers.length,
    obstacles: spreadPrepared.length,
    checksPerTick: totalChecks,
    aabbRejected,
    aabbRejectedPercent: Number(((aabbRejected / totalChecks) * 100).toFixed(2)),
    intersectedCount,
    prepareCountAcrossTicks: cacheStats.prepareCount,
    spreadTransmissionOnly: summarizeUs(spreadSamples),
    denseWorstCaseTransmissionOnly: summarizeUs(denseSamples),
    fullMixerTickSpread: summarizeUs(mixerSamples),
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const table = computeWorkedTable();
  const bench = await runOcclusionBenchmark();
  process.stdout.write('=== Week 3 (Day 16) Worked Occlusion Table (Seeded 1920x1080 Lobby) ===\n');
  for (const row of table) {
    process.stdout.write(
      `${row.scenario.padEnd(46)} | d=${String(row.distancePx).padStart(5)}px | gain(d)=${row.distanceGain.toFixed(5)} | T=${row.transmission.toFixed(2)} | final=${row.targetGain.toFixed(5)} | ${row.overlayText}\n`,
    );
  }
  process.stdout.write('\n=== Week 3 (Day 16) Benchmark: 8 Peers x 200 Obstacles per Tick ===\n');
  process.stdout.write(
    `Checks/tick: ${bench.checksPerTick} (${bench.peers} peers x ${bench.obstacles} obstacles), AABB rejected: ${bench.aabbRejected}/${bench.checksPerTick} (${bench.aabbRejectedPercent}%), intersected: ${bench.intersectedCount}, prepareObstacles runs across ${1000 + bench.fullMixerTickSpread.samples} ticks: ${bench.prepareCountAcrossTicks}\n`,
  );
  process.stdout.write(
    `Spread room (AABB-rejected majority)   : p50=${bench.spreadTransmissionOnly.p50Us} us (${bench.spreadTransmissionOnly.p50Ms} ms), p95=${bench.spreadTransmissionOnly.p95Us} us (${bench.spreadTransmissionOnly.p95Ms} ms), max=${bench.spreadTransmissionOnly.maxUs} us (${bench.spreadTransmissionOnly.maxMs} ms)\n`,
  );
  process.stdout.write(
    `Dense overlap (all pass AABB pre-check): p50=${bench.denseWorstCaseTransmissionOnly.p50Us} us (${bench.denseWorstCaseTransmissionOnly.p50Ms} ms), p95=${bench.denseWorstCaseTransmissionOnly.p95Us} us (${bench.denseWorstCaseTransmissionOnly.p95Ms} ms), max=${bench.denseWorstCaseTransmissionOnly.maxUs} us (${bench.denseWorstCaseTransmissionOnly.maxMs} ms)\n`,
  );
  process.stdout.write(
    `Full audioMixer.updateGains tick       : p50=${bench.fullMixerTickSpread.p50Us} us (${bench.fullMixerTickSpread.p50Ms} ms), p95=${bench.fullMixerTickSpread.p95Us} us (${bench.fullMixerTickSpread.p95Ms} ms), max=${bench.fullMixerTickSpread.maxUs} us (${bench.fullMixerTickSpread.maxMs} ms)\n`,
  );
}
