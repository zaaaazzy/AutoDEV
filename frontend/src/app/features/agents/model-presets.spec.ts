import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_PRESETS, modelLabel, presetLabel, presetOf } from './agent-options.js';

const claude = (alias: string) => `claude --model ${alias} --permission-mode acceptEdits -p {prompt}`;

test('Claude-Vorgaben nutzen die Aliase der CLI, die immer die neueste Version der Reihe nehmen', () => {
  const byId = new Map(MODEL_PRESETS.map((preset) => [preset.id, preset]));
  assert.equal(byId.get('claude-haiku')?.command, claude('haiku'));
  assert.equal(byId.get('claude-sonnet')?.command, claude('sonnet'));
  assert.equal(byId.get('claude-opus')?.command, claude('opus'));
  assert.equal(byId.get('claude-fable')?.command, claude('fable'));
});

test('Claude Fable ist die teuerste Stufe und steht hinter Opus', () => {
  const ids = MODEL_PRESETS.map((preset) => preset.id);
  assert.ok(ids.indexOf('claude-opus') < ids.indexOf('claude-fable'));
  const fable = MODEL_PRESETS.find((preset) => preset.id === 'claude-fable');
  assert.ok(fable);
  assert.equal(fable.tier, 4);
  assert.match(presetLabel(fable), /^Claude Fable 5\.1 .*· \$\$\$\$$/);
});

test('Gespeicherte Fable-Befehle werden als Vorgabe erkannt und lesbar angezeigt', () => {
  assert.equal(presetOf(claude('fable')), 'claude-fable');
  assert.match(modelLabel(claude('fable').split(' ')), /^Claude Fable 5\.1/);
  // Eigener Befehl ohne Vorgabe: Alias wird nur grossgeschrieben.
  assert.equal(modelLabel(['claude', '--model', 'fable', '-p', '{prompt}']), 'Claude Fable');
});
