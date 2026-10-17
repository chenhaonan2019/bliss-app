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
5. **Website.** vercel.com → Add New → Project → import `bliss-app` → Framework preset *Other* → Deploy.
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
