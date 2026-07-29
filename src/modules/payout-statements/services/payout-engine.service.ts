import {
  Prisma
} from '@prisma/client';

import prisma from '../../../core/prisma';

export type PayoutFundingSource = {
  sourceType:
    | 'wallet_movement'
    | 'treasury_advance'
    | 'manual_adjustment'
    | 'reserve';

  walletMovementId?: string | null;
  amount: number;
  metadata?: Record<string, unknown>;
};

export type ConfirmPaidPayoutInput = {
  merchantId: string;
  walletId: string;
  storeId: string;

  statementCode: string;
  idempotencyKey: string;
  externalReference?: string | null;

  currency: string;
  amount: number;

  scheduledFor: string;
  paidOn: string;

  description?: string | null;
  createdBy: string;

  fundingSources: PayoutFundingSource[];

  metadata?: Record<string, unknown>;
};

type DatabaseRow =
  Record<string, any>;

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

const parseMetadata = (
  value: unknown
): Record<string, unknown> => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as
      Record<string, unknown>;
  }

  if (typeof value === 'string') {
    try {
      const parsed =
        JSON.parse(value);

      return (
        parsed &&
        typeof parsed === 'object'
      )
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
};

const insertStoreAllocation = async (
  tx: Prisma.TransactionClient,
  input: ConfirmPaidPayoutInput,
  payoutStatementId: string
): Promise<string> => {
  const schemaRows =
    await tx.$queryRawUnsafe<
      DatabaseRow[]
    >(`
      SELECT
        column_name

      FROM information_schema.columns

      WHERE table_schema = 'public'
        AND table_name =
          'payout_statement_allocations'
    `);

  const columnsAvailable =
    new Set(
      schemaRows.map(
        row =>
          String(row.column_name)
      )
    );

  const columns: string[] = [
    'payout_statement_id',
    'store_id',
    'amount'
  ];

  const values: unknown[] = [
    payoutStatementId,
    input.storeId,
    input.amount
  ];

  const casts: string[] = [
    '::uuid',
    '::uuid',
    '::numeric'
  ];

  if (
    columnsAvailable.has(
      'merchant_id'
    )
  ) {
    columns.push('merchant_id');
    values.push(input.merchantId);
    casts.push('::uuid');
  }

  if (
    columnsAvailable.has(
      'currency'
    )
  ) {
    columns.push('currency');
    values.push(input.currency);
    casts.push('::text');
  }

  if (
    columnsAvailable.has(
      'created_by'
    )
  ) {
    columns.push('created_by');
    values.push(input.createdBy);
    casts.push('::text');
  }

  if (
    columnsAvailable.has(
      'metadata'
    )
  ) {
    columns.push('metadata');

    values.push(
      JSON.stringify({
        source:
          'atomic_payout_engine_v42',

        statementCode:
          input.statementCode,

        idempotencyKey:
          input.idempotencyKey
      })
    );

    casts.push('::jsonb');
  }

  const placeholders =
    values.map(
      (_value, index) =>
        `$${index + 1}${casts[index]}`
    );

  const rows =
    await tx.$queryRawUnsafe<
      DatabaseRow[]
    >(
      `
        INSERT INTO
          public.payout_statement_allocations (
            ${columns.join(', ')}
          )

        VALUES (
          ${placeholders.join(', ')}
        )

        RETURNING id::text
      `,
      ...values
    );

  if (rows.length !== 1) {
    throw new Error(
      'Falha ao criar allocation da Store.'
    );
  }

  return String(rows[0].id);
};

export const confirmPaidPayoutInTransaction =
  async (
    tx: Prisma.TransactionClient,
    input: ConfirmPaidPayoutInput
  ) => {
    const amount =
      money(input.amount);

    if (amount <= 0) {
      throw new Error(
        'Valor do payout inválido.'
      );
    }

    const currency =
      input.currency
        .trim()
        .toUpperCase();

    const fundingTotal =
      money(
        input.fundingSources.reduce(
          (
            total,
            source
          ) =>
            total +
            money(source.amount),
          0
        )
      );

    if (fundingTotal !== amount) {
      throw new Error(
        `Funding ${fundingTotal} não coincide com payout ${amount}.`
      );
    }

    const duplicate =
      await tx.$queryRawUnsafe<
        DatabaseRow[]
      >(
        `
          SELECT
            id::text,
            statement_code

          FROM public.payout_statements

          WHERE merchant_id =
            $1::uuid

            AND (
              statement_code = $2
              OR idempotency_key = $3
            )

          FOR UPDATE
        `,
        input.merchantId,
        input.statementCode,
        input.idempotencyKey
      );

    if (duplicate.length > 0) {
      throw new Error(
        `Payout duplicado: ${input.statementCode}.`
      );
    }

    const walletRows =
      await tx.$queryRawUnsafe<
        DatabaseRow[]
      >(
        `
          SELECT
            id::text,
            merchant_id::text,
            currency,
            balance::text,
            available::text,
            reserved::text,
            reconciliation_hold::text

          FROM public.wallets

          WHERE id = $1::uuid

          FOR UPDATE
        `,
        input.walletId
      );

    if (walletRows.length !== 1) {
      throw new Error(
        'Wallet não encontrada.'
      );
    }

    const walletBefore =
      walletRows[0];

    if (
      walletBefore.merchant_id !==
        input.merchantId ||
      String(
        walletBefore.currency
      ).toUpperCase() !== currency
    ) {
      throw new Error(
        'Wallet não pertence ao Merchant/moeda.'
      );
    }

    if (
      money(walletBefore.balance) <
      amount
    ) {
      throw new Error(
        'Saldo insuficiente para o payout.'
      );
    }

    for (
      const source of
      input.fundingSources
    ) {
      if (
        source.sourceType !==
          'wallet_movement'
      ) {
        if (source.walletMovementId) {
          throw new Error(
            'Origem não movement não pode informar walletMovementId.'
          );
        }

        continue;
      }

      if (!source.walletMovementId) {
        throw new Error(
          'walletMovementId obrigatório.'
        );
      }

      const movementRows =
        await tx.$queryRawUnsafe<
          DatabaseRow[]
        >(
          `
            SELECT
              id::text,
              merchant_id::text,
              store_id::text,
              currency,
              type,
              direction,
              status,

              GREATEST(
                COALESCE(
                  merchant_net,
                  amount -
                    COALESCE(
                      provider_fee,
                      0
                    )
                ),
                0
              )::text AS capacity

            FROM public.wallet_movements

            WHERE id = $1::uuid

            FOR UPDATE
          `,
          source.walletMovementId
        );

      if (
        movementRows.length !== 1
      ) {
        throw new Error(
          `Movimento não encontrado: ${source.walletMovementId}.`
        );
      }

      const movement =
        movementRows[0];

      if (
        movement.merchant_id !==
          input.merchantId ||
        movement.store_id !==
          input.storeId ||
        String(
          movement.currency
        ).toUpperCase() !== currency ||
        movement.type !== 'payment' ||
        movement.direction !== 'in'
      ) {
        throw new Error(
          `Movimento incompatível: ${source.walletMovementId}.`
        );
      }

      const allocatedRows =
        await tx.$queryRawUnsafe<
          DatabaseRow[]
        >(
          `
            SELECT
              COALESCE(
                SUM(allocated_amount),
                0
              )::text AS allocated

            FROM public.payout_funding_allocations

            WHERE wallet_movement_id =
              $1::uuid
          `,
          source.walletMovementId
        );

      const capacity =
        money(movement.capacity);

      const alreadyAllocated =
        money(
          allocatedRows[0]
            ?.allocated
        );

      const remaining =
        money(
          capacity -
          alreadyAllocated
        );

      if (
        money(source.amount) >
        remaining
      ) {
        throw new Error(
          `Alocação excede o movimento ${source.walletMovementId}.`
        );
      }
    }

    const payoutMetadata = {
      ...parseMetadata(
        input.metadata
      ),

      payoutEngine: {
        version:
          '4.2',

        atomic:
          true,

        idempotencyKey:
          input.idempotencyKey,

        fundingTotal,

        fundingSources:
          input.fundingSources.length,

        createdAt:
          new Date().toISOString()
      }
    };

    const payoutRows =
      await tx.$queryRawUnsafe<
        DatabaseRow[]
      >(
        `
          INSERT INTO
            public.payout_statements (
              statement_code,
              merchant_id,
              wallet_id,
              currency,
              amount,
              status,
              scheduled_for,
              paid_on,
              paid_at,
              external_reference,
              description,
              idempotency_key,
              historical_date_only,
              created_by,
              paid_by,
              metadata
            )

          VALUES (
            $1,
            $2::uuid,
            $3::uuid,
            $4,
            $5::numeric,
            'paid',
            $6::date,
            $7::date,
            NOW(),
            $8,
            $9,
            $10,
            FALSE,
            $11,
            $11,
            $12::jsonb
          )

          RETURNING
            id::text,
            statement_code,
            amount::text,
            status,
            paid_on::text
        `,
        input.statementCode,
        input.merchantId,
        input.walletId,
        currency,
        amount,
        input.scheduledFor,
        input.paidOn,
        input.externalReference ||
          null,
        input.description ||
          null,
        input.idempotencyKey,
        input.createdBy,
        JSON.stringify(
          payoutMetadata
        )
      );

    if (payoutRows.length !== 1) {
      throw new Error(
        'Falha ao criar payout statement.'
      );
    }

    const payout =
      payoutRows[0];

    const storeAllocationId =
      await insertStoreAllocation(
        tx,
        {
          ...input,
          amount,
          currency
        },
        String(payout.id)
      );

    const fundingAllocationIds:
      string[] = [];

    for (
      const source of
      input.fundingSources
    ) {
      const rows =
        await tx.$queryRawUnsafe<
          DatabaseRow[]
        >(
          `
            INSERT INTO
              public.payout_funding_allocations (
                payout_statement_id,
                merchant_id,
                store_id,
                wallet_movement_id,
                source_type,
                allocated_amount,
                currency,
                metadata
              )

            VALUES (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              $5,
              $6::numeric,
              $7,
              $8::jsonb
            )

            RETURNING id::text
          `,
          payout.id,
          input.merchantId,
          input.storeId,
          source.walletMovementId ||
            null,
          source.sourceType,
          money(source.amount),
          currency,
          JSON.stringify({
            source:
              'atomic_payout_engine_v42',

            ...(
              source.metadata ||
              {}
            )
          })
        );

      if (rows.length !== 1) {
        throw new Error(
          'Falha ao criar funding allocation.'
        );
      }

      fundingAllocationIds.push(
        String(rows[0].id)
      );
    }

    const movementRows =
      await tx.$queryRawUnsafe<
        DatabaseRow[]
      >(
        `
          INSERT INTO
            public.wallet_movements (
              wallet_id,
              merchant_id,
              store_id,
              currency,
              type,
              direction,
              amount,
              status,
              reference,
              payout_statement_id,
              metadata
            )

          VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            'payout',
            'out',
            $5::numeric,
            'completed',
            $6,
            $7::uuid,
            $8::jsonb
          )

          RETURNING
            id::text,
            amount::text,
            status,
            reference
        `,
        input.walletId,
        input.merchantId,
        input.storeId,
        currency,
        amount,
        input.externalReference ||
          input.statementCode,
        payout.id,
        JSON.stringify({
          operation:
            'atomic_paid_payout',

          engineVersion:
            '4.2',

          payoutStatementId:
            payout.id,

          statementCode:
            input.statementCode,

          fundingTotal,

          fundingAllocationCount:
            fundingAllocationIds.length
        })
      );

    if (movementRows.length !== 1) {
      throw new Error(
        'Falha ao criar movimento de saída.'
      );
    }

    const walletAfterRows =
      await tx.$queryRawUnsafe<
        DatabaseRow[]
      >(
        `
          UPDATE public.wallets

          SET balance =
            balance -
            $2::numeric

          WHERE id = $1::uuid

            AND merchant_id =
              $3::uuid

            AND upper(currency) =
              $4

            AND balance >=
              $2::numeric

          RETURNING
            id::text,
            balance::text,
            available::text,
            reserved::text,
            reconciliation_hold::text
        `,
        input.walletId,
        amount,
        input.merchantId,
        currency
      );

    if (
      walletAfterRows.length !== 1
    ) {
      throw new Error(
        'Falha ao debitar wallet.'
      );
    }

    return {
      payout,
      storeAllocationId,
      fundingAllocationIds,
      payoutMovement:
        movementRows[0],
      walletBefore,
      walletAfter:
        walletAfterRows[0]
    };
  };

export const confirmPaidPayout =
  async (
    input: ConfirmPaidPayoutInput
  ) =>
    prisma.$transaction(
      tx =>
        confirmPaidPayoutInTransaction(
          tx,
          input
        ),
      {
        maxWait:
          10000,

        timeout:
          30000,

        isolationLevel:
          Prisma.TransactionIsolationLevel
            .Serializable
      }
    );
