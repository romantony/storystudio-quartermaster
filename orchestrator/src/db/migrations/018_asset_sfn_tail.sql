-- 018_asset_sfn_tail — the assembly tail as an AWS Step Functions execution
-- (2026-10-02, docs/qm-sfn-ecs-tail-implementation-2026-10-02.md).
--
-- The project-scoped tail used to be the `postprod-lite` asset kind: one
-- RunPod call that merged, trimmed, concatenated, captioned and mixed on a
-- single pod. It is now one Step Functions execution — ECS merge/concat/
-- silence-removal, RunPod BGM-S2T word-level captions + BGM, ECS finalize
-- (upscale, caption burn, BGM overlay) — started and polled by the `sfn-tail`
-- agent. `assets.provider` already distinguishes non-RunPod kinds (013) and
-- `endpoint_id` holds a sentinel ('aws-sfn:tail'), exactly as `remotion`'s
-- Lambda does; `provider_job_id` carries the execution ARN.
--
-- The retired kinds' partitions (asset_postprod_lite, asset_merge, asset_bgm,
-- asset_dreamx_refine) are deliberately LEFT IN PLACE: they hold the history
-- of every project that ran through them, and dropping a partition drops its
-- rows. Nothing writes to them any more.

CREATE TABLE asset_sfn_tail PARTITION OF assets FOR VALUES IN ('sfn-tail');

-- @DOWN

DROP TABLE IF EXISTS asset_sfn_tail;
