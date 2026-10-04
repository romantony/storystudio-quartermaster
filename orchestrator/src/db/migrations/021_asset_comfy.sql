-- 021_asset_comfy — LTX-2.3 on Comfy Cloud as assets (2026-10-04).
--
-- `options.motionEngine: 'ltx'` plans `comfy-video` in Wan2's place (one
-- in-process Comfy Cloud call per frame, endpoint_id 'lambda:comfy-ltx23', like
-- `animate`/`remotion`) and `comfy-last` (the last frame of an `flf` shot, on
-- the qwen-image-edit endpoint) when any frame needs one.

CREATE TABLE asset_comfy_last PARTITION OF assets FOR VALUES IN ('comfy-last');
CREATE TABLE asset_comfy_video PARTITION OF assets FOR VALUES IN ('comfy-video');

-- @DOWN

DROP TABLE IF EXISTS asset_comfy_video;
DROP TABLE IF EXISTS asset_comfy_last;
