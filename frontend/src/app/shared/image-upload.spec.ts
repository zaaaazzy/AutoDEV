import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertImageSizes, MAX_IMAGE_BYTES } from './image-upload.js';

test('Bildgröße: zu großes Bild wird vor dem Anlegen abgewiesen', () => {
  assert.throws(
    () =>
      assertImageSizes([
        { name: 'klein.png', size: 1000 },
        { name: 'gross.png', size: 6 * 1024 * 1024 },
      ]),
    /gross\.png ist größer als 5 MB/,
  );
});

test('Bildgröße: Bilder bis 5 MB und leere Auswahl sind erlaubt', () => {
  assert.doesNotThrow(() => assertImageSizes([{ name: 'genau.png', size: MAX_IMAGE_BYTES }]));
  assert.doesNotThrow(() => assertImageSizes([]));
});
