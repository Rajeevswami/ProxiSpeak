import { useState } from 'react';
import { MAX_NAME_LENGTH, ROOMS, describeServerError, validateJoinInput } from '../join/joinForm.js';

/**
 * Name + room entry (Day 4; Day 9 adds the one microphone choice). No
 * movement, no media capture here — just a validated `join` ({ roomId, name,
 * withMic } in the Day 3 + Day 9 contract) and honest errors.
 *
 * The rules live in `join/joinForm.js` (pure, unit-tested); this component owns
 * the form state and renders the message the rules produce. The server is still
 * the authority: a room it does not know is answered with `room_not_found`,
 * which is displayed here, never swallowed. The microphone itself is requested
 * by `useSocket.join` inside this submit click (a real user gesture); when the
 * browser says no, `notice` explains it and the join continues listen-only.
 */
export default function JoinScreen({ onJoin, status, error, notice }) {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('lobby');
  const [withMic, setWithMic] = useState(true);
  const [localError, setLocalError] = useState(null);

  const connecting = status === 'connecting';
  const shownError = localError ?? describeServerError(error);

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
    <main className="join-screen">
      <form className="join-card" onSubmit={handleSubmit} noValidate>
        <h1>ProxiSpeak</h1>
        <p className="join-subtitle">Walk into a room. Proximity is the volume knob.</p>

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

        <label className="field">
          <span>Room</span>
          <select value={roomId} onChange={(event) => setRoomId(event.target.value)} disabled={connecting}>
            {ROOMS.map((room) => (
              <option key={room.id} value={room.id}>
                {room.label} ({room.id})
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Microphone</span>
          <select
            value={withMic ? 'mic' : 'listen'}
            onChange={(event) => setWithMic(event.target.value === 'mic')}
            disabled={connecting}
          >
            <option value="mic">Join with mic</option>
            <option value="listen">Listen only</option>
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

        <button type="submit" disabled={connecting}>
          {connecting ? 'Joining…' : withMic ? 'Join room' : 'Join room (listen only)'}
        </button>

        <p className="join-hint">Walk with WASD or the arrow keys, or click the floor to walk there.</p>
      </form>
    </main>
  );
}
