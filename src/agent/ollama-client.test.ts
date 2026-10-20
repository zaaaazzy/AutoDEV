import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  patientFetch,
  requestOllamaChat,
  resolveContext,
  resolveModel,
} from './ollama-client.js';

test('resolveModel: Rollenmodell vor globalem Modell vor Standard', () => {
  assert.equal(resolveModel('author', {}), DEFAULT_OLLAMA_MODEL);
  assert.equal(resolveModel('author', { DEV_LOG_OLLAMA_MODEL: ' llama3 ' }), 'llama3');
  assert.equal(
    resolveModel('bug_reviewer', { DEV_LOG_OLLAMA_MODEL: 'a', DEV_LOG_OLLAMA_MODEL_BUG_REVIEWER: 'b' }),
    'b',
  );
  // Sonderzeichen der Rolle werden zu „_“; leere Werte zählen nicht.
  assert.equal(resolveModel('pre-sprint', { DEV_LOG_OLLAMA_MODEL_PRE_SPRINT: 'c' }), 'c');
  assert.equal(
    resolveModel('author', { DEV_LOG_OLLAMA_MODEL_AUTHOR: '  ', DEV_LOG_OLLAMA_MODEL: '' }),
    DEFAULT_OLLAMA_MODEL,
  );
});

test('resolveContext: gültige Werte zwischen 2048 und 131072, sonst Rollenstandard', () => {
  assert.equal(resolveContext('developer', {}), 32_768);
  assert.equal(resolveContext('tester', {}), 16_384);
  assert.equal(resolveContext('tester', { DEV_LOG_OLLAMA_CTX: '8192' }), 8192);
  assert.equal(resolveContext('tester', { DEV_LOG_OLLAMA_CTX: '8192', DEV_LOG_OLLAMA_CTX_TESTER: '4096' }), 4096);
  assert.equal(resolveContext('tester', { DEV_LOG_OLLAMA_CTX: '2048' }), 2048, 'untere Grenze');
  assert.equal(resolveContext('tester', { DEV_LOG_OLLAMA_CTX: '131072' }), 131_072, 'obere Grenze');
  for (const value of ['2047', '131073', '4096.5', 'viel', '']) {
    assert.equal(resolveContext('developer', { DEV_LOG_OLLAMA_CTX: value }), 32_768, value);
  }
});

test('requestOllamaChat: POST an /api/chat mit JSON und Abbruchsignal – ohne Netzwerk', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const signal = new AbortController().signal;
  const response = await requestOllamaChat(fetchImpl, DEFAULT_OLLAMA_URL, { model: 'm', stream: false }, signal);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(calls[0]!.init.headers, { 'Content-Type': 'application/json' });
  assert.equal(calls[0]!.init.signal, signal);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { model: 'm', stream: false });
});

test('patientFetch: bricht mit bereits abgebrochenem Signal ab, bevor eine Verbindung entsteht', async () => {
  const controller = new AbortController();
  controller.abort(new Error('abgebrochen'));
  // Port 9 (discard) auf localhost; durch das abgebrochene Signal wird gar nicht erst verbunden.
  await assert.rejects(patientFetch('http://127.0.0.1:9/api/chat', { signal: controller.signal }), /abgebrochen/);
});
