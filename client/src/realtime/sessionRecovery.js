/** A fresh connection reruns the existing connect -> join -> joined path.
 * Preserve the hook's pending join credentials and authoritative snapshot merge;
 * do not add a second set of listeners or optimistically create an avatar. */
export function recoverExpiredSession(socket, error) {
  if (error?.code !== 'session_expired') return false;
  // Coalesce repeated errors while the same socket is already reconnecting.
  if (socket.connected) {
    socket.disconnect();
    socket.connect();
  }
  return true;
}
