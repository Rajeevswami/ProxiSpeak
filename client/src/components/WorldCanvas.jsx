import { useEffect, useRef } from 'react';
import { createCanvasLoop } from '../canvas/frameLoop.js';

/**
 * Full-window canvas (Day 4; Day 5 movement & click-to-walk; Week 3, Day 18
 * offscreen static layer + zero-allocation dynamic path).
 *
 * Owns the `<canvas>` element and delegates its single `requestAnimationFrame`
 * loop, DPR-aware backing sizing, offscreen static layer and unmount cleanup to
 * `createCanvasLoop`. Never calls setState per frame — drawing triggers zero
 * React re-renders.
 */
export default function WorldCanvas({
  world,
  renderFrame = null,
  updateFrame = null,
  onWorldClick = null,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const loop = createCanvasLoop({
      canvas,
      worldRef: world,
      renderFrame,
      updateFrame,
      onWorldClick,
    });
    loop.start();
    return () => loop.stop();
  }, [world, renderFrame, updateFrame, onWorldClick]);

  return <canvas ref={canvasRef} className="world-canvas" aria-label="ProxiSpeak room" />;
}
