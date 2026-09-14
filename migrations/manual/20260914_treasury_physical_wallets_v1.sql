CREATE TABLE IF NOT EXISTS public.treasury_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  currency text NOT NULL,
  wallet_role text NOT NULL,
  ecosystem text,
  status text NOT NULL DEFAULT 'active',
  balance numeric(18,2) NOT NULL DEFAULT 0.00,
  available numeric(18,2) NOT NULL DEFAULT 0.00,
  reserved numeric(18,2) NOT NULL DEFAULT 0.00,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT treasury_wallets_code_uq UNIQUE (merchant_id, code),
  CONSTRAINT treasury_wallets_role_chk CHECK (wallet_role IN ('BANK_SETTLEMENT','CRYPTO_SETTLEMENT','BLOCKED')),
  CONSTRAINT treasury_wallets_status_chk CHECK (status IN ('active','inactive','suspended')),
  CONSTRAINT treasury_wallets_currency_chk CHECK (currency ~ '^[A-Z0-9]{3,10}$'),
  CONSTRAINT treasury_wallets_nonnegative_chk CHECK (balance >= 0 AND available >= 0 AND reserved >= 0)
);

CREATE INDEX IF NOT EXISTS treasury_wallets_merchant_idx
  ON public.treasury_wallets(merchant_id);

CREATE INDEX IF NOT EXISTS treasury_wallets_role_currency_idx
  ON public.treasury_wallets(wallet_role, currency);

CREATE TABLE IF NOT EXISTS public.treasury_wallet_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  treasury_wallet_id uuid NOT NULL REFERENCES public.treasury_wallets(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  direction text NOT NULL,
  type text NOT NULL,
  amount numeric(18,2) NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed',
  source_wallet_id uuid REFERENCES public.wallets(id) ON DELETE SET NULL,
  source_amount numeric(18,2),
  source_currency text,
  fx_rate numeric(24,10),
  fx_cost numeric(18,2) NOT NULL DEFAULT 0.00,
  payout_statement_id uuid REFERENCES public.payout_statements(id) ON DELETE SET NULL,
  payout_request_id uuid REFERENCES public.payout_requests(id) ON DELETE SET NULL,
  reference text,
  idempotency_key text,
  notes text,
  confirmed_by text,
  confirmed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT treasury_wallet_movements_direction_chk CHECK (direction IN ('in','out')),
  CONSTRAINT treasury_wallet_movements_status_chk CHECK (status IN ('draft','confirmed','cancelled')),
  CONSTRAINT treasury_wallet_movements_amount_chk CHECK (amount > 0),
  CONSTRAINT treasury_wallet_movements_currency_chk CHECK (currency ~ '^[A-Z0-9]{3,10}$'),
  CONSTRAINT treasury_wallet_movements_source_amount_chk CHECK (source_amount IS NULL OR source_amount > 0),
  CONSTRAINT treasury_wallet_movements_fx_cost_chk CHECK (fx_cost >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS treasury_wallet_movements_idempotency_uq
  ON public.treasury_wallet_movements(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS treasury_wallet_movements_wallet_idx
  ON public.treasury_wallet_movements(treasury_wallet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS treasury_wallet_movements_merchant_idx
  ON public.treasury_wallet_movements(merchant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS treasury_wallet_movements_payout_statement_idx
  ON public.treasury_wallet_movements(payout_statement_id)
  WHERE payout_statement_id IS NOT NULL;

INSERT INTO public.treasury_wallets (
  merchant_id,
  code,
  label,
  currency,
  wallet_role,
  ecosystem,
  status,
  balance,
  available,
  reserved,
  metadata
)
SELECT
  m.id,
  'WALLET-BRL',
  'Wallet-BRL',
  'BRL',
  'BANK_SETTLEMENT',
  'PagarPIX.org',
  'active',
  0.00,
  0.00,
  0.00,
  jsonb_build_object(
    'physical', true,
    'manualSettlement', true,
    'autoFx', false,
    'source', 'treasury_physical_wallets_v1'
  )
FROM public.merchants m
WHERE m.status = 'active'
ON CONFLICT (merchant_id, code) DO NOTHING;
