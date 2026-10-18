// BLISS Manager · "cover" Edge Function — finding someone to cover a shift.
//
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
