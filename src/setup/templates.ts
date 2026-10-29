import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { normalizeProjectSlug } from '../core/validation.js';

/**
 * Projektvorlagen für den Einrichtungsassistenten. „featured“ erscheinen als Karten, die übrigen im Auswahlfeld
 * „Weitere Frameworks“. Jede Vorlage besteht aus Dateien und/oder Befehlen, die im (leeren) Projektordner laufen.
 */
export interface TemplateFile {
  path: string;
  content: string;
}

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
  group: 'featured' | 'frontend' | 'fullstack' | 'backend' | 'other';
  /** Kurzer Hinweis auf den Technologie-Stack für die Karte. */
  stack: string[];
  files?: (name: string) => TemplateFile[];
  /** Befehle nach dem Schreiben der Dateien, z. B. Generatoren oder npm install. */
  commands?: string[][];
  /** Projekt-Einstellungen, die beim Anlegen mit dieser Vorlage vorbelegt werden. */
  project?: TemplateProjectSettings;
}

/** Vorbelegung der Projekt-Einstellungen (Befehle wie in den Einstellungen: ein Befehl je Eintrag, Wörter getrennt). */
export interface TemplateProjectSettings {
  testCommands?: string[][];
  orderTestCommands?: string[][];
  reviewCommand?: string[];
  /** Vorschau-Adresse der visuellen Prüfung (Dev-Server im Projektordner). */
  previewUrl?: string;
  guidelines?: string;
}

const gitignore = `node_modules/
dist/
coverage/
.env
.env.*
!.env.example
.DS_Store
*.log
`;

const readme = (name: string, body: string): TemplateFile => ({ path: 'README.md', content: `# ${name}\n\n${body}\n` });

const nodeApiFiles = (dir: string): TemplateFile[] => [
  {
    path: `${dir}package.json`,
    content: `${JSON.stringify(
      {
        name: dir ? 'backend' : 'api',
        private: true,
        type: 'module',
        scripts: {
          dev: 'tsx watch src/server.ts',
          build: 'tsc -p tsconfig.json',
          start: 'node dist/server.js',
          test: 'tsx --test "src/**/*.test.ts"',
        },
        dependencies: { express: '^5.1.0', pg: '^8.16.0' },
        devDependencies: {
          '@types/express': '^5.0.3',
          '@types/node': '^22.15.0',
          '@types/pg': '^8.15.0',
          tsx: '^4.20.0',
          typescript: '^5.8.0',
        },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: `${dir}tsconfig.json`,
    content: `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'dist',
          rootDir: 'src',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  },
  {
    path: `${dir}src/app.ts`,
    content: `import express from 'express';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });
  return app;
}
`,
  },
  {
    path: `${dir}src/server.ts`,
    content: `import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => console.info(\`API listening on port \${port}\`));
`,
  },
  {
    path: `${dir}src/app.test.ts`,
    content: `import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';

test('health endpoint answers ok', async () => {
  const server = createApp().listen(0);
  const { port } = server.address() as { port: number };
  const response = await fetch(\`http://127.0.0.1:\${port}/api/health\`);
  assert.deepEqual(await response.json(), { status: 'ok' });
  server.close();
});
`,
  },
];

/** Ordner mit Vorlagen, die als echte Dateien im Repository liegen (templates/<id>/). */
export const TEMPLATE_FOLDER_ROOT = resolve(import.meta.dirname, '..', '..', 'templates');

/**
 * Liest eine Vorlage aus templates/<folder>/ und setzt __PROJECT_NAME__ und __PACKAGE_NAME__ ein. Erst beim Anwenden
 * (im Worker) gelesen; das Image der API braucht den Ordner nicht.
 */
export function folderFiles(folder: string, name: string, root = TEMPLATE_FOLDER_ROOT): TemplateFile[] {
  const base = join(root, folder);
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
    .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
    .map((path) => ({
      path,
      content: readFileSync(join(base, path), 'utf8')
        .replaceAll('__PROJECT_NAME__', name)
        .replaceAll('__PACKAGE_NAME__', normalizeProjectSlug(name) || 'projekt'),
    }));
}

/**
 * Feste Generator-Versionen, damit eine Vorlage heute und morgen dasselbe anlegt. Aktualisieren: `npm view <paket> version`,
 * Vorlage einmal anlegen und prüfen.
 */
export const GENERATORS = {
  createVite: 'create-vite@7.0.0',
  angularCli: '@angular/cli@20.3.40',
  createNextApp: 'create-next-app@15.5.0',
  nuxi: 'nuxi@3.25.1',
  nestCli: '@nestjs/cli@11.0.7',
} as const;

/**
 * Installationen der Vorlagen laufen ohne Install-Skripte fremder Pakete (zusätzlich setzt der Worker
 * npm_config_ignore_scripts). Generatoren, die selbst installieren, bekommen --skip-install bzw. --no-install.
 */
const NPM_INSTALL = ['npm', 'install', '--ignore-scripts'];

const viteCommands = (template: string): string[][] => [
  ['npm', 'create', '-y', GENERATORS.createVite, '.', '--', '--template', template],
  NPM_INSTALL,
];

/** Vorschau-Port des Phaser-Dev-Servers (vite.config.ts der Vorlage, strictPort). */
export const PHASER_DEV_URL = 'http://localhost:5180';

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'empty',
    label: 'Leer',
    description: 'Nur README und .gitignore – du baust alles selbst auf.',
    group: 'featured',
    stack: ['README', '.gitignore'],
    files: (name) => [readme(name, 'Neues Projekt.'), { path: '.gitignore', content: gitignore }],
  },
  {
    id: 'angular-node-postgres',
    label: 'Angular + Node.js + PostgreSQL',
    description: 'Empfohlen: Angular-Frontend, Express-API (TypeScript) und PostgreSQL in Docker – wie mainty.',
    group: 'featured',
    stack: ['Angular', 'Node.js/Express', 'PostgreSQL (Docker)'],
    files: (name) => [
      readme(
        name,
        '## Start\n\n```bash\ndocker compose up -d db\nnpm --prefix backend run dev\nnpm --prefix frontend start\n```',
      ),
      { path: '.gitignore', content: gitignore },
      {
        path: 'docker-compose.yml',
        content: `services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app_local_dev
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - db_data:/var/lib/postgresql/data
volumes:
  db_data:
`,
      },
      { path: '.env.example', content: 'DATABASE_URL=postgresql://app:app_local_dev@127.0.0.1:5432/app\n' },
      ...nodeApiFiles('backend/'),
    ],
    commands: [
      ['npm', '--prefix', 'backend', 'install', '--ignore-scripts'],
      [
        'npx',
        '-y',
        GENERATORS.angularCli,
        'new',
        'frontend',
        '--defaults',
        '--routing',
        '--style=scss',
        '--skip-git',
        '--ssr=false',
        '--skip-install',
      ],
      ['npm', '--prefix', 'frontend', 'install', '--ignore-scripts'],
    ],
  },
  {
    id: 'node-api',
    label: 'Node.js API (TypeScript)',
    description: 'Express-API mit TypeScript, Health-Endpunkt und erstem Test – ohne Frontend.',
    group: 'featured',
    stack: ['Node.js', 'Express', 'TypeScript'],
    files: (name) => [
      readme(name, '```bash\nnpm install\nnpm run dev\n```'),
      { path: '.gitignore', content: gitignore },
      ...nodeApiFiles(''),
    ],
    commands: [NPM_INSTALL],
  },
  {
    id: 'phaser-game',
    label: 'Browser-Spiel (Phaser 3)',
    description:
      'Phaser 3 mit TypeScript und Vite: Beispielszene, Unit-Tests der Spiellogik (Vitest) und Playwright-Smoke-Test.',
    group: 'featured',
    stack: ['Phaser 3', 'Vite', 'TypeScript', 'Vitest', 'Playwright'],
    files: (name) => [
      { path: '.gitignore', content: `${gitignore}test-results/\nplaywright-report/\n` },
      ...folderFiles('phaser-game', name),
    ],
    // Chromium für den Smoke-Test: gleiche Playwright-Version wie AIdeation, also meist schon vorhanden.
    commands: [
      ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
      ['npx', '--no-install', 'playwright', 'install', 'chromium'],
    ],
    project: {
      testCommands: [
        ['npm', 'run', 'build'],
        ['npm', 'test'],
        ['npm', 'run', 'test:smoke'],
      ],
      orderTestCommands: [
        ['npm', 'run', 'typecheck'],
        ['npx', 'vitest', 'run', '{tests}'],
        ['npm', 'run', 'test:smoke'],
      ],
      reviewCommand: ['npm', 'run', 'review'],
      previewUrl: PHASER_DEV_URL,
      guidelines: [
        'Browser-Spiel mit Phaser 3, TypeScript und Vite; Details in AGENTS.md.',
        'Spiellogik (Regeln, Zustand, Kollisionen, Punkte, Zeit) gehört als reine Funktionen ohne Phaser, DOM und Canvas nach src/logic/, damit sie mit Vitest testbar ist. Szenen in src/scenes/ lesen nur Eingaben, rufen die Logik auf und zeichnen.',
        'Jede neue Regel bekommt einen Unit-Test neben der Datei (src/logic/<name>.test.ts). Bewegung und Zeit über delta rechnen, Zufall über einen Seed.',
        'Der Smoke-Test (npm run test:smoke) prüft, dass der Canvas zeichnet und keine Konsolenfehler auftreten.',
      ].join('\n'),
    },
  },
  {
    id: 'react-vite',
    label: 'React + Vite',
    description: 'React mit TypeScript und Vite.',
    group: 'frontend',
    stack: ['React', 'Vite', 'TypeScript'],
    commands: viteCommands('react-ts'),
  },
  {
    id: 'vue-vite',
    label: 'Vue + Vite',
    description: 'Vue 3 mit TypeScript und Vite.',
    group: 'frontend',
    stack: ['Vue 3', 'Vite', 'TypeScript'],
    commands: viteCommands('vue-ts'),
  },
  {
    id: 'svelte-vite',
    label: 'Svelte + Vite',
    description: 'Svelte mit TypeScript und Vite.',
    group: 'frontend',
    stack: ['Svelte', 'Vite', 'TypeScript'],
    commands: viteCommands('svelte-ts'),
  },
  {
    id: 'angular',
    label: 'Angular',
    description: 'Nur Angular-Frontend (Standalone, SCSS, Routing).',
    group: 'frontend',
    stack: ['Angular', 'TypeScript'],
    commands: [
      [
        'npx',
        '-y',
        GENERATORS.angularCli,
        'new',
        'app',
        '--directory',
        '.',
        '--defaults',
        '--routing',
        '--style=scss',
        '--skip-git',
        '--ssr=false',
        '--skip-install',
      ],
      NPM_INSTALL,
    ],
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    description: 'React-Fullstack-Framework mit App Router.',
    group: 'fullstack',
    stack: ['Next.js', 'React', 'TypeScript'],
    commands: [
      [
        'npx',
        '-y',
        GENERATORS.createNextApp,
        '.',
        '--ts',
        '--eslint',
        '--app',
        '--src-dir',
        '--use-npm',
        '--yes',
        '--disable-git',
        '--skip-install',
      ],
      NPM_INSTALL,
    ],
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    description: 'Vue-Fullstack-Framework.',
    group: 'fullstack',
    stack: ['Nuxt', 'Vue', 'TypeScript'],
    // Ohne Terminal verlangt nuxi eine Vorlage; npm 10 scheitert an Nuxts Peer-Abhängigkeiten ohne --legacy-peer-deps.
    // Ohne Install-Skripte entfällt das postinstall `nuxt prepare` (.nuxt/-Typen); `npm run dev` bzw. `build` holt es nach.
    commands: [
      [
        'npx',
        '-y',
        GENERATORS.nuxi,
        'init',
        '.',
        '--template',
        'minimal',
        '--packageManager',
        'npm',
        '--gitInit',
        'false',
        '--no-install',
        '--force',
      ],
      ['npm', 'install', '--ignore-scripts', '--legacy-peer-deps'],
    ],
  },
  {
    id: 'nestjs',
    label: 'NestJS',
    description: 'Strukturiertes Node.js-Backend mit Modulen und Dependency Injection.',
    group: 'backend',
    stack: ['NestJS', 'TypeScript'],
    commands: [
      ['npx', '-y', GENERATORS.nestCli, 'new', '.', '--package-manager', 'npm', '--skip-git', '--skip-install'],
      NPM_INSTALL,
    ],
  },
  {
    id: 'fastapi',
    label: 'Python FastAPI',
    description: 'Python-API mit FastAPI und pytest.',
    group: 'backend',
    stack: ['Python', 'FastAPI'],
    files: (name) => [
      readme(
        name,
        '```bash\npython3 -m venv .venv && . .venv/bin/activate\npip install -r requirements.txt\nuvicorn app.main:app --reload\n```',
      ),
      { path: '.gitignore', content: `${gitignore}.venv/\n__pycache__/\n` },
      { path: 'requirements.txt', content: 'fastapi>=0.115\nuvicorn[standard]>=0.32\npytest>=8\nhttpx>=0.28\n' },
      { path: 'app/__init__.py', content: '' },
      {
        path: 'app/main.py',
        content:
          'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/api/health")\ndef health() -> dict[str, str]:\n    return {"status": "ok"}\n',
      },
      {
        path: 'tests/test_health.py',
        content:
          'from fastapi.testclient import TestClient\n\nfrom app.main import app\n\n\ndef test_health() -> None:\n    assert TestClient(app).get("/api/health").json() == {"status": "ok"}\n',
      },
    ],
  },
  {
    id: 'custom',
    label: 'Eigenes GitHub-Template',
    description: 'Beliebiges Repository als Vorlage klonen (Historie wird nicht übernommen).',
    group: 'other',
    stack: ['Git-URL'],
  },
];

export const TEMPLATE_GROUP_LABELS: Record<ProjectTemplate['group'], string> = {
  featured: 'Empfohlen',
  frontend: 'Frontend',
  fullstack: 'Fullstack',
  backend: 'Backend',
  other: 'Sonstiges',
};

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/** Vorlage für eine zeitgesteuerte Routine (Agent-Aufgabe mit Zeitplan, Europe/Zurich). */
export interface RoutineTemplate {
  id: string;
  title: string;
  prompt: string;
  /** Cron mit 5 Feldern. */
  schedule: string;
  outputTarget: 'chat' | 'push' | 'bug' | 'idea' | 'order';
  /** Optionales Zeitfenster „HH:MM-HH:MM“. */
  runWindow?: string;
}

const READ_ONLY = 'Nur lesen: ändere keine Dateien, installiere nichts und committe nichts.';

/**
 * Routine-Vorlagen: kommen bei jedem Projekt einmal in die Agent-Aufgaben – immer deaktiviert, bis jemand sie
 * einschaltet. Alle sind nur lesend; Befunde gehen über die Marker (@@BUG, @@IDEA, @@ORDER) weiter.
 */
export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: 'security-nightly',
    title: 'Nächtlicher Sicherheits-Check',
    prompt: `${READ_ONLY} Führe \`npm audit\` und \`npm outdated\` aus. Melde jede Sicherheitslücke ab Schwere „moderate“ als eigenen Bug (Paket, betroffene Version, behobene Version, Schwere) und fasse veraltete Hauptversionen kurz zusammen.`,
    schedule: '0 2 * * *',
    outputTarget: 'bug',
    runWindow: '22:00-06:00',
  },
  {
    id: 'docs-weekly',
    title: 'Wöchentlicher Doku-Abgleich',
    prompt: `${READ_ONLY} Vergleiche README und docs/ mit dem aktuellen Code: Befehle, Skripte, Umgebungsvariablen, Endpunkte und beschriebene Abläufe. Melde jede veraltete oder fehlende Stelle als Auftrag mit Datei und konkretem Änderungsvorschlag.`,
    schedule: '0 3 * * 1',
    outputTarget: 'order',
  },
  {
    id: 'dead-files-todos',
    title: 'Tote Dateien und TODOs finden',
    prompt: `${READ_ONLY} Suche Dateien, die nirgends importiert oder referenziert werden, sowie TODO-, FIXME- und HACK-Kommentare (z. B. mit \`git ls-files\` und \`git grep -n TODO\`). Melde zusammengehörige Funde als Idee mit Fundstellen; nichts löschen.`,
    schedule: '0 4 * * 0',
    outputTarget: 'idea',
  },
  {
    id: 'coverage-75',
    title: 'Testabdeckung unter 75 % melden',
    prompt: `${READ_ONLY} Ermittle die Testabdeckung je Bereich aus dem letzten Abdeckungsbericht des Projekts (z. B. coverage/coverage-summary.json oder lcov.info) oder mit dem Abdeckungsskript des Projekts, falls es erlaubt ist. Melde jeden Bereich unter 75 % als Auftrag. Fehlt ein Messwert oder ist der Befehl blockiert, gilt das nicht als bestanden: melde den fehlenden Wert ausdrücklich als Hinweis, nicht als 0 % oder leer.`,
    schedule: '0 5 * * 1',
    outputTarget: 'order',
  },
];
