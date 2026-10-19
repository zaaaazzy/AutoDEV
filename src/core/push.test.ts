import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushSubject } from './push.js';

test('Push-Absender: öffentliche Adresse aus Umgebung oder .env, nie localhost', () => {
  const none = () => undefined;
  assert.equal(pushSubject({ DEV_LOG_PUBLIC_URL: 'https://dev.example.ch' }, none), 'https://dev.example.ch');
  assert.equal(pushSubject({ DEV_LOG_DOMAIN: 'dev.example.ch' }, none), 'https://dev.example.ch');
  assert.equal(
    pushSubject({}, (key) => (key === 'DEV_LOG_DOMAIN' ? 'log.example.ch' : undefined)),
    'https://log.example.ch',
  );
  assert.doesNotMatch(pushSubject({}, none), /localhost/);
});
