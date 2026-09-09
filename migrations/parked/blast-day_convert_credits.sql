-- PARKED — run ONLY on "blast day", the day Yijun emails existing credit holders
-- (after resumability + Deepgram ship). NOT part of the numbered sequence.
--
-- Converts every remaining legacy credit into a story allowance: 1 credit = 1
-- story, unlimited sessions, 30 days from TODAY (the email says 30 days, and the
-- clock must start when they hear about it — not when this file was written).
-- Idempotent: a profile that already has a 'converted from' row is skipped.
--
-- After this runs, and once the 30 days have passed, 5.5 (retire credits) may go.

insert into public.purchases (user_id, kind, stories_allowed, source, note, expires_at)
select
  p.id,
  'bundle',
  p.credits,
  'manual',
  'converted from ' || p.credits || ' credit' || case when p.credits = 1 then '' else 's' end,
  now() + interval '30 days'
from public.profiles p
where p.credits > 0
  and not exists (
    select 1 from public.purchases x
     where x.user_id = p.id and x.note like 'converted from %'
  );

-- Zero the credits in the same run, or converted users would hold BOTH the new
-- allowance and the old credits (double-counting), and the "Session credits" row
-- on the plan page would linger. The audit trigger logs each as a
-- 'manual_adjustment' ledger row, which is the correct record of the conversion.
update public.profiles p
   set credits = 0
 where p.credits > 0
   and exists (select 1 from public.purchases x where x.user_id = p.id and x.note like 'converted from %');

-- verify: expect one purchase per former credit holder (18 as of the 2026-09-07
-- snapshot), and zero credits left anywhere.
-- select count(*), sum(stories_allowed) from purchases where note like 'converted from %';
-- select count(*) from profiles where credits > 0;   -- 0
