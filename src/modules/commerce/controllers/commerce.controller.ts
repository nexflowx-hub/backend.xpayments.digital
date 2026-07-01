import { Response, Request } from 'express';
import crypto from 'crypto';
import prisma from '../../../core/prisma';
import { isValidUUID } from '../../../core/utils/auth';
import { AuthRequest } from '../../../middleware/auth.middleware';

// --- STORES ---
export const getStores = async (req: AuthRequest, res: Response) => {
  try {
    const stores = await prisma.store.findMany({ where: { merchantId: req.merchantId! }, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: stores });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const createStore = async (req: AuthRequest, res: Response) => {
  try {
    const { name, primaryColor, successUrl, webhookUrl } = req.body;
    const newStore = await prisma.store.create({
      data: { merchantId: req.merchantId!, name: name || 'Nova Loja', primaryColor: primaryColor || '#10b981', successUrl: successUrl || '', webhookUrl: webhookUrl || '', checkoutConfig: { allowedMethods: ["CARD", "MBWAY", "PIX"], defaultCurrency: "EUR" } }
    });
    res.json({ success: true, data: newStore });
  } catch (error) { res.status(500).json({ success: false }); }
};

// --- PRODUCTS ---
export const getProducts = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = req.merchantId!;
    const stores = await prisma.store.findMany({ where: { merchantId }, select: { id: true }});
    const products = await prisma.product.findMany({ where: { storeId: { in: stores.map(s => s.id) } }, orderBy: { createdAt: 'desc' }, include: { store: true }});
    res.json({ success: true, data: products });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const createProduct = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = req.merchantId!;
    let { storeId, name, description, category, priceFiat, currency, images, metadata } = req.body;
    if (!isValidUUID(storeId)) {
      const firstStore = await prisma.store.findFirst({ where: { merchantId } });
      storeId = firstStore ? firstStore.id : (await prisma.store.create({ data: { merchantId, name: 'Loja Principal', isActive: true } })).id;
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
    const newProduct = await prisma.product.create({ data: { storeId, name, slug, description, category, priceFiat: Number(priceFiat) || 0, currency: currency || 'EUR', images: images || [], metadata: metadata || {} } });
    res.json({ success: true, data: newProduct });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const updateProduct = async (req: AuthRequest, res: Response) => {
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!p || p.store.merchantId !== req.merchantId!) return res.status(404).json({ success: false });
    const { name, description, priceFiat, currency, isActive, images } = req.body;
    const updated = await prisma.product.update({ where: { id: req.params.id }, data: { name, description, priceFiat: priceFiat !== undefined ? Number(priceFiat) : undefined, currency, isActive, images } });
    res.json({ success: true, data: updated });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!p || p.store.merchantId !== req.merchantId!) return res.status(404).json({ success: false });
    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
};

// --- PAYMENT LINKS ---
export const getLinks = async (req: AuthRequest, res: Response) => {
  try {
    const stores = await prisma.store.findMany({ where: { merchantId: req.merchantId! }, select: { id: true } });
    const links = await prisma.paymentLink.findMany({ where: { storeId: { in: stores.map(s => s.id) } }, orderBy: { createdAt: 'desc' }, include: { store: true } });
    const mappedLinks = links.map(l => ({ ...l, amount: Number(l.amountFiat), url: `https://checkout.xpayments.digital/pay/${l.urlCode}` }));
    res.json({ success: true, data: mappedLinks });
  } catch (error) { res.json({ success: true, data: [] }); }
};

export const createLink = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = req.merchantId!;
    let { storeId, productId, name, amountFiat, amount, currency, description } = req.body;
    if (!isValidUUID(storeId)) {
      const firstStore = await prisma.store.findFirst({ where: { merchantId } });
      storeId = firstStore ? firstStore.id : (await prisma.store.create({ data: { merchantId, name: 'Loja Principal', isActive: true } })).id;
    }
    const validProductId = isValidUUID(productId) ? productId : null;
    const safeAmount = isNaN(Number(amountFiat || amount)) ? 0 : Number(amountFiat || amount);
    let imageUrl = null;
    if (validProductId) {
      const p = await prisma.product.findUnique({ where: { id: validProductId }});
      if (p && p.images && p.images.length > 0) imageUrl = p.images[0];
      if (!name && p) name = p.name;
    }
    const newLink = await prisma.paymentLink.create({ data: { storeId, productId: validProductId, name: name || description || 'Pagamento XPayments', amountFiat: safeAmount, currency: currency || 'EUR', description: description || '', imageUrl, urlCode: crypto.randomBytes(6).toString('hex') } });
    res.json({ success: true, data: { ...newLink, amount: Number(newLink.amountFiat), url: `https://checkout.xpayments.digital/pay/${newLink.urlCode}` } });
  } catch (error) { res.status(500).json({ success: false }); }
};

export const deleteLink = async (req: AuthRequest, res: Response) => {
  try {
    const l = await prisma.paymentLink.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!l || l.store.merchantId !== req.merchantId!) return res.status(404).json({ success: false });
    await prisma.paymentLink.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
};

// ESTA É A ÚNICA QUE FICA PÚBLICA (Qualquer pessoa pode abrir um link de pagamento)
export const getLinkByCode = async (req: Request, res: Response) => {
  try {
    const link = await prisma.paymentLink.findFirst({ where: { urlCode: req.params.urlCode, isActive: true }, include: { store: true, product: true } });
    if (!link) return res.status(404).json({ success: false, error: 'Link expirado' });
    res.json({ success: true, data: { id: link.id, storeId: link.storeId, name: link.name, amountFiat: Number(link.amountFiat), currency: link.currency, productImage: link.imageUrl || (link.product && link.product.images[0]) || null, branding: { storeName: link.store.name, logo: link.store.logoUrl, color: link.store.primaryColor || '#111111' }, successUrl: link.store.successUrl } });
  } catch (error) { res.status(500).json({ success: false }); }
};
