BEGIN;

WITH candidates AS (
  SELECT DISTINCT ON (i.id)
    i.id AS isolement_id,
    e.id_espece
  FROM isolements i
  JOIN especes e
    ON (
      upper(trim(i.cycle_type::text)) = upper(trim(e.nom_scientifique))

      OR (
        upper(trim(i.cycle_type::text)) = 'AGARICUS'
        AND upper(trim(e.nom_scientifique)) LIKE 'AGARICUS%'
      )

      OR (
        upper(trim(i.cycle_type::text)) = 'PLEUROTUS'
        AND upper(trim(e.nom_scientifique)) LIKE 'PLEUROTUS%'
      )

      OR (
        NULLIF(trim(e.nom_commun), '') IS NOT NULL
        AND upper(COALESCE(i.champignon, ''))
            LIKE '%' || upper(trim(e.nom_commun)) || '%'
      )
    )
  WHERE i.espece_id IS NULL
  ORDER BY i.id, e.id_espece
)

UPDATE isolements i
SET
  espece_id = c.id_espece,
  updated_at = now()
FROM candidates c
WHERE c.isolement_id = i.id
  AND i.espece_id IS NULL;

COMMIT;