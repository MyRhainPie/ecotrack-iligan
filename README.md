# Iliguide

Responsive visitor booking and destination operations for Iligan City. The React application reads real Supabase records; it does not seed sample destinations or fake bookings.

## Run locally

1. Install Node.js 20+ and pnpm.
2. Run `pnpm install`.
3. Copy `.env.example` to `.env.local`.
4. Add the Supabase project URL and **publishable key** to `.env.local`:

   ```env
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```

   Older projects can use `VITE_SUPABASE_ANON_KEY`. Never put a Supabase service role key, PayMongo secret, or webhook secret in a `VITE_` variable.
5. Run `pnpm dev` and open the printed local URL.

The linked Supabase project already has the four migrations in `supabase/migrations`. For a different empty project, apply them in filename order using the Supabase CLI or SQL editor.

## First account and destination

Public registration creates a visitor only. After registering and verifying your account, replace the email in `supabase/bootstrap_tourism_office.sql` and run that one-time script in the linked project's SQL Editor to make your account the first Tourism Office user. Do not run it with the placeholder email.

Sign in as Tourism Office to create destination records, fees, and operating days. New sites start as drafts. Add future visit slots, then publish. The visitor site shows an empty state until a destination is published.

## Edge Functions and payment setup

The Edge Functions are in `supabase/functions`; `supabase/config.toml` documents their JWT settings. The linked Supabase project already has all seven functions deployed. Deploy again after changing function code, or deploy them to another project with the Supabase CLI:

```powershell
supabase functions deploy paymongo-checkout
supabase functions deploy paymongo-webhook
supabase functions deploy ticket
supabase functions deploy scan-ticket
supabase functions deploy invite-staff
supabase functions deploy accept-staff-invitation
supabase functions deploy process-refund
```

Set these **server-side Edge Function secrets** in the Supabase Dashboard or with `supabase secrets set`:

- `APP_BASE_URL`: public application origin used for checkout return URLs.
- `TICKET_SIGNING_SECRET`: random value with at least 32 characters.
- `PAYMONGO_SECRET_KEY`: PayMongo secret API key.
- `PAYMONGO_WEBHOOK_SECRET`: signing secret shown when the webhook endpoint is created.
- `PAYMONGO_PAYMENT_METHODS`: optional comma-separated method list; default is `gcash,qrph,card`.

Create a PayMongo webhook at `https://<project-ref>.supabase.co/functions/v1/paymongo-webhook` and subscribe it to `checkout_session.payment.paid`, `checkout_session.payment.failed`, and `payment.refund.updated`. Copy its endpoint secret into `PAYMONGO_WEBHOOK_SECRET`. The frontend never treats the checkout redirect as payment confirmation.

The guest ticket and checkout functions accept requests without a user JWT because they validate the private guest access code through the database. Scanner, invitation, and refund functions require an authenticated JWT. The webhook verifies PayMongo's signature.

## Current behavior

- Visitor registration, sign-in, password reset, profile, avatar, and notifications use Supabase Auth and Storage.
- Public destination pages use published site details, fee settings, uploaded images, live slot capacity, and published review aggregates.
- Booking holds last ten minutes and use database-side fee and capacity checks. Free bookings confirm through a database RPC. Paid bookings redirect to PayMongo Checkout and become confirmed only after a signed webhook.
- Guest bookings can be recovered with both the booking reference and private access code.
- Paid tickets contain an opaque signed QR token. Gatekeeper scans and manual lookups record entry and exit in the database.
- Walk-ins record the onsite payment amount and validate current slot, capacity, and staff assignment.
- Site teams manage operating hours, visit slots, closures, gatekeeper assignments, reviews, cancellations, refunds, and image uploads according to row-level security.
- Reports and audit activity come from database records and are scoped to staff permissions.
- The PWA caches its app shell and same-origin assets for offline startup. Supabase data still needs an internet connection.

## Build

```powershell
pnpm run build
```
