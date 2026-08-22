BEGIN;

-- ============================================================
-- LC pot / lot deletion approval workflow
-- - operator: pending request requiring admin review
-- - admin: same reason/evidence form, immediate deletion
-- - every executed deletion is preserved in lc_deletion_history
-- ============================================================

CREATE TABLE IF NOT EXISTS public.lc_deletion_requests (
  id BIGSERIAL PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('pot','lot')),
  lc_lot_id BIGINT,
  lc_pot_id BIGINT,
  lot_code TEXT,
  pot_code TEXT,
  reason TEXT NOT NULL,
  evidence_path TEXT,
  evidence_bucket TEXT NOT NULL DEFAULT 'lc_issue_delete',
  evidence_mime_type TEXT,
  context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by UUID,
  requested_by_name TEXT NOT NULL,
  requested_by_role TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID,
  reviewed_by_name TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CHECK (
    (resource_type='pot' AND lc_pot_id IS NOT NULL AND lc_lot_id IS NOT NULL)
    OR
    (resource_type='lot' AND lc_lot_id IS NOT NULL)
  )
);

ALTER TABLE public.lc_deletion_requests
  ADD COLUMN IF NOT EXISTS evidence_bucket TEXT NOT NULL DEFAULT 'lc_issue_delete';

CREATE UNIQUE INDEX IF NOT EXISTS ux_lc_deletion_pending_pot
  ON public.lc_deletion_requests(lc_pot_id)
  WHERE status='pending' AND resource_type='pot';

CREATE UNIQUE INDEX IF NOT EXISTS ux_lc_deletion_pending_lot
  ON public.lc_deletion_requests(lc_lot_id)
  WHERE status='pending' AND resource_type='lot';

CREATE INDEX IF NOT EXISTS ix_lc_deletion_requests_requested_at
  ON public.lc_deletion_requests(requested_at DESC);


CREATE TABLE IF NOT EXISTS public.lc_deletion_history (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('pot','lot')),
  lc_lot_id BIGINT,
  lc_pot_id BIGINT,
  lot_code TEXT,
  pot_code TEXT,
  reason TEXT NOT NULL,
  evidence_path TEXT,
  evidence_bucket TEXT NOT NULL DEFAULT 'lc_issue_delete',
  evidence_mime_type TEXT,
  requested_by UUID,
  requested_by_name TEXT NOT NULL,
  requested_by_role TEXT NOT NULL,
  requested_at TIMESTAMPTZ,
  approved_by UUID,
  approved_by_name TEXT,
  approved_at TIMESTAMPTZ,
  deletion_mode TEXT NOT NULL
    CHECK (deletion_mode IN ('admin_direct','operator_approved')),
  context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  original_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (resource_type='pot' AND lc_pot_id IS NOT NULL AND lc_lot_id IS NOT NULL)
    OR
    (resource_type='lot' AND lc_lot_id IS NOT NULL)
  )
);

ALTER TABLE public.lc_deletion_history
  ADD COLUMN IF NOT EXISTS evidence_bucket TEXT NOT NULL DEFAULT 'lc_issue_delete';
ALTER TABLE public.lc_deletion_history
  ADD COLUMN IF NOT EXISTS original_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS ix_lc_deletion_history_deleted_at
  ON public.lc_deletion_history(deleted_at DESC);
CREATE INDEX IF NOT EXISTS ix_lc_deletion_history_lot_id
  ON public.lc_deletion_history(lc_lot_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS ix_lc_deletion_history_pot_id
  ON public.lc_deletion_history(lc_pot_id, deleted_at DESC);

-- Private evidence bucket. The backend uses the Supabase service role and
-- provides administrators a temporary signed URL; no public policy is needed.
INSERT INTO storage.buckets
  (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'lc_issue_delete',
    'lc_issue_delete',
    false,
    4194304,
    ARRAY['image/jpeg','image/png','image/webp','image/avif','image/heic','image/heif']::text[]
  )
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMIT;
