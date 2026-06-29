import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 A iniciar Setup do Lojista BW e Loja Walluxe...');

  // 1. Criar o Merchant BW
  const merchant = await prisma.merchant.create({
    data: {
      name: 'BW Lda.',
      email: 'admin@bw.com',
      password: 'SenhaSegura123!', // Podes mudar no painel depois
      tier: 'TIER_A_PREMIUM',
      status: 'ACTIVE'
    }
  });

  // 2. Criar a Store Walluxe ligada ao BW
  const store = await prisma.store.create({
    data: {
      merchantId: merchant.id,
      name: 'Walluxe',
      primaryColor: '#D4AF37', // O Dourado Premium
      accentColor: '#10b981',
      successUrl: 'https://walluxe.xdeals.online/checkout/success',
      webhookUrl: 'https://walluxe.xdeals.online/api/xpayments-webhook',
      checkoutConfig: { allowedMethods: ["CARD"], defaultCurrency: "EUR" }
    }
  });

  // 3. Gerar a API Key (Secret e Public) para o BW
  const apiKey = await prisma.apiKey.create({
    data: {
      merchantId: merchant.id,
      merchantName: 'BW Lda.',
      publicKey: 'pk_live_' + crypto.randomBytes(16).toString('hex'),
      secretKey: 'sk_live_' + crypto.randomBytes(32).toString('hex')
    }
  });

  console.log('✅ Setup Concluído com Sucesso!');
  console.log('--------------------------------------------------');
  console.log(`🔐 Email Lojista: ${merchant.email}`);
  console.log(`🆔 ID da Loja (storeId): ${store.id}`);
  console.log(`🔑 Chave Secreta da API (Para a Walluxe usar): ${apiKey.secretKey}`);
  console.log('--------------------------------------------------');
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
