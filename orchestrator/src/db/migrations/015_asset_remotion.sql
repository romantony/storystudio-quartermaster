-- 015_asset_remotion — the Remotion overlay as a generator agent (2026-09-19).
--
-- Educational and explainer frames carry on-screen text rendered by the
-- existing, live-tested `QM-remotion-overlay` AWS Lambda. In the cohort model
-- that is step 16, squeezed between per-frame merge and concat. The asset
-- pipeline has no such gap — merge, trim and concat all happen inside the
-- postprod-lite one-shot — so the overlay moves EARLIER: it renders onto the
-- frame's silent clip, and the one-shot then merges narration into the
-- already-overlaid clip.
--
-- It is the first agent whose provider is not RunPod. `assets.provider` (013)
-- already carries the distinction and `endpoint_id` holds a sentinel, exactly
-- as steps/catalog.ts's seq 16 does; the in-flight ceiling then works as a
-- self-imposed Lambda concurrency limit rather than a pod count.

CREATE TABLE asset_remotion PARTITION OF assets FOR VALUES IN ('remotion');

-- @DOWN

DROP TABLE IF EXISTS asset_remotion;
