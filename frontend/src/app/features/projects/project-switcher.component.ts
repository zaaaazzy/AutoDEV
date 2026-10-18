import { Component, ElementRef, computed, inject, output, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { Project } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';

/** Projektwahl in der Kopfzeile (Desktop): Favicon und Name, Liste aller Projekte, „Neues Projekt“ ganz unten. */
@Component({
  selector: 'app-project-switcher',
  standalone: true,
  templateUrl: './project-switcher.component.html',
  host: {
    class: 'project-switcher',
    '(document:click)': 'closeOnOutside($event)',
    '(document:keydown.escape)': 'open.set(false)',
  },
})
export class ProjectSwitcherComponent {
  private readonly api = inject(ApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly store = inject(ProjectStore);
  readonly create = output<void>();

  protected readonly open = signal(false);
  /** Favicons, die nicht geladen werden konnten – dann das Dev-Log-Zeichen. */
  protected readonly failed = signal(new Set<string>());
  protected readonly current = computed(() => this.store.currentProject() ?? null);

  protected icon(project: Project | null): string | null {
    if (!project?.faviconVersion) return null;
    const url = this.api.url(`/api/projects/${encodeURIComponent(project.slug)}/favicon?v=${project.faviconVersion}`);
    return this.failed().has(url) ? null : url;
  }

  protected iconFailed(url: string): void {
    this.failed.set(new Set(this.failed()).add(url));
  }

  protected choose(project: Project): void {
    this.open.set(false);
    if (project.slug !== this.store.activeProject()) void this.store.loadProject(project.slug);
  }

  protected newProject(): void {
    this.open.set(false);
    this.create.emit();
  }

  protected closeOnOutside(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  /** Pfeiltasten wandern durch die Liste. */
  protected move(event: KeyboardEvent): void {
    const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.switcher-item'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  }
}
