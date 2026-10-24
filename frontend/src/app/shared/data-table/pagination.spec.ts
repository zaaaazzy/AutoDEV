import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPage, countText, pageCount, pageItems, pageRange } from './pagination.js';

test('Seitenzahl und Begrenzung: leere Tabelle hat eine Seite, zu große Seite rutscht auf die letzte', () => {
  assert.equal(pageCount(0, 20), 1);
  assert.equal(pageCount(20, 20), 1);
  assert.equal(pageCount(21, 20), 2);
  assert.equal(clampPage(5, 41, 20), 2);
  assert.equal(clampPage(-1, 41, 20), 0);
  assert.equal(clampPage(3, 0, 20), 0);
});

test('Bereich „21–40 von 57“: letzte Seite endet bei der Gesamtzahl', () => {
  assert.deepEqual(pageRange(0, 57, 20), { from: 1, to: 20 });
  assert.deepEqual(pageRange(1, 57, 20), { from: 21, to: 40 });
  assert.deepEqual(pageRange(2, 57, 20), { from: 41, to: 57 });
  assert.deepEqual(pageRange(9, 57, 20), { from: 41, to: 57 });
  assert.deepEqual(pageRange(0, 0, 20), { from: 0, to: 0 });
});

test('Seitenknöpfe: bis sieben Seiten alle, sonst immer sieben Einträge mit echten Lücken', () => {
  assert.deepEqual(pageItems(0, 1), [0]);
  assert.deepEqual(pageItems(3, 7), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pageItems(0, 10), [0, 1, 2, 3, 4, 'gap', 9]);
  assert.deepEqual(pageItems(3, 10), [0, 1, 2, 3, 4, 'gap', 9]);
  assert.deepEqual(pageItems(4, 10), [0, 'gap', 3, 4, 5, 'gap', 9]);
  assert.deepEqual(pageItems(6, 10), [0, 'gap', 5, 6, 7, 8, 9]);
  assert.deepEqual(pageItems(9, 10), [0, 'gap', 5, 6, 7, 8, 9]);
  for (let count = 8; count <= 30; count++) {
    for (let page = 0; page < count; page++) {
      const items = pageItems(page, count);
      assert.equal(items.length, 7, `${page}/${count}`);
      assert.ok(items.includes(page), `aktuelle Seite ${page}/${count} fehlt`);
      // Eine Lücke steht nie für nur eine Seite.
      items.forEach((item, index) => {
        if (item !== 'gap') return;
        const before = items[index - 1] as number;
        const after = items[index + 1] as number;
        assert.ok(after - before > 2, `Lücke für eine Seite bei ${page}/${count}`);
      });
    }
  }
});

test('Zählzeile unter der Tabelle', () => {
  assert.equal(countText(null, 1, 1), '1 Eintrag');
  assert.equal(countText(null, 12, 12), '12 Einträge');
  assert.equal(countText(null, 5, 12), '5 von 12 Einträgen');
  assert.equal(countText({ from: 21, to: 40 }, 57, 57), '21–40 von 57 Einträgen');
  assert.equal(countText({ from: 1, to: 20 }, 45, 120), '1–20 von 45 Einträgen · gefiltert aus 120');
});
