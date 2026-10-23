-- 026_asset_seedance — Seedance 2 Mini on KIE as an asset (2026-10-23).
--
-- `options.motionEngine: 'seedance'` (Dialogue Premium) plans `seedance-video` in Wan2's place:
-- one in-process KIE call per frame (endpoint_id 'lambda:kie-seedance2mini', like `comfy-video`), whose
-- clip carries its own speech. No TTS, no lip-sync pass.

CREATE TABLE asset_seedance_video PARTITION OF assets FOR VALUES IN ('seedance-video');

-- @DOWN

DROP TABLE IF EXISTS asset_seedance_video;
