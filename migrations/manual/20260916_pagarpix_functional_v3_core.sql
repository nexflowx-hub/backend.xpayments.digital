BEGIN;

CREATE TABLE IF NOT EXISTS public.wallet_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_code text NOT NULL UNIQUE,
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores(id) ON DELETE SET NULL,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  currency text NOT NULL,
  amount numeric(18,2) NOT NULL,
  source_treasury_wallet_id uuid REFERENCES public.treasury_wallets(id) ON DELETE RESTRICT,
  destination_treasury_wallet_id uuid REFERENCES public.treasury_wallets(id) ON DELETE RESTRICT,
  payout_request_id uuid REFERENCES public.payout_requests(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  external_reference text,
  failure_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_operations_type_chk CHECK (type IN ('deposit','transfer','withdrawal')),
  CONSTRAINT wallet_operations_status_chk CHECK (status IN ('pending','processing','completed','failed','reversed','cancelled')),
  CONSTRAINT wallet_operations_amount_chk CHECK (amount > 0),
  CONSTRAINT wallet_operations_currency_chk CHECK (currency ~ '^[A-Z0-9]{3,10}$'),
  CONSTRAINT wallet_operations_wallet_shape_chk CHECK (
    (type = 'deposit' AND destination_treasury_wallet_id IS NOT NULL) OR
    (type = 'withdrawal' AND source_treasury_wallet_id IS NOT NULL) OR
    (type = 'transfer' AND source_treasury_wallet_id IS NOT NULL AND destination_treasury_wallet_id IS NOT NULL AND source_treasury_wallet_id <> destination_treasury_wallet_id)
  ),
  CONSTRAINT wallet_operations_idempotency_uq UNIQUE (merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS wallet_operations_merchant_created_idx
  ON public.wallet_operations(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_operations_merchant_status_idx
  ON public.wallet_operations(merchant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_operations_store_idx
  ON public.wallet_operations(store_id, created_at DESC)
  WHERE store_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.wallet_operation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.wallet_operations(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_operation_events_actor_type_chk CHECK (actor_type IN ('merchant','admin','system','provider'))
);

CREATE INDEX IF NOT EXISTS wallet_operation_events_operation_idx
  ON public.wallet_operation_events(operation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS wallet_operation_events_merchant_idx
  ON public.wallet_operation_events(merchant_id, created_at DESC);

ALTER TABLE public.treasury_wallet_movements
  ADD COLUMN IF NOT EXISTS wallet_operation_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'treasury_wallet_movements_wallet_operation_fk'
  ) THEN
    ALTER TABLE public.treasury_wallet_movements
      ADD CONSTRAINT treasury_wallet_movements_wallet_operation_fk
      FOREIGN KEY (wallet_operation_id)
      REFERENCES public.wallet_operations(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS treasury_wallet_movements_wallet_operation_idx
  ON public.treasury_wallet_movements(wallet_operation_id)
  WHERE wallet_operation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.routing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  method text NOT NULL,
  currency text NOT NULL,
  strategy text NOT NULL DEFAULT 'priority_failover',
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routing_policies_strategy_chk CHECK (strategy IN ('priority_failover','weighted','manual')),
  CONSTRAINT routing_policies_status_chk CHECK (status IN ('active','inactive')),
  CONSTRAINT routing_policies_currency_chk CHECK (currency ~ '^[A-Z0-9]{3,10}$'),
  CONSTRAINT routing_policies_version_chk CHECK (version > 0),
  CONSTRAINT routing_policies_scope_uq UNIQUE (merchant_id, store_id, method, currency)
);

CREATE INDEX IF NOT EXISTS routing_policies_store_idx
  ON public.routing_policies(store_id, status, method, currency);

CREATE TABLE IF NOT EXISTS public.provider_health_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_connection_id uuid NOT NULL REFERENCES public.provider_connections(id) ON DELETE CASCADE,
  health_status text NOT NULL,
  latency_ms integer,
  success_rate numeric(5,2),
  source text NOT NULL DEFAULT 'observer',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_health_status_chk CHECK (health_status IN ('healthy','degraded','unavailable','unknown')),
  CONSTRAINT provider_health_latency_chk CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT provider_health_success_rate_chk CHECK (success_rate IS NULL OR (success_rate >= 0 AND success_rate <= 100))
);

CREATE INDEX IF NOT EXISTS provider_health_connection_observed_idx
  ON public.provider_health_snapshots(provider_connection_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS public.routing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  method text NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  environment text NOT NULL,
  strategy text,
  selected_connection_id uuid REFERENCES public.provider_connections(id) ON DELETE SET NULL,
  selected_gateway_vault_id uuid REFERENCES public.gateway_vaults(id) ON DELETE SET NULL,
  eligible_connections jsonb NOT NULL DEFAULT '[]'::jsonb,
  health_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routing_decisions_amount_chk CHECK (amount_minor > 0),
  CONSTRAINT routing_decisions_environment_chk CHECK (environment IN ('test','live')),
  CONSTRAINT routing_decisions_currency_chk CHECK (currency ~ '^[A-Z0-9]{3,10}$'),
  CONSTRAINT routing_decisions_idempotency_uq UNIQUE (merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS routing_decisions_store_created_idx
  ON public.routing_decisions(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS routing_decisions_transaction_idx
  ON public.routing_decisions(transaction_id)
  WHERE transaction_id IS NOT NULL;

ALTER TABLE public.wallet_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_decisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.wallet_operations FROM anon, authenticated;
REVOKE ALL ON public.wallet_operation_events FROM anon, authenticated;
REVOKE ALL ON public.routing_policies FROM anon, authenticated;
REVOKE ALL ON public.provider_health_snapshots FROM anon, authenticated;
REVOKE ALL ON public.routing_decisions FROM anon, authenticated;

COMMIT;
