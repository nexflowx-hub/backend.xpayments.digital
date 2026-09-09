import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import prisma from '../../../core/prisma';
import { ControlPlaneRequest } from '../middleware/control-plane-auth.middleware';
import { writeControlPlaneAudit } from '../services/control-plane-audit.service';

const SESSION_HOURS = 12;

const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

const safePermissions = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, enabled]) => [key, enabled === true])
  );
};

export const loginControlPlane = async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Email e password são obrigatórios.' }
      });
    }

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `
      select id, email, name, password_hash, role, permissions, status
      from control_plane_users
      where lower(email) = $1
      limit 1
      `,
      email
    );

    const user = rows[0];
    const valid = user && user.status === 'active' && await bcrypt.compare(password, String(user.password_hash));

    if (!valid) {
      await writeControlPlaneAudit({
        actorUserId: null,
        action: 'CONTROL_PLANE_LOGIN_FAILED',
        entityType: 'control_plane_user',
        metadata: { email },
        req
      });
      return res.status(401).json({
        success: false,
        error: { code: 'CONTROL_PLANE_LOGIN_FAILED', message: 'Credenciais inválidas.' }
      });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);

    const sessionRows = await prisma.$queryRawUnsafe<any[]>(
      `
      insert into control_plane_sessions (
        user_id, token_hash, expires_at, ip_address, user_agent
      ) values (
        $1::uuid, $2, $3::timestamptz, $4, $5
      )
      returning id
      `,
      String(user.id),
      tokenHash,
      expiresAt.toISOString(),
      req.ip || null,
      String(req.headers['user-agent'] || '').slice(0, 500) || null
    );

    await prisma.$executeRawUnsafe(
      `update control_plane_users set last_login_at = now() where id = $1::uuid`,
      String(user.id)
    );

    await writeControlPlaneAudit({
      actorUserId: String(user.id),
      action: 'CONTROL_PLANE_LOGIN_SUCCEEDED',
      entityType: 'control_plane_session',
      entityId: String(sessionRows[0]?.id || ''),
      metadata: { expiresAt: expiresAt.toISOString() },
      req
    });

    return res.status(200).json({
      success: true,
      data: {
        token,
        expiresAt: expiresAt.toISOString(),
        user: {
          id: String(user.id),
          email: String(user.email),
          name: String(user.name),
          role: String(user.role),
          permissions: safePermissions(user.permissions)
        }
      }
    });
  } catch (error) {
    console.error('[control-plane.login]', error);
    return res.status(500).json({
      success: false,
      error: { code: 'CONTROL_PLANE_LOGIN_ERROR', message: 'Não foi possível iniciar a sessão interna.' }
    });
  }
};

export const getControlPlaneMe = async (req: ControlPlaneRequest, res: Response) => {
  const identity = req.controlPlane!;
  return res.json({
    success: true,
    data: {
      user: {
        id: identity.userId,
        email: identity.email,
        name: identity.name,
        role: identity.role,
        permissions: identity.permissions
      },
      sessionId: identity.sessionId
    }
  });
};

export const logoutControlPlane = async (req: ControlPlaneRequest, res: Response) => {
  try {
    const identity = req.controlPlane!;
    await prisma.$executeRawUnsafe(
      `update control_plane_sessions set revoked_at = now() where id = $1::uuid and revoked_at is null`,
      identity.sessionId
    );

    await writeControlPlaneAudit({
      actorUserId: identity.userId,
      action: 'CONTROL_PLANE_LOGOUT',
      entityType: 'control_plane_session',
      entityId: identity.sessionId,
      req
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('[control-plane.logout]', error);
    return res.status(500).json({
      success: false,
      error: { code: 'CONTROL_PLANE_LOGOUT_ERROR', message: 'Não foi possível terminar a sessão.' }
    });
  }
};
