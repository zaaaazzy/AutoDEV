import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component.js';

bootstrapApplication(AppComponent, {
  providers: [provideHttpClient()],
}).catch((error: unknown) => {
  console.error('Dev Log UI failed to start:', error);
});

// Service Worker für Push-Nachrichten und Installation als App (nur über HTTPS bzw. localhost verfügbar).
if ('serviceWorker' in navigator && globalThis.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((error: unknown) => {
    console.warn('Service Worker konnte nicht registriert werden:', error);
  });
}
