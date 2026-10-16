/**
 * World-state tests (Day 6). Pure data, so no React, no socket and no DOM:
 * these tests drive exactly the sequence of server events the hook feeds in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addUser,
  applyJoinedSnapshot,
  createWorldState,
  hasJoinedConnection,
  moveUser,
  removeUser,
} from '../src/realtime/worldState.js';

const room = { roomId: 'lobby', name: 'Lobby', width: 1920, height: 1080, obstacles: [] };
const person = (id, name, x = 100, y = 200) => ({ id, name, x, y });

test('a new world is empty until a snapshot arrives', () => {
  const world = createWorldState();
  assert.equal(world.room, null);
  assert.equal(world.selfId, null);
  assert.equal(world.epoch, 0);
  assert.equal(world.users.size, 0);
});

test('user:joined stores an avatar once and upserts on a repeat', () => {
  const world = createWorldState();
  assert.equal(addUser(world, person('a', 'Ada')), true);
  assert.equal(world.users.size, 1);

  // A repeated announcement must not create a second avatar: it updates the
  // one entry and snaps it to the announced position.
  world.users.get('a').x = 500;
  assert.equal(addUser(world, person('a', 'Ada', 300, 400)), true);
  assert.equal(world.users.size, 1);
  assert.deepEqual(
    { ...world.users.get('a') },
    { id: 'a', name: 'Ada', x: 300, y: 400, tx: 300, ty: 400 },
  );
});

test('junk user payloads are refused instead of drawn', () => {
  const world = createWorldState();
  for (const junk of [undefined, null, 42, 'ada', {}, { id: 7 }, { id: 'a' }, { id: 'a', x: Number.NaN, y: 1 }, { id: 'a', x: 1, y: Number.POSITIVE_INFINITY }]) {
    assert.equal(addUser(world, junk), false, JSON.stringify(junk));
  }
  assert.equal(world.users.size, 0);
});

test('user:moved only moves the target of a known avatar', () => {
  const world = createWorldState();
  addUser(world, person('a', 'Ada', 0, 0));
  assert.equal(moveUser(world, { id: 'a', x: 30, y: 40 }), true);
  const ada = world.users.get('a');
  assert.equal(ada.x, 0, 'the drawn position waits for the render loop to glide');
  assert.equal(ada.y, 0);
  assert.equal(ada.tx, 30);
  assert.equal(ada.ty, 40);
});

test('user:moved for an unknown id recovers a missed join', () => {
  const world = createWorldState();
  addUser(world, { id: 'b', name: 'Bob', x: 10, y: 10 });
  // The server only broadcasts moves inside the room, so the mover is really
  // there — storing them beats hiding a peer until their next move.
  assert.equal(moveUser(world, { id: 'c', x: 800, y: 600 }), true);
  assert.equal(world.users.size, 2);
  assert.deepEqual({ ...world.users.get('c') }, { id: 'c', name: null, x: 800, y: 600, tx: 800, ty: 600 });
});

test('user:left removes the avatar and tolerates unknown ids', () => {
  const world = createWorldState();
  addUser(world, person('a', 'Ada'));
  assert.equal(removeUser(world, { id: 'a' }), true);
  assert.equal(world.users.size, 0);
  assert.equal(removeUser(world, { id: 'a' }), false);
  assert.equal(removeUser(world, { id: 42 }), false);
  assert.equal(removeUser(world, null), false);
});

test('joined applies the snapshot, the room and the epoch', () => {
  const world = createWorldState();
  applyJoinedSnapshot(
    world,
    { selfId: 'conn-1', room, users: [person('conn-1', 'Ada'), person('conn-2', 'Bob', 700, 800)] },
    { selfId: 'conn-1', name: 'Ada' },
  );

  assert.equal(world.room, room);
  assert.equal(world.selfId, 'conn-1');
  assert.equal(world.epoch, 1);
  assert.deepEqual([...world.users.keys()], ['conn-1', 'conn-2']);
  assert.deepEqual({ ...world.users.get('conn-1') }, { id: 'conn-1', name: 'Ada', x: 100, y: 200, tx: 100, ty: 200 });

  // Every snapshot bumps the epoch, which is what makes the movement controller
  // drop held keys and stale click targets.
  applyJoinedSnapshot(world, { selfId: 'conn-1', room, users: [person('conn-1', 'Ada')] }, { selfId: 'conn-1' });
  assert.equal(world.epoch, 2);
});

test('a snapshot clears avatars that are no longer in the room', () => {
  const world = createWorldState();
  applyJoinedSnapshot(
    world,
    { selfId: 'a', room, users: [person('a', 'Ada'), person('b', 'Bob')] },
    { selfId: 'a', name: 'Ada' },
  );
  // Bob left while our connection was down: the next snapshot does not list him.
  applyJoinedSnapshot(world, { selfId: 'a', room, users: [person('a', 'Ada')] }, { selfId: 'a', name: 'Ada' });
  assert.deepEqual([...world.users.keys()], ['a']);
});

test('a name-less snapshot entry keeps the name we already know', () => {
  const world = createWorldState();
  addUser(world, person('b', 'Bob'));
  applyJoinedSnapshot(world, { selfId: 'a', room, users: [{ id: 'b', x: 5, y: 5 }, person('a', 'Ada')] }, { selfId: 'a', name: 'Ada' });
  assert.equal(world.users.get('b').name, 'Bob');
  assert.equal(world.users.get('b').x, 5, 'the server position is authoritative');
});

test('a user announced while our join was in flight survives the snapshot', () => {
  const world = createWorldState();
  const announced = new Set();
  addUser(world, person('a', 'Ada'));

  // Carol announced herself after we joined the room channel but before the
  // server's snapshot read saw her row.
  assert.equal(addUser(world, person('carol', 'Carol', 900, 100)), true);
  announced.add('carol');

  applyJoinedSnapshot(
    world,
    { selfId: 'conn-1', room, users: [person('conn-1', 'Ada'), person('b', 'Bob')] },
    { selfId: 'conn-1', name: 'Ada', announcedIds: announced },
  );

  assert.deepEqual([...world.users.keys()].sort(), ['b', 'carol', 'conn-1']);
  assert.equal(world.users.get('carol').name, 'Carol');
});

test('announcements from a previous connection do not leak into a reconnect', () => {
  const world = createWorldState();
  const announced = new Set();
  addUser(world, person('stale', 'Ghost', 1, 1));
  announced.add('stale');

  // The hook clears the announcement set when a new connection is established,
  // so a stale id cannot survive the reconnect's snapshot.
  announced.clear();
  applyJoinedSnapshot(world, { selfId: 'conn-2', room, users: [person('conn-2', 'Ada')] }, { selfId: 'conn-2', name: 'Ada', announcedIds: announced });

  assert.deepEqual([...world.users.keys()], ['conn-2']);
});

test('a user announced and then gone is not resurrected by the snapshot', () => {
  const world = createWorldState();
  const announced = new Set();
  addUser(world, person('carol', 'Carol'));
  announced.add('carol');
  removeUser(world, { id: 'carol' }); // Carol left before our snapshot landed

  applyJoinedSnapshot(world, { selfId: 'conn-1', room, users: [person('conn-1', 'Ada')] }, { selfId: 'conn-1', name: 'Ada', announcedIds: announced });
  assert.deepEqual([...world.users.keys()], ['conn-1']);
});

test('a reconnect cannot stack two avatars for one person', () => {
  const world = createWorldState();
  const announced = new Set();
  applyJoinedSnapshot(
    world,
    { selfId: 'conn-1', room, users: [person('conn-1', 'Ada'), person('bob', 'Bob')] },
    { selfId: 'conn-1', name: 'Ada', announcedIds: announced },
  );
  announced.clear(); // the reconnect starts a new connection

  // Socket.io reconnected: same person, new connection id. The peer is
  // announced again while the re-join is in flight.
  assert.equal(addUser(world, person('bob', 'Bob', 640, 480)), true);
  announced.add('bob');
  applyJoinedSnapshot(
    world,
    { selfId: 'conn-2', room, users: [person('conn-2', 'Ada'), person('bob', 'Bob', 640, 480)] },
    { selfId: 'conn-2', name: 'Ada', announcedIds: announced },
  );

  assert.equal(world.users.size, 2, `expected 2 avatars, got ${[...world.users.keys()]}`);
  assert.deepEqual([...world.users.keys()].sort(), ['bob', 'conn-2']);
  assert.equal(world.selfId, 'conn-2');
});

test('hasJoinedConnection is true only for the connection that joined', () => {
  const world = createWorldState();
  assert.equal(hasJoinedConnection(world, 'conn-1'), false, 'nothing has joined yet');
  applyJoinedSnapshot(world, { selfId: 'conn-1', room, users: [] }, { selfId: 'conn-1' });
  assert.equal(hasJoinedConnection(world, 'conn-1'), true);
  // A reconnect produces a brand new socket id, so the move gate closes again
  // until the server acknowledges the new join.
  assert.equal(hasJoinedConnection(world, 'conn-2'), false);
  assert.equal(hasJoinedConnection(world, null), false);
  assert.equal(hasJoinedConnection(null, 'conn-1'), false);
});

test('a reconnecting client never draws its own ghost avatar', () => {
  const world = createWorldState();
  const announced = new Set();
  applyJoinedSnapshot(
    world,
    { selfId: 'conn-1', room, users: [person('conn-1', 'Ada'), person('bob', 'Bob')] },
    { selfId: 'conn-1', name: 'Ada', announcedIds: announced },
  );

  // The transport died and Socket.io reconnected with a new id. The server has
  // not noticed the old socket yet (it reaps a dead transport on ping timeout),
  // so its presence row for conn-1 is still in the new snapshot — same name,
  // old id. It is this client's own previous connection, so it must be dropped.
  applyJoinedSnapshot(
    world,
    {
      selfId: 'conn-2',
      room,
      users: [person('conn-1', 'Ada', 200, 200), person('conn-2', 'Ada', 700, 700), person('bob', 'Bob')],
    },
    { selfId: 'conn-2', name: 'Ada', announcedIds: announced },
  );

  assert.deepEqual([...world.users.keys()].sort(), ['bob', 'conn-2'], 'exactly one avatar for Ada');
  assert.equal(world.selfId, 'conn-2');
});

test('the ghost rule never touches anybody else', () => {
  const world = createWorldState();
  applyJoinedSnapshot(
    world,
    { selfId: 'ada-1', room, users: [person('ada-1', 'Ada'), person('bob', 'Bob')] },
    { selfId: 'ada-1', name: 'Ada' },
  );
  // A snapshot where our own id did not change keeps every listed peer.
  applyJoinedSnapshot(
    world,
    { selfId: 'ada-1', room, users: [person('ada-1', 'Ada'), person('bob', 'Bob'), person('carol', 'Carol')] },
    { selfId: 'ada-1', name: 'Ada' },
  );
  assert.deepEqual([...world.users.keys()].sort(), ['ada-1', 'bob', 'carol']);
});

test('a delayed joined snapshot cannot resurrect a peer that already emitted user:left', () => {
  const world = createWorldState();
  addUser(world, person('departed', 'Gone'));
  removeUser(world, { id: 'departed' });
  applyJoinedSnapshot(world, {
    selfId: 'self', room, users: [person('self', 'Me'), person('departed', 'Gone')],
  }, { departedIds: new Set(['departed']) });
  assert.deepEqual([...world.users.keys()], ['self']);
});
