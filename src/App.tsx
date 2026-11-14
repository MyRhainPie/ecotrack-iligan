import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BadgeCheck, CalendarDays, Check, ChevronDown, Compass, MapPin, Menu, Search, ShieldCheck, Ticket as TicketIcon, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from './lib/supabase';
import { createHold, db, invokeFunction, loadAssignments, loadProfile, loadSites, loadSlots, money, timeLabel, type Booking, type CreatedHold, type Profile, type Site, type Slot, type StaffAssignment, type Ticket as IssuedTicket } from './lib/iliguide';
import { AuthDialog, type AuthMode } from './components/AuthDialog';
const VisitorPages = lazy(() => import('./components/VisitorPages').then((module) => ({ default: module.VisitorPages })));
const StaffPages = lazy(() => import('./components/StaffPages').then((module) => ({ default: module.StaffPages })));

type Page = 'Discover' | 'Destination' | 'How it works' | 'Bookings' | 'Tickets' | 'Account' | 'Overview' | 'Scan and exit' | 'Walk-in registration' | "Today's list" | 'Slots and closures' | 'Staff and reviews' | 'Reports' | 'Sites and staff';
type StaffPage = Extract<Page, 'Overview' | 'Scan and exit' | 'Walk-in registration' | "Today's list" | 'Slots and closures' | 'Staff and reviews' | 'Reports' | 'Sites and staff'>;
type Party = { adults: number; children: number };
const todayPh = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const destinationPhoto = (slug: string) => ({ 'tinago-falls': '/tinago.jpg', 'timoga-cold-springs': '/timoga.jpg', 'mimbalot-falls': '/mimbalot.jpg', 'sikyop-agri-tourism-adventure': '/sikyop.jpg' } as Record<string, string>)[slug];
const accessKey = (reference: string) => { try { return localStorage.getItem('iliguide.access.' + reference.toUpperCase()) || ''; } catch { return ''; } };
const isStaffPage = (page: Page): page is StaffPage => ['Overview', 'Scan and exit', 'Walk-in registration', "Today's list", 'Slots and closures', 'Staff and reviews', 'Reports', 'Sites and staff'].includes(page);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [assignments, setAssignments] = useState<StaffAssignment[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [page, setPage] = useState<Page>('Discover');
  const [siteId, setSiteId] = useState('');
  const [date, setDate] = useState(todayPh());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState('');
  const [party, setParty] = useState<Party>({ adults: 1, children: 0 });
  const [visitor, setVisitor] = useState({ name: '', email: '', phone: '' });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState('');
  const [dataError, setDataError] = useState('');
  const [busy, setBusy] = useState(false);
  const [bookingReference, setBookingReference] = useState('');
  const [guestCode, setGuestCode] = useState('');
  const [activeBooking, setActiveBooking] = useState<Booking | null>(null);
  const [activeTicket, setActiveTicket] = useState<IssuedTicket | null>(null);
  const [activeGuestCode, setActiveGuestCode] = useState('');
  const [paymentMessage, setPaymentMessage] = useState('');

  const role = profile?.account_status === 'active' ? profile.role : 'visitor';
  const activeSite = sites.find((site) => site.id === siteId) ?? null;
  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 4000);
  }, []);
  const go = useCallback((next: Page) => {
    setPage(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const reloadSites = useCallback(async (nextRole: Profile['role'] = 'visitor', nextAssignments: StaffAssignment[] = []) => {
    if (!supabaseConfigured) return;
    try {
      const rows = await loadSites(nextRole !== 'visitor');
      setSites(rows);
      setDataError('');
      const permitted = nextRole === 'visitor' ? rows : rows.filter((site) =>
        nextRole === 'tourism_office' || nextAssignments.some((assignment) => assignment.site_id === site.id),
      );
      setSiteId((current) => permitted.some((site) => site.id === current) ? current : permitted[0]?.id ?? rows[0]?.id ?? '');
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Could not load destinations.');
    }
  }, []);

  const applyUser = useCallback(async (nextUser: User | null) => {
    setUser(nextUser);
    if (!nextUser) {
      setProfile(null);
      setAssignments([]);
      setVisitor({ name: '', email: '', phone: '' });
      return;
    }
    try {
      const nextProfile = await loadProfile(nextUser.id);
      setProfile(nextProfile);
      if (nextProfile?.account_status === 'active' && nextProfile.role !== 'visitor') {
        void invokeFunction<{ accepted: number }>('accept-staff-invitation', {}).catch((error) => {
          console.warn('Could not update staff invitation status', error);
        });
      }
      setVisitor({
        name: nextProfile?.full_name || String(nextUser.user_metadata?.full_name ?? ''),
        email: nextUser.email ?? '',
        phone: nextProfile?.phone ?? String(nextUser.user_metadata?.phone ?? ''),
      });
      const nextAssignments = nextProfile && nextProfile.role !== 'visitor'
        ? await loadAssignments(nextUser.id) : [];
      setAssignments(nextAssignments);
      await reloadSites(nextProfile?.account_status === 'active' ? nextProfile.role : 'visitor', nextAssignments);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'Could not load the account.');
    }
  }, [reloadSites]);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) void applyUser(data.session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (active && ['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED', 'PASSWORD_RECOVERY'].includes(event)) {
        window.setTimeout(() => { if (active) void applyUser(session?.user ?? null); }, 0);
      }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [applyUser]);

  useEffect(() => { void reloadSites(role, assignments); }, [role, assignments, reloadSites]);

  useEffect(() => {
    if (authMode === null && new URLSearchParams(window.location.search).get('mode') === 'reset') setAuthMode('reset');
  }, [authMode]);

  useEffect(() => {
    if (!supabaseConfigured) return;
    const params = new URLSearchParams(window.location.search);
    const reference = params.get('reference');
    const status = params.get('payment');
    if (!reference || !status) return;
    setBookingReference(reference);
    setGuestCode(accessKey(reference));
    setPage('Bookings');
    if (status === 'cancelled') {
      setPaymentMessage('Checkout was cancelled. The slot remains held until its expiry time.');
    } else {
      setPaymentMessage('Checking the provider confirmation. This page updates only after the signed payment webhook records it.');
      let attempts = 0;
      const poll = async () => {
        attempts += 1;
        try {
          const row = await db().rpc('lookup_booking', {
            p_booking_reference: reference,
            p_guest_access_token: accessKey(reference) || null,
          });
          const booking = (row.data ?? [])[0] as Booking | undefined;
          if (booking) setActiveBooking(booking);
          if (booking?.payment_status === 'paid' || attempts >= 20) {
            setPaymentMessage(booking?.payment_status === 'paid'
              ? 'Payment is confirmed by PayMongo. Your booking is ready.'
              : 'Payment is still awaiting provider confirmation. Refresh this page later; do not pay again while the first payment is pending.');
            return;
          }
        } catch { /* Retry while the webhook is being delivered. */ }
        window.setTimeout(() => { void poll(); }, 3000);
      };
      void poll();
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !activeSite || page !== 'Destination') { setSlots([]); return; }
    let active = true;
    void loadSlots(activeSite.id, date, date)
      .then((rows) => { if (active) setSlots(rows); })
      .catch((error) => { if (active) { setSlots([]); setDataError(error instanceof Error ? error.message : 'Could not load available times.'); } });
    return () => { active = false; };
  }, [activeSite?.id, date, page]);

  const permittedSites = useMemo(() => role === 'visitor' || role === 'tourism_office'
    ? sites
    : sites.filter((site) => assignments.some((assignment) => assignment.site_id === site.id)), [assignments, role, sites]);
  const categories = useMemo(() => ['All', ...new Set(sites.map((site) => site.category))], [sites]);
  const visibleSites = useMemo(() => permittedSites.filter((site) =>
    (category === 'All' || site.category === category) &&
    (site.name + ' ' + site.address + ' ' + site.category).toLowerCase().includes(search.toLowerCase()),
  ), [category, permittedSites, search]);
  const availableSlots = slots.filter((slot) => slot.status === 'open' && slot.remaining_capacity > 0);

  const openSite = (site: Site) => {
    setSiteId(site.id);
    setSelectedSlot('');
    setParty({ adults: 1, children: 0 });
    go('Destination');
  };

  const openBooking = async (reference: string, token = accessKey(reference)) => {
    const normalized = reference.trim().toUpperCase();
    const usableToken = token || accessKey(reference);
    if (!normalized) { notify('Enter the booking reference.'); return; }
    setBusy(true);
    try {
      const { data, error } = await db().rpc('lookup_booking', {
        p_booking_reference: normalized,
        p_guest_access_token: usableToken || null,
      });
      if (error) throw error;
      const booking = ((data ?? []) as Booking[])[0];
      if (!booking) throw new Error('Booking not found or access could not be verified.');
      setBookingReference(booking.booking_reference);
      setGuestCode(usableToken);
      setActiveGuestCode(usableToken);
      setActiveBooking(booking);
      setActiveTicket(null);
      go('Bookings');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not find that booking.');
    } finally { setBusy(false); }
  };

  const reserve = async () => {
    if (!supabaseConfigured) { notify('Add the Supabase project URL and publishable key to .env.local first.'); return; }
    if (!activeSite || !selectedSlot) { notify('Choose an available time slot first.'); return; }
    if (!visitor.name.trim() || (!visitor.email.trim() && !visitor.phone.trim())) {
      notify('Enter your name and at least one contact method.'); return;
    }
    if (party.adults < 1 || party.adults + party.children > activeSite.max_per_booking) {
      notify('Check the visitor count for this destination.'); return;
    }
    setBusy(true);
    try {
      const hold: CreatedHold = await createHold({
        slotId: selectedSlot,
        name: visitor.name.trim(),
        adults: party.adults,
        children: party.children,
        email: visitor.email.trim(),
        phone: visitor.phone.trim(),
      });
      const token = hold.guest_access_token ?? '';
      if (token) {
        setGuestCode(token);
        setActiveGuestCode(token);
        localStorage.setItem('iliguide.access.' + hold.booking_reference.toUpperCase(), token);
      }
      setBookingReference(hold.booking_reference);
      if (Number(hold.total_amount) === 0) {
        const { error } = await db().rpc('confirm_free_booking', {
          p_booking_id: hold.booking_id,
          p_guest_access_token: token || null,
        });
        if (error) throw error;
        const { data, error: lookupError } = await db().rpc('lookup_booking', {
          p_booking_reference: hold.booking_reference,
          p_guest_access_token: token || null,
        });
        if (lookupError) throw lookupError;
        setActiveBooking(((data ?? []) as Booking[])[0] ?? null);
        go('Bookings');
        notify('The database confirmed this free booking.');
      } else {
        const result = await invokeFunction<{ checkout_url: string }>('paymongo-checkout', {
          booking_reference: hold.booking_reference,
          guest_access_token: token || null,
        });
        if (!result.checkout_url) throw new Error('PayMongo did not return a checkout link.');
        window.location.assign(result.checkout_url);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create the booking hold.');
    } finally { setBusy(false); }
  };

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    setPage('Discover');
    notify('You are signed out.');
  };
  const makeTicket = async (booking: Booking, token = activeGuestCode) => {
    setBusy(true);
    try {
      const ticket = await invokeFunction<{ token: string; booking: Booking }>('ticket', {
        booking_reference: booking.booking_reference,
        guest_access_token: token || null,
      });
      setActiveTicket(ticket as unknown as IssuedTicket);
      setActiveBooking({ ...booking, ...ticket.booking });
      go('Tickets');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not issue the ticket.'); }
    finally { setBusy(false); }
  };

  const nav = role === 'visitor'
    ? [['Discover', 'Discover'], ['Destinations', 'Discover'], ['How it works', 'How it works'], ['Manage a booking', 'Bookings']] as const
    : role === 'gatekeeper'
      ? [['Workspace', 'Discover']] as const
      : [['Discover', 'Discover'], ['Workspace', 'Overview'], ['How it works', 'How it works']] as const;

  return <div className="app-shell">
    <header className="topbar">
      <Link className="brand" to="/" onClick={(event) => { event.preventDefault(); go('Discover'); }}>
        <span className="brand-mark"><img src="/iliguide-logo.svg" alt=""/></span><span>Iliguide</span>
      </Link>
      <button className="mobile-menu icon-btn" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation">{mobileNav ? <X/> : <Menu/>}</button>
      <nav className={mobileNav ? 'main-nav open' : 'main-nav'}>{nav.map(([label, target]) =>
        <button key={label} onClick={() => { if (label === 'Destinations') document.getElementById('destinations')?.scrollIntoView({ behavior: 'smooth' }); else go(target as Page); setMobileNav(false); }}>{label}</button>)}</nav>
      <div className="header-actions">{role === 'visitor'
        ? <><button className="link-btn" onClick={() => setAuthMode('login')}>Log in</button><button className="btn btn-dark btn-sm" onClick={() => setAuthMode('signup')}>Create account <ArrowRight size={15}/></button></>
        : <><span className="role-pill"><span className="status-dot"/>{role.replace('_', ' ')}</span><button className="link-btn" onClick={signOut}>Log out</button></>}
      </div>
    </header>
    {dataError && <div className="connection-banner" role="status"><ShieldCheck size={16}/><span>{dataError}</span><button onClick={() => { setDataError(''); void reloadSites(role, assignments); }}>Retry</button></div>}
    {!supabaseConfigured && <div className="connection-banner"><ShieldCheck size={16}/><span>Add Supabase URL and publishable key to connect live data.</span></div>}
    {paymentMessage && <div className="connection-banner payment-banner"><ShieldCheck size={16}/><span>{paymentMessage}</span><button onClick={() => setPaymentMessage('')}>Dismiss</button></div>}

    <main><Suspense fallback={<section className="section-wrap loading-screen">Loading workspace…</section>}>
      {page === 'Discover' && role !== 'gatekeeper' && <HomePage
        sites={visibleSites} allCount={sites.length} categories={categories} category={category}
        setCategory={setCategory} search={search} setSearch={setSearch} visitDate={date} setVisitDate={setDate} openSite={openSite}
        signedIn={Boolean(user)} onHow={() => go('How it works')}
      />}
      {page === 'Destination' && activeSite && <section className="details-page section-wrap">
        <button className="back-link" onClick={() => go('Discover')}>← All destinations</button>
        <div className="details-top"><div><span className="eyebrow"><span className="eyebrow-line"/> ILIGAN CITY · {activeSite.category.toUpperCase()}</span>
          <h1>{activeSite.name}</h1><p className="details-rating">{activeSite.average_rating === null ? 'No published reviews yet' : <><b>★ {activeSite.average_rating.toFixed(1)}</b><span>·</span>{activeSite.review_count} published reviews</>}</p>
        </div><span className="status-tag">{activeSite.status.replace('_', ' ')}</span></div>
        <div className="details-layout"><div>
          <div className="gallery">{activeSite.images.length ? activeSite.images.slice(0, 3).map((image, index) =>
            <img className={index === 0 ? 'gallery-main' : ''} key={image.id} src={image.public_url} alt={image.alt_text || activeSite.name}/>) :
            destinationPhoto(activeSite.slug) ? <img className="gallery-main" src={destinationPhoto(activeSite.slug)} alt={activeSite.name}/> :
              <div className="gallery-empty"><Compass size={32}/><span>Photos will appear here when this destination adds them.</span></div>}</div>
          <div className="detail-tabs"><button className="selected">Overview</button><button>Fees</button><button>Visitor notes</button><button>Reviews ({activeSite.review_count})</button></div>
          <div className="detail-copy"><h3>About this place</h3><p>{activeSite.description || 'The destination manager has not added a description yet.'}</p>
            <p><MapPin size={14}/> {activeSite.address || 'Location details not provided'}</p>
            <div className="fee-table"><div><b>VISITOR</b><b>ADMISSION</b><b>FEE</b></div><div><span>Adult</span><span>Standard admission</span><b>{money(activeSite.adult_fee)}</b></div><div><span>Child</span><span>Child admission</span><b>{money(activeSite.child_fee)}</b></div></div>
            <div className="review-snippet"><BadgeCheck size={18}/><span>Review scores include only published visitor reviews.</span><span>{activeSite.review_count ? activeSite.review_count + ' reviews' : 'No reviews yet'}</span></div>
          </div>
        </div><aside className="booking-card">
          <span className="eyebrow"><span className="eyebrow-line"/> LIVE AVAILABILITY</span><h3>Plan your visit</h3>
          <p className="price-intro">Starting at <b>{money(activeSite.adult_fee)}</b> / adult</p>
          <label className="field-label">Visit date<input type="date" min={todayPh()} value={date} onChange={(event) => { setDate(event.target.value); setSelectedSlot(''); }}/></label>
          <div className="slot-heading">Choose a time <small><i className="live-dot"/> Live capacity</small></div>
          <div className="slot-list">{availableSlots.map((slot) => <button key={slot.slot_id}
            className={selectedSlot === slot.slot_id ? 'slot-option selected' : 'slot-option'}
            onClick={() => setSelectedSlot(slot.slot_id)}><span>{timeLabel(slot.starts_at)} – {timeLabel(slot.ends_at)}</span>
            <small>{slot.remaining_capacity} spaces left</small></button>)}
            {!availableSlots.length && <div className="empty-inline">No available slots for this date.</div>}
          </div>
          <div className="party-count"><span><b>Visitors</b><small>Adults + children</small></span><span>
            <button className="mini-counter" aria-label="Fewer adults" onClick={() => setParty({ ...party, adults: Math.max(1, party.adults - 1) })}>−</button>
            <b>{party.adults}</b><button className="mini-counter" aria-label="More adults" onClick={() => setParty({ ...party, adults: Math.min(activeSite.max_per_booking, party.adults + 1) })}>+</button>
            <span className="counter-divider"/>
            <button className="mini-counter" aria-label="Fewer children" onClick={() => setParty({ ...party, children: Math.max(0, party.children - 1) })}>−</button>
            <b>{party.children}</b><button className="mini-counter" aria-label="More children" onClick={() => setParty({ ...party, children: Math.min(activeSite.max_per_booking - party.adults - party.children, party.children + 1) })}>+</button>
          </span></div>
          <div className="price-fields"><label>Your name<input value={visitor.name} onChange={(event) => setVisitor({ ...visitor, name: event.target.value })} maxLength={120}/></label>
            <label>Email<input type="email" value={visitor.email} onChange={(event) => setVisitor({ ...visitor, email: event.target.value })} maxLength={254}/></label>
            <label>Phone<input value={visitor.phone} onChange={(event) => setVisitor({ ...visitor, phone: event.target.value })} maxLength={40}/></label></div>
          <div className="booking-total"><span>Estimated total<small>Final amount is calculated by the booking service.</small></span><b>{money(activeSite.adult_fee * party.adults + activeSite.child_fee * party.children)}</b></div>
          <button className="btn btn-primary btn-wide" disabled={busy || !selectedSlot || !availableSlots.some((slot) => slot.slot_id === selectedSlot)} onClick={() => void reserve()}>{busy ? 'Please wait…' : 'Reserve and continue'} <ArrowRight size={16}/></button>
          <p className="secure-note"><ShieldCheck size={14}/> Your space is held for ten minutes. Payment is confirmed by PayMongo.</p>
        </aside></div>
      </section>}
      {page === 'How it works' && <HowPage/>}
      {(page === 'Bookings' || page === 'Tickets' || page === 'Account') && <VisitorPages
        page={page} user={user} profile={profile} booking={activeBooking} ticket={activeTicket} bookingReference={bookingReference}
        guestCode={guestCode} setReference={setBookingReference} setGuestCode={setGuestCode}
        onLookup={(ref, code) => void openBooking(ref, code)} onTicket={(booking, code) => void makeTicket(booking, code)}
        busy={busy} notify={notify} reloadUser={() => { if (user) void applyUser(user); }}
        go={go} onSignOut={signOut} configured={supabaseConfigured}
      />}
      {role !== 'visitor' && isStaffPage(page) &&
        <StaffPages page={page} role={role} sites={permittedSites} siteId={siteId} setSiteId={setSiteId}
          assignments={assignments} notify={notify} busy={busy} setBusy={setBusy}
          refresh={() => { void reloadSites(role, assignments); }} go={go} user={user}
        />}
      {role === 'gatekeeper' && page === 'Discover' && <StaffPages page="Overview" role={role} sites={permittedSites}
        siteId={siteId} setSiteId={setSiteId} assignments={assignments} notify={notify} busy={busy}
        setBusy={setBusy} refresh={() => { void reloadSites(role, assignments); }} go={go} user={user}/>}
      {role !== 'visitor' && role !== 'gatekeeper' && page === 'Discover' && <StaffPages page="Overview" role={role} sites={permittedSites}
        siteId={siteId} setSiteId={setSiteId} assignments={assignments} notify={notify} busy={busy}
        setBusy={setBusy} refresh={() => { void reloadSites(role, assignments); }} go={go} user={user} compact/>}
      {page === 'Discover' && role === 'visitor' && <VisitorShortcuts go={go} signedIn={Boolean(user)}/>}
    </Suspense></main>
    {role !== 'visitor' && <MobileTabs role={role} page={page} go={go}/>}
    {role === 'visitor' && <MobileTabs role={role} page={page} go={go}/>}
    <footer className="footer"><div className="section-wrap footer-inner">{role === 'gatekeeper' ? <div className="footer-bottom"><span>© {new Date().getFullYear()} Iliguide · Iligan City</span></div> : <><div className="footer-brand"><span>Iliguide</span></div>
      <div className="footer-col"><b>Explore</b><button onClick={() => go('Discover')}>Destinations</button><button onClick={() => go('How it works')}>How it works</button><button onClick={() => go('Bookings')}>Manage a booking</button></div>
      <div className="footer-col"><b>Your account</b><button onClick={() => setAuthMode('login')}>Log in</button><button onClick={() => setAuthMode('signup')}>Create account</button><span>Private visitor details</span></div>
      <div className="footer-col"><b>For destination teams</b><span>Live capacity and attendance</span><span>Secure role based access</span><span>Recorded operational changes</span></div>
      <div className="footer-bottom"><span>© {new Date().getFullYear()} Iliguide · Iligan City</span><span>Local destinations, managed live</span></div></>}</div></footer>
    {toast && <div className="toast" role="status"><Check size={16}/>{toast}</div>}
    <AuthDialog mode={authMode} onClose={() => setAuthMode(null)} onMode={setAuthMode}/>
  </div>;
}

function HomePage({ sites, allCount, categories, category, setCategory, search, setSearch, visitDate, setVisitDate, openSite, signedIn, onHow }: {
  sites: Site[]; allCount: number; categories: string[]; category: string;
  setCategory: (value: string) => void; search: string; setSearch: (value: string) => void;
  visitDate: string; setVisitDate: (value: string) => void;
  openSite: (site: Site) => void; signedIn: boolean; onHow: () => void;
}) {
  const feature = sites.find((site) => site.images.some((image) => image.image_role === 'cover')) ?? sites[0];
  const cover = feature?.images.find((image) => image.image_role === 'cover')?.public_url ?? feature?.images[0]?.public_url;
  return <>
    <section className="hero"><div className="hero-copy"><span className="eyebrow"><span className="eyebrow-line"/> YOUR NEXT GREAT ESCAPE</span>
      <h1>Majestic City<br/><em>of waterfalls.</em></h1>
      <p>Chase waterfalls, cool off in crystal springs, and find the quieter side of Iligan. Explore live destination details and choose a visit time.</p>
      <div className="search-panel"><label className="search-field"><MapPin size={17}/><span><small>DESTINATION</small><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Where do you want to go?" list="site-names"/><datalist id="site-names">{sites.map((site) => <option key={site.id} value={site.name}/>)}</datalist></span><ChevronDown size={15}/></label>
        <label className="search-field date-field"><CalendarDays size={17}/><span><small>WHEN</small><input type="date" min={todayPh()} value={visitDate} onChange={(event) => setVisitDate(event.target.value)}/></span></label>
        <button className="btn btn-primary" onClick={() => document.getElementById('destinations')?.scrollIntoView({ behavior: 'smooth' })}><Search size={17}/> Find a place</button></div>
      <div className="hero-note"><div className="avatar-stack"><span>✦</span><span>✦</span><span>✦</span></div><span><b>{allCount} destinations listed</b><br/>Only live records from Iligan destination teams.</span></div>
    </div><div className="hero-image">{cover ? <img src={cover} alt={feature?.images[0]?.alt_text || feature?.name || 'Iligan destination'}/> : <img src="/iligan-city.jpg" alt="Iligan City landmark"/>}
      <div className="image-shade"/><div className="hero-image-label"><span className="live-dot"/> LIVE DESTINATION DETAILS</div>
      {cover && feature && <div className="floating-card"><span className="float-icon"><MapPin size={17}/></span><span><b>{feature.name}</b><small>{feature.address || feature.category}</small></span></div>}
      <div className="image-caption"><span>{allCount ? 'LIVE' : 'GET STARTED'}</span><i/><span>THE PHILIPPINES, REDISCOVERED</span></div></div></section>
    <div className="trust-strip"><span><ShieldCheck size={18}/> Live slot availability</span><span><BadgeCheck size={18}/> Fees shown before booking</span><span><TicketIcon size={18}/> Tickets issued after payment</span><span className="strip-location"><MapPin size={16}/> Iligan City, Philippines</span></div>
    <section className="destinations-section section-wrap" id="destinations"><div className="section-heading"><div><span className="eyebrow"><span className="eyebrow-line"/> THE GOOD STUFF</span><h2>Places worth<br className="mobile-only"/> <em>getting lost in.</em></h2></div><span className="text-link">{allCount} live destinations <ArrowRight size={17}/></span></div>
      <div className="dest-toolbar"><p>Browse current destination records.</p><div className="filter-pills">{categories.map((item) => <button key={item} className={category === item ? 'filter-pill active' : 'filter-pill'} onClick={() => setCategory(item)}>{item}</button>)}</div></div>
      <div className="site-grid">{sites.map((site, index) => <SiteCard key={site.id} site={site} index={index} onOpen={() => openSite(site)}/>)}</div>
      {!sites.length && <div className="empty-state"><Compass size={32}/><h3>No destinations listed yet</h3><p>{allCount === 0 ? 'When a Tourism Office administrator publishes a destination, it will appear here.' : 'No places match this search. Try a different name or category.'}</p></div>}
    </section>
    <section className="how-section"><div className="section-wrap how-inner"><div className="how-intro"><span className="eyebrow"><span className="eyebrow-line"/> EASY AS 1, 2, 3</span><h2>Less planning.<br/><em>More exploring.</em></h2><p>Choose a destination, reserve a live slot, and show your ticket at the gate.</p><button className="btn btn-outline" onClick={onHow}>How it works <ArrowRight size={16}/></button></div>
      <div className="steps">{[{ n: '01', title: 'Find your spot', text: 'Browse current destination details and published hours.', icon: <Compass/> }, { n: '02', title: 'Book your visit', text: 'See live slot capacity and fees before placing a hold.', icon: <CalendarDays/> }, { n: '03', title: 'Show up & explore', text: 'Use your paid booking ticket at the destination entrance.', icon: <TicketIcon/> }].map((step) => <div className="step" key={step.n}><span className="step-icon">{step.icon}</span><span className="step-body"><span className="step-number">{step.n} /</span><b>{step.title}</b><small>{step.text}</small></span><ArrowRight className="step-arrow" size={19}/></div>)}</div></div></section>
    {!signedIn && <section className="local-note section-wrap"><div className="local-art"><span className="sun-disc"/><span className="hill hill-one"/><span className="hill hill-two"/><span className="hill hill-three"/></div><div className="local-copy"><span className="eyebrow"><span className="eyebrow-line"/> MADE FOR YOUR NEXT DAY OUT</span><h2>Good days start<br/><em>with a plan.</em></h2><p>Create a visitor account to see your bookings together, or manage a guest booking with its reference and access code.</p></div></section>}
  </>;
}

function SiteCard({ site, index, onOpen }: { site: Site; index: number; onOpen: () => void }) {
  const image = site.images.find((item) => item.image_role === 'cover') ?? site.images[0];
  return <article className={'site-card card-' + (index % 4)}><button className="site-photo" onClick={onOpen} aria-label={'View ' + site.name}>
    {image ? <img src={image.public_url} alt={image.alt_text || site.name}/> : destinationPhoto(site.slug) ? <img src={destinationPhoto(site.slug)} alt={site.name}/> : <span className="site-photo-empty"><Compass size={27}/></span>}
    <span className="photo-index">{String(index + 1).padStart(2, '0')} <i/> ILIGAN</span></button>
    <div className="site-card-info"><div className="site-meta"><span>{site.category}</span><span>{site.average_rating === null ? 'No reviews' : <><b>★</b> {site.average_rating.toFixed(1)} <i>({site.review_count})</i></>}</span></div>
      <button className="site-title" onClick={onOpen}>{site.name}<ArrowRight size={17}/></button>
      <div className="site-loc"><MapPin size={13}/>{site.address || 'Iligan City'}</div>
      <div className="card-bottom"><span>From <b>{money(site.adult_fee)}</b> <small>/ adult</small></span><button onClick={onOpen}>See details <ArrowRight size={14}/></button></div></div>
  </article>;
}

function HowPage() {
  return <section className="content-page section-wrap"><span className="eyebrow"><span className="eyebrow-line"/> A SIMPLE WAY TO VISIT</span><h1>Plan less.<br/><em>Be there more.</em></h1>
    <p className="page-intro">Iliguide uses current destination records and the booking status confirmed by its payment provider.</p>
    <div className="how-page-grid">{[
      ['01', 'Choose a destination', 'Review live site details, admission fees, published hours, and currently available slots.'],
      ['02', 'Hold a visit time', 'Create a ten-minute reservation hold. The booking service calculates the total and checks capacity.'],
      ['03', 'Pay securely', 'Pay through PayMongo checkout. A redirect alone does not confirm payment; the signed webhook does.'],
      ['04', 'Show your ticket', 'Once payment is confirmed, open your QR ticket and present it to a gatekeeper for entry and exit scans.'],
    ].map(([number, title, text]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></article>)}</div>
    <div className="config-note"><ShieldCheck size={16}/> Guest bookings can be recovered with the booking reference and the private access code saved when the hold was created.</div>
  </section>;
}

function VisitorShortcuts({ go, signedIn }: { go: (page: Page) => void; signedIn: boolean }) {
  return <div className="visitor-shortcuts section-wrap"><button onClick={() => go('Bookings')}><CalendarDays size={17}/>{signedIn ? 'Your bookings' : 'Manage a booking'}<ArrowRight size={15}/></button><button onClick={() => go('Tickets')}><TicketIcon size={17}/>Tickets<ArrowRight size={15}/></button><button onClick={() => go('Account')}><ShieldCheck size={17}/>Account<ArrowRight size={15}/></button></div>;
}

function MobileTabs({ role, page, go }: { role: string; page: Page; go: (page: Page) => void }) {
  const items: Array<[string, Page]> = role === 'gatekeeper'
    ? [['Home', 'Overview'], ['Scan', 'Scan and exit'], ['Walk-in', 'Walk-in registration'], ['Today', "Today's list"]]
    : role === 'site_admin'
      ? [['Home', 'Overview'], ['Slots', 'Slots and closures'], ['Reviews', 'Staff and reviews'], ['Today', "Today's list"]]
      : role === 'tourism_office'
        ? [['Home', 'Overview'], ['Reports', 'Reports'], ['Sites', 'Sites and staff'], ['Today', "Today's list"]]
        : [['Discover', 'Discover'], ['Bookings', 'Bookings'], ['Tickets', 'Tickets'], ['Account', 'Account']];
  return <nav className="mobile-tabs" aria-label="Mobile navigation">{items.map(([label, target]) =>
    <button className={page === target ? 'active' : ''} key={target} onClick={() => go(target)}><span>
      {label === 'Bookings' ? <CalendarDays size={18}/> : label === 'Tickets' || label === 'Walk-in' ? <TicketIcon size={18}/>
        : label === 'Account' || label === 'Today' ? <ShieldCheck size={18}/> : label === 'Scan' ? <Search size={18}/>
          : label === 'Reports' ? <CalendarDays size={18}/> : label === 'Reviews' ? <BadgeCheck size={18}/> : <Compass size={18}/>}
    </span>{label}</button>)}</nav>;
}
