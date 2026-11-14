import { clients, constantTimeEqual, hmacSha256, json, preflight } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const secret = Deno.env.get('PAYMONGO_WEBHOOK_SECRET');
    if (!secret) return json({ error: 'Webhook verification is not configured' }, 503);
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('Paymongo-Signature');
    if (!signatureHeader) return json({ error: 'Missing PayMongo signature' }, 401);

    const parts = Object.fromEntries(signatureHeader.split(',').map((part) => {
      const [key, ...value] = part.trim().split('=');
      return [key, value.join('=')];
    }));
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
      return json({ error: 'Webhook timestamp is outside the accepted window' }, 401);
    }
    const envelope = JSON.parse(rawBody);
    const attributes = envelope?.data?.attributes;
    const liveMode = attributes?.livemode === true;
    const receivedSignature = liveMode ? parts.li : parts.te;
    const expectedSignature = await hmacSha256(secret, String(timestamp) + '.' + rawBody);
    if (!receivedSignature || !constantTimeEqual(receivedSignature.toLowerCase(), expectedSignature)) {
      return json({ error: 'Invalid PayMongo signature' }, 401);
    }

    const eventId = envelope?.data?.id;
    const eventType = attributes?.type;
    const session = attributes?.data;
    if (!eventId || !eventType || !attributes?.data) {
      return json({ received: true, processed: false });
    }
    const { admin } = clients();
    if (eventType === 'payment.refund.updated') {
      const refundResource = attributes.data;
      const refundId = refundResource?.id;
      const refundAttrs = refundResource?.attributes ?? {};
      const status = refundAttrs.status;
      if (!refundId || !['processing', 'succeeded', 'failed'].includes(status)) {
        return json({ error: 'Invalid PayMongo refund event' }, 400);
      }
      const { data: refund, error: refundLookupError } = await admin.from('refunds')
        .select('id, booking_id, payment_id, refund_status')
        .eq('provider_refund_id', refundId).maybeSingle();
      if (refundLookupError) return json({ error: 'Could not link refund event' }, 500);
      if (!refund || !refund.payment_id) return json({ received: true, processed: false });

      const { data: payment, error: paymentLookupError } = await admin.from('payments')
        .select('amount').eq('id', refund.payment_id).eq('provider', 'paymongo').maybeSingle();
      if (paymentLookupError || !payment) return json({ error: 'Refund payment record not found' }, 500);
      const { error: eventError } = await admin.from('payment_transactions').insert({
        payment_id: refund.payment_id,
        provider: 'paymongo',
        provider_event_id: eventId,
        event_type: eventType,
        amount_minor: refundAttrs.amount,
        currency: refundAttrs.currency,
        payload: { event_id: eventId, refund_id: refundId, status, livemode: liveMode },
      });
      if (eventError?.code === '23505') return json({ received: true, duplicate: true });
      if (eventError) return json({ error: 'Refund event could not be recorded' }, 500);
      const { error: updateError } = await admin.from('refunds').update({
        refund_status: status,
        processed_at: status === 'succeeded' ? new Date().toISOString() : null,
        failure_message: status === 'failed' ? 'PayMongo reports the refund failed' : null,
      }).eq('id', refund.id);
      if (updateError) return json({ error: 'Refund event was recorded but its status could not be saved' }, 500);
      if (status === 'succeeded') {
        const { data: completedRefunds, error: totalError } = await admin.from('refunds')
          .select('amount').eq('payment_id', refund.payment_id).eq('refund_status', 'succeeded');
        if (totalError) return json({ error: 'Refund was recorded but payment totals could not be reconciled' }, 500);
        const returned = (completedRefunds ?? []).reduce((sum, item) => sum + Number(item.amount), 0);
        if (returned >= Number(payment.amount)) {
          await admin.from('bookings').update({ payment_status: 'refunded' }).eq('id', refund.booking_id);
        }
      }
      return json({ received: true, processed: true });
    }
    if (!['checkout_session.payment.paid', 'checkout_session.payment.failed'].includes(eventType) || !session?.id) {
      return json({ received: true, processed: false });
    }
    const payments = Array.isArray(session?.attributes?.payments) ? session.attributes.payments : [];
    const expectedStatus = eventType.endsWith('.paid') ? 'paid' : 'failed';
    const providerPayment = payments.find((item: { attributes?: { status?: string } }) => item.attributes?.status === expectedStatus);
    if (!providerPayment) return json({ error: 'Checkout event has no matching payment resource' }, 400);
    const paymentAttrs = providerPayment.attributes ?? {};
    const { data, error } = await admin.rpc('process_paymongo_checkout_event', {
      p_event_id: eventId,
      p_event_type: eventType,
      p_checkout_session_id: session.id,
      p_provider_payment_id: providerPayment.id,
      p_amount_minor: paymentAttrs.amount,
      p_currency: paymentAttrs.currency,
      p_payload: {
        event_id: eventId,
        event_type: eventType,
        livemode: liveMode,
        checkout_session_id: session.id,
        provider_payment_id: providerPayment.id,
      },
    });
    if (error) {
      console.error('payment webhook database error', error.message);
      return json({ error: 'Payment event could not be recorded' }, 500);
    }
    return json({ received: true, result: data });
  } catch (error) {
    console.error('paymongo-webhook', error);
    return json({ error: 'Could not process payment webhook' }, 500);
  }
});
