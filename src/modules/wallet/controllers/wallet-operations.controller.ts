import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../../middleware/auth.middleware';
import {
  WalletOperationError,
  createDepositOperation,
  createTransferOperation,
  createWithdrawalOperation,
  getWalletOperation,
  listWalletOperations
} from '../services/wallet-operations.service';

const uuid = z.string().uuid();
const currency = z.string().trim().min(3).max(10).transform(value => value.toUpperCase());
const amount = z.coerce.number().positive().max(999999999999.99);
const metadata = z.record(z.string(), z.unknown()).optional();

const withdrawalSchema = z.object({
  treasuryWalletId: uuid,
  amount,
  currency,
  storeId: uuid.nullish(),
  externalReference: z.string().trim().max(200).nullish(),
  metadata
});

const depositSchema = withdrawalSchema;

const transferSchema = z.object({
  sourceTreasuryWalletId: uuid,
  destinationTreasuryWalletId: uuid,
  amount,
  currency,
  storeId: uuid.nullish(),
  metadata
});

const listSchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'reversed', 'cancelled']).optional(),
  type: z.enum(['deposit', 'transfer', 'withdrawal']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const merchantIdOf = (req: AuthRequest): string | null =>
  req.merchantId || req.user?.id || null;

const idempotencyKeyOf = (req: AuthRequest): string =>
  String(req.header('Idempotency-Key') ?? '').trim();

const requireContext = (req: AuthRequest, res: Response): { merchantId: string; idempotencyKey: string } | null => {
  const merchantId = merchantIdOf(req);
  if (!merchantId) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    return null;
  }
  const idempotencyKey = idempotencyKeyOf(req);
  if (!idempotencyKey || idempotencyKey.length > 200) {
    res.status(400).json({
      success: false,
      error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Envie um header Idempotency-Key válido.' }
    });
    return null;
  }
  return { merchantId, idempotencyKey };
};

const sendError = (res: Response, error: unknown) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Payload inválido.', details: error.issues }
    });
  }
  if (error instanceof WalletOperationError) {
    return res.status(error.httpStatus).json({
      success: false,
      error: { code: error.code, message: error.message }
    });
  }
  console.error('[WALLET_OPERATION_ERROR]', error);
  return res.status(500).json({
    success: false,
    error: { code: 'WALLET_OPERATION_ERROR', message: 'Falha ao processar a operação da Wallet.' }
  });
};

export const postWithdrawal = async (req: AuthRequest, res: Response) => {
  try {
    const context = requireContext(req, res);
    if (!context) return;
    const body = withdrawalSchema.parse(req.body);
    const operation = await createWithdrawalOperation({
      merchantId: context.merchantId,
      idempotencyKey: context.idempotencyKey,
      treasuryWalletId: body.treasuryWalletId,
      amount: body.amount,
      currency: body.currency,
      storeId: body.storeId,
      externalReference: body.externalReference,
      metadata: body.metadata
    });
    return res.status(201).json({ success: true, data: operation });
  } catch (error) {
    return sendError(res, error);
  }
};

export const postDeposit = async (req: AuthRequest, res: Response) => {
  try {
    const context = requireContext(req, res);
    if (!context) return;
    const body = depositSchema.parse(req.body);
    const operation = await createDepositOperation({
      merchantId: context.merchantId,
      idempotencyKey: context.idempotencyKey,
      treasuryWalletId: body.treasuryWalletId,
      amount: body.amount,
      currency: body.currency,
      storeId: body.storeId,
      externalReference: body.externalReference,
      metadata: body.metadata
    });
    return res.status(201).json({ success: true, data: operation });
  } catch (error) {
    return sendError(res, error);
  }
};

export const postTransfer = async (req: AuthRequest, res: Response) => {
  try {
    const context = requireContext(req, res);
    if (!context) return;
    const body = transferSchema.parse(req.body);
    const operation = await createTransferOperation({
      merchantId: context.merchantId,
      idempotencyKey: context.idempotencyKey,
      sourceTreasuryWalletId: body.sourceTreasuryWalletId,
      destinationTreasuryWalletId: body.destinationTreasuryWalletId,
      amount: body.amount,
      currency: body.currency,
      storeId: body.storeId,
      metadata: body.metadata
    });
    return res.status(201).json({ success: true, data: operation });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getOperations = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdOf(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }
    const query = listSchema.parse(req.query);
    const operations = await listWalletOperations({ merchantId, ...query });
    return res.status(200).json({ success: true, data: operations });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getOperationById = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdOf(req);
    if (!merchantId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' } });
    }
    const operationId = uuid.parse(req.params.id);
    const operation = await getWalletOperation(merchantId, operationId);
    return res.status(200).json({ success: true, data: operation });
  } catch (error) {
    return sendError(res, error);
  }
};
