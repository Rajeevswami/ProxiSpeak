/**
 * Input validation primitives shared by the socket handlers.
 *
 * Everything a client sends is untrusted: these helpers only ever *return* a
 * value once it has been proven to be the expected type and range, and throw a
 * ValidationError otherwise. They never touch the database or the socket.
 */
import { ValidationError } from './errors.js';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
export const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Round to 2 decimals — keeps socket traffic and documents small. */
export const round2 = (value) => Math.round(value * 100) / 100;

/**
 * A finite number inside an optional range. Rejects NaN, ±Infinity, numeric
 * strings, null and every other type a client might smuggle in.
 */
export function requireFiniteNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (!isFiniteNumber(value)) {
    throw new ValidationError(`"${field}" must be a finite number`, { field });
  }
  if (value < min || value > max) {
    throw new ValidationError(`"${field}" must be within [${min}, ${max}]`, { field });
  }
  return value;
}

/** A trimmed string of a given length, optionally matching a pattern. */
export function requireString(value, field, { min = 1, max = 64, pattern } = {}) {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${field}" must be a string`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ValidationError(`"${field}" must be ${min}-${max} characters`, { field });
  }
  if (pattern && !pattern.test(trimmed)) {
    throw new ValidationError(`"${field}" has an unsupported format`, { field });
  }
  return trimmed;
}
