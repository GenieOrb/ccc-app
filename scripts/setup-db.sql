-- SQL Schema for Comment App (Idempotent and Transactional)

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table: campaigns
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_number SERIAL NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    campaign_type TEXT NOT NULL DEFAULT 'manual',
    direction TEXT,
    post_active_lifetime_hours INTEGER,
    is_active BOOLEAN NOT NULL DEFAULT false,
    safety_allowed BOOLEAN NOT NULL DEFAULT true,
    safety_category TEXT,
    safety_reason TEXT,
    initial_size INT NOT NULL DEFAULT 50,
    replenishment_threshold INT NOT NULL DEFAULT 20,
    replenishment_size INT NOT NULL DEFAULT 50,
    prompt_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migración de campañas existentes
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS post_active_lifetime_hours INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_campaign_type_lifetime' AND conrelid = 'campaigns'::regclass) THEN
        ALTER TABLE campaigns ADD CONSTRAINT chk_campaign_type_lifetime CHECK (
            (campaign_type = 'manual' AND post_active_lifetime_hours IS NULL) OR
            (campaign_type = 'perpetual' AND post_active_lifetime_hours BETWEEN 1 AND 720)
        );
    END IF;
END $$;

-- Table: campaign_accounts
CREATE TABLE IF NOT EXISTS campaign_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL,
    x_user_id TEXT,
    monitoring_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_post_id TEXT,
    last_polled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at TIMESTAMPTZ
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_campaign_account_compound' AND conrelid = 'campaign_accounts'::regclass) THEN
        ALTER TABLE campaign_accounts ADD CONSTRAINT unique_campaign_account_compound UNIQUE (id, campaign_id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_accounts_active_idx
ON campaign_accounts(campaign_id, username_normalized)
WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS campaign_accounts_username_idx
ON campaign_accounts(username_normalized)
WHERE removed_at IS NULL;

-- Table: campaign_posts
CREATE TABLE IF NOT EXISTS campaign_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    x_post_id TEXT NOT NULL,
    input_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    author_name TEXT,
    author_username TEXT,
    text_content TEXT NOT NULL,
    language TEXT,
    conversation_id TEXT,
    posted_at TIMESTAMPTZ,
    accessible_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    campaign_account_id UUID,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at TIMESTAMPTZ
);

-- Ensure retired_at exists before indexes on already initialized databases
ALTER TABLE campaign_posts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- Fase 2: Relación a la cuenta de origen y expiración
ALTER TABLE campaign_posts ADD COLUMN IF NOT EXISTS campaign_account_id UUID;
ALTER TABLE campaign_posts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_campaign_posts_account' AND conrelid = 'campaign_posts'::regclass) THEN
        ALTER TABLE campaign_posts ADD CONSTRAINT fk_campaign_posts_account
        FOREIGN KEY (campaign_account_id, campaign_id) REFERENCES campaign_accounts(id, campaign_id) ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS campaign_posts_expires_idx
ON campaign_posts(campaign_id, expires_at)
WHERE retired_at IS NULL AND expires_at IS NOT NULL;

-- Index for active campaign posts to prevent duplicates but allow re-adding if retired
CREATE UNIQUE INDEX IF NOT EXISTS campaign_posts_active_idx
ON campaign_posts(campaign_id, x_post_id)
WHERE retired_at IS NULL;

-- Prevent perpetual campaigns from inserting the same post twice even if retired,
-- while preserving manual campaigns behaviour (which allows re-adding retired posts).
CREATE UNIQUE INDEX IF NOT EXISTS campaign_posts_perpetual_unique_idx
ON campaign_posts(campaign_account_id, x_post_id)
WHERE campaign_account_id IS NOT NULL;

-- Table: generation_cycles
CREATE TABLE IF NOT EXISTS generation_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    campaign_post_id UUID,
    cycle_type TEXT NOT NULL CHECK (cycle_type IN ('initial', 'replenishment')),
    target_count INT NOT NULL DEFAULT 50,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    model_name TEXT NOT NULL DEFAULT 'gpt-5.4',
    prompt_version INT NOT NULL DEFAULT 1,
    valid_produced_count INT NOT NULL DEFAULT 0,
    completed_jobs_count INT NOT NULL DEFAULT 0,
    failed_jobs_count INT NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

-- Table: generation_jobs
CREATE TABLE IF NOT EXISTS generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL REFERENCES generation_cycles(id) ON DELETE RESTRICT,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    campaign_post_id UUID NOT NULL REFERENCES campaign_posts(id) ON DELETE RESTRICT,
    slot_index INT NOT NULL CHECK (slot_index >= 0 AND slot_index < 50),
    slot_plan JSONB NOT NULL,
    length_mode TEXT NOT NULL CHECK (length_mode IN ('ultra_short', 'normal')),
    emoji_policy TEXT NOT NULL CHECK (emoji_policy IN ('one_emoji', 'no_emoji')),
    rhetorical_form TEXT NOT NULL,
    texture TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    attempts_count INT NOT NULL DEFAULT 0 CHECK (attempts_count <= 3),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    error_message TEXT,
    suggestion_id UUID,
    model_name TEXT NOT NULL DEFAULT 'gpt-5.4',
    prompt_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_cycle_slot UNIQUE (cycle_id, slot_index)
);

-- Index for claiming jobs efficiently
CREATE INDEX IF NOT EXISTS idx_generation_jobs_claimable
ON generation_jobs (status, next_attempt_at, lease_expires_at)
WHERE status IN ('pending', 'processing');

-- Table: suggestions
CREATE TABLE IF NOT EXISTS suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    campaign_post_id UUID NOT NULL REFERENCES campaign_posts(id) ON DELETE RESTRICT,
    cycle_id UUID NOT NULL REFERENCES generation_cycles(id) ON DELETE RESTRICT,
    job_id UUID NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE RESTRICT,
    content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'gif', 'text_media')),
    comment_text TEXT NOT NULL,
    normalized_hash TEXT NOT NULL,
    slot_plan JSONB NOT NULL,
    model_name TEXT NOT NULL DEFAULT 'gpt-5.4',
    prompt_version INT NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('available', 'assigned', 'withdrawn')),
    delivery_order INT NOT NULL,
    media_url TEXT,
    media_alt TEXT,
    media_sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    CONSTRAINT chk_withdrawn_status CHECK ((status = 'withdrawn' AND withdrawn_at IS NOT NULL) OR (status != 'withdrawn' AND withdrawn_at IS NULL)),
    CONSTRAINT unique_campaign_normalized_hash UNIQUE (campaign_id, normalized_hash)
);

-- Index to claim available suggestions fast
CREATE INDEX IF NOT EXISTS idx_suggestions_available
ON suggestions (campaign_id, status, delivery_order)
WHERE status = 'available';

-- Table: visitors
CREATE TABLE IF NOT EXISTS visitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    visitor_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: assignments
CREATE TABLE IF NOT EXISTS assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    visitor_id UUID NOT NULL REFERENCES visitors(id) ON DELETE RESTRICT,
    campaign_post_id UUID NOT NULL REFERENCES campaign_posts(id) ON DELETE RESTRICT,
    suggestion_id UUID NOT NULL UNIQUE REFERENCES suggestions(id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: admin_login_attempts
CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_key_hash TEXT NOT NULL UNIQUE,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    failure_count INT NOT NULL DEFAULT 1,
    blocked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: public_assignment_rate_limits
CREATE TABLE IF NOT EXISTS public_assignment_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rate_key_hash TEXT NOT NULL UNIQUE,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_count INT NOT NULL DEFAULT 1,
    blocked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger Function: Immutability for assignments table
CREATE OR REPLACE FUNCTION prevent_assignment_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Assignments are immutable. UPDATE and DELETE operations are strictly forbidden on table assignments.';
END;
$$ LANGUAGE plpgsql;

-- Apply Immutability Trigger on assignments
DROP TRIGGER IF EXISTS trigger_prevent_assignment_mutation ON assignments;
CREATE TRIGGER trigger_prevent_assignment_mutation
BEFORE UPDATE OR DELETE ON assignments
FOR EACH ROW EXECUTE FUNCTION prevent_assignment_mutation();

-- --- Idempotent Schema Updates for Existing DBs ---

-- 1. Añadir columnas nuevas a instalaciones existentes
ALTER TABLE campaign_accounts ADD COLUMN IF NOT EXISTS monitoring_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE campaign_accounts ADD COLUMN IF NOT EXISTS last_seen_post_id TEXT;
ALTER TABLE campaign_accounts ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;

ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS campaign_post_id UUID;

ALTER TABLE campaign_posts DROP CONSTRAINT IF EXISTS unique_campaign_x_post_id;

ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_status_check;
ALTER TABLE suggestions ADD CONSTRAINT suggestions_status_check CHECK (status IN ('available', 'assigned', 'withdrawn'));
ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS chk_withdrawn_status;
ALTER TABLE suggestions ADD CONSTRAINT chk_withdrawn_status CHECK ((status = 'withdrawn' AND withdrawn_at IS NOT NULL) OR (status != 'withdrawn' AND withdrawn_at IS NULL));

-- 1. Ampliar assignments
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS campaign_post_id UUID REFERENCES campaign_posts(id) ON DELETE RESTRICT;

-- Desactivar temporalmente inmutabilidad para rellenar datos
ALTER TABLE assignments DISABLE TRIGGER trigger_prevent_assignment_mutation;

UPDATE assignments a
SET campaign_post_id = s.campaign_post_id
FROM suggestions s
WHERE a.suggestion_id = s.id AND a.campaign_post_id IS NULL;

ALTER TABLE assignments ENABLE TRIGGER trigger_prevent_assignment_mutation;

-- Comprobar antes de forzar NOT NULL
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM assignments WHERE campaign_post_id IS NULL) THEN
        RAISE EXCEPTION 'No se pudo vincular campaign_post_id para todas las asignaciones existentes.';
    END IF;
END $$;

-- Convertir a NOT NULL
ALTER TABLE assignments ALTER COLUMN campaign_post_id SET NOT NULL;

-- Eliminar unique_campaign_visitor original (es seguro eliminarlo porque no tiene FK apuntándole)
ALTER TABLE assignments DROP CONSTRAINT IF EXISTS unique_campaign_visitor;

-- Crear restricciones compuestas de forma idempotente sin eliminarlas
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_campaign_post_compound' AND conrelid = 'campaign_posts'::regclass) THEN
        ALTER TABLE campaign_posts ADD CONSTRAINT unique_campaign_post_compound UNIQUE (id, campaign_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_suggestion_compound' AND conrelid = 'suggestions'::regclass) THEN
        ALTER TABLE suggestions ADD CONSTRAINT unique_suggestion_compound UNIQUE (id, campaign_id, campaign_post_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_campaign_visitor_post' AND conrelid = 'assignments'::regclass) THEN
        ALTER TABLE assignments ADD CONSTRAINT unique_campaign_visitor_post UNIQUE (campaign_id, visitor_id, campaign_post_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_assignment_compound' AND conrelid = 'assignments'::regclass) THEN
        ALTER TABLE assignments ADD CONSTRAINT unique_assignment_compound UNIQUE (id, campaign_id, visitor_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assignments_campaign_post_compound' AND conrelid = 'assignments'::regclass) THEN
        ALTER TABLE assignments ADD CONSTRAINT fk_assignments_campaign_post_compound
        FOREIGN KEY (campaign_post_id, campaign_id) REFERENCES campaign_posts (id, campaign_id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assignments_suggestion_compound' AND conrelid = 'assignments'::regclass) THEN
        ALTER TABLE assignments ADD CONSTRAINT fk_assignments_suggestion_compound
        FOREIGN KEY (suggestion_id, campaign_id, campaign_post_id) REFERENCES suggestions (id, campaign_id, campaign_post_id) ON DELETE RESTRICT;
    END IF;
END $$;

-- 2. Crear estado por campaña y visitante
CREATE TABLE IF NOT EXISTS visitor_campaign_states (
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    visitor_id UUID NOT NULL REFERENCES visitors(id) ON DELETE RESTRICT,
    active_assignment_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (campaign_id, visitor_id),
    CONSTRAINT fk_active_assignment FOREIGN KEY (active_assignment_id, campaign_id, visitor_id) REFERENCES assignments (id, campaign_id, visitor_id) ON DELETE RESTRICT
);

-- 3. Crear registro inmutable del clic
CREATE TABLE IF NOT EXISTS assignment_post_clicks (
    assignment_id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL,
    visitor_id UUID NOT NULL,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_click_assignment FOREIGN KEY (assignment_id, campaign_id, visitor_id) REFERENCES assignments (id, campaign_id, visitor_id) ON DELETE RESTRICT
);

-- Trigger Function: Immutability for clicks table
CREATE OR REPLACE FUNCTION prevent_click_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Clicks are immutable. UPDATE and DELETE operations are strictly forbidden on table assignment_post_clicks.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prevent_click_mutation ON assignment_post_clicks;
CREATE TRIGGER trigger_prevent_click_mutation
BEFORE UPDATE OR DELETE ON assignment_post_clicks
FOR EACH ROW EXECUTE FUNCTION prevent_click_mutation();

-- 4. Migración de datos existentes para visitor_campaign_states
INSERT INTO visitor_campaign_states (campaign_id, visitor_id, active_assignment_id, created_at, updated_at)
SELECT campaign_id, visitor_id, id, assigned_at, assigned_at
FROM assignments
ON CONFLICT (campaign_id, visitor_id) DO NOTHING;

-- 5. Actualizaciones idempotentes para monitorización de perpetuals y estados cancelados

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT oid, conname
        FROM pg_constraint
        WHERE conrelid = 'generation_cycles'::regclass AND contype = 'c'
          AND conname LIKE '%status%'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
    ) LOOP
        EXECUTE 'ALTER TABLE generation_cycles DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
END $$;
ALTER TABLE generation_cycles ADD CONSTRAINT generation_cycles_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'));

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT oid, conname
        FROM pg_constraint
        WHERE conrelid = 'generation_jobs'::regclass AND contype = 'c'
          AND conname LIKE '%status%'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
    ) LOOP
        EXECUTE 'ALTER TABLE generation_jobs DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
END $$;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'));

-- Sustituir índice activo global por índices parciales (si existía el antiguo sin filtro post_id, eliminarlo de forma segura)
DROP INDEX IF EXISTS unique_active_cycle_per_campaign;

-- Index to enforce single active cycle per campaign globally (manual)
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_cycle_per_campaign_global
ON generation_cycles(campaign_id)
WHERE status IN ('pending', 'processing') AND campaign_post_id IS NULL;

-- Index to enforce single active cycle per post (perpetual)
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_cycle_per_post
ON generation_cycles(campaign_post_id)
WHERE status IN ('pending', 'processing') AND campaign_post_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_generation_cycles_campaign_post_compound' AND conrelid = 'generation_cycles'::regclass) THEN
        ALTER TABLE generation_cycles ADD CONSTRAINT fk_generation_cycles_campaign_post_compound
        FOREIGN KEY (campaign_post_id, campaign_id) REFERENCES campaign_posts (id, campaign_id) ON DELETE RESTRICT;
    END IF;
END $$;

COMMIT;
