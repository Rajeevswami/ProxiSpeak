/**
 * Keyboard-input rules for avatar movement (Day 5). No React, no
 * listeners here — the hook owns the DOM wiring; this module holds the
 * pure decisions: when key input must be ignored so it can never
 * collide with typing.
 */

/**
 * True when the focused element would consume keystrokes as text: the
 * join screen's name input, any input, textarea or select, or anything
 * content-editable. Movement keys are ignored while this is true, so
 * typing a name (or "wasd" in any future text field) never walks the
 * avatar.
 */
export function isTypingTarget(target) {
  if (!target || typeof target.tagName !== 'string') return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable === true;
}
