import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiService } from './api.service';

describe('ApiService', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('passes the server message of a failed request on', async () => {
    const result = api.put('/api/system-agents/analyst', { allowTools: 'ja' });
    http
      .expectOne('/api/system-agents/analyst')
      .flush({ message: 'Ungültige Rolle' }, { status: 400, statusText: 'Bad' });
    await expect(result).rejects.toThrow('Ungültige Rolle');
  });

  it('explains an unreachable server', async () => {
    const result = api.get('/api/projects');
    http.expectOne('/api/projects').error(new ProgressEvent('error'), { status: 0 });
    await expect(result).rejects.toThrow(/nicht erreichbar/);
  });

  it('falls back to the status code without a message', async () => {
    const result = api.delete('/api/agents/1');
    http.expectOne('/api/agents/1').flush('kaputt', { status: 500, statusText: 'Error' });
    await expect(result).rejects.toThrow('Anfrage fehlgeschlagen (500).');
  });
});
