WITH d1_vaults AS (
  SELECT
    gv.id AS gateway_vault_id,
    'vault:' || gv.id::text AS external_account_id
  FROM public.gateway_vaults gv
  WHERE gv.is_active = true
    AND gv.store_id IS NOT NULL
    AND lower(gv.provider) LIKE 'pix-d1%'
)
INSERT INTO public.provider_accounts (
  provider,
  external_account_id,
  environment,
  country,
  default_currency,
  status,
  metadata
)
SELECT
  'pix_d1',
  v.external_account_id,
  'live',
  'BR',
  'BRL',
  'active',
  jsonb_build_object(
    'source', 'PIX_D1_V3_REGISTRY_BACKFILL',
    'sourceVaultId', v.gateway_vault_id,
    'identityMode', 'vault_surrogate'
  )
FROM d1_vaults v
ON CONFLICT (provider, external_account_id, environment)
DO UPDATE SET
  status = 'active',
  default_currency = 'BRL',
  country = 'BR',
  metadata = public.provider_accounts.metadata || EXCLUDED.metadata,
  updated_at = now();
