BEGIN;

-- =========================================================
-- FUNÇÃO ATÓMICA PARA REGISTAR UM PAYOUT JÁ REALIZADO
-- =========================================================

CREATE OR REPLACE FUNCTION
public.xpayments_record_paid_payout(
  p_statement_code text,
  p_merchant_id uuid,
  p_wallet_id uuid,
  p_store_id uuid,
  p_currency text,
  p_amount numeric,
  p_paid_on date,
  p_external_reference text,
  p_description text,
  p_idempotency_key text,
  p_actor_reference text,
  p_historical_date_only boolean DEFAULT false,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_id uuid;
  v_statement_id uuid;
  v_wallet record;
BEGIN
  IF p_statement_code IS NULL
     OR btrim(p_statement_code) = '' THEN
    RAISE EXCEPTION
      'statement_code é obrigatório';
  END IF;

  IF p_idempotency_key IS NULL
     OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION
      'idempotency_key é obrigatório';
  END IF;

  IF p_amount IS NULL
     OR p_amount <= 0 THEN
    RAISE EXCEPTION
      'amount deve ser maior que zero';
  END IF;

  SELECT id
  INTO v_existing_id
  FROM public.payout_statements
  WHERE idempotency_key =
    p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

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

  WHERE id = p_wallet_id
    AND merchant_id = p_merchant_id
    AND upper(currency) =
      upper(p_currency)

  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Wallet não encontrada para merchant %, wallet % e currency %',
      p_merchant_id,
      p_wallet_id,
      p_currency;
  END IF;

  IF v_wallet.available < p_amount THEN
    RAISE EXCEPTION
      'Saldo disponível insuficiente. Available: %, payout: %',
      v_wallet.available,
      p_amount;
  END IF;

  IF p_store_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.stores
       WHERE id = p_store_id
         AND merchant_id =
           p_merchant_id
     ) THEN

    RAISE EXCEPTION
      'Store % não pertence ao Merchant %',
      p_store_id,
      p_merchant_id;
  END IF;

  INSERT INTO public.payout_statements (
    statement_code,
    merchant_id,
    wallet_id,
    currency,
    amount,
    status,
    scheduled_for,
    paid_on,
    paid_at,
    external_reference,
    description,
    idempotency_key,
    historical_date_only,
    created_by,
    paid_by,
    metadata
  )
  VALUES (
    p_statement_code,
    p_merchant_id,
    p_wallet_id,
    upper(p_currency),
    p_amount,
    'paid',
    p_paid_on,
    p_paid_on,

    CASE
      WHEN p_historical_date_only
        THEN NULL
      ELSE now()
    END,

    NULLIF(
      btrim(
        COALESCE(
          p_external_reference,
          ''
        )
      ),
      ''
    ),

    p_description,
    p_idempotency_key,
    p_historical_date_only,
    p_actor_reference,
    p_actor_reference,

    COALESCE(
      p_metadata,
      '{}'::jsonb
    ) || jsonb_build_object(
      'source',
      'finance_v4_phase2',
      'effectivePaidOn',
      p_paid_on,
      'importedAt',
      now()
    )
  )
  RETURNING id
  INTO v_statement_id;

  IF p_store_id IS NOT NULL THEN
    INSERT INTO public.payout_statement_allocations (
      payout_statement_id,
      store_id,
      amount,
      metadata
    )
    VALUES (
      v_statement_id,
      p_store_id,
      p_amount,
      jsonb_build_object(
        'allocationType',
        'full',
        'source',
        'historical_import'
      )
    );
  END IF;

  INSERT INTO public.payout_statement_events (
    payout_statement_id,
    event_type,
    actor_reference,
    payload
  )
  VALUES (
    v_statement_id,
    'marked_paid',
    p_actor_reference,
    jsonb_build_object(
      'amount',
      p_amount,
      'currency',
      upper(p_currency),
      'paidOn',
      p_paid_on,
      'historicalDateOnly',
      p_historical_date_only,
      'source',
      'historical_import'
    )
  );

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
    created_at,
    store_id,
    payout_statement_id,
    idempotency_key,
    updated_at
  )
  VALUES (
    p_wallet_id,
    p_merchant_id,
    upper(p_currency),
    'payout',
    'out',
    p_amount,
    'completed',
    p_statement_code,

    jsonb_build_object(
      'payoutStatementId',
      v_statement_id,
      'statementCode',
      p_statement_code,
      'effectivePaidOn',
      p_paid_on,
      'historicalDateOnly',
      p_historical_date_only,
      'externalReference',
      p_external_reference,
      'source',
      'historical_import'
    ),

    now(),
    p_store_id,
    v_statement_id,
    'wallet-movement:' ||
      p_idempotency_key,
    now()
  );

  UPDATE public.wallets
  SET
    balance =
      balance - p_amount,

    available =
      available - p_amount,

    updated_at =
      now()

  WHERE id = p_wallet_id
  RETURNING
    id,
    merchant_id,
    currency,
    balance,
    available,
    reserved,
    reconciliation_hold

  INTO v_wallet;

  IF v_wallet.available < 0 THEN
    RAISE EXCEPTION
      'Invariante violada: available negativo';
  END IF;

  IF v_wallet.balance <
     (
       v_wallet.available +
       v_wallet.reserved +
       v_wallet.reconciliation_hold
     ) THEN

    RAISE EXCEPTION
      'Invariante violada: balance inferior aos buckets conhecidos';
  END IF;

  RETURN v_statement_id;
END;
$$;

-- =========================================================
-- PRÉ-CONDIÇÕES DO IMPORT
-- =========================================================

DO $$
DECLARE
  v_wallet record;
  v_existing_payouts integer;
  v_orphan_count integer;
  v_orphan_total numeric(18,2);
BEGIN
  SELECT
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

  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Wallet BW não encontrada';
  END IF;

  SELECT COUNT(*)
  INTO v_existing_payouts
  FROM public.payout_statements
  WHERE idempotency_key IN (
    'historical-manual-payout:REVEURO1:2026-07-22:1087.00',
    'historical-manual-payout:REVEURO1:2026-07-23:1964.71',
    'historical-manual-payout:REVEURO2:2026-07-23:178.65'
  );

  IF v_existing_payouts NOT IN (0, 3) THEN
    RAISE EXCEPTION
      'Import histórico parcialmente existente: % payouts',
      v_existing_payouts;
  END IF;

  SELECT
    COUNT(*),
    COALESCE(
      SUM(amount),
      0
    )

  INTO
    v_orphan_count,
    v_orphan_total

  FROM public.wallet_movements

  WHERE id IN (
    'b1d2f680-b205-46b9-9863-24d148dacb35',
    '7c643c64-9ebb-4d69-8a4e-61af1236079f',
    'a99cfa08-4724-4192-9cef-db29f58fa2bb',
    '1704b505-1892-4305-a232-fb339541ede4',
    'e268b400-0f88-497f-8747-54251b655661',
    'd46b790b-2fc8-4084-ad1f-f1e9bbed48c3'
  );

  IF v_orphan_count <> 6 THEN
    RAISE EXCEPTION
      'Esperados 6 movimentos órfãos; encontrados %',
      v_orphan_count;
  END IF;

  IF ROUND(
       v_orphan_total::numeric,
       2
     ) <> 175.78 THEN

    RAISE EXCEPTION
      'Total órfão inesperado: %',
      v_orphan_total;
  END IF;

  IF v_existing_payouts = 0
     AND v_wallet.available < 3230.36 THEN

    RAISE EXCEPTION
      'Available insuficiente para payouts históricos: %',
      v_wallet.available;
  END IF;
END
$$;

-- =========================================================
-- IMPORTAR OS TRÊS PAYOUTS
-- =========================================================

SELECT
  public.xpayments_record_paid_payout(
    'PAY-20260722-REVEURO1-001',
    '5d2a2279-deed-4225-b49c-b0c60ebb8580',
    'ddba7396-c189-459d-bab4-6803e2ddffd8',
    'f1b08de4-a01c-4aca-9ba3-246cfceed95b',
    'EUR',
    1087.00,
    DATE '2026-07-22',
    NULL,
    'Payout manual histórico — RevEuro-1',
    'historical-manual-payout:REVEURO1:2026-07-22:1087.00',
    'finance-v4-phase2',
    true,
    jsonb_build_object(
      'storeCode',
      'REVEURO1'
    )
  ) AS payout_reveuro1_20260722;


SELECT
  public.xpayments_record_paid_payout(
    'PAY-20260723-REVEURO1-001',
    '5d2a2279-deed-4225-b49c-b0c60ebb8580',
    'ddba7396-c189-459d-bab4-6803e2ddffd8',
    'f1b08de4-a01c-4aca-9ba3-246cfceed95b',
    'EUR',
    1964.71,
    DATE '2026-07-23',
    NULL,
    'Payout manual histórico — RevEuro-1',
    'historical-manual-payout:REVEURO1:2026-07-23:1964.71',
    'finance-v4-phase2',
    true,
    jsonb_build_object(
      'storeCode',
      'REVEURO1'
    )
  ) AS payout_reveuro1_20260723;


SELECT
  public.xpayments_record_paid_payout(
    'PAY-20260723-REVEURO2-001',
    '5d2a2279-deed-4225-b49c-b0c60ebb8580',
    'ddba7396-c189-459d-bab4-6803e2ddffd8',
    '023ca747-f12d-458b-a89d-2405deb05d69',
    'EUR',
    178.65,
    DATE '2026-07-23',
    NULL,
    'Payout manual histórico — RevEuro-2',
    'historical-manual-payout:REVEURO2:2026-07-23:178.65',
    'finance-v4-phase2',
    true,
    jsonb_build_object(
      'storeCode',
      'REVEURO2'
    )
  ) AS payout_reveuro2_20260723;

-- =========================================================
-- COLOCAR OS SEIS MOVIMENTOS ÓRFÃOS EM RECONCILIAÇÃO
-- Idempotente: se já estiverem held, não volta a mover fundos.
-- =========================================================

DO $$
DECLARE
  v_expected_ids uuid[] := ARRAY[
    'b1d2f680-b205-46b9-9863-24d148dacb35'::uuid,
    '7c643c64-9ebb-4d69-8a4e-61af1236079f'::uuid,
    'a99cfa08-4724-4192-9cef-db29f58fa2bb'::uuid,
    '1704b505-1892-4305-a232-fb339541ede4'::uuid,
    'e268b400-0f88-497f-8747-54251b655661'::uuid,
    'd46b790b-2fc8-4084-ad1f-f1e9bbed48c3'::uuid
  ];

  v_total numeric(18,2);
  v_disponivel_count integer;
  v_held_count integer;
  v_wallet record;
BEGIN
  SELECT
    ROUND(
      COALESCE(
        SUM(amount),
        0
      )::numeric,
      2
    ),

    COUNT(*) FILTER (
      WHERE status = 'disponivel'
    ),

    COUNT(*) FILTER (
      WHERE status = 'reconciliation_hold'
    )

  INTO
    v_total,
    v_disponivel_count,
    v_held_count

  FROM public.wallet_movements

  WHERE id =
    ANY(v_expected_ids)

    AND merchant_id =
      '5d2a2279-deed-4225-b49c-b0c60ebb8580'

    AND wallet_id =
      'ddba7396-c189-459d-bab4-6803e2ddffd8'

    AND type =
      'payment'

    AND direction =
      'in'

    AND transaction_id IS NULL;

  IF v_total <> 175.78 THEN
    RAISE EXCEPTION
      'Total de movimentos órfãos divergente: %',
      v_total;
  END IF;

  IF v_held_count = 6
     AND v_disponivel_count = 0 THEN

    RAISE NOTICE
      'Movimentos órfãos já estão em reconciliation_hold';

  ELSIF v_disponivel_count = 6
        AND v_held_count = 0 THEN

    SELECT
      balance,
      available,
      reserved,
      reconciliation_hold

    INTO v_wallet

    FROM public.wallets

    WHERE id =
      'ddba7396-c189-459d-bab4-6803e2ddffd8'

    FOR UPDATE;

    IF v_wallet.available < v_total THEN
      RAISE EXCEPTION
        'Available insuficiente para reconciliation hold. Available: %, hold: %',
        v_wallet.available,
        v_total;
    END IF;

    UPDATE public.wallet_movements
    SET
      status =
        'reconciliation_hold',

      metadata =
        COALESCE(
          metadata,
          '{}'::jsonb
        ) || jsonb_build_object(
          'classification',
          'historical_orphan_movement',
          'reconciliationStatus',
          'held',
          'reason',
          'Movement reference has no matching transaction',
          'heldAt',
          now(),
          'actor',
          'finance-v4-phase2'
        ),

      updated_at =
        now()

    WHERE id =
      ANY(v_expected_ids);

    UPDATE public.wallets
    SET
      available =
        available - v_total,

      reconciliation_hold =
        reconciliation_hold + v_total,

      updated_at =
        now()

    WHERE id =
      'ddba7396-c189-459d-bab4-6803e2ddffd8';

  ELSE
    RAISE EXCEPTION
      'Estado misto nos órfãos. Disponíveis: %, held: %',
      v_disponivel_count,
      v_held_count;
  END IF;
END
$$;

-- =========================================================
-- VALIDAÇÕES ANTES DO COMMIT
-- =========================================================

DO $$
DECLARE
  v_payout_count integer;
  v_payout_total numeric(18,2);
  v_out_count integer;
  v_out_total numeric(18,2);
  v_hold_count integer;
  v_hold_total numeric(18,2);
  v_wallet record;
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
    v_payout_count,
    v_payout_total

  FROM public.payout_statements

  WHERE idempotency_key IN (
    'historical-manual-payout:REVEURO1:2026-07-22:1087.00',
    'historical-manual-payout:REVEURO1:2026-07-23:1964.71',
    'historical-manual-payout:REVEURO2:2026-07-23:178.65'
  )

    AND status = 'paid';

  IF v_payout_count <> 3
     OR v_payout_total <> 3230.36 THEN

    RAISE EXCEPTION
      'Payouts inválidos. Count: %, total: %',
      v_payout_count,
      v_payout_total;
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
    v_out_count,
    v_out_total

  FROM public.wallet_movements

  WHERE payout_statement_id IS NOT NULL
    AND type = 'payout'
    AND direction = 'out'
    AND status = 'completed';

  IF v_out_count < 3
     OR v_out_total < 3230.36 THEN

    RAISE EXCEPTION
      'Movimentos de payout inválidos. Count: %, total: %',
      v_out_count,
      v_out_total;
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
    v_hold_count,
    v_hold_total

  FROM public.wallet_movements

  WHERE id IN (
    'b1d2f680-b205-46b9-9863-24d148dacb35',
    '7c643c64-9ebb-4d69-8a4e-61af1236079f',
    'a99cfa08-4724-4192-9cef-db29f58fa2bb',
    '1704b505-1892-4305-a232-fb339541ede4',
    'e268b400-0f88-497f-8747-54251b655661',
    'd46b790b-2fc8-4084-ad1f-f1e9bbed48c3'
  )

    AND status =
      'reconciliation_hold';

  IF v_hold_count <> 6
     OR v_hold_total <> 175.78 THEN

    RAISE EXCEPTION
      'Hold inválido. Count: %, total: %',
      v_hold_count,
      v_hold_total;
  END IF;

  SELECT
    balance,
    available,
    reserved,
    reconciliation_hold

  INTO v_wallet

  FROM public.wallets

  WHERE id =
    'ddba7396-c189-459d-bab4-6803e2ddffd8';

  IF v_wallet.available < 0
     OR v_wallet.balance <
       (
         v_wallet.available +
         v_wallet.reserved +
         v_wallet.reconciliation_hold
       ) THEN

    RAISE EXCEPTION
      'Invariante Wallet inválida. Balance %, available %, reserved %, hold %',
      v_wallet.balance,
      v_wallet.available,
      v_wallet.reserved,
      v_wallet.reconciliation_hold;
  END IF;
END
$$;

COMMIT;
