import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.store.updateMany({
    data: { status: 'active' }
  });
  console.log('✅ Lojas ativadas com sucesso!');
}

main().finally(async () => {
  await prisma.$disconnect();
});
