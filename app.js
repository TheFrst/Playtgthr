import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { initializeAuth, browserLocalPersistence, browserSessionPersistence, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { PROMPTS } from "./prompts.js";
import { WORDS } from "./words.js";

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

const GAMES = { most: "👑 Who's the Most?", imposter: "🕵️ Imposter" };
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
  if (isHost && room.game === "imposter" && hostData && ["clue", "vote", "guess"].includes(room.state)
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
  $("#start").disabled = ids.length < 3;
  $("#start").textContent = ids.length < 3 ? `Need 3+ players (${ids.length} now)` : `Start ${GAMES[room.game]}`;
}

function secretText() {
  if (!secret) return { text: "You joined mid-word, so just watch this one and vote 👀", imp: false };
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
  const hasVoted = id => !!players[votes[id]];   // a vote for a kicked player doesn't count
  const voted = ids.filter(hasVoted).length;
  const imp = room.game === "imposter";
  $("#roundinfo").textContent = imp ? GAMES.imposter : `Round ${room.round} of ${MOST_ROUNDS}`;
  $("#prompt").textContent = imp ? "Who's the imposter? 🕵️" : room.prompt;
  $("#vsecret").hidden = !imp;
  $("#recap").hidden = !imp;
  if (imp) { drawSecret($("#vsecret")); $("#recap").replaceChildren(...clueItems(names)); }
  $("#count").textContent = `${voted}/${ids.length} voted`;

  const key = room.rid + "|" + ids.join(",");   // rebuild buttons only when the round or players change
  if (key !== choicesKey) {
    choicesKey = key;
    $("#choices").replaceChildren(...ids.filter(id => id !== me).map(id => el("button", "", id)));
  }
  for (const b of $("#choices").children) {
    const mine = votes[me] === b.dataset.id;
    b.textContent = (mine ? "✓ " : "") + names[b.dataset.id];
    b.classList.toggle("mine", mine);
  }
  $("#waiting").replaceChildren(...ids.filter(id => !hasVoted(id)).map(id => playerRow(id, names[id])));
  if (isHost && voted === ids.length) doReveal();
}

function doReveal() {   // host: auto when everyone voted, or the "Reveal now" button
  if (!room || room.state !== "vote") return;
  room.game === "imposter" ? revealImposter() : revealMost();
}

// Votes for/by players still in the room, frozen at reveal time.
function frozenVotes() {
  const shown = {};
  for (const [v, t] of Object.entries(room.votes || {}))
    if (room.players[v] && room.players[t]) shown[v] = t;
  return shown;
}
function tally(votes) {
  const counts = {};
  for (const target of Object.values(votes)) counts[target] = (counts[target] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  return { counts, max, top: Object.keys(counts).filter(id => counts[id] === max) };
}
function voteList(shown, players, names) {
  return Object.entries(shown).filter(([v, t]) => players[v] && players[t])
    .map(([v, t]) => el("li", `${names[v]} → ${names[t]}`));
}

// ---------- WHO'S THE MOST ----------
function nextMost(reset) {   // host: Start (reset = true) and Next both call this
  if (!PROMPTS.length) return alert("Add some prompts to prompts.js first");
  const round = reset ? 0 : room.round;
  if (round >= MOST_ROUNDS) return update(roomRef(), { state: "end" }).catch(fail);
  let free = PROMPTS.map((_, i) => i).filter(i => !room.used?.[i]);
  const cycle = free.length === 0;   // every prompt played: start over
  if (cycle) free = PROMPTS.map((_, i) => i);
  const i = pick(free);
  const used = { ...(cycle ? {} : room.used), [i]: true };
  save("pgUsed", used);   // remembered on the host's phone for the next room too
  const u = { state: "vote", round: round + 1, rid: newId(), prompt: PROMPTS[i], votes: null, shown: null, used };
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

function renderMostReveal(players, shown, names) {
  const { counts, max, top } = tally(shown);
  const winners = top.filter(id => players[id]).map(id => names[id]);
  $("#rprompt").textContent = room.prompt;
  $("#winner").textContent = !winners.length ? "Nobody voted 😴" : (winners.length > 1 ? "Tie: " : "") + winners.join(" & ");
  $("#bars").replaceChildren(...Object.keys(players).sort((a, b) => (counts[b] || 0) - (counts[a] || 0)).map(id => {
    const n = counts[id] || 0, bar = el("div", `${names[id]} — ${n}`);
    bar.className = "bar";
    bar.style.width = `${20 + 80 * n / Math.max(max, 1)}%`;
    return bar;
  }));
  $("#who").replaceChildren(...voteList(shown, players, names));
  $("#next").textContent = room.round >= MOST_ROUNDS ? "See final results" : "Next";
}

function renderMostEnd(players, names) {
  const ids = Object.keys(players);
  const best = key => {
    const m = Math.max(...ids.map(id => players[id][key]));
    return ids.filter(id => players[id][key] === m).map(id => names[id]).join(" & ");
  };
  $("#titles").textContent = `Most picked: ${best("picked")} · Most rounds won: ${best("wins")}`;
  $("#rank").replaceChildren(...[...ids]
    .sort((a, b) => players[b].picked - players[a].picked || players[b].wins - players[a].wins)
    .map(id => el("li", `${names[id]}: ${players[id].picked} votes, ${players[id].wins} rounds won`)));
}

// ---------- IMPOSTER ----------
async function startImposter(reset) {   // host: Start (reset = true) and Next word
  const ids = Object.keys(room.players);
  if (ids.length < 3) return alert("You need at least 3 players");
  const category = pick(Object.keys(WORDS));
  const usedW = load("pgUsedWords", "{}");   // avoid repeating words on this host's phone
  let pool = WORDS[category].filter(w => !usedW[w]);
  if (!pool.length) { WORDS[category].forEach(w => delete usedW[w]); pool = [...WORDS[category]]; }
  const word = pick(pool);
  usedW[word] = true; save("pgUsedWords", usedW);

  const imposter = pick(ids);
  const turns = shuffle(ids);
  if (turns[0] === imposter) [turns[0], turns[1]] = [turns[1], turns[0]];   // imposter never goes first
  const order = [];
  for (let lap = 0; lap < CLUE_LAPS; lap++) order.push(...turns);
  const secrets = {};
  for (const id of ids) secrets[id] = id === imposter ? { imposter: true } : { word };

  try {
    hostData = { word, imposter, name: room.players[imposter].name };
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
    if (max > 0 && top.length === 1 && top[0] === hostData.imposter)
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
      result: { outcome, imposter: imp, name: players[imp]?.name || hostData.name, word: hostData.word, guess: room.guess || "" }
    };
    if (["wrong", "tie", "stole"].includes(outcome) && players[imp]) u[`players/${imp}/pts`] = players[imp].pts + 2;
    if (outcome === "caught") for (const id in players) if (id !== imp) u[`players/${id}/pts`] = players[id].pts + 1;
    update(roomRef(), u).catch(fail);
  });
}

function renderResult(players, names) {
  const r = room.result || {};
  const who = names[r.imposter] || r.name;
  const lines = {
    wrong:  ["🕵️ The imposter escaped!", `You voted out the wrong person. ${who} was the imposter. (+2 for ${who})`],
    tie:    ["🕵️ The imposter escaped!", `The vote was split. ${who} was the imposter. (+2 for ${who})`],
    stole:  [`😈 ${who} stole the win!`, `Caught, but guessed the word "${r.guess}". (+2 for ${who})`],
    caught: ["🎉 Imposter caught!", `${who} was the imposter` + (r.guess ? ` and guessed "${r.guess}", wrong.` : ".") + " (+1 for everyone else)"],
    left:   ["🚪 The imposter left", `${who} left the room, so nobody scores this word.`]
  }[r.outcome] || ["", ""];
  $("#headline").textContent = lines[0];
  $("#subline").textContent = lines[1];
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
$("#start").addEventListener("click", () => room.game === "imposter" ? startImposter(true) : nextMost(true));
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
