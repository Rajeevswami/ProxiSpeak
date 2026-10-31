/**
 * Payload validation for every event a client can send.
 *
 * Pure functions on purpose: they are the cheapest place to stop a malformed
 * or hostile payload, so they run before any database read/write and can be
 * unit tested without a server or a socket.
 */
import { ValidationError } from '../utils/errors.js';
import { clamp, isPlainObject, requireFiniteNumber, requireString, round2 } from '../utils/validate.js';

/**
 * Room ids are lowercased and restricted to url/file-system safe characters:
 * the id is used as a Socket.io room channel and as a MongoDB key, so dots,
 * slashes, dollar signs and colons are rejected outright.
 */
const ROOM_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** Control characters would end up echoed to other clients — never allow them. */
const SAFE_NAME = /^[^\u0000-\u001f\u007f]+$/;

const MAX_ROOM_ID_LENGTH = 48;
export const MAX_NAME_LENGTH = 24;

/** `join` -> { roomId, name }. Both fields are required. */
export function validateJoinPayload(payload, { maxNameLength = MAX_NAME_LENGTH } = {}) {
  const data = isPlainObject(payload) ? payload : {};

  const roomId = requireString(data.roomId ?? '', 'roomId', { min: 1, max: MAX_ROOM_ID_LENGTH }).toLowerCase();
  if (!ROOM_ID.test(roomId)) {
    throw new ValidationError('"roomId" may only contain a-z, 0-9, "-" and "_"', { field: 'roomId' });
  }

  const name = requireString(data.name ?? '', 'name', { min: 1, max: maxNameLength, pattern: SAFE_NAME });

  return { roomId, name };
}

/** Absurd magnitudes (1e300) are rejected outright rather than clamped. */
const MAX_COORDINATE = 1e6;

/**
 * `move` -> { x, y }. The server owns the position, so two independent guards
 * are applied to every accepted move:
 *
 *  bounds    — a coordinate outside the room is clamped into it, so no client
 *              can drive an avatar out of the floor plan;
 *  step      — the accepted position is at most `maxStepPx` away from the
 *              previous one, which is what makes teleporting impossible.
 *
 * @returns {{x:number,y:number,limited:boolean,outOfBounds:boolean}}
 */
export function validateMovePayload(payload, { room, previous, maxStepPx }) {
  const data = isPlainObject(payload) ? payload : {};

  const rawX = requireFiniteNumber(data.x, 'x', { min: -MAX_COORDINATE, max: MAX_COORDINATE });
  const rawY = requireFiniteNumber(data.y, 'y', { min: -MAX_COORDINATE, max: MAX_COORDINATE });

  let x = round2(clamp(rawX, 0, room.width));
  let y = round2(clamp(rawY, 0, room.height));
  const outOfBounds = x !== round2(rawX) || y !== round2(rawY);

  let limited = false;
  if (previous) {
    const dx = x - previous.x;
    const dy = y - previous.y;
    const distance = Math.hypot(dx, dy);
    if (distance > maxStepPx) {
      // Keep the direction the client asked for, shorten the step.
      const ratio = maxStepPx / distance;
      x = round2(clamp(previous.x + dx * ratio, 0, room.width));
      y = round2(clamp(previous.y + dy * ratio, 0, room.height));
      limited = true;
    }
  }

  return { x, y, limited, outOfBounds };
}

export default validateJoinPayload;

// --------------------------------------------------------------- signaling ---

/**
 * WebRTC signaling envelope (Day 8).
 *
 * SDP is opaque text for the server; it only checks that it is a string and
 * that the whole `data` object stays small (~16 KB). Offers/answers carry
 * `sdp`; trickled candidates carry either the raw candidate string or the
 * browser's candidate object, which is whitelisted field by field before it
 * is relayed. Nothing here inspects or interprets media.
 */
export const MAX_SIGNAL_BYTES = 16 * 1024;
const MAX_SIGNAL_STRING_LENGTH = MAX_SIGNAL_BYTES;

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate']);
const CANDIDATE_FIELDS = ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'];

/** A raw (untrimmed) string: SDP and candidate lines are whitespace-sensitive. */
function requireRawString(value, field, { min = 0, max = MAX_SIGNAL_STRING_LENGTH } = {}) {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${field}" must be a string`, { field });
  }
  if (value.length < min || value.length > max) {
    throw new ValidationError(`"${field}" must be ${min}-${max} characters`, { field });
  }
  return value;
}

function signalByteLength(value, field) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new ValidationError(`"${field}" must be JSON-serializable`, { field });
  }
}

function normalizeCandidate(candidate) {
  if (candidate === null) return null; // end-of-candidates
  if (typeof candidate === 'string') {
    return requireRawString(candidate, 'data.candidate');
  }
  if (!isPlainObject(candidate)) {
    throw new ValidationError('"data.candidate" must be a string, an object or null', { field: 'data.candidate' });
  }

  const normalized = {
    candidate: requireRawString(candidate.candidate, 'data.candidate.candidate'),
  };
  for (const field of CANDIDATE_FIELDS.slice(1)) {
    const value = candidate[field];
    if (value === undefined || value === null) continue;
    if (field === 'sdpMLineIndex') {
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new ValidationError('"data.candidate.sdpMLineIndex" must be an integer in [0, 65535]', {
          field: 'data.candidate.sdpMLineIndex',
        });
      }
      normalized.sdpMLineIndex = value;
    } else {
      normalized[field] = requireRawString(value, `data.candidate.${field}`, { max: 256 });
    }
  }
  return normalized;
}

/**
 * `signal` -> { to, generation, data }.
 *
 * Accepted forms:
 *   { to, generation, data: { type: "offer"|"answer", sdp } }
 *   { to, generation, data: { type: "candidate", candidate: string|object|null } }
 *
 * @returns {{to:string, generation:number, data:object}} a whitelisted copy
 */
export function validateSignalPayload(payload, { maxBytes = MAX_SIGNAL_BYTES } = {}) {
  const envelope = isPlainObject(payload) ? payload : {};

  const to = requireString(envelope.to ?? '', 'to', {
    min: 1, max: 128, pattern: SESSION_ID,
  });
  // Generations are non-negative integers. 0 is structurally valid but can
  // never name a live edge (the first edge is generation 1), so it is refused
  // by the gateway as stale rather than as a malformed envelope.
  const generation = requireFiniteNumber(envelope.generation, 'generation', {
    min: 0, max: Number.MAX_SAFE_INTEGER,
  });
  if (!Number.isInteger(generation)) {
    throw new ValidationError('"generation" must be an integer', { field: 'generation' });
  }

  const data = envelope.data;
  if (!isPlainObject(data)) {
    throw new ValidationError('"data" must be an object', { field: 'data' });
  }
  if (signalByteLength(data, 'data') > maxBytes) {
    throw new ValidationError(`"data" must be at most ${maxBytes} bytes`, { field: 'data' });
  }
  if (!SIGNAL_TYPES.has(data.type)) {
    throw new ValidationError('"data.type" must be "offer", "answer" or "candidate"', {
      field: 'data.type',
    });
  }

  if (data.type === 'offer' || data.type === 'answer') {
    const sdp = requireRawString(data.sdp, 'data.sdp', { min: 1, max: maxBytes });
    return { to, generation, data: { type: data.type, sdp } };
  }

  return { to, generation, data: { type: 'candidate', candidate: normalizeCandidate(data.candidate) } };
}
