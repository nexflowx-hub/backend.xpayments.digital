import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const XPAY_EXPERT_SELLER_MERCHANT_ID = '4f0bebc8-72aa-4fb7-a91d-4b2153130fd0';
const WHATSAPP_E164 = '+351925386409';

const STORE_BY_CURRENCY: Record<string, string> = {
  EUR: 'XPAYEXPERT-EUR',
  BRL: 'XPAYEXPERT-BRL',
  USDT: 'XPAYEXPERT-USDT'
};

const merchantIdFrom = (req: AuthRequest) =>
  String(req.merchantId || req.user?.id || '').trim();

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const objectValue = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {}
  }

  return {};
};

export const getMerchantOrderPaymentInstructions = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const merchantId = merchantIdFrom(req);
    const orderId = String(req.params.orderId || '').trim();

    if (!merchantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' }
      });
    }

    if (!isUuid(orderId)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ORDER_ID', message: 'Identificador da contratação inválido.' }
      });
    }

    const orderRows = await prisma.$queryRaw<any[]>`
      select
        so.id,
        so.order_code,
        so.payment_status,
        so.payment_currency,
        so.payment_amount,
        off.code as offering_code,
        off.name as offering_name
      from service_orders so
      join service_offerings off on off.id = so.offering_id
      where so.id = cast(${orderId} as uuid)
        and so.merchant_id = cast(${merchantId} as uuid)
      limit 1
    `;

    const order = orderRows[0];
    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Contratação não encontrada.' }
      });
    }

    const currency = String(order.payment_currency || '').toUpperCase();
    const storeCode = STORE_BY_CURRENCY[currency];

    if (!storeCode) {
      return res.status(400).json({
        success: false,
        error: { code: 'PAYMENT_METHOD_UNAVAILABLE', message: 'Não existem instruções para esta moeda.' }
      });
    }

    const vaultRows = await prisma.$queryRaw<any[]>`
      select
        s.store_code,
        gv.provider,
        gv.credentials
      from stores s
      join gateway_vaults gv on gv.store_id = s.id
      where s.merchant_id = cast(${XPAY_EXPERT_SELLER_MERCHANT_ID} as uuid)
        and s.store_code = ${storeCode}
        and s.status = 'active'
        and gv.is_active = true
      order by gv.created_at asc
      limit 1
    `;

    const vault = vaultRows[0];
    if (!vault) {
      return res.status(503).json({
        success: false,
        error: { code: 'PAYMENT_INSTRUCTIONS_UNAVAILABLE', message: 'As instruções de pagamento estão temporariamente indisponíveis.' }
      });
    }

    const credentials = objectValue(vault.credentials);
    let instructions: Record<string, any>;

    if (currency === 'EUR') {
      const accounts = Array.isArray(credentials.accounts) ? credentials.accounts : [];
      instructions = {
        method: 'SEPA',
        accounts: accounts.map((account: any) => ({
          label: String(account?.label || ''),
          priority: Number(account?.priority || 0),
          beneficiary: String(account?.beneficiary || ''),
          iban: String(account?.iban || ''),
          bic: String(account?.bic || ''),
          bank: String(account?.bank || ''),
          bankAddress: String(account?.bankAddress || ''),
          bankCountry: String(account?.bankCountry || ''),
          scheme: String(account?.scheme || 'SEPA')
        }))
      };
    } else if (currency === 'BRL') {
      const keys = Array.isArray(credentials.keys) ? credentials.keys : [];
      instructions = {
        method: 'PIX',
        keys: keys.map((key: any) => ({
          label: String(key?.label || ''),
          priority: Number(key?.priority || 0),
          keyType: String(key?.keyType || ''),
          key: String(key?.key || '')
        })),
        qrCode: {
          available: false,
          reason: 'PIX BR Code dinâmico será ativado após configuração do merchant city/nome PIX.'
        }
      };
    } else {
      const wallets = Array.isArray(credentials.wallets) ? credentials.wallets : [];
      instructions = {
        method: 'CRYPTO',
        asset: 'USDT',
        preferredNetwork: String(credentials.preferredStablecoinNetwork || 'TRC20'),
        wallets: wallets
          .filter((wallet: any) => Array.isArray(wallet?.assets) && wallet.assets.includes('USDT'))
          .map((wallet: any) => ({
            network: String(wallet?.network || ''),
            standard: String(wallet?.standard || ''),
            address: String(wallet?.address || ''),
            priority: Number(wallet?.priority || 0),
            explorer: String(wallet?.explorer || '')
          }))
      };
    }

    return res.json({
      success: true,
      data: {
        order: {
          id: order.id,
          orderCode: order.order_code,
          offeringCode: order.offering_code,
          offeringName: order.offering_name,
          paymentStatus: order.payment_status,
          amount: Number(order.payment_amount),
          currency
        },
        payment: {
          storeCode,
          provider: vault.provider,
          reference: order.order_code,
          confirmationMode: 'MANUAL_PROOF',
          proofRequired: true,
          whatsapp: WHATSAPP_E164,
          instructions
        }
      }
    });
  } catch (error: any) {
    console.error('[expert.orders.payment-instructions]', {
      code: error?.code || null,
      message: error?.message || 'unknown'
    });

    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Não foi possível carregar as instruções de pagamento.' }
    });
  }
};
