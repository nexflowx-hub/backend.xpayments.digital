import axios from 'axios';
import * as cheerio from 'cheerio';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const STORE_ID = "2a74fcfa-a344-4507-9369-a52d689160f0";

async function runRealScraper() {
  console.log('🕵️‍♂️ A iniciar Scraper Furtivo...');
  console.log('🌐 Alvo: Mercado Livre (Viveiro Buriti)');

  try {
    // 1. O DISFARCE: Vamos fingir que somos um utilizador real no Windows 11 com o Chrome 124
    const response = await axios.get('https://lista.mercadolivre.com.br/viveiro-buriti', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': 'https://www.google.com/', // Fingimos que viemos do Google
        'Sec-Ch-Ua-Platform': '"Windows"'
      },
      timeout: 10000 // 10 segundos de limite
    });

    // 2. LER O CÓDIGO-FONTE: O Mercado Livre deixou-nos entrar. Vamos ler o HTML.
    const html = response.data;
    const $ = cheerio.load(html);
    const products: any[] = [];

    // 3. A EXTRAÇÃO CIRÚRGICA: Procurar a grelha de produtos na página
    $('.ui-search-layout__item').each((index, element) => {
      if (index >= 30) return; // Limitar a 30 produtos reais

      // Extrair Título
      const title = $(element).find('.ui-search-item__title').text().trim();
      
      // Extrair Preço (remover os pontos de milhar do Brasil)
      const priceStr = $(element).find('.andes-money-amount__fraction').first().text().replace(/\./g, '');
      const price = parseFloat(priceStr);
      
      // Extrair Imagem (O ML usa lazy loading, a foto real pode estar no data-src ou src)
      let image = $(element).find('.ui-search-result-image__element').attr('data-src') || 
                  $(element).find('.ui-search-result-image__element').attr('src');
      
      // Melhorar a resolução da imagem do ML de miniatura (-I) para média (-O)
      if (image) image = image.replace('-I.jpg', '-O.jpg');

      // Extrair Link do Produto
      const link = $(element).find('.ui-search-link').attr('href');

      if (title && price && image) {
        products.push({ title, price, image, link });
      }
    });

    if (products.length === 0) {
      console.log('❌ O HTML mudou ou o disfarce foi detetado. Tenta novamente mais tarde.');
      return;
    }

    console.log(`📦 Extraímos ${products.length} produtos REAIS com sucesso! A gravar no Catálogo da Genesis...`);

    // 4. INJETAR NA BASE DE DADOS
    let importedCount = 0;
    for (const item of products) {
      const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex');

      await prisma.product.create({
        data: {
          storeId: STORE_ID,
          name: item.title,
          slug: slug,
          description: `Produto raspado diretamente do Mercado Livre.\nLink original: ${item.link}`,
          category: 'Plantas (Scraped)',
          priceFiat: item.price,
          currency: 'BRL',
          images: [item.image],
          isActive: true,
          metadata: {
            source: 'mercadolivre.com.br',
            method: 'cheerio-scraper',
            original_url: item.link
          }
        }
      });
      importedCount++;
      console.log(`✅ Gravado: ${item.title.substring(0, 40)}... | R$ ${item.price}`);
    }

    console.log(`\n🎉 MISSÃO CONCLUÍDA! Catálogo alimentado com dados autênticos do site.`);

  } catch (error: any) {
    console.error('❌ O Scraper bateu de frente com um escudo:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

runRealScraper();
