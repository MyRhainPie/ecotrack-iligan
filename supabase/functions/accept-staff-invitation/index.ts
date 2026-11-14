import { authenticatedUser, clients, json, preflight } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = clients(req);
    const actor = await authenticatedUser(req, user);
    if (!actor?.email) return json({ error: 'Sign in to accept staff invitations' }, 401);
    const email = actor.email.toLowerCase();
    const { data: profile, error: profileError } = await admin.from('profiles')
      .select('role,account_status,email').eq('id', actor.id).maybeSingle();
    if (profileError || !profile || profile.account_status !== 'active' || profile.role === 'visitor') {
      return json({ accepted: 0 });
    }
    const { data: pending, error: invitationError } = await admin.from('staff_invitations')
      .select('id').eq('email', email).eq('staff_role', profile.role).eq('status', 'pending');
    if (invitationError) return json({ error: 'Could not verify the staff invitation' }, 500);
    if (!pending?.length) return json({ accepted: 0 });
    const { error: updateError } = await admin.from('staff_invitations').update({
      status: 'accepted',
      accepted_profile_id: actor.id,
    }).in('id', pending.map((row) => row.id));
    if (updateError) return json({ error: 'Could not accept the staff invitation' }, 500);
    return json({ accepted: pending.length });
  } catch (error) {
    console.error('accept-staff-invitation', error);
    return json({ error: 'Could not accept staff invitation' }, 500);
  }
});
