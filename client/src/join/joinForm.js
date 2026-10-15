/**
 * Join-form rules (Week 1). Pure functions: no React, no socket, no DOM — the
 * component in `components/JoinScreen.jsx` only renders what these decide, and
 * `client/test/joinForm.test.js` tests them without a browser.
 *
 * Two jobs:
 *   1. refuse an obviously invalid name/room before a round trip, with a message
 *      the user can act on;
 *   2. turn a server/connection `error` into a sentence that says what happened
 *      and what to do next. The server is the authority — a room it does not
 *      know is answered with `room_not_found` and shown here, never swallowed.
 */

/** The rooms `npm run seed` creates server-side (server/scripts/seed.js). */
export const ROOMS = [
  { id: 'lobby', label: 'Lobby' },
  { id: 'studio', label: 'Studio' },
  { id: 'lounge', label: 'Lounge' },
];

/** Mirrors the server's rule (server/src/sockets/validation.js). */
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Longest name the server accepts. */
export const MAX_NAME_LENGTH = 24;

/**
 * @returns {string|null} the problem with the input, or null when it is fine
 */
export function validateJoinInput(name, roomId) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const normalizedRoom = typeof roomId === 'string' ? roomId.trim().toLowerCase() : '';

  if (!trimmedName) return 'Please enter your name.';
  if (trimmedName.length > MAX_NAME_LENGTH) return `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
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
  connection_failed: () => 'Could not reach the server. Check that the server is running and that CLIENT_URL allows this page, then try again.',
  connection_lost: () =>
    'The connection to the server was lost before the join finished, and Socket.io is still trying to reconnect. Check that the server is running, then try again.',
  connect_error: () => 'Could not reach the server. Check that the server is running and that CLIENT_URL allows this page, then try again.',
  server_error: () => 'The server hit an unexpected error. Please try again.',
};

/**
 * @param {{code:string,message?:string,field?:string}|null} error
 * @returns {string|null} a sentence for the user, or null when there is no error
 */
export function describeServerError(error) {
  if (!error) return null;
  const describe = SERVER_ERROR_TEXT[error.code];
  if (describe) return describe(error);
  return error.message ?? 'Something went wrong. Please try again.';
}
