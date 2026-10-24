/**
 * Connection status machine (Week 1). The hook owns the socket; this module owns
 * the rules that turn socket events into the one word the UI shows. Pure, so the
 * awkward transitions are unit-tested instead of only being observable in a
 * browser with a flaky network.
 *
 *   idle          nothing requested yet (the join screen has no error to show)
 *   connecting    a join was requested, no reply yet — the form is busy
 *   joined        the server acknowledged this connection: we are in the world
 *   disconnected  the transport dropped while we were in the world; Socket.io is
 *                 reconnecting on its own
 *   error         something went wrong that the user has to act on: the server
 *                 is unreachable, the join was rejected, or the connection
 *                 dropped before the join finished
 */

export const CONNECTION_STATUS = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  JOINED: 'joined',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
});

/**
 * @param {string} status the current status
 * @param {'join-requested'|'joined'|'error'|'connect-error'|'disconnected'} event
 * @returns {string} the next status
 */
export function statusAfter(status, event) {
  const current = status ?? CONNECTION_STATUS.IDLE;

  switch (event) {
    // A fresh join always starts from scratch: no stale error, no busy form.
    case 'join-requested':
      return CONNECTION_STATUS.CONNECTING;

    case 'joined':
      return CONNECTION_STATUS.JOINED;

    // The server answered with a rejection (room_not_found, invalid_payload):
    // actionable before the join, and never a reason to throw a world away.
    // From 'disconnected' it means the re-join was refused, so "reconnecting…"
    // would be a lie — the error takes over.
    case 'error':
      return current === CONNECTION_STATUS.JOINED ? CONNECTION_STATUS.JOINED : CONNECTION_STATUS.ERROR;

    // The handshake itself failed (no server, blocked origin). Before the join
    // that is an error the form shows; a member who is already in the world and
    // reconnecting keeps the "reconnecting…" state, and a failed retry does not
    // move them out of it.
    case 'connect-error':
      if (current === CONNECTION_STATUS.JOINED) return CONNECTION_STATUS.JOINED;
      if (current === CONNECTION_STATUS.DISCONNECTED) return CONNECTION_STATUS.DISCONNECTED;
      return CONNECTION_STATUS.ERROR;

    // The transport dropped. Socket.io reconnects by itself, so a member stays
    // in the world and the HUD can say "reconnecting…" — but a connection that
    // dies *before* the join was acknowledged must not leave the form stuck at
    // "Joining…" with its button disabled forever: that becomes an error the
    // join screen can show.
    case 'disconnected':
      return current === CONNECTION_STATUS.JOINED ? CONNECTION_STATUS.DISCONNECTED : CONNECTION_STATUS.ERROR;

    default:
      return current;
  }
}

export default statusAfter;
