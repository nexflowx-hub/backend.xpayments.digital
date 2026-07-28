"use strict";

const fs = require("fs");

require("dotenv").config({
  path: "/root/xpayments-backend-v3/.env",
  quiet: true,
});

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const MERCHANT_ID =
  "5d2a2279-deed-4225-b49c-b0c60ebb8580";

const CURRENCY = "EUR";

const PENDING_STATUSES = new Set([
  "pending",
  "pendente",
  "processing",
  "em_transito",
  "in_transit",
]);

const round = (value) =>
  Number((Number(value) || 0).toFixed(2));

const add = (map, key, amount) => {
  map[key] = round(
    (map[key] || 0) + Number(amount || 0),
  );
};

function effectiveSchedule(
  schedule,
  initialCarry,
) {
  const result = {};
  let remainingCarry = round(initialCarry);

  for (const date of Object.keys(schedule).sort()) {
    const original = round(schedule[date]);

    const deduction = Math.min(
      original,
      remainingCarry,
    );

    const effective = round(
      original - deduction,
    );

    remainingCarry = round(
      remainingCarry - deduction,
    );

    result[date] = {
      providerNet: original,
      carryApplied: round(deduction),
      effectiveNet: effective,
    };
  }

  return {
    items: result,
    remainingCarry,
  };
}

async function main() {
  const reportPath = process.argv[2];

  if (!reportPath) {
    throw new Error(
      "Informe o caminho do report.json.",
    );
  }

  const report = JSON.parse(
    fs.readFileSync(reportPath, "utf8"),
  );

  const auditRows = report.rows || [];

  if (auditRows.length !== 345) {
    throw new Error(
      `Esperadas 345 linhas; encontradas ${auditRows.length}.`,
    );
  }

  const movements =
    await prisma.$queryRawUnsafe(`
      SELECT
        id::text,
        transaction_id::text,
        reference,
        store_id::text,
        status,
        amount::numeric::text,
        released_at,
        provider_available_on,
        manual_estimated_release_on,
        system_estimated_release_on,
        expected_release_at

      FROM public.wallet_movements

      WHERE merchant_id =
        '${MERCHANT_ID}'::uuid

        AND currency = '${CURRENCY}'
        AND type = 'payment'
        AND direction = 'in'
    `);

  const payouts =
    await prisma.$queryRawUnsafe(`
      SELECT
        allocation.store_id::text
          AS store_id,

        ROUND(
          SUM(
            allocation.amount
          )::numeric,
          2
        )::text
          AS paid_amount

      FROM public.payout_statement_allocations
        AS allocation

      INNER JOIN public.payout_statements
        AS statement
        ON statement.id =
          allocation.payout_statement_id

      WHERE statement.merchant_id =
        '${MERCHANT_ID}'::uuid

        AND statement.currency =
          '${CURRENCY}'

        AND statement.status = 'paid'

      GROUP BY allocation.store_id
    `);

  const walletRows =
    await prisma.$queryRawUnsafe(`
      SELECT
        id::text,
        balance::numeric::text,
        available::numeric::text,
        reserved::numeric::text,
        reconciliation_hold::numeric::text

      FROM public.wallets

      WHERE merchant_id =
        '${MERCHANT_ID}'::uuid

        AND currency = '${CURRENCY}'

      LIMIT 1
    `);

  const feeHoldRows =
    await prisma.$queryRawUnsafe(`
      SELECT
        id::text,
        amount::numeric::text,
        store_id::text,
        status,
        idempotency_key

      FROM public.wallet_movements

      WHERE merchant_id =
        '${MERCHANT_ID}'::uuid

        AND currency = '${CURRENCY}'
        AND type = 'fee_reconciliation'
        AND direction = 'hold'
        AND status = 'active'

      ORDER BY created_at
    `);

  const movementByTransaction =
    new Map();

  for (const movement of movements) {
    if (movement.transaction_id) {
      movementByTransaction.set(
        movement.transaction_id,
        movement,
      );
    }

    if (movement.reference) {
      movementByTransaction.set(
        String(movement.reference),
        movement,
      );
    }
  }

  const payoutByStore =
    new Map(
      payouts.map((row) => [
        row.store_id,
        round(row.paid_amount),
      ]),
    );

  const groups = new Map();

  let missingMovements = 0;

  for (const row of auditRows) {
    const movement =
      movementByTransaction.get(
        row.transactionId,
      );

    if (!movement) {
      missingMovements += 1;
      continue;
    }

    const storeId =
      row.storeId ||
      movement.store_id ||
      "UNKNOWN";

    if (!groups.has(storeId)) {
      groups.set(storeId, {
        storeId,
        storeCode: row.storeCode,
        storeName: row.storeName,
        gateway: row.gateway,
        transactions: 0,
        gross: 0,
        providerFees: 0,
        platformFees: 0,
        totalFees: 0,
        correctedNet: 0,
        originalMovementNet: 0,
        pendingTransactions: 0,
        pendingProviderFees: 0,
        pendingCorrectedNet: 0,
        releasedTransactions: 0,
        releasedProviderFees: 0,
        releasedCorrectedNet: 0,
        providerSchedule: {},
      });
    }

    const group = groups.get(storeId);

    const isPending =
      PENDING_STATUSES.has(
        String(movement.status)
          .trim()
          .toLowerCase(),
      );

    group.transactions += 1;
    group.gross += Number(row.gross);
    group.providerFees +=
      Number(row.providerFee || 0);
    group.platformFees +=
      Number(row.platformFee || 0);
    group.totalFees +=
      Number(row.totalMerchantFee || 0);
    group.correctedNet +=
      Number(row.correctedMerchantNet || 0);
    group.originalMovementNet +=
      Number(movement.amount || 0);

    if (isPending) {
      group.pendingTransactions += 1;
      group.pendingProviderFees +=
        Number(row.providerFee || 0);
      group.pendingCorrectedNet +=
        Number(row.correctedMerchantNet || 0);

      const providerDate =
        row.availableOnLisbon ||
        movement.provider_available_on ||
        movement.manual_estimated_release_on ||
        movement.system_estimated_release_on ||
        null;

      if (providerDate) {
        add(
          group.providerSchedule,
          String(providerDate).slice(0, 10),
          row.correctedMerchantNet,
        );
      }
    } else {
      group.releasedTransactions += 1;
      group.releasedProviderFees +=
        Number(row.providerFee || 0);
      group.releasedCorrectedNet +=
        Number(row.correctedMerchantNet || 0);
    }
  }

  const finalGroups = [];

  for (const group of groups.values()) {
    const paidPayouts =
      payoutByStore.get(group.storeId) || 0;

    const carryForward = Math.max(
      0,
      round(
        paidPayouts -
        group.releasedCorrectedNet,
      ),
    );

    const adjustedSchedule =
      effectiveSchedule(
        group.providerSchedule,
        carryForward,
      );

    finalGroups.push({
      ...group,

      gross: round(group.gross),

      providerFees:
        round(group.providerFees),

      platformFees:
        round(group.platformFees),

      totalFees:
        round(group.totalFees),

      correctedNet:
        round(group.correctedNet),

      originalMovementNet:
        round(group.originalMovementNet),

      pendingProviderFees:
        round(group.pendingProviderFees),

      pendingCorrectedNet:
        round(group.pendingCorrectedNet),

      releasedProviderFees:
        round(group.releasedProviderFees),

      releasedCorrectedNet:
        round(group.releasedCorrectedNet),

      paidPayouts,

      operationalBalance:
        round(
          group.correctedNet -
          paidPayouts,
        ),

      carryForward,

      providerSchedule:
        group.providerSchedule,

      effectiveSchedule:
        adjustedSchedule.items,

      remainingCarry:
        adjustedSchedule.remainingCarry,
    });
  }

  finalGroups.sort(
    (a, b) =>
      String(a.storeCode)
        .localeCompare(
          String(b.storeCode),
        ),
  );

  const wallet = walletRows[0];

  if (!wallet) {
    throw new Error(
      "Wallet EUR não localizada.",
    );
  }

  const activeProvisionalHold =
    round(
      feeHoldRows.reduce(
        (sum, row) =>
          sum + Number(row.amount),
        0,
      ),
    );

  const providerFees =
    round(
      auditRows.reduce(
        (sum, row) =>
          sum +
          Number(row.providerFee || 0),
        0,
      ),
    );

  const currentBookBalance =
    round(wallet.balance);

  const currentReconciliationHold =
    round(wallet.reconciliation_hold);

  const targetBookBalance =
    round(
      currentBookBalance -
      providerFees,
    );

  const targetReconciliationHold =
    round(
      currentReconciliationHold -
      activeProvisionalHold,
    );

  const currentMerchantWallet =
    round(
      currentBookBalance -
      currentReconciliationHold,
    );

  const targetMerchantWallet =
    round(
      targetBookBalance -
      targetReconciliationHold,
    );

  const output = {
    generatedAt:
      new Date().toISOString(),

    mode: "READ_ONLY",

    validation: {
      auditTransactions:
        auditRows.length,

      mappedMovements:
        auditRows.length -
        missingMovements,

      missingMovements,

      providerFees,
    },

    wallet: {
      current: {
        bookBalance:
          currentBookBalance,

        reconciliationHold:
          currentReconciliationHold,

        merchantWallet:
          currentMerchantWallet,

        available:
          round(wallet.available),

        reserved:
          round(wallet.reserved),
      },

      provisionalFeeHold:
        activeProvisionalHold,

      target: {
        bookBalance:
          targetBookBalance,

        reconciliationHold:
          targetReconciliationHold,

        merchantWallet:
          targetMerchantWallet,

        available: 0,

        reserved: 0,
      },

      additionalMerchantReduction:
        round(
          currentMerchantWallet -
          targetMerchantWallet,
        ),
    },

    feeHolds:
      feeHoldRows.map((row) => ({
        id: row.id,
        storeId: row.store_id,
        amount: round(row.amount),
        status: row.status,
        idempotencyKey:
          row.idempotency_key,
      })),

    stores: finalGroups,
  };

  const totalOperationalBalance =
    round(
      finalGroups.reduce(
        (sum, group) =>
          sum +
          group.operationalBalance,
        0,
      ),
    );

  const totalCarryForward =
    round(
      finalGroups.reduce(
        (sum, group) =>
          sum +
          group.carryForward,
        0,
      ),
    );

  output.summary = {
    operationalBalance:
      totalOperationalBalance,

    carryForward:
      totalCarryForward,

    expectedMerchantWallet:
      targetMerchantWallet,

    exactMatch:
      totalOperationalBalance ===
      targetMerchantWallet,
  };

  console.log(
    JSON.stringify(
      output,
      null,
      2,
    ),
  );

  if (missingMovements !== 0) {
    throw new Error(
      `${missingMovements} movimentos não foram ligados.`,
    );
  }

  if (
    providerFees !==
    round(report.totals.providerFees)
  ) {
    throw new Error(
      "Provider fees não coincidem com o relatório Stripe.",
    );
  }

  if (
    totalOperationalBalance !==
    targetMerchantWallet
  ) {
    throw new Error(
      "Saldo operacional não coincide com Wallet Merchant alvo.",
    );
  }
}

main()
  .catch((error) => {
    console.error(
      "PREFLIGHT_FATAL:",
      error.message || error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
