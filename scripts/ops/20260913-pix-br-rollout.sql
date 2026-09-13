-- XPAYMENTS — BRL PIX production rollout
-- 2026-09-13
-- Purpose:
--   1. Activate MADOSI-BR for live PIX using its existing MISTIC_BR001 binding.
--   2. Promote MyPets-BR to the same VNEXT / ORCHESTRATED control-plane model.
--   3. Leave TWF-BR unchanged because it is already VNEXT / ORCHESTRATED / ACTIVE.
--
-- This migration is idempotent. It does not create payments, modify wallet balances,
-- alter transaction history, or change the certified Direct EUR runtime.

BEGIN;

WITH mypets_connection AS (
  INSERT INTO public.provider_connections (
    id, provider_account_id, merchant_id, store_id, gateway_vault_id,
    alias, mode, credential_mode, capture_policy, status,
    shadow_mode, ledger_enabled, metadata, created_at, updated_at
  ) VALUES (
    gen_random_uuid(),
    'be46dccf-d7ab-4f08-8d93-323cbd6a5d1b'::uuid,
    'c518ff43-9887-4e59-97ed-9519c9e4800a'::uuid,
    '5cc7883f-7e4c-4ac8-b0c4-56b1b9959a42'::uuid,
    '710c6994-8535-439b-a6a5-504748ce4725'::uuid,
    'misticpay-mypets-br001',
    'ORCHESTRATED',
    'xpayments_managed',
    'success_only',
    'active',
    false,
    true,
    jsonb_build_object(
      'purpose','PIX_LIVE_ORCHESTRATION',
      'surface','XPAYMENTS_NATIVE',
      'migration','MYPETS-BR-VNEXT-20260913',
      'environment','live',
      'financeBinding',true,
      'physicalProviderAccount','MISTIC_BR001',
      'sharedPhysicalMisticAccount',true
    ),
    now(), now()
  )
  ON CONFLICT (merchant_id, store_id, alias)
  DO UPDATE SET
    provider_account_id=EXCLUDED.provider_account_id,
    gateway_vault_id=EXCLUDED.gateway_vault_id,
    mode=EXCLUDED.mode,
    credential_mode=EXCLUDED.credential_mode,
    capture_policy=EXCLUDED.capture_policy,
    status='active',
    shadow_mode=false,
    ledger_enabled=true,
    metadata=EXCLUDED.metadata,
    updated_at=now()
  RETURNING id
),
upsert_mypets_profile AS (
  INSERT INTO public.store_processing_profiles (
    id, merchant_id, store_id, runtime_generation, processing_mode,
    activation_state, provider_connection_id, effective_from,
    legacy_compatibility, metadata, created_at, updated_at
  )
  SELECT
    gen_random_uuid(),
    'c518ff43-9887-4e59-97ed-9519c9e4800a'::uuid,
    '5cc7883f-7e4c-4ac8-b0c4-56b1b9959a42'::uuid,
    'VNEXT', 'ORCHESTRATED', 'ACTIVE', id, now(), false,
    jsonb_build_object(
      'purpose','PIX_LIVE_ORCHESTRATION',
      'surface','XPAYMENTS_NATIVE',
      'migration','MYPETS-BR-VNEXT-20260913',
      'environment','live',
      'financeBinding',true,
      'physicalProviderAccount','MISTIC_BR001'
    ),
    now(), now()
  FROM mypets_connection
  ON CONFLICT (store_id)
  DO UPDATE SET
    runtime_generation='VNEXT',
    processing_mode='ORCHESTRATED',
    activation_state='ACTIVE',
    provider_connection_id=EXCLUDED.provider_connection_id,
    effective_from=COALESCE(store_processing_profiles.effective_from, now()),
    legacy_compatibility=false,
    metadata=EXCLUDED.metadata,
    updated_at=now()
  RETURNING id
)
UPDATE public.stores
SET status='active'
WHERE id='5cc7883f-7e4c-4ac8-b0c4-56b1b9959a42'::uuid;

UPDATE public.stores
SET status='active'
WHERE id='37cbbe89-168b-401a-b2c8-6bda59084252'::uuid;

UPDATE public.store_processing_profiles
SET activation_state='ACTIVE',
    effective_from=COALESCE(effective_from, now()),
    updated_at=now(),
    metadata=COALESCE(metadata,'{}'::jsonb)
      || jsonb_build_object('activatedAt',now(),'activation','PRODUCTION')
WHERE store_id='37cbbe89-168b-401a-b2c8-6bda59084252'::uuid;

UPDATE public.provider_connections
SET status='active', shadow_mode=false, ledger_enabled=true, updated_at=now()
WHERE id='ab31353e-6cfd-47e7-a8af-dd7e54030b44'::uuid;

COMMIT;
