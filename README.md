# BLISS Manager

Shop management app for BLISS Matcha & Beyond: clock-in, scheduling and auto-scheduling, availability,
nightly inventory counts, orders with screenshot reading and blind receiving, prep / closing / deep-cleaning
photos, training, evaluations, payroll and owner profit reports.

It is a static web app (no build step) backed by [Supabase](https://supabase.com):

| Part | Where |
|---|---|
| Pages | `index.html` (app), `backend.js` (sign-in + data bridge), `config.js` (public project settings) |
| Database, access rules, photo storage | `supabase/schema.sql` |
| Claude AI (screenshot reading, auto-scheduling) | `supabase/functions/ai/index.ts` |

## Set up (one time)

1. **Database.** Supabase → SQL Editor → New query → paste all of `supabase/schema.sql` → Run.
2. **Sign-in emails with a code.** Supabase → Authentication → Emails → *Magic Link* template. Replace the body with:
   ```html
   <h2>Your BLISS sign-in code</h2>
   <p>Enter this code in the app: <strong style="font-size:24px">{{ .Token }}</strong></p>
   <p>Or <a href="{{ .ConfirmationURL }}">tap here to sign in</a>.</p>
   ```
3. **Site address.** Supabase → Authentication → URL Configuration → *Site URL*: your Vercel address
   (for example `https://bliss-app.vercel.app`). Add the same address under *Redirect URLs*.
4. **Claude AI.** Supabase → Edge Functions → Deploy a new function → *Via Editor* → name `ai` → paste
   `supabase/functions/ai/index.ts` → Deploy. Then Edge Functions → *Secrets* → add `ANTHROPIC_API_KEY`
   with your key from console.anthropic.com.
5. **Team sign-in accounts.** Edge Functions → Deploy a new function → *Via Editor* → name `team` → paste
   `supabase/functions/team/index.ts` → Deploy. When a manager or owner adds someone's email in Team → People,
   this creates their sign-in account, so only people on the team can get a sign-in code.
6. **Website.** vercel.com → Add New → Project → import `bliss-app` → Framework preset *Other* → Deploy.
   No build command or environment variables are needed.

## First sign-in

1. Open the Vercel address, enter the owner email, type the 6-digit code from the email.
2. Choose **I'm a business owner — set up a new business**, enter the name and store locations.
3. To bring over data from the earlier Claude version, run the private import SQL in the SQL Editor
   (it is not stored in this repository).
4. Add staff in **Team → People** with their email. When they sign in with that email they are linked
   automatically. Role *Manager* gets the manager view for their store; everyone else gets the staff view.

## Install on a phone

Open the address in Safari (iPhone) or Chrome (Android) → Share / menu → **Add to Home Screen**.

## Roles

| | Owner | Manager | Staff |
|---|---|---|---|
| Profit, fixed costs, sales, both stores | ✓ | | |
| Stock, orders, photo review, schedule, wages, team | ✓ | own store | |
| Clock in, counts, photos, receiving, availability | ✓ | ✓ | ✓ |

Access is enforced in the database (row level security in `schema.sql`), not just hidden in the page.

## Shift cover (someone can't come)

How it works:
- Staff tap **Can't make it** on a shift in My shifts, or a manager opens the shift and taps **Mark can't come**. They can also ask one coworker to swap.
- Every shift has a **backup**: someone at the same store who is free for the whole shift (from availability). Shifts with no backup are flagged in Schedule. The backup is asked first.
- Everyone who can cover, plus managers and owners, gets a notification. They tap **I can take it** (or reply YES to a text, or press 1 on a call).
- **Within the urgent window** (default 4 hours before the shift), the first eligible person to accept gets the shift and the manager is told. **Before that**, the manager picks from the people who offered. Swaps always need a manager's OK.
- If no one offers: texts go out after 15 minutes and calls after 30. You can change both times. Each channel has its own on/off switch in Team → Settings → Shift cover.

### 1. Database
Run `supabase/schema.sql` again (SQL Editor → paste → Run).

### 2. The `cover` function
Edge Functions → Deploy a new function → Via Editor → name it exactly `cover` → paste `supabase/functions/cover/index.ts` → Deploy.
Then open the function → **Details** → turn **off "Verify JWT"** → Save. (Twilio and the timer can't sign in. The function checks sign-ins, Twilio signatures and the timer secret itself.)

### 3. Secrets (Edge Functions → Secrets)
| Name | Value |
|---|---|
| `APP_URL` | `https://bliss-app-one.vercel.app` |
| `CRON_SECRET` | any long random text (also used in step 4) |
| `SMTP_USER`, `SMTP_PASS` | for email: bliss98olive@gmail.com and its Gmail app password |
| `SMTP_NAME` | optional sender name, e.g. `BLISS: Matcha and Beyond` |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | for texts and calls (see step 5) |

Phone notifications need no setup: the signing key is created automatically the first time someone turns notifications on.

### 4. The timer (texts/calls when no one replies)
Database → Extensions: turn on **pg_cron** and **pg_net**. Then in SQL Editor run this, with your own secret in place of `PUT-CRON-SECRET-HERE`:
```sql
select cron.schedule('bliss-cover', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://vylynuuzeniqmyorrefl.supabase.co/functions/v1/cover',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PUT-CRON-SECRET-HERE'),
    body := '{"action":"tick"}'::jsonb)
$$);
```

### 5. Texts and calls (Twilio, optional)
1. Sign up at twilio.com and buy a local phone number (about $1.15/month).
2. US texting needs registration: Messaging → Regulatory Compliance → **A2P 10DLC** (Sole Proprietor or Low-Volume Standard brand, about $4 + $15 one time; approval takes days). Calls work without it.
3. Copy the **Account SID**, **Auth Token** and the number (like `+18605550123`) into the secrets in step 3.
4. Phone Numbers → your number → Messaging → **A message comes in** → Webhook, HTTP POST:
   `https://vylynuuzeniqmyorrefl.supabase.co/functions/v1/cover?a=sms`
5. In the app: Team → Settings → Shift cover → turn on Text message / Automatic phone call, and use **Test text** / **Test call**.

Staff need a phone number in Team → People for texts and calls.

### Phone notifications on iPhone
iPhone only allows them for apps added to the Home Screen: Safari → Share → **Add to Home Screen**, open BLISS from the Home Screen, then tap **Turn on notifications** on Today.

## Schedule review (owner approves before staff see it)
- Managers build the week in Schedule, then tap **Send to owner**. Until the owner approves, staff don't see that week.
- Owners get a "waiting for your review" item on Today (and a phone notification/email if the `cover` function is set up). The review shows hours, estimated labor cost, and problems (no backup, not available, double-booked, over max hours). **Approve & publish**, or **Ask for changes** with a note.
- After approval, changes go live right away and the owner sees "N changes since you approved" with the list, until they tap **Got it**.
- Turn it on or off in Team → Settings → Schedule review. Weeks that already had shifts when it was turned on stay visible.
- Needs `schema.sql` run again (only owners can publish).
