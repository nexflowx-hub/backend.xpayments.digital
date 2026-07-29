CREATE TABLE IF NOT EXISTS
  public.payout_funding_allocations (
    id uuid PRIMARY KEY
      DEFAULT gen_random_uuid(),

    payout_statement_id uuid NOT NULL
      REFERENCES public.payout_statements(id)
      ON DELETE CASCADE,

    merchant_id uuid NOT NULL
      REFERENCES public.merchants(id)
      ON DELETE CASCADE,

    store_id uuid
      REFERENCES public.stores(id)
      ON DELETE SET NULL,

    wallet_movement_id uuid
      REFERENCES public.wallet_movements(id)
      ON DELETE RESTRICT,

    source_type text NOT NULL,

    allocated_amount numeric(18, 2)
      NOT NULL,

    currency text NOT NULL,

    metadata jsonb NOT NULL
      DEFAULT '{}'::jsonb,

    created_at timestamptz NOT NULL
      DEFAULT now(),

    CONSTRAINT
      payout_funding_allocations_amount_positive
      CHECK (allocated_amount > 0),

    CONSTRAINT
      payout_funding_allocations_source_type_check
      CHECK (
        source_type IN (
          'wallet_movement',
          'treasury_advance',
          'manual_adjustment',
          'reserve'
        )
      ),

    CONSTRAINT
      payout_funding_allocations_movement_source_check
      CHECK (
        (
          source_type = 'wallet_movement'
          AND wallet_movement_id IS NOT NULL
        )
        OR
        (
          source_type <> 'wallet_movement'
          AND wallet_movement_id IS NULL
        )
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  payout_funding_allocations_payout_movement_uidx

  ON public.payout_funding_allocations (
    payout_statement_id,
    wallet_movement_id
  )

  WHERE wallet_movement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  payout_funding_allocations_movement_idx

  ON public.payout_funding_allocations (
    wallet_movement_id
  )

  WHERE wallet_movement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  payout_funding_allocations_payout_idx

  ON public.payout_funding_allocations (
    payout_statement_id
  );

CREATE INDEX IF NOT EXISTS
  payout_funding_allocations_merchant_store_idx

  ON public.payout_funding_allocations (
    merchant_id,
    store_id,
    currency
  );

CREATE OR REPLACE FUNCTION
  public.validate_payout_funding_allocation()

RETURNS trigger

LANGUAGE plpgsql

AS $$
DECLARE
  movement_merchant_id uuid;
  movement_store_id uuid;
  movement_currency text;
  movement_capacity numeric(18, 2);
  movement_allocated numeric(18, 2);

  payout_merchant_id uuid;
  payout_currency text;
BEGIN
  SELECT
    merchant_id,
    currency

  INTO
    payout_merchant_id,
    payout_currency

  FROM public.payout_statements

  WHERE id =
    NEW.payout_statement_id;

  IF payout_merchant_id IS NULL THEN
    RAISE EXCEPTION
      'Payout statement % não encontrado.',
      NEW.payout_statement_id;
  END IF;

  IF payout_merchant_id <>
    NEW.merchant_id
  THEN
    RAISE EXCEPTION
      'Merchant divergente na alocação do payout.';
  END IF;

  IF upper(payout_currency) <>
    upper(NEW.currency)
  THEN
    RAISE EXCEPTION
      'Moeda divergente na alocação do payout.';
  END IF;

  IF NEW.source_type =
    'wallet_movement'
  THEN
    SELECT
      merchant_id,
      store_id,
      currency,

      GREATEST(
        COALESCE(
          merchant_net,
          amount -
            COALESCE(
              provider_fee,
              0
            )
        ),
        0
      )

    INTO
      movement_merchant_id,
      movement_store_id,
      movement_currency,
      movement_capacity

    FROM public.wallet_movements

    WHERE id =
      NEW.wallet_movement_id;

    IF movement_merchant_id IS NULL THEN
      RAISE EXCEPTION
        'Wallet movement % não encontrado.',
        NEW.wallet_movement_id;
    END IF;

    IF movement_merchant_id <>
      NEW.merchant_id
    THEN
      RAISE EXCEPTION
        'Merchant divergente no movimento de origem.';
    END IF;

    IF upper(movement_currency) <>
      upper(NEW.currency)
    THEN
      RAISE EXCEPTION
        'Moeda divergente no movimento de origem.';
    END IF;

    IF
      NEW.store_id IS NOT NULL
      AND movement_store_id IS NOT NULL
      AND NEW.store_id <>
        movement_store_id
    THEN
      RAISE EXCEPTION
        'Store divergente no movimento de origem.';
    END IF;

    SELECT
      COALESCE(
        SUM(allocated_amount),
        0
      )

    INTO movement_allocated

    FROM public.payout_funding_allocations

    WHERE wallet_movement_id =
      NEW.wallet_movement_id

      AND id <>
        NEW.id;

    IF
      movement_allocated +
        NEW.allocated_amount >
      movement_capacity + 0.005
    THEN
      RAISE EXCEPTION
        'Alocação excede o líquido disponível do movimento %.',
        NEW.wallet_movement_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  payout_funding_allocations_validate

ON public.payout_funding_allocations;

CREATE TRIGGER
  payout_funding_allocations_validate

BEFORE INSERT OR UPDATE

ON public.payout_funding_allocations

FOR EACH ROW

EXECUTE FUNCTION
  public.validate_payout_funding_allocation();

COMMENT ON TABLE
  public.payout_funding_allocations

IS
  'Relaciona payouts às origens financeiras exatas. Permite payout parcial, FIFO, D0 e adiantamentos de tesouraria.';
