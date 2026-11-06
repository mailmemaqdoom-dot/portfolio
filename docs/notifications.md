# Administrator email notifications: architecture (not deployed)

Status: **design only.** Nothing in this document is deployed. No email provider is configured,
no sender identity is verified, and no project-level authentication or SMTP setting has been changed.
Implementation starts only after the decisions in "Decisions needed" are approved.

## What exists today

- Supabase Auth sends its own account emails (password reset and sign-in link) through the project's
  default email service. Those are not CMS notifications, and they are not customised.
- The database records content, media and résumé changes in `audit_log` (a trigger on each table).
  This is the source of truth for content events.
- No notification code, function, table or provider key exists in the repository or the project.

## Architecture

### 1. Event sources

| Category | Source | Recorded by |
|---|---|---|
| Content saved (Hero, Career, Achievements, Contact, SEO, sections) | `audit_log` row written by the table trigger | Database |
| Media uploaded, deleted, alt text changed | `audit_log` (`media_assets`) | Database |
| Résumé draft uploaded, replaced, archived | `audit_log` (`media_assets`, `replace_resume_draft`) | Database |
| Password changed | Dashboard, after `updateUser` succeeds | Client, then server call |
| Password recovery requested / completed | Dashboard recovery flow, after success | Client, then server call |
| Sign-in and sign-out | Dashboard, after the session event | Client, then server call |
| Failed sign-in attempts | Requires a server-side Auth hook (not configured) | Not available yet |
| Publishing succeeded / failed | Not built (no publishing step exists) | Not applicable |

Database events are reliable because the trigger runs in the same transaction as the change.
Dashboard events are best effort: a browser can close before the call is sent. Security events are
therefore also flagged in `audit_log` where they can be (password change, recovery), so the record
does not depend on the email call succeeding.

### 2. Delivery: one server-side function

- A Supabase Edge Function, `notify`, receives a notification request from the dashboard.
- The caller's own session token is verified. The function checks `is_admin()` for that caller and
  rejects everyone else. It is not public.
- The email provider's API key is stored as a function secret in Supabase. It is never sent to the
  browser and never appears in the repository.
- The function renders the email. It includes: event title, date and time in East Africa Time (UTC+3),
  category, section or asset name, action, and success or failure. It includes a link to the dashboard.
- It never includes passwords, tokens, session data, or private media URLs. Password emails say only
  that the password was changed.

### 3. Idempotency and retries

- The dashboard creates an `event_id` (UUID) for each event before the action runs.
- The delivery record is unique on `(event_id, channel)`. A retry with the same `event_id` returns the
  existing result and sends nothing new.
- Database-originated events use the `audit_log` row id as their `event_id`.

### 4. Failure isolation

- A notification is always sent after the content or password change has committed. It never runs
  inside that change.
- If delivery fails, the failure is recorded in the delivery table and shown in the dashboard. The
  saved content or the new password is not rolled back and is not reported as failed.
- Delivery status is recorded separately from the audited change.

### 5. Preferences and critical alerts

- Preferences are stored per category for the administrator.
- Password changes, password recovery, and account-security changes are **critical**. The server
  enforces that they stay enabled, even if an ordinary content category is turned off.
- A test email is sent by an administrator-only request to the same function, and its result is shown.

### 6. Rate limiting

- Failed sign-in alerts need a server-side Auth hook. Until that is approved, they are reported as
  "not available", not simulated.
- Other notifications are batched per `event_id`, so a burst of saves from one edit session does not
  produce one email per field.

## Proposed database objects (NOT applied)

Both tables need your approval before they are created. The sketch below is for review only.

```sql
-- Delivery log: one row per notification attempt. Admin-only, like the other CMS tables.
create table public.notification_log (
  id bigint generated always as identity primary key,
  event_id uuid not null,
  channel text not null default 'email' check (channel in ('email')),
  category text not null check (category in ('content','media','resume','publishing','account_security')),
  status text not null check (status in ('queued','sent','failed','skipped')),
  error_code text,
  created_at timestamptz not null default now(),
  unique (event_id, channel)
);

-- Preferences: one row per category. Critical categories are enforced in the function.
create table public.notification_preferences (
  category text primary key check (category in ('content','media','resume','publishing','account_security')),
  enabled boolean not null default true
);
```

RLS for both: enabled; a single `is_admin()` policy for select and insert; no anonymous grants.
The account-security row must always be enabled. The function enforces that, and so does a check
constraint in the final version.

## Decisions needed before anything is built

1. **Email provider.** Choose one: Resend, Postmark, SendGrid or Brevo. You create the account and
   store the API key as a Supabase function secret.
2. **Sender identity.** A domain you control with verified DNS records, or your Gmail address as an
   interim. A Gmail sender is limited and may land in spam. Notifications would come from that address.
3. **The two tables** above, and the migration that creates them.
4. **Deploying `notify`** as an Edge Function.
5. **Failed sign-in alerts:** a project-level Auth hook. This is a project setting change.
6. **Password-recovery alerts from Supabase's own emails:** a custom SMTP setting. This is a
   project setting change, and it also affects Supabase's own sign-in and reset emails.

Until 1 to 4 are approved, the dashboard will report notifications as "not configured". It will not
claim that they are working.

## Test plan (after approval)

- Content save generates one notification with the correct section name; a failed save generates none.
- A password change generates a security notification, and the password never appears in the email,
  the logs or the browser.
- A simulated provider failure leaves the saved content and the new password unchanged and records
  `failed`.
- A retry with the same `event_id` sends nothing new.
- Turning off a content category does not affect security notifications.
- The test email works only for an administrator and reports the provider's response.
- Checks for credentials: no provider key in browser code, the repository or the logs.
