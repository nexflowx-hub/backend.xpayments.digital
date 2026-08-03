BEGIN;

DROP TABLE IF EXISTS
  public.payout_request_notification_outbox;

DROP TABLE IF EXISTS
  public.payout_request_events;

DROP TABLE IF EXISTS
  public.payout_request_allocations;

DROP TABLE IF EXISTS
  public.payout_requests;

COMMIT;
