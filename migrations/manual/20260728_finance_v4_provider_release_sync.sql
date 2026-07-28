BEGIN;

-- =========================================================
-- FINANCE V4.1 — STRIPE BALANCE TRANSACTION SNAPSHOT
--
-- Estes campos alimentam apenas previsões e reconciliação.
-- A migration NÃO altera status de movimentos, wallets,
-- liberações ou payout statements.
-- =========================================================

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    provider_balance_transaction_id text;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    provider_balance_status text;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    provider_gross numeric(18,2);

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    provider_fee numeric(18,2);

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    provider_net numeric(18,2);

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    platform_fee numeric(18,2);

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    merchant_net numeric(18,2);

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    provider_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS
  wallet_movements_provider_balance_tx_idx
ON public.wallet_movements (
  provider_balance_transaction_id
)
WHERE provider_balance_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  wallet_movements_provider_release_lookup_idx
ON public.wallet_movements (
  merchant_id,
  provider_available_on,
  provider_balance_status,
  store_id
)
WHERE
  type = 'payment'
  AND direction = 'in'
  AND status = 'pendente';

COMMENT ON COLUMN public.wallet_movements.provider_balance_transaction_id IS
  'Stripe Balance Transaction usada no snapshot financeiro da previsão.';

COMMENT ON COLUMN public.wallet_movements.provider_balance_status IS
  'Estado informativo do saldo no provider: pending, available ou desconhecido.';

COMMENT ON COLUMN public.wallet_movements.provider_gross IS
  'Valor bruto da venda associado ao snapshot do provider.';

COMMENT ON COLUMN public.wallet_movements.provider_fee IS
  'Taxa real do provider obtida da Stripe Balance Transaction.';

COMMENT ON COLUMN public.wallet_movements.provider_net IS
  'Líquido Stripe: bruto menos taxa Stripe.';

COMMENT ON COLUMN public.wallet_movements.platform_fee IS
  'Taxa XPayments já registada na transação no momento da sincronização.';

COMMENT ON COLUMN public.wallet_movements.merchant_net IS
  'Previsão líquida do merchant: venda - taxa Stripe - taxa XPayments.';

COMMENT ON COLUMN public.wallet_movements.provider_synced_at IS
  'Última sincronização informativa com a Balance Transaction.';

COMMIT;
