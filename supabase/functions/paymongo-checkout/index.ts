import { authenticatedUser, clients, json, preflight } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = clients(req);
    await authenticatedUser(req, user);
    const body = await req.json();
    const bookingReference = String(body.booking_reference ?? '').trim();
    const guestAccessToken = typeof body.guest_access_token === 'string' ? body.guest_access_token : null;
    if (!bookingReference) return json({ error: 'Booking reference is required' }, 400);

    const { data: bookingRows, error: lookupError } = await user.rpc('lookup_booking', {
      p_booking_reference: bookingReference,
      p_guest_access_token: guestAccessToken,
    });
    const booking = Array.isArray(bookingRows) ? bookingRows[0] : null;
    if (lookupError || !booking) return json({ error: 'Booking not found or access could not be verified' }, 404);
    if (booking.booking_status !== 'awaiting_payment' || new Date(booking.hold_expires_at).getTime() <= Date.now()) {
      return json({ error: 'The ten-minute booking hold has expired' }, 409);
    }
    if (Number(booking.total_amount) <= 0) return json({ error: 'This booking does not require online payment' }, 400);

    const secretKey = Deno.env.get('PAYMONGO_SECRET_KEY');
    const appBaseUrl = Deno.env.get('APP_BASE_URL');
    if (!secretKey || !appBaseUrl) {
      return json({ error: 'Payment checkout is not configured. Add PAYMONGO_SECRET_KEY and APP_BASE_URL to Supabase Function secrets.' }, 503);
    }

    const { data: site } = await admin.from('tourism_sites').select('name').eq('id', booking.site_id).maybeSingle();
    const idempotencyKey = 'iliguide-checkout-' + booking.booking_id;
    let { data: payment, error: paymentReadError } = await admin
      .from('payments')
      .select('id, checkout_session_id, checkout_url, payment_status')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (paymentReadError) return json({ error: 'Could not prepare payment' }, 500);
    if (payment?.checkout_session_id && payment.checkout_url) {
      return json({ checkout_url: payment.checkout_url, reused: true });
    }

    if (!payment) {
      const { data: created, error: createError } = await admin
        .from('payments')
        .insert({
          booking_id: booking.booking_id,
          provider: 'paymongo',
          idempotency_key: idempotencyKey,
          amount: booking.total_amount,
          currency: 'PHP',
          payment_status: 'pending',
        })
        .select('id, checkout_session_id, checkout_url, payment_status')
        .single();
      if (createError) {
        const { data: existing } = await admin
          .from('payments')
          .select('id, checkout_session_id, checkout_url, payment_status')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (!existing) return json({ error: 'Could not reserve a payment attempt' }, 500);
        payment = existing;
      } else {
        payment = created;
      }
    }
    if (payment.checkout_session_id && payment.checkout_url) {
      return json({ checkout_url: payment.checkout_url, reused: true });
    }
    if (payment.payment_status === 'failed') {
      return json({ error: 'This payment attempt failed. Create a new booking hold to try again.' }, 409);
    }

    const baseUrl = appBaseUrl.replace(/\/+$/, '');
    const amountMinor = Math.round(Number(booking.total_amount) * 100);
    const methods = (Deno.env.get('PAYMONGO_PAYMENT_METHODS') ?? 'gcash,qrph,card')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    const response = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(secretKey + ':'),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        data: {
          attributes: {
            line_items: [{
              name: (site?.name ?? 'Iliguide admission').slice(0, 120),
              amount: amountMinor,
              currency: 'PHP',
              quantity: 1,
            }],
            payment_method_types: methods,
            success_url: baseUrl + '/?payment=success&reference=' + encodeURIComponent(booking.booking_reference),
            cancel_url: baseUrl + '/?payment=cancelled&reference=' + encodeURIComponent(booking.booking_reference),
            reference_number: booking.booking_reference,
            send_email_receipt: Boolean(booking.visitor_email),
            metadata: { iliguide_booking_id: booking.booking_id },
          },
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    const sessionId = result?.data?.id;
    const checkoutUrl = result?.data?.attributes?.checkout_url;
    if (!response.ok || !sessionId || !checkoutUrl) {
      if (response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429) {
        await admin.from('payments').update({ payment_status: 'failed' }).eq('id', payment.id);
      }
      return json({ error: 'PayMongo could not create checkout. Try again or check payment provider configuration.' }, 502);
    }

    const { error: saveError } = await admin.from('payments').update({
      checkout_session_id: sessionId,
      provider_reference: sessionId,
      checkout_url: checkoutUrl,
    }).eq('id', payment.id);
    if (saveError) return json({ error: 'Checkout was created but could not be linked to the booking. Retry this request.' }, 503);
    return json({ checkout_url: checkoutUrl, reused: false });
  } catch (error) {
    console.error('paymongo-checkout', error);
    return json({ error: 'Could not create checkout' }, 500);
  }
});
