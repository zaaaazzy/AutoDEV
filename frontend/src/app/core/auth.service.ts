import { Injectable, signal } from '@angular/core';

/** Anmeldestatus: Sobald die API 401 meldet, zeigt die Oberfläche die Login-Seite. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly required = signal(false);
}
