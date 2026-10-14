import { useState } from 'react';

/**
 * Name + room entry (Day 4). No movement, no media — just a validated
 * `join` ({ roomId, name } in the Day 3 contract) and honest errors.
 *
 * Rooms are the ones `npm run seed` creates server-side (Day 2/3). The
 * server is still the authority: a room it does not know is answered
 * with `room_not_found`, which is displayed here, never swallowed.
 */

export const ROOMS = [
  { id: 'lobby', label: 'Lobby' },
  { id: 'studio', label: 'Studio' },
  { id: 'lounge', label: 'Lounge' },
];

const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validateJoinInput(name, roomId) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const normalizedRoom = typeof roomId === 'string' ? roomId.trim().toLowerCase() : '';

  if (!trimmedName) return 'Please enter your name.';
  if (trimmedName.length > 24) return 'Name must be 24 characters or fewer.';
  if (CONTROL_CHARS.test(trimmedName)) return 'Name contains characters that are not allowed.';
  if (!normalizedRoom) return 'Please choose a room.';
  if (!ROOM_ID_PATTERN.test(normalizedRoom)) {
    return 'Room may only contain a-z, 0-9, "-" and "_" (48 characters max).';
  }
  return null;
}

const SERVER_ERROR_TEXT = {
  room_not_found: (err) =>
    `That room does not exist on the server${err?.message ? ` — ${err.message}` : ''}. Run \`npm run seed\` on the server, then try again.`,
  invalid_payload: (err) =>
    `The server rejected that join as invalid${err?.field ? ` (field: ${err.field})` : ''}${err?.message ? ` — ${err.message}` : ''}.`,
  already_joined: () => 'This connection is already in a room. Reload the page to join a different one.',
  not_joined: () => 'You are not in a room yet.',
  connection_failed: () =>
    'Could not reach the server. Check that the server is running (see the Day 4 README) and that CLIENT_URL allows this page, then try again.',
  connect_error: () =>
    'Could not reach the server. Check that the server is running (see the Day 4 README) and that CLIENT_URL allows this page, then try again.',
  server_error: () => 'The server hit an unexpected error. Please try again.',
};

export function describeServerError(error) {
  if (!error) return null;
  const describe = SERVER_ERROR_TEXT[error.code];
  if (describe) return describe(error);
  return error.message ?? 'Something went wrong. Please try again.';
}

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
            maxLength={25}
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
