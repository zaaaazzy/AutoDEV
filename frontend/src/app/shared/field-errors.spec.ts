import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FieldError } from '../core/errors.js';
import { FieldErrors } from './field-errors.js';

test('FieldErrors: leeres Pflichtfeld zeigt die Meldung am Feld, Eingabe löscht sie', () => {
  const errors = new FieldErrors();
  assert.equal(errors.require('title', '  ', 'Bitte einen Titel angeben.'), false);
  assert.equal(errors.message('title'), 'Bitte einen Titel angeben.');
  errors.clear('title');
  assert.equal(errors.message('title'), '');
  assert.equal(errors.require('title', 'Neue Idee', 'Bitte einen Titel angeben.'), true);
});

test('FieldErrors: Feldfehler der API landet am Feld und wird als angezeigt markiert', () => {
  const errors = new FieldErrors();
  const error = new FieldError('Titel bitte kurz halten.', 'title');
  errors.take(error);
  assert.equal(errors.message('title'), 'Titel bitte kurz halten.');
  assert.equal(error.shown, true);
});

test('FieldErrors: andere Fehler bleiben unberührt', () => {
  const errors = new FieldErrors();
  errors.take(new Error('Netzwerk weg'));
  assert.equal(errors.message('title'), '');
});
