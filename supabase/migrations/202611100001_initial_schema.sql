-- Iliguide initial system schema. Safe to apply to an empty project.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create type public.app_role as enum ('visitor', 'gatekeeper', 'site_admin', 'tourism_office');
create type public.account_status as enum ('active', 'pending', 'disabled');
create type public.site_status as enum ('draft', 'published', 'inactive', 'temporarily_closed');
create type public.slot_status as enum ('open', 'closed');
create type public.booking_status as enum ('awaiting_payment', 'confirmed', 'completed', 'cancelled', 'expired', 'needs_resolution');
create type public.payment_status as enum ('pending', 'paid', 'failed', 'expired', 'refunded');
create type public.hold_status as enum ('active', 'consumed', 'released', 'expired');
create type public.cancellation_status as enum ('pending', 'approved', 'rejected');
create type public.refund_status as enum ('queued', 'processing', 'succeeded', 'failed', 'manual_required');
create type public.attendance_action as enum ('entry', 'exit');
create type public.review_status as enum ('pending', 'published', 'hidden');
create type public.staff_invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default 'Visitor' check (length(trim(full_name)) between 1 and 120),
  email text,
  phone text,
  avatar_path text,
  role public.app_role not null default 'visitor',
  account_status public.account_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_lower_uidx on public.profiles (lower(email)) where email is not null;

create table public.tourism_sites (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  category text not null default 'Other' check (length(trim(category)) between 2 and 80),
  description text not null default '',
  address text not null default '',
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  contact_information jsonb not null default '{}'::jsonb check (jsonb_typeof(contact_information) = 'object'),
  timezone text not null default 'Asia/Manila',
  status public.site_status not null default 'draft',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.site_settings (
  site_id uuid primary key references public.tourism_sites(id) on delete cascade,
  adult_fee numeric(12,2) not null default 0 check (adult_fee >= 0),
  child_fee numeric(12,2) not null default 0 check (child_fee >= 0),
  currency char(3) not null default 'PHP' check (currency = 'PHP'),
  max_per_booking integer not null default 20 check (max_per_booking between 1 and 500),
  cancellation_cutoff_hours integer not null default 24 check (cancellation_cutoff_hours between 0 and 8760),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.site_images (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.tourism_sites(id) on delete cascade,
  storage_path text not null unique,
  image_role text not null default 'gallery' check (image_role in ('cover', 'gallery')),
  alt_text text not null default '',
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index site_images_one_cover_uidx on public.site_images(site_id) where image_role = 'cover';
create index site_images_site_sort_idx on public.site_images(site_id, sort_order);

create table public.site_operating_hours (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.tourism_sites(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time,
  closes_at time,
  is_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, weekday),
  check ((is_closed and opens_at is null and closes_at is null) or
         (not is_closed and opens_at is not null and closes_at > opens_at))
);

create table public.site_slots (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.tourism_sites(id) on delete cascade,
  slot_date date not null,
  starts_at time not null,
  ends_at time not null,
  capacity integer not null check (capacity between 1 and 100000),
  status public.slot_status not null default 'open',
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (site_id, slot_date, starts_at)
);
create index site_slots_public_lookup_idx on public.site_slots(site_id, slot_date, status, starts_at);

create table public.site_closures (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.tourism_sites(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  starts_at time,
  ends_at time,
  reason text not null check (length(trim(reason)) between 2 and 500),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check ((starts_at is null and ends_at is null) or (starts_at is not null and ends_at > starts_at))
);
create index site_closures_dates_idx on public.site_closures(site_id, starts_on, ends_on);

create table public.staff_assignments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid not null references public.tourism_sites(id) on delete cascade,
  staff_role public.app_role not null check (staff_role in ('gatekeeper', 'site_admin')),
  is_active boolean not null default true,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, site_id),
  unique (profile_id, site_id, staff_role)
);
create index staff_assignments_site_role_idx on public.staff_assignments(site_id, staff_role, is_active);

create table public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null check (position('@' in email) > 1),
  staff_role public.app_role not null check (staff_role in ('gatekeeper', 'site_admin', 'tourism_office')),
  site_id uuid references public.tourism_sites(id) on delete cascade,
  status public.staff_invitation_status not null default 'pending',
  invited_by uuid not null references public.profiles(id) on delete restrict,
  accepted_profile_id uuid references public.profiles(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  check ((staff_role = 'tourism_office' and site_id is null) or
         (staff_role in ('gatekeeper', 'site_admin') and site_id is not null))
);
create unique index staff_invitation_pending_email_uidx on public.staff_invitations(lower(email)) where status = 'pending';
create index staff_invitations_site_status_idx on public.staff_invitations(site_id, status, created_at desc);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_reference text not null unique,
  visitor_id uuid references public.profiles(id) on delete set null,
  site_id uuid not null references public.tourism_sites(id) on delete restrict,
  slot_id uuid not null references public.site_slots(id) on delete restrict,
  visitor_name text not null check (length(trim(visitor_name)) between 1 and 120),
  visitor_email text,
  visitor_phone text,
  adult_count integer not null check (adult_count >= 1),
  child_count integer not null default 0 check (child_count >= 0),
  visitor_count integer generated always as (adult_count + child_count) stored,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  currency char(3) not null default 'PHP' check (currency = 'PHP'),
  payment_status public.payment_status not null default 'pending',
  booking_status public.booking_status not null default 'awaiting_payment',
  booking_source text not null default 'online' check (booking_source in ('online', 'walk_in')),
  hold_expires_at timestamptz,
  cancellation_cutoff_at timestamptz,
  qr_token_hash bytea,
  qr_issued_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visitor_email is not null or visitor_phone is not null),
  check ((booking_status = 'awaiting_payment' and hold_expires_at is not null) or
         (booking_status <> 'awaiting_payment' and hold_expires_at is null))
);
create index bookings_visitor_created_idx on public.bookings(visitor_id, created_at desc);
create index bookings_site_date_idx on public.bookings(site_id, slot_id, booking_status);
create index bookings_created_at_idx on public.bookings(created_at desc);

create table public.booking_holds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  slot_id uuid not null references public.site_slots(id) on delete cascade,
  held_capacity integer not null check (held_capacity > 0),
  expires_at timestamptz not null,
  status public.hold_status not null default 'active',
  created_at timestamptz not null default now()
);
create index booking_holds_active_slot_idx on public.booking_holds(slot_id, expires_at) where status = 'active';

create table public.booking_access_tokens (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  token_hash bytea not null,
  expires_at timestamptz not null default (now() + interval '2 years'),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  provider text not null check (provider in ('paymongo', 'cash', 'onsite', 'manual')),
  provider_reference text,
  checkout_session_id text unique,
  provider_payment_id text,
  idempotency_key text unique,
  amount numeric(12,2) not null check (amount >= 0),
  currency char(3) not null default 'PHP' check (currency = 'PHP'),
  payment_status public.payment_status not null default 'pending',
  checkout_url text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_booking_created_idx on public.payments(booking_id, created_at desc);
create index payments_provider_payment_idx on public.payments(provider, provider_payment_id) where provider_payment_id is not null;

create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  provider text not null,
  provider_event_id text,
  event_type text not null,
  amount_minor bigint,
  currency char(3),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now()
);
create unique index payment_transactions_event_uidx on public.payment_transactions(provider, provider_event_id)
  where provider_event_id is not null;
create index payment_transactions_payment_idx on public.payment_transactions(payment_id, received_at desc);

create table public.cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  site_id uuid not null references public.tourism_sites(id) on delete restrict,
  visitor_id uuid references public.profiles(id) on delete set null,
  reason text not null check (length(trim(reason)) between 2 and 1000),
  request_status public.cancellation_status not null default 'pending',
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create unique index cancellation_pending_booking_uidx on public.cancellation_requests(booking_id) where request_status = 'pending';
create index cancellation_site_status_idx on public.cancellation_requests(site_id, request_status, created_at desc);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  payment_id uuid references public.payments(id) on delete restrict,
  provider_refund_id text unique,
  amount numeric(12,2) not null check (amount >= 0),
  currency char(3) not null default 'PHP' check (currency = 'PHP'),
  refund_status public.refund_status not null default 'queued',
  reason text not null,
  requested_by uuid references public.profiles(id) on delete set null,
  processed_at timestamptz,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index refunds_booking_idx on public.refunds(booking_id, created_at desc);

create table public.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  site_id uuid not null references public.tourism_sites(id) on delete restrict,
  gatekeeper_id uuid not null references public.profiles(id) on delete restrict,
  action public.attendance_action not null,
  scanned_at timestamptz not null default now(),
  device_information jsonb not null default '{}'::jsonb check (jsonb_typeof(device_information) = 'object')
);
create unique index attendance_one_entry_uidx on public.attendance_logs(booking_id) where action = 'entry';
create unique index attendance_one_exit_uidx on public.attendance_logs(booking_id) where action = 'exit';
create index attendance_site_scanned_idx on public.attendance_logs(site_id, scanned_at desc);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete restrict,
  visitor_id uuid references public.profiles(id) on delete set null,
  site_id uuid not null references public.tourism_sites(id) on delete restrict,
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '' check (length(comment) <= 3000),
  review_status public.review_status not null default 'pending',
  moderated_by uuid references public.profiles(id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reviews_site_status_created_idx on public.reviews(site_id, review_status, created_at desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (length(title) between 1 and 160),
  message text not null check (length(message) between 1 and 2000),
  notification_type text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_created_idx on public.notifications(user_id, created_at desc);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  site_id uuid references public.tourism_sites(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_site_created_idx on public.audit_logs(site_id, created_at desc);

create table public.app_settings (
  setting_key text primary key,
  value jsonb not null default '{}'::jsonb check (jsonb_typeof(value) = 'object'),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function private.current_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid()) and p.account_status = 'active'
$$;

create or replace function private.user_has_role(p_role public.app_role)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(private.current_role() = p_role, false)
$$;

create or replace function private.user_has_site_role(p_site_id uuid, p_role public.app_role)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff_assignments a
    join public.profiles p on p.id = a.profile_id
    where a.site_id = p_site_id and a.profile_id = (select auth.uid())
      and a.staff_role = p_role and a.is_active and p.account_status = 'active'
  )
$$;

create or replace function private.can_manage_site(p_site_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.user_has_role('tourism_office')
      or private.user_has_site_role(p_site_id, 'site_admin')
$$;

create or replace function private.can_work_site(p_site_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_manage_site(p_site_id)
      or private.user_has_site_role(p_site_id, 'gatekeeper')
$$;

create or replace function private.booking_access_valid(p_booking_id uuid, p_token text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_token is not null and length(p_token) >= 32 and exists (
    select 1 from public.booking_access_tokens t
    where t.booking_id = p_booking_id and t.revoked_at is null
      and t.expires_at > now()
      and t.token_hash = extensions.digest(convert_to(p_token, 'UTF8'), 'sha256')
  )
$$;

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create or replace function private.write_audit_event(
  p_action text, p_entity_type text, p_entity_id uuid, p_site_id uuid default null
)
returns void language sql security definer set search_path = ''
as $$
  insert into public.audit_logs(actor_id, site_id, action, entity_type, entity_id)
  values ((select auth.uid()), p_site_id, p_action, p_entity_type, p_entity_id)
$$;

create or replace function private.audit_row_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb;
  v_id uuid;
  v_site_id uuid;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_id := coalesce((v_row ->> 'id')::uuid, (v_row ->> 'site_id')::uuid);
  if v_row ? 'site_id' then v_site_id := (v_row ->> 'site_id')::uuid; end if;
  if tg_table_name in ('payments', 'refunds') then
    select b.site_id into v_site_id from public.bookings b
    where b.id = (v_row ->> 'booking_id')::uuid;
  end if;
  perform private.write_audit_event(lower(tg_op), tg_table_name, v_id, v_site_id);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_invitation public.staff_invitations%rowtype;
  v_role public.app_role := 'visitor';
  v_site_id uuid;
  v_has_invitation boolean := false;
begin
  select * into v_invitation
  from public.staff_invitations i
  where lower(i.email) = lower(new.email)
    and i.status = 'pending' and i.expires_at > now()
  order by i.created_at desc
  limit 1
  for update;

  v_has_invitation := found;
  if found then
    v_role := v_invitation.staff_role;
    v_site_id := v_invitation.site_id;
  end if;

  insert into public.profiles(id, full_name, email, phone, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Visitor'),
    lower(new.email),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    v_role
  );

  if v_role in ('gatekeeper', 'site_admin') then
    insert into public.staff_assignments(profile_id, site_id, staff_role, assigned_by)
    values (new.id, v_site_id, v_role, v_invitation.invited_by);
  end if;

  if v_has_invitation then
    update public.staff_invitations
    set status = 'accepted', accepted_profile_id = new.id
    where id = v_invitation.id;
  end if;
  return new;
end
$$;
create trigger on_auth_user_created_profile
  after insert on auth.users for each row execute function private.handle_new_auth_user();

create trigger profiles_updated_at before update on public.profiles for each row execute function private.set_updated_at();
create trigger sites_updated_at before update on public.tourism_sites for each row execute function private.set_updated_at();
create trigger site_settings_updated_at before update on public.site_settings for each row execute function private.set_updated_at();
create trigger site_hours_updated_at before update on public.site_operating_hours for each row execute function private.set_updated_at();
create trigger site_slots_updated_at before update on public.site_slots for each row execute function private.set_updated_at();
create trigger staff_assignments_updated_at before update on public.staff_assignments for each row execute function private.set_updated_at();
create trigger bookings_updated_at before update on public.bookings for each row execute function private.set_updated_at();
create trigger payments_updated_at before update on public.payments for each row execute function private.set_updated_at();
create trigger refunds_updated_at before update on public.refunds for each row execute function private.set_updated_at();
create trigger reviews_updated_at before update on public.reviews for each row execute function private.set_updated_at();

create trigger audit_sites after insert or update or delete on public.tourism_sites for each row execute function private.audit_row_change();
create trigger audit_profile_privileges after update of role, account_status on public.profiles for each row execute function private.audit_row_change();
create trigger audit_site_settings after insert or update or delete on public.site_settings for each row execute function private.audit_row_change();
create trigger audit_site_slots after insert or update or delete on public.site_slots for each row execute function private.audit_row_change();
create trigger audit_site_closures after insert or update or delete on public.site_closures for each row execute function private.audit_row_change();
create trigger audit_staff_assignments after insert or update or delete on public.staff_assignments for each row execute function private.audit_row_change();
create trigger audit_bookings after insert or update or delete on public.bookings for each row execute function private.audit_row_change();
create trigger audit_payments after insert or update or delete on public.payments for each row execute function private.audit_row_change();
create trigger audit_cancellations after insert or update or delete on public.cancellation_requests for each row execute function private.audit_row_change();
create trigger audit_refunds after insert or update or delete on public.refunds for each row execute function private.audit_row_change();
create trigger audit_attendance after insert or update or delete on public.attendance_logs for each row execute function private.audit_row_change();
create trigger audit_reviews after insert or update or delete on public.reviews for each row execute function private.audit_row_change();

create or replace function public.get_slot_availability(
  p_site_id uuid, p_from date, p_to date
)
returns table (
  slot_id uuid, site_id uuid, slot_date date, starts_at time, ends_at time,
  capacity integer, remaining_capacity integer, status public.slot_status
)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.site_id, s.slot_date, s.starts_at, s.ends_at, s.capacity,
    greatest(s.capacity - coalesce(sum(b.visitor_count) filter (
      where b.booking_status = 'confirmed'
         or (b.booking_status = 'awaiting_payment' and b.hold_expires_at > now())
    ), 0)::integer, 0),
    s.status
  from public.site_slots s
  join public.tourism_sites t on t.id = s.site_id
  left join public.bookings b on b.slot_id = s.id
  where s.site_id = p_site_id
    and s.slot_date between p_from and p_to
    and p_to >= p_from and p_to <= p_from + 62
    and t.status = 'published'
  group by s.id
  order by s.slot_date, s.starts_at
$$;

create or replace function public.create_booking_hold(
  p_slot_id uuid,
  p_name text,
  p_adult_count integer,
  p_child_count integer default 0,
  p_email text default null,
  p_phone text default null
)
returns table (
  booking_id uuid, booking_reference text, hold_expires_at timestamptz,
  total_amount numeric, guest_access_token text
)
language plpgsql security definer set search_path = ''
as $$
declare
  v_slot public.site_slots%rowtype;
  v_site public.tourism_sites%rowtype;
  v_settings public.site_settings%rowtype;
  v_booked integer;
  v_total numeric(12,2);
  v_booking_id uuid := gen_random_uuid();
  v_reference text := 'ILG-' || upper(encode(extensions.gen_random_bytes(8), 'hex'));
  v_expires timestamptz := now() + interval '10 minutes';
  v_guest_token text;
begin
  if p_adult_count is null or p_adult_count < 1 or p_child_count is null or p_child_count < 0
     or p_adult_count + p_child_count > 100
     or nullif(trim(p_name), '') is null
     or (nullif(trim(p_email), '') is null and nullif(trim(p_phone), '') is null) then
    raise exception 'Enter a name, one contact method, and a valid visitor count';
  end if;
  if auth.uid() is not null and private.current_role() is distinct from 'visitor' then
    raise exception 'Only active visitor accounts can make online bookings';
  end if;

  select * into v_slot from public.site_slots s where s.id = p_slot_id for update;
  if not found or v_slot.status <> 'open' then raise exception 'This time slot is unavailable'; end if;
  select * into v_site from public.tourism_sites t
  where t.id = v_slot.site_id and t.status = 'published';
  if not found then raise exception 'This destination is not accepting reservations'; end if;
  select * into v_settings from public.site_settings ss where ss.site_id = v_site.id;
  if not found then raise exception 'This destination has not configured its booking fees'; end if;
  if p_adult_count + p_child_count > v_settings.max_per_booking then
    raise exception 'Visitor count exceeds the site booking limit';
  end if;
  if not exists (
    select 1 from public.site_operating_hours h
    where h.site_id = v_site.id
      and h.weekday = extract(dow from v_slot.slot_date)::smallint
      and not h.is_closed
      and v_slot.starts_at >= h.opens_at
      and v_slot.ends_at <= h.closes_at
  ) then
    raise exception 'This time slot is outside the published operating hours';
  end if;
  if v_slot.slot_date < (now() at time zone v_site.timezone)::date then
    raise exception 'Past dates cannot be booked';
  end if;
  if v_slot.slot_date = (now() at time zone v_site.timezone)::date
     and v_slot.ends_at <= (now() at time zone v_site.timezone)::time then
    raise exception 'This time slot has already ended';
  end if;
  if exists (
    select 1 from public.site_closures c
    where c.site_id = v_site.id and v_slot.slot_date between c.starts_on and c.ends_on
      and (c.starts_at is null or (c.starts_at < v_slot.ends_at and c.ends_at > v_slot.starts_at))
  ) then raise exception 'The destination is closed during this time'; end if;

  update public.bookings b
  set booking_status = 'expired', hold_expires_at = null
  where b.slot_id = v_slot.id and b.booking_status = 'awaiting_payment'
    and b.hold_expires_at <= now() and b.payment_status in ('pending', 'failed', 'expired');
  update public.booking_holds h
  set status = 'expired'
  where h.slot_id = v_slot.id and h.status = 'active' and h.expires_at <= now();

  select coalesce(sum(b.visitor_count), 0)::integer into v_booked
  from public.bookings b
  where b.slot_id = v_slot.id
    and (b.booking_status = 'confirmed'
      or (b.booking_status = 'awaiting_payment' and b.hold_expires_at > now()));
  if v_booked + p_adult_count + p_child_count > v_slot.capacity then
    raise exception 'Not enough spaces remain in this time slot';
  end if;

  v_total := (v_settings.adult_fee * p_adult_count) + (v_settings.child_fee * p_child_count);
  if auth.uid() is null then v_guest_token := encode(extensions.gen_random_bytes(32), 'hex'); end if;
  insert into public.bookings(
    id, booking_reference, visitor_id, site_id, slot_id, visitor_name,
    visitor_email, visitor_phone, adult_count, child_count, total_amount,
    booking_status, payment_status, hold_expires_at, cancellation_cutoff_at
  ) values (
    v_booking_id, v_reference, auth.uid(), v_site.id, v_slot.id, trim(p_name),
    nullif(lower(trim(p_email)), ''), nullif(trim(p_phone), ''), p_adult_count, p_child_count,
    v_total, 'awaiting_payment', 'pending', v_expires,
    ((v_slot.slot_date + v_slot.starts_at) at time zone v_site.timezone)
      - (v_settings.cancellation_cutoff_hours * interval '1 hour')
  );
  insert into public.booking_holds(booking_id, slot_id, held_capacity, expires_at)
  values (v_booking_id, v_slot.id, p_adult_count + p_child_count, v_expires);
  if v_guest_token is not null then
    insert into public.booking_access_tokens(booking_id, token_hash)
    values (v_booking_id, extensions.digest(convert_to(v_guest_token, 'UTF8'), 'sha256'));
  end if;
  return query select v_booking_id, v_reference, v_expires, v_total, v_guest_token;
end
$$;

create or replace function public.confirm_free_booking(
  p_booking_id uuid, p_guest_access_token text default null
)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_booking public.bookings%rowtype;
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found or not (
    v_booking.visitor_id = (select auth.uid())
    or private.booking_access_valid(v_booking.id, p_guest_access_token)
  ) then raise exception 'Booking not found or access could not be verified'; end if;
  if v_booking.total_amount <> 0 or v_booking.booking_status <> 'awaiting_payment'
     or v_booking.hold_expires_at <= now() then
    raise exception 'This booking is not eligible for free confirmation';
  end if;
  update public.bookings set payment_status = 'paid', booking_status = 'confirmed', hold_expires_at = null
  where id = v_booking.id;
  update public.booking_holds set status = 'consumed' where booking_id = v_booking.id;
  if v_booking.visitor_id is not null then
    insert into public.notifications(user_id, title, message, notification_type)
    values (v_booking.visitor_id, 'Booking confirmed',
      'Your free booking is confirmed. Your ticket is ready in Bookings.',
      'booking_confirmed');
  end if;
end
$$;

create or replace function public.expire_booking_holds()
returns integer language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  update public.bookings b
  set booking_status = 'expired', hold_expires_at = null
  where b.booking_status = 'awaiting_payment' and b.hold_expires_at <= now()
    and b.payment_status in ('pending', 'failed', 'expired');
  get diagnostics v_count = row_count;
  update public.booking_holds h
  set status = 'expired'
  where h.status = 'active' and h.expires_at <= now();
  return v_count;
end
$$;

create or replace function public.lookup_booking(
  p_booking_reference text, p_guest_access_token text default null
)
returns table (
  booking_id uuid, booking_reference text, visitor_name text, visitor_count integer,
  visitor_email text, visitor_phone text,
  adult_count integer, child_count integer, total_amount numeric, currency char(3),
  payment_status public.payment_status, booking_status public.booking_status,
  booking_source text, site_id uuid, site_name text, slot_date date, starts_at time,
  ends_at time, cancellation_cutoff_at timestamptz, hold_expires_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  return query
  select b.id, b.booking_reference, b.visitor_name, b.visitor_count,
    b.visitor_email, b.visitor_phone,
    b.adult_count, b.child_count, b.total_amount, b.currency,
    b.payment_status, b.booking_status, b.booking_source, b.site_id, s.name,
    sl.slot_date, sl.starts_at, sl.ends_at, b.cancellation_cutoff_at, b.hold_expires_at
  from public.bookings b
  join public.tourism_sites s on s.id = b.site_id
  join public.site_slots sl on sl.id = b.slot_id
  where upper(b.booking_reference) = upper(trim(p_booking_reference))
    and (
      b.visitor_id = (select auth.uid())
      or private.booking_access_valid(b.id, p_guest_access_token)
      or private.can_work_site(b.site_id)
    );
end
$$;

create or replace function public.set_booking_qr_hash(p_booking_id uuid, p_token_hash bytea)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Server authorization required';
  end if;
  if octet_length(p_token_hash) <> 32 then raise exception 'Invalid ticket token hash'; end if;
  update public.bookings
  set qr_token_hash = p_token_hash, qr_issued_at = coalesce(qr_issued_at, now())
  where id = p_booking_id and payment_status = 'paid'
    and booking_status in ('confirmed', 'completed');
  if not found then raise exception 'Paid booking not found'; end if;
end
$$;

create or replace function public.manual_scan_ticket(
  p_booking_reference text, p_site_id uuid, p_device jsonb default '{}'::jsonb
)
returns table (result text, booking_reference text, visitor_name text, visitor_count integer, entered_at timestamptz, exited_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare v_booking_id uuid; v_token_hash bytea;
begin
  if private.current_role() is distinct from 'gatekeeper'
     or not private.user_has_site_role(p_site_id, 'gatekeeper') then
    raise exception 'Gatekeeper access denied';
  end if;
  select b.id, b.qr_token_hash into v_booking_id, v_token_hash
  from public.bookings b
  where upper(b.booking_reference) = upper(trim(p_booking_reference))
    and b.site_id = p_site_id;
  if not found or v_token_hash is null then
    return query select 'invalid'::text, null::text, null::text, 0, null::timestamptz, null::timestamptz;
    return;
  end if;
  return query select * from public.scan_ticket(v_booking_id, v_token_hash, p_site_id, p_device);
end
$$;

create or replace function public.request_cancellation(
  p_booking_id uuid, p_guest_access_token text, p_reason text
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_booking public.bookings%rowtype; v_request_id uuid := gen_random_uuid();
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found or not (
    v_booking.visitor_id = (select auth.uid())
    or private.booking_access_valid(v_booking.id, p_guest_access_token)
  ) then raise exception 'Booking not found or access could not be verified'; end if;
  if v_booking.booking_status <> 'confirmed' or v_booking.cancellation_cutoff_at < now() then
    raise exception 'This booking is no longer eligible for cancellation';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A cancellation reason is required'; end if;
  insert into public.cancellation_requests(id, booking_id, site_id, visitor_id, reason)
  values (v_request_id, v_booking.id, v_booking.site_id, v_booking.visitor_id, trim(p_reason));
  return v_request_id;
end
$$;

create or replace function public.review_cancellation(
  p_request_id uuid, p_approve boolean, p_note text default null
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_request public.cancellation_requests%rowtype; v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype; v_refund_id uuid;
begin
  select * into v_request from public.cancellation_requests r where r.id = p_request_id for update;
  if not found or not private.can_manage_site(v_request.site_id) then
    raise exception 'Cancellation request not found or access denied';
  end if;
  if v_request.request_status <> 'pending' then raise exception 'Request has already been reviewed'; end if;
  select * into v_booking from public.bookings b where b.id = v_request.booking_id for update;
  update public.cancellation_requests
  set request_status = case when p_approve then 'approved'::public.cancellation_status else 'rejected'::public.cancellation_status end,
      reviewed_by = (select auth.uid()), reviewed_at = now(), decision_note = nullif(trim(p_note), '')
  where id = v_request.id;
  if not p_approve then return null; end if;
  update public.bookings set booking_status = 'cancelled' where id = v_booking.id;
  if v_booking.payment_status = 'paid' then
    select * into v_payment from public.payments p
    where p.booking_id = v_booking.id and p.payment_status = 'paid'
    order by p.verified_at desc nulls last, p.created_at desc limit 1;
    v_refund_id := gen_random_uuid();
    insert into public.refunds(id, booking_id, payment_id, amount, reason, requested_by, refund_status)
    values (v_refund_id, v_booking.id, v_payment.id, v_booking.total_amount,
      coalesce(nullif(trim(p_note), ''), 'Approved booking cancellation'),
      (select auth.uid()),
      case when v_payment.provider = 'paymongo' and v_payment.provider_payment_id is not null
        then 'queued'::public.refund_status else 'manual_required'::public.refund_status end);
  end if;
  if v_booking.visitor_id is not null then
    insert into public.notifications(user_id, title, message, notification_type)
    values (v_booking.visitor_id, 'Booking cancelled',
      'Your cancellation request was approved. Check the booking for refund status.',
      'booking_cancelled');
  end if;
  return v_refund_id;
end
$$;

create or replace function public.submit_review(
  p_booking_id uuid, p_guest_access_token text, p_rating smallint, p_comment text default ''
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_booking public.bookings%rowtype; v_review_id uuid := gen_random_uuid();
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found or not (
    v_booking.visitor_id = (select auth.uid())
    or private.booking_access_valid(v_booking.id, p_guest_access_token)
  ) then raise exception 'Booking not found or access could not be verified'; end if;
  if v_booking.booking_status <> 'completed' then raise exception 'A completed visit is required to review'; end if;
  if p_rating not between 1 and 5 or length(coalesce(p_comment, '')) > 3000 then
    raise exception 'Invalid review';
  end if;
  insert into public.reviews(id, booking_id, visitor_id, site_id, rating, comment)
  values (v_review_id, v_booking.id, v_booking.visitor_id, v_booking.site_id, p_rating, trim(coalesce(p_comment, '')));
  return v_review_id;
end
$$;

create or replace function public.register_walk_in(
  p_site_id uuid, p_slot_id uuid, p_name text, p_adult_count integer,
  p_child_count integer, p_email text, p_phone text, p_received_amount numeric,
  p_receipt_note text default null
)
returns table (booking_id uuid, booking_reference text, total_amount numeric, guest_access_token text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_slot public.site_slots%rowtype; v_site public.tourism_sites%rowtype;
  v_settings public.site_settings%rowtype; v_booked integer; v_total numeric(12,2);
  v_booking_id uuid := gen_random_uuid();
  v_reference text := 'ILG-' || upper(encode(extensions.gen_random_bytes(8), 'hex'));
  v_access_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_ticket_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if private.current_role() is distinct from 'gatekeeper'
     or not private.user_has_site_role(p_site_id, 'gatekeeper') then
    raise exception 'Gatekeeper access denied';
  end if;
  if nullif(trim(p_name), '') is null or p_adult_count < 1 or p_child_count < 0
     or (nullif(trim(p_email), '') is null and nullif(trim(p_phone), '') is null) then
    raise exception 'Enter the visitor details and a valid party size';
  end if;
  select * into v_slot from public.site_slots s
  where s.id = p_slot_id and s.site_id = p_site_id and s.status = 'open' for update;
  if not found then raise exception 'This time slot is unavailable'; end if;
  select * into v_site from public.tourism_sites t where t.id = p_site_id and t.status = 'published';
  if not found then raise exception 'This site is not accepting walk-ins'; end if;
  select * into v_settings from public.site_settings ss where ss.site_id = p_site_id;
  if not found then raise exception 'Site fees are not configured'; end if;
  if p_adult_count + p_child_count > v_settings.max_per_booking then raise exception 'Party size exceeds site limit'; end if;
  if v_slot.slot_date <> (now() at time zone v_site.timezone)::date then raise exception 'Walk-in slot must be for today'; end if;
  if (now() at time zone v_site.timezone)::time < v_slot.starts_at
     or (now() at time zone v_site.timezone)::time >= v_slot.ends_at then
    raise exception 'Walk-in registration is available only during the selected time slot';
  end if;
  if exists (
    select 1 from public.site_closures c
    where c.site_id = p_site_id and v_slot.slot_date between c.starts_on and c.ends_on
      and (c.starts_at is null or (c.starts_at < v_slot.ends_at and c.ends_at > v_slot.starts_at))
  ) then raise exception 'The site is closed during this slot'; end if;
  v_total := v_settings.adult_fee * p_adult_count + v_settings.child_fee * p_child_count;
  if coalesce(p_received_amount, -1) <> v_total then
    raise exception 'Confirm the full server-calculated amount before registering this walk-in';
  end if;
  select coalesce(sum(b.visitor_count), 0)::integer into v_booked
  from public.bookings b
  where b.slot_id = v_slot.id
    and (b.booking_status = 'confirmed'
      or (b.booking_status = 'awaiting_payment' and b.hold_expires_at > now()));
  if v_booked + p_adult_count + p_child_count > v_slot.capacity then raise exception 'No capacity remains'; end if;

  insert into public.bookings(
    id, booking_reference, site_id, slot_id, visitor_name, visitor_email, visitor_phone,
    adult_count, child_count, total_amount, payment_status, booking_status, booking_source,
    qr_token_hash, qr_issued_at, created_by
  ) values (
    v_booking_id, v_reference, p_site_id, v_slot.id, trim(p_name), nullif(lower(trim(p_email)), ''),
    nullif(trim(p_phone), ''), p_adult_count, p_child_count, v_total, 'paid', 'confirmed',
    'walk_in', extensions.digest(convert_to(v_ticket_token, 'UTF8'), 'sha256'), now(), (select auth.uid())
  );
  insert into public.payments(booking_id, provider, provider_reference, provider_payment_id, amount, payment_status, verified_at)
  values (v_booking_id, 'onsite', nullif(trim(p_receipt_note), ''),
    nullif(trim(p_receipt_note), ''), v_total, 'paid', now());
  insert into public.booking_access_tokens(booking_id, token_hash)
  values (v_booking_id, extensions.digest(convert_to(v_access_token, 'UTF8'), 'sha256'));
  if v_total = 0 then
    update public.bookings set payment_status = 'paid' where id = v_booking_id;
  end if;
  return query select v_booking_id, v_reference, v_total, v_access_token;
end
$$;

create or replace function public.scan_ticket(
  p_booking_id uuid, p_token_hash bytea, p_site_id uuid, p_device jsonb default '{}'::jsonb
)
returns table (result text, booking_reference text, visitor_name text, visitor_count integer, entered_at timestamptz, exited_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype; v_slot public.site_slots%rowtype;
  v_site public.tourism_sites%rowtype; v_entry timestamptz; v_exit timestamptz;
  v_now_local time; v_result text;
begin
  if private.current_role() is distinct from 'gatekeeper'
     or not private.user_has_site_role(p_site_id, 'gatekeeper') then
    raise exception 'Gatekeeper access denied';
  end if;
  select * into v_booking from public.bookings b
  where b.id = p_booking_id and b.site_id = p_site_id for update;
  if not found or p_token_hash is null or v_booking.qr_token_hash <> p_token_hash then
    return query select 'invalid'::text, null::text, null::text, 0, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_booking.payment_status <> 'paid' or v_booking.booking_status not in ('confirmed', 'completed') then
    return query select 'unpaid_or_inactive'::text, v_booking.booking_reference,
      v_booking.visitor_name, v_booking.visitor_count, null::timestamptz, null::timestamptz;
    return;
  end if;
  select * into v_slot from public.site_slots s where s.id = v_booking.slot_id;
  select * into v_site from public.tourism_sites t where t.id = p_site_id;
  v_now_local := (now() at time zone v_site.timezone)::time;
  if v_slot.slot_date <> (now() at time zone v_site.timezone)::date
     or v_now_local < v_slot.starts_at - interval '30 minutes'
     or v_now_local > v_slot.ends_at + interval '3 hours' then
    return query select 'outside_window'::text, v_booking.booking_reference,
      v_booking.visitor_name, v_booking.visitor_count, null::timestamptz, null::timestamptz;
    return;
  end if;
  select min(a.scanned_at) filter (where a.action = 'entry'),
         min(a.scanned_at) filter (where a.action = 'exit')
  into v_entry, v_exit from public.attendance_logs a where a.booking_id = v_booking.id;
  if v_exit is not null then
    return query select 'completed'::text, v_booking.booking_reference,
      v_booking.visitor_name, v_booking.visitor_count, v_entry, v_exit;
    return;
  end if;
  if v_entry is null then
    insert into public.attendance_logs(booking_id, site_id, gatekeeper_id, action, device_information)
    values (v_booking.id, p_site_id, (select auth.uid()), 'entry', coalesce(p_device, '{}'::jsonb));
    return query select 'entry_recorded'::text, v_booking.booking_reference,
      v_booking.visitor_name, v_booking.visitor_count, now(), null::timestamptz;
  else
    insert into public.attendance_logs(booking_id, site_id, gatekeeper_id, action, device_information)
    values (v_booking.id, p_site_id, (select auth.uid()), 'exit', coalesce(p_device, '{}'::jsonb));
    update public.bookings set booking_status = 'completed' where id = v_booking.id;
    return query select 'exit_recorded'::text, v_booking.booking_reference,
      v_booking.visitor_name, v_booking.visitor_count, v_entry, now();
  end if;
end
$$;

create or replace function public.process_paymongo_checkout_event(
  p_event_id text, p_event_type text, p_checkout_session_id text,
  p_provider_payment_id text, p_amount_minor bigint, p_currency text, p_payload jsonb
)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_payment public.payments%rowtype; v_booking public.bookings%rowtype;
  v_slot public.site_slots%rowtype; v_used integer;
begin
  if (select auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Server authorization required';
  end if;
  if nullif(p_event_id, '') is null or nullif(p_checkout_session_id, '') is null
     or p_event_type not in ('checkout_session.payment.paid', 'checkout_session.payment.failed')
     or p_currency <> 'PHP' or jsonb_typeof(coalesce(p_payload, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid payment event';
  end if;
  select * into v_payment from public.payments p
  where p.provider = 'paymongo' and p.checkout_session_id = p_checkout_session_id
  for update;
  if not found then raise exception 'Checkout session is not linked to a booking'; end if;
  if exists (
    select 1 from public.payment_transactions t
    where t.provider = 'paymongo' and t.provider_event_id = p_event_id
  ) then return 'duplicate'; end if;
  if p_amount_minor <> round(v_payment.amount * 100)::bigint then raise exception 'Payment amount mismatch'; end if;
  insert into public.payment_transactions(
    payment_id, provider, provider_event_id, event_type, amount_minor, currency, payload
  ) values (
    v_payment.id, 'paymongo', p_event_id, p_event_type, p_amount_minor, p_currency,
    jsonb_build_object('event_id', p_event_id, 'event_type', p_event_type)
  );
  select * into v_booking from public.bookings b where b.id = v_payment.booking_id for update;
  if p_event_type = 'checkout_session.payment.failed' then
    update public.payments set payment_status = 'failed' where id = v_payment.id;
    return 'failed';
  end if;
  if v_payment.payment_status = 'paid' then return 'duplicate'; end if;
  update public.payments
  set payment_status = 'paid', provider_payment_id = p_provider_payment_id, verified_at = now()
  where id = v_payment.id;
  if v_booking.booking_status = 'awaiting_payment' and v_booking.hold_expires_at > now() then
    update public.bookings set payment_status = 'paid', booking_status = 'confirmed', hold_expires_at = null
    where id = v_booking.id;
    update public.booking_holds set status = 'consumed' where booking_id = v_booking.id;
  else
    select * into v_slot from public.site_slots s where s.id = v_booking.slot_id for update;
    select coalesce(sum(b.visitor_count), 0)::integer into v_used
    from public.bookings b where b.slot_id = v_slot.id and b.id <> v_booking.id
      and (b.booking_status = 'confirmed'
        or (b.booking_status = 'awaiting_payment' and b.hold_expires_at > now()));
    if v_used + v_booking.visitor_count <= v_slot.capacity and v_booking.booking_status = 'expired' then
      update public.bookings set payment_status = 'paid', booking_status = 'confirmed', hold_expires_at = null
      where id = v_booking.id;
      update public.booking_holds set status = 'consumed' where booking_id = v_booking.id;
    else
      update public.bookings set payment_status = 'paid', booking_status = 'needs_resolution', hold_expires_at = null
      where id = v_booking.id;
      insert into public.refunds(booking_id, payment_id, amount, reason, refund_status)
      values (v_booking.id, v_payment.id, v_booking.total_amount,
        'Payment succeeded after the reservation hold expired',
        case when p_provider_payment_id is not null then 'queued'::public.refund_status else 'manual_required'::public.refund_status end);
    end if;
  end if;
  if v_booking.visitor_id is not null then
    insert into public.notifications(user_id, title, message, notification_type)
    values (v_booking.visitor_id, 'Booking confirmed',
      'Your payment is confirmed. Your ticket is ready in Bookings.',
      'booking_confirmed');
  end if;
  return 'processed';
end
$$;

create view public.booking_daily_metrics with (security_invoker = true) as
select b.site_id,
  (b.created_at at time zone 'Asia/Manila')::date as report_date,
  count(*)::bigint as booking_count,
  sum(b.visitor_count)::bigint as visitor_count,
  count(*) filter (where b.booking_source = 'walk_in')::bigint as walk_in_count,
  count(*) filter (where b.booking_source = 'online')::bigint as online_count,
  coalesce(sum(b.total_amount) filter (where b.payment_status = 'paid'), 0)::numeric(14,2) as paid_revenue
from public.bookings b
group by b.site_id, (b.created_at at time zone 'Asia/Manila')::date;

create view public.site_review_metrics with (security_invoker = true) as
select r.site_id, count(*)::bigint as review_count, round(avg(r.rating)::numeric, 2) as average_rating
from public.reviews r where r.review_status = 'published'
group by r.site_id;

alter table public.profiles enable row level security;
alter table public.tourism_sites enable row level security;
alter table public.site_settings enable row level security;
alter table public.site_images enable row level security;
alter table public.site_operating_hours enable row level security;
alter table public.site_slots enable row level security;
alter table public.site_closures enable row level security;
alter table public.staff_assignments enable row level security;
alter table public.staff_invitations enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_holds enable row level security;
alter table public.booking_access_tokens enable row level security;
alter table public.payments enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.cancellation_requests enable row level security;
alter table public.refunds enable row level security;
alter table public.attendance_logs enable row level security;
alter table public.reviews enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.app_settings enable row level security;

create policy profiles_read_own_or_staff on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or private.user_has_role('tourism_office')
  or exists (
    select 1 from public.staff_assignments a
    where a.profile_id = profiles.id and a.is_active and private.can_work_site(a.site_id)
  )
);
create policy profiles_update_own_public_fields on public.profiles for update to authenticated
using (id = (select auth.uid()) and role = 'visitor' and account_status = 'active')
with check (id = (select auth.uid()) and role = 'visitor' and account_status = 'active');

create policy sites_public_read on public.tourism_sites for select to anon, authenticated
using (status = 'published' or private.can_manage_site(id));
create policy sites_staff_manage on public.tourism_sites for all to authenticated
using (private.can_manage_site(id)) with check (private.can_manage_site(id));

create policy site_settings_public_read on public.site_settings for select to anon, authenticated
using (exists (select 1 from public.tourism_sites s where s.id = site_id and s.status = 'published')
  or private.can_manage_site(site_id));
create policy site_settings_manage on public.site_settings for all to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));

create policy site_images_public_read on public.site_images for select to anon, authenticated
using (exists (select 1 from public.tourism_sites s where s.id = site_id and s.status = 'published')
  or private.can_manage_site(site_id));
create policy site_images_manage on public.site_images for all to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));

create policy site_hours_public_read on public.site_operating_hours for select to anon, authenticated
using (exists (select 1 from public.tourism_sites s where s.id = site_id and s.status = 'published')
  or private.can_manage_site(site_id));
create policy site_hours_manage on public.site_operating_hours for all to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));

create policy slots_public_read on public.site_slots for select to anon, authenticated
using ((status = 'open' and exists (
  select 1 from public.tourism_sites s where s.id = site_id and s.status = 'published'
)) or private.can_work_site(site_id));
create policy slots_manage on public.site_slots for all to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));

create policy closures_public_read on public.site_closures for select to anon, authenticated
using (exists (select 1 from public.tourism_sites s where s.id = site_id and s.status = 'published')
  or private.can_manage_site(site_id));
create policy closures_manage on public.site_closures for all to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));

create policy staff_assignments_read on public.staff_assignments for select to authenticated
using (profile_id = (select auth.uid()) or private.user_has_role('tourism_office')
  or (private.can_manage_site(site_id) and staff_role = 'gatekeeper'));
create policy staff_assignments_manage on public.staff_assignments for all to authenticated
using (private.user_has_role('tourism_office') or (private.can_manage_site(site_id) and staff_role = 'gatekeeper'))
with check (private.user_has_role('tourism_office') or (private.can_manage_site(site_id) and staff_role = 'gatekeeper'));

create policy staff_invitations_read on public.staff_invitations for select to authenticated
using (private.user_has_role('tourism_office')
  or (staff_role = 'gatekeeper' and site_id is not null and private.can_manage_site(site_id)));
create policy staff_invitations_manage on public.staff_invitations for all to authenticated
using (private.user_has_role('tourism_office')
  or (staff_role = 'gatekeeper' and site_id is not null and private.can_manage_site(site_id)))
with check (private.user_has_role('tourism_office')
  or (staff_role = 'gatekeeper' and site_id is not null and private.can_manage_site(site_id)));

create policy bookings_read_owner_or_staff on public.bookings for select to authenticated
using (visitor_id = (select auth.uid()) or private.can_work_site(site_id));
create policy holds_read_owner_or_staff on public.booking_holds for select to authenticated
using (exists (select 1 from public.bookings b where b.id = booking_id
  and (b.visitor_id = (select auth.uid()) or private.can_work_site(b.site_id))));
create policy access_tokens_read_staff_only on public.booking_access_tokens for select to authenticated
using (exists (select 1 from public.bookings b where b.id = booking_id and private.can_manage_site(b.site_id)));

create policy payments_read_owner_or_staff on public.payments for select to authenticated
using (exists (select 1 from public.bookings b where b.id = booking_id
  and (b.visitor_id = (select auth.uid()) or private.can_work_site(b.site_id))));
create policy payment_transactions_staff_read on public.payment_transactions for select to authenticated
using (exists (select 1 from public.payments p join public.bookings b on b.id = p.booking_id
  where p.id = payment_id and private.can_manage_site(b.site_id)));

create policy cancellations_read_owner_or_staff on public.cancellation_requests for select to authenticated
using (visitor_id = (select auth.uid()) or private.can_manage_site(site_id));
create policy refunds_read_owner_or_staff on public.refunds for select to authenticated
using (exists (select 1 from public.bookings b where b.id = booking_id
  and (b.visitor_id = (select auth.uid()) or private.can_manage_site(b.site_id))));

create policy attendance_read_site_staff on public.attendance_logs for select to authenticated
using (private.can_work_site(site_id));

create policy reviews_public_read on public.reviews for select to anon, authenticated
using (review_status = 'published' or private.can_manage_site(site_id));
create policy reviews_moderate on public.reviews for update to authenticated
using (private.can_manage_site(site_id)) with check (private.can_manage_site(site_id));

create policy notifications_read_own on public.notifications for select to authenticated
using (user_id = (select auth.uid()));
create policy notifications_mark_read on public.notifications for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy audit_logs_read_staff on public.audit_logs for select to authenticated
using (private.user_has_role('tourism_office') or
  (site_id is not null and private.can_manage_site(site_id)));

create policy app_settings_office_only on public.app_settings for all to authenticated
using (private.user_has_role('tourism_office'))
with check (private.user_has_role('tourism_office'));

grant usage on schema public to anon, authenticated, service_role;
grant select on public.tourism_sites, public.site_settings, public.site_images,
  public.site_operating_hours, public.site_slots, public.site_closures, public.reviews to anon, authenticated;
grant select, insert, update, delete on public.tourism_sites, public.site_settings,
  public.site_images, public.site_operating_hours, public.site_slots, public.site_closures,
  public.staff_assignments, public.staff_invitations, public.reviews, public.app_settings to authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, phone, avatar_path) on public.profiles to authenticated;
grant select on public.bookings, public.booking_holds, public.cancellation_requests,
  public.refunds, public.attendance_logs, public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select (id, booking_id, provider, amount, currency, payment_status, verified_at, created_at)
  on public.payments to authenticated;
grant select on public.payment_transactions to authenticated;
grant select on public.audit_logs, public.booking_daily_metrics, public.site_review_metrics to authenticated;

revoke insert, update, delete on public.profiles, public.bookings, public.booking_holds,
  public.booking_access_tokens, public.payments, public.payment_transactions,
  public.cancellation_requests, public.refunds, public.attendance_logs,
  public.notifications, public.audit_logs from anon, authenticated;
revoke all on public.app_settings from anon;
revoke all on public.booking_access_tokens from anon, authenticated;
revoke all on public.payment_transactions from anon;
revoke all on public.audit_logs from anon;
grant update (full_name, phone, avatar_path) on public.profiles to authenticated;
grant update (read_at) on public.notifications to authenticated;

revoke all on function public.get_slot_availability(uuid, date, date) from public;
grant execute on function public.get_slot_availability(uuid, date, date) to anon, authenticated;
revoke all on function public.create_booking_hold(uuid, text, integer, integer, text, text) from public;
grant execute on function public.create_booking_hold(uuid, text, integer, integer, text, text) to anon, authenticated;
revoke all on function public.confirm_free_booking(uuid, text) from public;
grant execute on function public.confirm_free_booking(uuid, text) to anon, authenticated;
revoke all on function public.expire_booking_holds() from public, anon, authenticated;
grant execute on function public.expire_booking_holds() to service_role;
revoke all on function public.lookup_booking(text, text) from public;
grant execute on function public.lookup_booking(text, text) to anon, authenticated;
revoke all on function public.set_booking_qr_hash(uuid, bytea) from public, anon, authenticated;
grant execute on function public.set_booking_qr_hash(uuid, bytea) to service_role;
revoke all on function public.request_cancellation(uuid, text, text) from public;
grant execute on function public.request_cancellation(uuid, text, text) to anon, authenticated;
revoke all on function public.review_cancellation(uuid, boolean, text) from public, anon;
grant execute on function public.review_cancellation(uuid, boolean, text) to authenticated;
revoke all on function public.submit_review(uuid, text, smallint, text) from public;
grant execute on function public.submit_review(uuid, text, smallint, text) to anon, authenticated;
revoke all on function public.register_walk_in(uuid, uuid, text, integer, integer, text, text, numeric, text) from public, anon;
grant execute on function public.register_walk_in(uuid, uuid, text, integer, integer, text, text, numeric, text) to authenticated;
revoke all on function public.scan_ticket(uuid, bytea, uuid, jsonb) from public, anon;
grant execute on function public.scan_ticket(uuid, bytea, uuid, jsonb) to authenticated;
revoke all on function public.manual_scan_ticket(text, uuid, jsonb) from public, anon;
grant execute on function public.manual_scan_ticket(text, uuid, jsonb) to authenticated;
revoke all on function public.process_paymongo_checkout_event(text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.process_paymongo_checkout_event(text, text, text, text, bigint, text, jsonb) to service_role;

revoke all on function private.current_role() from public;
revoke all on function private.user_has_role(public.app_role) from public;
revoke all on function private.user_has_site_role(uuid, public.app_role) from public;
revoke all on function private.can_manage_site(uuid) from public;
revoke all on function private.can_work_site(uuid) from public;
revoke all on function private.booking_access_valid(uuid, text) from public;
grant execute on function private.current_role() to anon, authenticated, service_role;
grant execute on function private.user_has_role(public.app_role) to anon, authenticated, service_role;
grant execute on function private.user_has_site_role(uuid, public.app_role) to anon, authenticated, service_role;
grant execute on function private.can_manage_site(uuid) to anon, authenticated, service_role;
grant execute on function private.can_work_site(uuid) to anon, authenticated, service_role;
grant execute on function private.booking_access_valid(uuid, text) to anon, authenticated, service_role;
revoke all on function private.write_audit_event(text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function private.audit_row_change() from public, anon, authenticated;
revoke all on function private.handle_new_auth_user() from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('tourism-site-images', 'tourism-site-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('visitor-avatars', 'visitor-avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp']);

create policy tourism_site_images_public_read on storage.objects for select to anon, authenticated
using (bucket_id = 'tourism-site-images');
create policy tourism_site_images_manager_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'tourism-site-images'
  and cardinality(storage.foldername(name)) >= 3
  and (storage.foldername(name))[2] in ('cover', 'gallery')
  and private.can_manage_site((storage.foldername(name))[1]::uuid)
);
create policy tourism_site_images_manager_update on storage.objects for update to authenticated
using (
  bucket_id = 'tourism-site-images'
  and cardinality(storage.foldername(name)) >= 3
  and private.can_manage_site((storage.foldername(name))[1]::uuid)
)
with check (
  bucket_id = 'tourism-site-images'
  and cardinality(storage.foldername(name)) >= 3
  and (storage.foldername(name))[2] in ('cover', 'gallery')
  and private.can_manage_site((storage.foldername(name))[1]::uuid)
);
create policy tourism_site_images_manager_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'tourism-site-images'
  and cardinality(storage.foldername(name)) >= 3
  and private.can_manage_site((storage.foldername(name))[1]::uuid)
);

create policy visitor_avatar_select_own on storage.objects for select to authenticated
using (bucket_id = 'visitor-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy visitor_avatar_insert_own on storage.objects for insert to authenticated
with check (bucket_id = 'visitor-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy visitor_avatar_update_own on storage.objects for update to authenticated
using (bucket_id = 'visitor-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'visitor-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy visitor_avatar_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'visitor-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'iliguide-expire-booking-holds') then
    perform cron.schedule(
      'iliguide-expire-booking-holds',
      '* * * * *',
      'select public.expire_booking_holds();'
    );
  end if;
end
$$;
