import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

const STORE_ID = "2a74fcfa-a344-4507-9369-a52d689160f0";

async function scrapeMercadoLivre() {
  console.log('🔍 A extrair dados da API do Mercado Livre (Pesquisa Aberta)...');

  try {
    // Usamos a pesquisa aberta 'q=mudas frutiferas' que nunca é bloqueada
    const mlResponse = await fetch('https://api.mercadolibre.com/sites/MLB/search?q=mudas%20frutiferas&limit=50');
    const data = await mlResponse.json();

    if (!data.results || data.results.length === 0) {
      console.log('❌ Nenhum produto encontrado. A API pode estar a limitar a tua IP.');
      return;
    }

    console.log(`📦 Encontrados ${data.results.length} produtos. A injetar no Catálogo da Genesis...`);

    let importedCount = 0;

    for (const item of data.results) {
      // Ignorar produtos sem foto
      if (!item.thumbnail) continue;

      // Formatar Imagem: O ML usa "-I" para miniaturas e "-O" para Original/Alta Qualidade
      const highResImage = item.thumbnail.replace('-I.jpg', '-O.jpg');
      
      const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex');

      await prisma.product.create({
        data: {
          storeId: STORE_ID,
          name: item.title,
          slug: slug,
          description: `Muda de alta qualidade para o Projeto Genesis.\nRef ML: ${item.permalink}`,
          category: item.domain_id || 'Plantas',
          priceFiat: item.price,
          currency: item.currency_id || 'BRL',
          images: [highResImage],
          isActive: true,
          metadata: {
            source: 'mercadolivre.com.br',
            ml_item_id: item.id,
            available_quantity: item.available_quantity,
            condition: item.condition
          }
        }
      });
      importedCount++;
      console.log(`✅ Plantado: ${item.title.substring(0, 40)}... - R$ ${item.price}`);
    }

    console.log(`\n🎉 INJEÇÃO CONCLUÍDA! ${importedCount} mudas foram plantadas no teu catálogo da Genesis.`);

  } catch (error) {
    console.error('❌ Erro fatal durante a extração:', error);
  } finally {
    await prisma.$disconnect();
  }
}

scrapeMercadoLivre();
