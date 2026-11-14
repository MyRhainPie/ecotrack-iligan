import { supabase } from './supabase';

export type Role = 'visitor' | 'gatekeeper' | 'site_admin' | 'tourism_office';
export type Profile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  avatar_path: string | null;
  role: Role;
  account_status: 'active' | 'pending' | 'disabled';
};
export type StaffAssignment = {
  id: string;
  profile_id: string;
  site_id: string;
  staff_role: 'gatekeeper' | 'site_admin';
  is_active: boolean;
};
export type SiteImage = {
  id: string;
  storage_path: string;
  image_role: 'cover' | 'gallery';
  alt_text: string;
  sort_order: number;
  public_url: string;
};
export type Site = {
  id: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  status: 'draft' | 'published' | 'inactive' | 'temporarily_closed';
  adult_fee: number;
  child_fee: number;
  max_per_booking: number;
  cancellation_cutoff_hours: number;
  images: SiteImage[];
  average_rating: number | null;
  review_count: number;
};
export type Slot = {
  slot_id: string;
  site_id: string;
  slot_date: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  remaining_capacity: number;
  status: 'open' | 'closed';
};
export type Booking = {
  booking_id: string;
  booking_reference: string;
  visitor_name: string;
  visitor_email: string | null;
  visitor_phone: string | null;
  visitor_count: number;
  adult_count: number;
  child_count: number;
  total_amount: number;
  currency: string;
  payment_status: string;
  booking_status: string;
  booking_source: string;
  site_id: string;
  site_name: string;
  slot_date: string;
  starts_at: string;
  ends_at: string;
  cancellation_cutoff_at: string | null;
  hold_expires_at: string | null;
};
export type CreatedHold = {
  booking_id: string;
  booking_reference: string;
  hold_expires_at: string;
  total_amount: number;
  guest_access_token: string | null;
};
export type Ticket = {
  token: string;
  booking: {
    booking_id: string;
    booking_reference: string;
    visitor_name: string;
    visitor_count: number;
    total_amount: number;
    currency: string;
    site_id: string;
    site_name: string;
    slot_date: string;
    starts_at: string;
    ends_at: string;
  };
};

export function db() {
  if (!supabase) throw new Error('Add the Supabase project URL and publishable key to .env.local.');
  return supabase;
}

export function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong. Please try again.';
}

export function money(value: number | string | null | undefined): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    maximumFractionDigits: 2,
  }).format(Number(value ?? 0));
}

export function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value + 'T12:00:00'));
}

export function timeLabel(value: string): string {
  const [hour, minute] = value.split(':').map(Number);
  return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' })
    .format(new Date(2000, 0, 1, hour, minute));
}

export async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await db().from('profiles')
    .select('id, full_name, email, phone, avatar_path, role, account_status')
    .eq('id', userId).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

export async function loadAssignments(userId: string): Promise<StaffAssignment[]> {
  const { data, error } = await db().from('staff_assignments')
    .select('id, profile_id, site_id, staff_role, is_active')
    .eq('profile_id', userId).eq('is_active', true).order('created_at');
  if (error) throw error;
  return (data ?? []) as StaffAssignment[];
}

export async function loadSites(includeUnpublished = false): Promise<Site[]> {
  let query = db().from('tourism_sites')
    .select(
      'id, name, slug, category, description, address, latitude, longitude, timezone, status,' +
      ' settings:site_settings(adult_fee, child_fee, max_per_booking, cancellation_cutoff_hours),' +
      ' images:site_images(id, storage_path, image_role, alt_text, sort_order)',
    )
    .order('name');
  if (!includeUnpublished) query = query.eq('status', 'published');
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, any>>;
  if (!rows.length) return [];

  const siteIds = rows.map((row) => row.id as string);
  const reviewResult = await db().from('site_review_metrics')
    .select('site_id, review_count, average_rating').in('site_id', siteIds);
  if (reviewResult.error) throw reviewResult.error;
  const reviews = new Map(
    ((reviewResult.data ?? []) as Array<Record<string, any>>).map((row) => [
      row.site_id as string,
      { average: Number(row.average_rating), count: Number(row.review_count) },
    ]),
  );

  return rows.map((row) => {
    const settings = Array.isArray(row.settings) ? row.settings[0] : row.settings;
    const review = reviews.get(row.id);
    const images = ((row.images ?? []) as Array<Record<string, any>>)
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
      .map((image) => ({
        id: image.id,
        storage_path: image.storage_path,
        image_role: image.image_role,
        alt_text: image.alt_text ?? '',
        sort_order: image.sort_order,
        public_url: db().storage.from('tourism-site-images').getPublicUrl(image.storage_path).data.publicUrl,
      }));
    return {
      ...row,
      adult_fee: Number(settings?.adult_fee ?? 0),
      child_fee: Number(settings?.child_fee ?? 0),
      max_per_booking: Number(settings?.max_per_booking ?? 20),
      cancellation_cutoff_hours: Number(settings?.cancellation_cutoff_hours ?? 24),
      images,
      average_rating: review?.average ?? null,
      review_count: review?.count ?? 0,
    } as Site;
  });
}

export async function loadSlots(siteId: string, from: string, to: string): Promise<Slot[]> {
  const { data, error } = await db().rpc('get_slot_availability', {
    p_site_id: siteId,
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  return (data ?? []) as Slot[];
}

export async function lookupBooking(reference: string, guestAccessToken?: string | null): Promise<Booking | null> {
  const { data, error } = await db().rpc('lookup_booking', {
    p_booking_reference: reference.trim(),
    p_guest_access_token: guestAccessToken ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as Booking[])[0] ?? null;
}

export async function loadOwnBookings(): Promise<Booking[]> {
  const { data, error } = await db().from('bookings')
    .select(
      'id, booking_reference, visitor_name, visitor_email, visitor_phone, visitor_count,' +
      ' adult_count, child_count, total_amount, currency, payment_status, booking_status,' +
      ' booking_source, site_id, cancellation_cutoff_at, hold_expires_at,' +
      ' tourism_sites(name), site_slots(slot_date, starts_at, ends_at)',
    )
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    booking_id: row.id,
    booking_reference: row.booking_reference,
    visitor_name: row.visitor_name,
    visitor_email: row.visitor_email,
    visitor_phone: row.visitor_phone,
    visitor_count: row.visitor_count,
    adult_count: row.adult_count,
    child_count: row.child_count,
    total_amount: Number(row.total_amount),
    currency: row.currency,
    payment_status: row.payment_status,
    booking_status: row.booking_status,
    booking_source: row.booking_source,
    site_id: row.site_id,
    site_name: row.tourism_sites?.name ?? 'Destination',
    slot_date: row.site_slots?.slot_date,
    starts_at: row.site_slots?.starts_at,
    ends_at: row.site_slots?.ends_at,
    cancellation_cutoff_at: row.cancellation_cutoff_at,
    hold_expires_at: row.hold_expires_at,
  })) as Booking[];
}

export async function createHold(input: {
  slotId: string;
  name: string;
  adults: number;
  children: number;
  email: string;
  phone: string;
}): Promise<CreatedHold> {
  const { data, error } = await db().rpc('create_booking_hold', {
    p_slot_id: input.slotId,
    p_name: input.name,
    p_adult_count: input.adults,
    p_child_count: input.children,
    p_email: input.email || null,
    p_phone: input.phone || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('The booking hold could not be created.');
  return row as CreatedHold;
}

export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().functions.invoke(name, { body });
  if (error) {
    const context = (error as Error & { context?: Response }).context;
    if (context) {
      const payload = await context.clone().json().catch(() => null);
      if (payload?.error) throw new Error(String(payload.error));
    }
    throw error;
  }
  return data as T;
}

export async function issueTicket(reference: string, guestAccessToken?: string | null): Promise<Ticket> {
  return invokeFunction<Ticket>('ticket', {
    booking_reference: reference,
    guest_access_token: guestAccessToken ?? null,
  });
}

export async function exportCsv(filename: string, rows: Array<Record<string, unknown>>): Promise<void> {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const quote = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const content = [
    keys.map(quote).join(','),
    ...rows.map((row) => keys.map((key) => quote(row[key])).join(',')),
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
