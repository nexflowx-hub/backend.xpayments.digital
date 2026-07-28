"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

for (const envFile of [".env", ".env.production", ".env.local"]) {
  const fullPath = path.resolve(process.cwd(), envFile);

  if (fs.existsSync(fullPath)) {
    dotenv.config({
      path: fullPath,
      override: false,
    });
  }
}

const {
  PrismaClient,
  Prisma,
} = require("@prisma/client");

const prisma = new PrismaClient({
  log: ["error"],
});

const CONFIRM = process.env.CONFIRM === "YES";

const MERCHANT_ID =
  "5d2a2279-deed-4225-b49c-b0c60ebb8580";

const STORE_CODE = "REVEURO1";
const CURRENCY = "EUR";
const AMOUNT_TEXT = "961.02";

const DESCRIPTION =
  "Saída Re-Investimento TrafegoPago";

const EXTERNAL_REFERENCE =
  "BW-REINV-TRAFEGO-20260727-96102";

const STATEMENT_CODE =
  "PAYOUT-BW-20260727-96102";

const TIMEZONE = "Europe/Lisbon";

const AMOUNT = new Prisma.Decimal(AMOUNT_TEXT);

function normalize(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function modelByNames(...names) {
  const wanted = names.map(normalize);

  return Prisma.dmmf.datamodel.models.find(
    (model) => wanted.includes(normalize(model.name)),
  );
}

function fieldByNames(model, ...names) {
  if (!model) {
    return null;
  }

  const wanted = names.map(normalize);

  return model.fields.find(
    (field) => wanted.includes(normalize(field.name)),
  ) || null;
}

function clientKey(model) {
  return model.name.charAt(0).toLowerCase()
    + model.name.slice(1);
}

function delegate(client, model) {
  const key = clientKey(model);
  const value = client[key];

  if (!value) {
    throw new Error(
      `Delegate Prisma não encontrado: ${key}`,
    );
  }

  return value;
}

function decimalNumber(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number(value.toString());
}

function money(value) {
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency: CURRENCY,
  }).format(decimalNumber(value));
}

function civilDate(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dateFieldValue(field, date, now) {
  if (!field) {
    return undefined;
  }

  if (field.type === "DateTime") {
    if (date) {
      return new Date(`${date}T00:00:00.000Z`);
    }

    return now;
  }

  return date || now.toISOString();
}

function safeMetadata(value) {
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
  ) {
    return value;
  }

  return {};
}

function assertRequiredScalars(model, data, operationName) {
  const missing = model.fields.filter((field) => {
    if (field.kind !== "scalar") {
      return false;
    }

    if (!field.isRequired) {
      return false;
    }

    if (field.hasDefaultValue || field.isUpdatedAt) {
      return false;
    }

    return data[field.name] === undefined;
  });

  if (missing.length) {
    throw new Error(
      `${operationName}: campos obrigatórios não mapeados: `
      + missing.map((field) => field.name).join(", "),
    );
  }
}

async function main() {
  const today = civilDate(TIMEZONE);
  const now = new Date();

  const Merchant = modelByNames("Merchant");
  const Wallet = modelByNames("Wallet");
  const Store = modelByNames("Store");

  const PayoutStatement = modelByNames(
    "PayoutStatement",
  );

  const PayoutAllocation = modelByNames(
    "PayoutAllocation",
    "PayoutStatementAllocation",
  );

  const WalletMovement = modelByNames(
    "WalletMovement",
  );

  const requiredModels = {
    Merchant,
    Wallet,
    Store,
    PayoutStatement,
    WalletMovement,
  };

  for (const [name, model] of Object.entries(requiredModels)) {
    if (!model) {
      throw new Error(
        `Modelo Prisma obrigatório não encontrado: ${name}`,
      );
    }
  }

  const merchantDelegate = delegate(prisma, Merchant);
  const walletDelegate = delegate(prisma, Wallet);
  const storeDelegate = delegate(prisma, Store);
  const statementDelegate =
    delegate(prisma, PayoutStatement);
  const movementDelegate =
    delegate(prisma, WalletMovement);

  const merchantIdField =
    fieldByNames(Merchant, "id");

  const merchant = await merchantDelegate.findUnique({
    where: {
      [merchantIdField.name]: MERCHANT_ID,
    },
  });

  if (!merchant) {
    throw new Error(
      `Merchant BW não encontrado: ${MERCHANT_ID}`,
    );
  }

  const walletIdField =
    fieldByNames(Wallet, "id");

  const walletMerchantField =
    fieldByNames(Wallet, "merchantId");

  const walletCurrencyField =
    fieldByNames(Wallet, "currency");

  const walletAvailableField =
    fieldByNames(Wallet, "available");

  const walletReservedField =
    fieldByNames(Wallet, "reserved");

  const walletBalanceField =
    fieldByNames(
      Wallet,
      "balance",
      "merchantWallet",
      "merchantBalance",
    );

  const walletBookBalanceField =
    fieldByNames(Wallet, "bookBalance");

  if (
    !walletIdField
    || !walletMerchantField
    || !walletCurrencyField
    || !walletAvailableField
    || !walletBalanceField
  ) {
    throw new Error(
      "O modelo Wallet não possui os campos financeiros esperados.",
    );
  }

  const wallet = await walletDelegate.findFirst({
    where: {
      [walletMerchantField.name]: MERCHANT_ID,
      [walletCurrencyField.name]: CURRENCY,
    },
  });

  if (!wallet) {
    throw new Error(
      `Wallet ${CURRENCY} do Merchant BW não encontrada.`,
    );
  }

  const storeIdField =
    fieldByNames(Store, "id");

  const storeMerchantField =
    fieldByNames(Store, "merchantId");

  const storeCodeField =
    fieldByNames(Store, "storeCode", "code");

  const storeNameField =
    fieldByNames(Store, "name", "storeName");

  const store = await storeDelegate.findFirst({
    where: {
      [storeMerchantField.name]: MERCHANT_ID,
      [storeCodeField.name]: STORE_CODE,
    },
  });

  if (!store) {
    throw new Error(
      `Store ${STORE_CODE} não encontrada para o Merchant BW.`,
    );
  }

  const statementIdField =
    fieldByNames(PayoutStatement, "id");

  const statementMerchantField =
    fieldByNames(PayoutStatement, "merchantId");

  const statementWalletField =
    fieldByNames(PayoutStatement, "walletId");

  const statementStoreField =
    fieldByNames(PayoutStatement, "storeId");

  const statementCodeField =
    fieldByNames(
      PayoutStatement,
      "statementCode",
      "code",
      "number",
    );

  const statementCurrencyField =
    fieldByNames(PayoutStatement, "currency");

  const statementAmountField =
    fieldByNames(PayoutStatement, "amount", "value");

  const statementStatusField =
    fieldByNames(PayoutStatement, "status");

  const statementScheduledField =
    fieldByNames(
      PayoutStatement,
      "scheduledFor",
      "scheduledDate",
    );

  const statementPaidAtField =
    fieldByNames(PayoutStatement, "paidAt");

  const statementPaidOnField =
    fieldByNames(PayoutStatement, "paidOn");

  const statementExternalRefField =
    fieldByNames(
      PayoutStatement,
      "externalReference",
      "reference",
    );

  const statementDescriptionField =
    fieldByNames(
      PayoutStatement,
      "description",
      "comment",
      "memo",
    );

  const statementHistoricalField =
    fieldByNames(
      PayoutStatement,
      "historicalDateOnly",
    );

  const statementMetadataField =
    fieldByNames(PayoutStatement, "metadata");

  const statementCreatedAtField =
    fieldByNames(PayoutStatement, "createdAt");

  if (
    !statementIdField
    || !statementCodeField
    || !statementCurrencyField
    || !statementAmountField
    || !statementStatusField
  ) {
    throw new Error(
      "PayoutStatement não possui os campos operacionais esperados.",
    );
  }

  let exactStatement = null;

  if (statementExternalRefField) {
    exactStatement =
      await statementDelegate.findFirst({
        where: {
          [statementExternalRefField.name]:
            EXTERNAL_REFERENCE,
        },
      });
  }

  if (!exactStatement) {
    exactStatement =
      await statementDelegate.findFirst({
        where: {
          [statementCodeField.name]:
            STATEMENT_CODE,
        },
      });
  }

  if (
    exactStatement
    && exactStatement[statementStatusField.name] === "paid"
  ) {
    console.log("================================================");
    console.log("PAYOUT JÁ CONFIRMADO — OPERAÇÃO IDEMPOTENTE");
    console.log("================================================");
    console.log({
      id: exactStatement[statementIdField.name],
      statementCode:
        exactStatement[statementCodeField.name],
      status:
        exactStatement[statementStatusField.name],
      amount:
        money(exactStatement[statementAmountField.name]),
      reference:
        statementExternalRefField
          ? exactStatement[
              statementExternalRefField.name
            ]
          : null,
    });

    return;
  }

  const candidateWhere = {
    [statementCurrencyField.name]: CURRENCY,
    [statementAmountField.name]: AMOUNT,
  };

  if (statementMerchantField) {
    candidateWhere[statementMerchantField.name] =
      MERCHANT_ID;
  }

  const findArgs = {
    where: candidateWhere,
    take: 20,
  };

  if (statementCreatedAtField) {
    findArgs.orderBy = {
      [statementCreatedAtField.name]: "desc",
    };
  }

  const candidates =
    await statementDelegate.findMany(findArgs);

  const openStatuses = new Set([
    "draft",
    "scheduled",
    "processing",
    "pending",
  ]);

  const openCandidates = candidates.filter(
    (item) => openStatuses.has(
      String(item[statementStatusField.name]),
    ),
  );

  let existingStatement =
    exactStatement || null;

  if (!existingStatement) {
    if (openCandidates.length > 1) {
      console.log(
        "Payouts abertos encontrados:",
        openCandidates.map((item) => ({
          id: item[statementIdField.name],
          code: item[statementCodeField.name],
          status: item[statementStatusField.name],
          amount: money(item[statementAmountField.name]),
          scheduledFor: statementScheduledField
            ? item[statementScheduledField.name]
            : null,
        })),
      );

      throw new Error(
        "Mais de um payout aberto de € 961,02. "
        + "Operação cancelada para evitar confirmação ambígua.",
      );
    }

    existingStatement =
      openCandidates[0] || null;
  }

  const available =
    decimalNumber(wallet[walletAvailableField.name]);

  const reserved =
    walletReservedField
      ? decimalNumber(wallet[walletReservedField.name])
      : 0;

  const amountNumber = decimalNumber(AMOUNT);

  let debitBucket = null;

  if (available >= amountNumber) {
    debitBucket = walletAvailableField;
  } else if (
    existingStatement
    && walletReservedField
    && reserved >= amountNumber
  ) {
    debitBucket = walletReservedField;
  }

  console.log("================================================");
  console.log("XPAYMENTS — CONFIRMAÇÃO MANUAL DE PAYOUT");
  console.log("================================================");
  console.log({
    mode: CONFIRM ? "COMMIT" : "READ_ONLY",
    merchantId: MERCHANT_ID,
    merchant:
      merchant.name
      || merchant.company
      || merchant.email,
    storeId: store[storeIdField.name],
    storeCode: store[storeCodeField.name],
    storeName: storeNameField
      ? store[storeNameField.name]
      : null,
    currency: CURRENCY,
    amount: money(AMOUNT),
    description: DESCRIPTION,
    reference: EXTERNAL_REFERENCE,
    civilDate: today,
  });

  console.log("\nWALLET ATUAL");
  console.log({
    id: wallet[walletIdField.name],
    balance:
      money(wallet[walletBalanceField.name]),
    bookBalance: walletBookBalanceField
      ? money(wallet[walletBookBalanceField.name])
      : "campo inexistente",
    available: money(
      wallet[walletAvailableField.name],
    ),
    reserved: walletReservedField
      ? money(wallet[walletReservedField.name])
      : "campo inexistente",
    debitBucket:
      debitBucket ? debitBucket.name : null,
  });

  console.log("\nPAYOUT EXISTENTE");
  console.log(
    existingStatement
      ? {
          id:
            existingStatement[statementIdField.name],
          code:
            existingStatement[
              statementCodeField.name
            ],
          status:
            existingStatement[
              statementStatusField.name
            ],
          amount:
            money(
              existingStatement[
                statementAmountField.name
              ],
            ),
        }
      : "Nenhum payout agendado correspondente; será criado.",
  );

  if (!debitBucket) {
    throw new Error(
      `Saldo insuficiente. Available=${money(available)}, `
      + `Reserved=${money(reserved)}, `
      + `Payout=${money(AMOUNT)}. `
      + "Nenhuma alteração foi realizada.",
    );
  }

  const movementIdField =
    fieldByNames(WalletMovement, "id");

  const movementWalletField =
    fieldByNames(WalletMovement, "walletId");

  const movementMerchantField =
    fieldByNames(WalletMovement, "merchantId");

  const movementStoreField =
    fieldByNames(WalletMovement, "storeId");

  const movementCurrencyField =
    fieldByNames(WalletMovement, "currency");

  const movementTypeField =
    fieldByNames(WalletMovement, "type");

  const movementDirectionField =
    fieldByNames(WalletMovement, "direction");

  const movementAmountField =
    fieldByNames(WalletMovement, "amount");

  const movementStatusField =
    fieldByNames(WalletMovement, "status");

  const movementReferenceField =
    fieldByNames(WalletMovement, "reference");

  const movementDescriptionField =
    fieldByNames(
      WalletMovement,
      "description",
      "comment",
      "memo",
    );

  const movementMetadataField =
    fieldByNames(WalletMovement, "metadata");

  const movementCreatedAtField =
    fieldByNames(WalletMovement, "createdAt");

  if (
    !movementWalletField
    || !movementMerchantField
    || !movementCurrencyField
    || !movementTypeField
    || !movementDirectionField
    || !movementAmountField
    || !movementStatusField
    || !movementReferenceField
  ) {
    throw new Error(
      "WalletMovement não possui os campos de auditoria esperados.",
    );
  }

  const previousPayoutMovement =
    await movementDelegate.findFirst({
      where: {
        [movementWalletField.name]:
          wallet[walletIdField.name],
        [movementTypeField.name]: "payout",
      },
      ...(movementCreatedAtField
        ? {
            orderBy: {
              [movementCreatedAtField.name]:
                "desc",
            },
          }
        : {}),
    });

  const movementStatus =
    previousPayoutMovement
      ? String(
          previousPayoutMovement[
            movementStatusField.name
          ],
        )
      : "paid";

  const movementDirection =
    previousPayoutMovement
      ? String(
          previousPayoutMovement[
            movementDirectionField.name
          ],
        )
      : "debit";

  const existingMovement =
    await movementDelegate.findFirst({
      where: {
        [movementReferenceField.name]:
          EXTERNAL_REFERENCE,
      },
    });

  if (existingMovement) {
    throw new Error(
      "Já existe WalletMovement com esta referência, "
      + "mas o payout não está confirmado como paid. "
      + "Operação cancelada para análise.",
    );
  }

  const statementPreviewData = {};

  if (statementMerchantField) {
    statementPreviewData[
      statementMerchantField.name
    ] = MERCHANT_ID;
  }

  if (statementWalletField) {
    statementPreviewData[
      statementWalletField.name
    ] = wallet[walletIdField.name];
  }

  if (statementStoreField) {
    statementPreviewData[
      statementStoreField.name
    ] = store[storeIdField.name];
  }

  statementPreviewData[
    statementCodeField.name
  ] = STATEMENT_CODE;

  statementPreviewData[
    statementCurrencyField.name
  ] = CURRENCY;

  statementPreviewData[
    statementAmountField.name
  ] = AMOUNT;

  statementPreviewData[
    statementStatusField.name
  ] = "paid";

  if (statementScheduledField) {
    statementPreviewData[
      statementScheduledField.name
    ] = dateFieldValue(
      statementScheduledField,
      today,
      now,
    );
  }

  if (statementPaidAtField) {
    statementPreviewData[
      statementPaidAtField.name
    ] = dateFieldValue(
      statementPaidAtField,
      null,
      now,
    );
  }

  if (statementPaidOnField) {
    statementPreviewData[
      statementPaidOnField.name
    ] = dateFieldValue(
      statementPaidOnField,
      today,
      now,
    );
  }

  if (statementExternalRefField) {
    statementPreviewData[
      statementExternalRefField.name
    ] = EXTERNAL_REFERENCE;
  }

  if (statementDescriptionField) {
    statementPreviewData[
      statementDescriptionField.name
    ] = DESCRIPTION;
  }

  if (statementHistoricalField) {
    statementPreviewData[
      statementHistoricalField.name
    ] = false;
  }

  const operationMetadata = {
    operation: "manual_paid_payout",
    purpose: "traffic_reinvestment",
    description: DESCRIPTION,
    merchantId: MERCHANT_ID,
    storeId: store[storeIdField.name],
    storeCode: STORE_CODE,
    amount: AMOUNT_TEXT,
    currency: CURRENCY,
    reference: EXTERNAL_REFERENCE,
    confirmedAt: now.toISOString(),
    confirmedDate: today,
    source: "vps_manual_operation",
  };

  if (statementMetadataField) {
    statementPreviewData[
      statementMetadataField.name
    ] = operationMetadata;
  }

  if (!existingStatement) {
    assertRequiredScalars(
      PayoutStatement,
      statementPreviewData,
      "Criação de PayoutStatement",
    );
  }

  console.log("\nRESULTADO DO PREFLIGHT");
  console.log({
    ready: true,
    willUpdateExistingStatement:
      Boolean(existingStatement),
    debitFrom: debitBucket.name,
    movementStatus,
    movementDirection,
    walletBalanceAfter:
      money(
        decimalNumber(
          wallet[walletBalanceField.name],
        ) - amountNumber,
      ),
    walletAvailableAfter:
      debitBucket.name === walletAvailableField.name
        ? money(available - amountNumber)
        : money(available),
    walletReservedAfter:
      walletReservedField
        ? debitBucket.name ===
          walletReservedField.name
          ? money(reserved - amountNumber)
          : money(reserved)
        : "campo inexistente",
  });

  if (!CONFIRM) {
    console.log("\nREAD-ONLY concluído.");
    console.log(
      "Para confirmar, execute novamente com CONFIRM=YES.",
    );

    return;
  }

  const txOptions = {
    maxWait: 10000,
    timeout: 30000,
  };

  if (
    Prisma.TransactionIsolationLevel
    && Prisma.TransactionIsolationLevel.Serializable
  ) {
    txOptions.isolationLevel =
      Prisma.TransactionIsolationLevel.Serializable;
  }

  const result = await prisma.$transaction(
    async (tx) => {
      const txWallet =
        delegate(tx, Wallet);

      const txStatement =
        delegate(tx, PayoutStatement);

      const txMovement =
        delegate(tx, WalletMovement);

      const walletWhere = {
        [walletIdField.name]:
          wallet[walletIdField.name],
        [debitBucket.name]: {
          gte: AMOUNT,
        },
        [walletBalanceField.name]: {
          gte: AMOUNT,
        },
      };

      if (
        walletBookBalanceField
        && walletBookBalanceField.name
          !== walletBalanceField.name
      ) {
        walletWhere[
          walletBookBalanceField.name
        ] = {
          gte: AMOUNT,
        };
      }

      const walletUpdateData = {
        [debitBucket.name]: {
          decrement: AMOUNT,
        },
        [walletBalanceField.name]: {
          decrement: AMOUNT,
        },
      };

      if (
        walletBookBalanceField
        && walletBookBalanceField.name
          !== walletBalanceField.name
      ) {
        walletUpdateData[
          walletBookBalanceField.name
        ] = {
          decrement: AMOUNT,
        };
      }

      const walletUpdate =
        await txWallet.updateMany({
          where: walletWhere,
          data: walletUpdateData,
        });

      if (walletUpdate.count !== 1) {
        throw new Error(
          "A Wallet foi alterada durante a operação "
          + "ou deixou de possuir saldo suficiente.",
        );
      }

      let statement;

      if (existingStatement) {
        const updateData = {
          [statementStatusField.name]: "paid",
        };

        if (statementPaidAtField) {
          updateData[
            statementPaidAtField.name
          ] = dateFieldValue(
            statementPaidAtField,
            null,
            now,
          );
        }

        if (statementPaidOnField) {
          updateData[
            statementPaidOnField.name
          ] = dateFieldValue(
            statementPaidOnField,
            today,
            now,
          );
        }

        if (statementExternalRefField) {
          updateData[
            statementExternalRefField.name
          ] = EXTERNAL_REFERENCE;
        }

        if (statementDescriptionField) {
          updateData[
            statementDescriptionField.name
          ] = DESCRIPTION;
        }

        if (statementHistoricalField) {
          updateData[
            statementHistoricalField.name
          ] = false;
        }

        if (statementMetadataField) {
          updateData[
            statementMetadataField.name
          ] = {
            ...safeMetadata(
              existingStatement[
                statementMetadataField.name
              ],
            ),
            ...operationMetadata,
          };
        }

        statement =
          await txStatement.update({
            where: {
              [statementIdField.name]:
                existingStatement[
                  statementIdField.name
                ],
            },
            data: updateData,
          });
      } else {
        statement =
          await txStatement.create({
            data: statementPreviewData,
          });
      }

      if (PayoutAllocation) {
        const allocationDelegate =
          delegate(tx, PayoutAllocation);

        const allocationStatementField =
          fieldByNames(
            PayoutAllocation,
            "payoutStatementId",
            "statementId",
            "payoutId",
          );

        const allocationStoreField =
          fieldByNames(
            PayoutAllocation,
            "storeId",
          );

        const allocationMerchantField =
          fieldByNames(
            PayoutAllocation,
            "merchantId",
          );

        const allocationAmountField =
          fieldByNames(
            PayoutAllocation,
            "amount",
            "value",
          );

        const allocationCurrencyField =
          fieldByNames(
            PayoutAllocation,
            "currency",
          );

        const allocationStoreCodeField =
          fieldByNames(
            PayoutAllocation,
            "storeCode",
          );

        const allocationStoreNameField =
          fieldByNames(
            PayoutAllocation,
            "storeName",
          );

        if (
          !allocationStatementField
          || !allocationStoreField
          || !allocationAmountField
        ) {
          throw new Error(
            "PayoutAllocation não possui os campos esperados.",
          );
        }

        const existingAllocations =
          await allocationDelegate.findMany({
            where: {
              [allocationStatementField.name]:
                statement[statementIdField.name],
            },
          });

        const allocationTotal =
          existingAllocations.reduce(
            (sum, item) =>
              sum + decimalNumber(
                item[allocationAmountField.name],
              ),
            0,
          );

        if (
          existingAllocations.length
          && Math.abs(
            allocationTotal - amountNumber,
          ) > 0.001
        ) {
          throw new Error(
            `Allocations existentes totalizam `
            + `${money(allocationTotal)}, não `
            + `${money(AMOUNT)}.`,
          );
        }

        if (!existingAllocations.length) {
          const allocationData = {
            [allocationStatementField.name]:
              statement[statementIdField.name],
            [allocationStoreField.name]:
              store[storeIdField.name],
            [allocationAmountField.name]:
              AMOUNT,
          };

          if (allocationMerchantField) {
            allocationData[
              allocationMerchantField.name
            ] = MERCHANT_ID;
          }

          if (allocationCurrencyField) {
            allocationData[
              allocationCurrencyField.name
            ] = CURRENCY;
          }

          if (allocationStoreCodeField) {
            allocationData[
              allocationStoreCodeField.name
            ] = STORE_CODE;
          }

          if (allocationStoreNameField) {
            allocationData[
              allocationStoreNameField.name
            ] = storeNameField
              ? store[storeNameField.name]
              : STORE_CODE;
          }

          assertRequiredScalars(
            PayoutAllocation,
            allocationData,
            "Criação de PayoutAllocation",
          );

          await allocationDelegate.create({
            data: allocationData,
          });
        }
      }

      const movementData = {
        [movementWalletField.name]:
          wallet[walletIdField.name],
        [movementMerchantField.name]:
          MERCHANT_ID,
        [movementCurrencyField.name]:
          CURRENCY,
        [movementTypeField.name]:
          "payout",
        [movementDirectionField.name]:
          movementDirection,
        [movementAmountField.name]:
          AMOUNT,
        [movementStatusField.name]:
          movementStatus,
        [movementReferenceField.name]:
          EXTERNAL_REFERENCE,
      };

      if (movementStoreField) {
        movementData[
          movementStoreField.name
        ] = store[storeIdField.name];
      }

      if (movementDescriptionField) {
        movementData[
          movementDescriptionField.name
        ] = DESCRIPTION;
      }

      if (movementMetadataField) {
        movementData[
          movementMetadataField.name
        ] = {
          ...operationMetadata,
          payoutStatementId:
            statement[statementIdField.name],
          statementCode:
            statement[statementCodeField.name],
        };
      }

      assertRequiredScalars(
        WalletMovement,
        movementData,
        "Criação de WalletMovement",
      );

      const movement =
        await txMovement.create({
          data: movementData,
        });

      const finalWallet =
        await txWallet.findUnique({
          where: {
            [walletIdField.name]:
              wallet[walletIdField.name],
          },
        });

      return {
        statement,
        movement,
        finalWallet,
      };
    },
    txOptions,
  );

  console.log("\n================================================");
  console.log("PAYOUT CONFIRMADO COM SUCESSO");
  console.log("================================================");

  console.log({
    payoutStatementId:
      result.statement[statementIdField.name],
    statementCode:
      result.statement[statementCodeField.name],
    status:
      result.statement[statementStatusField.name],
    amount:
      money(result.statement[statementAmountField.name]),
    description: DESCRIPTION,
    externalReference:
      statementExternalRefField
        ? result.statement[
            statementExternalRefField.name
          ]
        : EXTERNAL_REFERENCE,
    walletMovementId: movementIdField
      ? result.movement[movementIdField.name]
      : null,
    walletBalance:
      money(
        result.finalWallet[
          walletBalanceField.name
        ],
      ),
    walletAvailable:
      money(
        result.finalWallet[
          walletAvailableField.name
        ],
      ),
    walletReserved:
      walletReservedField
        ? money(
            result.finalWallet[
              walletReservedField.name
            ],
          )
        : null,
  });
}

main()
  .catch((error) => {
    console.error("\nOPERAÇÃO CANCELADA");
    console.error(error);

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
