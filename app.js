import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, setDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, GOOGLE_CLIENT_ID } from "./firebase-config.js";

/* ---------- Firebase ---------- */
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const ROOT = ["sitter", "main"];               // all data lives under /sitter/main/...
const COLLS = ["families", "shifts", "logs"];

const S = { families: [], shifts: [], logs: [], settings: {}, clock: null };
let me = null, unsubs = [], period = monthStart(new Date()), loaded = 0;

const $ = id => document.getElementById(id);
const ref = (coll, id) => doc(db, ...ROOT, coll, id);
const clean = o => JSON.parse(JSON.stringify(o));
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function put(coll, obj) {
  if (!obj.id) obj.id = uid();
  const { id, ...body } = obj;
  try { await setDoc(ref(coll, id), clean(body)); }
  catch (e) { toast(writeErr(e)); throw e; }
  return obj;
}
async function del(coll, id) { try { await deleteDoc(ref(coll, id)); } catch (e) { toast(writeErr(e)); } }
async function putMeta(key, val) {
  try { await setDoc(ref("meta", key), { v: val ?? null }); } catch (e) { toast(writeErr(e)); }
}
function writeErr(e) {
  return e?.code === "permission-denied" ? "This Google account doesn't have access." : "Couldn't save. Check your connection and try again.";
}

/* ---------- sign-in ---------- */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
$("signinBtn").onclick = async () => {
  $("signinMsg").textContent = "";
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === "auth/popup-blocked") return signInWithRedirect(auth, provider);
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request")
      $("signinMsg").textContent = "Sign-in failed (" + e.code + "). Check that this site is listed under Firebase → Authentication → Settings → Authorized domains.";
  }
};
onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = []; loaded = 0;
  me = user;
  $("signin").hidden = !!user; $("app").hidden = !user;
  if (!user) return;
  $("acctBtn").hidden = false;
  setSync(false, "Loading…");
  const fail = e => {
    if (e.code === "permission-denied") {
      signOut(auth);
      $("signinMsg").textContent = user.email + " isn't on the access list. Add it to firestore.rules, then try again.";
    } else setSync(false, "Offline");
  };
  COLLS.forEach(name => unsubs.push(onSnapshot(collection(db, ...ROOT, name), snap => {
    S[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (++loaded >= 3) setSync(!snap.metadata.fromCache, snap.metadata.fromCache ? "Offline · saves when back online" : "Synced");
    render();
  }, fail)));
  unsubs.push(onSnapshot(ref("meta", "clock"), s => { S.clock = s.exists() ? s.data().v : null; render(); }, fail));
  unsubs.push(onSnapshot(ref("meta", "settings"), s => { S.settings = (s.exists() && s.data().v) || {}; render(); }, fail));
  render();
});
$("acctBtn").onclick = () => openAccount();
function setSync(on, msg) { $("syncDot").classList.toggle("on", on); $("syncText").textContent = msg; }

/* ---------- helpers ---------- */
function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function monthEnd(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
const fmtT = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtD = d => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const money = n => "$" + (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = ms => ms / 3600000;
function dur(ms) { const t = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"); }
function toLocalInput(d) { const p = n => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const fam = id => S.families.find(f => f.id === id);
function logPay(l) {
  const f = fam(l.familyId); const rate = l.rate ?? f?.rate ?? 0; const end = l.out ? new Date(l.out) : new Date();
  const h = hrs(end - new Date(l.in)); return { h, pay: l.flat ? Number(l.flat) : h * rate, rate };
}
const guests = () => (S.settings.guests || "").split(",").map(x => x.trim().toLowerCase()).filter(x => x && x !== me?.email?.toLowerCase());

/* ---------- Google Calendar ---------- */
// Two levels: (1) automatic sync through the Calendar API when GOOGLE_CLIENT_ID is set and this
// person has connected their calendar; (2) otherwise an "Add to Google Calendar" link per shift.
let tokenClient = null, calToken = null, calExp = 0;
const CAL_KEY = "sitterbook-cal-connected";
const calWanted = () => { try { return localStorage.getItem(CAL_KEY) === me?.email; } catch (e) { return false; } };
const calAvailable = () => !!GOOGLE_CLIENT_ID && !!window.google?.accounts?.oauth2;
const calOn = () => calAvailable() && calWanted();

function getCalToken(prompt = "") {
  if (calToken && Date.now() < calExp - 60000) return Promise.resolve(calToken);
  return new Promise((res, rej) => {
    if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: "https://www.googleapis.com/auth/calendar.events", callback: () => {} });
    tokenClient.callback = r => {
      if (r.error) return rej(r);
      calToken = r.access_token; calExp = Date.now() + Number(r.expires_in || 3600) * 1000; res(calToken);
    };
    tokenClient.error_callback = e => rej(e);
    tokenClient.requestAccessToken({ prompt, login_hint: me?.email });
  });
}
function eventBody(sh) {
  const f = fam(sh.familyId) || {}; const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    summary: "Babysitting – " + (f.name || "Family"), location: f.address || "",
    description: [f.kids ? "Kids: " + f.kids : "", f.phone ? "Phone: " + f.phone : "", sh.notes || ""].filter(Boolean).join("\n"),
    start: { dateTime: sh.start, timeZone: tz }, end: { dateTime: sh.end, timeZone: tz },
    attendees: guests().map(email => ({ email })),
  };
}
async function calFetch(token, method, path, body) {
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events" + path + (path.includes("?") ? "&" : "?") + "sendUpdates=all",
    { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (method === "DELETE" && (r.status === 404 || r.status === 410)) return null;
  if (!r.ok) throw new Error("calendar " + r.status);
  return method === "DELETE" ? null : r.json();
}
// Returns the shift with calendar fields updated, or the shift unchanged if sync wasn't possible.
async function syncShift(sh, tokenP) {
  if (!tokenP) return sh;
  const mine = !sh.gcalId || sh.gcalOwner === me.email;
  if (!mine) { toast("Saved. The calendar event belongs to " + sh.gcalOwner + ", so they'll need to update it."); return sh; }
  try {
    const t = await tokenP;
    const ev = sh.gcalId ? await calFetch(t, "PATCH", "/" + encodeURIComponent(sh.gcalId), eventBody(sh))
                         : await calFetch(t, "POST", "", eventBody(sh));
    return { ...sh, gcalId: ev.id, gcalOwner: me.email, gcal: true };
  } catch (e) { toast("Saved, but Google Calendar didn't update. Use the Add button."); return { ...sh, gcal: false }; }
}
function gcalStamp(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
function gcalLink(sh) {
  const f = fam(sh.familyId) || {}; const b = eventBody(sh);
  const p = new URLSearchParams({ action: "TEMPLATE", text: b.summary, dates: gcalStamp(new Date(sh.start)) + "/" + gcalStamp(new Date(sh.end)), details: b.description, location: f.address || "" });
  if (guests().length) p.set("add", guests().join(","));
  return "https://calendar.google.com/calendar/render?" + p.toString();
}

/* ---------- derived ---------- */
const upcoming = () => S.shifts.filter(s => new Date(s.end) > new Date()).sort((a, b) => new Date(a.start) - new Date(b.start));
function logsIn(a, b) { return S.logs.filter(l => { const t = new Date(l.in); return t >= a && t < b; }).sort((x, y) => new Date(y.in) - new Date(x.in)); }
const periodLogs = () => logsIn(period, monthEnd(period));
function totals(logs) { let h = 0, p = 0, unpaid = 0; logs.forEach(l => { if (!l.out) return; const r = logPay(l); h += r.h; p += r.pay; if (!l.paid) unpaid += r.pay; }); return { h, p, unpaid }; }

/* ---------- render ---------- */
function render() { if (!me) return; renderHome(); renderSchedule(); renderFamilies(); renderHours(); }
function calButtons(sh) {
  if (sh.gcalId) return `<span class="chip paid">✓ On Google Calendar</span>`;
  return `<a class="btn sm" href="${gcalLink(sh)}" target="_blank" rel="noopener">Add to Google Calendar</a>
    <button class="sm ghost" onclick="markCal('${sh.id}')">${sh.gcal ? "✓ Added" : "Mark added"}</button>`;
}
function shiftItem(sh, withActions = true) {
  const d = new Date(sh.start), e = new Date(sh.end), f = fam(sh.familyId) || { name: "Deleted family" };
  const h = hrs(e - d), est = h * (f.rate || 0);
  return `<div class="item">
    <div class="date"><div class="m">${d.toLocaleDateString([], { month: "short" })}</div><div class="d">${d.getDate()}</div></div>
    <div class="main"><div class="title">${esc(f.name)} ${f.type === "oncall" ? '<span class="chip oncall">On-call</span>' : ""}</div>
      <div class="small muted num">${fmtD(d)} · ${fmtT(d)}–${fmtT(e)} · ${h.toFixed(1)} h${f.rate ? " · ~" + money(est) : ""}</div>
      ${f.address ? `<div class="small muted">${esc(f.address)}</div>` : ""}
      ${sh.notes ? `<div class="small">${esc(sh.notes)}</div>` : ""}
      ${withActions ? `<div class="actions">${calButtons(sh)}<button class="sm ghost" onclick="openShift('${sh.id}')">Edit</button></div>` : ""}
    </div></div>`;
}
function renderHome() {
  const el = $("p-home"), c = S.clock, now = new Date();
  const fams = [...S.families].sort((a, b) => (a.type === b.type ? 0 : a.type === "oncall" ? 1 : -1) || a.name.localeCompare(b.name));
  const nextShift = upcoming().find(s => new Date(s.start) - now < 3 * 3600000);
  const mt = totals(logsIn(monthStart(now), monthEnd(now)));
  const cf = c && fam(c.familyId);
  const clockCard = c ? `<div class="clock stack">
      <span class="label" style="color:inherit;opacity:.8">On the clock · ${esc(cf?.name || "")}</span>
      <div class="timer num" id="timer">${dur(now - new Date(c.in))}</div>
      <div class="small" style="opacity:.85">Started ${fmtT(new Date(c.in))} · <span id="soFar">${money(hrs(now - new Date(c.in)) * (cf?.rate || 0))}</span> so far</div>
      <div class="row"><button class="primary" onclick="clockOut()">Clock out</button><button class="ghost" style="color:inherit;border-color:currentColor" onclick="cancelClock()">Cancel</button></div>
    </div>`
    : `<div class="clock idle stack"><span class="label">Clock in</span>
      ${fams.length ? `<select id="clockFam" aria-label="Family">${fams.map(f => `<option value="${f.id}" ${nextShift?.familyId === f.id ? "selected" : ""}>${esc(f.name)}${f.type === "oncall" ? " (on-call)" : ""}</option>`).join("")}</select>
      <button class="primary" onclick="clockIn()">Clock in now</button>`
      : `<div class="small muted">Add a family first, then you can clock in here.</div><button class="primary" onclick="openFamily()">Add a family</button>`}
    </div>`;
  const up = upcoming().slice(0, 4);
  el.innerHTML = `${clockCard}
    <div class="stack"><span class="label">${now.toLocaleDateString([], { month: "long" })} so far</span>
      <div class="pay"><div class="stat money"><span class="small muted">Earned</span><b class="num">${money(mt.p)}</b></div>
      <div class="stat"><span class="small muted">Hours</span><b class="num">${mt.h.toFixed(1)}</b></div></div>
      ${mt.unpaid > 0 ? `<div class="small muted num">${money(mt.unpaid)} not marked paid yet</div>` : ""}</div>
    <div class="stack"><div class="row between"><span class="label">Coming up</span><button class="sm" onclick="openShift()">+ Add shift</button></div>
      <div class="list">${up.length ? up.map(s => shiftItem(s)).join("") : '<div class="empty">No shifts scheduled. Tap “Add shift” when a family books you.</div>'}</div></div>`;
}
function renderSchedule() {
  const el = $("p-schedule"), up = upcoming();
  const past = S.shifts.filter(s => new Date(s.end) <= new Date()).sort((a, b) => new Date(b.start) - new Date(a.start)).slice(0, 10);
  const calText = calOn() ? `Calendar sync is on. New and edited shifts go straight to your Google Calendar${guests().length ? ` and invite <b>${esc(guests().join(", "))}</b>` : ""}.`
    : `Each shift has an “Add to Google Calendar” button${guests().length ? ` that invites <b>${esc(guests().join(", "))}</b>` : ""}.${calAvailable() ? " Turn on automatic sync in Calendar settings." : ""}`;
  el.innerHTML = `<div class="row between"><h2>Schedule</h2><button class="primary sm" onclick="openShift()">+ Add shift</button></div>
    <div class="card stack small"><div>${calText}</div>
      <div class="actions" style="margin-top:0"><button class="sm" onclick="openSettings()">Calendar settings</button></div></div>
    <div class="stack"><span class="label">Upcoming · ${up.length}</span><div class="list">${up.length ? up.map(s => shiftItem(s)).join("") : '<div class="empty">Nothing on the books yet.</div>'}</div></div>
    ${past.length ? `<div class="stack"><span class="label">Recent</span><div class="list">${past.map(s => shiftItem(s, false)).join("")}</div></div>` : ""}`;
}
function famCard(f) {
  return `<div class="item"><div class="main">
    <div class="row between"><div class="title">${esc(f.name)}</div><span class="num small muted">${f.rate ? money(f.rate) + "/h" : ""}</span></div>
    ${f.kids ? `<div class="small">${esc(f.kids)}</div>` : ""}
    <div class="small muted">${[f.phone, f.address].filter(Boolean).map(esc).join(" · ")}</div>
    ${f.notes ? `<div class="small muted">${esc(f.notes)}</div>` : ""}
    <div class="actions">
      ${f.type === "oncall" ? `<button class="sm primary" onclick="quickClock('${f.id}')">Clock in now</button>` : ""}
      <button class="sm" onclick="openShift(null,'${f.id}')">Schedule</button>
      <button class="sm ghost" onclick="openFamily('${f.id}')">Edit</button>
      <button class="sm ghost" onclick="moveFam('${f.id}')">${f.type === "oncall" ? "Make active" : "Move to on-call"}</button>
    </div></div></div>`;
}
function renderFamilies() {
  const el = $("p-families");
  const act = S.families.filter(f => f.type !== "oncall").sort((a, b) => a.name.localeCompare(b.name));
  const oc = S.families.filter(f => f.type === "oncall").sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `<div class="row between"><h2>Families</h2><button class="primary sm" onclick="openFamily()">+ Add family</button></div>
    <div class="stack"><span class="label">Active · regular schedule</span><div class="list">${act.length ? act.map(famCard).join("") : '<div class="empty">Families you sit for on set days go here.</div>'}</div></div>
    <div class="stack"><span class="label">On-call · when they need you</span><div class="list">${oc.length ? oc.map(famCard).join("") : '<div class="empty">Families that call last-minute go here. Clock in straight from their card.</div>'}</div></div>`;
}
function renderHours() {
  const el = $("p-hours"), logs = periodLogs(), t = totals(logs);
  const byFam = {};
  logs.forEach(l => { if (!l.out) return; const r = logPay(l), k = l.familyId; byFam[k] = byFam[k] || { h: 0, p: 0, unpaid: 0 }; byFam[k].h += r.h; byFam[k].p += r.pay; if (!l.paid) byFam[k].unpaid += r.pay; });
  el.innerHTML = `<div class="row between"><h2>Hours &amp; Pay</h2><button class="sm" onclick="openLog()">+ Add hours</button></div>
    <div class="row between card" style="padding:8px">
      <button class="ghost sm" onclick="shiftPeriod(-1)" aria-label="Previous month">‹</button>
      <b>${period.toLocaleDateString([], { month: "long", year: "numeric" })}</b>
      <button class="ghost sm" onclick="shiftPeriod(1)" aria-label="Next month">›</button></div>
    <div class="pay"><div class="stat money"><span class="small muted">Total pay</span><b class="num">${money(t.p)}</b></div>
      <div class="stat"><span class="small muted">Hours</span><b class="num">${t.h.toFixed(2)}</b></div></div>
    ${Object.keys(byFam).length ? `<div class="stack"><span class="label">By family</span><div class="list">${Object.entries(byFam).map(([id, v]) => `<div class="item"><div class="main">
      <div class="row between"><div class="title">${esc(fam(id)?.name || "Deleted family")}</div><b class="num">${money(v.p)}</b></div>
      <div class="row between small muted num"><span>${v.h.toFixed(2)} h</span><span>${v.unpaid > 0 ? money(v.unpaid) + " owed" : "All paid"}</span></div>
      ${v.unpaid > 0 ? `<div class="actions"><button class="sm" onclick="markAllPaid('${id}')">Mark all paid</button></div>` : ""}</div></div>`).join("")}</div></div>` : ""}
    <div class="stack"><span class="label">Time log</span><div class="list">${logs.length ? logs.map(l => {
      const r = logPay(l), a = new Date(l.in);
      return `<div class="item"><div class="main"><div class="row between"><div class="title">${esc(fam(l.familyId)?.name || "Deleted family")}</div><b class="num">${l.out ? money(r.pay) : "…"}</b></div>
      <div class="small muted num">${fmtD(a)} · ${fmtT(a)}–${l.out ? fmtT(new Date(l.out)) : "now"} · ${r.h.toFixed(2)} h${l.flat ? " · flat" : " @ " + money(r.rate)}</div>
      ${l.notes ? `<div class="small">${esc(l.notes)}</div>` : ""}
      <div class="actions">${l.out ? `<button class="sm ${l.paid ? "" : "primary"}" onclick="togglePaid('${l.id}')">${l.paid ? "✓ Paid" : "Mark paid"}</button>` : '<span class="chip">On the clock</span>'}
      <button class="sm ghost" onclick="openLog('${l.id}')">Edit</button></div></div></div>`;
    }).join("") : '<div class="empty">No hours logged this month. Clock in from the Today tab, or add hours by hand.</div>'}</div></div>`;
}

/* ---------- actions ---------- */
async function clockIn(fid) {
  fid = fid || $("clockFam")?.value; if (!fid) return;
  if (S.clock) { toast("Already clocked in."); return; }
  await putMeta("clock", { familyId: fid, in: new Date().toISOString(), by: me.email }); toast("Clocked in");
}
function quickClock(fid) { go("home"); clockIn(fid); }
async function clockOut() {
  const c = S.clock; if (!c) return; const f = fam(c.familyId);
  await put("logs", { familyId: c.familyId, in: c.in, out: new Date().toISOString(), rate: f?.rate || 0, paid: false });
  await putMeta("clock", null); toast("Clocked out · hours saved");
}
function cancelClock() { confirmSheet("Discard this clock-in? No hours will be saved.", "Discard", () => putMeta("clock", null)); }
async function markCal(id) { const s = S.shifts.find(x => x.id === id); if (s) await put("shifts", { ...s, gcal: !s.gcal }); }
async function moveFam(id) { const f = fam(id); await put("families", { ...f, type: f.type === "oncall" ? "active" : "oncall" }); }
async function togglePaid(id) { const l = S.logs.find(x => x.id === id); await put("logs", { ...l, paid: !l.paid }); }
async function markAllPaid(fid) { for (const l of periodLogs().filter(l => l.familyId === fid && l.out && !l.paid)) await put("logs", { ...l, paid: true }); toast("Marked paid"); }
function shiftPeriod(n) { period = new Date(period.getFullYear(), period.getMonth() + n, 1); renderHours(); }

/* ---------- sheets ---------- */
const sheet = $("sheet"), sb = $("sheetBody");
function openSheet(html) { sb.innerHTML = html; sheet.hidden = false; }
function closeSheet() { sheet.hidden = true; sb.innerHTML = ""; }
sheet.addEventListener("click", e => { if (e.target === sheet) closeSheet(); });
const val = id => $(id).value;
function confirmSheet(msg, label, fn) {
  openSheet(`<h2>${esc(msg)}</h2><div class="row"><button class="primary" style="background:var(--danger);border-color:var(--danger)" id="cOk">${label}</button><button onclick="closeSheet()">Keep</button></div>`);
  $("cOk").onclick = async () => { closeSheet(); await fn(); };
}
function openFamily(id) {
  const f = id ? fam(id) : { type: "active" };
  openSheet(`<h2>${id ? "Edit family" : "New family"}</h2>
    <div class="seg" role="group" aria-label="Type"><button type="button" id="tA" aria-pressed="${f.type !== "oncall"}">Active</button><button type="button" id="tO" aria-pressed="${f.type === "oncall"}">On-call</button></div>
    <label class="f">Family name<input id="fName" value="${esc(f.name)}" placeholder="The Millers"></label>
    <label class="f">Kids<input id="fKids" value="${esc(f.kids)}" placeholder="Emma (6), Jack (3)"></label>
    <div class="grid2"><label class="f">Hourly rate ($)<input id="fRate" type="number" inputmode="decimal" step="0.5" value="${f.rate ?? ""}" placeholder="18"></label>
    <label class="f">Phone<input id="fPhone" type="tel" value="${esc(f.phone)}"></label></div>
    <label class="f">Address<input id="fAddr" value="${esc(f.address)}"></label>
    <label class="f">Notes<textarea id="fNotes" placeholder="Allergies, bedtime, wifi, pets…">${esc(f.notes)}</textarea></label>
    <div class="row"><button class="primary" id="fSave">Save</button><button onclick="closeSheet()">Cancel</button>
    ${id ? `<button class="ghost danger" style="margin-left:auto" id="fDel">Delete</button>` : ""}</div>`);
  let type = f.type || "active";
  const seg = () => { $("tA").setAttribute("aria-pressed", type !== "oncall"); $("tO").setAttribute("aria-pressed", type === "oncall"); };
  $("tA").onclick = () => { type = "active"; seg(); }; $("tO").onclick = () => { type = "oncall"; seg(); };
  $("fSave").onclick = async () => {
    const name = val("fName").trim(); if (!name) { toast("Add a family name."); return; }
    await put("families", { ...(id ? f : {}), id, type, name, kids: val("fKids"), rate: parseFloat(val("fRate")) || 0, phone: val("fPhone"), address: val("fAddr"), notes: val("fNotes") });
    closeSheet(); toast("Family saved");
  };
  if (id) $("fDel").onclick = () => confirmSheet("Delete " + f.name + "? Their past hours stay in the log.", "Delete", () => del("families", id));
}
function openShift(id, presetFam) {
  if (!S.families.length) { toast("Add a family first."); openFamily(); return; }
  const s = id ? S.shifts.find(x => x.id === id) : null;
  const st = s ? new Date(s.start) : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return d; })();
  const en = s ? new Date(s.end) : new Date(st.getTime() + 4 * 3600000);
  const fid = s?.familyId || presetFam;
  openSheet(`<h2>${id ? "Edit shift" : "New shift"}</h2>
    <label class="f">Family<select id="sFam">${S.families.map(f => `<option value="${f.id}" ${f.id === fid ? "selected" : ""}>${esc(f.name)}${f.type === "oncall" ? " (on-call)" : ""}</option>`).join("")}</select></label>
    <label class="f">Starts<input id="sStart" type="datetime-local" value="${toLocalInput(st)}"></label>
    <label class="f">Ends<input id="sEnd" type="datetime-local" value="${toLocalInput(en)}"></label>
    <label class="f">Notes<textarea id="sNotes" placeholder="Pick up from school, dinner in fridge…">${esc(s?.notes)}</textarea></label>
    <div class="row"><button class="primary" id="sSave">Save</button><button onclick="closeSheet()">Cancel</button>
    ${id ? `<button class="ghost danger" style="margin-left:auto" id="sDel">Delete</button>` : ""}</div>`);
  $("sSave").onclick = async () => {
    const a = new Date(val("sStart")), b = new Date(val("sEnd"));
    if (isNaN(a) || isNaN(b) || b <= a) { toast("End time needs to be after the start."); return; }
    // Ask for the calendar token first, while the tap still counts as a user gesture.
    const tokenP = calOn() ? getCalToken() : null; tokenP?.catch(() => {});
    let sh = { ...(s || {}), id: s?.id || uid(), familyId: val("sFam"), start: a.toISOString(), end: b.toISOString(), notes: val("sNotes") };
    if (s && !s.gcalId && (s.start !== sh.start || s.end !== sh.end)) sh.gcal = false;
    closeSheet();
    await put("shifts", sh);
    if (tokenP) { sh = await syncShift(sh, tokenP); if (sh.gcalId) { await put("shifts", sh); toast("Saved · on Google Calendar"); } }
    else {
      openSheet(`<h2>Shift saved</h2><p class="muted small" style="margin:0">Put it on Google Calendar${guests().length ? " (invites " + esc(guests().join(", ")) + ")" : ""}:</p>
        <a class="btn primary" style="justify-content:center;background:var(--accent);color:var(--bg);border-color:var(--accent)" href="${gcalLink(sh)}" target="_blank" rel="noopener" id="addCal">Add to Google Calendar</a>
        <button onclick="closeSheet()">Not now</button>`);
      $("addCal").onclick = () => { setTimeout(() => { markCal(sh.id); closeSheet(); }, 50); };
    }
  };
  if (id) $("sDel").onclick = () => {
    const canCal = s.gcalId && s.gcalOwner === me.email && calOn();
    const tokenP = canCal ? getCalToken() : null; tokenP?.catch(() => {});
    confirmSheet(canCal ? "Delete this shift and its calendar event?" : "Delete this shift?" + (s.gcal || s.gcalId ? " Remove it from Google Calendar too." : ""), "Delete", async () => {
      await del("shifts", id);
      if (tokenP) { try { await calFetch(await tokenP, "DELETE", "/" + encodeURIComponent(s.gcalId)); } catch (e) { toast("Shift deleted, but the calendar event is still there."); } }
    });
  };
}
function openLog(id) {
  if (!S.families.length) { toast("Add a family first."); return; }
  const l = id ? S.logs.find(x => x.id === id) : null;
  const a = l ? new Date(l.in) : new Date(Date.now() - 3 * 3600000), b = l?.out ? new Date(l.out) : new Date();
  openSheet(`<h2>${id ? "Edit hours" : "Add hours"}</h2>
    <label class="f">Family<select id="lFam">${S.families.map(f => `<option value="${f.id}" ${f.id === l?.familyId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>
    <div class="grid2"><label class="f">Start<input id="lIn" type="datetime-local" value="${toLocalInput(a)}"></label>
    <label class="f">End<input id="lOut" type="datetime-local" value="${toLocalInput(b)}"></label></div>
    <div class="grid2"><label class="f">Rate ($/h)<input id="lRate" type="number" inputmode="decimal" step="0.5" value="${l?.rate ?? ""}" placeholder="Family's rate"></label>
    <label class="f">Flat total ($)<input id="lFlat" type="number" inputmode="decimal" step="1" value="${l?.flat ?? ""}" placeholder="Optional"></label></div>
    <label class="f">Notes<input id="lNotes" value="${esc(l?.notes)}" placeholder="Tip, extra kid, mileage…"></label>
    <div class="row"><button class="primary" id="lSave">Save</button><button onclick="closeSheet()">Cancel</button>
    ${id ? `<button class="ghost danger" style="margin-left:auto" id="lDel">Delete</button>` : ""}</div>`);
  $("lSave").onclick = async () => {
    const i = new Date(val("lIn")), o = new Date(val("lOut")); if (isNaN(i) || isNaN(o) || o <= i) { toast("End time needs to be after the start."); return; }
    const fid = val("lFam"), r = val("lRate"), fl = val("lFlat");
    await put("logs", { ...(l || {}), id, familyId: fid, in: i.toISOString(), out: o.toISOString(), rate: r === "" ? (fam(fid)?.rate || 0) : parseFloat(r), flat: fl === "" ? null : parseFloat(fl), notes: val("lNotes"), paid: !!l?.paid });
    closeSheet(); toast("Hours saved");
  };
  if (id) $("lDel").onclick = () => confirmSheet("Delete these hours?", "Delete", () => del("logs", id));
}
function openSettings() {
  const avail = calAvailable(), on = calOn();
  openSheet(`<h2>Calendar settings</h2>
    <label class="f">Invite to every shift<input id="gGuests" type="email" inputmode="email" value="${esc(S.settings.guests)}" placeholder="partner@gmail.com"></label>
    <p class="small muted" style="margin:0">Separate several addresses with commas. These people get each shift on their Google Calendar as an invite.</p>
    ${avail ? `<div class="card stack small"><b>Automatic sync on this phone</b>
      <span class="muted">${on ? "On. Shifts you save here are added, moved and deleted on your Google Calendar automatically." : "Off. Turn it on to skip the Add to Google Calendar step."}</span>
      <div><button class="sm ${on ? "" : "primary"}" id="calToggle">${on ? "Turn off" : "Connect Google Calendar"}</button></div></div>` : ""}
    <div class="row"><button class="primary" id="gSave">Save</button><button onclick="closeSheet()">Cancel</button></div>`);
  $("gSave").onclick = async () => { await putMeta("settings", { ...S.settings, guests: val("gGuests") }); closeSheet(); toast("Saved"); };
  if (avail) $("calToggle").onclick = async () => {
    try {
      if (on) { localStorage.removeItem(CAL_KEY); if (calToken) google.accounts.oauth2.revoke(calToken, () => {}); calToken = null; toast("Calendar sync off"); }
      else { await getCalToken("consent"); localStorage.setItem(CAL_KEY, me.email); toast("Google Calendar connected"); }
    } catch (e) { toast("Calendar wasn't connected."); }
    closeSheet(); render();
  };
}
function openAccount() {
  openSheet(`<h2>Account</h2><div class="small muted">Signed in as ${esc(me?.email)}</div>
    <div class="row"><button id="soBtn">Sign out</button><button onclick="closeSheet()">Close</button></div>`);
  $("soBtn").onclick = () => { closeSheet(); signOut(auth); };
}

/* ---------- nav, toast, ticking clock ---------- */
function go(t) {
  document.querySelectorAll("nav button").forEach(b => b.dataset.tab === t ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  ["home", "schedule", "families", "hours"].forEach(k => $("p-" + k).hidden = k !== t); window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => go(b.dataset.tab));
let tt; function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2800); }
setInterval(() => {
  if (!S.clock) return; const ms = new Date() - new Date(S.clock.in);
  const el = $("timer"); if (el) el.textContent = dur(ms);
  const sf = $("soFar"); if (sf) sf.textContent = money(hrs(ms) * (fam(S.clock.familyId)?.rate || 0));
}, 1000);

Object.assign(window, { clockIn, clockOut, cancelClock, quickClock, markCal, moveFam, togglePaid, markAllPaid, shiftPeriod, openFamily, openShift, openLog, openSettings, closeSheet });
