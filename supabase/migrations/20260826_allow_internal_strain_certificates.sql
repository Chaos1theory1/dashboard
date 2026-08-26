-- Option A: certificate_available means that a certificate is associated
-- with the strain, whether the strain is INTERNAL or EXTERNAL.
--
-- The previous constraint forced every INTERNAL strain to keep
-- certificate_available = false, which conflicts with the certification
-- workflow that sets certificate_available = true after a successful
-- certification.

BEGIN;

ALTER TABLE public.strains
  DROP CONSTRAINT IF EXISTS chk_strains_internal_no_cert;

-- Keep the important production safety rule intact. Recreate it only if a
-- database was missing it for any reason. PostgreSQL does not support
-- ADD CONSTRAINT IF NOT EXISTS, so use a guarded DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.strains'::regclass
      AND conname = 'chk_strains_production_requires_cert'
  ) THEN
    ALTER TABLE public.strains
      ADD CONSTRAINT chk_strains_production_requires_cert
      CHECK (
        production_allowed = false
        OR certification_status = 'CERTIFIED'::strain_certification_status_enum
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.strains.certificate_available IS
  'True when a certificate is associated with the strain, including certificates issued through the internal certification workflow.';

COMMIT;
