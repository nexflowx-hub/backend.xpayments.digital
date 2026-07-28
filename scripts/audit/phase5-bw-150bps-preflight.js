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

const PLATFORM_FEE_BPS = Number(
  process.env.PLATFORM_FEE_BPS || 150,
);

const EXPECTED_TRANSACTIONS = 345;
const EXPECTED_PROVIDER_FEES = 259.74;
const EXPECTED_PAYOUT_COUNT = 3;
const EXPECTED_PAYOUT_TOTAL = 3230.36;

const PENDING_STATUSES = new Set([
  "pending",
  "pendente",
  "processing",
  "em_transito",
  "in_transit",
]);

const round = (value) =>
  Number((Number(value) || 0).toFixed(2));

const toCents = (value) =>
  Math.round(Number(value || 0) * 100);

const fromCents = (value) =>
  Number((Number(value || 0) / 100).toFixed(2));

function calculatePlatformFee(gross) {
  const grossCents = toCents(gross);

  const feeCents = Math.round(
    (grossCents * PLATFORM_FEE_BPS) / 10000,
  );

  return fromCents(feeCents);
}

function civilDateNow(timeZone) {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    },
  ).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [
      part.type,
      part.value,
    ]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function addSchedule(
  schedule,
  date,
  status,
  amount,
) {
  if (!schedule[date]) {
    schedule[date] = {
      providerStatusAvailable: 0,
      providerStatusPending: 0,
      unknownStatus: 0,
      amountAvailable: 0,
      amountPending: 0,
      amountUnknown: 0,
      totalAmount: 0,
      movementCount: 0,
    };
  }

  const entry = schedule[date];
  const normalized = String(status || "")
    .trim()
    .toLowerCase();

  entry.movementCount += 1;
  entry.totalAmount = round(
    entry.totalAmount + amount,
  );

  if (normalized === "available") {
    entry.providerStatusAvailable += 1;
    entry.amountAvailable = round(
      entry.amountAvailable + amount,
    );
  } else if (normalized === "pending") {
    entry.providerStatusPending += 1;
    entry.amountPending = round(
      entry.amountPending + amount,
    );
  } else {
    entry.unknownStatus += 1;
    entry.amountUnknown = round(
      entry.amountUnknown + amount,
    );
  }
}

function applyCarryToSchedule(
  schedule,
  initialCarry,
) {
  let carry = round(initialCarry);
  const result = {};

  for (
    const date of Object.keys(schedule).sort()
  ) {
    const providerNet = round(
      schedule[date].totalAmount,
    );

    const carryApplied = Math.min(
      providerNet,
      carry,
    );

    const effectiveNet = round(
      providerNet - carryApplied,
    );

    carry = round(
      carry - carryApplied,
    );

    result[date] = {
      ...schedule[date],
      providerNet,
      carryApplied: round(carryApplied),
      effectiveNet,
    };
  }

  return {
    items: result,
    remainingCarry: carry,
  };
}

function calculateEligibleToday(
  effectiveSchedule,
  today,
) {
  let amount = 0;
  let movements = 0;

  for (
    const [date, entry]
    of Object.entries(effectiveSchedule)
  ) {
    if (date > today) {
      continue;
    }

    if (
      Number(entry.providerStatusAvailable) === 0
    ) {
      continue;
    }

    /*
     * A dedução do carry é aplicada à primeira
     * data cronológica, antes da disponibilidade.
     */
    const availableRatio =
      entry.totalAmount > 0
        ? entry.amountAvailable /
          entry.totalAmount
        : 0;

    amount +=
      entry.effectiveNet *
      availableRatio;

    movements +=
      entry.providerStatusAvailable;
  }

  return {
    amount: round(amount),
    movementCount: movements,
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

  const rows = report.rows || [];

  if (
    rows.length !== EXPECTED_TRANSACTIONS
  ) {
    throw new Error(
      `Esperadas ${EXPECTED_TRANSACTIONS} ` +
      `Transactions; encontradas ${rows.length}.`,
    );
  }

  if (
    report.totals?.resolved !==
      EXPECTED_TRANSACTIONS ||
    report.totals?.missing !== 0 ||
    report.totals?.errors !== 0
  ) {
    throw new Error(
      "Auditoria Stripe não está 100% resolvida.",
    );
  }

  const [
    movements,
    payoutStatements,
    payoutAllocations,
    walletRows,
    provisionalFeeHolds,
    orphanHoldRows,
  ] = await Promise.all([
    prisma.$queryRawUnsafe(`
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
        expected_release_at,
        release_date_source

      FROM public.wallet_movements

      WHERE merchant_id =
        '${MERCHANT_ID}'::uuid

        AND currency = '${CURRENCY}'
        AND type = 'payment'
        AND direction = 'in'
    `),

    prisma.$queryRawUnsafe(`
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
        created_at::text

      FROM public.payout_statements

      WHERE merchant_id =
        '${MERCHANT_ID}'::uuid

        AND currency = '${CURRENCY}'

      ORDER BY
        COALESCE(
          paid_on,
          scheduled_for,
          created_at::date
        ),
        created_at
    `),

    prisma.$queryRawUnsafe(`
      SELECT
        allocation.store_id::text
          AS store_id,

        ROUND(
          SUM(allocation.amount)::numeric,
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
    `),

    prisma.$queryRawUnsafe(`
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
    `),

    prisma.$queryRawUnsafe(`
      SELECT
        id::text,
        store_id::text,
        amount::numeric::text,
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
    `),

    prisma.$queryRawUnsafe(`
      SELECT
        ROUND(
          COALESCE(
            SUM(amount),
            0
          )::numeric,
          2
        )::text AS amount

      FROM public.wallet_movements

      WHERE merchant_id =
        '${MERCHANT_ID}'::uuid

        AND currency = '${CURRENCY}'
        AND status =
          'reconciliation_hold'
    `),
  ]);

  const wallet = walletRows[0];

  if (!wallet) {
    throw new Error(
      "Wallet EUR não encontrada.",
    );
  }

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

  const paidByStore = new Map(
    payoutAllocations.map((row) => [
      row.store_id,
      round(row.paid_amount),
    ]),
  );

  const groups = new Map();

  let mappedMovements = 0;
  let missingMovements = 0;

  let totalGross = 0;
  let totalProviderFees = 0;
  let totalPlatformFees = 0;
  let totalFees = 0;
  let totalCorrectedNet = 0;

  for (const row of rows) {
    const movement =
      movementByTransaction.get(
        row.transactionId,
      );

    if (!movement) {
      missingMovements += 1;
      continue;
    }

    mappedMovements += 1;

    const gross = round(row.gross);
    const providerFee = round(
      row.providerFee,
    );

    const platformFee =
      calculatePlatformFee(gross);

    const merchantTotalFee = round(
      providerFee + platformFee,
    );

    const correctedNet = round(
      gross - merchantTotalFee,
    );

    totalGross += gross;
    totalProviderFees += providerFee;
    totalPlatformFees += platformFee;
    totalFees += merchantTotalFee;
    totalCorrectedNet += correctedNet;

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
        pendingPlatformFees: 0,
        pendingCorrectedNet: 0,
        releasedTransactions: 0,
        releasedProviderFees: 0,
        releasedPlatformFees: 0,
        releasedCorrectedNet: 0,
        providerSchedule: {},
      });
    }

    const group = groups.get(storeId);

    const movementStatus =
      String(movement.status || "")
        .trim()
        .toLowerCase();

    const isPending =
      PENDING_STATUSES.has(
        movementStatus,
      );

    group.transactions += 1;
    group.gross += gross;
    group.providerFees += providerFee;
    group.platformFees += platformFee;
    group.totalFees += merchantTotalFee;
    group.correctedNet += correctedNet;
    group.originalMovementNet +=
      Number(movement.amount || 0);

    if (isPending) {
      group.pendingTransactions += 1;
      group.pendingProviderFees +=
        providerFee;
      group.pendingPlatformFees +=
        platformFee;
      group.pendingCorrectedNet +=
        correctedNet;

      const providerDate =
        row.availableOnLisbon ||
        movement.provider_available_on ||
        movement.manual_estimated_release_on ||
        movement.system_estimated_release_on ||
        null;

      if (!providerDate) {
        throw new Error(
          `Data de disponibilidade ausente: ` +
          `${row.transactionId}`,
        );
      }

      addSchedule(
        group.providerSchedule,
        String(providerDate).slice(0, 10),
        row.providerBalanceStatus,
        correctedNet,
      );
    } else {
      group.releasedTransactions += 1;
      group.releasedProviderFees +=
        providerFee;
      group.releasedPlatformFees +=
        platformFee;
      group.releasedCorrectedNet +=
        correctedNet;
    }
  }

  totalGross = round(totalGross);
  totalProviderFees = round(
    totalProviderFees,
  );
  totalPlatformFees = round(
    totalPlatformFees,
  );
  totalFees = round(totalFees);
  totalCorrectedNet = round(
    totalCorrectedNet,
  );

  const paidStatements =
    payoutStatements.filter(
      (statement) =>
        statement.status === "paid",
    );

  const paidPayoutTotal = round(
    paidStatements.reduce(
      (sum, statement) =>
        sum + Number(statement.amount),
      0,
    ),
  );

  const todayLisbon =
    civilDateNow("Europe/Lisbon");

  const finalGroups = [];

  for (const group of groups.values()) {
    const paidPayouts =
      paidByStore.get(group.storeId) || 0;

    const carryForward = Math.max(
      0,
      round(
        paidPayouts -
        group.releasedCorrectedNet,
      ),
    );

    const adjusted =
      applyCarryToSchedule(
        group.providerSchedule,
        carryForward,
      );

    const eligibleToday =
      calculateEligibleToday(
        adjusted.items,
        todayLisbon,
      );

    finalGroups.push({
      ...group,

      gross:
        round(group.gross),

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
        round(
          group.pendingProviderFees,
        ),

      pendingPlatformFees:
        round(
          group.pendingPlatformFees,
        ),

      pendingCorrectedNet:
        round(
          group.pendingCorrectedNet,
        ),

      releasedProviderFees:
        round(
          group.releasedProviderFees,
        ),

      releasedPlatformFees:
        round(
          group.releasedPlatformFees,
        ),

      releasedCorrectedNet:
        round(
          group.releasedCorrectedNet,
        ),

      paidPayouts,

      operationalBalance:
        round(
          group.correctedNet -
          paidPayouts,
        ),

      carryForward,

      effectiveSchedule:
        adjusted.items,

      remainingCarry:
        adjusted.remainingCarry,

      eligibleForManualReleaseToday:
        eligibleToday,
    });
  }

  finalGroups.sort(
    (a, b) =>
      String(a.storeCode)
        .localeCompare(
          String(b.storeCode),
        ),
  );

  const orphanHold = round(
    orphanHoldRows[0]?.amount || 0,
  );

  const provisionalFeeHold = round(
    provisionalFeeHolds.reduce(
      (sum, row) =>
        sum + Number(row.amount),
      0,
    ),
  );

  const currentBookBalance =
    round(wallet.balance);

  const currentReconciliationHold =
    round(wallet.reconciliation_hold);

  const currentMerchantWallet =
    round(
      currentBookBalance -
      currentReconciliationHold,
    );

  const targetMerchantWallet =
    round(
      totalCorrectedNet -
      paidPayoutTotal,
    );

  const targetReconciliationHold =
    orphanHold;

  const targetBookBalance =
    round(
      targetMerchantWallet +
      targetReconciliationHold,
    );

  const operationalBalance = round(
    finalGroups.reduce(
      (sum, group) =>
        sum +
        group.operationalBalance,
      0,
    ),
  );

  const carryForward = round(
    finalGroups.reduce(
      (sum, group) =>
        sum + group.carryForward,
      0,
    ),
  );

  const eligibleToday = {
    amount: round(
      finalGroups.reduce(
        (sum, group) =>
          sum +
          group
            .eligibleForManualReleaseToday
            .amount,
        0,
      ),
    ),

    movementCount:
      finalGroups.reduce(
        (sum, group) =>
          sum +
          group
            .eligibleForManualReleaseToday
            .movementCount,
        0,
      ),
  };

  const output = {
    generatedAt:
      new Date().toISOString(),

    mode: "READ_ONLY",

    feePolicy: {
      platformDefaultBps: 2500,
      platformDefaultPercent: 25,
      platformDefaultRequiresAdminReview:
        true,

      merchantOverride: {
        merchantId: MERCHANT_ID,
        platformFeeBps:
          PLATFORM_FEE_BPS,
        platformFeePercent:
          PLATFORM_FEE_BPS / 100,
      },

      resolutionPriority: [
        "store_override",
        "merchant_override",
        "platform_default",
      ],
    },

    validation: {
      auditTransactions:
        rows.length,

      mappedMovements,
      missingMovements,

      providerResolved:
        report.totals.resolved,

      providerMissing:
        report.totals.missing,

      providerErrors:
        report.totals.errors,
    },

    correctedAccounting: {
      gross:
        totalGross,

      providerFees:
        totalProviderFees,

      platformFees:
        totalPlatformFees,

      totalMerchantFees:
        totalFees,

      correctedMerchantNet:
        totalCorrectedNet,

      paidPayouts:
        paidPayoutTotal,

      merchantWallet:
        targetMerchantWallet,
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

      provisionalFeeHold,

      orphanReconciliationHold:
        orphanHold,

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

    historicalPayouts: {
      immutable: true,

      count:
        paidStatements.length,

      total:
        paidPayoutTotal,

      items:
        paidStatements.map(
          (statement) => ({
            id: statement.id,
            statementCode:
              statement.statement_code,
            amount:
              round(statement.amount),
            status:
              statement.status,
            paidOn:
              statement.paid_on,
            paidAt:
              statement.paid_at,
            externalReference:
              statement.external_reference,
          }),
        ),
    },

    releaseEligibility: {
      timezone:
        "Europe/Lisbon",

      today:
        todayLisbon,

      sourcePriority: [
        "manual_estimated_release_on",
        "provider_available_on",
        "system_estimated_release_on",
      ],

      requiresProviderStatusAvailable:
        true,

      confirmation:
        "manual",

      eligibleToday,
    },

    provisionalFeeHolds:
      provisionalFeeHolds.map(
        (row) => ({
          id: row.id,
          storeId: row.store_id,
          amount: round(row.amount),
          status: row.status,
          idempotencyKey:
            row.idempotency_key,
        }),
      ),

    stores: finalGroups,

    summary: {
      operationalBalance,
      expectedMerchantWallet:
        targetMerchantWallet,

      carryForward,

      exactMatch:
        operationalBalance ===
        targetMerchantWallet,

      payoutHistoryPreserved:
        paidStatements.length ===
          EXPECTED_PAYOUT_COUNT &&
        paidPayoutTotal ===
          EXPECTED_PAYOUT_TOTAL,
    },
  };

  console.log(
    JSON.stringify(
      output,
      null,
      2,
    ),
  );

  if (
    mappedMovements !==
      EXPECTED_TRANSACTIONS ||
    missingMovements !== 0
  ) {
    throw new Error(
      "Mapeamento de movimentos incompleto.",
    );
  }

  if (
    totalProviderFees !==
    EXPECTED_PROVIDER_FEES
  ) {
    throw new Error(
      `Provider fee deveria ser ` +
      `${EXPECTED_PROVIDER_FEES}; ` +
      `encontrada ${totalProviderFees}.`,
    );
  }

  if (
    paidStatements.length !==
      EXPECTED_PAYOUT_COUNT ||
    paidPayoutTotal !==
      EXPECTED_PAYOUT_TOTAL
  ) {
    throw new Error(
      "Payouts históricos não coincidem.",
    );
  }

  if (
    provisionalFeeHold !== 18.12
  ) {
    throw new Error(
      `Hold provisório deveria ser 18.12; ` +
      `encontrado ${provisionalFeeHold}.`,
    );
  }

  if (
    orphanHold !== 175.78
  ) {
    throw new Error(
      `Hold órfão deveria ser 175.78; ` +
      `encontrado ${orphanHold}.`,
    );
  }

  if (
    operationalBalance !==
    targetMerchantWallet
  ) {
    throw new Error(
      "Saldo por Store não coincide com Wallet alvo.",
    );
  }

  if (
    !output.summary.payoutHistoryPreserved
  ) {
    throw new Error(
      "Payout histórico não foi preservado.",
    );
  }
}

main()
  .catch((error) => {
    console.error(
      "PREFLIGHT_150BPS_FATAL:",
      error.message || error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
