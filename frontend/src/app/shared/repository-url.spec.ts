import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repositoryWebUrl } from './repository-url.js';

test('Repository-Adresse aus dem Git-Remote: SSH und HTTPS, ohne Zugangsdaten und .git', () => {
  assert.equal(repositoryWebUrl('git@github.com:ana/shop.git'), 'https://github.com/ana/shop');
  assert.equal(repositoryWebUrl('https://github.com/ana/shop.git'), 'https://github.com/ana/shop');
  assert.equal(repositoryWebUrl('https://token@github.com/ana/shop/'), 'https://github.com/ana/shop');
  assert.equal(repositoryWebUrl('http://git.local:8080/ana/shop'), 'https://git.local:8080/ana/shop');
  assert.equal(repositoryWebUrl(''), null);
  assert.equal(repositoryWebUrl(null), null);
  assert.equal(repositoryWebUrl('/lokaler/ordner'), null);
});
