/**
 * Routes API pour la gestion des souches
 * Backend Node.js/Express pour BaslyAgro.Biotech
 * VERSION FINALE - Structure base de données vérifiée
 * 
 * STRUCTURE RÉELLE CONFIRMÉE:
 * - isolements (id, code, champignon, categorie, origine)
 * - iso_petris (id, isolement_id, phase, j0, status, gelose_id)
 * - iso_geloses (id, isolement_id, nom, recette)
 * - strains (id UUID, code, species, name, etc.)
 */
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { deleteStoredFile, persistUploadedFile, safeExtension, shouldUseCloudStorage } = require('../supabase-storage');


const express = require('express');
const router = express.Router();


// ============================================================
// APPROBATION DE CREATION DES SOUCHES EXTERNES
// ============================================================
function isAdminRequest(req) {
  return !!(req && req.adminSession && req.adminSession.role === 'admin');
}

function isOperatorRequest(req) {
  return !!(req && req.adminSession && req.adminSession.role === 'operator');
}

function cleanText(value, max = 5000) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanDate(value) {
  const text = cleanText(value, 40);
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text.slice(0, 10)) ? text.slice(0, 10) : null;
}

function normalizeStrainPayload(body = {}, options = {}) {
  const strainType = String(body.strain_type || '').trim().toUpperCase();
  const forceExternalSafety = options.forceExternalSafety === true && strainType === 'EXTERNAL';
  const sourceRef = cleanText(body.source_ref ?? body.certificate_ref, 500);

  return {
    code: cleanText(body.code, 160),
    name: cleanText(body.name, 255),
    species: cleanText(body.species, 255),
    strain_type: strainType,
    form: String(body.form || 'AGAR').trim().toUpperCase(),
    source_name: cleanText(body.source_name, 255),
    source_ref: sourceRef,
    quantity: cleanNumber(body.quantity),
    unit: cleanText(body.unit, 30),
    created_on: cleanDate(body.created_on),
    manufactured_on: cleanDate(body.manufactured_on),
    expiry_on: cleanDate(body.expiry_on),
    storage_temp_c: cleanNumber(body.storage_temp_c),
    storage_location: cleanText(body.storage_location, 255),
    status: String(body.status || 'ACTIVE').trim().toUpperCase(),
    notes: cleanText(body.notes, 10000),
    received_on: cleanDate(body.received_on),
    certificate_available: forceExternalSafety
      ? Boolean(body.certificate_available || sourceRef)
      : Boolean(body.certificate_available),
    certification_status: forceExternalSafety
      ? 'NOT_CERTIFIED'
      : String(body.certification_status || 'NOT_CERTIFIED').trim().toUpperCase(),
    production_allowed: forceExternalSafety ? false : body.production_allowed === true,
  };
}

function validateStrainPayload(payload) {
  if (!payload.code || !payload.name || !payload.species || !payload.strain_type) {
    const error = new Error('Champs obligatoires manquants: code, name, species, strain_type');
    error.status = 400;
    throw error;
  }
  if (!['INTERNAL', 'EXTERNAL'].includes(payload.strain_type)) {
    const error = new Error('strain_type doit être INTERNAL ou EXTERNAL');
    error.status = 400;
    throw error;
  }
  if (payload.strain_type === 'INTERNAL') {
    if (!payload.created_on) {
      const error = new Error('created_on obligatoire pour les souches internes');
      error.status = 400;
      throw error;
    }
    if (payload.certificate_available === true) {
      const error = new Error('Les souches internes ne peuvent pas avoir de certificat externe');
      error.status = 400;
      throw error;
    }
  }
  if (payload.production_allowed === true && payload.certification_status !== 'CERTIFIED') {
    const error = new Error('production_allowed nécessite certification_status = CERTIFIED');
    error.status = 400;
    throw error;
  }
}

async function insertStrain(db, payload) {
  const result = await db.query(
    `INSERT INTO strains (
      code, name, species, strain_type, form,
      source_name, source_ref, quantity, unit,
      created_on, manufactured_on, expiry_on,
      storage_temp_c, storage_location, status,
      notes, received_on,
      certificate_available, certification_status, production_allowed
    ) VALUES (
      $1, $2, $3, $4::strain_type_enum, $5::strain_form_enum,
      $6, $7, $8, $9::quantity_unit_enum,
      $10, $11, $12,
      $13, $14, $15::strain_status_enum,
      $16, $17,
      $18, $19::strain_certification_status_enum, $20
    )
    RETURNING *`,
    [
      payload.code, payload.name, payload.species, payload.strain_type, payload.form,
      payload.source_name, payload.source_ref, payload.quantity, payload.unit,
      payload.created_on, payload.manufactured_on, payload.expiry_on,
      payload.storage_temp_c, payload.storage_location, payload.status,
      payload.notes, payload.received_on,
      payload.certificate_available, payload.certification_status, payload.production_allowed
    ]
  );
  return result.rows[0];
}

async function ensureStrainCreationApprovalSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS strain_creation_requests (
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
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_strain_creation_pending_code
    ON strain_creation_requests (lower(requested_code))
    WHERE status='pending'
  `);
}

async function queueExternalStrainCreation(req, res, payload) {
  await ensureStrainCreationApprovalSchema(req.db);

  const existing = await req.db.query(
    `SELECT id FROM strains WHERE lower(code)=lower($1) LIMIT 1`,
    [payload.code]
  );
  if (existing.rows.length) {
    return res.status(409).json({ error: 'Ce code de souche existe déjà' });
  }

  try {
    const result = await req.db.query(
      `INSERT INTO strain_creation_requests
        (requested_code,payload,requested_by,requested_by_name)
       VALUES ($1,$2::jsonb,$3,$4)
       RETURNING id,status,requested_at`,
      [
        payload.code,
        JSON.stringify(payload),
        req.adminSession?.userId || null,
        req.adminSession?.username || 'Opérateur'
      ]
    );
    return res.status(202).json({
      success: true,
      pending: true,
      request_id: result.rows[0].id,
      status: result.rows[0].status,
      message: 'Demande de création envoyée à un administrateur. La souche sera ajoutée après approbation.'
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Une demande en attente existe déjà pour ce code de souche.' });
    }
    throw error;
  }
}

function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

async function getStrainDependencies(db, strainId) {
  const fkResult = await db.query(`
    SELECT DISTINCT
      kcu.table_schema,
      kcu.table_name,
      kcu.column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name=kcu.constraint_name
     AND tc.constraint_schema=kcu.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name=tc.constraint_name
     AND ccu.constraint_schema=tc.constraint_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name=tc.constraint_name
     AND rc.constraint_schema=tc.constraint_schema
    WHERE tc.constraint_type='FOREIGN KEY'
      AND ccu.table_schema='public'
      AND ccu.table_name='strains'
      AND ccu.column_name='id'
  `);

  const dependencies = [];
  for (const fk of fkResult.rows) {
    const schema = quoteIdentifier(fk.table_schema);
    const table = quoteIdentifier(fk.table_name);
    const column = quoteIdentifier(fk.column_name);
    const count = await db.query(
      `SELECT count(*)::int AS total FROM ${schema}.${table} WHERE ${column}=$1::uuid`,
      [strainId]
    );
    const total = Number(count.rows[0]?.total || 0);
    if (total > 0) {
      dependencies.push({
        table: fk.table_name,
        column: fk.column_name,
        delete_rule: fk.delete_rule,
        count: total,
      });
    }
  }
  return dependencies;
}


// Admin: consulter / approuver / refuser les demandes de création externe.
router.get('/strain-creation-requests', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Réservé aux administrateurs' });
  try {
    await ensureStrainCreationApprovalSchema(req.db);
    const result = await req.db.query(`
      SELECT id,request_type,requested_code,payload,status,
             requested_by,requested_by_name,requested_at,
             reviewed_by,reviewed_by_name,reviewed_at,review_note,created_strain_id
      FROM strain_creation_requests
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, requested_at DESC
      LIMIT 300
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/strain-creation-requests:', error);
    res.status(500).json({ error: 'Impossible de charger les demandes de création de souche' });
  }
});

router.post('/strain-creation-requests/:id/reject', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Réservé aux administrateurs' });
  try {
    await ensureStrainCreationApprovalSchema(req.db);
    const result = await req.db.query(`
      UPDATE strain_creation_requests
      SET status='rejected',reviewed_by=$2,reviewed_by_name=$3,
          reviewed_at=now(),review_note=$4
      WHERE id=$1 AND status='pending'
      RETURNING *
    `, [
      Number(req.params.id),
      req.adminSession?.userId || null,
      req.adminSession?.username || 'Admin',
      String(req.body?.note || '')
    ]);
    if (!result.rows.length) return res.status(409).json({ error: 'Cette demande a déjà été traitée.' });
    res.json({ success: true, request: result.rows[0] });
  } catch (error) {
    console.error('POST /api/strain-creation-requests/:id/reject:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/strain-creation-requests/:id/approve', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Réservé aux administrateurs' });
  await ensureStrainCreationApprovalSchema(req.db);
  const client = await req.db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM strain_creation_requests WHERE id=$1 FOR UPDATE`,
      [Number(req.params.id)]
    );
    if (!locked.rows.length || locked.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cette demande a déjà été traitée.' });
    }

    const payload = normalizeStrainPayload(locked.rows[0].payload || {}, { forceExternalSafety: true });
    validateStrainPayload(payload);
    if (payload.strain_type !== 'EXTERNAL') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cette demande ne concerne pas une souche externe.' });
    }

    const existing = await client.query(
      `SELECT id FROM strains WHERE lower(code)=lower($1) LIMIT 1`,
      [payload.code]
    );
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Le code de souche existe déjà. Refusez ou corrigez la demande.' });
    }

    const strain = await insertStrain(client, payload);
    await client.query(`
      UPDATE strain_creation_requests
      SET status='approved',reviewed_by=$2,reviewed_by_name=$3,
          reviewed_at=now(),review_note=$4,created_strain_id=$5
      WHERE id=$1 AND status='pending'
    `, [
      Number(req.params.id),
      req.adminSession?.userId || null,
      req.adminSession?.username || 'Admin',
      String(req.body?.note || ''),
      strain.id
    ]);
    await client.query('COMMIT');
    res.json({ success: true, strain });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('POST /api/strain-creation-requests/:id/approve:', error);
    if (error.code === '23505') return res.status(409).json({ error: 'Ce code de souche existe déjà' });
    res.status(error.status || 500).json({ error: error.message || 'Erreur lors de l’approbation' });
  } finally {
    client.release();
  }
});

// ============================================================
// ROUTES DE BASE - GESTION DES SOUCHES
// ============================================================
function certificateFilename(req, file) {
  const ext = safeExtension(file && file.originalname, '.pdf');
  const demoPrefix = req.adminSession && req.adminSession.role === 'visitor' && req.adminSession.sid
    ? `DEMO-${req.adminSession.sid}-`
    : '';
  return `${demoPrefix}STRAIN-${req.params.id}-${Date.now()}${ext}`;
}

const storage = shouldUseCloudStorage()
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../../uploads/certificates');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, certificateFilename(req, file))
    });

const upload = multer({
  storage,
  limits: { fileSize: process.env.VERCEL ? 4 * 1024 * 1024 : 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Seuls les fichiers PDF sont autorisés'));
    }
    cb(null, true);
  }
});
router.post(
  '/strains/:id/certify',
  upload.single('certificate_pdf'),
  async (req, res) => {
    const {
      certificate_ref,
      certified_by,
      contamination_status,
      contamination_type,
      growth_rate,
      colonization_days,
      morphology_status,
      decision,
      notes
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Certificat PDF manquant' });
    }

    if (decision !== 'PASS') {
      return res.status(400).json({ error: 'La certification doit être PASS' });
    }

    let pdfPath = null;
    try {
      pdfPath = await persistUploadedFile({
        file: req.file,
        folder: 'certificates',
        filename: req.file.filename || certificateFilename(req, req.file),
      });
      await req.db.query('BEGIN');

      // 1️⃣ Enregistrer le certificat
      await req.db.query(
        `
        INSERT INTO strain_certificates (
          strain_id,
          certificate_ref,
          certified_by,
          contamination_status,
          contamination_type,
          growth_rate,
          colonization_days,
          morphology_status,
          decision,
          notes,
          pdf_path
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          req.params.id,
          certificate_ref,
          certified_by,
          contamination_status,
          contamination_type || null,
          growth_rate || null,
          colonization_days || null,
          morphology_status || null,
          decision,
          notes || null,
          pdfPath
        ]
      );

      // 2️⃣ Mettre à jour la souche
      await req.db.query(
        `
        UPDATE strains
        SET
          certificate_available = true,
          certification_status = 'CERTIFIED',
          production_allowed = true
        WHERE id = $1
        `,
        [req.params.id]
      );

      await req.db.query('COMMIT');

      res.json({ success: true });
    } catch (error) {
      try { await req.db.query('ROLLBACK'); } catch (_) {}
      if (pdfPath) await deleteStoredFile(pdfPath, path.join(__dirname, '../..'));
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * 
 * 
 * 
 * 
 * 
 * 
 * GET /api/strains
 * Liste toutes les souches avec pagination
 */
router.get('/strains', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const offset = parseInt(req.query.offset) || 0;
    
    const result = await req.db.query(
      `SELECT 
        id, code, species, name, strain_type, form,
        source_name, source_ref,
        quantity, unit,
        created_on, manufactured_on, expiry_on,
        storage_temp_c, storage_location,
        status, certificate_available, certification_status, 
        production_allowed, created_at, updated_at
      FROM strains
      WHERE status != 'ARCHIVED'
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/strains:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des souches' });
  }
});

router.get('/strains/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      'SELECT * FROM strains WHERE id = $1::UUID',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/strains/:id:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la souche' });
  }
});

router.post('/strains', async (req, res) => {
  try {
    // Pour une souche externe créée par un opérateur, on ne crée jamais la
    // souche immédiatement : on stocke une demande complète pour approbation.
    const requestedType = String(req.body?.strain_type || '').trim().toUpperCase();
    const forceExternalSafety = requestedType === 'EXTERNAL';
    const payload = normalizeStrainPayload(req.body || {}, { forceExternalSafety });
    validateStrainPayload(payload);

    if (payload.strain_type === 'EXTERNAL' && isOperatorRequest(req)) {
      return await queueExternalStrainCreation(req, res, payload);
    }

    const created = await insertStrain(req.db, payload);
    res.status(201).json(created);
  } catch (error) {
    console.error('Erreur POST /api/strains:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ce code de souche existe déjà' });
    }
    res.status(error.status || 500).json({
      error: error.status ? error.message : 'Erreur lors de la création de la souche'
    });
  }
});

router.put('/strains/:id', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Seul un administrateur peut modifier une souche.' });
  }

  const { id } = req.params;
  const b = req.body || {};
  const code = cleanText(b.code, 160);
  const name = cleanText(b.name, 255);
  const species = cleanText(b.species, 255);
  const sourceName = cleanText(b.source_name, 255);
  const sourceRef = cleanText(b.source_ref, 500);
  const quantity = cleanNumber(b.quantity);
  const unit = cleanText(b.unit, 30);
  const createdOn = cleanDate(b.created_on);
  const manufacturedOn = cleanDate(b.manufactured_on);
  const expiryOn = cleanDate(b.expiry_on);
  const storageTemp = cleanNumber(b.storage_temp_c);
  const storageLocation = cleanText(b.storage_location, 255);
  const notes = cleanText(b.notes, 10000);
  const receivedOn = cleanDate(b.received_on);

  if (!code || !name || !species) {
    return res.status(400).json({ error: 'Code, nom et espèce sont obligatoires.' });
  }

  try {
    const existingStrain = await req.db.query(
      'SELECT * FROM strains WHERE id = $1::UUID',
      [id]
    );
    if (existingStrain.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }

    const current = existingStrain.rows[0];
    const certificateAvailable = current.strain_type === 'EXTERNAL'
      ? Boolean(sourceRef)
      : false;

    const result = await req.db.query(
      `UPDATE strains SET
        code = $1,
        name = $2,
        species = $3,
        source_name = $4,
        source_ref = $5,
        quantity = $6,
        unit = $7::quantity_unit_enum,
        created_on = $8,
        manufactured_on = $9,
        expiry_on = $10,
        storage_temp_c = $11,
        storage_location = $12,
        notes = $13,
        received_on = $14,
        certificate_available = $15,
        updated_at = NOW()
      WHERE id = $16::UUID
      RETURNING *`,
      [
        code, name, species, sourceName, sourceRef,
        quantity, unit, createdOn, manufacturedOn, expiryOn,
        storageTemp, storageLocation, notes, receivedOn,
        certificateAvailable, id
      ]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur PUT /api/strains/:id:', error);
    if (error.code === '23505') return res.status(409).json({ error: 'Ce code de souche existe déjà' });
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la souche' });
  }
});

router.delete('/strains/:id', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Seul un administrateur peut supprimer une souche.' });
  }

  const { id } = req.params;
  try {
    const existing = await req.db.query(
      `SELECT id,code,name,strain_type,status FROM strains WHERE id=$1::uuid`,
      [id]
    );
    if (!existing.rows.length) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }

    // Une suppression physique ne doit jamais effacer silencieusement l'historique
    // via des FOREIGN KEY ON DELETE CASCADE. On bloque donc toute souche déjà utilisée.
    const dependencies = await getStrainDependencies(req.db, id);
    if (dependencies.length) {
      return res.status(409).json({
        error: 'Suppression impossible : cette souche est déjà liée à des données de production ou de traçabilité. Utilisez le statut ARCHIVED si vous souhaitez la retirer de l’inventaire actif.',
        dependencies
      });
    }

    const deleted = await req.db.query(
      `DELETE FROM strains WHERE id=$1::uuid RETURNING id,code,name`,
      [id]
    );
    res.json({ success: true, message: 'Souche supprimée définitivement de la base de données.', strain: deleted.rows[0] });
  } catch (error) {
    console.error('Erreur DELETE /api/strains/:id:', error);
    if (error.code === '23503') {
      return res.status(409).json({ error: 'Suppression impossible : la souche est encore référencée par d’autres données.' });
    }
    res.status(500).json({ error: 'Erreur lors de la suppression de la souche' });
  }
});

// ============================================================
// ROUTES P3 VALIDÉS - VERSION FINALE CORRIGÉE
// ============================================================

/**
 * GET /api/petris/p3-valides
 * STRUCTURE RÉELLE VÉRIFIÉE:
 * - iso_geloses n'a PAS de gelose_id
 * - iso_geloses.nom contient le nom de la gélose
 * - Pas de lien avec types_gelose
 */
router.get('/petris/p3-valides', async (req, res) => {
  try {
    const result = await req.db.query(`
      SELECT 
        p.id,
        p.isolement_id,
        p.phase,
        p.j0,
        p.status,
        i.code AS isolement_code,
        i.champignon AS espece,
        i.categorie,
        i.origine,
        ig.nom AS gelose_nom
      FROM iso_petris p
      LEFT JOIN isolements i ON p.isolement_id = i.id
      LEFT JOIN iso_geloses ig ON p.gelose_id = ig.id
      WHERE p.phase = 3
        AND p.status = 'VALIDE'
        AND NOT EXISTS (
          SELECT 1 FROM strains s 
          WHERE s.source_ref = CAST(p.id AS VARCHAR)
        )
      ORDER BY p.j0 DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Erreur P3 validés:', err);
    res.status(500).json({ error: err.message });
  }
});


router.post('/petris/:id/use-for-strain', async (req, res) => {
  const { id } = req.params;
  
  try {
    const petriCheck = await req.db.query(
      'SELECT * FROM iso_petris WHERE id = $1',
      [id]
    );
    
    if (petriCheck.rows.length === 0) {
      return res.status(404).json({ error: 'P3 non trouvé' });
    }
    
    const petri = petriCheck.rows[0];
    
    if (petri.phase !== 3) {
      return res.status(400).json({ error: 'Ce petri n\'est pas en phase P3' });
    }
    
    if (petri.status !== 'VALIDE') {
      return res.status(400).json({ 
        error: `Ce P3 a un statut ${petri.status} et ne peut pas être utilisé` 
      });
    }
    
    await req.db.query(
      `UPDATE iso_petris SET 
        status = 'TERMINE',
        updated_at = NOW()
      WHERE id = $1`,
      [id]
    );
    
    res.json({ message: 'P3 marqué comme utilisé pour création de souche' });
  } catch (error) {
    console.error('Erreur POST /api/petris/:id/use-for-strain:', error);
    res.status(500).json({ error: 'Erreur lors du marquage du P3' });
  }
});

// ============================================================
// ROUTES JOURNAL DES SOUCHES
// ============================================================

router.get('/strains/by-source/:petri_id', async (req, res) => {
  const { petri_id } = req.params;
  
  try {
    const result = await req.db.query(
      `SELECT * FROM strains WHERE source_ref = $1`,
      [petri_id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée pour ce P3' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET /api/strains/by-source:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la souche' });
  }
});

router.get('/strains/:id/manipulations', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      `SELECT * FROM strain_manipulations 
       WHERE strain_id = $1::UUID
       ORDER BY created_at DESC`,
      [id]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur GET /api/strains/:id/manipulations:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des manipulations' });
  }
});

router.post('/strains/:id/manipulations', async (req, res) => {
  const { id } = req.params;
  const {
    manipulation_type,
    notes,
    temperature_c,
    created_by = 'admin'
  } = req.body;
  
  if (!manipulation_type || !notes) {
    return res.status(400).json({ 
      error: 'Champs obligatoires manquants: manipulation_type, notes' 
    });
  }
  
  const validTypes = ['TRANSFERT', 'VERIFICATION', 'PRELEVEMENT', 'CONTAMINATION', 'STOCKAGE', 'AUTRE'];
  if (!validTypes.includes(manipulation_type)) {
    return res.status(400).json({ 
      error: `manipulation_type doit être l'un de: ${validTypes.join(', ')}` 
    });
  }
  
  if (temperature_c !== null && temperature_c !== undefined) {
    if (temperature_c < 0 || temperature_c > 10) {
      return res.status(400).json({ 
        error: 'Température doit être entre 0 et 10°C' 
      });
    }
  }
  
  try {
    const strainCheck = await req.db.query(
      'SELECT id FROM strains WHERE id = $1::UUID',
      [id]
    );
    
    if (strainCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Souche non trouvée' });
    }
    
    const result = await req.db.query(
      `INSERT INTO strain_manipulations (
        strain_id, manipulation_type, notes, temperature_c, created_by
      ) VALUES ($1::UUID, $2, $3, $4, $5)
      RETURNING *`,
      [id, manipulation_type, notes, temperature_c, created_by]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur POST /api/strains/:id/manipulations:', error);
    res.status(500).json({ error: 'Erreur lors de la création de la manipulation' });
  }
});

router.get('/strains/:id/stats', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      'SELECT * FROM get_strain_manipulation_stats($1::UUID)',
      [id]
    );
    
    res.json(result.rows[0] || {
      total_manipulations: 0,
      last_manipulation_date: null,
      last_verification_date: null,
      average_temperature: null
    });
  } catch (error) {
    console.error('Erreur GET /api/strains/:id/stats:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
  }
});

router.delete('/strains/:id/manipulations/:manip_id', async (req, res) => {
  const { id, manip_id } = req.params;
  
  try {
    const result = await req.db.query(
      `DELETE FROM strain_manipulations 
       WHERE id = $1 AND strain_id = $2::UUID
       RETURNING *`,
      [manip_id, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Manipulation non trouvée' });
    }
    
    res.json({ 
      message: 'Manipulation supprimée avec succès',
      manipulation: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur DELETE manipulation:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la manipulation' });
  }
});

router.get('/strains/:id/expiry-alert', async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await req.db.query(
      `SELECT 
        id,
        code,
        name,
        created_on,
        created_on + INTERVAL '2 years' AS expiry_date,
        EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) AS days_until_expiry,
        CASE 
          WHEN EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) < 0 THEN 'EXPIRED'
          WHEN EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) < 30 THEN 'CRITICAL'
          WHEN EXTRACT(DAY FROM (created_on + INTERVAL '2 years' - NOW())) < 90 THEN 'WARNING'
          ELSE 'OK'
        END AS alert_level
      FROM strains
      WHERE id = $1::UUID AND strain_type = 'INTERNAL'::strain_type_enum`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Souche interne non trouvée' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur GET expiry alert:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification d\'expiration' });
  }
});

// ============================================================
// IMPRESSION ÉTIQUETTES
// ============================================================

router.post('/labels/print', async (req, res) => {
  const { code, type = 'STRAIN', quantity = 1 } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'Code obligatoire' });
  }
  
  try {
    if (type === 'STRAIN') {
      const strainResult = await req.db.query(
        'SELECT * FROM strains WHERE code = $1',
        [code]
      );
      
      if (strainResult.rows.length === 0) {
        return res.status(404).json({ error: 'Souche non trouvée' });
      }
      
      const strain = strainResult.rows[0];
      
      console.log('=== IMPRESSION ÉTIQUETTE ===');
      console.log('Code:', code);
      console.log('Nom:', strain.name);
      console.log('Espèce:', strain.species);
      console.log('Type:', strain.strain_type);
      console.log('Date:', new Date().toLocaleDateString('fr-FR'));
      console.log('Quantité:', quantity);
      console.log('===========================');
      
      await req.db.query(
        `INSERT INTO print_logs (
          item_code, item_type, quantity, printed_at
        ) VALUES ($1, $2, $3, NOW())`,
        [code, type, quantity]
      ).catch(() => {});
    }
    
    res.json({ 
      message: `Demande d'impression envoyée: ${quantity} étiquette(s) pour ${code}`,
      success: true 
    });
  } catch (error) {
    console.error('Erreur POST /api/labels/print:', error);
    res.status(500).json({ error: 'Erreur lors de l\'impression' });
  }
});

module.exports = router;