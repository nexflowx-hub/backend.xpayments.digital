import { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import prisma from '../../../core/prisma';

export type ControlPlaneRole =
  | 'SUPER_ADMIN'
  | 'OPERATIONS'
  | 'FINANCE'
  | 'RISK'
  | 'SUPPORT'
  | 'EXPERT_OPS'
  | 'READ_ONLY';

export interface ControlPlaneIdentity {
  userId: string;
  email: string;
  name: string;
  role: ControlPlaneRole;
  permissions: Record<string, boolean>;
  sessionId: string;
}

export interface ControlPlaneRequest extends Request {
  controlPlane?: ControlPlaneIdentity;
}

const ROLE_DEFAULT_PERMISSIONS: Record<ControlPlaneRole, string[]> = {
  SUPER_ADMIN: ['*'],
  OPERATIONS: [
    'overview.read', 'merchants.read', 'stores.read', 'transactions.read',
    'processing.read', 'payouts.read', 'expert.read', 'audit.read'
  ],
  FINANCE: [
    'overview.read', 'merchants.read', 'stores.read', 'transactions.read',
    'fees.read', 'payouts.read', 'audit.read'
  ],
  RISK: [
    'overview.read', 'merchants.read', 'stores.read', 'transactions.read',
    'processing.read', 'audit.read'
  ],
  SUPPORT: [
    'overview.read', 'merchants.read', 'stores.read', 'transactions.read',
    'expert.read'
  ],
  EXPERT_OPS: ['overview.read', 'merchants.read', 'expert.read', 'audit.read'],
  READ_ONLY: [
    'overview.read', 'merchants.read', 'stores.read', 'transactions.read',
    'processing.read', 'fees.read', 'payouts.read', 'expert.read'
  ]
};

const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

const normalizePermissions = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, enabled]) => [key, enabled === true])
  );
};

export const hasControlPlanePermission = (
  identity: ControlPlaneIdentity,
  permission: string
): boolean => {
  if (identity.role === 'SUPER_ADMIN') return true;
  if (identity.permissions[permission] === true || identity.permissions['*'] === true) return true;
  return (ROLE_DEFAULT_PERMISSIONS[identity.role] || []).includes(permission);
};

export const controlPlaneAuthMiddleware = async (
  req: ControlPlaneRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const header = String(req.headers.authorization || '').trim();
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: { code: 'CONTROL_PLANE_UNAUTHORIZED', message: 'Autenticação interna necessária.' }
      });
    }

    const token = header.slice(7).trim();
    if (!token || token.length < 32) {
      return res.status(401).json({
        success: false,
        error: { code: 'CONTROL_PLANE_UNAUTHORIZED', message: 'Sessão interna inválida.' }
      });
    }

    const tokenHash = sha256(token);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `
      select
        s.id as session_id,
        u.id as user_id,
        u.email,
        u.name,
        u.role,
        u.permissions
      from control_plane_sessions s
      join control_plane_users u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and u.status = 'active'
      limit 1
      `,
      tokenHash
    );

    const row = rows[0];
    if (!row) {
      return res.status(401).json({
        success: false,
        error: { code: 'CONTROL_PLANE_SESSION_EXPIRED', message: 'Sessão interna expirada ou revogada.' }
      });
    }

    req.controlPlane = {
      userId: String(row.user_id),
      email: String(row.email),
      name: String(row.name),
      role: String(row.role) as ControlPlaneRole,
      permissions: normalizePermissions(row.permissions),
      sessionId: String(row.session_id)
    };

    void prisma.$executeRawUnsafe(
      `update control_plane_sessions set last_seen_at = now() where id = $1::uuid`,
      req.controlPlane.sessionId
    ).catch(() => undefined);

    return next();
  } catch (error) {
    console.error('[control-plane.auth]', error);
    return res.status(500).json({
      success: false,
      error: { code: 'CONTROL_PLANE_AUTH_ERROR', message: 'Falha ao validar sessão interna.' }
    });
  }
};

export const requireControlPlanePermission = (permission: string) =>
  (req: ControlPlaneRequest, res: Response, next: NextFunction) => {
    const identity = req.controlPlane;
    if (!identity) {
      return res.status(401).json({
        success: false,
        error: { code: 'CONTROL_PLANE_UNAUTHORIZED', message: 'Autenticação interna necessária.' }
      });
    }

    if (!hasControlPlanePermission(identity, permission)) {
      return res.status(403).json({
        success: false,
        error: { code: 'CONTROL_PLANE_FORBIDDEN', message: 'Permissão insuficiente para esta operação.' }
      });
    }

    return next();
  };
