import { Response } from 'express';
import prisma from '../../../core/prisma';
import { ControlPlaneRequest } from '../middleware/control-plane-auth.middleware';
import { writeControlPlaneAudit } from '../services/control-plane-audit.service';

type Row = Record<string, any>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const currencyRe = /^[A-Z0-9]{3,10}$/;

const money = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
};

const positive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const optionalUuid = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return uuid.test(text) ? text : null;
};

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

export async function confirmTreasurySettlementV2(req: ControlPlaneRequest, res: Response) {
  const actor = req.controlPlane;
  if (!actor) return fail(res, 401, 'CONTROL_PLANE_UNAUTHORIZED', 'Autenticação interna necessária.');

  const merchantId = optionalUuid(req.body?.merchantId);
  const sourceWalletId = optionalUuid(req.body?.sourceWalletId);
  const destinationWalletId = optionalUuid(req.body?.destinationWalletId);
  const payoutStatementId = optionalUuid(req.body?.payoutStatementId);
  const payoutRequestId = optionalUuid(req.body?.payoutRequestId);
  const sourceAmount = positive(req.body?.sourceAmount);
  const creditAmount = positive(req.body?.creditAmount);
  const sourceCurrency = String(req.body?.sourceCurrency || '').trim().toUpperCase();
  const destinationCode = String(req.body?.destinationCode || 'WALLET-BRL').trim().toUpperCase();
  const fxRateRaw = req.body?.fxRate;
  const fxRate = fxRateRaw === undefined || fxRateRaw === null || fxRateRaw === '' ? null : positive(fxRateRaw);
  const fxCost = Math.max(0, money(req.body?.fxCost || 0));
  const reference = String(req.body?.reference || '').trim().slice(0, 200);
  const notes = String(req.body?.notes || '').trim().slice(0, 2000);
  const idempotencyKey = String(req.body?.idempotencyKey || '').trim().slice(0, 200);

  if (!merchantId) return fail(res, 400, 'INVALID_MERCHANT_ID', 'merchantId obrigatório e inválido.');
  if (!sourceWalletId) return fail(res, 400, 'INVALID_SOURCE_WALLET', 'sourceWalletId obrigatório e inválido.');
  if (!sourceAmount || !creditAmount) return fail(res, 400, 'INVALID_AMOUNT', 'Valores de origem e crédito devem ser positivos.');
  if (!currencyRe.test(sourceCurrency)) return fail(res, 400, 'INVALID_CURRENCY', 'Moeda de origem inválida.');
  if (fxRateRaw !== undefined && fxRateRaw !== null && fxRateRaw !== '' && !fxRate) return fail(res, 400, 'INVALID_FX_RATE', 'FX rate inválido.');
  if (idempotencyKey.length < 8) return fail(res, 400, 'IDEMPOTENCY_REQUIRED', 'idempotencyKey é obrigatório.');

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe<Row[]>(
        `select * from treasury_wallet_movements where idempotency_key = $1 limit 1`,
        idempotencyKey
      );

      if (existing[0]) {
        if (String(existing[0].merchant_id) !== merchantId) throw new Error('IDEMPOTENCY_CONFLICT');
        return { movement: existing[0], idempotent: true };
      }

      const sourceRows = await tx.$queryRawUnsafe<Row[]>(
        `select * from wallets where id = $1::uuid and merchant_id = $2::uuid for update`,
        sourceWalletId,
        merchantId
      );
      const source = sourceRows[0];
      if (!source) throw new Error('SOURCE_WALLET_NOT_FOUND');
      if (String(source.currency).toUpperCase() !== sourceCurrency) throw new Error('SOURCE_CURRENCY_MISMATCH');
      if (money(source.available) < sourceAmount || money(source.balance) < sourceAmount) throw new Error('INSUFFICIENT_AVAILABLE');

      const destinationRows = destinationWalletId
        ? await tx.$queryRawUnsafe<Row[]>(
            `select * from treasury_wallets where id = $1::uuid and merchant_id = $2::uuid for update`,
            destinationWalletId,
            merchantId
          )
        : await tx.$queryRawUnsafe<Row[]>(
            `select * from treasury_wallets where merchant_id = $1::uuid and code = $2 for update`,
            merchantId,
            destinationCode
          );
      const destination = destinationRows[0];
      if (!destination) throw new Error('DESTINATION_WALLET_NOT_FOUND');
      if (String(destination.status) !== 'active') throw new Error('DESTINATION_WALLET_INACTIVE');

      let statement: Row | null = null;
      if (payoutStatementId) {
        const rows = await tx.$queryRawUnsafe<Row[]>(
          `select * from payout_statements where id = $1::uuid and merchant_id = $2::uuid for update`,
          payoutStatementId,
          merchantId
        );
        statement = rows[0] || null;
        if (!statement) throw new Error('PAYOUT_STATEMENT_NOT_FOUND');
        if (String(statement.wallet_id) !== sourceWalletId) throw new Error('PAYOUT_SOURCE_WALLET_MISMATCH');
        if (String(statement.currency).toUpperCase() !== sourceCurrency) throw new Error('PAYOUT_CURRENCY_MISMATCH');
        if (Math.abs(money(statement.amount) - sourceAmount) > 0.009) throw new Error('PAYOUT_AMOUNT_MISMATCH');
        if (String(statement.status) === 'paid') throw new Error('PAYOUT_ALREADY_PAID');

        const priorOut = await tx.$queryRawUnsafe<Row[]>(
          `
          select id, status, amount
          from wallet_movements
          where payout_statement_id = $1::uuid
            and direction = 'out'
          limit 1
          `,
          payoutStatementId
        );
        if (priorOut[0]) throw new Error('PAYOUT_ALREADY_HAS_LEDGER_OUT');
      }

      if (payoutRequestId) {
        const rows = await tx.$queryRawUnsafe<Row[]>(
          `select id from payout_requests where id = $1::uuid and merchant_id = $2::uuid limit 1`,
          payoutRequestId,
          merchantId
        );
        if (!rows[0]) throw new Error('PAYOUT_REQUEST_NOT_FOUND');
      }

      await tx.$executeRawUnsafe(
        `
        update wallets
        set balance = balance - $1::numeric,
            available = available - $1::numeric,
            updated_at = now()
        where id = $2::uuid and merchant_id = $3::uuid
        `,
        sourceAmount,
        sourceWalletId,
        merchantId
      );

      await tx.$executeRawUnsafe(
        `
        insert into wallet_movements (
          wallet_id, merchant_id, currency, type, direction, amount, status,
          reference, metadata, payout_statement_id, idempotency_key, released_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3, 'treasury_settlement', 'out', $4::numeric, 'concluido',
          $5, $6::jsonb, $7::uuid, $8, now(), now()
        )
        `,
        sourceWalletId,
        merchantId,
        sourceCurrency,
        sourceAmount,
        reference || null,
        JSON.stringify({
          destinationTreasuryWalletId: destination.id,
          destinationCode: destination.code,
          destinationCurrency: destination.currency,
          creditAmount,
          fxRate,
          fxCost,
          controlPlaneActor: actor.userId
        }),
        payoutStatementId,
        `accounting:${idempotencyKey}`
      );

      const movementRows = await tx.$queryRawUnsafe<Row[]>(
        `
        insert into treasury_wallet_movements (
          treasury_wallet_id, merchant_id, direction, type, amount, currency, status,
          source_wallet_id, source_amount, source_currency, fx_rate, fx_cost,
          payout_statement_id, payout_request_id, reference, idempotency_key,
          notes, confirmed_by, confirmed_at, metadata, updated_at
        ) values (
          $1::uuid, $2::uuid, 'in', 'settlement_transfer', $3::numeric, $4, 'confirmed',
          $5::uuid, $6::numeric, $7, $8::numeric, $9::numeric,
          $10::uuid, $11::uuid, $12, $13,
          $14, $15, now(), $16::jsonb, now()
        )
        returning *
        `,
        destination.id,
        merchantId,
        creditAmount,
        destination.currency,
        sourceWalletId,
        sourceAmount,
        sourceCurrency,
        fxRate,
        fxCost,
        payoutStatementId,
        payoutRequestId,
        reference || null,
        idempotencyKey,
        notes || null,
        actor.email,
        JSON.stringify({
          manualFx: true,
          autoFx: false,
          autoSettlement: false,
          actorUserId: actor.userId,
          actorRole: actor.role
        })
      );
      const movement = movementRows[0];

      await tx.$executeRawUnsafe(
        `
        update treasury_wallets
        set balance = balance + $1::numeric,
            available = available + $1::numeric,
            updated_at = now()
        where id = $2::uuid and merchant_id = $3::uuid
        `,
        creditAmount,
        destination.id,
        merchantId
      );

      if (statement) {
        await tx.$executeRawUnsafe(
          `
          update payout_statements
          set status = 'paid',
              paid_on = (now() at time zone 'Europe/Lisbon')::date,
              paid_at = now(),
              paid_by = $1,
              external_reference = coalesce(nullif($2, ''), external_reference),
              metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
          where id = $4::uuid
          `,
          actor.email,
          reference,
          JSON.stringify({
            treasurySettlement: true,
            treasuryWalletId: destination.id,
            treasuryWalletCode: destination.code,
            destinationAmount: creditAmount,
            destinationCurrency: destination.currency,
            sourceAmount,
            sourceCurrency,
            fxRate,
            fxCost
          }),
          payoutStatementId
        );
      }

      // Financial writes and their audit record succeed or roll back together.
      await tx.$executeRawUnsafe(
        `
        insert into control_plane_audit_logs (
          actor_user_id, action, entity_type, entity_id,
          before_data, after_data, metadata, ip_address, user_agent
        ) values (
          $1::uuid, 'treasury.settlement.confirm', 'treasury_wallet_movement', $2,
          null, $3::jsonb, $4::jsonb, $5, $6
        )
        `,
        actor.userId,
        movement.id,
        JSON.stringify(movement),
        JSON.stringify({
          merchantId,
          sourceWalletId,
          destinationWalletId: destination.id,
          payoutStatementId,
          payoutRequestId,
          idempotencyKey,
          sourceAmount,
          sourceCurrency,
          creditAmount,
          destinationCurrency: destination.currency,
          fxRate,
          fxCost
        }),
        req.ip || null,
        String(req.headers['user-agent'] || '').slice(0, 500) || null
      );

      return { movement, idempotent: false };
    });

    if (result.idempotent) {
      // Replay is non-financial; best-effort audit is sufficient here.
      await writeControlPlaneAudit({
        actorUserId: actor.userId,
        action: 'treasury.settlement.replay',
        entityType: 'treasury_wallet_movement',
        entityId: result.movement?.id || null,
        metadata: { merchantId, idempotencyKey },
        req
      });
    }

    return res.status(result.idempotent ? 200 : 201).json({
      success: true,
      data: { movement: result.movement, idempotent: result.idempotent }
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TREASURY_SETTLEMENT_FAILED';
    const known: Record<string, [number, string]> = {
      IDEMPOTENCY_CONFLICT: [409, 'A chave de idempotência pertence a outra operação.'],
      SOURCE_WALLET_NOT_FOUND: [404, 'Wallet contabilística de origem não encontrada.'],
      SOURCE_CURRENCY_MISMATCH: [409, 'A moeda da Wallet de origem não corresponde à operação.'],
      INSUFFICIENT_AVAILABLE: [409, 'Saldo disponível insuficiente na Wallet contabilística de origem.'],
      DESTINATION_WALLET_NOT_FOUND: [404, 'Treasury Wallet de destino não encontrada.'],
      DESTINATION_WALLET_INACTIVE: [409, 'Treasury Wallet de destino não está ativa.'],
      PAYOUT_STATEMENT_NOT_FOUND: [404, 'Payout statement não encontrado.'],
      PAYOUT_SOURCE_WALLET_MISMATCH: [409, 'Payout statement pertence a outra Wallet de origem.'],
      PAYOUT_CURRENCY_MISMATCH: [409, 'Payout statement pertence a outra moeda.'],
      PAYOUT_AMOUNT_MISMATCH: [409, 'Valor da operação difere do payout statement.'],
      PAYOUT_ALREADY_PAID: [409, 'Payout statement já está marcado como pago.'],
      PAYOUT_ALREADY_HAS_LEDGER_OUT: [409, 'O payout já possui uma saída contabilística e não pode ser debitado novamente.'],
      PAYOUT_REQUEST_NOT_FOUND: [404, 'Payout request não encontrado.']
    };
    const mapped = known[code];
    if (mapped) return fail(res, mapped[0], code, mapped[1]);
    console.error('[control-plane.treasury.settlement.v2]', error);
    return fail(res, 500, 'TREASURY_SETTLEMENT_FAILED', 'Falha ao confirmar settlement manual.');
  }
}
