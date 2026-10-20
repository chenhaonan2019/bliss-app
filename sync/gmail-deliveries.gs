// BLISS · BJ's / Walmart delivery emails → the app (live tracking + phone alerts)
//
// Runs inside the owner's Gmail as a Google Apps Script, once a minute. No passwords:
// each request is signed with your own Google sign-in, and the app only accepts it
// from an owner's email address.
//
// Setup (once): script.google.com → New project → paste this file into Code.gs →
// Project Settings → "Show appsscript.json" → paste the manifest at the bottom into appsscript.json →
// pick the function "setup" → Run → allow access. That's it.

const BLISS_FN = 'https://vylynuuzeniqmyorrefl.supabase.co/functions/v1/cover';
const BLISS_QUERY = 'from:(oe.bjs.com OR help@walmart.com) newer_than:1d';

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
  poll();
}

function poll() {
  const props = PropertiesService.getScriptProperties();
  const seen = JSON.parse(props.getProperty('seen') || '[]');
  const known = {}; seen.forEach(function (id) { known[id] = 1; });
  const msgs = [];
  GmailApp.search(BLISS_QUERY, 0, 30).forEach(function (th) {
    th.getMessages().forEach(function (m) {
      const id = m.getId();
      if (known[id] || Date.now() - m.getDate().getTime() > 864e5) return;
      msgs.push({ id: id, from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toISOString(), text: blissText(m.getBody()).slice(0, 9000) });
    });
  });
  // every 5 minutes, check in even with no new mail, so "delivered but not received yet" reminders go out
  if (!msgs.length && new Date().getMinutes() % 5 !== 0) return;
  const batch = msgs.slice(0, 12);
  const r = UrlFetchApp.fetch(BLISS_FN, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ action: 'mail', msgs: batch, token: ScriptApp.getIdentityToken() }),
  });
  if (r.getResponseCode() === 200) {
    batch.forEach(function (m) { seen.push(m.id); });
    props.setProperty('seen', JSON.stringify(seen.slice(-300)));
  } else {
    console.warn('BLISS ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 300));
  }
}

function blissText(h) {
  return String(h || '')
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|th|h\d|li|table)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/[ \t ​-‍͏­]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/* appsscript.json
{
  "timeZone": "America/New_York",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
*/
