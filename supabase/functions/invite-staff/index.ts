import { authenticatedUser, clients, json, preflight } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = clients(req);
    const actor = await authenticatedUser(req, user);
    if (!actor) return json({ error: 'Sign in before inviting staff' }, 401);
    const { data: actorProfile, error: actorError } = await admin
      .from('profiles').select('role, account_status').eq('id', actor.id).maybeSingle();
    if (actorError || !actorProfile || actorProfile.account_status !== 'active') {
      return json({ error: 'Active staff access is required' }, 403);
    }

    const body = await req.json();
    const email = String(body.email ?? '').trim().toLowerCase();
    const staffRole = String(body.staff_role ?? '');
    const siteId = body.site_id ? String(body.site_id) : null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400);
    if (!['gatekeeper', 'site_admin', 'tourism_office'].includes(staffRole)) {
      return json({ error: 'Visitor is the only role available through public registration' }, 400);
    }

    if (actorProfile.role === 'site_admin') {
      if (staffRole !== 'gatekeeper' || !siteId) return json({ error: 'Site administrators may invite gatekeepers only' }, 403);
      const { data: assignment } = await admin.from('staff_assignments')
        .select('id').eq('profile_id', actor.id).eq('site_id', siteId)
        .eq('staff_role', 'site_admin').eq('is_active', true).maybeSingle();
      if (!assignment) return json({ error: 'You cannot manage staff for that site' }, 403);
    } else if (actorProfile.role !== 'tourism_office') {
      return json({ error: 'Tourism Office access is required to provision this role' }, 403);
    }
    if ((staffRole === 'tourism_office' && siteId) || (staffRole !== 'tourism_office' && !siteId)) {
      return json({ error: 'Choose a site for site staff' }, 400);
    }

    const { data: existingProfile } = await admin.from('profiles')
      .select('id, role, account_status').eq('email', email).maybeSingle();
    if (existingProfile && existingProfile.role !== 'visitor') {
      return json({ error: 'That account already has a staff role' }, 409);
    }
    if (existingProfile && existingProfile.account_status !== 'active') {
      return json({ error: 'That account is not active' }, 409);
    }

    const { data: invitation, error: inviteRowError } = await admin.from('staff_invitations')
      .insert({
        email,
        staff_role: staffRole,
        site_id: siteId,
        invited_by: actor.id,
      })
      .select('id, email, staff_role, site_id, expires_at')
      .single();
    if (inviteRowError) return json({ error: 'An active invitation may already exist for this email' }, 409);

    if (existingProfile) {
      const { error: profileUpdateError } = await admin.from('profiles')
        .update({ role: staffRole }).eq('id', existingProfile.id);
      if (profileUpdateError) {
        await admin.from('staff_invitations').update({ status: 'revoked' }).eq('id', invitation.id);
        return json({ error: 'Could not update the existing visitor role' }, 500);
      }
      if (siteId) {
        const { error: assignmentError } = await admin.from('staff_assignments').upsert({
          profile_id: existingProfile.id,
          site_id: siteId,
          staff_role: staffRole,
          assigned_by: actor.id,
          is_active: true,
        }, { onConflict: 'profile_id,site_id' });
        if (assignmentError) {
          await admin.from('staff_invitations').update({ status: 'revoked' }).eq('id', invitation.id);
          return json({ error: 'Could not assign the existing account to this site' }, 500);
        }
      }
      await admin.from('staff_invitations').update({
        status: 'accepted',
        accepted_profile_id: existingProfile.id,
      }).eq('id', invitation.id);
      return json({ invitation, existing_account: true });
    }

    const appBaseUrl = Deno.env.get('APP_BASE_URL');
    const inviteOptions = appBaseUrl ? { redirectTo: appBaseUrl.replace(/\/+$/, '') + '/' } : undefined;
    const { data: invited, error: authInviteError } = await admin.auth.admin.inviteUserByEmail(email, inviteOptions);
    if (authInviteError) {
      await admin.from('staff_invitations').update({ status: 'revoked' }).eq('id', invitation.id);
      return json({ error: 'Could not send the invitation. Check Supabase Auth email settings and try again.' }, 502);
    }
    const invitedProfileId = invited.user?.id;
    if (!invitedProfileId) return json({ error: 'Invitation was sent but no account id was returned' }, 502);
    const { error: roleError } = await admin.from('profiles')
      .update({ role: staffRole, account_status: 'active' }).eq('id', invitedProfileId);
    if (roleError) {
      console.error('invited profile provisioning error', roleError.message);
      return json({ error: 'Invitation was sent but the staff account role could not be assigned' }, 503);
    }
    if (siteId) {
      const { error: assignmentError } = await admin.from('staff_assignments').upsert({
        profile_id: invitedProfileId,
        site_id: siteId,
        staff_role: staffRole,
        assigned_by: actor.id,
        is_active: true,
      }, { onConflict: 'profile_id,site_id' });
      if (assignmentError) {
        console.error('invited assignment provisioning error', assignmentError.message);
        return json({ error: 'Invitation was sent but the site assignment could not be created' }, 503);
      }
    }
    return json({ invitation, existing_account: false });
  } catch (error) {
    console.error('invite-staff', error);
    return json({ error: 'Could not invite staff' }, 500);
  }
});
