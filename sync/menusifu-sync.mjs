// BLISS · Menusifu → app hourly sales sync (runs in GitHub Actions, no computer needed).
// Signs in to Menusifu Cloud in a headless browser, reads each store's sales per hour for the
// days that are missing, and saves them through the database function bliss_menusifu_put().
// The repository is public, so this script never logs sales numbers, tokens or page contents —
// only counts, dates and short status messages.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const env = (k, d) => { const v = process.env[k]; if (v == null || v === "") { if (d !== undefined) return d; throw new Error(`Missing setting ${k}`); } return v; };
const EMAIL = env("MENUSIFU_EMAIL"), PASSWORD = env("MENUSIFU_PASSWORD"), SYNC_SECRET = env("BLISS_SYNC_SECRET");
const SB_URL = env("SUPABASE_URL"), SB_ANON = env("SUPABASE_ANON_KEY");
const BUSINESS = env("MENUSIFU_BUSINESS", "Bliss");
// Menusifu branch id → app store id
const STORES = Object.fromEntries(env("MENUSIFU_STORES", "M000023561=nh,M000026022=wh").split(",").map((p) => p.trim().split("=")));
const BACKFILL_DAYS = +env("BACKFILL_DAYS", "400");
const REFETCH_DAYS = +env("REFETCH_DAYS", "3");
const FULL = env("FULL_REFETCH", "") === "true"; // re-read all history (e.g. after adding new columns) // re-read the last few days in case late orders were added
const ORIGIN = "https://cloud.menusifucloud.com";
const ORDER_TYPES = ["DINE_IN", "DOORDASH_D_DELIVERY", "DOORDASH_D_PICKUP", "GRUBHUB_D_DELIVERY", "ONLINE_PICKUP", "TOGO", "UBER_EATS_D_DELIVERY", "UBER_EATS_D_PICKUP"];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const nyDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Saving to the app failed (${r.status}): ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const status = (s) => rpc("bliss_menusifu_put", { p_secret: SYNC_SECRET, p_loc: null, p_days: null, p_status: { at: new Date().toISOString(), ...s } }).catch((e) => log("could not save status:", e.message));

async function signIn(page) {
  log("opening Menusifu sign-in");
  await page.goto(`${ORIGIN}/B/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const user = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i], input[placeholder*="mail" i], input[placeholder*="user" i], input[type="text"]').first();
  const pass = page.locator('input[type="password"]').first();
  try { await user.waitFor({ state: "visible", timeout: 30000 }); await pass.waitFor({ state: "visible", timeout: 10000 }); }
  catch (e) { await describePage(page); throw new Error("Could not find the Menusifu sign-in boxes"); }
  await user.fill(EMAIL); await pass.fill(PASSWORD);
  const btn = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")').first();
  if (await btn.count()) await btn.click(); else await pass.press("Enter");
  // signed in once we leave the login page; stop early on a verification-code or error screen
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await page.waitForTimeout(1500);
    const url = page.url();
    if (!/\/login/i.test(url)) break;
    const txt = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (/verification code|verify|one-time|mfa|captcha|robot/.test(txt)) throw new Error("Menusifu asked for a verification step — automatic sign-in can't continue");
    if (/incorrect|invalid|wrong password|not exist|failed/.test(txt)) throw new Error("Menusifu rejected the email or password");
  }
  if (/\/login/i.test(page.url())) { await describePage(page); throw new Error("Still on the sign-in page after 60 seconds"); }
  // pick the business if Menusifu shows a chooser
  const pick = page.getByText(new RegExp(BUSINESS, "i")).first();
  if (!/\/report/.test(page.url()) && (await pick.count())) { await pick.click().catch(() => {}); }
  await page.waitForURL(/\/report/, { timeout: 60000 }).catch(() => {});
  if (!/\/report/.test(page.url())) {
    await page.goto(`${ORIGIN}/B/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/report/, { timeout: 60000 }).catch(() => {});
  }
  if (!/\/report/.test(page.url())) { await describePage(page); throw new Error("Signed in, but the sales reports did not open"); }
  log("signed in");
}

// Only structure, never values or page text (the Actions log is public).
async function describePage(page) {
  const d = await page.evaluate(() => ({
    path: location.pathname,
    inputs: [...document.querySelectorAll("input")].map((i) => `${i.type}|${i.name}|${i.placeholder}`).slice(0, 10),
    buttons: [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim().slice(0, 30)).filter(Boolean).slice(0, 10),
  })).catch(() => null);
  log("page structure:", JSON.stringify(d));
}

// Open Breakdowns once so the page makes its own hourly-report request, and reuse its headers.
// Open Breakdowns so the page makes its own report requests, then try each one's headers on a recent day:
// the one that returns the hourly "Sales Summary" table is the Breakdowns report. (Checking the page's own reply
// doesn't work early in the morning: today has no sales yet, so Menusifu sends no hourly table for today.)
async function captureHeaders(page) {
  const cands = [], seen = new Set();
  let armed = false;
  page.on("request", (r) => {
    if (!armed || !r.url().includes("/cloud-report-service/fetchReportData")) return;
    const h = r.headers(), k = h.reportid || h.reportId || JSON.stringify(h);
    if (!seen.has(k)) { seen.add(k); cands.push(h); }
  });
  const tab = page.getByText("Breakdowns", { exact: true }).first();
  await tab.waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  armed = true;
  await tab.click();
  await page.waitForTimeout(6000);
  const keep = ["accept", "content-type", "_domain", "_merchantid", "reportid", "merchants", "businessid", "token"];
  const pick = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => keep.includes(k.toLowerCase())));
  const merchant = Object.keys(STORES)[0], y = addDays(nyDate(), -1);
  for (const h of cands.reverse()) {            // Breakdowns' request comes last
    const hdr = pick(h);
    for (const d of [y, addDays(y, -1), addDays(y, -7)]) {
      const ok = await page.evaluate(async ({ hdr, merchant, d, end, types }) => {
        const r = await fetch("/api/cloud-report-service/fetchReportData", { method: "POST", headers: { ...hdr, merchants: JSON.stringify([merchant]) },
          body: JSON.stringify({ orderType: types, curDate: { startDate: d, endDate: end }, linkFrontEnd: "dateRange", secret: "", frontEndTest: "", locale: "en-US" }) });
        if (!r.ok) return false;
        const j = await r.json().catch(() => null);
        return (j?.reportData?.serviceData || []).some((x) => x.title === "Sales Summary" && x.style === "table" && (x.data?.labels || []).some((l) => /^\d\d(AM|PM)$/.test(l)));
      }, { hdr, merchant, d, end: addDays(d, 1), types: ORDER_TYPES }).catch(() => false);
      if (ok) { log(`hourly report found (${cands.length} report requests seen)`); return hdr; }
    }
  }
  await describePage(page);
  throw new Error(`The hourly report did not load (${cands.length} report requests seen)`);
}

async function fetchDay(page, hdr, merchant, date) {
  return page.evaluate(async ({ hdr, merchant, date, end, types }) => {
    const h = { ...hdr, merchants: JSON.stringify([merchant]) };
    const r = await fetch("/api/cloud-report-service/fetchReportData", { method: "POST", headers: h, body: JSON.stringify({ orderType: types, curDate: { startDate: date, endDate: end }, linkFrontEnd: "dateRange", secret: "", frontEndTest: "", locale: "en-US" }) });
    if (!r.ok) return { err: r.status };
    const j = await r.json();
    const t = (j?.reportData?.serviceData || []).find((s) => s.title === "Sales Summary" && s.style === "table");
    // headers were verified on a real hourly report, so a day without the table simply had no sales;
    // only a reply with no report data at all is an error
    if (!t) return Array.isArray(j?.reportData?.serviceData) ? { out: {} } : { err: "no report data" };
    // per hour: [net sales, orders, tips, tax, account receivable]
    const labels = t.data.labels.slice(1), names = t.data.dataSets[0].data, out = {};
    const at = (col, name) => { const i = names.indexOf(name); return i < 0 ? 0 : +String(col[i]).replace(/[$,]/g, "") || 0; };
    labels.forEach((l, j2) => { const col = t.data.dataSets[j2 + 1]?.data || []; const m = /^(\d\d)(AM|PM)$/.exec(l); if (!m) return; const hh = (+m[1] % 12) + (m[2] === "PM" ? 12 : 0);
      out[hh] = [at(col, "Net Sales"), Math.round(at(col, "Orders")), at(col, "Total Tips"), at(col, "Tax"), at(col, "Account Receivable")]; });
    return { out };
  }, { hdr, merchant, date, end: addDays(date, 1), types: ORDER_TYPES });
}

async function main() {
  const yesterday = addDays(nyDate(), -1);
  const info = (await rpc("bliss_menusifu_last", { p_secret: SYNC_SECRET })) || {};
  const last = info.last || {};
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: "en-US", timezoneId: "America/New_York", viewport: { width: 1350, height: 900 } })).newPage();
  const done = {};
  try {
    await signIn(page);
    const hdr = await captureHeaders(page);
    for (const [merchant, loc] of Object.entries(STORES)) {
      const from = last[loc] && !FULL ? addDays(last[loc], -REFETCH_DAYS + 1) : addDays(yesterday, -BACKFILL_DAYS + 1);
      const days = {}; let errs = 0;
      for (let d = from; d <= yesterday; d = addDays(d, 1)) {
        let r = null;
        for (let t = 0; t < 3 && !r?.out; t++) { r = await fetchDay(page, hdr, merchant, d).catch(() => null); if (!r?.out) await page.waitForTimeout(1500); }
        if (r?.out) { if (Object.keys(r.out).length) days[d] = r.out; } else errs++;
      }
      if (errs > 5) throw new Error(`Menusifu stopped answering for store ${loc} (${errs} days failed)`);
      const n = Object.keys(days).length;
      const span = Math.round((new Date(yesterday) - new Date(from)) / 864e5) + 1;
      if (!n && span >= 7) throw new Error(`No sales came back for store ${loc} over ${span} days — the report may have changed`);
      if (n) await rpc("bliss_menusifu_put", { p_secret: SYNC_SECRET, p_loc: loc, p_days: days, p_status: null });
      done[loc] = n; log(`store ${loc}: ${from} → ${yesterday}, saved ${n} days with sales`);
    }
    const planned = await staffingNeeds(info).catch((e) => { log("staffing needs not updated:", e.message); return null; });
    await status({ ok: true, through: yesterday, saved: done, ...(planned ? { needsThrough: planned } : {}) });
    log("done");
  } catch (e) {
    log("FAILED:", e.message);
    await status({ ok: false, error: String(e.message).slice(0, 200), saved: done });
    process.exitCode = 1;
  } finally { await browser.close(); }
}

// Managers can't read sales, so compute their staffing needs here with the app's own forecast code
// (the "sales forecast → staffing" block of index.html) and save only people per hour + a weather label.
async function staffingNeeds(info) {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const a = html.indexOf("/* ---------- sales forecast → staffing"), b = html.indexOf("/* hourly sales import");
  if (a < 0 || b < 0) throw new Error("forecast code not found in index.html");
  const hourly = (await rpc("bliss_menusifu_hourly", { p_secret: SYNC_SECRET })) || {};
  const today = nyDate();
  const ctx = vm.createContext({ fetch, console, Math, Date, JSON, Object, Array, Promise, String, Number, isFinite, parseInt, parseFloat, WeakMap, Set, Intl, encodeURIComponent });
  vm.runInContext(`
    const localStorage={getItem:()=>null,setItem:()=>{}};
    const D={hourly:${JSON.stringify(hourly)},schedCfg:{forecast:${JSON.stringify(info.forecast || {})}},settings:{staffing:${JSON.stringify(info.staffing || {})}}};
    const DOW=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const DEF_NEEDS=[{start:'11:00',end:'17:00',n:2},{start:'17:00',end:'22:30',n:2}];
    function needsFor(loc,dow){const l=D.settings.staffing?.[loc]?.[dow];return Array.isArray(l)?l:DEF_NEEDS}
    const pad=n=>String(n).padStart(2,'0');const ymd=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
    const parseYmd=s=>{const[y,m,d]=String(s).split('-').map(Number);return new Date(y,(m||1)-1,d||1)};
    const today=()=>${JSON.stringify(today)};const addDays=(s,n)=>{const d=parseYmd(s);d.setDate(d.getDate()+n);return ymd(d)};
    const toMin=t=>{if(!t)return 0;const[h,m]=t.split(':').map(Number);return h*60+(m||0)};
    ${html.slice(a, b)}
    globalThis.__fc={fcDay,fcNeeds,wxAll,wxLabel};`, ctx);
  await ctx.__fc.wxAll();
  let lastDate = null;
  for (const loc of Object.keys(hourly)) {
    const dates = {};
    for (let i = 0; i < 21; i++) {
      const d = addDays(today, i), r = ctx.__fc.fcNeeds(loc, d);
      if (!r.fc?.ok) continue;
      dates[d] = { needs: r.needs, hours: Object.fromEntries(Object.entries(r.fc.hours).map(([h, x]) => [h, x.need])), wx: ctx.__fc.wxLabel(r.fc.wx) };
      lastDate = d;
    }
    await rpc("bliss_menusifu_needs", { p_secret: SYNC_SECRET, p_loc: loc, p_dates: dates });
    log(`store ${loc}: staffing needs for ${Object.keys(dates).length} days`);
  }
  return lastDate;
}
main();
