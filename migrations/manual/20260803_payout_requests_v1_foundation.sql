BEGIN;

CREATE TABLE public.payout_requests (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  request_code text NOT NULL UNIQUE,

  merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE CASCADE,

  store_id uuid NOT NULL
    REFERENCES public.stores(id)
    ON DELETE RESTRICT,

  wallet_id uuid NOT NULL
    REFERENCES public.wallets(id)
    ON DELETE RESTRICT,

  currency text NOT NULL,

  status text NOT NULL
    DEFAULT 'draft',

  requested_amount numeric(18, 2)
    NOT NULL DEFAULT 0,

  external_reference text,
  notes text,

  created_by_merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE RESTRICT,

  requested_at timestamptz,
  review_started_at timestamptz,
  reviewed_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  confirmed_at timestamptz,
  deleted_at timestamptz,

  confirmed_payout_statement_id uuid UNIQUE
    REFERENCES public.payout_statements(id)
    ON DELETE SET NULL,

  snapshot_hash text,
  version integer NOT NULL DEFAULT 1,

  metadata jsonb NOT NULL
    DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL
    DEFAULT now(),

  updated_at timestamptz NOT NULL
    DEFAULT now(),

  CONSTRAINT payout_requests_currency_format
    CHECK (currency ~ '^[A-Z]{3,5}$'),

  CONSTRAINT payout_requests_status_valid
    CHECK (
      status IN (
        'draft',
        'requested',
        'under_review',
        'rejected',
        'cancelled',
        'stale',
        'confirmed'
      )
    ),

  CONSTRAINT payout_requests_amount_nonnegative
    CHECK (requested_amount >= 0),

  CONSTRAINT payout_requests_version_positive
    CHECK (version >= 1)
);

CREATE TABLE public.payout_request_allocations (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  payout_request_id uuid NOT NULL
    REFERENCES public.payout_requests(id)
    ON DELETE CASCADE,

  merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE CASCADE,

  store_id uuid NOT NULL
    REFERENCES public.stores(id)
    ON DELETE RESTRICT,

  release_date date NOT NULL,
  provider text NOT NULL,

  requested_amount numeric(18, 2)
    NOT NULL,

  snapshot_available_amount numeric(18, 2),
  snapshot_movement_count integer,
  position integer NOT NULL DEFAULT 0,

  metadata jsonb NOT NULL
    DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL
    DEFAULT now(),

  updated_at timestamptz NOT NULL
    DEFAULT now(),

  CONSTRAINT payout_request_allocations_amount_positive
    CHECK (requested_amount > 0),

  CONSTRAINT payout_request_allocations_snapshot_nonnegative
    CHECK (
      snapshot_available_amount IS NULL
      OR snapshot_available_amount >= 0
    ),

  CONSTRAINT payout_request_allocations_movement_count_nonnegative
    CHECK (
      snapshot_movement_count IS NULL
      OR snapshot_movement_count >= 0
    ),

  CONSTRAINT payout_request_allocations_position_nonnegative
    CHECK (position >= 0)
);

CREATE TABLE public.payout_request_events (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  payout_request_id uuid NOT NULL
    REFERENCES public.payout_requests(id)
    ON DELETE CASCADE,

  merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE CASCADE,

  actor_merchant_id uuid
    REFERENCES public.merchants(id)
    ON DELETE SET NULL,

  event_type text NOT NULL,
  from_status text,
  to_status text,

  ip_address text,
  user_agent text,

  payload jsonb NOT NULL
    DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL
    DEFAULT now()
);

CREATE TABLE public.payout_request_notification_outbox (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  payout_request_id uuid NOT NULL
    REFERENCES public.payout_requests(id)
    ON DELETE CASCADE,

  merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE CASCADE,

  channel text NOT NULL,
  destination text,

  status text NOT NULL
    DEFAULT 'pending',

  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz
    NOT NULL DEFAULT now(),

  sent_at timestamptz,
  last_error text,

  payload jsonb NOT NULL
    DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL
    DEFAULT now(),

  updated_at timestamptz NOT NULL
    DEFAULT now(),

  CONSTRAINT payout_request_outbox_channel_valid
    CHECK (
      channel IN (
        'telegram',
        'discord',
        'email',
        'slack',
        'webhook'
      )
    ),

  CONSTRAINT payout_request_outbox_status_valid
    CHECK (
      status IN (
        'pending',
        'processing',
        'sent',
        'failed',
        'dead'
      )
    ),

  CONSTRAINT payout_request_outbox_attempts_nonnegative
    CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX
  payout_request_allocations_unique_bucket
ON public.payout_request_allocations (
  payout_request_id,
  release_date,
  provider,
  position
);

CREATE INDEX
  payout_requests_merchant_status_created_idx
ON public.payout_requests (
  merchant_id,
  status,
  created_at DESC
);

CREATE INDEX
  payout_requests_store_created_idx
ON public.payout_requests (
  store_id,
  created_at DESC
);

CREATE INDEX
  payout_requests_active_idx
ON public.payout_requests (
  merchant_id,
  updated_at DESC
)
WHERE deleted_at IS NULL;

CREATE INDEX
  payout_request_allocations_request_idx
ON public.payout_request_allocations (
  payout_request_id,
  position,
  created_at
);

CREATE INDEX
  payout_request_allocations_funding_bucket_idx
ON public.payout_request_allocations (
  merchant_id,
  store_id,
  provider,
  release_date
);

CREATE INDEX
  payout_request_events_request_created_idx
ON public.payout_request_events (
  payout_request_id,
  created_at
);

CREATE INDEX
  payout_request_events_merchant_created_idx
ON public.payout_request_events (
  merchant_id,
  created_at DESC
);

CREATE INDEX
  payout_request_outbox_pending_idx
ON public.payout_request_notification_outbox (
  status,
  next_attempt_at,
  created_at
)
WHERE status IN ('pending', 'failed');

COMMIT;
