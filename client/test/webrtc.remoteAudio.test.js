/**
 * Remote audio tests (Day 9). A fake `document` stands in for the DOM, so the
 * element lifecycle (attach / replace / remove / removeAll) runs in Node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { REMOTE_AUDIO_CONTAINER_CLASS, createRemoteAudio } from '../src/webrtc/remoteAudio.js';

/** Minimal DOM: elements know their parent and can be removed. */
function createFakeDocument() {
  const makeElement = (tag) => ({
    tagName: tag,
    attrs: {},
    children: [],
    parentNode: null,
    srcObject: null,
    autoplay: false,
    playsInline: false,
    paused: true,
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
      }
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return { catch: () => {} };
    },
  });
  const body = makeElement('body');
  return {
    body,
    createElement: makeElement,
  };
}

test('each remote stream gets its own autoplay audio element in a hidden container', () => {
  const document = createFakeDocument();
  const audio = createRemoteAudio({ document });
  const streamA = { id: 'a' };
  const streamB = { id: 'b' };

  const elA = audio.attach('bob', streamA);
  const elB = audio.attach('cat', streamB);

  assert.equal(elA.tagName, 'audio');
  assert.equal(elA.autoplay, true);
  assert.equal(elA.playsInline, true);
  assert.equal(elA.attrs.autoplay, '');
  assert.equal(elA.attrs.playsinline, '');
  assert.equal(elA.srcObject, streamA);
  assert.equal(elB.srcObject, streamB);
  assert.equal(audio.count(), 2);

  const container = document.body.children[0];
  assert.equal(container.className, REMOTE_AUDIO_CONTAINER_CLASS);
  assert.equal(container.attrs['aria-hidden'], 'true');
  assert.deepEqual(container.children, [elA, elB]);
});

test('attach replaces the previous element for the same peer', () => {
  const document = createFakeDocument();
  const audio = createRemoteAudio({ document });
  const first = audio.attach('bob', { id: 1 });
  const second = audio.attach('bob', { id: 2 });

  assert.notEqual(first, second);
  assert.equal(first.parentNode, null, 'the old element is detached');
  assert.equal(first.srcObject, null, 'the old stream is released');
  assert.equal(audio.elementOf('bob'), second);
  assert.equal(audio.count(), 1);
});

test('remove detaches the element and clears its stream; removeAll empties the container', () => {
  const document = createFakeDocument();
  const audio = createRemoteAudio({ document });
  const el = audio.attach('bob', { id: 1 });
  audio.attach('cat', { id: 2 });

  assert.equal(audio.remove('bob'), true);
  assert.equal(el.parentNode, null);
  assert.equal(el.srcObject, null);
  assert.equal(audio.remove('bob'), false, 'removing twice is a no-op');
  assert.equal(audio.count(), 1);

  audio.removeAll();
  assert.equal(audio.count(), 0);
  const container = document.body.children[0];
  assert.equal(container.children.length, 0);
});

test('destroy removes owned elements and container; externally supplied containers stay owned by caller', () => {
  const document = createFakeDocument();
  const audio = createRemoteAudio({ document });
  const first = audio.attach('bob', { id: 1 });
  const ownedContainer = document.body.children[0];

  audio.destroy();
  assert.equal(first.parentNode, null);
  assert.equal(first.srcObject, null);
  assert.equal(audio.count(), 0);
  assert.equal(document.body.children.length, 0);
  audio.destroy(); // idempotent

  const external = document.createElement('div');
  document.body.appendChild(external);
  const supplied = createRemoteAudio({ document, container: external });
  supplied.attach('cat', { id: 2 });
  supplied.destroy();
  assert.equal(external.parentNode, document.body, 'caller-owned container remains attached');
  assert.equal(external.children.length, 0);
  assert.notEqual(ownedContainer.parentNode, document.body);
});

test('50 per-session audio sinks leave no elements or owned containers behind', () => {
  const document = createFakeDocument();
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const audio = createRemoteAudio({ document });
    audio.attach(`peer-${cycle}`, { id: cycle }, { muted: true });
    audio.destroy();
  }
  assert.equal(document.body.children.length, 0);
});

test('without a DOM document attach is a safe no-op', () => {
  const audio = createRemoteAudio({ document: null });
  assert.equal(audio.attach('bob', {}), null);
  assert.equal(audio.count(), 0);
  assert.equal(audio.remove('bob'), false);
  audio.removeAll(); // must not throw
});
