-- 006: baseline for the credit audit trigger on profiles. Recorded verbatim from
-- prod on 2026-09-07. Completes the baseline started in 001 and 005.
--
-- What it does: any change to profiles.credits that did NOT come through one of
-- the credit RPCs (which set app.credit_rpc='on' for their transaction) gets a
-- 'manual_adjustment' row in credit_transactions. This is an AUDIT trigger, not
-- a guard — it records off-path changes, it does not block them. See the note in
-- the Phase 2 design about why the purchases ledger must not rely on the same
-- shape.

CREATE OR REPLACE FUNCTION public.log_manual_credit_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_delta integer := new.credits - old.credits;
begin
  if v_delta = 0 then
    return new;
  end if;

  -- An RPC in this transaction already logs its own ledger row.
  if coalesce(current_setting('app.credit_rpc', true), '') = 'on' then
    return new;
  end if;

  insert into public.credit_transactions (user_id, session_id, delta, reason, balance_after)
    values (new.id, null, v_delta, 'manual_adjustment', new.credits);

  return new;
end;
$function$;

drop trigger if exists on_profiles_credits_changed on public.profiles;
create trigger on_profiles_credits_changed
  after update of credits on public.profiles
  for each row
  when (old.credits is distinct from new.credits)
  execute function public.log_manual_credit_change();
