/**
 * Canvas renderer — plain functions, no React.
 *
 * Week 3 (Day 18) splits rendering into:
 *  - `drawStatic(ctx, view, room)`: letterbox backdrop, floor, grid, room
 *    border and obstacles — built onto an offscreen canvas (`staticLayer.js`)
 *    only when size, DPR, room id or `layoutRevision` changes.
 *  - `drawDynamic(ctx, view, world, labelCache)`: avatars, the local highlight
 *    ring, initials and cached truncated name labels — painted every frame on
 *    top of a single `ctx.drawImage(staticCanvas, ...)` blit (`drawFrame`).
 *  - `drawRoom`, `drawAvatars` and `drawWorld` remain as compositions for
 *    compatibility and tests.
 */
import { updateViewport } from './coords.js';

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
const LABEL_FONT = '12px system-ui, sans-serif';
const OBSTACLE_LABEL_FONT = '10px system-ui, sans-serif';
const TWO_PI = Math.PI * 2;

export function obstacleColor(type) {
  return OBSTACLE_COLORS[type] ?? OBSTACLE_FALLBACK;
}

/**
 * Reused viewport scratch object when a caller passes `{ width, height }`
 * instead of a pre-populated view object.
 */
const scratchViewport = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  drawnWidth: 0,
  drawnHeight: 0,
  roomWidth: 0,
  roomHeight: 0,
  canvasWidth: 0,
  canvasHeight: 0,
};

function copyViewport(vp) {
  return {
    scale: vp.scale,
    offsetX: vp.offsetX,
    offsetY: vp.offsetY,
    drawnWidth: vp.drawnWidth,
    drawnHeight: vp.drawnHeight,
    roomWidth: vp.roomWidth,
    roomHeight: vp.roomHeight,
    canvasWidth: vp.canvasWidth,
    canvasHeight: vp.canvasHeight,
  };
}

function resolveViewViewport(view, room) {
  const width = view.width ?? view.canvasWidth;
  const height = view.height ?? view.canvasHeight;
  if (
    typeof view.scale === 'number'
    && view.roomWidth === room.width
    && view.roomHeight === room.height
    && view.canvasWidth === width
    && view.canvasHeight === height
  ) {
    return view;
  }
  return updateViewport(scratchViewport, room.width, room.height, width, height);
}

/**
 * Draw everything that does NOT move per frame: letterbox backdrop, room floor,
 * grid lines, room border, obstacles and obstacle type labels.
 *
 * Issues the exact same 2D context operations in the exact same order as the
 * pre-Day-18 `drawRoom` path, without per-frame array/object allocations.
 *
 * @param {CanvasRenderingContext2D} ctx context already scaled for DPR
 * @param {{ width?: number, height?: number, canvasWidth?: number, canvasHeight?: number }} view
 * @param {object|null} room room blueprint or null
 * @returns {object|null} viewport metrics used, or null when `room` is absent
 */
export function drawStatic(ctx, view, room) {
  const width = view?.width ?? view?.canvasWidth ?? 0;
  const height = view?.height ?? view?.canvasHeight ?? 0;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, width, height);

  if (!room) return null;

  const viewport = resolveViewViewport(view, room);
  const { offsetX, offsetY, scale, drawnWidth, drawnHeight } = viewport;

  // Floor.
  ctx.fillStyle = '#151c2e';
  ctx.fillRect(offsetX, offsetY, drawnWidth, drawnHeight);

  // Light grid inside the floor only.
  ctx.strokeStyle = 'rgba(163, 179, 214, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = GRID_STEP_WORLD; x < room.width; x += GRID_STEP_WORLD) {
    const screenX = offsetX + x * scale;
    ctx.moveTo(screenX, offsetY);
    ctx.lineTo(screenX, offsetY + drawnHeight);
  }
  for (let y = GRID_STEP_WORLD; y < room.height; y += GRID_STEP_WORLD) {
    const screenY = offsetY + y * scale;
    ctx.moveTo(offsetX, screenY);
    ctx.lineTo(offsetX + drawnWidth, screenY);
  }
  ctx.stroke();

  // Floor border so the room edge reads against the letterbox bands.
  ctx.strokeStyle = 'rgba(229, 233, 240, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(offsetX, offsetY, drawnWidth, drawnHeight);

  // Obstacles: server data only ({ id, type, x, y, w, h, ... }), painted
  // in room coordinates so the layout matches every other client.
  const obstacles = room.obstacles;
  if (Array.isArray(obstacles)) {
    for (let i = 0; i < obstacles.length; i += 1) {
      const obstacle = obstacles[i];
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
        ctx.font = OBSTACLE_LABEL_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const label = typeof obstacle.type === 'string' ? obstacle.type : String(obstacle.type ?? '');
        ctx.fillText(label, left + 3, top - 2);
      }
    }
  }

  return viewport;
}

/**
 * Compatibility wrapper: draw the static room from `(ctx, world, size)` and
 * return an independent viewport object (or null when `world.room` is null).
 */
export function drawRoom(ctx, world, size) {
  if (!size) return null;
  const vp = drawStatic(ctx, size, world?.room ?? null);
  return vp ? copyViewport(vp) : null;
}

export default drawRoom;

/** Stable per-user colour so the same avatar looks the same in every tab. */
const AVATAR_PALETTE = ['#4f8cff', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee', '#fb7185', '#a3e635'];

/**
 * Reused for every avatar, every frame: the render loop must not allocate
 * per entity (the same rule the room painter follows).
 */
const scratchCentre = { x: 0, y: 0 };

/** Uncached fallback scratch entry for synthetic test users without a string id. */
const scratchAnonEntry = {
  rawName: null,
  isSelf: false,
  color: '#4f8cff',
  initial: 'G',
  text: 'guest',
  measuredFont: '',
  measuredWidth: -1,
  seenTag: 0,
};

/** Cached avatar-initial font string, recomputed only when viewport scale changes. */
let cachedInitialFontScale = -1;
let cachedInitialFont = '';

function initialFontFor(scale, radius) {
  if (scale !== cachedInitialFontScale) {
    cachedInitialFontScale = scale;
    cachedInitialFont = `700 ${Math.max(10, radius)}px system-ui, sans-serif`;
  }
  return cachedInitialFont;
}

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

function populateLabelEntry(entry, user, selfId, isSelf, rawName) {
  const label = avatarLabel(user, selfId);
  entry.rawName = rawName;
  entry.isSelf = isSelf;
  entry.color = isSelf ? '#ffd166' : avatarColor(user);
  entry.initial = label.slice(0, 1).toUpperCase();
  entry.text = truncateLabel(isSelf ? `${label} (you)` : label);
  entry.measuredFont = '';
  entry.measuredWidth = -1;
  return entry;
}

/**
 * Per-user avatar label & colour cache keyed by `user.id`.
 *
 * Truncates each avatar's label once per `(userId, name, isSelf)` and caches
 * optional text-width measurements on the same entry. Departed users are pruned
 * automatically at the end of `drawDynamic` whenever `size !== seenCount` (zero
 * overhead on steady frames where nobody left) and via `prune(users)` / `delete`.
 */
export function createLabelCache() {
  const map = new Map();
  let frameTag = 0;
  let computeCount = 0;

  return {
    get size() {
      return map.size;
    },

    get computeCount() {
      return computeCount;
    },

    has(userId) {
      return map.has(userId);
    },

    get(userId) {
      return map.get(userId);
    },

    delete(userId) {
      return map.delete(userId);
    },

    clear() {
      map.clear();
    },

    /** Prune any cached entry whose key is no longer present in `users` (a Map). */
    prune(users) {
      if (!users || users.size === 0) {
        map.clear();
        return;
      }
      for (const id of map.keys()) {
        if (!users.has(id)) map.delete(id);
      }
    },

    /** Advance and return the next monotonic frame tag for mark-and-prune. */
    nextFrameTag() {
      frameTag += 1;
      if (frameTag >= Number.MAX_SAFE_INTEGER) {
        frameTag = 1;
        for (const entry of map.values()) entry.seenTag = 0;
      }
      return frameTag;
    },

    /**
     * Return cached `{ color, initial, text }` for `user`, recomputing only
     * when `(userId, name, isSelf)` is new or changed.
     */
    resolve(user, selfId) {
      const id = user?.id;
      const isSelf = Boolean(id && id === selfId);
      const rawName = user?.name ? String(user.name) : null;

      if (typeof id !== 'string' || id.length === 0) {
        computeCount += 1;
        return populateLabelEntry(scratchAnonEntry, user, selfId, isSelf, rawName);
      }

      let entry = map.get(id);
      if (!entry) {
        computeCount += 1;
        entry = populateLabelEntry(
          {
            rawName: null,
            isSelf: false,
            color: '',
            initial: '',
            text: '',
            measuredFont: '',
            measuredWidth: -1,
            seenTag: 0,
          },
          user,
          selfId,
          isSelf,
          rawName,
        );
        map.set(id, entry);
        return entry;
      }

      if (entry.rawName !== rawName || entry.isSelf !== isSelf) {
        computeCount += 1;
        populateLabelEntry(entry, user, selfId, isSelf, rawName);
      }
      return entry;
    },

    /**
     * Cache `ctx.measureText(entry.text).width` on `entry` for `font` when text
     * width is requested, avoiding repeated `measureText` calls across frames.
     */
    measureWidth(ctx, entry, font = LABEL_FONT) {
      if (!entry) return 0;
      if (entry.measuredWidth >= 0 && entry.measuredFont === font) {
        return entry.measuredWidth;
      }
      if (typeof ctx?.measureText !== 'function') return 0;
      ctx.font = font;
      const width = Number(ctx.measureText(entry.text)?.width) || 0;
      entry.measuredFont = font;
      entry.measuredWidth = width;
      return width;
    },

    /**
     * O(1) steady-state sweep: when nobody left since the last frame
     * (`map.size === seenCount`), returns immediately without iterating.
     */
    finishFrame(tag, seenCount) {
      if (seenCount === 0) {
        if (map.size > 0) map.clear();
        return;
      }
      if (map.size === seenCount) return;
      for (const [id, entry] of map) {
        if (entry.seenTag !== tag) map.delete(id);
      }
    },
  };
}

export const defaultLabelCache = createLabelCache();

function resolveDynamicViewport(view, world) {
  if (!view) return null;
  if (typeof view.scale === 'number') {
    const room = world?.room;
    const width = view.width ?? view.canvasWidth;
    const height = view.height ?? view.canvasHeight;
    if (
      !room
      || (
        view.roomWidth === room.width
        && view.roomHeight === room.height
        && view.canvasWidth === width
        && view.canvasHeight === height
      )
    ) {
      return view;
    }
  }
  const room = world?.room;
  if (!room) return null;
  const width = view.width ?? view.canvasWidth;
  const height = view.height ?? view.canvasHeight;
  if (!(width > 0) || !(height > 0)) return null;
  return updateViewport(scratchViewport, room.width, room.height, width, height);
}

/**
 * Draw everything that moves per frame: avatar circles, the local highlight
 * ring, avatar initials and cached truncated name labels.
 *
 * Allocates zero objects, arrays, closures or strings on steady-state frames.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view viewport or `{ width, height }` size
 * @param {object} world world state `{ room, users, selfId }`
 * @param {ReturnType<typeof createLabelCache>} [labelCache]
 */
export function drawDynamic(ctx, view, world, labelCache = defaultLabelCache) {
  if (!world || !view || !world.users) return;
  const viewport = resolveDynamicViewport(view, world);
  if (!viewport) return;

  const { offsetX, offsetY, scale } = viewport;
  const radius = Math.max(7, 18 * scale);
  const initialFont = initialFontFor(scale, radius);
  const selfId = world.selfId;

  const tag = labelCache.nextFrameTag();
  let seenCount = 0;

  for (const user of world.users.values()) {
    const hasStringId = typeof user?.id === 'string' && user.id.length > 0;
    if (!Number.isFinite(user?.x) || !Number.isFinite(user?.y)) continue;

    const entry = labelCache.resolve(user, selfId);
    if (hasStringId && entry.seenTag !== tag) {
      entry.seenTag = tag;
      seenCount += 1;
    }

    const centre = scratchCentre;
    centre.x = offsetX + user.x * scale;
    centre.y = offsetY + user.y * scale;
    const isSelf = entry.isSelf;

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, TWO_PI);
    ctx.fillStyle = entry.color;
    ctx.fill();

    ctx.lineWidth = isSelf ? 3 : 1.5;
    ctx.strokeStyle = isSelf ? '#ffffff' : 'rgba(5, 7, 13, 0.65)';
    ctx.stroke();

    if (isSelf) {
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius + 5, 0, TWO_PI);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Initial inside the circle.
    ctx.fillStyle = isSelf ? '#1a1405' : '#0b1020';
    ctx.font = initialFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(entry.initial, centre.x, centre.y + 0.5);

    // Name label above the avatar (with a " (you)" marker for self).
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5, 7, 13, 0.8)';
    ctx.strokeText(entry.text, centre.x, centre.y - radius - 6);
    ctx.fillStyle = '#e5e9f0';
    ctx.fillText(entry.text, centre.x, centre.y - radius - 6);
  }

  labelCache.finishFrame(tag, seenCount);
}

/** Compatibility alias for `drawDynamic(ctx, viewport, world)`. */
export function drawAvatars(ctx, world, viewport) {
  drawDynamic(ctx, viewport, world, defaultLabelCache);
}

/**
 * Per-frame cached path: ensure the static offscreen layer, blit it with ONE
 * `drawImage`, then paint dynamic avatars on top.
 */
export function drawFrame(ctx, staticLayer, view, world, labelCache = defaultLabelCache) {
  const room = world?.room ?? null;
  const layerCanvas = staticLayer.ensure(view, room);
  ctx.drawImage(layerCanvas, 0, 0, view.width, view.height);

  if (!room) {
    if (labelCache.size > 0) labelCache.clear();
    return;
  }

  if (
    view.roomWidth !== room.width
    || view.roomHeight !== room.height
    || view.canvasWidth !== view.width
    || view.canvasHeight !== view.height
  ) {
    updateViewport(view, room.width, room.height, view.width, view.height);
  }

  drawDynamic(ctx, view, world, labelCache);
}

/** One full uncached frame composition, kept for compatibility and tests. */
export function drawWorld(ctx, world, size) {
  const vp = drawRoom(ctx, world, size);
  if (vp) drawDynamic(ctx, vp, world, defaultLabelCache);
  return vp;
}
