import { Request } from 'express';
import prisma from '../../../core/prisma';

interface AuditInput {
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: Record<string, unknown>;
  req?: Request;
}

const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);

export async function writeControlPlaneAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `
      insert into control_plane_audit_logs (
        actor_user_id, action, entity_type, entity_id,
        before_data, after_data, metadata, ip_address, user_agent
      ) values (
        $1::uuid, $2, $3, $4,
        $5::jsonb, $6::jsonb, $7::jsonb, $8, $9
      )
      `,
      input.actorUserId || null,
      input.action,
      input.entityType,
      input.entityId || null,
      json(input.beforeData),
      json(input.afterData),
      JSON.stringify(input.metadata || {}),
      input.req?.ip || null,
      String(input.req?.headers['user-agent'] || '').slice(0, 500) || null
    );
  } catch (error) {
    console.error('[control-plane.audit]', error);
  }
}
