-- Serialize slot changes for the same site/date and reject overlapping time windows.
create or replace function private.prevent_overlapping_site_slots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.site_id::text || ':' || new.slot_date::text, 0)
  );
  if exists (
    select 1
    from public.site_slots s
    where s.site_id = new.site_id
      and s.slot_date = new.slot_date
      and s.id is distinct from new.id
      and new.starts_at < s.ends_at
      and new.ends_at > s.starts_at
  ) then
    raise exception 'Visit slots for the same destination and date cannot overlap';
  end if;
  return new;
end;
$$;

create trigger prevent_overlapping_site_slots
before insert or update of site_id, slot_date, starts_at, ends_at on public.site_slots
for each row execute function private.prevent_overlapping_site_slots();

revoke all on function private.prevent_overlapping_site_slots() from public, anon, authenticated, service_role;
