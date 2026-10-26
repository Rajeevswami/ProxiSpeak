/**
 * Unit tests for the shared layout validator (Week 4 - Room Persistence).
 * Validates all obstacle schema rules, room boundary containment, mass assignment
 * guards, payload caps, and clear error paths without needing a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateObstacle,
  validateLayoutPayload,
  OBSTACLE_TYPES,
  DEFAULT_MAX_OBSTACLES,
} from '../src/validators/roomLayout.js';
import { ValidationError } from '../src/utils/errors.js';

const ROOM = { width: 1920, height: 1080 };

function validObstacle(overrides = {}) {
  return {
    id: 'wall-1',
    type: 'wall',
    x: 100,
    y: 200,
    w: 50,
    h: 80,
    blocksAudio: true,
    attenuation: 0.2,
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  return {
    expectedRevision: 1,
    obstacles: [validObstacle()],
    ...overrides,
  };
}

test('valid layout payload passes validation and returns sanitized copy', () => {
  const payload = validPayload({
    name: 'New Conference Room',
    description: 'Updated blueprint with soundproof dividers',
  });
  const result = validateLayoutPayload(payload, { room: ROOM });

  assert.equal(result.expectedRevision, 1);
  assert.equal(result.name, 'New Conference Room');
  assert.equal(result.description, 'Updated blueprint with soundproof dividers');
  assert.equal(result.obstacles.length, 1);
  assert.deepEqual(result.obstacles[0], payload.obstacles[0]);
});

test('all valid obstacle types are accepted', () => {
  for (const type of OBSTACLE_TYPES) {
    const obs = validObstacle({ id: `item-${type}`, type });
    assert.doesNotThrow(() => validateObstacle(obs, 0, ROOM));
  }
});

test('non-object layout payload is rejected with clear message', () => {
  assert.throws(
    () => validateLayoutPayload(null),
    (err) => err instanceof ValidationError && err.message.includes('JSON object'),
  );
  assert.throws(
    () => validateLayoutPayload('string-payload'),
    (err) => err instanceof ValidationError && err.message.includes('JSON object'),
  );
});

test('mass assignment fields are rejected outright (roomId, width, height, layoutRevision)', () => {
  const forbidden = ['roomId', 'width', 'height', 'layoutRevision', 'spawnPoints', 'createdAt', 'extra'];
  for (const field of forbidden) {
    const payload = validPayload({ [field]: 'forbidden-value' });
    assert.throws(
      () => validateLayoutPayload(payload, { room: ROOM }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.path, field);
        assert.match(err.message, new RegExp(`Unknown field "${field}"`));
        return true;
      },
      `Should reject mass assignment field "${field}"`,
    );
  }
});

test('expectedRevision must be a positive integer (>= 1)', () => {
  const invalidRevisions = [0, -1, -50, 1.5, NaN, Infinity, '1', null, true];
  for (const rev of invalidRevisions) {
    const payload = validPayload({ expectedRevision: rev });
    assert.throws(
      () => validateLayoutPayload(payload, { room: ROOM }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.path, 'expectedRevision');
        return true;
      },
      `Should reject expectedRevision: ${rev}`,
    );
  }
});

test('obstacles field must be an array', () => {
  const invalidObstacles = ['not-an-array', 123, null, {}, true];
  for (const bad of invalidObstacles) {
    const payload = validPayload({ obstacles: bad });
    assert.throws(
      () => validateLayoutPayload(payload, { room: ROOM }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.path, 'obstacles');
        return true;
      },
    );
  }
});

test('obstacles array cap (max 200) is enforced', () => {
  const obstacles = [];
  for (let i = 0; i < 201; i += 1) {
    obstacles.push(validObstacle({ id: `obs-${i}`, x: 0, y: 0, w: 1, h: 1 }));
  }
  assert.throws(
    () => validateLayoutPayload({ expectedRevision: 1, obstacles }, { room: ROOM, maxObstacles: 200 }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.details?.path, 'obstacles');
      assert.match(err.message, /exceeds maximum allowed limit of 200/);
      return true;
    },
  );

  // Exactly 200 should pass
  const exactly200 = obstacles.slice(0, 200);
  assert.doesNotThrow(() =>
    validateLayoutPayload({ expectedRevision: 1, obstacles: exactly200 }, { room: ROOM, maxObstacles: 200 }),
  );
});

test('obstacle IDs must be unique across the layout', () => {
  const payload = {
    expectedRevision: 1,
    obstacles: [
      validObstacle({ id: 'desk-dup', x: 10, y: 10 }),
      validObstacle({ id: 'wall-other', x: 20, y: 20 }),
      validObstacle({ id: 'desk-dup', x: 30, y: 30 }),
    ],
  };
  assert.throws(
    () => validateLayoutPayload(payload, { room: ROOM }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.details?.path, 'obstacles[2].id');
      assert.match(err.message, /Duplicate obstacle id "desk-dup" at index 2/);
      return true;
    },
  );
});

test('obstacle ID format and length are strictly enforced', () => {
  const invalidIds = [
    '', // empty
    'has space',
    'has.dot',
    'has$dollar',
    'has/slash',
    'a'.repeat(65), // > 64 chars
    123,
    null,
  ];

  for (const badId of invalidIds) {
    const obs = validObstacle({ id: badId });
    assert.throws(
      () => validateObstacle(obs, 3, ROOM),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.path, 'obstacles[3].id');
        return true;
      },
      `Should reject obstacle ID: ${badId}`,
    );
  }

  // Max 64 chars valid id
  const maxId = 'a'.repeat(64);
  assert.doesNotThrow(() => validateObstacle(validObstacle({ id: maxId }), 0, ROOM));
});

test('obstacle type must be in enum', () => {
  const invalidTypes = ['table', 'sofa', 'window', 'DOOR', 'WALL', '', null, 12];
  for (const badType of invalidTypes) {
    assert.throws(
      () => validateObstacle(validObstacle({ type: badType }), 2, ROOM),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.path, 'obstacles[2].type');
        assert.match(err.message, /must be one of:/);
        return true;
      },
    );
  }
});

test('coordinates x and y must be finite numbers >= 0', () => {
  for (const coord of ['x', 'y']) {
    for (const badVal of [-1, -0.01, NaN, Infinity, -Infinity, '10', null, undefined]) {
      const obs = validObstacle({ [coord]: badVal });
      assert.throws(
        () => validateObstacle(obs, 5, ROOM),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.details?.path, new RegExp(`obstacles\\[5\\]\\.${coord}`));
          return true;
        },
      );
    }
    // 0 is valid
    assert.doesNotThrow(() => validateObstacle(validObstacle({ [coord]: 0 }), 0, ROOM));
  }
});

test('dimensions w and h must be finite numbers >= 1', () => {
  for (const dim of ['w', 'h']) {
    for (const badVal of [0, 0.99, -1, NaN, Infinity, '50', null, undefined]) {
      const obs = validObstacle({ [dim]: badVal });
      assert.throws(
        () => validateObstacle(obs, 1, ROOM),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.details?.path, new RegExp(`obstacles\\[1\\]\\.${dim}`));
          return true;
        },
      );
    }
    // 1 is minimum valid
    assert.doesNotThrow(() => validateObstacle(validObstacle({ [dim]: 1 }), 0, ROOM));
  }
});

test('boundary values: obstacle exactly touching the room edge is valid', () => {
  // Top-left corner touching (0, 0)
  assert.doesNotThrow(() =>
    validateObstacle(validObstacle({ x: 0, y: 0, w: 100, h: 100 }), 0, ROOM),
  );

  // Bottom-right corner touching (x + w = room.width, y + h = room.height)
  assert.doesNotThrow(() =>
    validateObstacle(
      validObstacle({ x: ROOM.width - 200, y: ROOM.height - 150, w: 200, h: 150 }),
      0,
      ROOM,
    ),
  );

  // Spanning entire room exactly
  assert.doesNotThrow(() =>
    validateObstacle(validObstacle({ x: 0, y: 0, w: ROOM.width, h: ROOM.height }), 0, ROOM),
  );
});

test('boundary values: obstacle one pixel outside room edge is rejected', () => {
  // 1 pixel beyond right edge: x + w = 1921 > 1920
  assert.throws(
    () =>
      validateObstacle(
        validObstacle({ x: ROOM.width - 50, y: 100, w: 51, h: 50 }),
        4,
        ROOM,
      ),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.details?.path, 'obstacles[4].w');
      assert.match(err.message, /exceeds room width/);
      return true;
    },
  );

  // 1 pixel beyond bottom edge: y + h = 1081 > 1080
  assert.throws(
    () =>
      validateObstacle(
        validObstacle({ x: 100, y: ROOM.height - 50, w: 50, h: 51 }),
        4,
        ROOM,
      ),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.details?.path, 'obstacles[4].h');
      assert.match(err.message, /exceeds room height/);
      return true;
    },
  );
});

test('blocksAudio must be a strict boolean', () => {
  for (const bad of ['true', 'false', 1, 0, null, undefined, {}]) {
    assert.throws(
      () => validateObstacle(validObstacle({ blocksAudio: bad }), 3, ROOM),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.path, 'obstacles[3].blocksAudio');
        assert.match(err.message, /must be a boolean/);
        return true;
      },
    );
  }

  assert.doesNotThrow(() => validateObstacle(validObstacle({ blocksAudio: true }), 0, ROOM));
  assert.doesNotThrow(() => validateObstacle(validObstacle({ blocksAudio: false }), 0, ROOM));
});

test('attenuation must be a finite number in [0, 1]', () => {
  for (const bad of [-0.01, 1.01, -1, 2, NaN, Infinity, '0.5', null, undefined]) {
    assert.throws(
      () => validateObstacle(validObstacle({ attenuation: bad }), 2, ROOM),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.path, 'obstacles[2].attenuation');
        return true;
      },
    );
  }

  // Boundaries 0 and 1 are valid
  assert.doesNotThrow(() => validateObstacle(validObstacle({ attenuation: 0 }), 0, ROOM));
  assert.doesNotThrow(() => validateObstacle(validObstacle({ attenuation: 1 }), 0, ROOM));
  assert.doesNotThrow(() => validateObstacle(validObstacle({ attenuation: 0.12 }), 0, ROOM));
});

test('unknown fields in individual obstacle objects are rejected', () => {
  const obs = validObstacle({ unknownProperty: 'malicious', color: 'red' });
  assert.throws(
    () => validateObstacle(obs, 7, ROOM),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.details?.path, /^obstacles\[7\]\./);
      assert.match(err.message, /is an unknown field/);
      return true;
    },
  );
});

test('optional name and description validation', () => {
  // Valid name and description
  const valid = validateLayoutPayload(
    validPayload({ name: 'Valid Name', description: 'A short description' }),
    { room: ROOM },
  );
  assert.equal(valid.name, 'Valid Name');
  assert.equal(valid.description, 'A short description');

  // Name too long (>64)
  assert.throws(
    () => validateLayoutPayload(validPayload({ name: 'x'.repeat(65) }), { room: ROOM }),
    (err) => err instanceof ValidationError && err.details?.path === 'name',
  );

  // Description too long (>500)
  assert.throws(
    () => validateLayoutPayload(validPayload({ description: 'd'.repeat(501) }), { room: ROOM }),
    (err) => err instanceof ValidationError && err.details?.path === 'description',
  );
});
