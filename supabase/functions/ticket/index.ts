import { authenticatedUser, clients, hmacSha256, json, preflight } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = clients(req);
    await authenticatedUser(req, user);
    const body = await req.json();
    const reference = String(body.booking_reference ?? '').trim();
    const accessToken = typeof body.guest_access_token === 'string' ? body.guest_access_token : null;
    if (!reference) return json({ error: 'Booking reference is required' }, 400);
    const signingSecret = Deno.env.get('TICKET_SIGNING_SECRET');
    if (!signingSecret || signingSecret.length < 32) {
      return json({ error: 'Ticket signing is not configured. Add a 32-character TICKET_SIGNING_SECRET.' }, 503);
    }

    const { data: rows, error } = await user.rpc('lookup_booking', {
      p_booking_reference: reference,
      p_guest_access_token: accessToken,
    });
    const booking = Array.isArray(rows) ? rows[0] : null;
    if (error || !booking) return json({ error: 'Booking not found or access could not be verified' }, 404);
    if (booking.payment_status !== 'paid' || !['confirmed', 'completed'].includes(booking.booking_status)) {
      return json({ error: 'A paid and confirmed booking is required for a ticket' }, 409);
    }

    const signature = await hmacSha256(signingSecret, booking.booking_id);
    const token = 'ILG1.' + booking.booking_id + '.' + signature;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hashHex = Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const { error: saveError } = await admin.rpc('set_booking_qr_hash', {
      p_booking_id: booking.booking_id,
      p_token_hash: '\\x' + hashHex,
    });
    if (saveError) {
      console.error('ticket hash save error', saveError.message);
      return json({ error: 'Could not issue ticket' }, 500);
    }
    return json({
      token,
      booking: {
        booking_id: booking.booking_id,
        booking_reference: booking.booking_reference,
        visitor_name: booking.visitor_name,
        visitor_count: booking.visitor_count,
        total_amount: booking.total_amount,
        currency: booking.currency,
        site_id: booking.site_id,
        site_name: booking.site_name,
        slot_date: booking.slot_date,
        starts_at: booking.starts_at,
        ends_at: booking.ends_at,
      },
    });
  } catch (error) {
    console.error('ticket', error);
    return json({ error: 'Could not issue ticket' }, 500);
  }
});
