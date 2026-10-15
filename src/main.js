import "./style.css";

const app = document.querySelector("#app");
const API = "/.netlify/functions/game";
const KEY = "iad-session-v1";
const categories = ["Food", "Technology", "Movies", "Places", "Everyday objects"];
const state = {
  screen: "home", room: null, player: null, token: null, secret: null,
  roomCode: "", name: "", error: "", busy: false, lastVersion: -1,
  pollTimer: null, localMode: false
};

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));
const initials = n => (n || "?").trim().slice(0, 2).toUpperCase();
const isHost = () => !!state.room && state.room.hostId === state.player?.id;
const me = () => state.room?.players?.find(p => p.id === state.player?.id);
const phaseNames = {
  lobby: "LOBBY", role: "SECRET BRIEFING", clues: "CLUE ROUND",
  discussion: "DISCUSSION", voting: "CAST YOUR VOTE", reveal: "ROUND REVEAL", finished: "FINAL RESULTS"
};

function setError(message) { state.error = message || ""; }
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }

async function api(action, payload = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload, roomCode: payload.roomCode || state.roomCode || state.room?.code, playerId: payload.playerId || state.player?.id, token: payload.token || state.token })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function applyRoom(data) {
  if (data.room) {
    state.room = data.room;
    state.roomCode = data.room.code;
    state.lastVersion = data.room.version ?? state.lastVersion;
  }
  if (data.player) state.player = data.player;
  if (data.token) state.token = data.token;
  if (data.secret !== undefined) state.secret = data.secret;
  if (state.player && state.token) {
    try { localStorage.setItem(KEY, JSON.stringify({ player: state.player, token: state.token, roomCode: state.roomCode })); } catch {}
  }
}
async function refresh(silent = false) {
  if (!state.roomCode || !state.player?.id || !state.token) return;
  try {
    const data = await api("state");
    applyRoom(data);
    if (data.secret !== undefined) state.secret = data.secret;
    if (!silent) render();
    else render();
  } catch (err) {
    if (!silent) { setError(err.message); render(); }
  }
}
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => refresh(true), 1200);
}
function goHome() {
  stopPolling();
  state.screen = "home"; state.room = null; state.player = null; state.token = null;
  state.secret = null; state.roomCode = ""; state.error = ""; state.busy = false;
  try { localStorage.removeItem(KEY); } catch {}
  render();
}
async function doAction(action, payload = {}, nextScreen) {
  if (state.busy) return;
  state.busy = true; setError(""); render();
  try {
    const data = await api(action, payload);
    applyRoom(data);
    if (data.secret !== undefined) state.secret = data.secret;
    if (nextScreen) state.screen = nextScreen;
    if (state.room) state.screen = state.room.phase === "lobby" ? "room" : "game";
    startPolling();
  } catch (err) { setError(err.message); }
  finally { state.busy = false; render(); }
}
function playerCard(p, index) {
  const mine = p.id === state.player?.id;
  return `<div class="player-row">
    <div class="avatar ${mine ? "mine" : ""}">${escapeHtml(initials(p.name))}</div>
    <div class="player-meta"><strong>${escapeHtml(p.name)}${mine ? ' <span class="you">(YOU)</span>' : ""}</strong><small>${p.connected === false ? "Reconnecting…" : (p.id === state.room?.hostId ? "Room host" : "Operative")}</small></div>
    <span class="status-dot ${p.connected === false ? "offline" : ""}"></span>
  </div>`;
}
function topbar() {
  return `<header class="topbar"><button class="wordmark" data-action="home"><span class="brand-mark">◈</span> IMPOSTOR <i>//</i> AFTER DARK</button><div class="top-right"><span class="live-pill"><b></b> LIVE ROOM</span>${state.room ? `<button class="code-chip" data-action="copy-code">${escapeHtml(state.room.code)} <span>⧉</span></button>` : ""}</div></header>`;
}
function errorBox() { return state.error ? `<div class="error-box" role="alert">${escapeHtml(state.error)}</div>` : ""; }
function homeView() {
  return `<main class="hero">
    <div class="hero-copy"><div class="eyebrow"><span></span> SOCIAL DEDUCTION / MULTIPLAYER</div>
      <h1>TRUST<br/><em>NO ONE.</em></h1>
      <p class="hero-sub">One secret. One impostor. And a room full of people who might be lying.</p>
      <div class="home-actions">
        <button class="btn btn-primary" data-action="show-create">CREATE A ROOM <span>↗</span></button>
        <button class="btn btn-secondary" data-action="show-join">JOIN WITH CODE <span>＋</span></button>
      </div>
      <div class="micro-stats"><span><b>02–04</b> PLAYERS</span><span><b>03</b> ROUNDS</span><span><b>ZERO</b> DOWNLOADS</span></div>
    </div>
    <div class="hero-art" aria-label="Abstract neon game artwork">
      <div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
      <div class="core"><span class="eye">◉</span><span class="core-label">WHO'S<br/>LYING?</span></div>
      <div class="float-tag tag-a">IDENTITY UNKNOWN</div><div class="float-tag tag-b">SIGNAL DETECTED <b>●</b></div>
      <div class="crosshair">＋</div><div class="side-code">I / A — 001</div>
    </div>
    <div class="bottom-note"><span class="tiny-line"></span> READ THE ROOM. READ BETWEEN THE LINES.</div>
  </main>
  <section class="home-panel hidden" id="create-panel"><div class="panel-head"><span class="eyebrow">NEW SESSION</span><button class="close-btn" data-action="close-panel">×</button></div><h2>Start the game.</h2><label for="create-name">YOUR CODENAME</label><input id="create-name" maxlength="18" placeholder="e.g. NightOwl" autocomplete="nickname"/><label for="round-count">ROUNDS</label><select id="round-count"><option value="3">3 rounds · Quick match</option><option value="5">5 rounds · Extended match</option></select><button class="btn btn-primary full" data-action="create">GENERATE ROOM CODE ↗</button></section>
  <section class="home-panel hidden" id="join-panel"><div class="panel-head"><span class="eyebrow">JOIN SESSION</span><button class="close-btn" data-action="close-panel">×</button></div><h2>Enter the room.</h2><label for="join-name">YOUR CODENAME</label><input id="join-name" maxlength="18" placeholder="e.g. GhostMode" autocomplete="nickname"/><label for="join-code">SIX-CHARACTER ROOM CODE</label><input id="join-code" maxlength="6" placeholder="ABC123" class="code-input" autocapitalize="characters"/><button class="btn btn-primary full" data-action="join">JOIN THE ROOM ↗</button></section>
  ${errorBox()}`;
}
function lobbyView() {
  const room = state.room;
  return `<main class="content-shell"><div class="section-kicker">PRIVATE SESSION <span> / </span> WAITING ROOM</div>
    <div class="lobby-head"><div><h1>Assemble<br/><em>your crew.</em></h1><p>Share the code. Trust absolutely nobody.</p></div>
      <div class="room-code-block"><small>ROOM CODE</small><button data-action="copy-code" class="room-code">${escapeHtml(room.code)} <span>⧉</span></button><small class="muted">Tap to copy invite code</small></div></div>
    <div class="lobby-grid"><section class="panel player-panel"><div class="panel-title"><span>OPERATIVES</span><span>${room.players.length} / 4</span></div><div class="player-list">${room.players.map(playerCard).join("")}${Array.from({length:Math.max(0,4-room.players.length)},(_,i)=>`<div class="player-row empty"><div class="avatar">··</div><div class="player-meta"><strong>Awaiting operative</strong><small>Share the room code to invite</small></div><span class="status-dot waiting"></span></div>`).join("")}</div><div class="panel-foot"><span class="pulse"></span> ${room.players.length < 3 ? "2-player bluff mode available" : "Impostor protocol ready"}</div></section>
      <section class="panel rules-panel"><div class="panel-title">MISSION BRIEF</div><div class="rule"><span>01</span><div><b>GET YOUR WORD</b><small>Everyone sees a secret word. The impostor gets only a category.</small></div></div><div class="rule"><span>02</span><div><b>DROP A CLUE</b><small>Take turns. One clue each. Don't make it too obvious.</small></div></div><div class="rule"><span>03</span><div><b>FIND THE LIAR</b><small>Discuss, vote in private, and expose the impostor.</small></div></div><div class="round-select"><label for="round-select">MATCH LENGTH</label><strong>${room.totalRounds} ROUNDS</strong></div></section></div>
    <div class="lobby-actions">${isHost() ? `<button class="btn btn-primary" data-action="start" ${room.players.length<2 ? "disabled" : ""}>${room.players.length<2?"WAITING FOR PLAYERS":"START MATCH"} <span>↗</span></button>` : `<div class="waiting-message"><span class="pulse"></span> Waiting for host to start…</div>`}<button class="btn btn-quiet" data-action="leave">LEAVE ROOM</button></div>${errorBox()}</main>`;
}
function gameView() {
  const r = state.room, phase = r.phase;
  const players = r.players || [];
  const secret = state.secret;
  let body = "";
  if (phase === "role") {
    body = `<div class="secret-card ${secret?.role==="impostor"?"impostor-secret":""}"><div class="eyebrow">YOUR CLASSIFICATION</div><h2>${secret?.role==="impostor"?"IMPOSTOR":"OPERATIVE"}</h2><p>${secret?.role==="impostor"?"You don't know the secret word. Blend in and survive.":"Keep this word secret. Spot anyone who sounds suspicious."}</p><div class="secret-word">${secret?.role==="impostor" ? "???" : escapeHtml(secret?.word || "••••••")}</div><div class="category-tag">${secret?.role==="impostor" ? "CATEGORY: "+escapeHtml(secret?.category || "UNKNOWN") : "SECRET WORD"}</div><button class="btn btn-primary full" data-action="ready-role">I'M READY ↗</button></div>`;
  } else if (phase === "clues") {
    const current = players.find(p=>p.id===r.currentPlayerId);
    const already = (r.clues||[]).some(c=>c.playerId===state.player?.id);
    body = `<div class="phase-copy"><div class="eyebrow">ROUND ${r.roundNumber} / ${r.totalRounds}</div><h2>${current?.id===state.player?.id?"Your turn to speak.":"Listen closely."}</h2><p>${current?.id===state.player?.id?"Give one short clue that relates to your word. Don't say the word itself.":"Waiting for "+escapeHtml(current?.name||"the next player")+" to submit a clue."}</p></div>
      ${(r.clues||[]).length ? `<div class="clue-list">${r.clues.map(c=>`<div class="clue-item"><span>${escapeHtml(c.playerName)}</span><b>${escapeHtml(c.text)}</b></div>`).join("")}</div>`:""}
      ${current?.id===state.player?.id && !already ? `<form id="clue-form" class="action-form"><label for="clue-text">YOUR CLUE</label><input id="clue-text" maxlength="70" required placeholder="A short hint, not the answer…"/><button class="btn btn-primary full" type="submit">SUBMIT CLUE ↗</button></form>`:""}
      ${isHost()?`<button class="btn btn-secondary full" data-action="advance-clues">HOST: ADVANCE PHASE</button>`:""}`;
  } else if (phase === "discussion") {
    body = `<div class="phase-copy"><div class="eyebrow">ROUND ${r.roundNumber} / ${r.totalRounds}</div><h2>Something feels<br/><em>off.</em></h2><p>Discuss the clues with your crew. Then the host can open voting.</p></div><div class="clue-list">${(r.clues||[]).map(c=>`<div class="clue-item"><span>${escapeHtml(c.playerName)}</span><b>${escapeHtml(c.text)}</b></div>`).join("")}</div>${isHost()?`<button class="btn btn-primary full" data-action="open-voting">OPEN VOTING ↗</button>`:`<div class="waiting-message"><span class="pulse"></span> Waiting for host to open voting…</div>`}`;
  } else if (phase === "voting") {
    const voted = (r.votes||[]).some(v=>v.voterId===state.player?.id);
    body = `<div class="phase-copy"><div class="eyebrow">ROUND ${r.roundNumber} / ${r.totalRounds}</div><h2>Who is the<br/><em>impostor?</em></h2><p>Choose one player. Your vote stays hidden until the reveal.</p></div><div class="vote-grid">${players.filter(p=>p.id!==state.player?.id).map(p=>`<button class="vote-card" data-action="vote" data-target="${p.id}" ${voted?"disabled":""}><span class="avatar">${escapeHtml(initials(p.name))}</span><b>${escapeHtml(p.name)}</b><small>${voted?"VOTE LOCKED":"SELECT SUSPECT"}</small></button>`).join("")}</div>${voted?`<div class="waiting-message"><span class="pulse"></span> Vote locked. Waiting for other operatives…</div>`:""}${isHost()?`<button class="btn btn-secondary full" data-action="reveal">HOST: REVEAL VOTES</button>`:""}`;
  } else if (phase === "reveal") {
    const res = r.lastResult || {};
    body = `<div class="result-mark">${res.caught?"✓":"×"}</div><div class="phase-copy"><div class="eyebrow">ROUND ${r.roundNumber} COMPLETE</div><h2>${res.caught?"Impostor exposed.":"The impostor escaped."}</h2><p>The secret word was <strong>${escapeHtml(res.word||"—")}</strong>. The impostor was <strong>${escapeHtml(res.impostorName||"unknown")}</strong>.</p></div><div class="score-list">${players.map(p=>`<div class="score-row"><span>${escapeHtml(p.name)}</span><b>${p.score||0} <small>PTS</small></b></div>`).join("")}</div>${isHost()?`<button class="btn btn-primary full" data-action="next-round">${r.roundNumber>=r.totalRounds?"VIEW FINAL RESULTS":"NEXT ROUND"} ↗</button>`:`<div class="waiting-message"><span class="pulse"></span> Waiting for host to continue…</div>`}`;
  } else if (phase === "finished") {
    const sorted = [...players].sort((a,b)=>(b.score||0)-(a.score||0));
    body = `<div class="result-mark trophy">♛</div><div class="phase-copy"><div class="eyebrow">MISSION COMPLETE</div><h2>${escapeHtml(sorted[0]?.name||"Nobody")}<br/><em>takes the crown.</em></h2><p>Final standings. Same crew, new suspicions?</p></div><div class="score-list">${sorted.map((p,i)=>`<div class="score-row"><span><i class="rank">0${i+1}</i>${escapeHtml(p.name)}</span><b>${p.score||0} <small>PTS</small></b></div>`).join("")}</div>${isHost()?`<button class="btn btn-primary full" data-action="restart">PLAY AGAIN ↗</button>`:""}<button class="btn btn-quiet full" data-action="leave">LEAVE ROOM</button>`;
  }
  return `<main class="content-shell game-shell"><div class="section-kicker">ROOM ${escapeHtml(r.code)} <span> / </span> ${phaseNames[phase]||phase.toUpperCase()}</div><div class="game-layout"><section class="game-main">${body}${errorBox()}</section><aside class="panel sidebar"><div class="panel-title">OPERATIVES <span>${players.length}</span></div><div class="player-list compact">${players.map(playerCard).join("")}</div><div class="sidebar-divider"></div><div class="panel-title">LIVE SCOREBOARD</div><div class="score-list compact-scores">${[...players].sort((a,b)=>(b.score||0)-(a.score||0)).map((p,i)=>`<div class="score-row"><span>${escapeHtml(p.name)}</span><b>${p.score||0}</b></div>`).join("")}</div><div class="sidebar-note"><span class="pulse"></span> STATE SYNC ACTIVE</div></aside></div></main>`;
}
function render() {
  if (!state.room) {
    app.innerHTML = `${topbar()}${homeView()}<footer><span>© AFTER DARK PROTOCOL</span><span>BUILT FOR THE UNTRUSTING.</span></footer>`;
  } else if (state.room.phase === "lobby") {
    app.innerHTML = `${topbar()}${lobbyView()}<footer><span>© AFTER DARK PROTOCOL</span><span>ROOMS ARE PRIVATE. SECRETS ARE NOT.</span></footer>`;
  } else {
    app.innerHTML = `${topbar()}${gameView()}<footer><span>© AFTER DARK PROTOCOL</span><span>ROOM ${escapeHtml(state.room.code)} · ${state.room.phase.toUpperCase()}</span></footer>`;
  }
  const create = document.querySelector("#create-panel"), join = document.querySelector("#join-panel");
  if (create && state.screen === "create") create.classList.remove("hidden");
  if (join && state.screen === "join") join.classList.remove("hidden");
  if (state.busy) app.querySelectorAll("button[data-action]").forEach(b=>b.disabled=true);
}
function showPanel(which) { state.screen=which; setError(""); render(); const input=document.querySelector(which==="create"?"#create-name":"#join-name"); input?.focus(); }
function readName(id) { return (document.querySelector(id)?.value || "").trim(); }

app.addEventListener("click", async e => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const a = b.dataset.action;
  if (a==="home") { goHome(); return; }
  if (a==="show-create") { showPanel("create"); return; }
  if (a==="show-join") { showPanel("join"); return; }
  if (a==="close-panel") { state.screen="home"; render(); return; }
  if (a==="create") {
    const name=readName("#create-name");
    if (!name) { setError("Choose a codename first."); render(); return; }
    await doAction("create", {name, totalRounds:Number(document.querySelector("#round-count")?.value||3)});
    return;
  }
  if (a==="join") {
    const name=readName("#join-name"), code=(document.querySelector("#join-code")?.value||"").trim().toUpperCase();
    if (!name || !code) { setError("Enter a codename and room code."); render(); return; }
    state.roomCode=code;
    await doAction("join", {name, roomCode:code});
    return;
  }
  if (a==="copy-code") {
    try { await navigator.clipboard.writeText(state.room?.code || state.roomCode); setError("Room code copied."); } catch { setError("Room code: "+(state.room?.code||state.roomCode)); }
    render(); return;
  }
  if (a==="start") { await doAction("start"); return; }
  if (a==="leave") { try { await api("leave"); } catch {} goHome(); return; }
  if (a==="ready-role") { await doAction("ready"); return; }
  if (a==="advance-clues") { await doAction("advanceClues"); return; }
  if (a==="open-voting") { await doAction("openVoting"); return; }
  if (a==="vote") { await doAction("vote", {targetId:b.dataset.target}); return; }
  if (a==="reveal") { await doAction("reveal"); return; }
  if (a==="next-round") { await doAction("nextRound"); return; }
  if (a==="restart") { await doAction("restart"); return; }
});
app.addEventListener("submit", async e => {
  if (e.target.id==="clue-form") {
    e.preventDefault();
    const text=(document.querySelector("#clue-text")?.value||"").trim();
    if (!text) return;
    await doAction("clue", {text});
  }
});

window.addEventListener("online", () => refresh(true));
window.addEventListener("beforeunload", () => stopPolling());
try {
  const saved=JSON.parse(localStorage.getItem(KEY)||"null");
  if (saved?.roomCode && saved?.player?.id && saved?.token) {
    state.roomCode=saved.roomCode; state.player=saved.player; state.token=saved.token;
    refresh().then(()=>startPolling());
  } else render();
} catch { render(); }
