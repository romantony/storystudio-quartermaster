-- 022_asset_dialogue_audio — Dialogue Basic on LTX-2.3 (2026-10-04).
--
-- `dialogue-audio` pads each dialogue line with its lead silence to the clip
-- length (in-process ffmpeg, endpoint_id 'lambda:dialogue-audio'); planned when
-- any frame carries `dialogue`.

CREATE TABLE asset_dialogue_audio PARTITION OF assets FOR VALUES IN ('dialogue-audio');

-- @DOWN

DROP TABLE IF EXISTS asset_dialogue_audio;
