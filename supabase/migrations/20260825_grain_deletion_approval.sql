-- Mycelium Tech Digital
-- Grain pot/sac deletion approval workflow
-- Run once in Supabase SQL Editor before deploying the updated backend.

BEGIN;

CREATE TABLE IF NOT EXISTS public.grain_deletion_requests (
  id BIGSERIAL PRIMARY KEY,
  grain_unit_id BIGINT NOT NULL,
  batch_id BIGINT,
  unit_code TEXT,
  batch_code TEXT,
  container_type TEXT,
  reason TEXT NOT NULL,
  evidence_path TEXT,
  evidence_bucket TEXT NOT NULL DEFAULT 'grain_issue_delete',
  evidence_mime_type TEXT,
  context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by UUID,
  requested_by_name TEXT NOT NULL,
  requested_by_role TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID,
  reviewed_by_name TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_grain_deletion_pending_unit
  ON public.grain_deletion_requests(grain_unit_id)
  WHERE status='pending';
CREATE INDEX IF NOT EXISTS ix_grain_deletion_requests_requested_at
  ON public.grain_deletion_requests(requested_at DESC);

CREATE TABLE IF NOT EXISTS public.grain_deletion_history (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT,
  grain_unit_id BIGINT NOT NULL,
  batch_id BIGINT,
  unit_code TEXT,
  batch_code TEXT,
  container_type TEXT,
  reason TEXT NOT NULL,
  evidence_path TEXT,
  evidence_bucket TEXT NOT NULL DEFAULT 'grain_issue_delete',
  evidence_mime_type TEXT,
  requested_by UUID,
  requested_by_name TEXT NOT NULL,
  requested_by_role TEXT NOT NULL,
  requested_at TIMESTAMPTZ,
  approved_by UUID,
  approved_by_name TEXT,
  approved_at TIMESTAMPTZ,
  deletion_mode TEXT NOT NULL CHECK (deletion_mode IN ('admin_direct','operator_approved')),
  context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  original_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_grain_deletion_history_deleted_at
  ON public.grain_deletion_history(deleted_at DESC);
CREATE INDEX IF NOT EXISTS ix_grain_deletion_history_unit_id
  ON public.grain_deletion_history(grain_unit_id, deleted_at DESC);

-- RBAC permissions used by server.js.
INSERT INTO public.app_permissions(code,description)
VALUES
  ('grain.delete.request','Demander la suppression d’un pot ou sac grain'),
  ('grain.delete.direct','Supprimer immédiatement un pot ou sac grain'),
  ('grain.delete.approve','Approuver les suppressions grain')
ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO public.app_role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM public.app_roles r
JOIN public.app_permissions p ON p.code='grain.delete.request'
WHERE r.code='operator'
ON CONFLICT DO NOTHING;

INSERT INTO public.app_role_permissions(role_id,permission_id)
SELECT r.id,p.id
FROM public.app_roles r
CROSS JOIN public.app_permissions p
WHERE r.code='admin' AND p.code IN ('grain.delete.request','grain.delete.direct','grain.delete.approve')
ON CONFLICT DO NOTHING;

COMMIT;

-- The private Supabase Storage bucket "grain_issue_delete" is created automatically
-- by the updated backend on first evidence upload. It is intentionally not public.
