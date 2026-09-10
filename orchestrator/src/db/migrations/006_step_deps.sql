-- 006_step_deps — persists spec §9.3's per-step `dependsOn` (impl plan §6.2/§8.3).
--
-- 001_init reproduced the spec's schema verbatim, but the spec's own plan JSON
-- (§9.3) carries a `dependsOn` array per step that `001`'s `steps` table never
-- got a column for. The generator's dependency decrement ("completing a job
-- decrements deps_remaining on the dependents of any job reaching complete" —
-- §6.4/§8.3) needs to know, for a completed job's step, which OTHER steps
-- depend on it, scoped to the same frame. That lookup has nowhere to read from
-- without this column.

ALTER TABLE steps ADD COLUMN depends_on int[] NOT NULL DEFAULT '{}';

-- @DOWN

ALTER TABLE steps DROP COLUMN IF EXISTS depends_on;
