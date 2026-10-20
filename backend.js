/* BLISS Manager · backend bridge
 * Signs people in with Supabase (email + one-time code) and gives the app the same
 * small data API it used inside Claude: db, user, assets, sample (Claude AI), downloads.
 */
(function () {
  "use strict";
  const CFG = window.BLISS_CONFIG;
  const SB = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  window.BLOB = `${CFG.supabaseUrl}/storage/v1/object/public/${CFG.photoBucket}/`;

  let ORG = null, ROLE = null, UID = null, EMAIL = null, ORGS = [];
  let readyResolve; const ready = new Promise((r) => (readyResolve = r));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return localStorage.getItem("bliss." + k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem("bliss." + k, v); } catch (e) {} };

  /* ───────────── sign-in screen ───────────── */
  const host = document.createElement("div");
  host.id = "auth";
  document.body.appendChild(host);
  const css = document.createElement("style");
  css.textContent = `#auth{position:fixed;inset:0;z-index:100;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:24px max(16px,env(safe-area-inset-left,0px));overflow:auto}
  #auth .box{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px}
  #auth .brand{text-align:center;margin-bottom:8px}#auth .brand .mk{width:84px;height:84px;margin:0 auto 14px;background:var(--brand);-webkit-mask:url(logo-mark.png) center/contain no-repeat;mask:url(logo-mark.png) center/contain no-repeat}#auth .brand b{font-family:var(--display);font-weight:800;font-size:40px;letter-spacing:.16em;color:var(--brand)}
  #auth .brand small{display:block;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-top:4px}
  #auth .code{font-size:28px;letter-spacing:.5em;text-align:center;font-weight:700}
  #auth .err{color:var(--bad);font-size:14px;min-height:20px}#auth .link{background:none;border:0;color:var(--info);font-weight:600;cursor:pointer;padding:6px}`;
  document.head.appendChild(css);

  function screen(html) { host.hidden = false; host.innerHTML = `<div class="box"><div class="brand"><div class="mk" role="img" aria-label="BLISS logo"></div><b>BLISS</b><small>Matcha &amp; Beyond</small></div>${html}</div>`; }
  function hideAuth() { host.hidden = true; host.innerHTML = ""; }
  const errOf = (e) => e?.message || String(e || "Something went wrong");

  function showEmail(msg) {
    screen(`<h2 style="text-align:center">Sign in</h2>
      <p class="muted small" style="text-align:center">Enter your email. We'll send you a sign-in code.</p>
      <label class="f">Email<input class="in" id="au_email" type="email" autocomplete="email" inputmode="email" value="${esc(lsGet("email") || "")}" placeholder="you@example.com"></label>
      <button class="btn pri big" id="au_send">Send code</button><div class="err" id="au_err">${esc(msg || "")}</div>`);
    const go = async () => {
      const email = document.getElementById("au_email").value.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) { document.getElementById("au_err").textContent = "Enter a valid email address."; return; }
      const b = document.getElementById("au_send"); b.disabled = true; b.textContent = "Sending…";
      // Accounts are created when a manager or owner adds the email, so unknown emails get a clear message.
      const { error } = await SB.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
      if (error) {
        b.disabled = false; b.textContent = "Send code";
        const m = errOf(error);
        document.getElementById("au_err").textContent = /signups? not allowed|not found|user/i.test(m) && !/rate/i.test(m)
          ? "This email isn't on a team yet. Ask your manager to add it in Team → People, then try again."
          : m;
        return;
      }
      lsSet("email", email); showCode(email);
    };
    document.getElementById("au_send").onclick = go;
    document.getElementById("au_email").onkeydown = (e) => { if (e.key === "Enter") go(); };
  }

  function showCode(email) {
    screen(`<h2 style="text-align:center">Check your email</h2>
      <p class="muted small" style="text-align:center">We sent a code to <b>${esc(email)}</b>. Enter it below. Check Spam if it is not in your inbox.</p>
      <input class="in code" id="au_code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code" aria-label="Code">
      <button class="btn pri big" id="au_ok">Sign in</button><div class="err" id="au_err"></div>
      <button class="link" id="au_back">Use a different email</button>`);
    const go = async () => {
      const token = document.getElementById("au_code").value.replace(/\D/g, "");
      if (token.length < 6) { document.getElementById("au_err").textContent = "Enter the code from the email."; return; }
      const b = document.getElementById("au_ok"); if (b.disabled) return; b.disabled = true; b.textContent = "Checking…";
      const { error } = await SB.auth.verifyOtp({ email, token, type: "email" });
      if (error) { b.disabled = false; b.textContent = "Sign in"; document.getElementById("au_err").textContent = "That code didn't work. Check it or request a new one."; }
    };
    document.getElementById("au_ok").onclick = go;
    // Codes can be 6–10 digits (a Supabase setting). Submit by itself only when the whole code
    // arrives at once (paste or the phone's code autofill); otherwise the person taps Sign in.
    document.getElementById("au_code").oninput = (e) => {
      const n = e.target.value.replace(/\D/g, "").length;
      const whole = e.inputType === "insertFromPaste" || e.inputType === "insertReplacementText" || !e.inputType;
      if (whole && n >= 6) go();
    };
    document.getElementById("au_code").onkeydown = (e) => { if (e.key === "Enter") go(); };
    document.getElementById("au_back").onclick = () => showEmail();
    setTimeout(() => document.getElementById("au_code")?.focus(), 50);
  }

  function showNoAccess() {
    screen(`<h2 style="text-align:center">Almost there</h2>
      <p style="text-align:center">You're signed in as <b>${esc(EMAIL)}</b>, but this email isn't on a team yet.</p>
      <div class="hint">Staff: ask your manager to add <b>${esc(EMAIL)}</b> as your email in Team → People, then tap "Try again".</div>
      <button class="btn pri" id="au_retry">Try again</button>
      <details class="card"><summary style="cursor:pointer;font-weight:600">I'm a business owner — set up a new business</summary>
        <div class="stack" style="margin-top:12px">
          <label class="f">Business name<input class="in" id="au_org" placeholder="e.g. BLISS Matcha & Beyond"></label>
          <label class="f">Store locations (one per line)<textarea class="in" id="au_locs" rows="3" placeholder="West Hartford&#10;NH Olive St"></textarea></label>
          <button class="btn" id="au_create">Create business</button>
        </div></details>
      <div class="err" id="au_err"></div><button class="link" id="au_out">Sign out</button>`);
    document.getElementById("au_retry").onclick = afterSignIn;
    document.getElementById("au_out").onclick = signOut;
    document.getElementById("au_create").onclick = async () => {
      const name = document.getElementById("au_org").value.trim();
      const lines = document.getElementById("au_locs").value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!name) { document.getElementById("au_err").textContent = "Enter the business name."; return; }
      const used = new Set();
      const locations = (lines.length ? lines : ["Main store"]).map((n) => {
        let id = n.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "store"; while (used.has(id)) id += "x"; used.add(id); return { id, name: n };
      });
      const { error } = await SB.rpc("create_org", { org_name: name, locations });
      if (error) { document.getElementById("au_err").textContent = errOf(error); return; }
      afterSignIn();
    };
  }

  function showPickOrg() {
    screen(`<h2 style="text-align:center">Choose a business</h2>
      ${ORGS.map((o, i) => `<button class="btn big" data-i="${i}">${esc(o.org_name)} <span class="muted small">· ${esc(o.role)}</span></button>`).join("")}
      <button class="link" id="au_out">Sign out</button>`);
    host.querySelectorAll("button[data-i]").forEach((b) => (b.onclick = () => useOrg(ORGS[+b.dataset.i])));
    document.getElementById("au_out").onclick = signOut;
  }

  // Only one sign-in check runs at a time (page load and the auth event can both start one).
  let signing = null;
  function afterSignIn() { if (!signing) signing = doSignIn().finally(() => { signing = null; }); return signing; }
  async function doSignIn() {
    if (started) return;
    const { data: { session } } = await SB.auth.getSession();
    if (!session) return showEmail();
    UID = session.user.id; EMAIL = session.user.email;
    screen(`<p class="muted" style="text-align:center">Loading your team…</p>`);
    const { data, error } = await SB.rpc("claim_membership");
    if (error) return screen(`<div class="hint warn">Could not load your account: ${esc(errOf(error))}</div><button class="btn" onclick="location.reload()">Retry</button>`);
    ORGS = data || [];
    if (!ORGS.length) return showNoAccess();
    const last = lsGet("org"); const pick = ORGS.find((o) => o.org_id === last);
    if (pick || ORGS.length === 1) return useOrg(pick || ORGS[0]);
    showPickOrg();
  }

  let started = false;
  function useOrg(o) {
    ORG = o.org_id; ROLE = o.role; lsSet("org", ORG);
    const rpc = async (fn, args) => { const { data, error } = await SB.rpc(fn, { o: ORG, ...args }); if (error) throw new Error(error.message); return data; };
    window.blissAccount = {
      email: EMAIL, org: o.org_name, role: ROLE, orgs: ORGS, signOut,
      switchOrg: () => { lsSet("org", ""); location.reload(); },
      // owner tools
      listOwners: () => rpc("list_owners", {}),
      addOwner: async (email) => {
        const r = await rpc("add_owner", { owner_email: email });
        if (r === "invited") await window.blissAccount.ensureUsers([email]).catch((e) => console.warn(e));
        return r;
      },
      removeOwner: (email) => rpc("remove_owner", { owner_email: email }),
      // Create sign-in accounts for team emails (runs the "team" Edge Function).
      ensureUsers: async (emails) => {
        const list = (emails || []).filter(Boolean);
        if (!list.length) return { created: [], existing: [], skipped: [] };
        const { data, error } = await SB.functions.invoke("team", { body: { org_id: ORG, emails: list } });
        if (error) throw new Error("Could not create the sign-in account. Is the \"team\" function deployed?");
        return data;
      },
      // After a "no permission" error: if this person's access changed (role changed or removed), reload.
      recheck: async () => {
        // Never reload on a failed check (phones often have no network for a moment after the camera closes),
        // or while someone is taking a photo or uploading.
        if (window.BLISS_BUSY?.()) return;
        const { data, error } = await SB.rpc("claim_membership");
        if (error || !Array.isArray(data) || window.BLISS_BUSY?.()) return;
        const now = data.find((x) => x.org_id === ORG);
        if (!now || now.role !== ROLE) location.reload();
      },
      renameOrg: async (name) => { await rpc("rename_org", { new_name: name }); window.blissAccount.org = name.trim(); },
    };
    // Shift cover: database rules in schema.sql (cover_*), notifications in the "cover" Edge Function.
    const coverFn = async (body) => {
      const { data, error } = await SB.functions.invoke("cover", { body: { org_id: ORG, ...body } });
      if (error) throw new Error("Couldn't reach the \"cover\" function. Is it deployed?");
      return data;
    };
    const b64 = (s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0)); };
    // after a change, re-read cover requests and shifts right away (don't wait for the live update)
    const crpc = async (fn, args) => { const r = await rpc(fn, args); refresh("cover"); refresh("shifts"); return r; };
    window.blissCover = {
      request: (a) => crpc("cover_request", a),
      respond: (cid, emp) => (emp ? crpc("cover_respond_for", { cid, emp }) : crpc("cover_respond", { cid })),
      withdraw: (cid) => crpc("cover_withdraw", { cid }),
      assign: (cid, emp, by_name) => crpc("cover_assign", { cid, emp, by_name }),
      cancel: (cid, by_name) => crpc("cover_cancel", { cid, by_name }),
      notify: (action, cid) => coverFn({ action, cid }),
      alts: (order) => coverFn({ action: "alts", order }),
      test: (channel, to) => coverFn({ action: "test", channel, to }),
      notifySched: (event, loc, ws, note) => coverFn({ action: "sched", event, loc, ws, note }),
      // Phone notifications ("web push"). On iPhone this needs the app added to the Home Screen first.
      pushSupported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
      pushState: async () => {
        if (!window.blissCover.pushSupported()) return "unsupported";
        if (Notification.permission === "denied") return "blocked";
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = reg && (await reg.pushManager.getSubscription());
        return sub ? "on" : "off";
      },
      pushOn: async () => {
        if (!window.blissCover.pushSupported()) throw new Error("This browser can't show notifications. On iPhone, first tap Share → Add to Home Screen, then open BLISS from the Home Screen.");
        const perm = await Notification.requestPermission();
        if (perm !== "granted") throw new Error("Notifications are blocked. Allow them for this site in your phone's settings.");
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        const { publicKey } = await coverFn({ action: "vapid" });
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
        const { error } = await SB.rpc("push_save", { sub: sub.toJSON() });
        if (error) throw new Error(error.message);
        return "on";
      },
      pushOff: async () => {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = reg && (await reg.pushManager.getSubscription());
        if (sub) { await SB.rpc("push_remove", { ep: sub.endpoint }); await sub.unsubscribe(); }
        return "off";
      },
    };
    hideAuth();
    // Who's who (owners and managers can read everyone; staff only themselves). Used to show reviewer names.
    SB.from("members").select("user_id,email,role").eq("org_id", ORG).then(({ data }) => { window.blissAccount.members = data || []; });
    if (started) return;
    started = true; startRealtime(); readyResolve();
  }

  async function signOut() { await SB.auth.signOut(); lsSet("org", ""); location.reload(); }

  SB.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" && !started) afterSignIn(); if (ev === "SIGNED_OUT" && started) location.reload(); });
  afterSignIn();

  /* ───────────── db: document store on top of the "docs" table ───────────── */
  const OPS = { "==": "eq", "!=": "neq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte", in: "in" };
  const errMap = (e) => {
    const m = errOf(e); const c = e?.code || "";
    if (c === "42501" || /row-level security|permission/i.test(m) || c === "P0002") return { code: "invalid_argument", message: m };
    if (/fetch|network|Failed to fetch/i.test(m)) return { code: "unavailable", message: m };
    return { code: "unavailable", message: m };
  };
  const collOf = (p) => p.split("/").slice(0, -1).join("/");
  const idOf = (p) => p.split("/").pop();
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : Date.now().toString(36) + Math.random().toString(36).slice(2));
  // __by = account that last changed the document (lets the app name who did an older review).
  const snapDoc = (row, id) => ({ id: row ? row.doc_id : id, exists: !!row, data: () => (row ? (row.updated_by ? { ...row.data, __by: row.updated_by } : row.data) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });

  async function fetchQuery(q) {
    let r = SB.from("docs").select("doc_id,path,data,updated_by").eq("org_id", ORG);
    if (q.path) r = r.eq("path", q.path); else r = r.eq("coll", q.coll);
    for (const [f, op, v] of q.where || []) {
      const fn = OPS[op]; if (!fn) continue;
      const col = "data->>" + f;
      r = fn === "in" ? r.in(col, v.map(String)) : r[fn](col, typeof v === "string" ? v : String(v));
    }
    if (q.order) r = r.order("data->>" + q.order[0], { ascending: q.order[1] !== "desc" });
    r = r.limit(q.limit || 1000);
    const { data, error } = await r;
    if (error) throw errMap(error);
    return data || [];
  }

  const subs = new Set();
  async function runSub(s) {
    try {
      const rows = await fetchQuery(s.q);
      if (!subs.has(s)) return;
      const sig = JSON.stringify(rows);
      if (sig === s.last) return;   // nothing changed: don't redraw
      s.last = sig;
      if (s.q.path) s.next(snapDoc(rows[0], idOf(s.q.path)));
      else { const docs = rows.map((r) => snapDoc(r)); s.next({ docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } }); }
    } catch (e) { console.warn("bliss sub", e); }
  }
  const pending = new Map();
  function refresh(coll) {
    clearTimeout(pending.get(coll));
    pending.set(coll, setTimeout(() => { subs.forEach((s) => { const c = s.q.path ? collOf(s.q.path) : s.q.coll; if (!coll || c === coll) runSub(s); }); }, 120));
  }
  function subscribe(q, next, error) { const s = { q, next, error }; subs.add(s); runSub(s); return () => subs.delete(s); }

  // Re-read this person's role; reload the app if it changed or access was removed.
  let roleT = null;
  function roleCheckSoon() {
    if (ROLE === "owner") return;
    clearTimeout(roleT);
    roleT = setTimeout(() => window.blissAccount?.recheck?.().catch((e) => console.warn("role check", e)), 1500);
  }

  function startRealtime() {
    SB.channel("docs-" + ORG)
      .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: `org_id=eq.${ORG}` }, (p) => {
        const path = (p.new && p.new.path) || (p.old && p.old.path);
        refresh(path ? collOf(path) : null);
        // Team list changed: someone's role or access may have changed, maybe this person's.
        if (!path || /^(employees|links)\//.test(path)) roleCheckSoon();
      })
      .subscribe();
    setInterval(() => { if (!document.hidden) refresh(null); }, 30000);
    setInterval(() => { if (!document.hidden) roleCheckSoon(); }, 120000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(null); roleCheckSoon(); } });
  }

  function docRef(path) {
    return {
      id: idOf(path), path,
      async get() { const rows = await fetchQuery({ path }); return snapDoc(rows[0], idOf(path)); },
      async set(data) {
        if (data && typeof data === "object" && "__by" in data) { data = { ...data }; delete data.__by; }
        const { error } = await SB.from("docs").upsert({ org_id: ORG, path, coll: collOf(path), doc_id: idOf(path), data }, { onConflict: "org_id,path" });
        if (error) throw errMap(error); refresh(collOf(path));
      },
      async update(patch) {
        if (patch && typeof patch === "object" && "__by" in patch) { patch = { ...patch }; delete patch.__by; }
        const { error } = await SB.rpc("doc_merge", { o: ORG, p: path, patch });
        if (error) throw errMap(error); refresh(collOf(path));
      },
      async delete() {
        const { error } = await SB.from("docs").delete().eq("org_id", ORG).eq("path", path);
        if (error) throw errMap(error); refresh(collOf(path));
      },
      async acquire() { return { acquired: true }; },
      onSnapshot(next, error) { return subscribe({ path }, next, error); },
      collection(sub) { return collRef(path + "/" + sub); },
    };
  }
  function query(coll, where, order, lim) {
    return {
      where: (f, op, v) => query(coll, [...where, [f, op, v]], order, lim),
      orderBy: (f, dir) => query(coll, where, [f, dir || "asc"], lim),
      limit: (n) => query(coll, where, order, n),
      async get() { const rows = await fetchQuery({ coll, where, order, limit: lim }); const docs = rows.map((r) => snapDoc(r)); return { docs, size: docs.length, empty: !docs.length }; },
      onSnapshot(next, error) { return subscribe({ coll, where, order, limit: lim }, next, error); },
    };
  }
  function collRef(coll) {
    return Object.assign(query(coll, [], null, null), {
      path: coll,
      doc: (id) => docRef(coll + "/" + (id || newId())),
      async add(data) { const d = docRef(coll + "/" + newId()); await d.set(data); return d; },
    });
  }
  const db = { doc: docRef, collection: collRef };

  /* ───────────── user ───────────── */
  const user = {
    id: async () => UID,
    isOwner: async () => ROLE === "owner",
    canEdit: async () => ROLE === "owner" || ROLE === "manager",
    can: async () => true,
    me: async () => ({ id: UID, name: "", avatarUrl: "", color: "#4E6B45", email: EMAIL, isOwner: ROLE === "owner", canEdit: ROLE !== "staff" }),
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => [id, { id, name: "", avatarUrl: "", color: "#888", email: null, isMe: id === UID, guest: false }])),
    name: async () => "", email: async () => EMAIL, search: async () => [],
  };

  /* ───────────── photo uploads ───────────── */
  const assets = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || "image/jpeg";
      const ext = (opts && opts.ext) || { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" }[type] || "bin";
      const path = `${ORG}/${newId()}${newId().slice(0, 6)}.${ext}`;
      const { error } = await SB.storage.from(CFG.photoBucket).upload(path, blob, { contentType: type, upsert: false });
      if (error) throw { code: /size|large/i.test(error.message) ? "too_large" : "upstream_error", message: error.message };
      return { id: path, url: window.BLOB + path, sizeBytes: blob.size, contentType: type };
    },
    async list() { return { assets: [], usage: {} }; },
    async delete(id) { await SB.storage.from(CFG.photoBucket).remove([id]); return { deleted: true }; },
  };

  /* ───────────── Claude (via the "ai" Edge Function) ───────────── */
  const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function ask(input, opts) {
    opts = opts || {};
    const prompt = typeof input === "string" ? input : (input || []).map((m) => m.content).join("\n\n");
    const imgs = [];
    for (const b of [].concat(opts.images || [])) { if (b) imgs.push({ media_type: b.type || "image/jpeg", data: await toB64(b) }); }
    const { data, error } = await SB.functions.invoke("ai", { body: { prompt, images: imgs, tier: opts.modelTier || "default" } });
    if (error) {
      let code = "upstream_error";
      try { const j = await error.context?.json?.(); if (j?.error === "rate_limited") code = "rate_limited"; if (j?.error === "not_configured") code = "not_granted"; } catch (e) {}
      throw { code, message: errOf(error) };
    }
    return { text: data?.text || "", truncated: !!data?.truncated };
  }
  const sample = Object.assign((input, opts) => ask(input, opts), {
    async json(input, opts) {
      const { text } = await ask(input, opts);
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); const raw = m ? m[1] : text;
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      try { return JSON.parse(raw.slice(s, e + 1)); } catch (err) { throw { code: "upstream_error", message: "Could not read the answer" }; }
    },
    async limits() { return { images: { maxCount: 10, maxBytes: 5000000, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } }; },
  });

  /* ───────────── downloads ───────────── */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { status: "saved" };
    },
  };

  const caps = { db, user, assets, sample, downloads };
  window.claude = { use: async (name) => { await ready; return caps[name] || null; } };
})();
