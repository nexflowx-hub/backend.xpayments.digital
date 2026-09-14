import { Response } from 'express';
import prisma from '../../../core/prisma';
import { ControlPlaneRequest } from '../middleware/control-plane-auth.middleware';

type Row = Record<string, any>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const currencyRe = /^[A-Z0-9]{3,10}$/;
const money = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
};

export async function listAccountingWallets(req: ControlPlaneRequest, res: Response) {
  try {
    const merchantId = String(req.query.merchantId || '').trim();
    const currency = String(req.query.currency || '').trim().toUpperCase();

    if (merchantId && !uuid.test(merchantId)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_MERCHANT_ID', message: 'merchantId inválido.' } });
    }
    if (currency && !currencyRe.test(currency)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_CURRENCY', message: 'Moeda inválida.' } });
    }

    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `
      select
        w.id,
        w.merchant_id,
        m.name as merchant_name,
        w.currency,
        w.label,
        w.type,
        w.balance,
        w.available,
        w.reserved,
        w.reconciliation_hold,
        w.updated_at
      from wallets w
      join merchants m on m.id = w.merchant_id
      where ($1::text = '' or w.merchant_id = $1::uuid)
        and ($2::text = '' or upper(w.currency) = $2)
      order by m.name, upper(w.currency)
      `,
      merchantId,
      currency
    );

    return res.json({
      success: true,
      data: {
        wallets: rows.map((row) => ({
          id: row.id,
          merchantId: row.merchant_id,
          merchantName: row.merchant_name,
          currency: row.currency,
          label: row.label,
          type: row.type,
          balance: money(row.balance),
          available: money(row.available),
          reserved: money(row.reserved),
          reconciliationHold: money(row.reconciliation_hold),
          updatedAt: row.updated_at
        })),
        accountingOnly: true,
        crossCurrencyTotal: null
      }
    });
  } catch (error) {
    console.error('[control-plane.treasury.accounting-wallets]', error);
    return res.status(500).json({ success: false, error: { code: 'TREASURY_QUERY_FAILED', message: 'Falha ao carregar Wallets contabilísticas.' } });
  }
}
