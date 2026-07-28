BEGIN;

DO $$
DECLARE
  v_wallet record;
  v_existing_movement uuid;
  v_adjustment numeric(18,2) := 18.12;
BEGIN
  SELECT id
  INTO v_existing_movement
  FROM public.wallet_movements
  WHERE idempotency_key =
    'fee-reconciliation-hold:BW:2026-07-26:18.12';

  IF v_existing_movement IS NOT NULL THEN
    RAISE NOTICE
      'Fee reconciliation hold já aplicado: %',
      v_existing_movement;

    RETURN;
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

  WHERE id =
    'ddba7396-c189-459d-bab4-6803e2ddffd8'

    AND merchant_id =
      '5d2a2279-deed-4225-b49c-b0c60ebb8580'

    AND upper(currency) = 'EUR'

  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Wallet BW EUR não encontrada';
  END IF;

  IF v_wallet.available < v_adjustment THEN
    RAISE EXCEPTION
      'Available insuficiente. Encontrado %, necessário %',
      v_wallet.available,
      v_adjustment;
  END IF;

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
    idempotency_key,
    created_at,
    updated_at
  )
  VALUES (
    v_wallet.id,
    v_wallet.merchant_id,
    v_wallet.currency,
    'fee_reconciliation',
    'hold',
    v_adjustment,
    'active',
    'FEE-RECONCILIATION-20260726',

    jsonb_build_object(
      'classification',
      'historical_fee_reconciliation_hold',

      'reason',
      'Available residual temporarily held pending Stripe provider fee reconciliation',

      'platformFeePolicy',
      '2_percent',

      'providerFeePolicy',
      'stripe_balance_transaction_actual',

      'amount',
      v_adjustment,

      'currency',
      v_wallet.currency,

      'createdBy',
      'finance-v4-phase4',

      'createdAt',
      now()
    ),

    'fee-reconciliation-hold:BW:2026-07-26:18.12',
    now(),
    now()
  );
END
$$;

DO $$
DECLARE
  v_wallet record;
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
      'Available deveria ser zero, encontrado %',
      v_wallet.available;
  END IF;

  IF ROUND(
       v_wallet.reconciliation_hold::numeric,
       2
     ) <> 193.90 THEN

    RAISE EXCEPTION
      'Hold esperado 193.90, encontrado %',
      v_wallet.reconciliation_hold;
  END IF;

  IF ROUND(
       (
         v_wallet.balance -
         v_wallet.reconciliation_hold
       )::numeric,
       2
     ) <> 8092.25 THEN

    RAISE EXCEPTION
      'Wallet Merchant esperada 8092.25';
  END IF;
END
$$;

COMMIT;
