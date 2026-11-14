-- Create the first Tourism Office role only after you have registered and verified
-- your own visitor account in Iliguide. Replace the example email before running.
do $$
declare
  v_email text := 'replace-with-your-account-email@example.com';
  v_updated integer;
begin
  update public.profiles
  set role = 'tourism_office', account_status = 'active'
  where lower(email) = lower(v_email) and role = 'visitor';

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'Expected one visitor profile for %, updated %', v_email, v_updated;
  end if;
end;
$$;
