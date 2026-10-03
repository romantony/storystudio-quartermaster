-- 020_asset_animate — per-frame Ken Burns as an asset (2026-10-03).
--
-- Narration-basic (`options.motionEngine: 'animate'`) used to animate its
-- stills inside the SFN tail's ECS assemble task. That ran after Remotion
-- would have needed a clip, so basic explainers lost their on-screen text,
-- and every frame was rendered one after another. The `animate` kind invokes
-- the QM-animate Lambda once per frame during generation, in Wan2's place in
-- the chain; `assets.provider` = 'lambda' and `endpoint_id` holds the
-- 'lambda:qm-animate' sentinel, exactly as `remotion` does (015).

CREATE TABLE asset_animate PARTITION OF assets FOR VALUES IN ('animate');

-- @DOWN

DROP TABLE IF EXISTS asset_animate;
