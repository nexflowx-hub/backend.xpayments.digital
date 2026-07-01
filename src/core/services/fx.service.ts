export class FXService {
  private static rates = { BRL: 0.194, EUR: 1.08, USD: 1.0, USDT: 1.0 };
  private static lastUpdate = 0;

  static async getRates() {
    if (Date.now() - this.lastUpdate < 60000) return this.rates;
    try {
      const resBrl = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL').then(r => r.json());
      const resEur = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT').then(r => r.json());
      if (resBrl && resBrl.price) this.rates.BRL = 1 / Number(resBrl.price);
      if (resEur && resEur.price) this.rates.EUR = Number(resEur.price);
      this.lastUpdate = Date.now();
    } catch (e) {}
    return this.rates;
  }
}
