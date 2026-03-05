import {
  SOLANA_CLUSTER,
  DEVNET_RPC,
  connection,
  PROGRAM_ID,
  deriveThreadPda,
  deriveSpawnPoolPda,
  deriveFeeVaultPda,
  deriveDepositPda,
  deriveThreadEscrowPda,
  deriveBanPda,
  fetchProgramAccounts,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "./lib/solana.js";

function surfaceFatalMessage(prefix, err){
  const message = String(err?.message || err || "unknown error");
  const full = `${prefix}: ${message}`;
  console.error(full, err);
  const toastEl = document.getElementById("toast");
  const toastTextEl = document.getElementById("toastText");
  if(toastEl && toastTextEl){
    toastTextEl.textContent = full;
    toastEl.classList.add("on");
    return;
  }
  alert(full);
}

window.addEventListener("error", (event) => {
  surfaceFatalMessage("[pingy] crash", event?.error || event?.message || event);
});

window.addEventListener("unhandledrejection", (event) => {
  surfaceFatalMessage("[pingy] unhandled rejection", event?.reason || event);
});

const $ = (id) => document.getElementById(id);

    // Exposed for devnet wiring checks from browser console.
    window.pingySolana = {
      SOLANA_CLUSTER,
      DEVNET_RPC,
      connection,
      PROGRAM_ID,
      deriveThreadPda,
      deriveSpawnPoolPda,
      deriveFeeVaultPda,
      deriveDepositPda,
      deriveThreadEscrowPda,
      deriveBanPda,
      fetchProgramAccounts,
    };

    console.log('[pingy] app.js loaded');
    console.log("[pingy] window.phantom?.solana:", window.phantom?.solana);
    console.log("[pingy] window.solana:", window.solana);
    console.log("[pingy] window.solana?.isPhantom:", window.solana?.isPhantom);
    console.log("[pingy] window.solana?.providers:", window.solana?.providers);

    // Tuned assumptions
    const SOL_TO_USD = 100; // internal conversion (mock) — for display only

    // Single-curve: virtual tranche before spawn, realized on spawn
    const TOTAL_SUPPLY = 1_000_000_000;
    const SPAWN_PERCENT = 0.10;
    const SPAWN_TRANCHE_TOKENS = TOTAL_SUPPLY * SPAWN_PERCENT; // first 10% of supply

    // Per-wallet cap at spawn: ≤0.5% of total supply (i.e., ≤5% of the spawn tranche)
    const MAX_WALLET_PCT_TOTAL = 0.005;
    const MAX_TOKENS_PER_WALLET = TOTAL_SUPPLY * MAX_WALLET_PCT_TOTAL; // 5,000,000


    const MC_SPAWN = 6600;
    const MC_BONDED = 66000;
    const SPAWN_FEE_BPS = 100;
    const POST_SPAWN_TRADING_FEE_BPS = 100;
    const BPS_DENOM = 10_000;


    let homeView;
    let roomView;
    let profileView;
    let legalView;
    let homeBtn;

    let walletPill;
    let walletMenu;
    let walletDropdown;
    let walletProfileItem;
    let walletViewWalletItem;
    let walletCopyItem;
    let walletDisconnectItem;
    let connectBtn;

    let activeProfileTab = "balances";

    let toast;
    let toastText;
    let toastTimer = null;
    let onchainBanner;
    let onchainBannerText;
    let onchainEnabled = true;
    const onchainReasons = [];
    let traceCounter = 0;

    function showToast(msg){
      if(!toast || !toastText) return alert(msg || "connect wallet first.");
      toastText.textContent = msg || "connect wallet first.";
      toast.classList.add("on");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("on"), 2400);
    }

    function traceStep(label, details, toastMsg){
      traceCounter += 1;
      const line = `[ping-trace ${String(traceCounter).padStart(3, "0")}] ${label}`;
      if(details !== undefined){
        console.log(line, details);
      } else {
        console.log(line);
      }
      if(toastMsg) showToast(toastMsg);
    }

    function updateOnchainBanner(){
      if(!onchainBanner || !onchainBannerText) return;
      const suffix = onchainReasons.length ? ` (${onchainReasons.join("; ")})` : "";
      onchainBannerText.textContent = `on-chain status: ${onchainEnabled ? "ENABLED" : "DISABLED"}${suffix}`;
      onchainBanner.style.borderColor = onchainEnabled ? "#204a2c" : "#5a2a2a";
    }

    function reportFatal(err){
      surfaceFatalMessage("[pingy] init failed", err);
    }

    function disableOnchainFeatures(reason){
      onchainEnabled = false;
      if(reason && !onchainReasons.includes(reason)) onchainReasons.push(reason);
      console.warn("[pingy] on-chain disabled:", reason);
      updateOnchainBanner();
      showToast(reason + " — using mock escrow");
      // DO NOT disable ping/unping confirm buttons.
    }

    function shouldUseOnchain(){
      const ok = !!onchainEnabled && !!connectedWallet;
      if(!ok){
        const reason = !onchainEnabled ? (onchainReasons[0] || "on-chain disabled") : "wallet not connected";
        traceStep("shouldUseOnchain=false", { onchainEnabled, connectedWallet: !!connectedWallet, reason });
      }
      return ok;
    }

    async function validateOnchainConfig(){
      traceStep("validateOnchainConfig:start", { programId: PROGRAM_ID.toBase58(), rpc: DEVNET_RPC });
      if(PROGRAM_ID.toBase58() === "11111111111111111111111111111111"){
        disableOnchainFeatures("On-chain disabled: PROGRAM_ID misconfigured");
        traceStep("validateOnchainConfig:failed", { reason: "default program id" }, "on-chain disabled: program id misconfigured");
        return;
      }
      try {
        const info = await connection.getAccountInfo(PROGRAM_ID, "confirmed");
        console.log("[pingy] program account:", info);
        if(!info || !info.executable){
          disableOnchainFeatures("On-chain disabled: PROGRAM_ID misconfigured");
          traceStep("validateOnchainConfig:failed", { reason: "program account not executable" }, "on-chain disabled: program account invalid");
          return;
        }
      } catch (err){
        console.error("[pingy] program account check failed", err);
        disableOnchainFeatures("On-chain disabled: PROGRAM_ID misconfigured");
        traceStep("validateOnchainConfig:failed", { reason: String(err?.message || err) }, "on-chain disabled: rpc program check failed");
        return;
      }
      onchainEnabled = true;
      traceStep("validateOnchainConfig:ok", { onchainEnabled: true });
      updateOnchainBanner();
    }

    function getErrorLogs(err){
      return [
        ...(Array.isArray(err?.logs) ? err.logs : []),
        ...(Array.isArray(err?.data?.logs) ? err.data.logs : []),
        ...(Array.isArray(err?.error?.logs) ? err.error.logs : []),
        ...(Array.isArray(err?.simLogs) ? err.simLogs : []),
        ...(Array.isArray(err?.txLogs) ? err.txLogs : []),
      ];
    }

    function extractProgramLogLine(err){
      const logs = getErrorLogs(err);
      const programLines = logs.filter((line) => /Program log:|Program .* failed|AnchorError/i.test(String(line || "")));
      return programLines.length ? String(programLines[programLines.length - 1]) : "";
    }

    function summarizeTxError(err){
      const message = String(err?.message || err || "transaction failed");
      const snippet = message.slice(0, 160);
      const logs = getErrorLogs(err);
      const combined = [message, ...logs].join(" ");
      const customMatch = combined.match(/custom program error:\s*0x[0-9a-f]+/i);
      const instructionMatch = combined.match(/InstructionError[^\n]*/i);
      if(customMatch) return `${snippet} (${customMatch[0]})`;
      if(instructionMatch) return `${snippet} (${instructionMatch[0]})`;
      return snippet;
    }

    function reportTxError(err, contextLabel){
      console.error(err);
      console.error(err?.message);
      const logs = getErrorLogs(err);
      console.error(logs);
      if(contextLabel) console.error(`[pingy] ${contextLabel}`);
      const lastProgramLine = extractProgramLogLine(err);
      const details = [String(err?.message || summarizeTxError(err)), lastProgramLine, ...logs].filter(Boolean).join(" | ").slice(0, 700);
      showToast(details);
    }

    function isWalletTxRejected(err){
      const code = Number(err?.code);
      if(code === 4001) return true;
      const msg = String(err?.message || err || "");
      return /reject|denied|declin/i.test(msg);
    }

    function shouldFallbackToSignTransaction(err){
      const msg = String(err?.message || err || "");
      return /not\s+implemented|not\s+supported|signAndSendTransaction\s+is\s+not\s+a\s+function/i.test(msg);
    }

    function isUserBannedError(err){
      const logs = getErrorLogs(err).join(" ");
      const msg = String(err?.message || err || "");
      const combined = `${msg} ${logs}`;
      return /UserBanned|User is banned from this thread/i.test(combined);
    }

    function explorerTxUrl(signature){
      return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
    }

    function explorerAddressUrl(address){
      return `https://explorer.solana.com/address/${address}?cluster=devnet`;
    }


    let moversIntervalId = null;

    function stopMoversSimulation(){
      if(moversIntervalId){
        clearInterval(moversIntervalId);
        moversIntervalId = null;
      }
    }

    function startMoversSimulation(){
      stopMoversSimulation();
      if(!state.movers.enabled) return;
      if(typeof simulateMovers !== "function") return;
      simulateMovers(state.rooms);
      moversIntervalId = setInterval(() => {
        if(!homeView?.classList.contains("on")) return;
        simulateMovers(state.rooms);
      }, state.movers.tickMs);
    }

    function setView(which){
      const isHome = (which === "home");
      const isRoom = (which === "room");
      const isProfile = (which === "profile");
      const isLegal = (which === "legal");
      homeView.classList.toggle("on", isHome);
      roomView.classList.toggle("on", isRoom);
      profileView.classList.toggle("on", isProfile);
      legalView.classList.toggle("on", isLegal);
      homeBtn.style.display = isHome ? "none" : "inline-block";
      if(isHome) startMoversSimulation();
      else stopMoversSimulation();
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

    const PRESETS = {
      fast: { key: "fast", label: "Fast", minWallets: 10, targetSol: 3, maxWalletShareBps: 1000 },
      balanced: { key: "balanced", label: "Balanced", minWallets: 20, targetSol: 5, maxWalletShareBps: 700 },
      high_quality: { key: "high_quality", label: "High Quality", minWallets: 30, targetSol: 8, maxWalletShareBps: 500 },
    };

    function selectedPreset(){
      const key = ($("newPreset")?.value || "fast").toLowerCase();
      return PRESETS[key] || PRESETS.balanced;
    }

    function updatePresetCapHint(){
      const hint = $("presetCapHint");
      if(!hint) return;
      const preset = selectedPreset();
      const targetSol = Number(preset.targetSol || 0);
      const capSol = targetSol * (Number(preset.maxWalletShareBps || 0) / 10000);
      hint.textContent = `Cap per wallet: ${capSol.toFixed(3)} SOL`;
    }

    function roomPreset(room){
      const r = room || {};
      const key = String(r.launch_preset || "fast").toLowerCase();
      const base = PRESETS[key] || PRESETS.balanced;
      return {
        ...base,
        minWallets: Number(r.min_approved_wallets || base.minWallets),
        targetSol: Number(r.spawn_target_sol || base.targetSol),
        maxWalletShareBps: Number(r.max_wallet_share_bps || base.maxWalletShareBps),
      };
    }

    function spawnTargetSol(room){
      const lamports = room?.onchain?.spawn_target_lamports;
      if (typeof lamports === "number") {
        return lamports / 1e9;
      }
      const fallback = Number(room?.spawn_target_sol || 0);
      return Number.isFinite(fallback) ? fallback : 0;
    }

    function minApprovedWalletsRequired(room){
      const roomMin = room?.min_approved_wallets;
      if(typeof roomMin === "number") return roomMin;
      const onchainMin = room?.onchain?.min_approved_wallets;
      if(typeof onchainMin === "number") return onchainMin;
      return Number(roomPreset(room).minWallets || 0);
    }

    function walletCapSol(room){
      const target = spawnTargetSol(room);
      const bps = room?.onchain?.max_wallet_share_bps;
      if (!target || !bps) return 0;
      return target * (bps / 10000);
    }

    function presetWalletCapLamports(presetKey){
      const preset = PRESETS[String(presetKey || "").toLowerCase()] || PRESETS.balanced;
      const targetLamports = Math.floor(Number(preset.targetSol || 0) * LAMPORTS_PER_SOL);
      const shareBps = Number(preset.maxWalletShareBps || 0);
      if(targetLamports <= 0 || shareBps <= 0) return 0;
      return Math.floor((targetLamports * shareBps) / BPS_DENOM);
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
    let walletListenersBound = false;

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
        mkRoom("r3","meme_lab","MEME","chaos, but organized"),
        mkRoom("r4","orbit_mint","ORBT","countdown to ignition"),
        mkRoom("r5","liquid_hype","HYPE","everyone is watching"),
        mkRoom("r6","night_shift","NITE","late hours, loud charts")
      ],
      chat: {
        r1: [{ ts:"—", wallet:"SYSTEM", text:"waiting for spawn." }],
        r2: [{ ts:"—", wallet:"SYSTEM", text:"keep it clean." }],
        r3: [{ ts:"—", wallet:"SYSTEM", text:"waiting for spawn." }]
      },
      onchain: {},
      onchainMeta: {},
      walletBalances: {},
      walletBalancesMeta: {},
      userEscrow: null,
      walletPubkey: null,
      maxPingLamports: 0,
      movers: { enabled: true, tickMs: 3000, active: new Set(), scores: {}, shimmyId: null, shimmyUntil: 0 }
    };

    const ONCHAIN_REFRESH_MS = 7000;
    const WALLET_BAL_REFRESH_MS = 6000;
    const LAMPORTS_PER_SOL = 1_000_000_000;
    const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");


    function readU32LE(bytes, offset){
      const v = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
      return [v, offset + 4];
    }

    function readString(bytes, offset){
      const [len, next] = readU32LE(bytes, offset);
      const end = next + len;
      const val = new TextDecoder().decode(bytes.slice(next, end));
      return [val, end];
    }

    function readPubkey(bytes, offset){
      const keyBytes = bytes.slice(offset, offset + 32);
      return [new PublicKey(keyBytes), offset + 32];
    }

    function toBase58String(value){
      if(!value) return "";
      if(typeof value === "string"){
        try { return new PublicKey(value).toBase58(); }
        catch(_e){ return ""; }
      }
      if(value?.toBase58) return value.toBase58();
      try { return new PublicKey(value).toBase58(); }
      catch(_e){ return ""; }
    }

    function encodeStringArg(v){
      const strBytes = new TextEncoder().encode(String(v || ""));
      const out = new Uint8Array(4 + strBytes.length);
      new DataView(out.buffer).setUint32(0, strBytes.length, true);
      out.set(strBytes, 4);
      return out;
    }

    function encodeU32Arg(v){
      const out = new Uint8Array(4);
      new DataView(out.buffer).setUint32(0, Number(v || 0), true);
      return out;
    }

    function encodeU16Arg(v){
      const out = new Uint8Array(2);
      new DataView(out.buffer).setUint16(0, Number(v || 0), true);
      return out;
    }

    function encodeU64Arg(v){
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigUint64(0, BigInt(v || 0), true);
      return out;
    }

    function concatBytes(...parts){
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      parts.forEach((p) => {
        out.set(p, o);
        o += p.length;
      });
      return out;
    }


    async function anchorDiscriminator(name){
      const preimage = `global:${name}`;
      const bytes = new TextEncoder().encode(preimage);
      const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
      return new Uint8Array(hashBuf).slice(0, 8);
    }

    function getProvider(){
      if(typeof window === "undefined") return null;
      const p1 = window.phantom?.solana;
      if(p1?.isPhantom) return p1;

      const p2 = window.solana;
      if(p2?.isPhantom) return p2;

      const list = p2?.providers;
      if(Array.isArray(list)){
        const phantom = list.find((p) => p?.isPhantom);
        if(phantom) return phantom;
      }

      return null;
    }

    function parsePublicKeyStrict(value, label){
      try {
        return new PublicKey(value);
      } catch (err){
        throw new Error(`Invalid public key for ${label}: ${String(value || "")}`);
      }
    }

    function assertIxPubkeys(ix){
      (ix?.keys || []).forEach((k, i) => {
        if(!k || !k.pubkey) throw new Error(`Missing pubkey in instruction key ${i}`);
        parsePublicKeyStrict(k.pubkey.toBase58 ? k.pubkey.toBase58() : k.pubkey, `instruction key ${i}`);
      });
      if(ix?.programId){
        parsePublicKeyStrict(ix.programId.toBase58 ? ix.programId.toBase58() : ix.programId, "instruction programId");
      }
    }

    async function sendProgramInstructions(ixs){
      const provider = getProvider();
      if(!provider) throw new Error("Phantom not found");
      if(!connectedWallet) throw new Error("Wallet not connected");

      const instructions = Array.isArray(ixs) ? ixs : [ixs];
      if(!instructions.length) throw new Error("No instructions provided");

      try { instructions.forEach(assertIxPubkeys); }
      catch(e){ showToast("assertIxPubkeys: " + (e?.message||e)); throw e; }

      let feePayer;
      try {
        const providerPk = provider.publicKey?.toBase58?.() || connectedWallet;
        feePayer = parsePublicKeyStrict(providerPk, "provider public key");
      } catch(e){ showToast("provider public key: " + (e?.message||e)); throw e; }

      let blockhash, lastValidBlockHeight;
      try {
        ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));
      } catch(e){ showToast("getLatestBlockhash: " + (e?.message||e)); throw e; }

      const tx = new Transaction();
      tx.feePayer = feePayer;
      tx.recentBlockhash = blockhash;
      instructions.forEach((ix) => tx.add(ix));

      console.log("[ping-debug] sendProgramInstruction program checks", {
        PROGRAM_ID: PROGRAM_ID.toBase58(),
        ixProgramIds: instructions.map((ix) => ix.programId?.toBase58?.()),
        txInstructionProgramIds: tx.instructions.map((i) => i.programId?.toBase58?.()),
      });

      traceStep("tx:simulate:start", { ixCount: instructions.length });
      try {
        const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "processed" });
        console.log("[pingy] tx simulation err:", sim?.value?.err);
        console.log("[pingy] tx simulation logs:", sim?.value?.logs || []);
        if(sim?.value?.err){
          const simLogs = sim?.value?.logs || [];
          console.warn("[pingy] simulation failed; continuing to wallet signature", sim.value.err, simLogs);
          showToast(`simulation warning: ${JSON.stringify(sim.value.err)} — requesting wallet signature...`);
        }
      } catch (simErr){
        console.warn("[pingy] simulation RPC failed; continuing to wallet signature", simErr);
      }

      console.log("[pingy] about to sign tx", {
        feePayer: tx.feePayer?.toBase58?.(),
        recentBlockhash: tx.recentBlockhash,
        ixCount: tx.instructions?.length,
        programId: instructions[0]?.programId?.toBase58?.(),
      });
      console.log("[pingy] provider methods", {
        hasSignTransaction: typeof provider.signTransaction,
        hasSignAndSendTransaction: typeof provider.signAndSendTransaction,
      });

      let sig;
      if(typeof provider.signAndSendTransaction === "function"){
        traceStep("tx:signAndSendTransaction", { via: "provider.signAndSendTransaction" }, "tx step: opening phantom with signAndSend...");
        try {
          const sendRes = await provider.signAndSendTransaction(tx, { skipPreflight: false });
          sig = typeof sendRes === "string" ? sendRes : sendRes?.signature;
          traceStep("tx:signAndSendTransaction:ok", { signature: sig });
        } catch (e){
          if(isWalletTxRejected(e)){
            traceStep("tx:signAndSendTransaction:rejected", { error: String(e?.message || e) }, "tx step: wallet request rejected by user.");
            throw e;
          }
          if(shouldFallbackToSignTransaction(e)){
            traceStep("tx:signAndSendTransaction:failed", { error: String(e?.message || e) }, "tx step: signAndSend unsupported, trying fallback...");
          } else {
            traceStep("tx:signAndSendTransaction:failed", { error: String(e?.message || e) }, "tx step: signAndSend failed; skipping fallback to avoid duplicate wallet prompts.");
            throw e;
          }
        }
      }

      if(!sig){
        traceStep("tx:fallback-signTransaction", { via: "provider.signTransaction + sendRawTransaction" }, "tx step: opening phantom with fallback signer...");
        let signedTx;
        try {
          signedTx = await provider.signTransaction(tx);
        } catch(e){
          console.error("signTransaction error", e);
          showToast("signTransaction: " + String(e?.message || e));
          throw e;
        }
        if(!signedTx) throw new Error("Missing signed transaction");

        try {
          sig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight:false });
        } catch(e){ showToast("sendRawTransaction: " + (e?.message||e)); throw e; }
      }
      if(!sig) throw new Error("Missing transaction signature");
      traceStep("tx:submitted", { signature: sig }, "tx submitted; waiting for confirmation...");

      let txLogs = [];
      const fetchTxLogs = async () => {
        try {
          const txInfo = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          return txInfo?.meta?.logMessages || [];
        } catch (logErr){
          console.error("[ping-debug] failed to fetch tx logs", logErr);
          return [];
        }
      };

      traceStep("tx:confirm:start", { signature: sig });
      try {
        const confirmRes = await connection.confirmTransaction({ signature:sig, blockhash, lastValidBlockHeight }, "confirmed");
        if(confirmRes?.value?.err){
          txLogs = await fetchTxLogs();
          const confirmErr = new Error(`confirmTransaction returned err: ${JSON.stringify(confirmRes.value.err)}`);
          confirmErr.logs = txLogs;
          confirmErr.txLogs = txLogs;
          confirmErr.signature = sig;
          throw confirmErr;
        }
      } catch(e){
        if(!txLogs.length) txLogs = await fetchTxLogs();
        e.logs = [...(Array.isArray(e?.logs) ? e.logs : []), ...txLogs];
        e.txLogs = txLogs;
        showToast(`confirm failed: ${String(e?.message || e)} | ${(txLogs[txLogs.length - 1] || "no logs")}`);
        console.error("[ping-debug] confirmTransaction error:", e);
        console.error("[ping-debug] onchain logMessages:", txLogs);
        throw e;
      }

      traceStep("tx:confirm:ok", { signature: sig }, "tx confirmed: " + sig);
      return sig;
    }

    async function sendProgramInstruction(ix){
      return sendProgramInstructions([ix]);
    }

    async function pingDepositTx(roomId, amountLamports){
      const rid = String(roomId || "");
      const lamports = Number(amountLamports);
      if(!Number.isInteger(lamports) || lamports <= 0){
        throw new Error("amountLamports must be a positive integer");
      }
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [depositPda] = await deriveDepositPda(rid, walletPk);
      const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
      const [banPda] = await deriveBanPda(rid, walletPk);
      const banInfo = await connection.getAccountInfo(banPda, "confirmed");
      const discriminator = await anchorDiscriminator("ping_deposit");
      const data = concatBytes(
        discriminator,
        encodeStringArg(rid),
        encodeU64Arg(lamports)
      );
      const keys = [
        { pubkey: walletPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: true },
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      if(banInfo) keys.push({ pubkey: banPda, isSigner: false, isWritable: false });
      console.log("[ping-debug] ping_deposit ix", {
        programId: PROGRAM_ID.toBase58(),
        threadPda: threadPda.toBase58(),
        depositPda: depositPda.toBase58(),
              threadEscrowPda: threadEscrowPda.toBase58(),
        discriminatorBytes: Array.from(discriminator),
        dataLength: data.length,
        idlAccountOrder: ["user", "thread", "deposit", "threadEscrow", "systemProgram"],
        keys: keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
      });
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys,
        data,
      }));
    }

    async function pingWithOptionalThreadInitTx(roomId, amountLamports, includeThreadInit){
      const rid = String(roomId || "");
      const lamports = Number(amountLamports);
      if(!Number.isInteger(lamports) || lamports <= 0){
        throw new Error("amountLamports must be a positive integer");
      }
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      const [depositPda] = await deriveDepositPda(rid, walletPk);
      const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
      const [banPda] = await deriveBanPda(rid, walletPk);
      const banInfo = await connection.getAccountInfo(banPda, "confirmed");

      const instructions = [];
      if(includeThreadInit){
        instructions.push(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: walletPk, isSigner: true, isWritable: true },
            { pubkey: threadPda, isSigner: false, isWritable: true },
            { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
            { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
            { pubkey: (await deriveFeeVaultPda())[0], isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: concatBytes(await anchorDiscriminator("initialize_thread"), encodeStringArg(rid), encodeU32Arg(minApprovedWalletsRequired()), encodeU64Arg(Math.floor(Number(selectedPreset().targetSol || 0) * LAMPORTS_PER_SOL)), encodeU16Arg(selectedPreset().maxWalletShareBps)),
        }));
      }

      const pingKeys = [
        { pubkey: walletPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: true },
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      if(banInfo) pingKeys.push({ pubkey: banPda, isSigner: false, isWritable: false });

      instructions.push(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: pingKeys,
        data: concatBytes(
          await anchorDiscriminator("ping_deposit"),
          encodeStringArg(rid),
          encodeU64Arg(lamports)
        ),
      }));

      return sendProgramInstructions(instructions);
    }

    async function initializeThreadTx(threadId){
      const rid = String(threadId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      const discriminator = await anchorDiscriminator("initialize_thread");
      const preset = selectedPreset();
      const data = concatBytes(discriminator, encodeStringArg(rid), encodeU32Arg(preset.minWallets), encodeU64Arg(Math.floor(preset.targetSol * LAMPORTS_PER_SOL)), encodeU16Arg(preset.maxWalletShareBps));
      const keys = [
        { pubkey: adminPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: true },
        { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
        { pubkey: (await deriveThreadEscrowPda(rid))[0], isSigner: false, isWritable: true },
        { pubkey: (await deriveFeeVaultPda())[0], isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      console.log("[ping-debug] initialize_thread ix", {
        programId: PROGRAM_ID.toBase58(),
        discriminatorBytes: Array.from(discriminator),
        dataLength: data.length,
        idlAccountOrder: ["admin", "thread", "spawnPool", "threadEscrow", "feeVault", "systemProgram"],
        keys: keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      });
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys,
        data,
      }));
    }

    async function unpingWithdrawTx(roomId){
      const rid = String(roomId || "");
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
      const [depositPda] = await deriveDepositPda(rid, walletPk);
      const data = concatBytes(await anchorDiscriminator("unping_withdraw"), encodeStringArg(rid));
      const keys = [
        { pubkey: walletPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: true },
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
      ];
      console.log("[ping-debug] unping_withdraw ix", {
        programId: PROGRAM_ID.toBase58(),
        threadPda: threadPda.toBase58(),
        threadEscrowPda: threadEscrowPda.toBase58(),
        depositPda: depositPda.toBase58(),
        discriminatorBytes: Array.from(data.slice(0, 8)),
        idlAccountOrder: ["user", "thread", "deposit", "threadEscrow"],
        keys: keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
      });
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys,
        data,
      }));
    }

    async function approveUserTx(roomId, userWallet){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const userPk = parsePublicKeyStrict(userWallet, "approved user wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [depositPda] = await deriveDepositPda(rid, userPk);
      const data = concatBytes(
        await anchorDiscriminator("approve_user"),
        encodeStringArg(rid),
        userPk.toBytes()
      );
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: threadPda, isSigner: false, isWritable: true },
          { pubkey: depositPda, isSigner: false, isWritable: true },
        ],
        data,
      }));
    }

    function decodeThreadAccount(data){
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if(!bytes?.length || bytes.length < 8) return null;
      let o = 8; // anchor discriminator
      const [threadId, o1] = readString(bytes, o);
      o = o1;
      const [adminPubkey, o2] = readPubkey(bytes, o);
      o = o2;
      const spawnState = bytes[o];
      o += 1;
      const [pendingCount, o3] = readU32LE(bytes, o);
      o = o3;
      const [approvedCount, o4] = readU32LE(bytes, o);
      o = o4;
      const totalAllocatedLamports = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const totalEscrowLamports = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const [minWallets, o5] = readU32LE(bytes, o);
      o = o5;
      const spawnTargetLamports = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const maxWalletShareBps = new DataView(bytes.buffer, bytes.byteOffset + o, 2).getUint16(0, true);
      return {
        threadId,
        admin: adminPubkey.toBase58(),
        admin_pubkey: adminPubkey,
        spawnState,
        pending_count: pendingCount,
        approved_count: approvedCount,
        total_allocated_lamports: Number(totalAllocatedLamports || 0n),
        total_escrow_lamports: Number(totalEscrowLamports || 0n),
        min_approved_wallets: Number(minWallets || 0),
        spawn_target_lamports: Number(spawnTargetLamports || 0n),
        max_wallet_share_bps: Number(maxWalletShareBps || 0),
      };
    }

    function decodeDepositAccount(data){
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if(!bytes?.length || bytes.length < 8) return null;
      let o = 8; // anchor discriminator
      const [threadId, o1] = readString(bytes, o);
      o = o1;
      const [userPubkey, o2] = readPubkey(bytes, o);
      o = o2;
      const statusCode = bytes[o];
      o += 1;
      const rejectedOnce = !!bytes[o];
      o += 1;
      const refundableLamports = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const allocatedLamports = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      const statusMap = ["pending", "approved", "rejected", "withdrawn", "converted"];
      return {
        threadId,
        user: userPubkey.toBase58(),
        status: statusMap[statusCode] || "unknown",
        rejectedOnce,
        refundable_lamports: Number(refundableLamports || 0n),
        allocated_lamports: Number(allocatedLamports || 0n)
      };
    }


    async function fetchRoomOnchainSnapshot(roomId){
      if(!roomId) return null;
      const [threadPda] = await deriveThreadPda(roomId);
      const threadInfo = await connection.getAccountInfo(threadPda, "confirmed");
      if(!threadInfo || !threadInfo.data || threadInfo.data.length < 8){
        state.onchain[roomId] = null;
        return null;
      }

      const thread = decodeThreadAccount(threadInfo.data);
      if(!thread) return null;
      const byWallet = {};
      const approvedWallets = [];
      const pendingWallets = [];
      const depositAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
        commitment: "confirmed",
        filters: [{ dataSize: 8 + 4 + 64 + 32 + 1 + 1 + 8 + 8 }]
      });

      for(const acct of depositAccounts){
        if(!acct?.account?.data || acct.account.data.length < 8) continue;
        const deposit = decodeDepositAccount(acct.account.data);
        if(!deposit || deposit.threadId !== roomId) continue;
        const wallet = deposit.user;
        const refundableSol = Math.max(0, Number(deposit.refundable_lamports || 0) / 1_000_000_000);
        const allocatedSol = Math.max(0, Number(deposit.allocated_lamports || 0) / 1_000_000_000);
        const withdrawableSol = refundableSol + allocatedSol;

        byWallet[wallet] = {
          status: deposit.status,
          refundable_sol: refundableSol,
          allocated_sol: allocatedSol,
          withdrawable_sol: withdrawableSol,
          escrow_sol: allocatedSol,
          deposit_pda: acct.pubkey.toBase58()
        };

        if(deposit.status === "approved") approvedWallets.push(wallet);
        if(deposit.status === "pending") pendingWallets.push(wallet);
      }

      const snapshot = {
        roomId,
        threadPda: threadPda.toBase58(),
        admin: thread.admin,
        admin_pubkey: thread.admin_pubkey,
        pending_count: Number(thread.pending_count || 0),
        approved_count: Number(thread.approved_count || 0),
        total_allocated_lamports: Number(thread.total_allocated_lamports || 0),
        total_escrow_lamports: Number(thread.total_escrow_lamports || 0),
        min_approved_wallets: Number(thread.min_approved_wallets || 0),
        spawn_target_lamports: Number(thread.spawn_target_lamports || 0),
        max_wallet_share_bps: Number(thread.max_wallet_share_bps || 0),
        approverWallets: thread.admin ? [thread.admin] : [],
        byWallet,
        approvedWallets,
        pendingWallets,
        fetchedAtMs: Date.now()
      };

      state.onchain[roomId] = snapshot;
      const room = roomById(roomId);
      if(room){
        room.onchain = snapshot;
        room.spawn_target_sol = Number(snapshot.spawn_target_lamports || 0) / LAMPORTS_PER_SOL;
        room.min_approved_wallets = Number(snapshot.min_approved_wallets || room.min_approved_wallets || 0);
        room.max_wallet_share_bps = Number(snapshot.max_wallet_share_bps || room.max_wallet_share_bps || 0);
      }
      state.onchainMeta[roomId] = { fetchedAtMs: snapshot.fetchedAtMs };
      return snapshot;
    }

    async function fetchConnectedWalletDepositLamports(roomId){
      if(!roomId || !connectedWallet) return 0;
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [depositPda] = await deriveDepositPda(roomId, walletPk);
      const depositInfo = await connection.getAccountInfo(depositPda, "confirmed");
      if(!depositInfo || !depositInfo.data || depositInfo.data.length < 8) return 0;
      const deposit = decodeDepositAccount(depositInfo.data);
      return Number((deposit?.allocated_lamports || 0) + (deposit?.refundable_lamports || 0));
    }


    async function fetchConnectedWalletDepositSnapshot(){
      if(!connectedWallet || !activeRoomId) {
        state.userEscrow = null;
        return null;
      }
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [depositPda] = await deriveDepositPda(activeRoomId, walletPk);
      const info = await connection.getAccountInfo(depositPda, "confirmed");
      if(!info || !info.data || info.data.length < 8){
        state.userEscrow = { refundable_lamports: 0, allocated_lamports: 0, deposit_pda: depositPda.toBase58() };
        return state.userEscrow;
      }
      const deposit = decodeDepositAccount(info.data);
      state.userEscrow = {
        refundable_lamports: Number(deposit?.refundable_lamports || 0),
        allocated_lamports: Number(deposit?.allocated_lamports || 0),
        withdrawable_lamports: Number((deposit?.refundable_lamports || 0) + (deposit?.allocated_lamports || 0)),
        deposit_pda: depositPda.toBase58(),
      };
      return state.userEscrow;
    }

    function refreshRoomOnchainSnapshot(roomId, opts = {}){
      if(!roomId) return Promise.resolve(null);
      const force = !!opts.force;
      const now = Date.now();
      const meta = state.onchainMeta[roomId] || {};
      if(!force && meta.inflight) return meta.inflight;
      if(!force && meta.fetchedAtMs && (now - meta.fetchedAtMs) < ONCHAIN_REFRESH_MS){
        return Promise.resolve(state.onchain[roomId] || null);
      }
      const inflight = fetchRoomOnchainSnapshot(roomId).catch(() => null).finally(() => {
        const latest = state.onchainMeta[roomId] || {};
        delete latest.inflight;
        state.onchainMeta[roomId] = latest;
      });
      state.onchainMeta[roomId] = { ...meta, inflight };
      return inflight;
    }

    function normalizeMintAddress(mint){
      const raw = String(mint || "").trim();
      if(!raw || raw.includes("...")) return "";
      try { return new PublicKey(raw).toBase58(); }
      catch(_e){ return ""; }
    }

    async function fetchWalletBalancesSnapshot(wallet){
      if(!wallet) return null;
      const ownerPk = new PublicKey(wallet);

      const lamports = await connection.getBalance(ownerPk, "confirmed");
      const nativeSol = Number(lamports || 0) / LAMPORTS_PER_SOL;

      let depositsByThread = {};
      let tokenBalances = [];
      let depositsError = "";
      let tokensError = "";

      try {
        const depositAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
          commitment: "confirmed",
          filters: [{ dataSize: 8 + 4 + 64 + 32 + 1 + 1 + 8 + 8 }]
        });
        for(const acct of depositAccounts){
          if(!acct?.account?.data || acct.account.data.length < 8) continue;
          const deposit = decodeDepositAccount(acct.account.data);
          if(!deposit || deposit.user !== wallet) continue;
          const refundableSol = Math.max(0, Number(deposit.refundable_lamports || 0) / LAMPORTS_PER_SOL);
          const allocatedSol = Math.max(0, Number(deposit.allocated_lamports || 0) / LAMPORTS_PER_SOL);
          const threadId = deposit.threadId;
          depositsByThread[threadId] = {
            threadId,
            status: normalizeDepositStatus(deposit.status),
            refundable_sol: refundableSol,
            allocated_sol: allocatedSol,
            withdrawable_sol: refundableSol + allocatedSol,
            deposit_pda: acct.pubkey.toBase58(),
          };
        }
      } catch(e){
        depositsByThread = {};
        depositsError = String(e?.message || e || "failed to fetch deposits");
      }

      try {
        const tokenResp = await connection.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_PROGRAM_ID }, "confirmed");
        const roomByTokenAddress = new Map();
        state.rooms.forEach((room) => {
          const normalized = normalizeMintAddress(room.token_address);
          if(normalized) roomByTokenAddress.set(normalized, room.id);
        });
        tokenBalances = [];
        for(const entry of tokenResp?.value || []){
          const info = entry?.account?.data?.parsed?.info;
          const mint = info?.mint;
          const uiAmount = Number(info?.tokenAmount?.uiAmount || 0);
          if(!mint || uiAmount <= 0) continue;
          const normalizedMint = normalizeMintAddress(mint);
          tokenBalances.push({
            mint: normalizedMint || String(mint),
            amount: uiAmount,
            roomId: roomByTokenAddress.get(normalizedMint) || null,
          });
        }
      } catch(e){
        tokenBalances = [];
        tokensError = String(e?.message || e || "failed to fetch token balances");
      }

      const snapshot = {
        wallet,
        nativeSol,
        depositsByThread,
        tokenBalances,
        fetchedAtMs: Date.now(),
      };
      if(depositsError) snapshot.deposits_error = depositsError;
      if(tokensError) snapshot.tokens_error = tokensError;
      state.walletBalances[wallet] = snapshot;
      state.walletBalancesMeta[wallet] = { fetchedAtMs: snapshot.fetchedAtMs };
      return snapshot;
    }

    function refreshWalletBalances(wallet, opts = {}){
      if(!wallet) return Promise.resolve(null);
      const force = !!opts.force;
      const now = Date.now();
      const meta = state.walletBalancesMeta[wallet] || {};
      if(!force && meta.inflight) return meta.inflight;
      if(!force && meta.fetchedAtMs && (now - meta.fetchedAtMs) < WALLET_BAL_REFRESH_MS){
        return Promise.resolve(state.walletBalances[wallet] || null);
      }
      const inflight = fetchWalletBalancesSnapshot(wallet).catch((e) => {
        const fallback = {
          wallet,
          nativeSol: 0,
          depositsByThread: {},
          tokenBalances: [],
          fetchedAtMs: Date.now(),
          error: String(e?.message || e || "balance fetch failed"),
        };
        state.walletBalances[wallet] = fallback;
        state.walletBalancesMeta[wallet] = { fetchedAtMs: fallback.fetchedAtMs };
        return fallback;
      }).finally(() => {
        const latest = state.walletBalancesMeta[wallet] || {};
        delete latest.inflight;
        state.walletBalancesMeta[wallet] = latest;
      });
      state.walletBalancesMeta[wallet] = { ...meta, inflight };
      return inflight;
    }

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

    // Extra demo rooms
    state.rooms[3].positions = { [state.rooms[3].creator_wallet]: { escrow_sol: 0.18 } };
    state.rooms[3]._lastActivity = Date.now() - 25_000;
    state.rooms[4].positions = { [state.rooms[4].creator_wallet]: { escrow_sol: 2.2 } };
    state.rooms[4]._lastActivity = Date.now() - 7_000;
    state.rooms[5].state = "BONDING";
    state.rooms[5].market_cap_usd = 61200;
    state.rooms[5].change_pct = 9.84;
    state.rooms[5].token_address = "8m7QKp...nV1z";
    state.rooms[5]._lastActivity = Date.now() - 4_000;

    state.rooms.forEach((r) => {
      r.approval = r.approval || {};
      r.approverWallets = r.approverWallets || {};
      r.blockedWallets = r.blockedWallets || {};
      if(r.creator_wallet){
        r.approval[r.creator_wallet] = "approved";
        r.approverWallets[r.creator_wallet] = true;
      }
    });

    function mkRoom(id, name, ticker, desc, presetKey = "fast"){
      const creator_wallet = (Math.random().toString(16).slice(2,10) + '111111111111111111111111111111').slice(0,44);
      const preset = PRESETS[presetKey] || PRESETS.balanced;
      return {
        id, name, ticker, desc,
        creator_wallet,
        socials: { x:'', tg:'', web:'' },
        created_at: nowStamp(),
        state: "SPAWNING",          // SPAWNING | BONDING | BONDED
        launch_preset: preset.key,
        min_approved_wallets: preset.minWallets,
        spawn_target_sol: preset.targetSol,
        max_wallet_share_bps: preset.maxWalletShareBps,
        spawn_tokens_total: 0,      // virtual tokens sold in the spawn tranche (pre-token)
        spawn_fee_paid_sol: 0,      // actual spawn fee charged only when spawn executes
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
      const snapshot = state.onchain?.[roomId];
      if(snapshot?.byWallet?.[connectedWallet]){
        const row = snapshot.byWallet[connectedWallet] || {};
        const withdrawable = Number(row.withdrawable_sol);
        if(Number.isFinite(withdrawable)) return Math.max(0, withdrawable);
        return Math.max(0, Number(row.escrow_sol || 0));
      }
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


    async function refreshConnectedWalletEscrowLine(roomId){
      if(!connectedWallet || !roomId || activeRoomId !== roomId) return;
      const meLine = $("meLine");
      if(!meLine) return;
      const r = roomById(roomId);
      if(!r || r.state !== "SPAWNING") return;
      try {
        const lamports = await fetchConnectedWalletDepositLamports(roomId);
        if(activeRoomId !== roomId) return;
        const escrowSol = Number(lamports || 0) / LAMPORTS_PER_SOL;
        const snapshot = state.onchain?.[roomId] || {};
        snapshot.byWallet = snapshot.byWallet || {};
        snapshot.byWallet[connectedWallet] = {
          ...(snapshot.byWallet[connectedWallet] || {}),
          escrow_sol: escrowSol,
        };
        state.onchain[roomId] = snapshot;
        meLine.textContent = `you: ${escrowSol.toFixed(3)} SOL escrow`;
      } catch(err){
        console.warn("[pingy] failed to refresh connected wallet deposit", err);
      }
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
    const createCoinHead = $("createCoinHead");
    console.log("[pingy] DOM check createCoinHead:", !!createCoinHead);
    if(createCoinHead){
      createCoinHead.addEventListener("click", () => {
        console.log("[pingy] createCoinHead click");
        toggleCreateCoin();
      });
    }

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

    function openProfile(wallet){
      if(!wallet) return;
      navigateHash("profile/" + encodeURIComponent(wallet));
    }


    async function init(){
      homeView = $("homeView");
      roomView = $("roomView");
      profileView = $("profileView");
      legalView = $("legalView");
      homeBtn = $("homeBtn");

      walletPill = $("walletPill");
      walletMenu = $("walletMenu");
      walletDropdown = $("walletDropdown");
      walletProfileItem = $("walletProfileItem");
      walletViewWalletItem = $("walletViewWalletItem");
      walletCopyItem = $("walletCopyItem");
      walletDisconnectItem = $("walletDisconnectItem");
      connectBtn = $("connectBtn");

      toast = $("toast");
      toastText = $("toastText");
      onchainBanner = $("onchainBanner");
      onchainBannerText = $("onchainBannerText");
      updateOnchainBanner();

      loadProfileLocal();

    async function providerConnect(provider, opts){
      if(!provider || typeof provider.connect !== "function"){
        throw new Error("Wallet provider connect not available");
      }
      try {
        if(opts) return await provider.connect(opts);
        return await provider.connect();
      } catch (err){
        const msg = String(err?.message || err || "").toLowerCase();
        if(opts && msg.includes("invalid arguments")){
          return provider.connect();
        }
        throw err;
      }
    }

    function getExplorerAccountUrl(wallet){
      const base = `https://explorer.solana.com/address/${encodeURIComponent(wallet)}`;
      return SOLANA_CLUSTER === "devnet" ? `${base}?cluster=devnet` : base;
    }

    function refreshWalletViews(){
      updateHeaderWalletUI();
      renderHome();
      if(activeRoomId) renderRoom(activeRoomId);
      if(profileView.classList.contains("on")) renderProfilePage();
    }

    function setConnectedWallet(nextWallet){
      connectedWallet = nextWallet || null;
      state.walletPubkey = connectedWallet;
    }

    function clearWalletScopedCaches(){
      state.userEscrow = null;
      state.onchain = {};
      state.onchainMeta = {};
    }

    async function refreshRoomFromChain(){
      const tasks = state.rooms.map((room) => refreshRoomOnchainSnapshot(room.id, { force: true }));
      if(connectedWallet) tasks.push(fetchConnectedWalletDepositSnapshot());
      await Promise.allSettled(tasks);
      if(activeRoomId && connectedWallet) await refreshConnectedWalletEscrowLine(activeRoomId);
    }

    function clearConnectedWallet(){
      setConnectedWallet(null);
      clearWalletScopedCaches();
      refreshWalletViews();
      updateEarningsUI();
    }

    function bindWalletListeners(provider){
      if(walletListenersBound || !provider || typeof provider.on !== "function") return;
      provider.on("accountChanged", async (pubkey) => {
        console.log("[wallet] accountChanged", pubkey?.toBase58?.() || null);
        if(!pubkey){
          clearConnectedWallet();
          return;
        }
        setConnectedWallet(pubkey.toBase58());
        clearWalletScopedCaches();
        await refreshRoomFromChain();
        refreshWalletViews();
      });
      provider.on("connect", async () => {
        console.log("[wallet] connect", provider.publicKey?.toBase58?.() || null);
        setConnectedWallet(provider.publicKey?.toBase58?.() || null);
        await refreshRoomFromChain();
        refreshWalletViews();
      });
      provider.on("disconnect", () => {
        console.log("[wallet] disconnect");
        clearConnectedWallet();
      });
      walletListenersBound = true;
    }

    async function runWalletSmokeTest(){
      if(!connectedWallet) return showToast("connect wallet first.");
      const provider = getProvider();
      if(!provider) return showToast("Phantom not found. Install Phantom.");
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      traceStep("wallet-smoke-test:start", { wallet: connectedWallet }, "smoke test: requesting phantom popup...");
      try {
        let blockhash, lastValidBlockHeight;
        ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));

        const tx = new Transaction({
          feePayer: walletPk,
          recentBlockhash: blockhash,
        }).add(SystemProgram.transfer({
          fromPubkey: walletPk,
          toPubkey: walletPk,
          lamports: 1,
        }));

        console.log("SystemProgram.transfer type:", typeof SystemProgram.transfer);

        let sig;
        if(typeof provider.signAndSendTransaction === "function"){
          const sendRes = await provider.signAndSendTransaction(tx, { skipPreflight: false });
          sig = typeof sendRes === "string" ? sendRes : sendRes?.signature;
        }

        if(!sig){
          const signedTx = await provider.signTransaction(tx);
          sig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });
        }

        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        traceStep("wallet-smoke-test:ok", { signature: sig }, "smoke test confirmed");
      } catch (err){
        traceStep("wallet-smoke-test:failed", { error: String(err?.message || err) }, "smoke test failed");
        reportTxError(err, "wallet smoke test failed");
      }
    }

    // Connect wallet (Phantom)
async function connectMock(){
  closeWalletDropdown();
  const provider = getProvider();
  if(!provider) return showToast("Phantom not found. Install Phantom.");

  console.log("[pingy] provider object:", provider);
  console.log("[pingy] provider.isPhantom:", provider?.isPhantom);

  bindWalletListeners(provider);

  try{
    const resp = await providerConnect(provider);
    bindWalletListeners(provider);
    const nextWallet = resp && resp.publicKey ? resp.publicKey.toString() : null;
    if(!nextWallet) return;

    setConnectedWallet(nextWallet);
    console.log("[pingy] provider.publicKey after connect:", provider?.publicKey?.toString?.() || provider?.publicKey);
    toast.classList.remove("on");

    if(!profile.wallet_first_seen_ms) profile.wallet_first_seen_ms = Date.now();
    if(!profile.namesByWallet[connectedWallet]) profile.namesByWallet[connectedWallet] = "big_hitter";
    saveProfileLocal();

    await refreshRoomFromChain();
    refreshWalletViews();
  } catch(err){
    console.error("[pingy] connect error:", err);
    const code = Number(err && err.code);
    if(code === 4001 || /reject/i.test(String(err && err.message || ""))){
      const rejectedMsg = String(err?.message || err || "wallet connection rejected.");
      showToast(rejectedMsg);
      return;
    }
    const msg = String(err?.message || err || "wallet connect failed");
    showToast(msg);
  }
}

async function disconnectMock(){
  closeWalletDropdown();
  const provider = getProvider();
  if(provider && typeof provider.disconnect === "function"){
    try { await provider.disconnect(); }
    catch(e){ /* no-op */ }
  }
  clearConnectedWallet();
  state.userEscrow = null;
  showToast("disconnected.");
}

console.log("[pingy] DOM check connectBtn:", !!connectBtn);
if(connectBtn){
  connectBtn.addEventListener("click", () => {
    console.log("[pingy] connectBtn click");
    connectMock();
  });
}
    $("toastConnect").addEventListener("click", connectMock);
    $("toastClose").addEventListener("click", () => toast.classList.remove("on"));
    homeBtn.addEventListener("click", () => navigateHash("home"));
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

    const visibleModalOverlays = Array.from(document.querySelectorAll(".modalBack"))
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => el.id);
    console.log("[pingy] visible modal overlays at init:", visibleModalOverlays);

    // Profile modal
    function openProfileModal(){
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
      window.open(getExplorerAccountUrl(connectedWallet), "_blank", "noopener,noreferrer");
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
    function statusToString(status){
      if(typeof status === "string") return status;
      if(typeof status === "number") return String(status);
      if(status && typeof status === "object"){
        if(typeof status.value === "string") return status.value;
        if(typeof status.kind === "string") return status.kind;
        const keys = Object.keys(status);
        if(keys.length === 1) return keys[0];
      }
      return String(status || "");
    }

    function normalizeDepositStatus(status){
      const raw = statusToString(status).toLowerCase();
      if(raw === "denied") return "rejected";
      return raw;
    }

    function isCountedDepositStatus(status){
      const normalized = normalizeDepositStatus(status);
      return normalized === "approved" || normalized === "swept";
    }

    function walletStatus(r, wallet){
      if(!wallet) return "";
      const snapshot = getRoomEscrowSnapshot(r);
      if(r.blockedWallets && r.blockedWallets[wallet]) return "denied";
      const status = snapshot.byWallet?.[wallet]?.status;
      if(status) return status;
      if(isCreator(r, wallet)) return "approved";
      return "";
    }
    function isApproved(r, wallet){ return walletStatus(r, wallet) === "approved"; }
    function isApprover(r, wallet){
      if(!wallet) return false;
      const snapshot = getRoomEscrowSnapshot(r);
      const onchainApprovers = snapshot.approverWallets || [];
      if(onchainApprovers.length > 0) return onchainApprovers.includes(wallet);
      return isCreator(r, wallet) || !!(r.approverWallets && r.approverWallets[wallet]);
    }
    function isDenied(r, wallet){
      const status = walletStatus(r, wallet);
      return status === "denied" || status === "rejected";
    }
    function isPending(r, wallet){ return walletStatus(r, wallet) === "pending"; }

    function getRoomEscrowSnapshot(room){
      const r = room || {};
      const onchain = state.onchain?.[r.id];
      if(onchain && onchain.byWallet){
        const byWallet = {};
        const approvedWallets = [];
        const pendingWallets = [];

        for(const wallet of Object.keys(onchain.byWallet)){
          const row = onchain.byWallet[wallet] || {};
          const blocked = !!(r.blockedWallets && r.blockedWallets[wallet]);
          const status = blocked ? "denied" : normalizeDepositStatus(row.status);
          const rawEscrowSol = Math.max(0, Number(row.escrow_sol || 0));
          const escrowSol = isCountedDepositStatus(status) ? rawEscrowSol : 0;

          byWallet[wallet] = {
            ...row,
            status,
            escrow_sol: escrowSol
          };

          if(isCountedDepositStatus(status)) approvedWallets.push(wallet);
          if(status === "pending") pendingWallets.push(wallet);
        }

        return {
          ...onchain,
          byWallet,
          approvedWallets,
          pendingWallets
        };
      }

      return {
        roomId: r.id,
        admin: r.creator_wallet,
        approverWallets: r.creator_wallet ? [r.creator_wallet] : [],
        byWallet: {},
        approvedWallets: [],
        pendingWallets: []
      };
    }

    function approvedEscrowSol(r){
      let total = 0;
      const snapshot = getRoomEscrowSnapshot(r);
      for(const w of snapshot.approvedWallets){
        total += Number(snapshot.byWallet[w]?.escrow_sol || 0);
      }
      return total;
    }

    function countedEscrowSol(r){
      if(Number(r?.onchain?.spawn_target_lamports || 0) > 0){
        return Number(r.onchain.total_allocated_lamports || 0) / LAMPORTS_PER_SOL;
      }
      let total = 0;
      const capSol = Number(walletCapSol(r) || 0);
      const snapshot = getRoomEscrowSnapshot(r);
      for(const w of snapshot.approvedWallets){
        const escrow = Number(snapshot.byWallet[w]?.escrow_sol || 0);
        total += Math.min(escrow, capSol);
      }
      return total;
    }

    function spawnProgress01(r){
      const target = spawnTargetSol(r);
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
        const target = spawnTargetSol(r);
        if(target > 0 && total >= target && getRoomEscrowSnapshot(r).approvedWallets.length >= minApprovedWalletsRequired(r)){
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
          const feeSol = total * (SPAWN_FEE_BPS / BPS_DENOM);
          const netSol = Math.max(0, total - feeSol);
          r.spawn_fee_paid_sol = feeSol;
          addSystemEvent(r.id, `spawn fee paid: ${feeSol.toFixed(3)} SOL (1%), net used: ${netSol.toFixed(3)} SOL`);

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
              <div class="bar barActive barSpawn"><i style="width:${pct}%"></i></div>
              <div class="barRow">
                <div class="tiny">raising launch liquidity</div>
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
      const athRatio = p;
      const isHotBonding = r.state === "BONDING" && athRatio >= 0.9;
      const barClass = isHotBonding ? "bar barActive barBonding barHot" : "bar barActive barBonding";

      return `
        <div class="cardGrid">
          ${mosaicHtml(r)}
          <div style="min-width:0;">
            <div class="row" style="justify-content:space-between;align-items:baseline;">
              <div class="name">${escapeText(r.name)} <span class="k">$${escapeText(r.ticker)}</span></div>
              <span class="k">${chip}</span>
            </div>
            <div class="tiny subline">${escapeText(r.desc || "—")}</div>
            <div class="${barClass}"><i style="width:${pct}%"></i>${isHotBonding ? `<span class="barSpark"></span>` : ""}</div>
          </div>
          <div>
            <div class="metric">${fmtK(mc)}</div>
            <div class="chg ${chgCls}">${signArrow(chg)}</div>
          </div>
        </div>
      `;
    }

    function renderCard(r, where){
      where.appendChild(getOrCreateHomeCard(r));
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

    function computeMoversScore(thread){
      const now = Date.now();
      const lastChatAt = Number(thread?.lastChatAtMs || thread?._lastActivity || 0);
      const recency = lastChatAt > 0 ? Math.max(0, 1 - ((now - lastChatAt) / 300000)) : 0;
      const pingers = Array.isArray(thread?.pingers) ? thread.pingers.length : 0;
      const pingerSignal = Math.min(1, pingers / 8);
      const progressSignal = pctForRoom(thread);
      return (recency * 0.45) + (pingerSignal * 0.2) + (progressSignal * 0.35) + (Math.random() * 0.25);
    }

    function simulateMovers(threads){
      if(!state.movers.enabled) return;
      const ranked = threads.map((thread) => {
        const score = computeMoversScore(thread);
        state.movers.scores[thread.id] = score;
        return { id: thread.id, score };
      }).sort((a,b) => b.score - a.score);

      const topIds = ranked.slice(0, Math.min(3, ranked.length)).map((item) => item.id);
      state.movers.active = new Set(topIds);
      renderHome();
    }

    function moveBottomLiveCardToTop(){
      const liveRooms = sortedLiveRooms();
      if(liveRooms.length < 2) return;
      const last = liveRooms[liveRooms.length - 1];
      const topScore = liveRooms.reduce((maxScore, room) => Math.max(maxScore, Number(state.movers.scores[room.id] || 0)), 0);
      state.movers.scores[last.id] = topScore + 10;
      state.movers.active = new Set([last.id, ...liveRooms.slice(0,2).map((room) => room.id)]);
      state.movers.shimmyId = last.id;
      state.movers.shimmyUntil = Date.now() + 250;
      renderHome();
    }

    function sortedLiveRooms(){
      return state.rooms
        .slice()
        .sort((a,b) => {
          const moverDelta = Number(state.movers.scores[b.id] || 0) - Number(state.movers.scores[a.id] || 0);
          if(Math.abs(moverDelta) > 0.0001) return moverDelta;
          const la = Number(a._lastActivity||0), lb = Number(b._lastActivity||0);
          if(lb !== la) return lb - la;
          const sa = roomRankKey(a), sb = roomRankKey(b);
          if(sa !== sb) return sa - sb;
          return pctForRoom(b) - pctForRoom(a);
        })
        .slice(0,9);
    }

    const homeCardElsByThreadId = new Map();

    function getOrCreateHomeCard(r){
      let el = homeCardElsByThreadId.get(r.id);
      if(!el){
        el = document.createElement("div");
        el.style.willChange = "transform";
        homeCardElsByThreadId.set(r.id, el);
      }
      updateHomeCard(el, r);
      return el;
    }

    function updateHomeCard(el, r){
      const classes = ["card"];
      if(Date.now() < (r._pulseUntil||0)) classes.push("pulse");
      if(state.movers.active.has(r.id)) classes.push("isMover");
      if(state.movers.shimmyId === r.id && Date.now() < Number(state.movers.shimmyUntil || 0)) classes.push("isShimmy");
      el.className = classes.join(" ");
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
        setTimeout(() => openPingModal(r.id), 0);
      });
      el.querySelector("[data-share]").addEventListener("click", () => openShareModal(r.id));
    }

    function animateHomeReorder(container, liveRooms){
      const first = new Map();
      liveRooms.forEach((room) => {
        const existing = homeCardElsByThreadId.get(room.id);
        if(existing && existing.isConnected) first.set(room.id, existing.getBoundingClientRect());
      });

      liveRooms.forEach((room) => container.appendChild(getOrCreateHomeCard(room)));

      const flips = [];
      liveRooms.forEach((room) => {
        const el = homeCardElsByThreadId.get(room.id);
        const prev = first.get(room.id);
        if(!el || !prev) return;
        const next = el.getBoundingClientRect();
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        if(Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        flips.push(el);
      });

      if(!flips.length) return;
      requestAnimationFrame(() => {
        flips.forEach((el) => {
          el.style.transition = "transform 350ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 140ms ease, filter 140ms ease";
          el.style.transform = "translate(0, 0)";
        });
      });
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
      if(!cardsRow || !exploreList) return;
      exploreList.innerHTML = "";

      // LIVE: never filtered by explore search
      const liveRooms = sortedLiveRooms();
      animateHomeReorder(cardsRow, liveRooms);
      const liveIds = new Set(liveRooms.map((r) => r.id));
      for(const [id, el] of homeCardElsByThreadId.entries()){
        if(!liveIds.has(id) && el.parentElement === cardsRow) cardsRow.removeChild(el);
      }


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
    $("moveCardsBtn")?.addEventListener("click", moveBottomLiveCardToTop);
    $("searchInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter"){ e.preventDefault(); runExploreSearch(); }
    });

    async function createCoinFromForm(){
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
      const commitLamports = Math.floor(commit * LAMPORTS_PER_SOL);
      if(commit > 0 && commitLamports <= 0) return alert("commit must be at least 1 lamport.");

      const preset = selectedPreset();
      const presetCapLamports = presetWalletCapLamports(preset.key);
      if(commitLamports > presetCapLamports){
        return alert(`commit exceeds ${preset.label} cap (${(presetCapLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL max).`);
      }
      const id = "r" + Math.random().toString(16).slice(2,6);

      if(shouldUseOnchain()){
        if(commitLamports > 0){
          try {
            await pingWithOptionalThreadInitTx(id, commitLamports, true);
          } catch(e){
            if(isWalletTxRejected(e)) showToast("Create cancelled — no coin or commit was submitted.");
            else if(isUserBannedError(e)) showToast("You were denied from this coin and can’t re-enter.");
            else reportTxError(e, "initialize + ping_deposit transaction failed on create");
            return;
          }
        } else {
          try {
            await initializeThreadTx(id);
          } catch (e){
            reportTxError(e, "initialize_thread transaction failed");
            return;
          }
        }
      }

      const r = mkRoom(id, name, ticker, desc, preset.key);
      r.creator_wallet = connectedWallet;
      r.approval = { [connectedWallet]: "approved" };
      r.approverWallets = r.approverWallets || {};
      r.blockedWallets = r.blockedWallets || {};
      r.approverWallets[connectedWallet] = true;
      r.socials = { x: xUrl, tg: tgUrl, web: webUrl };
      if(newImgData) r.image = newImgData;
      state.rooms.unshift(r);
      state.chat[id] = [{ ts:"—", wallet:"SYSTEM", text:"coin created. waiting for spawn." }];

      $("newName").value = "";
      $("newTicker").value = "";
      $("newDesc").value = "";
      $("newX").value = "";
      $("newTg").value = "";
      $("newWeb").value = "";
      $("newCommit").value = "";
      if($("newPreset")) {
        $("newPreset").value = "fast";
        updatePresetCapHint();
      }
      $("newImg").value = "";
      newImgData = null;
      setNewImgPreview(null);

      toggleCreateCoin(false);
      renderHome();
      openRoom(id);

      if(shouldUseOnchain()){
        await fetchRoomOnchainSnapshot(id);
        await refreshConnectedWalletEscrowLine(id);
        await fetchConnectedWalletDepositSnapshot();
        if(activeRoomId === id) renderRoom(id);
      }
    }
    $("createCoinBtn").addEventListener("click", createCoinFromForm);
    if($("newPreset")){
      $("newPreset").addEventListener("change", updatePresetCapHint);
      updatePresetCapHint();
    }

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

    function setActiveProfileTab(tab){
      activeProfileTab = tab;
      renderProfilePage();
    }

    function profileBalanceStatusLabel(status){
      if(status === "pending") return "pending approval";
      if(status === "approved") return "approved";
      if(status === "rejected") return "rejected";
      if(status === "withdrawn") return "withdrawn";
      if(status === "converted") return "converted";
      return status || "unknown";
    }

    async function renderProfileTabs(wallet){
      const content = $("profileTabContent");
      const tabButtons = {
        balances: $("profileTabBalances"),
        coins: $("profileTabCoins"),
        rewards: $("profileTabRewards"),
        followers: $("profileTabFollowers"),
      };
      Object.entries(tabButtons).forEach(([tab, btn]) => {
        if(btn) btn.classList.toggle("active", tab === activeProfileTab);
      });
      if(!content) return;

      if(!wallet){
        content.innerHTML = '<div class="muted">connect wallet to view tab details.</div>';
        return;
      }

      if(activeProfileTab === "balances"){
        let snapshot = state.walletBalances[wallet] || null;
        if(!snapshot){
          snapshot = await refreshWalletBalances(wallet);
        } else {
          refreshWalletBalances(wallet);
        }
        if(profileRouteWallet() !== wallet) return;
        if(!snapshot){
          content.innerHTML = '<div class="muted">loading balances…</div>';
          return;
        }

        const sol = Number(snapshot.nativeSol || 0);
        const usd = Math.max(0, sol) * SOL_TO_USD;
        const sections = document.createElement("div");
        sections.className = "profileTabList";

        if(snapshot.error || snapshot.deposits_error || snapshot.tokens_error){
          const partial = document.createElement("div");
          partial.className = "muted tiny";
          partial.textContent = "Balances partial (offline)";
          sections.appendChild(partial);
        }

        const solRow = document.createElement("div");
        solRow.className = "btn subtle profileTabRow";
        solRow.innerHTML = `<span><b>${sol.toFixed(4)} SOL</b></span><span class="muted tiny">${fmtUsd(usd)} (mock)</span>`;
        sections.appendChild(solRow);

        const escrowsHeader = document.createElement("div");
        escrowsHeader.className = "muted tiny";
        escrowsHeader.textContent = "Pingy escrows";
        sections.appendChild(escrowsHeader);

        const deposits = Object.values(snapshot.depositsByThread || {});
        if(!deposits.length){
          const none = document.createElement("div");
          none.className = "muted tiny";
          none.textContent = "no escrow positions";
          sections.appendChild(none);
        } else {
          deposits.forEach((deposit) => {
            const room = roomById(deposit.threadId);
            const row = document.createElement("div");
            row.className = "btn subtle profileTabRow";
            const left = document.createElement("span");
            left.innerHTML = `${escapeText(room ? `${room.name} $${room.ticker}` : deposit.threadId)} <span class="muted tiny">${escapeText(profileBalanceStatusLabel(deposit.status))} • ${Number(deposit.withdrawable_sol || 0).toFixed(4)} SOL</span>`;
            const right = document.createElement("span");
            right.style.display = "inline-flex";
            right.style.gap = "6px";
            const openBtn = document.createElement("button");
            openBtn.className = "btn subtle small";
            openBtn.type = "button";
            openBtn.textContent = "open";
            openBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              navigateHash("room/" + encodeURIComponent(deposit.threadId));
            });
            right.appendChild(openBtn);
            if(room && connectedWallet && connectedWallet === wallet && room.state === "SPAWNING"){
              const unpingBtn = document.createElement("button");
              unpingBtn.className = "btn subtle small";
              unpingBtn.type = "button";
              unpingBtn.textContent = "unping";
              unpingBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                openUnpingModal(room.id);
              });
              right.appendChild(unpingBtn);
            }
            row.appendChild(left);
            row.appendChild(right);
            sections.appendChild(row);
          });
        }

        const tokenHeader = document.createElement("div");
        tokenHeader.className = "muted tiny";
        tokenHeader.textContent = "Tokens";
        sections.appendChild(tokenHeader);

        const tokens = snapshot.tokenBalances || [];
        if(!tokens.length){
          const none = document.createElement("div");
          none.className = "muted tiny";
          none.textContent = "no SPL tokens";
          sections.appendChild(none);
        } else {
          tokens.forEach((token) => {
            const room = token.roomId ? roomById(token.roomId) : null;
            const row = document.createElement("div");
            row.className = "btn subtle profileTabRow";
            const left = document.createElement("span");
            left.innerHTML = `${escapeText(room ? `${room.name} $${room.ticker}` : shortWallet(token.mint))} <span class="muted tiny">${Number(token.amount || 0).toLocaleString()}</span>`;
            row.appendChild(left);
            if(room){
              const right = document.createElement("span");
              right.style.display = "inline-flex";
              right.style.gap = "6px";
              const openBtn = document.createElement("button");
              openBtn.className = "btn subtle small";
              openBtn.type = "button";
              openBtn.textContent = "open";
              openBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                navigateHash("room/" + encodeURIComponent(room.id));
              });
              right.appendChild(openBtn);
              const sellBtn = document.createElement("button");
              sellBtn.className = "btn subtle small";
              sellBtn.type = "button";
              sellBtn.textContent = "sell";
              sellBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                navigateHash("room/" + encodeURIComponent(room.id));
                setTimeout(() => openUnpingModal(room.id), 0);
              });
              right.appendChild(sellBtn);
              row.appendChild(right);
            }
            sections.appendChild(row);
          });
        }

        content.innerHTML = "";
        content.appendChild(sections);
        return;
      }

      if(activeProfileTab === "coins"){
        const rooms = state.rooms.filter(r => r.creator_wallet === wallet);
        if(!rooms.length){
          content.innerHTML = '<div class="muted">no coins created yet.</div>';
          return;
        }
        const list = document.createElement("div");
        list.className = "profileTabList";
        rooms.forEach((r) => {
          const row = document.createElement("button");
          row.className = "btn subtle profileTabRow";
          row.type = "button";
          row.innerHTML = `<span>${escapeText(r.name)} <span class="muted">$${escapeText(r.ticker)}</span></span><span class="muted">view</span>`;
          row.addEventListener("click", () => navigateHash("room/" + encodeURIComponent(r.id)));
          list.appendChild(row);
        });
        content.innerHTML = "";
        content.appendChild(list);
        return;
      }

      if(activeProfileTab === "rewards"){
        content.innerHTML = '<div class="muted">creator rewards coming soon.</div>';
        return;
      }

      const all = profile.followsByWallet || {};
      const followers = Object.keys(all).filter((followerWallet) => all[followerWallet] && all[followerWallet][wallet]);
      if(!followers.length){
        content.innerHTML = '<div class="muted">no followers yet.</div>';
        return;
      }
      const list = document.createElement("div");
      list.className = "profileTabList";
      followers.forEach((followerWallet) => {
        const row = document.createElement("button");
        row.className = "btn subtle profileTabRow";
        row.type = "button";
        row.innerHTML = `<span>${escapeText(displayName(followerWallet))}</span><span class="muted">${escapeText(shortWallet(followerWallet))}</span>`;
        row.addEventListener("click", () => navigateHash("profile/" + encodeURIComponent(followerWallet)));
        list.appendChild(row);
      });
      content.innerHTML = "";
      content.appendChild(list);
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
        renderProfileTabs("");
        return;
      }

      const details = getProfileDetails(wallet);
      $("profileNameOut").textContent = displayName(wallet);
      $("profileWalletOut").textContent = shortWallet(wallet);
      $("profileBioOut").textContent = details.bio || "no bio yet.";
      $("profileSolscanLink").href = getExplorerAccountUrl(wallet);
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
      renderProfileTabs(wallet);

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

    $("profileTabBalances").addEventListener("click", () => setActiveProfileTab("balances"));
    $("profileTabCoins").addEventListener("click", () => setActiveProfileTab("coins"));
    $("profileTabRewards").addEventListener("click", () => setActiveProfileTab("rewards"));
    $("profileTabFollowers").addEventListener("click", () => setActiveProfileTab("followers"));

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
      refreshRoomOnchainSnapshot(roomId, { force: true }).then(() => {
        if(activeRoomId === roomId) renderRoom(roomId);
      });

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
    function updatePingersToggleLabel(roomId){
      const toggle = $("pingersToggle");
      if(!toggle) return;
      const tri = pingersOpen ? "▾" : "▸";
      const r = roomById(roomId || activeRoomId);
      const snapshot = r ? getRoomEscrowSnapshot(r) : null;
      const pendingCount = Number(snapshot?.pendingWallets?.length || 0);
      const pendingSuffix = pendingCount > 0 ? ` (${pendingCount} pending)` : "";
      toggle.textContent = `pingers ${tri}${pendingSuffix}`;
    }
    const pingersToggle = $("pingersToggle");
    if(pingersToggle){
      pingersToggle.addEventListener("click", () => {
        pingersOpen = !pingersOpen;
        updatePingersToggleLabel(activeRoomId);
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
          if(isApprover(r, wallet)) extras += `<span class="k">approver</span>`;
          else if(isApproved(r, wallet)) extras += `<span class="k">pinger</span>`;
          else if(isPending(r, wallet)) extras += `<span class="k">pending approval</span>`;

          const thread = state.onchain?.[roomId] || {};
          if(thread.byWallet?.[wallet]){
            console.log("[pingy] deposit status runtime", {
              wallet,
              rawStatus: thread.byWallet[wallet].status,
              rawStatusType: typeof thread.byWallet[wallet].status,
              normalizedStatus: statusToString(thread.byWallet[wallet].status),
            });
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

        if(!isSys){
          const whoName = row.querySelector(".whoName");
          if(whoName){
            whoName.innerHTML = "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "walletLink";
            btn.textContent = displayName(m.wallet);
            btn.addEventListener("click", () => openProfile(m.wallet));
            whoName.appendChild(btn);
          }
        }

        row.querySelector(".copyBtn").addEventListener("click", () => copyToClipboard(m.wallet));

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
      const denied = !!(connectedWallet && r && r.blockedWallets && r.blockedWallets[connectedWallet]);
      const enabled = !!connectedWallet && !denied;
      $("msgInput").disabled = !enabled;
      $("sendBtn").disabled = !enabled;
      $("msgInput").placeholder = denied ? "denied — chat is read-only" : (enabled ? "message" : "connect wallet");
    }


    async function approveWallet(roomId, wallet){
      if(!onchainEnabled) return showToast("On-chain disabled: PROGRAM_ID misconfigured");
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isApprover(r, connectedWallet)) return;
      if(!isPending(r, wallet)) return;
      try{
        await approveUserTx(roomId, wallet);
      } catch(e){
        reportTxError(e, "approve transaction failed");
        return;
      }

      addSystemEvent(roomId, `@${shortWallet(wallet)} approved — now a PINGER`);
      await refreshRoomOnchainSnapshot(roomId, { force: true });
      await refreshConnectedWalletEscrowLine(roomId);
      renderRoom(roomId);
      renderHome();
    }

    async function denyWallet(roomId, wallet){
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isApprover(r, connectedWallet)) return;
      if(isApproved(r, wallet)) return showToast("approved pingers are permanent");
      if(r.blockedWallets && r.blockedWallets[wallet]) return;
      r.blockedWallets = r.blockedWallets || {};
      r.blockedWallets[wallet] = true;
      r.approval = r.approval || {};
      r.approval[wallet] = "denied";
      addSystemEvent(roomId, `@${shortWallet(wallet)} denied — wallet is now blocked from ping + chat.`);
      await refreshConnectedWalletEscrowLine(roomId);
      renderRoom(roomId);
      renderHome();
    }

    async function toggleApproverWallet(roomId, wallet){
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
      await refreshRoomOnchainSnapshot(roomId, { force: true });
      renderRoom(roomId);
      renderHome();
    }

    function renderRoom(roomId){
      const r = roomById(roomId);
      if(!r) return;

      maybeAdvance(r);

      $("roomTitle").textContent = r.name + "  $" + r.ticker;
      const roomMeta = $("roomMeta");
      roomMeta.textContent = "";
      roomMeta.appendChild(document.createTextNode("creator: "));
      const creatorLink = document.createElement("a");
      creatorLink.href = "#/profile/" + encodeURIComponent(r.creator_wallet);
      creatorLink.style.textDecoration = "underline";
      creatorLink.style.color = "inherit";
      creatorLink.textContent = displayName(r.creator_wallet);
      creatorLink.title = r.creator_wallet || "";
      creatorLink.addEventListener("click", (e) => {
        e.preventDefault();
        navigateHash("profile/" + encodeURIComponent(r.creator_wallet));
      });
      roomMeta.appendChild(creatorLink);
      roomMeta.appendChild(document.createTextNode(` • created: ${r.created_at}`));

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

      const snapshot = getRoomEscrowSnapshot(r);
      const pending = (snapshot.pendingWallets || []).slice();
      const pingers = (snapshot.approvedWallets || []).slice();
      const approvers = (snapshot.approverWallets || []).filter((w) => isApprover(r, w));
      const thread = state.onchain?.[roomId] || {};
      r.onchain = thread;
      if(thread.spawn_target_lamports) r.spawn_target_sol = Number(thread.spawn_target_lamports || 0) / LAMPORTS_PER_SOL;
      if(thread.min_approved_wallets) r.min_approved_wallets = Number(thread.min_approved_wallets || 0);
      if(thread.max_wallet_share_bps) r.max_wallet_share_bps = Number(thread.max_wallet_share_bps || 0);
      const threadAdminPubkey = thread.admin_pubkey || thread.admin;
      const walletPubkey = connectedWallet;
      const isAdmin = !!threadAdminPubkey && !!walletPubkey && toBase58String(threadAdminPubkey) === toBase58String(walletPubkey);

      const pendingList = $("pendingList");
      const pingersList = $("pingersList");
      const approversList = $("approversList");

      const makeWalletRow = (wallet, walletRow = {}, actions = []) => {
        const row = document.createElement("div");
        row.className = "row";
        row.style.marginTop = "4px";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";

        const left = document.createElement("div");
        left.className = "tiny";
        const allocated = Number(walletRow.allocated_sol || 0);
        left.innerHTML = "";
        const walletBtn = document.createElement("button");
        walletBtn.type = "button";
        walletBtn.className = "walletLink";
        walletBtn.textContent = displayName(wallet);
        walletBtn.addEventListener("click", () => openProfile(wallet));
        left.appendChild(walletBtn);
        left.appendChild(document.createTextNode(` • Allocated ${allocated.toFixed(3)} SOL`));

        const right = document.createElement("div");
        right.className = "row";
        right.style.gap = "6px";

        actions.forEach((action) => {
          const btn = document.createElement("button");
          btn.className = "btn subtle small";
          btn.textContent = action.label;
          if(action.disabled){
            btn.disabled = true;
            btn.title = action.title || "coming soon";
          } else {
            btn.addEventListener("click", action.onClick);
          }
          right.appendChild(btn);
        });

        row.appendChild(left);
        if(actions.length > 0) row.appendChild(right);
        return row;
      };

      if(pendingList){
        pendingList.innerHTML = "";
        if(!isAdmin){
          const e = document.createElement("span");
          e.className = "muted tiny";
          e.textContent = "admin only";
          pendingList.appendChild(e);
        } else if(pending.length === 0){
          const e = document.createElement("span");
          e.className = "muted tiny";
          e.textContent = "none";
          pendingList.appendChild(e);
        } else {
          pending.forEach((w) => {
            const row = makeWalletRow(
              w,
              snapshot.byWallet?.[w] || {},
              [
                { label: "approve", onClick: () => approveWallet(roomId, w) },
                { label: "deny", onClick: () => denyWallet(roomId, w) }
              ]
            );
            pendingList.appendChild(row);
          });
        }
      }

      if(pingersList){
        pingersList.innerHTML = "";
        if(pingers.length === 0){
          const e = document.createElement("span");
          e.className = "muted tiny";
          e.textContent = "none";
          pingersList.appendChild(e);
        } else {
          pingers.forEach((w) => {
            const actions = [];
            pingersList.appendChild(makeWalletRow(w, snapshot.byWallet?.[w] || {}, actions));
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
            const actions = [];
            if(isCreator(r, connectedWallet) && !isCreator(r, w)){
              actions.push({ label: "remove", onClick: () => toggleApproverWallet(roomId, w) });
            }
            approversList.appendChild(makeWalletRow(w, snapshot.byWallet?.[w] || {}, actions));
          });
        }
        if(isCreator(r, connectedWallet)){
          const soon = document.createElement("button");
          soon.className = "btn subtle small";
          soon.textContent = "add approver (coming soon)";
          soon.disabled = true;
          soon.style.marginTop = "6px";
          approversList.appendChild(soon);
        }
      }

      updatePingersToggleLabel(roomId);

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
      const phaseBarWrap = phaseBar ? phaseBar.parentElement : null;

      if(r.state === "SPAWNING"){
        phaseLabel.textContent = "Raising launch liquidity";
        statePill.textContent = "SPAWNING";
        const target = spawnTargetSol(r);
        const allocated = Number(r?.onchain?.total_allocated_lamports || 0) / 1e9;
        const progress = target > 0
          ? Math.min(allocated / target, 1)
          : 0;
        phaseBar.style.width = Math.round(progress * 100) + "%";
        phaseBar.style.background = "#ff6eb1";
        if(phaseBarWrap){
          phaseBarWrap.className = "bar barActive barSpawn";
          const sparkEl = phaseBarWrap.querySelector(".barSpark");
          if(sparkEl) sparkEl.remove();
        }
        const progressLine = $("spawnProgressLine");
        if(progressLine){
          const approvedCount = Number(r?.onchain?.approved_count || 0);
          const minApproved = minApprovedWalletsRequired(r);
          progressLine.textContent = `Allocated: ${allocated.toFixed(3)} / ${target.toFixed(3)} SOL • Approved wallets: ${approvedCount} / ${minApproved} • Max per wallet: ${walletCapSol(r).toFixed(3)} SOL`;
        }
      } else if(r.state === "BONDING"){
        phaseLabel.textContent = "BONDING";
        statePill.textContent = "BONDING";
        const bondProgress = bondingProgress01(r);
        const hotBonding = bondProgress >= 0.9;
        phaseBar.style.width = Math.round(bondProgress*100) + "%";
        phaseBar.style.background = hotBonding ? "#46d36f" : "#84d4ff";
        if(phaseBarWrap){
          phaseBarWrap.className = hotBonding ? "bar barActive barBonding barHot" : "bar barActive barBonding";
          let sparkEl = phaseBarWrap.querySelector(".barSpark");
          if(hotBonding && !sparkEl){
            sparkEl = document.createElement("span");
            sparkEl.className = "barSpark";
            phaseBarWrap.appendChild(sparkEl);
          }
          if(!hotBonding && sparkEl) sparkEl.remove();
        }
        const progressLine = $("spawnProgressLine");
        if(progressLine) progressLine.textContent = `trading fee: ${POST_SPAWN_TRADING_FEE_BPS / 100}% (displayed only; enforcement depends on trade routing)`;
      } else {
        phaseLabel.textContent = "BONDED";
        statePill.textContent = "BONDED";
        phaseBar.style.width = "100%";
        phaseBar.style.background = "#46d36f";
        if(phaseBarWrap){
          phaseBarWrap.className = "bar";
          const sparkEl = phaseBarWrap.querySelector(".barSpark");
          if(sparkEl) sparkEl.remove();
        }
        const progressLine = $("spawnProgressLine");
        if(progressLine) progressLine.textContent = `trading fee: ${POST_SPAWN_TRADING_FEE_BPS / 100}% (displayed only; enforcement depends on trade routing)`;
      }

      const me =
        (r.state === "SPAWNING")
          ? `you: ${myEscrow(roomId).toFixed(3)} SOL escrow`
          : `you: ${myBond(roomId).toFixed(3)} SOL position`;
      $("meLine").textContent = connectedWallet ? me : "connect wallet";
      if(connectedWallet && r.state === "SPAWNING") refreshConnectedWalletEscrowLine(roomId);

      $("pingBtn").disabled = !connectedWallet || !!(connectedWallet && r.blockedWallets && r.blockedWallets[connectedWallet]);
      $("unpingBtn").disabled = !connectedWallet || r.state !== "SPAWNING";

      setComposerState(r);
      renderChat(roomId);
    }

    // Ping / Unping flow
    // Use an explicit room id for modals so home-card clicks can't race view changes.
    let modalRoomId = null;
    function computeMaxPingLamports(room, userDeposit = {}){
      const targetLamports = Number(room?.onchain?.spawn_target_lamports || 0);
      const totalAllocatedLamports = Number(room?.onchain?.total_allocated_lamports || 0);
      const presetCapLamports = presetWalletCapLamports(room?.launch_preset);
      const userAllocatedLamports = Number(userDeposit?.allocated_lamports || 0);
      if(targetLamports <= 0 || presetCapLamports <= 0) return 0;
      const need = Math.max(0, targetLamports - totalAllocatedLamports);
      const walletRemaining = Math.max(0, presetCapLamports - userAllocatedLamports);
      return Math.max(0, Math.min(need, walletRemaining));
    }

    function updatePingAllocationHint(roomId){
      const hint = $("pingAllocationHint");
      if(!hint) return;
      const r = roomById(roomId || activeRoomId);
      if(!r){
        hint.textContent = "Max: 0.000 SOL";
        state.maxPingLamports = 0;
        return;
      }
      const pingConfirm = $("pingConfirm");
      if(r.state !== "SPAWNING"){
        state.maxPingLamports = 0;
        hint.textContent = "Max applies during spawning.";
        if(pingConfirm) pingConfirm.disabled = false;
        return;
      }
      const userDeposit = state.userEscrow || {};
      const maxLamports = computeMaxPingLamports(r, userDeposit);
      state.maxPingLamports = maxLamports;
      const maxSol = maxLamports / LAMPORTS_PER_SOL;
      hint.textContent = maxLamports > 0 ? `Max: ${maxSol.toFixed(3)} SOL` : "Spawn is full or you're at cap.";
      if(pingConfirm) pingConfirm.disabled = maxLamports <= 0;
    }

    function openPingModal(roomId){
      if(!connectedWallet) return showToast("connect wallet first.");
      const rid = roomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      r.onchain = state.onchain?.[rid] || r.onchain || {};
      modalRoomId = rid;
      $("pingAmount").value = "";
      state.maxPingLamports = 0;
      $("pingRoomLine").textContent = `coin: ${r.name}  $${r.ticker}`;
      updatePingAllocationHint(rid);
      openModal($("pingBack"));
    }
    function openUnpingModal(roomId){
      if(!connectedWallet) return showToast("connect wallet first.");
      const rid = roomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      r.onchain = state.onchain?.[rid] || r.onchain || {};
      if(r.state !== "SPAWNING") return alert("unping is only available before spawn.");
      modalRoomId = rid;
      $("unpingAmount").value = "full withdraw";
      $("unpingRoomLine").textContent = `coin: ${r.name}  $${r.ticker}`;
      openModal($("unpingBack"));
    }
    $("pingBtn").addEventListener("click", () => openPingModal(activeRoomId));
    $("pingAmount").addEventListener("input", () => updatePingAllocationHint(modalRoomId || activeRoomId));
    $("pingMaxBtn").addEventListener("click", () => {
      const maxLamports = Number(state.maxPingLamports || 0);
      const input = $("pingAmount");
      if(!input) return;
      input.value = (maxLamports / LAMPORTS_PER_SOL).toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
      updatePingAllocationHint(modalRoomId || activeRoomId);
    });
    $("unpingBtn").addEventListener("click", () => openUnpingModal(activeRoomId));
    $("pingWalletSmokeTest").addEventListener("click", runWalletSmokeTest);
    function nudgeChange(r, delta){
      r.change_pct = Number(r.change_pct || 0) + delta;
      r.change_pct = Math.max(-99, Math.min(999, r.change_pct));
    }

    $("pingConfirm").addEventListener("click", async () => {
      const rid = modalRoomId || activeRoomId;
      traceStep("pingConfirm:clicked", { rid, connectedWallet: connectedWallet || null }, "ping trace: confirm clicked");
      const r = roomById(rid);
      if(!r) return;
      r.onchain = state.onchain?.[rid] || r.onchain || {};
      const s = ($("pingAmount").value||"").trim();
      const solAmount = Number(s);
      if(!s || Number.isNaN(solAmount) || solAmount <= 0) return alert("enter a valid SOL amount.");

      if(r.state === "SPAWNING"){
        if(r.blockedWallets && r.blockedWallets[connectedWallet]) return alert("you were denied from this spawn.");
        if(!isCreator(r, connectedWallet)){
          r.approval = r.approval || {};
          if(!r.approval[connectedWallet]) r.approval[connectedWallet] = "pending";
        }
        if(shouldUseOnchain()){
          const amountLamports = Math.round(solAmount * 1_000_000_000);
          if(!Number.isInteger(amountLamports) || amountLamports <= 0) return alert("enter at least 1 lamport.");
          const maxAllowedLamports = Number(state.maxPingLamports || computeMaxPingLamports(r, state.userEscrow || {}));
          if(amountLamports > (maxAllowedLamports + 1)){
            showToast(`Too much. Max is ${(maxAllowedLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL.`);
            return;
          }
          console.log("[ping-debug] amount conversion", { solAmount, amountLamports });
          const walletPk = new PublicKey(connectedWallet);
          const [threadPda] = await deriveThreadPda(rid);
          const [depositPda] = await deriveDepositPda(rid, walletPk);
          const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
          const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
          const threadInfo = await connection.getAccountInfo(threadPda, "confirmed");

          const escrowInfoBefore = await connection.getAccountInfo(threadEscrowPda, "confirmed");
          const balBefore = escrowInfoBefore ? await connection.getBalance(threadEscrowPda, "confirmed") : 0;
          try {
            const sig = await pingWithOptionalThreadInitTx(rid, amountLamports, !threadInfo);
            const escrowInfoAfter = await connection.getAccountInfo(threadEscrowPda, "confirmed");
            const balAfter = escrowInfoAfter ? await connection.getBalance(threadEscrowPda, "confirmed") : 0;
            const deltaLamports = Number(balAfter || 0) - Number(balBefore || 0);
            const deltaSol = deltaLamports / 1_000_000_000;
            console.log("[ping-debug] deposit balance delta", {
              depositPda: depositPda.toBase58(),
              threadEscrowPda: threadEscrowPda.toBase58(),
              balBefore,
              balAfter,
              deltaLamports,
              deltaSol,
              expectedLamports: amountLamports,
              txExplorer: explorerTxUrl(sig),
              escrowExplorer: explorerAddressUrl(threadEscrowPda.toBase58()),
            });
            showToast(`Thread escrow deposit +${deltaSol.toFixed(9)} SOL (expected ~${solAmount} SOL)`);
            console.log("[ping-debug] explorer links", {
              tx: explorerTxUrl(sig),
              threadEscrow: explorerAddressUrl(threadEscrowPda.toBase58()),
            });
          } catch(e){
            if(isUserBannedError(e)){
              showToast("You were denied from this coin and can’t re-enter.");
            } else {
              reportTxError(e, "ping deposit transaction failed");
            }
            console.error("[ping-debug] context", {
              connectedWallet,
              DEVNET_RPC,
              SOLANA_CLUSTER,
              programId: PROGRAM_ID.toBase58(),
              threadPda: threadPda.toBase58(),
              depositPda: depositPda.toBase58(),
              threadEscrowPda: threadEscrowPda.toBase58(),
              spawnPoolPda: spawnPoolPda.toBase58(),
              vault: null,
              solAmount,
              amountLamports,
            });
            return;
          }
        } else {
          applySpawnCommit(r, connectedWallet, solAmount);
        }

        state.chat[r.id] = state.chat[r.id] || [];
        const statusText = isApproved(r, connectedWallet) ? "approved" : "pending approval";
        state.chat[r.id].push({ ts: nowStamp(), wallet: "SYSTEM", text:`@${shortWallet(connectedWallet)} pinged ${solAmount.toFixed(3)} SOL (${statusText})` });

        maybeAdvance(r);

      } else if(r.state === "BONDING") {
        r.positions[connectedWallet] = r.positions[connectedWallet] || {escrow_sol:0, bond_sol:0, spawn_tokens:0};
        r.positions[connectedWallet].bond_sol = Number(r.positions[connectedWallet].bond_sol||0) + solAmount;

        const add = Math.round(solAmount * SOL_TO_USD * 12);
        r.market_cap_usd = Number(r.market_cap_usd||0) + add;
        nudgeChange(r, Math.random()*3);

        maybeAdvance(r);

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`bought ${solAmount.toFixed(3)} SOL on curve.` });
      }

      closeModal($("pingBack"));
      await fetchRoomOnchainSnapshot(rid);
      await fetchConnectedWalletDepositSnapshot();
      renderRoom(rid);
      r._pulseUntil = Date.now() + 900;
      r._lastActivity = Date.now();
      renderHome();
    });

    $("unpingConfirm").addEventListener("click", async () => {
      const rid = modalRoomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      r.onchain = state.onchain?.[rid] || r.onchain || {};
      if(r.state === "SPAWNING"){
        const curLamports = await fetchConnectedWalletDepositLamports(rid);
        const cur = Number(curLamports || 0) / LAMPORTS_PER_SOL;
        if(cur <= 0) return alert("you have no escrow to withdraw.");
        if(shouldUseOnchain()){
          try{
            await unpingWithdrawTx(rid);
          } catch(e){
            reportTxError(e, "unping transaction failed");
            return;
          }
          showToast("Withdraw complete — funds returned to wallet.");
        } else {
          applySpawnUncommit(r, connectedWallet, cur);
        }

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`withdrew ${cur.toFixed(3)} SOL (full escrow withdrawal, returned to wallet).` });

      } else {
        return alert("unping is disabled after spawn.");
      }

      closeModal($("unpingBack"));
      await fetchRoomOnchainSnapshot(rid);
      await fetchConnectedWalletDepositSnapshot();
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
      if(!canPost(r)) return alert(isDenied(r, connectedWallet) ? "you were denied from chat for this coin." : "ping to post.");

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

    const LEGAL_PAGES = {
      privacy: {
        title: "Privacy Policy",
        body: `
          <p>We collect your wallet address, on-chain transaction data, basic usage analytics (if any), and optional display name details you provide.</p>
          <p>We do not collect passwords or seed phrases.</p>
          <p>Cookies/localStorage are used for UI preferences and local app behavior.</p>
          <p>We do not share your information except with service providers (if any) needed to operate the app.</p>
          <p>Contact: [add contact email]</p>
        `,
      },
      terms: {
        title: "Terms of Service",
        body: `
          <p>This app and its content are not financial advice.</p>
          <p>You are responsible for your trades, wallet decisions, and wallet security.</p>
          <p>Tokens and on-chain participation involve risk, including volatility and potential loss.</p>
          <p>Prohibited behavior includes spam, abuse, and attempts to harm the app or other users.</p>
          <p>Limitation of liability: use is at your own risk to the maximum extent allowed by law.</p>
          <p>We may change these terms over time by posting updated terms in-app.</p>
        `,
      },
      fees: {
        title: "Fees",
        body: `
          <p>Current fees: 0% platform fee; network fees apply. Future fees may be introduced with notice.</p>
          <p>This includes spawn flow, transactions, and creator-related actions unless explicitly stated otherwise in future updates.</p>
        `,
      },
      revenue: {
        title: "Revenue",
        body: `
          <p>Pingy may generate revenue through optional platform fees in the future.</p>
          <p>Featured listings or promotional placements may also be introduced as optional revenue sources.</p>
          <p>Today, there may be no platform revenue while the product is in early stages.</p>
          <p>We aim to keep any monetization approach transparent to users.</p>
        `,
      },
    };

    function renderLegalPage(key){
      const page = LEGAL_PAGES[key];
      if(!page){
        setView("home");
        renderHome();
        return;
      }
      setView("legal");
      $("legalTitle").textContent = page.title;
      $("legalContent").innerHTML = page.body;
    }

    // Hash routing
    function handleHash(){
      const h = (location.hash || "").replace(/^#/, "");
      console.log("[pingy] handleHash:", h || "<empty>");
      if(!h){
        setView("home");
        renderHome();
        return;
      }

      const clean = h.replace(/^\//, "");
      const parts = clean.split("/").filter(Boolean);

      if(parts[0] === "home"){
        setView("home");
        renderHome();
        return;
      }

      if(parts[0] === "profile"){
        setView("profile");
        renderProfilePage();
        return;
      }

      if(["privacy", "terms", "fees", "revenue"].includes(parts[0])){
        renderLegalPage(parts[0]);
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
      if(activeRoomId){
        refreshRoomOnchainSnapshot(activeRoomId);
        renderRoom(activeRoomId);
      }
      if(homeView?.classList.contains("on")){
        for(const room of state.rooms) refreshRoomOnchainSnapshot(room.id);
      }
      if(profileView.classList.contains("on") && activeProfileTab === "balances"){
        const wallet = profileRouteWallet();
        if(wallet) refreshWalletBalances(wallet);
      }
      if(profileView.classList.contains("on")) renderProfilePage();
    }

    if(!location.hash) navigateHash("home");
    (async () => {
      const provider = getProvider();
      if(!provider) return;
      bindWalletListeners(provider);
      try{
        const resp = await providerConnect(provider, { onlyIfTrusted: true });
        if(resp && resp.publicKey){
          setConnectedWallet(resp.publicKey.toBase58());
          await refreshRoomFromChain();
    refreshWalletViews();
        }
      } catch(e){
        // ignore untrusted/no-session restore failures
      }
    })();
    handleHash();
    setInterval(tick, 900);

    await validateOnchainConfig();
    window.__PINGY_READY__ = true;
    console.log("[pingy] init complete");
    }

    let initStarted = false;
    function startInit(){
      if(initStarted) return;
      initStarted = true;
      init().catch(reportFatal);
    }

    if(document.readyState === "loading"){
      window.addEventListener("DOMContentLoaded", startInit, { once: true });
    } else {
      startInit();
    }
