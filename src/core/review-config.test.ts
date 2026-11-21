import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseReviewPort,
  reviewCommandLines,
  reviewDockerfileError,
  reviewHealthPathError,
  reviewHealthUrl,
  reviewPort,
  reviewProjectImage,
  reviewScript,
  reviewUrl,
} from './review-config.js';

test('Review-Container: Host-Port und Adresse je Nummer, Health-Pfad mit Standard „/“', () => {
  assert.equal(reviewPort(1), 4201);
  assert.equal(reviewUrl(3), 'http://localhost:4203');
  assert.equal(reviewHealthUrl(2, null), 'http://localhost:4202/');
  assert.equal(reviewHealthUrl(2, '  '), 'http://localhost:4202/');
  assert.equal(reviewHealthUrl(2, '/health'), 'http://localhost:4202/health');
});

test('Review-Befehle: Zeilen aus der Spalte, Unbekanntes zählt als kein Befehl', () => {
  assert.deepEqual(reviewCommandLines(['npm run build', ' npm start ', '']), ['npm run build', 'npm start']);
  assert.deepEqual(reviewCommandLines(null), []);
  assert.deepEqual(reviewCommandLines('npm start'), []);
  assert.deepEqual(reviewCommandLines([1, 'x']), []);
});

test('Review-Skript: eine Zeile je Befehl, /source/ wird /work/', () => {
  assert.equal(
    reviewScript(['sh /source/scripts/review.sh', 'vite preview --port $REVIEW_FRONTEND_PORT']),
    'sh /work/scripts/review.sh\nvite preview --port $REVIEW_FRONTEND_PORT',
  );
});

test('Port der App im Container: leer = Standard, 1 bis 65535, sonst ungültig', () => {
  assert.equal(parseReviewPort(undefined), null);
  assert.equal(parseReviewPort(null), null);
  assert.equal(parseReviewPort(''), null);
  assert.equal(parseReviewPort(8080), 8080);
  assert.equal(parseReviewPort(' 3000 '), 3000);
  for (const bad of [0, 65536, -1, 1.5, 'abc', '80 80', true, {}]) {
    assert.equal(parseReviewPort(bad), undefined, String(bad));
  }
});

test('Health-Pfad: beginnt mit „/“, ohne Leerzeichen, höchstens 200 Zeichen', () => {
  assert.equal(reviewHealthPathError(''), null);
  assert.equal(reviewHealthPathError('/'), null);
  assert.equal(reviewHealthPathError('/api/health?deep=1'), null);
  assert.match(String(reviewHealthPathError('health')), /beginnt mit/);
  assert.match(String(reviewHealthPathError('/a b')), /Leerzeichen/);
  assert.match(String(reviewHealthPathError(`/${'x'.repeat(200)}`)), /200/);
});

test('Review-Dockerfile: nur relative Pfade im Projekt, kein „..“, kein führendes „/“', () => {
  assert.equal(reviewDockerfileError(''), null);
  assert.equal(reviewDockerfileError('Dockerfile'), null);
  assert.equal(reviewDockerfileError('deploy/review/Dockerfile'), null);
  assert.equal(reviewDockerfileError('.docker/review.Dockerfile'), null);
  for (const bad of [
    '/etc/Dockerfile',
    '../Dockerfile',
    'deploy/../../Dockerfile',
    'deploy//Dockerfile',
    'deploy/',
    'deploy/Docker file',
    'deploy/Dockerfile;rm -rf /',
    'C:\\Dockerfile',
    `${'a/'.repeat(101)}Dockerfile`,
  ]) {
    assert.match(String(reviewDockerfileError(bad)), /relativ zum Projekt/, bad);
  }
});

test('Projekteigenes Review-Image: Name aus dem Slug mit Docker-tauglichen Zeichen', () => {
  assert.equal(reviewProjectImage('mainty'), 'aideation-review-mainty');
  assert.equal(reviewProjectImage('Mein Projekt/x'), 'aideation-review-mein_projekt_x');
});
