export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name TEXT NOT NULL,
    repository TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    guidelines TEXT NOT NULL DEFAULT '',
    git_remote TEXT,
    database_url TEXT,
    test_commands JSONB,
    deploy_commands JSONB,
    deploy_status TEXT,
    auto_bugfix BOOLEAN NOT NULL DEFAULT TRUE,
    agents_seeded BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS worker_heartbeats (
    project_slug TEXT PRIMARY KEY,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pid INTEGER,
    interval_seconds INTEGER NOT NULL DEFAULT 30,
    last_error TEXT,
    cpu_percent REAL
  );

  CREATE TABLE IF NOT EXISTS test_runs (
    id UUID PRIMARY KEY,
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
    trigger TEXT NOT NULL,
    branch TEXT,
    commit_sha TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS test_runs_project_started_idx ON test_runs (project_slug, started_at DESC);

  CREATE TABLE IF NOT EXISTS test_run_steps (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
    exit_code INTEGER,
    duration_ms INTEGER,
    output TEXT NOT NULL DEFAULT '',
    UNIQUE (run_id, position)
  );
  -- Testkategorien (Qualität, Unit, E2E, User), Einzelergebnisse und Screenshots/Videos aus Playwright.
  ALTER TABLE test_run_steps ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('quality', 'unit', 'e2e', 'user'));
  CREATE TABLE IF NOT EXISTS test_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('unit', 'e2e', 'user')),
    title TEXT NOT NULL,
    file TEXT,
    device TEXT,
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'flaky')),
    duration_ms INTEGER,
    errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    UNIQUE (run_id, position)
  );
  CREATE TABLE IF NOT EXISTS test_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    case_id UUID REFERENCES test_cases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'video/webm')),
    size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 52428800),
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS test_media_run_idx ON test_media (run_id);
  CREATE INDEX IF NOT EXISTS test_media_case_idx ON test_media (case_id);
  -- Testbericht (Markdown) eines Laufs, erscheint in der Dokumentation unter „Testberichte“.
  ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS report TEXT;
  -- Betriebssystem des Rechners, auf dem der Lauf lief (darwin, win32, linux).
  ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS platform TEXT;

  CREATE TABLE IF NOT EXISTS ideation_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea'
      CHECK (status IN ('idea', 'considering', 'review', 'requested', 'drafting', 'accepted', 'rejected')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    effort_hours DOUBLE PRECISION CHECK (effort_hours >= 0),
    token_estimate BIGINT CHECK (token_estimate >= 0),
    benefit SMALLINT CHECK (benefit BETWEEN 0 AND 10),
    cost SMALLINT CHECK (cost BETWEEN 0 AND 10),
    agent_note TEXT,
    revision_prompt TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Bestehende Datenbanken: Status-Check um 'review' (Prüfen) erweitern.
  ALTER TABLE ideation_items DROP CONSTRAINT IF EXISTS ideation_items_status_check;
  ALTER TABLE ideation_items ADD CONSTRAINT ideation_items_status_check
    CHECK (status IN ('idea', 'considering', 'review', 'requested', 'drafting', 'accepted', 'rejected'));
  CREATE INDEX IF NOT EXISTS ideation_items_project_status_idx ON ideation_items (project_slug, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS ideation_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ideation_id UUID NOT NULL REFERENCES ideation_items(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS ideation_comments_idea_idx ON ideation_comments (ideation_id, created_at);

  CREATE TABLE IF NOT EXISTS ideation_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ideation_id UUID NOT NULL REFERENCES ideation_items(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 5242880),
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS ideation_attachments_idea_idx ON ideation_attachments (ideation_id);

  CREATE TABLE IF NOT EXISTS sprints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
    start_date DATE,
    end_date DATE,
    git_sync TEXT CHECK (git_sync IN ('pending', 'running', 'done', 'failed')),
    git_action TEXT NOT NULL DEFAULT 'push' CHECK (git_action IN ('push', 'pull')),
    git_message TEXT,
    git_commit TEXT,
    git_branch TEXT,
    git_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sprints_one_active_idx ON sprints (project_slug) WHERE status = 'active';

  CREATE OR REPLACE FUNCTION sprints_queue_git_sync() RETURNS trigger AS $fn$
  BEGIN
    IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
      NEW.git_sync := 'pending';
      NEW.git_action := 'push';
      NEW.git_message := NULL;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS sprints_git_sync ON sprints;
  CREATE TRIGGER sprints_git_sync BEFORE UPDATE OF status ON sprints
    FOR EACH ROW EXECUTE FUNCTION sprints_queue_git_sync();

  CREATE TABLE IF NOT EXISTS sprint_reports (
    sprint_id UUID PRIMARY KEY REFERENCES sprints(id) ON DELETE CASCADE,
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    summary TEXT NOT NULL DEFAULT '',
    implemented JSONB NOT NULL DEFAULT '[]',
    missing JSONB NOT NULL DEFAULT '[]',
    problems JSONB NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    role TEXT NOT NULL DEFAULT 'custom' CHECK (role IN
      ('author', 'developer', 'tester', 'reviewer', 'documenter', 'bug_reviewer', 'manual_writer', 'user_manual_writer', 'custom')),
    phase TEXT NOT NULL CHECK (phase IN ('pre_task', 'while_task', 'after_task')),
    position INTEGER NOT NULL DEFAULT 0,
    instructions TEXT NOT NULL DEFAULT '',
    command TEXT[],
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS agents_project_workflow_idx ON agents (project_slug, phase, position);

  CREATE TABLE IF NOT EXISTS bugs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
    description TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'fixed', 'wontfix')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent')),
    sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL,
    fix_notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fixed_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS bugs_project_status_idx ON bugs (project_slug, status, created_at DESC);

  -- Bilder gehören entweder zu einer Idee oder zu einem Bug.
  ALTER TABLE ideation_attachments ALTER COLUMN ideation_id DROP NOT NULL;
  ALTER TABLE ideation_attachments ADD COLUMN IF NOT EXISTS bug_id UUID REFERENCES bugs(id) ON DELETE CASCADE;
  ALTER TABLE ideation_attachments DROP CONSTRAINT IF EXISTS ideation_attachments_owner_check;
  ALTER TABLE ideation_attachments ADD CONSTRAINT ideation_attachments_owner_check
    CHECK ((ideation_id IS NULL) <> (bug_id IS NULL));
  CREATE INDEX IF NOT EXISTS ideation_attachments_bug_idx ON ideation_attachments (bug_id);
  CREATE INDEX IF NOT EXISTS bugs_sprint_idx ON bugs (sprint_id);

  CREATE TABLE IF NOT EXISTS development_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    ideation_id UUID REFERENCES ideation_items(id) ON DELETE SET NULL,
    test_run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
    sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL,
    bug_id UUID REFERENCES bugs(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'feature' CHECK (kind IN ('feature', 'bug')),
    status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'planned', 'in_progress', 'blocked', 'done')),
    return_status TEXT,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    effort_hours DOUBLE PRECISION CHECK (effort_hours >= 0),
    token_estimate BIGINT CHECK (token_estimate >= 0),
    benefit SMALLINT CHECK (benefit BETWEEN 0 AND 10),
    cost SMALLINT CHECK (cost BETWEEN 0 AND 10),
    risks TEXT NOT NULL DEFAULT '',
    project_context TEXT NOT NULL DEFAULT '',
    failure TEXT,
    failure_bug_id UUID REFERENCES bugs(id) ON DELETE SET NULL,
    auto_run BOOLEAN NOT NULL DEFAULT FALSE,
    retry_count INTEGER NOT NULL DEFAULT 0,
    analysis_status TEXT CHECK (analysis_status IN ('requested', 'running', 'done', 'failed')),
    analysis TEXT NOT NULL DEFAULT '',
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS development_items_sprint_idx ON development_items (sprint_id);
  CREATE INDEX IF NOT EXISTS development_items_project_status_idx
    ON development_items (project_slug, status, priority, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS development_items_bug_idx ON development_items (bug_id) WHERE bug_id IS NOT NULL;

  CREATE OR REPLACE FUNCTION development_items_track_status() RETURNS trigger AS $fn$
  BEGIN
    IF NEW.status = 'done' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'done') THEN
      NEW.completed_at := NOW();
    ELSIF NEW.status <> 'done' THEN
      NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS development_items_status_trigger ON development_items;
  CREATE TRIGGER development_items_status_trigger BEFORE INSERT OR UPDATE ON development_items
    FOR EACH ROW EXECUTE FUNCTION development_items_track_status();

  -- A finished bug order marks its bug as fixed; a started one marks it in progress.
  CREATE OR REPLACE FUNCTION development_items_sync_bug() RETURNS trigger AS $fn$
  BEGIN
    IF NEW.bug_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'done' THEN
        UPDATE bugs SET status = 'fixed', fixed_at = NOW(), updated_at = NOW()
         WHERE id = NEW.bug_id AND status IN ('open', 'in_progress');
      ELSIF NEW.status = 'in_progress' THEN
        UPDATE bugs SET status = 'in_progress', updated_at = NOW() WHERE id = NEW.bug_id AND status = 'open';
      ELSIF NEW.status = 'rejected' THEN
        UPDATE bugs SET status = 'rejected', updated_at = NOW() WHERE id = NEW.bug_id AND status IN ('open', 'in_progress');
      ELSIF NEW.status IN ('planned', 'backlog', 'blocked') THEN
        UPDATE bugs SET status = 'open', updated_at = NOW() WHERE id = NEW.bug_id AND status = 'in_progress';
      END IF;
    END IF;
    RETURN NULL;
  END;
  $fn$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS development_items_bug_trigger ON development_items;
  CREATE TRIGGER development_items_bug_trigger AFTER UPDATE ON development_items
    FOR EACH ROW EXECUTE FUNCTION development_items_sync_bug();

  CREATE TABLE IF NOT EXISTS agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    development_id UUID NOT NULL REFERENCES development_items(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_running_idx ON agent_runs (development_id) WHERE status = 'running';
  CREATE INDEX IF NOT EXISTS agent_runs_item_idx ON agent_runs (development_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS agent_run_steps (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    agent_name TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'skipped')),
    exit_code INTEGER,
    duration_ms INTEGER,
    output TEXT NOT NULL DEFAULT '',
    pid INTEGER,
    pid_started_at TIMESTAMPTZ,
    progress TEXT,
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    tokens BIGINT NOT NULL DEFAULT 0,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (run_id, position)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  );
  -- Verlauf der Assistenten-Aktionen (wie bei Agent-Schritten), damit der Chat dieselbe Ansicht nutzt.
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS events JSONB NOT NULL DEFAULT '[]'::jsonb;
  -- Rückfrage des Assistenten und die Claude-Sitzung, mit der er nach der Antwort weiterarbeitet.
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS question TEXT;
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS session_id TEXT;
  CREATE INDEX IF NOT EXISTS chat_messages_project_idx ON chat_messages (project_slug, created_at);

  CREATE TABLE IF NOT EXISTS docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'order', 'sprint', 'repo')),
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
    content TEXT NOT NULL DEFAULT '',
    development_id UUID REFERENCES development_items(id) ON DELETE SET NULL,
    sprint_id UUID REFERENCES sprints(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS docs_unique_title_idx ON docs (project_slug, kind, title)
    WHERE kind IN ('manual', 'sprint', 'repo');
  CREATE UNIQUE INDEX IF NOT EXISTS docs_order_idx ON docs (development_id) WHERE kind = 'order';

  -- Kategorie (Frontend, Backend, Fullstack, Infrastruktur, Dokumentation) für Ideen, Aufträge und Bugs.
  ALTER TABLE ideation_items ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('frontend', 'backend', 'fullstack', 'infrastructure', 'docs'));
  ALTER TABLE development_items ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('frontend', 'backend', 'fullstack', 'infrastructure', 'docs'));
  ALTER TABLE bugs ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('frontend', 'backend', 'fullstack', 'infrastructure', 'docs'));

  -- Aufträge erben die Kategorie ihrer Idee bzw. ihres Bugs, egal auf welchem Weg sie entstehen.
  CREATE OR REPLACE FUNCTION development_items_inherit_category() RETURNS trigger AS $$
  BEGIN
    IF NEW.category IS NULL THEN
      NEW.category := COALESCE(
        (SELECT category FROM ideation_items WHERE id = NEW.ideation_id),
        (SELECT category FROM bugs WHERE id = NEW.bug_id)
      );
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS development_items_inherit_category ON development_items;
  CREATE TRIGGER development_items_inherit_category BEFORE INSERT ON development_items
    FOR EACH ROW EXECUTE FUNCTION development_items_inherit_category();

  -- Testabdeckung, die der Tester nach einem Auftrag meldet (pro Bereich wie Frontend/Backend).
  CREATE TABLE IF NOT EXISTS test_coverage_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    development_id UUID REFERENCES development_items(id) ON DELETE SET NULL,
    summary TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS test_coverage_reports_project_idx ON test_coverage_reports (project_slug, created_at DESC);
  CREATE TABLE IF NOT EXISTS test_coverage_areas (
    report_id UUID NOT NULL REFERENCES test_coverage_reports(id) ON DELETE CASCADE,
    area TEXT NOT NULL,
    unit_tests INTEGER NOT NULL DEFAULT 0,
    component_tests INTEGER NOT NULL DEFAULT 0,
    integration_tests INTEGER NOT NULL DEFAULT 0,
    e2e_tests INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    lines REAL,
    statements REAL,
    branches REAL,
    functions REAL,
    PRIMARY KEY (report_id, area)
  );

  -- Rechte-Gruppen der Agents pro Projekt (NULL = Standard) und Jobs des Einrichtungsassistenten.
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS agent_permissions TEXT[];
  CREATE TABLE IF NOT EXISTS setup_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL,
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    result JSONB,
    log TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS setup_jobs_pending_idx ON setup_jobs (status, created_at);

  -- Reviewer nachträglich in bestehende Workflows aufnehmen (einmalig je Projekt).
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS reviewer_seeded BOOLEAN NOT NULL DEFAULT FALSE;

  -- Definition of Ready/Done pro Projekt (NULL = Standard) und Abnahme je Auftrag (Akzeptanzkriterien und DoD).
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS definition_of_ready TEXT[];
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS definition_of_done TEXT[];
  CREATE TABLE IF NOT EXISTS acceptance_checks (
    development_id UUID NOT NULL REFERENCES development_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('criterion', 'done')),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'met', 'unmet')),
    note TEXT NOT NULL DEFAULT '',
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (development_id, kind, position)
  );

  ALTER TABLE agent_run_steps ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0;
  -- Verbrauch der Agents außerhalb des Auftrags-Workflows (Dashboard-Assistent, Auftragsautor, Bug-Wächter, Analyse, Schätzung).
  CREATE TABLE IF NOT EXISTS agent_usage (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    role TEXT NOT NULL,
    tokens BIGINT NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
    success BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS agent_usage_project_idx ON agent_usage (project_slug, created_at);
  -- Live-Fortschritt, während der Auftragsautor (bzw. Bug-Wächter) aus einer Idee einen Auftrag schreibt.
  ALTER TABLE ideation_items ADD COLUMN IF NOT EXISTS progress TEXT;
  ALTER TABLE ideation_items ADD COLUMN IF NOT EXISTS progress_agent TEXT;
  ALTER TABLE ideation_items ADD COLUMN IF NOT EXISTS drafting_started_at TIMESTAMPTZ;
  ALTER TABLE acceptance_checks DROP CONSTRAINT IF EXISTS acceptance_checks_status_check;
  ALTER TABLE acceptance_checks ADD CONSTRAINT acceptance_checks_status_check
    CHECK (status IN ('open', 'met', 'unmet', 'manual', 'verifying', 'checking'));
  -- Aus einem Sprint herausgenommene Aufträge landen unter „Besondere Aufmerksamkeit“.
  ALTER TABLE development_items ADD COLUMN IF NOT EXISTS removed_from_sprint TEXT;
  ALTER TABLE development_items ADD COLUMN IF NOT EXISTS removed_from_sprint_at TIMESTAMPTZ;
  -- Favicon der betreuten Anwendung (vom Worker aus dem Projektordner übernommen).
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS favicon BYTEA;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS favicon_type TEXT;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS favicon_mtime TIMESTAMPTZ;
  -- Benutzer und Rollen (zusätzlich zum Systemadministrator aus der .env).
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    roles TEXT[] NOT NULL DEFAULT '{}',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    totp_secret TEXT,
    totp_pending TEXT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));
  ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

  -- Änderungen an Dokumenten: werden eingereicht und erst nach Prüfung durch die Redaktion übernommen.
  CREATE TABLE IF NOT EXISTS doc_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    base_title TEXT NOT NULL DEFAULT '',
    base_content TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    reviewer_name TEXT,
    review_note TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS doc_revisions_doc_idx ON doc_revisions (doc_id, created_at DESC);
  -- Reihenfolge der Aufträge im Sprint (Kanban); die Agents arbeiten sie in dieser Reihenfolge ab.
  ALTER TABLE development_items ADD COLUMN IF NOT EXISTS sprint_rank INTEGER;
  -- Git-Verlauf (Commits und Branches) fürs Dashboard; der Worker liest ihn aus dem Projektordner.
  CREATE TABLE IF NOT EXISTS project_git_graphs (
    project_slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    graph JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Agent-Aufgaben: gespeicherte Anweisungen, die mit einem Klick an den Assistenten gehen.
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_by TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS agent_tasks_project_idx ON agent_tasks (project_slug);
  -- Wer eine Chat-Anfrage oder Agent-Aufgabe übernimmt (leer = allgemeiner Assistent).
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS agent_name TEXT;
  ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
  -- Aktion notwendig: kurz, was ein Mensch tun muss (null = nichts zu tun).
  ALTER TABLE development_items ADD COLUMN IF NOT EXISTS action_todo TEXT;
  -- Folgeauftrag: bezieht sich auf einen abgeschlossenen Auftrag, dessen Kontext der Entwickler mitbekommt.
  ALTER TABLE development_items ADD COLUMN IF NOT EXISTS follow_up_of UUID REFERENCES development_items(id) ON DELETE SET NULL;
  -- Verweise einer Chat-Nachricht (@auftrag/…, @git/…), vom Server geprüft.
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS refs JSONB NOT NULL DEFAULT '[]'::jsonb;
  -- Abgelehnt: Auftrag bzw. Bug verstösst gegen die Projektregeln (Do's and Don'ts) und wird nicht umgesetzt.
  ALTER TABLE development_items DROP CONSTRAINT IF EXISTS development_items_status_check;
  ALTER TABLE development_items ADD CONSTRAINT development_items_status_check
    CHECK (status IN ('backlog', 'planned', 'in_progress', 'blocked', 'done', 'rejected'));
  ALTER TABLE bugs DROP CONSTRAINT IF EXISTS bugs_status_check;
  ALTER TABLE bugs ADD CONSTRAINT bugs_status_check CHECK (status IN ('open', 'in_progress', 'fixed', 'wontfix', 'rejected'));
  -- Sprintplanung je Projekt: manuell (Standard), vorschlagen oder Autopilot; Kapazität ohne Sprint-Historie.
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS sprint_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (sprint_mode IN ('manual', 'suggest', 'autopilot'));
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS sprint_capacity_hours DOUBLE PRECISION NOT NULL DEFAULT 40
    CHECK (sprint_capacity_hours > 0);
  -- Angenommene Ideen, deren Auftrag gelöscht wurde, sind wieder offen.
  UPDATE ideation_items i SET status = 'idea', updated_at = NOW()
   WHERE i.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id);
  -- Erledigte oder abgelehnte Aufträge brauchen keine Aktion mehr: Hinweis beim Abschluss löschen (auch Altfälle).
  CREATE OR REPLACE FUNCTION clear_action_todo() RETURNS trigger AS $$
  BEGIN
    IF NEW.status IN ('done', 'rejected') THEN
      NEW.action_todo := NULL;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE OR REPLACE TRIGGER development_items_clear_action_todo
    BEFORE INSERT OR UPDATE OF status ON development_items
    FOR EACH ROW EXECUTE FUNCTION clear_action_todo();
  UPDATE development_items SET action_todo = NULL
   WHERE status IN ('done', 'rejected') AND action_todo IS NOT NULL;
  -- Mandantentrennung: Benutzer sehen nur freigeschaltete Projekte (Administratoren alle).
  CREATE TABLE IF NOT EXISTS project_members (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, project_slug)
  );
  -- Push nur an Geräte von Benutzern mit Zugriff auf das Projekt.
  ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS system_admin BOOLEAN NOT NULL DEFAULT FALSE;
  -- Ältere Geräte ohne Besitzer stammen aus der Zeit vor Benutzerkonten: dem Systemadministrator zuordnen.
  UPDATE push_subscriptions SET system_admin = TRUE WHERE user_id IS NULL AND NOT system_admin;
  -- Einmalig beim Einführen der Mandantentrennung: bestehende Benutzer behalten Zugriff auf die bestehenden Projekte.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'tenancy_migrated') THEN
      INSERT INTO project_members (user_id, project_slug)
        SELECT u.id, p.slug FROM users u CROSS JOIN projects p ON CONFLICT DO NOTHING;
      INSERT INTO app_settings (key, value) VALUES ('tenancy_migrated', 'true');
    END IF;
  END $$;
  -- Rechte je Agent auf Befehlsebene (null = Projektstandard wie bisher) und eigene Kategorien je Projekt (Administration).
  ALTER TABLE agents DROP COLUMN IF EXISTS permission_groups;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_commands TEXT[];
  CREATE TABLE IF NOT EXISTS project_permission_groups (
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    id TEXT NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
    description TEXT NOT NULL DEFAULT '',
    rules TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_slug, id)
  );
  -- Dokumentgruppe „Anfragen“: Anfragen an Assistent und Agents samt Ergebnis.
  ALTER TABLE docs DROP CONSTRAINT IF EXISTS docs_kind_check;
  ALTER TABLE docs ADD CONSTRAINT docs_kind_check CHECK (kind IN ('manual', 'order', 'sprint', 'repo', 'request'));

  -- Dateirechte getrennt: „files“ wird zu „Dateien anlegen“ und „Dateien ändern“; dazu erlaubte Ordner je Agent.
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS file_scope TEXT[] NOT NULL DEFAULT '{}';
  UPDATE agents SET allowed_commands = ARRAY(
      SELECT DISTINCT unnest(array_remove(allowed_commands, 'files') || ARRAY['files:create', 'files:edit']))
    WHERE 'files' = ANY(allowed_commands);
  UPDATE project_permission_groups SET rules = ARRAY(
      SELECT DISTINCT unnest(array_remove(rules, 'files') || ARRAY['files:create', 'files:edit']))
    WHERE 'files' = ANY(rules);

  -- Kommentare an Ideen: @-Erwähnungen von Agents und Personen; ein erwähnter Agent antwortet als Kommentar.
  ALTER TABLE ideation_comments ADD COLUMN IF NOT EXISTS author_kind TEXT NOT NULL DEFAULT 'user';
  ALTER TABLE ideation_comments ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE ideation_comments ADD COLUMN IF NOT EXISTS reply_to UUID REFERENCES ideation_comments(id) ON DELETE SET NULL;
  ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS idea_comment_id UUID REFERENCES ideation_comments(id) ON DELETE SET NULL;

  -- Herkunft einer Idee (bestehende Ideen: human) und Ablehnungsgrund, den der Visionär beim nächsten Lauf beachtet.
  ALTER TABLE ideation_items ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'human'
    CHECK (source IN ('human', 'visionary', 'routine', 'production', 'github'));
  ALTER TABLE ideation_items ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
  -- Läufe des Visionärs: angefragt → läuft → fertig/fehlgeschlagen/abgebrochen; je Projekt höchstens ein offener Lauf.
  CREATE TABLE IF NOT EXISTS visionary_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'requested'
      CHECK (status IN ('requested', 'running', 'done', 'failed', 'cancelled')),
    progress TEXT,
    created_count INTEGER NOT NULL DEFAULT 0,
    discarded_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    requested_by TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS visionary_runs_open_idx ON visionary_runs (project_slug)
    WHERE status IN ('requested', 'running');
  CREATE INDEX IF NOT EXISTS visionary_runs_project_idx ON visionary_runs (project_slug, requested_at DESC);
  -- launchctl-Freigabe ohne feste Benutzer-ID (der Container hat eine andere als der Worker).
  UPDATE agents SET allowed_commands = ARRAY(SELECT DISTINCT CASE
      WHEN rule ~ '^Bash\\(launchctl kickstart -k gui/[0-9]+/ch\\.\\*\\)$' THEN 'services' ELSE rule END
      FROM unnest(allowed_commands) rule)
    WHERE EXISTS (SELECT 1 FROM unnest(allowed_commands) rule WHERE rule LIKE 'Bash(launchctl kickstart -k gui/%');

  -- Sprint-Autopilot: Arbeitszeiten (nur darin startet er Sprints; 1 = Montag … 7 = Sonntag) und manuelle Freigabe
  -- nach gescheiterter Git-Sicherung (Sprint, dessen Fehler bewusst übergangen wird).
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS autopilot_start TEXT NOT NULL DEFAULT '08:00'
    CHECK (autopilot_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS autopilot_end TEXT NOT NULL DEFAULT '18:00'
    CHECK (autopilot_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS autopilot_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}';
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS autopilot_released_sprint UUID REFERENCES sprints(id) ON DELETE SET NULL;
  -- KI-Kommentar zum Sprintvorschlag (Auftragsautor, nur Text): je Projekt der letzte, beim Übernehmen gelöscht.
  CREATE TABLE IF NOT EXISTS sprint_proposal_comments (
    project_slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    item_ids UUID[] NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'done', 'failed')),
    comment TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
  );
`;
