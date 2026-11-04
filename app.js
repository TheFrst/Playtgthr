import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { initializeAuth, browserLocalPersistence, browserSessionPersistence, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { PROMPTS } from "./prompts.js";
import { WORDS } from "./words.js";
import { MOST_PACKS, WYR, HOT, PAIRS } from "./packs.js";

// Firebase project: Playtgthr (playtgthr-a7daa)
const firebaseConfig = {
  apiKey: "AIzaSyCorGRJiuUTjyIJe8yl9IAnCMs889jy1NQ",
  authDomain: "playtgthr-a7daa.firebaseapp.com",
  databaseURL: "https://playtgthr-a7daa-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "playtgthr-a7daa",
  storageBucket: "playtgthr-a7daa.firebasestorage.app",
  messagingSenderId: "1084444606157",
  appId: "1:1084444606157:web:fb6287b553ca1362c97384"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
// Normal play: one player per browser, so re-opening the link keeps you the same player.
// Testing alone: open  .../#tes  in several NEW tabs; each tab becomes its own player.
const TEST = location.hash === "#tes";
const auth = initializeAuth(app, { persistence: TEST ? browserSessionPersistence : browserLocalPersistence });
const me = (await signInAnonymously(auth)).user.uid;

const GAMES = { most: "👑 Who's the Most?", imposter: "🕵️ Imposter", wyr: "🤔 Would You Rather", hot: "🔥 Hot Takes", under: "🎭 Undercover" };
const OPT = g => g === "wyr" || g === "hot";        // vote for an option, not a player
const IMP = g => g === "imposter" || g === "under";  // the clue-and-vote word games
const MOST_ROUNDS = 10;   // Who's the Most: rounds per game
const CLUE_LAPS = 2;      // Imposter: how many clues each player gives per word
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O/1/I/L mix-ups
const $ = s => document.querySelector(s);

let room = null, code = null, secret = null, hostData = null;
let unsub = null, unsubSecret = null, unsubHost = null;
let choicesKey = "", wake = null;
const done = new Set();   // host actions already fired this round (stops double-scoring)

// ---------- small helpers ----------
const load = (k, d) => { try { return JSON.parse(localStorage[k] ?? d); } catch { return JSON.parse(d); } };
const save = (k, v) => { try { localStorage[k] = JSON.stringify(v); } catch {} };
const roomRef = (p = "") => ref(db, `rooms/${code}${p ? "/" + p : ""}`);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const newId = () => Math.random().toString(36).slice(2, 10);
const list = v => (v ? Object.values(v).filter(Boolean) : []);   // RTDB may return arrays or objects
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// ---------- sound + effects (no files, made live) ----------
let AC = null;
function ac() { try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === "suspended") AC.resume(); } catch { AC = null; } return AC; }
function tone(f, t0, dur, type = "sine", vol = .15, f2) {
  const a = ac(); if (!a || load("pgMute", "false")) return;
  const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + t0;
  o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(vol, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + .05);
}
const SFX = {
  tap: () => tone(660, 0, .08, "triangle", .08),
  drum: () => { for (let i = 0; i < 16; i++) tone(90 + Math.random() * 20, i * .12, .1, "triangle", .12 + i * .01); },
  tada: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, i * .09, .35, "triangle", .14)),
  boo: () => tone(220, 0, .6, "sawtooth", .1, 110),
  pop: () => tone(880, 0, .12, "sine", .12, 1320),
};
function confetti() {
  const box = document.createElement("div"); box.className = "confetti";
  for (let i = 0; i < 60; i++) { const p = document.createElement("i"); p.style.left = Math.random() * 100 + "%"; p.style.background = pick(["#4ade80", "#f472b6", "#facc15", "#60a5fa", "#fff"]); p.style.animationDelay = Math.random() * .6 + "s"; p.style.setProperty("--x", (Math.random() * 200 - 100) + "px"); box.append(p); }
  document.body.append(box); setTimeout(() => box.remove(), 3200);
}
// Suspense before a reveal: 3, 2, 1 with a drumroll, then the answer.
let lastSuspense = "", suspRunning = false;
function suspense(key, section, then) {
  if (lastSuspense === key) { if (!suspRunning) then(false); return; }
  lastSuspense = key; suspRunning = true;
  section.classList.add("hold"); SFX.drum();
  const ov = document.createElement("div"); ov.className = "count"; section.prepend(ov);
  let n = 3; ov.textContent = n;
  const t = setInterval(() => { n--; if (n > 0) { ov.textContent = n; return; } clearInterval(t); ov.remove(); section.classList.remove("hold"); suspRunning = false; then(true); }, 650);
}
// Your group's hall of fame, kept on this phone.
function remember(key, names) {
  const h = load("pgHall", "{}"); if (h["_" + key]) return; h["_" + key] = 1;
  for (const n of names) h[n] = (h[n] || 0) + 1; save("pgHall", h); drawHall();
}
function drawHall() {
  const h = load("pgHall", "{}"), top = Object.entries(h).filter(([k]) => !k.startsWith("_")).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const box = $("#hall"); if (!box) return; box.hidden = !top.length;
  $("#halllist").replaceChildren(...top.map(([n, c], i) => el("li", `${["🥇", "🥈", "🥉", "🏅", "🏅"][i]} ${n}: ${c} crown${c > 1 ? "s" : ""}`)));
}
function shareText(text) {
  if (navigator.share) navigator.share({ text: text + "\n\nPlay on Playtgthr: " + location.origin + location.pathname }).catch(() => {});
  else { navigator.clipboard?.writeText(text).catch(() => {}); alert("Copied! Paste it in your group chat."); }
}
function once(key, fn) { const k = `${room.rid}:${key}`; if (done.has(k)) return; done.add(k); fn(); }
const fail = e => alert("Something went wrong: " + e.message);

// User text only ever goes through textContent, never innerHTML.
function el(tag, text, id) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (id) e.dataset.id = id;
  return e;
}
// Unique display names, the same on every phone: "Kenny", "Kenny 2".
function labels(players) {
  const out = {}, seen = new Set();
  for (const id of Object.keys(players).sort()) {
    const base = players[id].name;
    let n = base, k = 2;
    while (seen.has(n.toLowerCase())) n = `${base} ${k++}`;
    seen.add(n.toLowerCase());
    out[id] = n;
  }
  return out;
}
function playerRow(id, label, extra = "") {
  const li = el("li", label + extra);
  if (me === room.host && id !== room.host) {
    const k = el("button", "✕");
    k.className = "kick"; k.dataset.kick = id;
    li.append(k);
  }
  return li;
}
function myName() {
  const n = $("#name").value.trim().slice(0, 16);
  if (n) save("pgName", n);
  return n;
}

// Prefill: a shared link (?r=ABCD) fills the code, otherwise your last room does.
const linkCode = new URLSearchParams(location.search).get("r");
$("#joincode").value = String(linkCode || load("pgCode", '""')).toUpperCase().slice(0, 4);
$("#name").value = load("pgName", '""');

// The host's phone runs the game, so keep its screen on where the browser allows it.
async function keepAwake() {
  if (!room || me !== room.host || wake || document.visibilityState !== "visible" || !navigator.wakeLock) return;
  wake = "pending";
  try {
    wake = await navigator.wakeLock.request("screen");
    wake.addEventListener("release", () => { wake = null; });
  } catch { wake = null; }
}
document.addEventListener("visibilitychange", keepAwake);

// ---------- rooms ----------
async function createRoom(game) {
  const name = myName();
  if (!name) return alert("Type your name first");
  for (let attempt = 0; attempt < 5; attempt++) {
    const c = Array.from({ length: 4 }, () => pick(CODE_CHARS)).join("");
    try {
      await set(ref(db, `rooms/${c}`), {
        host: me, game, state: "lobby", round: 0, rid: newId(), used: load("pgUsed", "{}"),
        players: { [me]: { name, picked: 0, wins: 0, pts: 0 } }
      });
      return listen(c);
    } catch { /* code taken by someone else's room: try another */ }
  }
  alert("Couldn't create a room, try again");
}

async function joinRoom() {
  const c = $("#joincode").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(c)) return alert("The code is 4 letters/numbers");
  try {
    const snap = await get(ref(db, `rooms/${c}`));
    if (!snap.exists()) return alert("Room not found");
    if (!snap.val().players?.[me]) {   // re-opened link? keep your old entry and score
      const name = myName();
      if (!name) return alert("Type your name first");
      await set(ref(db, `rooms/${c}/players/${me}`), { name, picked: 0, wins: 0, pts: 0 });
    }
    listen(c);
  } catch (e) { alert("Couldn't join: " + e.message); }
}

function listen(c) {
  stopListening();
  code = c; save("pgCode", c);
  unsub = onValue(ref(db, `rooms/${code}`), snap => {
    room = snap.val();
    if (!room) return leave("The room was closed");
    if (!room.players?.[me]) return leave("You were removed from the room");
    if (me === room.host && !unsubHost)
      unsubHost = onValue(ref(db, `hostdata/${code}`), s => { hostData = s.val(); if (room) render(); });
    render();
  }, e => alert("Connection error: " + e.message));
  // Your own secret word (Imposter). Only you can read this path.
  unsubSecret = onValue(ref(db, `secrets/${code}/${me}`), s => { secret = s.val(); if (room) render(); }, () => {});
}

function stopListening() {
  unsub?.(); unsubSecret?.(); unsubHost?.();
  unsub = unsubSecret = unsubHost = null;
  room = null; secret = null; hostData = null; choicesKey = "";
}

function leave(msg) {
  stopListening();
  wake?.release?.(); wake = null;
  document.querySelectorAll("section").forEach(s => s.hidden = s.id !== "home");
  alert(msg);
}

function toLobby() {   // host: back to the lobby with the same players and code
  update(roomRef(), {
    state: "lobby", round: 0, rid: newId(), prompt: null, votes: null, shown: null,
    order: null, clues: null, category: null, caught: null, guess: null, result: null
  }).catch(fail);
}

// ---------- render: every phone draws the screen that matches room.state ----------
function render() {
  const players = room.players || {}, votes = room.votes || {};
  const isHost = me === room.host;
  const names = labels(players);
  const ids = Object.keys(players).sort((a, b) => names[a].localeCompare(names[b]));
  document.querySelectorAll("section").forEach(s => s.hidden = s.id !== room.state);
  document.querySelectorAll(".host-only").forEach(b => b.hidden = !isHost);
  document.querySelectorAll(".guest-only").forEach(b => b.hidden = isHost);
  keepAwake();

  // Imposter: if the imposter left mid-word, end the word.
  if (isHost && IMP(room.game) && hostData && ["clue", "vote", "guess"].includes(room.state)
      && !players[hostData.imposter]) return finishImposter("left", room.shown || {});

  if (room.state === "lobby") renderLobby(ids, names, isHost);
  if (room.state === "clue") renderClue(players, names, isHost);
  if (room.state === "vote") renderVote(ids, players, votes, names, isHost);
  if (room.state === "reveal") renderMostReveal(players, room.shown || {}, names);
  if (room.state === "end") renderMostEnd(players, names);
  if (room.state === "guess") renderGuess(names, isHost);
  if (room.state === "result") renderResult(players, names);
}

function renderLobby(ids, names, isHost) {
  $("#gamename").textContent = GAMES[room.game];
  $("#code").textContent = code;
  $("#players").replaceChildren(...ids.map(id => playerRow(id, names[id], id === room.host ? " 👑" : "")));
  for (const b of document.querySelectorAll("[data-game]")) b.classList.toggle("mine", b.dataset.game === room.game);
  const packs = $("#packs"); packs.hidden = room.game !== "most";
  if (room.game === "most") {
    const cur = room.category || "All";
    packs.replaceChildren(...["All", ...Object.keys(MOST_PACKS)].map(p => { const b = el("button", p); b.className = "alt pack" + (p === cur ? " mine" : ""); b.dataset.pack = p; b.disabled = !isHost; return b; }));
  }
  $("#start").disabled = ids.length < 3;
  $("#start").textContent = ids.length < 3 ? `Need 3+ players (${ids.length} now)` : `Start ${GAMES[room.game]}`;
}

function secretText() {
  if (!secret) return { text: "You joined mid-word, so just watch this one and vote 👀", imp: false };
  if (room.game === "under") return { text: "🎭 Your word\n(one of you secretly has a different one, maybe you)", word: secret.word, imp: false };
  if (secret.imposter) return { text: `🤫 You're the IMPOSTER\nCategory: ${room.category}\nBlend in!`, imp: true };
  return { text: `Category: ${room.category}\nYour word:`, word: secret.word, imp: false };
}
function drawSecret(box) {
  const s = secretText();
  box.className = "card" + (s.imp ? " imposter" : "");
  box.replaceChildren(...s.text.split("\n").flatMap((line, i) => (i ? [document.createElement("br"), line] : [line])));
  if (s.word) box.append(el("b", s.word));
}
function clueItems(names) {
  return list(room.clues).map(c => {
    const li = el("li", (names[c.by] || "(left)") + ": ");
    li.append(el("span", c.text));
    return li;
  });
}

function renderClue(players, names, isHost) {
  const order = room.order || [];
  const t = list(room.clues).length;   // whose turn = how many clues so far
  drawSecret($("#secret"));
  $("#clues").replaceChildren(...clueItems(names));
  $("#cluecount").textContent = `Clue ${Math.min(t + 1, order.length)} of ${order.length}`;
  const current = order[t];

  if (t >= order.length) {   // everyone gave their clues: go vote
    $("#clueform").hidden = true; $("#turn").textContent = "All clues in! Time to vote…"; $("#skipturn").hidden = true;
    if (isHost) once("tovote", () => update(roomRef(), { state: "vote", votes: null }).catch(fail));
    return;
  }
  if (isHost && !players[current])   // that player was kicked: skip them
    return once(`skip${t}`, () => set(roomRef(`clues/${t}`), { by: current, text: "(skipped)" }).catch(fail));

  const mine = current === me;
  $("#clueform").hidden = !mine;
  $("#clueform").dataset.turn = t;
  $("#turn").textContent = mine ? "" : `Waiting for ${names[current]}…`;
  $("#skipturn").hidden = !isHost || mine;
  $("#skipturn").textContent = `Skip ${names[current]}`;
}

function renderVote(ids, players, votes, names, isHost) {
  const opt = OPT(room.game);
  const hasVoted = id => opt ? ["a", "b"].includes(votes[id]) : !!players[votes[id]];   // a vote for a kicked player doesn't count
  const voted = ids.filter(hasVoted).length;
  const imp = IMP(room.game);
  $("#roundinfo").textContent = imp ? GAMES[room.game] : `${GAMES[room.game]} · Round ${room.round} of ${MOST_ROUNDS}`;
  const [pa, pb] = String(room.prompt || "").split("|");
  $("#prompt").textContent = imp ? (room.game === "under" ? "Who has the different word? 🎭" : "Who's the imposter? 🕵️") : room.game === "wyr" ? "Would you rather…" : room.game === "hot" ? `🔥 "${room.prompt}"` : room.prompt;
  $("#vsecret").hidden = !imp;
  $("#recap").hidden = !imp;
  if (imp) { drawSecret($("#vsecret")); $("#recap").replaceChildren(...clueItems(names)); }
  $("#count").textContent = `${voted}/${ids.length} voted`;

  const key = room.rid + "|" + ids.join(",");   // rebuild buttons only when the round or players change
  if (key !== choicesKey) {
    choicesKey = key;
    $("#choices").replaceChildren(...(opt ? ["a", "b"] : ids.filter(id => id !== me)).map(id => el("button", "", id)));
    $("#choices").className = opt ? "opts " + room.game : "";
  }
  const optLabel = k => room.game === "wyr" ? (k === "a" ? "🅰️ " + pa : "🅱️ " + pb) : (k === "a" ? "🔥 Agree" : "🧊 Disagree");
  for (const b of $("#choices").children) {
    const mine = votes[me] === b.dataset.id;
    b.textContent = (mine ? "✓ " : "") + (opt ? optLabel(b.dataset.id) : names[b.dataset.id]);
    b.classList.toggle("mine", mine);
  }
  $("#waiting").replaceChildren(...ids.filter(id => !hasVoted(id)).map(id => playerRow(id, names[id])));
  if (isHost && voted === ids.length) doReveal();
}

function doReveal() {   // host: auto when everyone voted, or the "Reveal now" button
  if (!room || room.state !== "vote") return;
  IMP(room.game) ? revealImposter() : OPT(room.game) ? revealOpt() : revealMost();
}

// Votes for/by players still in the room, frozen at reveal time.
function frozenVotes() {
  const shown = {};
  for (const [v, t] of Object.entries(room.votes || {}))
    if (room.players[v] && (OPT(room.game) ? ["a", "b"].includes(t) : room.players[t])) shown[v] = t;
  return shown;
}
function tally(votes) {
  const counts = {};
  for (const target of Object.values(votes)) counts[target] = (counts[target] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  return { counts, max, top: Object.keys(counts).filter(id => counts[id] === max) };
}
function voteList(shown, players, names) {
  const opt = OPT(room.game), [pa, pb] = String(room.prompt || "").split("|");
  const lab = t => room.game === "wyr" ? (t === "a" ? pa : pb) : room.game === "hot" ? (t === "a" ? "🔥 agree" : "🧊 disagree") : names[t];
  return Object.entries(shown).filter(([v, t]) => players[v] && (opt || players[t]))
    .map(([v, t]) => el("li", `${names[v]} → ${lab(t)}`));
}

// ---------- WHO'S THE MOST ----------
function nextMost(reset) {   // host: Start (reset = true) and Next both call this
  const round = reset ? 0 : room.round;
  if (round >= MOST_ROUNDS) return update(roomRef(), { state: "end" }).catch(fail);
  // every prompt gets a stable key, so the "don't repeat" memory works across games
  let pool;
  if (room.game === "wyr") pool = WYR.map((p, i) => [`w${i}`, p.join("|")]);
  else if (room.game === "hot") pool = HOT.map((p, i) => [`h${i}`, p]);
  else {
    const names = Object.keys(MOST_PACKS), want = room.category && MOST_PACKS[room.category] ? [room.category] : names;
    pool = want.flatMap(n => MOST_PACKS[n].map((p, i) => [n === "Classic" ? String(i) : `m${names.indexOf(n)}_${i}`, p]));
  }
  if (!pool.length) return alert("No prompts in this pack");
  let free = pool.filter(([k]) => !room.used?.[k]);
  const cycle = free.length === 0;   // every prompt played: start over
  if (cycle) free = pool;
  const [k, text] = pick(free);
  const used = { ...(cycle ? {} : room.used), [k]: true };
  save("pgUsed", used);   // remembered on the host's phone for the next room too
  const u = { state: "vote", round: round + 1, rid: newId(), prompt: text, votes: null, shown: null, used };
  if (reset) for (const id in room.players) { u[`players/${id}/picked`] = 0; u[`players/${id}/wins`] = 0; }
  update(roomRef(), u).catch(fail);
}

function revealMost() {
  once("reveal", () => {
    const shown = frozenVotes();
    const { counts, max } = tally(shown);
    const u = { state: "reveal", shown };
    for (const [id, n] of Object.entries(counts)) {
      u[`players/${id}/picked`] = room.players[id].picked + n;
      if (n === max) u[`players/${id}/wins`] = room.players[id].wins + 1;   // ties: everyone +1
    }
    update(roomRef(), u).catch(fail);
  });
}

function revealOpt() {   // Would You Rather / Hot Takes: the crowd vs the rebels
  once("reveal", () => {
    const shown = frozenVotes();
    const a = Object.values(shown).filter(t => t === "a").length, b = Object.values(shown).filter(t => t === "b").length;
    const u = { state: "reveal", shown };
    if (a !== b) {
      const big = a > b ? "a" : "b";
      for (const [id, t] of Object.entries(shown)) {
        if (t === big) u[`players/${id}/wins`] = room.players[id].wins + 1;      // went with the crowd
        else u[`players/${id}/picked`] = room.players[id].picked + 1;           // the rebel
      }
    }
    update(roomRef(), u).catch(fail);
  });
}

function renderMostReveal(players, shown, names) {
  if (OPT(room.game)) return renderOptReveal(players, shown, names);
  const { counts, max, top } = tally(shown);
  const winners = top.filter(id => players[id]).map(id => names[id]);
  $("#rprompt").textContent = room.prompt;
  const sec = $("#reveal");
  suspense(room.rid, sec, fresh => {
    $("#winner").textContent = !winners.length ? "Nobody voted 😴" : "👑 " + (winners.length > 1 ? "Tie: " : "") + winners.join(" & ");
    if (fresh && winners.length) { SFX.tada(); confetti(); }
  });
  $("#bars").replaceChildren(...Object.keys(players).sort((a, b) => (counts[b] || 0) - (counts[a] || 0)).map(id => {
    const n = counts[id] || 0, bar = el("div", `${names[id]} — ${n}`);
    bar.className = "bar";
    bar.style.width = `${20 + 80 * n / Math.max(max, 1)}%`;
    return bar;
  }));
  $("#who").replaceChildren(...voteList(shown, players, names));
  $("#next").textContent = room.round >= MOST_ROUNDS ? "See final results" : "Next";
}

function renderOptReveal(players, shown, names) {
  const [pa, pb] = String(room.prompt || "").split("|"), wyr = room.game === "wyr";
  const vals = Object.values(shown), a = vals.filter(t => t === "a").length, b = vals.filter(t => t === "b").length, n = Math.max(1, a + b);
  $("#rprompt").textContent = wyr ? `Would you rather: ${pa} OR ${pb}?` : `🔥 "${room.prompt}"`;
  const la = wyr ? pa : "🔥 Agree", lb = wyr ? pb : "🧊 Disagree";
  suspense(room.rid, $("#reveal"), fresh => {
    $("#winner").textContent = a === b ? "Perfectly split! ⚖️" : `${Math.round(100 * Math.max(a, b) / n)}% ${a > b ? la : lb}`;
    if (fresh) { a === b ? SFX.pop() : SFX.tada(); }
  });
  $("#bars").replaceChildren(...[[la, a], [lb, b]].map(([l, c]) => { const bar = el("div", `${l} — ${c}`); bar.className = "bar"; bar.style.width = `${20 + 80 * c / n}%`; return bar; }));
  const lonely = Object.entries(shown).filter(([, t]) => a !== b && t === (a > b ? "b" : "a")).map(([v]) => names[v]);
  $("#who").replaceChildren(...(lonely.length ? [el("li", `😎 The rebels: ${lonely.join(", ")}`)] : []), ...voteList(shown, players, names));
  $("#next").textContent = room.round >= MOST_ROUNDS ? "See final results" : "Next";
}

function renderMostEnd(players, names) {
  const ids = Object.keys(players);
  const best = key => {
    const m = Math.max(...ids.map(id => players[id][key]));
    return ids.filter(id => players[id][key] === m).map(id => names[id]).join(" & ");
  };
  $("#titles").textContent = OPT(room.game)
    ? `🫂 Most in sync with the group: ${best("wins")} · 😎 Biggest rebel: ${best("picked")}`
    : `👑 Most picked: ${best("picked")} · Most rounds won: ${best("wins")}`;
  remember(room.rid, best(OPT(room.game) ? "wins" : "picked").split(" & "));
  $("#sharewin").onclick = () => shareText(`${GAMES[room.game]} results\n${$("#titles").textContent}\n` + [...$("#rank").children].map(li => li.textContent).join("\n"));
  $("#rank").replaceChildren(...[...ids]
    .sort((a, b) => players[b].picked - players[a].picked || players[b].wins - players[a].wins)
    .map(id => el("li", OPT(room.game) ? `${names[id]}: with the crowd ${players[id].wins}×, rebel ${players[id].picked}×` : `${names[id]}: ${players[id].picked} votes, ${players[id].wins} rounds won`)));
}

// ---------- IMPOSTER ----------
async function startImposter(reset) {   // host: Start (reset = true) and Next word
  const ids = Object.keys(room.players);
  if (ids.length < 3) return alert("You need at least 3 players");
  const under = room.game === "under";
  let category, word, decoy = "";
  const usedW = load("pgUsedWords", "{}");   // avoid repeating words on this host's phone
  if (under) {
    let pp = PAIRS.filter(p => !usedW[p.join("|")]);
    if (!pp.length) { PAIRS.forEach(p => delete usedW[p.join("|")]); pp = PAIRS; }
    const pair = pick(pp); usedW[pair.join("|")] = true;
    [word, decoy] = Math.random() < .5 ? pair : [pair[1], pair[0]];
    category = "Undercover";
  } else {
    category = pick(Object.keys(WORDS));
    let pool = WORDS[category].filter(w => !usedW[w]);
    if (!pool.length) { WORDS[category].forEach(w => delete usedW[w]); pool = [...WORDS[category]]; }
    word = pick(pool);
    usedW[word] = true;
  }
  save("pgUsedWords", usedW);

  const imposter = pick(ids);
  const turns = shuffle(ids);
  if (turns[0] === imposter) [turns[0], turns[1]] = [turns[1], turns[0]];   // imposter never goes first
  const order = [];
  for (let lap = 0; lap < CLUE_LAPS; lap++) order.push(...turns);
  const secrets = {};
  for (const id of ids) secrets[id] = id === imposter ? (under ? { word: decoy } : { imposter: true }) : { word };

  try {
    hostData = { word, imposter, name: room.players[imposter].name };
    if (under) hostData.decoy = decoy;
    await set(ref(db, `hostdata/${code}`), hostData);
    await set(ref(db, `secrets/${code}`), secrets);   // each player can only read their own
    const u = {
      state: "clue", round: (reset ? 0 : room.round) + 1, rid: newId(), category, order,
      clues: null, votes: null, shown: null, caught: null, guess: null, result: null
    };
    if (reset) for (const id of ids) u[`players/${id}/pts`] = 0;
    await update(roomRef(), u);
  } catch (e) { fail(e); }
}

function sendClue() {
  const text = $("#cluetext").value.trim().slice(0, 40);
  if (!text) return;
  const t = $("#clueform").dataset.turn;
  set(roomRef(`clues/${t}`), { by: me, text })
    .then(() => { $("#cluetext").value = ""; })
    .catch(() => alert("Couldn't send — maybe your turn was skipped"));
}

function skipTurn() {   // host: skip a player who's AFK
  const t = list(room.clues).length, current = room.order?.[t];
  if (!current || current === me) return;
  once(`skip${t}`, () => set(roomRef(`clues/${t}`), { by: current, text: "(skipped)" }).catch(fail));
}

function revealImposter() {
  if (!hostData) return;   // host's answer not loaded yet; the next update retries
  once("reveal", () => {
    const shown = frozenVotes();
    const { max, top } = tally(shown);
    if (max > 0 && top.length === 1 && top[0] === hostData.imposter && room.game === "under")
      finishImposter("caught", shown);   // the undercover never knew, so no steal-guess
    else if (max > 0 && top.length === 1 && top[0] === hostData.imposter)
      update(roomRef(), { state: "guess", shown, caught: hostData.imposter, guess: null }).catch(fail);
    else finishImposter(max > 0 && top.length === 1 ? "wrong" : "tie", shown);
  });
}

function renderGuess(names, isHost) {
  const caught = room.caught, mine = caught === me;
  $("#caughtname").textContent = `🚨 ${names[caught] || "The imposter"} got caught!`;
  $("#guessform").hidden = !mine;
  $("#guesswait").textContent = mine ? "" : `${names[caught]} gets one guess at the word to steal the win…`;
  $("#skipguess").hidden = !isHost || mine;
  if (isHost && hostData && room.guess != null)
    finishImposter(norm(room.guess) === norm(hostData.word) ? "stole" : "caught", room.shown || {});
}

function sendGuess() {
  const text = $("#guesstext").value.trim().slice(0, 40);
  if (!text) return;
  set(roomRef("guess"), text).then(() => { $("#guesstext").value = ""; }).catch(fail);
}

function finishImposter(outcome, shown) {   // host
  if (!hostData) return;
  once("finish", () => {
    const imp = hostData.imposter, players = room.players;
    const u = {
      state: "result", shown,
      result: { outcome, imposter: imp, name: players[imp]?.name || hostData.name, word: hostData.word, guess: room.game === "under" ? (hostData.decoy || "") : (room.guess || "") }
    };
    if (["wrong", "tie", "stole"].includes(outcome) && players[imp]) u[`players/${imp}/pts`] = players[imp].pts + 2;
    if (outcome === "caught") for (const id in players) if (id !== imp) u[`players/${id}/pts`] = players[id].pts + 1;
    update(roomRef(), u).catch(fail);
  });
}

function renderResult(players, names) {
  const r = room.result || {};
  const who = names[r.imposter] || r.name;
  const under = room.game === "under";
  const lines = under ? {
    wrong:  ["🎭 The undercover escaped!", `${who} had a different word: "${r.guess}". (+2 for ${who})`],
    tie:    ["🎭 The undercover escaped!", `The vote was split. ${who} had "${r.guess}". (+2 for ${who})`],
    caught: ["🎉 Undercover caught!", `${who} had "${r.guess}" the whole time. (+1 for everyone else)`],
    left:   ["🚪 The undercover left", `${who} left the room, so nobody scores this word.`]
  }[r.outcome] || ["", ""] : {
    wrong:  ["🕵️ The imposter escaped!", `You voted out the wrong person. ${who} was the imposter. (+2 for ${who})`],
    tie:    ["🕵️ The imposter escaped!", `The vote was split. ${who} was the imposter. (+2 for ${who})`],
    stole:  [`😈 ${who} stole the win!`, `Caught, but guessed the word "${r.guess}". (+2 for ${who})`],
    caught: ["🎉 Imposter caught!", `${who} was the imposter` + (r.guess ? ` and guessed "${r.guess}", wrong.` : ".") + " (+1 for everyone else)"],
    left:   ["🚪 The imposter left", `${who} left the room, so nobody scores this word.`]
  }[r.outcome] || ["", ""];
  const good = r.outcome === "caught";
  suspense(room.rid, $("#result"), fresh => {
    $("#headline").textContent = lines[0];
    if (fresh) { good ? (SFX.tada(), confetti()) : SFX.boo(); }
  });
  $("#subline").textContent = lines[1];
  const top = Object.keys(players).sort((a, b) => players[b].pts - players[a].pts)[0];
  $("#sharewin2").onclick = () => shareText(`${GAMES[room.game]}: ${lines[0]}\n${lines[1]}\nThe word was "${r.word}". Leader: ${names[top]} (${players[top]?.pts} pts)`);
  $("#theword").textContent = r.word || "";
  $("#rwho").replaceChildren(...voteList(room.shown || {}, players, names));
  $("#scores").replaceChildren(...Object.keys(players)
    .sort((a, b) => players[b].pts - players[a].pts)
    .map(id => el("li", `${names[id]}: ${players[id].pts} pts`)));
}

// ---------- buttons ----------
document.querySelectorAll("[data-create]").forEach(b => b.addEventListener("click", () => createRoom(b.dataset.create)));
$("#join").addEventListener("click", joinRoom);
document.querySelectorAll("[data-game]").forEach(b => b.addEventListener("click", () => {
  if (room && me === room.host) update(roomRef(), { game: b.dataset.game }).catch(fail);
}));
$("#start").addEventListener("click", () => { SFX.pop(); IMP(room.game) ? startImposter(true) : nextMost(true); });
$("#packs").addEventListener("click", e => {
  const p = e.target.closest("button")?.dataset.pack;
  if (p && room && me === room.host) update(roomRef(), { category: p === "All" ? null : p }).catch(fail);
});
$("#mute").addEventListener("click", () => { const m = !load("pgMute", "false"); save("pgMute", m); $("#mute").textContent = m ? "🔇 Sound off" : "🔊 Sound on"; if (!m) SFX.pop(); });
$("#mute").textContent = load("pgMute", "false") ? "🔇 Sound off" : "🔊 Sound on";
drawHall();
$("#share").addEventListener("click", () => {
  const url = `${location.origin}${location.pathname}?r=${code}`;
  if (navigator.share) navigator.share({ text: `Join my game! Code: ${code}`, url }).catch(() => {});
  else window.prompt("Copy this link:", url);
});
$("#sendclue").addEventListener("click", sendClue);
$("#cluetext").addEventListener("keydown", e => { if (e.key === "Enter") sendClue(); });
$("#skipturn").addEventListener("click", skipTurn);
$("#force").addEventListener("click", doReveal);
$("#next").addEventListener("click", () => nextMost(false));
$("#tolobby1").addEventListener("click", toLobby);
$("#tolobby2").addEventListener("click", toLobby);
$("#sendguess").addEventListener("click", sendGuess);
$("#guesstext").addEventListener("keydown", e => { if (e.key === "Enter") sendGuess(); });
$("#skipguess").addEventListener("click", () => finishImposter("caught", room.shown || {}));
$("#nextword").addEventListener("click", () => startImposter(false));

// Vote buttons: tap a name to vote; tap another to change it until the reveal.
$("#choices").addEventListener("click", e => {
  const id = e.target.closest("button")?.dataset.id;
  if (!id || !room || room.state !== "vote" || room.votes?.[me] === id) return;
  SFX.tap();
  set(roomRef(`votes/${me}`), id).catch(() => alert("Too late, the votes were already revealed"));
});
// Host kick (lobby list and the "Still voting" list). Votes for the kicked player are cleared.
document.addEventListener("click", e => {
  const id = e.target.dataset?.kick;
  if (!id || !room || me !== room.host) return;
  if (!confirm(`Remove ${labels(room.players)[id]}?`)) return;
  const u = { [`players/${id}`]: null, [`votes/${id}`]: null };
  for (const [v, t] of Object.entries(room.votes || {})) if (t === id) u[`votes/${v}`] = null;
  update(roomRef(), u).catch(fail);
});
