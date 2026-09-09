import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const providerFamily = (value: unknown) =>
  String(value ?? '').trim().toLowerCase().split('-')[0].split('_')[0];

export const getStoreElementsConfig = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = req.user?.id ? String(req.user.id) : '';
    const storeId = String(req.params.storeId ?? '').trim();

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' }
      });
    }

    const store = await prisma.store.findFirst({
      where: { id: storeId, merchantId },
      select: { id: true, storeCode: true, name: true, status: true }
    });

    if (!store) {
      return res.status(404).json({
        success: false,
        error: { code: 'STORE_NOT_FOUND', message: 'Store não encontrada.' }
      });
    }

    const rows = await prisma.$queryRawUnsafe<any[]>(`
      select
        spp.activation_state,
        spp.processing_mode,
        pc.id as connection_id,
        pc.status as connection_status,
        pa.provider as account_provider,
        pa.environment as account_environment,
        pa.external_account_id,
        gv.id as vault_id,
        gv.provider as vault_provider,
        gv.credentials,
        gv.is_active as vault_active
      from store_processing_profiles spp
      join provider_connections pc on pc.id = spp.provider_connection_id
      join provider_accounts pa on pa.id = pc.provider_account_id
      join gateway_vaults gv on gv.id = pc.gateway_vault_id
      where spp.store_id = $1::uuid
        and spp.merchant_id = $2::uuid
        and pc.store_id = $1::uuid
        and pc.merchant_id = $2::uuid
        and lower(pc.status) = 'active'
        and gv.is_active = true
      order by
        case when upper(spp.activation_state) = 'ACTIVE' then 0 else 1 end,
        spp.updated_at desc
      limit 1
    `, storeId, merchantId);

    const route = rows[0];
    if (!route) {
      return res.status(200).json({
        success: true,
        data: {
          storeId: store.id,
          storeCode: store.storeCode,
          storeName: store.name,
          available: false,
          mode: 'XPAYMENTS_EMBED',
          reason: 'STRIPE_ROUTE_NOT_CONFIGURED'
        }
      });
    }

    if (
      providerFamily(route.account_provider) !== 'stripe' ||
      providerFamily(route.vault_provider) !== 'stripe'
    ) {
      return res.status(200).json({
        success: true,
        data: {
          storeId: store.id,
          storeCode: store.storeCode,
          storeName: store.name,
          available: false,
          mode: 'XPAYMENTS_EMBED',
          reason: 'ACTIVE_ROUTE_NOT_STRIPE'
        }
      });
    }

    const credentials = route.credentials && typeof route.credentials === 'object'
      ? route.credentials as Record<string, unknown>
      : {};

    const publishableKey = String(
      credentials.publishableKey ?? credentials.publicKey ?? ''
    ).trim();

    const secretKey = String(credentials.secretKey ?? '').trim();
    const environment =
      secretKey.startsWith('sk_live_') || publishableKey.startsWith('pk_live_')
        ? 'live'
        : secretKey.startsWith('sk_test_') || publishableKey.startsWith('pk_test_')
          ? 'test'
          : String(credentials.environment ?? route.account_environment ?? 'unknown').toLowerCase();

    if (!publishableKey.startsWith('pk_')) {
      return res.status(200).json({
        success: true,
        data: {
          storeId: store.id,
          storeCode: store.storeCode,
          storeName: store.name,
          available: false,
          mode: 'XPAYMENTS_EMBED',
          environment,
          reason: 'PUBLISHABLE_KEY_NOT_CONFIGURED'
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        storeId: store.id,
        storeCode: store.storeCode,
        storeName: store.name,
        available: true,
        mode: 'STRIPE_ELEMENTS_COMPAT',
        environment,
        publishableKey,
        stripeAccountId: null,
        relayBaseUrl: 'https://api.xpayments.digital/api/stripe/v1',
        note: 'publishableKey is browser-safe. Never expose xp_* or Stripe secret credentials in client code.'
      }
    });
  } catch (error) {
    console.error('[ELEMENTS_CONFIG_ERROR]', error);
    return res.status(500).json({
      success: false,
      error: { code: 'ELEMENTS_CONFIG_ERROR', message: 'Erro ao carregar configuração Elements.' }
    });
  }
};
