"use strict";

const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: "/root/xpayments-backend-v3/.env",
  quiet: true,
});

const { PrismaClient } = require("@prisma/client");
const Stripe = require("stripe");

const prisma = new PrismaClient();

const MERCHANT_ID =
  process.env.AUDIT_MERCHANT_ID ||
  "5d2a2279-deed-4225-b49c-b0c60ebb8580";

const AUDIT_LIMIT = Math.max(
  0,
  Number(process.env.AUDIT_LIMIT || 0),
);

const DELAY_MS = Math.max(
  0,
  Number(process.env.STRIPE_AUDIT_DELAY_MS || 120),
);

const PLATFORM_FEE_RATE = 0.02;
const TIMEZONE = "Europe/Lisbon";

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const roundMoney = (value) =>
  Number((Number(value) || 0).toFixed(2));

const fromMinorUnit = (value) =>
  roundMoney((Number(value) || 0) / 100);

function parseCredentials(value) {
  if (!value) return {};

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function civilDateFromUnix(timestamp, timeZone) {
  if (!timestamp) return null;

  const date = new Date(Number(timestamp) * 1000);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";

  const text =
    typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

  return `"${text.replace(/"/g, '""')}"`;
}

async function withRetry(fn, maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const statusCode =
        error?.statusCode ||
        error?.status ||
        0;

      const retryable =
        statusCode === 429 ||
        statusCode >= 500 ||
        error?.code === "ECONNRESET" ||
        error?.code === "ETIMEDOUT";

      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      await sleep(attempt * 750);
    }
  }

  throw lastError;
}

async function retrieveBalanceTransaction(
  stripe,
  paymentIntentId,
) {
  const paymentIntent = await withRetry(() =>
    stripe.paymentIntents.retrieve(
      paymentIntentId,
      {
        expand: [
          "latest_charge.balance_transaction",
        ],
      },
    ),
  );

  let charge = paymentIntent.latest_charge;

  if (!charge) {
    return {
      paymentIntent,
      charge: null,
      balanceTransaction: null,
      reason: "latest_charge_missing",
    };
  }

  if (typeof charge === "string") {
    charge = await withRetry(() =>
      stripe.charges.retrieve(
        charge,
        {
          expand: ["balance_transaction"],
        },
      ),
    );
  }

  let balanceTransaction =
    charge?.balance_transaction || null;

  if (typeof balanceTransaction === "string") {
    balanceTransaction = await withRetry(() =>
      stripe.balanceTransactions.retrieve(
        balanceTransaction,
      ),
    );
  }

  return {
    paymentIntent,
    charge,
    balanceTransaction,
    reason: balanceTransaction
      ? null
      : "balance_transaction_missing",
  };
}

function groupRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const key = [
      row.gateway,
      row.storeCode,
      row.currency,
    ].join("|");

    if (!groups.has(key)) {
      groups.set(key, {
        gateway: row.gateway,
        storeCode: row.storeCode,
        storeName: row.storeName,
        currency: row.currency,
        transactions: 0,
        gross: 0,
        recordedFees: 0,
        providerFees: 0,
        platformFees: 0,
        totalMerchantFees: 0,
        currentNet: 0,
        correctedMerchantNet: 0,
        missingBalanceTransactions: 0,
        availableDates: {},
      });
    }

    const group = groups.get(key);

    group.transactions += 1;
    group.gross += row.gross;
    group.recordedFees += row.recordedFee;
    group.providerFees += row.providerFee || 0;
    group.platformFees += row.platformFee;
    group.totalMerchantFees +=
      row.totalMerchantFee || 0;
    group.currentNet += row.currentNet;
    group.correctedMerchantNet +=
      row.correctedMerchantNet || 0;

    if (!row.balanceTransactionId) {
      group.missingBalanceTransactions += 1;
    }

    if (row.availableOnLisbon) {
      group.availableDates[
        row.availableOnLisbon
      ] =
        (
          group.availableDates[
            row.availableOnLisbon
          ] || 0
        ) + row.correctedMerchantNet;
    }
  }

  return Array.from(groups.values()).map(
    (group) => ({
      ...group,
      gross: roundMoney(group.gross),
      recordedFees: roundMoney(
        group.recordedFees,
      ),
      providerFees: roundMoney(
        group.providerFees,
      ),
      platformFees: roundMoney(
        group.platformFees,
      ),
      totalMerchantFees: roundMoney(
        group.totalMerchantFees,
      ),
      currentNet: roundMoney(
        group.currentNet,
      ),
      correctedMerchantNet: roundMoney(
        group.correctedMerchantNet,
      ),
      availableDates: Object.fromEntries(
        Object.entries(
          group.availableDates,
        )
          .sort(([a], [b]) =>
            a.localeCompare(b),
          )
          .map(([date, amount]) => [
            date,
            roundMoney(amount),
          ]),
      ),
    }),
  );
}

async function main() {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const outputDir =
    `/root/audits/xpayments-stripe/${stamp}`;

  fs.mkdirSync(outputDir, {
    recursive: true,
    mode: 0o700,
  });

  console.log(
    "============================================================",
  );
  console.log(
    "XPAYMENTS — STRIPE BALANCE TRANSACTION AUDIT",
  );
  console.log(
    "MODO: READ-ONLY",
  );
  console.log(
    "============================================================",
  );

  const query = {
    where: {
      merchantId: MERCHANT_ID,
      status: "succeeded",
      providerId: {
        startsWith: "pi_",
      },
      gatewayVaultId: {
        not: null,
      },
    },
    include: {
      gatewayVault: true,
      store: {
        select: {
          id: true,
          name: true,
          storeCode: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  };

  if (AUDIT_LIMIT > 0) {
    query.take = AUDIT_LIMIT;
  }

  const transactions =
    await prisma.transaction.findMany(query);

  console.log(
    `Transactions encontradas: ${transactions.length}`,
  );

  const clients = new Map();
  const rows = [];

  let successCount = 0;
  let missingCount = 0;
  let errorCount = 0;

  for (
    let index = 0;
    index < transactions.length;
    index += 1
  ) {
    const transaction = transactions[index];
    const vault = transaction.gatewayVault;

    const credentials = parseCredentials(
      vault?.credentials,
    );

    const secretKey = String(
      credentials?.secretKey || "",
    ).trim();

    const baseRow = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      gatewayVaultId:
        transaction.gatewayVaultId,
      gateway:
        transaction.gateway || vault?.provider,
      storeId: transaction.storeId,
      storeCode:
        transaction.store?.storeCode || null,
      storeName:
        transaction.store?.name || null,
      createdAt:
        transaction.createdAt.toISOString(),
      currency:
        String(transaction.currency)
          .toUpperCase(),
      gross: roundMoney(
        Number(transaction.amount),
      ),
      recordedFee: roundMoney(
        Number(transaction.fee || 0),
      ),
    };

    baseRow.platformFee = roundMoney(
      baseRow.gross * PLATFORM_FEE_RATE,
    );

    baseRow.currentNet = roundMoney(
      baseRow.gross -
      baseRow.recordedFee,
    );

    if (!secretKey) {
      rows.push({
        ...baseRow,
        error: "stripe_secret_missing",
      });

      errorCount += 1;

      console.log(
        `[${index + 1}/${transactions.length}] ` +
        `${baseRow.storeCode} ` +
        `${baseRow.providerId}: SECRET AUSENTE`,
      );

      continue;
    }

    if (!clients.has(vault.id)) {
      clients.set(
        vault.id,
        new Stripe(secretKey, {
          apiVersion:
            "2026-06-24.dahlia",
          maxNetworkRetries: 2,
          timeout: 30000,
        }),
      );
    }

    const stripe = clients.get(vault.id);

    try {
      const result =
        await retrieveBalanceTransaction(
          stripe,
          transaction.providerId,
        );

      const balanceTransaction =
        result.balanceTransaction;

      if (!balanceTransaction) {
        rows.push({
          ...baseRow,
          chargeId:
            typeof result.charge === "string"
              ? result.charge
              : result.charge?.id || null,
          balanceTransactionId: null,
          providerFee: null,
          providerNet: null,
          totalMerchantFee: null,
          correctedMerchantNet: null,
          availableOnUtc: null,
          availableOnLisbon: null,
          providerBalanceStatus: null,
          feeDetails: [],
          error: result.reason,
        });

        missingCount += 1;

        console.log(
          `[${index + 1}/${transactions.length}] ` +
          `${baseRow.storeCode} ` +
          `${baseRow.providerId}: ` +
          `${result.reason}`,
        );
      } else {
        const providerFee = fromMinorUnit(
          balanceTransaction.fee,
        );

        const providerNet = fromMinorUnit(
          balanceTransaction.net,
        );

        const totalMerchantFee = roundMoney(
          providerFee +
          baseRow.platformFee,
        );

        const correctedMerchantNet =
          roundMoney(
            baseRow.gross -
            totalMerchantFee,
          );

        const availableOnUtc =
          balanceTransaction.available_on
            ? new Date(
                balanceTransaction.available_on *
                  1000,
              ).toISOString()
            : null;

        const availableOnLisbon =
          civilDateFromUnix(
            balanceTransaction.available_on,
            TIMEZONE,
          );

        rows.push({
          ...baseRow,
          chargeId:
            typeof result.charge === "string"
              ? result.charge
              : result.charge?.id || null,
          balanceTransactionId:
            balanceTransaction.id,
          providerAmount: fromMinorUnit(
            balanceTransaction.amount,
          ),
          providerFee,
          providerNet,
          totalMerchantFee,
          correctedMerchantNet,
          feeAdjustmentRequired:
            roundMoney(
              baseRow.currentNet -
              correctedMerchantNet,
            ),
          availableOnUtc,
          availableOnLisbon,
          providerBalanceStatus:
            balanceTransaction.status,
          reportingCategory:
            balanceTransaction
              .reporting_category || null,
          balanceType:
            balanceTransaction.type || null,
          feeDetails:
            balanceTransaction.fee_details || [],
          error: null,
        });

        successCount += 1;

        console.log(
          `[${index + 1}/${transactions.length}] ` +
          `${baseRow.storeCode} ` +
          `${baseRow.providerId} ` +
          `fee=${providerFee.toFixed(2)} ` +
          `available=${availableOnLisbon} ` +
          `status=${balanceTransaction.status}`,
        );
      }
    } catch (error) {
      rows.push({
        ...baseRow,
        balanceTransactionId: null,
        providerFee: null,
        providerNet: null,
        totalMerchantFee: null,
        correctedMerchantNet: null,
        availableOnUtc: null,
        availableOnLisbon: null,
        providerBalanceStatus: null,
        feeDetails: [],
        error: {
          type:
            error?.type ||
            error?.name ||
            "StripeError",
          code: error?.code || null,
          statusCode:
            error?.statusCode || null,
          message:
            String(
              error?.message ||
              "Stripe request failed",
            ).slice(0, 300),
        },
      });

      errorCount += 1;

      console.log(
        `[${index + 1}/${transactions.length}] ` +
        `${baseRow.storeCode} ` +
        `${baseRow.providerId}: ERRO ` +
        `${error?.code || error?.message}`,
      );
    }

    if (DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  const groups = groupRows(rows);

  const validRows = rows.filter(
    (row) =>
      row.balanceTransactionId &&
      row.providerFee !== null,
  );

  const totals = {
    transactions: rows.length,
    resolved: successCount,
    missing: missingCount,
    errors: errorCount,

    gross: roundMoney(
      validRows.reduce(
        (sum, row) => sum + row.gross,
        0,
      ),
    ),

    recordedFees: roundMoney(
      validRows.reduce(
        (sum, row) =>
          sum + row.recordedFee,
        0,
      ),
    ),

    providerFees: roundMoney(
      validRows.reduce(
        (sum, row) =>
          sum + row.providerFee,
        0,
      ),
    ),

    platformFees: roundMoney(
      validRows.reduce(
        (sum, row) =>
          sum + row.platformFee,
        0,
      ),
    ),

    totalMerchantFees: roundMoney(
      validRows.reduce(
        (sum, row) =>
          sum + row.totalMerchantFee,
        0,
      ),
    ),

    currentNet: roundMoney(
      validRows.reduce(
        (sum, row) =>
          sum + row.currentNet,
        0,
      ),
    ),

    correctedMerchantNet: roundMoney(
      validRows.reduce(
        (sum, row) =>
          sum + row.correctedMerchantNet,
        0,
      ),
    ),
  };

  totals.feeAdjustmentRequired =
    roundMoney(
      totals.currentNet -
      totals.correctedMerchantNet,
    );

  const report = {
    generatedAt:
      new Date().toISOString(),
    mode: "READ_ONLY",
    merchantId: MERCHANT_ID,
    timezone: TIMEZONE,
    platformFeeRate:
      PLATFORM_FEE_RATE,
    totals,
    groups,
    rows,
  };

  const jsonPath =
    path.join(outputDir, "report.json");

  const summaryPath =
    path.join(outputDir, "summary.json");

  const csvPath =
    path.join(outputDir, "transactions.csv");

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(report, null, 2),
    {
      mode: 0o600,
    },
  );

  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: report.generatedAt,
        totals,
        groups,
      },
      null,
      2,
    ),
    {
      mode: 0o600,
    },
  );

  const csvColumns = [
    "transactionId",
    "providerId",
    "gateway",
    "storeCode",
    "storeName",
    "createdAt",
    "currency",
    "gross",
    "recordedFee",
    "providerFee",
    "platformFee",
    "totalMerchantFee",
    "currentNet",
    "correctedMerchantNet",
    "feeAdjustmentRequired",
    "balanceTransactionId",
    "providerBalanceStatus",
    "availableOnLisbon",
    "availableOnUtc",
    "feeDetails",
    "error",
  ];

  const csv = [
    csvColumns.join(","),
    ...rows.map((row) =>
      csvColumns
        .map((column) =>
          csvCell(row[column]),
        )
        .join(","),
    ),
  ].join("\n");

  fs.writeFileSync(csvPath, csv, {
    mode: 0o600,
  });

  console.log();
  console.log(
    "================ RESUMO =================",
  );
  console.log(
    JSON.stringify(totals, null, 2),
  );

  console.log();
  console.log(
    "================ POR STORE =================",
  );
  console.log(
    JSON.stringify(groups, null, 2),
  );

  console.log();
  console.log(
    "Relatórios:",
  );
  console.log(jsonPath);
  console.log(summaryPath);
  console.log(csvPath);
}

main()
  .catch((error) => {
    console.error(
      "AUDIT_FATAL:",
      error?.message || error,
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
