/**
 * Shared validator for room layouts and obstacles (Week 4 - Room Persistence).
 * Used across the Express API, the CLI script, and Mongoose model validation.
 */
import { ValidationError } from '../utils/errors.js';
import { isPlainObject } from '../utils/validate.js';

export const OBSTACLE_TYPES = Object.freeze(['wall', 'desk', 'plant', 'pillar', 'screen']);
export const OBSTACLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_MAX_OBSTACLES = 200;

export const ALLOWED_OBSTACLE_KEYS = Object.freeze(
  new Set(['id', 'type', 'x', 'y', 'w', 'h', 'blocksAudio', 'attenuation']),
);

export const ALLOWED_LAYOUT_KEYS = Object.freeze(
  new Set(['expectedRevision', 'obstacles', 'name', 'description']),
);

/**
 * Validate a single obstacle against schema rules and optional room dimensions.
 * Throws a ValidationError with a precise `path` if any rule is violated.
 */
export function validateObstacle(obstacle, index, room = null) {
  const pathPrefix = Number.isInteger(index) ? `obstacles[${index}]` : 'obstacle';

  if (!isPlainObject(obstacle)) {
    throw new ValidationError(`"${pathPrefix}" must be a JSON object`, { path: pathPrefix });
  }

  // Reject unknown obstacle fields
  for (const key of Object.keys(obstacle)) {
    if (!ALLOWED_OBSTACLE_KEYS.has(key)) {
      const fieldPath = `${pathPrefix}.${key}`;
      throw new ValidationError(`"${fieldPath}" is an unknown field`, { path: fieldPath });
    }
  }

  // id: required string, strict format, 1-64 chars
  const idPath = `${pathPrefix}.id`;
  if (typeof obstacle.id !== 'string') {
    throw new ValidationError(`"${idPath}" must be a string`, { path: idPath });
  }
  if (!OBSTACLE_ID_PATTERN.test(obstacle.id)) {
    throw new ValidationError(
      `"${idPath}" has an unsupported format (must be 1-64 alphanumeric, dash, or underscore characters)`,
      { path: idPath },
    );
  }

  // type: enum
  const typePath = `${pathPrefix}.type`;
  if (!OBSTACLE_TYPES.includes(obstacle.type)) {
    throw new ValidationError(
      `"${typePath}" must be one of: ${OBSTACLE_TYPES.join(', ')}`,
      { path: typePath },
    );
  }

  // Coordinates and dimensions: x, y, w, h
  const checkFinite = (val, fieldName) => {
    const fieldPath = `${pathPrefix}.${fieldName}`;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new ValidationError(`"${fieldPath}" must be a finite number`, { path: fieldPath });
    }
  };

  checkFinite(obstacle.x, 'x');
  checkFinite(obstacle.y, 'y');
  checkFinite(obstacle.w, 'w');
  checkFinite(obstacle.h, 'h');

  if (obstacle.x < 0) {
    throw new ValidationError(`"${pathPrefix}.x" must be >= 0`, { path: `${pathPrefix}.x` });
  }
  if (obstacle.y < 0) {
    throw new ValidationError(`"${pathPrefix}.y" must be >= 0`, { path: `${pathPrefix}.y` });
  }
  if (obstacle.w < 1) {
    throw new ValidationError(`"${pathPrefix}.w" must be >= 1`, { path: `${pathPrefix}.w` });
  }
  if (obstacle.h < 1) {
    throw new ValidationError(`"${pathPrefix}.h" must be >= 1`, { path: `${pathPrefix}.h` });
  }

  // Containment within room
  if (room && Number.isFinite(room.width) && Number.isFinite(room.height)) {
    if (obstacle.x + obstacle.w > room.width) {
      const fieldPath = `${pathPrefix}.w`;
      throw new ValidationError(
        `"${pathPrefix}" exceeds room width (x + w = ${obstacle.x + obstacle.w} > room width ${room.width})`,
        { path: fieldPath },
      );
    }
    if (obstacle.y + obstacle.h > room.height) {
      const fieldPath = `${pathPrefix}.h`;
      throw new ValidationError(
        `"${pathPrefix}" exceeds room height (y + h = ${obstacle.y + obstacle.h} > room height ${room.height})`,
        { path: fieldPath },
      );
    }
  }

  // blocksAudio: boolean
  const blocksAudioPath = `${pathPrefix}.blocksAudio`;
  if (typeof obstacle.blocksAudio !== 'boolean') {
    throw new ValidationError(`"${blocksAudioPath}" must be a boolean`, { path: blocksAudioPath });
  }

  // attenuation: finite number in [0, 1]
  const attenuationPath = `${pathPrefix}.attenuation`;
  if (typeof obstacle.attenuation !== 'number' || !Number.isFinite(obstacle.attenuation)) {
    throw new ValidationError(`"${attenuationPath}" must be a finite number`, { path: attenuationPath });
  }
  if (obstacle.attenuation < 0 || obstacle.attenuation > 1) {
    throw new ValidationError(`"${attenuationPath}" must be between 0 and 1`, { path: attenuationPath });
  }

  return {
    id: obstacle.id,
    type: obstacle.type,
    x: obstacle.x,
    y: obstacle.y,
    w: obstacle.w,
    h: obstacle.h,
    blocksAudio: obstacle.blocksAudio,
    attenuation: obstacle.attenuation,
  };
}

/**
 * Validates a layout save payload.
 *
 * @param {object} payload - Incoming body { expectedRevision, obstacles, name?, description? }
 * @param {object} [options]
 * @param {object} [options.room] - Existing room document with { width, height }
 * @param {number} [options.maxObstacles] - Maximum allowed obstacles (default 200)
 * @param {boolean} [options.requireExpectedRevision] - Whether expectedRevision is mandatory
 * @returns {object} Sanitized and validated payload
 */
export function validateLayoutPayload(
  payload,
  {
    room = null,
    maxObstacles = DEFAULT_MAX_OBSTACLES,
    requireExpectedRevision = true,
  } = {},
) {
  if (!isPlainObject(payload)) {
    throw new ValidationError('Layout payload must be a JSON object', { path: '' });
  }

  // Reject unknown top-level fields (prevents mass-assignment of roomId, width, height, layoutRevision, etc.)
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_LAYOUT_KEYS.has(key)) {
      throw new ValidationError(`Unknown field "${key}" is not allowed in layout payload`, { path: key });
    }
  }

  // expectedRevision validation
  if (requireExpectedRevision || payload.expectedRevision !== undefined) {
    const rev = payload.expectedRevision;
    if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
      throw new ValidationError('"expectedRevision" must be a positive integer (>= 1)', {
        path: 'expectedRevision',
      });
    }
  }

  // obstacles validation
  if (!Array.isArray(payload.obstacles)) {
    throw new ValidationError('"obstacles" must be an array', { path: 'obstacles' });
  }
  if (payload.obstacles.length > maxObstacles) {
    throw new ValidationError(
      `"obstacles" array exceeds maximum allowed limit of ${maxObstacles} (received ${payload.obstacles.length})`,
      { path: 'obstacles' },
    );
  }

  // Unique IDs check and obstacle item validations
  const seenIds = new Set();
  const sanitizedObstacles = payload.obstacles.map((obs, idx) => {
    const validated = validateObstacle(obs, idx, room);
    if (seenIds.has(validated.id)) {
      const idPath = `obstacles[${idx}].id`;
      throw new ValidationError(
        `Duplicate obstacle id "${validated.id}" at index ${idx}`,
        { path: idPath },
      );
    }
    seenIds.add(validated.id);
    return validated;
  });

  // Optional room name
  let name;
  if (payload.name !== undefined) {
    if (typeof payload.name !== 'string') {
      throw new ValidationError('"name" must be a string', { path: 'name' });
    }
    const trimmed = payload.name.trim();
    if (trimmed.length < 1 || trimmed.length > 64) {
      throw new ValidationError('"name" must be 1-64 characters', { path: 'name' });
    }
    name = trimmed;
  }

  // Optional room description
  let description;
  if (payload.description !== undefined) {
    if (typeof payload.description !== 'string') {
      throw new ValidationError('"description" must be a string', { path: 'description' });
    }
    const trimmed = payload.description.trim();
    if (trimmed.length > 500) {
      throw new ValidationError('"description" must not exceed 500 characters', { path: 'description' });
    }
    description = trimmed;
  }

  return {
    ...(payload.expectedRevision !== undefined ? { expectedRevision: payload.expectedRevision } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    obstacles: sanitizedObstacles,
  };
}

export default validateLayoutPayload;
