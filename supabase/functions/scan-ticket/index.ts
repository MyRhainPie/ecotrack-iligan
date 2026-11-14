import { authenticatedUser, clients, constantTimeEqual, hmacSha256, json, preflight } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { user } = clients(req);
    const actor = await authenticatedUser(req, user);
    if (!actor) return json({ error: 'Staff sign-in is required' }, 401);
    const signingSecret = Deno.env.get('TICKET_SIGNING_SECRET');
    if (!signingSecret || signingSecret.length < 32) return json({ error: 'Ticket scanning is not configured' }, 503);

    const body = await req.json();
    const token = String(body.token ?? '');
    const siteId = String(body.site_id ?? '');
    const match = /^ILG1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(token);
    if (!match || !/^[0-9a-f-]{36}$/i.test(siteId)) return json({ error: 'Invalid ticket' }, 400);
    const expected = await hmacSha256(signingSecret, match[1].toLowerCase());
    if (!constantTimeEqual(match[2].toLowerCase(), expected)) return json({ error: 'Invalid ticket signature' }, 400);

    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hashHex = Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const { data, error } = await user.rpc('scan_ticket', {
      p_booking_id: match[1].toLowerCase(),
      p_token_hash: '\\x' + hashHex,
      p_site_id: siteId,
      p_device: { user_agent: (req.headers.get('user-agent') ?? '').slice(0, 240) },
    });
    if (error) {
      console.error('scan authorization error', error.message);
      return json({ error: 'This gatekeeper cannot scan tickets for that site' }, 403);
    }
    return json({ result: Array.isArray(data) ? data[0] : data });
  } catch (error) {
    console.error('scan-ticket', error);
    return json({ error: 'Could not scan ticket' }, 500);
  }
});
