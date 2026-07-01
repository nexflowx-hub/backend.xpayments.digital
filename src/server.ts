import app from './core/app';

const PORT = process.env.PORT || 8084;

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 XPayments Master API`);
  console.log(`🌐 Porta: ${PORT}`);
  console.log(`🛡️  Arquitetura Enterprise (Middlewares & Services) ativa`);
  console.log(`=========================================`);
});
