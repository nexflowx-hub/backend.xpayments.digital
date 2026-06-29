import axios from 'axios';
import * as cheerio from 'cheerio';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const STORE_ID = "2a74fcfa-a344-4507-9369-a52d689160f0"; // Loja Mudas.Projetogenesis.org
const SCRAPER_API_KEY = "be9c8b5d7fcdfeb4ba60c79211e9e90d"; 

async function runUltimateScraper() {
  console.log('🚀 A iniciar Scraper Nível Enterprise via Rede de Proxies ScraperAPI...');
  console.log('🌐 Alvo: Mercado Livre (Viveiro Buriti)');
  
  try {
    const targetUrl = 'https://lista.mercadolivre.com.br/viveiro-buriti';
    // O render=true obriga os servidores deles a abrir um browser real (Headless Chrome) para carregar as fotos
    const proxyUrl = `http://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true`;

    console.log('⏳ A furar as defesas (isto pode demorar 20-40 segundos)...');
    const response = await axios.get(proxyUrl, { timeout: 90000 }); 
    
    const html = response.data;
    const $ = cheerio.load(html);
    const products: any[] = [];

    $('.ui-search-layout__item').each((index, element) => {
      if (index >= 40) return; // Vamos puxar até 40 mudas

      const title = $(element).find('.ui-search-item__title').text().trim() || $(element).find('h2').text().trim();
      const priceStr = $(element).find('.andes-money-amount__fraction').first().text().replace(/\./g, '');
      const price = parseFloat(priceStr);
      
      // O ML esconde as imagens em várias tags devido ao lazy loading
      let image = $(element).find('.ui-search-result-image__element').attr('data-src') || 
                  $(element).find('.ui-search-result-image__element').attr('src') ||
                  $(element).find('img').attr('src');
                  
      // Mudar miniatura para alta resolução
      if (image) image = image.replace('-I.jpg', '-O.jpg');
      
      const link = $(element).find('.ui-search-link').attr('href') || $(element).find('a').attr('href');

      if (title && price && image) {
        products.push({ title, price, image, link });
      }
    });

    if (products.length === 0) {
      console.log('❌ O HTML não trouxe os produtos. O ML pode ter mudado a classe CSS hoje.');
      return;
    }

    console.log(`\n📦 Extraímos ${products.length} mudas reais! A injetar no Catálogo...`);

    let importedCount = 0;
    for (const item of products) {
      const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
      await prisma.product.create({
        data: {
          storeId: STORE_ID,
          name: item.title,
          slug: slug,
          description: `Produto autêntico do Viveiro Buriti.\nLink ML: ${item.link}`,
          category: 'Mudas e Plantas',
          priceFiat: item.price,
          currency: 'BRL',
          images: [item.image],
          isActive: true,
          metadata: { source: 'mercadolivre.com.br', method: 'scraper-api' }
        }
      });
      importedCount++;
      console.log(`✅ Salvo: ${item.title.substring(0, 30)}... | R$ ${item.price}`);
    }

    console.log(`\n🎉 SUCESSO ABSOLUTO! Catálogo do Projeto Genesis preenchido com dados reais.`);

  } catch (error: any) {
    console.error('❌ Falha na conexão:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

runUltimateScraper();
