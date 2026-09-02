-- MyceliumTech / Biotech Agro performance indexes - 2026-09-02
-- Run once in Supabase SQL Editor BEFORE deploying the optimized server.js.
DO $$
BEGIN
  IF to_regclass('public.iso_petri_journal') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='iso_petri_journal' AND column_name='petri_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='iso_petri_journal' AND column_name='day_index')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='iso_petri_journal' AND column_name='treated_at')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='iso_petri_journal' AND column_name='id')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_iso_petri_journal_latest_by_petri ON public.iso_petri_journal (petri_id, day_index DESC, treated_at DESC, id DESC)'; END IF;

  IF to_regclass('public.lc_pot_journal') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lc_pot_journal' AND column_name='treated_at')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_lc_pot_journal_treated_at ON public.lc_pot_journal (treated_at DESC)'; END IF;

  IF to_regclass('public.myc_grain_journal') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='myc_grain_journal' AND column_name='treated_at')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_grain_journal_treated_at ON public.myc_grain_journal (treated_at DESC)'; END IF;

  IF to_regclass('public.lc_pots') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lc_pots' AND column_name='lot_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lc_pots' AND column_name='pot_number')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lc_pots' AND column_name='deleted_at')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_lc_pots_active_lot_pot ON public.lc_pots (lot_id, pot_number) WHERE deleted_at IS NULL'; END IF;

  IF to_regclass('public.app_users') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_users' AND column_name='last_seen_at')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_app_users_last_seen_at ON public.app_users (last_seen_at DESC)'; END IF;

  IF to_regclass('public.photo_deletion_requests') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='photo_deletion_requests' AND column_name='status')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_photo_deletion_pending_id ON public.photo_deletion_requests (id) WHERE status=''pending'''; END IF;
  IF to_regclass('public.petri_deletion_requests') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='petri_deletion_requests' AND column_name='status')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_petri_deletion_pending_id ON public.petri_deletion_requests (id) WHERE status=''pending'''; END IF;
  IF to_regclass('public.lc_deletion_requests') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lc_deletion_requests' AND column_name='status')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_lc_deletion_pending_id ON public.lc_deletion_requests (id) WHERE status=''pending'''; END IF;
  IF to_regclass('public.grain_deletion_requests') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='grain_deletion_requests' AND column_name='status')
  THEN EXECUTE 'CREATE INDEX IF NOT EXISTS ix_grain_deletion_pending_id ON public.grain_deletion_requests (id) WHERE status=''pending'''; END IF;
END $$;
