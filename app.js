const $ = (id) => document.getElementById(id);

    // Tuned assumptions
    const SOL_TO_USD = 100; // internal conversion (mock) — for display only

    // Single-curve: virtual tranche before spawn, realized on spawn
    const TOTAL_SUPPLY = 1_000_000_000;
    const SPAWN_PERCENT = 0.10;
    const SPAWN_TRANCHE_TOKENS = TOTAL_SUPPLY * SPAWN_PERCENT; // first 10% of supply

    // Per-wallet cap at spawn: ≤0.5% of total supply (i.e., ≤5% of the spawn tranche)
    const MAX_WALLET_PCT_TOTAL = 0.005;
    const MAX_TOKENS_PER_WALLET = TOTAL_SUPPLY * MAX_WALLET_PCT_TOTAL; // 5,000,000


    // Virtual spawn curve (SOL per token) — linear, increasing with tranche sold (mock)
    const VPRICE_P0 = 2e-7;   // starting price (SOL per token)
    const VPRICE_P1 = 8e-7;   // additional price by end of tranche
    const VPRICE_T = SPAWN_TRANCHE_TOKENS;

    const MC_SPAWN = 6600;
    const MC_BONDED = 66000;


    const homeView = $("homeView");
    const roomView = $("roomView");
    const profileView = $("profileView");
    const homeBtn = $("homeBtn");

    const walletPill = $("walletPill");
    const walletMenu = $("walletMenu");
    const walletDropdown = $("walletDropdown");
    const walletProfileItem = $("walletProfileItem");
    const walletViewWalletItem = $("walletViewWalletItem");
    const walletCopyItem = $("walletCopyItem");
    const walletDisconnectItem = $("walletDisconnectItem");
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
      const isRoom = (which === "room");
      const isProfile = (which === "profile");
      homeView.classList.toggle("on", isHome);
      roomView.classList.toggle("on", isRoom);
      profileView.classList.toggle("on", isProfile);
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

    // Deterministic mock: SOL cost to buy first 10% of supply from the bonding curve.
    function spawnTargetSol(){
      return spawnCostSolForTokens(VPRICE_T);
    }

    function spawnCostSolForTokens(tokensIn){
      const T = Math.max(0, Number(VPRICE_T || 0));
      if(T <= 0) return 0;
      const N = Math.max(0, Math.min(T, Number(tokensIn || 0)));
      const a = Number(VPRICE_P0 || 0);
      const b = Number(VPRICE_P1 || 0);
      return (a * N) + ((b / (2 * T)) * N * N);
    }

    function walletCapSol(room){
      return spawnTargetSol(room) / 20;
    }

    function applySpawnCommit(r, wallet, solIn){
      const pos = ensurePos(r, wallet);
      const sol = Math.max(0, Number(solIn||0));
      if(sol <= 0) return 0;

      // escrow bucket (refundable pre-spawn)
      pos.escrow_sol = Number(pos.escrow_sol||0) + sol;
      return sol;
    }

    function applySpawnUncommit(r, wallet, solOut){
      const pos = ensurePos(r, wallet);
      const sol = Math.max(0, Number(solOut||0));
      const curSol = Math.max(0, Number(pos.escrow_sol||0));
      if(sol <= 0 || curSol <= 0) return 0;

      const take = Math.min(sol, curSol);
      pos.escrow_sol = curSol - take;
      return take;
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
      detailsByWallet: {},
      followsByWallet: {}
    };

    const PROFILE_STORAGE_KEY = "pingy_profile_v1";

    function saveProfileLocal(){
      try { localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile)); }
      catch(e){}
    }
    function loadProfileLocal(){
      try{
        const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
        if(!raw) return;
        const parsed = JSON.parse(raw);
        if(!parsed || typeof parsed !== "object") return;
        Object.assign(profile, parsed);
      } catch(e){}
      profile.namesByWallet = profile.namesByWallet || {};
      profile.detailsByWallet = profile.detailsByWallet || {};
      profile.followsByWallet = profile.followsByWallet || {};
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

    state.rooms.forEach((r) => {
      r.approval = r.approval || {};
      r.approverWallets = r.approverWallets || {};
      r.blockedWallets = r.blockedWallets || {};
      if(r.creator_wallet){
        r.approval[r.creator_wallet] = "approved";
        r.approverWallets[r.creator_wallet] = true;
      }
    });

    function mkRoom(id, name, ticker, desc){
      const creator_wallet = (Math.random().toString(16).slice(2,10) + '111111111111111111111111111111').slice(0,44);
      return {
        id, name, ticker, desc,
        creator_wallet,
        socials: { x:'', tg:'', web:'' },
        created_at: nowStamp(),
        state: "SPAWNING",          // SPAWNING | BONDING | BONDED
        spawn_tokens_total: 0,      // virtual tokens sold in the spawn tranche (pre-token)
        positions: {},              // wallet -> { escrow_sol, bond_sol, spawn_tokens }
        approval: { [creator_wallet]: "approved" },        // wallet => approved|pending|denied
        approverWallets: { [creator_wallet]: true },        // wallet => true
        blockedWallets: {},         // wallet => true
        market_cap_usd: 0,
        change_pct: (Math.random() * 10 - 5),
        token_address: null,
        image: null,
        series: null
      };
    }

    function roomById(id){ return state.rooms.find(r => r.id === id); }

    function getProfileDetails(wallet){
      profile.detailsByWallet = profile.detailsByWallet || {};
      const d = profile.detailsByWallet[wallet] || {};
      return {
        image: d.image || "",
        bio: d.bio || "",
        social: d.social || ""
      };
    }
    function setProfileDetails(wallet, next){
      if(!wallet) return;
      profile.detailsByWallet[wallet] = {
        image: String(next.image || ""),
        bio: String(next.bio || "").trim(),
        social: String(next.social || "").trim()
      };
      saveProfileLocal();
    }
    function getFollowingMap(wallet){
      profile.followsByWallet = profile.followsByWallet || {};
      profile.followsByWallet[wallet] = profile.followsByWallet[wallet] || {};
      return profile.followsByWallet[wallet];
    }
    function isFollowing(followerWallet, targetWallet){
      if(!followerWallet || !targetWallet) return false;
      return !!getFollowingMap(followerWallet)[targetWallet];
    }
    function followCount(wallet){
      return Object.keys(getFollowingMap(wallet)).length;
    }
    function followerCount(wallet){
      let n = 0;
      const all = profile.followsByWallet || {};
      Object.keys(all).forEach((f) => { if(all[f] && all[f][wallet]) n += 1; });
      return n;
    }
    function createdCoinsCount(wallet){
      return state.rooms.filter(r => r.creator_wallet === wallet).length;
    }

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


    function setWalletDropdown(on){
      const open = !!on && !!connectedWallet;
      walletDropdown.classList.toggle("on", open);
      walletDropdown.setAttribute("aria-hidden", open ? "false" : "true");
    }

    function updateHeaderWalletUI(){
      const connected = !!connectedWallet;
      walletMenu.style.display = connected ? "block" : "none";
      connectBtn.style.display = connected ? "none" : "inline-block";
      if(connected){
        walletPill.textContent = displayName(connectedWallet);
      } else {
        walletPill.textContent = "wallet";
      }
    }

    function closeWalletDropdown(){
      setWalletDropdown(false);
    }

    function navigateHash(path){
      const target = "#/" + path;
      if(location.hash !== target) location.hash = target;
    }

    loadProfileLocal();

    // Connect wallet (mock)
function connectMock(){
  closeWalletDropdown();
  connectedWallet = "Fk2a9rQp8wYz3mN7vT5s1kC4dE6hJ9pL2qR8sX1zYb3A";
  updateHeaderWalletUI();
  toast.classList.remove("on");

  if(!profile.wallet_first_seen_ms) profile.wallet_first_seen_ms = Date.now();

  if(!profile.namesByWallet[connectedWallet]) profile.namesByWallet[connectedWallet] = "big_hitter";
  saveProfileLocal();

  renderHome();
  if(activeRoomId) renderRoom(activeRoomId);
  if(profileView.classList.contains("on")) renderProfilePage();
}

function disconnectMock(){
  closeWalletDropdown();
  connectedWallet = null;
  updateHeaderWalletUI();

  updateEarningsUI();
  renderHome();
  if(activeRoomId) renderRoom(activeRoomId);
  if(profileView.classList.contains("on")) renderProfilePage();
  showToast("disconnected.");
}

connectBtn.addEventListener("click", connectMock);
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
    wireModal($("editProfileBack"), $("editProfileClose"));
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
        $("profileAgeLine").textContent = "connect a wallet to set identity";
      }

      $("profileUsername").value = connectedWallet ? (profile.myUsername || "") : "";
      $("profileUsername").disabled = !connectedWallet;
      $("profileSave").disabled = !connectedWallet;

      // disconnect button visibility
      $("profileDisconnect").style.display = connectedWallet ? "inline-block" : "none";

      openModal($("profileBack"));
    }
    walletPill.addEventListener("click", () => {
      if(!connectedWallet) return;
      const next = !walletDropdown.classList.contains("on");
      setWalletDropdown(next);
    });
    walletProfileItem.addEventListener("click", () => {
      closeWalletDropdown();
      navigateHash("profile");
    });
    walletViewWalletItem.addEventListener("click", () => {
      if(!connectedWallet) return;
      closeWalletDropdown();
      window.open(`https://solscan.io/account/${encodeURIComponent(connectedWallet)}`, "_blank", "noopener,noreferrer");
    });
    walletCopyItem.addEventListener("click", async () => {
      if(!connectedWallet) return;
      await copyToClipboard(connectedWallet);
      closeWalletDropdown();
      showToast("address copied.");
    });
    walletDisconnectItem.addEventListener("click", () => {
      if(!connectedWallet) return;
      disconnectMock();
    });
    document.addEventListener("click", (e) => {
      if(!walletMenu.contains(e.target)) closeWalletDropdown();
    });

    updateHeaderWalletUI();

    function saveUsername(){
      if(!connectedWallet) return showToast("connect wallet first.");
      const raw = ($("profileUsername").value || "").trim();
      const ok = /^[a-zA-Z0-9 _-]{0,20}$/.test(raw);
      if(!ok) return alert("username: letters/numbers/spaces/_/- (max 20).");
      profile.namesByWallet[connectedWallet] = raw;
      saveProfileLocal();
      $("profileHint").textContent = raw ? `saved: ${raw}` : "cleared. showing wallet instead.";
      updateHeaderWalletUI();
      if(activeRoomId) renderRoom(activeRoomId);
    }
    $("profileSave").addEventListener("click", saveUsername);
    $("profileUsername").addEventListener("keydown", (e) => {
      if(e.key === "Enter"){ e.preventDefault(); saveUsername(); }
    });

    function addSystemEvent(roomId, text){
      if(!roomId) return;
      state.chat[roomId] = state.chat[roomId] || [];
      state.chat[roomId].push({ ts: nowStamp(), wallet:"SYSTEM", text });
    }

    function walletUsdInRoom(r, wallet){
      const sol = Number((r.positions?.[wallet]?.escrow_sol) || 0);
      return Math.max(0, sol) * SOL_TO_USD;
    }

    function totalEscrowSol(r){
      let total = 0;
      const pos = r.positions || {};
      for(const w of Object.keys(pos)) total += Math.max(0, Number((pos[w]||{}).escrow_sol || 0));
      return total;
    }

    function isCreator(r, wallet){ return !!wallet && wallet === r.creator_wallet; }
    function isApproved(r, wallet){ return !!(wallet && r.approval && r.approval[wallet] === "approved"); }
    function isApprover(r, wallet){ return isCreator(r, wallet) || !!(wallet && r.approverWallets && r.approverWallets[wallet]); }
    function isDenied(r, wallet){ return !!(wallet && r.approval && r.approval[wallet] === "denied"); }
    function isPending(r, wallet){
      return !!(wallet && r.approval && r.approval[wallet] === "pending");
    }

    function approvedEscrowSol(r){
      let total = 0;
      const pos = r.positions || {};
      for(const w of Object.keys(pos)){
        if(!isApproved(r, w)) continue;
        total += Math.max(0, Number((pos[w]||{}).escrow_sol || 0));
      }
      return total;
    }

    function countedEscrowSol(r){
      let total = 0;
      const capSol = walletCapSol(r);
      const pos = r.positions || {};
      for(const w of Object.keys(pos)){
        if(!isApproved(r, w)) continue;
        const escrow = Math.max(0, Number((pos[w]||{}).escrow_sol || 0));
        total += Math.min(escrow, capSol);
      }
      return total;
    }

    function spawnProgress01(r){
      const target = spawnTargetSol();
      if(target <= 0) return 0;
      return clamp01(countedEscrowSol(r) / target);
    }
    function bondingProgress01(r){
      const MC = Number(r.market_cap_usd || 0);
      return clamp01((MC - MC_SPAWN) / (MC_BONDED - MC_SPAWN));
    }

    function maybeAdvance(r){
      if(r.state === "SPAWNING"){
        const total = countedEscrowSol(r);
        const target = spawnTargetSol();
        if(total >= target){
          const pos = r.positions || {};
          const capSol = walletCapSol(r);
          let remainingTokens = SPAWN_TRANCHE_TOKENS;

          for(const w of Object.keys(pos)){
            const p = ensurePos(r, w);
            p.spawn_tokens = 0;
          }

          let rounds = 0;
          let active = Object.keys(pos).filter(w => {
            if(!isApproved(r, w)) return false;
            const escrow = Math.max(0, Number((pos[w]||{}).escrow_sol || 0));
            return Math.min(escrow, capSol) > 0;
          });
          while(remainingTokens > 1e-6 && active.length > 0 && rounds < 6){
            let activeSol = 0;
            for(const w of active){
              const escrow = Math.max(0, Number((pos[w]||{}).escrow_sol || 0));
              activeSol += Math.min(escrow, capSol);
            }
            if(activeSol <= 0) break;

            const nextActive = [];
            for(const w of active){
              const p = ensurePos(r, w);
              const escrow = Math.max(0, Number(p.escrow_sol || 0));
              const wSol = Math.min(escrow, capSol);
              const roomShare = wSol / activeSol;
              const addTokens = remainingTokens * roomShare;
              const capRemain = Math.max(0, MAX_TOKENS_PER_WALLET - Number(p.spawn_tokens||0));
              const granted = Math.min(addTokens, capRemain);
              p.spawn_tokens = Number(p.spawn_tokens||0) + granted;
              remainingTokens -= granted;
              if(capRemain - granted > 1e-6) nextActive.push(w);
            }
            active = nextActive;
            rounds += 1;
          }

          let refundedPending = false;
          for(const w of Object.keys(pos)){
            const p = ensurePos(r, w);
            const e = Math.max(0, Number(p.escrow_sol||0));
            if(e <= 0) continue;
            if(isApproved(r, w)){
              const counted = Math.min(e, capSol);
              const excess = Math.max(0, e - counted);
              if(excess > 0) p.bond_sol = Number(p.bond_sol||0) + excess;
            } else {
              refundedPending = true;
            }
            p.escrow_sol = 0;
          }
          if(refundedPending) addSystemEvent(r.id, "spawn triggered — pending escrow refunded");
          r.spawn_tokens_total = SPAWN_TRANCHE_TOKENS - Math.max(0, remainingTokens);

          r.state = "BONDING";
          r.market_cap_usd = Math.max(Number(r.market_cap_usd || 0), MC_SPAWN);
          if(!r.token_address) r.token_address = mockTokenAddress(r.ticker || r.name || "PINGY");
          addSystemEvent(r.id, "spawn complete: token + curve created, first 10% bought, now bonding.");
        }
      }
      if(r.state === "BONDING"){
        if(bondingProgress01(r) >= 1){
          r.state = "BONDED";
          addSystemEvent(r.id, "bonded.");
        }
      }
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
                <div class="tiny">funding first 10% of curve</div>
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
      r.approval = { [connectedWallet]: "approved" };
      r.approverWallets = r.approverWallets || {};
      r.blockedWallets = r.blockedWallets || {};
      r.approverWallets[connectedWallet] = true;
      r.socials = { x: xUrl, tg: tgUrl, web: webUrl };
      if(newImgData) r.image = newImgData;
      state.rooms.unshift(r);
      state.chat[id] = [{ ts:"—", wallet:"SYSTEM", text:"coin created. waiting for spawn." }];

      if(commit > 0){
        applySpawnCommit(r, connectedWallet, commit);
        state.chat[id].push({ ts: nowStamp(), wallet: "SYSTEM", text:`@${shortWallet(connectedWallet)} pinged ${commit.toFixed(3)} SOL (approved)` });
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

    function profileRouteWallet(){
      const raw = (location.hash || "").replace(/^#\/?/, "");
      const parts = raw.split("/").filter(Boolean);
      if(parts[0] !== "profile") return null;
      const walletFromRoute = parts[1] ? decodeURIComponent(parts[1]) : "";
      return walletFromRoute || connectedWallet;
    }

    function renderProfileAvatar(wallet, dataUrl){
      const avatar = $("profileAvatar");
      avatar.innerHTML = "";
      if(dataUrl){
        const im = document.createElement("img");
        im.src = dataUrl;
        im.alt = "";
        avatar.appendChild(im);
        return;
      }
      avatar.textContent = shortWallet(wallet || "wallet").slice(0,1).toUpperCase();
    }

    function renderProfilePage(){
      const wallet = profileRouteWallet();
      if(!wallet){
        $("profileNameOut").textContent = "not connected";
        $("profileWalletOut").textContent = "connect wallet to view profile.";
        $("profileBioOut").textContent = "no bio yet.";
        $("profileSolscanLink").href = "https://solscan.io";
        $("profileSocialOut").style.display = "none";
        $("followersCountOut").textContent = "0";
        $("followingCountOut").textContent = "0";
        $("createdCountOut").textContent = "0";
        $("profileActionBtn").textContent = "edit profile";
        $("profileActionBtn").disabled = true;
        renderProfileAvatar("", "");
        return;
      }

      const details = getProfileDetails(wallet);
      $("profileNameOut").textContent = displayName(wallet);
      $("profileWalletOut").textContent = shortWallet(wallet);
      $("profileBioOut").textContent = details.bio || "no bio yet.";
      $("profileSolscanLink").href = `https://solscan.io/account/${encodeURIComponent(wallet)}`;
      if(details.social){
        const social = $("profileSocialOut");
        social.style.display = "inline-flex";
        social.href = details.social;
      } else {
        $("profileSocialOut").style.display = "none";
      }
      $("followersCountOut").textContent = String(followerCount(wallet));
      $("followingCountOut").textContent = String(followCount(wallet));
      $("createdCountOut").textContent = String(createdCoinsCount(wallet));
      renderProfileAvatar(wallet, details.image || "");

      const isSelf = !!connectedWallet && connectedWallet === wallet;
      const actionBtn = $("profileActionBtn");
      if(isSelf){
        actionBtn.textContent = "edit profile";
        actionBtn.disabled = false;
      } else {
        actionBtn.disabled = !connectedWallet;
        actionBtn.textContent = isFollowing(connectedWallet, wallet) ? "unfollow" : "follow";
      }
    }

    function openEditProfileModal(){
      if(!connectedWallet) return showToast("connect wallet first.");
      const details = getProfileDetails(connectedWallet);
      editProfileImageData = "";
      $("editProfileImage").value = "";
      $("editProfileName").value = profile.namesByWallet[connectedWallet] || "";
      $("editProfileBio").value = details.bio || "";
      $("editProfileSocial").value = details.social || "";

      const prev = $("editProfileImagePreview");
      prev.innerHTML = "";
      if(details.image){
        const im = document.createElement("img");
        im.src = details.image;
        im.alt = "";
        prev.appendChild(im);
      } else {
        prev.innerHTML = '<span class="muted">no image</span>';
      }

      openModal($("editProfileBack"));
    }

    let editProfileImageData = "";
    $("editProfileImage").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if(!f) return;
      if(!String(f.type||"").startsWith("image/")) return alert("please choose an image file.");
      if(f.size > 1500000) return alert("image too large (max ~1.5MB for mock).");
      const reader = new FileReader();
      reader.onload = () => {
        editProfileImageData = String(reader.result || "");
        const prev = $("editProfileImagePreview");
        prev.innerHTML = "";
        const im = document.createElement("img");
        im.src = editProfileImageData;
        im.alt = "";
        prev.appendChild(im);
      };
      reader.readAsDataURL(f);
    });

    $("editProfileSave").addEventListener("click", () => {
      if(!connectedWallet) return showToast("connect wallet first.");
      const rawName = ($("editProfileName").value || "").trim();
      if(rawName && !/^[a-zA-Z0-9 _-]{1,32}$/.test(rawName)) return alert("display name: letters/numbers/spaces/_/- (max 32).");
      profile.namesByWallet[connectedWallet] = rawName;
      const curDetails = getProfileDetails(connectedWallet);
      setProfileDetails(connectedWallet, {
        image: editProfileImageData || curDetails.image || "",
        bio: $("editProfileBio").value || "",
        social: normalizeUrl($("editProfileSocial").value || "", "web") || ""
      });
      saveProfileLocal();
      updateHeaderWalletUI();
      closeModal($("editProfileBack"));
      renderProfilePage();
      renderHome();
      if(activeRoomId) renderRoom(activeRoomId);
    });

    $("profileActionBtn").addEventListener("click", () => {
      const wallet = profileRouteWallet();
      if(!wallet) return;
      if(!connectedWallet) return showToast("connect wallet first.");

      if(wallet === connectedWallet){
        openEditProfileModal();
        return;
      }

      const map = getFollowingMap(connectedWallet);
      if(map[wallet]) delete map[wallet];
      else map[wallet] = true;
      saveProfileLocal();
      renderProfilePage();
    });

    // Room view
    function openRoom(roomId){
      activeRoomId = roomId;
      setView("room");
      renderRoom(roomId);

      const h = "#/room/" + encodeURIComponent(roomId);
      if(location.hash !== h) history.replaceState(null,"",h);
    }

    function shareLink(roomId){
      const base = location.origin + location.pathname;
      return base + "#/room/" + encodeURIComponent(roomId);
    }
    function openShareModal(roomId){
      $("shareOut").value = shareLink(roomId);
      openModal($("shareBack"));
    }
    $("shareCopy").addEventListener("click", () => copyToClipboard($("shareOut").value||""));
    let pingersOpen = false;
    const pingersToggle = $("pingersToggle");
    if(pingersToggle){
      pingersToggle.addEventListener("click", () => {
        pingersOpen = !pingersOpen;
        const tri = pingersOpen ? "▾" : "▸";
        pingersToggle.textContent = `pingers ${tri}`;
        const content = $("pingersContent");
        if(content) content.style.display = pingersOpen ? "block" : "none";
      });
    }

    function renderChat(roomId){
      const box = $("chatBox");
      box.innerHTML = "";
      const msgs = state.chat[roomId] || [];
      const r = roomById(roomId);

      msgs.forEach((m) => {
        const row = document.createElement("div");
        row.className = "msg";

        const isSys = (m.wallet === "SYSTEM");
        const nm = isSys ? "system" : displayName(m.wallet);
        const nameHtml = isSys ? `<strong>${escapeText(nm)}</strong>` : escapeText(nm);

        let extras = "";
        if(!isSys && r){
          const wallet = m.wallet;
          if(isApprover(r, wallet)) extras += `<span class="k">APPROVER</span>`;
          else if(isApproved(r, wallet)) extras += `<span class="k">PINGER</span>`;
          else if(isPending(r, wallet)) extras += `<span class="k">PENDING</span>`;

          if(connectedWallet && isApprover(r, connectedWallet) && isPending(r, wallet)){
            extras += ` <button class="btn subtle small" data-approve="${escapeText(wallet)}">approve</button>`;
            extras += ` <button class="btn subtle small" data-deny="${escapeText(wallet)}">deny</button>`;
          }
          if(connectedWallet && isCreator(r, connectedWallet) && isApproved(r, wallet) && !isCreator(r, wallet)){
            const isAp = !!(r.approverWallets && r.approverWallets[wallet]);
            extras += ` <button class="btn subtle small" data-toggle-approver="${escapeText(wallet)}">${isAp ? "remove approver" : "make approver"}</button>`;
          }
        }

        row.innerHTML = `
          <div class="who">
            <div class="whoTop">
              <button class="copyBtn" title="copy wallet">⧉</button>
              <span class="whoName">${nameHtml}</span>
              ${extras}
            </div>
          </div>
          <div class="text ${isSys ? "sysLine" : ""}">${escapeText(m.text)}</div>
          <div class="ts">${escapeText(m.ts)}</div>
        `;

        row.querySelector(".copyBtn").addEventListener("click", () => copyToClipboard(m.wallet));
        const approveBtn = row.querySelector("[data-approve]");
        const denyBtn = row.querySelector("[data-deny]");
        const toggleBtn = row.querySelector("[data-toggle-approver]");
        if(approveBtn) approveBtn.addEventListener("click", () => approveWallet(roomId, m.wallet));
        if(denyBtn) denyBtn.addEventListener("click", () => denyWallet(roomId, m.wallet));
        if(toggleBtn) toggleBtn.addEventListener("click", () => toggleApproverWallet(roomId, m.wallet));

        box.appendChild(row);
      });

      box.scrollTop = box.scrollHeight;
    }

    function canPost(r){
      if(!connectedWallet) return false;
      if(r && r.blockedWallets && r.blockedWallets[connectedWallet]) return false;
      return true;
    }

    function setComposerState(r){
      const enabled = !!connectedWallet;
      $("msgInput").disabled = !enabled;
      $("sendBtn").disabled = !enabled;
      $("msgInput").placeholder = enabled ? "message" : "connect wallet";
    }


    function approveWallet(roomId, wallet){
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isApprover(r, connectedWallet)) return;
      if(!isPending(r, wallet)) return;
      r.approval = r.approval || {};
      r.approval[wallet] = "approved";
      const escrow = Math.max(0, Number((r.positions?.[wallet]?.escrow_sol) || 0));
      const capSol = walletCapSol(r);
      if(escrow > capSol){
        addSystemEvent(roomId, `@${shortWallet(wallet)} approved — cap is ${capSol.toFixed(3)} SOL counted toward spawn (excess escrow not counted)`);
      } else {
        addSystemEvent(roomId, `@${shortWallet(wallet)} approved — now a PINGER`);
      }
      renderRoom(roomId);
      renderHome();
    }

    function denyWallet(roomId, wallet){
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isApprover(r, connectedWallet)) return;
      const p = ensurePos(r, wallet);
      p.escrow_sol = 0;
      r.approval = r.approval || {};
      r.blockedWallets = r.blockedWallets || {};
      r.approval[wallet] = "denied";
      r.blockedWallets[wallet] = true;
      addSystemEvent(roomId, `@${shortWallet(wallet)} denied — escrow refunded`);
      renderRoom(roomId);
      renderHome();
    }

    function toggleApproverWallet(roomId, wallet){
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isCreator(r, connectedWallet)) return;
      if(!isApproved(r, wallet)) return;
      r.approverWallets = r.approverWallets || {};
      if(r.approverWallets[wallet]){
        delete r.approverWallets[wallet];
        addSystemEvent(roomId, `@${shortWallet(wallet)} removed as approver`);
      } else {
        r.approverWallets[wallet] = true;
        addSystemEvent(roomId, `@${shortWallet(wallet)} is now an approver`);
      }
      renderRoom(roomId);
      renderHome();
    }

    function renderRoom(roomId){
      const r = roomById(roomId);
      if(!r) return;

      maybeAdvance(r);

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

      const pingers = Object.keys(r.approval || {}).filter((w) => isApproved(r, w));
      const approvers = Object.keys(r.approverWallets || {}).filter((w) => isApprover(r, w));
      const pingersList = $("pingersList");
      const approversList = $("approversList");
      if(pingersList){
        pingersList.innerHTML = "";
        if(pingers.length === 0){
          const e = document.createElement("span");
          e.className = "muted tiny";
          e.textContent = "none";
          pingersList.appendChild(e);
        } else {
          pingers.forEach((w) => {
            const tag = document.createElement("span");
            tag.className = "k";
            tag.textContent = shortWallet(w);
            pingersList.appendChild(tag);
          });
        }
      }
      if(approversList){
        approversList.innerHTML = "";
        if(approvers.length === 0){
          const e = document.createElement("span");
          e.className = "muted tiny";
          e.textContent = "none";
          approversList.appendChild(e);
        } else {
          approvers.forEach((w) => {
            const tag = document.createElement("span");
            tag.className = "k";
            tag.textContent = shortWallet(w);
            approversList.appendChild(tag);
          });
        }
      }

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
        phaseLabel.textContent = "Funding first 10% of curve";
        statePill.textContent = "SPAWNING";
        phaseBar.style.width = Math.round(spawnProgress01(r)*100) + "%";
        const counted = countedEscrowSol(r);
        const target = spawnTargetSol();
        const capSol = walletCapSol(r);
        const progressLine = $("spawnProgressLine");
        if(progressLine) progressLine.textContent = `approved counted: ${counted.toFixed(3)}/${target.toFixed(3)} SOL • cap per wallet: ${capSol.toFixed(3)} SOL`;
      } else if(r.state === "BONDING"){
        phaseLabel.textContent = "BONDING";
        statePill.textContent = "BONDING";
        phaseBar.style.width = Math.round(bondingProgress01(r)*100) + "%";
        const progressLine = $("spawnProgressLine");
        if(progressLine) progressLine.textContent = "";
      } else {
        phaseLabel.textContent = "BONDED";
        statePill.textContent = "BONDED";
        phaseBar.style.width = "100%";
        const progressLine = $("spawnProgressLine");
        if(progressLine) progressLine.textContent = "";
      }

      const me =
        (r.state === "SPAWNING")
          ? `you: ${myEscrow(roomId).toFixed(3)} SOL escrow`
          : `you: ${myBond(roomId).toFixed(3)} SOL position`;
      $("meLine").textContent = connectedWallet ? me : "connect wallet";

      $("pingBtn").disabled = !connectedWallet || !!(connectedWallet && r.blockedWallets && r.blockedWallets[connectedWallet]);
      $("unpingBtn").disabled = !connectedWallet || r.state !== "SPAWNING";

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
      if(r.state !== "SPAWNING") return alert("refunds are only available before spawn.");
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
        if(r.blockedWallets && r.blockedWallets[connectedWallet]) return alert("you were denied from this spawn.");
        if(!isCreator(r, connectedWallet)){
          r.approval = r.approval || {};
          if(!r.approval[connectedWallet]) r.approval[connectedWallet] = "pending";
        }
        applySpawnCommit(r, connectedWallet, sol);

        state.chat[r.id] = state.chat[r.id] || [];
        const statusText = isApproved(r, connectedWallet) ? "approved" : "pending approval";
        state.chat[r.id].push({ ts: nowStamp(), wallet: "SYSTEM", text:`@${shortWallet(connectedWallet)} pinged ${sol.toFixed(3)} SOL (${statusText})` });

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

      } else {
        return alert("refunds are disabled after spawn.");
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
      const h = (location.hash || "").replace(/^#/, "");
      if(!h){
        setView("home");
        return;
      }

      const clean = h.replace(/^\//, "");
      const parts = clean.split("/").filter(Boolean);

      if(parts[0] === "profile"){
        setView("profile");
        renderProfilePage();
        return;
      }

      if(parts[0] === "room" && parts[1]){
        const ridFromPath = decodeURIComponent(parts[1]);
        const r = roomById(ridFromPath);
        if(r){
          if(!connectedWallet) showToast("connect wallet first.");
          else openRoom(ridFromPath);
          return;
        }
      }

      const params = new URLSearchParams(clean);
      const rid = params.get("room");
      if(rid){
        const r = roomById(rid);
        if(r){
          if(!connectedWallet) showToast("connect wallet first.");
          else openRoom(rid);
          return;
        }
      }

      setView("home");
    }
    window.addEventListener("hashchange", handleHash);
    document.addEventListener("keydown", (e) => { if(e.key === "Escape") closeWalletDropdown(); });

    // Init + ticker
    function tick(){
      renderHome();
      updateHeaderWalletUI();
      if(activeRoomId) renderRoom(activeRoomId);
      if(profileView.classList.contains("on")) renderProfilePage();
    }

    setView("home");
    renderHome();
    handleHash();
    setInterval(tick, 900);
