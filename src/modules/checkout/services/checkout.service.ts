import crypto from 'crypto';
import prisma from '../../../core/prisma';
import { FXService } from '../../../core/services/fx.service';
import { FeeService } from '../../../core/services/fee.service';
import { GatewayRouter } from '../../../services/gateways';
import { isValidUUID } from '../../../core/utils/auth';

export class CheckoutService {
  
  static async createSession(authHeader: string | undefined, storeId: string, amountFiat: number, currency: string, orderId: string, metadata: any) {
    if (!authHeader || !authHeader.startsWith('Bearer sk_')) throw new Error('Chave Inválida');
    const apiKey = await prisma.apiKey.findFirst({ where: { secretKey: authHeader.split(' ')[1], isActive: true } });
    if (!apiKey) throw new Error('Não autorizado');

    let finalStoreId = isValidUUID(storeId) ? storeId : null;
    if (!finalStoreId) {
      const firstStore = await prisma.store.findFirst({ where: { merchantId: apiKey.merchantId } });
      if (firstStore) finalStoreId = firstStore.id;
    }
    if (!finalStoreId) throw new Error('Loja não encontrada');

    const sessionId = 'cs_' + crypto.randomBytes(16).toString('hex');
    await prisma.paymentLink.create({ 
      data: { 
        storeId: finalStoreId, name: `Order #${orderId || 'API'}`, amountFiat: Number(amountFiat) || 0, 
        currency: currency || 'EUR', description: metadata ? JSON.stringify(metadata) : `Sessão API`, urlCode: sessionId, isReusable: false 
      } 
    });
    return { id: sessionId, url: `https://checkout.xpayments.digital/pay/${sessionId}` };
  }

  static async initiateCheckout(storeId: string, amountFiat: number, currency: string, customerDetails: any, metadata: any) {
    if (!isValidUUID(storeId)) throw new Error('StoreID inválido');
    
    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { merchant: { include: { feeProfile: true } } } });
    if (!store) throw new Error('Loja não encontrada');

    const rates = await FXService.getRates();
    const exchangeRate = (rates as any)[currency.toUpperCase()] || 1.0;
    const amountUSDT = amountFiat * exchangeRate;

    const feePercent = FeeService.calculateInboundFee('CHECKOUT', currency, store.merchant.feeProfile, store.merchant.customFeePercent ? Number(store.merchant.customFeePercent) : null); 
    const feeUSDT = amountUSDT * (feePercent / 100);
    const netAmountUSDT = amountUSDT - feeUSDT;

    const safeEmail = customerDetails?.email || 'guest@xpayments.digital';
    const safeName = customerDetails?.fullName || 'Cliente Guest';
    const customer = await prisma.customer.upsert({ 
      where: { merchantId_email: { merchantId: store.merchantId, email: safeEmail } }, 
      update: { name: safeName } as any, create: { merchantId: store.merchantId, email: safeEmail, name: safeName } 
    });

    const tx = await prisma.transaction.create({
      data: { merchantId: store.merchantId, storeId: store.id, customerId: customer.id, type: 'CHECKOUT', merchantName: store.merchant.name, storeName: store.name, amountFiat, currency, exchangeRate, amountUSDT, feeUSDT, netAmountUSDT, status: 'PENDING_GATEWAY', customerEmail: safeEmail, metadata: metadata || {} }
    });

    const gatewayResponse = await GatewayRouter.routePayment(currency, tx.id, amountFiat, { fullName: safeName, email: safeEmail, taxId: null }, store.name);
    await prisma.transaction.update({ where: { id: tx.id }, data: { providerUsed: gatewayResponse.gateway, providerTxId: gatewayResponse.providerTxId } });

    return { gateway: gatewayResponse.gateway, checkoutData: { ...gatewayResponse, providerTxId: tx.id } };
  }
}
