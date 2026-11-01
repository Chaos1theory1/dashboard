-- 20261101_species_varieties_and_isolation_identity.sql
-- Database-backed species/varieties for isolation creation + operator approval workflow.

BEGIN;

CREATE TABLE IF NOT EXISTS public.espece_varietes (
  id BIGSERIAL PRIMARY KEY,
  espece_id BIGINT NOT NULL REFERENCES public.especes(id_espece) ON DELETE CASCADE,
  nom TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_espece_varietes_name
  ON public.espece_varietes(espece_id, lower(nom));

CREATE TABLE IF NOT EXISTS public.espece_variety_requests (
  id BIGSERIAL PRIMARY KEY,
  espece_id BIGINT NOT NULL REFERENCES public.especes(id_espece) ON DELETE CASCADE,
  variety_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  requested_by UUID,
  requested_by_name TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID,
  reviewed_by_name TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_variety_id BIGINT REFERENCES public.espece_varietes(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_espece_variety_requests_pending
  ON public.espece_variety_requests(espece_id, lower(variety_name)) WHERE status='pending';
CREATE INDEX IF NOT EXISTS ix_espece_variety_requests_status
  ON public.espece_variety_requests(status, requested_at DESC);

ALTER TABLE public.isolements ADD COLUMN IF NOT EXISTS espece_id BIGINT REFERENCES public.especes(id_espece) ON DELETE SET NULL;
ALTER TABLE public.isolements ADD COLUMN IF NOT EXISTS variety_id BIGINT REFERENCES public.espece_varietes(id) ON DELETE SET NULL;

-- Initial Agaricus bisporus catalogue supplied by Mycelium Tech Digital.
INSERT INTO public.espece_varietes(espece_id,nom,created_by_name)
SELECT e.id_espece,v.nom,'migration'
FROM public.especes e
CROSS JOIN (VALUES
  ('ItalienSpawn F599 (Blanc)'),
  ('ItalienSpawn FB30 (Brown)'),
  ('ItalienSpawn FB35 (Portobello)'),
  ('Sylvan A15 (Blanc)'),
  ('Sylvan Tuscan (Brown)'),
  ('Bio.De'),
  ('Saoudi Portabella'),
  ('Saoudi Brown')
) AS v(nom)
WHERE lower(e.nom_scientifique)=lower('Agaricus bisporus')
ON CONFLICT DO NOTHING;

COMMIT;
