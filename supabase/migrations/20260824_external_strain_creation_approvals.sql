-- External strain creation approval workflow.
-- The backend also creates this table defensively with IF NOT EXISTS so the
-- application remains deployable even when Supabase CLI migrations are not run.

CREATE TABLE IF NOT EXISTS public.strain_creation_requests (
  id BIGSERIAL PRIMARY KEY,
  request_type TEXT NOT NULL DEFAULT 'EXTERNAL_CREATE'
    CHECK (request_type IN ('EXTERNAL_CREATE')),
  requested_code TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by UUID,
  requested_by_name TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID,
  reviewed_by_name TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_strain_id UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_strain_creation_pending_code
ON public.strain_creation_requests (lower(requested_code))
WHERE status='pending';
