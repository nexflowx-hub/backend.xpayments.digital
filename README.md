# XPayments V2 — Financial Infrastructure Platform

XPayments é uma infraestrutura financeira de nível Enterprise que unifica Commerce, Orchestration de Pagamentos, Tesouraria e Ativos Digitais numa única plataforma API-first.

## 🏗 Visão Geral da Plataforma (Os 4 Pilares)

1. **Commerce:** Gestão de Lojas, Produtos, Payment Links e CRM de Clientes.
2. **Payments:** Orquestração dinâmica de pagamentos B2B (Checkout) com suporte nativo a Cartões, PIX, MBWay, Bizum e Crypto.
3. **Treasury:** Contabilidade Double-Entry, gestão de saldos (Wallets) e Motor de Taxas (Fee Engine) dinâmico.
4. **Digital Assets:** Conversão FX em tempo real (via Binance Oracle) e settlement em stablecoins (USDT).

---

## 🛠 Stack Tecnológico

*   **Runtime:** Node.js (Express)
*   **Database:** PostgreSQL (Alojado via Supabase com Connection Pooling)
*   **ORM:** Prisma ORM
*   **Security:** JWT Authentication, Role-based Access Control (Merchant vs Admin)
*   **Architecture:** Modular Monolith (Strangler Fig Pattern)

---

## 📂 Estrutura de Diretórios (Modular)

A plataforma segue uma arquitetura orientada a domínios de negócio (DDD - Domain Driven Design):

```text
src/
├── core/                  # Utilitários globais e configuração
│   ├── app.ts             # Configuração do Express (Middlewares, CORS)
│   ├── prisma.ts          # Instância Singleton do PrismaClient
│   └── services/          # Serviços core (FXService, FeeService)
│
├── middleware/            # Escudos de segurança (Auth, Admin)
│
├── modules/               # Domínios isolados da aplicação
│   ├── admin/             # Gestão Global (Gateways, Stats da Plataforma)
│   ├── analytics/         # Motor de BI (LTV, Conversão, Volume)
│   ├── auth/              # Autenticação (Login, Registo)
│   ├── checkout/          # Sessões B2B e Iniciação de Pagamentos
│   ├── commerce/          # Gestão de Lojas, Produtos e Links
│   ├── customers/         # CRM (Histórico e Lifetime Value)
│   ├── developer/         # Gestão de Chaves API
│   ├── risk/              # Risk Engine (Rolling Reserves Automáticas)
│   ├── wallet/            # Dashboards financeiros e Top-ups
│   └── webhooks/          # Escuta ativa de provedores (MisticPay, Stripe)
│
└── server.ts              # Entrypoint minimalista (Bootstrap)
⚙️ Core Engines (Lógica de Negócio)
1. Double-Entry Ledger (Tesouraria)
A plataforma não atualiza saldos de forma destrutiva. Cada pagamento aprovado gera duas entradas imutáveis:

Ledger: Crédito do valor líquido a favor da carteira do Lojista.

TreasuryLedger: Registo do lucro exato retido pela XPayments (Fee Revenue e FX Spread).

2. Fee Engine & FX Oracle
Taxas Dinâmicas: As taxas não estão hardcoded. São lidas a partir de FeeProfiles alocados a cada Lojista na base de dados, permitindo Tiers customizados.

FX em Tempo Real: O módulo FXService consome a API da Binance para conversões precisas ao milissegundo (ex: EUR -> USDT), eliminando risco de flutuação cambial.

3. Risk Engine (Prevenção de Fraude)
O sistema avalia transações continuamente. Se um Lojista apresentar um padrão de volume anómalo, o motor altera automaticamente o seu Risk Score e pode impor uma retenção preventiva de fundos (Rolling Reserve) de X% durante X dias.

📡 API Reference (Endpoints Principais)
Todos os endpoints (exceto públicos) exigem autenticação via cabeçalho Authorization: Bearer <token>.

Auth & Admin
POST /api/v1/auth/login - Autenticação de Lojistas.

POST /api/v1/auth/register - Criação de conta, loja e chaves API automáticas.

GET /api/v1/admin/stats - [Restrito] Visão financeira global da XPayments.

Commerce & Customers
GET /api/v1/merchant/products - Listagem de catálogo.

POST /api/v1/merchant/links - Geração de Payment Links.

GET /api/v1/customers - CRM (LTV, total de compras, dados do cliente).

Analytics & Risk
GET /api/v1/analytics/overview - KPIs, conversão e Gross vs Net Revenue.

GET /api/v1/risk/profile - Avaliação de segurança e estado de retenção de fundos.

B2B Checkout Engine
POST /api/v1/checkout/sessions - Criação de sessão Stateless (via API Key).

POST /api/v1/checkout/initiate - Motor de roteamento para o Gateway adequado.

Webhooks & Ledger
POST /api/v1/webhooks/stripe - Escuta e transição de Ledger para AVAILABLE.

🔒 Segurança e Compliance
Isolamento de Dados: Middlewares injetam o merchantId extraído do Token diretamente no ciclo de vida do pedido. É matematicamente impossível um Lojista aceder a dados de outra entidade através de manipulação de parâmetros URL.

Idempotência: A conversão do fluxo de estado para SUCCESS bloqueia re-processamentos do mesmo ID de transação proveniente de webhooks duplicados.

XPayments Infrastructure - Confidencial & Proprietário
