import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const STORE_ID = "2a74fcfa-a344-4507-9369-a52d689160f0";

async function createFirstProduct() {
  console.log('🌱 A plantar o Kit Premium no Projeto Genesis...');
  
  try {
    const name = "Kit 3 Mudas Acerola Goiaba Caju + Ganhe 1 Jabuticaba";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex');

    const product = await prisma.product.create({
      data: {
        storeId: STORE_ID,
        name: name,
        slug: slug,
        description: `KIT 3 MUDAS FRUTÍFERAS\n\nACEROLA + GOIABA + CAJU\n\nGANHE 1 MUDA DE JABUTICABA DE BRINDE\n\nAproveite esta oferta especial e receba um kit com 3 mudas frutíferas selecionadas para formar ou ampliar seu pomar, além de uma muda de jabuticaba enviada gratuitamente como brinde.\n\nO KIT CONTÉM:\n• 01 Muda de Acerola com 30 a 50 cm\n• 01 Muda de Goiaba com 30 a 50 cm\n• 01 Muda de Caju com 30 a 50 cm\n\nBRINDE:\n• 01 Muda de Jabuticaba com aproximadamente 20 cm\n\nBENEFÍCIOS\n• Frutíferas de fácil cultivo\n• Ideal para quintais, chácaras e sítios\n• Produção de frutas frescas para toda a família\n• Plantas saudáveis e prontas para o plantio\n• Excelente opção para quem deseja iniciar um pomar\n\nQUALIDADE E SEGURANÇA\nTodas as mudas são cuidadosamente selecionadas e embaladas para garantir que cheguem em ótimas condições até você.\n\nIMPORTANTE\n• As mudas possuem altura aproximada entre 30 e 50 cm.\n• A muda de jabuticaba enviada como brinde possui aproximadamente 20 cm.\n• Por serem plantas vivas, podem ocorrer pequenas variações de tamanho, folhas e coloração.\n• As fotos são ilustrativas.\n\nGaranta agora seu kit e receba uma muda de jabuticaba totalmente grátis para deixar seu pomar ainda mais completo.`,
        category: "Kits Promocionais",
        priceFiat: 129.90,
        currency: "BRL",
        images: ["https://res.cloudinary.com/dmmiup10y/image/upload/v1782512127/Acerola_Goiaba_Caju_Jabuticaba__KIT4_2_e16m1x.png"],
        isActive: true,
        metadata: {
          source: 'manual_entry',
          promotional: true
        }
      }
    });

    console.log(`✅ Produto Criado com Sucesso!`);
    console.log(`📦 Nome: ${product.name}`);
    console.log(`💰 Preço: R$ ${product.priceFiat}`);
    console.log(`🆔 ID do Produto: ${product.id}`);
  } catch (error) {
    console.error('❌ Erro a plantar:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createFirstProduct();
