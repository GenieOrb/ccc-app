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
    initial_size INT NOT NULL DEFAULT 30,
    replenishment_threshold INT NOT NULL DEFAULT 5,
    replenishment_size INT NOT NULL DEFAULT 10,
    prompt_version INT NOT NULL DEFAULT 1,
    brand_variants JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_brand_variants_is_array CHECK (jsonb_typeof(brand_variants) = 'array')
);

-- Migración de campañas existentes
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS brand_variants JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_brand_variants_is_array' AND conrelid = 'campaigns'::regclass) THEN
        ALTER TABLE campaigns ADD CONSTRAINT chk_brand_variants_is_array CHECK (jsonb_typeof(brand_variants) = 'array');
    END IF;
END $$;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS post_active_lifetime_hours INTEGER;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_comments_total INT;
ALTER TABLE campaigns ALTER COLUMN max_comments_total DROP DEFAULT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_campaign_max_comments_total'
          AND conrelid = 'campaigns'::regclass
    ) THEN
        ALTER TABLE campaigns
        ADD CONSTRAINT chk_campaign_max_comments_total
        CHECK (
            max_comments_total IS NULL
            OR max_comments_total BETWEEN 1 AND 1000000
        );
    END IF;
END $$;

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
    initial_sync_pending BOOLEAN NOT NULL DEFAULT true,
    last_seen_post_id TEXT,
    last_polled_at TIMESTAMPTZ,
    poll_lease_owner UUID,
    poll_lease_expires_at TIMESTAMPTZ,
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

-- Durable monitor audit trail. Details carry only bounded operational metadata.
CREATE TABLE IF NOT EXISTS perpetual_sync_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    campaign_account_id UUID NOT NULL REFERENCES campaign_accounts(id) ON DELETE RESTRICT,
    run_id UUID NOT NULL,
    phase TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS perpetual_sync_checkpoints_account_recent_idx
ON perpetual_sync_checkpoints(campaign_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS perpetual_sync_checkpoints_campaign_recent_idx
ON perpetual_sync_checkpoints(campaign_id, created_at DESC);

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
ALTER TABLE campaign_accounts ADD COLUMN IF NOT EXISTS poll_lease_owner UUID;
ALTER TABLE campaign_accounts ADD COLUMN IF NOT EXISTS poll_lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS campaign_accounts_poll_lease_idx
ON campaign_accounts(poll_lease_expires_at)
WHERE poll_lease_expires_at IS NOT NULL;

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

-- Multi-provider campaign configuration and immutable generation snapshots.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS model_key TEXT;
ALTER TABLE campaigns ALTER COLUMN initial_size SET DEFAULT 30;
ALTER TABLE campaigns ALTER COLUMN replenishment_threshold SET DEFAULT 5;
ALTER TABLE campaigns ALTER COLUMN replenishment_size SET DEFAULT 10;
UPDATE campaigns SET initial_size = 30 WHERE initial_size = 50;
UPDATE campaigns SET replenishment_threshold = 5 WHERE replenishment_threshold = 20;
UPDATE campaigns SET replenishment_size = 10 WHERE replenishment_size = 50;
UPDATE campaigns SET model_key = 'gpt-5.4' WHERE model_key IS NULL;
ALTER TABLE campaigns ALTER COLUMN model_key SET DEFAULT 'deepseek-v4-flash';
ALTER TABLE campaigns ALTER COLUMN model_key SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_campaign_display_name_length' AND conrelid = 'campaigns'::regclass) THEN
    ALTER TABLE campaigns ADD CONSTRAINT chk_campaign_display_name_length CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 120);
  END IF;
END $$;

ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS model_key TEXT;
ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS api_model TEXT;
ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS input_price_per_million NUMERIC(12,6);
ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS cached_input_price_per_million NUMERIC(12,6);
ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS output_price_per_million NUMERIC(12,6);
ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS pricing_currency TEXT;
ALTER TABLE generation_cycles ADD COLUMN IF NOT EXISTS pricing_effective_at DATE;
UPDATE generation_cycles SET model_key = COALESCE(model_key, 'gpt-5.4'), provider = COALESCE(provider, 'openai'), api_model = COALESCE(api_model, 'gpt-5.4'), input_price_per_million = COALESCE(input_price_per_million, 2.5), cached_input_price_per_million = COALESCE(cached_input_price_per_million, .25), output_price_per_million = COALESCE(output_price_per_million, 15), pricing_currency = COALESCE(pricing_currency, 'USD'), pricing_effective_at = COALESCE(pricing_effective_at, DATE '2026-07-26');

ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS model_key TEXT;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS api_model TEXT;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS input_price_per_million NUMERIC(12,6);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS cached_input_price_per_million NUMERIC(12,6);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS output_price_per_million NUMERIC(12,6);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS pricing_currency TEXT;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS pricing_effective_at DATE;
UPDATE generation_jobs j SET model_key = COALESCE(j.model_key, c.model_key), provider = COALESCE(j.provider, c.provider), api_model = COALESCE(j.api_model, c.api_model), input_price_per_million = COALESCE(j.input_price_per_million, c.input_price_per_million), cached_input_price_per_million = COALESCE(j.cached_input_price_per_million, c.cached_input_price_per_million), output_price_per_million = COALESCE(j.output_price_per_million, c.output_price_per_million), pricing_currency = COALESCE(j.pricing_currency, c.pricing_currency), pricing_effective_at = COALESCE(j.pricing_effective_at, c.pricing_effective_at) FROM generation_cycles c WHERE c.id = j.cycle_id;

ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS requested_provider TEXT;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS requested_model_key TEXT;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS final_provider TEXT;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS final_model_key TEXT;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(16,8);
UPDATE suggestions SET requested_provider = COALESCE(requested_provider, 'openai'), requested_model_key = COALESCE(requested_model_key, 'gpt-5.4'), final_provider = COALESCE(final_provider, 'openai'), final_model_key = COALESCE(final_model_key, 'gpt-5.4');

CREATE TABLE IF NOT EXISTS generation_usage_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  campaign_post_id UUID REFERENCES campaign_posts(id) ON DELETE RESTRICT, cycle_id UUID REFERENCES generation_cycles(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES generation_jobs(id) ON DELETE RESTRICT, requested_provider TEXT NOT NULL, requested_model_key TEXT NOT NULL,
  final_provider TEXT, final_model_key TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
  comments_requested INTEGER NOT NULL, comments_received INTEGER NOT NULL, comments_valid INTEGER NOT NULL, comments_rejected INTEGER NOT NULL,
  regenerations INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, fallback_used BOOLEAN NOT NULL DEFAULT false,
  reason TEXT, input_price_per_million NUMERIC(12,6), cached_input_price_per_million NUMERIC(12,6), output_price_per_million NUMERIC(12,6),
  currency TEXT, estimated_cost NUMERIC(16,8), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE campaign_accounts ADD COLUMN IF NOT EXISTS initial_sync_pending BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS generation_usage_metrics_model_idx ON generation_usage_metrics (requested_model_key, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_usage_metrics_campaign_idx ON generation_usage_metrics (campaign_id, created_at DESC);

-- One durable record for each real AI HTTP request.  This is deliberately
-- separate from aggregated generation_usage_metrics so retries/fallbacks are
-- never collapsed into a single comment-level metric.
CREATE TABLE IF NOT EXISTS generation_api_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_key TEXT NOT NULL UNIQUE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT,
  campaign_post_id UUID REFERENCES campaign_posts(id) ON DELETE RESTRICT,
  campaign_account_id UUID REFERENCES campaign_accounts(id) ON DELETE RESTRICT,
  cycle_id UUID REFERENCES generation_cycles(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES generation_jobs(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('generation','rewrite','fallback','preview','preflight')),
  provider TEXT NOT NULL,
  model_key TEXT NOT NULL,
  api_model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','cancelled','usage_unknown')),
  input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
  input_price_per_million NUMERIC(12,6), cached_input_price_per_million NUMERIC(12,6), output_price_per_million NUMERIC(12,6),
  currency TEXT NOT NULL DEFAULT 'USD', estimated_cost NUMERIC(16,8),
  attribution_key UUID,
  failure_kind TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
);
-- Legacy compatibility: generation_api_calls cost columns
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS response_text TEXT;
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS input_tokens INTEGER;
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER;
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS output_tokens INTEGER;
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS input_price_per_million NUMERIC(12,6);
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS cached_input_price_per_million NUMERIC(12,6);
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS output_price_per_million NUMERIC(12,6);
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(16,8);
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS failure_kind TEXT;
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS generation_api_calls_campaign_idx ON generation_api_calls (campaign_id, created_at DESC);
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS attribution_key UUID;
CREATE INDEX IF NOT EXISTS generation_api_calls_attribution_idx ON generation_api_calls (attribution_key) WHERE campaign_id IS NULL;
ALTER TABLE generation_api_calls ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE generation_api_calls ADD COLUMN IF NOT EXISTS campaign_account_id UUID REFERENCES campaign_accounts(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS generation_api_calls_campaign_account_idx ON generation_api_calls (campaign_account_id, created_at DESC);

-- X is an independently billed/limited provider.  Its calls must never be
-- represented as AI USD usage: operation and attribution are recorded alone.
CREATE TABLE IF NOT EXISTS x_api_billable_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('post', 'user')),
  resource_id TEXT NOT NULL,
  billing_utc_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_x_billable_resource UNIQUE (resource_type, resource_id, billing_utc_date)
);

CREATE TABLE IF NOT EXISTS x_api_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_key TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('tweet_lookup','user_lookup','timeline_lookup')),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT,
  campaign_account_id UUID REFERENCES campaign_accounts(id) ON DELETE RESTRICT,
  post_resources_count INT NOT NULL DEFAULT 0,
  user_resources_count INT NOT NULL DEFAULT 0,
  post_unit_price NUMERIC(12,6),
  user_unit_price NUMERIC(12,6),
  currency TEXT,
  estimated_cost NUMERIC(16,8),
  pricing_effective_at DATE,
  cost_complete BOOLEAN NOT NULL DEFAULT true,
  attribution_key UUID,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  http_status INTEGER, failure_kind TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
);
-- Legacy compatibility: x_api_calls cost columns
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS campaign_account_id UUID REFERENCES campaign_accounts(id) ON DELETE RESTRICT;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(16,8);
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS http_status INTEGER;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS failure_kind TEXT;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS x_api_calls_campaign_idx ON x_api_calls (campaign_id, created_at DESC);
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS attribution_key UUID;
CREATE INDEX IF NOT EXISTS x_api_calls_attribution_idx ON x_api_calls (attribution_key) WHERE campaign_id IS NULL;

-- Remove old columns if any exist (idempotent setup handles drops cleanly for new fields in test envs, but in production we'd use ADD COLUMN. We'll add them here just in case).
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS post_resources_count INT NOT NULL DEFAULT 0;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS user_resources_count INT NOT NULL DEFAULT 0;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS post_unit_price NUMERIC(12,6);
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS user_unit_price NUMERIC(12,6);
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS pricing_effective_at DATE;
ALTER TABLE x_api_calls ADD COLUMN IF NOT EXISTS cost_complete BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS campaign_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  campaign_post_id UUID NOT NULL REFERENCES campaign_posts(id) ON DELETE RESTRICT, model_key TEXT NOT NULL, provider TEXT NOT NULL, api_model TEXT NOT NULL,
  comments JSONB, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, estimated_cost NUMERIC(16,8), error_message TEXT,
  input_price_per_million NUMERIC(12,6), cached_input_price_per_million NUMERIC(12,6), output_price_per_million NUMERIC(12,6), currency TEXT, pricing_effective_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Legacy compatibility: campaign_previews cost columns
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS input_tokens INTEGER;
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER;
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS output_tokens INTEGER;
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(16,8);
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS input_price_per_million NUMERIC(12,6);
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS cached_input_price_per_million NUMERIC(12,6);
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS output_price_per_million NUMERIC(12,6);
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE campaign_previews ADD COLUMN IF NOT EXISTS pricing_effective_at DATE;
CREATE INDEX IF NOT EXISTS campaign_previews_campaign_idx ON campaign_previews (campaign_id, created_at DESC);

-- Snapshot is populated at enqueue time from the campaign, so legacy enqueue paths
-- cannot silently fall back to OPENAI_MODEL. Application code may supply the same
-- values explicitly; this trigger is an integrity guard for the existing queue.
CREATE OR REPLACE FUNCTION fill_generation_cycle_model_snapshot()
RETURNS TRIGGER AS $$
DECLARE selected_key TEXT;
BEGIN
  SELECT model_key INTO selected_key FROM campaigns WHERE id = NEW.campaign_id;
  selected_key := COALESCE(NEW.model_key, selected_key, 'gpt-5.4');
  NEW.model_key := selected_key;
  CASE selected_key
    WHEN 'deepseek-v4-flash' THEN NEW.provider := COALESCE(NEW.provider, 'deepseek'); NEW.api_model := COALESCE(NEW.api_model, 'deepseek-v4-flash'); NEW.input_price_per_million := COALESCE(NEW.input_price_per_million, .14); NEW.cached_input_price_per_million := COALESCE(NEW.cached_input_price_per_million, .0028); NEW.output_price_per_million := COALESCE(NEW.output_price_per_million, .28);
    WHEN 'deepseek-v4-pro' THEN NEW.provider := COALESCE(NEW.provider, 'deepseek'); NEW.api_model := COALESCE(NEW.api_model, 'deepseek-v4-pro'); NEW.input_price_per_million := COALESCE(NEW.input_price_per_million, .435); NEW.cached_input_price_per_million := COALESCE(NEW.cached_input_price_per_million, .003625); NEW.output_price_per_million := COALESCE(NEW.output_price_per_million, .87);
    WHEN 'gpt-5.4-mini' THEN NEW.provider := COALESCE(NEW.provider, 'openai'); NEW.api_model := COALESCE(NEW.api_model, 'gpt-5.4-mini'); NEW.input_price_per_million := COALESCE(NEW.input_price_per_million, .75); NEW.cached_input_price_per_million := COALESCE(NEW.cached_input_price_per_million, .075); NEW.output_price_per_million := COALESCE(NEW.output_price_per_million, 4.5);
    WHEN 'qwen3.7-plus' THEN NEW.provider := COALESCE(NEW.provider, 'qwen'); NEW.api_model := COALESCE(NEW.api_model, 'qwen3.7-plus'); NEW.input_price_per_million := COALESCE(NEW.input_price_per_million, .276); NEW.output_price_per_million := COALESCE(NEW.output_price_per_million, 1.101);
    ELSE NEW.model_key := 'gpt-5.4'; NEW.provider := COALESCE(NEW.provider, 'openai'); NEW.api_model := COALESCE(NEW.api_model, 'gpt-5.4'); NEW.input_price_per_million := COALESCE(NEW.input_price_per_million, 2.5); NEW.cached_input_price_per_million := COALESCE(NEW.cached_input_price_per_million, .25); NEW.output_price_per_million := COALESCE(NEW.output_price_per_million, 15);
  END CASE;
  NEW.model_name := NEW.api_model;
  NEW.pricing_currency := COALESCE(NEW.pricing_currency, 'USD'); NEW.pricing_effective_at := COALESCE(NEW.pricing_effective_at, DATE '2026-07-26');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fill_generation_job_model_snapshot()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.cycle_id IS NULL THEN
    RAISE EXCEPTION 'generation_jobs.cycle_id is required for model snapshot';
  END IF;

  SELECT model_key, provider, api_model, input_price_per_million,
         cached_input_price_per_million, output_price_per_million,
         pricing_currency, pricing_effective_at
    INTO NEW.model_key, NEW.provider, NEW.api_model,
         NEW.input_price_per_million, NEW.cached_input_price_per_million,
         NEW.output_price_per_million, NEW.pricing_currency,
         NEW.pricing_effective_at
    FROM generation_cycles WHERE id = NEW.cycle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation cycle % does not exist for job snapshot', NEW.cycle_id;
  END IF;
  NEW.model_name := COALESCE(NEW.api_model, NEW.model_name, 'gpt-5.4');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trigger_generation_cycle_snapshot ON generation_cycles;
DROP TRIGGER IF EXISTS trigger_generation_job_snapshot ON generation_jobs;
-- Remove the former polymorphic trigger function after detaching both
-- triggers, so a repeated setup leaves no obsolete runtime path behind.
DROP FUNCTION IF EXISTS fill_generation_model_snapshot();
CREATE TRIGGER trigger_generation_cycle_snapshot BEFORE INSERT ON generation_cycles FOR EACH ROW EXECUTE FUNCTION fill_generation_cycle_model_snapshot();
CREATE TRIGGER trigger_generation_job_snapshot BEFORE INSERT ON generation_jobs FOR EACH ROW EXECUTE FUNCTION fill_generation_job_model_snapshot();

-- ==========================================
-- MEME SYSTEM SCHEMA (PHASE 1)
-- ==========================================

-- 1. Extend campaigns with meme config
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS include_memes BOOLEAN;
UPDATE campaigns SET include_memes = false WHERE include_memes IS NULL;
ALTER TABLE campaigns ALTER COLUMN include_memes SET NOT NULL;
ALTER TABLE campaigns ALTER COLUMN include_memes SET DEFAULT true;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meme_percentage INT NOT NULL DEFAULT 25 CHECK (meme_percentage BETWEEN 0 AND 100);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meme_model_key TEXT NOT NULL DEFAULT 'gpt-image-2';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meme_planner_version INT NOT NULL DEFAULT 1;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meme_initial_size INT NOT NULL DEFAULT 10 CHECK (meme_initial_size > 0);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meme_replenishment_threshold INT NOT NULL DEFAULT 5 CHECK (meme_replenishment_threshold >= 0);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meme_replenishment_size INT NOT NULL DEFAULT 10 CHECK (meme_replenishment_size > 0);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meme_sequence_state JSONB NOT NULL DEFAULT '{"deficit": 0}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_meme_replenishment_limits' AND conrelid = 'campaigns'::regclass) THEN
        ALTER TABLE campaigns ADD CONSTRAINT chk_meme_replenishment_limits CHECK (meme_replenishment_threshold <= meme_initial_size);
    END IF;
END $$;

-- 2. Meme Drafts
CREATE TABLE IF NOT EXISTS meme_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config JSONB NOT NULL,
    inputs_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'converted')),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS meme_drafts_expired_idx ON meme_drafts(expires_at) WHERE status = 'active';

-- 3. Meme Assets (References)
CREATE TABLE IF NOT EXISTS meme_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT,
    draft_id UUID REFERENCES meme_drafts(id) ON DELETE RESTRICT,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('logo', 'mascot', 'product', 'fictional_character', 'object', 'other')),
    appearance_percentage INT NOT NULL CHECK (appearance_percentage BETWEEN 1 AND 100),
    instruction TEXT,
    storage_provider TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    storage_url TEXT,
    mime_type TEXT NOT NULL,
    size_bytes INT NOT NULL,
    width INT,
    height INT,
    sha256_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at TIMESTAMPTZ,
    CONSTRAINT chk_campaign_or_draft CHECK ((campaign_id IS NOT NULL AND draft_id IS NULL) OR (campaign_id IS NULL AND draft_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS meme_assets_active_idx ON meme_assets(campaign_id, status) WHERE status = 'active';

-- 4. Meme Generation Cycles
CREATE TABLE IF NOT EXISTS meme_generation_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT,
    draft_id UUID REFERENCES meme_drafts(id) ON DELETE RESTRICT,
    campaign_post_id UUID REFERENCES campaign_posts(id) ON DELETE RESTRICT,
    cycle_type TEXT NOT NULL CHECK (cycle_type IN ('preview', 'initial', 'replenishment', 'retry')),
    target_count INT NOT NULL DEFAULT 10,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled', 'partial')),
    model_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_model TEXT NOT NULL,
    planner_version INT NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    valid_produced_count INT NOT NULL DEFAULT 0,
    completed_jobs_count INT NOT NULL DEFAULT 0,
    failed_jobs_count INT NOT NULL DEFAULT 0,
    error_message TEXT,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT chk_meme_cycle_campaign_or_draft CHECK ((campaign_id IS NOT NULL AND draft_id IS NULL) OR (campaign_id IS NULL AND draft_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS meme_generation_cycles_active_idx ON meme_generation_cycles(campaign_id, status) WHERE status IN ('pending', 'processing');

-- 5. Meme Generation Jobs
CREATE TABLE IF NOT EXISTS meme_generation_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL REFERENCES meme_generation_cycles(id) ON DELETE RESTRICT,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT,
    draft_id UUID REFERENCES meme_drafts(id) ON DELETE RESTRICT,
    campaign_post_id UUID REFERENCES campaign_posts(id) ON DELETE RESTRICT,
    slot_index INT NOT NULL,
    slot_plan JSONB NOT NULL,
    deterministic_dimensions JSONB NOT NULL,
    asset_snapshot JSONB,
    model_snapshot JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    attempts_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    error_message TEXT,
    accumulated_cost NUMERIC(16,8) NOT NULL DEFAULT 0,
    call_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_meme_job_campaign_or_draft CHECK ((campaign_id IS NOT NULL AND draft_id IS NULL) OR (campaign_id IS NULL AND draft_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS meme_generation_jobs_claimable_idx ON meme_generation_jobs(status, next_attempt_at, lease_expires_at) WHERE status IN ('pending', 'processing');

-- 6. Memes Table (Inventory)
CREATE TABLE IF NOT EXISTS memes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
    campaign_post_id UUID NOT NULL REFERENCES campaign_posts(id) ON DELETE RESTRICT,
    job_id UUID NOT NULL UNIQUE REFERENCES meme_generation_jobs(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('preview', 'available', 'assigned', 'withdrawn', 'rejected', 'failed')),
    storage_provider TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INT NOT NULL,
    width INT NOT NULL,
    height INT NOT NULL,
    sha256_hash TEXT NOT NULL,
    expected_text TEXT,
    slot_plan JSONB NOT NULL,
    model_key TEXT NOT NULL,
    asset_id UUID REFERENCES meme_assets(id) ON DELETE RESTRICT,
    accumulated_cost NUMERIC(16,8) NOT NULL DEFAULT 0,
    preview_origin_draft_id UUID REFERENCES meme_drafts(id) ON DELETE RESTRICT,
    rejection_reason TEXT,
    delivery_order INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_meme_hash_per_campaign ON memes(campaign_id, sha256_hash) WHERE status IN ('available', 'assigned');
CREATE INDEX IF NOT EXISTS memes_available_idx ON memes(campaign_id, status, delivery_order) WHERE status = 'available';

-- 7. Meme API Calls (Auditing & Costs)
CREATE TABLE IF NOT EXISTS meme_api_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_key TEXT NOT NULL UNIQUE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT,
    draft_id UUID REFERENCES meme_drafts(id) ON DELETE RESTRICT,
    cycle_id UUID REFERENCES meme_generation_cycles(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES meme_generation_jobs(id) ON DELETE RESTRICT,
    meme_id UUID REFERENCES memes(id) ON DELETE RESTRICT,
    purpose TEXT NOT NULL CHECK (purpose IN ('analysis', 'concept', 'moderation', 'generation', 'validation', 'preview', 'regeneration')),
    provider TEXT NOT NULL,
    model_key TEXT NOT NULL,
    api_model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'cancelled', 'usage_unknown')),
    provider_request_id TEXT,
    attempt INT NOT NULL DEFAULT 1,
    input_text_tokens INTEGER,
    input_image_tokens INTEGER,
    cached_tokens INTEGER,
    output_text_tokens INTEGER,
    output_image_tokens INTEGER,
    reference_images_count INTEGER,
    quality TEXT,
    resolution TEXT,
    pricing_snapshot JSONB NOT NULL,
    cost_components JSONB,
    total_cost NUMERIC(16,8),
    currency TEXT NOT NULL DEFAULT 'USD',
    is_estimated BOOLEAN NOT NULL DEFAULT true,
    error_message TEXT,
    durable_result_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS meme_api_calls_campaign_idx ON meme_api_calls(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS meme_api_calls_attribution_idx ON meme_api_calls(draft_id) WHERE campaign_id IS NULL;

-- 8. Alter Assignments to support Memes
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'comment' CHECK (content_type IN ('comment', 'meme'));
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS meme_id UUID REFERENCES memes(id) ON DELETE RESTRICT;

ALTER TABLE assignments DISABLE TRIGGER trigger_prevent_assignment_mutation;
ALTER TABLE assignments ALTER COLUMN suggestion_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_assignment_exact_content' AND conrelid = 'assignments'::regclass) THEN
        ALTER TABLE assignments ADD CONSTRAINT chk_assignment_exact_content CHECK (
            (content_type = 'comment' AND suggestion_id IS NOT NULL AND meme_id IS NULL) OR
            (content_type = 'meme' AND meme_id IS NOT NULL AND suggestion_id IS NULL)
        );
    END IF;
END $$;
ALTER TABLE assignments ENABLE TRIGGER trigger_prevent_assignment_mutation;

-- Create constraint for exact-one suggestion or meme per unique visitor-campaign pair
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_assignment_meme_compound' AND conrelid = 'assignments'::regclass) THEN
        ALTER TABLE assignments ADD CONSTRAINT unique_assignment_meme_compound UNIQUE (id, campaign_id, campaign_post_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assignments_meme_compound' AND conrelid = 'assignments'::regclass) THEN
        ALTER TABLE assignments ADD CONSTRAINT fk_assignments_meme_compound
        FOREIGN KEY (meme_id) REFERENCES memes (id) ON DELETE RESTRICT;
    END IF;
END $$;

COMMIT;
