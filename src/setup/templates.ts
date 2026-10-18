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
      ['npm', '--prefix', 'backend', 'install'],
      [
        'npx',
        '-y',
        '@angular/cli@20',
        'new',
        'frontend',
        '--defaults',
        '--routing',
        '--style=scss',
        '--skip-git',
        '--ssr=false',
      ],
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
    commands: [['npm', 'install']],
  },
  {
    id: 'react-vite',
    label: 'React + Vite',
    description: 'React mit TypeScript und Vite.',
    group: 'frontend',
    stack: ['React', 'Vite', 'TypeScript'],
    commands: [
      ['npm', 'create', '-y', 'vite@latest', '.', '--', '--template', 'react-ts'],
      ['npm', 'install'],
    ],
  },
  {
    id: 'vue-vite',
    label: 'Vue + Vite',
    description: 'Vue 3 mit TypeScript und Vite.',
    group: 'frontend',
    stack: ['Vue 3', 'Vite', 'TypeScript'],
    commands: [
      ['npm', 'create', '-y', 'vite@latest', '.', '--', '--template', 'vue-ts'],
      ['npm', 'install'],
    ],
  },
  {
    id: 'svelte-vite',
    label: 'Svelte + Vite',
    description: 'Svelte mit TypeScript und Vite.',
    group: 'frontend',
    stack: ['Svelte', 'Vite', 'TypeScript'],
    commands: [
      ['npm', 'create', '-y', 'vite@latest', '.', '--', '--template', 'svelte-ts'],
      ['npm', 'install'],
    ],
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
        '@angular/cli@20',
        'new',
        'app',
        '--directory',
        '.',
        '--defaults',
        '--routing',
        '--style=scss',
        '--skip-git',
        '--ssr=false',
      ],
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
        'create-next-app@latest',
        '.',
        '--ts',
        '--eslint',
        '--app',
        '--src-dir',
        '--use-npm',
        '--yes',
        '--disable-git',
      ],
    ],
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    description: 'Vue-Fullstack-Framework.',
    group: 'fullstack',
    stack: ['Nuxt', 'Vue', 'TypeScript'],
    commands: [['npx', '-y', 'nuxi@latest', 'init', '.', '--packageManager', 'npm', '--gitInit', 'false', '--force']],
  },
  {
    id: 'nestjs',
    label: 'NestJS',
    description: 'Strukturiertes Node.js-Backend mit Modulen und Dependency Injection.',
    group: 'backend',
    stack: ['NestJS', 'TypeScript'],
    commands: [['npx', '-y', '@nestjs/cli@latest', 'new', '.', '--package-manager', 'npm', '--skip-git']],
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
