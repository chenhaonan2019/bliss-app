// BLISS Manager · "cover" Edge Function — phone alerts: finding someone to cover a shift, and live delivery tracking.
//
//   POST {action:"mail", msgs, token}   Apps Script in the owner's Gmail (sync/gmail-deliveries.gs): BJ's / Walmart emails
//   POST {action:"open", org_id, cid}        app: a cover request was created → work out who can cover, notify them + managers
//   POST {action:"responded"|"assigned", org_id, cid}  app: someone offered / a manager picked someone → notify
//   POST {action:"vapid"}                    app: public key for phone push notifications
//   POST {action:"test", org_id, channel, to} app: send a test text / call / email / push to yourself
//   POST {action:"tick"} + header x-cron-secret   every few minutes (Supabase Cron): text, then call, if nobody has offered
//   POST ?a=voice&t=…  /  ?a=sms             Twilio webhooks: "press 1" on a call, "YES" text replies
//
// Deploy: Edge Functions → Deploy a new function → Via Editor → name "cover" → paste → Deploy,
// then open the function's Details and turn OFF "Verify JWT" (Twilio and the timer can't send a sign-in token;
// this function checks sign-ins, Twilio signatures and the timer secret itself).
//
// Secrets (Edge Functions → Secrets). Only add the ones for the channels you turn on:
//   CRON_SECRET        any long random text; also put in the Cron job (see README)
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM   for text messages and calls (TWILIO_FROM like +18605550123)
//   SMTP_USER, SMTP_PASS                    for email (Gmail address + app password)
//   APP_URL            your app address, e.g. https://bliss-app-one.vercel.app

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;
const DENO: any = (globalThis as any).Deno;
const env = (k: string) => (DENO ? DENO.env.get(k) : (globalThis as any).process?.env?.[k]) || "";

/* ───────────────────────── small helpers ───────────────────────── */
export const toMin = (t: string) => { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
export const shiftHrs = (s: Json) => { let m = toMin(s.end) - toMin(s.start); if (m < 0) m += 1440; return m / 60; };
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const parseYmd = (s: string) => new Date(s + "T00:00:00Z");
export const addDays = (s: string, n: number) => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
export const dow = (s: string) => parseYmd(s).getUTCDay();
export const weekStart = (s: string) => addDays(s, -((dow(s) + 6) % 7));
const fmtT = (t: string) => { const m = toMin(t); const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`; };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (s: string) => { const d = parseYmd(s); return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export const phoneE164 = (p: string) => { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return d.length > 7 ? "+" + d : ""; };
const xml = (s: string) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));
const b64u = (buf: ArrayBuffer | Uint8Array) => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; b.forEach((x) => (s += String.fromCharCode(x))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s: string) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "===".slice((t.length + 3) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const te = new TextEncoder();
async function hmac(alg: "SHA-256" | "SHA-1", key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: alg }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/* ───────────────────────── who can cover ───────────────────────── */
// Same rules as the app: active, same store, not the person who can't come, no overlapping shift that day,
// free at that time (availability), and not over their max hours for that week.
export function availFits(av: Json | undefined, date: string, start: string, end: string): "yes" | "no" | "unknown" {
  if (!av) return "unknown";
  if ((av.off || []).includes(date)) return "no";
  const w = (av.snap?.[weekStart(date)]?.weekly || av.weekly)?.[dow(date)];
  if (!w || w.mode === "no") return "no";
  if (w.mode === "all") return "yes";
  const a = toMin(w.from), b = toMin(w.to) || 1440, s = toMin(start); let e = toMin(end); if (e <= s) e += 1440;
  return a <= s && e <= (b <= a ? b + 1440 : b) ? "yes" : "no";
}
export function eligible(cover: Json, ctx: { employees: Json[]; shifts: Json[]; avail: Json; maxHrs: Json; locOf: (id: string) => string }) {
  const out: { id: string; fit: string }[] = [];
  const s0 = toMin(cover.start); let e0 = toMin(cover.end); if (e0 <= s0) e0 += 1440;
  const ws = weekStart(cover.date), we = addDays(ws, 6);
  for (const e of ctx.employees) {
    if (e.active === false || e.id === cover.empId || ctx.locOf(e.id) !== cover.loc) continue;
    if (cover.kind === "swap" && cover.swapTo && e.id !== cover.swapTo) continue;
    const mine = ctx.shifts.filter((s) => s.empId === e.id);
    const clash = mine.some((s) => { if (s.date !== cover.date || s.id === cover.shiftId) return false; const a = toMin(s.start); let b = toMin(s.end); if (b <= a) b += 1440; return a < e0 && s0 < b; });
    if (clash) continue;
    const fit = cover.kind === "swap" ? "yes" : availFits(ctx.avail[e.id], cover.date, cover.start, cover.end);
    if (fit === "no") continue;
    const max = Number(ctx.maxHrs?.[e.id]);
    if (max > 0) { const wk = mine.filter((s) => s.date >= ws && s.date <= we).reduce((a, s) => a + shiftHrs(s), 0); if (wk + shiftHrs(cover) > max + 1e-9) continue; }
    out.push({ id: e.id, fit });
  }
  return out.sort((a, b) => (a.fit === "yes" ? 0 : 1) - (b.fit === "yes" ? 0 : 1)).map((x) => x.id);
}

/* ───────────────────────── web push (RFC 8291 + VAPID, no libraries) ───────────────────────── */
export async function encryptPush(payload: Uint8Array, p256dh: string, auth: string, rs = 4096, _test?: { salt?: Uint8Array; key?: CryptoKeyPair }) {
  const ua = unb64u(p256dh), authSecret = unb64u(auth);
  const kp = _test?.key || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, kp.privateKey, 256));
  const prkKey = await hmac("SHA-256", authSecret, ecdh);
  const ikm = (await hmac("SHA-256", prkKey, cat(te.encode("WebPush: info\0"), ua, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = _test?.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac("SHA-256", salt, ikm);
  const cek = (await hmac("SHA-256", prk, cat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac("SHA-256", prk, cat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(payload, new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, rs); head[20] = asPub.length;
  return cat(head, asPub, ct);
}
export async function vapidJwt(aud: string, privJwk: Json, subject: string) {
  const enc = (o: Json) => b64u(te.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const k = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, te.encode(unsigned));
  return `${unsigned}.${b64u(sig)}`;
}
export async function newVapidKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { publicKey: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
}

/* ───────────────────────── Twilio signature (X-Twilio-Signature) ───────────────────────── */
export async function twilioSig(token: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const mac = await hmac("SHA-1", te.encode(token), te.encode(data));
  let s = ""; mac.forEach((x) => (s += String.fromCharCode(x))); return btoa(s);
}
// Our own short-lived token for the "press 1" step of a call (org|cover|employee).
export async function callToken(org: string, cid: string, emp: string) {
  return b64u((await hmac("SHA-256", te.encode(env("CRON_SECRET") || env("SUPABASE_SERVICE_ROLE_KEY")), te.encode(`${org}|${cid}|${emp}`))).slice(0, 18));
}

/* ───────────────────────── Supabase (service role) ───────────────────────── */
const SB = () => env("SUPABASE_URL"), SR = () => env("SUPABASE_SERVICE_ROLE_KEY");
const H = () => ({ apikey: SR(), Authorization: `Bearer ${SR()}`, "Content-Type": "application/json" });
async function q(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, { ...init, headers: { ...H(), ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const docsOf = async (org: string, coll: string) => (await q(`docs?select=doc_id,data&org_id=eq.${org}&coll=eq.${encodeURIComponent(coll)}`)) as { doc_id: string; data: Json }[];
const docOf = async (org: string, path: string) => ((await q(`docs?select=data&org_id=eq.${org}&path=eq.${encodeURIComponent(path)}`)) as Json[])[0]?.data;
const merge = (org: string, path: string, patch: Json) => q("rpc/doc_merge", { method: "POST", body: JSON.stringify({ o: org, p: path, patch }) });
const rpc = (fn: string, args: Json) => q(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const DEF = { push: true, email: true, sms: false, call: false, smsAfter: 15, callAfter: 30, urgentHours: 4, alertPhones: [] as string[] };
async function orgCtx(org: string) {
  const [emps, shifts, avail, sched, settings, cfg, links, members] = await Promise.all([
    docsOf(org, "employees"), docsOf(org, "shifts"), docsOf(org, "availability"), docOf(org, "mgr/sched"), docOf(org, "config/settings"), docOf(org, "mgr/cover"), docsOf(org, "links"),
    q(`members?select=user_id,email,role&org_id=eq.${org}`) as Promise<Json[]>,
  ]);
  const employees = emps.map((d) => ({ id: d.doc_id, ...d.data }));
  const byId: Json = Object.fromEntries(employees.map((e) => [e.id, e]));
  const locs = settings?.locations || [];
  const locOf = (id: string) => byId[id]?.loc || locs[0]?.id || "wh";
  const userOfEmp: Json = {}; links.forEach((l) => { if (l.data?.empId) userOfEmp[l.data.empId] = l.doc_id; });
  return {
    employees, byId, locOf, userOfEmp, members, locs,
    shifts: shifts.map((d) => ({ id: d.doc_id, ...d.data })),
    avail: Object.fromEntries(avail.map((d) => [d.doc_id, d.data])),
    maxHrs: sched?.maxHrs || {},
    cfg: { ...DEF, ...(cfg || {}) },
    locName: (id: string) => locs.find((l: Json) => l.id === id)?.name || id,
    bizName: settings?.location || "BLISS",
  };
}
type Ctx = Awaited<ReturnType<typeof orgCtx>>;
const managersFor = (ctx: Ctx, loc: string) => ctx.employees.filter((e) => e.active !== false && e.role === "Manager" && ctx.locOf(e.id) === loc);

/* ───────────────────────── sending ───────────────────────── */
async function sendSms(to: string, body: string) {
  const sid = env("TWILIO_SID"), tok = env("TWILIO_TOKEN"), from = env("TWILIO_FROM");
  if (!sid || !tok || !from || !to) return { ok: false, why: "not set up" };
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST", headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  return { ok: r.ok, why: r.ok ? "" : (await r.text()).slice(0, 200) };
}
async function sendCall(to: string, twiml: string) {
  const sid = env("TWILIO_SID"), tok = env("TWILIO_TOKEN"), from = env("TWILIO_FROM");
  if (!sid || !tok || !from || !to) return { ok: false, why: "not set up" };
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST", headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Twiml: twiml }),
  });
  return { ok: r.ok, why: r.ok ? "" : (await r.text()).slice(0, 200) };
}
// Minimal SMTP over TLS (port 465) — enough for Gmail with an app password.
export async function sendEmail(to: string, subject: string, text: string, conn?: any) {
  const user = env("SMTP_USER"), pass = env("SMTP_PASS");
  if (!to || (!conn && (!user || !pass || !DENO))) return { ok: false, why: "not set up" };
  const c = conn || (await DENO.connectTls({ hostname: env("SMTP_HOST") || "smtp.gmail.com", port: Number(env("SMTP_PORT") || 465) }));
  const dec = new TextDecoder(); let buf = "";
  const read = async () => { for (;;) { const m = buf.match(/(^|\r\n)(\d{3}) [^\r\n]*\r\n/); if (m) { const end = buf.indexOf(m[0]) + m[0].length; const out = buf.slice(0, end); buf = buf.slice(end); return out; } const b = new Uint8Array(4096); const n = await c.read(b); if (n === null) throw new Error("smtp closed"); buf += dec.decode(b.subarray(0, n)); } };
  const cmd = async (line: string | null, want: string) => { if (line !== null) await c.write(te.encode(line + "\r\n")); const r = await read(); if (!r.match(new RegExp(`(^|\\r\\n)${want}`))) throw new Error("smtp: " + r.trim().slice(-120)); return r; };
  try {
    await cmd(null, "220"); await cmd("EHLO bliss", "250"); await cmd("AUTH LOGIN", "334"); await cmd(btoa(user), "334"); await cmd(btoa(pass), "235");
    await cmd(`MAIL FROM:<${user}>`, "250"); await cmd(`RCPT TO:<${to}>`, "25"); await cmd("DATA", "354");
    const msg = [`From: ${env("SMTP_NAME") || "BLISS"} <${user}>`, `To: <${to}>`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", ...text.split("\n").map((l) => (l.startsWith(".") ? "." + l : l)), "."].join("\r\n");
    await cmd(msg, "250"); await cmd("QUIT", "221").catch(() => {});
    return { ok: true, why: "" };
  } catch (e) { return { ok: false, why: String((e as Error).message || e) }; } finally { try { c.close(); } catch { /* */ } }
}
async function vapidKeys() {
  const row = ((await q("app_secrets?select=v&k=eq.vapid")) as Json[])[0];
  if (row) return JSON.parse(row.v);
  const k = await newVapidKeys();
  await q("app_secrets", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ k: "vapid", v: JSON.stringify(k) }) });
  return ((await q("app_secrets?select=v&k=eq.vapid")) as Json[]).map((r) => JSON.parse(r.v))[0];
}
async function sendPush(userIds: string[], title: string, body: string, url: string) {
  if (!userIds.length) return 0;
  const subs = (await q(`push_subs?select=endpoint,sub&user_id=in.(${userIds.join(",")})`)) as Json[];
  if (!subs.length) return 0;
  const k = await vapidKeys(); let n = 0;
  for (const s of subs) {
    try {
      const ep = new URL(s.endpoint); const jwt = await vapidJwt(ep.origin, k.privateJwk, "mailto:" + (env("SMTP_USER") || "owner@example.com"));
      const body_ = await encryptPush(te.encode(JSON.stringify({ title, body, url })), s.sub.keys.p256dh, s.sub.keys.auth);
      const r = await fetch(s.endpoint, { method: "POST", headers: { Authorization: `vapid t=${jwt}, k=${k.publicKey}`, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" }, body: body_ });
      if (r.status === 404 || r.status === 410) await q(`push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE" });
      else if (r.ok) n++;
    } catch (e) { console.warn("push", e); }
  }
  return n;
}

/* ───────────────────────── messages ───────────────────────── */
const appUrl = (cid: string) => `${(env("APP_URL") || "").replace(/\/$/, "")}/?cover=${cid}`;
const isUrgent = (cv: Json) => Date.now() >= new Date(cv.startsAt).getTime() - Number(cv.urgentHours ?? 4) * 3600e3;
function describe(cv: Json, ctx: Ctx) {
  const who = ctx.byId[cv.empId]?.name?.split(" ")[0] || "Someone";
  return { who, when: `${fmtDay(cv.date)}, ${fmtT(cv.start)}–${fmtT(cv.end)}`, where: ctx.locName(cv.loc) };
}
async function log(org: string, cid: string, cv: Json, ev: string) {
  const l = [...(cv.log || []), { at: new Date().toISOString(), ev }].slice(-60); cv.log = l;
  await merge(org, `cover/${cid}`, { log: l });
}

// Stage 1: push + email to everyone who can cover, and to managers/owners.
async function notifyOpen(org: string, cid: string) {
  const ctx = await orgCtx(org); const cv = await docOf(org, `cover/${cid}`); if (!cv || cv.status !== "open") return { skipped: true };
  let elig = eligible(cv, ctx);
  // The shift's backup (free for the whole shift) goes first and, if texts are on, is texted right away.
  if (cv.backup && elig.includes(cv.backup)) elig = [cv.backup, ...elig.filter((e) => e !== cv.backup)];
  await merge(org, `cover/${cid}`, { elig, stage: Math.max(1, cv.stage || 0), notifiedAt: new Date().toISOString(), urgentHours: cv.urgentHours ?? ctx.cfg.urgentHours });
  cv.elig = elig;
  const d = describe(cv, ctx); const urgent = isUrgent(cv); const link = appUrl(cid); const sent: string[] = [];
  const staffTitle = cv.kind === "swap" ? `${d.who} asked you to take a shift` : `Shift needs cover${urgent ? " · urgent" : ""}`;
  const staffBody = `${d.when} at ${d.where}. ${urgent && cv.kind !== "swap" ? "First to accept gets it." : "Tap to offer to take it."}`;
  if (ctx.cfg.push) sent.push(`push ${await sendPush(elig.map((e) => ctx.userOfEmp[e]).filter(Boolean), staffTitle, staffBody, link)}`);
  if (ctx.cfg.email) for (const e of elig) { const em = ctx.byId[e]?.email; if (em) { const r = await sendEmail(em, `BLISS: ${staffTitle}`, `${staffBody}\n\nOpen the app: ${link}`); sent.push(`email ${e} ${r.ok ? "ok" : r.why}`); } }
  if (ctx.cfg.sms && cv.kind !== "swap" && cv.backup && elig[0] === cv.backup) {
    const p = phoneE164(ctx.byId[cv.backup]?.phone);
    if (p) { const r = await sendSms(p, `BLISS: you're the backup for ${d.when} at ${d.where} (${d.who} can't make it). ${urgent ? "First to reply YES gets it." : "Reply YES if you can take it."} Or open ${link}`); sent.push(`backup text ${r.ok ? "ok" : r.why}`); }
  }
  // managers
  const mgrTitle = `${d.who} can't make ${d.when}`; const mgrBody = `${d.where}${cv.reason ? " · " + cv.reason : ""}. ${elig.length} people can cover; they've been notified.`;
  const mgrUsers = [...managersFor(ctx, cv.loc).map((e) => ctx.userOfEmp[e.id]), ...ctx.members.filter((m) => m.role === "owner").map((m) => m.user_id)].filter(Boolean);
  if (ctx.cfg.push) await sendPush([...new Set(mgrUsers)], mgrTitle, mgrBody, link);
  if (ctx.cfg.email) for (const em of new Set([...managersFor(ctx, cv.loc).map((e) => e.email), ...ctx.members.filter((m) => m.role === "owner").map((m) => m.email)].filter(Boolean))) await sendEmail(em, `BLISS: ${mgrTitle}`, `${mgrBody}\n\n${link}`);
  if (ctx.cfg.sms) for (const p of ctx.cfg.alertPhones || []) await sendSms(phoneE164(p), `BLISS: ${mgrTitle}. ${mgrBody} ${link}`);
  await log(org, cid, cv, `Notified ${elig.length} people (${sent.join(", ") || "in app"})`);
  return { elig, sent };
}
// Someone offered or was assigned: tell managers (and the person who got the shift).
async function notifyChange(org: string, cid: string) {
  const ctx = await orgCtx(org); const cv = await docOf(org, `cover/${cid}`); if (!cv) return {};
  const d = describe(cv, ctx); const link = appUrl(cid);
  const mgrUsers = [...managersFor(ctx, cv.loc).map((e) => ctx.userOfEmp[e.id]), ...ctx.members.filter((m) => m.role === "owner").map((m) => m.user_id)].filter(Boolean);
  if (cv.status === "filled" && cv.assigned) {
    const taker = ctx.byId[cv.assigned]; const msg = `You're on: ${d.when} at ${d.where} (covering for ${d.who}).`;
    if (ctx.cfg.push) { await sendPush([ctx.userOfEmp[cv.assigned]].filter(Boolean), "Shift is yours", msg, link); await sendPush([ctx.userOfEmp[cv.empId]].filter(Boolean), "Your shift is covered", `${taker?.name || "Someone"} is covering ${d.when}.`, link); await sendPush(mgrUsers, "Shift covered", `${taker?.name || "Someone"} is covering for ${d.who}, ${d.when}.`, link); }
    if (ctx.cfg.sms && taker?.phone && cv.via?.includes?.("sms")) await sendSms(phoneE164(taker.phone), `BLISS: ${msg}`);
    if (ctx.cfg.sms) for (const p of ctx.cfg.alertPhones || []) await sendSms(phoneE164(p), `BLISS: covered. ${taker?.name || "Someone"} takes ${d.who}'s shift ${d.when}.`);
  } else {
    const n = Object.keys(cv.volunteers || {}).length;
    if (ctx.cfg.push) await sendPush(mgrUsers, "Someone can cover", `${n} offer${n === 1 ? "" : "s"} for ${d.who}'s shift ${d.when}. Tap to pick.`, link);
    if (ctx.cfg.sms) for (const p of ctx.cfg.alertPhones || []) await sendSms(phoneE164(p), `BLISS: ${n} offer${n === 1 ? "" : "s"} to cover ${d.who}'s shift ${d.when}. Pick in the app: ${link}`);
  }
  return { ok: true };
}
// Every few minutes: if nobody has offered, text; later, call. Close requests whose shift has started.
async function tick() {
  const open = (await q("docs?select=org_id,doc_id,data&coll=eq.cover&data->>status=eq.open")) as { org_id: string; doc_id: string; data: Json }[];
  const done: string[] = []; const base = `${SB()}/functions/v1/cover`;
  for (const row of open) {
    const org = row.org_id, cid = row.doc_id, cv = row.data;
    if (Date.now() > new Date(cv.startsAt).getTime()) { await merge(org, `cover/${cid}`, { status: "expired" }); done.push(`${cid} expired`); continue; }
    if (Object.keys(cv.volunteers || {}).length) continue;
    const ctx = await orgCtx(org); const mins = (Date.now() - new Date(cv.createdAt).getTime()) / 60000;
    const elig = cv.elig || eligible(cv, ctx); const d = describe(cv, ctx); const urgent = isUrgent(cv);
    if ((cv.stage || 1) < 2 && ctx.cfg.sms && mins >= Number(ctx.cfg.smsAfter)) {
      let n = 0; for (const e of elig) { const p = phoneE164(ctx.byId[e]?.phone); if (!p) continue; const r = await sendSms(p, `BLISS: can you cover ${d.when} at ${d.where}? ${urgent ? "First to reply YES gets it." : "Reply YES to offer."} Or open ${appUrl(cid)}`); if (r.ok) n++; }
      for (const p of ctx.cfg.alertPhones || []) await sendSms(phoneE164(p), `BLISS: no one has offered for ${d.who}'s shift ${d.when} yet. Texted ${n} people.`);
      await merge(org, `cover/${cid}`, { stage: 2 }); cv.stage = 2; await log(org, cid, cv, `No offers after ${Math.round(mins)} min: texted ${n} people`); done.push(`${cid} sms ${n}`);
    }
    if ((cv.stage || 1) < 3 && ctx.cfg.call && mins >= Number(ctx.cfg.callAfter)) {
      let n = 0;
      for (const e of elig) {
        const p = phoneE164(ctx.byId[e]?.phone); if (!p) continue; const first = String(ctx.byId[e]?.name || "").split(" ")[0];
        const t = await callToken(org, cid, e); const act = `${base}?a=voice&o=${org}&c=${encodeURIComponent(cid)}&e=${encodeURIComponent(e)}&t=${t}`;
        const say = `Hi ${first}. This is ${ctx.bizName}. A shift needs cover on ${d.when.replace("–", " to ")}, at ${d.where}. Press 1 if you can take it. Press 2 if you can't.`;
        const r = await sendCall(p, `<Response><Gather numDigits="1" timeout="8" action="${xml(act)}" method="POST"><Say voice="Polly.Joanna">${xml(say)}</Say></Gather><Say voice="Polly.Joanna">We didn't get an answer. Goodbye.</Say></Response>`);
        if (r.ok) n++;
      }
      await merge(org, `cover/${cid}`, { stage: 3 }); cv.stage = 3; await log(org, cid, cv, `Still no offers after ${Math.round(mins)} min: called ${n} people`); done.push(`${cid} call ${n}`);
    }
  }
  // delivery receiving jobs for whoever is on shift (also runs with each Gmail check; one push per person per order)
  const orgs = (await q("orgs?select=id")) as Json[];
  for (const g of orgs) {
    try {
      const orders = (await docsOf(g.id, "orders")).map((r) => ({ id: r.doc_id, data: r.data })).filter((o) => dutyDue(o.data, etParts().ymd));
      if (orders.length) done.push(...(await deliveryDuty(g.id, await deliveryCtx(g.id), orders)).map((x) => `duty ${x.order} ${x.duty}`));
    } catch (e) { console.warn("duty", e); }
    try { done.push(...(await batchDuty(g.id, await deliveryCtx(g.id))).map((x) => `batch ${x.batch} ${x.kind} ${x.to}`)); } catch (e) { console.warn("batch", e); }
  }
  return { open: open.length, done };
}
// A response from a text or a call: same rules as the app (urgent → first one gets it; otherwise an offer).
async function respondAs(org: string, cid: string, emp: string, via: string) {
  const r = (await rpc("cover_respond_as", { o: org, cid, emp, via })) as string;
  if (r === "assigned" || r === "volunteered") notifyChange(org, cid).catch((e) => console.warn(e));
  return r;
}

// Schedule review: tell owners a week is waiting; tell the store's managers it was approved or needs changes.
async function notifySched(org: string, role: string, b: Json) {
  const ctx = await orgCtx(org); const loc = String(b.loc || ""), ws = String(b.ws || "");
  const week = `week of ${MONTHS[parseYmd(ws).getUTCMonth()]} ${parseYmd(ws).getUTCDate()}`; const where = ctx.locName(loc);
  const link = `${(env("APP_URL") || "").replace(/\/$/, "")}/`; const note = b.note ? ` “${String(b.note).slice(0, 200)}”` : "";
  const owners = ctx.members.filter((m) => m.role === "owner");
  const mgrs = managersFor(ctx, loc);
  let users: string[] = [], emails: string[] = [], title = "", text = "";
  if (b.event === "submitted") { users = owners.map((m) => m.user_id); emails = owners.map((m) => m.email); title = "Schedule ready for your review"; text = `${where}, ${week}.${note}`; }
  else if ((b.event === "approved" || b.event === "changes") && role === "owner") {
    users = mgrs.map((e) => ctx.userOfEmp[e.id]); emails = mgrs.map((e) => e.email);
    title = b.event === "approved" ? "Schedule approved" : "Owner asked for schedule changes";
    text = b.event === "approved" ? `${where}, ${week} is published. Staff can see it now.` : `${where}, ${week}.${note}`;
  } else return { skipped: true };
  users = [...new Set(users.filter(Boolean))]; emails = [...new Set(emails.filter(Boolean))];
  if (ctx.cfg.push) await sendPush(users, title, text, link);
  if (ctx.cfg.email) for (const e of emails) await sendEmail(e, `BLISS: ${title}`, `${text}\n\n${link}`);
  return { ok: true, to: users.length };
}

/* ───────────────────────── deliveries: BJ's / Walmart emails → live order tracking ─────────────────────────
   A small Google Apps Script in the owner's Gmail (see sync/gmail-deliveries.gs) posts new store emails here
   every minute, signed with the owner's Google sign-in token (no passwords stored anywhere).
   Claude reads each email → order number, stage, time window / ETA, store address → we create or update the
   app's order and send phone alerts (managers of that store, staff working there today, owners).            */
const TZ = "America/New_York";
export function etParts(d = new Date()) {
  const p: Json = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
// New York wall-clock time → exact moment (ISO)
export function etIso(day: string, hm: string) {
  const guess = Date.parse(`${day}T${hm}:00Z`); const p = etParts(new Date(guess));
  const off = Date.parse(`${p.ymd}T${p.hm}:00Z`) - guess; return new Date(guess - off).toISOString();
}
export const STAGES = ["ordered", "picked_up", "out_for_delivery", "delivered"];
const rank = (s: string) => STAGES.indexOf(s);
export const htmlToText = (h: string) => String(h || "")
  .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<br\s*\/?>|<\/(p|div|tr|td|th|h\d|li|table)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/[ \t ​-‍͏­]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

// Google sign-in token from Apps Script (ScriptApp.getIdentityToken) → the verified email, or "".
let JWKS: { at: number; keys: Json[] } | null = null; let WHY = "";
export async function googleEmail(tok: string, fetchCerts = async () => { const r = await fetch("https://www.googleapis.com/oauth2/v3/certs"); const t = await r.text(); if (!r.ok || !t) throw new Error("certs " + r.status + " " + t.length); return JSON.parse(t).keys; }) {
  try {
    const [h, p, s] = tok.split("."); const dec = (x: string) => JSON.parse(new TextDecoder().decode(unb64u(x)));
    const hd = dec(h), pl = dec(p);
    if (!["accounts.google.com", "https://accounts.google.com"].includes(pl.iss) || !(pl.exp * 1000 > Date.now()) || pl.email_verified === false || !pl.email) { WHY = "claims"; return ""; }
    if (!JWKS || Date.now() - JWKS.at > 3600e3 || !JWKS.keys.some((k) => k.kid === hd.kid)) JWKS = { at: Date.now(), keys: await fetchCerts() };
    const jwk = JWKS.keys.find((k) => k.kid === hd.kid); if (!jwk) { WHY = "no key " + JWKS.keys.length; return ""; }
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), te.encode(`${h}.${p}`)); if (!ok) WHY = "signature";
    return ok ? String(pl.email).toLowerCase() : "";
  } catch (e) { WHY = "error " + String((e as Error).message || e).slice(0, 120); return await tokenInfo(tok); }
}
// fallback: ask Google to check the token
async function tokenInfo(tok: string) {
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(tok)); const t = await r.text();
    if (!r.ok) { WHY += " / tokeninfo " + r.status; return ""; }
    const pl = JSON.parse(t);
    if (!["accounts.google.com", "https://accounts.google.com"].includes(pl.iss) || String(pl.email_verified) === "false" || !pl.email || !(+pl.exp * 1000 > Date.now())) { WHY += " / tokeninfo claims"; return ""; }
    return String(pl.email).toLowerCase();
  } catch (e) { WHY += " / tokeninfo " + String((e as Error).message || e).slice(0, 80); return ""; }
}

// What one email says. Claude first; simple rules if Claude is unavailable.
export function ruleParse(m: Json) {
  const s = String(m.subject || ""), t = String(m.text || ""), all = s + "\n" + t;
  const vendor = /bjs|bj's/i.test(m.from + s) ? "BJ's" : /walmart/i.test(m.from + s) ? "Walmart" : "Other";
  const no = (all.match(/order\s*(?:number)?\s*:?\s*#?\s*(\d{4,}(?:-\d+)?)/i) || [])[1] || null;
  // the subject line says the stage unambiguously (bodies mention later steps, e.g. "we'll tell you when it's out for delivery")
  // Returns and refunds ("Return reminder for order #…", "Your return has been canceled…", "You're getting a $8.86 refund")
  // are about something already delivered: never an order, a cancel or a reminder.
  const stage = RETURN_SUBJ.test(s) ? "return"
    : /unavailable/i.test(s) || /^review your order updates/i.test(s) && /unavailable/i.test(t.slice(0, 600)) ? "items_canceled"
    : /has been delivered|^delivered\b/i.test(s) ? "delivered" : /should arrive by|out for delivery/i.test(s) ? "out_for_delivery"
    : /is on the way\b(?! soon)/i.test(s) ? "picked_up" : /canceled/i.test(s) && /order\s*#/i.test(s) && !/item/i.test(s) ? "canceled" : /canceled/i.test(s) ? "items_canceled"
    : /order confirmation|thanks for your (delivery )?order/i.test(s) ? "ordered" : /reminder for your upcoming order/i.test(s) ? "reminder"
    : /on the way soon|passcode/i.test(s) ? "otp" : "other";
  const eta = (s.match(/arrive by (\d{1,2}):(\d\d)\s*([ap])m/i) || []);
  const etaHm = eta.length ? `${String((+eta[1] % 12) + (/p/i.test(eta[3]) ? 12 : 0)).padStart(2, "0")}:${eta[2]}` : null;
  return { vendor, orderNo: no, stage, eta: etaHm, address: null, windowDate: null, windowStart: null, windowEnd: null, itemCount: null, items: [], canceledItems: stage === "return" ? [] : unavailableItems(t), total: null, driver: null, note: "" };
}
export const RETURN_SUBJ = /\breturns?\b|\brefund/i;
// Walmart lists out-of-stock items under a "4 items unavailable" heading, each name followed by a price line and "Qty: 4".
// Read them straight from the email so they're caught even when Claude can't be reached (also on "delivered" emails).
export function unavailableItems(text: string) {
  const L = String(text || "").split("\n").map((x) => x.replace(/[|#*]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = []; let on = false;
  for (let i = 0; i < L.length; i++) {
    if (/^\d+ (?:items? (?:is |are )?unavailable|unavailable items?)\b/i.test(L[i]) && !/ in your order$/i.test(L[i])) { on = true; continue; }
    if (!on) continue;
    if (/^(payment method|summary|subtotal|\d+ items? (?:delivered|shipped|arriving)|delivery from store|shipped|arriving)/i.test(L[i]) && !/unavailable/i.test(L[i])) { on = /^delivery from store/i.test(L[i]) ? on : false; continue; }
    if (!/^qty:?\s*\d+/i.test(L[i])) continue;
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      if (/^\$|\/(?:oz|foz|lb|ct|ea|each)\b|^qty|unavailable/i.test(L[j]) || L[j].length < 4) continue;
      const qty = (L[i].match(/\d+/) || [])[0];
      out.push(`${L[j].slice(0, 52).replace(/[\s,;-]+$/, "")}${qty && qty !== "1" ? ` ×${qty}` : ""}`); break;
    }
  }
  return [...new Set(out)].slice(0, 20);
}
async function claudeParse(m: Json) {
  const key = env("ANTHROPIC_API_KEY"); if (!key) return null;
  const prompt = `This is a grocery delivery email sent to a cafe owner (sent ${m.date}, New York time zone). Read it and reply with JSON only:
{"vendor":"BJ's"|"Walmart"|"Other","orderNo":string|null,"stage":"ordered"|"reminder"|"items_canceled"|"picked_up"|"out_for_delivery"|"delivered"|"canceled"|"return"|"otp"|"other",
"windowDate":"YYYY-MM-DD"|null,"windowStart":"HH:MM"|null,"windowEnd":"HH:MM"|null,"eta":"HH:MM"|null,"driver":string|null,"address":string|null,
"itemCount":number|null,"items":[up to 8 item names],"canceledItems":[names of canceled / out-of-stock items],"total":number|null,"signature":boolean,"editUntil":string|null,"note":"one short plain sentence for the store staff"}
Rules: stage "ordered" = order confirmation; "picked_up" = driver picked it up / on the way with no time; "out_for_delivery" = has an arrival time; "canceled" only if the whole order is canceled; "otp" = passcode email.
"items_canceled" = some items won't come (canceled, out of stock, or Walmart "unavailable") — list them in canceledItems; items listed as unavailable on any email (even "delivered") also go in canceledItems.
"return" = anything about a return or refund (return started / reminder / update / canceled, refund issued) — these are never a new order or an order cancellation.
Times are 24h New York time. orderNo without "#". address = delivery address. Use null when the email doesn't say.

Subject: ${m.subject}
From: ${m.from}
${String(m.text || "").slice(0, 7000)}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env("MODEL_QUICK") || "claude-haiku-5-5", max_tokens: 700, messages: [{ role: "user", content: prompt }] }) });
    if (!r.ok) { console.warn("claude", r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json(); const txt = (j.content || []).map((c: Json) => c.text || "").join("");
    const o = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); return o && typeof o === "object" ? o : null;
  } catch (e) { console.warn("claude", e); return null; }
}
export async function parseMail(m: Json, ai = claudeParse) {
  const base: Json = ruleParse(m); base.self = /successfully canceled|cancellation request/i.test(String(m.subject || "") + String(m.text || "").slice(0, 300));
  const c = await ai(m); if (!c) return { ...base, by: "rules" };
  const out: Json = { ...base, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined && v !== "")) };
  if (base.stage !== "other" && base.stage !== out.stage && !["canceled", "items_canceled"].includes(out.stage) && ["delivered", "out_for_delivery", "picked_up"].includes(base.stage)) out.stage = base.stage; // subject lines are unambiguous
  if (base.stage === "return") { out.stage = "return"; out.canceledItems = []; } // subject says return / refund: Claude can't turn it into an order
  else if (out.stage === "return") out.stage = "other";
  if (base.stage === "items_canceled" && !["canceled", "items_canceled"].includes(out.stage) && !["delivered", "out_for_delivery", "picked_up"].includes(out.stage)) out.stage = "items_canceled";
  if (!(out.canceledItems || []).length && base.canceledItems.length) out.canceledItems = base.canceledItems;
  if (base.orderNo && !out.orderNo) out.orderNo = base.orderNo;
  out.orderNo = out.orderNo ? String(out.orderNo).replace(/^#/, "").trim() : null; out.by = "claude"; out.self = base.self; return out;
}

const LOCKEY: Json = { wh: ["west hartford", "farmington ave", "06107", "06119", "06117", "06110"], nh: ["new haven", "olive st", "06511", "06510", "06513"] };
export function locFromAddr(addr: string, locs: Json[]) {
  const t = String(addr || "").toLowerCase(); if (!t) return null;
  for (const l of locs) if ([...(LOCKEY[l.id] || []), String(l.name || "").toLowerCase()].filter(Boolean).some((k) => t.includes(k))) return l.id;
  return null;
}
const fmtHm = (hm: string) => fmtT(hm);
export function etaText(o: Json) {
  const t = o.track || {};
  if (t.eta) return `by ${fmtHm(t.eta)}`;
  if (t.wStart) return `${fmtHm(t.wStart)}–${fmtHm(t.wEnd || t.wStart)}`;
  return "";
}

// Apply one parsed email to the orders list. Returns {id, data, isNew, event} or null. Pure (no I/O) so it can be tested.
export function applyMail(orders: { id: string; data: Json }[], p: Json, m: Json, locs: Json[], now = new Date()) {
  if (["otp", "other", "return"].includes(p.stage) || p.vendor === "Other") return null;
  const store = p.vendor; const ref = p.orderNo ? `${store === "BJ's" ? "BJ" : "WM"}:${p.orderNo}` : null;
  const at = m.date ? new Date(m.date).toISOString() : now.toISOString(); const day = etParts(new Date(at)).ymd;
  let row = ref ? (orders.find((o) => o.data.ref === ref && o.data.status !== "merged") || orders.find((o) => o.data.ref === ref)) : undefined;
  // a manager's screenshot order with the same order number
  const nn = (x: unknown) => String(x || "").replace(/[^0-9]/g, "");
  if (!row && p.orderNo) row = orders.find((o) => !o.data.ref && o.data.store === store && o.data.status !== "merged" && nn(o.data.orderNo) === nn(p.orderNo));
  const open = (o: { data: Json }) => o.data.store === store && o.data.status === "ordered";
  if (!row && !ref) row = orders.filter((o) => open(o) && o.data.ref).sort((a, b) => String(b.data.createdAt).localeCompare(String(a.data.createdAt)))[0]; // email without a number → newest tracked order
  const loc = locFromAddr(p.address, locs);
  const wDate = p.windowDate || (p.eta ? day : null);
  if (!row && ref) { // an order someone typed in by hand for the same store and day → attach to it
    const recvRecent = (o: { data: Json }) => ["received", "issue"].includes(o.data.status) && o.data.store === store && Math.abs(Date.parse(o.data.receivedAt || "") - Date.parse(at)) < 24 * 3600e3;
    const cands = orders.filter((o) => (open(o) || recvRecent(o)) && o.data.kind !== "stockin" && !o.data.ref && !o.data.orderNo && o.data.status !== "merged" && (!loc || o.data.loc === loc)
      && (o.data.src === "draft" ? Math.abs(Date.parse(o.data.createdAt || "") - Date.parse(at)) < 12 * 3600e3 : (!!wDate && (o.data.expected === wDate || Math.abs(Date.parse(o.data.expected || "") - Date.parse(wDate)) <= 864e5 && Math.abs(Date.parse(o.data.createdAt || "") - Date.parse(at)) < 36 * 3600e3
        && (!p.itemCount || !(o.data.lines || []).length || Math.abs(p.itemCount - o.data.lines.length) <= Math.max(2, 0.4 * p.itemCount))))));
    // several on the same day (e.g. two Walmart orders): pick the one whose total / item count is closest
    const tot = (o: Json) => +o.total || (o.lines || []).reduce((a: number, l: Json) => a + (+l.price || 0), 0);
    const sc = (o: { data: Json }) => (p.total && tot(o.data) ? Math.abs(tot(o.data) - p.total) / p.total : 0.5) + (p.itemCount && (o.data.lines || []).length ? Math.abs(p.itemCount - o.data.lines.length) / p.itemCount : 0.5) + (o.data.expected === wDate ? 0 : 0.3);
    const ranked = cands.map((o) => ({ o, v: sc(o) })).sort((a, b) => a.v - b.v);
    row = ranked.length === 1 || (ranked.length > 1 && ranked[0].v + 0.15 < ranked[1].v) ? ranked[0].o : undefined;
  }
  if (!row && ["reminder", "items_canceled"].includes(p.stage) && !ref) return null;
  const isNew = !row;
  const d: Json = row ? JSON.parse(JSON.stringify(row.data)) : { store, loc: loc || locs[0]?.id || "wh", date: day, expected: wDate || day, window: "", lines: [], status: "ordered", createdAt: at, createdBy: "email", src: "email", screenshots: [] };
  if (ref) d.ref = ref; if (loc && (isNew || d.status === "ordered")) d.loc = loc;
  const t: Json = d.track || { stage: "ordered", events: [] };
  if ((t.events || []).some((e: Json) => e.mid === m.id)) return null; // already applied
  const prev = t.stage || "ordered";
  if (rank(p.stage) > rank(prev)) t.stage = p.stage;
  if (p.stage === "canceled") { t.stage = "canceled"; if (d.status === "ordered") d.status = "canceled"; }
  if (p.windowDate) { d.expected = p.windowDate; t.wDate = p.windowDate; }
  if (p.windowStart) { t.wStart = p.windowStart; t.wEnd = p.windowEnd || null; }
  if (p.eta) { t.eta = p.eta; t.etaAt = etIso(p.windowDate || day, p.eta); if (!p.windowDate) d.expected = day; }
  if (p.stage === "picked_up") t.pickedAt = at;
  if (p.stage === "out_for_delivery") t.outAt = t.outAt || at;
  if (p.stage === "delivered") t.deliveredAt = at;
  if (p.driver) t.driver = String(p.driver).slice(0, 40);
  if (p.itemCount) t.items = +p.itemCount || t.items;
  if ((p.items || []).length) t.names = (p.items as string[]).slice(0, 8).map((x) => String(x).slice(0, 60));
  if (p.total != null && isFinite(+p.total)) t.total = +p.total;
  if (p.signature) t.signature = true;
  if (p.editUntil) t.editUntil = String(p.editUntil).slice(0, 40);
  // the owner canceled items themselves (not out of stock): no alarm; if they placed a new order with the same store
  // within 45 min, this one was replaced
  if (p.self) {
    t.selfCanceled = [...new Set([...(t.selfCanceled || []), ...((p.canceledItems || []) as string[]).map((x) => String(x).slice(0, 60))])].slice(0, 30);
    const made = Date.parse(d.createdAt || at);
    const repl = orders.find((o) => o.data.ref && o.data.ref !== d.ref && o.data.store === store && o.data.status !== "canceled" && Math.abs(Date.parse(o.data.createdAt || "") - made) < 45 * 6e4);
    if (repl) { t.stage = "canceled"; t.replacedBy = repl.data.track?.no || repl.data.ref; if (d.status === "ordered") d.status = "canceled"; }
    p = { ...p, canceledItems: [] };
  }
  const had = new Set((t.canceled || []).map((x: string) => x.toLowerCase()));
  const newCanceled = ((p.canceledItems || []) as string[]).map((x) => String(x).slice(0, 60)).filter((x) => !had.has(x.toLowerCase()));
  if ((p.canceledItems || []).length) t.canceled = [...new Set([...(t.canceled || []), ...(p.canceledItems as string[]).map((x) => String(x).slice(0, 60))])].slice(0, 20);
  if (t.wStart && !d.window) d.window = `${fmtHm(t.wStart)}–${fmtHm(t.wEnd || t.wStart)}`;
  if (p.orderNo) t.no = p.orderNo;
  const ev = { at, stage: p.stage, mid: m.id, text: String(p.note || m.subject || "").slice(0, 160) };
  t.events = [...(t.events || []), ev].sort((a: Json, b: Json) => String(a.at).localeCompare(String(b.at))).slice(-25);
  t.at = now.toISOString(); d.track = t;
  // first run: an order that was already delivered hours ago isn't waiting for anyone any more
  if (p.stage === "delivered" && d.status === "ordered" && now.getTime() - Date.parse(at) > 3600e3) Object.assign(d, { status: "received", receivedAt: at, receivedDate: etParts(new Date(at)).ymd, receivedBy: "email", recvNote: "Delivered before tracking started (from the store email)", issueSeen: true });
  const advanced = !p.self && (rank(t.stage) > rank(prev) || p.stage === "items_canceled" || p.stage === "canceled" || isNew);
  return { id: row?.id || (ref ? "em_" + ref.replace(/[^A-Za-z0-9]+/g, "_") : `em${Date.parse(at).toString(36)}${Math.random().toString(36).slice(2, 6)}`), data: d, isNew, event: advanced ? p.stage : null, prevStage: prev, newCanceled };
}

// Alert text for a stage change.
export function deliveryAlert(o: Json, stage: string, where: string, multi: boolean) {
  const t = o.track || {}; const st = o.store; const at = multi ? ` · ${where}` : ""; const n = t.items ? ` · ${t.items} items` : "";
  if (stage === "ordered") return { title: `🧾 ${st} order placed${at}`, body: `Arrives ${o.expected ? fmtDay(o.expected).replace(/^\w+ /, (w: string) => w.slice(0, 3) + " ") : "soon"}${etaText(o) ? ", " + etaText(o) : ""}${n}.`, who: "plan" };
  if (stage === "items_canceled") return { title: `⚠️ ${st} canceled ${t.canceled?.length || "some"} item${(t.canceled?.length || 2) === 1 ? "" : "s"}${at}`, body: `${(t.canceled || []).slice(0, 4).join(", ") || "Out of stock"}. You may need to buy ${t.canceled?.length === 1 ? "it" : "them"} somewhere else.`, who: "plan" };
  if (stage === "canceled") return { title: `❌ ${st} order canceled${at}`, body: `Order #${t.no || ""} was canceled.`, who: "plan" };
  if (stage === "picked_up") return { title: `🚗 ${st} driver picked up your order${at}`, body: `On the way now${t.eta ? `, arriving by ${fmtHm(t.eta)}` : " — usually 20–40 min"}${n}. Get ready to receive it.`, who: "all" };
  if (stage === "out_for_delivery") return { title: `🚗 ${st} arriving by ${t.eta ? fmtHm(t.eta) : "soon"}${at}`, body: `${t.driver ? t.driver + " is on the way" : "Out for delivery"}${n}.${t.signature ? " Someone must sign for it." : ""} Get ready to receive it.`, who: "all" };
  if (stage === "delivered") return { title: `✅ ${st} delivered${at}`, body: `It's at the door now${n}. Bring it in (cold items first) and tap Receive delivery in the app.`, who: "all" };
  if (stage === "late1") return { title: `⏰ ${st} delivery still not received${at}`, body: `Delivered ${Math.round((Date.now() - Date.parse(t.deliveredAt)) / 6e4)} min ago. Please bring it in and count it in the app.`, who: "all" };
  if (stage === "late2") return { title: `⏰ ${st} delivery not received after 2 hours${at}`, body: `Nobody has received it in the app yet. Please check it's not left outside.`, who: "plan" };
  if (stage === "late_eta") return { title: `⌛ ${st} is running late${at}`, body: `It was due ${etaText(o)} and hasn't been delivered yet.`, who: "plan" };
  return null;
}

async function deliveryCtx(org: string) {
  const [settings, cfg, links, members, emps, shifts, punches] = await Promise.all([
    docOf(org, "config/settings"), docOf(org, "mgr/cover"), docsOf(org, "links"),
    q(`members?select=user_id,email,role&org_id=eq.${org}`) as Promise<Json[]>, docsOf(org, "employees"),
    q(`docs?select=doc_id,data&org_id=eq.${org}&coll=eq.shifts&data->>date=eq.${etParts().ymd}`) as Promise<{ doc_id: string; data: Json }[]>,
    q(`docs?select=doc_id,data&org_id=eq.${org}&coll=eq.punches&data->>date=eq.${etParts().ymd}`) as Promise<{ doc_id: string; data: Json }[]>,
  ]);
  const locs: Json[] = settings?.locations || [{ id: "wh", name: "West Hartford" }];
  const byId: Json = Object.fromEntries(emps.map((e) => [e.doc_id, e.data]));
  const userOfEmp: Json = {}; links.forEach((l) => { if (l.data?.empId) userOfEmp[l.data.empId] = l.doc_id; });
  const empLoc = (id: string) => byId[id]?.loc || locs[0]?.id;
  const dv = { mgr: true, staff: true, owner: "all", ...((cfg || {}).deliv || {}) };
  const push = (cfg || {}).push !== false;
  function recipients(loc: string, who: string) {
    const nowHm = etParts().hm; const ids = new Set<string>();
    if (dv.mgr) emps.filter((e) => e.data.active !== false && e.data.role === "Manager" && (empLoc(e.doc_id) === loc || (e.data.locs || []).includes(loc))).forEach((e) => userOfEmp[e.doc_id] && ids.add(userOfEmp[e.doc_id]));
    if (dv.staff && who === "all") {
      shifts.filter((s) => (s.data.loc || empLoc(s.data.empId)) === loc && toMin(s.data.end || "23:59") + (toMin(s.data.end) < toMin(s.data.start) ? 1440 : 0) > toMin(nowHm) && toMin(s.data.start) - 90 <= toMin(nowHm)).forEach((s) => userOfEmp[s.data.empId] && ids.add(userOfEmp[s.data.empId]));
      punches.filter((p) => !p.data.out && (p.data.loc || empLoc(p.data.empId)) === loc).forEach((p) => userOfEmp[p.data.empId] && ids.add(userOfEmp[p.data.empId]));
    }
    if (dv.owner === "all" || (dv.owner === "key" && who === "plan")) members.filter((m) => m.role === "owner").forEach((m) => ids.add(m.user_id));
    return [...ids];
  }
  // staff working at this store right now: scheduled now (from 30 min before the start) or clocked in
  function onShift(loc: string) {
    const now = toMin(etParts().hm); const ids = new Set<string>();
    shifts.filter((s) => (s.data.loc || empLoc(s.data.empId)) === loc && toMin(s.data.end || "23:59") + (toMin(s.data.end) < toMin(s.data.start) ? 1440 : 0) > now && toMin(s.data.start) - 30 <= now).forEach((s) => userOfEmp[s.data.empId] && ids.add(userOfEmp[s.data.empId]));
    punches.filter((p) => !p.data.out && (p.data.loc || empLoc(p.data.empId)) === loc).forEach((p) => userOfEmp[p.data.empId] && ids.add(userOfEmp[p.data.empId]));
    return dv.staff ? [...ids] : [];
  }
  const owners = members.filter((m) => m.role === "owner").map((m) => m.user_id);
  // store managers of this store + every regional manager (escalations)
  const managers = (loc: string) => [...new Set(emps.filter((e) => e.data.active !== false && e.data.role === "Manager" && (e.data.regional || empLoc(e.doc_id) === loc || (e.data.locs || []).includes(loc))).map((e) => userOfEmp[e.doc_id]).filter(Boolean))] as string[];
  return { locs, recipients, onShift, managers, push, owners, settings: settings || {}, locName: (id: string) => locs.find((l) => l.id === id)?.name || id };
}
const orderUrl = (id: string) => `${(env("APP_URL") || "").replace(/\/$/, "")}/?order=${id}`;
async function alertOrder(org: string, ctx: Json, id: string, o: Json, stage: string) {
  const a = deliveryAlert(o, stage, ctx.locName(o.loc), ctx.locs.length > 1); if (!a || !ctx.push) return 0;
  const to = ctx.recipients(o.loc, a.who);
  // whoever was told it's at the door already has the receiving job: don't send them the shift reminder too
  if (["delivered", "late1"].includes(stage)) { const pinged = [...new Set([...(o.duty?.pinged || []), ...ctx.onShift(o.loc)])]; o.duty = { ...(o.duty || {}), pinged }; await merge(org, `orders/${id}`, { duty: { pinged } }).catch(() => {}); }
  return await sendPush(to, a.title, a.body, orderUrl(id));
}

// Prep batches (Black Sesame, boba…): remind whoever is on shift before it expires and when it does; if it's still
// not thrown out 30 min after that reminder, tell the store's managers and the regional manager. Pure, for tests.
export function batchAlert(b: Json, now = Date.now()) {
  if (b.status !== "active" || !b.expAt) return null;
  const e = Date.parse(b.expAt), a = b.alerts || {};
  const warn = Math.min(60 * 6e4, Math.max(15 * 6e4, (e - Date.parse(b.madeAt || b.expAt)) * 0.2));
  if (now >= e) { if (!a.exp) return "exp"; if (!a.esc && now - Date.parse(a.exp) >= 30 * 6e4) return "esc"; return null; }
  if (now >= e - warn && !a.soon) return "soon";
  return null;
}
const hmOf = (iso: string) => { const p = etParts(new Date(iso)); return fmtT(p.hm); };
async function batchDuty(org: string, ctx: Json) {
  const out: Json[] = []; if (!ctx.push) return out;
  const rows = (await q(`docs?select=doc_id,data&org_id=eq.${org}&coll=eq.batches&data->>status=eq.active`)) as { doc_id: string; data: Json }[];
  for (const r of rows) {
    const b = r.data; const kind = batchAlert(b); if (!kind) continue;
    const loc = b.loc || ctx.locs[0]?.id; if (ctx.locs.find((l: Json) => l.id === loc)?.stage === "preopen") continue;
    const at = ctx.locs.length > 1 ? ` · ${ctx.locName(loc)}` : "";
    const to: string[] = kind === "esc" ? ctx.managers(loc) : ctx.onShift(loc);
    if (!to.length) continue; // nobody on shift (store closed): try again on the next run
    const title = kind === "soon" ? `⏳ ${b.name} expires at ${hmOf(b.expAt)}${at}` : kind === "exp" ? `🗑️ Throw out ${b.name} now${at}` : `⚠️ ${b.name} expired and is still not thrown out${at}`;
    const body = kind === "soon" ? `Use it first. When it's done or expired, mark it in the app.` : kind === "exp" ? `It expired at ${hmOf(b.expAt)}. Throw it out and tap "Thrown out" in the app with a photo.` : `It expired at ${hmOf(b.expAt)}. Staff were reminded 30 min ago. Please make sure it's thrown out.`;
    await sendPush(to, title, body, `${(env("APP_URL") || "").replace(/\/$/, "")}/`);
    await merge(org, `batches/${r.doc_id}`, { alerts: { [kind]: new Date().toISOString() } });
    out.push({ batch: r.doc_id, kind, to: to.length });
  }
  return out;
}

// Receiving is a job for whoever is on shift that day: when a delivery is at the door (or an order without
// email tracking is due today) and someone starts their shift / clocks in, push them once to count it and take photos.
export function dutyDue(o: Json, today: string, now = Date.now()) {
  if (o.status !== "ordered" || o.kind === "stockin") return false;
  const t = o.track;
  if (t?.deliveredAt) return now - Date.parse(t.deliveredAt) < 14 * 3600e3;
  if (t && t.stage === "canceled") return false;
  if (!t) return !!o.expected && o.expected <= today && o.expected >= addDaysYmd(today, -1);
  return false; // tracked but not delivered yet: the store emails trigger the alerts
}
const addDaysYmd = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function deliveryDuty(org: string, ctx: Json, orders: { id: string; data: Json }[]) {
  const out: Json[] = []; if (!ctx.push) return out; const today = etParts().ymd;
  for (const o of orders) {
    if (!dutyDue(o.data, today)) continue;
    const loc = o.data.loc || ctx.locs[0]?.id; const done = new Set<string>(o.data.duty?.pinged || []);
    const to = ctx.onShift(loc).filter((u: string) => !done.has(u)); if (!to.length) continue;
    const t = o.data.track || {}; const n = t.items || (o.data.lines || []).length; const at = ctx.locs.length > 1 ? ` · ${ctx.locName(loc)}` : "";
    const title = t.deliveredAt ? `📦 ${o.data.store} delivery is waiting${at}` : `📦 ${o.data.store} delivery today${at}`;
    const body = `${t.deliveredAt ? "It was delivered and nobody has received it yet." : `Expected today${o.data.window ? " " + o.data.window : ""}.`}${n ? ` ${n} items.` : ""} Bring it in, count every item and take photos in the app (Receive delivery).`;
    await sendPush(to, title, body, orderUrl(o.id));
    const pinged = [...done, ...to]; o.data.duty = { ...(o.data.duty || {}), pinged };
    await merge(org, `orders/${o.id}`, { duty: { pinged } }); out.push({ order: o.id, duty: to.length });
  }
  return out;
}

// Items canceled (out of stock): look at the bigger picture like a store manager would — has this item been
// canceled before, did any other order bring it, how much is left, when does the store open next — and ask
// the owner to decide. Never orders anything by itself.
async function cancelInsight(org: string, ctx: Json, id: string, o: Json, orders: { id: string; data: Json }[]) {
  const key = env("ANTHROPIC_API_KEY"); const t = o.track || {}; if (!key || !(t.canceled || []).length) return null;
  const since = Date.now() - 21 * 864e5;
  const recent = orders.filter((x) => x.id !== id && Date.parse(x.data.createdAt || x.data.date || "") > since && (x.data.loc || "wh") === o.loc)
    .map((x) => ({ store: x.data.store, ordered: x.data.date, due: x.data.expected, status: x.data.status, stage: x.data.track?.stage, canceled: x.data.track?.canceled || [], ...(x.data.track?.replacedBy ? { note: `owner canceled this order on purpose and replaced it with #${x.data.track.replacedBy} (not a store problem)` } : x.data.track?.selfCanceled?.length ? { ownerRemovedItems: x.data.track.selfCanceled } : {}), arrived: x.data.track?.names || (x.data.lines || []).map((l: Json) => l.name) }));
  const [items, counts] = await Promise.all([docOf(org, "config/items"), q(`docs?select=data&org_id=eq.${org}&coll=eq.counts&order=updated_at.desc&limit=6`) as Promise<Json[]>]);
  const cnt = counts.map((c) => c.data).filter((c) => (c.loc || "wh") === o.loc)[0];
  const stock = (items?.list || []).map((it: Json) => ({ name: it.name, unit: it.unit, min: it.min, par: it.par, lastCount: cnt?.counts?.[it.id] ?? null }));
  const zip = o.loc === "nh" ? "98 Olive St, New Haven, CT 06511" : o.loc === "wh" ? "981 Farmington Ave, West Hartford, CT 06107" : ctx.locName(o.loc) + ", Connecticut";
  const now = etParts(); const hrs = ctx.settings.hours?.[o.loc] || {}; const prep = ctx.settings.prepMin ?? 90;
  const nextDays = [0, 1, 2].map((i) => { const d = addDays(now.ymd, i); const h = hrs[dow(d)]; return h ? { date: d, weekday: DAYS[dow(d)], opens: h[0], closes: h[1], staffArrive: `${String(Math.floor((toMin(h[0]) - prep) / 60)).padStart(2, "0")}:${String((toMin(h[0]) - prep) % 60).padStart(2, "0")}` } : { date: d, closed: true }; });
  const prompt = `You help the owner of a bubble tea / matcha cafe (${ctx.locName(o.loc)}) run supplies. ${o.store} just canceled items from an order because they were out of stock.
Now (New York): ${now.ymd} ${now.hm}. Think like a sharp store manager: has the same item been canceled in other recent orders? Did another order bring it? How much was left at the last count? Will the store run out before it can be restocked (staff arrive for prep at staffArrive, store opens at opens)? Is ordering the same item from ${o.store} again likely to fail?
CHECK ALTERNATIVES with web search, near the store (${zip}), in this order:
 1) Walmart and BJ's first (the owner already has delivery accounts at both): the same item at Walmart (delivery or pickup), and at BJ's — the same item in another size/pack, or the same item for pickup at a nearby club. 
 2) ONLY if neither Walmart nor BJ's has it (or close enough), look further: Target, Stop & Shop, Costco, Whole Foods / Amazon, Instacart.
For each place say whether it shows as in stock, the price, and how fast it could arrive (before staff arrive for prep if possible). Prefer the store's own product page. Never place an order. If a page doesn't say, use "unknown" rather than guessing. List Walmart/BJ's results first.
Reply with JSON only (after any searching):
{"urgent":true|false,
 "zh":{"title":"short push title in Chinese, under 30 chars","body":"2-4 short sentences in Chinese: what was canceled, the pattern (e.g. second time in a row, ordered 4 got 0), the impact on the next opening, and what you suggest. Plain, specific, no fluff."},
 "en":{"title":"same in English, under 45 chars","body":"same in English"},
 "alternatives":[{"store":"Walmart","product":"exact product name and size","price":"$x.xx" or null,"stock":"in stock"|"limited"|"out of stock"|"unknown","when":"e.g. delivery today 6–8pm / pickup 8am" or null,"url":"product page"}]  (best 2-4 places, best first),
 "options":[{"zh":"...","en":"..."}  (2-3 short choices for the owner, based on what you found, e.g. "Order 3 from Walmart, $8.98 each, delivery tonight", use a substitute, already handled)]}
Data:
${JSON.stringify({ order: { store: o.store, number: t.no, due: o.expected, window: t.wStart ? `${t.wStart}-${t.wEnd}` : null, eta: t.eta, stage: t.stage, items: t.items, canceled: t.canceled, arrivedItems: t.names || [] }, recentOrdersThisStore: recent.slice(0, 15), inventory: stock.slice(0, 80), nextDays })}`;
  const call = (tools: boolean) => fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env("MODEL_DEFAULT") || "claude-sonnet-5-5", max_tokens: 2500, messages: [{ role: "user", content: prompt }],
      ...(tools ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6, user_location: { type: "approximate", city: o.loc === "nh" ? "New Haven" : "West Hartford", region: "Connecticut", country: "US", timezone: TZ } }] } : {}) }) });
  try {
    let r = await call(true); let searched = true;
    if (!r.ok) { console.warn("insight+search", r.status, (await r.text()).slice(0, 300)); r = await call(false); searched = false; }
    if (!r.ok) { console.warn("insight", r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json(); const blocks = (j.content || []).filter((c: Json) => c.type === "text").map((c: Json) => c.text || "");
    const txt = blocks.filter((b: string) => b.includes("{")).pop() || blocks.join("");
    const a = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    const alts = (Array.isArray(a.alternatives) ? a.alternatives : []).slice(0, 4).map((x: Json) => ({ store: String(x.store || "").slice(0, 40), product: String(x.product || "").slice(0, 120), price: x.price ? String(x.price).slice(0, 20) : null,
      stock: ["in stock", "limited", "out of stock"].includes(String(x.stock)) ? String(x.stock) : "unknown", when: x.when ? String(x.when).slice(0, 60) : null, url: /^https:\/\//.test(String(x.url || "")) ? String(x.url).slice(0, 400) : null })).filter((x: Json) => x.store);
    if (!a?.zh?.body || !a?.en?.body) return null;
    return { at: new Date().toISOString(), urgent: !!a.urgent, zh: { title: String(a.zh.title || "").slice(0, 60), body: String(a.zh.body).slice(0, 600) }, en: { title: String(a.en.title || "").slice(0, 80), body: String(a.en.body).slice(0, 800) },
      options: (Array.isArray(a.options) ? a.options : []).slice(0, 3).map((x: Json) => ({ zh: String(x.zh || x.en || "").slice(0, 80), en: String(x.en || x.zh || "").slice(0, 100) })), alts, searched, items: t.canceled, answer: null };
  } catch (e) { console.warn("insight", e); return null; }
}

// Price check: for each item, find the identical packaged product at BJ's and at Walmart (web search), with
// price and how many count units one purchase holds, so the app can put each item in the cheaper cart.
export async function priceCheck(org: string, ids: string[], loc: string) {
  const key = env("ANTHROPIC_API_KEY"); if (!key) throw new Error("no ANTHROPIC_API_KEY");
  const items = ((await docOf(org, "config/items"))?.list || []).filter((it: Json) => ids.includes(it.id)).slice(0, 8);
  if (!items.length) return { items: {} };
  const where = loc === "nh" ? "New Haven, CT 06511" : "West Hartford, CT 06107";
  const prompt = `A matcha cafe in ${where} buys supplies by delivery from BJ's Wholesale Club (bjs.com) and Walmart (walmart.com).
For EACH item below, use web search to find the product at BJ's and at Walmart, and its current price. Prefer the IDENTICAL product (same brand, same size) at both stores so prices compare fairly; if the item names a brand/size, match it. If a store doesn't carry it, use the closest equivalent and say so in "note".
"per" = how many of the item's count unit ("unit") one purchase gives (e.g. unit "gallon", BJ's sells a 2-pack of 1 gal → per 2; unit "oz", a 96 oz bottle → per 96). Use the product page or search result price; never guess a price — use null if not found.
Reply with JSON only: {"items":{"<id>":{"BJ's":{"product":"...","price":number|null,"per":number|null,"url":"https://...","stock":"in stock"|"out of stock"|"unknown","note":""},"Walmart":{...}}}}
Items marked anyBrand: any brand is equally good (e.g. whole milk) — find the CHEAPEST product of that kind and size at each store instead of matching the brand.
Items: ${JSON.stringify(items.map((it: Json) => ({ id: it.id, name: it.name, unit: it.unit || "unit", ...(it.anyBrand ? { anyBrand: true } : {}), buyingNow: (it.buy || []).map((b: Json) => ({ store: b.store, label: b.label, per: b.per, price: b.price })) })))}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env("MODEL_DEFAULT") || "claude-sonnet-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: Math.min(16, items.length * 2 + 2), user_location: { type: "approximate", city: loc === "nh" ? "New Haven" : "West Hartford", region: "Connecticut", country: "US", timezone: TZ } }] }) });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json(); const blocks = (j.content || []).filter((c: Json) => c.type === "text").map((c: Json) => c.text || "");
  const txt = blocks.filter((b: string) => b.includes("{")).pop() || "{}";
  const a = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
  const at = new Date().toISOString(); const out: Json = {};
  for (const it of items) {
    const x = a.items?.[it.id]; if (!x) continue; out[it.id] = {};
    for (const st of ["BJ's", "Walmart"]) {
      const v = x[st]; if (!v) continue;
      out[it.id][st] = { product: String(v.product || "").slice(0, 120), price: isFinite(+v.price) && +v.price > 0 ? +v.price : null, per: isFinite(+v.per) && +v.per > 0 ? +v.per : null,
        url: /^https:\/\//.test(String(v.url || "")) ? String(v.url).slice(0, 400) : null, stock: ["in stock", "out of stock"].includes(v.stock) ? v.stock : "unknown", note: String(v.note || "").slice(0, 120), at };
    }
  }
  const prev = (await docOf(org, "mgr/prices")) || {};
  const data = { items: { ...(prev.items || {}), ...out }, at };
  await q("docs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ org_id: org, path: "mgr/prices", coll: "mgr", doc_id: "prices", data }) });
  return { items: out };
}

// keep working after the reply is sent (Supabase Edge Runtime); elsewhere just let it run
const later = (p: Promise<unknown>) => { const er = (globalThis as any).EdgeRuntime; p.catch((e) => console.warn("later", e)); if (er?.waitUntil) er.waitUntil(p); };

// Before return / refund emails were recognized they could become orders ("Return reminder for order #…") or cancel one
// ("Your return has been canceled…"). Pure: says which orders to delete and which to rewrite without those emails.
export function returnCleanup(orders: { id: string; data: Json }[], subjects: Record<string, string>) {
  const isRet = (e: Json) => RETURN_SUBJ.test(String(e.text || "")) || RETURN_SUBJ.test(subjects[e.mid] || "");
  const del: string[] = [], fix: { id: string; data: Json }[] = [];
  for (const o of orders) {
    const t = o.data.track; const ev: Json[] = t?.events || []; const bad = ev.filter(isRet);
    if (!bad.length) continue;
    const keep = ev.filter((e) => !isRet(e));
    if (!keep.length && o.data.src === "email" && !(o.data.lines || []).length && !(o.data.screenshots || []).length) { del.push(o.id); continue; }
    const d = JSON.parse(JSON.stringify(o.data)); const nt = d.track;
    nt.events = keep;
    const wasCanceled = keep.some((e) => e.stage === "canceled");
    nt.stage = wasCanceled ? "canceled" : keep.reduce((a: string, e: Json) => rank(e.stage) > rank(a) ? e.stage : a, "ordered");
    if (d.status === "canceled" && !wasCanceled) d.status = nt.deliveredAt ? "received" : "ordered";
    fix.push({ id: o.id, data: d });
  }
  return { del, fix };
}

export async function onMail(org: string, msgs: Json[]) {
  const seenDoc = (await docOf(org, "owner/mail_seen")) || {}; const seen = new Set<string>(seenDoc.ids || []);
  const fresh = msgs.filter((m) => m && m.id && !seen.has(String(m.id))).slice(0, 25);
  const ctx = await deliveryCtx(org); const out: Json[] = [];
  let orders = (await docsOf(org, "orders")).map((r) => ({ id: r.doc_id, data: r.data }));
  if (!(await docOf(org, "owner/return_cleanup"))) { // once
    const subj: Record<string, string> = {}; for (const x of seenDoc.last || []) if (x?.id) subj[x.id] = String(x.subject || "");
    const { del, fix } = returnCleanup(orders, subj);
    for (const id of del) await q(`docs?org_id=eq.${org}&path=eq.${encodeURIComponent("orders/" + id)}`, { method: "DELETE" });
    for (const f of fix) await q(`docs?org_id=eq.${org}&path=eq.${encodeURIComponent("orders/" + f.id)}`, { method: "PATCH", body: JSON.stringify({ data: f.data, updated_at: new Date().toISOString() }) });
    orders = orders.filter((o) => !del.includes(o.id)).map((o) => fix.find((f) => f.id === o.id) || o);
    await q("docs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ org_id: org, path: "owner/return_cleanup", coll: "owner", doc_id: "return_cleanup", data: { at: new Date().toISOString(), deleted: del, fixed: fix.map((f) => f.id) } }) });
    out.push({ cleanup: { deleted: del.length, fixed: fix.length } });
  }
  fresh.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const m of fresh) {
    m.text = m.text || htmlToText(m.html || ""); const p = await parseMail(m);
    const r = applyMail(orders, p, m, ctx.locs);
    out.push({ id: m.id, subject: String(m.subject || "").slice(0, 80), stage: p.stage, no: p.orderNo, by: p.by, order: r?.id || null });
    seen.add(String(m.id));
    if (!r) continue;
    if (r.isNew) { await q("docs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ org_id: org, path: `orders/${r.id}`, coll: "orders", doc_id: r.id, data: r.data }) }); orders.push({ id: r.id, data: r.data }); }
    else { await q(`docs?org_id=eq.${org}&path=eq.${encodeURIComponent("orders/" + r.id)}`, { method: "PATCH", body: JSON.stringify({ data: r.data, updated_at: new Date().toISOString() }) }); const i = orders.findIndex((o) => o.id === r.id); orders[i] = { id: r.id, data: r.data }; }
    // Don't alert for old emails (first run, or the script was off for a while)
    const recent = Date.now() - Date.parse(m.date || "") < 3 * 3600e3;
    const outOfStock = async () => {
      // researching alternatives takes a minute: send the plain alert now, the full picture when it's ready
      await alertOrder(org, ctx, r.id, r.data, "items_canceled");
      const id = r.id, snap = JSON.parse(JSON.stringify(r.data)), all = orders.slice();
      later((async () => {
        const ask = await cancelInsight(org, ctx, id, snap, all); if (!ask) return;
        await merge(org, `orders/${id}`, { track: { ask } });
        if (ctx.push) { const url = orderUrl(id); await sendPush(ctx.owners, ask.zh.title, ask.zh.body, url); await sendPush(ctx.recipients(snap.loc, "plan").filter((u: string) => !ctx.owners.includes(u)), ask.en.title, ask.en.body, url); }
      })());
    };
    if (r.event === "items_canceled" && recent) { await outOfStock(); continue; }
    if (r.event && recent && (r.data.status === "ordered" || r.event === "canceled")) await alertOrder(org, ctx, r.id, r.data, r.event!);
    // Walmart's "delivered" email can also list items that were unavailable: alert for those too
    if (recent && r.newCanceled?.length && !p.self && r.event !== "canceled") await outOfStock();
  }
  const ids = [...seen].slice(-600);
  await q("docs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ org_id: org, path: "owner/mail_seen", coll: "owner", doc_id: "mail_seen", data: { ids, at: new Date().toISOString(), last: [...out, ...(seenDoc.last || [])].slice(0, 40) } }) });
  out.push(...await deliveryReminders(org, ctx, orders));
  out.push(...await deliveryDuty(org, ctx, orders));
  return out;
}

// Delivered but nobody tapped "Receive" → remind (30 min, then 2 h). Past the ETA and not delivered → tell managers once.
export function remindersDue(o: Json, now = Date.now()) {
  const t = o.track; if (!t || o.status !== "ordered") return null;
  const r = t.rem || {};
  if (t.deliveredAt) { const m = (now - Date.parse(t.deliveredAt)) / 6e4; if (m > 600) return null; if (m >= 120 && !r.late2) return "late2"; if (m >= 30 && !r.late1) return "late1"; return null; }
  if (t.etaAt && !r.late_eta && rank(t.stage) < 3) { const m = (now - Date.parse(t.etaAt)) / 6e4; if (m >= 30 && m < 240) return "late_eta"; }
  return null;
}
async function deliveryReminders(org: string, ctx: Json, orders: { id: string; data: Json }[]) {
  const out: Json[] = [];
  for (const o of orders) {
    const k = remindersDue(o.data); if (!k) continue;
    const rem = { ...(o.data.track.rem || {}), [k]: new Date().toISOString() }; o.data.track.rem = rem;
    await merge(org, `orders/${o.id}`, { track: { rem } }); await alertOrder(org, ctx, o.id, o.data, k); out.push({ order: o.id, reminder: k });
  }
  return out;
}

/* ───────────────────────── HTTP ───────────────────────── */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const twiml = (inner: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, { headers: { "Content-Type": "text/xml" } });

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url); const a = url.searchParams.get("a");

  // Twilio: keypress on a call
  if (a === "voice") {
    const form = Object.fromEntries((await req.formData()) as any) as Record<string, string>;
    const o = url.searchParams.get("o") || "", c = url.searchParams.get("c") || "", e = url.searchParams.get("e") || "";
    if (url.searchParams.get("t") !== (await callToken(o, c, e))) return new Response("forbidden", { status: 403 });
    if (form.Digits !== "1") return twiml(`<Say voice="Polly.Joanna">No problem. Thank you. Goodbye.</Say>`);
    const r = await respondAs(o, c, e, "call");
    const say = r === "assigned" ? "Thank you! The shift is yours. Your manager has been told." : r === "volunteered" ? "Thank you! Your manager will confirm with you soon." : "Sorry, this shift has already been covered. Thank you anyway.";
    return twiml(`<Say voice="Polly.Joanna">${xml(say)}</Say>`);
  }
  // Twilio: text message reply
  if (a === "sms") {
    const form = Object.fromEntries((await req.formData()) as any) as Record<string, string>;
    const sig = req.headers.get("x-twilio-signature") || ""; const tok = env("TWILIO_TOKEN");
    const publicUrl = `${SB()}/functions/v1/cover?a=sms`;
    if (!tok || sig !== (await twilioSig(tok, publicUrl, form))) return new Response("forbidden", { status: 403 });
    const from = phoneE164(form.From), body = String(form.Body || "").trim().toLowerCase();
    if (!/^(y|yes|1|ok|sure|i can)\b/.test(body)) return twiml(`<Message>Thanks. Reply YES if you can take the shift.</Message>`);
    const open = (await q("docs?select=org_id,doc_id,data&coll=eq.cover&data->>status=eq.open")) as { org_id: string; doc_id: string; data: Json }[];
    open.sort((x, y) => String(x.data.startsAt).localeCompare(String(y.data.startsAt)));
    for (const row of open) {
      const emps = await docsOf(row.org_id, "employees");
      const me = emps.find((d) => phoneE164(d.data?.phone) === from && (row.data.elig || []).includes(d.doc_id));
      if (!me) continue;
      const r = await respondAs(row.org_id, row.doc_id, me.doc_id, "sms");
      const msg = r === "assigned" ? `You're on! ${fmtDay(row.data.date)} ${fmtT(row.data.start)}–${fmtT(row.data.end)}. Thank you.` : r === "volunteered" ? "Thanks! Your manager will confirm with you soon." : "Sorry, that shift was already covered. Thank you anyway!";
      return twiml(`<Message>${xml(msg)}</Message>`);
    }
    return twiml(`<Message>We couldn't find an open shift for this number. Please check the app.</Message>`);
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Json = {}; try { body = await req.json(); } catch { /* */ }

  if (body.action === "tick") {
    if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return json({ error: "forbidden" }, 403);
    return json(await tick());
  }
  if (body.action === "vapid") return json({ publicKey: (await vapidKeys()).publicKey });

  // Store emails from the owner's Gmail (Apps Script, signed with the owner's Google token)
  if (body.action === "mail") {
    const gtok = String(body.token || req.headers.get("x-google-token") || "");
    const email = await googleEmail(gtok);
    if (!email) return json({ error: "unauthorized", why: (WHY || "?") + ` (token ${gtok.length} chars, ${gtok.split(".").length} parts)` }, 401);
    const own = (await q(`members?select=org_id&role=eq.owner&email=eq.${encodeURIComponent(email)}`)) as Json[];
    if (!own.length) return json({ error: "forbidden", email }, 403);
    try { const res: Json[] = []; for (const o of own) res.push(...await onMail(o.org_id, Array.isArray(body.msgs) ? body.msgs : [])); return json({ ok: true, res }); }
    catch (e) { console.warn(e); return json({ error: "failed", message: String((e as Error).message || e) }, 500); }
  }

  // Everything else: a signed-in member of that business.
  const auth = req.headers.get("Authorization") || "";
  const who = await fetch(`${SB()}/auth/v1/user`, { headers: { Authorization: auth, apikey: env("SUPABASE_ANON_KEY") } });
  if (!who.ok) return json({ error: "unauthorized" }, 401);
  const me = await who.json(); const org = String(body.org_id || "");
  const mem = ((await q(`members?select=role,email&org_id=eq.${org}&user_id=eq.${me.id}`)) as Json[])[0];
  if (!mem) return json({ error: "forbidden" }, 403);

  try {
    if (body.action === "open") return json(await notifyOpen(org, String(body.cid)));
    if (body.action === "responded" || body.action === "assigned") return json(await notifyChange(org, String(body.cid)));
    if (body.action === "sched") return json(await notifySched(org, mem.role, body));
    if (body.action === "prices") { // manager/owner: compare BJ's vs Walmart for these items now
      if (mem.role === "staff") return json({ error: "forbidden" }, 403);
      return json(await priceCheck(org, (Array.isArray(body.items) ? body.items : []).map(String), String(body.loc || "wh")));
    }
    if (body.action === "alts") { // manager/owner: look for canceled items at other stores now
      if (mem.role === "staff") return json({ error: "forbidden" }, 403);
      const oid = String(body.order || ""); const orders = (await docsOf(org, "orders")).map((r) => ({ id: r.doc_id, data: r.data }));
      const o = orders.find((x) => x.id === oid); if (!o) return json({ error: "not_found" }, 404);
      const trial = Array.isArray(body.items) && body.items.length; // "what if these were canceled" — look only, don't save
      const od = trial ? { ...o.data, track: { ...(o.data.track || {}), canceled: body.items.slice(0, 5).map((x: unknown) => String(x).slice(0, 80)) } } : o.data;
      const ask = await cancelInsight(org, await deliveryCtx(org), oid, od, orders);
      if (!ask) return json({ error: "failed" }, 500);
      if (trial) return json({ ok: true, trial: true, ask });
      await merge(org, `orders/${oid}`, { track: { ask } }); return json({ ok: true, ask });
    }
    if (body.action === "test") {
      if (mem.role === "staff") return json({ error: "forbidden" }, 403);
      const to = String(body.to || ""), ch = body.channel;
      if (ch === "sms") return json(await sendSms(phoneE164(to), "BLISS test text: shift-cover texts are working."));
      if (ch === "call") return json(await sendCall(phoneE164(to), `<Response><Say voice="Polly.Joanna">This is a test call from BLISS. Shift cover calls are working. Goodbye.</Say></Response>`));
      if (ch === "email") return json(await sendEmail(to || mem.email, "BLISS test email", "Shift-cover emails are working."));
      if (ch === "push") return json({ ok: (await sendPush([me.id], "BLISS test", "Phone notifications are working.", appUrl(""))) > 0, why: "no device turned on notifications yet" });
    }
  } catch (e) { console.warn(e); return json({ error: "failed", message: String((e as Error).message || e) }, 500); }
  return json({ error: "bad_request" }, 400);
}
if (DENO?.serve) DENO.serve(handle);
export { handle };
