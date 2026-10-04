-- 023_asset_char_ref — character references as the LTX first-frame edit source (2026-10-04).
--
-- `char-ref` passes one reference through, or composites two side by side
-- (in-process ffmpeg, endpoint_id 'lambda:char-ref'); skipped for frames with
-- no characters. Planned only on LTX projects with characters.

CREATE TABLE asset_char_ref PARTITION OF assets FOR VALUES IN ('char-ref');

-- @DOWN

DROP TABLE IF EXISTS asset_char_ref;
