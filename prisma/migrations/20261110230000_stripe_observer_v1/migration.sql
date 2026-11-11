-- V1 observer-only ingestion: independent from XPAYMENTS financial ledger.
CREATE TABLE "observer_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_id" UUID NOT NULL,
  "store_id" UUID NOT NULL,
  "source_code" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'stripe',
  "account_id" TEXT,
  "mode" TEXT NOT NULL DEFAULT 'observer',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "observer_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "observer_sources_source_code_key" ON "observer_sources"("source_code");
CREATE INDEX "observer_sources_merchant_id_store_id_idx" ON "observer_sources"("merchant_id", "store_id");
ALTER TABLE "observer_sources" ADD CONSTRAINT "observer_sources_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "observer_sources" ADD CONSTRAINT "observer_sources_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "observer_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "object_id" TEXT,
  "object_type" TEXT,
  "object_status" TEXT,
  "currency" TEXT,
  "amount_minor" BIGINT,
  "stripe_created_at" TIMESTAMPTZ NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "observer_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "observer_events_source_id_event_id_key"
  ON "observer_events"("source_id", "event_id");
CREATE INDEX "observer_events_source_id_stripe_created_at_idx"
  ON "observer_events"("source_id", "stripe_created_at" DESC);
ALTER TABLE "observer_events" ADD CONSTRAINT "observer_events_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "observer_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "observer_payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source_id" UUID NOT NULL,
  "payment_intent_id" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "received_minor" BIGINT NOT NULL,
  "status" TEXT NOT NULL,
  "last_event_created_at" TIMESTAMPTZ NOT NULL,
  "last_event_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "observer_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "observer_payments_source_id_payment_intent_id_key"
  ON "observer_payments"("source_id", "payment_intent_id");
CREATE INDEX "observer_payments_source_id_currency_status_idx"
  ON "observer_payments"("source_id", "currency", "status");
ALTER TABLE "observer_payments" ADD CONSTRAINT "observer_payments_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "observer_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
