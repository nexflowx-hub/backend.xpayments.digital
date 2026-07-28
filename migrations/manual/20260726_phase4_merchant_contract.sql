BEGIN;

-- =========================================================
-- COLUNAS PARA PREVISÃO DE LIBERAÇÃO
-- =========================================================

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    system_estimated_release_on date;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    manual_estimated_release_on date;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    provider_available_on date;

ALTER TABLE public.wallet_movements
  ADD COLUMN IF NOT EXISTS
    release_date_source text;

-- =========================================================
-- FUNÇÃO D+N DIAS ÚTEIS
--
-- O dia da transação é D0.
-- Sábado e domingo não contam.
--
-- Exemplo:
-- quarta-feira + 3 dias úteis = segunda-feira
-- =========================================================

CREATE OR REPLACE FUNCTION
public.xpayments_add_business_days(
  p_start_date date,
  p_business_days integer
)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  v_result date :=
    p_start_date;

  v_added integer :=
    0;
BEGIN
  IF p_business_days < 0 THEN
    RAISE EXCEPTION
      'Business days não pode ser negativo';
  END IF;

  WHILE v_added < p_business_days LOOP
    v_result :=
      v_result + 1;

    IF EXTRACT(
         ISODOW
         FROM v_result
       ) BETWEEN 1 AND 5 THEN

      v_added :=
        v_added + 1;
    END IF;
  END LOOP;

  RETURN v_result;
END;
$$;

-- =========================================================
-- PREPARAÇÃO AUTOMÁTICA DE NOVOS MOVIMENTOS
--
-- Esta trigger garante que novos movimentos criados pelo
-- webhook atual recebam:
--
-- transaction_id
-- store_id
-- system_estimated_release_on
-- expected_release_at
-- release_date_source
--
-- Assim não precisamos alterar ainda o motor Stripe.
-- =========================================================

CREATE OR REPLACE FUNCTION
public.xpayments_prepare_wallet_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction_id uuid;
  v_store_id uuid;
  v_effective_date date;
BEGIN
  IF NEW.type = 'payment'
     AND NEW.direction = 'in' THEN

    IF NEW.transaction_id IS NULL
       AND NEW.reference IS NOT NULL

       AND NEW.reference ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN

      SELECT
        transaction_record.id,
        transaction_record.store_id

      INTO
        v_transaction_id,
        v_store_id

      FROM public.transactions
        AS transaction_record

      WHERE transaction_record.id =
        NEW.reference::uuid;

      IF v_transaction_id IS NOT NULL THEN
        NEW.transaction_id :=
          v_transaction_id;

        NEW.store_id :=
          COALESCE(
            NEW.store_id,
            v_store_id
          );
      END IF;
    END IF;

    IF NEW.system_estimated_release_on
       IS NULL THEN

      NEW.system_estimated_release_on :=
        public.xpayments_add_business_days(
          (
            COALESCE(
              NEW.created_at,
              now()
            )
            AT TIME ZONE 'Europe/Lisbon'
          )::date,
          3
        );
    END IF;

    IF NEW.manual_estimated_release_on
       IS NOT NULL THEN

      v_effective_date :=
        NEW.manual_estimated_release_on;

      NEW.release_date_source :=
        'manual';

    ELSIF NEW.provider_available_on
          IS NOT NULL THEN

      v_effective_date :=
        NEW.provider_available_on;

      NEW.release_date_source :=
        'provider';

    ELSE
      v_effective_date :=
        NEW.system_estimated_release_on;

      NEW.release_date_source :=
        'business_day_fallback';
    END IF;

    IF v_effective_date IS NOT NULL THEN
      NEW.expected_release_at :=
        (
          v_effective_date::timestamp
          AT TIME ZONE 'Europe/Lisbon'
        );
    END IF;
  END IF;

  NEW.updated_at :=
    now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  wallet_movements_prepare_finance
ON public.wallet_movements;

CREATE TRIGGER
  wallet_movements_prepare_finance
BEFORE INSERT OR UPDATE OF
  reference,
  transaction_id,
  store_id,
  created_at,
  manual_estimated_release_on,
  provider_available_on,
  system_estimated_release_on
ON public.wallet_movements
FOR EACH ROW
EXECUTE FUNCTION
  public.xpayments_prepare_wallet_movement();

-- =========================================================
-- RECALCULAR TODOS OS MOVIMENTOS PENDENTES
-- D+3 DIAS ÚTEIS
-- =========================================================

UPDATE public.wallet_movements
SET
  system_estimated_release_on =
    public.xpayments_add_business_days(
      (
        created_at
        AT TIME ZONE 'Europe/Lisbon'
      )::date,
      3
    ),

  expected_release_at =
    (
      COALESCE(
        manual_estimated_release_on,

        provider_available_on,

        public.xpayments_add_business_days(
          (
            created_at
            AT TIME ZONE 'Europe/Lisbon'
          )::date,
          3
        )
      )::timestamp

      AT TIME ZONE 'Europe/Lisbon'
    ),

  release_date_source =
    CASE
      WHEN manual_estimated_release_on
        IS NOT NULL
        THEN 'manual'

      WHEN provider_available_on
        IS NOT NULL
        THEN 'provider'

      ELSE 'business_day_fallback'
    END,

  updated_at =
    now()

WHERE type = 'payment'
  AND direction = 'in'
  AND status = 'pendente'
  AND transaction_id IS NOT NULL;

-- =========================================================
-- HOLD INTERNO DOS €18,12
--
-- Suporta três estados:
--
-- 1. Hold ainda não aplicado:
--    move 18.12 de available para reconciliation_hold.
--
-- 2. Hold legado já aplicado:
--    substitui analiticamente o movimento global por dois
--    movimentos alocados às Stores, sem alterar a Wallet.
--
-- 3. Dois movimentos por Store já existem:
--    não executa novamente.
-- =========================================================

DO $$
DECLARE
  v_wallet record;

  v_legacy_count integer;
  v_legacy_total numeric(18,2);

  v_split_count integer;
  v_split_total numeric(18,2);

  v_create_split_movements boolean :=
    false;

  v_move_wallet boolean :=
    false;

  v_adjustment numeric(18,2) :=
    18.12;
BEGIN
  SELECT
    COUNT(*),

    ROUND(
      COALESCE(
        SUM(amount),
        0
      )::numeric,
      2
    )

  INTO
    v_legacy_count,
    v_legacy_total

  FROM public.wallet_movements

  WHERE idempotency_key =
    'fee-reconciliation-hold:BW:2026-07-26:18.12';


  SELECT
    COUNT(*),

    ROUND(
      COALESCE(
        SUM(amount),
        0
      )::numeric,
      2
    )

  INTO
    v_split_count,
    v_split_total

  FROM public.wallet_movements

  WHERE idempotency_key IN (
    'fee-reconciliation-hold:REVEURO1:2026-07-26:17.55',
    'fee-reconciliation-hold:REVEURO2:2026-07-26:0.57'
  );


  SELECT
    id,
    merchant_id,
    currency,
    balance,
    available,
    reserved,
    reconciliation_hold

  INTO v_wallet

  FROM public.wallets

  WHERE id =
    'ddba7396-c189-459d-bab4-6803e2ddffd8'

    AND merchant_id =
      '5d2a2279-deed-4225-b49c-b0c60ebb8580'

    AND upper(currency) =
      'EUR'

  FOR UPDATE;


  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Wallet BW EUR não encontrada';
  END IF;


  -- =======================================================
  -- ESTADO A:
  -- Movimentos divididos já existem.
  -- =======================================================

  IF v_split_count = 2 THEN
    IF v_split_total <> 18.12 THEN
      RAISE EXCEPTION
        'Fee holds divididos totalizam %, esperado 18.12',
        v_split_total;
    END IF;

    IF ROUND(
         v_wallet.available::numeric,
         2
       ) <> 0.00 THEN

      RAISE EXCEPTION
        'Fee holds existem, mas available é %',
        v_wallet.available;
    END IF;

    IF ROUND(
         v_wallet.reconciliation_hold::numeric,
         2
       ) <> 193.90 THEN

      RAISE EXCEPTION
        'Fee holds existem, mas reconciliation_hold é %',
        v_wallet.reconciliation_hold;
    END IF;

    RAISE NOTICE
      'Fee reconciliation hold por Store já aplicado';


  -- =======================================================
  -- ESTADO B:
  -- Hold global legado já aplicado.
  -- Apenas o dividimos por Store.
  -- =======================================================

  ELSIF v_split_count = 0
        AND v_legacy_count = 1 THEN

    IF v_legacy_total <> 18.12 THEN
      RAISE EXCEPTION
        'Fee hold legado totaliza %, esperado 18.12',
        v_legacy_total;
    END IF;

    IF ROUND(
         v_wallet.available::numeric,
         2
       ) <> 0.00 THEN

      RAISE EXCEPTION
        'Hold legado existe, mas available é %',
        v_wallet.available;
    END IF;

    IF ROUND(
         v_wallet.reconciliation_hold::numeric,
         2
       ) <> 193.90 THEN

      RAISE EXCEPTION
        'Hold legado existe, mas reconciliation_hold é %',
        v_wallet.reconciliation_hold;
    END IF;

    UPDATE public.wallet_movements
    SET
      status =
        'superseded',

      metadata =
        COALESCE(
          metadata,
          '{}'::jsonb
        ) || jsonb_build_object(
          'supersededAt',
          now(),

          'supersededBy',
          jsonb_build_array(
            'fee-reconciliation-hold:REVEURO1:2026-07-26:17.55',
            'fee-reconciliation-hold:REVEURO2:2026-07-26:0.57'
          ),

          'reason',
          'Global fee reconciliation hold split analytically by Store'
        ),

      updated_at =
        now()

    WHERE idempotency_key =
      'fee-reconciliation-hold:BW:2026-07-26:18.12';

    v_create_split_movements :=
      true;

    RAISE NOTICE
      'Hold legado será dividido por Store sem alterar a Wallet';


  -- =======================================================
  -- ESTADO C:
  -- Hold ainda não foi aplicado.
  -- =======================================================

  ELSIF v_split_count = 0
        AND v_legacy_count = 0 THEN

    IF ROUND(
         v_wallet.available::numeric,
         2
       ) <> 18.12 THEN

      RAISE EXCEPTION
        'Available esperado 18.12; encontrado %',
        v_wallet.available;
    END IF;

    IF ROUND(
         v_wallet.reconciliation_hold::numeric,
         2
       ) <> 175.78 THEN

      RAISE EXCEPTION
        'Hold base esperado 175.78; encontrado %',
        v_wallet.reconciliation_hold;
    END IF;

    v_create_split_movements :=
      true;

    v_move_wallet :=
      true;


  -- =======================================================
  -- ESTADO INCONSISTENTE
  -- =======================================================

  ELSE
    RAISE EXCEPTION
      'Estado inconsistente. Legacy count %, split count %',
      v_legacy_count,
      v_split_count;
  END IF;


  -- =======================================================
  -- CRIAR OS DOIS MOVIMENTOS ANALÍTICOS
  -- =======================================================

  IF v_create_split_movements THEN
    INSERT INTO public.wallet_movements (
      wallet_id,
      merchant_id,
      currency,
      type,
      direction,
      amount,
      status,
      reference,
      metadata,
      store_id,
      idempotency_key,
      created_at,
      updated_at
    )
    VALUES
    (
      v_wallet.id,
      v_wallet.merchant_id,
      v_wallet.currency,
      'fee_reconciliation',
      'hold',
      17.55,
      'active',
      'FEE-RECONCILIATION-REVEURO1-20260726',

      jsonb_build_object(
        'classification',
        'historical_fee_reconciliation_hold',

        'reason',
        'Residual available held pending Stripe provider fee reconciliation',

        'storeCode',
        'REVEURO1',

        'platformFeePolicy',
        '2_percent',

        'providerFeePolicy',
        'stripe_balance_transaction_actual',

        'amount',
        17.55,

        'createdBy',
        'finance-v4-phase4',

        'createdAt',
        now()
      ),

      'f1b08de4-a01c-4aca-9ba3-246cfceed95b',

      'fee-reconciliation-hold:REVEURO1:2026-07-26:17.55',

      now(),
      now()
    ),
    (
      v_wallet.id,
      v_wallet.merchant_id,
      v_wallet.currency,
      'fee_reconciliation',
      'hold',
      0.57,
      'active',
      'FEE-RECONCILIATION-REVEURO2-20260726',

      jsonb_build_object(
        'classification',
        'historical_fee_reconciliation_hold',

        'reason',
        'Residual available held pending Stripe provider fee reconciliation',

        'storeCode',
        'REVEURO2',

        'platformFeePolicy',
        '2_percent',

        'providerFeePolicy',
        'stripe_balance_transaction_actual',

        'amount',
        0.57,

        'createdBy',
        'finance-v4-phase4',

        'createdAt',
        now()
      ),

      '023ca747-f12d-458b-a89d-2405deb05d69',

      'fee-reconciliation-hold:REVEURO2:2026-07-26:0.57',

      now(),
      now()
    );
  END IF;


  -- =======================================================
  -- ALTERAR A WALLET APENAS SE O HOLD AINDA NÃO EXISTIA
  -- =======================================================

  IF v_move_wallet THEN
    UPDATE public.wallets
    SET
      available =
        available - v_adjustment,

      reconciliation_hold =
        reconciliation_hold + v_adjustment,

      updated_at =
        now()

    WHERE id =
      v_wallet.id;
  END IF;
END
$$;

-- =========================================================
-- VALIDAÇÕES
-- =========================================================

DO $$
DECLARE
  v_wallet record;
  v_fee_hold_count integer;
  v_fee_hold_total numeric(18,2);
BEGIN
  SELECT
    balance,
    available,
    reserved,
    reconciliation_hold

  INTO v_wallet

  FROM public.wallets

  WHERE id =
    'ddba7396-c189-459d-bab4-6803e2ddffd8';

  IF ROUND(
       v_wallet.available::numeric,
       2
     ) <> 0.00 THEN

    RAISE EXCEPTION
      'Available deveria ser 0.00; encontrado %',
      v_wallet.available;
  END IF;

  IF ROUND(
       v_wallet.reconciliation_hold::numeric,
       2
     ) <> 193.90 THEN

    RAISE EXCEPTION
      'Reconciliation hold deveria ser 193.90; encontrado %',
      v_wallet.reconciliation_hold;
  END IF;

  SELECT
    COUNT(*),

    ROUND(
      COALESCE(
        SUM(amount),
        0
      )::numeric,
      2
    )

  INTO
    v_fee_hold_count,
    v_fee_hold_total

  FROM public.wallet_movements

  WHERE idempotency_key IN (
    'fee-reconciliation-hold:REVEURO1:2026-07-26:17.55',
    'fee-reconciliation-hold:REVEURO2:2026-07-26:0.57'
  )

    AND type =
      'fee_reconciliation'

    AND direction =
      'hold'

    AND status =
      'active';

  IF v_fee_hold_count <> 2
     OR v_fee_hold_total <> 18.12 THEN

    RAISE EXCEPTION
      'Fee hold inválido. Count %, total %',
      v_fee_hold_count,
      v_fee_hold_total;
  END IF;
END
$$;

COMMIT;
