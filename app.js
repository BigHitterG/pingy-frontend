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
      fetchProgramAccounts,
    };

    console.log('[pingy] app.js loaded');
    console.log("[pingy] window.phantom?.solana:", window.phantom?.solana);
    console.log("[pingy] window.solana:", window.solana);
    console.log("[pingy] window.solana?.isPhantom:", window.solana?.isPhantom);
    console.log("[pingy] window.solana?.providers:", window.solana?.providers);

    // Tuned assumptions
    const SOL_TO_USD = 100; // internal conversion (mock) — for display only
    const LAMPORTS_PER_SOL = 1_000_000_000;

    // Single-curve launch model (opening buy initializes live curve)
    const TOTAL_SUPPLY = 1_000_000_000;
    const VIRTUAL_SOL_RESERVE_INITIAL = 30;
    const VIRTUAL_TOKEN_RESERVE_INITIAL = TOTAL_SUPPLY;
    const MC_SPAWN_FLOOR = 6600;
    const GRADUATION_MARKET_CAP = 66000;
    const SPAWN_FEE_BPS = 100;
    const POST_SPAWN_TRADING_FEE_BPS = 100;
    const BPS_DENOM = 10_000;

    const DEV_SIMULATION = !!(window?.location?.hostname === "localhost" || window?.location?.hostname === "127.0.0.1" || window?.location?.hostname === "0.0.0.0" || window?.location?.hostname?.endsWith?.(".local") || window?.location?.search?.includes("devsim=1"));
    const DEV_SIM_DEFAULT_SEED = 1337;


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
    // Curve + position helpers
    // ----------------------------
    function makeCurveState(){
      return {
        virtual_sol_reserve: VIRTUAL_SOL_RESERVE_INITIAL,
        virtual_token_reserve: VIRTUAL_TOKEN_RESERVE_INITIAL,
        opening_buy_sol: 0,
        opening_buy_tokens: 0,
      };
    }

    function curveBuyTokens(solIn, curveState){
      const s = Math.max(0, Number(solIn || 0));
      const x = Math.max(1e-9, Number(curveState?.virtual_sol_reserve || VIRTUAL_SOL_RESERVE_INITIAL));
      const y = Math.max(1e-9, Number(curveState?.virtual_token_reserve || VIRTUAL_TOKEN_RESERVE_INITIAL));
      if(s <= 0) return 0;
      const k = x * y;
      const nextY = k / (x + s);
      return Math.max(0, Math.min(y, y - nextY));
    }

    function curvePrice(curveState){
      const x = Math.max(1e-9, Number(curveState?.virtual_sol_reserve || VIRTUAL_SOL_RESERVE_INITIAL));
      const y = Math.max(1e-9, Number(curveState?.virtual_token_reserve || VIRTUAL_TOKEN_RESERVE_INITIAL));
      return x / y;
    }

    function curveMarketCap(curveState){
      const priceSol = curvePrice(curveState);
      return priceSol * TOTAL_SUPPLY * SOL_TO_USD;
    }

    function applyCurveBuy(solIn, curveState){
      const buySol = Math.max(0, Number(solIn || 0));
      const current = curveState || makeCurveState();
      const tokensOut = curveBuyTokens(buySol, current);
      const next = {
        ...current,
        virtual_sol_reserve: Number(current.virtual_sol_reserve || 0) + buySol,
        virtual_token_reserve: Math.max(0, Number(current.virtual_token_reserve || 0) - tokensOut),
      };
      return { next, tokensOut };
    }

    function applyTradingFeeToBuySol(solIn){
      const grossSol = Math.max(0, Number(solIn || 0));
      const feeSol = grossSol * (POST_SPAWN_TRADING_FEE_BPS / BPS_DENOM);
      const netSol = Math.max(0, grossSol - feeSol);
      return { grossSol, feeSol, netSol };
    }

    function curveSellSol(tokenIn, curveState){
      const t = Math.max(0, Number(tokenIn || 0));
      const x = Math.max(1e-9, Number(curveState?.virtual_sol_reserve || VIRTUAL_SOL_RESERVE_INITIAL));
      const y = Math.max(1e-9, Number(curveState?.virtual_token_reserve || VIRTUAL_TOKEN_RESERVE_INITIAL));
      if(t <= 0) return 0;
      const k = x * y;
      const nextX = k / (y + t);
      return Math.max(0, Math.min(x, x - nextX));
    }

    function applyCurveSell(tokenIn, curveState){
      const sellTokens = Math.max(0, Number(tokenIn || 0));
      const current = curveState || makeCurveState();
      const grossSolOut = curveSellSol(sellTokens, current);
      const next = {
        ...current,
        virtual_sol_reserve: Math.max(0, Number(current.virtual_sol_reserve || 0) - grossSolOut),
        virtual_token_reserve: Number(current.virtual_token_reserve || 0) + sellTokens,
      };
      return { next, grossSolOut };
    }

    function applyTradingFeeToSellSol(solOut){
      const grossSol = Math.max(0, Number(solOut || 0));
      const feeSol = grossSol * (POST_SPAWN_TRADING_FEE_BPS / BPS_DENOM);
      const netSol = Math.max(0, grossSol - feeSol);
      return { grossSol, feeSol, netSol };
    }

    function syncRoomMarketCap(r){
      if(!r) return;
      if(!r.curve_state) r.curve_state = makeCurveState();
      r.market_cap_usd = curveMarketCap(r.curve_state);
    }

    function ensureTradeHistory(r){
      if(!r) return [];
      if(!Array.isArray(r.trade_history)) r.trade_history = [];
      return r.trade_history;
    }

    function appendBondingTradeEvent(r, event){
      if(!r || !event) return;
      ensureTradeHistory(r).push(event);
    }

    function ensurePos(r, wallet){
      r.positions = r.positions || {};
      if(!r.positions[wallet]) r.positions[wallet] = { escrow_sol:0, net_sol_in:0, spawn_tokens:0, token_balance:0 };
      if(r.positions[wallet].spawn_tokens == null) r.positions[wallet].spawn_tokens = 0;
      if(r.positions[wallet].escrow_sol == null) r.positions[wallet].escrow_sol = 0;
      if(r.positions[wallet].net_sol_in == null) r.positions[wallet].net_sol_in = 0;
      if(r.positions[wallet].token_balance == null) r.positions[wallet].token_balance = 0;
      return r.positions[wallet];
    }

    const PRESETS = {
      fast: { key: "fast", label: "Fast", minWallets: 10, targetSol: 3, maxWalletShareBps: 1000 },
      balanced: { key: "balanced", label: "Balanced", minWallets: 20, targetSol: 5, maxWalletShareBps: 700 },
      high_quality: { key: "high_quality", label: "High Quality", minWallets: 30, targetSol: 8, maxWalletShareBps: 500 },
    };
    const CREATE_LIMITS = {
      minApprovedWalletsMin: 10,
      minApprovedWalletsMax: 50,
      spawnTargetSolMin: 1,
      spawnTargetSolMax: 100,
      maxWalletSharePctMin: 2,
      maxWalletSharePctMax: 20,
    };

    function getCreateLaunchMode(){
      return String($("newLaunchMode")?.value || "spawn").toLowerCase() === "instant" ? "instant" : "spawn";
    }

    function selectedPresetKey(){
      return String($("newPreset")?.value || "fast").toLowerCase();
    }

    function selectedPreset(){
      const key = selectedPresetKey();
      return PRESETS[key] || PRESETS.fast;
    }

    function asNumberInputValue(id){
      const raw = ($(id)?.value || "").trim();
      if(!raw) return NaN;
      return Number(raw);
    }

    function getCreateLaunchConfig(){
      const launchMode = getCreateLaunchMode();
      if(launchMode === "instant"){
        return {
          launchMode: "instant",
          launchPreset: null,
          minApprovedWallets: 0,
          spawnTargetSol: 0,
          spawnTargetLamports: 0,
          maxWalletShareBps: 0,
          maxWalletSharePct: 0,
          capPerWalletSol: 0,
        };
      }

      const mode = selectedPresetKey();
      if(mode !== "custom"){
        const preset = PRESETS[mode] || PRESETS.fast;
        const spawnTargetSol = Number(preset.targetSol || 0);
        const maxWalletShareBps = Number(preset.maxWalletShareBps || 0);
        const maxWalletSharePct = maxWalletShareBps / 100;
        return {
          launchMode: "spawn",
          launchPreset: preset.key,
          minApprovedWallets: Number(preset.minWallets || 0),
          spawnTargetSol,
          spawnTargetLamports: Math.round(spawnTargetSol * LAMPORTS_PER_SOL),
          maxWalletShareBps,
          maxWalletSharePct,
          capPerWalletSol: spawnTargetSol * (maxWalletShareBps / 10000),
        };
      }

      const minApprovedWallets = asNumberInputValue("customMinWallets");
      const spawnTargetSol = asNumberInputValue("customSpawnTargetSol");
      const maxWalletSharePct = asNumberInputValue("customMaxWalletSharePct");
      const maxWalletShareBps = Math.round(maxWalletSharePct * 100);
      return {
        launchMode: "spawn",
        launchPreset: "custom",
        minApprovedWallets,
        spawnTargetSol,
        spawnTargetLamports: Math.round(spawnTargetSol * LAMPORTS_PER_SOL),
        maxWalletShareBps,
        maxWalletSharePct,
        capPerWalletSol: spawnTargetSol * (maxWalletShareBps / 10000),
      };
    }

    function validateCreateLaunchConfig(config){
      const c = config || {};
      if(c.launchMode === "instant") return { ok:true, config: c };
      if(!Number.isFinite(c.minApprovedWallets) || !Number.isInteger(c.minApprovedWallets)){
        return { ok:false, message: "Minimum approved wallets must be between 10 and 50." };
      }
      if(c.minApprovedWallets < CREATE_LIMITS.minApprovedWalletsMin || c.minApprovedWallets > CREATE_LIMITS.minApprovedWalletsMax){
        return { ok:false, message: "Minimum approved wallets must be between 10 and 50." };
      }
      if(!Number.isFinite(c.spawnTargetSol)){
        return { ok:false, message: `Spawn target must be between ${CREATE_LIMITS.spawnTargetSolMin} and ${CREATE_LIMITS.spawnTargetSolMax} SOL.` };
      }
      if(c.spawnTargetSol < CREATE_LIMITS.spawnTargetSolMin || c.spawnTargetSol > CREATE_LIMITS.spawnTargetSolMax){
        return { ok:false, message: `Spawn target must be between ${CREATE_LIMITS.spawnTargetSolMin} and ${CREATE_LIMITS.spawnTargetSolMax} SOL.` };
      }
      if(!Number.isFinite(c.maxWalletSharePct)){
        return { ok:false, message: "Max wallet share must be between 2% and 20%." };
      }
      if(c.maxWalletSharePct < CREATE_LIMITS.maxWalletSharePctMin || c.maxWalletSharePct > CREATE_LIMITS.maxWalletSharePctMax){
        return { ok:false, message: "Max wallet share must be between 2% and 20%." };
      }
      if(!Number.isFinite(c.maxWalletShareBps) || c.maxWalletShareBps < 200 || c.maxWalletShareBps > 2000){
        return { ok:false, message: "Max wallet share must be between 2% and 20%." };
      }
      if(!Number.isInteger(c.spawnTargetLamports) || c.spawnTargetLamports <= 0){
        return { ok:false, message: "Spawn target amount is invalid." };
      }
      return { ok:true, config: c };
    }

    function roomLaunchMode(room){
      return String(room?.launch_mode || "spawn").toLowerCase() === "instant" ? "instant" : "spawn";
    }

    function roomLaunchLabel(room){
      if(roomLaunchMode(room) === "instant") return "Instant";
      const key = String(room?.launch_preset || "").toLowerCase();
      if(key === "custom") return "Spawn • Custom";
      return `Spawn • ${(PRESETS[key] || PRESETS.fast).label}`;
    }
    function roomPreset(room){
      const r = room || {};
      const key = String(r.launch_preset || "fast").toLowerCase();
      const base = PRESETS[key] || PRESETS.fast;
      return {
        ...base,
        key: key === "custom" ? "custom" : base.key,
        label: key === "custom" ? "Custom" : base.label,
        minWallets: Number(r.min_approved_wallets || base.minWallets),
        targetSol: Number(r.spawn_target_sol || base.targetSol),
        maxWalletShareBps: Number(r.max_wallet_share_bps || base.maxWalletShareBps),
      };
    }

    function spawnTargetSol(room){
      const lamports = room?.onchain?.spawn_target_lamports;
      if (typeof lamports === "number") return lamports / 1e9;
      return Number(roomPreset(room).targetSol || 0);
    }

    function minApprovedWalletsRequired(room){
      const roomMin = room?.min_approved_wallets;
      if(typeof roomMin === "number") return roomMin;
      const onchainMin = room?.onchain?.min_approved_wallets;
      if(typeof onchainMin === "number") return onchainMin;
      return Number(roomPreset(room).minWallets || 0);
    }

    function roomMaxWalletShareBps(room){
      const onchainBps = room?.onchain?.max_wallet_share_bps;
      if(typeof onchainBps === "number" && onchainBps > 0) return onchainBps;
      return Number(roomPreset(room).maxWalletShareBps || 0);
    }

    function walletCapSol(room){
      const target = spawnTargetSol(room);
      const bps = roomMaxWalletShareBps(room);
      if (!target || !bps) return 0;
      return target * (bps / 10000);
    }

    function configWalletCapLamports(config){
      const targetLamports = Number(config?.spawnTargetLamports || 0);
      const shareBps = Number(config?.maxWalletShareBps || 0);
      if(targetLamports <= 0 || shareBps <= 0) return 0;
      return Math.floor((targetLamports * shareBps) / BPS_DENOM);
    }

    function updatePresetCapHint(){
      const hint = $("presetCapHint");
      const panel = $("customLaunchPanel");
      const summary = $("customLaunchSummary");
      const error = $("customLaunchError");
      if(!hint) return;
      const config = getCreateLaunchConfig();
      const capSol = Number(config.capPerWalletSol || 0);
      const pct = Number(config.maxWalletSharePct || 0);
      const wallets = Number(config.minApprovedWallets || 0);
      const target = Number(config.spawnTargetSol || 0);
      const launchLine = `Launch requires ${wallets} approved wallets and ${target.toFixed(1)} SOL.`;
      if(config.launchPreset === "custom"){
        if(panel) panel.style.display = "block";
        if(summary){
          const capHint = capSol >= 1
            ? "Higher cap = fewer large wallets can fill the raise."
            : "Lower cap = broader initial distribution.";
          summary.innerHTML = `Cap per wallet: ${capSol.toFixed(3)} SOL (${pct.toFixed(1)}%)<br>${launchLine}<br><span class="muted">${capHint}</span>`;
        }
      } else {
        if(panel) panel.style.display = "none";
      }
      if(error) error.style.display = "none";
      hint.textContent = `Cap per wallet: ${capSol.toFixed(3)} SOL (${pct.toFixed(1)}%) • ${launchLine}`;
    }

    function updateCreateLaunchModeUI(){
      const launchMode = getCreateLaunchMode();
      const spawnWrap = $("spawnLaunchSettings");
      const instantHint = $("instantLaunchHint");
      if(spawnWrap) spawnWrap.style.display = launchMode === "spawn" ? "block" : "none";
      if(instantHint) instantHint.style.display = launchMode === "instant" ? "block" : "none";
      const customError = $("customLaunchError");
      if(launchMode === "instant" && customError){
        customError.textContent = "";
        customError.style.display = "none";
      }
      if(launchMode === "spawn") updatePresetCapHint();
    }

    function prefillCustomLaunchInputsFromPreset(presetKey){
      const preset = PRESETS[String(presetKey || "").toLowerCase()] || PRESETS.fast;
      if($("customMinWallets")) $("customMinWallets").value = String(preset.minWallets);
      if($("customSpawnTargetSol")) $("customSpawnTargetSol").value = String(preset.targetSol);
      if($("customMaxWalletSharePct")) $("customMaxWalletSharePct").value = String(preset.maxWalletShareBps / 100);
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

    let roomChart = null;
    let roomCandlesSeries = null;
    let roomLaunchTargetSeries = null;
    let roomChartContainerEl = null;
    let roomChartContextKey = "";
    let roomChartActiveCandles = [];
    let roomChartActiveCandlesRaw = [];
    let roomChartCrosshairHandler = null;
    let roomChartCrosshairBoundChart = null;
    const ROOM_CHART_UP_COLOR = "#46d36f";
    const ROOM_CHART_DOWN_COLOR = "#f06a6a";
    const ROOM_CHART_SPAWN_COLOR = "#ff6eb1";
    const ROOM_CHART_TF_SECONDS = {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "1h": 3600,
      "4h": 14400,
      "1d": 86400,
    };
    const roomChartUi = {
      timeframe: "1m",
      metric: "mcap",
      denom: "usd",
    };

    function roomChartDims(el){
      return {
        width: Math.max(1, Number(el?.clientWidth) || 300),
        height: Math.max(1, Number(el?.clientHeight) || 220),
      };
    }

    function ensureLaunchHistory(room){
      if(!room) return [];
      if(!Array.isArray(room.launch_history)) room.launch_history = [];
      return room.launch_history;
    }

    function launchPointForRoom(room, ts = nowStamp()){
      const r = room || {};
      const onchain = r.onchain || {};
      const approvedWallets = [];

      if(onchain && onchain.byWallet){
        for(const wallet of Object.keys(onchain.byWallet)){
          const status = String(onchain.byWallet[wallet]?.status || "").toLowerCase();
          if(status === "approved" || status === "swept") approvedWallets.push(wallet);
        }
      } else {
        const positions = r.positions || {};
        for(const wallet of Object.keys(positions)){
          if(Number(positions[wallet]?.escrow_sol || 0) > 0) approvedWallets.push(wallet);
        }
      }

      let allocated = 0;
      if(Number(onchain.spawn_target_lamports || 0) > 0){
        allocated = Number(onchain.total_allocated_lamports || 0) / LAMPORTS_PER_SOL;
      } else {
        const capSol = Number(walletCapSol(r) || 0);
        const positions = r.positions || {};
        for(const wallet of approvedWallets){
          const escrow = Math.max(0, Number(positions[wallet]?.escrow_sol || 0));
          allocated += capSol > 0 ? Math.min(escrow, capSol) : escrow;
        }
      }

      return {
        ts,
        allocated_sol_after: Number(allocated || 0),
        target_sol: Number(spawnTargetSol(r) || 0),
        approved_wallets_after: Number(approvedWallets.length || 0),
      };
    }

    function appendLaunchHistoryPoint(room, ts = nowStamp()){
      if(!room || room.state !== "SPAWNING") return;
      const history = ensureLaunchHistory(room);
      const next = launchPointForRoom(room, ts);
      const prev = history.length ? history[history.length - 1] : null;
      const unchanged = prev
        && Number(prev.allocated_sol_after || 0) === Number(next.allocated_sol_after || 0)
        && Number(prev.target_sol || 0) === Number(next.target_sol || 0)
        && Number(prev.approved_wallets_after || 0) === Number(next.approved_wallets_after || 0);
      if(unchanged) return;
      history.push(next);
    }

    function impliedSpawnMarketCapFromGrossSol(grossSol){
      const openingBuySol = Math.max(0, Number(grossSol || 0));
      const feeSol = openingBuySol * (SPAWN_FEE_BPS / BPS_DENOM);
      const netSol = Math.max(0, openingBuySol - feeSol);
      const baseCurveState = makeCurveState();
      const { next: impliedCurveState } = applyCurveBuy(netSol, baseCurveState);
      return Number(curveMarketCap(impliedCurveState) || 0);
    }

    function impliedSpawnScaleValue(point, room){
      const allocated = Number(point?.allocated_sol_after || 0);
      return impliedSpawnMarketCapFromGrossSol(allocated);
    }

    function parseTradeHistoryTs(ts){
      if(typeof ts === "number" && Number.isFinite(ts)) return ts;
      if(typeof ts !== "string") return null;
      const isoCandidate = ts.includes("T") ? ts : ts.replace(" ", "T");
      const parsed = Date.parse(isoCandidate);
      if(Number.isFinite(parsed)) return parsed;
      return null;
    }

    function getRoomCandles(room, intervalSeconds = 60){
      const events = ensureTradeHistory(room);
      if(!events.length) return [];

      const interval = Math.max(1, Number(intervalSeconds) || 60);
      const buckets = new Map();
      const ordered = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => Number.isFinite(Number(event?.market_cap_after)))
        .sort((a, b) => {
          const ta = parseTradeHistoryTs(a.event?.ts);
          const tb = parseTradeHistoryTs(b.event?.ts);
          if(ta == null && tb == null) return a.index - b.index;
          if(ta == null) return 1;
          if(tb == null) return -1;
          if(ta !== tb) return ta - tb;
          return a.index - b.index;
        });

      if(!ordered.length) return [];

      ordered.forEach(({ event, index }) => {
        const marketCap = Number(event.market_cap_after);
        const tsMs = parseTradeHistoryTs(event.ts);
        const fallbackTimeSec = index * interval;
        const eventTimeSec = tsMs == null
          ? fallbackTimeSec
          : Math.floor(tsMs / 1000);
        const bucketTime = Math.floor(eventTimeSec / interval) * interval;
        const existing = buckets.get(bucketTime);
        if(!existing){
          buckets.set(bucketTime, {
            time: bucketTime,
            open: marketCap,
            high: marketCap,
            low: marketCap,
            close: marketCap,
          });
          return;
        }
        existing.high = Math.max(existing.high, marketCap);
        existing.low = Math.min(existing.low, marketCap);
        existing.close = marketCap;
      });

      return Array.from(buckets.values()).sort((a,b)=>a.time-b.time);
    }

    // Aggregates OHLC candles into larger timeframe buckets while preserving chronological order.
    function aggregateCandlesByInterval(candles, intervalSeconds){
      if(!Array.isArray(candles) || !candles.length) return [];
      const interval = Math.max(60, Number(intervalSeconds) || 60);
      if(interval <= 60) return candles.map((c) => ({ ...c }));
      const buckets = new Map();

      candles.forEach((candle, index) => {
        const timeSec = Math.max(0, Number(candle?.time || 0));
        const bucketTime = Math.floor(timeSec / interval) * interval;
        const open = Number(candle?.open || 0);
        const high = Number(candle?.high || open);
        const low = Number(candle?.low || open);
        const close = Number(candle?.close || open);
        const existing = buckets.get(bucketTime);
        if(!existing){
          buckets.set(bucketTime, {
            time: bucketTime,
            open,
            high,
            low,
            close,
            __index: index,
          });
          return;
        }
        if(index < existing.__index) existing.open = open;
        existing.__index = Math.min(existing.__index, index);
        existing.high = Math.max(existing.high, high, open, close);
        existing.low = Math.min(existing.low, low, open, close);
        existing.close = close;
      });

      return Array.from(buckets.values())
        .sort((a, b) => a.time - b.time)
        .map(({ __index, ...candle }) => candle);
    }

    function chartValueFromMarketCapUsd(marketCapUsd){
      const capUsd = Math.max(0, Number(marketCapUsd || 0));
      const metricIsPrice = roomChartUi.metric === "price";
      const baseValueUsd = metricIsPrice ? (capUsd / TOTAL_SUPPLY) : capUsd;
      if(roomChartUi.denom === "sol") return baseValueUsd / SOL_TO_USD;
      return baseValueUsd;
    }

    function formatChartMetricValue(value){
      const numeric = Math.max(0, Number(value || 0));
      const metricIsPrice = roomChartUi.metric === "price";
      const denomIsSol = roomChartUi.denom === "sol";
      if(metricIsPrice){
        return denomIsSol
          ? `${numeric.toExponential(3)} SOL`
          : `$${numeric.toExponential(3)}`;
      }
      if(denomIsSol) return `${(numeric).toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL`;
      return fmtUsd(numeric);
    }

    function formatChartDateTime(timeSec){
      if(!Number.isFinite(Number(timeSec))) return "—";
      const d = new Date(Number(timeSec) * 1000);
      if(Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
    }

    function setActiveChartButton(selector, activeValue, attr){
      document.querySelectorAll(selector).forEach((btn) => {
        const selected = String(btn.getAttribute(attr) || "") === String(activeValue);
        btn.classList.toggle("active", selected);
      });
    }

    function detachRoomChartCrosshair(){
      if(roomChartCrosshairBoundChart && roomChartCrosshairHandler && typeof roomChartCrosshairBoundChart.unsubscribeCrosshairMove === "function"){
        roomChartCrosshairBoundChart.unsubscribeCrosshairMove(roomChartCrosshairHandler);
      }
      roomChartCrosshairHandler = null;
      roomChartCrosshairBoundChart = null;
      const tooltip = $("roomChartTooltip");
      if(tooltip) tooltip.hidden = true;
    }

    // Binds tooltip behavior to the active chart instance and safely rebinds on chart recreation.
    function bindRoomChartCrosshair(chart){
      if(!chart || !roomCandlesSeries) return;
      if(roomChartCrosshairBoundChart === chart && roomChartCrosshairHandler) return;
      detachRoomChartCrosshair();
      roomChartCrosshairHandler = (param) => {
        const tooltip = $("roomChartTooltip");
        const chartWrap = document.querySelector(".roomChartWrap");
        if(!tooltip || !chartWrap || !roomCandlesSeries){
          return;
        }
        const point = param?.point;
        const data = param?.seriesData?.get?.(roomCandlesSeries);
        if(!point || !data || point.x < 0 || point.y < 0){
          tooltip.hidden = true;
          return;
        }

        const room = roomById(activeRoomId);
        const isSpawning = room?.state === "SPAWNING";
        const metricLabel = isSpawning
          ? (roomChartUi.metric === "mcap" ? "Projected MCap" : "Projected Price")
          : (roomChartUi.metric === "mcap" ? "Market Cap" : "Price");
        const displayOpen = Number(data.open || 0);
        const displayHigh = Number(data.high || 0);
        const displayLow = Number(data.low || 0);
        const displayClose = Number(data.close || 0);

        tooltip.innerHTML = [
          `<b>${formatChartDateTime(Number(data.time || 0))}</b>`,
          `O: ${formatChartMetricValue(displayOpen)}`,
          `H: ${formatChartMetricValue(displayHigh)}`,
          `L: ${formatChartMetricValue(displayLow)}`,
          `C: ${formatChartMetricValue(displayClose)}`,
          `${metricLabel}: ${formatChartMetricValue(displayClose)}`,
        ].join("<br>");

        const maxLeft = Math.max(0, chartWrap.clientWidth - tooltip.offsetWidth - 8);
        const maxTop = Math.max(0, chartWrap.clientHeight - tooltip.offsetHeight - 8);
        const left = Math.min(maxLeft, Math.max(8, point.x + 14));
        const top = Math.min(maxTop, Math.max(8, point.y + 14));
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltip.hidden = false;
      };
      chart.subscribeCrosshairMove(roomChartCrosshairHandler);
      roomChartCrosshairBoundChart = chart;
    }

    // Sums positive escrow allocation deltas over the last 24h for pre-spawn lifecycle stats.
    function computeSpawnEscrowInflow24hSol(history){
      if(!Array.isArray(history) || history.length < 2) return 0;
      const nowSec = Math.floor(Date.now() / 1000);
      const lookbackSec = nowSec - (24 * 3600);
      let inflowSol = 0;
      for(let i = 1; i < history.length; i += 1){
        const cur = history[i];
        const prev = history[i - 1];
        const tsMs = parseTradeHistoryTs(cur?.ts);
        const eventSec = tsMs == null ? null : Math.floor(tsMs / 1000);
        if(eventSec != null && eventSec < lookbackSec) continue;
        const delta = Number(cur?.allocated_sol_after || 0) - Number(prev?.allocated_sol_after || 0);
        if(delta > 0) inflowSol += delta;
      }
      return Math.max(0, inflowSol);
    }

    function ensureRoomChart(){
      const chartEl = $("roomChart");
      if(!chartEl){
        detachRoomChartCrosshair();
        if(roomChart && typeof roomChart.remove === "function") roomChart.remove();
        roomChart = null;
        roomCandlesSeries = null;
        roomLaunchTargetSeries = null;
        roomChartContainerEl = null;
        roomChartContextKey = "";
        return null;
      }

      const chartContainerChanged = roomChart && roomChartContainerEl !== chartEl;
      const chartContainerMissing = roomChart && (!roomChartContainerEl || !roomChartContainerEl.isConnected);
      if(roomChart && (chartContainerChanged || chartContainerMissing)){
        detachRoomChartCrosshair();
        if(typeof roomChart.remove === "function") roomChart.remove();
        roomChart = null;
        roomCandlesSeries = null;
        roomLaunchTargetSeries = null;
        roomChartContainerEl = null;
        roomChartContextKey = "";
      }

      const api = window.LightweightCharts;
      if(!api || typeof api.createChart !== "function") return null;

      if(!roomChart){
        const dims = roomChartDims(chartEl);
        roomChart = api.createChart(chartEl, {
          width: dims.width,
          height: dims.height,
          layout: {
            background: { color: "#0f131b" },
            textColor: "#9aa8be",
          },
          rightPriceScale: {
            borderVisible: true,
            borderColor: "#1f2736",
          },
          timeScale: {
            borderVisible: true,
            borderColor: "#1f2736",
            timeVisible: true,
            secondsVisible: false,
          },
          grid: {
            vertLines: { visible: true, color: "rgba(169,180,202,0.08)" },
            horzLines: { visible: true, color: "rgba(169,180,202,0.08)" },
          },
          crosshair: {
            mode: 1,
            vertLine: { visible: true, color: "rgba(180,190,210,0.28)", width: 1, style: 2 },
            horzLine: { visible: true, color: "rgba(180,190,210,0.28)", width: 1, style: 2 },
          },
        });
        roomChartContainerEl = chartEl;
      }

      if(!roomLaunchTargetSeries){
        const { LineSeries, LineStyle } = api;
        if(LineSeries && typeof roomChart.addSeries === "function"){
          roomLaunchTargetSeries = roomChart.addSeries(LineSeries, {
            color: ROOM_CHART_SPAWN_COLOR,
            lineWidth: 2,
            lineStyle: (LineStyle && LineStyle.Dashed) ? LineStyle.Dashed : 2,
            lastValueVisible: false,
            priceLineVisible: false,
          });
        }
      }

      if(!roomCandlesSeries){
        const { CandlestickSeries } = api;
        if(CandlestickSeries && typeof roomChart.addSeries === "function"){
          roomCandlesSeries = roomChart.addSeries(CandlestickSeries, {
            upColor: ROOM_CHART_UP_COLOR,
            downColor: ROOM_CHART_DOWN_COLOR,
            wickUpColor: ROOM_CHART_UP_COLOR,
            wickDownColor: ROOM_CHART_DOWN_COLOR,
            borderUpColor: ROOM_CHART_UP_COLOR,
            borderDownColor: ROOM_CHART_DOWN_COLOR,
            borderVisible: true,
          });
        }
      }

      bindRoomChartCrosshair(roomChart);

      if(!window.__pingyRoomChartResizeBound){
        window.addEventListener("resize", () => {
          const el = $("roomChart");
          if(!roomChart || !el) return;
          roomChart.applyOptions({
            width: el.clientWidth || 300,
            height: el.clientHeight || 220,
          });
        });
        window.__pingyRoomChartResizeBound = true;
      }

      return roomChart;
    }

    function launchDataToCandles(launchData){
      if(!Array.isArray(launchData) || !launchData.length) return [];

      return launchData.map((point, index) => {
        const currentValue = Number(point?.value || 0);
        const previousValue = index > 0
          ? Number(launchData[index - 1]?.value || currentValue)
          : currentValue;
        const open = previousValue;
        const close = currentValue;
        const high = Math.max(open, close);
        const low = Math.min(open, close);
        return {
          time: point.time,
          open,
          high,
          low,
          close,
        };
      });
    }

    function renderRoomChart(room){
      const status = $("roomChartStatus");
      const chart = ensureRoomChart();
      if(!chart){
        if(status) status.textContent = "chart unavailable";
        return;
      }

      if(room?.state === "SPAWNING"){
        appendLaunchHistoryPoint(room);
      }

      const history = ensureLaunchHistory(room);
      const launchData = history.map((point, index) => {
        const tsMs = parseTradeHistoryTs(point.ts);
        const fallbackTimeSec = index * 60;
        return {
          time: tsMs == null ? fallbackTimeSec : Math.floor(tsMs / 1000),
          value: impliedSpawnScaleValue(point, room),
        };
      });
      const candles = getRoomCandles(room, 60);
      const spawnCandles = launchDataToCandles(launchData);
      const target = impliedSpawnMarketCapFromGrossSol(spawnTargetSol(room));
      const isSpawning = room?.state === "SPAWNING";
      let bondCandles = candles.map((candle) => ({ ...candle }));
      const timeframeSec = ROOM_CHART_TF_SECONDS[roomChartUi.timeframe] || 60;

      if(!isSpawning){
        const launchTail = launchData.length ? Number(launchData[launchData.length - 1]?.value || 0) : 0;
        const currentMarketCap = Number(room?.market_cap_usd || 0);
        const anchorValue = Math.max(launchTail, currentMarketCap);
        const firstCandle = candles.length ? candles[0] : null;
        const needsAnchor = anchorValue > 0 && (!firstCandle || Number(firstCandle.close || 0) <= 0);
        if(needsAnchor){
          const fallbackTime = launchData.length
            ? Number(launchData[launchData.length - 1].time || 0)
            : Math.max(0, Math.floor(Date.now() / 1000) - 60);
          const anchorTime = firstCandle
            ? Math.max(0, Number(firstCandle.time || 0) - 60)
            : fallbackTime;
          bondCandles.unshift({
            time: anchorTime,
            open: anchorValue,
            high: anchorValue,
            low: anchorValue,
            close: anchorValue,
          });
        }
      }

      if(spawnCandles.length && bondCandles.length){
        const lastSpawnTime = Number(spawnCandles[spawnCandles.length - 1].time || 0);
        const minBondTime = lastSpawnTime + 60;
        let previousTime = minBondTime - 60;
        bondCandles = bondCandles.map((candle) => {
          const originalTime = Number(candle.time || 0);
          const nextTime = Math.max(originalTime, previousTime + 60, minBondTime);
          previousTime = nextTime;
          return {
            ...candle,
            time: nextTime,
          };
        });
      }

      const mergedCandles = isSpawning
        ? spawnCandles.map((candle) => ({
            ...candle,
            color: ROOM_CHART_SPAWN_COLOR,
            wickColor: ROOM_CHART_SPAWN_COLOR,
          }))
        : [
            ...spawnCandles.map((candle) => ({
              ...candle,
              color: ROOM_CHART_SPAWN_COLOR,
              wickColor: ROOM_CHART_SPAWN_COLOR,
            })),
            ...bondCandles,
          ];

      const activeCandlesRaw = aggregateCandlesByInterval(mergedCandles, timeframeSec);
      const activeCandles = activeCandlesRaw.map((candle) => ({
        ...candle,
        open: chartValueFromMarketCapUsd(candle.open),
        high: chartValueFromMarketCapUsd(candle.high),
        low: chartValueFromMarketCapUsd(candle.low),
        close: chartValueFromMarketCapUsd(candle.close),
      }));
      roomChartActiveCandles = activeCandles.map((c) => ({ ...c }));
      roomChartActiveCandlesRaw = activeCandlesRaw.map((c) => ({ ...c }));

      if(roomCandlesSeries) roomCandlesSeries.setData(activeCandles);
      if(roomLaunchTargetSeries){
        if(isSpawning && target > 0 && launchData.length){
          const minLaunchTime = launchData[0].time;
          const maxLaunchTime = launchData[launchData.length - 1].time;
          const lineEnd = Math.max(maxLaunchTime, minLaunchTime + 60);
          const targetDisplay = chartValueFromMarketCapUsd(target);
          roomLaunchTargetSeries.setData([
            { time: minLaunchTime, value: targetDisplay },
            { time: lineEnd, value: targetDisplay },
          ]);
        } else {
          roomLaunchTargetSeries.setData([]);
        }
      }

      const launchMarkerTime = bondCandles.length
        ? bondCandles[0].time
        : (launchData.length ? launchData[launchData.length - 1].time : null);
      const launchMarkers = (!isSpawning && launchMarkerTime != null)
        ? [{
            time: launchMarkerTime,
            position: "belowBar",
            color: ROOM_CHART_SPAWN_COLOR,
            shape: "arrowUp",
            text: "spawn live",
          }]
        : [];
      if(roomCandlesSeries && typeof roomCandlesSeries.setMarkers === "function"){
        roomCandlesSeries.setMarkers(launchMarkers);
      }

      const nextKey = `${room?.id || ""}:lifecycle`;
      if(nextKey !== roomChartContextKey){
        chart.timeScale().fitContent();
        roomChartContextKey = nextKey;
      }

      if(status){
        if(room?.state === "SPAWNING") status.textContent = "spawn accumulation lifecycle chart";
        else if(room?.state === "BONDED") status.textContent = "bonded lifecycle chart";
        else status.textContent = "spawn to market lifecycle chart";
      }

      const latestLifecycleCloseUsd = roomChartActiveCandlesRaw.length
        ? Number(roomChartActiveCandlesRaw[roomChartActiveCandlesRaw.length - 1].close || 0)
        : 0;
      const currentSourceUsd = room?.state === "SPAWNING"
        ? (latestLifecycleCloseUsd > 0 ? latestLifecycleCloseUsd : Number(room?.market_cap_usd || 0))
        : (Number(room?.market_cap_usd || 0) > 0 ? Number(room?.market_cap_usd || 0) : latestLifecycleCloseUsd);
      const displayCurrent = chartValueFromMarketCapUsd(currentSourceUsd);
      const athUsd = roomChartActiveCandlesRaw.length
        ? Math.max(...roomChartActiveCandlesRaw.map((c) => Number(c.high || 0)))
        : Number(room?.market_cap_usd || 0);
      const athDisplay = chartValueFromMarketCapUsd(athUsd);

      const currentMetricEl = $("chartCurrentMetric");
      if(currentMetricEl){
        const prefix = room?.state === "SPAWNING" ? "Projected" : "Current";
        const label = roomChartUi.metric === "mcap" ? "MC" : "Price";
        currentMetricEl.textContent = `${prefix} ${label}: ${formatChartMetricValue(displayCurrent)}`;
      }
      const athEl = $("chartAth");
      if(athEl){
        const label = roomChartUi.metric === "mcap" ? "ATH" : "Peak";
        athEl.textContent = `${label}: ${formatChartMetricValue(athDisplay)}`;
      }

      const topStats = $("roomChartTopStats");
      if(topStats){
        const nowSec = Math.floor(Date.now() / 1000);
        const lookbackSec = 24 * 3600;
        const firstInLookback = roomChartActiveCandlesRaw.find((c) => Number(c.time || 0) >= (nowSec - lookbackSec));
        const latestCandle = roomChartActiveCandlesRaw.length ? roomChartActiveCandlesRaw[roomChartActiveCandlesRaw.length - 1] : null;
        const change24h = (firstInLookback && latestCandle && Number(firstInLookback.open || 0) > 0)
          ? ((Number(latestCandle.close || 0) - Number(firstInLookback.open || 0)) / Number(firstInLookback.open || 0)) * 100
          : Number(room?.change_pct || 0);
        const volume24hUsd = ensureTradeHistory(room)
          .filter((event) => {
            const ts = parseTradeHistoryTs(event?.ts);
            return ts != null && (Math.floor(ts / 1000) >= (nowSec - lookbackSec));
          })
          .reduce((sum, event) => sum + (Math.abs(Number(event?.gross_sol || 0)) * SOL_TO_USD), 0);
        const inflow24hSol = computeSpawnEscrowInflow24hSol(history);
        const spawningLabel = room?.state === "SPAWNING" ? " (implied)" : "";
        const volumeLabel = room?.state === "SPAWNING" ? "24h Escrow Inflow" : "24h Volume";
        const volumeValue = room?.state === "SPAWNING"
          ? (inflow24hSol > 0 ? `${inflow24hSol.toFixed(3)} SOL` : "—")
          : (volume24hUsd > 0 ? fmtUsd(volume24hUsd) : "—");

        topStats.innerHTML = `
          <div class="roomChartTopStat"><div class="label">Current${spawningLabel}</div><div class="value">${formatChartMetricValue(displayCurrent)}</div></div>
          <div class="roomChartTopStat"><div class="label">24h Change</div><div class="value ${change24h>0?"up":(change24h<0?"down":"")}">${signArrow(change24h)}</div></div>
          <div class="roomChartTopStat"><div class="label">${volumeLabel}</div><div class="value">${volumeValue}</div></div>
          <div class="roomChartTopStat"><div class="label">ATH${spawningLabel}</div><div class="value">${formatChartMetricValue(athDisplay)}</div></div>
        `;
      }
    }

    function bindRoomChartControls(){
      document.querySelectorAll(".chartTfBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tf = String(btn.getAttribute("data-tf") || "1m");
          if(!ROOM_CHART_TF_SECONDS[tf]) return;
          roomChartUi.timeframe = tf;
          setActiveChartButton(".chartTfBtn", tf, "data-tf");
          if(activeRoomId) renderRoom(activeRoomId);
        });
      });

      document.querySelectorAll("[data-chart-metric]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const metric = String(btn.getAttribute("data-chart-metric") || "mcap");
          roomChartUi.metric = metric === "price" ? "price" : "mcap";
          setActiveChartButton("[data-chart-metric]", roomChartUi.metric, "data-chart-metric");
          if(activeRoomId) renderRoom(activeRoomId);
        });
      });

      document.querySelectorAll("[data-chart-denom]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const denom = String(btn.getAttribute("data-chart-denom") || "usd");
          roomChartUi.denom = denom === "sol" ? "sol" : "usd";
          setActiveChartButton("[data-chart-denom]", roomChartUi.denom, "data-chart-denom");
          if(activeRoomId) renderRoom(activeRoomId);
        });
      });
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
      movers: { enabled: true, tickMs: 3000, active: new Set(), scores: {}, leadId: null, topId: null, shimmyId: null, shimmyUntil: 0 },
      devSim: {
        enabled: DEV_SIMULATION,
        active: false,
        roomId: null,
        endAtMs: 0,
        tickId: null,
        seed: DEV_SIM_DEFAULT_SEED,
        walletPool: [],
        backup: null
      }
    };

    const ONCHAIN_REFRESH_MS = 7000;
    const WALLET_BAL_REFRESH_MS = 6000;
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

    async function pingWithOptionalThreadInitTx(roomId, amountLamports, includeThreadInit, createConfig = null){
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

      const instructions = [];
      const config = createConfig || getCreateLaunchConfig();
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
          data: concatBytes(await anchorDiscriminator("initialize_thread"), encodeStringArg(rid), encodeU32Arg(Number(config.minApprovedWallets || 0)), encodeU64Arg(Number(config.spawnTargetLamports || 0)), encodeU16Arg(Number(config.maxWalletShareBps || 0))),
        }));
      }

      const pingKeys = [
        { pubkey: walletPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: true },
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

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

    async function initializeThreadTx(threadId, createConfig = null){
      const rid = String(threadId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      const discriminator = await anchorDiscriminator("initialize_thread");
      const config = createConfig || getCreateLaunchConfig();
      const data = concatBytes(discriminator, encodeStringArg(rid), encodeU32Arg(Number(config.minApprovedWallets || 0)), encodeU64Arg(Number(config.spawnTargetLamports || 0)), encodeU16Arg(Number(config.maxWalletShareBps || 0)));
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


    async function revokeApprovedUserTx(roomId, userWallet){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const userPk = parsePublicKeyStrict(userWallet, "revoked user wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [depositPda] = await deriveDepositPda(rid, userPk);
      const data = concatBytes(
        await anchorDiscriminator("revoke_approved_user"),
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
      const statusMap = ["pending", "approved", "revoked", "rejected", "withdrawn", "converted"];
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
      ensureTradeHistory(r);
      if(r.creator_wallet){
        r.approval[r.creator_wallet] = "approved";
        r.approverWallets[r.creator_wallet] = true;
      }
      ensureLaunchHistory(r);
      appendLaunchHistoryPoint(r);
    });

    function mkRoom(id, name, ticker, desc, launchConfig = null){
      const creator_wallet = (Math.random().toString(16).slice(2,10) + '111111111111111111111111111111').slice(0,44);
      const config = launchConfig || getCreateLaunchConfig();
      const mode = config.launchMode || "spawn";
      const isInstant = mode === "instant";
      return {
        id, name, ticker, desc,
        creator_wallet,
        socials: { x:'', tg:'', web:'' },
        created_at: nowStamp(),
        state: isInstant ? "BONDING" : "SPAWNING",          // SPAWNING | BONDING | BONDED
        launch_mode: isInstant ? "instant" : "spawn",
        launch_preset: isInstant ? null : config.launchPreset,
        min_approved_wallets: isInstant ? 0 : Number(config.minApprovedWallets || 0),
        spawn_target_sol: isInstant ? 0 : Number(config.spawnTargetSol || 0),
        max_wallet_share_bps: isInstant ? 0 : Number(config.maxWalletShareBps || 0),
        spawn_tokens_total: 0,      // tokens bought by opening buy at spawn execution
        spawn_fee_paid_sol: 0,      // actual spawn fee charged only when spawn executes
        protocol_fees_sol: 0,      // cumulative post-spawn trading fees collected
        positions: {},              // wallet -> { escrow_sol, net_sol_in, spawn_tokens, token_balance }
        curve_state: makeCurveState(),
        trade_history: [],          // chronological bonding-curve trade events
        launch_history: [],         // chronological spawn-formation points
        approval: { [creator_wallet]: "approved" },        // wallet => approved|pending|denied
        approverWallets: { [creator_wallet]: true },        // wallet => true
        blockedWallets: {},         // wallet => true
        market_cap_usd: isInstant ? curveMarketCap(makeCurveState()) : 0,
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
      const p = r.positions[connectedWallet] || {escrow_sol:0, net_sol_in:0, spawn_tokens:0, token_balance:0};
      return Number(p.escrow_sol||0);
    }
    function myBond(roomId){
      if(!connectedWallet) return 0;
      const r = roomById(roomId);
      const p = r.positions[connectedWallet] || {escrow_sol:0, net_sol_in:0, spawn_tokens:0, token_balance:0};
      return Number(p.token_balance||0);
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

    // Create coin image/banner previews
    let newImgData = null;
    let newBannerData = null;

    function toggleInfoPanel(btnId, panelId){
      const btn = $(btnId);
      const panel = $(panelId);
      if(!btn || !panel) return;
      btn.addEventListener("click", () => {
        const show = panel.style.display === "none";
        panel.style.display = show ? "block" : "none";
        btn.setAttribute("aria-expanded", show ? "true" : "false");
      });
    }

    function setImagePreview(elId, dataUrl, emptyText){
      const prev = $(elId);
      prev.innerHTML = "";
      if(!dataUrl){
        prev.innerHTML = `<span class="muted">${emptyText}</span>`;
        return;
      }
      const im = document.createElement("img");
      im.src = dataUrl;
      im.alt = "";
      prev.appendChild(im);
    }

    function handleImageInput({ inputId, maxBytes, assignData, previewId, emptyText, overLimitMsg }){
      $(inputId).addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if(!f){ assignData(null); setImagePreview(previewId, null, emptyText); return; }
        const okType = String(f.type || "").startsWith("image/") || /\.(jpg|jpeg|gif|png)$/i.test(String(f.name || ""));
        if(!okType){ alert("please choose a .jpg, .gif, or .png image file."); e.target.value=""; return; }
        if(f.size > maxBytes){ alert(overLimitMsg); e.target.value=""; return; }
        const reader = new FileReader();
        reader.onload = () => { assignData(String(reader.result||"")); setImagePreview(previewId, String(reader.result||""), emptyText); };
        reader.readAsDataURL(f);
      });
    }

    toggleInfoPanel("coinImageInfoBtn", "coinImageInfo");
    toggleInfoPanel("socialsInfoBtn", "socialsInfo");

    handleImageInput({
      inputId: "newImg",
      maxBytes: 15000000,
      assignData: (v) => { newImgData = v; },
      previewId: "newImgPreview",
      emptyText: "no image",
      overLimitMsg: "image too large (max 15mb)."
    });

    handleImageInput({
      inputId: "newBanner",
      maxBytes: 4300000,
      assignData: (v) => { newBannerData = v; },
      previewId: "newBannerPreview",
      emptyText: "no banner",
      overLimitMsg: "banner too large (max 4.3mb)."
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

    function addSystemEvent(roomId, text, options = {}){
      if(!roomId) return;
      state.chat[roomId] = state.chat[roomId] || [];
      state.chat[roomId].push({
        ts: nowStamp(),
        wallet:"SYSTEM",
        text,
        kind: options.kind || "system_activity",
        approvedWallet: options.approvedWallet || "",
      });
    }

    function addApprovalSystemEvent(roomId, wallet){
      if(!roomId || !wallet) return;
      state.chat[roomId] = state.chat[roomId] || [];
      const exists = state.chat[roomId].some((m) => (
        m
        && m.wallet === "SYSTEM"
        && m.kind === "system_approval"
        && m.approvedWallet === wallet
      ));
      if(exists) return;
      addSystemEvent(roomId, `${displayName(wallet)} was approved as a pinger`, {
        kind: "system_approval",
        approvedWallet: wallet,
      });
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
    function getRoomApproverWallets(r){
      if(!r) return [];
      r.approverWallets = r.approverWallets || {};
      if(r.creator_wallet) r.approverWallets[r.creator_wallet] = true;

      const out = new Set();
      if(r.creator_wallet) out.add(r.creator_wallet);

      const onchainApprovers = state.onchain?.[r.id]?.approverWallets || r.onchain?.approverWallets || [];
      onchainApprovers.forEach((w) => { if(w) out.add(w); });
      Object.keys(r.approverWallets).forEach((w) => { if(r.approverWallets[w]) out.add(w); });

      for(const wallet of Array.from(out)){
        if(wallet !== r.creator_wallet && !isApproved(r, wallet)){
          out.delete(wallet);
          if(r.approverWallets[wallet]) delete r.approverWallets[wallet];
        }
      }

      if(r.creator_wallet) r.approverWallets[r.creator_wallet] = true;
      return Array.from(out);
    }
    function isApprover(r, wallet){
      if(!wallet) return false;
      return getRoomApproverWallets(r).includes(wallet);
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
      syncRoomMarketCap(r);
      const MC = Number(r.market_cap_usd || 0);
      return clamp01((MC - MC_SPAWN_FLOOR) / (GRADUATION_MARKET_CAP - MC_SPAWN_FLOOR));
    }

    function maybeAdvance(r){
      if(r.state === "BONDING" || r.state === "BONDED") syncRoomMarketCap(r);
      if(r.state === "SPAWNING"){
        const total = countedEscrowSol(r);
        const target = spawnTargetSol(r);
        if(target > 0 && total >= target && getRoomEscrowSnapshot(r).approvedWallets.length >= minApprovedWalletsRequired(r)){
          const pos = r.positions || {};
          const capSol = walletCapSol(r);
          const contributions = {};
          let openingBuySol = 0;

          for(const w of Object.keys(pos)){
            const p = ensurePos(r, w);
            p.spawn_tokens = 0;
            if(!isApproved(r, w)) continue;
            const escrow = Math.max(0, Number(p.escrow_sol || 0));
            const counted = Math.min(escrow, capSol);
            if(counted <= 0) continue;
            contributions[w] = counted;
            openingBuySol += counted;
          }

          const feeSol = openingBuySol * (SPAWN_FEE_BPS / BPS_DENOM);
          const netSol = Math.max(0, openingBuySol - feeSol);
          const curveInit = r.curve_state || makeCurveState();
          const { next: curveNext, tokensOut } = applyCurveBuy(netSol, curveInit);

          for(const w of Object.keys(contributions)){
            const p = ensurePos(r, w);
            const share = openingBuySol > 0 ? (Number(contributions[w] || 0) / openingBuySol) : 0;
            p.spawn_tokens = tokensOut * share;
            p.token_balance = Number(p.token_balance || 0) + p.spawn_tokens;
          }

          let refundedPending = false;
          for(const w of Object.keys(pos)){
            const p = ensurePos(r, w);
            const e = Math.max(0, Number(p.escrow_sol||0));
            if(e <= 0) continue;
            if(isApproved(r, w)){
              const counted = Math.min(e, capSol);
              const excess = Math.max(0, e - counted);
              if(excess > 0) p.net_sol_in = Number(p.net_sol_in||0) + excess;
            } else {
              refundedPending = true;
            }
            p.escrow_sol = 0;
          }
          if(refundedPending) addSystemEvent(r.id, "spawn triggered — pending escrow refunded");
          r.spawn_tokens_total = tokensOut;
          r.spawn_fee_paid_sol = feeSol;
          r.curve_state = {
            ...curveNext,
            opening_buy_sol: netSol,
            opening_buy_tokens: tokensOut,
          };
          addSystemEvent(r.id, `spawn fee paid: ${feeSol.toFixed(3)} SOL (1%), net used: ${netSol.toFixed(3)} SOL`);

          r.state = "BONDING";
          syncRoomMarketCap(r);
          appendBondingTradeEvent(r, {
            ts: nowStamp(),
            wallet: "SYSTEM",
            side: "spawn_opening_buy",
            gross_sol: openingBuySol,
            fee_sol: feeSol,
            net_sol: netSol,
            tokens_out: tokensOut,
            price_after: curvePrice(r.curve_state),
            market_cap_after: Number(r.market_cap_usd || 0),
          });
          if(!r.token_address) r.token_address = mockTokenAddress(r.ticker || r.name || "PINGY");
          addSystemEvent(r.id, "spawn complete: opening buy executed, curve now live.");
        }
      }
      if(r.state === "BONDING"){
        if(bondingProgress01(r) >= 1){
          r.state = "BONDED";
          addSystemEvent(r.id, "bonded.");
        }
      }
    }


    function seededRandom(seed){
      const raw = String(seed || 1);
      let x = 2166136261;
      for(let i = 0; i < raw.length; i += 1){
        x ^= raw.charCodeAt(i);
        x = Math.imul(x, 16777619) >>> 0;
      }
      return function next(){
        x = (1664525 * x + 1013904223) >>> 0;
        return x / 4294967296;
      };
    }

    function randomWalletFromSeed(tag){
      const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const rand = seededRandom(tag);
      let out = "";
      for(let i=0;i<44;i+=1) out += chars[Math.floor(rand() * chars.length)] || "1";
      return out;
    }

    function makeDevSimWalletPool(roomId, size = 36, seed = DEV_SIM_DEFAULT_SEED){
      const pool = [];
      for(let i=0;i<size;i+=1){
        pool.push(randomWalletFromSeed(`${roomId}:${seed}:${i}`));
      }
      return pool;
    }

    function cloneRoomForDevSim(r){
      return JSON.parse(JSON.stringify({
        state: r.state,
        min_approved_wallets: r.min_approved_wallets,
        spawn_target_sol: r.spawn_target_sol,
        max_wallet_share_bps: r.max_wallet_share_bps,
        spawn_tokens_total: r.spawn_tokens_total,
        spawn_fee_paid_sol: r.spawn_fee_paid_sol,
        protocol_fees_sol: r.protocol_fees_sol,
        positions: r.positions || {},
        curve_state: r.curve_state || makeCurveState(),
        trade_history: r.trade_history || [],
        launch_history: r.launch_history || [],
        approval: r.approval || {},
        approverWallets: r.approverWallets || {},
        blockedWallets: r.blockedWallets || {},
        market_cap_usd: r.market_cap_usd,
        change_pct: r.change_pct,
        token_address: r.token_address,
        onchain: r.onchain || null,
        chat: state.chat[r.id] || []
      }));
    }

    function restoreRoomFromDevSimBackup(roomId){
      const r = roomById(roomId);
      const backup = state.devSim.backup;
      if(!r || !backup || backup.roomId !== roomId) return;
      const data = backup.room || {};
      r.state = data.state || r.state;
      r.min_approved_wallets = Number(data.min_approved_wallets || r.min_approved_wallets || 0);
      r.spawn_target_sol = Number(data.spawn_target_sol || r.spawn_target_sol || 0);
      r.max_wallet_share_bps = Number(data.max_wallet_share_bps || r.max_wallet_share_bps || 0);
      r.spawn_tokens_total = Number(data.spawn_tokens_total || 0);
      r.spawn_fee_paid_sol = Number(data.spawn_fee_paid_sol || 0);
      r.protocol_fees_sol = Number(data.protocol_fees_sol || 0);
      r.positions = data.positions || {};
      r.curve_state = data.curve_state || makeCurveState();
      r.trade_history = Array.isArray(data.trade_history) ? data.trade_history : [];
      r.launch_history = Array.isArray(data.launch_history) ? data.launch_history : [];
      r.approval = data.approval || {};
      r.approverWallets = data.approverWallets || {};
      r.blockedWallets = data.blockedWallets || {};
      r.market_cap_usd = Number(data.market_cap_usd || 0);
      r.change_pct = Number(data.change_pct || 0);
      r.token_address = data.token_address || null;
      state.onchain[roomId] = data.onchain || null;
      state.chat[roomId] = Array.isArray(data.chat) ? data.chat : [];
      if(r.creator_wallet){
        r.approval[r.creator_wallet] = "approved";
        r.approverWallets[r.creator_wallet] = true;
      }
    }

    function ensureRoomLocalSnapshot(roomId){
      const r = roomById(roomId);
      if(!r) return null;
      const byWallet = {};
      const approvedWallets = [];
      const pendingWallets = [];
      const pos = r.positions || {};
      for(const wallet of Object.keys(pos)){
        const rowPos = pos[wallet] || {};
        const status = normalizeDepositStatus(r.approval?.[wallet] || (wallet === r.creator_wallet ? "approved" : ""));
        if(!status) continue;
        const escrow = Math.max(0, Number(rowPos.escrow_sol || 0));
        byWallet[wallet] = { status, allocated_sol: escrow, escrow_sol: escrow, withdrawable_sol: escrow, refundable_sol: escrow };
        if(status === "pending") pendingWallets.push(wallet);
        if(status === "approved") approvedWallets.push(wallet);
      }
      const totalAllocated = Object.values(byWallet).reduce((sum, row) => sum + Number(row.allocated_sol || 0), 0);
      const snapshot = {
        roomId,
        admin: r.creator_wallet,
        approverWallets: Object.keys(r.approverWallets || {}).filter((w) => !!r.approverWallets[w]),
        byWallet,
        approvedWallets,
        pendingWallets,
        approved_count: approvedWallets.length,
        pending_count: pendingWallets.length,
        total_allocated_lamports: Math.round(totalAllocated * LAMPORTS_PER_SOL),
        spawn_target_lamports: Math.round(spawnTargetSol(r) * LAMPORTS_PER_SOL),
        min_approved_wallets: minApprovedWalletsRequired(r),
        max_wallet_share_bps: Number(r.max_wallet_share_bps || 0),
        fetchedAtMs: Date.now(),
      };
      state.onchain[roomId] = snapshot;
      state.onchainMeta[roomId] = { fetchedAtMs: snapshot.fetchedAtMs };
      r.onchain = snapshot;
      return snapshot;
    }

    function upsertDevSimPing(room, wallet, solIn, approvedNow){
      const amount = Math.max(0.01, Number(solIn || 0));
      applySpawnCommit(room, wallet, amount);
      room.approval = room.approval || {};
      const existing = normalizeDepositStatus(room.approval[wallet]);
      const wasApproved = existing === "approved";
      room.approval[wallet] = approvedNow ? "approved" : (wasApproved ? "approved" : "pending");
      if(approvedNow && !wasApproved) addApprovalSystemEvent(room.id, wallet);
      else if(!existing) addSystemEvent(room.id, `@${shortWallet(wallet)} pinged ${amount.toFixed(3)} SOL (pending)`);
      room._lastActivity = Date.now();
      room._pulseUntil = Date.now() + 600;
    }

    function runSpawnSimulationStep(room, sim, rand){
      const minWallets = minApprovedWalletsRequired(room);
      const target = spawnTargetSol(room);
      const cap = Math.max(0.01, walletCapSol(room));
      const shouldPing = rand() < 0.78;
      let snapshot = getRoomEscrowSnapshot(room);
      if(shouldPing){
        const wallet = sim.walletPool[Math.floor(rand() * sim.walletPool.length)];
        const pos = ensurePos(room, wallet);
        const leftCap = Math.max(0, cap - Number(pos.escrow_sol || 0));
        if(leftCap > 0.002){
          const contribution = Math.min(leftCap, 0.02 + rand() * 0.28);
          const approveChance = snapshot.approvedWallets.length < minWallets ? 0.58 : 0.32;
          const approveNow = rand() < approveChance;
          upsertDevSimPing(room, wallet, contribution, approveNow);
          snapshot = getRoomEscrowSnapshot(room);
        }
      }

      if(snapshot.pendingWallets.length > 0 && rand() < 0.7){
        const wallet = snapshot.pendingWallets[Math.floor(rand() * snapshot.pendingWallets.length)];
        const wasApproved = normalizeDepositStatus(room.approval?.[wallet]) === "approved";
        room.approval[wallet] = "approved";
        if(!wasApproved) addApprovalSystemEvent(room.id, wallet);
        snapshot = getRoomEscrowSnapshot(room);
      }

      const approvedTotal = approvedEscrowSol(room);
      if(approvedTotal < target && rand() < 0.65 && snapshot.approvedWallets.length > 0){
        const wallet = snapshot.approvedWallets[Math.floor(rand() * snapshot.approvedWallets.length)];
        const pos = ensurePos(room, wallet);
        const leftCap = Math.max(0, cap - Number(pos.escrow_sol || 0));
        if(leftCap > 0.001) applySpawnCommit(room, wallet, Math.min(leftCap, 0.02 + rand() * 0.2));
      }
      ensureRoomLocalSnapshot(room.id);
      maybeAdvance(room);
    }

    function runBondingSimulationStep(room, sim, rand){
      const activeWallets = sim.walletPool.slice(0, 20);
      const buyers = activeWallets.filter((w) => Number(ensurePos(room, w).net_sol_in || 0) < 8);
      const sellers = activeWallets.filter((w) => Number(ensurePos(room, w).token_balance || 0) > 10);
      const buyBias = sellers.length < 3 ? 0.8 : 0.58;
      const buySide = rand() < buyBias;
      if((buySide && buyers.length === 0) || (!buySide && sellers.length === 0)) return;

      if(buySide){
        const wallet = buyers[Math.floor(rand() * buyers.length)];
        const grossSol = 0.01 + rand() * 0.2;
        const buyFee = applyTradingFeeToBuySol(grossSol);
        const buy = applyCurveBuy(buyFee.netSol, room.curve_state || makeCurveState());
        const pos = ensurePos(room, wallet);
        room.curve_state = buy.next;
        pos.token_balance = Number(pos.token_balance || 0) + buy.tokensOut;
        pos.net_sol_in = Number(pos.net_sol_in || 0) + buyFee.netSol;
        room.protocol_fees_sol = Number(room.protocol_fees_sol || 0) + buyFee.feeSol;
        syncRoomMarketCap(room);
        appendBondingTradeEvent(room, {
          ts: nowStamp(),
          wallet,
          side: "buy",
          gross_sol: buyFee.grossSol,
          fee_sol: buyFee.feeSol,
          net_sol: buyFee.netSol,
          tokens_out: buy.tokensOut,
          price_after: curvePrice(room.curve_state),
          market_cap_after: Number(room.market_cap_usd || 0),
        });
        if(rand() < 0.35) addSystemEvent(room.id, `@${shortWallet(wallet)} bought ${buy.tokensOut.toFixed(3)} tokens`);
        nudgeChange(room, rand() * 2.4);
      } else {
        const wallet = sellers[Math.floor(rand() * sellers.length)];
        const pos = ensurePos(room, wallet);
        const tokenBalance = Number(pos.token_balance || 0);
        const tokenIn = Math.max(5, tokenBalance * (0.05 + rand() * 0.22));
        const soldTokens = Math.min(tokenBalance, tokenIn);
        const sell = applyCurveSell(soldTokens, room.curve_state || makeCurveState());
        const sellFee = applyTradingFeeToSellSol(sell.grossSolOut);
        room.curve_state = sell.next;
        pos.token_balance = Math.max(0, tokenBalance - soldTokens);
        pos.net_sol_in = Number(pos.net_sol_in || 0) - sellFee.netSol;
        room.protocol_fees_sol = Number(room.protocol_fees_sol || 0) + sellFee.feeSol;
        syncRoomMarketCap(room);
        appendBondingTradeEvent(room, {
          ts: nowStamp(),
          wallet,
          side: "sell",
          tokens_in: soldTokens,
          gross_sol_out: sellFee.grossSol,
          fee_sol: sellFee.feeSol,
          net_sol_out: sellFee.netSol,
          price_after: curvePrice(room.curve_state),
          market_cap_after: Number(room.market_cap_usd || 0),
        });
        if(rand() < 0.28) addSystemEvent(room.id, `@${shortWallet(wallet)} sold ${soldTokens.toFixed(3)} tokens`);
        nudgeChange(room, -(rand() * 2.2));
      }
      maybeAdvance(room);
      room._lastActivity = Date.now();
      room._pulseUntil = Date.now() + 450;
      ensureRoomLocalSnapshot(room.id);
    }

    function stopDevSimulation(roomId){
      const sim = state.devSim;
      if(sim.tickId){
        clearInterval(sim.tickId);
        sim.tickId = null;
      }
      sim.active = false;
      sim.endAtMs = 0;
      if(roomId && sim.roomId && roomId !== sim.roomId) return;
      sim.roomId = roomId || sim.roomId;
    }

    function resetDevSimulationRoom(roomId){
      if(!roomId) return;
      stopDevSimulation(roomId);
      restoreRoomFromDevSimBackup(roomId);
      state.devSim.backup = null;
      ensureRoomLocalSnapshot(roomId);
      renderHome();
      if(activeRoomId === roomId) renderRoom(roomId);
    }

    function devSimStatusText(roomId){
      const sim = state.devSim;
      if(!DEV_SIMULATION) return "disabled";
      if(!sim.active || sim.roomId !== roomId) return "idle";
      const leftMs = Math.max(0, sim.endAtMs - Date.now());
      return `running (${Math.ceil(leftMs / 1000)}s left)`;
    }

    function startDevSimulation(roomId, durationMinutes){
      if(!DEV_SIMULATION) return;
      const room = roomById(roomId);
      if(!room) return;
      stopDevSimulation();
      state.devSim.backup = {
        roomId,
        room: cloneRoomForDevSim(room)
      };
      room.state = "SPAWNING";
      room.positions = {};
      room.trade_history = [];
      room.launch_history = [];
      appendLaunchHistoryPoint(room);
      room.protocol_fees_sol = 0;
      room.spawn_tokens_total = 0;
      room.spawn_fee_paid_sol = 0;
      room.curve_state = makeCurveState();
      room.token_address = null;
      room.market_cap_usd = 0;
      room.approval = { [room.creator_wallet]: "approved" };
      room.approverWallets = { [room.creator_wallet]: true };
      room.blockedWallets = {};
      state.chat[roomId] = [{ ts: nowStamp(), wallet: "SYSTEM", text: "dev simulation started (local-only)." }];
      ensureRoomLocalSnapshot(roomId);

      const sim = state.devSim;
      sim.seed = DEV_SIM_DEFAULT_SEED + (durationMinutes * 17) + roomId.length;
      sim.walletPool = makeDevSimWalletPool(roomId, 40, sim.seed);
      sim.roomId = roomId;
      sim.endAtMs = Date.now() + (durationMinutes * 60 * 1000);
      sim.active = true;

      const rand = seededRandom(sim.seed);
      sim.tickId = setInterval(() => {
        const currentRoom = roomById(roomId);
        if(!currentRoom) return stopDevSimulation(roomId);
        if(Date.now() >= sim.endAtMs) return stopDevSimulation(roomId);
        if(currentRoom.state === "SPAWNING") runSpawnSimulationStep(currentRoom, sim, rand);
        else if(currentRoom.state === "BONDING") runBondingSimulationStep(currentRoom, sim, rand);
        if(activeRoomId === roomId) renderRoom(roomId);
        renderHome();
      }, 1200);

      if(activeRoomId === roomId) renderRoom(roomId);
      renderHome();
    }

    function renderDevSimulationPanel(room){
      const panel = $("devSimPanel");
      const status = $("devSimStatus");
      if(!panel || !status) return;
      const visible = DEV_SIMULATION && !!room;
      panel.style.display = visible ? "block" : "none";
      if(!visible) return;
      status.textContent = devSimStatusText(room.id);
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
                <span class="k">SPAWNING • ${roomLaunchLabel(r)}</span>
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
      const chip = (r.state === "BONDING") ? `BONDING • ${roomLaunchLabel(r)}` : `BONDED • ${roomLaunchLabel(r)}`;
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
          <button class="btn subtle" title="share" data-share="${escapeText(r.id)}">↗</button>
        </div>
      `;
      el.addEventListener("dblclick", (ev) => {
        if(ev.target.closest("[data-ping],[data-share]")) return;
        openRoom(r.id);
      });
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
      state.movers.leadId = topIds[0] || null;
      if(state.movers.leadId && state.movers.leadId !== state.movers.topId){
        state.movers.topId = state.movers.leadId;
        state.movers.shimmyId = state.movers.leadId;
        state.movers.shimmyUntil = Date.now() + 420;
      }
      renderHome();
    }

    function moveBottomLiveCardToTop(){
      const liveRooms = sortedLiveRooms();
      if(liveRooms.length < 2) return;
      const last = liveRooms[liveRooms.length - 1];
      const topScore = liveRooms.reduce((maxScore, room) => Math.max(maxScore, Number(state.movers.scores[room.id] || 0)), 0);
      state.movers.scores[last.id] = topScore + 10;
      state.movers.active = new Set([last.id, ...liveRooms.slice(0,2).map((room) => room.id)]);
      state.movers.leadId = last.id;
      state.movers.topId = last.id;
      state.movers.shimmyId = last.id;
      state.movers.shimmyUntil = Date.now() + 420;
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
      if(state.movers.leadId === r.id) classes.push("isLeadMover");
      if(state.movers.shimmyId === r.id && Date.now() < Number(state.movers.shimmyUntil || 0)) classes.push("isShimmy");
      el.className = classes.join(" ");
      el.innerHTML = `
        ${cardInner(r)}
        <div class="row" style="justify-content:flex-end; margin-top:10px;">
          <button class="btn subtle small" data-ping="${escapeText(r.id)}">ping</button>
          <button class="btn subtle small" title="share" data-share="${escapeText(r.id)}">↗</button>
        </div>
      `;
      el.addEventListener("dblclick", (ev) => {
        if(ev.target.closest("[data-ping],[data-share]")) return;
        openRoom(r.id);
      });
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
    bindRoomChartControls();

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

      const launchConfigResult = validateCreateLaunchConfig(getCreateLaunchConfig());
      if(!launchConfigResult.ok){
        const customError = $("customLaunchError");
        if(customError){
          customError.textContent = launchConfigResult.message;
          customError.style.display = "block";
        }
        return alert(launchConfigResult.message);
      }
      const launchConfig = launchConfigResult.config;
      const launchMode = launchConfig.launchMode || "spawn";

      if(launchMode === "spawn"){
        const presetCapLamports = configWalletCapLamports(launchConfig);
        if(commitLamports > presetCapLamports){
          return alert(`commit exceeds ${roomLaunchLabel({ launch_mode: "spawn", launch_preset: launchConfig.launchPreset })} cap (${(presetCapLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL max).`);
        }
      }
      const id = "r" + Math.random().toString(16).slice(2,6);

      if(shouldUseOnchain() && launchMode === "spawn"){
        if(commitLamports > 0){
          try {
            await pingWithOptionalThreadInitTx(id, commitLamports, true, launchConfig);
          } catch(e){
            if(isWalletTxRejected(e)) showToast("Create cancelled — no coin or commit was submitted.");
            else reportTxError(e, "initialize + ping_deposit transaction failed on create");
            return;
          }
        } else {
          try {
            await initializeThreadTx(id, launchConfig);
          } catch (e){
            reportTxError(e, "initialize_thread transaction failed");
            return;
          }
        }
      }

      const r = mkRoom(id, name, ticker, desc, launchConfig);
      r.creator_wallet = connectedWallet;
      r.approval = { [connectedWallet]: "approved" };
      r.approverWallets = r.approverWallets || {};
      r.blockedWallets = r.blockedWallets || {};
      r.approverWallets[connectedWallet] = true;
      r.socials = { x: xUrl, tg: tgUrl, web: webUrl };
      if(newImgData) r.image = newImgData;
      if(newBannerData) r.banner = newBannerData;
      if(launchMode === "instant"){
        r.token_address = mockTokenAddress(r.ticker || r.name || "PINGY");
        if(commit > 0){
          r.positions[connectedWallet] = r.positions[connectedWallet] || {escrow_sol:0, net_sol_in:0, spawn_tokens:0, token_balance:0};
          const buyFee = applyTradingFeeToBuySol(commit);
          const buy = applyCurveBuy(buyFee.netSol, r.curve_state || makeCurveState());
          r.curve_state = buy.next;
          r.positions[connectedWallet].token_balance = Number(r.positions[connectedWallet].token_balance || 0) + buy.tokensOut;
          r.positions[connectedWallet].net_sol_in = Number(r.positions[connectedWallet].net_sol_in || 0) + buyFee.grossSol;
          r.protocol_fees_sol = Number(r.protocol_fees_sol || 0) + buyFee.feeSol;
          syncRoomMarketCap(r);
          appendBondingTradeEvent(r, {
            ts: nowStamp(),
            wallet: connectedWallet,
            side: "buy",
            gross_sol: buyFee.grossSol,
            fee_sol: buyFee.feeSol,
            net_sol: buyFee.netSol,
            tokens_out: buy.tokensOut,
            price_after: curvePrice(r.curve_state),
            market_cap_after: Number(r.market_cap_usd || 0),
          });
        }
      }
      state.rooms.unshift(r);
      state.chat[id] = [{ ts:"—", wallet:"SYSTEM", text: launchMode === "instant" ? "coin created. live on bonding curve." : "coin created. waiting for spawn." }];

      $("newName").value = "";
      $("newTicker").value = "";
      $("newDesc").value = "";
      $("newX").value = "";
      $("newTg").value = "";
      $("newWeb").value = "";
      $("newCommit").value = "";
      if($("newLaunchMode")) $("newLaunchMode").value = "spawn";
      if($("newPreset")) {
        $("newPreset").value = "fast";
        lastPresetBeforeCustom = "fast";
        prefillCustomLaunchInputsFromPreset("fast");
      }
      updateCreateLaunchModeUI();
      const customError = $("customLaunchError");
      if(customError){
        customError.textContent = "";
        customError.style.display = "none";
      }
      $("newImg").value = "";
      newImgData = null;
      setImagePreview("newImgPreview", null, "no image");
      if($("newBanner")) $("newBanner").value = "";
      newBannerData = null;
      setImagePreview("newBannerPreview", null, "no banner");

      toggleCreateCoin(false);
      renderHome();
      openRoom(id);

      if(shouldUseOnchain() && launchMode === "spawn"){
        await fetchRoomOnchainSnapshot(id);
        await refreshConnectedWalletEscrowLine(id);
        await fetchConnectedWalletDepositSnapshot();
        if(activeRoomId === id) renderRoom(id);
      }
    }
    $("createCoinBtn").addEventListener("click", createCoinFromForm);
    let lastPresetBeforeCustom = "fast";
    if($("newLaunchMode")){
      $("newLaunchMode").addEventListener("change", updateCreateLaunchModeUI);
    }
    if($("newPreset")){
      $("newPreset").addEventListener("change", () => {
        const next = selectedPresetKey();
        if(next === "custom"){
          prefillCustomLaunchInputsFromPreset(lastPresetBeforeCustom);
        } else {
          lastPresetBeforeCustom = next;
        }
        updatePresetCapHint();
      });
      ["customMinWallets", "customSpawnTargetSol", "customMaxWalletSharePct"].forEach((id) => {
        const el = $(id);
        if(!el) return;
        el.addEventListener("input", updatePresetCapHint);
      });
    }
    if($("newPreset")) $("newPreset").value = "fast";
    if($("newLaunchMode")) $("newLaunchMode").value = "spawn";
    updateCreateLaunchModeUI();

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
      if(!(state.devSim.active && state.devSim.roomId === roomId)){
        refreshRoomOnchainSnapshot(roomId, { force: true }).then(() => {
          if(activeRoomId === roomId) renderRoom(roomId);
        });
      }

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

      const isApprovalSystemMessage = (m) => (
        !!m
        && m.wallet === "SYSTEM"
        && m.kind === "system_approval"
        && !!m.approvedWallet
      );
      const isTradeActivityText = (text) => {
        const t = String(text || "");
        if(!t) return false;
        if(/^bought .* tokens for .* SOL gross/i.test(t)) return true;
        if(/^sold .* tokens for .* SOL gross/i.test(t)) return true;
        if(/^withdrew .* SOL \(full escrow withdrawal, returned to wallet\)\.?$/i.test(t)) return true;
        return false;
      };
      const isMainChatMessage = (m) => {
        if(!m) return false;
        if(m.wallet === "SYSTEM") return isApprovalSystemMessage(m);
        if(m.kind === "activity") return false;
        if(isTradeActivityText(m.text)) return false;
        return true;
      };

      msgs.filter(isMainChatMessage).forEach((m) => {
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

        const systemClass = isApprovalSystemMessage(m) ? "sysApprovalLine" : "";
        row.innerHTML = `
          <div class="who">
            <div class="whoTop">
              <button class="copyBtn" title="copy wallet">⧉</button>
              <span class="whoName">${nameHtml}</span>
              ${extras}
            </div>
          </div>
          <div class="text ${isSys ? "sysLine" : ""} ${systemClass}">${escapeText(m.text)}</div>
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

        if(isApprovalSystemMessage(m)){
          const textNode = row.querySelector(".text");
          if(textNode){
            textNode.innerHTML = "";
            const whoBtn = document.createElement("button");
            whoBtn.type = "button";
            whoBtn.className = "walletLink";
            whoBtn.textContent = displayName(m.approvedWallet);
            whoBtn.addEventListener("click", () => openProfile(m.approvedWallet));
            textNode.appendChild(whoBtn);
            textNode.appendChild(document.createTextNode(" was approved as a pinger"));
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
      $("msgInput").placeholder = denied ? "Denied from this spawn. Your SOL remains in escrow until you unping." : (enabled ? "message" : "connect wallet");
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

      addApprovalSystemEvent(roomId, wallet);
      await refreshRoomOnchainSnapshot(roomId, { force: true });
      await refreshConnectedWalletEscrowLine(roomId);
      renderRoom(roomId);
      renderHome();
    }

    async function denyWallet(roomId, wallet){
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isApprover(r, connectedWallet)) return;
      if(!isPending(r, wallet)) return;
      if(r.blockedWallets && r.blockedWallets[wallet]) return;
      r.blockedWallets = r.blockedWallets || {};
      r.blockedWallets[wallet] = true;
      r.approval = r.approval || {};
      r.approval[wallet] = "denied";
      addSystemEvent(roomId, `@${shortWallet(wallet)} denied from pending. Denied from this spawn. Your SOL remains in escrow until you unping.`);
      await refreshConnectedWalletEscrowLine(roomId);
      renderRoom(roomId);
      renderHome();
    }

    async function removeApprovedFromSpawn(roomId, wallet){
      if(!onchainEnabled) return showToast("On-chain disabled: PROGRAM_ID misconfigured");
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isApprover(r, connectedWallet)) return;
      if(!isApproved(r, wallet)) return;
      try{
        await revokeApprovedUserTx(roomId, wallet);
      } catch(e){
        reportTxError(e, "remove from spawn transaction failed");
        return;
      }
      r.blockedWallets = r.blockedWallets || {};
      r.blockedWallets[wallet] = true;
      addSystemEvent(roomId, `@${shortWallet(wallet)} removed from spawn on-chain and blocked from this thread.`);
      await refreshRoomOnchainSnapshot(roomId, { force: true });
      await refreshConnectedWalletEscrowLine(roomId);
      renderRoom(roomId);
      renderHome();
    }

    async function toggleApproverWallet(roomId, wallet){
      const r = roomById(roomId);
      if(!r || !wallet) return;
      if(!isCreator(r, connectedWallet)) return;
      if(wallet === r.creator_wallet) return;
      r.approverWallets = r.approverWallets || {};
      if(r.approverWallets[wallet]){
        delete r.approverWallets[wallet];
        addSystemEvent(roomId, `@${shortWallet(wallet)} removed as approver`);
      } else {
        if(!isApproved(r, wallet)) return;
        r.approverWallets[wallet] = true;
        addSystemEvent(roomId, `@${shortWallet(wallet)} is now an approver`);
      }
      getRoomApproverWallets(r);
      ensureRoomLocalSnapshot(roomId);
      renderRoom(roomId);
      renderHome();
    }

    function renderRoom(roomId){
      const r = roomById(roomId);
      if(!r) return;

      maybeAdvance(r);
      renderDevSimulationPanel(r);

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
      roomMeta.appendChild(document.createTextNode(` • created: ${r.created_at} • launch: ${roomLaunchLabel(r)}`));

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
      const approvers = getRoomApproverWallets(r);
      const thread = state.onchain?.[roomId] || {};
      r.onchain = thread;
      if(thread.spawn_target_lamports) r.spawn_target_sol = Number(thread.spawn_target_lamports || 0) / LAMPORTS_PER_SOL;
      if(thread.min_approved_wallets) r.min_approved_wallets = Number(thread.min_approved_wallets || 0);
      if(thread.max_wallet_share_bps) r.max_wallet_share_bps = Number(thread.max_wallet_share_bps || 0);
      const threadAdminPubkey = thread.admin_pubkey || thread.admin;
      const walletPubkey = connectedWallet;
      const isAdmin = !!threadAdminPubkey && !!walletPubkey && toBase58String(threadAdminPubkey) === toBase58String(walletPubkey);
      const canModerateApprovals = isApprover(r, connectedWallet);

      const pendingList = $("pendingList");
      const pingersList = $("pingersList");
      const approversList = $("approversList");
      const isInstantLaunch = roomLaunchMode(r) === "instant";
      const pingersPanel = $("pingersToggle")?.closest(".panel");
      if(pingersPanel) pingersPanel.style.display = isInstantLaunch ? "none" : "block";

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

      if(pendingList && !isInstantLaunch){
        pendingList.innerHTML = "";
        if(!canModerateApprovals){
          const e = document.createElement("span");
          e.className = "muted tiny";
          e.textContent = "creator/approver only";
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
                { label: "Deny", onClick: () => denyWallet(roomId, w) }
              ]
            );
            pendingList.appendChild(row);
          });
        }
      }

      if(pingersList && !isInstantLaunch){
        pingersList.innerHTML = "";
        if(pingers.length === 0){
          const e = document.createElement("span");
          e.className = "muted tiny";
          e.textContent = "none";
          pingersList.appendChild(e);
        } else {
          pingers.forEach((w) => {
            const actions = [];
            if(isAdmin){
              actions.push({ label: "Remove from spawn", onClick: () => removeApprovedFromSpawn(roomId, w) });
              if(!isCreator(r, w)){
                actions.push({
                  label: isApprover(r, w) ? "remove approver" : "make approver",
                  onClick: () => toggleApproverWallet(roomId, w)
                });
              }
            }
            pingersList.appendChild(makeWalletRow(w, snapshot.byWallet?.[w] || {}, actions));
          });
        }
      }

      if(approversList && !isInstantLaunch){
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
      }

      if(!isInstantLaunch) updatePingersToggleLabel(roomId);

      // room banner + image (if provided)
      const bannerEl = $("roomBanner");
      if(bannerEl){
        if(r.banner){
          bannerEl.style.display = "block";
          bannerEl.innerHTML = `<img src="${r.banner}" alt="" />`;
        } else {
          bannerEl.style.display = "none";
          bannerEl.innerHTML = "";
        }
      }

      const imgEl = $("roomImg");
      if(imgEl){
        if(r.image){
          imgEl.innerHTML = `<img src="${r.image}" alt="" />`;
          imgEl.classList.add("img");
        } else {
          imgEl.innerHTML = `<span class="muted" style="display:block;padding:10px 6px;">—</span>`;
        }
      }

      // market + chart
      const marketPanel = $("marketPanel");
      if(marketPanel){
        marketPanel.style.display = "block";
        const mc = Number(r.market_cap_usd || 0);
        $("marketCapBig").textContent = fmtUsd(mc);
        const chg = Number(r.change_pct || 0);
        const arrow = signArrow(chg);
        $("marketChange").innerHTML = `<span class="${chg>0?'up':(chg<0?'down':'')}">${arrow}</span>`;
        $("tokenAddrPill").textContent = r.token_address || "—";
        $("copyTokenBtn").onclick = () => copyToClipboard(r.token_address || "");
        renderRoomChart(r);
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
        phaseLabel.textContent = isInstantLaunch ? "Live on bonding curve" : "BONDING";
        statePill.textContent = isInstantLaunch ? "INSTANT" : "BONDING";
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
        if(progressLine) progressLine.textContent = `trading fee: ${POST_SPAWN_TRADING_FEE_BPS / 100}% applied to bonding buys/sells`;
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
        if(progressLine) progressLine.textContent = `trading fee: ${POST_SPAWN_TRADING_FEE_BPS / 100}% applied to bonding buys/sells`;
      }

      const me =
        (r.state === "SPAWNING")
          ? `you: ${myEscrow(roomId).toFixed(3)} SOL escrow`
           : `you: ${myBond(roomId).toFixed(3)} tokens on curve`;
      $("meLine").textContent = connectedWallet ? me : "connect wallet";
      if(connectedWallet && r.state === "SPAWNING") refreshConnectedWalletEscrowLine(roomId);

      const pingBtn = $("pingBtn");
      const unpingBtn = $("unpingBtn");
      if(pingBtn) pingBtn.textContent = r.state === "SPAWNING" ? "ping" : "buy";
      if(unpingBtn) unpingBtn.textContent = r.state === "SPAWNING" ? "unping" : "sell";
      $("pingBtn").disabled = !connectedWallet || !!(connectedWallet && r.blockedWallets && r.blockedWallets[connectedWallet]);
      $("unpingBtn").disabled = !connectedWallet;

      setComposerState(r);
      renderChat(roomId);
    }

    // Ping / Unping flow
    // Use an explicit room id for modals so home-card clicks can't race view changes.
    let modalRoomId = null;
    function computeMaxPingLamports(room, userDeposit = {}){
      const targetLamports = Number(room?.onchain?.spawn_target_lamports || 0);
      const totalAllocatedLamports = Number(room?.onchain?.total_allocated_lamports || 0);
      const presetCapLamports = configWalletCapLamports({
        spawnTargetLamports: targetLamports,
        maxWalletShareBps: roomMaxWalletShareBps(room),
      });
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
      if(r.state === "BONDED") return alert("sell is not available after bonding is complete in this mock.");
      modalRoomId = rid;
      $("unpingAmount").value = r.state === "SPAWNING" ? "full withdraw" : "sell token amount";
      $("unpingAmount").readOnly = r.state === "SPAWNING";
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

    const devSimStart5Btn = $("devSimStart5");
    const devSimStart10Btn = $("devSimStart10");
    const devSimStopBtn = $("devSimStop");
    const devSimResetBtn = $("devSimReset");
    if(devSimStart5Btn) devSimStart5Btn.addEventListener("click", () => { if(activeRoomId) startDevSimulation(activeRoomId, 5); });
    if(devSimStart10Btn) devSimStart10Btn.addEventListener("click", () => { if(activeRoomId) startDevSimulation(activeRoomId, 10); });
    if(devSimStopBtn) devSimStopBtn.addEventListener("click", () => { if(activeRoomId) { stopDevSimulation(activeRoomId); renderRoom(activeRoomId); } });
    if(devSimResetBtn) devSimResetBtn.addEventListener("click", () => { if(activeRoomId) resetDevSimulationRoom(activeRoomId); });
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
        if(r.blockedWallets && r.blockedWallets[connectedWallet]) return alert("Denied from this spawn. Your SOL remains in escrow until you unping.");
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
            reportTxError(e, "ping deposit transaction failed");
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
        state.chat[r.id].push({ ts: nowStamp(), wallet: "SYSTEM", text:`@${shortWallet(connectedWallet)} pinged ${solAmount.toFixed(3)} SOL (${statusText})`, kind: "system_activity" });

        maybeAdvance(r);

      } else if(r.state === "BONDING") {
        r.positions[connectedWallet] = r.positions[connectedWallet] || {escrow_sol:0, net_sol_in:0, spawn_tokens:0, token_balance:0};
        const buyFee = applyTradingFeeToBuySol(solAmount);
        const buy = applyCurveBuy(buyFee.netSol, r.curve_state || makeCurveState());
        r.curve_state = buy.next;
        r.positions[connectedWallet].token_balance = Number(r.positions[connectedWallet].token_balance || 0) + buy.tokensOut;
        r.positions[connectedWallet].net_sol_in = Number(r.positions[connectedWallet].net_sol_in || 0) + buyFee.grossSol;
        r.protocol_fees_sol = Number(r.protocol_fees_sol || 0) + buyFee.feeSol;
        console.debug("[ping-debug] protocol fee accrual (buy)", { roomId: r.id, tradeFeeSol: buyFee.feeSol, protocolFeesSol: r.protocol_fees_sol });
        syncRoomMarketCap(r);
        appendBondingTradeEvent(r, {
          ts: nowStamp(),
          wallet: connectedWallet,
          side: "buy",
          gross_sol: buyFee.grossSol,
          fee_sol: buyFee.feeSol,
          net_sol: buyFee.netSol,
          tokens_out: buy.tokensOut,
          price_after: curvePrice(r.curve_state),
          market_cap_after: Number(r.market_cap_usd || 0),
        });
        nudgeChange(r, Math.random()*3);

        maybeAdvance(r);

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`bought ${buy.tokensOut.toFixed(3)} tokens for ${buyFee.grossSol.toFixed(3)} SOL gross (${buyFee.feeSol.toFixed(3)} fee, ${buyFee.netSol.toFixed(3)} net to curve).`, kind: "activity" });
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
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`withdrew ${cur.toFixed(3)} SOL (full escrow withdrawal, returned to wallet).`, kind: "activity" });

      } else if(r.state === "BONDING") {
        const s = ($("unpingAmount").value||"").trim();
        const tokenAmount = Number(s);
        if(!s || Number.isNaN(tokenAmount) || tokenAmount <= 0) return alert("enter a valid token amount.");
        r.positions[connectedWallet] = r.positions[connectedWallet] || {escrow_sol:0, net_sol_in:0, spawn_tokens:0, token_balance:0};
        const curTokens = Number(r.positions[connectedWallet].token_balance || 0);
        const sellTokens = Math.min(curTokens, tokenAmount);
        if(sellTokens <= 0) return alert("you have no tokens to sell.");
        const sell = applyCurveSell(sellTokens, r.curve_state || makeCurveState());
        const sellFee = applyTradingFeeToSellSol(sell.grossSolOut);
        r.curve_state = sell.next;
        r.positions[connectedWallet].token_balance = curTokens - sellTokens;
        r.positions[connectedWallet].net_sol_in = Number(r.positions[connectedWallet].net_sol_in || 0) - sellFee.netSol;
        r.protocol_fees_sol = Number(r.protocol_fees_sol || 0) + sellFee.feeSol;
        console.debug("[ping-debug] protocol fee accrual (sell)", { roomId: r.id, tradeFeeSol: sellFee.feeSol, protocolFeesSol: r.protocol_fees_sol });
        syncRoomMarketCap(r);
        appendBondingTradeEvent(r, {
          ts: nowStamp(),
          wallet: connectedWallet,
          side: "sell",
          tokens_in: sellTokens,
          gross_sol_out: sellFee.grossSol,
          fee_sol: sellFee.feeSol,
          net_sol_out: sellFee.netSol,
          price_after: curvePrice(r.curve_state),
          market_cap_after: Number(r.market_cap_usd || 0),
        });
        nudgeChange(r, -(Math.random()*3));
        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`sold ${sellTokens.toFixed(3)} tokens for ${sellFee.grossSol.toFixed(3)} SOL gross (${sellFee.feeSol.toFixed(3)} fee, ${sellFee.netSol.toFixed(3)} net received).`, kind: "activity" });
      } else {
        return alert("sell is unavailable in this state.");
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
      if(!canPost(r)) return alert(isDenied(r, connectedWallet) ? "you were denied from chat for this coin." : r.state === "SPAWNING" ? "ping to post." : "buy to post.");

      const txt = ($("msgInput").value || "").trim();
      if(!txt) return;

      state.chat[activeRoomId] = state.chat[activeRoomId] || [];
      state.chat[activeRoomId].push({ ts: nowStamp(), wallet: connectedWallet, text: txt, kind: "chat" });
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
        if(!(state.devSim.active && state.devSim.roomId === activeRoomId)) refreshRoomOnchainSnapshot(activeRoomId);
        renderRoom(activeRoomId);
      }
      if(homeView?.classList.contains("on")){
        for(const room of state.rooms){
          if(state.devSim.active && state.devSim.roomId === room.id) continue;
          refreshRoomOnchainSnapshot(room.id);
        }
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
