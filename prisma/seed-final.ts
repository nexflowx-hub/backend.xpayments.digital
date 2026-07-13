import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('⏳ A iniciar orquestração de dados NeXFlowX...');
  const merchantId = '5d2a2279-deed-4225-b49c-b0c60ebb8580';

  // 1. Merchant
  const merchant = await prisma.merchant.upsert({
    where: { id: merchantId },
    update: {},
    create: { 
      id: merchantId, email: 'admin@bwwebprojets.com', name: 'BW_WebProjets', 
      company: 'BW_WebProjets', passwordHash: 'hash_simulado' 
    }
  });

  // 2. Lojas, Webhooks e Chaves
  const storesData = [
    { code: 'WALLUXE', name: 'Walluxe', apiKey: 'sk_test_walluxe_v3', webhookUrl: 'https://api.walluxe.com/webhooks/nexflow' },
    { code: 'REVEUROPE', name: 'RevEurope', apiKey: 'sk_test_reveurope_v3', webhookUrl: 'https://api.reveurope.com/webhooks/nexflow' }
  ];

  for (const s of storesData) {
    const store = await prisma.store.upsert({
      where: { storeCode: s.code },
      update: {},
      create: {
        merchantId: merchant.id,
        storeCode: s.code,
        name: s.name,
        routingRules: { "mb_way": "stripe", "pix": "misticpay", "card": "stripe" }
      }
    });

    // Criar Webhook da Loja
    await prisma.webhook.create({
      data: { storeId: store.id, url: s.webhookUrl, secret: `whsec_${s.code.toLowerCase()}_123` }
    });

    // Criar API Key da Loja (Plain text)
    await prisma.apiKey.upsert({
      where: { key: s.apiKey },
      update: {},
      create: { storeId: store.id, name: `API Key - ${s.name}`, key: s.apiKey, scopes: ['payments_write'] }
    });

    // Criar Cofres Gateway (Stripe para ambas, Misticpay só para Walluxe de momento)
    await prisma.gatewayVault.create({
      data: { merchantId: merchant.id, storeId: store.id, provider: 'stripe', credentials: { accountId: 'STRIPE_BW001' } }
    });

    if (s.code === 'WALLUXE') {
      await prisma.gatewayVault.create({
        data: { merchantId: merchant.id, storeId: store.id, provider: 'misticpay', credentials: { accountId: 'MISTIC_BW001' } }
      });
    }
  }

  console.log('✅ Base de dados alimentada com sucesso! Lojas, Chaves e Webhooks isolados.');
}

main()
  .catch(e => { console.error('❌ Erro no seed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
