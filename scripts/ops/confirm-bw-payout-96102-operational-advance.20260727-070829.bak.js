"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

for (const envFile of [
  ".env",
  ".env.production",
  ".env.local",
]) {
  const fullPath = path.resolve(
    process.cwd(),
    envFile,
  );

  if (fs.existsSync(fullPath)) {
    dotenv.config({
      path: fullPath,
      override: false,
    });
  }
}

const prisma = new PrismaClient();

const CONFIRM =
  process.env.CONFIRM === "YES";

const MERCHANT_ID =
  "5d2a2279-deed-4225-b49c-b0c60ebb8580";

const STORE_CODE = "REVEURO1";
const CURRENCY = "EUR";
const AMOUNT = 961.02;
const RELEASE_DATE = "2026-07-27";

const DESCRIPTION =
  "Saída Re-Investimento TrafegoPago";

const EXTERNAL_REFERENCE =
  "BW-REINV-TRAFEGO-20260727-96102";

const STATEMENT_CODE =
  "PAYOUT-BW-20260727-96102";

function n(value) {
  return Number(value || 0);
}

function round(value) {
  return Number(n(value).toFixed(2));
}

function money(value) {
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency: CURRENCY,
  }).format(n(value));
}

async function query(
  db,
  sql,
  ...parameters
) {
  return db.$queryRawUnsafe(
    sql,
    ...parameters,
  );
}

async function execute(
  db,
  sql,
  ...parameters
) {
  return db.$executeRawUnsafe(
    sql,
    ...parameters,
  );
}

async function loadState(
  db,
  lockWallet = false,
) {
  const storeRows = await query(
    db,
    `
      SELECT
        id::text,
        merchant_id::text,
        store_code,
        name,
        status,
        currency

      FROM public.stores

      WHERE merchant_id = $1::uuid
        AND store_code = $2

      LIMIT 1
    `,
    MERCHANT_ID,
    STORE_CODE,
  );

  const store = storeRows[0];

  if (!store) {
    throw new Error(
      "Store REVEURO1 não encontrada.",
    );
  }

  const walletRows = await query(
    db,
    `
      SELECT
        id::text,
        merchant_id::text,
        currency,
        balance::numeric::text,
        available::numeric::text,
        reserved::numeric::text,
        reconciliation_hold::numeric::text

      FROM public.wallets

      WHERE merchant_id = $1::uuid
        AND currency = $2

      LIMIT 1
      ${lockWallet ? "FOR UPDATE" : ""}
    `,
    MERCHANT_ID,
    CURRENCY,
  );

  const wallet = walletRows[0];

  if (!wallet) {
    throw new Error(
      "Wallet EUR do Merchant BW não encontrada.",
    );
  }

  const statementRows = await query(
    db,
    `
      SELECT
        id::text,
        statement_code,
        amount::numeric::text,
        currency,
        status,
        scheduled_for::text,
        paid_on::text,
        paid_at::text,
        external_reference,
        description,
        metadata,
        created_at::text

      FROM public.payout_statements

      WHERE merchant_id = $1::uuid
        AND currency = $2
        AND (
          external_reference = $3
          OR statement_code = $4
        )

      ORDER BY created_at DESC
    `,
    MERCHANT_ID,
    CURRENCY,
    EXTERNAL_REFERENCE,
    STATEMENT_CODE,
  );

  const movementRows = await query(
    db,
    `
      SELECT
        id::text,
        wallet_id::text,
        store_id::text,
        type,
        direction,
        amount::numeric::text,
        status,
        reference,
        metadata,
        created_at::text

      FROM public.wallet_movements

      WHERE merchant_id = $1::uuid
        AND currency = $2
        AND reference = $3

      ORDER BY created_at DESC
    `,
    MERCHANT_ID,
    CURRENCY,
    EXTERNAL_REFERENCE,
  );

  const openSameAmount = await query(
    db,
    `
      SELECT
        id::text,
        statement_code,
        amount::numeric::text,
        status,
        scheduled_for::text,
        external_reference,
        description,
        created_at::text

      FROM public.payout_statements

      WHERE merchant_id = $1::uuid
        AND currency = $2
        AND amount = $3::numeric
        AND status IN (
          'draft',
          'scheduled',
          'processing',
          'pending'
        )

      ORDER BY created_at DESC
    `,
    MERCHANT_ID,
    CURRENCY,
    AMOUNT,
  );

  const releaseRows = await query(
    db,
    `
      SELECT
        COUNT(*)::integer
          AS movement_count,

        ROUND(
          SUM(amount)::numeric,
          2
        )::text
          AS movement_amount

      FROM public.wallet_movements

      WHERE merchant_id = $1::uuid
        AND store_id = $2::uuid
        AND currency = $3
        AND type = 'payment'
        AND direction = 'in'
        AND status = 'pendente'

        AND COALESCE(
          manual_estimated_release_on::date,
          provider_available_on::date,
          system_estimated_release_on::date,
          expected_release_at::date
        ) = $4::date
    `,
    MERCHANT_ID,
    store.id,
    CURRENCY,
    RELEASE_DATE,
  );

  const release = releaseRows[0];

  const merchantWallet = round(
    n(wallet.balance)
    - n(wallet.reconciliation_hold),
  );

  const alreadyConfirmed =
    statementRows.length === 1
    && movementRows.length === 1
    && statementRows[0].status === "paid";

  let blockingReason = null;

  if (
    statementRows.length > 1
    || movementRows.length > 1
  ) {
    blockingReason =
      "duplicate_idempotency_records";
  } else if (
    statementRows.length === 1
    && movementRows.length === 0
  ) {
    blockingReason =
      "statement_exists_without_movement";
  } else if (
    statementRows.length === 0
    && movementRows.length === 1
  ) {
    blockingReason =
      "movement_exists_without_statement";
  } else if (
    !alreadyConfirmed
    && openSameAmount.length > 0
  ) {
    blockingReason =
      "another_open_payout_same_amount";
  } else if (
    !alreadyConfirmed
    && merchantWallet < AMOUNT
  ) {
    blockingReason =
      "insufficient_merchant_wallet";
  } else if (
    !alreadyConfirmed
    && (
      n(release?.movement_count) !== 29
      || round(release?.movement_amount)
        !== AMOUNT
    )
  ) {
    blockingReason =
      "release_snapshot_changed";
  }

  return {
    store,
    wallet,
    statement:
      statementRows[0] || null,
    movement:
      movementRows[0] || null,
    openSameAmount,
    release,
    merchantWallet,
    alreadyConfirmed,
    blockingReason,
    ready:
      alreadyConfirmed
      || !blockingReason,
  };
}

function printState(state) {
  console.log(
    "================================================",
  );

  console.log(
    "XPAYMENTS — PAYOUT OPERACIONAL BW",
  );

  console.log(
    "================================================",
  );

  console.log({
    mode:
      CONFIRM
        ? "COMMIT"
        : "READ_ONLY",

    merchantId:
      MERCHANT_ID,

    storeId:
      state.store.id,

    storeCode:
      state.store.store_code,

    storeName:
      state.store.name,

    amount:
      money(AMOUNT),

    description:
      DESCRIPTION,

    externalReference:
      EXTERNAL_REFERENCE,

    releaseDate:
      RELEASE_DATE,

    fundingMode:
      "operational_advance_pending_release",
  });

  console.log("\nWALLET");

  console.log({
    balance:
      money(state.wallet.balance),

    reconciliationHold:
      money(
        state.wallet
          .reconciliation_hold,
      ),

    merchantWallet:
      money(state.merchantWallet),

    available:
      money(state.wallet.available),

    reserved:
      money(state.wallet.reserved),
  });

  console.log(
    "\nLIBERAÇÃO PENDENTE DE REFERÊNCIA",
  );

  console.log({
    date:
      RELEASE_DATE,

    store:
      STORE_CODE,

    movementCount:
      n(
        state.release
          ?.movement_count,
      ),

    movementAmount:
      money(
        state.release
          ?.movement_amount,
      ),

    releaseWillBeModified:
      false,
  });

  console.log(
    "\nREGISTOS IDEMPOTENTES",
  );

  console.log({
    statement:
      state.statement,

    movement:
      state.movement,

    otherOpenSameAmount:
      state.openSameAmount,
  });

  console.log(
    "\nRESULTADO DO PREFLIGHT",
  );

  console.log({
    ready:
      state.ready,

    alreadyConfirmed:
      state.alreadyConfirmed,

    blockingReason:
      state.blockingReason,

    walletBalanceAfter:
      money(
        n(state.wallet.balance)
        - AMOUNT,
      ),

    merchantWalletAfter:
      money(
        state.merchantWallet
        - AMOUNT,
      ),

    availableAfter:
      money(
        state.wallet.available,
      ),

    reconciliationHoldAfter:
      money(
        state.wallet
          .reconciliation_hold,
      ),
  });
}

async function commitOperation() {
  return prisma.$transaction(
    async (tx) => {
      await query(
        tx,
        `
          WITH advisory_lock AS (
            SELECT pg_advisory_xact_lock(
              hashtext($1)
            )
          )

          SELECT
            1::integer AS locked

          FROM advisory_lock
        `,
        EXTERNAL_REFERENCE,
      );

      const state = await loadState(
        tx,
        true,
      );

      if (state.alreadyConfirmed) {
        return {
          idempotent: true,
          state,
        };
      }

      if (!state.ready) {
        throw new Error(
          `Operação bloqueada: `
          + `${state.blockingReason}`,
        );
      }

      const walletUpdated = await execute(
        tx,
        `
          UPDATE public.wallets

          SET balance =
            balance - $1::numeric

          WHERE id = $2::uuid

            AND (
              balance
              - reconciliation_hold
            ) >= $1::numeric
        `,
        AMOUNT,
        state.wallet.id,
      );

      if (walletUpdated !== 1) {
        throw new Error(
          "A Wallet foi alterada durante "
          + "a confirmação ou deixou de "
          + "possuir cobertura suficiente.",
        );
      }

      const metadata = {
        operation:
          "manual_paid_payout",

        fundingMode:
          "operational_advance_pending_release",

        carryForwardRequired:
          true,

        sourceReleaseDate:
          RELEASE_DATE,

        sourceReleaseStoreId:
          state.store.id,

        sourceReleaseStoreCode:
          STORE_CODE,

        sourceReleaseMovementCount:
          n(
            state.release
              .movement_count,
          ),

        sourceReleaseAmountSnapshot:
          round(
            state.release
              .movement_amount,
          ),

        pendingReleaseWasModified:
          false,

        merchantId:
          MERCHANT_ID,

        storeId:
          state.store.id,

        storeCode:
          STORE_CODE,

        amount:
          AMOUNT,

        currency:
          CURRENCY,

        description:
          DESCRIPTION,

        externalReference:
          EXTERNAL_REFERENCE,

        confirmedAt:
          new Date().toISOString(),

        confirmedBy:
          "manual_vps_operation",
      };

      const statementRows = await query(
        tx,
        `
          INSERT INTO
            public.payout_statements (
              id,
              merchant_id,
              statement_code,
              currency,
              amount,
              status,
              scheduled_for,
              paid_on,
              paid_at,
              historical_date_only,
              external_reference,
              description,
              metadata,
              created_at,
              updated_at
            )

          VALUES (
            gen_random_uuid(),
            $1::uuid,
            $2,
            $3,
            $4::numeric,
            'paid',
            $5::date,
            $5::date,
            NOW(),
            FALSE,
            $6,
            $7,
            $8::jsonb,
            NOW(),
            NOW()
          )

          RETURNING
            id::text,
            statement_code,
            currency,
            amount::numeric::text,
            status,
            scheduled_for::text,
            paid_on::text,
            paid_at::text,
            external_reference,
            description,
            metadata
        `,
        MERCHANT_ID,
        STATEMENT_CODE,
        CURRENCY,
        AMOUNT,
        RELEASE_DATE,
        EXTERNAL_REFERENCE,
        DESCRIPTION,
        JSON.stringify(metadata),
      );

      const statement =
        statementRows[0];

      await execute(
        tx,
        `
          INSERT INTO
            public.payout_statement_allocations (
              id,
              payout_statement_id,
              store_id,
              amount,
              created_at
            )

          VALUES (
            gen_random_uuid(),
            $1::uuid,
            $2::uuid,
            $3::numeric,
            NOW()
          )
        `,
        statement.id,
        state.store.id,
        AMOUNT,
      );

      const movementRows = await query(
        tx,
        `
          INSERT INTO
            public.wallet_movements (
              id,
              wallet_id,
              merchant_id,
              store_id,
              currency,
              type,
              direction,
              amount,
              status,
              reference,
              metadata,
              created_at
            )

          VALUES (
            gen_random_uuid(),
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            'payout',
            'out',
            $5::numeric,
            'completed',
            $6,
            $7::jsonb,
            NOW()
          )

          RETURNING
            id::text,
            type,
            direction,
            amount::numeric::text,
            status,
            reference,
            metadata,
            created_at::text
        `,
        state.wallet.id,
        MERCHANT_ID,
        state.store.id,
        CURRENCY,
        AMOUNT,
        EXTERNAL_REFERENCE,
        JSON.stringify({
          ...metadata,

          payoutStatementId:
            statement.id,

          statementCode:
            statement
              .statement_code,
        }),
      );

      const finalWalletRows =
        await query(
          tx,
          `
            SELECT
              id::text,
              balance::numeric::text,
              available::numeric::text,
              reserved::numeric::text,
              reconciliation_hold::numeric::text,

              ROUND(
                (
                  balance
                  - reconciliation_hold
                )::numeric,
                2
              )::text
                AS merchant_wallet

            FROM public.wallets

            WHERE id = $1::uuid
          `,
          state.wallet.id,
        );

      return {
        idempotent: false,
        statement,
        movement:
          movementRows[0],
        wallet:
          finalWalletRows[0],
      };
    },
    {
      maxWait: 10000,
      timeout: 30000,
      isolationLevel:
        "Serializable",
    },
  );
}

async function main() {
  const state =
    await loadState(prisma);

  printState(state);

  if (!CONFIRM) {
    console.log(
      "\nNenhuma alteração foi realizada.",
    );

    console.log(
      "Para confirmar, execute com CONFIRM=YES.",
    );

    return;
  }

  if (!state.ready) {
    throw new Error(
      `Preflight não aprovado: `
      + `${state.blockingReason}`,
    );
  }

  const result =
    await commitOperation();

  console.log(
    "\n================================================",
  );

  console.log(
    "PAYOUT CONFIRMADO COM SUCESSO",
  );

  console.log(
    "================================================",
  );

  if (result.idempotent) {
    console.log(
      "A operação já estava confirmada.",
    );

    return;
  }

  console.log({
    payoutStatementId:
      result.statement.id,

    statementCode:
      result.statement
        .statement_code,

    status:
      result.statement.status,

    amount:
      money(
        result.statement.amount,
      ),

    paidOn:
      result.statement.paid_on,

    paidAt:
      result.statement.paid_at,

    description:
      result.statement.description,

    externalReference:
      result.statement
        .external_reference,

    movementId:
      result.movement.id,

    movementStatus:
      result.movement.status,

    movementDirection:
      result.movement.direction,

    walletBalanceAfter:
      money(
        result.wallet.balance,
      ),

    merchantWalletAfter:
      money(
        result.wallet
          .merchant_wallet,
      ),

    availableAfter:
      money(
        result.wallet.available,
      ),

    reservedAfter:
      money(
        result.wallet.reserved,
      ),

    reconciliationHold:
      money(
        result.wallet
          .reconciliation_hold,
      ),
  });
}

main()
  .catch((error) => {
    console.error(
      "\nOPERAÇÃO CANCELADA",
    );

    console.error(
      error.message || error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
