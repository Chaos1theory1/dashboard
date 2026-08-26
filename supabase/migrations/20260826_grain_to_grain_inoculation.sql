-- Mycelium Tech Digital
-- Grain inoculation source extension: LC | P3 | GRAIN
-- Safe to run after the previous LC/P3 migration.

BEGIN;

ALTER TABLE IF EXISTS myc_grain_units
  ADD COLUMN IF NOT EXISTS inoculation_source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_grain_unit_id BIGINT,
  ADD COLUMN IF NOT EXISTS source_grain_unit_code TEXT,
  ADD COLUMN IF NOT EXISTS source_petri_id BIGINT,
  ADD COLUMN IF NOT EXISTS p3_code TEXT;

ALTER TABLE IF EXISTS myc_grain_inoculations
  ADD COLUMN IF NOT EXISTS inoculation_source_type TEXT DEFAULT 'LC',
  ADD COLUMN IF NOT EXISTS source_grain_unit_id BIGINT,
  ADD COLUMN IF NOT EXISTS source_grain_unit_code TEXT,
  ADD COLUMN IF NOT EXISTS source_petri_id BIGINT,
  ADD COLUMN IF NOT EXISTS p3_code TEXT;

ALTER TABLE IF EXISTS myc_grain_inoculations
  ALTER COLUMN lc_lot_id DROP NOT NULL;

UPDATE myc_grain_inoculations
SET inoculation_source_type = CASE
  WHEN source_grain_unit_id IS NOT NULL THEN 'GRAIN'
  WHEN lc_lot_id IS NOT NULL THEN 'LC'
  WHEN source_petri_id IS NOT NULL THEN 'P3'
  ELSE 'LC'
END
WHERE inoculation_source_type IS NULL
   OR inoculation_source_type NOT IN ('LC','P3','GRAIN');

UPDATE myc_grain_units
SET inoculation_source_type = CASE
  WHEN source_grain_unit_id IS NOT NULL THEN 'GRAIN'
  WHEN lc_lot_id IS NOT NULL THEN 'LC'
  WHEN source_petri_id IS NOT NULL AND inoculated_at IS NOT NULL THEN 'P3'
  ELSE inoculation_source_type
END
WHERE inoculation_source_type IS NULL
  AND inoculated_at IS NOT NULL;

ALTER TABLE IF EXISTS myc_grain_inoculations
  ALTER COLUMN inoculation_source_type SET DEFAULT 'LC';
ALTER TABLE IF EXISTS myc_grain_inoculations
  ALTER COLUMN inoculation_source_type SET NOT NULL;

ALTER TABLE IF EXISTS myc_grain_inoculations
  DROP CONSTRAINT IF EXISTS chk_grain_inoculation_source_type;
ALTER TABLE IF EXISTS myc_grain_inoculations
  ADD CONSTRAINT chk_grain_inoculation_source_type
  CHECK (inoculation_source_type IN ('LC','P3','GRAIN'));

ALTER TABLE IF EXISTS myc_grain_units
  DROP CONSTRAINT IF EXISTS chk_grain_unit_source_type;
ALTER TABLE IF EXISTS myc_grain_units
  ADD CONSTRAINT chk_grain_unit_source_type
  CHECK (inoculation_source_type IS NULL OR inoculation_source_type IN ('LC','P3','GRAIN'));

DO $$
BEGIN
  IF to_regclass('public.myc_grain_units') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_myc_grain_units_source_grain') THEN
    ALTER TABLE myc_grain_units
      ADD CONSTRAINT fk_myc_grain_units_source_grain
      FOREIGN KEY (source_grain_unit_id)
      REFERENCES myc_grain_units(id)
      ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.myc_grain_inoculations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_myc_grain_inoculations_source_grain') THEN
    ALTER TABLE myc_grain_inoculations
      ADD CONSTRAINT fk_myc_grain_inoculations_source_grain
      FOREIGN KEY (source_grain_unit_id)
      REFERENCES myc_grain_units(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_myc_grain_units_source_grain
  ON myc_grain_units(source_grain_unit_id)
  WHERE source_grain_unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_myc_grain_inoculations_source_grain
  ON myc_grain_inoculations(source_grain_unit_id)
  WHERE source_grain_unit_id IS NOT NULL;

COMMIT;
