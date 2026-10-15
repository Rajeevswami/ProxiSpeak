import { useEffect, useRef } from 'react';
import { computeCanvasSize, computeViewport, screenToWorld } from '../canvas/coords.js';
import { drawRoom } from '../canvas/renderer.js';

/**
 * Full-window canvas (Day 4; Day 5 adds per-frame movement and clicks).
 *
 * Owns exactly three things: the canvas element, its
 * devicePixelRatio-aware sizing (recomputed on resize), and one
 * requestAnimationFrame loop started on mount and cancelled on
 * unmount. It never calls setState per frame — each frame computes the
 * elapsed delta time, lets `updateFrame` advance the world (movement,
 * broadcasting, interpolation), then paints whatever moved. The same
 * effect also translates canvas clicks into world coordinates with the
 * Day 4 helpers and hands them to `onWorldClick`.
 *
 * `renderFrame` and `updateFrame` are injectable so the world painter
 * can be swapped without touching this lifecycle; all callbacks are
 * stable for the component's lifetime (module functions or controller
 * methods), so the loop never restarts.
 */
export default function WorldCanvas({
  world,
  renderFrame = drawRoom,
  updateFrame = null,
  onWorldClick = null,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let animationFrame = 0;
    // One size object for the effect's lifetime, mutated on resize —
    // not a fresh allocation on every animation frame.
    const size = { width: 0, height: 0 };
    // Same clock as the rAF timestamps (both are performance.now-based).
    let lastFrameTime = performance.now();

    const resize = () => {
      // Sizes come from the window (and can be 0 in a minimised window), so
      // they are sanitised into a usable canvas here — a throw from inside the
      // frame callback would end the render loop for good.
      const canvasSize = computeCanvasSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
      size.width = canvasSize.width;
      size.height = canvasSize.height;
      canvas.width = canvasSize.backingWidth;
      canvas.height = canvasSize.backingHeight;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      // Draw in CSS pixels; the DPR transform keeps lines sharp on retina
      // (resizing the canvas reset the transform, so it is set after every fit).
      ctx.setTransform(canvasSize.dpr, 0, 0, canvasSize.dpr, 0, 0);
    };

    const frame = (now) => {
      const deltaSeconds = Math.max(0, (now - lastFrameTime) / 1000);
      lastFrameTime = now;
      // Movement first (the controller clamps its own delta time), then
      // the frame paints the positions that movement just produced.
      if (updateFrame) updateFrame(deltaSeconds);
      renderFrame(ctx, world.current, size);
      animationFrame = window.requestAnimationFrame(frame);
    };

    // Click-to-walk: screen -> world with the Day 4 coordinate helpers,
    // using exactly the viewport the renderer letterboxes with.
    const handleClick = (event) => {
      if (!onWorldClick || event.button !== 0) return;
      const room = world.current?.room;
      if (!room) return;
      const rect = canvas.getBoundingClientRect();
      const viewport = computeViewport(room.width, room.height, size.width, size.height);
      const point = screenToWorld(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        viewport,
      );
      onWorldClick(point);
    };

    resize();
    window.addEventListener('resize', resize);
    canvas.addEventListener('click', handleClick);
    animationFrame = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('click', handleClick);
    };
  }, [world, renderFrame, updateFrame, onWorldClick]);

  return <canvas ref={canvasRef} className="world-canvas" aria-label="ProxiSpeak room" />;
}
