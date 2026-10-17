// BLISS Manager · "team" Edge Function
// Creates sign-in accounts for team members, so they can sign in with a code as soon as
// a manager or owner adds their email. Only emails that are on that business's team
// (or invited as owners) can be created, and only by a manager or owner of that business.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function → Via Editor,
// name it "team", paste this file, Deploy. No secrets to add: it uses the built-in ones.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";

  let body: { org_id?: string; emails?: string[] };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const org = String(body.org_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(org)) return json({ error: "bad_request", message: "org_id is required" }, 400);
  const emails = [...new Set((body.emails ?? []).map((e) => String(e).trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 200);
  if (!emails.length) return json({ created: [], existing: [], skipped: [] });

  // Who is calling, and what is their role in this business?
  const who = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
  if (!who.ok) return json({ error: "unauthorized" }, 401);
  const me = await who.json();
  const svc = { apikey: service, Authorization: `Bearer ${service}` };
  const m = await fetch(`${url}/rest/v1/members?select=role&org_id=eq.${org}&user_id=eq.${me.id}`, { headers: svc });
  const role = m.ok ? (await m.json())[0]?.role : null;
  if (role !== "owner" && role !== "manager") return json({ error: "forbidden" }, 403);

  // Emails this caller may create: active team members of this business, plus owner invites (owners only).
  const d = await fetch(`${url}/rest/v1/docs?select=data&org_id=eq.${org}&coll=eq.employees`, { headers: svc });
  const allowed = new Set<string>();
  for (const r of (d.ok ? await d.json() : [])) {
    const e = String(r.data?.email ?? "").trim().toLowerCase();
    if (e && r.data?.active !== false) allowed.add(e);
  }
  if (role === "owner") {
    const i = await fetch(`${url}/rest/v1/invites?select=email&org_id=eq.${org}`, { headers: svc });
    for (const r of (i.ok ? await i.json() : [])) allowed.add(String(r.email).toLowerCase());
  }

  const created: string[] = [], existing: string[] = [], skipped: string[] = [];
  for (const email of emails) {
    if (!allowed.has(email)) { skipped.push(email); continue; }
    const r = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: { ...svc, "Content-Type": "application/json" },
      body: JSON.stringify({ email, email_confirm: true }),
    });
    if (r.ok) created.push(email);
    else if (r.status === 422 || r.status === 409) existing.push(email); // already has an account
    else skipped.push(email);
  }
  // Someone who requested a code before being added has an unconfirmed account: confirm it.
  if (existing.length) {
    await fetch(`${url}/rest/v1/rpc/confirm_team_emails`, {
      method: "POST", headers: { ...svc, "Content-Type": "application/json" }, body: JSON.stringify({ emails: existing }),
    });
  }
  return json({ created, existing, skipped });
});
