"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");

for (const envFile of [".env", ".env.production", ".env.local"]) {
  const fullPath = path.resolve(process.cwd(), envFile);

  if (fs.existsSync(fullPath)) {
    dotenv.config({
      path: fullPath,
      override: false,
    });
  }
}

const prisma = new PrismaClient();

const CONFIRM = process.env.CONFIRM === "YES";
const USE_EXISTING_ID =
  String(process.env.USE_EXISTING_ID || "").trim();

const MERCHANT_ID =
  "5d2a2279-deed-4225-b49c-b0c60ebb8580";

const STORE_CODE = "REVEURO1";
const CURRENCY = "EUR";
const AMOUNT = "961.02";

const DESCRIPTION =
  "Saída Re-Investimento TrafegoPago";

const EXTERNAL_REFERENCE =
  "BW-REINV-TRAFEGO-20260727-96102";

const STATEMENT_CODE =
  "PAYOUT-BW-20260727-96102";

const TIMEZONE = "Europe/Lisbon";

function number(value) {
  return Number(value || 0);
}

function money(value) {
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency: CURRENCY,
  }).format(number(value));
}

function civilDate(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

async function query(db, sql, ...parameters) {
  return db.$queryRawUnsafe(sql, ...parameters);
}

async function execute(db, sql, ...parameters) {
  return db.$executeRawUnsafe(sql, ...parameters);
}

async function inspect(db, { lockWallet = false } = {}) {
  const walletRows = await query(
    db,
    `
      SELECT
        id::text,
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
    throw new Error("Wallet EUR do Merchant BW não encontrada.");
  }

  const storeRows = await query(
    db,
    `
      SELECT
        id::text,
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
    throw new Error("Store REVEURO1 não encontrada.");
  }

  const exactRows = await query(
    db,
    `
      SELECT
        id::text,
        statement_code,
        amount::numeric::text,
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
      LIMIT 2
    `,
    MERCHANT_ID,
    CURRENCY,
    EXTERNAL_REFERENCE,
    STATEMENT_CODE,
  );

  const exactStatement = exactRows[0] || null;

  let selectedStatement = exactStatement;

  if (USE_EXISTING_ID) {
    const selectedRows = await query(
      db,
      `
        SELECT
          id::text,
          statement_code,
          amount::numeric::text,
          status,
          scheduled_for::text,
          paid_on::text,
          paid_at::text,
          external_reference,
          description,
          metadata,
          created_at::text

        FROM public.payout_statements

        WHERE id = $1::uuid
          AND merchant_id = $2::uuid
          AND currency = $3

        LIMIT 1
      `,
      USE_EXISTING_ID,
      MERCHANT_ID,
      CURRENCY,
    );

    selectedStatement = selectedRows[0] || null;

    if (!selectedStatement) {
      throw new Error(
        `Payout ${USE_EXISTING_ID} não encontrado para BW.`,
      );
    }

    if (number(selectedStatement.amount) !== number(AMOUNT)) {
      throw new Error(
        `O payout selecionado possui ${money(selectedStatement.amount)}, `
        + `não ${money(AMOUNT)}.`,
      );
    }
  }

  const openRows = await query(
    db,
    `
      SELECT
        id::text,
        statement_code,
        amount::numeric::text,
        status,
        scheduled_for::text,
        paid_on::text,
        paid_at::text,
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

  const movementRows = await query(
    db,
    `
      SELECT
        id::text,
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

  const existingMovement = movementRows[0] || null;

  const lastPayoutMovements = await query(
    db,
    `
      SELECT
        id::text,
        direction,
        status,
        reference,
        amount::numeric::text,
        created_at::text

      FROM public.wallet_movements

      WHERE merchant_id = $1::uuid
        AND currency = $2
        AND type = 'payout'

      ORDER BY created_at DESC
      LIMIT 5
    `,
    MERCHANT_ID,
    CURRENCY,
  );

  const dueReleases = await query(
    db,
    `
      SELECT
        COALESCE(
          manual_estimated_release_on::date,
          provider_available_on::date,
          system_estimated_release_on::date,
          expected_release_at::date
        )::text AS effective_date,

        status,
        COUNT(*)::integer AS movement_count,
        ROUND(SUM(amount)::numeric, 2)::text AS amount

      FROM public.wallet_movements

      WHERE merchant_id = $1::uuid
        AND currency = $2
        AND type = 'payment'
        AND direction = 'in'

      GROUP BY
        COALESCE(
          manual_estimated_release_on::date,
          provider_available_on::date,
          system_estimated_release_on::date,
          expected_release_at::date
        ),
        status

      ORDER BY
        COALESCE(
          manual_estimated_release_on::date,
          provider_available_on::date,
          system_estimated_release_on::date,
          expected_release_at::date
        ),
        status
    `,
    MERCHANT_ID,
    CURRENCY,
  );

  const available = number(wallet.available);
  const reserved = number(wallet.reserved);
  const amount = number(AMOUNT);

  const alreadyPaid =
    selectedStatement?.status === "paid"
    && Boolean(existingMovement);

  let debitSource = null;

  if (!alreadyPaid) {
    if (
      selectedStatement
      && ["draft", "scheduled", "processing", "pending"]
        .includes(selectedStatement.status)
      && reserved >= amount
    ) {
      debitSource = "reserved";
    } else if (available >= amount) {
      debitSource = "available";
    }
  }

  let blockingReason = null;

  if (
    !selectedStatement
    && !USE_EXISTING_ID
    && openRows.length > 0
  ) {
    blockingReason =
      "existing_open_payout_requires_explicit_id";
  } else if (!alreadyPaid && !debitSource) {
    blockingReason =
      "insufficient_available_or_reserved_balance";
  }

  return {
    wallet,
    store,
    selectedStatement,
    exactStatement,
    openRows,
    existingMovement,
    lastPayoutMovements,
    dueReleases,
    alreadyPaid,
    debitSource,
    blockingReason,
    ready:
      alreadyPaid
      || Boolean(debitSource && !blockingReason),
  };
}

function printState(state) {
  console.log("================================================");
  console.log("XPAYMENTS — PAYOUT BW € 961,02");
  console.log("================================================");

  console.log({
    mode: CONFIRM ? "COMMIT" : "READ_ONLY",
    merchantId: MERCHANT_ID,
    storeId: state.store.id,
    storeCode: state.store.store_code,
    storeName: state.store.name,
    amount: money(AMOUNT),
    description: DESCRIPTION,
    reference: EXTERNAL_REFERENCE,
    date: civilDate(TIMEZONE),
  });

  console.log("\nWALLET");
  console.log({
    id: state.wallet.id,
    balance: money(state.wallet.balance),
    available: money(state.wallet.available),
    reserved: money(state.wallet.reserved),
    reconciliationHold:
      money(state.wallet.reconciliation_hold),
  });

  console.log("\nPAYOUT SELECIONADO");
  console.log(
    state.selectedStatement || "Nenhum",
  );

  console.log("\nPAYOUTS ABERTOS DE € 961,02");
  console.log(
    state.openRows.length
      ? state.openRows
      : "Nenhum",
  );

  console.log("\nMOVIMENTO IDEMPOTENTE");
  console.log(
    state.existingMovement || "Nenhum",
  );

  console.log("\nÚLTIMOS MOVIMENTOS DE PAYOUT");
  console.log(state.lastPayoutMovements);

  console.log("\nLIBERAÇÕES REGISTRADAS POR DATA");
  console.log(state.dueReleases);

  console.log("\nRESULTADO DO PREFLIGHT");
  console.log({
    ready: state.ready,
    alreadyPaid: state.alreadyPaid,
    debitSource: state.debitSource,
    blockingReason: state.blockingReason,
  });
}

async function confirmPayout() {
  return prisma.$transaction(
    async (tx) => {
      await query(
        tx,
        `
          SELECT pg_advisory_xact_lock(
            hashtext($1)
          )
        `,
        EXTERNAL_REFERENCE,
      );

      const state = await inspect(tx, {
        lockWallet: true,
      });

      if (state.alreadyPaid) {
        return {
          idempotent: true,
          state,
        };
      }

      if (!state.ready || !state.debitSource) {
        throw new Error(
          `Preflight transacional bloqueado: `
          + `${state.blockingReason || "not_ready"}`,
        );
      }

      const amount = number(AMOUNT);
      const source = state.debitSource;

      const walletUpdated = await execute(
        tx,
        `
          UPDATE public.wallets

          SET
            ${source} = ${source} - $1::numeric,
            balance = balance - $1::numeric

          WHERE id = $2::uuid
            AND ${source} >= $1::numeric
            AND balance >= $1::numeric
        `,
        AMOUNT,
        state.wallet.id,
      );

      if (walletUpdated !== 1) {
        throw new Error(
          "Wallet alterada durante a operação ou saldo insuficiente.",
        );
      }

      const operationMetadata = JSON.stringify({
        operation: "manual_paid_payout",
        purpose: "traffic_reinvestment",
        description: DESCRIPTION,
        merchantId: MERCHANT_ID,
        storeId: state.store.id,
        storeCode: STORE_CODE,
        amount: AMOUNT,
        currency: CURRENCY,
        externalReference: EXTERNAL_REFERENCE,
        confirmedAt: new Date().toISOString(),
        confirmedDate: civilDate(TIMEZONE),
        debitSource: source,
        source: "vps_manual_operation",
      });

      let statement;

      if (state.selectedStatement) {
        const rows = await query(
          tx,
          `
            UPDATE public.payout_statements

            SET
              status = 'paid',
              paid_at = NOW(),
              paid_on = $1::date,
              external_reference = $2,
              description = $3,
              historical_date_only = FALSE,
              metadata =
                COALESCE(metadata, '{}'::jsonb)
                || $4::jsonb,
              updated_at = NOW()

            WHERE id = $5::uuid

            RETURNING
              id::text,
              statement_code,
              amount::numeric::text,
              currency,
              status,
              scheduled_for::text,
              paid_on::text,
              paid_at::text,
              external_reference,
              description
          `,
          civilDate(TIMEZONE),
          EXTERNAL_REFERENCE,
          DESCRIPTION,
          operationMetadata,
          state.selectedStatement.id,
        );

        statement = rows[0];
      } else {
        const rows = await query(
          tx,
          `
            INSERT INTO public.payout_statements (
              id,
              merchant_id,
              statement_code,
              currency,
              amount,
              status,
              scheduled_for,
              paid_at,
              paid_on,
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
              NOW(),
              $5::date,
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
              amount::numeric::text,
              currency,
              status,
              scheduled_for::text,
              paid_on::text,
              paid_at::text,
              external_reference,
              description
          `,
          MERCHANT_ID,
          STATEMENT_CODE,
          CURRENCY,
          AMOUNT,
          civilDate(TIMEZONE),
          EXTERNAL_REFERENCE,
          DESCRIPTION,
          operationMetadata,
        );

        statement = rows[0];
      }

      const allocations = await query(
        tx,
        `
          SELECT
            id::text,
            store_id::text,
            amount::numeric::text

          FROM public.payout_statement_allocations

          WHERE payout_statement_id = $1::uuid
        `,
        statement.id,
      );

      if (allocations.length === 0) {
        await execute(
          tx,
          `
            INSERT INTO public.payout_statement_allocations (
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
      } else {
        const allocationTotal = allocations.reduce(
          (sum, allocation) =>
            sum + number(allocation.amount),
          0,
        );

        const wrongStore = allocations.some(
          (allocation) =>
            allocation.store_id !== state.store.id,
        );

        if (
          Math.abs(allocationTotal - amount) > 0.001
          || wrongStore
        ) {
          throw new Error(
            "As allocations do payout existente não correspondem "
            + "a € 961,02 integralmente na REVEURO1.",
          );
        }
      }

      const movementAlreadyExists = await query(
        tx,
        `
          SELECT id::text

          FROM public.wallet_movements

          WHERE merchant_id = $1::uuid
            AND currency = $2
            AND reference = $3

          LIMIT 1
        `,
        MERCHANT_ID,
        CURRENCY,
        EXTERNAL_REFERENCE,
      );

      if (movementAlreadyExists.length) {
        throw new Error(
          "Já existe WalletMovement com a referência idempotente.",
        );
      }

      const previousMovement =
        state.lastPayoutMovements[0] || null;

      const movementDirection =
        previousMovement?.direction || "out";

      const movementStatus =
        previousMovement?.status || "paid";

      const movementRows = await query(
        tx,
        `
          INSERT INTO public.wallet_movements (
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
            $5,
            $6::numeric,
            $7,
            $8,
            $9::jsonb,
            NOW()
          )

          RETURNING
            id::text,
            type,
            direction,
            amount::numeric::text,
            status,
            reference,
            created_at::text
        `,
        state.wallet.id,
        MERCHANT_ID,
        state.store.id,
        CURRENCY,
        movementDirection,
        AMOUNT,
        movementStatus,
        EXTERNAL_REFERENCE,
        JSON.stringify({
          ...JSON.parse(operationMetadata),
          payoutStatementId: statement.id,
          statementCode: statement.statement_code,
        }),
      );

      const finalWalletRows = await query(
        tx,
        `
          SELECT
            id::text,
            balance::numeric::text,
            available::numeric::text,
            reserved::numeric::text,
            reconciliation_hold::numeric::text

          FROM public.wallets

          WHERE id = $1::uuid
        `,
        state.wallet.id,
      );

      return {
        idempotent: false,
        statement,
        movement: movementRows[0],
        wallet: finalWalletRows[0],
        debitSource: source,
      };
    },
    {
      maxWait: 10000,
      timeout: 30000,
      isolationLevel: "Serializable",
    },
  );
}

async function main() {
  const state = await inspect(prisma);
  printState(state);

  if (!CONFIRM) {
    console.log("\nNenhuma alteração foi realizada.");

    if (
      state.blockingReason ===
      "existing_open_payout_requires_explicit_id"
    ) {
      console.log(
        "\nExiste um payout aberto de € 961,02."
      );

      console.log(
        "Selecione o ID correto e execute o preflight com:"
      );

      console.log(
        "USE_EXISTING_ID=<UUID> "
        + "node scripts/ops/"
        + "confirm-bw-traffic-reinvestment-payout.js"
      );
    }

    return;
  }

  if (!state.ready) {
    throw new Error(
      `Não é seguro confirmar: ${state.blockingReason}`,
    );
  }

  const result = await confirmPayout();

  console.log("\n================================================");
  console.log("PAYOUT CONFIRMADO");
  console.log("================================================");

  if (result.idempotent) {
    console.log(
      "A operação já estava confirmada anteriormente."
    );

    return;
  }

  console.log({
    payoutStatementId: result.statement.id,
    statementCode: result.statement.statement_code,
    status: result.statement.status,
    amount: money(result.statement.amount),
    paidOn: result.statement.paid_on,
    paidAt: result.statement.paid_at,
    description: result.statement.description,
    externalReference:
      result.statement.external_reference,
    walletMovementId: result.movement.id,
    movementDirection: result.movement.direction,
    movementStatus: result.movement.status,
    debitSource: result.debitSource,
    walletBalanceAfter:
      money(result.wallet.balance),
    walletAvailableAfter:
      money(result.wallet.available),
    walletReservedAfter:
      money(result.wallet.reserved),
    reconciliationHold:
      money(result.wallet.reconciliation_hold),
  });
}

main()
  .catch((error) => {
    console.error("\nOPERAÇÃO CANCELADA");
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
