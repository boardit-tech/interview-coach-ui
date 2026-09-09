-- 013: finish what 007 started for the 29 legacy stories.
-- 007 linked each legacy story to its session but left the story's own STAR
-- state empty and defaulted every status to 'complete'. Copy the coaching
-- state up from the linked session, and mark partial-tier stories in_progress
-- so they read as resumable (Continue) rather than finished (Sharpen).
-- Safe on prod: only touches stories whose star_sections is still null.

update public.stories s
   set star_sections      = coalesce(s.star_sections, l.star_sections),
       extracted_question = coalesce(s.extracted_question, l.extracted_question),
       target_company     = coalesce(s.target_company, l.target_company),
       extracted_flags    = coalesce(s.extracted_flags, l.extracted_flags),
       -- green = has text; legacy sessions carried no yellow state
       star_status        = coalesce(s.star_status, jsonb_build_object(
                              'situation', case when l.star_sections->>'situation' is not null then 'green' end,
                              'task',      case when l.star_sections->>'task'      is not null then 'green' end,
                              'action',    case when l.star_sections->>'action'    is not null then 'green' end,
                              'result',    case when l.star_sections->>'result'    is not null then 'green' end)),
       status             = case when s.tier = 'partial' then 'in_progress' else s.status end
  from public.session_logs l
 where l.story_id = s.id
   and s.star_sections is null;

-- verify:
-- select status, count(*) from stories group by 1;            -- in_progress = number of partial-tier stories
-- select count(*) from stories where star_sections is null;   -- 0 for legacy rows (new empty stories may be null)
