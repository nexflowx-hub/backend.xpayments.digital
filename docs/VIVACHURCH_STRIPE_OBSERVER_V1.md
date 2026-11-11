# XPAYMENTS — VivaChurch / HumanImpact Stripe Observer V1

Status: code proposed for review. **Not deployed. No Stripe changes made.**

## Scope / source of truth

One merchant login: `VivaChurch@XPayments.Digital`.
Two distinct Stripe accounts, two XPAYMENTS stores:

| Store | Main currency | Other observed currency | Stripe source |
|---|---|---|---|
| VivaChurch | GBP | EUR | vivachurch |
| HumanImpact | GBP | EUR | humanimpact |

Each observed transaction remains in its native currency. **Never add GBP and EUR amounts.**
This integration is NOT a payment gateway, Stripe Connect onboarding, transfer, settlement, or fund custody.

## Required order

1. Rotate the shared live restricted API keys, existing webhook secrets and initial password using the
   account owner's Stripe Dashboard and a secret manager. Coordinate rotation of the CUSTOMER'S
   existing endpoint signing secrets with an atomic update of its app environment and deployment;
   rotating those without updating the client can interrupt payments. Previously pasted credentials
   must be treated as compromised. Do not paste them into GitHub, logs, tickets, or this repository.
2. Review PR; validate Prisma migration in staging; deploy the independent webhook receiver first.
   Confirm `/api/health` and `/api/v1/observer/stripe/:sourceCode` resolve to the correct host.
3. Set `VIVACHURCH_MERCHANT_INITIAL_PASSWORD` through the server's secret manager; run
   `npx tsx scripts/ops/bootstrap-vivachurch-observer.ts` ONCE after migration.
   The script will not reset the password of a pre-existing merchant.
4. Via the account owner's Stripe Dashboard, create **one additional webhook destination per
   account** (do not edit or delete the customer's webhook):
   - VivaChurch: `https://api.xpayments.digital/api/v1/observer/stripe/vivachurch`
   - HumanImpact: `https://api.xpayments.digital/api/v1/observer/stripe/humanimpact`
   Verify the hostname routes to the deployed service before using it. Select **live mode**
   and the supported event types defined in `allowedEvents` in observer.controller.ts.
5. Each NEW Stripe endpoint issues its OWN `whsec_` signing secret. Set these independently in
   secret manager environment variables:
   - `STRIPE_OBSERVER_VIVACHURCH_WEBHOOK_SECRET`
   - `STRIPE_OBSERVER_HUMANIMPACT_WEBHOOK_SECRET`
   Never reuse the secrets or destination belonging to the customer's application.
   Set the optional account IDs `STRIPE_OBSERVER_VIVACHURCH_ACCOUNT_ID` and
   `STRIPE_OBSERVER_HUMANIMPACT_ACCOUNT_ID` only after verifying in Stripe.
6. Deploy/restart with secrets loaded. Check Stripe delivery health for BOTH added endpoints
   and absence of impact on the customer's existing endpoints. Then rerun the idempotent
   bootstrap in the secured runtime to mark the sources active (it will not reset passwords).
7. Log in to the merchant portal and verify authenticated GET:
   - `/api/v1/observer/sources`
   - `/api/v1/observer/summary?sourceCode=vivachurch&currency=GBP`
   - `/api/v1/observer/summary?sourceCode=vivachurch&currency=EUR`
   - `/api/v1/observer/summary?sourceCode=humanimpact&currency=GBP`
   - `/api/v1/observer/summary?sourceCode=humanimpact&currency=EUR`
   - `/api/v1/observer/events?sourceCode=vivachurch`
   All read APIs require the authenticated merchant JWT.

## Webhook compatibility

Customer's existing destination remains
`https://avivachurch.vercel.app/api/stripe/webhook`, on both Stripe accounts if that
is what the account owner configured. XPAYMENTS does not forward events to this endpoint
and does not require access to its signing secrets.

Stripe requires verifying the signature against the **exact raw bytes**. The new ingestion
route runs before Express JSON parsing, uses Stripe's `constructEvent`, validates a new
endpoint-specific signing secret, and responds with 2xx for valid duplicates.

Unsupported events are acknowledged but not stored. Test-mode events are signature-verified
but deliberately not counted as live revenue. Invalid signatures are rejected.

## Security / financial isolation

- Inactive `stripe-observer` GatewayVault catalog records have secret **references**, NOT live keys.
- No outbound requests to Stripe are made by the Observer receiver.
- No payment creation/capture/refund/transfer/payout functionality is implemented.
- No writes to `transactions`, `wallets`, `wallet_movements` or settlement tables.
- Observation is event-driven and may lag Stripe delivery; use Stripe as source of truth.
- Deduplicate using source + Stripe event ID; PaymentIntent uses atomic ordering guard.
- Do not report observer totals as custodial balance, payouts, reserves, settlement or booked net.
- The V1 summary reports PaymentIntent gross volumes; refund/dispute/payout/invoice event
  timelines are observable but are NOT netted into revenue or reconciled.
- **Existing XPAYMENTS GatewayVault GET endpoints currently expose `credentials` JSON.**
  Do not store Stripe secret keys in these records until vault encryption and redaction
  are independently remediated and verified.
- The existing legacy Stripe webhook is not appropriate for external Observer events because
  it writes to financial tables and lacks signature verification.

## Acceptance criteria

- [ ] Database migration applied once with rollback/backup plan
- [ ] Merchant registered and login tested (initial password must be changed)
- [ ] 2 stores and 2 inactive catalog GatewayVault records exist
- [ ] 2 independently signed live Stripe webhook destinations added
- [ ] Existing customer destination still delivering unchanged
- [ ] Valid Stripe event recorded once even with retries
- [ ] Incorrect signature rejected
- [ ] GBP and EUR isolated by currency in reports
- [ ] Merchant A cannot read Merchant B's source/events
- [ ] Financial ledger has **zero** new observer-originated postings
- [ ] Event delivery failure is monitored; backfill/reconciliation plan added before SLA
