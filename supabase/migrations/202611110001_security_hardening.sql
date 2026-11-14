-- Keep privileged RPC implementations outside the exposed PostgREST schema.
alter function public.get_slot_availability(uuid, date, date) set schema private;
alter function public.create_booking_hold(uuid, text, integer, integer, text, text) set schema private;
alter function public.confirm_free_booking(uuid, text) set schema private;
alter function public.lookup_booking(text, text) set schema private;
alter function public.set_booking_qr_hash(uuid, bytea) set schema private;
alter function public.expire_booking_holds() set schema private;
alter function public.request_cancellation(uuid, text, text) set schema private;
alter function public.review_cancellation(uuid, boolean, text) set schema private;
alter function public.submit_review(uuid, text, smallint, text) set schema private;
alter function public.register_walk_in(uuid, uuid, text, integer, integer, text, text, numeric, text) set schema private;
alter function public.scan_ticket(uuid, bytea, uuid, jsonb) set schema private;
alter function public.manual_scan_ticket(text, uuid, jsonb) set schema private;
alter function public.process_paymongo_checkout_event(text, text, text, text, bigint, text, jsonb) set schema private;

create or replace function private.user_has_site_role(p_site_id uuid, p_role public.app_role)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff_assignments a
    join public.profiles p on p.id = a.profile_id
    where a.site_id = p_site_id and a.profile_id = (select auth.uid())
      and a.staff_role = p_role and p.role = a.staff_role
      and a.is_active and p.account_status = 'active'
  )
$$;

create or replace function private.validate_staff_assignment()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.is_active and not exists (
    select 1 from public.profiles p
    where p.id = new.profile_id and p.role = new.staff_role
      and p.account_status = 'active'
  ) then
    raise exception 'Active staff assignment must match an active profile role';
  end if;
  return new;
end
$$;

create or replace function private.sync_profile_assignments()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.staff_assignments
  set is_active = (new.account_status = 'active' and new.role = staff_role)
  where profile_id = new.id
    and is_active is distinct from (new.account_status = 'active' and new.role = staff_role);
  return new;
end
$$;

create trigger validate_staff_assignment_role
before insert or update of profile_id, staff_role, is_active on public.staff_assignments
for each row execute function private.validate_staff_assignment();
create trigger sync_staff_assignments_on_profile_change
after update of role, account_status on public.profiles
for each row execute function private.sync_profile_assignments();
revoke all on function private.validate_staff_assignment() from public, anon, authenticated, service_role;
revoke all on function private.sync_profile_assignments() from public, anon, authenticated, service_role;

create function public.get_slot_availability(p_site_id uuid, p_from date, p_to date)
returns table (
  slot_id uuid, site_id uuid, slot_date date, starts_at time, ends_at time,
  capacity integer, remaining_capacity integer, status public.slot_status
)
language sql stable security invoker set search_path = ''
as $$ select * from private.get_slot_availability(p_site_id, p_from, p_to) $$;

create function public.create_booking_hold(
  p_slot_id uuid, p_name text, p_adult_count integer, p_child_count integer default 0,
  p_email text default null, p_phone text default null
)
returns table (
  booking_id uuid, booking_reference text, hold_expires_at timestamptz,
  total_amount numeric, guest_access_token text
)
language sql security invoker set search_path = ''
as $$ select * from private.create_booking_hold(p_slot_id, p_name, p_adult_count, p_child_count, p_email, p_phone) $$;

create function public.confirm_free_booking(p_booking_id uuid, p_guest_access_token text default null)
returns void language sql security invoker set search_path = ''
as $$ select private.confirm_free_booking(p_booking_id, p_guest_access_token) $$;

create function public.lookup_booking(p_booking_reference text, p_guest_access_token text default null)
returns table (
  booking_id uuid, booking_reference text, visitor_name text, visitor_count integer,
  visitor_email text, visitor_phone text, adult_count integer, child_count integer,
  total_amount numeric, currency char(3), payment_status public.payment_status,
  booking_status public.booking_status, booking_source text, site_id uuid,
  site_name text, slot_date date, starts_at time, ends_at time,
  cancellation_cutoff_at timestamptz, hold_expires_at timestamptz
)
language sql stable security invoker set search_path = ''
as $$ select * from private.lookup_booking(p_booking_reference, p_guest_access_token) $$;

create function public.set_booking_qr_hash(p_booking_id uuid, p_token_hash bytea)
returns void language sql security invoker set search_path = ''
as $$ select private.set_booking_qr_hash(p_booking_id, p_token_hash) $$;

create function public.expire_booking_holds()
returns integer language sql security invoker set search_path = ''
as $$ select private.expire_booking_holds() $$;

create function public.request_cancellation(
  p_booking_id uuid, p_guest_access_token text, p_reason text
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.request_cancellation(p_booking_id, p_guest_access_token, p_reason) $$;

create function public.review_cancellation(
  p_request_id uuid, p_approve boolean, p_note text default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.review_cancellation(p_request_id, p_approve, p_note) $$;

create function public.submit_review(
  p_booking_id uuid, p_guest_access_token text, p_rating smallint, p_comment text default ''
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.submit_review(p_booking_id, p_guest_access_token, p_rating, p_comment) $$;

create function public.register_walk_in(
  p_site_id uuid, p_slot_id uuid, p_name text, p_adult_count integer,
  p_child_count integer, p_email text, p_phone text, p_received_amount numeric,
  p_receipt_note text default null
)
returns table (booking_id uuid, booking_reference text, total_amount numeric, guest_access_token text)
language sql security invoker set search_path = ''
as $$
  select * from private.register_walk_in(
    p_site_id, p_slot_id, p_name, p_adult_count, p_child_count,
    p_email, p_phone, p_received_amount, p_receipt_note
  )
$$;

create function public.scan_ticket(
  p_booking_id uuid, p_token_hash bytea, p_site_id uuid, p_device jsonb default '{}'::jsonb
)
returns table (
  result text, booking_reference text, visitor_name text, visitor_count integer,
  entered_at timestamptz, exited_at timestamptz
)
language sql security invoker set search_path = ''
as $$ select * from private.scan_ticket(p_booking_id, p_token_hash, p_site_id, p_device) $$;

create function public.manual_scan_ticket(
  p_booking_reference text, p_site_id uuid, p_device jsonb default '{}'::jsonb
)
returns table (
  result text, booking_reference text, visitor_name text, visitor_count integer,
  entered_at timestamptz, exited_at timestamptz
)
language sql security invoker set search_path = ''
as $$ select * from private.manual_scan_ticket(p_booking_reference, p_site_id, p_device) $$;

create function public.process_paymongo_checkout_event(
  p_event_id text, p_event_type text, p_checkout_session_id text,
  p_provider_payment_id text, p_amount_minor bigint, p_currency text, p_payload jsonb
)
returns text language sql security invoker set search_path = ''
as $$
  select private.process_paymongo_checkout_event(
    p_event_id, p_event_type, p_checkout_session_id, p_provider_payment_id,
    p_amount_minor, p_currency, p_payload
  )
$$;

revoke all on function private.get_slot_availability(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function private.create_booking_hold(uuid, text, integer, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function private.confirm_free_booking(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.lookup_booking(text, text) from public, anon, authenticated, service_role;
revoke all on function private.set_booking_qr_hash(uuid, bytea) from public, anon, authenticated, service_role;
revoke all on function private.expire_booking_holds() from public, anon, authenticated, service_role;
revoke all on function private.request_cancellation(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.review_cancellation(uuid, boolean, text) from public, anon, authenticated, service_role;
revoke all on function private.submit_review(uuid, text, smallint, text) from public, anon, authenticated, service_role;
revoke all on function private.register_walk_in(uuid, uuid, text, integer, integer, text, text, numeric, text) from public, anon, authenticated, service_role;
revoke all on function private.scan_ticket(uuid, bytea, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.manual_scan_ticket(text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.process_paymongo_checkout_event(text, text, text, text, bigint, text, jsonb) from public, anon, authenticated, service_role;

grant execute on function private.get_slot_availability(uuid, date, date) to anon, authenticated;
grant execute on function private.create_booking_hold(uuid, text, integer, integer, text, text) to anon, authenticated;
grant execute on function private.confirm_free_booking(uuid, text) to anon, authenticated;
grant execute on function private.lookup_booking(text, text) to anon, authenticated;
grant execute on function private.request_cancellation(uuid, text, text) to anon, authenticated;
grant execute on function private.submit_review(uuid, text, smallint, text) to anon, authenticated;
grant execute on function private.review_cancellation(uuid, boolean, text) to authenticated;
grant execute on function private.register_walk_in(uuid, uuid, text, integer, integer, text, text, numeric, text) to authenticated;
grant execute on function private.scan_ticket(uuid, bytea, uuid, jsonb) to authenticated;
grant execute on function private.manual_scan_ticket(text, uuid, jsonb) to authenticated;
grant execute on function private.set_booking_qr_hash(uuid, bytea) to service_role;
grant execute on function private.expire_booking_holds() to service_role;
grant execute on function private.process_paymongo_checkout_event(text, text, text, text, bigint, text, jsonb) to service_role;

revoke all on function public.get_slot_availability(uuid, date, date) from public;
revoke all on function public.create_booking_hold(uuid, text, integer, integer, text, text) from public;
revoke all on function public.confirm_free_booking(uuid, text) from public;
revoke all on function public.lookup_booking(text, text) from public;
revoke all on function public.set_booking_qr_hash(uuid, bytea) from public, anon, authenticated;
revoke all on function public.expire_booking_holds() from public, anon, authenticated;
revoke all on function public.request_cancellation(uuid, text, text) from public;
revoke all on function public.review_cancellation(uuid, boolean, text) from public, anon;
revoke all on function public.submit_review(uuid, text, smallint, text) from public;
revoke all on function public.register_walk_in(uuid, uuid, text, integer, integer, text, text, numeric, text) from public, anon;
revoke all on function public.scan_ticket(uuid, bytea, uuid, jsonb) from public, anon;
revoke all on function public.manual_scan_ticket(text, uuid, jsonb) from public, anon;
revoke all on function public.process_paymongo_checkout_event(text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;

grant execute on function public.get_slot_availability(uuid, date, date) to anon, authenticated;
grant execute on function public.create_booking_hold(uuid, text, integer, integer, text, text) to anon, authenticated;
grant execute on function public.confirm_free_booking(uuid, text) to anon, authenticated;
grant execute on function public.lookup_booking(text, text) to anon, authenticated;
grant execute on function public.request_cancellation(uuid, text, text) to anon, authenticated;
grant execute on function public.submit_review(uuid, text, smallint, text) to anon, authenticated;
grant execute on function public.review_cancellation(uuid, boolean, text) to authenticated;
grant execute on function public.register_walk_in(uuid, uuid, text, integer, integer, text, text, numeric, text) to authenticated;
grant execute on function public.scan_ticket(uuid, bytea, uuid, jsonb) to authenticated;
grant execute on function public.manual_scan_ticket(text, uuid, jsonb) to authenticated;
grant execute on function public.set_booking_qr_hash(uuid, bytea) to service_role;
grant execute on function public.expire_booking_holds() to service_role;
grant execute on function public.process_paymongo_checkout_event(text, text, text, text, bigint, text, jsonb) to service_role;

-- Use one SELECT policy per table; write policies are restricted to their own actions.
drop policy sites_staff_manage on public.tourism_sites;
create policy sites_insert on public.tourism_sites for insert to authenticated
with check (private.can_manage_site(id));
create policy sites_update on public.tourism_sites for update to authenticated
using (private.can_manage_site(id)) with check (private.can_manage_site(id));
create policy sites_delete on public.tourism_sites for delete to authenticated
using (private.can_manage_site(id));

drop policy site_settings_manage on public.site_settings;
create policy site_settings_insert on public.site_settings for insert to authenticated
with check (private.can_manage_site(site_id));
create policy site_settings_update on public.site_settings for update to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));
create policy site_settings_delete on public.site_settings for delete to authenticated
using (private.can_manage_site(site_id));

drop policy site_images_manage on public.site_images;
create policy site_images_insert on public.site_images for insert to authenticated
with check (private.can_manage_site(site_id));
create policy site_images_update on public.site_images for update to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));
create policy site_images_delete on public.site_images for delete to authenticated
using (private.can_manage_site(site_id));

drop policy site_hours_manage on public.site_operating_hours;
create policy site_hours_insert on public.site_operating_hours for insert to authenticated
with check (private.can_manage_site(site_id));
create policy site_hours_update on public.site_operating_hours for update to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));
create policy site_hours_delete on public.site_operating_hours for delete to authenticated
using (private.can_manage_site(site_id));

drop policy slots_manage on public.site_slots;
create policy slots_insert on public.site_slots for insert to authenticated
with check (private.can_manage_site(site_id));
create policy slots_update on public.site_slots for update to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));
create policy slots_delete on public.site_slots for delete to authenticated
using (private.can_manage_site(site_id));

drop policy closures_manage on public.site_closures;
create policy closures_insert on public.site_closures for insert to authenticated
with check (private.can_manage_site(site_id));
create policy closures_update on public.site_closures for update to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));
create policy closures_delete on public.site_closures for delete to authenticated
using (private.can_manage_site(site_id));

drop policy staff_assignments_manage on public.staff_assignments;
create policy staff_assignments_insert on public.staff_assignments for insert to authenticated
with check (private.user_has_role('tourism_office')
  or (private.can_manage_site(site_id) and staff_role = 'gatekeeper'));
create policy staff_assignments_update on public.staff_assignments for update to authenticated
using (private.user_has_role('tourism_office')
  or (private.can_manage_site(site_id) and staff_role = 'gatekeeper'))
with check (private.user_has_role('tourism_office')
  or (private.can_manage_site(site_id) and staff_role = 'gatekeeper'));
create policy staff_assignments_delete on public.staff_assignments for delete to authenticated
using (private.user_has_role('tourism_office')
  or (private.can_manage_site(site_id) and staff_role = 'gatekeeper'));

drop policy staff_invitations_manage on public.staff_invitations;
create policy staff_invitations_insert on public.staff_invitations for insert to authenticated
with check (private.user_has_role('tourism_office')
  or (staff_role = 'gatekeeper' and site_id is not null and private.can_manage_site(site_id)));
create policy staff_invitations_update on public.staff_invitations for update to authenticated
using (private.user_has_role('tourism_office')
  or (staff_role = 'gatekeeper' and site_id is not null and private.can_manage_site(site_id)))
with check (private.user_has_role('tourism_office')
  or (staff_role = 'gatekeeper' and site_id is not null and private.can_manage_site(site_id)));
create policy staff_invitations_delete on public.staff_invitations for delete to authenticated
using (private.user_has_role('tourism_office')
  or (staff_role = 'gatekeeper' and site_id is not null and private.can_manage_site(site_id)));

create index app_settings_updated_by_idx on public.app_settings(updated_by);
create index attendance_logs_gatekeeper_idx on public.attendance_logs(gatekeeper_id);
create index attendance_logs_booking_idx on public.attendance_logs(booking_id);
create index audit_logs_actor_idx on public.audit_logs(actor_id);
create index bookings_created_by_idx on public.bookings(created_by);
create index bookings_slot_idx on public.bookings(slot_id);
create index cancellation_requests_reviewed_by_idx on public.cancellation_requests(reviewed_by);
create index cancellation_requests_visitor_idx on public.cancellation_requests(visitor_id);
create index cancellation_requests_booking_idx on public.cancellation_requests(booking_id);
create index refunds_payment_idx on public.refunds(payment_id);
create index refunds_requested_by_idx on public.refunds(requested_by);
create index reviews_moderated_by_idx on public.reviews(moderated_by);
create index reviews_visitor_idx on public.reviews(visitor_id);
create index site_closures_created_by_idx on public.site_closures(created_by);
create index site_images_created_by_idx on public.site_images(created_by);
create index site_settings_updated_by_idx on public.site_settings(updated_by);
create index site_slots_created_by_idx on public.site_slots(created_by);
create index staff_assignments_assigned_by_idx on public.staff_assignments(assigned_by);
create index staff_invitations_accepted_profile_idx on public.staff_invitations(accepted_profile_id);
create index staff_invitations_invited_by_idx on public.staff_invitations(invited_by);
create index tourism_sites_created_by_idx on public.tourism_sites(created_by);
