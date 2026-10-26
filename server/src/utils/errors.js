/**
 * Typed application errors.
 *
 * The socket layer maps an `AppError` with a 4xx status to a compact `error`
 * event (safe to show a client) and treats anything else as a bug worth
 * logging, reported back as a generic `server_error` so internals — stack
 * traces, connection strings, document shapes — never reach a browser.
 */
export class AppError extends Error {
  constructor(message, { code = 'server_error', status = 500, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Malformed client input: always a 400, always answered with `error`. */
export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { code: 'invalid_payload', status: 400, details });
    this.name = 'ValidationError';
  }
}

/** Room does not exist: always a 404. */
export class RoomNotFoundError extends AppError {
  constructor(roomId) {
    super(`Room "${roomId}" not found`, {
      code: 'room_not_found',
      status: 404,
      details: { roomId },
    });
    this.name = 'RoomNotFoundError';
  }
}

/** Optimistic concurrency revision conflict: always a 409. */
export class RevisionConflictError extends AppError {
  constructor(roomId, expectedRevision, currentRevision) {
    super(
      `Revision conflict on room "${roomId}": expected revision ${expectedRevision} but current revision is ${currentRevision}`,
      {
        code: 'revision_conflict',
        status: 409,
        details: { roomId, expectedRevision, currentRevision },
      },
    );
    this.name = 'RevisionConflictError';
  }
}

export default AppError;
