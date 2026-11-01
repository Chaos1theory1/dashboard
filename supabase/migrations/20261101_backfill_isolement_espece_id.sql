BEGIN;

-- Backfill legacy isolations created before isolements.espece_id existed.
-- Priority: exact scientific name -> genus/cycle match -> common-name match in champignon.
WITH candidates AS (
  SELECT
    i.id AS isolement_id,
    e.id_espece,
    ROW_NUMBER() OVER (
      PARTITION BY i.id
      ORDER BY
        CASE
          WHEN upper(trim(e.nom_scientifique)) = upper(trim(i.cycle_type::text)) THEN 1
          WHEN upper(split_part(trim(e.nom_scientifique), ' ', 1)) = upper(trim(i.cycle_type::text)) THEN 2
          WHEN NULLIF(trim(e.nom_commun), '') IS NOT NULL
               AND upper(COALESCE(i.champignon, '')) LIKE '%' || upper(trim(e.nom_commun)) || '%' THEN 3
          ELSE 9
        END,
        e.id_espece
    ) AS rn
  FROM isolements i
  JOIN especes e
    ON upper(trim(e.nom_scientifique)) = upper(trim(i.cycle_type::text))
    OR upper(split_part(trim(e.nom_scientifique), ' ', 1)) = upper(trim(i.cycle_type::text))
    OR (
      NULLIF(trim(e.nom_commun), '') IS NOT NULL
      AND upper(COALESCE(i.champignon, '')) LIKE '%' || upper(trim(e.nom_commun)) || '%'
    )
  WHERE i.espece_id IS NULL
)
UPDATE isolements i
SET espece_id = c.id_espece,
    updated_at = now()
FROM candidates c
WHERE c.isolement_id = i.id
  AND c.rn = 1
  AND i.espece_id IS NULL;

COMMIT;

-- Optional verification:
-- SELECT i.id, i.code, i.cycle_type, i.champignon, i.espece_id, e.nom_scientifique
-- FROM isolements i
-- LEFT JOIN especes e ON e.id_espece = i.espece_id
-- ORDER BY i.id DESC;
