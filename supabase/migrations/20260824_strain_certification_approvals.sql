BEGIN;

CREATE TABLE IF NOT EXISTS public.strain_certification_requests (
  id BIGSERIAL PRIMARY KEY,
  strain_id UUID NOT NULL REFERENCES public.strains(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  certificate_file_url TEXT,
  certificate_file_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','cancelled')),
  requested_by UUID,
  requested_by_name TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID,
  reviewed_by_name TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_strain_certification_pending
  ON public.strain_certification_requests (strain_id)
  WHERE status='pending';

CREATE INDEX IF NOT EXISTS ix_strain_certification_requests_requested_at
  ON public.strain_certification_requests (requested_at DESC);

COMMIT;
