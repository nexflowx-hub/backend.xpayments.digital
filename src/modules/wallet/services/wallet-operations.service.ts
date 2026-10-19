import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../../core/prisma';

export type WalletOperationType = 'deposit' | 'transfer' | 'withdrawal';
export type WalletOperationStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'reversed'
  | 'cancelled';

type JsonRecord = Record<string, unknown>;

export class WalletOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
  }
}

export interface WalletOperationRow {
  id: string;
  operation_code: string;
  merchant_id: string;
  store_id: string | null;
  type: WalletOperationType;
  status: WalletOperationStatus;
  currency: string;
  amount: unknown;
  source_treasury_wallet_id: string | null;
  destination_treasury_wallet_id: string | null;
  payout_request_id: string | null;
  idempotency_key: string;
  request_hash: string;
  external_reference: string | null;
  failure_reason: string | null;
  metadata: JsonRecord | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

type TreasuryWalletRow = {
  id: string;
  merchant_id: string;
  code: string;
  currency: string;
  wallet_role: string;
  status: string;
  balance: unknown;
  available: unknown;
  reserved: unknown;
  metadata: JsonRecord | null;
};

const normalizeCurrency = (value: unknown): string =>
  String(value ?? '').trim().toUpperCase();

const amountNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new WalletOperationError('INVALID_AMOUNT', 'O valor deve ser positivo.');
  }
  return Number(parsed.toFixed(2));
};

const hashRequest = (payload: JsonRecord): string =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

const operationCode = (type: WalletOperationType): string => {
  const prefix = type === 'withdrawal' ? 'WDR' : type === 'deposit' ? 'DEP' : 'TRF';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
};

const serializeOperation = (row: WalletOperationRow) => ({
  id: row.id,
  code: row.operation_code,
  type: row.type,
  status: row.status,
  currency: row.currency,
  amount: Number(row.amount),
  storeId: row.store_id,
  sourceTreasuryWalletId: row.source_treasury_wallet_id,
  destinationTreasuryWalletId: row.destination_treasury_wallet_id,
  payoutRequestId: row.payout_request_id,
  externalReference: row.external_reference,
  failureReason: row.failure_reason,
  metadata: row.metadata ?? {},
  completedAt: row.completed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const findExistingByIdempotency = async (
  tx: Prisma.TransactionClient,
  merchantId: string,
  idempotencyKey: string,
  requestHash: string
): Promise<WalletOperationRow | null> => {
  const rows = await tx.$queryRaw<WalletOperationRow[]>(Prisma.sql`
    SELECT *
    FROM public.wallet_operations
    WHERE merchant_id = ${merchantId}::uuid
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);

  const existing = rows[0] ?? null;
  if (existing && existing.request_hash !== requestHash) {
    throw new WalletOperationError(
      'IDEMPOTENCY_CONFLICT',
      'A mesma Idempotency-Key já foi utilizada com outro payload.',
      409
    );
  }
  return existing;
};

const lockTreasuryWallet = async (
  tx: Prisma.TransactionClient,
  merchantId: string,
  walletId: string
): Promise<TreasuryWalletRow> => {
  const rows = await tx.$queryRaw<TreasuryWalletRow[]>(Prisma.sql`
    SELECT id, merchant_id, code, currency, wallet_role, status,
           balance, available, reserved, metadata
    FROM public.treasury_wallets
    WHERE id = ${walletId}::uuid
      AND merchant_id = ${merchantId}::uuid
    FOR UPDATE
  `);
  const wallet = rows[0];
  if (!wallet) {
    throw new WalletOperationError('TREASURY_WALLET_NOT_FOUND', 'Wallet física não encontrada.', 404);
  }
  if (wallet.status !== 'active') {
    throw new WalletOperationError('TREASURY_WALLET_INACTIVE', 'Wallet física não está ativa.', 409);
  }
  return wallet;
};

const requireBankSettlementWallet = (wallet: TreasuryWalletRow) => {
  if (wallet.wallet_role !== 'BANK_SETTLEMENT') {
    throw new WalletOperationError(
      'INVALID_WALLET_ROLE',
      'A operação exige uma Wallet física de liquidação bancária.',
      409
    );
  }
};

const addEvent = async (
  tx: Prisma.TransactionClient,
  operationId: string,
  merchantId: string,
  eventType: string,
  fromStatus: WalletOperationStatus | null,
  toStatus: WalletOperationStatus,
  actorType: 'merchant' | 'admin' | 'system' | 'provider',
  actorId: string | null,
  metadata: JsonRecord = {}
) => {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO public.wallet_operation_events (
      operation_id, merchant_id, event_type, from_status, to_status,
      actor_type, actor_id, metadata
    ) VALUES (
      ${operationId}::uuid, ${merchantId}::uuid, ${eventType},
      ${fromStatus}, ${toStatus}, ${actorType}, ${actorId},
      ${JSON.stringify(metadata)}::jsonb
    )
  `);
};

export const createWithdrawalOperation = async (input: {
  merchantId: string;
  treasuryWalletId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  storeId?: string | null;
  externalReference?: string | null;
  metadata?: JsonRecord;
}) => {
  const currency = normalizeCurrency(input.currency);
  const amount = amountNumber(input.amount);
  const requestHash = hashRequest({
    type: 'withdrawal',
    treasuryWalletId: input.treasuryWalletId,
    amount,
    currency,
    storeId: input.storeId ?? null,
    externalReference: input.externalReference ?? null
  });

  return prisma.$transaction(async tx => {
    const existing = await findExistingByIdempotency(
      tx,
      input.merchantId,
      input.idempotencyKey,
      requestHash
    );
    if (existing) return serializeOperation(existing);

    const wallet = await lockTreasuryWallet(tx, input.merchantId, input.treasuryWalletId);
    requireBankSettlementWallet(wallet);
    if (wallet.currency !== currency) {
      throw new WalletOperationError('CURRENCY_MISMATCH', 'A moeda da operação não corresponde à Wallet.', 409);
    }
    if (Number(wallet.available) < amount) {
      throw new WalletOperationError('INSUFFICIENT_AVAILABLE_BALANCE', 'Saldo físico disponível insuficiente.', 409);
    }

    const rows = await tx.$queryRaw<WalletOperationRow[]>(Prisma.sql`
      INSERT INTO public.wallet_operations (
        operation_code, merchant_id, store_id, type, status, currency, amount,
        source_treasury_wallet_id, idempotency_key, request_hash,
        external_reference, metadata
      ) VALUES (
        ${operationCode('withdrawal')}, ${input.merchantId}::uuid,
        ${input.storeId ?? null}::uuid, 'withdrawal', 'pending', ${currency}, ${amount},
        ${input.treasuryWalletId}::uuid, ${input.idempotencyKey}, ${requestHash},
        ${input.externalReference ?? null}, ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING *
    `);
    const operation = rows[0];

    await tx.$executeRaw(Prisma.sql`
      UPDATE public.treasury_wallets
      SET available = available - ${amount},
          reserved = reserved + ${amount},
          updated_at = now()
      WHERE id = ${wallet.id}::uuid
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO public.treasury_wallet_movements (
        treasury_wallet_id, merchant_id, direction, type, amount, currency,
        status, reference, idempotency_key, wallet_operation_id, metadata
      ) VALUES (
        ${wallet.id}::uuid, ${input.merchantId}::uuid, 'out', 'withdrawal',
        ${amount}, ${currency}, 'draft', ${operation.operation_code},
        ${`wallet-op:${input.idempotencyKey}`}, ${operation.id}::uuid,
        ${JSON.stringify({ reserved: true, ...(input.metadata ?? {}) })}::jsonb
      )
    `);

    await addEvent(
      tx,
      operation.id,
      input.merchantId,
      'withdrawal_reserved',
      null,
      'pending',
      'merchant',
      input.merchantId,
      { treasuryWalletId: wallet.id, amount, currency }
    );

    return serializeOperation(operation);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

export const createDepositOperation = async (input: {
  merchantId: string;
  treasuryWalletId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  storeId?: string | null;
  externalReference?: string | null;
  metadata?: JsonRecord;
}) => {
  const currency = normalizeCurrency(input.currency);
  const amount = amountNumber(input.amount);
  const requestHash = hashRequest({
    type: 'deposit',
    treasuryWalletId: input.treasuryWalletId,
    amount,
    currency,
    storeId: input.storeId ?? null,
    externalReference: input.externalReference ?? null
  });

  return prisma.$transaction(async tx => {
    const existing = await findExistingByIdempotency(
      tx,
      input.merchantId,
      input.idempotencyKey,
      requestHash
    );
    if (existing) return serializeOperation(existing);

    const wallet = await lockTreasuryWallet(tx, input.merchantId, input.treasuryWalletId);
    requireBankSettlementWallet(wallet);
    if (wallet.currency !== currency) {
      throw new WalletOperationError('CURRENCY_MISMATCH', 'A moeda da operação não corresponde à Wallet.', 409);
    }

    const rows = await tx.$queryRaw<WalletOperationRow[]>(Prisma.sql`
      INSERT INTO public.wallet_operations (
        operation_code, merchant_id, store_id, type, status, currency, amount,
        destination_treasury_wallet_id, idempotency_key, request_hash,
        external_reference, metadata
      ) VALUES (
        ${operationCode('deposit')}, ${input.merchantId}::uuid,
        ${input.storeId ?? null}::uuid, 'deposit', 'pending', ${currency}, ${amount},
        ${input.treasuryWalletId}::uuid, ${input.idempotencyKey}, ${requestHash},
        ${input.externalReference ?? null}, ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING *
    `);
    const operation = rows[0];

    await addEvent(
      tx,
      operation.id,
      input.merchantId,
      'deposit_requested',
      null,
      'pending',
      'merchant',
      input.merchantId,
      { treasuryWalletId: wallet.id, amount, currency }
    );

    return serializeOperation(operation);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

export const createTransferOperation = async (input: {
  merchantId: string;
  sourceTreasuryWalletId: string;
  destinationTreasuryWalletId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  storeId?: string | null;
  metadata?: JsonRecord;
}) => {
  const currency = normalizeCurrency(input.currency);
  const amount = amountNumber(input.amount);
  if (input.sourceTreasuryWalletId === input.destinationTreasuryWalletId) {
    throw new WalletOperationError('SAME_WALLET_TRANSFER', 'Origem e destino devem ser diferentes.');
  }

  const requestHash = hashRequest({
    type: 'transfer',
    sourceTreasuryWalletId: input.sourceTreasuryWalletId,
    destinationTreasuryWalletId: input.destinationTreasuryWalletId,
    amount,
    currency,
    storeId: input.storeId ?? null
  });

  return prisma.$transaction(async tx => {
    const existing = await findExistingByIdempotency(
      tx,
      input.merchantId,
      input.idempotencyKey,
      requestHash
    );
    if (existing) return serializeOperation(existing);

    const locked = await tx.$queryRaw<TreasuryWalletRow[]>(Prisma.sql`
      SELECT id, merchant_id, code, currency, wallet_role, status,
             balance, available, reserved, metadata
      FROM public.treasury_wallets
      WHERE merchant_id = ${input.merchantId}::uuid
        AND id IN (${input.sourceTreasuryWalletId}::uuid, ${input.destinationTreasuryWalletId}::uuid)
      ORDER BY id
      FOR UPDATE
    `);

    const source = locked.find(wallet => wallet.id === input.sourceTreasuryWalletId);
    const destination = locked.find(wallet => wallet.id === input.destinationTreasuryWalletId);
    if (!source || !destination) {
      throw new WalletOperationError('TREASURY_WALLET_NOT_FOUND', 'Wallet física de origem ou destino não encontrada.', 404);
    }
    if (source.status !== 'active' || destination.status !== 'active') {
      throw new WalletOperationError('TREASURY_WALLET_INACTIVE', 'Origem e destino devem estar ativos.', 409);
    }
    if (source.currency !== currency || destination.currency !== currency) {
      throw new WalletOperationError('CURRENCY_MISMATCH', 'Transferências V3 exigem Wallets na mesma moeda.', 409);
    }
    if (Number(source.available) < amount || Number(source.balance) < amount) {
      throw new WalletOperationError('INSUFFICIENT_AVAILABLE_BALANCE', 'Saldo físico disponível insuficiente.', 409);
    }

    const rows = await tx.$queryRaw<WalletOperationRow[]>(Prisma.sql`
      INSERT INTO public.wallet_operations (
        operation_code, merchant_id, store_id, type, status, currency, amount,
        source_treasury_wallet_id, destination_treasury_wallet_id,
        idempotency_key, request_hash, metadata, completed_at
      ) VALUES (
        ${operationCode('transfer')}, ${input.merchantId}::uuid,
        ${input.storeId ?? null}::uuid, 'transfer', 'completed', ${currency}, ${amount},
        ${source.id}::uuid, ${destination.id}::uuid,
        ${input.idempotencyKey}, ${requestHash}, ${JSON.stringify(input.metadata ?? {})}::jsonb, now()
      )
      RETURNING *
    `);
    const operation = rows[0];

    await tx.$executeRaw(Prisma.sql`
      UPDATE public.treasury_wallets
      SET balance = balance - ${amount},
          available = available - ${amount},
          updated_at = now()
      WHERE id = ${source.id}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE public.treasury_wallets
      SET balance = balance + ${amount},
          available = available + ${amount},
          updated_at = now()
      WHERE id = ${destination.id}::uuid
    `);

    for (const movement of [
      { walletId: source.id, direction: 'out' },
      { walletId: destination.id, direction: 'in' }
    ] as const) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO public.treasury_wallet_movements (
          treasury_wallet_id, merchant_id, direction, type, amount, currency,
          status, reference, idempotency_key, wallet_operation_id, confirmed_by,
          confirmed_at, metadata
        ) VALUES (
          ${movement.walletId}::uuid, ${input.merchantId}::uuid, ${movement.direction},
          'transfer', ${amount}, ${currency}, 'confirmed', ${operation.operation_code},
          ${`wallet-op:${input.idempotencyKey}:${movement.direction}`}, ${operation.id}::uuid,
          'system', now(), ${JSON.stringify(input.metadata ?? {})}::jsonb
        )
      `);
    }

    await addEvent(
      tx,
      operation.id,
      input.merchantId,
      'transfer_completed',
      null,
      'completed',
      'system',
      null,
      { sourceTreasuryWalletId: source.id, destinationTreasuryWalletId: destination.id, amount, currency }
    );

    return serializeOperation(operation);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

export const listWalletOperations = async (input: {
  merchantId: string;
  status?: WalletOperationStatus;
  type?: WalletOperationType;
  limit?: number;
}) => {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const rows = await prisma.$queryRaw<WalletOperationRow[]>(Prisma.sql`
    SELECT *
    FROM public.wallet_operations
    WHERE merchant_id = ${input.merchantId}::uuid
      AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
      AND (${input.type ?? null}::text IS NULL OR type = ${input.type ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return rows.map(serializeOperation);
};

export const getWalletOperation = async (merchantId: string, operationId: string) => {
  const rows = await prisma.$queryRaw<WalletOperationRow[]>(Prisma.sql`
    SELECT *
    FROM public.wallet_operations
    WHERE id = ${operationId}::uuid
      AND merchant_id = ${merchantId}::uuid
    LIMIT 1
  `);
  const operation = rows[0];
  if (!operation) {
    throw new WalletOperationError('OPERATION_NOT_FOUND', 'Operação não encontrada.', 404);
  }

  const events = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT id, event_type, from_status, to_status, actor_type, actor_id, metadata, created_at
    FROM public.wallet_operation_events
    WHERE operation_id = ${operationId}::uuid
      AND merchant_id = ${merchantId}::uuid
    ORDER BY created_at ASC
  `);

  return { ...serializeOperation(operation), events };
};

export const transitionWalletOperation = async (input: {
  operationId: string;
  targetStatus: Exclude<WalletOperationStatus, 'pending' | 'reversed'>;
  actorType: 'admin' | 'system' | 'provider';
  actorId?: string | null;
  failureReason?: string | null;
  externalReference?: string | null;
  metadata?: JsonRecord;
}) => prisma.$transaction(async tx => {
  const rows = await tx.$queryRaw<WalletOperationRow[]>(Prisma.sql`
    SELECT *
    FROM public.wallet_operations
    WHERE id = ${input.operationId}::uuid
    FOR UPDATE
  `);
  const operation = rows[0];
  if (!operation) {
    throw new WalletOperationError('OPERATION_NOT_FOUND', 'Operação não encontrada.', 404);
  }
  if (operation.status === 'completed' || operation.status === 'cancelled' || operation.status === 'failed') {
    throw new WalletOperationError('TERMINAL_OPERATION', 'A operação já está em estado terminal.', 409);
  }

  const allowed: Record<string, WalletOperationStatus[]> = {
    pending: ['processing', 'completed', 'failed', 'cancelled'],
    processing: ['completed', 'failed', 'cancelled']
  };
  if (!allowed[operation.status]?.includes(input.targetStatus)) {
    throw new WalletOperationError('INVALID_STATUS_TRANSITION', 'Transição de estado inválida.', 409);
  }

  const amount = Number(operation.amount);

  if (operation.type === 'withdrawal' && operation.source_treasury_wallet_id) {
    const wallet = await lockTreasuryWallet(tx, operation.merchant_id, operation.source_treasury_wallet_id);

    if (input.targetStatus === 'completed') {
      if (Number(wallet.reserved) < amount || Number(wallet.balance) < amount) {
        throw new WalletOperationError('RESERVATION_MISMATCH', 'Reserva física inconsistente para concluir o saque.', 409);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE public.treasury_wallets
        SET balance = balance - ${amount}, reserved = reserved - ${amount}, updated_at = now()
        WHERE id = ${wallet.id}::uuid
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE public.treasury_wallet_movements
        SET status = 'confirmed', confirmed_by = ${input.actorId ?? input.actorType}, confirmed_at = now(), updated_at = now()
        WHERE wallet_operation_id = ${operation.id}::uuid
      `);
    } else if (input.targetStatus === 'failed' || input.targetStatus === 'cancelled') {
      if (Number(wallet.reserved) < amount) {
        throw new WalletOperationError('RESERVATION_MISMATCH', 'Reserva física inconsistente para libertar o saque.', 409);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE public.treasury_wallets
        SET available = available + ${amount}, reserved = reserved - ${amount}, updated_at = now()
        WHERE id = ${wallet.id}::uuid
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE public.treasury_wallet_movements
        SET status = 'cancelled', updated_at = now()
        WHERE wallet_operation_id = ${operation.id}::uuid
      `);
    }
  }

  if (operation.type === 'deposit' && operation.destination_treasury_wallet_id && input.targetStatus === 'completed') {
    const wallet = await lockTreasuryWallet(tx, operation.merchant_id, operation.destination_treasury_wallet_id);
    await tx.$executeRaw(Prisma.sql`
      UPDATE public.treasury_wallets
      SET balance = balance + ${amount}, available = available + ${amount}, updated_at = now()
      WHERE id = ${wallet.id}::uuid
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO public.treasury_wallet_movements (
        treasury_wallet_id, merchant_id, direction, type, amount, currency,
        status, reference, idempotency_key, wallet_operation_id,
        confirmed_by, confirmed_at, metadata
      ) VALUES (
        ${wallet.id}::uuid, ${operation.merchant_id}::uuid, 'in', 'deposit',
        ${amount}, ${operation.currency}, 'confirmed', ${operation.operation_code},
        ${`wallet-op:${operation.idempotency_key}:complete`}, ${operation.id}::uuid,
        ${input.actorId ?? input.actorType}, now(), ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
    `);
  }

  const updatedRows = await tx.$queryRaw<WalletOperationRow[]>(Prisma.sql`
    UPDATE public.wallet_operations
    SET status = ${input.targetStatus},
        failure_reason = ${input.failureReason ?? null},
        external_reference = COALESCE(${input.externalReference ?? null}, external_reference),
        metadata = metadata || ${JSON.stringify(input.metadata ?? {})}::jsonb,
        completed_at = CASE WHEN ${input.targetStatus} = 'completed' THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = ${operation.id}::uuid
    RETURNING *
  `);
  const updated = updatedRows[0];

  await addEvent(
    tx,
    operation.id,
    operation.merchant_id,
    `operation_${input.targetStatus}`,
    operation.status,
    input.targetStatus,
    input.actorType,
    input.actorId ?? null,
    input.metadata ?? {}
  );

  return serializeOperation(updated);
}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
