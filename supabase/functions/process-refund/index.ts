import { authenticatedUser, clients, json, preflight } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = clients(req);
    const actor = await authenticatedUser(req, user);
    if (!actor) return json({ error: 'Sign in to process a refund' }, 401);
    const { data: profile } = await admin.from('profiles')
      .select('role, account_status').eq('id', actor.id).maybeSingle();
    if (!profile || profile.account_status !== 'active') return json({ error: 'Active staff access is required' }, 403);
    const body = await req.json();
    const refundId = String(body.refund_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(refundId)) return json({ error: 'Invalid refund request' }, 400);

    const { data: refund } = await admin.from('refunds')
      .select('id, booking_id, payment_id, amount, refund_status')
      .eq('id', refundId).maybeSingle();
    if (!refund) return json({ error: 'Refund not found' }, 404);
    const { data: booking } = await admin.from('bookings')
      .select('site_id, payment_status').eq('id', refund.booking_id).maybeSingle();
    if (!booking) return json({ error: 'Booking not found' }, 404);
    if (profile.role === 'site_admin') {
      const { data: assignment } = await admin.from('staff_assignments')
        .select('id').eq('profile_id', actor.id).eq('site_id', booking.site_id)
        .eq('staff_role', 'site_admin').eq('is_active', true).maybeSingle();
      if (!assignment) return json({ error: 'You cannot process refunds for this site' }, 403);
    } else if (profile.role !== 'tourism_office') {
      return json({ error: 'Tourism staff access is required' }, 403);
    }

    if (refund.refund_status === 'succeeded') return json({ refund, reused: true });
    if (!['queued', 'failed', 'processing'].includes(refund.refund_status)) {
      return json({ error: 'This refund requires manual processing' }, 409);
    }
    const { data: payment } = await admin.from('payments')
      .select('provider, provider_payment_id').eq('id', refund.payment_id).maybeSingle();
    if (payment?.provider !== 'paymongo' || !payment.provider_payment_id) {
      await admin.from('refunds').update({ refund_status: 'manual_required' }).eq('id', refund.id);
      return json({ error: 'This payment must be refunded manually' }, 409);
    }
    const secret = Deno.env.get('PAYMONGO_SECRET_KEY');
    if (!secret) return json({ error: 'Add PAYMONGO_SECRET_KEY to Supabase Function secrets' }, 503);

    await admin.from('refunds').update({ refund_status: 'processing' }).eq('id', refund.id);
    const response = await fetch('https://api.paymongo.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(secret + ':'),
        'Content-Type': 'application/json',
        'Idempotency-Key': refund.id,
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round(Number(refund.amount) * 100),
            payment_id: payment.provider_payment_id,
            reason: 'others',
            notes: 'Iliguide booking cancellation ' + refund.booking_id,
          },
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    const providerRefundId = result?.data?.id;
    const providerStatus = result?.data?.attributes?.status;
    if (!response.ok || !providerRefundId || !providerStatus) {
      await admin.from('refunds').update({
        refund_status: 'failed',
        failure_message: 'PayMongo returned HTTP ' + response.status,
      }).eq('id', refund.id);
      return json({ error: 'PayMongo could not process the refund. Review the provider response in its dashboard.' }, 502);
    }
    const status = providerStatus === 'succeeded' ? 'succeeded'
      : ['pending', 'processing'].includes(providerStatus) ? 'processing' : 'failed';
    const { data: updated, error: saveError } = await admin.from('refunds').update({
      provider_refund_id: providerRefundId,
      refund_status: status,
      processed_at: status === 'succeeded' ? new Date().toISOString() : null,
      failure_message: status === 'failed' ? 'PayMongo refund failed' : null,
    }).eq('id', refund.id).select('*').single();
    if (saveError) return json({ error: 'Refund was submitted but its status could not be saved' }, 503);
    if (status === 'succeeded') {
      await admin.from('bookings').update({ payment_status: 'refunded' }).eq('id', refund.booking_id);
    }
    return json({ refund: updated });
  } catch (error) {
    console.error('process-refund', error);
    return json({ error: 'Could not process refund' }, 500);
  }
});
