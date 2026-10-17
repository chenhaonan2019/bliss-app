// BLISS Manager · "ai" Edge Function
// Reads order screenshots and builds schedules by calling the Claude API.
// The Claude API key lives only here, as the secret ANTHROPIC_API_KEY.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function → Via Editor,
// name it "ai", paste this file, Deploy. Then Edge Functions → Secrets → add ANTHROPIC_API_KEY.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MODELS: Record<string, string> = {
  quick: Deno.env.get("MODEL_QUICK") ?? "claude-haiku-5-5",
  default: Deno.env.get("MODEL_DEFAULT") ?? "claude-sonnet-5-5",
  complex: Deno.env.get("MODEL_COMPLEX") ?? "claude-sonnet-5-5",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "not_configured", message: "ANTHROPIC_API_KEY secret is not set" }, 500);

  // Only signed-in members of a business may use this.
  const auth = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const who = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
  if (!who.ok) return json({ error: "unauthorized" }, 401);
  const member = await fetch(`${url}/rest/v1/members?select=org_id&limit=1`, {
    headers: { Authorization: auth, apikey: anon },
  });
  const rows = member.ok ? await member.json() : [];
  if (!Array.isArray(rows) || rows.length === 0) return json({ error: "not_a_member" }, 403);

  let body: { prompt?: string; images?: { media_type: string; data: string }[]; tier?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const prompt = String(body.prompt ?? "").slice(0, 200_000);
  if (!prompt) return json({ error: "bad_request", message: "prompt is required" }, 400);
  const images = (body.images ?? []).slice(0, 10).filter((i) =>
    ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(i.media_type) && typeof i.data === "string");

  const content = [
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    { type: "text", text: prompt },
  ];

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELS[body.tier ?? "default"] ?? MODELS.default,
      max_tokens: 8000,
      messages: [{ role: "user", content }],
    }),
  });
  if (r.status === 429) return json({ error: "rate_limited" }, 429);
  if (!r.ok) return json({ error: "upstream_error", status: r.status, detail: (await r.text()).slice(0, 500) }, 502);
  const out = await r.json();
  const text = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  return json({ text, truncated: out.stop_reason === "max_tokens" });
});
