import { useState } from 'react';
import { MAX_NAME_LENGTH, ROOMS, describeServerError, validateJoinInput } from '../join/joinForm.js';

const ROOM_META = {
  lobby: {
    badge: 'Executive Floor',
    desc: 'Hardwood parquet, dual workstations & acoustic core wall',
    accent: '#38bdf8',
  },
  studio: {
    badge: 'Mastering Suite',
    desc: 'Sound-treated slate studio, isolation booths & live monitors',
    accent: '#c084fc',
  },
  lounge: {
    badge: 'Social Café Hub',
    desc: 'Warm walnut & emerald lounge, collaboration tables & planters',
    accent: '#34d399',
  },
};

/**
 * Name + room entry with an interactive 3D isometric room preview stage,
 * 3D perspective background, and mouse-reactive 3D tilt card.
 */
export default function JoinScreen({ onJoin, status, error, notice }) {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('lobby');
  const [withMic, setWithMic] = useState(true);
  const [localError, setLocalError] = useState(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 });

  const connecting = status === 'connecting';
  const shownError = localError ?? describeServerError(error);
  const activeMeta = ROOM_META[roomId] ?? ROOM_META.lobby;

  const handleMouseMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = (event.clientX - rect.left) / rect.width - 0.5;
    const ny = (event.clientY - rect.top) / rect.height - 0.5;
    setTilt({
      rx: Number((-ny * 8).toFixed(2)),
      ry: Number((nx * 10).toFixed(2)),
    });
  };

  const handleMouseLeave = () => {
    setTilt({ rx: 0, ry: 0 });
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const validationError = validateJoinInput(name, roomId);
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    setLocalError(null);
    onJoin({ name: name.trim(), roomId: roomId.trim().toLowerCase(), withMic });
  };

  return (
    <main className={`join-screen join-theme-${roomId}`}>
      {/* 3D Animated Ambient Background Stage */}
      <div className="join-bg-stage" aria-hidden="true">
        <div className="join-aurora join-aurora-1" />
        <div className="join-aurora join-aurora-2" />
        <div className="join-aurora join-aurora-3" />
        <div className="join-perspective-grid" />
        <div className="join-sonar-ring join-sonar-1" />
        <div className="join-sonar-ring join-sonar-2" />
        <div className="join-sonar-ring join-sonar-3" />
        <div className="join-orb join-orb-1" />
        <div className="join-orb join-orb-2" />
        <div className="join-orb join-orb-3" />
      </div>

      <form
        className="join-card"
        onSubmit={handleSubmit}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          '--card-rx': `${tilt.rx}deg`,
          '--card-ry': `${tilt.ry}deg`,
          '--room-accent': activeMeta.accent,
        }}
        noValidate
      >
        <div className="join-card-glow" aria-hidden="true" />

        {/* Header + Live 3D Isometric Room Mini-Stage */}
        <div className="join-hero">
          <div className="join-title-group">
            <span className="join-pill-badge">
              <span className="join-live-dot" />
              3D Spatial Proximity Audio
            </span>
            <h1>ProxiSpeak</h1>
            <p className="join-subtitle">Walk into a room. Proximity is the volume knob.</p>
          </div>

          {/* 3D Isometric Miniature Room Preview */}
          <div className={`iso-scene iso-room-${roomId}`} aria-hidden="true" title={`3D Preview: ${roomId}`}>
            <div className="iso-floor">
              <div className="iso-grid" />
              <div className="iso-rug" />
              <div className="iso-wall">
                <div className="iso-wall-top" />
              </div>
              <div className="iso-desk">
                <div className="iso-desk-monitor" />
              </div>
              <div className="iso-plant" />
              {/* Animated 3D Human Avatar A */}
              <div className="iso-avatar iso-avatar-a">
                <span className="iso-sonar" />
                <span className="iso-body" />
                <span className="iso-head" />
              </div>
              {/* Animated 3D Human Avatar B */}
              <div className="iso-avatar iso-avatar-b">
                <span className="iso-sonar" />
                <span className="iso-body" />
                <span className="iso-head" />
              </div>
              <div className="iso-sound-beam" />
            </div>
          </div>
        </div>

        <label className="field">
          <span>Your name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Ada"
            maxLength={MAX_NAME_LENGTH + 1}
            autoComplete="name"
            autoFocus
            disabled={connecting}
          />
        </label>

        {/* Interactive Room Theme Cards + Native Select */}
        <div className="field">
          <span>Choose 3D Space</span>
          <div className="room-QuickCards" role="group" aria-label="Room presets">
            {ROOMS.map((room) => {
              const meta = ROOM_META[room.id] ?? ROOM_META.lobby;
              const active = roomId === room.id;
              return (
                <button
                  key={room.id}
                  type="button"
                  className={`room-chip ${active ? 'room-chip-active' : ''}`}
                  onClick={() => setRoomId(room.id)}
                  disabled={connecting}
                >
                  <span className="room-chip-title">{room.label}</span>
                  <span className="room-chip-sub">{meta.badge}</span>
                </button>
              );
            })}
          </div>
          <select
            aria-label="Room"
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            disabled={connecting}
          >
            {ROOMS.map((room) => (
              <option key={room.id} value={room.id}>
                {room.label} ({room.id})
              </option>
            ))}
          </select>
          <span className="room-theme-caption">{activeMeta.desc}</span>
        </div>

        <label className="field">
          <span>Microphone</span>
          <select
            value={withMic ? 'mic' : 'listen'}
            onChange={(event) => setWithMic(event.target.value === 'mic')}
            disabled={connecting}
          >
            <option value="mic">Join with mic (Live P2P Voice)</option>
            <option value="listen">Listen only (No mic required)</option>
          </select>
        </label>

        {notice ? (
          <p className="form-notice" role="status">
            {notice}
          </p>
        ) : null}

        {shownError ? (
          <p className="form-error" role="alert">
            {shownError}
          </p>
        ) : null}

        <button type="submit" className="join-submit-btn" disabled={connecting}>
          <span className="btn-shimmer" aria-hidden="true" />
          <span className="btn-label">
            {connecting ? 'Entering 3D Room…' : withMic ? 'Enter 3D Room with Mic' : 'Enter 3D Room (Listen Only)'}
          </span>
        </button>

        <p className="join-hint">Walk with WASD or arrow keys · Click any floor tile to walk there · Real-time 3D stereo &amp; wall occlusion</p>
      </form>
    </main>
  );
}
