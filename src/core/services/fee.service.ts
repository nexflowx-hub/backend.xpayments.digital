export class FeeService {
  static calculateInboundFee(type: 'CHECKOUT' | 'DEPOSIT', currency: string, feeProfile: any, customOverride: number | null): number {
    if (customOverride !== null && customOverride !== undefined) return customOverride;
    const ccy = currency.toUpperCase();
    if (feeProfile) {
      if (type === 'CHECKOUT') {
        if (ccy === 'EUR') return Number(feeProfile.ecommerceEur);
        if (ccy === 'BRL') return Number(feeProfile.ecommerceBrl);
        return Number(feeProfile.ecommerceCrypto);
      }
      if (type === 'DEPOSIT') {
        if (ccy === 'EUR') return Number(feeProfile.depositEur);
        if (ccy === 'BRL') return Number(feeProfile.depositBrl);
        return Number(feeProfile.depositCrypto);
      }
    }
    if (type === 'CHECKOUT') return ccy === 'EUR' ? 25 : ccy === 'BRL' ? 15 : 10;
    return ccy === 'EUR' ? 20 : ccy === 'BRL' ? 15 : 10;
  }
}
