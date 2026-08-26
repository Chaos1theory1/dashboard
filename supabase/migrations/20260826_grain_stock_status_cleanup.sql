-- Canonicalise Mycelium Grain storage status.
-- After this migration, STOCK is the only supported storage status for myc_grain_units.
-- Legacy aliases EN_STOCK, STOCKE, STOCKEE and FRIGO are converted to STOCK
-- and prevented from being inserted again.

BEGIN;

-- 1) Convert existing legacy Grain unit statuses.
UPDATE public.myc_grain_units
SET statut = 'STOCK',
    updated_at = now()
WHERE UPPER(BTRIM(COALESCE(statut, ''))) IN ('EN_STOCK', 'STOCKE', 'STOCKEE', 'FRIGO');

-- 2) Prevent these legacy aliases from coming back.
ALTER TABLE public.myc_grain_units
  DROP CONSTRAINT IF EXISTS chk_myc_grain_units_no_legacy_stock_status;

ALTER TABLE public.myc_grain_units
  ADD CONSTRAINT chk_myc_grain_units_no_legacy_stock_status
  CHECK (
    statut IS NULL
    OR UPPER(BTRIM(statut)) NOT IN ('EN_STOCK', 'STOCKE', 'STOCKEE', 'FRIGO')
  );

COMMIT;

-- Verification: this should return zero rows for the four removed aliases.
SELECT statut, COUNT(*) AS total
FROM public.myc_grain_units
WHERE UPPER(BTRIM(COALESCE(statut, ''))) IN ('EN_STOCK', 'STOCKE', 'STOCKEE', 'FRIGO')
GROUP BY statut
ORDER BY statut;

-- Optional overview of the remaining Grain unit statuses.
SELECT statut, COUNT(*) AS total
FROM public.myc_grain_units
GROUP BY statut
ORDER BY statut;
