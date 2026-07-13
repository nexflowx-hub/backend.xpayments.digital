import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const merchantId = '5d2a2279-deed-4225-b49c-b0c60ebb8580'; // BW_WebProjets

  console.log('⏳ A iniciar a configuração da RevEurope...');

  // 1. Criar a nova loja RevEurope
  const store = await prisma.store.create({
    data: {
      merchantId: merchantId,
      name: 'RevEurope',
      domain: 'reveurope.xdeals.online',
      status: 'active',
      currency: 'EUR'
    }
  });
  console.log(`✅ Loja RevEurope criada com Sucesso! (ID: ${store.id})`);

  // 2. Criar uma API Key para o Merchant
  const apiKey = 'sk_test_reveurope_58b2x9';
  await prisma.apiKey.create({
    data: {
      merchantId: merchantId,
      name: 'API Key API Direta - RevEurope',
      prefix: 'sk_test_',
      lastFour: 'b2x9',
      hash: apiKey, 
      scopes: ['payments_write'],
      environment: 'test'
    }
  });
  console.log(`✅ API Key criada: ${apiKey}`);

  // 3. Criar o Gateway Vault (O cofre da Stripe) para a RevEurope
  await prisma.gatewayVault.create({
    data: {
      merchantId: merchantId,
      storeId: store.id,
      provider: 'stripe',
      isActive: true,
      credentials: {
        providerId: "STRIPE_PT_002",
        webhookSecret: "whsec_simulado_123",
        notes: "Configurado via seed para orquestração"
      }
    }
  });
  console.log('✅ GatewayVault (Stripe PT 002) associado à RevEurope.');
}

main()
  .catch(e => {
    console.error('❌ Erro no script:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
