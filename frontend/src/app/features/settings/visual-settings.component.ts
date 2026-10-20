import { Component, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Project, VisualSettings } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';

const EMPTY_LOGIN = {
  path: '',
  userSelector: '',
  passwordSelector: '',
  submitSelector: '',
  userKey: '',
  passwordKey: '',
};

/**
 * Projekt-Einstellungen der visuellen Prüfung: Adresse der laufenden Vorschau, aufzunehmende Seiten, Toleranz,
 * Masken, optionaler Test-Login (Werte nur aus der .env.example) und das abschaltbare KI-Urteil.
 */
@Component({
  selector: 'app-visual-settings',
  standalone: true,
  imports: [FormsModule],
  host: { style: 'display: contents' },
  template: `
    <section class="panel" id="visual-settings">
      <div class="section-heading">
        <div>
          <h2>Visuelle Prüfung</h2>
          <p class="muted">
            Screenshots der Vorschau auf Desktop und Handy nach dem Tester, Vergleich mit dem letzten Stand und
            automatische Layout-Prüfungen (nur Frontend- und Fullstack-Aufträge)
          </p>
        </div>
      </div>
      <form class="form-grid" (ngSubmit)="save()">
        <label class="wide"
          >Vorschau-Adresse<input
            name="previewUrl"
            [(ngModel)]="form.previewUrl"
            maxlength="300"
            placeholder="http://localhost:4200"
          />
        </label>
        <p class="muted wide">
          Leer = Schritt wird übersprungen. Der Dev-Server muss laufen (Deploy-Befehle des Projekts); die Prüfung
          startet ihn nicht selbst.
        </p>
        <label class="wide"
          >Seiten (ein Pfad pro Zeile)<textarea
            name="previewPages"
            [(ngModel)]="form.previewPages"
            rows="3"
            placeholder="/&#10;/#dashboard"
          ></textarea>
        </label>
        <label
          >Toleranz (% geänderte Pixel)<input
            name="tolerance"
            type="number"
            min="0"
            max="100"
            step="0.1"
            [(ngModel)]="form.tolerance"
          />
        </label>
        <label class="wide"
          >Masken (CSS-Selektor pro Zeile, z. B. Zeiten und Zahlen)<textarea
            name="masks"
            [(ngModel)]="form.masks"
            rows="2"
            placeholder=".timestamp&#10;[data-dynamic]"
          ></textarea>
        </label>
        <label class="wide check"
          ><input type="checkbox" name="loginEnabled" [(ngModel)]="form.loginEnabled" /> Vor den Aufnahmen anmelden
          (Test-Login)</label
        >
        @if (form.loginEnabled) {
          <label
            >Login-Seite<input name="loginPath" [(ngModel)]="form.login.path" maxlength="300" placeholder="/#login"
          /></label>
          <label
            >Feld Benutzer<input
              name="userSelector"
              [(ngModel)]="form.login.userSelector"
              maxlength="200"
              placeholder="input[name=username]"
          /></label>
          <label
            >Feld Passwort<input
              name="passwordSelector"
              [(ngModel)]="form.login.passwordSelector"
              maxlength="200"
              placeholder="input[type=password]"
          /></label>
          <label
            >Anmelde-Knopf<input
              name="submitSelector"
              [(ngModel)]="form.login.submitSelector"
              maxlength="200"
              placeholder="button[type=submit]"
          /></label>
          <label
            >Name des Benutzer-Werts<input
              name="userKey"
              [(ngModel)]="form.login.userKey"
              maxlength="64"
              placeholder="E2E_USERNAME"
          /></label>
          <label
            >Name des Passwort-Werts<input
              name="passwordKey"
              [(ngModel)]="form.login.passwordKey"
              maxlength="64"
              placeholder="E2E_PASSWORD"
          /></label>
          <p class="muted wide">
            Die Werte stammen nur aus der <code>.env.example</code> des Projekts. Passwortfelder werden in Screenshots
            immer abgedeckt; Zugangsdaten erscheinen nie in Logs oder Prüftexten.
          </p>
        }
        <label class="wide check"
          ><input type="checkbox" name="aiJudge" [(ngModel)]="form.aiJudge" /> KI-Urteil: ein bildfähiges Modell prüft
          die Akzeptanzkriterien anhand der Screenshots</label
        >
        @if (form.aiJudge) {
          <label class="wide"
            >Ollama-Bildmodell (nur ohne eigenen Befehl des Agents)<input
              name="visionModel"
              [(ngModel)]="form.visionModel"
              maxlength="100"
              placeholder="llava:13b"
          /></label>
        }
        <button class="button primary" type="submit" [disabled]="busy()">Visuelle Prüfung speichern</button>
      </form>
    </section>
  `,
})
export class VisualSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly busy = this.store.busy;
  protected form = {
    previewUrl: '',
    previewPages: '',
    tolerance: 0.5,
    masks: '',
    loginEnabled: false,
    login: { ...EMPTY_LOGIN },
    aiJudge: false,
    visionModel: '',
  };

  constructor() {
    effect(() => {
      this.store.foregroundLoads();
      this.store.activeProject();
      untracked(() => this.fill());
    });
  }

  private fill(): void {
    const project = this.store.currentProject();
    const settings = project?.visualSettings;
    this.form = {
      previewUrl: project?.previewUrl ?? '',
      previewPages: (project?.previewPages ?? []).join('\n'),
      tolerance: settings?.tolerance ?? 0.5,
      masks: (settings?.masks ?? []).join('\n'),
      loginEnabled: Boolean(settings?.login),
      login: { ...EMPTY_LOGIN, ...(settings?.login ?? {}) },
      aiJudge: settings?.aiJudge ?? false,
      visionModel: settings?.visionModel ?? '',
    };
  }

  protected async save(): Promise<void> {
    const slug = this.store.activeProject();
    const current = this.store.currentProject()?.visualSettings;
    const visualSettings: VisualSettings = {
      tolerance: Number(this.form.tolerance),
      threshold: current?.threshold ?? 0.1,
      masks: this.form.masks
        .split('\n')
        .map((mask) => mask.trim())
        .filter(Boolean),
      login: this.form.loginEnabled ? { ...this.form.login } : null,
      aiJudge: this.form.aiJudge,
      visionModel: this.form.visionModel.trim() || null,
    };
    await this.store.perform(
      async () => {
        const result = await this.api.patch<{ project: Project }>(this.api.projectPath(slug), {
          previewUrl: this.form.previewUrl.trim(),
          previewPages: this.form.previewPages,
          visualSettings,
        });
        this.store.projects.update((projects) =>
          projects.map((project) => (project.slug === slug ? { ...project, ...result.project } : project)),
        );
      },
      'Visuelle Prüfung gespeichert.',
      false,
    );
  }
}
