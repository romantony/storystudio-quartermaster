-- 004_rules — the rule store (impl plan §4.4, spec §6.6).
--
-- Every quality correction is also a candidate rule. When the same
-- issue_category fires >= N times for the same scope, it is promoted: a row
-- here, injected into prompts at planning time from then on. The gate catches
-- defects; the rule store is what stops producing them.

CREATE TABLE quality_rules (
  id             bigserial PRIMARY KEY,
  scope          text NOT NULL,          -- tier | product | tier+product
  scope_key      text NOT NULL,
  gate           text NOT NULL,
  issue_category text NOT NULL,          -- e.g. PROMPT_VISUAL_MISMATCH
  rule_text      text NOT NULL,          -- injected at planning time
  fired_count    int NOT NULL DEFAULT 0,
  promoted_at    timestamptz,
  retired_at     timestamptz
);
CREATE INDEX quality_rules_active ON quality_rules (scope, scope_key, gate)
  WHERE retired_at IS NULL AND promoted_at IS NOT NULL;

-- @DOWN

DROP TABLE IF EXISTS quality_rules;
