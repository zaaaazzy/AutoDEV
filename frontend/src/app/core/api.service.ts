import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service.js';
import { FieldError } from './errors.js';
import type { Project } from './models.js';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly basePath = globalThis.location.pathname.startsWith('/dev-log/') ? '/dev-log' : '';

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>(path, 'POST', body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, 'PATCH', body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, 'PUT', body);
  }

  delete(path: string, body?: unknown): Promise<void> {
    return this.request<void>(path, 'DELETE', body);
  }

  upload<T>(path: string, file: File): Promise<T> {
    return this.request<T>(`${path}?name=${encodeURIComponent(file.name)}`, 'POST', file);
  }

  url(path: string): string {
    return `${this.basePath}${path}`;
  }

  projectPath(slug: string): string {
    return `/api/projects/${encodeURIComponent(slug)}`;
  }

  async projects(): Promise<Project[]> {
    const result = await this.get<{ projects: Project[] }>('/api/projects');
    return result.projects ?? [];
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    try {
      return await firstValueFrom(this.http.request<T>(method, `${this.basePath}${path}`, { body }));
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 401 && path !== '/api/login') this.auth.required.set(true);
        const message =
          typeof error.error === 'object' &&
          error.error !== null &&
          'message' in error.error &&
          typeof error.error.message === 'string'
            ? error.error.message
            : error.status === 0
              ? 'AIdeation ist nicht erreichbar. Prüfe, ob der Server läuft, und lade die Seite neu.'
              : `Anfrage fehlgeschlagen (${error.status}).`;
        const field =
          typeof error.error === 'object' &&
          error.error !== null &&
          'field' in error.error &&
          typeof error.error.field === 'string'
            ? error.error.field
            : '';
        throw field ? new FieldError(message, field, { cause: error }) : new Error(message, { cause: error });
      }
      throw error;
    }
  }
}
