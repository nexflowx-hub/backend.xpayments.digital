import 'dotenv/config';

const onlyDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

function isValidCpf(value: unknown): boolean {
  const cpf = onlyDigits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;

  const digit = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      sum += Number(cpf[i]) * (length + 1 - i);
    }
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };

  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

async function main() {
  const storeCode = String(process.env.PIX_TEST_STORE_CODE ?? 'NOVIDADES-BRL')
    .trim()
    .toUpperCase();
  const expectedProvider = String(process.env.PIX_TEST_EXPECTED_PROVIDER ?? 'pix-primary')
    .trim()
    .toLowerCase();
  const apiKey = String(process.env.PIX_TEST_API_KEY ?? '').trim();
  const payerName = String(process.env.PIX_TEST_PAYER_NAME ?? '').trim();
  const payerCpf = onlyDigits(process.env.PIX_TEST_PAYER_CPF);
  const amount = Number(process.env.PIX_TEST_AMOUNT_CENTS ?? '100');
  const confirmed = String(process.env.PIX_TEST_CONFIRM ?? '').trim() === 'YES';

  if (!confirmed) throw new Error('Set PIX_TEST_CONFIRM=YES to create a real PIX charge.');
  if (!apiKey) throw new Error('PIX_TEST_API_KEY is required.');
  if (payerName.length < 3) throw new Error('PIX_TEST_PAYER_NAME is required.');
  if (!isValidCpf(payerCpf)) throw new Error('PIX_TEST_PAYER_CPF must be a valid CPF.');
  if (!Number.isInteger(amount) || amount < 100 || amount > 10000) {
    throw new Error('PIX_TEST_AMOUNT_CENTS must be an integer between 100 and 10000.');
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const reference = `${storeCode.replace(/[^A-Z0-9]/g, '').slice(0, 16)}-LIVE-${stamp}`;

  const response = await fetch('http://127.0.0.1:3001/api/v1/payments/charge', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount,
      currency: 'BRL',
      payment_method_types: ['pix'],
      reference,
      customer: {
        name: payerName,
        cpf: payerCpf,
        document: payerCpf,
        taxId: payerCpf,
      },
      metadata: {
        source: 'generic-brl-live-probe',
        storefront: storeCode,
        expectedProvider,
        purpose: 'production-preflight',
      },
    }),
  });

  const raw = await response.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw: raw.slice(0, 800) };
  }

  if (!response.ok || body?.success !== true) {
    console.error(
      JSON.stringify(
        { success: false, storeCode, httpStatus: response.status, reference, response: body },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }

  const action = body?.action ?? {};
  const copyPaste = action?.copyPaste ?? action?.pixString ?? '';

  console.log(
    JSON.stringify(
      {
        success: true,
        storeCode,
        httpStatus: response.status,
        reference: body?.reference ?? reference,
        transactionId: body?.transactionId ?? null,
        status: body?.status ?? null,
        method: body?.method ?? 'pix',
        amountCents: amount,
        expiresAt: action?.expiresAt ?? null,
        qrEmbedded: Boolean(action?.qrCodeBase64 || action?.qrCode),
        copyPastePresent: Boolean(copyPaste),
      },
      null,
      2,
    ),
  );

  if (copyPaste) {
    console.log('\nPIX COPIA E COLA:\n');
    console.log(copyPaste);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
