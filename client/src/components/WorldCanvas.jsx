import { useEffect, useRef } from 'react';
import { createCanvasLoop } from '../canvas/frameLoop.js';
import { isPerfEnabled } from '../perf/perfReadout.js';

/**
 * Full-window canvas (Day 4; Day 5 movement & click-to-walk; Week 3, Day 18
 * offscreen static layer, zero-allocation dynamic path and opt-in `?perf=1`
 * readout).
 *
 * Owns the `<canvas>` element (plus the read-only `?perf=1` text element when
 * requested in the URL) and delegates its single `requestAnimationFrame` loop,
 * DPR-aware backing sizing, offscreen static layer and unmount cleanup to
 * `createCanvasLoop`. Never calls setState per frame — neither drawing nor the
 * <= 1 Hz performance readout triggers React re-renders.
 */
export default function WorldCanvas({
  world,
  renderFrame = null,
  updateFrame = null,
  onWorldClick = null,
}) {
  const canvasRef = useRef(null);
  const perfRef = useRef(null);
  const perfEnabled = isPerfEnabled(typeof window !== 'undefined' ? window.location?.search : '');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const loop = createCanvasLoop({
      canvas,
      worldRef: world,
      renderFrame,
      updateFrame,
      onWorldClick,
      perfElement: perfEnabled ? perfRef.current : null,
      perfEnabled,
    });
    loop.start();
    return () => loop.stop();
  }, [world, renderFrame, updateFrame, onWorldClick, perfEnabled]);

  return (
    <>
      <canvas ref={canvasRef} className="world-canvas" aria-label="ProxiSpeak room" />
      {perfEnabled ? (
        <div ref={perfRef} className="perf-readout" aria-label="Canvas frame performance" />
      ) : null}
    </>
  );
}
