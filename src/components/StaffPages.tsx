import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Activity, ArrowDownToLine, ArrowRight, BadgeCheck, CalendarDays, Camera, Check, ImagePlus, MapPin, Plus, RefreshCw, ShieldCheck, Ticket as TicketIcon, Users, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { db, dateLabel, exportCsv, invokeFunction, loadSlots, money, timeLabel, type Profile, type Site, type Slot, type StaffAssignment } from '../lib/iliguide';

type Role = Profile['role'];
type Page = 'Overview' | 'Scan and exit' | 'Walk-in registration' | "Today's list" | 'Slots and closures' | 'Staff and reviews' | 'Reports' | 'Sites and staff';
type Props = {
  page: Page; role: Role; sites: Site[]; siteId: string; setSiteId: (value: string) => void;
  assignments: StaffAssignment[]; notify: (message: string) => void; busy: boolean;
  setBusy: (value: boolean) => void; refresh: () => void; go: (page: Page) => void;
  user: User | null; compact?: boolean;
};
const phToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const phTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const currentSlots = (rows: Slot[]) => {
  const now = phTime();
  return rows.filter((slot) => slot.slot_date === phToday() && slot.status === 'open' && slot.remaining_capacity > 0 && slot.starts_at.slice(0, 5) <= now && slot.ends_at.slice(0, 5) > now);
};
const localStart = (day: string) => new Date(day + 'T00:00:00+08:00').toISOString();
const localEnd = (day: string) => new Date(day + 'T23:59:59.999+08:00').toISOString();

export function StaffPages(props: Props) {
  if (props.compact) return <WorkspacePanel {...props}/>;
  if (props.page === 'Overview') return props.role === 'gatekeeper' ? <><OverviewPage {...props}/><ScannerPage {...props}/><WalkInPage {...props}/></> : <OverviewPage {...props}/>;
  if (props.page === "Today's list") return props.role === 'gatekeeper' ? <TodayPage {...props}/> : <AccessNotice/>;
  if (props.page === 'Scan and exit') return props.role === 'gatekeeper' ? <ScannerPage {...props}/> : <AccessNotice/>;
  if (props.page === 'Walk-in registration') return props.role === 'gatekeeper' ? <WalkInPage {...props}/> : <AccessNotice/>;
  if (props.page === 'Slots and closures') return props.role === 'site_admin' || props.role === 'tourism_office' ? <SchedulePage {...props}/> : <AccessNotice/>;
  if (props.page === 'Staff and reviews') return props.role === 'site_admin' || props.role === 'tourism_office' ? <PeoplePage {...props}/> : <AccessNotice/>;
  if (props.page === 'Reports') return props.role === 'site_admin' || props.role === 'tourism_office' ? <ReportsPage {...props}/> : <AccessNotice/>;
  if (props.page === 'Sites and staff') return props.role === 'tourism_office' ? <SitesPage {...props}/> : <AccessNotice/>;
  return <OverviewPage {...props}/>;
}

function SiteSelector({ sites, siteId, setSiteId }: Pick<Props, 'sites' | 'siteId' | 'setSiteId'>) {
  return <select aria-label="Active destination" value={siteId} onChange={(event) => setSiteId(event.target.value)}>
    {!sites.length && <option value="">No assigned destinations</option>}
    {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
  </select>;
}

function WorkspacePanel(props: Props) {
  const isGatekeeper = props.role === 'gatekeeper';
  const primary = isGatekeeper ? 'Scan and exit' : props.role === 'tourism_office' ? 'Reports' : 'Overview';
  const links: Array<[string, Page, string]> = isGatekeeper
    ? [['Scan a ticket', 'Scan and exit', 'Use camera or booking reference'], ['Register a walk-in', 'Walk-in registration', 'Record onsite admissions'], ['Today’s list', "Today's list", 'View today’s reservations']]
    : props.role === 'tourism_office'
      ? [['Network reports', 'Reports', 'Recorded bookings and attendance'], ['Destinations and staff', 'Sites and staff', 'Create and assign records'], ['Audit activity', 'Reports', 'Review recorded changes']]
      : [['Site reports', 'Reports', 'Recorded visitor and payment totals'], ['Slots and closures', 'Slots and closures', 'Manage visit capacity'], ['Staff and reviews', 'Staff and reviews', 'Invite gatekeepers and moderate']];
  return <section className="staff-panel section-wrap"><div className="staff-panel-top"><div><span className="eyebrow"><span className="eyebrow-line"/> YOUR STAFF WORKSPACE</span>
    <h3>{isGatekeeper ? 'Gatekeeper workspace' : props.role === 'site_admin' ? 'Destination workspace' : 'Tourism Office workspace'}</h3></div>
    <span className="online-badge"><span className="status-dot"/> Connected to live records</span></div>
    <div className="workspace-panel-select"><label>Active destination <SiteSelector {...props}/></label></div>
    <div className="staff-quick">{links.map(([label, page]) => <button className="btn btn-outline" key={label} onClick={() => props.go(page)}>{label} <ArrowRight size={15}/></button>)}
      <button className="text-link" onClick={() => props.go(primary)}>Open workspace <ArrowRight size={15}/></button></div>
  </section>;
}

function OverviewPage(props: Props) {
  const [rows, setRows] = useState<Array<Record<string, any>>>([]);
  const [attendance, setAttendance] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);
  const monthStart = phToday().slice(0, 8) + '01';
  const isGatekeeper = props.role === 'gatekeeper';
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (isGatekeeper && props.siteId) {
        const { data, error } = await db().from('attendance_logs')
          .select('id, action, scanned_at, booking_id').eq('site_id', props.siteId)
          .gte('scanned_at', localStart(phToday())).lte('scanned_at', localEnd(phToday()))
          .order('scanned_at', { ascending: false }).limit(200);
        if (error) throw error;
        setAttendance(data ?? []);
      } else {
        let query = db().from('booking_daily_metrics')
          .select('site_id, report_date, booking_count, visitor_count, walk_in_count, online_count, paid_revenue')
          .gte('report_date', monthStart).lte('report_date', phToday());
        if (props.siteId && props.role !== 'tourism_office') query = query.eq('site_id', props.siteId);
        const { data, error } = await query.order('report_date', { ascending: true });
        if (error) throw error;
        setRows((data ?? []) as Array<Record<string, any>>);
      }
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not load workspace metrics.');
    } finally { setLoading(false); }
  }, [isGatekeeper, monthStart, props.notify, props.role, props.siteId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const metric = (key: string) => rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
  const lastDays = rows.slice(-14);
  const maxVisitors = Math.max(1, ...lastDays.map((row) => Number(row.visitor_count ?? 0)));
  const site = props.sites.find((item) => item.id === props.siteId);
  return <section className={'dashboard-page section-wrap' + (isGatekeeper ? ' gatekeeper-overview' : '')}>
    <div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> {props.role.replace('_', ' ').toUpperCase()}</span>
      <h1>{isGatekeeper ? <>Gate <em>workspace.</em></> : props.role === 'tourism_office' ? <>Tourism <em>network.</em></> : <>Site <em>overview.</em></>}
      </h1><p>{isGatekeeper ? 'Attendance scans recorded for ' + (site?.name ?? 'your assigned destination') + ' today.'
        : 'Live records for ' + (props.role === 'tourism_office' ? 'all accessible destinations.' : site?.name ?? 'your assigned destination.')}</p></div>
      <div className="header-actions"><SiteSelector {...props}/><button className="btn btn-outline" onClick={() => void refresh()}><RefreshCw size={15}/> Refresh</button></div></div>
    {isGatekeeper ? <><div className="stats-grid">{[
      [attendance.filter((item) => item.action === 'entry').length, 'Entry scans today'],
      [attendance.filter((item) => item.action === 'exit').length, 'Exit scans today'],
      [attendance.filter((item) => item.action === 'entry').length - attendance.filter((item) => item.action === 'exit').length, 'Currently inside'],
      [loading ? '…' : attendance.length, 'Recorded scans'],
    ].map(([value, label]) => <div key={String(label)}><b>{loading ? '…' : value}</b><small>{label}</small></div>)}</div>
    </> : <><div className="stats-grid">{[
      [metric('visitor_count').toLocaleString(), 'Visitors this month'],
      [metric('online_count').toLocaleString(), 'Online bookings'],
      [metric('walk_in_count').toLocaleString(), 'Walk-in bookings'],
      [money(metric('paid_revenue')), 'Recorded paid revenue'],
    ].map(([value, label]) => <div key={label}><b>{loading ? '…' : value}</b><small>{label}</small></div>)}</div>
      <div className="dashboard-grid"><div className="chart-card"><div className="card-heading"><span><small>RECORDED VISITS · ASIA/MANILA</small><h3>Visitor activity</h3></span><CalendarDays size={18}/></div>
        {lastDays.length ? <div className="bar-chart">{lastDays.map((row) => <div className="bar-column" key={row.report_date}><i style={{ height: (Number(row.visitor_count) / maxVisitors * 100) + '%' }}/><small>{String(row.report_date).slice(8)}</small></div>)}</div>
          : <div className="empty-inline">{loading ? 'Loading records…' : 'No booking records for this month.'}</div>}
        <p className="report-note"><ShieldCheck size={15}/> Counts come from confirmed database records and are scoped by staff permissions.</p></div>
        <div className="activity-card"><div className="card-heading"><span><small>WORKSPACE</small><h3>Quick actions</h3></span><Activity size={18}/></div>
          {props.role === 'tourism_office' ? <><button className="quick-row" onClick={() => props.go('Sites and staff')}><MapPin size={17}/> Manage destinations <ArrowRight size={14}/></button><button className="quick-row" onClick={() => props.go('Reports')}><ArrowDownToLine size={17}/> Export reports <ArrowRight size={14}/></button></>
            : <><button className="quick-row" onClick={() => props.go('Slots and closures')}><CalendarDays size={17}/> Manage visit slots <ArrowRight size={14}/></button><button className="quick-row" onClick={() => props.go('Staff and reviews')}><Users size={17}/> Staff & reviews <ArrowRight size={14}/></button></>}</div></div>
    </>}
  </section>;
}

function TodayPage(props: Props) {
  const [bookings, setBookings] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    if (!props.siteId) { setBookings([]); setLoading(false); return; }
    setLoading(true);
    try {
      const { data, error } = await db().from('bookings')
        .select('id,booking_reference,visitor_name,visitor_count,adult_count,child_count,payment_status,booking_status,booking_source,created_at,site_slots!inner(slot_date,starts_at,ends_at)')
        .eq('site_id', props.siteId).eq('site_slots.slot_date', phToday())
        .order('created_at', { ascending: true }).limit(500);
      if (error) throw error;
      setBookings(data ?? []);
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not load today’s bookings.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [props.siteId]);
  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> GATEKEEPER · TODAY</span><h1>Today’s <em>visitors.</em></h1><p>{dateLabel(phToday())} · {props.sites.find((site) => site.id === props.siteId)?.name ?? 'Assigned site'}</p></div>
    <div className="header-actions"><SiteSelector {...props}/><button className="btn btn-outline" onClick={() => void refresh()}><RefreshCw size={15}/> Refresh</button></div></div>
    <div className="arrivals-card"><div className="card-heading"><span><small>LIVE BOOKING RECORDS</small><h3>Scheduled visits</h3></span><span>{loading ? 'Loading…' : bookings.length + ' bookings'}</span></div>
      {!loading && !bookings.length && <div className="empty-inline">No bookings are scheduled for this destination today.</div>}
      {bookings.map((booking) => { const slot = Array.isArray(booking.site_slots) ? booking.site_slots[0] : booking.site_slots; return <div className="arrival-row" key={booking.id}>
        <span className="arrival-initial">{String(booking.visitor_name ?? '?').slice(0, 1).toUpperCase()}</span>
        <span><b>{booking.visitor_name}</b><small>{booking.booking_reference} · {slot?.starts_at ? timeLabel(slot.starts_at) : ''} · {booking.visitor_count} visitors</small></span>
        <span className={booking.payment_status === 'paid' ? 'status-tag paid' : 'status-tag'}>{booking.payment_status}</span>
        <span className={booking.booking_status === 'completed' ? 'status-tag inside' : 'status-tag'}>{booking.booking_status.replace('_', ' ')}</span>
      </div>; })}
    </div><div className="staff-quick"><button className="btn btn-primary" onClick={() => props.go('Scan and exit')}>Scan next ticket <ArrowRight size={16}/></button><button className="btn btn-outline" onClick={() => props.go('Walk-in registration')}>Register walk-in</button></div>
  </section>;
}

function AccessNotice() {
  return <section className="dashboard-page section-wrap"><div className="empty-card"><ShieldCheck size={30}/><h3>This page is not available to this staff role</h3><p>Access follows the role and destination assignments linked to your account.</p></div></section>;
}

type ScanResult = { result: string; booking_reference: string | null; visitor_name: string | null; visitor_count: number; entered_at: string | null; exited_at: string | null };
function ScannerPage(props: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lockRef = useRef(false);
  const [manual, setManual] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const site = props.sites.find((item) => item.id === props.siteId);

  const processToken = useCallback(async (token: string) => {
    if (!props.siteId || lockRef.current) return;
    lockRef.current = true;
    setScanBusy(true);
    setScanError('');
    try {
      const payload = await invokeFunction<{ result: ScanResult }>('scan-ticket', { token, site_id: props.siteId });
      setResult(payload.result);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Ticket scan could not be recorded.');
    } finally {
      setScanBusy(false);
      controlsRef.current?.stop();
      controlsRef.current = null;
      setCameraOn(false);
      window.setTimeout(() => { lockRef.current = false; }, 1200);
    }
  }, [props.siteId]);

  const startCamera = async () => {
    if (!videoRef.current) return;
    setScanError('');
    setResult(null);
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const reader = new BrowserQRCodeReader();
      controlsRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current, (decoded) => {
        if (decoded && !lockRef.current) void processToken(decoded.getText());
      });
      setCameraOn(true);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Camera access is unavailable. Use manual booking reference lookup.');
    }
  };
  const stopCamera = () => { controlsRef.current?.stop(); controlsRef.current = null; setCameraOn(false); };
  useEffect(() => () => { controlsRef.current?.stop(); }, []);
  const manualLookup = async (event: FormEvent) => {
    event.preventDefault();
    if (!manual.trim() || !props.siteId) return;
    setScanBusy(true); setScanError(''); setResult(null);
    try {
      const { data, error } = await db().rpc('manual_scan_ticket', {
        p_booking_reference: manual.trim(),
        p_site_id: props.siteId,
        p_device: { user_agent: navigator.userAgent.slice(0, 240), method: 'manual' },
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as ScanResult;
      setResult(row);
    } catch (error) { setScanError(error instanceof Error ? error.message : 'Could not look up this booking.'); }
    finally { setScanBusy(false); }
  };

  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> GATEKEEPER · SCAN & EXIT</span><h1>One scan at a <em>time.</em></h1><p>Camera scans verify signed tickets. Manual lookup records the same entry or exit action.</p></div>
    <div className="header-actions"><SiteSelector {...props}/></div></div>
    {!props.siteId && <div className="empty-card"><ShieldCheck size={30}/><h3>No site assignment</h3><p>Ask the Tourism Office to assign your gatekeeper account.</p></div>}
    {!!props.siteId && <div className="scan-layout"><article className="scan-card"><div className="scan-mode"><button className={!manual ? 'active' : ''} onClick={() => { setManual(''); setScanError(''); }}>Camera</button><button className={manual ? 'active' : ''} onClick={() => { stopCamera(); setManual(' '); setScanError(''); }}>Manual reference</button></div>
      <div className="camera-box"><video ref={videoRef} muted playsInline className={cameraOn ? 'scanner-video visible' : 'scanner-video'}/>{!cameraOn && <div className="camera-placeholder"><Camera size={31}/><p>Point the camera at the visitor’s QR ticket.</p><small>Camera permission is requested only after you start the scanner.</small></div>}</div>
      <div className="scan-controls">{cameraOn ? <button className="btn btn-outline" onClick={stopCamera}><X size={15}/> Stop camera</button>
        : <button className="btn btn-primary" onClick={() => void startCamera()} disabled={!props.siteId}><Camera size={15}/> Start camera</button>}
        <span>{site?.name ?? 'Select a site'}</span></div>
      {Boolean(manual.trim()) && <form className="manual-scan-form" onSubmit={(event) => void manualLookup(event)}><label>Booking reference<input value={manual} onChange={(event) => setManual(event.target.value)} autoFocus placeholder="ILG-…" autoCapitalize="characters"/></label><button className="btn btn-primary" disabled={scanBusy}>{scanBusy ? 'Checking…' : 'Record scan'} <ArrowRight size={15}/></button></form>}
      {scanError && <p className="form-error" role="alert">{scanError}</p>}
    </article><article className="scan-result-card"><div className="card-heading"><span><small>SCAN RESULT</small><h3>Entry & exit record</h3></span><ShieldCheck size={19}/></div>
      {!result && !scanError && <div className="empty-inline">A scan result will appear here after the server validates the ticket.</div>}
      {result && <div className="scan-result"><span className={result.result.includes('recorded') ? 'scan-result-icon success' : 'scan-result-icon'}>{result.result.includes('recorded') ? <Check size={23}/> : <ShieldCheck size={23}/>}</span>
        <strong>{scanLabel(result.result)}</strong><p>{result.visitor_name || 'Ticket details unavailable'}</p>
        {result.booking_reference && <small>{result.booking_reference} · {result.visitor_count} visitors</small>}
        {result.entered_at && <small>Entry: {new Date(result.entered_at).toLocaleString()}</small>}
        {result.exited_at && <small>Exit: {new Date(result.exited_at).toLocaleString()}</small>}
        <button className="btn btn-outline" onClick={() => { setResult(null); setScanError(''); }}>Scan another ticket</button></div>}
    </article></div>}
  </section>;
}

function scanLabel(result: string) {
  return ({ entry_recorded: 'Entry recorded', exit_recorded: 'Exit recorded', completed: 'Visit already completed',
    invalid: 'Ticket is invalid', unpaid_or_inactive: 'Booking is unpaid or inactive', outside_window: 'Outside the visit time window' } as Record<string, string>)[result] ?? result.replace(/_/g, ' ');
}

type Hour = { weekday: number; opens_at: string; closes_at: string; is_closed: boolean };
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function SchedulePage(props: Props) {
  const [hours, setHours] = useState<Hour[]>(dayNames.map((_, weekday) => ({ weekday, opens_at: '', closes_at: '', is_closed: true })));
  const [slots, setSlots] = useState<Array<Record<string, any>>>([]);
  const [closures, setClosures] = useState<Array<Record<string, any>>>([]);
  const [slotForm, setSlotForm] = useState({ date: phToday(), starts_at: '', ends_at: '', capacity: '' });
  const [closureForm, setClosureForm] = useState({ starts_on: phToday(), ends_on: phToday(), reason: '' });
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!props.siteId) { setSlots([]); setClosures([]); return; }
    setLoading(true);
    try {
      const [hourResult, slotResult, closureResult] = await Promise.all([
        db().from('site_operating_hours').select('weekday,opens_at,closes_at,is_closed').eq('site_id', props.siteId).order('weekday'),
        db().from('site_slots').select('id,slot_date,starts_at,ends_at,capacity,status').eq('site_id', props.siteId).gte('slot_date', phToday()).order('slot_date').order('starts_at').limit(120),
        db().from('site_closures').select('id,starts_on,ends_on,starts_at,ends_at,reason').eq('site_id', props.siteId).gte('ends_on', phToday()).order('starts_on').limit(60),
      ]);
      if (hourResult.error) throw hourResult.error;
      if (slotResult.error) throw slotResult.error;
      if (closureResult.error) throw closureResult.error;
      const stored = new Map((hourResult.data ?? []).map((row) => [row.weekday, row]));
      setHours(dayNames.map((_, weekday) => {
        const row = stored.get(weekday);
        return row ? { weekday, opens_at: String(row.opens_at ?? '').slice(0, 5), closes_at: String(row.closes_at ?? '').slice(0, 5), is_closed: row.is_closed }
          : { weekday, opens_at: '', closes_at: '', is_closed: true };
      }));
      setSlots(slotResult.data ?? []);
      setClosures(closureResult.data ?? []);
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not load site schedule.'); }
    finally { setLoading(false); }
  }, [props.notify, props.siteId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const changeHour = (weekday: number, change: Partial<Hour>) => setHours((current) =>
    current.map((row) => row.weekday === weekday ? { ...row, ...change } : row));
  const saveHours = async () => {
    if (hours.some((row) => !row.is_closed && (!row.opens_at || !row.closes_at || row.closes_at <= row.opens_at))) {
      props.notify('Enter valid opening and closing times for every open day.'); return;
    }
    setLoading(true);
    try {
      const rows = hours.map((row) => ({
        site_id: props.siteId, weekday: row.weekday, is_closed: row.is_closed,
        opens_at: row.is_closed ? null : row.opens_at,
        closes_at: row.is_closed ? null : row.closes_at,
      }));
      const { error } = await db().from('site_operating_hours').upsert(rows, { onConflict: 'site_id,weekday' });
      if (error) throw error;
      props.notify('Weekly operating hours saved.');
      await refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not save weekly hours.'); }
    finally { setLoading(false); }
  };
  const addSlot = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.siteId || !slotForm.starts_at || !slotForm.ends_at || Number(slotForm.capacity) < 1) return;
    setLoading(true);
    try {
      const { error } = await db().from('site_slots').insert({
        site_id: props.siteId, slot_date: slotForm.date, starts_at: slotForm.starts_at,
        ends_at: slotForm.ends_at, capacity: Number(slotForm.capacity), created_by: props.user?.id,
      });
      if (error) throw error;
      props.notify('Visit slot added. Booking requests will check its operating hours and remaining capacity.');
      setSlotForm({ ...slotForm, starts_at: '', ends_at: '', capacity: '' });
      await refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not add the visit slot.'); }
    finally { setLoading(false); }
  };
  const addClosure = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.siteId || !closureForm.reason.trim()) return;
    setLoading(true);
    try {
      const { error } = await db().from('site_closures').insert({
        site_id: props.siteId, starts_on: closureForm.starts_on, ends_on: closureForm.ends_on,
        reason: closureForm.reason.trim(), created_by: props.user?.id,
      });
      if (error) throw error;
      props.notify('Closure saved. New booking holds will respect this date range.');
      setClosureForm({ ...closureForm, reason: '' });
      await refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not add the closure.'); }
    finally { setLoading(false); }
  };
  const toggleSlot = async (slot: Record<string, any>) => {
    const next = slot.status === 'open' ? 'closed' : 'open';
    const { error } = await db().from('site_slots').update({ status: next }).eq('id', slot.id);
    if (error) props.notify(error.message);
    else { props.notify('Slot status updated.'); await refresh(); }
  };
  const site = props.sites.find((item) => item.id === props.siteId);
  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> SITE ADMINISTRATION</span><h1>Hours that work <em>for you.</em></h1><p>Manage published hours, date-specific capacity, and closure notices{site ? ' for ' + site.name : ''}.</p></div>
    <div className="header-actions"><SiteSelector {...props}/><button className="btn btn-outline" onClick={() => void refresh()}><RefreshCw size={15}/></button></div></div>
    {!props.siteId && <div className="empty-card"><MapPin size={28}/><h3>No assigned destination</h3><p>Ask the Tourism Office to assign a site administrator account.</p></div>}
    {!!props.siteId && <><div className="schedule-card"><div className="schedule-head"><span><small>PHILIPPINE TIME · ASIA/MANILA</small><h3>Weekly operating hours</h3></span><button className="btn btn-primary" disabled={loading} onClick={() => void saveHours()}>Save hours <Check size={15}/></button></div>
      {hours.map((hour) => <div className="schedule-row" key={hour.weekday}><label className="day-switch"><input type="checkbox" checked={!hour.is_closed} onChange={(event) => changeHour(hour.weekday, { is_closed: !event.target.checked })}/>{dayNames[hour.weekday]}</label>
        {hour.is_closed ? <span className="closed-label">Closed</span> : <><input type="time" value={hour.opens_at} onChange={(event) => changeHour(hour.weekday, { opens_at: event.target.value })}/><span>to</span><input type="time" value={hour.closes_at} onChange={(event) => changeHour(hour.weekday, { closes_at: event.target.value })}/></>}
      </div>)}</div>
      <div className="schedule-card"><div className="schedule-head"><span><small>DATE-SPECIFIC CAPACITY</small><h3>Add a visit slot</h3></span></div>
        <form className="slot-admin-form" onSubmit={(event) => void addSlot(event)}><label>Date<input type="date" min={phToday()} value={slotForm.date} onChange={(event) => setSlotForm({ ...slotForm, date: event.target.value })} required/></label>
          <label>Starts<input type="time" value={slotForm.starts_at} onChange={(event) => setSlotForm({ ...slotForm, starts_at: event.target.value })} required/></label>
          <label>Ends<input type="time" value={slotForm.ends_at} onChange={(event) => setSlotForm({ ...slotForm, ends_at: event.target.value })} required/></label>
          <label>Capacity<input type="number" min="1" max="100000" value={slotForm.capacity} onChange={(event) => setSlotForm({ ...slotForm, capacity: event.target.value })} required/></label>
          <button className="btn btn-primary" disabled={loading}>Add slot <Plus size={15}/></button></form>
        {!slots.length && <div className="empty-inline">{loading ? 'Loading…' : 'No upcoming slots have been added.'}</div>}
        <div className="table-card"><table><thead><tr><th>Date</th><th>Time</th><th>Capacity</th><th>Status</th><th/></tr></thead><tbody>{slots.map((slot) => <tr key={slot.id}>
          <td>{dateLabel(slot.slot_date)}</td><td>{timeLabel(slot.starts_at)} – {timeLabel(slot.ends_at)}</td><td>{slot.capacity}</td><td><span className={slot.status === 'open' ? 'status-tag paid' : 'status-tag'}>{slot.status}</span></td>
          <td><button className="link-btn" onClick={() => void toggleSlot(slot)}>{slot.status === 'open' ? 'Close' : 'Open'}</button></td></tr>)}</tbody></table></div>
      </div>
      <div className="schedule-card"><div className="schedule-head"><span><small>SPECIAL DATES</small><h3>Closures</h3></span></div>
        <form className="closure-admin-form" onSubmit={(event) => void addClosure(event)}><label>From<input type="date" min={phToday()} value={closureForm.starts_on} onChange={(event) => setClosureForm({ ...closureForm, starts_on: event.target.value })} required/></label>
          <label>Through<input type="date" min={closureForm.starts_on} value={closureForm.ends_on} onChange={(event) => setClosureForm({ ...closureForm, ends_on: event.target.value })} required/></label>
          <label>Reason<input value={closureForm.reason} onChange={(event) => setClosureForm({ ...closureForm, reason: event.target.value })} maxLength={500} required/></label>
          <button className="btn btn-outline" disabled={loading}>Add closure <Plus size={15}/></button></form>
        {!closures.length && <div className="empty-inline">No future closures recorded.</div>}
        {closures.map((closure) => <div className="closure-row" key={closure.id}><span className="closure-date">{String(closure.starts_on).slice(5, 7)}<br/><b>{String(closure.starts_on).slice(8, 10)}</b></span><span><b>{dateLabel(closure.starts_on)}{closure.ends_on !== closure.starts_on ? ' – ' + dateLabel(closure.ends_on) : ''}</b><small>{closure.reason}</small></span><button className="link-btn" onClick={async () => { const { error } = await db().from('site_closures').delete().eq('id', closure.id); if (error) props.notify(error.message); else await refresh(); }}>Remove</button></div>)}
      </div></>}
  </section>;
}

function PeoplePage(props: Props) {
  const [reviews, setReviews] = useState<Array<Record<string, any>>>([]);
  const [cancellations, setCancellations] = useState<Array<Record<string, any>>>([]);
  const [refunds, setRefunds] = useState<Array<Record<string, any>>>([]);
  const [staff, setStaff] = useState<Array<Record<string, any>>>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState(props.role === 'site_admin' ? 'gatekeeper' : 'site_admin');
  const [decisionNote, setDecisionNote] = useState('');
  const [loading, setLoading] = useState(false);
  const siteIds = props.role === 'tourism_office' ? props.sites.map((site) => site.id) : [props.siteId].filter(Boolean);
  const refresh = useCallback(async () => {
    if (!siteIds.length) { setReviews([]); setCancellations([]); setRefunds([]); setStaff([]); return; }
    setLoading(true);
    try {
      const [reviewResult, cancellationResult, refundResult, staffResult] = await Promise.all([
        db().from('reviews').select('id,booking_id,site_id,rating,comment,review_status,created_at,booking:bookings(booking_reference,visitor_name),tourism_sites(name)')
          .in('site_id', siteIds).order('created_at', { ascending: false }).limit(100),
        db().from('cancellation_requests').select('id,booking_id,site_id,reason,request_status,created_at,decision_note,booking:bookings(booking_reference,visitor_name,total_amount,payment_status),tourism_sites(name)')
          .in('site_id', siteIds).order('created_at', { ascending: false }).limit(100),
        db().from('refunds').select('id,booking_id,amount,refund_status,reason,created_at,bookings!inner(site_id,booking_reference)')
          .in('bookings.site_id', siteIds).order('created_at', { ascending: false }).limit(100),
        db().from('staff_assignments').select('id,profile_id,site_id,staff_role,is_active,profiles(full_name,email),tourism_sites(name)')
          .in('site_id', siteIds).order('created_at', { ascending: false }).limit(100),
      ]);
      for (const result of [reviewResult, cancellationResult, refundResult, staffResult]) if (result.error) throw result.error;
      setReviews(reviewResult.data ?? []);
      setCancellations(cancellationResult.data ?? []);
      setRefunds(refundResult.data ?? []);
      setStaff(staffResult.data ?? []);
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not load staff and review records.'); }
    finally { setLoading(false); }
  }, [props.notify, siteIds.join(',')]);
  useEffect(() => { void refresh(); }, [refresh]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || (inviteRole !== 'tourism_office' && !props.siteId)) { props.notify('Enter the staff email and choose a site.'); return; }
    props.setBusy(true);
    try {
      const result = await invokeFunction<{ existing_account: boolean }>('invite-staff', {
        email: email.trim(), staff_role: inviteRole, site_id: inviteRole === 'tourism_office' ? null : props.siteId,
      });
      props.notify(result.existing_account ? 'Existing visitor account was assigned the selected staff role.' : 'Staff invitation sent by Supabase Auth email.');
      setEmail('');
      await refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not invite staff.'); }
    finally { props.setBusy(false); }
  };
  const moderate = async (review: Record<string, any>, status: 'published' | 'hidden') => {
    const { error } = await db().from('reviews').update({
      review_status: status, moderated_by: props.user?.id, moderated_at: new Date().toISOString(),
    }).eq('id', review.id);
    if (error) props.notify(error.message);
    else { props.notify('Review status updated.'); await refresh(); }
  };
  const decideCancellation = async (request: Record<string, any>, approve: boolean) => {
    setLoading(true);
    try {
      const { data, error } = await db().rpc('review_cancellation', {
        p_request_id: request.id, p_approve: approve, p_note: decisionNote.trim() || null,
      });
      if (error) throw error;
      setDecisionNote('');
      if (approve && data) {
        try {
          const result = await invokeFunction<{ refund: { refund_status: string } }>('process-refund', { refund_id: data });
          props.notify('Cancellation approved. Refund status: ' + result.refund.refund_status + '.');
        } catch (error) {
          props.notify('Cancellation approved. Refund requires follow-up: ' + (error instanceof Error ? error.message : 'check the refund record.'));
        }
      } else props.notify(approve ? 'Cancellation approved.' : 'Cancellation declined.');
      await refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not review this cancellation.'); }
    finally { setLoading(false); }
  };
  const disableAssignment = async (assignment: Record<string, any>) => {
    const { error } = await db().from('staff_assignments').update({ is_active: false }).eq('id', assignment.id);
    if (error) props.notify(error.message);
    else { props.notify('Site staff assignment disabled.'); await refresh(); }
  };
  const retryRefund = async (refund: Record<string, any>) => {
    try {
      const result = await invokeFunction<{ refund: { refund_status: string } }>('process-refund', { refund_id: refund.id });
      props.notify('Refund status: ' + result.refund.refund_status + '.');
      await refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not process this refund.'); }
  };
  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> SITE ADMINISTRATION</span><h1>People & <em>kind words.</em></h1><p>Invite staff, moderate visitor reviews, and review cancellation requests using live records.</p></div>
    <div className="header-actions">{props.role === 'tourism_office' && <SiteSelector {...props}/>}<button className="btn btn-outline" onClick={() => void refresh()}><RefreshCw size={15}/></button></div></div>
    {props.role === 'site_admin' && <div className="workspace-panel-select"><label>Active destination <SiteSelector {...props}/></label></div>}
    <div className="schedule-card"><div className="schedule-head"><span><small>ROLE-BASED ACCESS</small><h3>Invite a team member</h3></span><Users size={18}/></div>
      <form className="invite-form" onSubmit={(event) => void invite(event)}><label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254}/></label>
        <label>Staff role<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}><option value="gatekeeper">Gatekeeper</option>{props.role === 'tourism_office' && <><option value="site_admin">Site administrator</option><option value="tourism_office">Tourism Office</option></>}</select></label>
        {inviteRole !== 'tourism_office' && props.role === 'tourism_office' && <label>Destination<SiteSelector {...props}/></label>}
        <button className="btn btn-primary" disabled={props.busy || !props.siteId && inviteRole !== 'tourism_office'}>{props.busy ? 'Sending…' : 'Send invitation'} <ArrowRight size={15}/></button>
      </form>
      <div className="table-card"><table><thead><tr><th>Staff member</th><th>Destination</th><th>Role</th><th>Access</th><th/></tr></thead><tbody>
        {staff.map((assignment) => { const person = Array.isArray(assignment.profiles) ? assignment.profiles[0] : assignment.profiles; const site = Array.isArray(assignment.tourism_sites) ? assignment.tourism_sites[0] : assignment.tourism_sites; return <tr key={assignment.id}>
          <td>{person?.full_name || person?.email || assignment.profile_id}</td><td>{site?.name ?? '—'}</td><td>{assignment.staff_role.replace('_', ' ')}</td>
          <td><span className={assignment.is_active ? 'status-tag paid' : 'status-tag'}>{assignment.is_active ? 'Active' : 'Disabled'}</span></td>
          <td>{assignment.is_active && (props.role === 'tourism_office' || assignment.staff_role === 'gatekeeper') && <button className="link-btn" onClick={() => void disableAssignment(assignment)}>Disable</button>}</td>
        </tr>; })}
        {!staff.length && <tr><td colSpan={5}>{loading ? 'Loading staff…' : 'No site staff assignments.'}</td></tr>}
      </tbody></table></div>
    </div>
    <SiteImagesManager {...props}/>
    <div className="schedule-card"><div className="schedule-head"><span><small>VISITOR FEEDBACK</small><h3>Reviews</h3></span><BadgeCheck size={18}/></div>
      {!reviews.length && <div className="empty-inline">{loading ? 'Loading reviews…' : 'No visitor reviews yet.'}</div>}
      {reviews.map((review) => { const booking = Array.isArray(review.booking) ? review.booking[0] : review.booking; const site = Array.isArray(review.tourism_sites) ? review.tourism_sites[0] : review.tourism_sites; return <article className="review-card" key={review.id}>
        <div className="review-avatar">{Number(review.rating)}★</div><div><div className="review-card-head"><b>{booking?.visitor_name || 'Visitor'} <span className="verified-label"><BadgeCheck size={13}/> Verified visit</span></b><span>{site?.name}</span></div>
          <p>{review.comment || 'No written comment.'}</p><small>{booking?.booking_reference} · {new Date(review.created_at).toLocaleDateString()} · <strong>{review.review_status}</strong></small>
          <div className="review-actions"><button className="btn btn-outline" onClick={() => void moderate(review, 'published')}>Publish</button><button className="link-btn" onClick={() => void moderate(review, 'hidden')}>Hide</button></div></div></article>; })}
    </div>
    <div className="schedule-card"><div className="schedule-head"><span><small>BOOKING CANCELLATIONS</small><h3>Requests and refunds</h3></span><ShieldCheck size={18}/></div>
      {cancellations.map((request) => { const booking = Array.isArray(request.booking) ? request.booking[0] : request.booking; const site = Array.isArray(request.tourism_sites) ? request.tourism_sites[0] : request.tourism_sites; return <div className="request-row" key={request.id}>
        <div><b>{booking?.visitor_name || booking?.booking_reference || 'Booking'} · {site?.name}</b><small>{request.reason}</small><small>{new Date(request.created_at).toLocaleString()} · {request.request_status}</small></div>
        {request.request_status === 'pending' && <div className="request-actions"><button className="btn btn-primary" disabled={loading} onClick={() => void decideCancellation(request, true)}>Approve</button><button className="btn btn-outline" disabled={loading} onClick={() => void decideCancellation(request, false)}>Decline</button></div>}
      </div>; })}
      {!cancellations.length && <div className="empty-inline">No cancellation requests.</div>}
      {refunds.map((refund) => <div className="refund-row" key={refund.id}><span><b>{refund.bookings?.booking_reference || 'Booking refund'}</b><small>{money(refund.amount)} · {refund.reason}</small></span><span className="status-tag">{refund.refund_status.replace('_', ' ')}</span>
        {['queued', 'failed', 'processing'].includes(refund.refund_status) && <button className="link-btn" onClick={() => void retryRefund(refund)}>Retry refund</button>}</div>)}
    </div>
  </section>;
}

function SiteImagesManager(props: Props) {
  const [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false);
  const site = props.sites.find((item) => item.id === props.siteId);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !site) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      props.notify('Choose a JPEG, PNG, or WebP image under 5 MiB.'); return;
    }
    setBusy(true);
    const path = site.id + '/' + crypto.randomUUID() + '.' + file.type.split('/')[1].replace('jpeg', 'jpg');
    try {
      const { error: storageError } = await db().storage.from('tourism-site-images')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (storageError) throw storageError;
      const { error } = await db().from('site_images').insert({
        site_id: site.id, storage_path: path, image_role: 'gallery',
        alt_text: alt.trim() || site.name, created_by: props.user?.id,
      });
      if (error) {
        await db().storage.from('tourism-site-images').remove([path]);
        throw error;
      }
      setAlt('');
      props.notify('Destination image uploaded.');
      props.refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not upload this destination image.'); }
    finally { setBusy(false); event.target.value = ''; }
  };
  const remove = async (image: Site['images'][number]) => {
    const { error } = await db().from('site_images').delete().eq('id', image.id);
    if (error) { props.notify(error.message); return; }
    const result = await db().storage.from('tourism-site-images').remove([image.storage_path]);
    if (result.error) props.notify('Image record removed. The stored file could not be removed: ' + result.error.message);
    else props.notify('Destination image removed.');
    props.refresh();
  };
  return <div className="schedule-card"><div className="schedule-head"><span><small>DESTINATION MEDIA</small><h3>Photos {site ? '· ' + site.name : ''}</h3></span><ImagePlus size={18}/></div>
    {!site && <div className="empty-inline">Select an assigned destination to manage its photos.</div>}
    {site && <><div className="image-manager-grid">{site.images.map((image) => <div className="managed-image" key={image.id}><img src={image.public_url} alt={image.alt_text || site.name}/><span>{image.alt_text || site.name}</span><button aria-label="Remove image" onClick={() => void remove(image)}><X size={14}/></button></div>)}
      {!site.images.length && <div className="empty-inline">No destination photos uploaded.</div>}</div>
      <div className="image-upload-row"><label>Photo description<input value={alt} onChange={(event) => setAlt(event.target.value)} maxLength={250} placeholder={site.name}/></label>
        <label className="btn btn-outline image-pick">{busy ? 'Uploading…' : 'Add photo'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => void upload(event)}/></label>
      </div><p className="field-hint">JPEG, PNG, or WebP · maximum 5 MiB. These images are publicly viewable.</p></>}
  </div>;
}

function ReportsPage(props: Props) {
  const [metrics, setMetrics] = useState<Array<Record<string, any>>>([]);
  const [audit, setAudit] = useState<Array<Record<string, any>>>([]);
  const [month, setMonth] = useState(phToday().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const siteIds = props.role === 'tourism_office' ? props.sites.map((site) => site.id) : [props.siteId].filter(Boolean);
  const refresh = useCallback(async () => {
    if (!siteIds.length) { setMetrics([]); setAudit([]); setLoading(false); return; }
    setLoading(true);
    const start = month + '-01';
    const [year, monthNumber] = month.split('-').map(Number);
    const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    try {
      let metricQuery = db().from('booking_daily_metrics').select('site_id,report_date,booking_count,visitor_count,walk_in_count,online_count,paid_revenue')
        .gte('report_date', start).lte('report_date', end);
      let auditQuery = db().from('audit_logs').select('id,actor_id,site_id,action,entity_type,entity_id,created_at')
        .gte('created_at', localStart(start)).lte('created_at', localEnd(end)).order('created_at', { ascending: false }).limit(200);
      if (props.role !== 'tourism_office') {
        metricQuery = metricQuery.eq('site_id', props.siteId);
        auditQuery = auditQuery.eq('site_id', props.siteId);
      } else if (siteIds.length) {
        metricQuery = metricQuery.in('site_id', siteIds);
        auditQuery = auditQuery.in('site_id', siteIds);
      }
      const [metricResult, auditResult] = await Promise.all([metricQuery.order('report_date'), auditQuery]);
      if (metricResult.error) throw metricResult.error;
      if (auditResult.error) throw auditResult.error;
      setMetrics(metricResult.data ?? []);
      setAudit(auditResult.data ?? []);
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not load the report.'); }
    finally { setLoading(false); }
  }, [month, props.notify, props.role, props.siteId, siteIds.join(',')]);
  useEffect(() => { void refresh(); }, [refresh]);
  const summary = (key: string) => metrics.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
  const siteName = (id: string) => props.sites.find((site) => site.id === id)?.name ?? id;
  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> {props.role === 'tourism_office' ? 'TOURISM OFFICE · NETWORK REPORT' : 'SITE ADMIN · DESTINATION REPORT'}</span>
    <h1>See the recorded <em>picture.</em></h1><p>All values come from bookings and payment records the database has stored.</p></div>
    <div className="header-actions"><label className="month-picker">Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)}/></label>
      {props.role === 'tourism_office' && <SiteSelector {...props}/>}<button className="btn btn-outline" disabled={!metrics.length} onClick={() => void exportCsv('iliguide-report-' + month + '.csv', metrics.map((row) => ({ ...row, site_name: siteName(row.site_id) })))}><ArrowDownToLine size={15}/> Export</button></div></div>
    <div className="stats-grid">{[[summary('visitor_count').toLocaleString(), 'Visitors'], [summary('online_count').toLocaleString(), 'Online bookings'],
      [summary('walk_in_count').toLocaleString(), 'Walk-ins'], [money(summary('paid_revenue')), 'Paid revenue']].map(([value, label]) => <div key={label}><b>{loading ? '…' : value}</b><small>{label}</small></div>)}</div>
    <div className="report-grid"><div className="chart-card"><div className="card-heading"><span><small>BY DESTINATION · {month}</small><h3>Recorded activity</h3></span></div>
      {!metrics.length && <div className="empty-inline">{loading ? 'Loading report…' : 'No booking records for this reporting period.'}</div>}
      <div className="table-card"><table><thead><tr><th>Date</th><th>Destination</th><th>Visitors</th><th>Online</th><th>Walk-in</th><th>Paid revenue</th></tr></thead>
        <tbody>{metrics.map((row, index) => <tr key={row.site_id + row.report_date + index}><td>{dateLabel(row.report_date)}</td><td>{siteName(row.site_id)}</td><td>{row.visitor_count}</td><td>{row.online_count}</td><td>{row.walk_in_count}</td><td>{money(row.paid_revenue)}</td></tr>)}</tbody></table></div>
    </div><div className="chart-card"><div className="card-heading"><span><small>RECORDED CHANGES</small><h3>Audit activity</h3></span><ShieldCheck size={17}/></div>
      {!audit.length && <div className="empty-inline">{loading ? 'Loading audit history…' : 'No audit events in this period.'}</div>}
      {audit.map((row) => <div className="audit-row" key={row.id}><span><b>{row.action.replace(/_/g, ' ')}</b><small>{row.entity_type} · {siteName(row.site_id)}</small></span><time>{new Date(row.created_at).toLocaleString()}</time></div>)}
    </div></div>
    <p className="report-note"><ShieldCheck size={15}/> Reports are scoped by row level security. A zero count means no matching rows were recorded.</p>
  </section>;
}

type SiteDraft = {
  name: string; category: string; description: string; address: string;
  adult_fee: string; child_fee: string; max_per_booking: string; cancellation_cutoff_hours: string;
};
const emptyDraft = (): SiteDraft => ({ name: '', category: '', description: '', address: '', adult_fee: '', child_fee: '', max_per_booking: '20', cancellation_cutoff_hours: '24' });
function SitesPage(props: Props) {
  const [draft, setDraft] = useState<SiteDraft>(emptyDraft());
  const [editing, setEditing] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusBusy, setStatusBusy] = useState('');

  const change = (key: keyof SiteDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const beginEdit = (site: Site) => {
    setEditing(site.id);
    setDraft({
      name: site.name, category: site.category, description: site.description, address: site.address,
      adult_fee: String(site.adult_fee), child_fee: String(site.child_fee),
      max_per_booking: String(site.max_per_booking), cancellation_cutoff_hours: String(site.cancellation_cutoff_hours),
    });
  };
  const slugFromName = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const saveSite = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.user) { props.notify('Sign in with a Tourism Office account first.'); return; }
    if (Number(draft.adult_fee) < 0 || Number(draft.child_fee) < 0 || Number(draft.max_per_booking) < 1) {
      props.notify('Enter valid fees and booking limits.'); return;
    }
    if (!editing && (!days.length || !opens || !closes || closes <= opens)) {
      props.notify('Choose at least one operating day and valid opening hours.'); return;
    }
    setLoading(true);
    let createdSiteId = editing;
    try {
      const siteValues = {
        name: draft.name.trim(), category: draft.category.trim(), description: draft.description.trim(),
        address: draft.address.trim(),
      };
      if (editing) {
        const { error } = await db().from('tourism_sites').update(siteValues).eq('id', editing);
        if (error) throw error;
      } else {
        const slug = slugFromName(draft.name) + '-' + crypto.randomUUID().slice(0, 6);
        const { data, error } = await db().from('tourism_sites').insert({
          ...siteValues, slug, status: 'draft', created_by: props.user.id,
        }).select('id').single();
        if (error) throw error;
        createdSiteId = data.id;
      }
      const { error: settingsError } = await db().from('site_settings').upsert({
        site_id: createdSiteId,
        adult_fee: Number(draft.adult_fee),
        child_fee: Number(draft.child_fee),
        max_per_booking: Number(draft.max_per_booking),
        cancellation_cutoff_hours: Number(draft.cancellation_cutoff_hours),
        updated_by: props.user.id,
      }, { onConflict: 'site_id' });
      if (settingsError) throw settingsError;
      if (!editing) {
        const hourRows = dayNames.map((_, weekday) => ({
          site_id: createdSiteId, weekday, is_closed: !days.includes(weekday),
          opens_at: days.includes(weekday) ? opens : null,
          closes_at: days.includes(weekday) ? closes : null,
        }));
        const { error: hoursError } = await db().from('site_operating_hours').upsert(hourRows, { onConflict: 'site_id,weekday' });
        if (hoursError) throw hoursError;
      }
      props.setSiteId(createdSiteId);
      props.notify(editing ? 'Destination details and fees saved.' : 'Destination created as a draft. Add future visit slots before publishing.');
      setDraft(emptyDraft()); setEditing(''); setDays([]); setOpens(''); setCloses('');
      props.refresh();
    } catch (error) {
      props.notify((editing ? 'Could not save destination. ' : createdSiteId !== editing ? 'Draft exists; finish its settings. ' : '') +
        (error instanceof Error ? error.message : 'Please retry.'));
      props.refresh();
    } finally { setLoading(false); }
  };
  const updateStatus = async (site: Site, next: string) => {
    setStatusBusy(site.id);
    try {
      if (next === 'published') {
        const [settingsResult, hoursResult, slotsResult] = await Promise.all([
          db().from('site_settings').select('site_id').eq('site_id', site.id).maybeSingle(),
          db().from('site_operating_hours').select('weekday').eq('site_id', site.id).eq('is_closed', false),
          db().from('site_slots').select('id').eq('site_id', site.id).eq('status', 'open').gte('slot_date', phToday()).limit(1),
        ]);
        if (settingsResult.error) throw settingsResult.error;
        if (hoursResult.error) throw hoursResult.error;
        if (slotsResult.error) throw slotsResult.error;
        if (!settingsResult.data || !hoursResult.data?.length || !slotsResult.data?.length) {
          throw new Error('A published destination needs fee settings, at least one open day, and one upcoming open slot.');
        }
      }
      const { error } = await db().from('tourism_sites').update({ status: next }).eq('id', site.id);
      if (error) throw error;
      props.notify('Destination status updated to ' + next.replace('_', ' ') + '.');
      props.refresh();
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not update destination status.'); }
    finally { setStatusBusy(''); }
  };

  const site = props.sites.find((item) => item.id === props.siteId) ?? null;
  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> TOURISM OFFICE · NETWORK</span>
    <h1>Places and <em>people.</em></h1><p>Create destination records, configure fees and hours, and publish when slots are ready.</p></div>
    <button className="btn btn-outline" onClick={() => props.go('Staff and reviews')}>Manage site staff <Users size={15}/></button></div>
    <div className="sites-admin-layout"><div className="sites-admin-list"><div className="card-heading"><span><small>DATABASE RECORDS</small><h3>Destinations</h3></span><span>{props.sites.length} total</span></div>
      {!props.sites.length && <div className="empty-inline">No destination records have been created.</div>}
      {props.sites.map((item) => <article className={props.siteId === item.id ? 'site-admin-row selected' : 'site-admin-row'} key={item.id}>
        <button className="site-admin-main" onClick={() => props.setSiteId(item.id)}><span><b>{item.name}</b><small>{item.address || item.category} · Adult {money(item.adult_fee)} / child {money(item.child_fee)}</small></span><span className={'status-tag ' + (item.status === 'published' ? 'paid' : '')}>{item.status.replace('_', ' ')}</span></button>
        <div className="site-admin-actions"><button className="link-btn" onClick={() => beginEdit(item)}>Edit</button>
          <select aria-label={'Change status for ' + item.name} value={item.status} disabled={statusBusy === item.id} onChange={(event) => void updateStatus(item, event.target.value)}>
            {['draft', 'published', 'temporarily_closed', 'inactive'].map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
          </select></div>
      </article>)}
    </div>
    <div className="sites-admin-form"><form className="form-card" onSubmit={(event) => void saveSite(event)}><div className="card-heading"><span><small>{editing ? 'EDIT DESTINATION' : 'NEW DESTINATION'}</small><h3>{editing ? 'Update details' : 'Create a draft site'}</h3></span><MapPin size={18}/></div>
      <label>Destination name<input required value={draft.name} onChange={(event) => change('name', event.target.value)} maxLength={160}/></label>
      <label>Category<input required value={draft.category} onChange={(event) => change('category', event.target.value)} maxLength={80} placeholder="Waterfall, spring, heritage site…"/></label>
      <label>Location or address<input value={draft.address} onChange={(event) => change('address', event.target.value)} maxLength={500}/></label>
      <label>Description<textarea value={draft.description} onChange={(event) => change('description', event.target.value)} maxLength={5000} rows={4}/></label>
      <div className="form-two"><label>Adult fee (PHP)<input type="number" min="0" step="0.01" required value={draft.adult_fee} onChange={(event) => change('adult_fee', event.target.value)}/></label>
        <label>Child fee (PHP)<input type="number" min="0" step="0.01" required value={draft.child_fee} onChange={(event) => change('child_fee', event.target.value)}/></label></div>
      <div className="form-two"><label>Max visitors / booking<input type="number" min="1" max="500" required value={draft.max_per_booking} onChange={(event) => change('max_per_booking', event.target.value)}/></label>
        <label>Cancellation cutoff (hours)<input type="number" min="0" max="8760" required value={draft.cancellation_cutoff_hours} onChange={(event) => change('cancellation_cutoff_hours', event.target.value)}/></label></div>
      {!editing && <><fieldset className="operating-days"><legend>Operating days</legend>{dayNames.map((day, weekday) => <label key={day}><input type="checkbox" checked={days.includes(weekday)} onChange={(event) => setDays(event.target.checked ? [...days, weekday] : days.filter((value) => value !== weekday))}/>{day.slice(0, 3)}</label>)}</fieldset>
        <div className="form-two"><label>Opens at<input type="time" value={opens} onChange={(event) => setOpens(event.target.value)} required/></label><label>Closes at<input type="time" value={closes} onChange={(event) => setCloses(event.target.value)} required/></label></div></>}
      <button className="btn btn-primary btn-wide" disabled={loading}>{loading ? 'Saving…' : editing ? 'Save destination' : 'Create destination draft'} <Check size={15}/></button>
      {editing && <button type="button" className="link-btn form-cancel" onClick={() => { setEditing(''); setDraft(emptyDraft()); }}>Cancel edit</button>}
      {!editing && <p className="field-hint">New sites stay unpublished until you add an open slot and publish them.</p>}
    </form></div></div>
    {site && <><div className="workspace-panel-select"><label>Manage destination photos <SiteSelector {...props}/></label></div><SiteImagesManager {...props}/></>}
  </section>;
}

function WalkInPage(props: Props) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotId, setSlotId] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '', adults: 1, children: 0, received: '', receipt: '' });
  const [ticketToken, setTicketToken] = useState('');
  const [reference, setReference] = useState('');
  const site = props.sites.find((item) => item.id === props.siteId);
  const total = site ? site.adult_fee * form.adults + site.child_fee * form.children : 0;
  useEffect(() => {
    if (!props.siteId) { setSlots([]); return; }
    let active = true;
    void loadSlots(props.siteId, phToday(), phToday()).then((rows) => {
      if (!active) return;
      setSlots(currentSlots(rows));
    }).catch((error) => props.notify(error instanceof Error ? error.message : 'Could not load today’s slots.'));
    return () => { active = false; };
  }, [props.siteId, props.notify]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!site || !slotId) { props.notify('Choose a current slot.'); return; }
    if (!form.name.trim() || (!form.email.trim() && !form.phone.trim())) {
      props.notify('Enter the visitor name and at least one contact method.'); return;
    }
    if (Number(form.received) !== total) { props.notify('Enter the exact server-calculated amount received.'); return; }
    props.setBusy(true);
    try {
      const { data, error } = await db().rpc('register_walk_in', {
        p_site_id: site.id,
        p_slot_id: slotId,
        p_name: form.name.trim(),
        p_adult_count: form.adults,
        p_child_count: form.children,
        p_email: form.email.trim() || null,
        p_phone: form.phone.trim() || null,
        p_received_amount: total,
        p_receipt_note: form.receipt.trim() || null,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string; booking_reference: string; guest_access_token: string };
      if (row.guest_access_token) localStorage.setItem('iliguide.access.' + row.booking_reference.toUpperCase(), row.guest_access_token);
      const result = await invokeFunction<{ token: string }>('ticket', {
        booking_reference: row.booking_reference,
        guest_access_token: row.guest_access_token || null,
      });
      setReference(row.booking_reference);
      setTicketToken(result.token);
      props.notify('Onsite payment and walk-in booking were recorded.');
      setForm({ name: '', email: '', phone: '', adults: 1, children: 0, received: '', receipt: '' });
      const refreshed = await loadSlots(site.id, phToday(), phToday());
      setSlots(currentSlots(refreshed));
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Could not register this walk-in.'); }
    finally { props.setBusy(false); }
  };
  const slotOptions = slots;
  return <section className="dashboard-page section-wrap"><div className="dash-header"><div><span className="eyebrow"><span className="eyebrow-line"/> GATEKEEPER · WALK-IN</span><h1>Welcome them <em>in.</em></h1><p>Record current-slot walk-ins and onsite payment for {site?.name ?? 'your assigned destination'}.</p></div><div className="header-actions"><SiteSelector {...props}/></div></div>
    {!site && <div className="empty-card"><ShieldCheck size={30}/><h3>No site assignment</h3><p>Ask the Tourism Office to assign your gatekeeper account.</p></div>}
    {site && <div className="walkin-layout"><form className="form-card" onSubmit={(event) => void submit(event)}><div className="card-heading"><span><small>TODAY · ASIA/MANILA</small><h3>Visitor details</h3></span><Users size={18}/></div>
      <label>Visit slot<select value={slotId} onChange={(event) => setSlotId(event.target.value)} required><option value="">Choose a current slot</option>{slotOptions.map((slot) => <option value={slot.slot_id} key={slot.slot_id}>{timeLabel(slot.starts_at)} – {timeLabel(slot.ends_at)} · {slot.remaining_capacity} spaces</option>)}</select></label>
      {!slotOptions.length && <p className="field-hint">No available slots are listed for today.</p>}
      <label>Visitor name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={120}/></label>
      <div className="form-two"><label>Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} maxLength={254}/></label><label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} maxLength={40}/></label></div>
      <div className="form-two"><label>Adults<input type="number" min="1" max={site.max_per_booking} value={form.adults} onChange={(event) => setForm({ ...form, adults: Math.max(1, Number(event.target.value)) })} required/></label><label>Children<input type="number" min="0" max={site.max_per_booking - form.adults} value={form.children} onChange={(event) => setForm({ ...form, children: Math.max(0, Number(event.target.value)) })} required/></label></div>
      <label>Amount received<input type="number" min="0" step="0.01" value={form.received} onChange={(event) => setForm({ ...form, received: event.target.value })} required/><small>Expected onsite payment: {money(total)}</small></label>
      <label>Receipt or payment note <span className="field-optional">optional</span><input value={form.receipt} onChange={(event) => setForm({ ...form, receipt: event.target.value })} maxLength={160}/></label>
      <div className="booking-total"><span>Server-calculated total<small>{form.adults} adults · {form.children} children</small></span><b>{money(total)}</b></div>
      <button className="btn btn-primary btn-wide" disabled={props.busy || !slotOptions.length}>{props.busy ? 'Saving…' : 'Record walk-in'} <Check size={16}/></button>
      <p className="secure-note"><ShieldCheck size={14}/> The database checks site assignment, slot time, capacity, and total.</p>
    </form><article className="qr-preview"><span className="eyebrow"><span className="eyebrow-line"/> WALK-IN TICKET</span>
      {ticketToken ? <><h3>{reference}</h3><div className="ticket-qr"><QRCodeSVG value={ticketToken} size={190} level="H" includeMargin/><small>Paid onsite · present this QR ticket at the gate.</small></div>
        <button className="link-btn" onClick={() => { void navigator.clipboard.writeText(reference); props.notify('Booking reference copied.'); }}>Copy booking reference</button></>
        : <div className="empty-card compact-empty"><TicketIcon size={28}/><h3>Ticket appears after registration</h3><p>Only a walk-in successfully recorded by the database receives a ticket.</p></div>}
    </article></div>}
  </section>;
}
