import {
  createHash,
  randomUUID
} from 'crypto';

import bcrypt from 'bcryptjs';

import {
  Prisma
} from '@prisma/client';

import {
  Response
} from 'express';

import prisma from
  '../../../core/prisma';

import {
  AuthRequest
} from
  '../../../middleware/auth.middleware';

type DatabaseRow =
  Record<string, any>;

type QueryClient =
  Pick<
    Prisma.TransactionClient,
    '$queryRawUnsafe'
  >;

type DraftAllocation = {
  releaseDate: string;
  provider: string;
  amount: number;
  position: number;
};

type FundingOption = {
  releaseDate: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  gateway: string;
  remainingAmount: number;
  movementCount: number;
  providerStatus:
    | 'available'
    | 'pending'
    | 'unknown';
  providerAvailableCount: number;
  providerPendingCount: number;
  providerUnknownCount: number;
};

type DraftPayload = {
  storeId: string;
  currency: string;
  externalReference:
    string | null;
  notes:
    string | null;
  allocations:
    DraftAllocation[];
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(
    status: number,
    code: string,
    message: string
  ) {
    super(message);

    this.status =
      status;

    this.code =
      code;
  }
}

const FINANCE_TIMEZONE =
  'Europe/Lisbon';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const datePattern =
  /^\d{4}-\d{2}-\d{2}$/;

const currencyPattern =
  /^[A-Z]{3,5}$/;

const money = (
  value: unknown
): number => {
  const parsed =
    Number(value ?? 0);

  return Number.isFinite(parsed)
    ? Math.round(
        (
          parsed +
          Number.EPSILON
        ) * 100
      ) / 100
    : 0;
};

const cents = (
  value: unknown
): number =>
  Math.round(
    money(value) * 100
  );

const civilDate = (): string =>
  new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone:
        FINANCE_TIMEZONE,

      year:
        'numeric',

      month:
        '2-digit',

      day:
        '2-digit'
    }
  ).format(
    new Date()
  );

const getMerchantId = (
  req: AuthRequest
): string | null =>
  req.merchantId ||
  req.user?.id ||
  null;

const requiredMerchantId = (
  req: AuthRequest
): string => {
  const merchantId =
    getMerchantId(req);

  if (!merchantId) {
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      'Merchant não autenticado.'
    );
  }

  return merchantId;
};

const stringOrNull = (
  value: unknown,
  maxLength: number,
  field: string
): string | null => {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ApiError(
      400,
      'INVALID_PAYLOAD',
      `${field} inválido.`
    );
  }

  const normalized =
    value.trim();

  if (!normalized) {
    return null;
  }

  if (
    normalized.length >
    maxLength
  ) {
    throw new ApiError(
      400,
      'INVALID_PAYLOAD',
      `${field} excede ${maxLength} caracteres.`
    );
  }

  return normalized;
};

const normalizeCurrency = (
  value: unknown
): string => {
  const currency =
    typeof value === 'string'
      ? value
          .trim()
          .toUpperCase()
      : 'EUR';

  if (
    !currencyPattern.test(
      currency
    )
  ) {
    throw new ApiError(
      400,
      'INVALID_CURRENCY',
      'Moeda inválida.'
    );
  }

  return currency;
};

const normalizeAllocations = (
  value: unknown
): DraftAllocation[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100
  ) {
    throw new ApiError(
      400,
      'INVALID_ALLOCATIONS',
      'Informe entre 1 e 100 liberações.'
    );
  }

  const merged =
    new Map<
      string,
      {
        releaseDate: string;
        provider: string;
        amountCents: number;
      }
    >();

  for (
    const raw of value
  ) {
    if (
      !raw ||
      typeof raw !== 'object'
    ) {
      throw new ApiError(
        400,
        'INVALID_ALLOCATIONS',
        'Linha de liberação inválida.'
      );
    }

    const allocation =
      raw as Record<
        string,
        unknown
      >;

    const releaseDate =
      typeof allocation
        .releaseDate ===
        'string'
        ? allocation
            .releaseDate
            .trim()
        : '';

    const provider =
      typeof allocation
        .provider ===
        'string'
        ? allocation
            .provider
            .trim()
        : '';

    const amountCents =
      cents(
        allocation.amount
      );

    if (
      !datePattern.test(
        releaseDate
      )
    ) {
      throw new ApiError(
        400,
        'INVALID_RELEASE_DATE',
        'Data de liberação inválida.'
      );
    }

    if (
      !provider ||
      provider.length > 120
    ) {
      throw new ApiError(
        400,
        'INVALID_PROVIDER',
        'Provider inválido.'
      );
    }

    if (amountCents <= 0) {
      throw new ApiError(
        400,
        'INVALID_ALLOCATION_AMOUNT',
        'O valor de cada dedução deve ser positivo.'
      );
    }

    const key =
      `${releaseDate}|${provider}`;

    const previous =
      merged.get(key);

    merged.set(
      key,
      {
        releaseDate,
        provider,

        amountCents:
          (
            previous
              ?.amountCents ||
            0
          ) +
          amountCents
      }
    );
  }

  return [
    ...merged.values()
  ].map(
    (
      allocation,
      position
    ) => ({
      releaseDate:
        allocation
          .releaseDate,

      provider:
        allocation.provider,

      amount:
        money(
          allocation
            .amountCents /
          100
        ),

      position
    })
  );
};

const parseDraftPayload = (
  body: unknown
): DraftPayload => {
  if (
    !body ||
    typeof body !== 'object'
  ) {
    throw new ApiError(
      400,
      'INVALID_PAYLOAD',
      'Payload inválido.'
    );
  }

  const input =
    body as Record<
      string,
      unknown
    >;

  const storeId =
    typeof input.storeId ===
      'string'
      ? input.storeId.trim()
      : '';

  if (
    !uuidPattern.test(
      storeId
    )
  ) {
    throw new ApiError(
      400,
      'INVALID_STORE',
      'Store inválida.'
    );
  }

  return {
    storeId,

    currency:
      normalizeCurrency(
        input.currency
      ),

    externalReference:
      stringOrNull(
        input.externalReference,
        180,
        'Referência'
      ),

    notes:
      stringOrNull(
        input.notes,
        2000,
        'Notas'
      ),

    allocations:
      normalizeAllocations(
        input.allocations
      )
  };
};

const loadStoreWallet =
  async (
    client: QueryClient,
    merchantId: string,
    storeId: string,
    currency: string
  ) => {
    const rows =
      await client
        .$queryRawUnsafe<
          DatabaseRow[]
        >(
          `
            SELECT
              store.id::text
                AS store_id,

              store.store_code,
              store.name
                AS store_name,

              store.status
                AS store_status,

              store.currency
                AS store_currency,

              wallet.id::text
                AS wallet_id,

              wallet.balance::text
                AS wallet_balance,

              wallet.available::text
                AS wallet_available,

              wallet.reserved::text
                AS wallet_reserved

            FROM public.stores
              AS store

            JOIN public.wallets
              AS wallet

              ON wallet.merchant_id =
                store.merchant_id

              AND upper(
                wallet.currency
              ) = $3

            WHERE store.id =
                $2::uuid

              AND store.merchant_id =
                $1::uuid

              AND store.status =
                'active'

              AND upper(
                store.currency
              ) = $3

            LIMIT 1
          `,
          merchantId,
          storeId,
          currency
        );

    if (
      rows.length !== 1
    ) {
      throw new ApiError(
        404,
        'STORE_WALLET_NOT_FOUND',
        'Store ativa ou wallet da moeda não encontrada.'
      );
    }

    return rows[0];
  };

const loadFundingOptions =
  async (
    client: QueryClient,
    merchantId: string,
    storeId: string,
    currency: string
  ): Promise<
    FundingOption[]
  > => {
    const rows =
      await client
        .$queryRawUnsafe<
          DatabaseRow[]
        >(
          `
            WITH funding AS (
              SELECT
                wallet_movement_id,

                COALESCE(
                  SUM(
                    allocated_amount
                  ),
                  0
                ) AS allocated_amount

              FROM public
                .payout_funding_allocations

              WHERE source_type =
                  'wallet_movement'

                AND wallet_movement_id
                  IS NOT NULL

              GROUP BY
                wallet_movement_id
            ),

            open_movements AS (
              SELECT
                movement.id,

                COALESCE(
                  movement
                    .manual_estimated_release_on,

                  movement
                    .provider_available_on,

                  movement
                    .system_estimated_release_on,

                  (
                    movement
                      .expected_release_at

                    AT TIME ZONE
                      'Europe/Lisbon'
                  )::date
                ) AS release_date,

                store.id
                  AS store_id,

                store.store_code,
                store.name
                  AS store_name,

                COALESCE(
                  transaction_record
                    .gateway,

                  gateway_vault
                    .provider,

                  'unknown'
                ) AS gateway,

                GREATEST(
                  GREATEST(
                    COALESCE(
                      movement
                        .merchant_net,

                      movement.amount -
                        COALESCE(
                          movement
                            .provider_fee,
                          0
                        )
                    ),
                    0
                  ) -
                  COALESCE(
                    funding
                      .allocated_amount,
                    0
                  ),
                  0
                ) AS remaining_net,

                movement
                  .provider_balance_status

              FROM public
                .wallet_movements
                  AS movement

              LEFT JOIN public
                .transactions
                  AS transaction_record

                ON (
                  transaction_record.id =
                    movement
                      .transaction_id

                  OR
                  transaction_record
                    .id::text =
                    movement.reference
                )

              LEFT JOIN public
                .stores
                  AS store

                ON store.id =
                  movement.store_id

              LEFT JOIN public
                .gateway_vaults
                  AS gateway_vault

                ON gateway_vault.id =
                  transaction_record
                    .gateway_vault_id

              LEFT JOIN funding

                ON funding
                  .wallet_movement_id =
                  movement.id

              WHERE movement
                  .merchant_id =
                  $1::uuid

                AND movement.store_id =
                  $2::uuid

                AND upper(
                  movement.currency
                ) = $3

                AND movement.direction =
                  'in'

                AND movement.type =
                  'payment'

                AND movement.status IN (
                  'pendente',
                  'disponivel'
                )

                AND COALESCE(
                  movement
                    .manual_estimated_release_on,

                  movement
                    .provider_available_on,

                  movement
                    .system_estimated_release_on,

                  (
                    movement
                      .expected_release_at

                    AT TIME ZONE
                      'Europe/Lisbon'
                  )::date
                ) IS NOT NULL
            )

            SELECT
              release_date::text,

              store_id::text,
              store_code,
              store_name,
              gateway,

              COUNT(*)::int
                AS movement_count,

              COALESCE(
                SUM(
                  remaining_net
                ),
                0
              )::text
                AS remaining_amount,

              COUNT(*) FILTER (
                WHERE lower(
                  COALESCE(
                    provider_balance_status,
                    ''
                  )
                ) = 'available'
              )::int
                AS provider_available_count,

              COUNT(*) FILTER (
                WHERE lower(
                  COALESCE(
                    provider_balance_status,
                    ''
                  )
                ) = 'pending'
              )::int
                AS provider_pending_count,

              COUNT(*) FILTER (
                WHERE
                  provider_balance_status
                    IS NULL

                  OR lower(
                    provider_balance_status
                  ) NOT IN (
                    'available',
                    'pending'
                  )
              )::int
                AS provider_unknown_count

            FROM open_movements

            WHERE remaining_net > 0

            GROUP BY
              release_date,
              store_id,
              store_code,
              store_name,
              gateway

            ORDER BY
              release_date,
              gateway
          `,
          merchantId,
          storeId,
          currency
        );

    return rows.map(
      row => {
        const movementCount =
          Number(
            row.movement_count ||
            0
          );

        const availableCount =
          Number(
            row
              .provider_available_count ||
            0
          );

        const pendingCount =
          Number(
            row
              .provider_pending_count ||
            0
          );

        const unknownCount =
          Number(
            row
              .provider_unknown_count ||
            0
          );

        const providerStatus:
          FundingOption[
            'providerStatus'
          ] =
          (
            movementCount > 0 &&
            availableCount ===
              movementCount
          )
            ? 'available'
            : pendingCount > 0
              ? 'pending'
              : 'unknown';

        return {
          releaseDate:
            String(
              row.release_date
            ).slice(0, 10),

          storeId:
            String(
              row.store_id
            ),

          storeCode:
            String(
              row.store_code ||
              ''
            ),

          storeName:
            String(
              row.store_name ||
              ''
            ),

          gateway:
            String(
              row.gateway ||
              'unknown'
            ),

          remainingAmount:
            money(
              row
                .remaining_amount
            ),

          movementCount,
          providerStatus,

          providerAvailableCount:
            availableCount,

          providerPendingCount:
            pendingCount,

          providerUnknownCount:
            unknownCount
        };
      }
    );
  };

const validateDraft =
  async (
    client: QueryClient,
    merchantId: string,
    payload: DraftPayload
  ) => {
    const storeWallet =
      await loadStoreWallet(
        client,
        merchantId,
        payload.storeId,
        payload.currency
      );

    const options =
      await loadFundingOptions(
        client,
        merchantId,
        payload.storeId,
        payload.currency
      );

    const optionMap =
      new Map(
        options.map(
          option => [
            `${option.releaseDate}|${option.gateway}`,
            option
          ]
        )
      );

    const snapshots =
      payload.allocations.map(
        allocation => {
          const key =
            `${allocation.releaseDate}|${allocation.provider}`;

          const option =
            optionMap.get(key);

          if (!option) {
            throw new ApiError(
              409,
              'FUNDING_OPTION_NOT_AVAILABLE',
              `Liberação ${allocation.releaseDate} / ${allocation.provider} indisponível.`
            );
          }

          if (
            cents(
              allocation.amount
            ) >
            cents(
              option
                .remainingAmount
            )
          ) {
            throw new ApiError(
              409,
              'ALLOCATION_EXCEEDS_RELEASE',
              `Dedução excede a liberação ${allocation.releaseDate} / ${allocation.provider}.`
            );
          }

          return {
            ...allocation,

            snapshotAvailableAmount:
              option
                .remainingAmount,

            snapshotMovementCount:
              option
                .movementCount,

            providerStatus:
              option
                .providerStatus
          };
        }
      );

    const requestedAmount =
      money(
        snapshots.reduce(
          (
            total,
            allocation
          ) =>
            total +
            allocation.amount,
          0
        )
      );

    if (
      requestedAmount <= 0
    ) {
      throw new ApiError(
        400,
        'INVALID_REQUEST_AMOUNT',
        'Valor total inválido.'
      );
    }

    const snapshotHash =
      createHash('sha256')
        .update(
          JSON.stringify(
            snapshots.map(
              allocation => ({
                releaseDate:
                  allocation
                    .releaseDate,

                provider:
                  allocation
                    .provider,

                amount:
                  allocation.amount,

                snapshotAvailableAmount:
                  allocation
                    .snapshotAvailableAmount,

                snapshotMovementCount:
                  allocation
                    .snapshotMovementCount,

                providerStatus:
                  allocation
                    .providerStatus
              })
            )
          )
        )
        .digest('hex');

    return {
      storeWallet,
      snapshots,
      requestedAmount,
      snapshotHash
    };
  };

const createRequestCode =
  (): string =>
    [
      'PRQ',
      civilDate()
        .replace(
          /-/g,
          ''
        ),
      randomUUID()
        .replace(
          /-/g,
          ''
        )
        .slice(0, 10)
        .toUpperCase()
    ].join('-');

const insertAllocations =
  async (
    tx: Prisma.TransactionClient,
    requestId: string,
    merchantId: string,
    storeId: string,
    snapshots: Array<
      DraftAllocation & {
        snapshotAvailableAmount:
          number;
        snapshotMovementCount:
          number;
        providerStatus:
          string;
      }
    >
  ) => {
    for (
      const allocation of
      snapshots
    ) {
      await tx
        .$executeRawUnsafe(
          `
            INSERT INTO public
              .payout_request_allocations (
                payout_request_id,
                merchant_id,
                store_id,
                release_date,
                provider,
                requested_amount,
                snapshot_available_amount,
                snapshot_movement_count,
                position,
                metadata
              )

            VALUES (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              $4::date,
              $5,
              $6::numeric,
              $7::numeric,
              $8::integer,
              $9::integer,
              $10::jsonb
            )
          `,
          requestId,
          merchantId,
          storeId,
          allocation.releaseDate,
          allocation.provider,
          allocation.amount,
          allocation
            .snapshotAvailableAmount,
          allocation
            .snapshotMovementCount,
          allocation.position,
          JSON.stringify({
            providerStatusAtSnapshot:
              allocation
                .providerStatus,

            noFinancialImpact:
              true
          })
        );
    }
  };

const insertEvent =
  async (
    tx: Prisma.TransactionClient,
    input: {
      requestId: string;
      merchantId: string;
      actorMerchantId:
        string | null;
      eventType: string;
      fromStatus:
        string | null;
      toStatus:
        string | null;
      req: AuthRequest;
      payload?:
        Record<
          string,
          unknown
        >;
    }
  ) => {
    await tx
      .$executeRawUnsafe(
        `
          INSERT INTO public
            .payout_request_events (
              payout_request_id,
              merchant_id,
              actor_merchant_id,
              event_type,
              from_status,
              to_status,
              ip_address,
              user_agent,
              payload
            )

          VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9::jsonb
          )
        `,
        input.requestId,
        input.merchantId,
        input.actorMerchantId,
        input.eventType,
        input.fromStatus,
        input.toStatus,
        input.req.ip ||
          null,
        input.req.get(
          'user-agent'
        ) ||
          null,
        JSON.stringify(
          input.payload ||
          {}
        )
      );
  };

const fetchRequestById =
  async (
    client: QueryClient,
    merchantId: string,
    requestId: string
  ) => {
    const rows =
      await client
        .$queryRawUnsafe<
          DatabaseRow[]
        >(
          `
            SELECT
              request.id::text,
              request.request_code,
              request.currency,
              request.status,
              request.requested_amount::text,
              request.external_reference,
              request.notes,
              request.snapshot_hash,
              request.version,
              request.requested_at,
              request.confirmed_at,
              request.deleted_at,
              request.created_at,
              request.updated_at,

              store.id::text
                AS store_id,

              store.store_code,
              store.name
                AS store_name,

              wallet.id::text
                AS wallet_id,

              request
                .confirmed_payout_statement_id::text,

              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'id',
                    allocation.id,

                    'releaseDate',
                    allocation
                      .release_date,

                    'provider',
                    allocation.provider,

                    'amount',
                    allocation
                      .requested_amount,

                    'snapshotAvailableAmount',
                    allocation
                      .snapshot_available_amount,

                    'snapshotMovementCount',
                    allocation
                      .snapshot_movement_count,

                    'position',
                    allocation.position,

                    'metadata',
                    allocation.metadata
                  )

                  ORDER BY
                    allocation.position,
                    allocation.created_at
                ) FILTER (
                  WHERE allocation.id
                    IS NOT NULL
                ),
                '[]'::jsonb
              ) AS allocations

            FROM public
              .payout_requests
                AS request

            JOIN public.stores
              AS store

              ON store.id =
                request.store_id

            JOIN public.wallets
              AS wallet

              ON wallet.id =
                request.wallet_id

            LEFT JOIN public
              .payout_request_allocations
                AS allocation

              ON allocation
                .payout_request_id =
                request.id

            WHERE request.id =
                $2::uuid

              AND request.merchant_id =
                $1::uuid

              AND request.deleted_at
                IS NULL

            GROUP BY
              request.id,
              store.id,
              wallet.id
          `,
          merchantId,
          requestId
        );

    return rows[0] ||
      null;
  };

const serializeRequest = (
  row: DatabaseRow
) => ({
  id:
    row.id,

  requestCode:
    row.request_code,

  store: {
    id:
      row.store_id,

    code:
      row.store_code,

    name:
      row.store_name
  },

  walletId:
    row.wallet_id,

  currency:
    row.currency,

  status:
    row.status,

  requestedAmount:
    money(
      row.requested_amount
    ),

  externalReference:
    row.external_reference,

  notes:
    row.notes,

  snapshotHash:
    row.snapshot_hash,

  version:
    Number(
      row.version ||
      1
    ),

  requestedAt:
    row.requested_at,

  confirmedAt:
    row.confirmed_at,

  confirmedPayoutStatementId:
    row
      .confirmed_payout_statement_id,

  allocations:
    Array.isArray(
      row.allocations
    )
      ? row.allocations.map(
          (
            allocation: any
          ) => ({
            ...allocation,

            releaseDate:
              allocation.releaseDate
                ? String(
                    allocation
                      .releaseDate
                  ).slice(0, 10)
                : null,

            amount:
              money(
                allocation.amount
              ),

            snapshotAvailableAmount:
              money(
                allocation
                  .snapshotAvailableAmount
              ),

            snapshotMovementCount:
              Number(
                allocation
                  .snapshotMovementCount ||
                0
              )
          })
        )
      : [],

  createdAt:
    row.created_at,

  updatedAt:
    row.updated_at
});

const respondError = (
  res: Response,
  error: unknown
) => {
  if (
    error instanceof
    ApiError
  ) {
    return res
      .status(error.status)
      .json({
        success: false,

        error: {
          code:
            error.code,

          message:
            error.message
        }
      });
  }

  console.error(
    '[PAYOUT-REQUESTS]',
    error
  );

  return res.status(500).json({
    success: false,

    error: {
      code:
        'PAYOUT_REQUEST_FAILED',

      message:
        'Erro ao processar pedido de payout.'
    }
  });
};

export const getPayoutFundingOptions =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const storeId =
        typeof req.query
          .storeId ===
          'string'
          ? req.query
              .storeId
              .trim()
          : '';

      if (
        !uuidPattern.test(
          storeId
        )
      ) {
        throw new ApiError(
          400,
          'INVALID_STORE',
          'Store inválida.'
        );
      }

      const currency =
        normalizeCurrency(
          req.query.currency
        );

      const storeWallet =
        await loadStoreWallet(
          prisma,
          merchantId,
          storeId,
          currency
        );

      const options =
        await loadFundingOptions(
          prisma,
          merchantId,
          storeId,
          currency
        );

      return res.json({
        success: true,

        data: {
          currency,
          timezone:
            FINANCE_TIMEZONE,

          store: {
            id:
              storeWallet
                .store_id,

            code:
              storeWallet
                .store_code,

            name:
              storeWallet
                .store_name
          },

          walletId:
            storeWallet
              .wallet_id,

          items:
            options,

          summary: {
            remainingAmount:
              money(
                options.reduce(
                  (
                    total,
                    option
                  ) =>
                    total +
                    option
                      .remainingAmount,
                  0
                )
              ),

            movementCount:
              options.reduce(
                (
                  total,
                  option
                ) =>
                  total +
                  option
                    .movementCount,
                0
              )
          },

          generatedAt:
            new Date()
              .toISOString()
        }
      });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };

export const listPayoutRequests =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const status =
        typeof req.query.status ===
          'string' &&
        req.query.status.trim()
          ? req.query.status
              .trim()
              .toLowerCase()
          : null;

      const limitCandidate =
        Number(
          req.query.limit ||
          100
        );

      const limit =
        Number.isFinite(
          limitCandidate
        )
          ? Math.min(
              Math.max(
                Math.trunc(
                  limitCandidate
                ),
                1
              ),
              250
            )
          : 100;

      const rows =
        await prisma
          .$queryRawUnsafe<
            DatabaseRow[]
          >(
            `
              SELECT
                request.id::text,
                request.request_code,
                request.currency,
                request.status,
                request.requested_amount::text,
                request.external_reference,
                request.notes,
                request.snapshot_hash,
                request.version,
                request.requested_at,
                request.confirmed_at,
                request.deleted_at,
                request.created_at,
                request.updated_at,

                store.id::text
                  AS store_id,

                store.store_code,
                store.name
                  AS store_name,

                wallet.id::text
                  AS wallet_id,

                request
                  .confirmed_payout_statement_id::text,

                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'id',
                      allocation.id,

                      'releaseDate',
                      allocation
                        .release_date,

                      'provider',
                      allocation.provider,

                      'amount',
                      allocation
                        .requested_amount,

                      'snapshotAvailableAmount',
                      allocation
                        .snapshot_available_amount,

                      'snapshotMovementCount',
                      allocation
                        .snapshot_movement_count,

                      'position',
                      allocation.position,

                      'metadata',
                      allocation.metadata
                    )

                    ORDER BY
                      allocation.position,
                      allocation.created_at
                  ) FILTER (
                    WHERE allocation.id
                      IS NOT NULL
                  ),
                  '[]'::jsonb
                ) AS allocations

              FROM public
                .payout_requests
                  AS request

              JOIN public.stores
                AS store

                ON store.id =
                  request.store_id

              JOIN public.wallets
                AS wallet

                ON wallet.id =
                  request.wallet_id

              LEFT JOIN public
                .payout_request_allocations
                  AS allocation

                ON allocation
                  .payout_request_id =
                  request.id

              WHERE request.merchant_id =
                  $1::uuid

                AND request.deleted_at
                  IS NULL

                AND (
                  $2::text IS NULL
                  OR request.status =
                    $2
                )

              GROUP BY
                request.id,
                store.id,
                wallet.id

              ORDER BY
                request.updated_at
                  DESC

              LIMIT $3::integer
            `,
            merchantId,
            status,
            limit
          );

      const items =
        rows.map(
          serializeRequest
        );

      const summary =
        items.reduce(
          (
            accumulator,
            item
          ) => {
            accumulator.totalCount +=
              1;

            accumulator.totalAmount =
              money(
                accumulator
                  .totalAmount +
                item
                  .requestedAmount
              );

            accumulator.byStatus[
              item.status
            ] =
              (
                accumulator.byStatus[
                  item.status
                ] ||
                0
              ) +
              1;

            return accumulator;
          },
          {
            totalCount: 0,
            totalAmount: 0,
            byStatus:
              {} as Record<
                string,
                number
              >
          }
        );

      return res.json({
        success: true,

        data: {
          items,
          summary,

          generatedAt:
            new Date()
              .toISOString()
        }
      });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };

export const createPayoutRequest =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const payload =
        parseDraftPayload(
          req.body
        );

      const requestCode =
        createRequestCode();

      const requestId =
        await prisma
          .$transaction(
            async tx => {
              const validation =
                await validateDraft(
                  tx,
                  merchantId,
                  payload
                );

              const rows =
                await tx
                  .$queryRawUnsafe<
                    DatabaseRow[]
                  >(
                    `
                      INSERT INTO public
                        .payout_requests (
                          request_code,
                          merchant_id,
                          store_id,
                          wallet_id,
                          currency,
                          status,
                          requested_amount,
                          external_reference,
                          notes,
                          created_by_merchant_id,
                          snapshot_hash,
                          metadata
                        )

                      VALUES (
                        $1,
                        $2::uuid,
                        $3::uuid,
                        $4::uuid,
                        $5,
                        'draft',
                        $6::numeric,
                        $7,
                        $8,
                        $2::uuid,
                        $9,
                        $10::jsonb
                      )

                      RETURNING
                        id::text
                    `,
                    requestCode,
                    merchantId,
                    payload.storeId,
                    validation
                      .storeWallet
                      .wallet_id,
                    payload.currency,
                    validation
                      .requestedAmount,
                    payload
                      .externalReference,
                    payload.notes,
                    validation
                      .snapshotHash,
                    JSON.stringify({
                      source:
                        'merchant_dashboard',

                      noFinancialImpact:
                        true,

                      fundingReserved:
                        false
                    })
                  );

              const id =
                String(
                  rows[0]?.id ||
                  ''
                );

              if (!id) {
                throw new ApiError(
                  500,
                  'DRAFT_CREATE_FAILED',
                  'Falha ao criar rascunho.'
                );
              }

              await insertAllocations(
                tx,
                id,
                merchantId,
                payload.storeId,
                validation
                  .snapshots
              );

              await insertEvent(
                tx,
                {
                  requestId:
                    id,

                  merchantId,

                  actorMerchantId:
                    merchantId,

                  eventType:
                    'DRAFT_CREATED',

                  fromStatus:
                    null,

                  toStatus:
                    'draft',

                  req,

                  payload: {
                    requestedAmount:
                      validation
                        .requestedAmount,

                    allocationCount:
                      validation
                        .snapshots
                        .length,

                    noFinancialImpact:
                      true
                  }
                }
              );

              return id;
            },
            {
              maxWait:
                10000,

              timeout:
                30000,

              isolationLevel:
                Prisma
                  .TransactionIsolationLevel
                  .Serializable
            }
          );

      const created =
        await fetchRequestById(
          prisma,
          merchantId,
          requestId
        );

      if (!created) {
        throw new ApiError(
          500,
          'DRAFT_READ_FAILED',
          'Rascunho criado, mas não foi possível relê-lo.'
        );
      }

      return res
        .status(201)
        .json({
          success: true,

          data:
            serializeRequest(
              created
            )
        });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };

export const updatePayoutRequest =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const requestId =
        String(
          req.params.id ||
          ''
        ).trim();

      if (
        !uuidPattern.test(
          requestId
        )
      ) {
        throw new ApiError(
          400,
          'INVALID_REQUEST_ID',
          'Pedido inválido.'
        );
      }

      const expectedVersion =
        Number(
          (
            req.body as
              Record<
                string,
                unknown
              >
          )?.expectedVersion
        );

      if (
        !Number.isInteger(
          expectedVersion
        ) ||
        expectedVersion < 1
      ) {
        throw new ApiError(
          400,
          'EXPECTED_VERSION_REQUIRED',
          'Informe a versão atual do rascunho.'
        );
      }

      const payload =
        parseDraftPayload(
          req.body
        );

      await prisma
        .$transaction(
          async tx => {
            const currentRows =
              await tx
                .$queryRawUnsafe<
                  DatabaseRow[]
                >(
                  `
                    SELECT
                      id::text,
                      status,
                      version

                    FROM public
                      .payout_requests

                    WHERE id =
                        $1::uuid

                      AND merchant_id =
                        $2::uuid

                      AND deleted_at
                        IS NULL

                    FOR UPDATE
                  `,
                  requestId,
                  merchantId
                );

            if (
              currentRows.length !==
              1
            ) {
              throw new ApiError(
                404,
                'PAYOUT_REQUEST_NOT_FOUND',
                'Pedido não encontrado.'
              );
            }

            const current =
              currentRows[0];

            if (
              current.status !==
                'draft'
            ) {
              throw new ApiError(
                409,
                'PAYOUT_REQUEST_NOT_EDITABLE',
                'Somente rascunhos podem ser editados nesta etapa.'
              );
            }

            if (
              Number(
                current.version
              ) !==
              expectedVersion
            ) {
              throw new ApiError(
                409,
                'PAYOUT_REQUEST_VERSION_CONFLICT',
                'O rascunho foi alterado. Atualize a página.'
              );
            }

            const validation =
              await validateDraft(
                tx,
                merchantId,
                payload
              );

            const updated =
              await tx
                .$executeRawUnsafe(
                  `
                    UPDATE public
                      .payout_requests

                    SET
                      store_id =
                        $3::uuid,

                      wallet_id =
                        $4::uuid,

                      currency =
                        $5,

                      requested_amount =
                        $6::numeric,

                      external_reference =
                        $7,

                      notes =
                        $8,

                      snapshot_hash =
                        $9,

                      version =
                        version + 1,

                      updated_at =
                        now()

                    WHERE id =
                        $1::uuid

                      AND merchant_id =
                        $2::uuid

                      AND version =
                        $10::integer

                      AND status =
                        'draft'

                      AND deleted_at
                        IS NULL
                  `,
                  requestId,
                  merchantId,
                  payload.storeId,
                  validation
                    .storeWallet
                    .wallet_id,
                  payload.currency,
                  validation
                    .requestedAmount,
                  payload
                    .externalReference,
                  payload.notes,
                  validation
                    .snapshotHash,
                  expectedVersion
                );

            if (updated !== 1) {
              throw new ApiError(
                409,
                'PAYOUT_REQUEST_UPDATE_CONFLICT',
                'Não foi possível atualizar o rascunho.'
              );
            }

            await tx
              .$executeRawUnsafe(
                `
                  DELETE FROM public
                    .payout_request_allocations

                  WHERE payout_request_id =
                    $1::uuid
                `,
                requestId
              );

            await insertAllocations(
              tx,
              requestId,
              merchantId,
              payload.storeId,
              validation
                .snapshots
            );

            await insertEvent(
              tx,
              {
                requestId,
                merchantId,

                actorMerchantId:
                  merchantId,

                eventType:
                  'DRAFT_UPDATED',

                fromStatus:
                  'draft',

                toStatus:
                  'draft',

                req,

                payload: {
                  requestedAmount:
                    validation
                      .requestedAmount,

                  allocationCount:
                    validation
                      .snapshots
                      .length,

                  previousVersion:
                    expectedVersion,

                  nextVersion:
                    expectedVersion +
                    1,

                  noFinancialImpact:
                    true
                }
              }
            );
          },
          {
            maxWait:
              10000,

            timeout:
              30000,

            isolationLevel:
              Prisma
                .TransactionIsolationLevel
                .Serializable
          }
        );

      const updated =
        await fetchRequestById(
          prisma,
          merchantId,
          requestId
        );

      if (!updated) {
        throw new ApiError(
          500,
          'DRAFT_READ_FAILED',
          'Rascunho atualizado, mas não foi possível relê-lo.'
        );
      }

      return res.json({
        success: true,

        data:
          serializeRequest(
            updated
          )
      });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };

export const deletePayoutRequest =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const requestId =
        String(
          req.params.id ||
          ''
        ).trim();

      if (
        !uuidPattern.test(
          requestId
        )
      ) {
        throw new ApiError(
          400,
          'INVALID_REQUEST_ID',
          'Pedido inválido.'
        );
      }

      await prisma
        .$transaction(
          async tx => {
            const rows =
              await tx
                .$queryRawUnsafe<
                  DatabaseRow[]
                >(
                  `
                    SELECT
                      id::text,
                      status

                    FROM public
                      .payout_requests

                    WHERE id =
                        $1::uuid

                      AND merchant_id =
                        $2::uuid

                      AND deleted_at
                        IS NULL

                    FOR UPDATE
                  `,
                  requestId,
                  merchantId
                );

            if (
              rows.length !==
              1
            ) {
              throw new ApiError(
                404,
                'PAYOUT_REQUEST_NOT_FOUND',
                'Pedido não encontrado.'
              );
            }

            const status =
              String(
                rows[0].status
              );

            if (
              status ===
                'confirmed'
            ) {
              throw new ApiError(
                409,
                'CONFIRMED_REQUEST_IMMUTABLE',
                'Um payout confirmado não pode ser eliminado.'
              );
            }

            await tx
              .$executeRawUnsafe(
                `
                  UPDATE public
                    .payout_requests

                  SET
                    status =
                      'cancelled',

                    cancelled_at =
                      COALESCE(
                        cancelled_at,
                        now()
                      ),

                    deleted_at =
                      now(),

                    version =
                      version + 1,

                    updated_at =
                      now()

                  WHERE id =
                      $1::uuid

                    AND merchant_id =
                      $2::uuid

                    AND deleted_at
                      IS NULL
                `,
                requestId,
                merchantId
              );

            await insertEvent(
              tx,
              {
                requestId,
                merchantId,

                actorMerchantId:
                  merchantId,

                eventType:
                  'REQUEST_DELETED',

                fromStatus:
                  status,

                toStatus:
                  'cancelled',

                req,

                payload: {
                  softDelete:
                    true,

                  noFinancialImpact:
                    true
                }
              }
            );
          },
          {
            maxWait:
              10000,

            timeout:
              30000,

            isolationLevel:
              Prisma
                .TransactionIsolationLevel
                .Serializable
          }
        );

      return res.json({
        success: true,

        data: {
          id:
            requestId,

          deleted:
            true,

          financialImpact:
            false
        }
      });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };

type NotificationTarget = {
  channel:
    | 'telegram'
    | 'discord'
    | 'email'
    | 'slack'
    | 'webhook';

  destination:
    string;
};

const getNotificationTargets =
  (): NotificationTarget[] => {
    const candidates: Array<
      [
        NotificationTarget['channel'],
        string | undefined
      ]
    > = [
      [
        'telegram',
        process.env
          .PAYOUT_MANAGER_TELEGRAM_DESTINATION
      ],
      [
        'discord',
        process.env
          .PAYOUT_MANAGER_DISCORD_DESTINATION
      ],
      [
        'email',
        process.env
          .PAYOUT_MANAGER_EMAIL_DESTINATION
      ],
      [
        'slack',
        process.env
          .PAYOUT_MANAGER_SLACK_DESTINATION
      ],
      [
        'webhook',
        process.env
          .PAYOUT_MANAGER_WEBHOOK_URL
      ]
    ];

    return candidates
      .map(
        (
          [
            channel,
            rawDestination
          ]
        ) => ({
          channel,

          destination:
            String(
              rawDestination ||
              ''
            ).trim()
        })
      )
      .filter(
        target =>
          target.destination
            .length > 0
      );
  };

const insertManagerNotification =
  async (
    tx: Prisma.TransactionClient,
    input: {
      requestId:
        string;

      merchantId:
        string;

      requestCode:
        string;

      currency:
        string;

      requestedAmount:
        number;

      storeId:
        string;

      storeCode:
        string;

      storeName:
        string;

      externalReference:
        string | null;

      notes:
        string | null;

      actorMerchantId:
        string;

      reviewUrl:
        string | null;

      targets:
        NotificationTarget[];
    }
  ) => {
    for (
      const target of
      input.targets
    ) {
      await tx
        .$executeRawUnsafe(
          `
            INSERT INTO public
              .payout_request_notification_outbox (
                payout_request_id,
                merchant_id,
                channel,
                destination,
                status,
                attempts,
                next_attempt_at,
                payload,
                created_at,
                updated_at
              )

            VALUES (
              $1::uuid,
              $2::uuid,
              $3,
              $4,
              'pending',
              0,
              now(),
              $5::jsonb,
              now(),
              now()
            )
          `,
          input.requestId,
          input.merchantId,
          target.channel,
          target.destination,
          JSON.stringify({
            event:
              'PAYOUT_MANAGER_REQUESTED',

            requestId:
              input.requestId,

            requestCode:
              input.requestCode,

            merchantId:
              input.merchantId,

            actorMerchantId:
              input.actorMerchantId,

            store: {
              id:
                input.storeId,

              code:
                input.storeCode,

              name:
                input.storeName
            },

            currency:
              input.currency,

            requestedAmount:
              input.requestedAmount,

            externalReference:
              input.externalReference,

            notes:
              input.notes,

            reviewUrl:
              input.reviewUrl,

            createdAt:
              new Date()
                .toISOString()
          })
        );
    }
  };

export const requestPayoutManager =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const requestId =
        String(
          req.params.id ||
          ''
        ).trim();

      if (
        !uuidPattern.test(
          requestId
        )
      ) {
        throw new ApiError(
          400,
          'INVALID_REQUEST_ID',
          'Pedido inválido.'
        );
      }

      const expectedVersion =
        Number(
          (
            req.body as
              Record<
                string,
                unknown
              >
          )?.expectedVersion
        );

      if (
        !Number.isInteger(
          expectedVersion
        ) ||
        expectedVersion < 1
      ) {
        throw new ApiError(
          400,
          'EXPECTED_VERSION_REQUIRED',
          'Informe a versão atual do rascunho.'
        );
      }

      const notificationTargets =
        getNotificationTargets();

      const reviewBaseUrl =
        String(
          process.env
            .PAYOUT_MANAGER_REVIEW_BASE_URL ||
          ''
        )
          .trim()
          .replace(
            /\/+$/,
            ''
          );

      const transition =
        await prisma
          .$transaction(
            async tx => {
              const rows =
                await tx
                  .$queryRawUnsafe<
                    DatabaseRow[]
                  >(
                    `
                      SELECT
                        request.id::text,
                        request.request_code,
                        request.status,
                        request.version,
                        request.currency,
                        request.requested_amount::text,
                        request.external_reference,
                        request.notes,

                        store.id::text
                          AS store_id,

                        store.store_code,
                        store.name
                          AS store_name

                      FROM public
                        .payout_requests
                          AS request

                      JOIN public.stores
                        AS store

                        ON store.id =
                          request.store_id

                      WHERE request.id =
                          $1::uuid

                        AND request.merchant_id =
                          $2::uuid

                        AND request.deleted_at
                          IS NULL

                      FOR UPDATE OF request
                    `,
                    requestId,
                    merchantId
                  );

              if (
                rows.length !==
                1
              ) {
                throw new ApiError(
                  404,
                  'PAYOUT_REQUEST_NOT_FOUND',
                  'Pedido não encontrado.'
                );
              }

              const current =
                rows[0];

              const currentStatus =
                String(
                  current.status
                );

              const currentVersion =
                Number(
                  current.version ||
                  1
                );

              if (
                currentStatus ===
                  'requested'
              ) {
                return {
                  changed:
                    false,

                  alreadyRequested:
                    true,

                  notificationTargets:
                    0
                };
              }

              if (
                currentStatus !==
                  'draft'
              ) {
                throw new ApiError(
                  409,
                  'PAYOUT_REQUEST_NOT_REQUESTABLE',
                  'Somente rascunhos podem ser enviados ao Gerente.'
                );
              }

              if (
                currentVersion !==
                  expectedVersion
              ) {
                throw new ApiError(
                  409,
                  'PAYOUT_REQUEST_VERSION_CONFLICT',
                  'O rascunho foi alterado. Atualize a página.'
                );
              }

              const updated =
                await tx
                  .$executeRawUnsafe(
                    `
                      UPDATE public
                        .payout_requests

                      SET
                        status =
                          'requested',

                        requested_at =
                          now(),

                        version =
                          version + 1,

                        updated_at =
                          now()

                      WHERE id =
                          $1::uuid

                        AND merchant_id =
                          $2::uuid

                        AND status =
                          'draft'

                        AND version =
                          $3::integer

                        AND deleted_at
                          IS NULL
                    `,
                    requestId,
                    merchantId,
                    expectedVersion
                  );

              if (updated !== 1) {
                throw new ApiError(
                  409,
                  'PAYOUT_REQUEST_TRANSITION_CONFLICT',
                  'Não foi possível enviar o pedido ao Gerente.'
                );
              }

              const requestedAmount =
                money(
                  current
                    .requested_amount
                );

              const reviewUrl =
                reviewBaseUrl
                  ? `${reviewBaseUrl}/${requestId}`
                  : null;

              await insertManagerNotification(
                tx,
                {
                  requestId,
                  merchantId,

                  requestCode:
                    String(
                      current
                        .request_code
                    ),

                  currency:
                    String(
                      current.currency
                    ),

                  requestedAmount,

                  storeId:
                    String(
                      current.store_id
                    ),

                  storeCode:
                    String(
                      current
                        .store_code ||
                      ''
                    ),

                  storeName:
                    String(
                      current
                        .store_name ||
                      ''
                    ),

                  externalReference:
                    current
                      .external_reference ||
                    null,

                  notes:
                    current.notes ||
                    null,

                  actorMerchantId:
                    merchantId,

                  reviewUrl,

                  targets:
                    notificationTargets
                }
              );

              await insertEvent(
                tx,
                {
                  requestId,
                  merchantId,

                  actorMerchantId:
                    merchantId,

                  eventType:
                    'MANAGER_REQUESTED',

                  fromStatus:
                    'draft',

                  toStatus:
                    'requested',

                  req,

                  payload: {
                    requestedAmount,

                    notificationChannels:
                      notificationTargets
                        .map(
                          target =>
                            target.channel
                        ),

                    notificationCount:
                      notificationTargets
                        .length,

                    notificationConfigured:
                      notificationTargets
                        .length > 0,

                    noFinancialImpact:
                      true,

                    fundingReserved:
                      false
                  }
                }
              );

              return {
                changed:
                  true,

                alreadyRequested:
                  false,

                notificationTargets:
                  notificationTargets
                    .length
              };
            },
            {
              maxWait:
                10000,

              timeout:
                30000,

              isolationLevel:
                Prisma
                  .TransactionIsolationLevel
                  .Serializable
            }
          );

      const updated =
        await fetchRequestById(
          prisma,
          merchantId,
          requestId
        );

      if (!updated) {
        throw new ApiError(
          500,
          'REQUEST_READ_FAILED',
          'Pedido enviado, mas não foi possível relê-lo.'
        );
      }

      return res.json({
        success:
          true,

        data: {
          request:
            serializeRequest(
              updated
            ),

          transition,

          notification: {
            queued:
              transition
                .notificationTargets,

            configured:
              transition
                .notificationTargets >
              0,

            deliveryStarted:
              false
          },

          financialImpact:
            false
        }
      });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };

const confirmationAllowedStatuses =
  new Set([
    'draft',
    'requested',
    'under_review'
  ]);

const approvalWindowMinutes =
  15;

const approvalFailureLimit =
  5;

const challengeLifetimeMinutes =
  5;

const hashApprovalIp = (
  req: AuthRequest
): string => {
  const salt =
    String(
      process.env
        .PAYOUT_APPROVAL_RATE_LIMIT_SALT ||
      process.env.JWT_SECRET ||
      'xpayments-approval-rate-limit'
    );

  return createHash('sha256')
    .update(
      `${salt}|${req.ip || 'unknown'}`
    )
    .digest('hex');
};

const loadCurrentDraftForConfirmation =
  async (
    client: QueryClient,
    merchantId: string,
    requestId: string
  ) => {
    const row =
      await fetchRequestById(
        client,
        merchantId,
        requestId
      );

    if (!row) {
      throw new ApiError(
        404,
        'PAYOUT_REQUEST_NOT_FOUND',
        'Pedido não encontrado.'
      );
    }

    const serialized =
      serializeRequest(row);

    if (
      !confirmationAllowedStatuses
        .has(serialized.status)
    ) {
      throw new ApiError(
        409,
        'PAYOUT_REQUEST_NOT_CONFIRMABLE',
        'O pedido não está disponível para confirmação.'
      );
    }

    const payload: DraftPayload = {
      storeId:
        serialized.store.id,

      currency:
        serialized.currency,

      externalReference:
        serialized
          .externalReference,

      notes:
        serialized.notes,

      allocations:
        serialized.allocations
          .map(
            (
              allocation:
                Record<
                  string,
                  any
                >,
              position:
                number
            ) => ({
              releaseDate:
                String(
                  allocation
                    .releaseDate
                ).slice(0, 10),

              provider:
                String(
                  allocation.provider
                ),

              amount:
                money(
                  allocation.amount
                ),

              position
            })
          )
    };

    const validation =
      await validateDraft(
        client,
        merchantId,
        payload
      );

    if (
      cents(
        validation.requestedAmount
      ) !==
      cents(
        serialized
          .requestedAmount
      )
    ) {
      throw new ApiError(
        409,
        'PAYOUT_REQUEST_OUTDATED',
        'O valor do pedido já não coincide com as liberações.'
      );
    }

    const challengeSnapshotHash =
      createHash('sha256')
        .update(
          JSON.stringify({
            requestId:
              serialized.id,

            version:
              serialized.version,

            status:
              serialized.status,

            storeId:
              serialized.store.id,

            walletId:
              serialized.walletId,

            currency:
              serialized.currency,

            requestedAmount:
              serialized
                .requestedAmount,

            draftSnapshotHash:
              serialized
                .snapshotHash,

            liveSnapshotHash:
              validation
                .snapshotHash,

            allocations:
              validation.snapshots
                .map(
                  allocation => ({
                    releaseDate:
                      allocation
                        .releaseDate,

                    provider:
                      allocation
                        .provider,

                    amount:
                      allocation.amount,

                    snapshotAvailableAmount:
                      allocation
                        .snapshotAvailableAmount,

                    snapshotMovementCount:
                      allocation
                        .snapshotMovementCount,

                    providerStatus:
                      allocation
                        .providerStatus
                  })
                )
          })
        )
        .digest('hex');

    return {
      serialized,
      validation,
      challengeSnapshotHash
    };
  };

const insertApprovalAttempt =
  async (
    client: QueryClient,
    input: {
      requestId:
        string | null;

      challengeId:
        string | null;

      merchantId:
        string;

      actorMerchantId:
        string;

      ipHash:
        string;

      succeeded:
        boolean;

      reason:
        string;

      metadata?:
        Record<
          string,
          unknown
        >;
    }
  ) => {
    await client
      .$queryRawUnsafe(
        `
          INSERT INTO public
            .payout_manager_approval_attempts (
              payout_request_id,
              challenge_id,
              merchant_id,
              actor_merchant_id,
              ip_hash,
              succeeded,
              reason,
              metadata
            )

          VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            $6::boolean,
            $7,
            $8::jsonb
          )

          RETURNING id::text
        `,
        input.requestId,
        input.challengeId,
        input.merchantId,
        input.actorMerchantId,
        input.ipHash,
        input.succeeded,
        input.reason,
        JSON.stringify(
          input.metadata ||
          {}
        )
      );
  };

const ensureApprovalRateLimit =
  async (
    merchantId: string,
    actorMerchantId: string,
    ipHash: string
  ) => {
    const rows =
      await prisma
        .$queryRawUnsafe<
          DatabaseRow[]
        >(
          `
            SELECT
              COUNT(*)::int
                AS failure_count,

              MAX(created_at)
                AS last_failure_at

            FROM public
              .payout_manager_approval_attempts

            WHERE merchant_id =
                $1::uuid

              AND succeeded =
                false

              AND created_at >=
                now() -
                ($4::integer * interval '1 minute')

              AND (
                actor_merchant_id =
                  $2::uuid

                OR ip_hash =
                  $3
              )
          `,
          merchantId,
          actorMerchantId,
          ipHash,
          approvalWindowMinutes
        );

    const failureCount =
      Number(
        rows[0]
          ?.failure_count ||
        0
      );

    if (
      failureCount >=
      approvalFailureLimit
    ) {
      throw new ApiError(
        429,
        'PAYOUT_APPROVAL_RATE_LIMITED',
        'Muitas tentativas. Tente novamente mais tarde.'
      );
    }

    return {
      failureCount,

      remainingAttempts:
        Math.max(
          approvalFailureLimit -
            failureCount,
          0
        )
    };
  };

export const previewPayoutConfirmation =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const requestId =
        String(
          req.params.id ||
          ''
        ).trim();

      if (
        !uuidPattern.test(
          requestId
        )
      ) {
        throw new ApiError(
          400,
          'INVALID_REQUEST_ID',
          'Pedido inválido.'
        );
      }

      const expectedVersion =
        Number(
          (
            req.body as
              Record<
                string,
                unknown
              >
          )?.expectedVersion
        );

      if (
        !Number.isInteger(
          expectedVersion
        ) ||
        expectedVersion < 1
      ) {
        throw new ApiError(
          400,
          'EXPECTED_VERSION_REQUIRED',
          'Informe a versão atual do pedido.'
        );
      }

      const current =
        await loadCurrentDraftForConfirmation(
          prisma,
          merchantId,
          requestId
        );

      if (
        current.serialized
          .version !==
        expectedVersion
      ) {
        throw new ApiError(
          409,
          'PAYOUT_REQUEST_VERSION_CONFLICT',
          'O pedido foi alterado. Atualize a página.'
        );
      }

      const expiresAt =
        new Date(
          Date.now() +
          challengeLifetimeMinutes *
            60 *
            1000
        );

      const rows =
        await prisma
          .$transaction(
            async tx => {
              await tx
                .$executeRawUnsafe(
                  `
                    UPDATE public
                      .payout_confirmation_challenges

                    SET
                      status =
                        'invalidated',

                      invalidated_at =
                        now(),

                      updated_at =
                        now()

                    WHERE payout_request_id =
                        $1::uuid

                      AND merchant_id =
                        $2::uuid

                      AND actor_merchant_id =
                        $2::uuid

                      AND status =
                        'pending'
                  `,
                  requestId,
                  merchantId
                );

              return tx
                .$queryRawUnsafe<
                  DatabaseRow[]
                >(
                  `
                    INSERT INTO public
                      .payout_confirmation_challenges (
                        payout_request_id,
                        merchant_id,
                        actor_merchant_id,
                        request_version,
                        snapshot_hash,
                        status,
                        expires_at,
                        metadata
                      )

                    VALUES (
                      $1::uuid,
                      $2::uuid,
                      $2::uuid,
                      $3::integer,
                      $4,
                      'pending',
                      $5::timestamptz,
                      $6::jsonb
                    )

                    RETURNING
                      id::text,
                      status,
                      expires_at
                  `,
                  requestId,
                  merchantId,
                  expectedVersion,
                  current
                    .challengeSnapshotHash,
                  expiresAt
                    .toISOString(),
                  JSON.stringify({
                    purpose:
                      'payout_confirmation',

                    requestedAmount:
                      current.serialized
                        .requestedAmount,

                    currency:
                      current.serialized
                        .currency,

                    storeId:
                      current.serialized
                        .store.id,

                    walletId:
                      current.serialized
                        .walletId,

                    allocationCount:
                      current.validation
                        .snapshots
                        .length,

                    bankTransferAttestationRequired:
                      true,

                    financialImpact:
                      false
                  })
                );
            },
            {
              isolationLevel:
                Prisma
                  .TransactionIsolationLevel
                  .Serializable
            }
          );

      const challenge =
        rows[0];

      return res.json({
        success:
          true,

        data: {
          challengeId:
            challenge.id,

          status:
            challenge.status,

          expiresAt:
            challenge.expires_at,

          request: {
            id:
              current.serialized.id,

            requestCode:
              current.serialized
                .requestCode,

            version:
              current.serialized
                .version,

            status:
              current.serialized
                .status,

            store:
              current.serialized
                .store,

            walletId:
              current.serialized
                .walletId,

            currency:
              current.serialized
                .currency,

            requestedAmount:
              current.serialized
                .requestedAmount,

            externalReference:
              current.serialized
                .externalReference
          },

          allocations:
            current.validation
              .snapshots,

          bankTransferAttestationRequired:
            true,

          approvalPasswordRequired:
            true,

          financialImpact:
            false
        }
      });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };

export const verifyPayoutManager =
  async (
    req: AuthRequest,
    res: Response
  ) => {
    try {
      const merchantId =
        requiredMerchantId(req);

      const requestId =
        String(
          req.params.id ||
          ''
        ).trim();

      if (
        !uuidPattern.test(
          requestId
        )
      ) {
        throw new ApiError(
          400,
          'INVALID_REQUEST_ID',
          'Pedido inválido.'
        );
      }

      const body =
        (
          req.body ||
          {}
        ) as Record<
          string,
          unknown
        >;

      const challengeId =
        typeof body
          .challengeId ===
          'string'
          ? body
              .challengeId
              .trim()
          : '';

      const approvalPassword =
        typeof body
          .approvalPassword ===
          'string'
          ? body
              .approvalPassword
          : '';

      const bankTransferConfirmed =
        body
          .bankTransferConfirmed ===
        true;

      if (
        !uuidPattern.test(
          challengeId
        )
      ) {
        throw new ApiError(
          400,
          'INVALID_CHALLENGE_ID',
          'Desafio inválido.'
        );
      }

      if (
        !bankTransferConfirmed
      ) {
        throw new ApiError(
          400,
          'BANK_TRANSFER_ATTESTATION_REQUIRED',
          'Confirme que a transferência bancária foi executada.'
        );
      }

      if (
        !approvalPassword ||
        approvalPassword
          .length > 256
      ) {
        throw new ApiError(
          401,
          'PAYOUT_APPROVAL_DENIED',
          'Autorização inválida.'
        );
      }

      const passwordHash =
        String(
          process.env
            .PAYOUT_MANAGER_PASSWORD_HASH ||
          ''
        ).trim();

      if (
        !passwordHash
      ) {
        throw new ApiError(
          503,
          'PAYOUT_APPROVAL_NOT_CONFIGURED',
          'Autorização administrativa indisponível.'
        );
      }

      const ipHash =
        hashApprovalIp(req);

      const rateLimit =
        await ensureApprovalRateLimit(
          merchantId,
          merchantId,
          ipHash
        );

      const passwordValid =
        await bcrypt.compare(
          approvalPassword,
          passwordHash
        );

      if (
        !passwordValid
      ) {
        await insertApprovalAttempt(
          prisma,
          {
            requestId,
            challengeId,
            merchantId,

            actorMerchantId:
              merchantId,

            ipHash,

            succeeded:
              false,

            reason:
              'invalid_password',

            metadata: {
              remainingAttemptsBefore:
                rateLimit
                  .remainingAttempts,

              userAgent:
                req.get(
                  'user-agent'
                ) ||
                null
            }
          }
        );

        throw new ApiError(
          401,
          'PAYOUT_APPROVAL_DENIED',
          'Autorização inválida.'
        );
      }

      const authorization =
        await prisma
          .$transaction(
            async tx => {
              await tx
                .$queryRawUnsafe<
                  DatabaseRow[]
                >(
                  `
                    WITH advisory_lock AS
                      MATERIALIZED (
                        SELECT
                          pg_advisory_xact_lock(
                            hashtext($1)
                          )
                      )

                    SELECT
                      1::int
                        AS lock_acquired

                    FROM advisory_lock
                  `,
                  `${merchantId}|${ipHash}`
                );

              const rows =
                await tx
                  .$queryRawUnsafe<
                    DatabaseRow[]
                  >(
                    `
                      SELECT
                        challenge.id::text,
                        challenge.status,
                        challenge.expires_at,
                        challenge.request_version,
                        challenge.snapshot_hash,

                        request.status
                          AS request_status,

                        request.version
                          AS current_version

                      FROM public
                        .payout_confirmation_challenges
                          AS challenge

                      JOIN public
                        .payout_requests
                          AS request

                        ON request.id =
                          challenge
                            .payout_request_id

                      WHERE challenge.id =
                          $1::uuid

                        AND challenge
                          .payout_request_id =
                          $2::uuid

                        AND challenge
                          .merchant_id =
                          $3::uuid

                        AND challenge
                          .actor_merchant_id =
                          $3::uuid

                        AND request
                          .deleted_at
                          IS NULL

                      FOR UPDATE OF
                        challenge,
                        request
                    `,
                    challengeId,
                    requestId,
                    merchantId
                  );

              if (
                rows.length !==
                1
              ) {
                throw new ApiError(
                  404,
                  'PAYOUT_CHALLENGE_NOT_FOUND',
                  'Desafio não encontrado.'
                );
              }

              const challenge =
                rows[0];

              if (
                challenge.status !==
                  'pending'
              ) {
                throw new ApiError(
                  409,
                  'PAYOUT_CHALLENGE_NOT_PENDING',
                  'O desafio já não está disponível.'
                );
              }

              if (
                new Date(
                  challenge.expires_at
                ).getTime() <=
                Date.now()
              ) {
                await tx
                  .$executeRawUnsafe(
                    `
                      UPDATE public
                        .payout_confirmation_challenges

                      SET
                        status =
                          'expired',

                        updated_at =
                          now()

                      WHERE id =
                        $1::uuid
                    `,
                    challengeId
                  );

                throw new ApiError(
                  410,
                  'PAYOUT_CHALLENGE_EXPIRED',
                  'O desafio expirou.'
                );
              }

              if (
                Number(
                  challenge
                    .request_version
                ) !==
                Number(
                  challenge
                    .current_version
                )
              ) {
                throw new ApiError(
                  409,
                  'PAYOUT_REQUEST_OUTDATED',
                  'O pedido foi alterado após o preview.'
                );
              }

              const current =
                await loadCurrentDraftForConfirmation(
                  tx,
                  merchantId,
                  requestId
                );

              if (
                current
                  .challengeSnapshotHash !==
                challenge
                  .snapshot_hash
              ) {
                throw new ApiError(
                  409,
                  'PAYOUT_REQUEST_OUTDATED',
                  'As liberações mudaram após o preview.'
                );
              }

              await tx
                .$executeRawUnsafe(
                  `
                    UPDATE public
                      .payout_confirmation_challenges

                    SET
                      status =
                        'authorized',

                      authorized_at =
                        now(),

                      bank_transfer_confirmed =
                        true,

                      authorized_by_merchant_id =
                        $2::uuid,

                      updated_at =
                        now(),

                      metadata =
                        metadata ||
                        $3::jsonb

                    WHERE id =
                        $1::uuid
                  `,
                  challengeId,
                  merchantId,
                  JSON.stringify({
                    authorized:
                      true,

                    authorizationOnly:
                      true,

                    financialImpact:
                      false,

                    payoutEngineCalled:
                      false
                  })
                );

              await insertApprovalAttempt(
                tx,
                {
                  requestId,
                  challengeId,
                  merchantId,

                  actorMerchantId:
                    merchantId,

                  ipHash,

                  succeeded:
                    true,

                  reason:
                    'authorized',

                  metadata: {
                    bankTransferConfirmed:
                      true,

                    financialImpact:
                      false
                  }
                }
              );

              await insertEvent(
                tx,
                {
                  requestId,
                  merchantId,

                  actorMerchantId:
                    merchantId,

                  eventType:
                    'MANAGER_AUTHORIZED',

                  fromStatus:
                    current.serialized
                      .status,

                  toStatus:
                    current.serialized
                      .status,

                  req,

                  payload: {
                    challengeId,

                    bankTransferConfirmed:
                      true,

                    authorizationOnly:
                      true,

                    financialImpact:
                      false,

                    payoutEngineCalled:
                      false
                  }
                }
              );

              return {
                challengeId,

                status:
                  'authorized',

                expiresAt:
                  challenge
                    .expires_at,

                requestVersion:
                  Number(
                    challenge
                      .request_version
                  )
              };
            },
            {
              maxWait:
                10000,

              timeout:
                30000,

              isolationLevel:
                Prisma
                  .TransactionIsolationLevel
                  .Serializable
            }
          );

      return res.json({
        success:
          true,

        data: {
          authorization,

          confirmationReady:
            true,

          financialImpact:
            false,

          payoutEngineCalled:
            false
        }
      });
    } catch (error) {
      return respondError(
        res,
        error
      );
    }
  };
