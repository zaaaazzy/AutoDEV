import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component.js';
import { startLayoutCheck } from './app/core/layout-check.js';

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient()],
})
  .then(() => startLayoutCheck())
  .catch((error: unknown) => {
    console.error('AIdeation UI failed to start:', error);
  });

// Service Worker für Push-Nachrichten und Installation als App (nur über HTTPS bzw. localhost verfügbar).
if ('serviceWorker' in navigator && globalThis.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((error: unknown) => {
    console.warn('Service Worker konnte nicht registriert werden:', error);
  });
}
