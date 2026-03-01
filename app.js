const $ = (id) => document.getElementById(id);

    // Tuned assumptions
    const SOL_TO_USD = 100; // internal conversion (mock) — for display only

    // Single-curve: virtual tranche before spawn, realized on spawn
    const TOTAL_SUPPLY = 1_000_000_000;
    const SPAWN_TRANCHE_PCT = 0.10;
    const SPAWN_TRANCHE_TOKENS = TOTAL_SUPPLY * SPAWN_TRANCHE_PCT; // 100,000,000

    // Per-wallet cap at spawn: ≤0.5% of total supply (i.e., ≤5% of the spawn tranche)
    const MAX_WALLET_PCT_TOTAL = 0.005;
    const MAX_TOKENS_PER_WALLET = TOTAL_SUPPLY * MAX_WALLET_PCT_TOTAL; // 5,000,000

    // Quality + distribution requirements
    const GOOD_W_THRESHOLD = 0.80;      // humanWeight threshold to be considered "good"
    const GOOD_TOKEN_FRACTION = 0.80;   // need ≥80% of sold spawn tokens held by good wallets
    const MIN_GOOD_WALLETS = 20;        // 1 / 0.05 = 20 (min wallets if everyone is maxed)

    // Virtual spawn curve (SOL per token) — linear, increasing with tranche sold (mock)
    const VPRICE_P0 = 2e-7;   // starting price (SOL per token)
    const VPRICE_P1 = 8e-7;   // additional price by end of tranche
    const VPRICE_T = SPAWN_TRANCHE_TOKENS;

    const MC_SPAWN = 6600;
    const MC_BONDED = 66000;

    // vouch controls
    const VOUCHES_PER_THREAD = 2;
    const MAX_COUNTED_VOUCHES_PER_RECIPIENT = 3;

    const homeView = $("homeView");
    const roomView = $("roomView");
    const homeBtn = $("homeBtn");

    const walletPill = $("walletPill");
    const connectBtn = $("connectBtn");

    const toast = $("toast");
    const toastText = $("toastText");
    let toastTimer = null;

    function showToast(msg){
      toastText.textContent = msg || "connect wallet first.";
      toast.classList.add("on");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("on"), 2400);
    }

    function setView(which){
      const isHome = (which === "home");
      homeView.classList.toggle("on", isHome);
      roomView.classList.toggle("on", !isHome);
      homeBtn.style.display = isHome ? "none" : "inline-block";
    }

    function escapeText(s){
      return String(s)
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
    }


    function normalizeUrl(raw, kind){
      const s0 = String(raw||"").trim();
      if(!s0) return "";
      let s = s0;

      // convenience shorthands
      if(kind === "x"){
        if(s.startsWith("@")) s = "https://x.com/" + s.slice(1);
        if(/^x\.com\//i.test(s)) s = "https://" + s;
        if(/^twitter\.com\//i.test(s)) s = "https://" + s;
      } else if(kind === "tg"){
        if(/^t\.me\//i.test(s)) s = "https://" + s;
        if(/^telegram\.me\//i.test(s)) s = "https://" + s;
      } else if(kind === "web"){
        // if it looks like a domain, add https
        if(!/^https?:\/\//i.test(s) && /\.[a-z]{2,}/i.test(s)) s = "https://" + s;
      }

      // add scheme if missing but looks like a domain/path
      if(!/^https?:\/\//i.test(s) && /\.[a-z]{2,}/i.test(s)) s = "https://" + s;

      try{
        const u = new URL(s);
        if(u.protocol !== "http:" && u.protocol !== "https:") return "";
        // basic hard block
        if(/^javascript:/i.test(s0) || /^data:/i.test(s0)) return "";
        return u.toString();
      } catch(e){
        return "";
      }
    }

    function shortWallet(w){
      if(!w) return "not connected";
      return w.slice(0,4) + "..." + w.slice(-4);
    }
    async function copyToClipboard(text){
      try { await navigator.clipboard.writeText(text); }
      catch(e){
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
    }
    function nowStamp(){
      const d = new Date();
      return d.getFullYear() + "-" +
        String(d.getMonth()+1).padStart(2,"0") + "-" +
        String(d.getDate()).padStart(2,"0") + " " +
        String(d.getHours()).padStart(2,"0") + ":" +
        String(d.getMinutes()).padStart(2,"0");
    }
    function timeAgo(ms){
      const s = Math.floor(ms/1000);
      if(s < 60) return s + "s";
      const m = Math.floor(s/60);
      if(m < 60) return m + "m";
      const h = Math.floor(m/60);
      if(h < 48) return h + "h";
      const d = Math.floor(h/24);
      return d + "d";
    }
    function clamp01(x){ return Math.max(0, Math.min(1, Number(x||0))); }

    // ----------------------------
    // Virtual spawn curve helpers (pre-token)
    // ----------------------------
    function ensurePos(r, wallet){
      r.positions = r.positions || {};
      if(!r.positions[wallet]) r.positions[wallet] = { escrow_sol:0, bond_sol:0, spawn_tokens:0 };
      if(r.positions[wallet].spawn_tokens == null) r.positions[wallet].spawn_tokens = 0;
      if(r.positions[wallet].escrow_sol == null) r.positions[wallet].escrow_sol = 0;
      if(r.positions[wallet].bond_sol == null) r.positions[wallet].bond_sol = 0;
      return r.positions[wallet];
    }

    // Linear price: P(s) = P0 + P1*(s/T), where s is tokens already sold in the spawn tranche.
    // Closed-form solve for tokensOut given solIn.
    function tokensForSol(solIn, tokensSold){
      const sol = Math.max(0, Number(solIn||0));
      const s = Math.max(0, Number(tokensSold||0));
      if(sol <= 0) return 0;

      const T = VPRICE_T;
      const a = VPRICE_P0;
      const b = VPRICE_P1;

      // cost(t) = a*t + (b/(2T))*((s+t)^2 - s^2) = (b/(2T))*t^2 + (a + b*s/T)*t
      const A = (b/(2*T));
      const B = (a + (b*s/T));
      const C = -sol;

      // If A is ~0, fallback to flat price.
      if(Math.abs(A) < 1e-18){
        return sol / Math.max(1e-18, B);
      }

      const disc = B*B - 4*A*C;
      const t = (-B + Math.sqrt(Math.max(0, disc))) / (2*A);
      return Math.max(0, t);
    }

    function applySpawnCommit(r, wallet, solIn){
      const pos = ensurePos(r, wallet);
      const sol = Math.max(0, Number(solIn||0));
      if(sol <= 0) return 0;

      // escrow bucket (refundable pre-spawn)
      pos.escrow_sol = Number(pos.escrow_sol||0) + sol;

      // allocate virtual spawn tokens
      const walletRemain = Math.max(0, MAX_TOKENS_PER_WALLET - Number(pos.spawn_tokens||0));
      const trancheRemain = Math.max(0, SPAWN_TRANCHE_TOKENS - Number(r.spawn_tokens_total||0));

      let tokensOut = tokensForSol(sol, Number(r.spawn_tokens_total||0));
      tokensOut = Math.min(tokensOut, walletRemain, trancheRemain);
      tokensOut = Math.max(0, tokensOut);

      pos.spawn_tokens = Number(pos.spawn_tokens||0) + tokensOut;
      r.spawn_tokens_total = Number(r.spawn_tokens_total||0) + tokensOut;

      return tokensOut;
    }

    function applySpawnUncommit(r, wallet, solOut){
      const pos = ensurePos(r, wallet);
      const sol = Math.max(0, Number(solOut||0));
      const curSol = Math.max(0, Number(pos.escrow_sol||0));
      if(sol <= 0 || curSol <= 0) return 0;

      const take = Math.min(sol, curSol);
      const ratio = take / curSol;

      // proportional unwind (mock)
      const curTokens = Math.max(0, Number(pos.spawn_tokens||0));
      const tokensRemove = curTokens * ratio;

      pos.escrow_sol = curSol - take;
      pos.spawn_tokens = Math.max(0, curTokens - tokensRemove);
      r.spawn_tokens_total = Math.max(0, Number(r.spawn_tokens_total||0) - tokensRemove);

      return tokensRemove;
    }
    function fmtK(n){
      const v = Number(n||0);
      if(v >= 1000000) return "$" + (v/1000000).toFixed(2) + "M";
      if(v >= 1000) return "$" + (v/1000).toFixed(1) + "K";
      return "$" + v.toFixed(0);
    }
    function signArrow(p){
      const v = Number(p||0);
      const a = Math.abs(v).toFixed(2) + "%";
      if(v > 0) return "▲ " + a;
      if(v < 0) return "▼ " + a;
      return "—";
    }


    function fmtUsd(n){
      const v = Number(n||0);
      return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }

    // Simple placeholder sparkline for post-spawn rooms (no external data)
    function renderSparkline(room){
      const svg = $("sparkSvg");
      const path = $("sparkPath");
      if(!svg || !path) return;

      // deterministic-ish seed from room id
      let seed = 0;
      for(const ch of String(room.id||"")) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      function rnd(){
        // xorshift32
        seed ^= (seed << 13) >>> 0;
        seed ^= (seed >> 17) >>> 0;
        seed ^= (seed << 5) >>> 0;
        return (seed >>> 0) / 4294967296;
      }

      const W = 300, H = 90, N = 48;
      const base = 0.45 + rnd()*0.1;
      const trend = (Number(room.change_pct||0) >= 0 ? 1 : -1) * (0.18 + rnd()*0.12);

      const ys = [];
      let y = base;
      for(let i=0;i<N;i++){
        const noise = (rnd()-0.5) * 0.10;
        y = Math.min(0.98, Math.max(0.02, y + noise + trend/(N-1)));
        ys.push(y);
      }
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const span = Math.max(1e-6, (maxY - minY));

      const pts = ys.map((v,i)=>{
        const x = (i/(N-1))*W;
        const yy = H - ((v - minY)/span)*H;
        return [x, yy];
      });

      const d = pts.map((p,i)=> (i===0 ? `M ${p[0].toFixed(2)} ${p[1].toFixed(2)}` : `L ${p[0].toFixed(2)} ${p[1].toFixed(2)}`)).join(" ");
      path.setAttribute("d", d);
    }


    // State
    let connectedWallet = null;
    let activeRoomId = null;

    const profile = {
      namesByWallet: {},
      wallet_first_seen_ms: null,
      walletScoreByWallet: {},
      verifiedByRoom: {},
      verifiedGlobalByWallet: {},
      vouchesLeftByRoom: {},
      hasVouched: {},
      vouchCountedByRoom: {}
    };

    function getScore(wallet){
      return Math.max(0, Math.min(100, Number(profile.walletScoreByWallet[wallet] ?? 50)));
    }
    function setScore(wallet, val){
      profile.walletScoreByWallet[wallet] = Math.max(0, Math.min(100, Math.round(Number(val||0))));
    }
    function bumpScore(wallet, delta){
      setScore(wallet, getScore(wallet) + Number(delta||0));
    }
    function isVerifiedGlobal(wallet){ return !!profile.verifiedGlobalByWallet[wallet]; }
    function isVerifiedInRoom(wallet, roomId){
      const m = profile.verifiedByRoom[roomId] || {};
      return !!m[wallet];
    }
    function displayName(pubkey){
      const n = (profile.namesByWallet[pubkey] || "").trim();
      return n ? n : shortWallet(pubkey);
    }

    const state = {
      rooms: [
        mkRoom("r1","cats","CATS","just a mock coin"),
        mkRoom("r2","pump_alpha","ALPHA","tokenized attention"),
        mkRoom("r3","meme_lab","MEME","chaos, but organized")
      ],
      chat: {
        r1: [{ ts:"—", wallet:"SYSTEM", text:"waiting for spawn." }],
        r2: [{ ts:"—", wallet:"SYSTEM", text:"keep it clean." }],
        r3: [{ ts:"—", wallet:"SYSTEM", text:"waiting for spawn." }]
      }
    };

    // Example already spawned + bonding
    state.rooms[1].state = "BONDING";
    state.rooms[1].market_cap_usd = 36800;
    state.rooms[1].change_pct = -12.71;
    state.rooms[1].token_address = "6NQN...pump";
    state.rooms[1].image = null;

    // Example bonded
    state.rooms[2].state = "BONDED";
    state.rooms[2].market_cap_usd = 69000;
    state.rooms[2].change_pct = 28.14;
    state.rooms[2].token_address = "4khTDC...tG8d";
    state.rooms[2].image = null;

    function mkRoom(id, name, ticker, desc){
      return {
        id, name, ticker, desc,
        creator_wallet: (Math.random().toString(16).slice(2,10) + '111111111111111111111111111111').slice(0,44),
        socials: { x:'', tg:'', web:'' },
        created_at: nowStamp(),
        state: "SPAWNING",          // SPAWNING | BONDING | BONDED
        spawn_tokens_total: 0,      // virtual tokens sold in the spawn tranche (pre-token)
        positions: {},              // wallet -> { escrow_sol, bond_sol, spawn_tokens }
        market_cap_usd: 0,
        change_pct: (Math.random() * 10 - 5),
        token_address: null,
        image: null,
        series: null
      };
    }

    function roomById(id){ return state.rooms.find(r => r.id === id); }

    function myEscrow(roomId){
      if(!connectedWallet) return 0;
      const r = roomById(roomId);
      const p = r.positions[connectedWallet] || {escrow_sol:0, bond_sol:0, spawn_tokens:0};
      return Number(p.escrow_sol||0);
    }
    function myBond(roomId){
      if(!connectedWallet) return 0;
      const r = roomById(roomId);
      const p = r.positions[connectedWallet] || {escrow_sol:0, bond_sol:0, spawn_tokens:0};
      return Number(p.bond_sol||0);
    }

    function committedUsd(r){
      let totalSol = 0;
      for(const w of Object.keys(r.positions || {})){
        totalSol += Math.max(0, Number((r.positions[w]||{}).escrow_sol||0));
      }
      return totalSol * SOL_TO_USD;
    }

    // Collapsible create coin
    function toggleCreateCoin(force){
      const wrap = $("createCoinWrap");
      const on = (typeof force === "boolean") ? force : !wrap.classList.contains("on");
      wrap.classList.toggle("on", on);
      $("createTri").textContent = on ? "▼" : "▶";
      $("createCoinHead").setAttribute("aria-expanded", on ? "true" : "false");
    }
    $("createCoinHead").addEventListener("click", () => toggleCreateCoin());

    // Create coin image (local preview)
    let newImgData = null;
    function setNewImgPreview(dataUrl){
      const prev = $("newImgPreview");
      prev.innerHTML = "";
      if(!dataUrl){
        prev.innerHTML = '<span class="muted">no image</span>';
        return;
      }
      const im = document.createElement("img");
      im.src = dataUrl;
      im.alt = "";
      prev.appendChild(im);
    }
    $("newImg").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if(!f){ newImgData = null; setNewImgPreview(null); return; }
      if(!String(f.type||"").startsWith("image/")){ alert("please choose an image file."); e.target.value=""; return; }
      // keep it lightweight (mock): cap at ~1.5MB
      if(f.size > 1500000){ alert("image too large (max ~1.5MB for mock)."); e.target.value=""; return; }
      const reader = new FileReader();
      reader.onload = () => { newImgData = String(reader.result||""); setNewImgPreview(newImgData); };
      reader.readAsDataURL(f);
    });

    // Connect wallet (mock)
function connectMock(){
  connectedWallet = "Fk2a9rQp8wYz3mN7vT5s1kC4dE6hJ9pL2qR8sX1zYb3A";
  walletPill.textContent = "wallet: " + shortWallet(connectedWallet);
  connectBtn.textContent = "disconnect";
  connectBtn.disabled = false;
  toast.classList.remove("on");

  if(!profile.wallet_first_seen_ms) profile.wallet_first_seen_ms = Date.now();

  if(!profile.namesByWallet[connectedWallet]) profile.namesByWallet[connectedWallet] = "big_hitter";
  if(profile.walletScoreByWallet[connectedWallet] == null) setScore(connectedWallet, 50);
  if(profile.verifiedGlobalByWallet[connectedWallet] == null) profile.verifiedGlobalByWallet[connectedWallet] = false;

  renderHome();
  if(activeRoomId) renderRoom(activeRoomId);
}

function disconnectMock(){
  connectedWallet = null;
  walletPill.textContent = "wallet: not connected";
  connectBtn.textContent = "connect";
  connectBtn.disabled = false;

  updateEarningsUI();
  renderHome();
  if(activeRoomId) renderRoom(activeRoomId);
  showToast("disconnected.");
}

connectBtn.addEventListener("click", () => { if(connectedWallet) disconnectMock(); else connectMock(); });
    $("toastConnect").addEventListener("click", connectMock);
    $("toastClose").addEventListener("click", () => toast.classList.remove("on"));
    homeBtn.addEventListener("click", () => setView("home"));
    // Modals
    function openModal(backEl){ backEl.classList.add("on"); }
    function closeModal(backEl){ backEl.classList.remove("on"); }
    function wireModal(backEl, closeBtn){
      closeBtn.addEventListener("click", () => closeModal(backEl));
      backEl.addEventListener("click", (e) => { if(e.target === backEl) closeModal(backEl); });
    }
    wireModal($("profileBack"), $("profileClose"));
    $("profileDisconnect").addEventListener("click", () => { closeModal($("profileBack")); disconnectMock(); });
    wireModal($("scoreBack"), $("scoreClose"));
    wireModal($("howBack"), $("howClose"));
    wireModal($("verifyBack"), $("verifyClose"));
    wireModal($("pingBack"), $("pingClose"));
    wireModal($("unpingBack"), $("unpingClose"));
    wireModal($("shareBack"), $("shareClose"));

    // Profile modal
    function openProfile(){
      // allow opening even when disconnected (read-only)
      $("profileWalletLine").textContent = connectedWallet ? connectedWallet : "not connected";
      if(connectedWallet){
        const ageMs = Date.now() - (profile.wallet_first_seen_ms || Date.now());
        const days = Math.floor(ageMs / (1000*60*60*24));
        $("profileAgeLine").textContent = "wallet age on pingy: " + days + " day" + (days===1? "" : "s");
      } else {
        $("profileAgeLine").textContent = "connect a wallet to set identity + score";
      }

      $("profileUsername").value = connectedWallet ? (profile.myUsername || "") : "";
      $("profileUsername").disabled = !connectedWallet;
      $("profileSave").disabled = !connectedWallet;

      // disconnect button visibility
      $("profileDisconnect").style.display = connectedWallet ? "inline-block" : "none";

      openModal($("profileBack"));
    }
    walletPill.addEventListener("click", openProfile);

    function saveUsername(){
      if(!connectedWallet) return showToast("connect wallet first.");
      const raw = ($("profileUsername").value || "").trim();
      const ok = /^[a-zA-Z0-9 _-]{0,20}$/.test(raw);
      if(!ok) return alert("username: letters/numbers/spaces/_/- (max 20).");
      profile.namesByWallet[connectedWallet] = raw;
      $("profileHint").textContent = raw ? `saved: ${raw}` : "cleared. showing wallet instead.";
      if(activeRoomId) renderRoom(activeRoomId);
    }
    $("profileSave").addEventListener("click", saveUsername);
    $("profileUsername").addEventListener("keydown", (e) => {
      if(e.key === "Enter"){ e.preventDefault(); saveUsername(); }
    });

    // Wallet score modal
    function ensureVouchState(roomId){
      profile.vouchesLeftByRoom[roomId] = profile.vouchesLeftByRoom[roomId] || {};
      profile.hasVouched[roomId] = profile.hasVouched[roomId] || {};
      profile.vouchCountedByRoom[roomId] = profile.vouchCountedByRoom[roomId] || {};

      if(connectedWallet){
        if(profile.vouchesLeftByRoom[roomId][connectedWallet] == null){
          profile.vouchesLeftByRoom[roomId][connectedWallet] = VOUCHES_PER_THREAD;
        }
        profile.hasVouched[roomId][connectedWallet] = profile.hasVouched[roomId][connectedWallet] || {};
      }
    }
    function getVouchesLeft(roomId, wallet){
      ensureVouchState(roomId);
      return Number((profile.vouchesLeftByRoom[roomId]||{})[wallet] ?? VOUCHES_PER_THREAD);
    }
    function getCountedVouches(roomId, targetWallet){
      ensureVouchState(roomId);
      return Number((profile.vouchCountedByRoom[roomId]||{})[targetWallet] ?? 0);
    }
    function getGivenVouchCount(roomId, wallet){
      ensureVouchState(roomId);
      const m = (profile.hasVouched[roomId]||{})[wallet] || {};
      return Object.keys(m).length;
    }

    function openScoreModal(){
      if(!connectedWallet) return showToast("connect wallet first.");
      $("scoreBig").textContent = "score " + getScore(connectedWallet);
      const rows = $("scoreRows");
      rows.innerHTML = "";

      const checks = [
        { label:"human verified (this coin)", ok: (activeRoomId && connectedWallet) ? isVerifiedInRoom(connectedWallet, activeRoomId) : false },
        { label:"wallet age", ok: true },
        { label:"pingy history", ok: getScore(connectedWallet) >= 55 },
        { label:"vouched by others", ok: (activeRoomId ? (getCountedVouches(activeRoomId, connectedWallet) > 0) : false) },
        { label:"vouches given", ok: (activeRoomId ? (getGivenVouchCount(activeRoomId, connectedWallet) > 0) : false) },
        { label:"clean activity", ok: true }
      ];

      checks.forEach(c => {
        const line = document.createElement("div");
        line.className = "row";
        line.style.justifyContent = "space-between";
        line.innerHTML = `
          <div>${escapeText(c.label)}</div>
          <div class="muted">${c.ok ? "✓" : "—"}</div>
        `;
        rows.appendChild(line);
      });

      openModal($("scoreBack"));
    }
    $("scorePill").addEventListener("click", openScoreModal);
    $("scoreInfo").addEventListener("click", openScoreModal);

    // How it works modal
    $("howWorksBtn").addEventListener("click", () => openModal($("howBack")));

    // Verify flow
    function openVerify(){
      if(!connectedWallet) return showToast("connect wallet first.");
      $("captchaCheck").checked = false;
      openModal($("verifyBack"));
    }
    $("verifyBtn").addEventListener("click", openVerify);

    function addSystemEvent(roomId, text){
      if(!roomId) return;
      state.chat[roomId] = state.chat[roomId] || [];
      state.chat[roomId].push({ ts: nowStamp(), wallet:"SYSTEM", text });
    }

    $("verifyConfirm").addEventListener("click", () => {
      if(!connectedWallet) return showToast("connect wallet first.");
      if(!activeRoomId) return;
      if(!$("captchaCheck").checked) return alert("complete the captcha.");
      profile.verifiedByRoom[activeRoomId] = profile.verifiedByRoom[activeRoomId] || {};
      const already = !!profile.verifiedByRoom[activeRoomId][connectedWallet];
      profile.verifiedByRoom[activeRoomId][connectedWallet] = true;
      // global reputation grows over time; per-coin verification affects lottery weight
      if(!already) bumpScore(connectedWallet, 8);
      profile.verifiedGlobalByWallet[connectedWallet] = true;
      closeModal($("verifyBack"));
      showToast("✅ verified");
      addSystemEvent(activeRoomId, `✅ @${displayName(connectedWallet)} verified`);
      renderRoom(activeRoomId);
    });

    // Human confidence weight per wallet (w ∈ [0,1])
    function humanWeight(roomId, wallet){
      const score = clamp01((getScore(wallet) || 0) / 100);
      const vouches = (getCountedVouches(roomId, wallet) || 0);

      let w = 0.35;

      // vouch boost (capped) — verified still best
      w = Math.max(w, Math.min(0.60 + 0.10 * vouches, 0.90));

      // score boost (small)
      w += score * 0.15;

      // verified dominates for this room
      if(isVerifiedInRoom(wallet, roomId)){
        w = Math.max(w, 0.95);
        return clamp01(w);
      }

      // non-verified hard cap
      w = Math.min(w, 0.95);
      return clamp01(w);
    }

    // Progress (certainty-gated funding)
    function walletUsdInRoom(r, wallet){
      const sol = Number((r.positions?.[wallet]?.escrow_sol) || 0);
      return Math.max(0, sol) * SOL_TO_USD;
    }

    function getEligibleParticipants(r){
      const pos = r.positions || {};
      return Object.keys(pos).filter(w => Math.max(0, Number((pos[w]||{}).spawn_tokens||0)) > 0 && humanWeight(r.id, w) >= GOOD_W_THRESHOLD);
    }

    function goodWalletCount(r){
      return getEligibleParticipants(r).length;
    }

    function spawnProgress01(r){
      // Spawn is driven by virtual tranche sold + quality of holders (no $ targets).
      const T_total = Math.max(0, Number(r.spawn_tokens_total || 0));
      if(T_total <= 0) return 0;

      // good tokens = tokens held by wallets whose humanWeight >= threshold
      let T_good = 0;
      const pos = r.positions || {};
      for(const w of Object.keys(pos)){
        const p = pos[w] || {};
        const t = Math.max(0, Number(p.spawn_tokens || 0));
        if(t <= 0) continue;
        if(humanWeight(r.id, w) >= GOOD_W_THRESHOLD) T_good += t;
      }

      const goodShare = (T_total > 0) ? (T_good / T_total) : 0;

      const p_tranche = T_total / SPAWN_TRANCHE_TOKENS;
      const p_good = goodShare / GOOD_TOKEN_FRACTION;
      const p_wallets = goodWalletCount(r) / MIN_GOOD_WALLETS;

      return clamp01(Math.min(p_tranche, p_good, p_wallets));
    }
    function bondingProgress01(r){
      const MC = Number(r.market_cap_usd || 0);
      return clamp01((MC - MC_SPAWN) / (MC_BONDED - MC_SPAWN));
    }

    function maybeAdvance(r){
      if(r.state === "SPAWNING"){
        if(spawnProgress01(r) >= 1 && goodWalletCount(r) >= MIN_GOOD_WALLETS){
          // Realize the virtual tranche: escrow becomes first buys on the real curve
          const pos = r.positions || {};
          for(const w of Object.keys(pos)){
            const p = ensurePos(r, w);
            const e = Math.max(0, Number(p.escrow_sol||0));
            if(e > 0){
              p.bond_sol = Number(p.bond_sol||0) + e;
              p.escrow_sol = 0;
            }
          }

          r.state = "BONDING";
          r.market_cap_usd = Math.max(Number(r.market_cap_usd || 0), MC_SPAWN);
          if(!r.token_address) r.token_address = mockTokenAddress(r.ticker || r.name || "PINGY");
          addSystemEvent(r.id, "token spawned. bonding started.");
        }
      }
      if(r.state === "BONDING"){
        if(bondingProgress01(r) >= 1){
          r.state = "BONDED";
          addSystemEvent(r.id, "bonded.");
        }
      }
    }
    function canVouch(roomId){
      return connectedWallet && isVerifiedInRoom(connectedWallet, roomId);
    }

    function tryVouch(roomId, targetWallet){
      if(!connectedWallet) return showToast("connect wallet first.");
      if(!canVouch(roomId)) return alert("verify human to vouch.");
      if(targetWallet === "SYSTEM") return;
      if(targetWallet === connectedWallet) return alert("cannot vouch for yourself.");

      ensureVouchState(roomId);

      const left = getVouchesLeft(roomId, connectedWallet);
      if(left <= 0) return alert("no vouches left in this thread.");

      const already = !!profile.hasVouched[roomId][connectedWallet][targetWallet];
      if(already) return alert("already vouched for this wallet.");

      const counted = getCountedVouches(roomId, targetWallet);
      const willCount = counted < MAX_COUNTED_VOUCHES_PER_RECIPIENT;

      profile.vouchesLeftByRoom[roomId][connectedWallet] = left - 1;
      profile.hasVouched[roomId][connectedWallet][targetWallet] = true;

      bumpScore(connectedWallet, 1);
      if(willCount){
        profile.vouchCountedByRoom[roomId][targetWallet] = counted + 1;
        bumpScore(targetWallet, 6);
      } else {
        bumpScore(targetWallet, 1);
      }

      addSystemEvent(roomId, `👍 @${displayName(connectedWallet)} vouched for @${displayName(targetWallet)}`);
      renderRoom(roomId);
    }

    // Card UI helpers (home cards unchanged)
    function mosaicHtml(room){
      if(room && room.image){
        return `<div class="mosaic img" aria-hidden="true"><img src="${room.image}" alt=""/></div>`;
      }
      return `<div class="mosaic" aria-hidden="true">` + Array.from({length:9}).map(()=>`<i></i>`).join("") + `</div>`;
    }

    function cardInner(r){
      maybeAdvance(r);

      if(r.state === "SPAWNING"){
        const p = spawnProgress01(r);
        const pct = Math.round(p * 100);
        return `
          <div class="cardGrid pre">
            ${mosaicHtml(r)}
            <div style="min-width:0;">
              <div class="row" style="justify-content:space-between;align-items:baseline;">
                <div class="name">${escapeText(r.name)} <span class="k">$${escapeText(r.ticker)}</span></div>
                <span class="k">SPAWNING</span>
              </div>
              <div class="tiny subline">${escapeText(r.desc || "prespawn chat open")}</div>
              <div class="bar"><i style="width:${pct}%"></i></div>
              <div class="barRow">
                <div class="tiny">prespawn chat open</div>
                <div class="pct">${pct}%</div>
              </div>
            </div>
          </div>
        `;
      }

      const mc = Number(r.market_cap_usd || 0);
      const p = (r.state === "BONDING") ? bondingProgress01(r) : 1;
      const pct = Math.round(p * 100);
      const chg = Number(r.change_pct || 0);
      const chgCls = chg > 0 ? "up" : (chg < 0 ? "down" : "");
      const chip = (r.state === "BONDING") ? "BONDING" : "BONDED";

      return `
        <div class="cardGrid">
          ${mosaicHtml(r)}
          <div style="min-width:0;">
            <div class="row" style="justify-content:space-between;align-items:baseline;">
              <div class="name">${escapeText(r.name)} <span class="k">$${escapeText(r.ticker)}</span></div>
              <span class="k">${chip}</span>
            </div>
            <div class="tiny subline">${escapeText(r.desc || "—")}</div>
            <div class="bar green"><i style="width:${pct}%"></i></div>
          </div>
          <div>
            <div class="metric">${fmtK(mc)}</div>
            <div class="chg ${chgCls}">${signArrow(chg)}</div>
          </div>
        </div>
      `;
    }

    function renderCard(r, where){
      const el = document.createElement("div");
      el.className = "card" + ((Date.now() < (r._pulseUntil||0)) ? " pulse" : "");
      el.innerHTML = `
        ${cardInner(r)}
        <div class="row" style="justify-content:flex-end; margin-top:10px;">
          <button class="btn subtle small" data-ping="${escapeText(r.id)}">ping</button>
          <button class="btn subtle small" data-open="${escapeText(r.id)}">open</button>
          <button class="btn subtle small" title="share" data-share="${escapeText(r.id)}">↗</button>
        </div>
      `;
      el.querySelector("[data-open]").addEventListener("click", () => openRoom(r.id));
      el.querySelector("[data-ping]").addEventListener("click", () => {
        openRoom(r.id);
        // defer to ensure the room view is active before opening modal
        setTimeout(() => openPingModal(r.id), 0);
      });
      el.querySelector("[data-share]").addEventListener("click", () => openShareModal(r.id));
      where.appendChild(el);
    }

    function renderExploreCard(r, where){
      const el = document.createElement("div");
      el.className = "card";
      el.style.maxWidth = "none";
      el.style.minWidth = "unset";
      el.innerHTML = `
        ${cardInner(r)}
        <div class="row" style="justify-content:flex-end; margin-top:10px;">
          <button class="btn subtle" data-ping="${escapeText(r.id)}">ping</button>
          <button class="btn subtle" data-open="${escapeText(r.id)}">open</button>
          <button class="btn subtle" title="share" data-share="${escapeText(r.id)}">↗</button>
        </div>
      `;
      el.querySelector("[data-open]").addEventListener("click", () => openRoom(r.id));
      el.querySelector("[data-ping]").addEventListener("click", () => {
        openRoom(r.id);
        setTimeout(() => openPingModal(r.id), 0);
      });
      el.querySelector("[data-share]").addEventListener("click", () => openShareModal(r.id));
      where.appendChild(el);
    }

    function matchesSearch(r, q){
      if(!q) return true;
      const s = q.toLowerCase();
      return r.name.toLowerCase().includes(s) || r.ticker.toLowerCase().includes(s) || (r.desc||"").toLowerCase().includes(s);
    }
    function roomRankKey(r){
      const m = { "SPAWNING":0, "BONDING":1, "BONDED":2 };
      return m[r.state] ?? 9;
    }
    function pctForRoom(r){
      return (r.state === "SPAWNING") ? spawnProgress01(r) :
             (r.state === "BONDING") ? bondingProgress01(r) : 1;
    }

    let exploreQuery = "";
    let exploreHasSearched = false;

    function runExploreSearch(){
      exploreQuery = ($("searchInput").value || "").trim();
      exploreHasSearched = true;
      renderHome();
    }

    function renderHome(){
      const cardsRow = $("cardsRow");
      const exploreList = $("exploreList");
      cardsRow.innerHTML = "";
      exploreList.innerHTML = "";

      // LIVE: never filtered by explore search
      const liveRooms = state.rooms
        .slice()
        .sort((a,b) => {
          const la = Number(a._lastActivity||0), lb = Number(b._lastActivity||0);
          if(lb !== la) return lb - la; // most recent activity first
          const sa = roomRankKey(a), sb = roomRankKey(b);
          if(sa !== sb) return sa - sb;
          return pctForRoom(b) - pctForRoom(a);
        })
        .slice(0,9);

      liveRooms.forEach(r => renderCard(r, cardsRow));

      // EXPLORE: show nothing until a search is submitted
      if(!exploreHasSearched || !exploreQuery){
        const d = document.createElement("div");
        d.className = "muted";
        d.textContent = "search to explore";
        exploreList.appendChild(d);
        return;
      }

      const results = state.rooms
        .filter(r => matchesSearch(r, exploreQuery))
        .slice()
        .sort((a,b) => {
          const sa = roomRankKey(a), sb = roomRankKey(b);
          if(sa !== sb) return sa - sb;
          return pctForRoom(b) - pctForRoom(a);
        });

      if(results.length === 0){
        const d = document.createElement("div");
        d.className = "muted";
        d.textContent = "no results.";
        exploreList.appendChild(d);
        return;
      }

      results.forEach(r => renderExploreCard(r, exploreList));
    }

    $("searchBtn").addEventListener("click", runExploreSearch);
    $("searchInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter"){ e.preventDefault(); runExploreSearch(); }
    });

    function createCoinFromForm(){
      if(!connectedWallet) return showToast("connect wallet first.");
      const name = ($("newName").value||"").trim();
      const ticker = ($("newTicker").value||"").trim().toUpperCase();
      const desc = ($("newDesc").value||"").trim();
      const xRaw = ($("newX").value||"").trim();
      const tgRaw = ($("newTg").value||"").trim();
      const webRaw = ($("newWeb").value||"").trim();

      const xUrl = normalizeUrl(xRaw, "x");
      const tgUrl = normalizeUrl(tgRaw, "tg");
      const webUrl = normalizeUrl(webRaw, "web");

      if(xRaw && !xUrl) return alert("x/twitter must be a valid http(s) link (or @handle). ");
      if(tgRaw && !tgUrl) return alert("telegram must be a valid http(s) link (ex: https://t.me/...).");
      if(webRaw && !webUrl) return alert("website must be a valid http(s) link.");

      const commitStr = ($("newCommit").value||"").trim();
      const commit = commitStr ? Number(commitStr) : 0;

      if(!name) return alert("name required.");
      if(!ticker) return alert("ticker required.");
      const TICKER_RE = /^[A-Z0-9]{1,10}$/;
      if(!TICKER_RE.test(ticker)) return alert("ticker must be 1–10 chars, A–Z and 0–9 only (no spaces).");
      if(commitStr && (Number.isNaN(commit) || commit <= 0)) return alert("commit must be a valid SOL amount.");

      const id = "r" + Math.random().toString(16).slice(2,6);
      const r = mkRoom(id, name, ticker, desc);
      r.creator_wallet = connectedWallet;
      r.socials = { x: xUrl, tg: tgUrl, web: webUrl };
      if(newImgData) r.image = newImgData;
      state.rooms.unshift(r);
      state.chat[id] = [{ ts:"—", wallet:"SYSTEM", text:"coin created. waiting for spawn." }];

      if(commit > 0){
        applySpawnCommit(r, connectedWallet, commit);
        state.chat[id].push({ ts: nowStamp(), wallet: connectedWallet, text:`pinged ${commit.toFixed(3)} SOL (escrow).` });
      }

      $("newName").value = "";
      $("newTicker").value = "";
      $("newDesc").value = "";
      $("newX").value = "";
      $("newTg").value = "";
      $("newWeb").value = "";
      $("newCommit").value = "";
      $("newImg").value = "";
      newImgData = null;
      setNewImgPreview(null);

      toggleCreateCoin(false);
      renderHome();
      openRoom(id);
    }
    $("createCoinBtn").addEventListener("click", createCoinFromForm);

    // NOTE: v22 UI removed "newRoomBtn" on explore; keep handler optional
    const newRoomBtn = $("newRoomBtn");
    if(newRoomBtn){
      newRoomBtn.addEventListener("click", () => {
        if(!connectedWallet) return showToast("connect wallet first.");
        toggleCreateCoin(true);
        $("newName").focus();
      });
    }

    // Room view
    function openRoom(roomId){
      activeRoomId = roomId;
      setView("room");
      renderRoom(roomId);

      const h = "room=" + encodeURIComponent(roomId);
      if(location.hash.replace("#","") !== h) history.replaceState(null,"","#"+h);
    }

    function shareLink(roomId){
      const base = location.origin + location.pathname;
      return base + "#room=" + encodeURIComponent(roomId);
    }
    function openShareModal(roomId){
      $("shareOut").value = shareLink(roomId);
      openModal($("shareBack"));
    }
    $("shareCopy").addEventListener("click", () => copyToClipboard($("shareOut").value||""));

    function renderChat(roomId){
      const box = $("chatBox");
      box.innerHTML = "";
      const msgs = state.chat[roomId] || [];

      msgs.forEach((m) => {
        const row = document.createElement("div");
        row.className = "msg";

        const isSys = (m.wallet === "SYSTEM");
        const nm = isSys ? "system" : displayName(m.wallet);
        const verifiedMark = (!isSys && isVerifiedInRoom(m.wallet, roomId)) ? " ✔" : "";
        const nameHtml = isSys ? `<strong>${escapeText(nm)}</strong>` : escapeText(nm) + verifiedMark;

        const vouchable = (!isSys && canVouch(roomId) && m.wallet !== connectedWallet);
        const already = connectedWallet && profile.hasVouched[roomId]?.[connectedWallet]?.[m.wallet];
        const vouchDisabled = !vouchable || !!already || (connectedWallet ? (getVouchesLeft(roomId, connectedWallet) <= 0) : true);

        row.innerHTML = `
          <div class="who">
            <div class="whoTop">
              <button class="copyBtn" title="copy wallet">⧉</button>
              <span class="whoName">${nameHtml}</span>
              ${(!isSys && canVouch(roomId)) ? `<button class="vouchBtn" ${vouchDisabled ? "disabled" : ""} title="vouch">vouch</button>` : ``}
            </div>
          </div>
          <div class="text ${isSys ? "sysLine" : ""}">${escapeText(m.text)}</div>
          <div class="ts">${escapeText(m.ts)}</div>
        `;

        row.querySelector(".copyBtn").addEventListener("click", () => copyToClipboard(m.wallet));
        const vb = row.querySelector(".vouchBtn");
        if(vb){
          vb.addEventListener("click", () => tryVouch(roomId, m.wallet));
        }

        box.appendChild(row);
      });

      box.scrollTop = box.scrollHeight;
    }

    function canPost(r){
      if(!connectedWallet) return false;
      // must verify (captcha) per coin to chat
      if(!isVerifiedInRoom(connectedWallet, r.id)) return false;

      if(r.state === "SPAWNING") return myEscrow(r.id) > 0;
      return myBond(r.id) > 0;
    }

    function setComposerState(r){
      const verified = !!(connectedWallet && isVerifiedInRoom(connectedWallet, r.id));
      const hasPos = !!(connectedWallet && ((r.state === "SPAWNING") ? (myEscrow(r.id) > 0) : (myBond(r.id) > 0)));
      const enabled = verified && hasPos;

      $("msgInput").disabled = !enabled;
      $("sendBtn").disabled = !enabled;

      if(enabled){
        $("msgInput").placeholder = "message (plain text only)";
      } else if(!verified){
        $("msgInput").placeholder = "verify human to chat";
      } else {
        $("msgInput").placeholder = "ping to chat";
      }
    }

    function updateBoostUI(r){
      $("boostStateChip").textContent =
        (r.state === "SPAWNING") ? "SPAWNING" :
        (r.state === "BONDING") ? "BONDING" : "BONDED";

      const vb = $("verifyBtn");
      const badge = $("verifiedBadge");
      if(connectedWallet && activeRoomId && isVerifiedInRoom(connectedWallet, activeRoomId)){
        vb.style.display = "none";
        badge.style.display = "inline-block";
      } else {
        vb.style.display = "inline-block";
        badge.style.display = "none";
      }

      $("poolLockLine").style.display = "none";
    }

    function renderRoom(roomId){
      const r = roomById(roomId);
      if(!r) return;

      maybeAdvance(r);
      ensureVouchState(roomId);

      $("roomTitle").textContent = r.name + "  $" + r.ticker;
      $("roomMeta").textContent = `creator: ${shortWallet(r.creator_wallet)} • created: ${r.created_at}`;

      // coin info panel
      $("roomDescOut").textContent = r.desc ? r.desc : "—";
      const sWrap = $("roomSocialsOut");
      sWrap.innerHTML = "";
      const addLink = (label, url) => {
        if(!url) return;
        const a = document.createElement("a");
        a.className = "linkBtn";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = label;
        sWrap.appendChild(a);
      };
      addLink("x", r.socials?.x || "");
      addLink("tg", r.socials?.tg || "");
      addLink("web", r.socials?.web || "");
      if(sWrap.children.length === 0){
        const d = document.createElement("div");
        d.className = "muted";
        d.textContent = "no socials";
        sWrap.appendChild(d);
      }

      $("shareBtn").onclick = () => openShareModal(roomId);

      // room image (if provided)
      const imgEl = $("roomImg");
      if(imgEl){
        if(r.image){
          imgEl.innerHTML = `<img src="${r.image}" alt="" />`;
          imgEl.classList.add("img");
        } else {
          imgEl.innerHTML = `<span class="muted" style="display:block;padding:10px 6px;">—</span>`;
        }
      }

      // market + chart (only post-spawn)
      const marketPanel = $("marketPanel");
      if(marketPanel){
        const postSpawn = (r.state === "BONDING" || r.state === "BONDED");
        marketPanel.style.display = postSpawn ? "block" : "none";
        if(postSpawn){
          const mc = Number(r.market_cap_usd || 0);
          $("marketCapBig").textContent = fmtUsd(mc);
          const chg = Number(r.change_pct || 0);
          const arrow = signArrow(chg);
          $("marketChange").innerHTML = `<span class="${chg>0?'up':(chg<0?'down':'')}">${arrow}</span>`;
          $("tokenAddrPill").textContent = r.token_address || "—";
          $("copyTokenBtn").onclick = () => copyToClipboard(r.token_address || "");
          renderSparkline(r);
        }
      }


      const phaseLabel = $("phaseLabel");
      const statePill = $("statePill");
      const phaseBar = $("phaseBar");

      if(r.state === "SPAWNING"){
        phaseLabel.textContent = "SPAWNING";
        statePill.textContent = "SPAWNING";
        phaseBar.style.width = Math.round(spawnProgress01(r)*100) + "%";
      } else if(r.state === "BONDING"){
        phaseLabel.textContent = "BONDING";
        statePill.textContent = "BONDING";
        phaseBar.style.width = Math.round(bondingProgress01(r)*100) + "%";
      } else {
        phaseLabel.textContent = "BONDED";
        statePill.textContent = "BONDED";
        phaseBar.style.width = "100%";
      }

      const score = connectedWallet ? getScore(connectedWallet) : 0;
      $("scorePill").textContent = "wallet score: " + (connectedWallet ? score : "—");
      $("vouchesLine").textContent = connectedWallet ? ("vouches left: " + getVouchesLeft(roomId, connectedWallet)) : "vouches left: —";

      updateBoostUI(r);

      const me =
        (r.state === "SPAWNING")
          ? `you: ${myEscrow(roomId).toFixed(3)} SOL escrow`
          : `you: ${myBond(roomId).toFixed(3)} SOL position`;
      $("meLine").textContent = connectedWallet ? me : "connect wallet";

      $("pingBtn").disabled = !connectedWallet;
      $("unpingBtn").disabled = !connectedWallet;

      setComposerState(r);
      renderChat(roomId);
    }

    // Ping / Unping flow
    // Use an explicit room id for modals so home-card clicks can't race view changes.
    let modalRoomId = null;
    function openPingModal(roomId){
      if(!connectedWallet) return showToast("connect wallet first.");
      const rid = roomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      modalRoomId = rid;
      $("pingAmount").value = "";
      $("pingRoomLine").textContent = `coin: ${r.name}  $${r.ticker}`;
      openModal($("pingBack"));
    }
    function openUnpingModal(roomId){
      if(!connectedWallet) return showToast("connect wallet first.");
      const rid = roomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      modalRoomId = rid;
      $("unpingAmount").value = "";
      $("unpingRoomLine").textContent = `coin: ${r.name}  $${r.ticker}`;
      openModal($("unpingBack"));
    }
    $("pingBtn").addEventListener("click", () => openPingModal(activeRoomId));
    $("unpingBtn").addEventListener("click", () => openUnpingModal(activeRoomId));

    function nudgeChange(r, delta){
      r.change_pct = Number(r.change_pct || 0) + delta;
      r.change_pct = Math.max(-99, Math.min(999, r.change_pct));
    }

    $("pingConfirm").addEventListener("click", () => {
      const rid = modalRoomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      const s = ($("pingAmount").value||"").trim();
      const sol = Number(s);
      if(!s || Number.isNaN(sol) || sol <= 0) return alert("enter a valid SOL amount.");

      if(r.state === "SPAWNING"){
        const tOut = applySpawnCommit(r, connectedWallet, sol);

        if(rid && isVerifiedInRoom(connectedWallet, rid)) bumpScore(connectedWallet, 1);

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`pinged ${sol.toFixed(3)} SOL (escrow).` });

        maybeAdvance(r);

      } else if(r.state === "BONDING") {
        r.positions[connectedWallet] = r.positions[connectedWallet] || {escrow_sol:0, bond_sol:0, spawn_tokens:0};
        r.positions[connectedWallet].bond_sol = Number(r.positions[connectedWallet].bond_sol||0) + sol;

        const add = Math.round(sol * SOL_TO_USD * 12);
        r.market_cap_usd = Number(r.market_cap_usd||0) + add;
        nudgeChange(r, Math.random()*3);

        maybeAdvance(r);

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`bought ${sol.toFixed(3)} SOL on curve.` });
      }

      closeModal($("pingBack"));
      renderRoom(rid);
      r._pulseUntil = Date.now() + 900;
      r._lastActivity = Date.now();
      renderHome();
    });

    $("unpingConfirm").addEventListener("click", () => {
      const rid = modalRoomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      const s = ($("unpingAmount").value||"").trim();
      const sol = Number(s);
      if(!s || Number.isNaN(sol) || sol <= 0) return alert("enter a valid SOL amount.");

      if(r.state === "SPAWNING"){
        const cur = myEscrow(rid);
        if(cur <= 0) return alert("you have no escrow to unping.");
        if(sol > cur) return alert("cannot unping more than your escrow.");

        applySpawnUncommit(r, connectedWallet, sol);

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`unpinged ${sol.toFixed(3)} SOL (escrow).` });

      } else if(r.state === "BONDING"){
        const cur = myBond(rid);
        if(cur <= 0) return alert("you have no position to sell.");
        if(sol > cur) return alert("cannot sell more than your position.");

        r.positions[connectedWallet].bond_sol = cur - sol;
        const sub = Math.round(sol * SOL_TO_USD * 9);
        r.market_cap_usd = Math.max(0, Number(r.market_cap_usd||0) - sub);
        nudgeChange(r, -(Math.random()*3));

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`sold ${sol.toFixed(3)} SOL on curve.` });
      }

      closeModal($("unpingBack"));
      renderRoom(rid);
      r._pulseUntil = Date.now() + 900;
      r._lastActivity = Date.now();
      renderHome();
    });

    // send chat
    $("sendBtn").addEventListener("click", () => {
      if(!connectedWallet) return showToast("connect wallet first.");
      if(!activeRoomId) return;
      const r = roomById(activeRoomId);
      if(!canPost(r)) return alert("ping to post.");

      const txt = ($("msgInput").value || "").trim();
      if(!txt) return;

      state.chat[activeRoomId] = state.chat[activeRoomId] || [];
      state.chat[activeRoomId].push({ ts: nowStamp(), wallet: connectedWallet, text: txt });
      $("msgInput").value = "";
      renderChat(activeRoomId);
    });
    $("msgInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter" && !e.shiftKey){
        e.preventDefault();
        $("sendBtn").click();
      }
    });

    // Hash routing
    function handleHash(){
      const h = (location.hash || "").replace("#","");
      if(!h) return;
      const params = new URLSearchParams(h);
      const rid = params.get("room");
      if(rid){
        const r = roomById(rid);
        if(r){
          if(!connectedWallet){
            showToast("connect wallet first.");
          } else {
            openRoom(rid);
          }
        }
      }
    }
    window.addEventListener("hashchange", handleHash);

    // Init + ticker
    function tick(){
      renderHome();
      if(activeRoomId) renderRoom(activeRoomId);
    }

    setView("home");
    renderHome();
    handleHash();
    setInterval(tick, 900);
