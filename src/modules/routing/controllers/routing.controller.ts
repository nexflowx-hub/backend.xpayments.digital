import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../../middleware/auth.middleware';
import {
  RoutingPolicyError,
  listProviderConnectionsSafe,
  listRoutingDecisions,
  listRoutingPolicies,
  upsertRoutingPolicy
} from '../services/routing-policy.service';

const uuid = z.string().uuid();
const querySchema = z.object({
  storeId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const candidateSchema = z.object({
  connectionId: uuid,
  enabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(100000).optional(),
  weight: z.coerce.number().min(0).max(100000).optional(),
  minAmountMinor: z.coerce.number().int().min(0).optional(),
  maxAmountMinor: z.coerce.number().int().positive().optional()
});

const policySchema = z.object({
  storeId: uuid,
  method: z.string().trim().min(1).max(50),
  currency: z.string().trim().min(3).max(10),
  strategy: z.enum(['priority_failover', 'weighted', 'manual']),
  activationMode: z.enum(['shadow', 'enforce']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  candidates: z.array(candidateSchema).min(1).max(20)
});

const merchantIdOf = (req: AuthRequest): string | null =>
  req.merchantId || req.user?.id || null;

const sendError = (res: Response, error: unknown) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Parâmetros inválidos.', details: error.issues }
    });
  }
  if (error instanceof RoutingPolicyError) {
    return res.status(error.httpStatus).json({
      success: false,
      error: { code: error.code, message: error.message }
    });
  }
  console.error('[ROUTING_CONTROL_PLANE_ERROR]', error);
  return res.status(500).json({
    success: false,
    error: { code: 'ROUTING_CONTROL_PLANE_ERROR', message: 'Falha ao processar a configuração de routing.' }
  });
};

const requireMerchant = (req: AuthRequest, res: Response): string | null => {
  const merchantId = merchantIdOf(req);
  if (!merchantId) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Merchant não autenticado.' }
    });
    return null;
  }
  return merchantId;
};

export const getConnections = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = requireMerchant(req, res);
    if (!merchantId) return;
    const { storeId } = querySchema.parse(req.query);
    const data = await listProviderConnectionsSafe(merchantId, storeId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getPolicies = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = requireMerchant(req, res);
    if (!merchantId) return;
    const { storeId } = querySchema.parse(req.query);
    const data = await listRoutingPolicies(merchantId, storeId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
};

export const putPolicy = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = requireMerchant(req, res);
    if (!merchantId) return;
    const body = policySchema.parse(req.body);
    const data = await upsertRoutingPolicy({ merchantId, ...body });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getDecisions = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = requireMerchant(req, res);
    if (!merchantId) return;
    const { storeId, limit } = querySchema.parse(req.query);
    const data = await listRoutingDecisions(merchantId, storeId, limit ?? 50);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
};
