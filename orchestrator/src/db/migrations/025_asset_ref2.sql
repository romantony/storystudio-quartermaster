-- 025_asset_ref2 — reference 2 of a refs2 (MiniMax H3, two characters) frame (2026-10-17).
--
-- `ref2-sheet` pads the second character's sheet onto a 16:9 canvas
-- (in-process ffmpeg, endpoint_id 'lambda:char-ref'); `ref2-edit` edits it
-- with secondReferencePrompt on qwen-image-edit. Both are skipped for every
-- frame that is not refs2, and planned only when a project has one.

CREATE TABLE asset_ref2_sheet PARTITION OF assets FOR VALUES IN ('ref2-sheet');
CREATE TABLE asset_ref2_edit PARTITION OF assets FOR VALUES IN ('ref2-edit');

-- @DOWN

DROP TABLE IF EXISTS asset_ref2_edit;
DROP TABLE IF EXISTS asset_ref2_sheet;
