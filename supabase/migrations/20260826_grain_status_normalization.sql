-- Canonicalise Grain storage statuses and repair preparation-lot statuses.
-- Safe to run once in Supabase SQL Editor before deploying the matching backend.

BEGIN;

-- 1) One canonical storage status for Grain units.
UPDATE myc_grain_units
SET statut = 'STOCK',
    updated_at = now()
WHERE UPPER(BTRIM(COALESCE(statut,''))) IN ('EN_STOCK','STOCKE','STOCKEE','FRIGO');

ALTER TABLE myc_grain_units
  DROP CONSTRAINT IF EXISTS chk_myc_grain_units_no_legacy_stock_status;

ALTER TABLE myc_grain_units
  ADD CONSTRAINT chk_myc_grain_units_no_legacy_stock_status
  CHECK (
    statut IS NULL
    OR UPPER(BTRIM(statut)) NOT IN ('EN_STOCK','STOCKE','STOCKEE','FRIGO')
  );

-- 2) Derive each preparation-lot status from its current units.
-- PREPARE                  = every existing unit is still prepared/available.
-- PARTIELLEMENT_ENSEMENCE  = mix of prepared and already inoculated/advanced units.
-- ENSEMENCE                = no prepared units remain.
-- SUPPRIME                 = the lot has no remaining units.
WITH state AS (
  SELECT b.id,
         COUNT(u.id)::int AS total,
         COUNT(u.id) FILTER (
           WHERE UPPER(BTRIM(COALESCE(u.statut,'')))='PREPARE'
         )::int AS prepared
  FROM myc_grain_batches b
  LEFT JOIN myc_grain_units u ON u.batch_id=b.id
  GROUP BY b.id
)
UPDATE myc_grain_batches b
SET statut = CASE
      WHEN state.total = 0 THEN 'SUPPRIME'
      WHEN state.prepared = state.total THEN 'PREPARE'
      WHEN state.prepared = 0 THEN 'ENSEMENCE'
      ELSE 'PARTIELLEMENT_ENSEMENCE'
    END,
    nb_units = state.total,
    updated_at = now()
FROM state
WHERE b.id = state.id;

COMMIT;
