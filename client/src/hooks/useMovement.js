import { useEffect, useRef } from 'react';
import { createMovementController } from '../movement/controller.js';
import { isTypingTarget } from '../movement/input.js';
import { isMovementKey } from '../movement/movement.js';

/**
 * Wires avatar movement (Day 5) to the DOM and returns the stable
 * movement controller.
 *
 * What lives here: the window-level keyboard listeners with their focus
 * rules, and the controller's lifetime. What deliberately does NOT live
 * here: per-frame work — `controller.update` is invoked by the canvas
 * component's single rAF loop, and nothing in this hook ever calls
 * setState, so movement triggers zero React renders.
 *
 * Keyboard rules:
 *  - WASD and the arrow keys walk the avatar; input with Ctrl, Meta or
 *    Alt held is left to the browser (shortcuts stay shortcuts).
 *  - While the join screen or any text input has focus, movement keys
 *    are ignored — typing a name can never walk the avatar.
 *  - When the window loses focus every held key is cleared, so a key
 *    held while tabbing away cannot stick down.
 */
export function useMovement({ world, emitMove }) {
  const controllerRef = useRef(null);
  if (controllerRef.current === null) {
    // The world state object is created once by useSocket and mutated
    // in place for the hook's whole lifetime, so capturing it here is
    // safe (the socket hook never replaces it).
    controllerRef.current = createMovementController({ world: world.current, emitMove });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || !isMovementKey(event.code)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault(); // the arrow keys must not scroll the page
      controller.pressKey(event.code);
    };

    const onKeyUp = (event) => {
      controller.releaseKey(event.code);
    };

    const onBlur = () => {
      controller.clearKeys();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      controller.clearKeys();
    };
  }, [controller]);

  return controller;
}

export default useMovement;
