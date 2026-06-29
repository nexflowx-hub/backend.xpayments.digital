import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 A iniciar Setup do ProjetoGenesis...');

  // 1. Criar o Merchant Genesis
  const merchant = await prisma.merchant.create({
    data: {
      name: 'ProjetoGenesis',
      email: 'contact@projetogenesis.org',
      password: 'Pgen11235813213455*.*',
      tier: 'TIER_B_PRO', // Assumimos nível PRO
      status: 'ACTIVE'
    }
  });

  // 2. Criar a Store Mudas
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.id,
      name: 'Mudas.Projetogenesis.org',
      primaryColor: '#16a34a', // Verde Natureza
      accentColor: '#22c55e',
      checkoutConfig: { allowedMethods: ["CARD", "PIX"], defaultCurrency: "BRL" }
    }
  });

  // 3. Gerar a API Key
  const apiKey = await prisma.apiKey.create({
    data: {
      merchantId: merchant.id,
      merchantName: 'ProjetoGenesis',
      publicKey: 'pk_live_' + crypto.randomBytes(16).toString('hex'),
      secretKey: 'sk_live_' + crypto.randomBytes(32).toString('hex')
    }
  });

  console.log('✅ Setup Concluído com Sucesso!');
  console.log('--------------------------------------------------');
  console.log(`🆔 ID DA LOJA (storeId): ${store.id}`);
  console.log(`🔐 Email: ${merchant.email}`);
  console.log(`🔑 Secret Key: ${apiKey.secretKey}`);
  console.log('--------------------------------------------------');
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
