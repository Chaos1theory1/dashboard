BEGIN;

-- ============================================================
-- Petri deletion approval workflow
-- - Operator requests require administrator approval.
-- - Administrator direct deletions are logged immediately.
-- - Every executed deletion keeps the mandatory reason in
--   petri_deletion_history.
-- - Optional evidence images are stored in the private
--   Supabase Storage bucket: petrie_issue_delete
-- ============================================================

CREATE TABLE IF NOT EXISTS public.petri_deletion_requests (
  id BIGSERIAL PRIMARY KEY,
  petri_id BIGINT NOT NULL,
  isolement_id BIGINT,
  phase INTEGER,
  petri_code TEXT,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  evidence_path TEXT,
  evidence_bucket TEXT NOT NULL DEFAULT 'petrie_issue_delete',
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
  review_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_petri_deletion_pending
  ON public.petri_deletion_requests(petri_id)
  WHERE status='pending';

CREATE INDEX IF NOT EXISTS ix_petri_deletion_requests_requested_at
  ON public.petri_deletion_requests(requested_at DESC);

CREATE TABLE IF NOT EXISTS public.petri_deletion_history (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT,
  petri_id BIGINT NOT NULL,
  isolement_id BIGINT,
  phase INTEGER,
  petri_code TEXT,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  evidence_path TEXT,
  evidence_bucket TEXT NOT NULL DEFAULT 'petrie_issue_delete',
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
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_petri_deletion_history_deleted_at
  ON public.petri_deletion_history(deleted_at DESC);

CREATE INDEX IF NOT EXISTS ix_petri_deletion_history_petri_id
  ON public.petri_deletion_history(petri_id, deleted_at DESC);

-- Private bucket. The backend uses the Supabase service key, so no public
-- INSERT/SELECT storage policies are required for browser clients.
INSERT INTO storage.buckets (id, name, public)
VALUES ('petrie_issue_delete', 'petrie_issue_delete', false)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    public = false;

COMMIT;
