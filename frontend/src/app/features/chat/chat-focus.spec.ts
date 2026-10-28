import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handlesEscape, trapFocusTarget, type FocusNode } from './chat-focus.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Knoten mit Elternkette, reicht für `contains`. */
function node(nodeName: string, parent: FakeNode | null = null): FakeNode {
  return new FakeNode(nodeName, parent);
}
class FakeNode implements FocusNode {
  constructor(
    readonly nodeName: string,
    readonly parent: FakeNode | null,
  ) {}
  contains(other: FocusNode | null): boolean {
    for (let current = other as FakeNode | null; current; current = current.parent) if (current === this) return true;
    return false;
  }
}

const body = node('BODY');
const panel = node('SECTION', body);
const input = node('INPUT', panel);
const foreignDialog = node('SECTION', body);
const foreignButton = node('BUTTON', foreignDialog);

test('Escape: Fokus im Chat dockt ab bzw. schliesst das Modal', () => {
  assert.equal(handlesEscape({ defaultPrevented: false, target: input }, panel, 'docked'), true);
  assert.equal(handlesEscape({ defaultPrevented: false, target: input }, panel, 'modal'), true);
});

test('Escape in einem fremden Dialog lässt den angedockten Chat in Ruhe', () => {
  assert.equal(handlesEscape({ defaultPrevented: false, target: foreignButton }, panel, 'docked'), false);
  assert.equal(handlesEscape({ defaultPrevented: false, target: body }, panel, 'docked'), false);
  // Bestätigungsdialog über dem Chat-Modal: Escape gehört dem Dialog.
  assert.equal(handlesEscape({ defaultPrevented: false, target: foreignButton }, panel, 'modal'), false);
});

test('Escape: schon behandelt (defaultPrevented) oder nicht vergrössert → nichts tun', () => {
  assert.equal(handlesEscape({ defaultPrevented: true, target: input }, panel, 'docked'), false);
  assert.equal(handlesEscape({ defaultPrevented: false, target: input }, panel, null), false);
});

test('Escape im Modal ohne Fokus (body) schliesst das Modal', () => {
  assert.equal(handlesEscape({ defaultPrevented: false, target: body }, panel, 'modal'), true);
});

test('Fokusfalle: Tab am Ende springt zum Anfang, Shift+Tab am Anfang zum Ende', () => {
  const [first, middle, last] = ['a', 'b', 'c'];
  const list = [first, middle, last];
  assert.equal(trapFocusTarget(list, last, false), first);
  assert.equal(trapFocusTarget(list, first, true), last);
  // Dazwischen: Browser macht weiter.
  assert.equal(trapFocusTarget(list, middle, false), null);
  assert.equal(trapFocusTarget(list, middle, true), null);
  assert.equal(trapFocusTarget(list, first, false), null);
});

test('Fokusfalle: Fokus ausserhalb (z. B. body) wird ins Modal geholt', () => {
  assert.equal(trapFocusTarget(['a', 'b'], 'x', false), 'a');
  assert.equal(trapFocusTarget(['a', 'b'], null, true), 'b');
  assert.equal(trapFocusTarget([], null, false), null);
});

test('[hidden] gewinnt global gegen display-Regeln (Zoom-Knopf, Sprint-Vorschlag, „Läuft gerade“)', () => {
  const base = readFileSync(join(HERE, '..', '..', '..', 'styles', '01-base.css'), 'utf8');
  assert.match(base, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('Angedockte Sprechblase: kein Zoom-Knopf im DOM (nicht nur [hidden])', () => {
  const template = readFileSync(join(HERE, 'chat.component.html'), 'utf8');
  const zoomButton = /<button[^>]*chat-zoom[^>]*>/.exec(template)?.[0] ?? '';
  assert.ok(zoomButton, 'Zoom-Knopf fehlt');
  assert.doesNotMatch(zoomButton, /\[hidden\]/);
  assert.match(template, /@if \(!\(bubble\(\) && zoom\(\) === 'docked'\)\)\s*\{\s*<button[^>]*chat-zoom/);
});
