/**
 * Mesh indicator pure helper (Day 13).
 * Computes how many remote users are within connect radius but not connected
 * due to the peer cap. No React, no DOM, no socket — pure data for tests.
 */

/**
 * @param {object} opts
 * @param {Map<string,{x:number,y:number}>|object} opts.users Map or plain object of users
 * @param {string|null} opts.selfId
 * @param {Set<string>|Array<string>} opts.connectedIds Set or array of currently connected peer ids
 * @param {number} opts.radiusPx connect radius (100 by default)
 * @returns {number} count of nearby but not connected peers
 */
export function countNearbyNotConnected({ users, selfId, connectedIds, radiusPx }) {
  if (!users || !selfId || !Number.isFinite(radiusPx)) return 0;
  const connectedSet = connectedIds instanceof Set ? connectedIds : new Set(Array.isArray(connectedIds) ? connectedIds : []);
  const self = users instanceof Map ? users.get(selfId) : users[selfId];
  if (!self || !Number.isFinite(self.x) || !Number.isFinite(self.y)) return 0;
  let count = 0;
  const entries = users instanceof Map ? users.entries() : Object.entries(users);
  for (const [id, user] of entries) {
    if (id === selfId) continue;
    if (connectedSet.has(id)) continue;
    if (!user || !Number.isFinite(user.x) || !Number.isFinite(user.y)) continue;
    const dx = user.x - self.x;
    const dy = user.y - self.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= radiusPx) count += 1;
  }
  return count;
}

export default countNearbyNotConnected;
