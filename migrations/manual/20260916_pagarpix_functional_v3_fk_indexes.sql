CREATE INDEX IF NOT EXISTS wallet_operations_source_wallet_idx
  ON public.wallet_operations(source_treasury_wallet_id)
  WHERE source_treasury_wallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS wallet_operations_destination_wallet_idx
  ON public.wallet_operations(destination_treasury_wallet_id)
  WHERE destination_treasury_wallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS wallet_operations_payout_request_idx
  ON public.wallet_operations(payout_request_id)
  WHERE payout_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS routing_decisions_selected_connection_idx
  ON public.routing_decisions(selected_connection_id)
  WHERE selected_connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS routing_decisions_selected_gateway_vault_idx
  ON public.routing_decisions(selected_gateway_vault_id)
  WHERE selected_gateway_vault_id IS NOT NULL;
