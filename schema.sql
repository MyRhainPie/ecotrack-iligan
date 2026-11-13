-- 1. destinations
create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  location text,
  description text,
  rules text,
  open_time time,
  close_time time,
  fee_adult numeric(10,2) not null default 0,
  fee_child numeric(10,2) not null default 0,
  fee_senior_pwd numeric(10,2) not null default 0,
  daily_capacity int,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. time_slots
create table public.time_slots (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.destinations(id) on delete cascade,
  slot_date date not null,
  start_time time not null,
  end_time time not null,
  capacity int not null check (capacity > 0),
  is_closed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (destination_id, slot_date, start_time)
);

-- 3. bookings
create sequence public.booking_ref_seq start 1;

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_ref text unique not null
    default ('BK-' || lpad(nextval('public.booking_ref_seq')::text, 6, '0')),
  qr_token uuid unique not null default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  destination_id uuid not null references public.destinations(id),
  slot_id uuid references public.time_slots(id),
  booking_type text not null default 'online'
    check (booking_type in ('online', 'walk_in')),
  lead_name text not null,
  phone text not null,
  email text,
  origin text,
  adults int not null default 0 check (adults >= 0),
  children int not null default 0 check (children >= 0),
  seniors_pwd int not null default 0 check (seniors_pwd >= 0),
  group_size int generated always as (adults + children + seniors_pwd) stored,
  member_names jsonb not null default '[]'::jsonb,
  total_fee numeric(10,2) not null default 0,
  status text not null default 'valid'
    check (status in ('valid','checked_in','partially_exited','completed','expired','cancel_requested','cancelled')),
  consent_given boolean not null default false,
  created_at timestamptz not null default now()
);

-- 4. attendance_logs
create table public.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  destination_id uuid not null references public.destinations(id),
  scanned_by uuid references auth.users(id) on delete set null,
  scan_type text not null check (scan_type in ('entry', 'exit')),
  headcount int not null check (headcount > 0),
  result text not null default 'accepted'
    check (result in ('accepted', 'rejected_duplicate', 'rejected_invalid')),
  method text not null default 'qr'
    check (method in ('qr', 'manual_search')),
  scanned_at timestamptz not null default now()
);

create index attendance_logs_dest_time_idx
  on public.attendance_logs (destination_id, scanned_at);
