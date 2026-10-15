import { useState } from 'react';
import { MAX_NAME_LENGTH, ROOMS, describeServerError, validateJoinInput } from '../join/joinForm.js';

/**
 * Name + room entry (Day 4). No movement, no media — just a validated
 * `join` ({ roomId, name } in the Day 3 contract) and honest errors.
 *
 * The rules live in `join/joinForm.js` (pure, unit-tested); this component owns
 * the form state and renders the message the rules produce. The server is still
 * the authority: a room it does not know is answered with `room_not_found`,
 * which is displayed here, never swallowed.
 */
export default function JoinScreen({ onJoin, status, error }) {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('lobby');
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
    onJoin({ name: name.trim(), roomId: roomId.trim().toLowerCase() });
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

        {shownError ? (
          <p className="form-error" role="alert">
            {shownError}
          </p>
        ) : null}

        <button type="submit" disabled={connecting}>
          {connecting ? 'Joining…' : 'Join room'}
        </button>

        <p className="join-hint">Walk with WASD or the arrow keys, or click the floor to walk there.</p>
      </form>
    </main>
  );
}
