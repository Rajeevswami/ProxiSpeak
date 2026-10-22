import { useEffect, useState } from 'react';

/**
 * Audio connection status overlay (Day 9) — the visible proof for the
 * Mid-Project Review "Audio Check".
 *
 * Read-only and deliberately dumb: plain DOM in a fixed panel, no library.
 * It polls the peer manager's snapshot at most once per second (and only
 * re-renders when the values actually changed), so it can never cause the
 * per-event re-render storms the world canvas avoids. Rows show what proves a
 * WebRTC audio connection is alive: the connection state and the inbound
 * audio bytes received from each nearby peer.
 *
 * Mic line: on / off / listen-only, with the failure notice when there is one.
 */

const MIC_LABEL = {
  on: 'mic on',
  off: 'mic off',
  'listen-only': 'listen only',
};

/** 1.2 KB, 84 KB, 1.1 MB — enough resolution to watch bytes climb. */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

import { countNearbyNotConnected } from '../realtime/meshIndicator.js';

export default function AudioStatus({ mic, getSnapshot, worldRef, maxPeers, radiusPx }) {
  const [rows, setRows] = useState([]);
  const [meshInfo, setMeshInfo] = useState({ connected: 0, nearbyNotConnected: 0 });

  useEffect(() => {
    const read = () => {
      const next = typeof getSnapshot === 'function' ? getSnapshot() ?? [] : [];
      const serialized = JSON.stringify(next);
      setRows((prev) => (JSON.stringify(prev) === serialized ? prev : next));

      // Mesh indicator: connected N / max and M nearby not connected (cap)
      // Positions stay out of React state (existing refs; overlay updates at most once per second as today).
      try {
        const world = worldRef?.current ?? null;
        const connected = next.length;
        const max = Number.isFinite(maxPeers) ? maxPeers : 8;
        const radius = Number.isFinite(radiusPx) ? radiusPx : 100;
        const connectedIds = new Set(next.map((r) => r.peerId));
        const nearbyNotConnected = world ? countNearbyNotConnected({ users: world.users, selfId: world.selfId, connectedIds, radiusPx: radius }) : 0;
        const nextInfo = { connected, max, nearbyNotConnected };
        setMeshInfo((prev) => (prev.connected === nextInfo.connected && prev.max === nextInfo.max && prev.nearbyNotConnected === nextInfo.nearbyNotConnected ? prev : nextInfo));
      } catch {
        /* ignore */
      }
    };
    read();
    const timer = setInterval(read, 1000); // at most once per second
    return () => clearInterval(timer);
  }, [getSnapshot, worldRef, maxPeers, radiusPx]);

  const maxLabel = meshInfo.max === 0 ? '∞' : String(meshInfo.max);

  return (
    <aside className="audio-status" role="status" aria-live="polite" aria-label="Audio connections">
      <div className="audio-status-mic">
        Audio · {MIC_LABEL[mic?.state] ?? 'listen only'}
        {mic?.notice ? <span className="audio-status-notice">{mic.notice}</span> : null}
      </div>
      <div className="audio-status-mesh">
        connected {meshInfo.connected} / {maxLabel}
        {meshInfo.nearbyNotConnected > 0 ? <span> · {meshInfo.nearbyNotConnected} nearby, not connected (cap)</span> : null}
      </div>
      {rows.length === 0 ? (
        <div className="audio-status-empty">no nearby peers yet</div>
      ) : (
        <ul className="audio-status-list">
          {rows.map((row) => (
            <li key={row.peerId}>
              <span className="peer-name">{row.name || row.peerId.slice(0, 6)}</span>
              <span className={`peer-state peer-state-${row.connectionState}`}>{row.connectionState}</span>
              <span className="peer-distance" title="distance from your avatar">
                {Number.isFinite(row.distancePx) ? `${Math.round(row.distancePx)} px` : 'distance unknown'}
              </span>
              <span className="peer-volume" title="current distance-based output gain">
                {Number.isFinite(row.volumePercent) ? `${row.volumePercent}%` : '0%'}
              </span>
              <span className="peer-bytes" title="inbound audio bytes received">
                {formatBytes(row.bytesReceived)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
