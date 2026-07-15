import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const processSettlements = async () => {
  console.log('🔄 [SETTLEMENT] Iniciando liquidação de fundos (D+3)...');
  
  // Calcula a data limite: Tudo o que tem mais de 3 dias
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  try {
    // 1. Busca os movimentos pendentes antigos
    const pendingMovements = await prisma.walletMovement.findMany({
      where: {
        status: 'pendente',
        direction: 'in',
        createdAt: { lte: threeDaysAgo },
      }
    });

    if (pendingMovements.length === 0) {
      console.log('✅ [SETTLEMENT] Nenhum fundo pendente para liquidação neste momento.');
      return;
    }

    console.log(`⏳ [SETTLEMENT] Encontrados ${pendingMovements.length} movimentos para liquidar.`);

    // 2. Processa cada movimento dentro de uma Transação SQL segura
    for (const movement of pendingMovements) {
      await prisma.$transaction(async (tx) => {
        
        // A) Atualiza o estado do movimento para 'disponivel'
        await tx.walletMovement.update({
          where: { id: movement.id },
          data: { status: 'disponivel' }
        });

        // B) Incrementa o saldo de saque (available) na Wallet do Lojista
        await tx.wallet.update({
          where: { id: movement.walletId },
          data: { available: { increment: movement.amount } }
        });

      });
      
      console.log(`💰 [SETTLEMENT] Fundo liquidado: +${movement.amount} EUR (Movimento: ${movement.id})`);
    }

    console.log('✅ [SETTLEMENT] Processo de liquidação concluído com sucesso!');
  } catch (error) {
    console.error('❌ [SETTLEMENT] Erro no processo de liquidação:', error);
  } finally {
    await prisma.$disconnect();
  }
};

// Se o ficheiro for executado diretamente no terminal, roda a função
if (require.main === module) {
  processSettlements();
}
