BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.xpayments_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =========================================================
-- CENTROS DE CUSTO
-- =========================================================
CREATE TABLE IF NOT EXISTS public.finance_cost_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  store_id uuid,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_cost_centers_status_valid
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT finance_cost_centers_unique_code
    UNIQUE (merchant_id, code)
);

CREATE INDEX IF NOT EXISTS finance_cost_centers_merchant_status_idx
  ON public.finance_cost_centers (merchant_id, status, name);

-- =========================================================
-- CUSTOS E COMPROMISSOS
-- =========================================================
CREATE TABLE IF NOT EXISTS public.finance_cost_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  store_id uuid,
  cost_center_id uuid NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  amount numeric(18,2) NOT NULL,
  currency text NOT NULL,
  competence_date date NOT NULL,
  due_date date,
  paid_on date,
  status text NOT NULL DEFAULT 'draft',
  source text NOT NULL DEFAULT 'manual',
  supplier_name text,
  external_reference text,
  idempotency_key text,
  reporting_currency text,
  reporting_rate numeric(24,10),
  reporting_amount numeric(18,2),
  created_by text,
  approved_by text,
  approved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_cost_entries_amount_positive
    CHECK (amount > 0),
  CONSTRAINT finance_cost_entries_status_valid
    CHECK (status IN (
      'draft',
      'submitted',
      'approved',
      'reserved',
      'paid',
      'cancelled'
    )),
  CONSTRAINT finance_cost_entries_source_valid
    CHECK (source IN ('manual', 'import', 'api', 'integration', 'system')),
  CONSTRAINT finance_cost_entries_reporting_valid
    CHECK (
      (reporting_currency IS NULL AND reporting_rate IS NULL AND reporting_amount IS NULL)
      OR
      (reporting_currency IS NOT NULL AND reporting_rate IS NOT NULL AND reporting_amount IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_cost_entries_idempotency_unique_idx
  ON public.finance_cost_entries (merchant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS finance_cost_entries_merchant_date_idx
  ON public.finance_cost_entries (merchant_id, competence_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS finance_cost_entries_center_status_idx
  ON public.finance_cost_entries (cost_center_id, status, competence_date DESC);

-- =========================================================
-- PLANOS DE DISTRIBUIÇÃO
-- =========================================================
CREATE TABLE IF NOT EXISTS public.finance_distribution_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code text NOT NULL UNIQUE,
  merchant_id uuid NOT NULL,
  currency text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  source_total numeric(18,2) NOT NULL DEFAULT 0.00,
  cost_total numeric(18,2) NOT NULL DEFAULT 0.00,
  reserve_total numeric(18,2) NOT NULL DEFAULT 0.00,
  distributable_total numeric(18,2) NOT NULL DEFAULT 0.00,
  allocated_total numeric(18,2) NOT NULL DEFAULT 0.00,
  status text NOT NULL DEFAULT 'draft',
  residual_policy text NOT NULL DEFAULT 'last_allocation',
  reporting_currency text,
  reporting_rate numeric(24,10),
  reporting_source text,
  reporting_rate_date date,
  created_by text,
  approved_by text,
  approved_at timestamptz,
  reconciled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_distribution_plans_period_valid
    CHECK (period_end >= period_start),
  CONSTRAINT finance_distribution_plans_amounts_valid
    CHECK (
      source_total >= 0
      AND cost_total >= 0
      AND reserve_total >= 0
      AND distributable_total >= 0
      AND allocated_total >= 0
    ),
  CONSTRAINT finance_distribution_plans_status_valid
    CHECK (status IN (
      'draft',
      'calculated',
      'approved',
      'partially_paid',
      'paid',
      'reconciled',
      'cancelled'
    )),
  CONSTRAINT finance_distribution_plans_residual_valid
    CHECK (residual_policy IN ('last_allocation', 'largest_allocation', 'manual'))
);

CREATE INDEX IF NOT EXISTS finance_distribution_plans_merchant_period_idx
  ON public.finance_distribution_plans (merchant_id, period_end DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.finance_distribution_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_plan_id uuid NOT NULL,
  payout_statement_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL,
  source_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_distribution_sources_amount_positive
    CHECK (amount > 0),
  CONSTRAINT finance_distribution_sources_unique_payout
    UNIQUE (distribution_plan_id, payout_statement_id)
);

CREATE INDEX IF NOT EXISTS finance_distribution_sources_payout_idx
  ON public.finance_distribution_sources (payout_statement_id);

CREATE TABLE IF NOT EXISTS public.finance_distribution_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_plan_id uuid NOT NULL,
  cost_entry_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_distribution_costs_amount_positive
    CHECK (amount > 0),
  CONSTRAINT finance_distribution_costs_unique_entry
    UNIQUE (distribution_plan_id, cost_entry_id)
);

CREATE TABLE IF NOT EXISTS public.finance_distribution_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_plan_id uuid NOT NULL,
  beneficiary_code text NOT NULL,
  beneficiary_name text NOT NULL,
  allocation_type text NOT NULL DEFAULT 'percentage',
  percentage numeric(9,6),
  amount numeric(18,2) NOT NULL,
  is_residual boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'planned',
  external_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_distribution_allocations_amount_nonnegative
    CHECK (amount >= 0),
  CONSTRAINT finance_distribution_allocations_type_valid
    CHECK (allocation_type IN ('percentage', 'fixed', 'residual')),
  CONSTRAINT finance_distribution_allocations_percentage_valid
    CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),
  CONSTRAINT finance_distribution_allocations_status_valid
    CHECK (status IN ('planned', 'approved', 'reserved', 'paid', 'cancelled')),
  CONSTRAINT finance_distribution_allocations_unique_beneficiary
    UNIQUE (distribution_plan_id, beneficiary_code)
);

CREATE INDEX IF NOT EXISTS finance_distribution_allocations_plan_idx
  ON public.finance_distribution_allocations (distribution_plan_id, created_at);

-- =========================================================
-- TAXAS DE CÂMBIO PARA REPORTING
-- =========================================================
CREATE TABLE IF NOT EXISTS public.finance_fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency text NOT NULL,
  quote_currency text NOT NULL,
  rate numeric(24,10) NOT NULL,
  rate_date date NOT NULL,
  source text NOT NULL,
  rate_type text NOT NULL DEFAULT 'indicative',
  source_timestamp timestamptz,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_fx_rates_rate_positive
    CHECK (rate > 0),
  CONSTRAINT finance_fx_rates_currency_pair_valid
    CHECK (base_currency <> quote_currency),
  CONSTRAINT finance_fx_rates_type_valid
    CHECK (rate_type IN ('indicative', 'historical_snapshot', 'provider_settlement')),
  CONSTRAINT finance_fx_rates_unique_snapshot
    UNIQUE (base_currency, quote_currency, rate_date, source, rate_type)
);

CREATE INDEX IF NOT EXISTS finance_fx_rates_pair_date_idx
  ON public.finance_fx_rates (base_currency, quote_currency, rate_date DESC, created_at DESC);

-- =========================================================
-- AUDITORIA
-- =========================================================
CREATE TABLE IF NOT EXISTS public.finance_operation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_reference text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_operation_events_entity_idx
  ON public.finance_operation_events (merchant_id, entity_type, entity_id, created_at DESC);

-- =========================================================
-- FOREIGN KEYS (IDEMPOTENTES)
-- =========================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_cost_centers_merchant_fkey') THEN
    ALTER TABLE public.finance_cost_centers
      ADD CONSTRAINT finance_cost_centers_merchant_fkey
      FOREIGN KEY (merchant_id) REFERENCES public.merchants(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_cost_centers_store_fkey') THEN
    ALTER TABLE public.finance_cost_centers
      ADD CONSTRAINT finance_cost_centers_store_fkey
      FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_cost_centers_parent_fkey') THEN
    ALTER TABLE public.finance_cost_centers
      ADD CONSTRAINT finance_cost_centers_parent_fkey
      FOREIGN KEY (parent_id) REFERENCES public.finance_cost_centers(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_cost_entries_merchant_fkey') THEN
    ALTER TABLE public.finance_cost_entries
      ADD CONSTRAINT finance_cost_entries_merchant_fkey
      FOREIGN KEY (merchant_id) REFERENCES public.merchants(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_cost_entries_store_fkey') THEN
    ALTER TABLE public.finance_cost_entries
      ADD CONSTRAINT finance_cost_entries_store_fkey
      FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_cost_entries_center_fkey') THEN
    ALTER TABLE public.finance_cost_entries
      ADD CONSTRAINT finance_cost_entries_center_fkey
      FOREIGN KEY (cost_center_id) REFERENCES public.finance_cost_centers(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_distribution_plans_merchant_fkey') THEN
    ALTER TABLE public.finance_distribution_plans
      ADD CONSTRAINT finance_distribution_plans_merchant_fkey
      FOREIGN KEY (merchant_id) REFERENCES public.merchants(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_distribution_sources_plan_fkey') THEN
    ALTER TABLE public.finance_distribution_sources
      ADD CONSTRAINT finance_distribution_sources_plan_fkey
      FOREIGN KEY (distribution_plan_id) REFERENCES public.finance_distribution_plans(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_distribution_sources_payout_fkey') THEN
    ALTER TABLE public.finance_distribution_sources
      ADD CONSTRAINT finance_distribution_sources_payout_fkey
      FOREIGN KEY (payout_statement_id) REFERENCES public.payout_statements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_distribution_costs_plan_fkey') THEN
    ALTER TABLE public.finance_distribution_costs
      ADD CONSTRAINT finance_distribution_costs_plan_fkey
      FOREIGN KEY (distribution_plan_id) REFERENCES public.finance_distribution_plans(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_distribution_costs_entry_fkey') THEN
    ALTER TABLE public.finance_distribution_costs
      ADD CONSTRAINT finance_distribution_costs_entry_fkey
      FOREIGN KEY (cost_entry_id) REFERENCES public.finance_cost_entries(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_distribution_allocations_plan_fkey') THEN
    ALTER TABLE public.finance_distribution_allocations
      ADD CONSTRAINT finance_distribution_allocations_plan_fkey
      FOREIGN KEY (distribution_plan_id) REFERENCES public.finance_distribution_plans(id) ON DELETE CASCADE;
  END IF;
END
$$;

-- =========================================================
-- UPDATED_AT TRIGGERS
-- =========================================================
DROP TRIGGER IF EXISTS finance_cost_centers_set_updated_at ON public.finance_cost_centers;
CREATE TRIGGER finance_cost_centers_set_updated_at
BEFORE UPDATE ON public.finance_cost_centers
FOR EACH ROW EXECUTE FUNCTION public.xpayments_set_updated_at();

DROP TRIGGER IF EXISTS finance_cost_entries_set_updated_at ON public.finance_cost_entries;
CREATE TRIGGER finance_cost_entries_set_updated_at
BEFORE UPDATE ON public.finance_cost_entries
FOR EACH ROW EXECUTE FUNCTION public.xpayments_set_updated_at();

DROP TRIGGER IF EXISTS finance_distribution_plans_set_updated_at ON public.finance_distribution_plans;
CREATE TRIGGER finance_distribution_plans_set_updated_at
BEFORE UPDATE ON public.finance_distribution_plans
FOR EACH ROW EXECUTE FUNCTION public.xpayments_set_updated_at();

DROP TRIGGER IF EXISTS finance_distribution_allocations_set_updated_at ON public.finance_distribution_allocations;
CREATE TRIGGER finance_distribution_allocations_set_updated_at
BEFORE UPDATE ON public.finance_distribution_allocations
FOR EACH ROW EXECUTE FUNCTION public.xpayments_set_updated_at();

COMMIT;
