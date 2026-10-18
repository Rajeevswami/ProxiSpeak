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

export default function AudioStatus({ mic, getSnapshot }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    const read = () => {
      const next = typeof getSnapshot === 'function' ? getSnapshot() ?? [] : [];
      const serialized = JSON.stringify(next);
      // Only commit real changes: a steady peer list must not re-render.
      setRows((prev) => (JSON.stringify(prev) === serialized ? prev : next));
    };
    read();
    const timer = setInterval(read, 1000); // at most once per second
    return () => clearInterval(timer);
  }, [getSnapshot]);

  return (
    <aside className="audio-status" role="status" aria-live="polite" aria-label="Audio connections">
      <div className="audio-status-mic">
        Audio · {MIC_LABEL[mic?.state] ?? 'listen only'}
        {mic?.notice ? <span className="audio-status-notice">{mic.notice}</span> : null}
      </div>
      {rows.length === 0 ? (
        <div className="audio-status-empty">no nearby peers yet</div>
      ) : (
        <ul className="audio-status-list">
          {rows.map((row) => (
            <li key={row.peerId}>
              <span className="peer-name">{row.name || row.peerId.slice(0, 6)}</span>
              <span className={`peer-state peer-state-${row.connectionState}`}>{row.connectionState}</span>
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
