import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedVault() {
  console.log('🔐 A abrir a Caixa-Forte (GatewayVault)...');

  try {
    // 1. Cofre MASTER da MisticPay
    await prisma.gatewayVault.upsert({
      where: { providerId: 'MISTICPAY_MASTER' },
      update: {
        // Podes alterar isto depois diretamente na Base de Dados
        authConfig: JSON.stringify({ 
          ci: process.env.MISTICPAY_CI || "COLA_AQUI_O_CLIENT_ID_MISTICPAY", 
          cs: process.env.MISTICPAY_CS || "COLA_AQUI_O_CLIENT_SECRET_MISTICPAY" 
        }),
        status: 'ACTIVE'
      },
      create: {
        providerId: 'MISTICPAY_MASTER',
        publicName: 'MisticPay Global (PIX)',
        authConfig: JSON.stringify({ 
          ci: process.env.MISTICPAY_CI || "COLA_AQUI_O_CLIENT_ID_MISTICPAY", 
          cs: process.env.MISTICPAY_CS || "COLA_AQUI_O_CLIENT_SECRET_MISTICPAY" 
        }),
        status: 'ACTIVE'
      }
    });

    // 2. Cofre MASTER da Stripe
    await prisma.gatewayVault.upsert({
      where: { providerId: 'STRIPE_MASTER' },
      update: {}, // Não faz nada se já existir
      create: {
        providerId: 'STRIPE_MASTER',
        publicName: 'Stripe Global (EUR/USD)',
        authConfig: JSON.stringify({ secretKey: "sk_live_master_..." }),
        status: 'ACTIVE'
      }
    });

    console.log('✅ Cofres Master selados e operacionais!');
  } catch (error) {
    console.error('❌ Erro no cofre:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedVault();
