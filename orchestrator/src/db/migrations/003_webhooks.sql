-- 003_webhooks — delivery idempotency (impl plan §4.3).
--
-- ~690 webhooks a step, retried by RunPod on any non-2xx. Receipt must be
-- exactly-once in effect: the receiver inserts here with ON CONFLICT DO
-- NOTHING and only applies the job transition when the insert actually took a
-- row. A duplicate delivery becomes a no-op plus a 200.

CREATE TABLE webhook_receipts (
  runpod_job_id text PRIMARY KEY,
  received_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL,
  body          jsonb NOT NULL
);

-- @DOWN

DROP TABLE IF EXISTS webhook_receipts;
