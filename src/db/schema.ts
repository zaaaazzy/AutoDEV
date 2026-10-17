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
`;
