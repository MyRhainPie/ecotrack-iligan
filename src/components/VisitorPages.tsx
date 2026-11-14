import { useEffect, useState, type ChangeEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ArrowDownToLine, ArrowRight, CalendarDays, Clock3, LogOut, ShieldCheck, Ticket as TicketIcon, UserRound, Bell, BadgeCheck } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { db, dateLabel, exportCsv, loadOwnBookings, money, timeLabel, type Booking, type Profile, type Ticket } from '../lib/iliguide';

type Page = 'Bookings' | 'Tickets' | 'Account';
type Notice = { id: string; title: string; message: string; created_at: string; read_at: string | null };
type Props = {
  page: Page;
  user: User | null;
  profile: Profile | null;
  booking: Booking | null;
  ticket: Ticket | null;
  bookingReference: string;
  guestCode: string;
  setReference: (value: string) => void;
  setGuestCode: (value: string) => void;
  onLookup: (reference: string, code: string) => void;
  onTicket: (booking: Booking, code: string) => void;
  busy: boolean;
  notify: (message: string) => void;
  reloadUser: () => void;
  go: (page: 'Bookings' | 'Tickets' | 'Account') => void;
  onSignOut: () => void;
  configured: boolean;
};

export function VisitorPages(props: Props) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancellationReason, setCancellationReason] = useState('');
  const [reviewText, setReviewText] = useState('');
  const [reviewStars, setReviewStars] = useState(5);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    if (!props.user || !props.configured) { setBookings([]); return; }
    let active = true;
    setLoading(true);
    void loadOwnBookings()
      .then((rows) => { if (active) setBookings(rows); })
      .catch((error) => { if (active) props.notify(error instanceof Error ? error.message : 'Could not load bookings.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.user?.id, props.configured, props.booking?.booking_status]);

  const recover = () => props.onLookup(props.bookingReference, props.guestCode);
  const requestCancel = async () => {
    if (!props.booking) return;
    setActionBusy(true);
    try {
      const { error } = await db().rpc('request_cancellation', {
        p_booking_id: props.booking.booking_id,
        p_guest_access_token: props.guestCode || null,
        p_reason: cancellationReason.trim(),
      });
      if (error) throw error;
      props.notify('Cancellation request submitted for the destination team to review.');
      setCancellationReason('');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not submit the cancellation request.');
    } finally { setActionBusy(false); }
  };
  const submitReview = async () => {
    if (!props.booking) return;
    setActionBusy(true);
    try {
      const { error } = await db().rpc('submit_review', {
        p_booking_id: props.booking.booking_id,
        p_guest_access_token: props.guestCode || null,
        p_rating: reviewStars,
        p_comment: reviewText.trim(),
      });
      if (error) throw error;
      props.notify('Review submitted. It will appear after site moderation.');
      setReviewText('');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not submit the review.');
    } finally { setActionBusy(false); }
  };

  if (props.page === 'Account') return <AccountPage {...props}/>;
  return <section className="dashboard-page section-wrap">
    <div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> VISITOR ACCOUNT</span>
      <h1>{props.page === 'Tickets' ? <>Your <em>ticket.</em></> : <>Your plans, <em>all here.</em></>}</h1>
      <p>{props.page === 'Tickets' ? 'A ticket is available after your booking has been paid and confirmed.' : 'Find a guest booking or open reservations attached to your account.'}</p>
    </div>{props.user && <button className="btn btn-outline" onClick={() => void exportCsv('iliguide-bookings.csv', bookings as unknown as Array<Record<string, unknown>>)} disabled={!bookings.length}><ArrowDownToLine size={15}/> Export bookings</button>}</div>
    <section className="recovery-card"><div><span className="eyebrow"><span className="eyebrow-line"/> GUEST BOOKING</span><h3>Find a reservation</h3><p>Enter the reference and the private access code saved when you made the booking.</p></div>
      <div className="recovery-fields"><label>Booking reference<input value={props.bookingReference} onChange={(event) => props.setReference(event.target.value)} placeholder="ILG-…" autoCapitalize="characters"/></label>
        <label>Private access code<input value={props.guestCode} onChange={(event) => props.setGuestCode(event.target.value)} placeholder="Paste your access code" autoComplete="off"/></label>
        <button className="btn btn-primary" disabled={props.busy} onClick={recover}>{props.busy ? 'Checking…' : 'Find booking'} <ArrowRight size={15}/></button></div>
    </section>
    {props.booking && <BookingRecord booking={props.booking} token={props.guestCode} onTicket={props.onTicket} notify={props.notify}
      cancellationReason={cancellationReason} setCancellationReason={setCancellationReason}
      onCancel={requestCancel} cancelBusy={actionBusy} reviewText={reviewText} setReviewText={setReviewText}
      reviewStars={reviewStars} setReviewStars={setReviewStars} onReview={submitReview}/>}
    {props.page === 'Tickets' && props.ticket && props.booking && <TicketView booking={props.booking} ticket={props.ticket}/>}
    <div className="bookings-list-heading"><h2>Account bookings</h2><span>{loading ? 'Loading…' : bookings.length + ' records'}</span></div>
    {!props.user && <div className="empty-card"><UserRound size={30}/><h3>Sign in to see account bookings</h3><p>Guest bookings remain separate. Use the recovery form above with both values to open one.</p></div>}
    {props.user && !bookings.length && !loading && <div className="empty-card"><CalendarDays size={30}/><h3>No bookings on this account</h3><p>When you book while signed in, the current reservation will appear here.</p></div>}
    {bookings.map((item) => <article className="booking-record" key={item.booking_id}><div className="booking-record-icon"><CalendarDays size={19}/></div>
      <div className="booking-record-main"><span className="booking-reference">{item.booking_reference}</span><h3>{item.site_name}</h3>
        <p>{dateLabel(item.slot_date)} · {timeLabel(item.starts_at)} – {timeLabel(item.ends_at)} · {item.visitor_count} visitors</p>
        <small>{money(item.total_amount)} · {item.payment_status.replace('_', ' ')} · {item.booking_status.replace('_', ' ')}</small></div>
      <span className={item.payment_status === 'paid' ? 'status-tag paid' : 'status-tag'}>{item.payment_status.replace('_', ' ')}</span>
      {item.payment_status === 'paid' && ['confirmed', 'completed'].includes(item.booking_status) &&
        <button className="btn btn-outline" onClick={() => props.onTicket(item, '')}>Open ticket <TicketIcon size={15}/></button>}
    </article>)}
  </section>;
}

function BookingRecord({ booking, token, onTicket, notify, cancellationReason, setCancellationReason, onCancel, cancelBusy, reviewText, setReviewText, reviewStars, setReviewStars, onReview }: {
  booking: Booking; token: string; onTicket: (booking: Booking, token: string) => void; notify: (value: string) => void;
  cancellationReason: string; setCancellationReason: (value: string) => void; onCancel: () => void; cancelBusy: boolean;
  reviewText: string; setReviewText: (value: string) => void; reviewStars: number; setReviewStars: (value: number) => void; onReview: () => void;
}) {
  const canCancel = booking.booking_status === 'confirmed' && booking.cancellation_cutoff_at
    && new Date(booking.cancellation_cutoff_at).getTime() > Date.now();
  return <article className="booking-detail-card">
    <div className="booking-detail-head"><div><span className="eyebrow"><span className="eyebrow-line"/> BOOKING {booking.booking_reference}</span><h2>{booking.site_name}</h2>
      <p>{dateLabel(booking.slot_date)} · {timeLabel(booking.starts_at)} – {timeLabel(booking.ends_at)}</p></div>
      <span className={booking.payment_status === 'paid' ? 'status-tag paid' : 'status-tag'}>{booking.booking_status.replace('_', ' ')} · {booking.payment_status.replace('_', ' ')}</span></div>
    <div className="booking-detail-facts"><span><small>VISITORS</small><b>{booking.adult_count} adults, {booking.child_count} children</b></span>
      <span><small>TOTAL</small><b>{money(booking.total_amount)}</b></span><span><small>REFERENCE</small><b>{booking.booking_reference}</b></span></div>
    {token && <div className="access-code-panel"><ShieldCheck size={17}/><span><b>Guest access code</b><small>Save this private code with your reference for recovery on another device.</small><code>{token}</code></span><button className="link-btn" onClick={() => { void navigator.clipboard.writeText(token).then(() => notify('Access code copied.')); }}>Copy</button></div>}
    {booking.booking_status === 'awaiting_payment' && <p className="config-note"><Clock3 size={16}/> This reservation is pending payment confirmation. A redirect does not confirm payment.</p>}
    {booking.payment_status === 'paid' && ['confirmed', 'completed'].includes(booking.booking_status) &&
      <button className="btn btn-primary" onClick={() => onTicket(booking, token)}>View QR ticket <TicketIcon size={16}/></button>}
    {canCancel && <div className="inline-action"><label>Cancellation reason<input value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} maxLength={1000} placeholder="Tell the destination team why you need to cancel"/></label>
      <button className="btn btn-outline" disabled={cancelBusy || !cancellationReason.trim()} onClick={onCancel}>Request cancellation</button></div>}
    {booking.booking_status === 'completed' && <div className="inline-action review-action"><label>Share a review<textarea value={reviewText} onChange={(event) => setReviewText(event.target.value)} maxLength={3000} rows={3}/></label>
      <div><label>Rating<select value={reviewStars} onChange={(event) => setReviewStars(Number(event.target.value))}>{[5, 4, 3, 2, 1].map((number) => <option value={number} key={number}>{number} stars</option>)}</select></label>
        <button className="btn btn-outline" disabled={cancelBusy} onClick={onReview}>Submit review <BadgeCheck size={15}/></button></div></div>}
  </article>;
}

function TicketView({ booking, ticket }: { booking: Booking; ticket: Ticket }) {
  const download = () => {
    const svg = document.querySelector('.ticket-qr svg');
    if (!svg) return;
    const source = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = booking.booking_reference + '-ticket.svg';
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <article className="ticket-card ticket-card-live"><div className="ticket-left"><span className="status-tag paid">PAID · CONFIRMED</span><h2>{booking.site_name}</h2>
    <p>Show this QR ticket to the gatekeeper at your visit.</p><div className="ticket-divider"/>
    <div className="ticket-data"><span>BOOKING REFERENCE<b>{booking.booking_reference}</b></span><span>VISITOR NAME<b>{ticket.booking.visitor_name}</b></span>
      <span>VISITOR COUNT<b>{ticket.booking.visitor_count}</b></span><span>VISIT DATE<b>{dateLabel(ticket.booking.slot_date)}</b></span>
      <span>ENTRY TIME<b>{timeLabel(ticket.booking.starts_at)}</b></span><span>ADMISSION<b>{money(ticket.booking.total_amount)}</b></span></div></div>
    <div className="ticket-qr"><QRCodeSVG value={ticket.token} size={188} level="H" includeMargin aria-label="Secure Iliguide entry ticket QR code"/>
      <small>This private QR code contains an opaque signed ticket token, not visitor contact information.</small>
      <button className="btn btn-outline" onClick={download}><ArrowDownToLine size={15}/> Download ticket</button></div></article>;
}

function AccountPage(props: Props) {
  const [name, setName] = useState(props.profile?.full_name ?? '');
  const [phone, setPhone] = useState(props.profile?.phone ?? '');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(props.profile?.full_name ?? '');
    setPhone(props.profile?.phone ?? '');
  }, [props.profile?.id, props.profile?.full_name, props.profile?.phone]);
  useEffect(() => {
    if (!props.user || !props.configured) { setNotices([]); return; }
    let active = true;
    void db().from('notifications').select('id,title,message,created_at,read_at')
      .eq('user_id', props.user.id).order('created_at', { ascending: false }).limit(30)
      .then(async ({ data }) => {
        if (active) setNotices((data ?? []) as Notice[]);
        const path = props.profile?.avatar_path;
        if (path) {
          const result = await db().storage.from('visitor-avatars').createSignedUrl(path, 3600);
          if (active && result.data?.signedUrl) setAvatarUrl(result.data.signedUrl);
        }
      });
    return () => { active = false; };
  }, [props.user?.id, props.profile?.avatar_path, props.configured]);
  const save = async () => {
    if (!props.user) { props.notify('Sign in to update your account.'); return; }
    setBusy(true);
    try {
      const { error } = await db().from('profiles').update({ full_name: name.trim(), phone: phone.trim() || null }).eq('id', props.user.id);
      if (error) throw error;
      props.reloadUser();
      props.notify('Profile saved.');
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not save profile.'); }
    finally { setBusy(false); }
  };
  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !props.user) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      props.notify('Choose a JPEG, PNG, or WebP image under 2 MiB.'); return;
    }
    setBusy(true);
    try {
      const extension = file.type.split('/')[1].replace('jpeg', 'jpg');
      const path = props.user.id + '/' + crypto.randomUUID() + '.' + extension;
      const { error: uploadError } = await db().storage.from('visitor-avatars').upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) throw uploadError;
      const { error } = await db().from('profiles').update({ avatar_path: path }).eq('id', props.user.id);
      if (error) throw error;
      const result = await db().storage.from('visitor-avatars').createSignedUrl(path, 3600);
      setAvatarUrl(result.data?.signedUrl ?? '');
      props.reloadUser();
      props.notify('Profile photo updated.');
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not upload the profile photo.'); }
    finally { setBusy(false); event.target.value = ''; }
  };
  const markRead = async (notice: Notice) => {
    if (notice.read_at) return;
    const now = new Date().toISOString();
    const { error } = await db().from('notifications').update({ read_at: now }).eq('id', notice.id);
    if (error) { props.notify(error.message); return; }
    setNotices((current) => current.map((item) => item.id === notice.id ? { ...item, read_at: now } : item));
  };
  if (!props.user) return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> YOUR ACCOUNT</span><h1>A little more <em>personal.</em></h1></div></div>
    <div className="empty-card"><UserRound size={30}/><h3>Sign in to manage your profile</h3><p>Bookings made as a guest can still be recovered from the Manage a booking page.</p></div></section>;
  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> YOUR ACCOUNT</span><h1>A little more <em>personal.</em></h1><p>Update your visitor details, view notifications, and check your saved bookings.</p></div></div>
    <div className="account-settings-grid"><article className="account-settings-card"><div className="account-card account-card-wide"><div className="account-avatar">{avatarUrl ? <img src={avatarUrl} alt="Profile"/> : <UserRound size={22}/>}</div><div><h3>{props.profile?.full_name || props.user.email}</h3><p>{props.user.email} · Visitor account</p></div><button className="btn btn-outline" onClick={props.onSignOut}><LogOut size={15}/> Log out</button></div>
      <label className="avatar-upload">Profile photo <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadAvatar(event)}/><small>JPEG, PNG, WebP · up to 2 MiB</small></label>
      <label>Full name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120}/></label>
      <label>Email<input type="email" value={props.user.email ?? ''} disabled/><small>Email is managed by Supabase Auth.</small></label>
      <label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={40}/></label>
      <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save profile'} <ArrowRight size={15}/></button>
    </article>
    <article className="notifications-card"><div className="card-heading"><span><small>ACCOUNT ACTIVITY</small><h3><Bell size={17}/> Notifications</h3></span><span>{notices.filter((item) => !item.read_at).length} unread</span></div>
      {!notices.length && <div className="empty-inline">No account notifications.</div>}
      {notices.map((notice) => <button className={notice.read_at ? 'notification-row' : 'notification-row unread'} key={notice.id} onClick={() => void markRead(notice)}>
        <span><b>{notice.title}</b><small>{notice.message}</small><time>{new Date(notice.created_at).toLocaleString()}</time></span>{!notice.read_at && <i/>}</button>)}</article></div>
  </section>;
}
