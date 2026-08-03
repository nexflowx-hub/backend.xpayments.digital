BEGIN;

CREATE TABLE IF NOT EXISTS public.payout_confirmation_challenges (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  payout_request_id uuid NOT NULL
    REFERENCES public.payout_requests(id)
    ON DELETE CASCADE,

  merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE CASCADE,

  actor_merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE RESTRICT,

  request_version integer NOT NULL,
  snapshot_hash text NOT NULL,

  status text NOT NULL
    DEFAULT 'pending',

  expires_at timestamptz NOT NULL,
  authorized_at timestamptz,
  consumed_at timestamptz,
  invalidated_at timestamptz,

  bank_transfer_confirmed boolean
    NOT NULL DEFAULT false,

  authorized_by_merchant_id uuid
    REFERENCES public.merchants(id)
    ON DELETE SET NULL,

  metadata jsonb NOT NULL
    DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL
    DEFAULT now(),

  updated_at timestamptz NOT NULL
    DEFAULT now(),

  CONSTRAINT payout_confirmation_challenges_status_valid
    CHECK (
      status IN (
        'pending',
        'authorized',
        'consumed',
        'expired',
        'invalidated'
      )
    ),

  CONSTRAINT payout_confirmation_challenges_version_positive
    CHECK (request_version >= 1)
);

CREATE TABLE IF NOT EXISTS public.payout_manager_approval_attempts (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  payout_request_id uuid
    REFERENCES public.payout_requests(id)
    ON DELETE CASCADE,

  challenge_id uuid
    REFERENCES public.payout_confirmation_challenges(id)
    ON DELETE CASCADE,

  merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE CASCADE,

  actor_merchant_id uuid NOT NULL
    REFERENCES public.merchants(id)
    ON DELETE RESTRICT,

  ip_hash text NOT NULL,
  succeeded boolean NOT NULL,

  reason text NOT NULL,
  metadata jsonb NOT NULL
    DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL
    DEFAULT now()
);

CREATE INDEX IF NOT EXISTS
  payout_confirmation_challenges_request_idx
ON public.payout_confirmation_challenges (
  payout_request_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  payout_confirmation_challenges_pending_idx
ON public.payout_confirmation_challenges (
  merchant_id,
  actor_merchant_id,
  expires_at
)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS
  payout_manager_attempts_actor_idx
ON public.payout_manager_approval_attempts (
  merchant_id,
  actor_merchant_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  payout_manager_attempts_ip_idx
ON public.payout_manager_approval_attempts (
  merchant_id,
  ip_hash,
  created_at DESC
);

COMMIT;
