const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SOURCE_STORE_CODE = 'REVEURO1';
const TARGET_STORE_CODE = 'REVEURO2';

const TARGET_API_KEY_ID =
  'fa5560c8-c203-4a3d-b246-28bdb2e956a9';

function randomFromAlphabet(length, alphabet) {
  let result = '';

  while (result.length < length) {
    const bytes = crypto.randomBytes(length);

    for (const byte of bytes) {
      result += alphabet[byte % alphabet.length];

      if (result.length === length) {
        break;
      }
    }
  }

  return result;
}

function generateMatchingKey(sourceKey) {
  let prefix = '';

  if (sourceKey.startsWith('xp_live_')) {
    prefix = 'xp_live_';
  } else if (sourceKey.startsWith('xp_test_')) {
    prefix = 'xp_test_';
  } else {
    throw new Error(
      'A chave da RevEuro-1 não possui prefixo reconhecido.'
    );
  }

  const sourceSuffix = sourceKey.slice(prefix.length);
  const suffixLength = sourceSuffix.length;

  let generatedSuffix;

  if (/^[0-9a-f]+$/i.test(sourceSuffix)) {
    generatedSuffix = crypto
      .randomBytes(Math.ceil(suffixLength / 2))
      .toString('hex')
      .slice(0, suffixLength);
  } else if (/^[A-Za-z0-9]+$/.test(sourceSuffix)) {
    generatedSuffix = randomFromAlphabet(
      suffixLength,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    );
  } else if (/^[A-Za-z0-9_-]+$/.test(sourceSuffix)) {
    generatedSuffix = randomFromAlphabet(
      suffixLength,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
    );
  } else {
    throw new Error(
      'A codificação da chave RevEuro-1 não foi reconhecida.'
    );
  }

  return `${prefix}${generatedSuffix}`;
}

function preview(key) {
  if (!key) {
    return null;
  }

  return `${key.slice(0, 12)}...${key.slice(-6)}`;
}

async function main() {
  const sourceStore = await prisma.store.findUnique({
    where: {
      storeCode: SOURCE_STORE_CODE
    },
    include: {
      apiKeys: {
        where: {
          environment: 'live'
        },
        orderBy: {
          createdAt: 'asc'
        }
      }
    }
  });

  if (!sourceStore) {
    throw new Error(
      `Store ${SOURCE_STORE_CODE} não encontrada.`
    );
  }

  const sourceApiKey = sourceStore.apiKeys[0];

  if (!sourceApiKey) {
    throw new Error(
      `A Store ${SOURCE_STORE_CODE} não possui API Key live.`
    );
  }

  const targetStore = await prisma.store.findUnique({
    where: {
      storeCode: TARGET_STORE_CODE
    }
  });

  if (!targetStore) {
    throw new Error(
      `Store ${TARGET_STORE_CODE} não encontrada.`
    );
  }

  const targetApiKey = await prisma.apiKey.findUnique({
    where: {
      id: TARGET_API_KEY_ID
    }
  });

  if (!targetApiKey) {
    throw new Error(
      `API Key ${TARGET_API_KEY_ID} não encontrada.`
    );
  }

  if (targetApiKey.storeId !== targetStore.id) {
    throw new Error(
      'A API Key indicada não pertence à Store RevEuro-2.'
    );
  }

  const newKey = generateMatchingKey(sourceApiKey.key);

  const duplicate = await prisma.apiKey.findUnique({
    where: {
      key: newKey
    }
  });

  if (duplicate) {
    throw new Error(
      'Foi gerada uma chave duplicada. Execute novamente.'
    );
  }

  await prisma.apiKey.update({
    where: {
      id: targetApiKey.id
    },
    data: {
      key: newKey,
      name: 'API Key - RevEuro-2 Production',
      scopes: ['payments_write'],
      environment: 'live',
      lastUsedAt: null
    }
  });

  console.log('');
  console.log('==========================================');
  console.log('REVEURO-2 API KEY ATUALIZADA');
  console.log('==========================================');
  console.log(`Formato origem: ${SOURCE_STORE_CODE}`);
  console.log(`Chave origem: ${preview(sourceApiKey.key)}`);
  console.log(`Comprimento origem: ${sourceApiKey.key.length}`);
  console.log('');
  console.log(`Store atualizada: ${TARGET_STORE_CODE}`);
  console.log(`API Key ID: ${targetApiKey.id}`);
  console.log(`Chave anterior: ${preview(targetApiKey.key)}`);
  console.log(`Comprimento novo: ${newKey.length}`);
  console.log('');
  console.log(`NOVA API KEY: ${newKey}`);
  console.log('');
  console.log(
    'A chave anterior da RevEuro-2 deixou de funcionar.'
  );
}

main()
  .catch(error => {
    console.error('[ALIGN_REVEURO2_KEY_ERROR]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
