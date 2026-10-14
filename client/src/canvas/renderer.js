/**
 * Canvas renderer — plain functions, no React.
 *
 * Everything here takes a 2D context plus the world ref the socket hook
 * maintains, and paints one frame. The component owns the canvas, the
 * devicePixelRatio transform and the requestAnimationFrame loop; this
 * module only knows how to draw in CSS-pixel coordinates.
 */
import { computeViewport } from './coords.js';

/** Distinct colour per obstacle type, straight from the server's data. */
export const OBSTACLE_COLORS = Object.freeze({
  wall: '#8a93a6',
  desk: '#c98a3d',
  screen: '#4f8cff',
  pillar: '#9b7bea',
  plant: '#4caf7d',
});

const OBSTACLE_FALLBACK = '#6b7280';
const GRID_STEP_WORLD = 120; // px on the room plane between grid lines

export function obstacleColor(type) {
  return OBSTACLE_COLORS[type] ?? OBSTACLE_FALLBACK;
}

/**
 * Draw the static room: letterbox backdrop, floor, light grid and
 * obstacles. Avatar rendering is layered on top by drawWorld (Day 4,
 * next commit) — this function is the room without people.
 *
 * @param {CanvasRenderingContext2D} ctx context already scaled for DPR
 * @param {{ room: object|null }} world world ref contents
 * @param {{ width: number, height: number }} size canvas size in CSS pixels
 * @returns the viewport used, or null when there is nothing to draw
 */
export function drawRoom(ctx, world, size) {
  const { width, height } = size;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, width, height);

  const room = world?.room;
  if (!room) return null;

  const viewport = computeViewport(room.width, room.height, width, height);
  // Screen-space floor origin; computed arithmetically (not via
  // worldToScreen) so a frame allocates no per-line/per-obstacle objects.
  const { offsetX, offsetY, scale } = viewport;

  // Floor.
  ctx.fillStyle = '#151c2e';
  ctx.fillRect(offsetX, offsetY, viewport.drawnWidth, viewport.drawnHeight);

  // Light grid inside the floor only.
  ctx.strokeStyle = 'rgba(163, 179, 214, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = GRID_STEP_WORLD; x < room.width; x += GRID_STEP_WORLD) {
    const screenX = offsetX + x * scale;
    ctx.moveTo(screenX, offsetY);
    ctx.lineTo(screenX, offsetY + viewport.drawnHeight);
  }
  for (let y = GRID_STEP_WORLD; y < room.height; y += GRID_STEP_WORLD) {
    const screenY = offsetY + y * scale;
    ctx.moveTo(offsetX, screenY);
    ctx.lineTo(offsetX + viewport.drawnWidth, screenY);
  }
  ctx.stroke();

  // Floor border so the room edge reads against the letterbox bands.
  ctx.strokeStyle = 'rgba(229, 233, 240, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(offsetX, offsetY, viewport.drawnWidth, viewport.drawnHeight);

  // Obstacles: server data only ({ id, type, x, y, w, h, ... }), painted
  // in room coordinates so the layout matches every other client.
  for (const obstacle of room.obstacles ?? []) {
    const left = offsetX + obstacle.x * scale;
    const top = offsetY + obstacle.y * scale;
    const w = obstacle.w * scale;
    const h = obstacle.h * scale;
    ctx.fillStyle = obstacleColor(obstacle.type);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(left, top, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(5, 7, 13, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, w, h);

    if (scale > 0.25) {
      ctx.fillStyle = 'rgba(229, 233, 240, 0.75)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(obstacle.type ?? ''), left + 3, top - 2);
    }
  }

  return viewport;
}

export default drawRoom;

/** Stable per-user colour so the same avatar looks the same in every tab. */
const AVATAR_PALETTE = ['#4f8cff', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee', '#fb7185', '#a3e635'];

/**
 * Reused for every avatar, every frame: the render loop must not allocate
 * per entity (the same rule the room painter follows).
 */
const scratchCentre = { x: 0, y: 0 };

export function avatarColor(user) {
  const key = String(user?.id ?? user?.name ?? '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

/** Display label: server name when known, else a short stable id tag. */
export function avatarLabel(user, selfId) {
  if (user?.name) return user.name;
  if (user?.id && user.id === selfId) return 'you';
  return user?.id ? `user-${String(user.id).slice(0, 4)}` : 'guest';
}

/** Cap on drawn label length: server names run to 24 chars, plus " (you)". */
export const MAX_AVATAR_LABEL_CHARS = 18;

/** Truncate a drawn label with an ellipsis so long names cannot sprawl. */
export function truncateLabel(text, maxChars = MAX_AVATAR_LABEL_CHARS) {
  const value = String(text ?? '');
  return value.length > maxChars ? `${value.slice(0, Math.max(1, maxChars - 1))}…` : value;
}

/**
 * Draw every avatar in the world ref as a labelled circle. The local
 * user (world.selfId) is highlighted with a bright fill, a white ring
 * and a "you" tag, so you can find yourself among the crowd.
 */
export function drawAvatars(ctx, world, viewport) {
  if (!world || !viewport) return;
  const radius = Math.max(7, 18 * viewport.scale);

  for (const user of world.users.values()) {
    if (!Number.isFinite(user?.x) || !Number.isFinite(user?.y)) continue;
    const centre = scratchCentre;
    centre.x = viewport.offsetX + user.x * viewport.scale;
    centre.y = viewport.offsetY + user.y * viewport.scale;
    const isSelf = user.id === world.selfId;
    const label = avatarLabel(user, world.selfId);

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isSelf ? '#ffd166' : avatarColor(user);
    ctx.fill();

    ctx.lineWidth = isSelf ? 3 : 1.5;
    ctx.strokeStyle = isSelf ? '#ffffff' : 'rgba(5, 7, 13, 0.65)';
    ctx.stroke();

    if (isSelf) {
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Initial inside the circle.
    ctx.fillStyle = isSelf ? '#1a1405' : '#0b1020';
    ctx.font = `700 ${Math.max(10, radius)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.slice(0, 1).toUpperCase(), centre.x, centre.y + 0.5);

    // Name label above the avatar (with a " (you)" marker for self).
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const text = truncateLabel(isSelf ? `${label} (you)` : label);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5, 7, 13, 0.8)';
    ctx.strokeText(text, centre.x, centre.y - radius - 6);
    ctx.fillStyle = '#e5e9f0';
    ctx.fillText(text, centre.x, centre.y - radius - 6);
  }
}

/** One full frame: room first, then the people in it. */
export function drawWorld(ctx, world, size) {
  const viewport = drawRoom(ctx, world, size);
  if (viewport) drawAvatars(ctx, world, viewport);
  return viewport;
}
