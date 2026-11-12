/**
 * Realistic 2.5D / 3D-extruded architectural room & animated human avatar
 * renderer for browser CanvasRenderingContext2D.
 *
 * - `drawRealisticStatic(ctx, viewport, room, width, height)` renders onto the
 *   offscreen `staticLayer` canvas ONCE per room/layout/resize, so rich 3D
 *   furniture, wood parquet planks, rugs, lighting, shadows, monitors, chairs,
 *   plants and walls have zero per-frame CPU cost.
 * - `drawRealisticDynamic(ctx, viewport, world, labelCache)` renders animated
 *   human avatars (head, hair, eyes, headset, torso, swinging arms, stepping
 *   feet), 3D proximity sonar fields, and live acoustic wave tethers at 60 FPS.
 */
import { transmissionBetween, prepareObstacles } from '../audio/occlusion.js';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

const ROOM_THEMES = Object.freeze({
  lobby: {
    floorBase: '#1b2234',
    floorPlankA: 'rgba(255, 214, 165, 0.045)',
    floorPlankB: 'rgba(15, 23, 42, 0.22)',
    gridMajor: 'rgba(148, 163, 184, 0.11)',
    gridMinor: 'rgba(148, 163, 184, 0.04)',
    wallOuter: '#27324a',
    wallTrim: '#64748b',
    accentGlow: 'rgba(79, 140, 255, 0.16)',
    warmLight: 'rgba(251, 191, 36, 0.11)',
    rugPrimary: '#1e3a5f',
    rugSecondary: '#3b2d54',
    rugBorder: '#f59e0b',
  },
  studio: {
    floorBase: '#151928',
    floorPlankA: 'rgba(168, 85, 247, 0.05)',
    floorPlankB: 'rgba(10, 12, 22, 0.28)',
    gridMajor: 'rgba(192, 132, 252, 0.11)',
    gridMinor: 'rgba(192, 132, 252, 0.04)',
    wallOuter: '#231f3a',
    wallTrim: '#8b5cf6',
    accentGlow: 'rgba(168, 85, 247, 0.18)',
    warmLight: 'rgba(236, 72, 153, 0.11)',
    rugPrimary: '#311b47',
    rugSecondary: '#1f2942',
    rugBorder: '#ec4899',
  },
  lounge: {
    floorBase: '#1c2430',
    floorPlankA: 'rgba(251, 191, 36, 0.055)',
    floorPlankB: 'rgba(12, 18, 28, 0.24)',
    gridMajor: 'rgba(167, 243, 208, 0.10)',
    gridMinor: 'rgba(167, 243, 208, 0.04)',
    wallOuter: '#22333b',
    wallTrim: '#10b981',
    accentGlow: 'rgba(16, 185, 129, 0.16)',
    warmLight: 'rgba(245, 158, 11, 0.13)',
    rugPrimary: '#1b3b36',
    rugSecondary: '#3a2a29',
    rugBorder: '#34d399',
  },
});

const SKIN_TONES = ['#f5cba7', '#e8b48a', '#d49a6a', '#f7d7b5', '#c68652', '#f0c097'];
const HAIR_COLORS = ['#1e293b', '#3e2723', '#4a3525', '#111827', '#5d4037', '#27272a'];

function pickFromPalette(palette, key) {
  let h = 2166136261 >>> 0;
  const s = String(key ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return palette[h % palette.length];
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawAreaRug(ctx, x, y, w, h, fillColor, borderColor, scale) {
  ctx.save();
  // Soft rug shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
  roundedRectPath(ctx, x + 3 * scale, y + 4 * scale, w, h, 10 * scale);
  ctx.fill();

  // Rug body
  ctx.fillStyle = fillColor;
  roundedRectPath(ctx, x, y, w, h, 10 * scale);
  ctx.fill();

  // Inner decorative border
  const inset = Math.max(3, 8 * scale);
  ctx.strokeStyle = borderColor;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = Math.max(1, 1.8 * scale);
  roundedRectPath(ctx, x + inset, y + inset, w - inset * 2, h - inset * 2, 6 * scale);
  ctx.stroke();

  // Subtle geometric center diamond
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = borderColor;
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const rx = Math.min(w, h) * 0.18;
  const ry = Math.min(w, h) * 0.11;
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry);
  ctx.lineTo(cx + rx, cy);
  ctx.lineTo(cx, cy + ry);
  ctx.lineTo(cx - rx, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawChair(ctx, cx, cy, radius, facingAngle, scale) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(facingAngle);

  // Chair floor shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.arc(1.5 * scale, 2.5 * scale, radius * 1.05, 0, TWO_PI);
  ctx.fill();

  // 5-star caster spokes
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = Math.max(1, 1.5 * scale);
  for (let i = 0; i < 5; i += 1) {
    const a = (i * TWO_PI) / 5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * radius * 0.95, Math.sin(a) * radius * 0.95);
    ctx.stroke();
  }

  // Seat cushion
  const seatGrad = ctx.createRadialGradient(-radius * 0.2, -radius * 0.2, radius * 0.1, 0, 0, radius);
  seatGrad.addColorStop(0, '#334155');
  seatGrad.addColorStop(1, '#1e293b');
  ctx.fillStyle = seatGrad;
  roundedRectPath(ctx, -radius * 0.82, -radius * 0.82, radius * 1.64, radius * 1.64, radius * 0.45);
  ctx.fill();
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = Math.max(0.8, 1 * scale);
  ctx.stroke();

  // Armrests (left & right)
  ctx.fillStyle = '#0f172a';
  roundedRectPath(ctx, -radius * 0.98, -radius * 0.45, radius * 0.24, radius * 0.9, radius * 0.1);
  ctx.fill();
  roundedRectPath(ctx, radius * 0.74, -radius * 0.45, radius * 0.24, radius * 0.9, radius * 0.1);
  ctx.fill();

  // Curved ergonomic backrest (at the back = -y in local chair coords)
  ctx.fillStyle = '#0f172a';
  roundedRectPath(ctx, -radius * 0.78, -radius * 1.02, radius * 1.56, radius * 0.36, radius * 0.18);
  ctx.fill();
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = Math.max(0.7, 0.9 * scale);
  ctx.stroke();

  ctx.restore();
}

function drawRealisticDesk(ctx, left, top, w, h, scale) {
  ctx.save();
  const depth = Math.max(3, 8 * scale);
  const corner = Math.max(2, 5 * scale);
  const isHorizontal = w >= h;

  // 1. Ergonomic chairs tucked around the desk
  const chairR = Math.max(5, Math.min(w, h) * 0.24);
  if (isHorizontal) {
    // Two chairs on the top side facing down, one on the bottom facing up
    drawChair(ctx, left + w * 0.28, top - chairR * 0.55, chairR, 0, scale);
    drawChair(ctx, left + w * 0.72, top - chairR * 0.55, chairR, 0, scale);
    drawChair(ctx, left + w * 0.5, top + h + chairR * 0.65, chairR, Math.PI, scale);
  } else {
    drawChair(ctx, left - chairR * 0.55, top + h * 0.3, chairR, -HALF_PI, scale);
    drawChair(ctx, left + w + chairR * 0.55, top + h * 0.7, chairR, HALF_PI, scale);
  }

  // 2. Soft floor drop shadow under the table
  ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
  roundedRectPath(ctx, left + 4 * scale, top + 6 * scale, w, h + depth * 0.6, corner);
  ctx.fill();

  // 3. 3D front thickness skirt (dark walnut edge)
  ctx.fillStyle = '#5c3418';
  roundedRectPath(ctx, left, top + depth * 0.5, w, h, corner);
  ctx.fill();

  // Metallic corner legs peeking at bottom corners
  ctx.fillStyle = '#334155';
  const legW = Math.max(2, 4 * scale);
  ctx.fillRect(left + 3 * scale, top + h, legW, depth * 0.65);
  ctx.fillRect(left + w - 7 * scale, top + h, legW, depth * 0.65);

  // 4. Rich 3D Hardwood Tabletop
  const woodGrad = ctx.createLinearGradient(left, top, left + w, top + h);
  woodGrad.addColorStop(0, '#d99b52');
  woodGrad.addColorStop(0.5, '#b87632');
  woodGrad.addColorStop(1, '#8f551e');
  ctx.fillStyle = woodGrad;
  roundedRectPath(ctx, left, top, w, h, corner);
  ctx.fill();

  // Wood plank grain lines across tabletop
  ctx.strokeStyle = 'rgba(67, 35, 12, 0.24)';
  ctx.lineWidth = Math.max(0.6, 0.9 * scale);
  const planks = 4;
  for (let p = 1; p < planks; p += 1) {
    const py = top + (h * p) / planks;
    ctx.beginPath();
    ctx.moveTo(left + 3 * scale, py);
    ctx.lineTo(left + w - 3 * scale, py);
    ctx.stroke();
  }

  // Top bevel highlight
  ctx.strokeStyle = 'rgba(255, 235, 200, 0.45)';
  ctx.lineWidth = Math.max(0.8, 1.2 * scale);
  roundedRectPath(ctx, left + 0.5, top + 0.5, w - 1, h - 1, corner);
  ctx.stroke();

  // 5. Realistic Desk Items (when scale is large enough to see)
  if (scale > 0.22 && w > 24 * scale && h > 16 * scale) {
    // Dark slate desk mat
    const matW = w * 0.44;
    const matH = h * 0.52;
    const matX = left + w * 0.16;
    const matY = top + h * 0.24;
    ctx.fillStyle = '#1e293b';
    roundedRectPath(ctx, matX, matY, matW, matH, 2.5 * scale);
    ctx.fill();

    // Widescreen Monitor with glowing cyan/blue display
    const monW = Math.min(w * 0.34, 48 * scale);
    const monH = Math.max(3 * scale, h * 0.14);
    const monX = matX + (matW - monW) * 0.5;
    const monY = top + h * 0.14;
    // Screen glow on tabletop
    const screenGlow = ctx.createRadialGradient(
      monX + monW * 0.5,
      monY + monH,
      1 * scale,
      monX + monW * 0.5,
      monY + monH + 12 * scale,
      22 * scale,
    );
    screenGlow.addColorStop(0, 'rgba(56, 189, 248, 0.38)');
    screenGlow.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.fillStyle = screenGlow;
    ctx.fillRect(matX - 6 * scale, monY, matW + 12 * scale, h * 0.55);

    // Monitor stand + bezel
    ctx.fillStyle = '#64748b';
    ctx.fillRect(monX + monW * 0.42, monY - 2 * scale, monW * 0.16, 3 * scale);
    ctx.fillStyle = '#0f172a';
    roundedRectPath(ctx, monX, monY, monW, monH, 1.5 * scale);
    ctx.fill();
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(monX + 1.5 * scale, monY + 1 * scale, monW - 3 * scale, Math.max(1.5, monH * 0.45));

    // Mechanical Keyboard
    const kbW = monW * 0.68;
    const kbH = Math.max(3 * scale, h * 0.18);
    const kbX = matX + (matW - kbW) * 0.42;
    const kbY = matY + matH * 0.46;
    ctx.fillStyle = '#cbd5e1';
    roundedRectPath(ctx, kbX, kbY, kbW, kbH, 1.2 * scale);
    ctx.fill();
    ctx.fillStyle = '#334155';
    ctx.fillRect(kbX + 1.5 * scale, kbY + 1.2 * scale, kbW - 3 * scale, kbH - 2.4 * scale);

    // Wireless Mouse
    const mouseX = kbX + kbW + 3.5 * scale;
    const mouseY = kbY + kbH * 0.15;
    ctx.fillStyle = '#e2e8f0';
    roundedRectPath(ctx, mouseX, mouseY, Math.max(2, 3.8 * scale), Math.max(3, 5.5 * scale), 1.8 * scale);
    ctx.fill();

    // Notepad & Pen on right side of desk
    const padX = left + w * 0.67;
    const padY = top + h * 0.28;
    ctx.fillStyle = '#fef3c7';
    roundedRectPath(ctx, padX, padY, Math.max(4, 14 * scale), Math.max(5, 18 * scale), 1.2 * scale);
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = Math.max(0.5, 0.7 * scale);
    ctx.beginPath();
    ctx.moveTo(padX + 2 * scale, padY + 5 * scale);
    ctx.lineTo(padX + 11 * scale, padY + 5 * scale);
    ctx.moveTo(padX + 2 * scale, padY + 9 * scale);
    ctx.lineTo(padX + 10 * scale, padY + 9 * scale);
    ctx.stroke();

    // Coffee Mug (white ceramic rim + dark espresso)
    const mugX = left + w * 0.84;
    const mugY = top + h * 0.68;
    const mugR = Math.max(2.2, 4.5 * scale);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.arc(mugX + 1 * scale, mugY + 1.5 * scale, mugR * 1.1, 0, TWO_PI);
    ctx.fill();
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.arc(mugX, mugY, mugR, 0, TWO_PI);
    ctx.fill();
    ctx.fillStyle = '#3e2723';
    ctx.beginPath();
    ctx.arc(mugX, mugY, mugR * 0.68, 0, TWO_PI);
    ctx.fill();

    // Warm Golden Desk Lamp in top-right corner
    const lampX = left + w * 0.88;
    const lampY = top + h * 0.22;
    const lampGlow = ctx.createRadialGradient(lampX, lampY, 1 * scale, lampX, lampY, 24 * scale);
    lampGlow.addColorStop(0, 'rgba(251, 191, 36, 0.42)');
    lampGlow.addColorStop(1, 'rgba(251, 191, 36, 0)');
    ctx.fillStyle = lampGlow;
    ctx.beginPath();
    ctx.arc(lampX, lampY, 24 * scale, 0, TWO_PI);
    ctx.fill();
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(lampX, lampY, Math.max(2.2, 4.5 * scale), 0, TWO_PI);
    ctx.fill();
  }

  ctx.restore();
}

function drawRealisticWall(ctx, left, top, w, h, scale) {
  ctx.save();
  const extrude = Math.max(4, 11 * scale);

  // 1. Directional acoustic & physical shadow on floor
  const shadowGrad = ctx.createLinearGradient(left, top, left + w + 18 * scale, top + h + 14 * scale);
  shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.58)');
  shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = shadowGrad;
  roundedRectPath(ctx, left + 4 * scale, top + 5 * scale, w + 12 * scale, h + 10 * scale, 4 * scale);
  ctx.fill();

  // 2. Base wall footprint (dark slate concrete)
  ctx.fillStyle = '#334155';
  roundedRectPath(ctx, left, top, w, h, 3 * scale);
  ctx.fill();

  // 3. 3D Top Cap shifted upward by `extrude` to give 2.5D height
  const capTop = top - extrude * 0.55;
  // Front/bottom face connecting cap to footprint
  const frontGrad = ctx.createLinearGradient(left, capTop + h, left, top + h);
  frontGrad.addColorStop(0, '#475569');
  frontGrad.addColorStop(1, '#1e293b');
  ctx.fillStyle = frontGrad;
  ctx.fillRect(left, capTop + h - 2 * scale, w, extrude * 0.55 + 2 * scale);

  // Top architectural cap surface
  const capGrad = ctx.createLinearGradient(left, capTop, left + w, capTop + h);
  capGrad.addColorStop(0, '#cbd5e1');
  capGrad.addColorStop(0.5, '#94a3b8');
  capGrad.addColorStop(1, '#64748b');
  ctx.fillStyle = capGrad;
  roundedRectPath(ctx, left, capTop, w, h, 3 * scale);
  ctx.fill();

  // Acoustic wood/metal slat ribs along the wall cap
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.35)';
  ctx.lineWidth = Math.max(0.8, 1.2 * scale);
  const step = Math.max(5, 14 * scale);
  if (h >= w) {
    for (let y = capTop + step; y < capTop + h - step * 0.5; y += step) {
      ctx.beginPath();
      ctx.moveTo(left + 3 * scale, y);
      ctx.lineTo(left + w - 3 * scale, y);
      ctx.stroke();
    }
  } else {
    for (let x = left + step; x < left + w - step * 0.5; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, capTop + 3 * scale);
      ctx.lineTo(x, capTop + h - 3 * scale);
      ctx.stroke();
    }
  }

  // Specular top border
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.65)';
  ctx.lineWidth = Math.max(1, 1.4 * scale);
  roundedRectPath(ctx, left + 0.5, capTop + 0.5, w - 1, h - 1, 3 * scale);
  ctx.stroke();

  ctx.restore();
}

function drawRealisticScreen(ctx, left, top, w, h, scale) {
  ctx.save();
  // 1. Ambient cyan/blue light cone cast onto the floor
  const cx = left + w * 0.5;
  const cy = top + h * 0.5;
  const glowR = Math.max(w, h) * 0.65;
  const glow = ctx.createRadialGradient(cx, cy, 2 * scale, cx, cy + 16 * scale, glowR);
  glow.addColorStop(0, 'rgba(56, 189, 248, 0.36)');
  glow.addColorStop(0.5, 'rgba(79, 140, 255, 0.14)');
  glow.addColorStop(1, 'rgba(79, 140, 255, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy + 10 * scale, glowR, 0, TWO_PI);
  ctx.fill();

  // 2. Floor shadow & metallic stand feet
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  roundedRectPath(ctx, left + 2 * scale, top + 3 * scale, w, h + 4 * scale, 3 * scale);
  ctx.fill();

  // 3. 3D Display chassis & glowing glass panel
  ctx.fillStyle = '#0f172a';
  roundedRectPath(ctx, left, top - 3 * scale, w, h + 3 * scale, 3 * scale);
  ctx.fill();

  const panelGrad = ctx.createLinearGradient(left, top, left + w, top + h);
  panelGrad.addColorStop(0, '#38bdf8');
  panelGrad.addColorStop(0.5, '#3b82f6');
  panelGrad.addColorStop(1, '#6366f1');
  ctx.fillStyle = panelGrad;
  const inset = Math.max(1.2, 2 * scale);
  roundedRectPath(ctx, left + inset, top - 2 * scale + inset, w - inset * 2, h - inset, 2 * scale);
  ctx.fill();

  // Specular glass reflection stripe
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.lineWidth = Math.max(0.8, 1.3 * scale);
  ctx.beginPath();
  ctx.moveTo(left + w * 0.12, top);
  ctx.lineTo(left + w * 0.88, top);
  ctx.stroke();

  ctx.restore();
}

function drawRealisticPillar(ctx, left, top, w, h, scale) {
  ctx.save();
  const cx = left + w * 0.5;
  const cy = top + h * 0.5;

  // 1. Warm architectural sconce halo around the column
  const halo = ctx.createRadialGradient(cx, cy, w * 0.2, cx, cy, w * 1.4);
  halo.addColorStop(0, 'rgba(192, 132, 252, 0.28)');
  halo.addColorStop(1, 'rgba(192, 132, 252, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, w * 1.4, 0, TWO_PI);
  ctx.fill();

  // 2. Directional cast shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  roundedRectPath(ctx, left + 3.5 * scale, top + 4.5 * scale, w, h, 5 * scale);
  ctx.fill();

  // 3. Stepped stone plinth base
  ctx.fillStyle = '#4c1d95';
  roundedRectPath(ctx, left, top, w, h, 4 * scale);
  ctx.fill();

  // 4. 3D Elevated Marble Column Cap
  const capOffset = Math.max(2, 5 * scale);
  const colGrad = ctx.createLinearGradient(left, top - capOffset, left + w, top + h - capOffset);
  colGrad.addColorStop(0, '#e9d5ff');
  colGrad.addColorStop(0.45, '#a855f7');
  colGrad.addColorStop(1, '#581c87');
  ctx.fillStyle = colGrad;
  roundedRectPath(ctx, left + 1.5 * scale, top - capOffset, w - 3 * scale, h - 1 * scale, 4 * scale);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.lineWidth = Math.max(0.8, 1.2 * scale);
  ctx.stroke();

  ctx.restore();
}

function drawRealisticPlant(ctx, left, top, w, h, scale) {
  ctx.save();
  const cx = left + w * 0.5;
  const cy = top + h * 0.5;
  const radius = Math.max(w, h) * 0.62;

  // 1. Soft floor shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.beginPath();
  ctx.arc(cx + 2.5 * scale, cy + 3.5 * scale, radius * 1.05, 0, TWO_PI);
  ctx.fill();

  // 2. Terracotta / Ceramic planter pot
  const potGrad = ctx.createRadialGradient(cx - radius * 0.2, cy - radius * 0.2, radius * 0.1, cx, cy, radius * 0.85);
  potGrad.addColorStop(0, '#ea580c');
  potGrad.addColorStop(1, '#7c2d12');
  ctx.fillStyle = potGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.78, 0, TWO_PI);
  ctx.fill();

  // Dark rich potting soil
  ctx.fillStyle = '#271710';
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.58, 0, TWO_PI);
  ctx.fill();

  // 3. Lush layered tropical Monstera / Fiddle-Leaf foliage (9 leaves)
  const leafCount = 9;
  for (let i = 0; i < leafCount; i += 1) {
    const angle = (i * TWO_PI) / leafCount + 0.25;
    const isOuter = i % 2 === 0;
    const leafLen = radius * (isOuter ? 1.15 : 0.88);
    const leafWid = radius * (isOuter ? 0.42 : 0.34);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    ctx.fillStyle = isOuter ? '#15803d' : '#22c55e';
    ctx.beginPath();
    ctx.ellipse(leafLen * 0.52, 0, leafLen * 0.52, leafWid, 0, 0, TWO_PI);
    ctx.fill();

    // Central leaf vein highlight
    ctx.strokeStyle = isOuter ? '#4ade80' : '#bbf7d0';
    ctx.lineWidth = Math.max(0.6, 0.9 * scale);
    ctx.beginPath();
    ctx.moveTo(radius * 0.12, 0);
    ctx.lineTo(leafLen * 0.9, 0);
    ctx.stroke();

    ctx.restore();
  }

  // Center rosette highlight
  ctx.fillStyle = '#86efac';
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.18, 0, TWO_PI);
  ctx.fill();

  ctx.restore();
}

function drawObstacleBadge(ctx, obstacle, left, top, w, scale) {
  if (scale <= 0.32) return;
  const rawKind = obstacle.type ?? obstacle.kind;
  const rawType = typeof rawKind === 'string' ? rawKind : String(rawKind ?? '');
  if (!rawType) return;

  ctx.save();
  ctx.font = `600 ${Math.max(8, Math.round(9.5 * scale))}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';

  const labelY = top - (rawType === 'wall' ? 7 * scale : 3 * scale);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
  const textW = typeof ctx.measureText === 'function' ? ctx.measureText(rawType).width : rawType.length * 5.5 * scale;
  roundedRectPath(ctx, left + 1 * scale, labelY - 11 * scale, textW + 8 * scale, 12 * scale, 3 * scale);
  ctx.fill();

  ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
  ctx.fillText(rawType, left + 5 * scale, labelY - 1 * scale);
  ctx.restore();
}

/**
 * Render the complete 2.5D / 3D architectural room onto the static layer.
 */
export function drawRealisticStatic(ctx, viewport, room, width, height) {
  const { offsetX, offsetY, scale, drawnWidth, drawnHeight } = viewport;
  const roomKey = String(room?.roomId ?? room?.id ?? 'lobby').toLowerCase();
  const theme = ROOM_THEMES[roomKey] ?? ROOM_THEMES.lobby;

  // 1. Deep ambient architectural backdrop outside the room
  const bgGrad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    Math.min(width, height) * 0.1,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.75,
  );
  bgGrad.addColorStop(0, '#0f172a');
  bgGrad.addColorStop(1, '#04070f');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // 2. Outer 3D building drop shadow & perimeter wall frame
  const wallThick = Math.max(4, 10 * scale);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  roundedRectPath(
    ctx,
    offsetX - wallThick + 6 * scale,
    offsetY - wallThick + 8 * scale,
    drawnWidth + wallThick * 2,
    drawnHeight + wallThick * 2,
    8 * scale,
  );
  ctx.fill();

  ctx.fillStyle = theme.wallOuter;
  roundedRectPath(
    ctx,
    offsetX - wallThick,
    offsetY - wallThick,
    drawnWidth + wallThick * 2,
    drawnHeight + wallThick * 2,
    8 * scale,
  );
  ctx.fill();

  // 3. Base hardwood / architectural tile floor
  const floorGrad = ctx.createLinearGradient(offsetX, offsetY, offsetX + drawnWidth, offsetY + drawnHeight);
  floorGrad.addColorStop(0, theme.floorBase);
  floorGrad.addColorStop(0.5, '#1e293b');
  floorGrad.addColorStop(1, theme.floorBase);
  ctx.fillStyle = floorGrad;
  ctx.fillRect(offsetX, offsetY, drawnWidth, drawnHeight);

  // Subtle alternating hardwood plank bands
  const plankH = 40 * scale;
  if (plankH >= 6) {
    let toggle = false;
    for (let y = offsetY; y < offsetY + drawnHeight; y += plankH) {
      ctx.fillStyle = toggle ? theme.floorPlankA : theme.floorPlankB;
      ctx.fillRect(offsetX, y, drawnWidth, Math.min(plankH, offsetY + drawnHeight - y));
      toggle = !toggle;
    }
  }

  // 4. Decorative woven area rugs (pure floor art, never blocks movement or audio)
  drawAreaRug(
    ctx,
    offsetX + 1250 * scale,
    offsetY + 170 * scale,
    270 * scale,
    295 * scale,
    theme.rugPrimary,
    theme.rugBorder,
    scale,
  );
  drawAreaRug(
    ctx,
    offsetX + 370 * scale,
    offsetY + 725 * scale,
    310 * scale,
    170 * scale,
    theme.rugSecondary,
    theme.rugBorder,
    scale,
  );
  drawAreaRug(
    ctx,
    offsetX + 140 * scale,
    offsetY + 110 * scale,
    210 * scale,
    150 * scale,
    theme.rugPrimary,
    '#38bdf8',
    scale,
  );

  // 5. Architectural tile / spatial grid lines (major 120 px + minor 40 px)
  const minorStep = 40;
  if (scale > 0.35) {
    ctx.strokeStyle = theme.gridMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = minorStep; x < room.width; x += minorStep) {
      if (x % 120 === 0) continue;
      const sx = offsetX + x * scale;
      ctx.moveTo(sx, offsetY);
      ctx.lineTo(sx, offsetY + drawnHeight);
    }
    for (let y = minorStep; y < room.height; y += minorStep) {
      if (y % 120 === 0) continue;
      const sy = offsetY + y * scale;
      ctx.moveTo(offsetX, sy);
      ctx.lineTo(offsetX + drawnWidth, sy);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = theme.gridMajor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 120; x < room.width; x += 120) {
    const sx = offsetX + x * scale;
    ctx.moveTo(sx, offsetY);
    ctx.lineTo(sx, offsetY + drawnHeight);
  }
  for (let y = 120; y < room.height; y += 120) {
    const sy = offsetY + y * scale;
    ctx.moveTo(offsetX, sy);
    ctx.lineTo(offsetX + drawnWidth, sy);
  }
  ctx.stroke();

  // 6. Ambient ceiling spotlight pools & window light shafts
  const lights = [
    [480, 320, 280, theme.accentGlow],
    [1380, 320, 300, theme.warmLight],
    [960, 540, 340, theme.accentGlow],
    [520, 820, 260, theme.warmLight],
    [1480, 780, 280, theme.accentGlow],
  ];
  for (let i = 0; i < lights.length; i += 1) {
    const [lx, ly, lr, color] = lights[i];
    const sx = offsetX + lx * scale;
    const sy = offsetY + ly * scale;
    const sr = lr * scale;
    const g = ctx.createRadialGradient(sx, sy, sr * 0.05, sx, sy, sr);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, TWO_PI);
    ctx.fill();
  }

  // 7. Inner perimeter wall shadow & architectural doors/windows
  const innerShadow = ctx.createLinearGradient(offsetX, offsetY, offsetX, offsetY + 28 * scale);
  innerShadow.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
  innerShadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = innerShadow;
  ctx.fillRect(offsetX, offsetY, drawnWidth, 28 * scale);

  // Perimeter trim
  ctx.strokeStyle = theme.wallTrim;
  ctx.lineWidth = Math.max(1.5, 2.5 * scale);
  ctx.strokeRect(offsetX, offsetY, drawnWidth, drawnHeight);

  // Glowing glass skylight windows along top wall & double entrance doors at left
  ctx.fillStyle = 'rgba(56, 189, 248, 0.45)';
  for (const wx of [320, 720, 1160, 1560]) {
    if (wx + 160 < room.width) {
      ctx.fillRect(offsetX + wx * scale, offsetY - wallThick * 0.65, 140 * scale, wallThick * 0.5);
    }
  }

  // Architectural room watermark on the floor
  ctx.save();
  ctx.font = `700 ${Math.max(10, Math.round(13 * scale))}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(roomKey.toUpperCase(), offsetX + 18 * scale, offsetY + 14 * scale);
  ctx.restore();

  // 8. Obstacles rendered as realistic 2.5D / 3D objects in deterministic order
  const obstacles = room.obstacles;
  if (Array.isArray(obstacles)) {
    for (let i = 0; i < obstacles.length; i += 1) {
      const obstacle = obstacles[i];
      const left = offsetX + obstacle.x * scale;
      const top = offsetY + obstacle.y * scale;
      const w = (obstacle.w ?? obstacle.width ?? 0) * scale;
      const h = (obstacle.h ?? obstacle.height ?? 0) * scale;
      const type = obstacle.type ?? obstacle.kind;

      if (type === 'desk') {
        drawRealisticDesk(ctx, left, top, w, h, scale);
      } else if (type === 'wall') {
        drawRealisticWall(ctx, left, top, w, h, scale);
      } else if (type === 'screen') {
        drawRealisticScreen(ctx, left, top, w, h, scale);
      } else if (type === 'pillar') {
        drawRealisticPillar(ctx, left, top, w, h, scale);
      } else if (type === 'plant') {
        drawRealisticPlant(ctx, left, top, w, h, scale);
      } else {
        ctx.fillStyle = '#64748b';
        roundedRectPath(ctx, left, top, w, h, 4 * scale);
        ctx.fill();
      }

      drawObstacleBadge(ctx, obstacle, left, top, w, scale);
    }
  }
}

/**
 * Draw animated acoustic wave tethers between the local user and nearby peers
 * within proximity radius (`<= 100 px`).
 */
function drawProximityAudioLinks(ctx, selfUser, users, room, offsetX, offsetY, scale, radiusPx, timeSec) {
  if (!selfUser || !Number.isFinite(selfUser.x) || !Number.isFinite(selfUser.y)) return;
  const selfScreenX = offsetX + selfUser.x * scale;
  const selfScreenY = offsetY + selfUser.y * scale;
  const screenRadius = radiusPx * scale;

  // 1. 3D Proximity Earshot Aura around local user
  ctx.save();
  const auraGrad = ctx.createRadialGradient(
    selfScreenX,
    selfScreenY,
    screenRadius * 0.15,
    selfScreenX,
    selfScreenY,
    screenRadius,
  );
  auraGrad.addColorStop(0, 'rgba(79, 140, 255, 0.08)');
  auraGrad.addColorStop(0.75, 'rgba(56, 189, 248, 0.045)');
  auraGrad.addColorStop(1, 'rgba(56, 189, 248, 0.14)');
  ctx.fillStyle = auraGrad;
  ctx.beginPath();
  ctx.arc(selfScreenX, selfScreenY, screenRadius, 0, TWO_PI);
  ctx.fill();

  // Rotating dashed earshot boundary ring
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.38)';
  ctx.lineWidth = Math.max(1, 1.5 * scale);
  if (typeof ctx.setLineDash === 'function') {
    ctx.setLineDash([8 * scale, 6 * scale]);
    ctx.lineDashOffset = -timeSec * 28 * scale;
  }
  ctx.beginPath();
  ctx.arc(selfScreenX, selfScreenY, screenRadius, 0, TWO_PI);
  ctx.stroke();
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

  // Expanding sonar pulse ring inside earshot
  const sonarProgress = (timeSec * 0.55) % 1;
  const sonarR = screenRadius * sonarProgress;
  ctx.strokeStyle = `rgba(56, 189, 248, ${(1 - sonarProgress) * 0.28})`;
  ctx.lineWidth = Math.max(1, 1.4 * scale);
  ctx.beginPath();
  ctx.arc(selfScreenX, selfScreenY, sonarR, 0, TWO_PI);
  ctx.stroke();
  ctx.restore();

  // 2. Animated sound-wave tethers to peers within disconnect radius (115 px)
  const preparedObstacles = Array.isArray(room?.obstacles)
    ? prepareObstacles(room.obstacles, room.layoutRevision)
    : [];

  for (const peer of users.values()) {
    if (!peer || peer.id === selfUser.id) continue;
    if (!Number.isFinite(peer.x) || !Number.isFinite(peer.y)) continue;
    const dx = peer.x - selfUser.x;
    const dy = peer.y - selfUser.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radiusPx * 1.15 || dist < 0.01) continue;

    const transmission = preparedObstacles.length > 0
      ? transmissionBetween(selfUser, peer, preparedObstacles)
      : 1;
    const isOccluded = transmission < 0.999;
    const strength = Math.max(0.15, (1 - Math.min(dist, radiusPx) / (radiusPx * 1.15)) * transmission);

    const peerScreenX = offsetX + peer.x * scale;
    const peerScreenY = offsetY + peer.y * scale;
    const angle = Math.atan2(peerScreenY - selfScreenY, peerScreenX - selfScreenX);
    const screenDist = Math.hypot(peerScreenX - selfScreenX, peerScreenY - selfScreenY);

    ctx.save();
    ctx.translate(selfScreenX, selfScreenY);
    ctx.rotate(angle);

    // Sine-wave acoustic tether
    ctx.strokeStyle = isOccluded
      ? `rgba(251, 191, 36, ${0.35 + strength * 0.45})`
      : `rgba(52, 211, 153, ${0.38 + strength * 0.5})`;
    ctx.lineWidth = Math.max(1.2, 2.2 * scale);
    ctx.beginPath();
    const segments = 24;
    const amp = (isOccluded ? 2.5 : 5.5) * scale * strength;
    for (let s = 0; s <= segments; s += 1) {
      const t = s / segments;
      const env = Math.sin(t * Math.PI); // taper at ends
      const waveY = Math.sin(t * 18 - timeSec * 10) * amp * env;
      const px = t * screenDist;
      if (s === 0) ctx.moveTo(px, waveY);
      else ctx.lineTo(px, waveY);
    }
    ctx.stroke();

    // Midpoint acoustic pill indicator (distance + muffled state)
    if (scale > 0.38) {
      ctx.rotate(-angle);
      const midX = Math.cos(angle) * screenDist * 0.5;
      const midY = Math.sin(angle) * screenDist * 0.5;
      const badgeText = isOccluded
        ? `${Math.round(dist)}px · muffled`
        : `${Math.round(dist)}px · clear`;
      ctx.font = `600 ${Math.max(9, Math.round(10 * scale))}px system-ui, sans-serif`;
      const tw = typeof ctx.measureText === 'function' ? ctx.measureText(badgeText).width : badgeText.length * 5.5 * scale;
      const bw = tw + 10 * scale;
      const bh = 15 * scale;
      ctx.fillStyle = 'rgba(11, 16, 32, 0.86)';
      roundedRectPath(ctx, midX - bw * 0.5, midY - bh * 0.5, bw, bh, 6 * scale);
      ctx.fill();
      ctx.strokeStyle = isOccluded ? 'rgba(251, 191, 36, 0.65)' : 'rgba(52, 211, 153, 0.65)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = isOccluded ? '#fde68a' : '#a7f3d0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, midX, midY + 0.5 * scale);
    }

    ctx.restore();
  }
}

/**
 * Draw a single realistic 2.5D human avatar with walking animation, head,
 * hair, eyes, headset, jacket torso, swinging arms, stepping shoes and
 * floating glass nameplate.
 */
function drawHumanAvatar(ctx, user, entry, centreX, centreY, radius, scale, timeSec) {
  const isSelf = entry.isSelf;

  // Update walking animation state on `entry` (zero object allocations!)
  if (entry.lastX === undefined) {
    entry.lastX = user.x;
    entry.lastY = user.y;
    entry.heading = isSelf ? -HALF_PI : HALF_PI;
    entry.walkPhase = 0;
    entry.speed = 0;
    entry.skinColor = pickFromPalette(SKIN_TONES, user.id ?? user.name);
    entry.hairColor = pickFromPalette(HAIR_COLORS, user.id ?? user.name);
  } else {
    const dx = user.x - entry.lastX;
    const dy = user.y - entry.lastY;
    const stepDist = Math.hypot(dx, dy);
    entry.lastX = user.x;
    entry.lastY = user.y;
    if (stepDist > 0.08) {
      const targetHeading = Math.atan2(dy, dx);
      // Smooth angular interpolation
      let diff = targetHeading - entry.heading;
      while (diff > Math.PI) diff -= TWO_PI;
      while (diff < -Math.PI) diff += TWO_PI;
      entry.heading += diff * 0.28;
      entry.walkPhase = (entry.walkPhase + stepDist * 0.22) % TWO_PI;
      entry.speed = Math.min(1, entry.speed * 0.7 + 0.45);
    } else {
      entry.speed *= 0.84;
      if (entry.speed < 0.02) entry.speed = 0;
    }
  }

  const speed = entry.speed;
  const stride = Math.sin(entry.walkPhase) * speed;
  const bobY = Math.abs(Math.cos(entry.walkPhase)) * 1.8 * scale * speed
    + Math.sin(timeSec * 2.6 + (user.x * 0.01)) * 0.8 * scale;

  ctx.save();

  // 1. Ground shadow ellipse beneath the person
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.ellipse(centreX, centreY + radius * 0.78, radius * 0.92, radius * 0.48, 0, 0, TWO_PI);
  ctx.fill();

  // 2. Self highlight ring & voice ripple on the floor
  if (isSelf) {
    const pulse = 0.5 + 0.5 * Math.sin(timeSec * 4);
    ctx.strokeStyle = `rgba(255, 209, 102, ${0.55 + pulse * 0.3})`;
    ctx.lineWidth = Math.max(1.5, 2.4 * scale);
    ctx.beginPath();
    ctx.ellipse(centreX, centreY + radius * 0.65, radius * 1.28, radius * 0.72, 0, 0, TWO_PI);
    ctx.stroke();
  }

  // 3. Stepping Left & Right Shoes (animated with `stride`)
  const dirX = Math.cos(entry.heading);
  const dirY = Math.sin(entry.heading);
  const sideX = -dirY;
  const sideY = dirX;

  const footSpread = radius * 0.36;
  const footSwing = radius * 0.42 * stride;
  const leftFootX = centreX - sideX * footSpread + dirX * footSwing;
  const leftFootY = centreY + radius * 0.62 - sideY * footSpread * 0.5 + dirY * footSwing * 0.5;
  const rightFootX = centreX + sideX * footSpread - dirX * footSwing;
  const rightFootY = centreY + radius * 0.62 + sideY * footSpread * 0.5 - dirY * footSwing * 0.5;

  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.ellipse(leftFootX, leftFootY, radius * 0.28, radius * 0.18, entry.heading, 0, TWO_PI);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(rightFootX, rightFootY, radius * 0.28, radius * 0.18, entry.heading, 0, TWO_PI);
  ctx.fill();

  // 4. 3D Human Torso / Jacket & Swinging Arms
  const bodyY = centreY + radius * 0.12 - bobY;
  const armSpread = radius * 0.78;
  const armSwing = radius * 0.32 * stride;

  // Left & Right Swinging Arms + Hands
  const leftArmX = centreX - sideX * armSpread - dirX * armSwing;
  const leftArmY = bodyY - sideY * armSpread * 0.35 - dirY * armSwing * 0.35;
  const rightArmX = centreX + sideX * armSpread + dirX * armSwing;
  const rightArmY = bodyY + sideY * armSpread * 0.35 + dirY * armSwing * 0.35;

  ctx.fillStyle = entry.color;
  ctx.beginPath();
  ctx.arc(leftArmX, leftArmY, radius * 0.26, 0, TWO_PI);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(rightArmX, rightArmY, radius * 0.26, 0, TWO_PI);
  ctx.fill();

  // Skin-toned hands at the end of the arms
  ctx.fillStyle = entry.skinColor;
  ctx.beginPath();
  ctx.arc(leftArmX + dirX * radius * 0.14, leftArmY + dirY * radius * 0.14, radius * 0.16, 0, TWO_PI);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(rightArmX + dirX * radius * 0.14, rightArmY + dirY * radius * 0.14, radius * 0.16, 0, TWO_PI);
  ctx.fill();

  // Shoulders & Jacket Torso (3D shaded oval)
  const torsoGrad = ctx.createRadialGradient(
    centreX - radius * 0.25,
    bodyY - radius * 0.25,
    radius * 0.1,
    centreX,
    bodyY,
    radius * 0.9,
  );
  torsoGrad.addColorStop(0, isSelf ? '#fde047' : '#ffffff');
  torsoGrad.addColorStop(0.22, entry.color);
  torsoGrad.addColorStop(1, '#0f172a');
  ctx.fillStyle = torsoGrad;
  ctx.beginPath();
  ctx.ellipse(centreX, bodyY, radius * 0.78, radius * 0.56, 0, 0, TWO_PI);
  ctx.fill();
  ctx.strokeStyle = isSelf ? '#ffffff' : 'rgba(15, 23, 42, 0.85)';
  ctx.lineWidth = Math.max(1, (isSelf ? 2.2 : 1.4) * scale);
  ctx.stroke();

  // Shirt V-neck / collar detail
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.arc(centreX + dirX * radius * 0.16, bodyY - radius * 0.12, radius * 0.22, 0, TWO_PI);
  ctx.fill();

  // 5. 3D Human Head, Hair, Eyes & Wireless Headset
  const headY = centreY - radius * 0.42 - bobY;
  const headR = radius * 0.58;

  // Head drop shadow onto shoulders
  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.beginPath();
  ctx.arc(centreX, headY + headR * 0.22, headR * 0.98, 0, TWO_PI);
  ctx.fill();

  // Skin-toned 3D sphere head
  const headGrad = ctx.createRadialGradient(
    centreX - headR * 0.28,
    headY - headR * 0.28,
    headR * 0.1,
    centreX,
    headY,
    headR,
  );
  headGrad.addColorStop(0, '#fff7ed');
  headGrad.addColorStop(0.3, entry.skinColor);
  headGrad.addColorStop(1, '#9a5b32');
  ctx.fillStyle = headGrad;
  ctx.beginPath();
  ctx.arc(centreX, headY, headR, 0, TWO_PI);
  ctx.fill();

  // Styled 3D Hair cap (opposite the facing direction + crown)
  ctx.fillStyle = entry.hairColor;
  ctx.beginPath();
  ctx.arc(
    centreX - dirX * headR * 0.18,
    headY - headR * 0.18 - dirY * headR * 0.12,
    headR * 0.92,
    entry.heading + Math.PI * 0.42,
    entry.heading + Math.PI * 1.58,
  );
  ctx.fill();

  // Eyes looking toward `entry.heading`
  const eyeForward = headR * 0.42;
  const eyeSpread = headR * 0.32;
  const eyeCenterX = centreX + dirX * eyeForward;
  const eyeCenterY = headY + dirY * eyeForward * 0.55;
  const eyeR = Math.max(1.1, headR * 0.13);

  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.arc(eyeCenterX - sideX * eyeSpread, eyeCenterY - sideY * eyeSpread * 0.5, eyeR, 0, TWO_PI);
  ctx.arc(eyeCenterX + sideX * eyeSpread, eyeCenterY + sideY * eyeSpread * 0.5, eyeR, 0, TWO_PI);
  ctx.fill();

  // Tiny white eye catchlights
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(eyeCenterX - sideX * eyeSpread - 0.5, eyeCenterY - sideY * eyeSpread * 0.5 - 0.5, eyeR * 0.4, 0, TWO_PI);
  ctx.arc(eyeCenterX + sideX * eyeSpread - 0.5, eyeCenterY + sideY * eyeSpread * 0.5 - 0.5, eyeR * 0.4, 0, TWO_PI);
  ctx.fill();

  // Wireless Spatial Audio Headset band + earcups + glowing mic tip
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = Math.max(1.2, 2.2 * scale);
  ctx.beginPath();
  ctx.arc(centreX, headY - headR * 0.08, headR * 1.02, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();

  // Left & Right Earcups
  ctx.fillStyle = isSelf ? '#f59e0b' : '#38bdf8';
  ctx.beginPath();
  ctx.arc(centreX - headR * 0.98, headY, headR * 0.24, 0, TWO_PI);
  ctx.arc(centreX + headR * 0.98, headY, headR * 0.24, 0, TWO_PI);
  ctx.fill();

  // 6. Floating 3D Glass Pill Nameplate above the head
  const fontPx = Math.max(10, Math.round(12 * Math.min(1.15, Math.max(0.8, scale))));
  const fontStr = `600 ${fontPx}px system-ui, -apple-system, sans-serif`;
  ctx.font = fontStr;
  const textWidth = typeof ctx.measureText === 'function'
    ? (Number(ctx.measureText(entry.text)?.width) || entry.text.length * 6.5)
    : entry.text.length * 6.5;

  const pillPadX = 10 * scale;
  const pillW = textWidth + pillPadX * 2 + 10 * scale;
  const pillH = Math.max(16, 20 * scale);
  const pillX = centreX - pillW * 0.5;
  const pillY = headY - headR - pillH - 6 * scale;

  // Pill shadow + glass body
  ctx.fillStyle = 'rgba(5, 8, 18, 0.84)';
  roundedRectPath(ctx, pillX, pillY, pillW, pillH, pillH * 0.5);
  ctx.fill();
  ctx.strokeStyle = isSelf ? 'rgba(255, 209, 102, 0.85)' : 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = Math.max(1, 1.3 * scale);
  ctx.stroke();

  // Live green/gold status dot inside pill
  ctx.fillStyle = isSelf ? '#ffd166' : '#34d399';
  ctx.beginPath();
  ctx.arc(pillX + 8 * scale, pillY + pillH * 0.5, Math.max(2.2, 3.2 * scale), 0, TWO_PI);
  ctx.fill();

  // Name text
  ctx.fillStyle = isSelf ? '#fef08a' : '#f1f5f9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(entry.text, centreX + 3 * scale, pillY + pillH * 0.52);

  ctx.restore();
}

/**
 * Render all dynamic elements (proximity audio field, acoustic wave tethers,
 * and animated 2.5D human avatars) on top of the static room layer.
 */
export function drawRealisticDynamic(ctx, viewport, world, labelCache) {
  const { offsetX, offsetY, scale } = viewport;
  const radius = Math.max(9, 19 * scale);
  const selfId = world.selfId;
  const radiusPx = world.proximityRadiusPx ?? world.meshLimits?.proximityRadiusPx ?? 100;
  const timeSec = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;

  const selfUser = selfId ? world.users.get(selfId) : null;
  if (selfUser) {
    drawProximityAudioLinks(ctx, selfUser, world.users, world.room, offsetX, offsetY, scale, radiusPx, timeSec);
  }

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

    const centreX = offsetX + user.x * scale;
    const centreY = offsetY + user.y * scale;
    drawHumanAvatar(ctx, user, entry, centreX, centreY, radius, scale, timeSec);
  }

  labelCache.finishFrame(tag, seenCount);
}
