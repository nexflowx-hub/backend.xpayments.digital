import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 A iniciar o Seed da Base de Dados XPayments...');

  const masterVault = await prisma.gatewayVault.upsert({
    where: { providerId: 'STRIPE_PT_002' },
    update: {},
    create: {
      providerId: 'STRIPE_PT_002',
      publicName: 'Cartão de Crédito Global',
      authConfig: JSON.stringify({ apiKey: "mock_stripe_secret_key_123" }),
      webhookConfig: JSON.stringify({ webhookSecret: "mock_webhook_secret_123" })
    }
  });

  await prisma.adminUser.upsert({
    where: { email: 'contact@xpayments.digital' },
    update: {},
    create: { name: 'XPayments Master', email: 'contact@xpayments.digital', password: 'Xpay123456789*.*', role: 'SUPER_ADMIN' },
  });

  const baseConfig = JSON.stringify({
    routing: { "CARD": "STRIPE_PT_002", "MBWAY": "STRIPE_PT_002" },
    allowedMethods: ["CARD", "MBWAY"],
    defaultCurrency: "EUR"
  });

  await prisma.merchant.upsert({
    where: { email: 'admin@xdeals.online' },
    update: {},
    create: {
      name: 'XDEALS', email: 'admin@xdeals.online', password: 'SenhaSegura123!', tier: 'TIER_B_PRO',
      apiKeys: { create: { merchantName: 'XDEALS', publicKey: 'pk_live_' + crypto.randomBytes(8).toString('hex'), secretKey: 'mock_stripe_secret_key_123' + crypto.randomBytes(16).toString('hex') } },
      stores: { create: [
          { name: 'Securifix', merchantName: 'XDEALS', checkoutConfig: baseConfig, primaryColor: '#FF0000' },
          { name: 'Walluxe', merchantName: 'XDEALS', checkoutConfig: baseConfig, primaryColor: '#D4AF37' }
      ]}
    },
  });

  await prisma.merchant.upsert({
    where: { email: 'admin@nexecom.com' },
    update: {},
    create: {
      name: 'NeXECom', email: 'admin@nexecom.com', password: 'SenhaSegura123!', tier: 'TIER_A_PREMIUM',
      apiKeys: { create: { merchantName: 'NeXECom', publicKey: 'pk_live_' + crypto.randomBytes(8).toString('hex'), secretKey: 'mock_stripe_secret_key_123' + crypto.randomBytes(16).toString('hex') } },
      stores: { create: [
          { name: 'Azores.Bio', merchantName: 'NeXECom', checkoutConfig: baseConfig, primaryColor: '#22C55E' },
          { name: 'Acai.best', merchantName: 'NeXECom', checkoutConfig: baseConfig, primaryColor: '#9333EA' },
          { name: 'Robustponds.Shop', merchantName: 'NeXECom', checkoutConfig: baseConfig, primaryColor: '#3B82F6' }
      ]}
    },
  });

  console.log('🌲 Seed concluído! Contas criadas e prontas.');
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
