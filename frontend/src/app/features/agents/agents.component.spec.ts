import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AgentActivityService } from '../../core/agent-activity.service';
import { ApiService } from '../../core/api.service';
import { emptyProjectData } from '../../core/models';
import { ProjectStore } from '../../core/project-store';
import { AgentsComponent } from './agents.component';

const SYSTEM_AGENTS = [
  { name: 'Dashboard-Assistent', description: '', role: 'assistant', model: 'qwen3.5:9b', envKey: 'X', command: null },
  {
    name: 'Problemanalyse',
    description: '',
    role: 'analyst',
    model: 'qwen3.5:9b',
    envKey: 'Y',
    command: ['copilot', '--allow-all-tools', '-p', '{prompt}'],
    restricted: true,
    allowTools: false,
  },
  {
    name: 'Schnellschätzung',
    description: '',
    role: 'author',
    model: 'qwen3.5:9b',
    envKey: 'Z',
    command: ['mein-cli', '--frag'],
    restricted: true,
    allowTools: false,
  },
];

async function render() {
  const put = vi.fn().mockResolvedValue({});
  TestBed.configureTestingModule({
    imports: [AgentsComponent],
    providers: [
      {
        provide: ApiService,
        useValue: { get: vi.fn().mockResolvedValue({ agents: SYSTEM_AGENTS, models: ['qwen3.5:9b'] }), put },
      },
      {
        provide: ProjectStore,
        useValue: {
          ready: signal(true),
          selectedAgent: signal(null),
          showCreate: signal(false),
          data: signal(emptyProjectData()),
          busy: signal(false),
          notice: signal(''),
        },
      },
      { provide: AgentActivityService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(AgentsComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, element: fixture.nativeElement as HTMLElement, put };
}

const card = (element: HTMLElement, name: string): HTMLElement =>
  Array.from(element.querySelectorAll<HTMLElement>('article.item-card')).find((item) =>
    item.textContent?.includes(name),
  )!;

describe('AgentsComponent – System-Agents', () => {
  it('shows a command that matches no preset instead of a local model', async () => {
    const { element } = await render();
    const select = card(element, 'Schnellschätzung').querySelector('select')!;
    expect(select.selectedOptions[0]?.textContent).toContain('Eigener Befehl: mein-cli --frag');
  });

  it('offers the tool-rights switch only for restricted roles with a CLI', async () => {
    const { element } = await render();
    expect(card(element, 'Dashboard-Assistent').querySelector('.system-tools')).toBeNull();
    expect(card(element, 'Problemanalyse').querySelector('.system-tools')).not.toBeNull();
    expect(card(element, 'Problemanalyse').textContent).toContain('Rechte-Flags werden entfernt');
  });

  it('saves the tool-rights switch and updates the hint', async () => {
    const { fixture, element, put } = await render();
    const checkbox = card(element, 'Problemanalyse').querySelector<HTMLInputElement>('.system-tools input')!;
    checkbox.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(put).toHaveBeenCalledWith('/api/system-agents/analyst', { allowTools: true });
    expect(card(element, 'Problemanalyse').textContent).toContain('Die CLI kann Dateien ändern');
  });

  it('switching to a local model clears the command', async () => {
    const { fixture, element, put } = await render();
    const select = card(element, 'Problemanalyse').querySelector('select')!;
    select.value = 'ollama:qwen3.5:9b';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(put).toHaveBeenCalledWith('/api/system-agents/analyst', { model: 'qwen3.5:9b', command: null });
  });
});
