import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFromHash, sectionFromHash, targetFromHash } from './navigation.js';

function withHash(hash: string, check: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { hash }, configurable: true });
  try {
    check();
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete (globalThis as { location?: unknown }).location;
  }
}

test('Push-Link ohne Ziel: Seite und Projekt aus „#sprints?project=demo“', () => {
  withHash('#sprints?project=demo', () => {
    assert.equal(sectionFromHash(), 'sprints');
    assert.equal(targetFromHash(), null);
    assert.equal(projectFromHash(), 'demo');
  });
});

test('Push-Link mit Auftrag: Seite, Ziel und Projekt', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  withHash(`#development/${id}?project=demo`, () => {
    assert.equal(sectionFromHash(), 'development');
    assert.equal(targetFromHash(), id);
    assert.equal(projectFromHash(), 'demo');
  });
});

test('ohne Parameter bleibt alles wie bisher', () => {
  withHash('#bugs', () => {
    assert.equal(sectionFromHash(), 'bugs');
    assert.equal(projectFromHash(), null);
  });
});
