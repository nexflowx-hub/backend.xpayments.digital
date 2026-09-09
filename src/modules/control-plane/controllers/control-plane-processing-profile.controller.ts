import { Response } from 'express';
import prisma from '../../../core/prisma';
import { ControlPlaneRequest } from '../middleware/control-plane-auth.middleware';
import { writeControlPlaneAudit } from '../services/control-plane-audit.service';

const RUNTIME_GENERATIONS = new Set(['LEGACY', 'VNEXT']);
const PROCESSING_MODES = new Set(['ORCHESTRATED', 'OBSERVED']);
const ACTIVATION_STATES = new Set(['DRAFT', 'SHADOW', 'VALIDATED', 'READY', 'ACTIVE', 'ROLLED_BACK', 'DISABLED']);

const text = (value: unknown, max = 4000) => String(value ?? '').trim().slice(0, max);
const uuid = (value: unknown) => text(value, 80) || null;
const bool = (value: unknown, fallback = false) =>
  value === undefined ? fallback : value === true || String(value).toLowerCase() === 'true';
const jsonObj = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function normalizeRuntime(value: unknown, fallback = 'VNEXT') {
  const raw = text(value || fallback, 80).toUpperCase();
  if (raw === 'V1') return 'VNEXT';
  return raw;
}

export async function upsertProcessingProfileSafe(req: ControlPlaneRequest, res: Response) {
  try {
    const storeId = text(req.params.storeId, 80);
    const stores = await prisma.$queryRawUnsafe<any[]>(
      `select * from stores where id=$1::uuid limit 1`,
      storeId
    );
    const store = stores[0];
    if (!store) {
      return res.status(404).json({
        success: false,
        error: { code: 'STORE_NOT_FOUND', message: 'Store não encontrada.' }
      });
    }

    const before = (await prisma.$queryRawUnsafe<any[]>(
      `select * from store_processing_profiles where store_id=$1::uuid order by updated_at desc limit 1`,
      storeId
    ))[0];

    const runtimeGeneration = normalizeRuntime(
      req.body?.runtimeGeneration,
      before?.runtime_generation || 'VNEXT'
    );
    const processingMode = req.body?.processingMode === undefined
      ? (before?.processing_mode ?? null)
      : (text(req.body.processingMode, 80).toUpperCase() || null);
    const activationState = text(
      req.body?.activationState || before?.activation_state || 'ACTIVE',
      80
    ).toUpperCase();

    if (!RUNTIME_GENERATIONS.has(runtimeGeneration)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'RUNTIME_GENERATION_INVALID',
          message: 'runtimeGeneration deve ser LEGACY ou VNEXT.'
        }
      });
    }
    if (processingMode !== null && !PROCESSING_MODES.has(processingMode)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'PROCESSING_MODE_INVALID',
          message: 'processingMode deve ser ORCHESTRATED ou OBSERVED.'
        }
      });
    }
    if (!ACTIVATION_STATES.has(activationState)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ACTIVATION_STATE_INVALID',
          message: 'activationState inválido.'
        }
      });
    }

    const connectionId = uuid(req.body?.providerConnectionId);
    if (connectionId) {
      const connections = await prisma.$queryRawUnsafe<any[]>(
        `select * from provider_connections where id=$1::uuid limit 1`,
        connectionId
      );
      const connection = connections[0];
      if (
        !connection ||
        String(connection.store_id) !== storeId ||
        String(connection.merchant_id) !== String(store.merchant_id)
      ) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'CONNECTION_STORE_MISMATCH',
            message: 'Connection não pertence à Store.'
          }
        });
      }
    }

    let rows: any[];
    if (before) {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `update store_processing_profiles
         set runtime_generation=$2,
             processing_mode=$3,
             activation_state=$4,
             provider_connection_id=$5::uuid,
             effective_from=$6::timestamptz,
             legacy_compatibility=$7,
             metadata=$8::jsonb,
             updated_at=now()
         where id=$1::uuid
         returning *`,
        String(before.id),
        runtimeGeneration,
        processingMode,
        activationState,
        connectionId,
        req.body?.effectiveFrom
          ? text(req.body.effectiveFrom, 80)
          : (before.effective_from || new Date().toISOString()),
        req.body?.legacyCompatibility === undefined
          ? before.legacy_compatibility
          : bool(req.body.legacyCompatibility),
        JSON.stringify(
          req.body?.metadata === undefined ? (before.metadata || {}) : jsonObj(req.body.metadata)
        )
      );
    } else {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `insert into store_processing_profiles(
           merchant_id,store_id,runtime_generation,processing_mode,activation_state,
           provider_connection_id,effective_from,legacy_compatibility,metadata
         ) values(
           $1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::timestamptz,$8,$9::jsonb
         ) returning *`,
        String(store.merchant_id),
        storeId,
        runtimeGeneration,
        processingMode,
        activationState,
        connectionId,
        text(req.body?.effectiveFrom || new Date().toISOString(), 80),
        bool(req.body?.legacyCompatibility, false),
        JSON.stringify(jsonObj(req.body?.metadata))
      );
    }

    await writeControlPlaneAudit({
      actorUserId: req.controlPlane?.userId || null,
      action: before ? 'PROCESSING_PROFILE_UPDATED' : 'PROCESSING_PROFILE_CREATED',
      entityType: 'store_processing_profile',
      entityId: String(rows[0].id),
      beforeData: before,
      afterData: rows[0],
      metadata: {
        normalizedRuntimeAlias: text(req.body?.runtimeGeneration, 80).toUpperCase() === 'V1' ? 'V1->VNEXT' : null
      },
      req
    });

    return res.json({ success: true, data: { processingProfile: rows[0] } });
  } catch (error: any) {
    console.error('[cp.profile.upsert.safe]', error?.message || error);
    return res.status(500).json({
      success: false,
      error: { code: 'UPSERT_ERROR', message: 'Falha ao configurar processing profile.' }
    });
  }
}
