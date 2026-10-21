import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installPrompt, listenForInstallPrompt } from './install-prompt.js';

class PromptEvent extends Event {
  prompt(): Promise<void> {
    return Promise.resolve();
  }
}

test('Install-Angebot: Listener hängen nur einmal und lassen sich wieder entfernen', () => {
  const target = new EventTarget();
  const stop = listenForInstallPrompt(target);
  assert.equal(listenForInstallPrompt(target), stop, 'zweiter Aufruf hängt keinen weiteren Listener an');

  const event = new PromptEvent('beforeinstallprompt', { cancelable: true });
  target.dispatchEvent(event);
  assert.equal(installPrompt(), event);
  assert.equal(event.defaultPrevented, true);

  target.dispatchEvent(new Event('appinstalled'));
  assert.equal(installPrompt(), null);

  stop();
  target.dispatchEvent(new PromptEvent('beforeinstallprompt', { cancelable: true }));
  assert.equal(installPrompt(), null, 'nach dem Entfernen reagiert nichts mehr');
});
