-- 019_project_qa_flagged — a project whose QA finished with flagged assets
-- still assembles (2026-10-03).
--
-- 016's `failed` was terminal: one gated asset that exhausted its rework
-- budget stopped the whole project before assembly, even though the QA agent
-- had already accepted that asset flagged. Live on 2026-10-03 a 42-frame
-- StoryStudio project failed over one Wan2 clip the local detector called
-- frozen (the VLM tier that could have overruled it was unreachable — the
-- Replicate credit was empty), and StoryStudio got `failed` with no reason.
--
--   flagged   every gated asset judged; some were accepted flagged after
--             exhausting their rework budget. The compiler assembles, the
--             project finishes `partial`, and the flagged frames carry
--             `qualityFlagged: true` + an `errors` entry in the result.
--
-- `failed` stays in the vocabulary for rows written before this migration.

ALTER TABLE pipeline_projects DROP CONSTRAINT pipeline_projects_qa_status_check;
ALTER TABLE pipeline_projects ADD CONSTRAINT pipeline_projects_qa_status_check
  CHECK (qa_status IN ('pending', 'passed', 'bypassed', 'flagged', 'failed'));

-- @DOWN

UPDATE pipeline_projects SET qa_status = 'failed' WHERE qa_status = 'flagged';
ALTER TABLE pipeline_projects DROP CONSTRAINT pipeline_projects_qa_status_check;
ALTER TABLE pipeline_projects ADD CONSTRAINT pipeline_projects_qa_status_check
  CHECK (qa_status IN ('pending', 'passed', 'bypassed', 'failed'));
