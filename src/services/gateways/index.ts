import { MisticPayService } from './misticpay';
import { StripeService } from './stripe';

export class GatewayRouter {
  // Já não precisamos de passar o merchantId, porque vamos usar sempre a chave da XPayments
  static async routePayment(currency: string, txId: string, amount: number, customer: any, storeName: string) {
    if (currency === 'BRL') {
      const misticpay = new MisticPayService();
      return await misticpay.initiatePayment(txId, amount, customer, storeName);
    } else {
      const stripe = new StripeService();
      return await stripe.initiatePayment(txId, amount, currency);
    }
  }
}
