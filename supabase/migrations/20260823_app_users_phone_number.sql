BEGIN;

-- Adds the new phone number field used by the Users administration page.
-- Existing users are kept intact; their phone number can be filled the next time an admin edits them.
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS phone_number TEXT;

COMMENT ON COLUMN public.app_users.phone_number IS
  'Telephone number managed from the Mycelium Tech user administration page.';

COMMIT;
