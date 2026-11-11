import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_MODELS, MODEL_PRESETS, modelLabel, presetLabel, presetOf } from './agent-options.js';

const preset = (alias: string) => MODEL_PRESETS.find((entry) => entry.id === `claude-${alias}`);
const fable = preset('fable');

test('Jedes Claude-Modell hat eine Vorgabe mit Label und Kostenstufe aus CLAUDE_MODELS', () => {
  // Befehl wie `agentCommand('claude', alias)` in src/api/setup.ts, hier einmal wörtlich festgehalten.
  assert.equal(fable?.command, 'claude --model fable --permission-mode acceptEdits -p {prompt}');
  for (const model of CLAUDE_MODELS) {
    const entry = preset(model.alias);
    assert.ok(entry, model.alias);
    assert.deepEqual([entry.label, entry.tier], [model.label, model.tier]);
    // Gespeicherter Befehl wird als Vorgabe erkannt und mit dem Label angezeigt.
    assert.equal(presetOf(entry.command), entry.id);
    assert.equal(modelLabel(entry.command.split(' ')), model.label);
  }
});

test('Claude Fable ist die teuerste Stufe und steht hinter Opus', () => {
  const ids = MODEL_PRESETS.map((entry) => entry.id);
  assert.ok(ids.indexOf('claude-opus') < ids.indexOf('claude-fable'));
  assert.ok(fable);
  assert.equal(fable.tier, 4);
  assert.equal(presetLabel(fable), `${fable.label} · $$$$`);
});

test('Eigener Claude-Befehl ohne Vorgabe: Alias wird nur grossgeschrieben', () => {
  assert.equal(modelLabel(['claude', '--model', 'fable', '-p', '{prompt}']), 'Claude Fable');
});
