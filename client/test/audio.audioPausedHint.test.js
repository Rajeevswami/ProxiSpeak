import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowAudioPausedHint, AUDIO_PAUSED_HINT } from '../src/audio/audioPausedHint.js';

test('returns true for suspended with peers', () => {
  assert.equal(shouldShowAudioPausedHint('suspended', 1), true);
  assert.equal(shouldShowAudioPausedHint('suspended', 5), true);
});

test('returns true for interrupted (Safari) with peers', () => {
  assert.equal(shouldShowAudioPausedHint('interrupted', 1), true);
});

test('returns false when running (audio is flowing)', () => {
  assert.equal(shouldShowAudioPausedHint('running', 1), false);
  assert.equal(shouldShowAudioPausedHint('running', 10), false);
});

test('returns false when closed (context deliberately closed)', () => {
  assert.equal(shouldShowAudioPausedHint('closed', 1), false);
});

test('returns false when there are no peers', () => {
  assert.equal(shouldShowAudioPausedHint('suspended', 0), false);
  assert.equal(shouldShowAudioPausedHint('interrupted', 0), false);
});

test('returns false for null, undefined or non-string state', () => {
  assert.equal(shouldShowAudioPausedHint(null, 1), false);
  assert.equal(shouldShowAudioPausedHint(undefined, 1), false);
  assert.equal(shouldShowAudioPausedHint(42, 1), false);
});

test('returns false for non-finite peer count', () => {
  assert.equal(shouldShowAudioPausedHint('suspended', NaN), false);
  assert.equal(shouldShowAudioPausedHint('suspended', Infinity), false);
  assert.equal(shouldShowAudioPausedHint('suspended', undefined), false);
});

test('AUDIO_PAUSED_HINT is a non-empty string', () => {
  assert.equal(typeof AUDIO_PAUSED_HINT, 'string');
  assert.ok(AUDIO_PAUSED_HINT.length > 0);
});
