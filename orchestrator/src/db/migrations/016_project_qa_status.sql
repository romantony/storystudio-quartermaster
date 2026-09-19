-- 016_project_qa_status — a project-level QA verdict (2026-09-19).
--
-- The per-asset gate records a verdict per row (`assets.quality_status`,
-- migration 014). That answers "is this image acceptable", but the compiler
-- needs a different question answered: "is this PROJECT clear to assemble".
-- Deriving it by scanning every asset row on every tick works but leaves the
-- answer nowhere — not queryable, not in the result, not visible to an
-- operator asking why a project has not assembled. This is that answer,
-- written by the QA agent and read by the compiler.
--
--   pending   verdicts still outstanding (the default)
--   passed    every gated asset judged, none left failing
--   bypassed  nothing to judge — gating off, or no gated kinds, or a product
--             Remotion renders deterministically (explainer/educational)
--   failed    a gated asset exhausted its rework budget and is still bad
--
-- **The compiler assembles on `passed` or `bypassed` only.** `failed` is
-- terminal: the compiler finishes the project rather than waiting, because a
-- project that can never clear its gate must not sit in `generating` forever.

ALTER TABLE pipeline_projects
  ADD COLUMN qa_status text NOT NULL DEFAULT 'pending'
    CHECK (qa_status IN ('pending', 'passed', 'bypassed', 'failed')),
  -- Why, for an operator reading the table rather than the logs: which assets
  -- are still outstanding, or which one failed.
  ADD COLUMN qa_detail jsonb NOT NULL DEFAULT '{}';

-- The compiler's tick filters on it.
CREATE INDEX pipeline_projects_qa ON pipeline_projects (qa_status)
  WHERE status IN ('generating', 'assembling');

-- @DOWN

DROP INDEX IF EXISTS pipeline_projects_qa;
ALTER TABLE pipeline_projects
  DROP COLUMN IF EXISTS qa_detail,
  DROP COLUMN IF EXISTS qa_status;
