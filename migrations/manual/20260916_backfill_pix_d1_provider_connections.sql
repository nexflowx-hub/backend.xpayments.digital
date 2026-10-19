WITH d1_vaults AS (
  SELECT
    gv.id AS gateway_vault_id,
    gv.merchant_id,
    gv.store_id,
    lower(gv.provider) AS alias,
    'vault:' || gv.id::text AS external_account_id
  FROM public.gateway_vaults gv
  WHERE gv.is_active = true
    AND gv.store_id IS NOT NULL
    AND lower(gv.provider) LIKE 'pix-d1%'
)
INSERT INTO public.provider_connections (
  provider_account_id,
  merchant_id,
  store_id,
  gateway_vault_id,
  alias,
  mode,
  credential_mode,
  capture_policy,
  status,
  shadow_mode,
  ledger_enabled,
  metadata
)
SELECT
  pa.id,
  v.merchant_id,
  v.store_id,
  v.gateway_vault_id,
  v.alias,
  'ORCHESTRATED',
  'xpayments_managed',
  'success_only',
  'active',
  true,
  false,
  jsonb_build_object(
    'source', 'PIX_D1_V3_REGISTRY_BACKFILL',
    'sourceVaultId', v.gateway_vault_id
  )
FROM d1_vaults v
JOIN public.provider_accounts pa
  ON pa.provider = 'pix_d1'
 AND pa.external_account_id = v.external_account_id
 AND pa.environment = 'live'
ON CONFLICT (merchant_id, store_id, alias)
DO UPDATE SET
  provider_account_id = EXCLUDED.provider_account_id,
  gateway_vault_id = EXCLUDED.gateway_vault_id,
  mode = EXCLUDED.mode,
  status = 'active',
  shadow_mode = true,
  metadata = public.provider_connections.metadata || EXCLUDED.metadata,
  updated_at = now();
