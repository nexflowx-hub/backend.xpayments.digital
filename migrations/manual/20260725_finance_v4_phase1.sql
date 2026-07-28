BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- WALLET: BUCKET DE RECONCILIAÇÃO
-- =========================================================

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS reconciliation_hold numeric(18,2)
  NOT NULL DEFAULT 0.00;

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS updated_at timestamptz
  NOT NULL DEFAULT now();

-- =========================================================
-- WALLET MOVEMENTS: LIGAÇÕES FINANCEIRAS
-- =========================================================

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS transaction_id uuid;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS store_id uuid;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS payout_statement_id uuid;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS expected_release_at timestamptz;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS released_at timestamptz;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS updated_at timestamptz
  NOT NULL DEFAULT now();

-- =========================================================
-- PAYOUT STATEMENTS
-- =========================================================

CREATE TABLE IF NOT EXISTS public.payout_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  statement_code text NOT NULL UNIQUE,

  merchant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,

  currency text NOT NULL,
  amount numeric(18,2) NOT NULL,

  status text NOT NULL DEFAULT 'draft',

  scheduled_for date,
  paid_on date,
  paid_at timestamptz,

  external_reference text,
  description text,

  idempotency_key text NOT NULL UNIQUE,

  historical_date_only boolean
    NOT NULL DEFAULT false,

  created_by text,
  paid_by text,

  metadata jsonb
    NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz
    NOT NULL DEFAULT now(),

  updated_at timestamptz
    NOT NULL DEFAULT now(),

  CONSTRAINT payout_statements_amount_positive
    CHECK (amount > 0),

  CONSTRAINT payout_statements_status_valid
    CHECK (
      status IN (
        'draft',
        'scheduled',
        'processing',
        'paid',
        'cancelled',
        'failed'
      )
    )
);

CREATE TABLE IF NOT EXISTS public.payout_statement_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  payout_statement_id uuid NOT NULL,
  store_id uuid NOT NULL,

  amount numeric(18,2) NOT NULL,

  metadata jsonb
    NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz
    NOT NULL DEFAULT now(),

  CONSTRAINT payout_statement_allocations_amount_positive
    CHECK (amount > 0),

  CONSTRAINT payout_statement_allocations_unique_store
    UNIQUE (
      payout_statement_id,
      store_id
    )
);

CREATE TABLE IF NOT EXISTS public.payout_statement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  payout_statement_id uuid NOT NULL,

  event_type text NOT NULL,
  actor_reference text,

  payload jsonb
    NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz
    NOT NULL DEFAULT now()
);

-- =========================================================
-- FOREIGN KEYS
-- =========================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'payout_statements_merchant_id_fkey'
  ) THEN
    ALTER TABLE public.payout_statements
      ADD CONSTRAINT payout_statements_merchant_id_fkey
      FOREIGN KEY (merchant_id)
      REFERENCES public.merchants(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'payout_statements_wallet_id_fkey'
  ) THEN
    ALTER TABLE public.payout_statements
      ADD CONSTRAINT payout_statements_wallet_id_fkey
      FOREIGN KEY (wallet_id)
      REFERENCES public.wallets(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'payout_statement_allocations_payout_fkey'
  ) THEN
    ALTER TABLE public.payout_statement_allocations
      ADD CONSTRAINT payout_statement_allocations_payout_fkey
      FOREIGN KEY (payout_statement_id)
      REFERENCES public.payout_statements(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'payout_statement_allocations_store_fkey'
  ) THEN
    ALTER TABLE public.payout_statement_allocations
      ADD CONSTRAINT payout_statement_allocations_store_fkey
      FOREIGN KEY (store_id)
      REFERENCES public.stores(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'payout_statement_events_payout_fkey'
  ) THEN
    ALTER TABLE public.payout_statement_events
      ADD CONSTRAINT payout_statement_events_payout_fkey
      FOREIGN KEY (payout_statement_id)
      REFERENCES public.payout_statements(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'wallet_movements_transaction_id_fkey'
  ) THEN
    ALTER TABLE public.wallet_movements
      ADD CONSTRAINT wallet_movements_transaction_id_fkey
      FOREIGN KEY (transaction_id)
      REFERENCES public.transactions(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'wallet_movements_store_id_fkey'
  ) THEN
    ALTER TABLE public.wallet_movements
      ADD CONSTRAINT wallet_movements_store_id_fkey
      FOREIGN KEY (store_id)
      REFERENCES public.stores(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'wallet_movements_payout_statement_id_fkey'
  ) THEN
    ALTER TABLE public.wallet_movements
      ADD CONSTRAINT wallet_movements_payout_statement_id_fkey
      FOREIGN KEY (payout_statement_id)
      REFERENCES public.payout_statements(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- =========================================================
-- ÍNDICES
-- =========================================================

CREATE INDEX IF NOT EXISTS
  payout_statements_merchant_status_idx
ON public.payout_statements (
  merchant_id,
  status,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  payout_statements_scheduled_for_idx
ON public.payout_statements (
  scheduled_for
);

CREATE INDEX IF NOT EXISTS
  payout_statement_allocations_store_idx
ON public.payout_statement_allocations (
  store_id,
  payout_statement_id
);

CREATE INDEX IF NOT EXISTS
  payout_statement_events_payout_created_idx
ON public.payout_statement_events (
  payout_statement_id,
  created_at
);

CREATE INDEX IF NOT EXISTS
  wallet_movements_transaction_id_idx
ON public.wallet_movements (
  transaction_id
);

CREATE INDEX IF NOT EXISTS
  wallet_movements_store_id_idx
ON public.wallet_movements (
  store_id
);

CREATE INDEX IF NOT EXISTS
  wallet_movements_payout_statement_id_idx
ON public.wallet_movements (
  payout_statement_id
);

CREATE UNIQUE INDEX IF NOT EXISTS
  wallet_movements_idempotency_key_unique_idx
ON public.wallet_movements (
  idempotency_key
)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  wallet_movements_expected_release_idx
ON public.wallet_movements (
  merchant_id,
  expected_release_at
)
WHERE
  direction = 'in'
  AND status = 'pendente';

-- =========================================================
-- UPDATED_AT
-- =========================================================

CREATE OR REPLACE FUNCTION
public.xpayments_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  payout_statements_set_updated_at
ON public.payout_statements;

CREATE TRIGGER
  payout_statements_set_updated_at
BEFORE UPDATE
ON public.payout_statements
FOR EACH ROW
EXECUTE FUNCTION
  public.xpayments_set_updated_at();

DROP TRIGGER IF EXISTS
  wallets_set_updated_at
ON public.wallets;

CREATE TRIGGER
  wallets_set_updated_at
BEFORE UPDATE
ON public.wallets
FOR EACH ROW
EXECUTE FUNCTION
  public.xpayments_set_updated_at();

DROP TRIGGER IF EXISTS
  wallet_movements_set_updated_at
ON public.wallet_movements;

CREATE TRIGGER
  wallet_movements_set_updated_at
BEFORE UPDATE
ON public.wallet_movements
FOR EACH ROW
EXECUTE FUNCTION
  public.xpayments_set_updated_at();

-- =========================================================
-- BACKFILL: MOVEMENT -> TRANSACTION -> STORE
-- Não altera amount, status, balance ou available.
-- =========================================================

UPDATE public.wallet_movements AS movement
SET
  transaction_id =
    transaction_record.id,

  store_id =
    transaction_record.store_id,

  expected_release_at =
    COALESCE(
      movement.expected_release_at,
      movement.created_at + interval '3 days'
    )

FROM public.transactions AS transaction_record

WHERE movement.type = 'payment'
  AND movement.direction = 'in'
  AND movement.reference =
    transaction_record.id::text

  AND (
    movement.transaction_id IS NULL
    OR movement.store_id IS NULL
    OR movement.expected_release_at IS NULL
  );

COMMIT;
