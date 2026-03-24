import {
  SOLANA_CLUSTER,
  DEVNET_RPC,
  connection,
  PROGRAM_ID,
  deriveThreadPda,
  deriveSpawnPoolPda,
  deriveCurvePda,
  deriveCurveAuthorityPda,
  deriveCurveTokenVaultPda,
  deriveMintPda,
  deriveFeeVaultPda,
  deriveV2ProgramStatePda,
  deriveV2SharedVaultPda,
  deriveV2FeeVaultPda,
  deriveRoomLedgerPda,
  deriveRoomReceiptPda,
  deriveV2CurvePda,
  deriveV2CurveAuthorityPda,
  deriveV2SpawnPoolPda,
  deriveV2MintPda,
  deriveV2CurveTokenVaultPda,
  deriveDepositPda,
  deriveThreadEscrowPda,
  deriveBanPda,
  fetchProgramAccounts,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TOKEN_PROGRAM_ID,
} from "./lib/solana.js";
import {
  listRoomsMetadata as listSupabaseRoomsMetadata,
  insertRoomMetadata as insertSupabaseRoomMetadata,
  deleteRoomMetadataByRowId as deleteSupabaseRoomMetadataByRowId,
} from "./lib/supabase.js";

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
      deriveCurvePda,
      deriveCurveAuthorityPda,
      deriveCurveTokenVaultPda,
      deriveMintPda,
      deriveFeeVaultPda,
      deriveV2ProgramStatePda,
      deriveV2SharedVaultPda,
      deriveV2FeeVaultPda,
      deriveRoomLedgerPda,
      deriveRoomReceiptPda,
      deriveV2CurvePda,
      deriveV2CurveAuthorityPda,
      deriveV2SpawnPoolPda,
      deriveV2MintPda,
      deriveV2CurveTokenVaultPda,
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
    const DEPOSIT_ACCOUNT_DATA_SIZE = 8 + 4 + 64 + 32 + 1 + 1 + 8 + 8 + 8 + 8;

    // Single-curve launch model (opening buy initializes live curve)
    const TOTAL_SUPPLY = 1_000_000_000;
    const VIRTUAL_SOL_RESERVE_INITIAL = 30;
    const VIRTUAL_TOKEN_RESERVE_INITIAL = TOTAL_SUPPLY;
    const MC_SPAWN_FLOOR = 6600;
    const GRADUATION_MARKET_CAP = 66000;
    const SPAWN_FEE_BPS = 100;
    const POST_SPAWN_TRADING_FEE_BPS = 100;
    const PING_FEE_BPS = 100;
    const BPS_DENOM = 10_000;
    const CREATOR_MAX_TX_FEE_RESERVE_LAMPORTS = 20_000;
    const DEFAULT_CREATOR_BOOTSTRAP_RESERVE_LAMPORTS = 5_000_000;
    const PINGY_FEE_RECIPIENT = "4HCfrCG3V26adHQa3yRmkmBNG5btREJxhTVmNTDAb9Ep";
    const PINGY_LAUNCH_BACKEND = "pumpfun";
    const ROOM_RECEIPT_ACCOUNT_DATA_SIZE = 8 + 183;
    const PINGY_SHARED_VAULT_V2_ENABLED = typeof window?.PINGY_SHARED_VAULT_V2_ENABLED === "boolean"
      ? window.PINGY_SHARED_VAULT_V2_ENABLED
      : false;
    const PINGY_PUMPFUN_LAUNCH_ENDPOINT = "http://localhost:8787/api/pumpfun/launch";
    const PINGY_PUMPFUN_SETTLEMENT_ENDPOINT = "http://localhost:8787/api/pumpfun/settlement";
    const PINGY_PUMPFUN_STATUS_ENDPOINT = "http://localhost:8787/api/pumpfun/status";
    const EXTERNAL_LAUNCH_RECORDS_STORAGE_KEY = "pingy_external_launch_records";
    const DEBUG_ACCOUNTING = false;

    function isPumpfunLaunchBackend(){
      return PINGY_LAUNCH_BACKEND === "pumpfun";
    }
    function isNativeLaunchBackend(){
      return PINGY_LAUNCH_BACKEND === "native";
    }

    function isSharedVaultV2Enabled(){
      return PINGY_SHARED_VAULT_V2_ENABLED === true;
    }

    function getRoomVersionMarker(room){
      return String(
        room?.room_version
        || room?.onchain?.room_version
        || room?.onchain?.model
        || room?.onchain_model
        || ""
      ).trim().toLowerCase();
    }

    function isCanonicalV2Room(room){
      return getRoomVersionMarker(room) === "v2_shared_vault";
    }

    function isV2Room(room){
      if(isCanonicalV2Room(room)) return true;
      if(room?.version === "v2" || room?.shared_vault === true) return true;
      return false;
    }

    function isV2ExternalRoom(room){
      if(!isV2Room(room)) return false;
      const backend = String(room?.onchain?.launch_backend || room?.launch_backend || "").toLowerCase();
      return backend === "pumpfun" || backend === "external";
    }

    function isV2NativeRoom(room){
      return isV2Room(room) && !isV2ExternalRoom(room);
    }

    function canClaimNativeSpawnTokens(room){
      return isV2NativeRoom(room) || !isV2Room(room);
    }

    function canRecordExternalDistribution(room){
      return isV2ExternalRoom(room) && String(room?.state || "") !== "SPAWNING";
    }

    function getV2ExternalSettlementProgress(room){
      if(!isV2ExternalRoom(room)) return null;
      const status = String(room?.onchain?.external_settlement_status || room?.external_settlement_status || "pending").trim().toLowerCase() || "pending";
      const forwardedLamports = Math.max(0, Number(room?.onchain?.total_forwarded_lamports || 0));
      const targetLamports = Math.max(0, Number(room?.onchain?.spawn_target_lamports || 0));
      const settledUnits = Math.max(0, Number(room?.onchain?.total_external_units_settled || 0));
      const forwardedProgress01 = targetLamports > 0 ? Math.max(0, Math.min(1, forwardedLamports / targetLamports)) : 0;
      return { status, forwardedLamports, targetLamports, settledUnits, forwardedProgress01 };
    }

    function shouldUseV2SpawnFlow(roomOrLaunchMode = null){
      const launchMode = typeof roomOrLaunchMode === "string"
        ? roomOrLaunchMode
        : String(roomOrLaunchMode?.launch_mode || roomOrLaunchMode?.onchain?.launch_mode || "spawn");
      return isSharedVaultV2Enabled() && launchMode === "spawn";
    }

    function shouldUseV2CreateFlow(launchMode){
      return String(launchMode || "").toLowerCase() === "spawn" && isSharedVaultV2Enabled();
    }

    function markRoomAsV2SharedVault(room){
      if(!room || typeof room !== "object") return room;
      room.room_version = "v2_shared_vault";
      room.onchain_model = "v2_shared_vault";
      return room;
    }

    function isAlreadyInitializedLikeError(err){
      const message = String(err?.message || err || "").toLowerCase();
      return message.includes("already in use") || message.includes("already initialized");
    }

    let uiRenderHome = null;
    let uiRenderRoom = null;

    function setUiRenderers({ renderHomeFn = null, renderRoomFn = null } = {}){
      uiRenderHome = typeof renderHomeFn === "function" ? renderHomeFn : null;
      uiRenderRoom = typeof renderRoomFn === "function" ? renderRoomFn : null;
    }

    function safeRenderActiveRoom(roomId){
      if(typeof uiRenderRoom !== "function") return;
      if(!roomId) return;
      uiRenderRoom(roomId);
    }

    function safeRenderHome(){
      if(typeof uiRenderHome !== "function") return;
      uiRenderHome();
    }

    function launchStatusLabel(room){
      const status = getRoomLaunchStatus(room);
      if(status === "submitted") return "Submitted to Pump.fun";
      if(status === "live") return "Live externally";
      return "Draft";
    }

    function normalizePumpfunLaunchStatus(status){
      const normalized = String(status || "draft").toLowerCase();
      if(normalized === "submitted") return "submitted";
      if(normalized === "live") return "live";
      return "draft";
    }

    // Keep this helper near the top-level status helpers so it is always available
    // to every runtime path that touches room/deposit snapshots.
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


    function computePingFeeBreakdownLamports(grossPositionInputLamports){
      const safeInputLamports = Math.max(0, Math.floor(Number(grossPositionInputLamports || 0)));
      const feeLamports = Math.ceil((safeInputLamports * PING_FEE_BPS) / BPS_DENOM);
      const committedLamports = Math.max(0, safeInputLamports - feeLamports);
      return {
        grossPositionInputLamports: safeInputLamports,
        feeLamports,
        committedLamports,
      };
    }

    function computeGrossPositionInputForCommittedLamports(targetCommittedLamports){
      const safeTargetLamports = Math.max(0, Math.floor(Number(targetCommittedLamports || 0)));
      if(safeTargetLamports <= 0) return 0;
      return Math.ceil((safeTargetLamports * BPS_DENOM) / (BPS_DENOM - PING_FEE_BPS));
    }

    function computeRegularPingSpendModel({ grossWalletInputLamports }){
      const safeGrossWalletInputLamports = Math.max(0, Math.floor(Number(grossWalletInputLamports || 0)));
      const feeMath = computePingFeeBreakdownLamports(safeGrossWalletInputLamports);
      return {
        grossWalletInputLamports: safeGrossWalletInputLamports,
        grossPositionInputLamports: safeGrossWalletInputLamports,
        feeLamports: feeMath.feeLamports,
        committedLamports: feeMath.committedLamports,
      };
    }

    function computeCreatorSpawnSpendModel({ walletBalanceLamports, committedCapLamports, bootstrapCostLamports, networkBufferLamports, totalWalletSpendLamports = null }){
      const safeWalletBalanceLamports = Math.max(0, Math.floor(Number(walletBalanceLamports || 0)));
      const safeCommittedCapLamports = Math.max(0, Math.floor(Number(committedCapLamports || 0)));
      const safeBootstrapCostLamports = Math.max(0, Math.floor(Number(bootstrapCostLamports || 0)));
      const safeNetworkBufferLamports = Math.max(0, Math.floor(Number(networkBufferLamports || 0)));
      if(totalWalletSpendLamports != null){
        const total = Math.max(0, Math.floor(Number(totalWalletSpendLamports || 0)));
        const grossPositionInputLamports = Math.max(0, total - safeBootstrapCostLamports);
        const feeMath = computePingFeeBreakdownLamports(grossPositionInputLamports);
        return {
          committedTargetLamports: feeMath.committedLamports,
          grossPositionInputLamports,
          feeLamports: feeMath.feeLamports,
          bootstrapCostLamports: safeBootstrapCostLamports,
          totalWalletSpendLamports: total,
        };
      }
      const maxSpend = Math.max(0, safeWalletBalanceLamports - safeNetworkBufferLamports);
      const maxGrossPositionInputLamports = Math.max(0, maxSpend - safeBootstrapCostLamports);
      const maxCommittedByBalanceLamports = computePingFeeBreakdownLamports(maxGrossPositionInputLamports).committedLamports;
      const targetCommittedLamports = Math.min(safeCommittedCapLamports, maxCommittedByBalanceLamports);
      let grossPositionInputLamports = Math.min(maxGrossPositionInputLamports, computeGrossPositionInputForCommittedLamports(targetCommittedLamports));
      let feeMath = computePingFeeBreakdownLamports(grossPositionInputLamports);
      while(grossPositionInputLamports > 0 && feeMath.committedLamports > targetCommittedLamports){
        grossPositionInputLamports -= 1;
        feeMath = computePingFeeBreakdownLamports(grossPositionInputLamports);
      }
      return {
        committedTargetLamports: feeMath.committedLamports,
        grossPositionInputLamports,
        feeLamports: feeMath.feeLamports,
        bootstrapCostLamports: safeBootstrapCostLamports,
        totalWalletSpendLamports: grossPositionInputLamports + safeBootstrapCostLamports,
      };
    }

    function splitCommittedLamportsForEscrow({ committedLamports, depositBackingLamports }){
      const safeCommittedLamports = Math.max(0, Math.floor(Number(committedLamports || 0)));
      const safeDepositBackingLamports = Math.max(0, Math.floor(Number(depositBackingLamports || 0)));
      const clampedDepositBackingLamports = Math.min(safeCommittedLamports, safeDepositBackingLamports);
      return {
        depositBackingLamports: clampedDepositBackingLamports,
        escrowContributionLamports: Math.max(0, safeCommittedLamports - clampedDepositBackingLamports),
      };
    }

    function getWalletDepositBackingLamports(room, wallet){
      const normalizedWallet = String(wallet || "").trim();
      if(!room || !normalizedWallet) return 0;
      const store = room.wallet_deposit_backing_lamports_by_wallet || {};
      return Math.max(0, Math.floor(Number(store[normalizedWallet] || 0)));
    }

    function setWalletDepositBackingLamports(room, wallet, lamports){
      const normalizedWallet = String(wallet || "").trim();
      if(!room || !normalizedWallet) return;
      room.wallet_deposit_backing_lamports_by_wallet = room.wallet_deposit_backing_lamports_by_wallet || {};
      room.wallet_deposit_backing_lamports_by_wallet[normalizedWallet] = Math.max(0, Math.floor(Number(lamports || 0)));
    }

    function clearWalletDepositBackingLamports(room, wallet){
      const normalizedWallet = String(wallet || "").trim();
      if(!room || !normalizedWallet || !room.wallet_deposit_backing_lamports_by_wallet) return;
      delete room.wallet_deposit_backing_lamports_by_wallet[normalizedWallet];
    }

    function resolveWalletCommittedLamports(room, wallet, row = null){
      const sourceRow = row || {};
      const baseLamports = Math.max(0, Math.round(Number(
        sourceRow.committed_lamports
        ?? sourceRow.withdrawable_lamports
        ?? sourceRow.allocated_lamports
        ?? ((Number(sourceRow.committed_sol ?? sourceRow.withdrawable_sol ?? sourceRow.escrow_sol ?? sourceRow.allocated_sol ?? 0) || 0) * LAMPORTS_PER_SOL)
      ) || 0));
      return baseLamports + getWalletDepositBackingLamports(room, wallet);
    }

    async function estimateWalletDepositBackingLamports(roomId, wallet){
      const rid = String(roomId || "").trim();
      const walletStr = String(wallet || "").trim();
      if(!rid || !walletStr) return 0;
      const walletPk = parsePublicKeyStrict(walletStr, "wallet");
      const [depositPda] = await deriveDepositPda(rid, walletPk);
      const existingDepositInfo = await connection.getAccountInfo(depositPda, "confirmed");
      if(existingDepositInfo?.data?.length >= 8) return 0;
      const rentLamports = await connection.getMinimumBalanceForRentExemption(DEPOSIT_ACCOUNT_DATA_SIZE, "confirmed");
      return Math.max(0, Math.floor(Number(rentLamports || 0)));
    }

    function isCountedDepositStatus(status){
      const normalized = normalizeDepositStatus(status);
      return normalized === "approved" || normalized === "swept";
    }

    function getExternalLaunchResultMint(result){
      if(!result || typeof result !== "object") return "";
      const candidates = [
        result.mint,
        result.external_mint,
        result.token_mint,
        result.tokenMint,
        result.mint_address,
        result.address,
        result?.launch?.mint,
        result?.launch?.token_mint,
        result?.data?.mint,
        result?.data?.token_mint,
      ];
      const mint = candidates.find((value) => typeof value === "string" && value.trim());
      return typeof mint === "string" ? mint.trim() : "";
    }

    function getExternalLaunchResultUrl(result){
      if(!result || typeof result !== "object") return "";
      const candidates = [
        result.url,
        result.launch_url,
        result.external_launch_url,
        result.pumpfun_url,
        result.link,
        result?.launch?.url,
        result?.launch?.launch_url,
        result?.data?.url,
        result?.data?.launch_url,
      ];
      const url = candidates.find((value) => typeof value === "string" && value.trim());
      return typeof url === "string" ? url.trim() : "";
    }

    function getExternalLaunchResultStatus(result){
      if(!result || typeof result !== "object") return "draft";
      const explicit = [
        result.status,
        result.launch_status,
        result.state,
        result?.launch?.status,
        result?.data?.status,
      ];
      for(const raw of explicit){
        const normalized = normalizePumpfunLaunchStatus(raw);
        if(raw != null && normalized !== "draft") return normalized;
        if(String(raw || "").toLowerCase() === "draft") return "draft";
      }
      const liveAt = Number(result.live_at ?? result.liveAt ?? result?.launch?.live_at ?? result?.data?.live_at);
      if(Number.isFinite(liveAt) && liveAt > 0) return "live";
      if(result.live === true || result.is_live === true || result?.launch?.live === true) return "live";
      const submittedAt = Number(result.submitted_at ?? result.submittedAt ?? result?.launch?.submitted_at ?? result?.data?.submitted_at);
      if(Number.isFinite(submittedAt) && submittedAt > 0) return "submitted";
      if(result.ok === true) return "submitted";
      return "draft";
    }

    function normalizeExternalDistributionStatus(value){
      const normalized = String(value || "").trim().toLowerCase();
      return ["pending", "awaiting_token_receipt", "ready", "distributed"].includes(normalized)
        ? normalized
        : "";
    }

    function normalizeDistributionReceiptStatus(value){
      const normalized = String(value || "").trim().toLowerCase();
      return ["pending", "partial", "complete"].includes(normalized) ? normalized : "pending";
    }

    function toSafeExternalTokenAmount(value, fallback = 0){
      const parsed = Number(value);
      if(Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
      const parsedFallback = Number(fallback);
      return Number.isFinite(parsedFallback) && parsedFallback >= 0 ? Math.floor(parsedFallback) : 0;
    }

    function allocateProRataIntegerAmounts(totalTokens, rows){
      const safeRows = Array.isArray(rows) ? rows : [];
      if(!safeRows.length) return [];
      const total = toSafeExternalTokenAmount(totalTokens, 0);
      const normalized = safeRows.map((row, index) => ({
        index,
        wallet: typeof row?.wallet === "string" ? row.wallet : "",
        committed_sol: Number(row?.committed_sol || 0),
        weight: Number(row?.weight || 0),
      })).filter((row) => row.wallet);
      if(!normalized.length) return [];
      if(total <= 0){
        return normalized.map((row) => ({
          wallet: row.wallet,
          committed_sol: row.committed_sol,
          weight: row.weight,
          planned_tokens: 0,
        }));
      }
      const totalWeight = normalized.reduce((sum, row) => sum + (Number.isFinite(row.weight) && row.weight > 0 ? row.weight : 0), 0);
      if(totalWeight <= 0){
        return normalized.map((row) => ({
          wallet: row.wallet,
          committed_sol: row.committed_sol,
          weight: row.weight,
          planned_tokens: 0,
        }));
      }

      const ranked = normalized.map((row) => {
        const safeWeight = Number.isFinite(row.weight) && row.weight > 0 ? row.weight : 0;
        const exactShare = safeWeight > 0 ? ((total * safeWeight) / totalWeight) : 0;
        const baseTokens = Math.floor(exactShare);
        return {
          ...row,
          base_tokens: baseTokens,
          fractional_remainder: exactShare - baseTokens,
          planned_tokens: baseTokens,
        };
      });
      const baseTotal = ranked.reduce((sum, row) => sum + Number(row.base_tokens || 0), 0);
      let remainder = Math.max(0, total - baseTotal);
      const remainderRank = ranked
        .slice()
        .sort((a, b) => {
          if(b.fractional_remainder !== a.fractional_remainder) {
            return b.fractional_remainder - a.fractional_remainder;
          }
          if(a.wallet !== b.wallet) {
            return a.wallet.localeCompare(b.wallet);
          }
          return a.index - b.index;
        });

      for(const row of remainderRank){
        if(remainder <= 0) break;
        row.planned_tokens += 1;
        remainder -= 1;
      }

      return ranked
        .sort((a, b) => a.index - b.index)
        .map((row) => ({
          wallet: row.wallet,
          committed_sol: row.committed_sol,
          weight: row.weight,
          planned_tokens: Number(row.planned_tokens || 0),
        }));
    }

    function resolveRoomExternalDistributionStatus(room){
      const launchStatus = getRoomLaunchStatus(room);
      const tokensReceived = toSafeExternalTokenAmount(room?.external_tokens_received, 0);
      const plannedTotal = toSafeExternalTokenAmount(
        room?.external_distribution_total_tokens_planned,
        getRoomPlannedDistributionTotal(room),
      );
      const tokensSent = toSafeExternalTokenAmount(
        room?.external_distribution_total_tokens_sent,
        toSafeExternalTokenAmount(room?.external_tokens_distributed, 0),
      );
      if(launchStatus !== "live") return "pending";
      if(tokensReceived <= 0) return "awaiting_token_receipt";
      if(plannedTotal > 0 && tokensSent >= plannedTotal) return "distributed";
      return "ready";
    }

    // Canonical external launch backend response contract Pingy expects.
    // Partial backend responses are accepted; missing fields are normalized
    // and existing room state is preserved when applying live updates.
    // {
    //   ok: true,
    //   platform: "pumpfun",
    //   status: "submitted" | "live",
    //   url: "https://...",
    //   mint: "...",
    //   payload: { ... },
    //   submitted_at: 1234567890,
    //   live_at: 1234567890,
    //   tokens_received: number,
    //   tokens_distributed: number,
    //   distribution_status: "pending" | "awaiting_token_receipt" | "ready" | "distributed"
    // }
    function normalizePumpfunLaunchResult(result, room){
      const source = result && typeof result === "object" ? result : {};
      const fallbackPayload = room ? buildPumpfunLaunchPayload(room) : null;
      const submittedAt = Number(source.submitted_at ?? source.submittedAt ?? source?.launch?.submitted_at ?? source?.data?.submitted_at);
      const liveAt = Number(source.live_at ?? source.liveAt ?? source?.launch?.live_at ?? source?.data?.live_at);
      const rawTokensReceived = source.tokens_received
        ?? source.external_tokens_received
        ?? source.received_tokens
        ?? source?.launch?.tokens_received
        ?? source?.data?.tokens_received;
      const rawTokensDistributed = source.tokens_distributed
        ?? source.external_tokens_distributed
        ?? source.distributed_tokens
        ?? source?.launch?.tokens_distributed
        ?? source?.data?.tokens_distributed;
      const rawDistributionStatus = source.distribution_status
        ?? source.external_distribution_status
        ?? source?.launch?.distribution_status
        ?? source?.data?.distribution_status;
      const hasTokensReceived = rawTokensReceived != null && String(rawTokensReceived).trim() !== "";
      const hasTokensDistributed = rawTokensDistributed != null && String(rawTokensDistributed).trim() !== "";
      const hasDistributionStatus = normalizeExternalDistributionStatus(rawDistributionStatus) !== "";
      const payload = source.payload && typeof source.payload === "object"
        ? source.payload
        : (source?.launch?.payload && typeof source.launch.payload === "object"
          ? source.launch.payload
          : fallbackPayload);
      const fallbackDistributionStatus = resolveRoomExternalDistributionStatus(room);
      return {
        platform: String(source.platform || source.backend || source.external_platform || "pumpfun").toLowerCase() || "pumpfun",
        status: getExternalLaunchResultStatus(source),
        url: getExternalLaunchResultUrl(source),
        mint: getExternalLaunchResultMint(source),
        payload,
        submitted_at: Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : null,
        live_at: Number.isFinite(liveAt) && liveAt > 0 ? liveAt : null,
        tokens_received: toSafeExternalTokenAmount(rawTokensReceived, 0),
        tokens_distributed: toSafeExternalTokenAmount(rawTokensDistributed, 0),
        distribution_status: normalizeExternalDistributionStatus(rawDistributionStatus) || fallbackDistributionStatus,
        has_tokens_received: hasTokensReceived,
        has_tokens_distributed: hasTokensDistributed,
        has_distribution_status: hasDistributionStatus,
      };
    }

    function isPumpfunRoom(room){
      return !!room && String(room.launch_backend || "").toLowerCase() === "pumpfun";
    }

    function normalizeExternalLaunchRecord(room){
      if(!room || typeof room !== "object") return null;
      const legacyStatus = normalizePumpfunLaunchStatus(room.launch_status);
      const legacyPlatform = typeof room.external_platform === "string" ? room.external_platform : "";
      const legacyUrl = typeof room.external_launch_url === "string" ? room.external_launch_url : "";
      const legacyMint = typeof room.external_mint === "string" ? room.external_mint : "";
      const legacyPayload = room._lastLaunchPayload && typeof room._lastLaunchPayload === "object" ? room._lastLaunchPayload : null;
      const existing = room.external_launch && typeof room.external_launch === "object" ? room.external_launch : null;
      const inferredBackend = String(existing?.backend || legacyPlatform || room.launch_backend || "").toLowerCase() === "pumpfun" ? "pumpfun" : "";

      if(!existing && !isPumpfunRoom(room) && inferredBackend !== "pumpfun"){
        room.external_launch = null;
        return null;
      }

      const submittedAt = Number(existing?.submitted_at);
      const liveAt = Number(existing?.live_at);
      const normalized = {
        backend: "pumpfun",
        status: normalizePumpfunLaunchStatus(existing?.status || legacyStatus),
        submitted_at: Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : null,
        live_at: Number.isFinite(liveAt) && liveAt > 0 ? liveAt : null,
        url: typeof existing?.url === "string" ? existing.url : legacyUrl,
        mint: typeof existing?.mint === "string" ? existing.mint : legacyMint,
        payload: existing?.payload && typeof existing.payload === "object" ? existing.payload : legacyPayload,
      };
      room.external_launch = normalized;

      room.launch_status = normalized.status;
      room.external_platform = "pumpfun";
      room.external_launch_url = normalized.url;
      room.external_mint = normalized.mint;
      if(normalized.payload) room._lastLaunchPayload = normalized.payload;

      return normalized;
    }

    function getRoomExternalLaunchRecord(room){
      if(!room || typeof room !== "object") return null;
      const record = normalizeExternalLaunchRecord(room);
      if(!record || typeof record !== "object") return null;
      if(String(record.backend || "").toLowerCase() !== "pumpfun") return null;
      return record;
    }

    function getRoomLaunchStatus(room){
      const recordStatus = getRoomExternalLaunchRecord(room)?.status;
      if(recordStatus) return normalizePumpfunLaunchStatus(recordStatus);
      return normalizePumpfunLaunchStatus(room?.launch_status);
    }

    function isRoomLaunchDraft(room){
      return getRoomLaunchStatus(room) === "draft";
    }

    function isRoomLaunchSubmitted(room){
      return getRoomLaunchStatus(room) === "submitted";
    }

    function isRoomLaunchLive(room){
      return getRoomLaunchStatus(room) === "live";
    }

    function getPumpfunLifecycleLabel(room){
      if(!isPumpfunRoom(room)) return "";
      if(isRoomLaunchLive(room)) return "Live externally";
      if(isRoomLaunchSubmitted(room)) return "Submitted to Pump.fun";
      return "Draft";
    }

    function getDisplayedRoomPhase(room){
      if(!room) return "";
      if(!isPumpfunRoom(room)) return String(room.state || "").toUpperCase();
      if(isRoomLaunchLive(room)) return "live_external";
      if(isRoomLaunchSubmitted(room)) return "submitted_pumpfun";
      return "spawn_in_progress";
    }

    function getDisplayedRoomPhaseLabel(room){
      if(isPumpfunRoom(room)){
        if(isRoomLaunchLive(room)) return "Live externally";
        if(isRoomLaunchSubmitted(room)) return "Submitted to Pump.fun";
        return "Spawn in progress";
      }
      if(room?.state === "SPAWNING") return "PING PHASE • spawn progress";
      if(room?.state === "BONDING") return "MARKET • external routing";
      return "BONDED • spawn complete";
    }

    function getDisplayedRoomStatePill(room){
      if(isPumpfunRoom(room)){
        if(isRoomLaunchLive(room)) return "Live";
        if(isRoomLaunchSubmitted(room)) return "Submitted";
        return "Draft";
      }
      return lifecyclePhaseLabel(room?.state);
    }

    function getDisplayedRoomSubline(room){
      if(isPumpfunRoom(room)){
        if(isRoomLaunchLive(room)) return "Trading handled outside Pingy";
        if(isRoomLaunchSubmitted(room)) return "Submitted to Pump.fun";
        return room?.desc || "—";
      }
      if(room?.state === "BONDED") return "Graduated from bonding";
      return room?.desc || "—";
    }

    function getDisplayedRoomProgressText(room){
      if(!room) return "";
      if(room.state === "BONDING"){
        return isPumpfunRoom(room)
          ? "Spawn completed. Trading follows external launch."
          : "External market routing will be used after spawn.";
      }
      if(room.state === "BONDED"){
        return isPumpfunRoom(room)
          ? "This launch has completed its Pingy spawn phase."
          : "External market routing will be used after spawn.";
      }
      return "";
    }

    function getDisplayedExternalLaunchSummary(room){
      if(!isPumpfunRoom(room)) return "";
      const status = getRoomLaunchStatus(room);
      if(status === "draft" && !canRecordExternalDistribution(room)) return "";
      const lines = [];
      if(status === "submitted") lines.push("Submitted to Pump.fun. Waiting for external URL and mint.");
      else {
        const distributionStatus = resolveRoomExternalDistributionStatus(room);
        if(distributionStatus === "distributed") lines.push("Distribution complete.");
        else if(distributionStatus === "ready") lines.push("Live externally. Tokens received and ready for distribution.");
        else lines.push("Live externally. Waiting for token receipt.");
      }
      const v2Progress = getV2ExternalSettlementProgress(room);
      if(v2Progress){
        lines.push(`Settlement status: ${v2Progress.status || "pending"}`);
        if(v2Progress.targetLamports > 0){
          lines.push(`Forwarded: ${(v2Progress.forwardedLamports / LAMPORTS_PER_SOL).toFixed(3)} / ${(v2Progress.targetLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
        }
        lines.push(`External units settled: ${Math.round(v2Progress.settledUnits).toLocaleString()}`);
      }
      if(isRoomStatusRefreshing(room)) lines.push("Refreshing: yes");
      if(String(room?.external_settlement_status || "").trim()) lines.push(`Settlement status: ${String(room.external_settlement_status).trim()}`);
      const settledLabel = formatLaunchTimestamp(room?.external_settled_at);
      if(settledLabel) lines.push(`Settled: ${settledLabel}`);
      return lines.join(" • ");
    }

    function getDisplayedPumpPreviewText(room){
      if(!isPumpfunRoom(room)) return "";
      if(isRoomLaunchLive(room)) return "Live externally • Trading outside Pingy";
      if(isRoomLaunchSubmitted(room)) return "Submitted to Pump.fun • Pending market";
      return "Spawn in progress • Draft";
    }

    function getDisplayedSpawnSuccessTitle(room){
      if(!isPumpfunRoom(room)) return "";
      if(isRoomLaunchLive(room)) return "Launch is live externally.";
      if(isRoomLaunchSubmitted(room)) return "Launch submitted to Pump.fun.";
      return "Spawn in progress.";
    }

    function getDisplayedSpawnSuccessText(room){
      if(!isPumpfunRoom(room)) return "";
      const v2Progress = getV2ExternalSettlementProgress(room);
      if(v2Progress && String(room?.state || "") !== "SPAWNING"){
        if(v2Progress.status === "complete") return "External distribution has completed. Trading for launched coins is handled outside Pingy.";
        if(v2Progress.status === "in_progress") return "External settlement is in progress. Trading for launched coins is handled outside Pingy.";
        return "External settlement is pending. Trading for launched coins is handled outside Pingy.";
      }
      if(isRoomLaunchLive(room)) return "Trading for launched coins is handled outside Pingy.";
      if(isRoomLaunchSubmitted(room)) return "Waiting for external market listing details.";
      return "This launch is still forming on Pingy.";
    }

    function getDisplayedBondedStatusLine(room){
      if(!room) return "";
      return "Trading for launched coins is handled outside Pingy.";
    }

    function getRoomExternalLaunchUrl(room){
      const launchRecord = getRoomExternalLaunchRecord(room);
      const recordUrl = typeof launchRecord?.url === "string" ? launchRecord.url : "";
      if(recordUrl.trim()) return recordUrl;
      return typeof room?.external_launch_url === "string" ? room.external_launch_url : "";
    }

    function getRoomExternalMint(room){
      const launchRecord = getRoomExternalLaunchRecord(room);
      const recordMint = typeof launchRecord?.mint === "string" ? launchRecord.mint : "";
      if(recordMint.trim()) return recordMint;
      return typeof room?.external_mint === "string" ? room.external_mint : "";
    }

    function getRoomExternalPlatform(room){
      const recordBackend = String(getRoomExternalLaunchRecord(room)?.backend || "").toLowerCase();
      if(recordBackend) return recordBackend;
      return String(room?.external_platform || "").toLowerCase();
    }

    function readRoomEscrowSnapshot(room){
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

          const committedLamports = Math.max(0, Math.round(Number(
            row.committed_lamports
            ?? row.withdrawable_lamports
            ?? row.allocated_lamports
            ?? ((Number(row.committed_sol ?? row.withdrawable_sol ?? row.escrow_sol ?? row.allocated_sol ?? 0) || 0) * LAMPORTS_PER_SOL)
          ) || 0));
          const withdrawableLamports = Math.max(0, Math.round(Number(
            row.withdrawable_lamports
            ?? row.allocated_lamports
            ?? row.committed_lamports
            ?? ((Number(row.withdrawable_sol ?? row.allocated_sol ?? row.committed_sol ?? row.escrow_sol ?? 0) || 0) * LAMPORTS_PER_SOL)
          ) || 0));
          const allocatedLamports = Math.max(0, Math.round(Number(
            row.allocated_lamports
            ?? row.withdrawable_lamports
            ?? row.committed_lamports
            ?? ((Number(row.allocated_sol ?? row.withdrawable_sol ?? row.committed_sol ?? row.escrow_sol ?? 0) || 0) * LAMPORTS_PER_SOL)
          ) || 0));

          byWallet[wallet] = {
            ...row,
            status,
            committed_lamports: committedLamports,
            committed_sol: Math.max(0, Number(row.committed_sol ?? (committedLamports / LAMPORTS_PER_SOL))),
            withdrawable_lamports: withdrawableLamports,
            withdrawable_sol: Math.max(0, Number(row.withdrawable_sol ?? (withdrawableLamports / LAMPORTS_PER_SOL))),
            allocated_lamports: allocatedLamports,
            allocated_sol: Math.max(0, Number(row.allocated_sol ?? (allocatedLamports / LAMPORTS_PER_SOL))),
            escrow_sol: Math.max(0, Number(row.escrow_sol ?? row.withdrawable_sol ?? (withdrawableLamports / LAMPORTS_PER_SOL))),
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

      const approval = r.approval || {};
      const positions = r.positions || {};
      const blockedWallets = r.blockedWallets || {};
      const byWallet = {};
      const approvedWallets = [];
      const pendingWallets = [];
      const wallets = new Set([
        ...Object.keys(approval),
        ...Object.keys(positions),
        ...Object.keys(blockedWallets),
      ]);
      if(r.creator_wallet) wallets.add(r.creator_wallet);

      wallets.forEach((wallet) => {
        if(!wallet) return;
        const blocked = !!blockedWallets[wallet];
        const status = blocked
          ? "denied"
          : normalizeDepositStatus(approval[wallet] || (wallet === r.creator_wallet ? "approved" : ""));
        const position = positions[wallet] || {};
        const committedSol = Math.max(0, Number(position.committed_sol ?? position.escrow_sol ?? 0) || 0);
        const committedLamports = Math.max(0, Math.round(committedSol * LAMPORTS_PER_SOL));

        byWallet[wallet] = {
          ...position,
          status,
          committed_lamports: committedLamports,
          committed_sol: committedSol,
          withdrawable_lamports: committedLamports,
          withdrawable_sol: committedSol,
          allocated_lamports: committedLamports,
          allocated_sol: committedSol,
          escrow_sol: committedSol,
        };

        if(isCountedDepositStatus(status)) approvedWallets.push(wallet);
        if(status === "pending") pendingWallets.push(wallet);
      });

      return {
        roomId: r.id,
        admin: r.creator_wallet,
        approverWallets: r.creator_wallet ? [r.creator_wallet] : [],
        byWallet,
        approvedWallets,
        pendingWallets
      };
    }

    function buildRoomBootstrapCostMeta(totalLamports = 0, { known = false, note = "" } = {}){
      const safeLamports = Math.max(0, Math.round(Number(totalLamports || 0)));
      return {
        bootstrap_cost_lamports: safeLamports,
        bootstrap_cost_sol: safeLamports / LAMPORTS_PER_SOL,
        bootstrap_cost_breakdown: {
          known: !!known,
          total_lamports: safeLamports,
          note: String(note || "").trim() || "bootstrap cost tracking placeholder",
        },
      };
    }

    function getRoomBootstrapCostLamports(room){
      if(!room || typeof room !== "object") return 0;
      const directLamports = Number(room.bootstrap_cost_lamports);
      if(Number.isFinite(directLamports) && directLamports >= 0) return Math.round(directLamports);
      const fallbackLamports = Math.round(Math.max(0, Number(room.bootstrap_cost_sol || 0)) * LAMPORTS_PER_SOL);
      return Number.isFinite(fallbackLamports) && fallbackLamports > 0 ? fallbackLamports : 0;
    }

    function getRoomBootstrapCostSol(room){
      return getRoomBootstrapCostLamports(room) / LAMPORTS_PER_SOL;
    }

    function estimateCreatorBootstrapReserveLamports(wallet){
      const creator = String(wallet || "").trim();
      if(!creator) return DEFAULT_CREATOR_BOOTSTRAP_RESERVE_LAMPORTS;
      const historical = (Array.isArray(state?.rooms) ? state.rooms : [])
        .filter((room) => String(room?.creator_wallet || "").trim() === creator)
        .map((room) => getRoomBootstrapCostLamports(room))
        .filter((lamports) => Number.isFinite(lamports) && lamports > 0);
      if(historical.length > 0) return Math.max(...historical);
      return DEFAULT_CREATOR_BOOTSTRAP_RESERVE_LAMPORTS;
    }

    function applyRoomBootstrapCostMeta(room, totalLamports = 0, options = {}){
      if(!room || typeof room !== "object") return room;
      const isLocked = room.bootstrap_locked === true;
      const shouldPreserve = isLocked && !options.force;
      const effectiveLamports = shouldPreserve ? getRoomBootstrapCostLamports(room) : totalLamports;
      const existingBreakdown = room.bootstrap_cost_breakdown && typeof room.bootstrap_cost_breakdown === "object"
        ? room.bootstrap_cost_breakdown
        : {};
      const known = shouldPreserve ? !!existingBreakdown.known : !!options.known;
      const note = shouldPreserve
        ? (existingBreakdown.note || "bootstrap cost tracking placeholder")
        : options.note;
      const meta = buildRoomBootstrapCostMeta(effectiveLamports, { known, note });
      room.bootstrap_cost_lamports = meta.bootstrap_cost_lamports;
      room.bootstrap_cost_sol = meta.bootstrap_cost_sol;
      room.bootstrap_cost_breakdown = meta.bootstrap_cost_breakdown;
      room.bootstrap_locked = options.lock === true ? true : isLocked;
      return room;
    }

    async function estimateCreateBootstrapCostFromTx(signature, payerWallet, { commitLamports = 0 } = {}){
      const sig = String(signature || "").trim();
      const payer = String(payerWallet || "").trim();
      if(!sig || !payer) return { lamports: 0, estimated: true, source: "missing-signature-or-payer" };
      try {
        const txInfo = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const accountKeys = txInfo?.transaction?.message?.getAccountKeys?.().staticAccountKeys
          || txInfo?.transaction?.message?.accountKeys
          || [];
        const payerIdx = accountKeys.findIndex((key) => {
          const keyBase58 = typeof key?.toBase58 === "function" ? key.toBase58() : String(key || "");
          return keyBase58 === payer;
        });
        if(payerIdx < 0) return { lamports: 0, estimated: true, source: "payer-not-found" };
        const preBalance = Number(txInfo?.meta?.preBalances?.[payerIdx] || 0);
        const postBalance = Number(txInfo?.meta?.postBalances?.[payerIdx] || 0);
        const txFeeLamports = Math.max(0, Number(txInfo?.meta?.fee || 0));
        const payerDebitLamports = Math.max(0, preBalance - postBalance);
        const bootstrapLamports = Math.max(0, payerDebitLamports - Math.max(0, Number(commitLamports || 0)) - txFeeLamports);
        return {
          lamports: bootstrapLamports,
          estimated: true,
          source: "tx-balance-delta-minus-commit-and-fee",
          payerDebitLamports,
          txFeeLamports,
        };
      } catch(err){
        console.warn("[ping-debug] failed to estimate bootstrap cost from create tx", { signature: sig, err });
        return { lamports: 0, estimated: true, source: "estimate-failed" };
      }
    }

    function getRoomTotalCommittedSol(room){
      return getRoomGrossCommittedSol(room);
    }

    function getWalletGrossCommittedSol(room, wallet, walletRow){
      if(!room || !wallet) return 0;
      const snapshot = readRoomEscrowSnapshot(room);
      const row = walletRow || snapshot.byWallet?.[wallet] || {};
      const committedLamports = resolveWalletCommittedLamports(room, wallet, row);
      if(committedLamports > 0) return committedLamports / LAMPORTS_PER_SOL;
      const committedSolFromRow = Number(row.committed_sol);
      if(Number.isFinite(committedSolFromRow)) return Math.max(0, committedSolFromRow);
      return Math.max(0, Number(row.withdrawable_sol ?? row.escrow_sol ?? row.allocated_sol ?? 0));
    }

    function getRoomGrossCommittedSol(room){
      if(!room) return 0;
      const snapshot = readRoomEscrowSnapshot(room);
      return Number((snapshot.approvedWallets || []).reduce((sum, wallet) => {
        return sum + getWalletGrossCommittedSol(room, wallet, snapshot.byWallet?.[wallet]);
      }, 0));
    }

    function getRoomCreatorBuySol(room){
      if(!room) return 0;
      const direct = Number(room.creator_commit_sol);
      if(Number.isFinite(direct) && direct > 0) return direct;
      return Math.max(0, Number(creatorCommitSol(room) || 0));
    }

    function getRoomCreatorGrossCommittedSol(room){
      if(!room) return 0;
      const creatorWallet = String(room.creator_wallet || "").trim();
      if(!creatorWallet) return 0;
      const snapshot = readRoomEscrowSnapshot(room);
      return getWalletGrossCommittedSol(room, creatorWallet, snapshot.byWallet?.[creatorWallet]);
    }

    function getRoomParticipantCommittedSol(room){
      const total = Number(getRoomTotalCommittedSol(room) || 0);
      const creatorCommitted = Number(getRoomCreatorGrossCommittedSol(room) || 0);
      return Math.max(0, total - creatorCommitted);
    }

    function logRoomAccounting(room){
      if(!DEBUG_ACCOUNTING) return;
      if(!room || room.state !== "SPAWNING") return;
      console.log("[ping-debug] room accounting", {
        roomId: room.id,
        grossCommittedSol: Number(getRoomTotalCommittedSol(room).toFixed(9)),
        creatorCommittedSol: Number(getRoomCreatorGrossCommittedSol(room).toFixed(9)),
        participantCommittedSol: Number(getRoomParticipantCommittedSol(room).toFixed(9)),
        bootstrapCostSol: Number(getRoomBootstrapCostSol(room).toFixed(9)),
        bootstrapLocked: room.bootstrap_locked === true,
        launchMode: room.launch_mode,
        state: room.state,
      });
    }

    function getRoomLaunchFeeEstimateSol(room){
      const total = Number(getRoomTotalCommittedSol(room) || 0);
      if(total <= 0) return 0;
      return total * (SPAWN_FEE_BPS / BPS_DENOM);
    }

    function getRoomLaunchNetSol(room){
      const total = Number(getRoomTotalCommittedSol(room) || 0);
      const fee = Number(getRoomLaunchFeeEstimateSol(room) || 0);
      return Math.max(0, total - fee);
    }

    function getRoomExternalDistributionSummary(room){
      const status = resolveRoomExternalDistributionStatus(room);
      if(status === "distributed") return { status, label: "complete" };
      if(status === "awaiting_token_receipt") return { status, label: "awaiting token receipt" };
      if(status === "ready") return { status, label: "ready" };
      return { status: "pending", label: "pending" };
    }

    function getRoomExternalDistributionStatusLabel(room){
      return getRoomExternalDistributionSummary(room).label;
    }

    function getRoomEligibleDistributionWallets(room){
      if(!isPumpfunRoom(room)) return [];
      const snapshot = readRoomEscrowSnapshot(room);
      return (snapshot.approvedWallets || []).filter((wallet) => {
        return getWalletGrossCommittedSol(room, wallet, snapshot.byWallet?.[wallet]) > 0;
      });
    }

    function getRoomTotalDistributionWeight(room){
      if(!isPumpfunRoom(room)) return 0;
      const snapshot = readRoomEscrowSnapshot(room);
      const wallets = getRoomEligibleDistributionWallets(room);
      return Number(wallets.reduce((sum, wallet) => {
        return sum + getWalletGrossCommittedSol(room, wallet, snapshot.byWallet?.[wallet]);
      }, 0));
    }

    function hasFrozenDistributionSnapshot(room){
      if(!room || typeof room !== "object") return false;
      if(!Array.isArray(room.distribution_snapshot_rows) || room.distribution_snapshot_rows.length <= 0) return false;
      const lockedAt = Number(room.distribution_snapshot_locked_at);
      return Number.isFinite(lockedAt) && lockedAt > 0;
    }

    function buildRoomDistributionSnapshot(room){
      if(!isPumpfunRoom(room)){
        return {
          locked_at: Date.now(),
          source_status: getRoomLaunchStatus(room),
          total_weight: 0,
          total_recipients: 0,
          rows: [],
        };
      }
      const snapshot = readRoomEscrowSnapshot(room);
      const wallets = (snapshot.approvedWallets || []).filter((wallet) => {
        return getWalletGrossCommittedSol(room, wallet, snapshot.byWallet?.[wallet]) > 0;
      });
      const totalWeight = Number(wallets.reduce((sum, wallet) => {
        return sum + getWalletGrossCommittedSol(room, wallet, snapshot.byWallet?.[wallet]);
      }, 0));
      const tokenPool = toSafeExternalTokenAmount(room?.external_tokens_received, 0);
      const weightedRows = wallets.map((wallet) => {
        const committedSol = getWalletGrossCommittedSol(room, wallet, snapshot.byWallet?.[wallet]);
        return {
          wallet,
          committed_sol: committedSol,
          weight: committedSol,
        };
      });
      const rows = allocateProRataIntegerAmounts(tokenPool, weightedRows);
      return {
        locked_at: Date.now(),
        source_status: getRoomLaunchStatus(room),
        total_weight: totalWeight,
        total_recipients: Number(rows.length || 0),
        rows,
      };
    }

    function freezeRoomDistributionSnapshot(room){
      if(!room || typeof room !== "object") return room;
      const snapshot = buildRoomDistributionSnapshot(room);
      room.distribution_snapshot_locked_at = Number(snapshot.locked_at || Date.now());
      room.distribution_snapshot_source_status = String(snapshot.source_status || "");
      room.distribution_snapshot_total_weight = Number(snapshot.total_weight || 0);
      room.distribution_snapshot_total_recipients = Number(snapshot.total_recipients || 0);
      room.distribution_snapshot_rows = Array.isArray(snapshot.rows)
        ? snapshot.rows.map((row) => ({
          wallet: row.wallet,
          committed_sol: Number(row.committed_sol || 0),
          weight: Number(row.weight || 0),
          planned_tokens: toSafeExternalTokenAmount(row.planned_tokens, 0),
        }))
        : [];
      syncRoomDistributionReceiptsWithPlan(room);
      snapshotRoomExternalDistributionPlan(room);
      validateDistributionSnapshot(room);
      return room;
    }

    function getRoomPlannedDistributionRows(room){
      if(!isPumpfunRoom(room)) return [];
      if(hasFrozenDistributionSnapshot(room)) return room.distribution_snapshot_rows;
      const snapshot = readRoomEscrowSnapshot(room);
      const wallets = getRoomEligibleDistributionWallets(room);
      const tokenPool = toSafeExternalTokenAmount(room?.external_tokens_received, 0);
      const weightedRows = wallets.map((wallet) => {
        const committedSol = getWalletGrossCommittedSol(room, wallet, snapshot.byWallet?.[wallet]);
        return {
          wallet,
          committed_sol: committedSol,
          weight: committedSol,
        };
      });
      return allocateProRataIntegerAmounts(tokenPool, weightedRows);
    }

    function getRoomPlannedDistributionTotal(room){
      const sum = getRoomPlannedDistributionRows(room).reduce((sum, row) => sum + Number(row.planned_tokens || 0), 0);
      return toSafeExternalTokenAmount(sum, 0);
    }

    function getRoomPlannedDistributionRecipientCount(room){
      return Number(getRoomPlannedDistributionRows(room).length || 0);
    }

    function getRoomDistributionReceipts(room){
      if(!room || typeof room !== "object") return {};
      if(!room.external_distribution_receipts || typeof room.external_distribution_receipts !== "object" || Array.isArray(room.external_distribution_receipts)){
        room.external_distribution_receipts = {};
      }
      const receipts = {};
      for(const [wallet, receipt] of Object.entries(room.external_distribution_receipts)){
        const key = String(wallet || "").trim();
        if(!key) continue;
        const source = receipt && typeof receipt === "object" ? receipt : {};
        receipts[key] = {
          planned_tokens: toSafeExternalTokenAmount(source.planned_tokens, 0),
          sent_tokens: toSafeExternalTokenAmount(source.sent_tokens, 0),
          tx_id: typeof source.tx_id === "string" ? source.tx_id.trim() : "",
          sent_at: Number.isFinite(Number(source.sent_at)) && Number(source.sent_at) > 0 ? Number(source.sent_at) : null,
          status: normalizeDistributionReceiptStatus(source.status),
        };
      }
      room.external_distribution_receipts = receipts;
      return receipts;
    }

    function getRoomDistributionReceipt(room, wallet){
      const walletKey = String(wallet || "").trim();
      if(!walletKey) return {
        planned_tokens: 0,
        sent_tokens: 0,
        tx_id: "",
        sent_at: null,
        status: "pending",
      };
      const receipts = getRoomDistributionReceipts(room);
      return receipts[walletKey] || {
        planned_tokens: 0,
        sent_tokens: 0,
        tx_id: "",
        sent_at: null,
        status: "pending",
      };
    }

    function getRoomDistributionReceiptStatus(room, wallet){
      return getRoomDistributionReceipt(room, wallet).status;
    }

    function getRoomDistributionReceiptSentTokens(room, wallet){
      return toSafeExternalTokenAmount(getRoomDistributionReceipt(room, wallet).sent_tokens, 0);
    }

    function getRoomDistributionReceiptPlannedTokens(room, wallet){
      return toSafeExternalTokenAmount(getRoomDistributionReceipt(room, wallet).planned_tokens, 0);
    }

    function getRoomDistributionReceiptsRows(room){
      const plannedRows = getRoomPlannedDistributionRows(room);
      const receipts = getRoomDistributionReceipts(room);
      return plannedRows.map((row) => {
        const wallet = String(row?.wallet || "").trim();
        const plannedTokens = toSafeExternalTokenAmount(row?.planned_tokens, 0);
        const source = receipts[wallet] || {};
        const sentTokens = toSafeExternalTokenAmount(source.sent_tokens, 0);
        let status = "pending";
        if(plannedTokens > 0 && sentTokens >= plannedTokens) status = "complete";
        else if(sentTokens > 0 && sentTokens < plannedTokens) status = "partial";
        return {
          wallet,
          planned_tokens: plannedTokens,
          sent_tokens: sentTokens,
          tx_id: typeof source.tx_id === "string" ? source.tx_id.trim() : "",
          sent_at: Number.isFinite(Number(source.sent_at)) && Number(source.sent_at) > 0 ? Number(source.sent_at) : null,
          status,
        };
      });
    }

    function getRoomDistributionTotalSentTokens(room){
      const sum = getRoomDistributionReceiptsRows(room).reduce((acc, row) => acc + Number(row.sent_tokens || 0), 0);
      return toSafeExternalTokenAmount(sum, 0);
    }

    function getRoomDistributionCompletedRecipientCount(room){
      return Number(getRoomDistributionReceiptsRows(room).filter((row) => row.status === "complete").length || 0);
    }

    function getRoomDistributionPartialRecipientCount(room){
      return Number(getRoomDistributionReceiptsRows(room).filter((row) => row.status === "partial").length || 0);
    }

    function getRoomDistributionPendingRecipientCount(room){
      return Number(getRoomDistributionReceiptsRows(room).filter((row) => row.status === "pending").length || 0);
    }

    function syncRoomDistributionReceiptsWithPlan(room){
      if(!room || typeof room !== "object") return room;
      const plannedRows = getRoomPlannedDistributionRows(room);
      const existing = getRoomDistributionReceipts(room);
      const next = { ...existing };
      for(const row of plannedRows){
        const wallet = String(row?.wallet || "").trim();
        if(!wallet) continue;
        const plannedTokens = toSafeExternalTokenAmount(row?.planned_tokens, 0);
        const source = existing[wallet] || {};
        const sentTokens = toSafeExternalTokenAmount(source.sent_tokens, 0);
        let status = "pending";
        if(plannedTokens > 0 && sentTokens >= plannedTokens) status = "complete";
        else if(sentTokens > 0 && sentTokens < plannedTokens) status = "partial";
        next[wallet] = {
          planned_tokens: plannedTokens,
          sent_tokens: sentTokens,
          tx_id: typeof source.tx_id === "string" ? source.tx_id.trim() : "",
          sent_at: Number.isFinite(Number(source.sent_at)) && Number(source.sent_at) > 0 ? Number(source.sent_at) : null,
          status,
        };
      }
      room.external_distribution_receipts = next;
      return room;
    }

    function snapshotRoomExternalDistributionPlan(room){
      if(!room || typeof room !== "object") return room;
      syncRoomDistributionReceiptsWithPlan(room);
      room.external_distribution_total_recipients = Number(getRoomPlannedDistributionRecipientCount(room) || 0);
      room.external_distribution_total_tokens_planned = toSafeExternalTokenAmount(getRoomPlannedDistributionTotal(room), 0);
      room.external_distribution_total_tokens_sent = toSafeExternalTokenAmount(getRoomDistributionTotalSentTokens(room), 0);
      room.external_tokens_distributed = room.external_distribution_total_tokens_sent;
      room.external_distribution_status = resolveRoomExternalDistributionStatus(room);
      validateDistributionSnapshot(room);
      return room;
    }

    function buildRoomDistributionPreview(room){
      const rows = getRoomPlannedDistributionRows(room);
      return {
        mode: String(room?.external_distribution_mode || "pro_rata"),
        recipient_count: Number(rows.length || 0),
        total_tokens_received: toSafeExternalTokenAmount(room?.external_tokens_received, 0),
        total_tokens_planned: toSafeExternalTokenAmount(rows.reduce((sum, row) => sum + Number(row.planned_tokens || 0), 0), 0),
        rows,
      };
    }

    function validateDistributionSnapshot(room){
      if(!room || typeof room !== "object" || !isPumpfunRoom(room)) return true;
      let valid = true;
      const plannedRows = getRoomPlannedDistributionRows(room);
      const plannedTotal = toSafeExternalTokenAmount(
        plannedRows.reduce((sum, row) => sum + Number(row?.planned_tokens || 0), 0),
        0,
      );
      const storedPlannedTotal = toSafeExternalTokenAmount(room.external_distribution_total_tokens_planned, 0);
      const hasInvalidPlannedRow = plannedRows.some((row) => {
        const planned = Number(row?.planned_tokens);
        return !Number.isInteger(planned) || planned < 0;
      });
      if(hasInvalidPlannedRow){
        valid = false;
        console.warn("[pingy] distribution planned rows invalid", {
          roomId: room.id,
          rows: plannedRows,
        });
      }
      if(plannedTotal !== storedPlannedTotal){
        valid = false;
        console.warn("[pingy] distribution planned total mismatch", {
          roomId: room.id,
          plannedTotal,
          storedPlannedTotal,
        });
      }
      const receipts = getRoomDistributionReceipts(room);
      const hasInvalidReceipt = Object.values(receipts).some((receipt) => {
        const planned = Number(receipt?.planned_tokens);
        const sent = Number(receipt?.sent_tokens);
        return !Number.isInteger(planned)
          || planned < 0
          || !Number.isInteger(sent)
          || sent < 0
          || !["pending", "partial", "complete"].includes(normalizeDistributionReceiptStatus(receipt?.status));
      });
      if(hasInvalidReceipt){
        valid = false;
        console.warn("[pingy] distribution receipts invalid", {
          roomId: room.id,
          receipts,
        });
      }
      if(hasFrozenDistributionSnapshot(room)){
        const frozenRows = Array.isArray(room.distribution_snapshot_rows) ? room.distribution_snapshot_rows : [];
        const frozenTotal = toSafeExternalTokenAmount(
          frozenRows.reduce((sum, row) => sum + Number(row?.planned_tokens || 0), 0),
          0,
        );
        const hasInvalidFrozenRow = frozenRows.some((row) => {
          const planned = Number(row?.planned_tokens);
          return !Number.isInteger(planned) || planned < 0;
        });
        if(hasInvalidFrozenRow){
          valid = false;
          console.warn("[pingy] distribution frozen rows invalid", {
            roomId: room.id,
            rows: frozenRows,
          });
        }
        if(frozenTotal !== storedPlannedTotal){
          valid = false;
          console.warn("[pingy] distribution frozen total mismatch", {
            roomId: room.id,
            frozenTotal,
            storedPlannedTotal,
          });
        }
      }
      return valid;
    }

    function snapshotRoomLaunchVaultAccounting(room){
      if(!room) return room;
      room.launch_vault_sol = Number(getRoomTotalCommittedSol(room) || 0);
      room.launch_fee_sol = Number(getRoomLaunchFeeEstimateSol(room) || 0);
      room.launch_vault_net_sol = Number(getRoomLaunchNetSol(room) || 0);
      room.launch_creator_buy_sol = Number(getRoomCreatorBuySol(room) || 0);
      snapshotRoomExternalDistributionPlan(room);
      return room;
    }

    function mirrorExternalLaunchLegacyFields(room, externalLaunch = null){
      if(!room || typeof room !== "object") return;
      const launchRecord = externalLaunch || getRoomExternalLaunchRecord(room);
      if(!launchRecord) return;
      room.launch_status = normalizePumpfunLaunchStatus(launchRecord.status);
      room.external_platform = String(launchRecord.backend || "pumpfun").toLowerCase() || "pumpfun";
      room.external_launch_url = typeof launchRecord.url === "string" ? launchRecord.url : "";
      room.external_mint = typeof launchRecord.mint === "string" ? launchRecord.mint : "";
      if(launchRecord.payload && typeof launchRecord.payload === "object") room._lastLaunchPayload = launchRecord.payload;
    }

    function saveLaunchRecordsToLocalStorage(){
      if(!DEV_SIMULATION) return;
      try {
        const recordsByRoomId = {};
        state.rooms.forEach((room) => {
          const record = getRoomExternalLaunchRecord(room);
          if(record) recordsByRoomId[room.id] = record;
        });
        localStorage.setItem(EXTERNAL_LAUNCH_RECORDS_STORAGE_KEY, JSON.stringify(recordsByRoomId));
      } catch (err) {
        console.warn("[pingy] failed saving launch records", err);
      }
    }

    function loadLaunchRecordsFromLocalStorage(){
      if(!DEV_SIMULATION) return;
      try {
        const raw = localStorage.getItem(EXTERNAL_LAUNCH_RECORDS_STORAGE_KEY);
        if(!raw) return;
        const recordsByRoomId = JSON.parse(raw);
        if(!recordsByRoomId || typeof recordsByRoomId !== "object") return;
        state.rooms.forEach((room) => {
          const stored = recordsByRoomId[room.id];
          if(!stored || typeof stored !== "object") return;
          room.external_launch = stored;
          const externalLaunch = getRoomExternalLaunchRecord(room);
          mirrorExternalLaunchLegacyFields(room, externalLaunch);
        });
      } catch (err) {
        console.warn("[pingy] failed loading launch records", err);
      }
    }

    function debugPrintLaunchRecord(roomId){
      const room = roomById(roomId);
      const record = getRoomExternalLaunchRecord(room);
      const status = getRoomLaunchStatus(room);
      const url = getRoomExternalLaunchUrl(room);
      const mint = getRoomExternalMint(room);
      const payload = record?.payload || room?._lastLaunchPayload || null;
      if(DEBUG_EXTERNAL_STATUS) console.log("[pingy] launch record", {
        roomId,
        status,
        url,
        mint,
        payload,
        external_launch: record,
      });
      return record;
    }

    function isRoomLaunchSubmitting(room){
      return !!room?.launch_submitting;
    }

    function formatLaunchTimestamp(ts){
      const num = Number(ts);
      if(!Number.isFinite(num) || num <= 0) return "";
      return new Date(num).toLocaleString();
    }

    function isRoomAdminWallet(room, wallet){
      if(!room || !wallet) return false;
      const thread = state.onchain?.[room.id] || room.onchain || {};
      const threadAdminPubkey = thread.admin_pubkey || thread.admin;
      return !!threadAdminPubkey && toBase58String(threadAdminPubkey) === toBase58String(wallet);
    }

    function getNormalizedWallet(value){
      return String(value || "").trim();
    }

    function isCreator(room, wallet){
      const a = getNormalizedWallet(wallet);
      const b = getNormalizedWallet(room?.creator_wallet);
      return !!a && !!b && a === b;
    }

    function isOnchainApproverWallet(room, wallet){
      if(!room || !wallet) return false;
      const walletKey = toBase58String(wallet);
      if(!walletKey) return false;
      const onchainApprovers = state.onchain?.[room.id]?.approverWallets || room.onchain?.approverWallets || [];
      return onchainApprovers.some((approver) => toBase58String(approver) === walletKey);
    }

    function canCurrentWalletSubmitExternalHandoff(room){
      const currentWallet = getNormalizedWallet(connectedWallet);
      if(!currentWallet || !room) return false;
      return isCreator(room, currentWallet) || isOnchainApproverWallet(room, currentWallet) || isRoomAdminWallet(room, currentWallet);
    }

    function canCurrentWalletLaunchPumpfunRoom(room){
      if(!room || !connectedWallet) return false;
      return isCreator(room, connectedWallet);
    }

    function debugLaunchAuthority(room, source = "unknown"){
      const creatorWallet = getNormalizedWallet(room?.creator_wallet);
      const currentWallet = getNormalizedWallet(connectedWallet);
      const creator = isCreator(room, connectedWallet);

      console.log("[pingy] launch authority debug", {
        source,
        roomId: room?.id || "",
        connectedWallet: currentWallet,
        creatorWallet,
        creator,
        roomState: room?.state,
        launchStatus: getRoomLaunchStatus(room),
        canLaunch:
          !!currentWallet &&
          !!room &&
          isPumpfunRoom(room) &&
          !isRoomLaunchSubmitting(room) &&
          (room.state === "SPAWNING" || roomLaunchMode(room) === "instant") &&
          getRoomLaunchStatus(room) === "draft" &&
          creator,
      });
    }

    function canCurrentWalletLaunchExternally(room){
      if(!connectedWallet || !room) return false;
      if(!isPumpfunRoom(room)) return false;
      if(isRoomLaunchSubmitting(room)) return false;
      if(room.state !== "SPAWNING" && roomLaunchMode(room) !== "instant") return false;
      if(getRoomLaunchStatus(room) !== "draft") return false;
      return canCurrentWalletLaunchPumpfunRoom(room);
    }

    function canCurrentWalletMarkLiveExternally(room){
      if(!DEV_SIMULATION || !connectedWallet || !room) return false;
      if(!isPumpfunRoom(room)) return false;
      const status = getRoomLaunchStatus(room);
      if(status !== "draft" && status !== "submitted") return false;
      return isCreator(room, connectedWallet);
    }

    function canCurrentWalletSimulateDistribution(room){
      if(!DEV_SIMULATION || !connectedWallet || !room) return false;
      if(!isPumpfunRoom(room) || !isRoomLaunchLive(room)) return false;
      return isCreator(room, connectedWallet);
    }

    function canCurrentWalletSettleDistribution(room){
      if(!connectedWallet || !room) return false;
      if(!isPumpfunRoom(room)) return false;
      if(isRoomSettlementSubmitting(room)) return false;
      return isCreator(room, connectedWallet);
    }

    function isRoomSettlementSubmitting(room){
      return !!room?.settlement_submitting;
    }

    function isRoomStatusRefreshing(room){
      return !!room?.status_refreshing;
    }

    function canRefreshRoomExternalStatus(room){
      if(!room) return false;
      if(!isPumpfunRoom(room)) return false;
      const status = getRoomLaunchStatus(room);
      if(status !== "submitted" && status !== "live") return false;
      if(isRoomStatusRefreshing(room)) return false;
      return true;
    }

    function hasConfiguredEndpoint(value){
      return typeof value === "string" && value.trim().length > 0;
    }

    function shouldUseDevMockEndpoint(endpoint){
      return DEV_SIMULATION && !hasConfiguredEndpoint(endpoint);
    }

    // Pump.fun status request contract sent by Pingy
    // { roomId, mint, launchUrl, launchStatus, distributionStatus, settlementStatus }
    function buildPumpfunStatusRequest(room){
      return {
        roomId: String(room?.id || "").trim(),
        mint: String(getRoomExternalMint(room) || "").trim(),
        launchUrl: String(getRoomExternalLaunchUrl(room) || "").trim(),
        launchStatus: String(getRoomLaunchStatus(room) || "").trim(),
        distributionStatus: String(resolveRoomExternalDistributionStatus(room) || "").trim(),
        settlementStatus: String(room?.external_settlement_status || "").trim(),
      };
    }

    function buildPumpfunSettlementPayload(room){
      const receiptRows = getRoomDistributionReceiptsRows(room);
      const rows = receiptRows.map((row) => {
        const plannedTokens = toSafeExternalTokenAmount(row?.planned_tokens, 0);
        const sentTokens = toSafeExternalTokenAmount(row?.sent_tokens, 0);
        const remainingTokens = Math.max(plannedTokens - sentTokens, 0);
        let status = "pending";
        if(plannedTokens > 0 && sentTokens >= plannedTokens) status = "complete";
        else if(sentTokens > 0 && sentTokens < plannedTokens) status = "partial";
        return {
          wallet: String(row?.wallet || "").trim(),
          plannedTokens,
          sentTokens,
          remainingTokens,
          status,
        };
      }).filter((row) => row.wallet);

      return {
        roomId: room?.id || "",
        platform: "pumpfun",
        mint: getRoomExternalMint(room),
        launchUrl: getRoomExternalLaunchUrl(room),
        distributionMode: String(room?.external_distribution_mode || "pro_rata"),
        totalTokensReceived: toSafeExternalTokenAmount(room?.external_tokens_received, 0),
        totalTokensPlanned: toSafeExternalTokenAmount(getRoomPlannedDistributionTotal(room), 0),
        totalTokensSent: toSafeExternalTokenAmount(getRoomDistributionTotalSentTokens(room), 0),
        recipientCount: Number(rows.length || 0),
        snapshotLockedAt: Number(room?.distribution_snapshot_locked_at || 0) || null,
        rows,
      };
    }

    // Pump.fun settlement request contract sent by Pingy
    // { roomId, platform, mint, launchUrl, distributionMode, totalTokensReceived, totalTokensPlanned, totalTokensSent, recipientCount, snapshotLockedAt, rows: [{ wallet, plannedTokens, sentTokens, remainingTokens, status }] }
    function buildPumpfunSettlementRequest(room){
      const payload = buildPumpfunSettlementPayload(room);
      const snapshotLockedAt = Number(payload.snapshotLockedAt);
      return {
        roomId: String(payload.roomId || "").trim(),
        platform: String(payload.platform || "pumpfun").trim(),
        mint: String(payload.mint || "").trim(),
        launchUrl: String(payload.launchUrl || "").trim(),
        distributionMode: String(payload.distributionMode || "pro_rata").trim(),
        totalTokensReceived: toSafeExternalTokenAmount(payload.totalTokensReceived, 0),
        totalTokensPlanned: toSafeExternalTokenAmount(payload.totalTokensPlanned, 0),
        totalTokensSent: toSafeExternalTokenAmount(payload.totalTokensSent, 0),
        recipientCount: Number(payload.recipientCount || 0),
        snapshotLockedAt: Number.isFinite(snapshotLockedAt) && snapshotLockedAt > 0 ? snapshotLockedAt : null,
        rows: Array.isArray(payload.rows) ? payload.rows.map((row) => ({
          wallet: String(row?.wallet || "").trim(),
          plannedTokens: toSafeExternalTokenAmount(row?.plannedTokens, 0),
          sentTokens: toSafeExternalTokenAmount(row?.sentTokens, 0),
          remainingTokens: toSafeExternalTokenAmount(row?.remainingTokens, 0),
          status: String(row?.status || "pending").trim(),
        })).filter((row) => row.wallet) : [],
      };
    }

    async function postJsonToEndpoint(endpoint, payload, { defaultErrorMessage = "Request failed." } = {}){
      const url = String(endpoint || "").trim();
      if(!url) return { ok: false, error: defaultErrorMessage, status: null };
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload || {}),
        });
        let body = null;
        try {
          body = await response.json();
        } catch (_jsonErr) {
          return { ok: false, error: `Invalid JSON response from ${url}.`, status: response.status };
        }
        if(!response.ok){
          const message = typeof body?.error === "string" && body.error.trim()
            ? body.error.trim()
            : `${defaultErrorMessage} (${response.status}).`;
          return { ok: false, error: message, status: response.status, body };
        }
        if(!body || typeof body !== "object") return { ok: false, error: `Invalid response body from ${url}.`, status: response.status };
        return { ok: true, data: body, status: response.status, error: null };
      } catch (_err) {
        return { ok: false, error: `${defaultErrorMessage} (network error).`, status: null };
      }
    }

    function setRoomExternalDebug(room, patch = {}){
      if(!room || typeof room !== "object") return room;
      const current = room.external_debug && typeof room.external_debug === "object" ? room.external_debug : {};
      room.external_debug = {
        ...current,
        ...patch,
        updated_at: Date.now(),
      };
      return room;
    }

    function getRoomExternalDebug(room){
      return room?.external_debug && typeof room.external_debug === "object" ? room.external_debug : null;
    }

    function buildExternalSettlementErrorResult(error){
      const message = typeof error === "string"
        ? error
        : String(error?.message || error || "Settlement submission failed.");
      return {
        ok: false,
        platform: "pumpfun",
        settlement_status: "pending",
        settled_at: null,
        rows: [],
        error: message,
      };
    }

    function buildExternalSettlementSuccessResult({
      platform = "pumpfun",
      settlement_status = "pending",
      settled_at = null,
      rows = [],
    } = {}){
      const normalizeSettlementStatus = (status) => {
        const normalized = String(status || "").toLowerCase();
        if(normalized === "complete" || normalized === "distributed") return "complete";
        if(normalized === "partial" || normalized === "ready") return "partial";
        return "pending";
      };
      const normalizedRows = Array.isArray(rows)
        ? rows.map((row) => ({
          wallet: String(row?.wallet || "").trim(),
          planned_tokens: toSafeExternalTokenAmount(row?.planned_tokens, 0),
          sent_tokens: toSafeExternalTokenAmount(row?.sent_tokens, 0),
          tx_id: typeof row?.tx_id === "string" ? row.tx_id.trim() : "",
          sent_at: Number.isFinite(Number(row?.sent_at)) && Number(row.sent_at) > 0 ? Number(row.sent_at) : null,
          status: normalizeDistributionReceiptStatus(row?.status),
        })).filter((row) => row.wallet)
        : [];
      return {
        ok: true,
        platform: String(platform || "pumpfun").toLowerCase() || "pumpfun",
        settlement_status: normalizeSettlementStatus(settlement_status),
        settled_at: Number.isFinite(Number(settled_at)) && Number(settled_at) > 0 ? Number(settled_at) : null,
        rows: normalizedRows,
        error: null,
      };
    }

    function normalizeExternalSettlementResult(result, room){
      if(!result || typeof result !== "object") return buildExternalSettlementErrorResult("Settlement submission failed.");
      if(result.ok === false) return buildExternalSettlementErrorResult(result.error || "Settlement submission failed.");

      const sourceRows = Array.isArray(result.rows) ? result.rows : [];
      if(sourceRows.length <= 0 && room){
        const payloadRows = buildPumpfunSettlementPayload(room).rows;
        return buildExternalSettlementSuccessResult({
          platform: result.platform || "pumpfun",
          settlement_status: result.settlement_status || "pending",
          settled_at: result.settled_at,
          rows: payloadRows.map((row) => ({
            wallet: row.wallet,
            planned_tokens: row.plannedTokens,
            sent_tokens: row.sentTokens,
            tx_id: "",
            sent_at: null,
            status: row.status,
          })),
        });
      }

      return buildExternalSettlementSuccessResult({
        platform: result.platform || "pumpfun",
        settlement_status: result.settlement_status || "pending",
        settled_at: result.settled_at,
        rows: sourceRows,
      });
    }

    // Pump.fun settlement response adapter for Pingy
    // Normalizes backend settlement responses into Pingy's internal shape.
    function normalizePumpfunSettlementResponse(result, room){
      return normalizeExternalSettlementResult(result, room);
    }

    function getPumpfunSettlementEndpoint(){
      const configuredEndpoint = typeof window?.PINGY_PUMPFUN_SETTLEMENT_ENDPOINT === "string"
        ? window.PINGY_PUMPFUN_SETTLEMENT_ENDPOINT
        : PINGY_PUMPFUN_SETTLEMENT_ENDPOINT;
      return String(configuredEndpoint || "").trim();
    }

    function hasPumpfunSettlementEndpoint(){
      return hasConfiguredEndpoint(getPumpfunSettlementEndpoint());
    }

    function getPumpfunStatusEndpoint(){
      const configuredEndpoint = typeof window?.PINGY_PUMPFUN_STATUS_ENDPOINT === "string"
        ? window.PINGY_PUMPFUN_STATUS_ENDPOINT
        : PINGY_PUMPFUN_STATUS_ENDPOINT;
      return String(configuredEndpoint || "").trim();
    }

    function hasPumpfunStatusEndpoint(){
      return hasConfiguredEndpoint(getPumpfunStatusEndpoint());
    }

    function getPumpfunBackendModeSummary(){
      return {
        launch: hasPumpfunLaunchEndpoint() ? "live" : (DEV_SIMULATION ? "mock" : "missing"),
        status: hasPumpfunStatusEndpoint() ? "live" : (DEV_SIMULATION ? "mock" : "missing"),
        settlement: hasPumpfunSettlementEndpoint() ? "live" : (DEV_SIMULATION ? "mock" : "missing"),
      };
    }

    function getPumpfunBackendModeLabel(){
      const summary = getPumpfunBackendModeSummary();
      return `launch:${summary.launch} • status:${summary.status} • settlement:${summary.settlement}`;
    }

    function normalizeExternalStatusResult(result, room){
      if(!result || typeof result !== "object") return buildExternalLaunchErrorResult("Status refresh failed.");
      if(result.ok === false) return buildExternalLaunchErrorResult(result.error || "Status refresh failed.");

      const launchNormalized = normalizePumpfunLaunchResult(result, room);
      const settlementNormalized = normalizeExternalSettlementResult(result, room);
      const hasSettlementRows = Array.isArray(result.rows) && result.rows.length > 0;
      const hasSettlementStatus = typeof result.settlement_status === "string" && result.settlement_status.trim() !== "";
      const hasSettledAt = Number.isFinite(Number(result.settled_at)) && Number(result.settled_at) > 0;

      return {
        ...launchNormalized,
        ok: true,
        settlement_status: hasSettlementStatus ? settlementNormalized.settlement_status : undefined,
        settled_at: hasSettledAt ? settlementNormalized.settled_at : undefined,
        rows: hasSettlementRows ? settlementNormalized.rows : undefined,
      };
    }

    // Pump.fun status response adapter for Pingy
    // Normalizes backend status responses into Pingy's internal shape.
    function normalizePumpfunStatusResponse(result, room){
      return normalizeExternalStatusResult(result, room);
    }

    function buildExternalStatusMockResult(room){
      const launchRecord = getRoomExternalLaunchRecord(room);
      const receiptRows = getRoomDistributionReceiptsRows(room);
      return {
        ok: true,
        platform: getRoomExternalPlatform(room) || "pumpfun",
        status: getRoomLaunchStatus(room),
        url: getRoomExternalLaunchUrl(room),
        mint: getRoomExternalMint(room),
        submitted_at: Number(launchRecord?.submitted_at || 0) || null,
        live_at: Number(launchRecord?.live_at || 0) || null,
        tokens_received: toSafeExternalTokenAmount(room?.external_tokens_received, 0),
        tokens_distributed: toSafeExternalTokenAmount(room?.external_tokens_distributed, 0),
        distribution_status: resolveRoomExternalDistributionStatus(room),
        settlement_status: String(room?.external_distribution_status || "") === "distributed" ? "complete" : "pending",
        settled_at: Number(room?.external_distribution_updated_at || 0) || null,
        rows: receiptRows,
      };
    }

    async function fetchPumpfunRoomStatus(room){
      // a) validate room
      if(!room) return { ...buildExternalLaunchErrorResult("Room not found."), _httpStatus: null, _requestKind: "invalid" };

      // b) resolve endpoint
      const endpoint = getPumpfunStatusEndpoint();
      const requestKind = shouldUseDevMockEndpoint(endpoint) ? "mock" : "live";

      // c) dev mock fallback path
      if(shouldUseDevMockEndpoint(endpoint)) return { ...buildExternalStatusMockResult(room), _httpStatus: null, _requestKind: requestKind };

      // d) non-dev missing endpoint path
      if(!hasConfiguredEndpoint(endpoint)) return { ...buildExternalLaunchErrorResult("No status endpoint configured."), _httpStatus: null, _requestKind: requestKind };

      const payload = buildPumpfunStatusRequest(room);

      // e) live POST path
      const response = await postJsonToEndpoint(endpoint, payload, { defaultErrorMessage: "Status refresh failed" });
      if(!response.ok) return { ...buildExternalLaunchErrorResult(response.error || "Status refresh failed."), _httpStatus: response.status ?? null, _requestKind: requestKind };
      return { ...response.data, _httpStatus: response.status ?? null, _requestKind: requestKind };
    }

    function applyExternalStatusSettlementResult(roomId, normalized){
      if(!normalized || typeof normalized !== "object") return null;
      const hasRows = Array.isArray(normalized.rows) && normalized.rows.length > 0;
      const hasSettlementStatus = typeof normalized.settlement_status === "string" && normalized.settlement_status.trim() !== "";
      const hasSettledAt = Number.isFinite(Number(normalized.settled_at)) && Number(normalized.settled_at) > 0;
      if(!hasRows && !hasSettlementStatus && !hasSettledAt) return roomById(roomId);

      const room = roomById(roomId);
      if(!room) return null;
      const fallbackRows = hasRows ? normalized.rows : buildPumpfunSettlementPayload(room).rows.map((row) => ({
        wallet: row.wallet,
        planned_tokens: row.plannedTokens,
        sent_tokens: row.sentTokens,
        status: row.status,
      }));
      return applyExternalSettlementResult(roomId, {
        ok: true,
        platform: normalized.platform || "pumpfun",
        settlement_status: hasSettlementStatus ? normalized.settlement_status : resolveRoomExternalDistributionStatus(room),
        settled_at: hasSettledAt ? normalized.settled_at : null,
        rows: fallbackRows,
      });
    }

    async function refreshRoomExternalStatus(roomId, { silent = false } = {}){
      const room = roomById(roomId);
      if(!room){
        if(!silent) showToast("Room not found.");
        return buildExternalLaunchErrorResult("Room not found.");
      }
      if(!canRefreshRoomExternalStatus(room)){
        const error = "Room is not eligible for status refresh.";
        if(!silent) showToast(error);
        return buildExternalLaunchErrorResult(error);
      }
      if(!isCreator(room, connectedWallet)){
        const error = "Creator required to refresh status.";
        if(!silent) showToast(error);
        return buildExternalLaunchErrorResult(error);
      }

      room.status_refreshing = true;
      safeRenderActiveRoom(room.id);
      safeRenderHome();
      try {
        setRoomExternalDebug(room, {
          last_action: "status_request",
          last_request_kind: shouldUseDevMockEndpoint(getPumpfunStatusEndpoint()) ? "mock" : "live",
          last_response_kind: "",
          last_http_status: null,
          last_error: "",
        });
        const rawResult = await fetchPumpfunRoomStatus(room);
        setRoomExternalDebug(room, {
          last_response_kind: rawResult?.ok === false ? "error" : "success",
          last_http_status: rawResult?._httpStatus ?? null,
          last_error: rawResult?.ok === false ? String(rawResult?.error || "Status refresh failed.") : "",
        });
        const normalized = normalizePumpfunStatusResponse(rawResult, room);
        if(DEBUG_EXTERNAL_STATUS) console.log("[pingy] status refresh normalized", { roomId: room.id, normalized });
        if(normalized.ok === false){
          if(!silent) showToast(normalized.error || "Status refresh failed.");
          return normalized;
        }
        applyExternalLaunchResult(room.id, normalized);
        applyExternalStatusSettlementResult(room.id, normalized);
        if(!silent) showToast("Status refreshed.");
        return normalized;
      } catch (err) {
        console.error("[pingy] refreshRoomExternalStatus failed", err);
        const failed = buildExternalLaunchErrorResult("Status refresh failed.");
        setRoomExternalDebug(room, {
          last_response_kind: "error",
          last_http_status: null,
          last_error: String(err?.message || failed.error || "Status refresh failed."),
        });
        if(!silent) showToast(failed.error);
        return failed;
      } finally {
        room.status_refreshing = false;
        room.last_status_refresh_at = Date.now();
        safeRenderActiveRoom(room.id);
        safeRenderHome();
      }
    }

    function maybeAutoRefreshRoomExternalStatus(room){
      if(!room || !activeRoomId || room.id !== activeRoomId) return;
      if(!canRefreshRoomExternalStatus(room)) return;
      if(!isCreator(room, connectedWallet)) return;
      const now = Date.now();
      const last = Number(room.last_status_refresh_at || 0);
      const minIntervalMs = 20_000;
      if(Number.isFinite(last) && last > 0 && (now - last) < minIntervalMs) return;
      refreshRoomExternalStatus(room.id, { silent: true });
    }

    function validatePumpfunSettlementReadiness(room){
      if(!room) return { ok: false, error: "Room not found." };
      if(!isPumpfunRoom(room)) return { ok: false, error: "This room is not set to Pump.fun launch mode." };
      if(!isRoomLaunchLive(room)) return { ok: false, error: "Settlement requires a live Pump.fun launch." };
      if(!hasFrozenDistributionSnapshot(room)) return { ok: false, error: "Settlement requires a frozen distribution snapshot." };
      if(!String(getRoomExternalMint(room) || "").trim()) return { ok: false, error: "Settlement requires an external mint." };
      if(toSafeExternalTokenAmount(room.external_tokens_received, 0) <= 0) return { ok: false, error: "Settlement requires received external tokens." };
      if(getRoomPlannedDistributionRecipientCount(room) <= 0) return { ok: false, error: "Settlement requires planned recipients." };
      return { ok: true, error: null };
    }

    function applyExternalSettlementResult(roomId, result){
      const room = roomById(roomId);
      if(!room || !result || typeof result !== "object" || result.ok === false) return null;
      const normalized = normalizePumpfunSettlementResponse(result, room);
      if(!normalized.ok) return null;

      syncRoomDistributionReceiptsWithPlan(room);
      const receipts = getRoomDistributionReceipts(room);
      const existingSettledAt = Number.isFinite(Number(room.external_settled_at)) && Number(room.external_settled_at) > 0
        ? Number(room.external_settled_at)
        : (Number.isFinite(Number(room.external_distribution_updated_at)) && Number(room.external_distribution_updated_at) > 0
          ? Number(room.external_distribution_updated_at)
          : null);
      const settledAt = Number.isFinite(Number(normalized.settled_at)) && Number(normalized.settled_at) > 0
        ? Number(normalized.settled_at)
        : existingSettledAt;
      for(const row of normalized.rows || []){
        const wallet = String(row?.wallet || "").trim();
        if(!wallet) continue;
        const current = receipts[wallet] || {};
        const plannedTokens = toSafeExternalTokenAmount(
          row?.planned_tokens,
          toSafeExternalTokenAmount(current.planned_tokens, 0),
        );
        const sentTokens = toSafeExternalTokenAmount(row?.sent_tokens, toSafeExternalTokenAmount(current.sent_tokens, 0));
        const cappedSentTokens = Math.max(0, Math.min(sentTokens, plannedTokens));
        let status = normalizeDistributionReceiptStatus(row?.status);
        if(cappedSentTokens >= plannedTokens && plannedTokens > 0) status = "complete";
        else if(cappedSentTokens > 0) status = "partial";
        else status = "pending";
        receipts[wallet] = {
          planned_tokens: plannedTokens,
          sent_tokens: cappedSentTokens,
          tx_id: typeof row?.tx_id === "string" ? row.tx_id.trim() : (typeof current.tx_id === "string" ? current.tx_id.trim() : ""),
          sent_at: Number.isFinite(Number(row?.sent_at)) && Number(row.sent_at) > 0
            ? Number(row.sent_at)
            : (Number.isFinite(Number(current.sent_at)) && Number(current.sent_at) > 0
              ? Number(current.sent_at)
              : (Number.isFinite(Number(settledAt)) && settledAt > 0 ? settledAt : null)),
          status,
        };
      }
      room.external_distribution_receipts = receipts;
      if(Number.isFinite(Number(settledAt)) && Number(settledAt) > 0) room.external_distribution_updated_at = Number(settledAt);
      room.external_settlement_status = normalized.settlement_status;
      if(Number.isFinite(Number(settledAt)) && Number(settledAt) > 0) room.external_settled_at = Number(settledAt);
      room.external_distribution_status = normalized.settlement_status === "complete"
        ? "distributed"
        : (normalized.settlement_status === "partial" ? "ready" : resolveRoomExternalDistributionStatus(room));
      if(DEBUG_EXTERNAL_STATUS) console.log("[pingy] applied settlement result", {
        roomId,
        settlement_status: room.external_settlement_status,
        external_distribution_status: room.external_distribution_status,
        external_distribution_updated_at: room.external_distribution_updated_at,
        external_settled_at: room.external_settled_at,
      });
      snapshotRoomExternalDistributionPlan(room);
      validateDistributionSnapshot(room);
      if(DEV_SIMULATION) saveLaunchRecordsToLocalStorage();
      safeRenderActiveRoom(room.id);
      safeRenderHome();
      return room;
    }

    function submitPumpfunSettlementMock(room){
      if(!room) return buildExternalSettlementErrorResult("Room not found.");
      const payload = buildPumpfunSettlementPayload(room);
      const settledAt = Date.now();
      const txId = `mock-settlement-${room.id || "room"}-${String(settledAt).slice(-8)}`;
      return buildExternalSettlementSuccessResult({
        platform: "pumpfun",
        settlement_status: "complete",
        settled_at: settledAt,
        rows: payload.rows.map((row) => ({
          wallet: row.wallet,
          planned_tokens: row.plannedTokens,
          sent_tokens: row.plannedTokens,
          tx_id: txId,
          sent_at: settledAt,
          status: "complete",
        })),
      });
    }

    async function submitPumpfunSettlement(room){
      // a) validate room
      if(!room) return buildExternalSettlementErrorResult("Room not found.");
      const payload = buildPumpfunSettlementRequest(room);

      // b) resolve endpoint
      const endpoint = getPumpfunSettlementEndpoint();
      const requestKind = shouldUseDevMockEndpoint(endpoint) ? "mock" : "live";

      // c) dev mock fallback path
      if(shouldUseDevMockEndpoint(endpoint)) return { ...submitPumpfunSettlementMock(room), _httpStatus: null, _requestKind: requestKind };

      // d) non-dev missing endpoint path
      if(!hasConfiguredEndpoint(endpoint)) return { ...buildExternalSettlementErrorResult("No settlement endpoint configured."), _httpStatus: null, _requestKind: requestKind };

      // e) live POST path
      const response = await postJsonToEndpoint(endpoint, payload, { defaultErrorMessage: "Settlement submission failed" });
      if(!response.ok) return { ...buildExternalSettlementErrorResult(response.error || "Settlement submission failed."), _httpStatus: response.status ?? null, _requestKind: requestKind };
      return { ...response.data, _httpStatus: response.status ?? null, _requestKind: requestKind };
    }

    async function submitRoomSettlementExternally(roomId){
      const room = roomById(roomId);
      const readiness = validatePumpfunSettlementReadiness(room);
      if(!readiness.ok) return buildExternalSettlementErrorResult(readiness.error);
      if(!canCurrentWalletSettleDistribution(room)) return buildExternalSettlementErrorResult("Creator required to submit settlement.");

      try {
        const rawResult = await submitPumpfunSettlement(room);
        const normalized = normalizePumpfunSettlementResponse(rawResult, room);
        return {
          ...normalized,
          _httpStatus: rawResult?._httpStatus ?? null,
          _requestKind: rawResult?._requestKind || (shouldUseDevMockEndpoint(getPumpfunSettlementEndpoint()) ? "mock" : "live"),
        };
      } catch (err) {
        console.error("[pingy] submitRoomSettlementExternally failed", err);
        return buildExternalSettlementErrorResult("Settlement submission failed.");
      }
    }

    async function settleRoomDistributionOnPumpfun(roomId){
      const room = roomById(roomId);
      if(!room){
        showToast("Room not found.");
        return buildExternalSettlementErrorResult("Room not found.");
      }
      const readiness = validatePumpfunSettlementReadiness(room);
      if(!readiness.ok){
        showToast(readiness.error || "Settlement submission failed.");
        return buildExternalSettlementErrorResult(readiness.error || "Settlement submission failed.");
      }
      if(!canCurrentWalletSettleDistribution(room)){
        showToast("Creator required to submit settlement.");
        return buildExternalSettlementErrorResult("Creator required to submit settlement.");
      }
      room.settlement_submitting = true;
      safeRenderActiveRoom(room.id);
      safeRenderHome();
      try {
        setRoomExternalDebug(room, {
          last_action: "settlement_request",
          last_request_kind: shouldUseDevMockEndpoint(getPumpfunSettlementEndpoint()) ? "mock" : "live",
          last_response_kind: "",
          last_http_status: null,
          last_error: "",
        });
        const result = await submitRoomSettlementExternally(room.id);
        setRoomExternalDebug(room, {
          last_response_kind: result?.ok === false ? "error" : "success",
          last_http_status: result?._httpStatus ?? null,
          last_error: result?.ok === false ? String(result?.error || "Settlement submission failed.") : "",
        });
        const normalized = normalizePumpfunSettlementResponse(result, room);
        if(normalized.ok === false){
          showToast(normalized.error || "Settlement submission failed.");
          return normalized;
        }
        const applied = applyExternalSettlementResult(room.id, normalized);
        if(!applied){
          const failed = buildExternalSettlementErrorResult("Settlement submission failed.");
          showToast(failed.error);
          return failed;
        }
        addSystemEvent(room.id, "Distribution settlement submitted.");
        showToast("Distribution settled.");
        return normalized;
      } catch (err) {
        console.error("[pingy] settleRoomDistributionOnPumpfun failed", err);
        const failed = buildExternalSettlementErrorResult("Settlement submission failed.");
        setRoomExternalDebug(room, {
          last_response_kind: "error",
          last_http_status: null,
          last_error: String(err?.message || failed.error || "Settlement submission failed."),
        });
        showToast(failed.error);
        return failed;
      } finally {
        room.settlement_submitting = false;
        safeRenderActiveRoom(room.id);
        safeRenderHome();
      }
    }

    function buildPumpfunLaunchPayload(room){
      return {
        roomId: room.id || "",
        name: room.name || "",
        symbol: room.ticker || "",
        description: room.desc || "",
        image: room.image || "",
        banner: room.banner || "",
        twitter: room.socials?.x || "",
        telegram: room.socials?.tg || "",
        website: room.socials?.web || "",
        creatorWallet: room.creator_wallet || "",
        creatorBuySol: Number(room.creator_commit_sol || 0),
        launchMode: room.launch_mode || "spawn",
        launchPreset: room.launch_preset || "",
        minApprovedWallets: Number(room.min_approved_wallets || 0),
        spawnTargetSol: Number(room.spawn_target_sol || 0),
        maxWalletShareBps: Number(room.max_wallet_share_bps || 0),
        fundingMode: room.funding_mode || "vault",
        launchBackend: room.launch_backend || "pumpfun",
        externalPlatform: getRoomExternalPlatform(room) || "pumpfun",
      };
    }

    // Pump.fun launch request contract sent by Pingy
    // { roomId, name, symbol, description, image, banner, twitter, telegram, website, creatorWallet, creatorBuySol, launchMode, launchPreset, minApprovedWallets, spawnTargetSol, maxWalletShareBps, fundingMode, launchBackend, externalPlatform }
    function buildPumpfunLaunchRequest(room){
      const payload = buildPumpfunLaunchPayload(room);
      return {
        roomId: String(payload.roomId || "").trim(),
        name: String(payload.name || "").trim(),
        symbol: String(payload.symbol || "").trim(),
        description: String(payload.description || "").trim(),
        image: String(payload.image || "").trim(),
        banner: String(payload.banner || "").trim(),
        twitter: String(payload.twitter || "").trim(),
        telegram: String(payload.telegram || "").trim(),
        website: String(payload.website || "").trim(),
        creatorWallet: String(payload.creatorWallet || "").trim(),
        creatorBuySol: Number(payload.creatorBuySol || 0),
        launchMode: String(payload.launchMode || "spawn").trim(),
        launchPreset: String(payload.launchPreset || "").trim(),
        minApprovedWallets: Number(payload.minApprovedWallets || 0),
        spawnTargetSol: Number(payload.spawnTargetSol || 0),
        maxWalletShareBps: Number(payload.maxWalletShareBps || 0),
        fundingMode: String(payload.fundingMode || "vault").trim(),
        launchBackend: String(payload.launchBackend || "pumpfun").trim(),
        externalPlatform: String(payload.externalPlatform || "pumpfun").trim(),
      };
    }

    function buildExternalLaunchSuccessResult({
      status = "submitted",
      url = "",
      mint = "",
      payload = null,
      submitted_at = null,
      live_at = null,
      platform = "pumpfun",
    } = {}){
      return {
        ok: true,
        platform: String(platform || "pumpfun").toLowerCase() || "pumpfun",
        status: normalizePumpfunLaunchStatus(status),
        url: typeof url === "string" ? url : "",
        mint: typeof mint === "string" ? mint : "",
        payload: payload && typeof payload === "object" ? payload : null,
        submitted_at: Number.isFinite(Number(submitted_at)) && Number(submitted_at) > 0 ? Number(submitted_at) : null,
        live_at: Number.isFinite(Number(live_at)) && Number(live_at) > 0 ? Number(live_at) : null,
        error: null,
      };
    }

    function buildExternalLaunchErrorResult(error){
      const message = typeof error === "string"
        ? error
        : String(error?.message || error || "Launch submission failed.");
      return {
        ok: false,
        platform: "pumpfun",
        status: "draft",
        url: "",
        mint: "",
        payload: null,
        submitted_at: null,
        live_at: null,
        error: message,
      };
    }

    function validatePumpfunLaunchReadiness(room){
      if(!room) return { ok: false, error: "Room not found." };
      if(!isPumpfunRoom(room)) return { ok: false, error: "This room is not set to Pump.fun launch mode." };
      if(!String(room.name || "").trim()) return { ok: false, error: "Room name is required before launch handoff." };
      if(!String(room.ticker || "").trim()) return { ok: false, error: "Ticker is required before launch handoff." };
      if(!String(room.creator_wallet || "").trim()) return { ok: false, error: "Creator wallet is required before launch handoff." };
      if(room.state !== "SPAWNING") return { ok: false, error: "Launch handoff is only available during spawn formation." };
      if(getRoomLaunchStatus(room) !== "draft") return { ok: false, error: "Launch handoff has already been submitted." };
      return { ok: true, error: null };
    }

    function normalizeExternalLaunchSubmissionResult(result, room){
      if(!result || typeof result !== "object") {
        const invalidResult = buildExternalLaunchErrorResult("Launch submission failed.");
        invalidResult.payload = room ? buildPumpfunLaunchPayload(room) : null;
        return invalidResult;
      }

      if(result.ok === false){
        const errorResult = buildExternalLaunchErrorResult(result.error || "Launch submission failed.");
        errorResult.payload = result.payload && typeof result.payload === "object"
          ? result.payload
          : (room ? buildPumpfunLaunchPayload(room) : null);
        return errorResult;
      }
      const normalized = normalizePumpfunLaunchResult(result, room);
      return buildExternalLaunchSuccessResult({
        platform: normalized.platform || "pumpfun",
        status: normalized.status || "submitted",
        url: normalized.url,
        mint: normalized.mint,
        payload: normalized.payload,
        submitted_at: normalized.submitted_at,
        live_at: normalized.live_at,
      });
    }

    // Pump.fun launch response adapter for Pingy
    // Normalizes backend launch responses into Pingy's internal shape.
    function normalizePumpfunLaunchResponse(result, room){
      return normalizeExternalLaunchSubmissionResult(result, room);
    }

    function submitPumpfunLaunchMock(room){
      if(!room) return buildExternalLaunchErrorResult("Room not found.");
      const payload = buildPumpfunLaunchRequest(room);
      return buildExternalLaunchSuccessResult({
        platform: "pumpfun",
        status: "submitted",
        payload,
        url: "",
        mint: "",
        submitted_at: Date.now(),
        live_at: null,
      });
    }

    function getPumpfunLaunchEndpoint(){
      const configuredEndpoint = typeof window?.PINGY_PUMPFUN_LAUNCH_ENDPOINT === "string"
        ? window.PINGY_PUMPFUN_LAUNCH_ENDPOINT
        : PINGY_PUMPFUN_LAUNCH_ENDPOINT;
      return String(configuredEndpoint || "").trim();
    }

    function hasPumpfunLaunchEndpoint(){
      return hasConfiguredEndpoint(getPumpfunLaunchEndpoint());
    }

    async function submitPumpfunLaunch(room){
      // a) validate room
      if(!room) return buildExternalLaunchErrorResult("Room not found.");
      const payload = buildPumpfunLaunchRequest(room);

      // b) resolve endpoint
      const endpoint = getPumpfunLaunchEndpoint();
      const requestKind = shouldUseDevMockEndpoint(endpoint) ? "mock" : "live";

      // c) dev mock fallback path
      if(shouldUseDevMockEndpoint(endpoint)) return { ...submitPumpfunLaunchMock(room), _httpStatus: null, _requestKind: requestKind };

      // d) non-dev missing endpoint path
      if(!hasConfiguredEndpoint(endpoint)) return { ...buildExternalLaunchErrorResult("No launch endpoint configured."), _httpStatus: null, _requestKind: requestKind };

      // e) live POST path
      const response = await postJsonToEndpoint(endpoint, payload, { defaultErrorMessage: "Launch submission failed" });
      const rawResult = response.ok
        ? response.data
        : buildExternalLaunchErrorResult(response.error || "Launch submission failed.");

      const withDebugMeta = {
        ...rawResult,
        _httpStatus: response.status ?? null,
        _requestKind: requestKind,
      };

      if(withDebugMeta?.payload && typeof withDebugMeta.payload === "object"){
        return withDebugMeta;
      }
      return { ...withDebugMeta, payload };
    }

    async function submitRoomLaunchExternally(roomId){
      const room = roomById(roomId);
      const readiness = validatePumpfunLaunchReadiness(room);
      if(!readiness.ok) return buildExternalLaunchErrorResult(readiness.error);
      if(DEBUG_EXTERNAL_STATUS){
        console.log("[pingy] submitRoomLaunchExternally permission check", {
          roomId: room?.id,
          connectedWallet,
          creator_wallet: room?.creator_wallet,
          creatorMatch: isCreator(room, connectedWallet),
          canLaunchPumpfunRoom: canCurrentWalletLaunchPumpfunRoom(room),
        });
      }
      if(!canCurrentWalletLaunchPumpfunRoom(room)) return buildExternalLaunchErrorResult("Creator required to submit launch handoff.");

      try {
        const rawResult = await submitPumpfunLaunch(room);
        const normalized = normalizePumpfunLaunchResponse(rawResult, room);
        return {
          ...normalized,
          _httpStatus: rawResult?._httpStatus ?? null,
          _requestKind: rawResult?._requestKind || (shouldUseDevMockEndpoint(getPumpfunLaunchEndpoint()) ? "mock" : "live"),
        };
      } catch (err) {
        console.error("[pingy] submitRoomLaunchExternally failed", err);
        return buildExternalLaunchErrorResult("Launch submission failed.");
      }
    }

    async function launchRoomOnPumpfun(roomId){
      const room = roomById(roomId);
      if(!room){
        showToast("Room not found.");
        return buildExternalLaunchErrorResult("Room not found.");
      }
      debugLaunchAuthority(room, "launchRoomOnPumpfun:before-check");
      const readiness = validatePumpfunLaunchReadiness(room);
      if(!readiness.ok){
        showToast(readiness.error || "Launch submission failed.");
        return buildExternalLaunchErrorResult(readiness.error || "Launch submission failed.");
      }
      if(!canCurrentWalletLaunchExternally(room)){
        showToast("You are not allowed to submit launch handoff.");
        return buildExternalLaunchErrorResult("You are not allowed to submit launch handoff.");
      }
      room.launch_submitting = true;
      safeRenderActiveRoom(room.id);
      safeRenderHome();
      try {
        setRoomExternalDebug(room, {
          last_action: "launch_request",
          last_request_kind: shouldUseDevMockEndpoint(getPumpfunLaunchEndpoint()) ? "mock" : "live",
          last_response_kind: "",
          last_http_status: null,
          last_error: "",
        });
        if(DEBUG_EXTERNAL_STATUS){
          console.log("[pingy] launch permission check", {
            roomId: room?.id,
            connectedWallet,
            creator_wallet: room?.creator_wallet,
            creatorMatch: isCreator(room, connectedWallet),
            canLaunchExternally: canCurrentWalletLaunchExternally(room),
            state: room?.state,
            launchMode: roomLaunchMode(room),
            launchStatus: getRoomLaunchStatus(room),
          });
        }
        const result = await submitRoomLaunchExternally(room.id);
        setRoomExternalDebug(room, {
          last_response_kind: result?.ok === false ? "error" : "success",
          last_http_status: result?._httpStatus ?? null,
          last_error: result?.ok === false ? String(result?.error || "Launch submission failed.") : "",
        });
        if(result?.ok === false){
          showToast(result.error || "Launch submission failed.");
          return result;
        }
        const applied = applyExternalLaunchResult(room.id, result);
        if(!applied){
          const failedResult = buildExternalLaunchErrorResult("Launch submission failed.");
          showToast(failedResult.error);
          return failedResult;
        }
        snapshotRoomLaunchVaultAccounting(applied);
        saveLaunchRecordsToLocalStorage();
        addSystemEvent(room.id, "Launch submitted to Pump.fun.");
        showToast("Launch submitted.");
        return result;
      } catch (err) {
        console.error("[pingy] launchRoomOnPumpfun failed", err);
        const failedResult = buildExternalLaunchErrorResult("Launch submission failed.");
        setRoomExternalDebug(room, {
          last_response_kind: "error",
          last_http_status: null,
          last_error: String(err?.message || failedResult.error || "Launch submission failed."),
        });
        showToast(failedResult.error);
        return failedResult;
      } finally {
        room.launch_submitting = false;
        safeRenderActiveRoom(room.id);
        safeRenderHome();
      }
    }

    function applyExternalLaunchStatusPatch(roomId, patch = {}){
      if(!patch || typeof patch !== "object") return null;
      const room = roomById(roomId);
      if(!room) return null;
      const current = getRoomExternalLaunchRecord(room) || {};
      const merged = {
        ok: true,
        platform: patch.platform || current.backend || "pumpfun",
        status: typeof patch.status === "string" ? patch.status : current.status || getRoomLaunchStatus(room),
        url: typeof patch.url === "string" ? patch.url : current.url || getRoomExternalLaunchUrl(room),
        mint: typeof patch.mint === "string" ? patch.mint : current.mint || getRoomExternalMint(room),
        payload: patch.payload && typeof patch.payload === "object" ? patch.payload : current.payload || null,
        submitted_at: patch.submitted_at ?? current.submitted_at ?? null,
        live_at: patch.live_at ?? current.live_at ?? null,
        tokens_received: patch.tokens_received ?? room.external_tokens_received ?? 0,
        tokens_distributed: patch.tokens_distributed ?? room.external_tokens_distributed ?? 0,
        distribution_status: patch.distribution_status ?? room.external_distribution_status ?? resolveRoomExternalDistributionStatus(room),
      };
      if(typeof patch.external_distribution_mode === "string" && patch.external_distribution_mode.trim()){
        room.external_distribution_mode = patch.external_distribution_mode.trim();
      }
      if(typeof patch.external_distribution_notes === "string" && patch.external_distribution_notes.trim()){
        room.external_distribution_notes = patch.external_distribution_notes;
      }
      if(patch.external_distribution_updated_at != null){
        const nextUpdated = Number(patch.external_distribution_updated_at);
        if(Number.isFinite(nextUpdated) && nextUpdated > 0) room.external_distribution_updated_at = nextUpdated;
      }
      return applyExternalLaunchResult(roomId, merged);
    }

    function markRoomLiveExternally(roomId, {
      externalLaunchUrl = "",
      externalMint = "",
      tokensReceived = null,
      tokensDistributed = null,
      distributionStatus = "",
    } = {}){
      const room = roomById(roomId);
      if(!room){
        showToast("Room not found.");
        return false;
      }
      if(!canCurrentWalletMarkLiveExternally(room)){
        showToast("Mark live is limited to dev simulation creator/approver/admin controls.");
        return false;
      }
      const nextUrl = typeof externalLaunchUrl === "string" ? externalLaunchUrl.trim() : "";
      const nextMint = typeof externalMint === "string" ? externalMint.trim() : "";
      const patch = {
        status: "live",
        live_at: Date.now(),
        platform: "pumpfun",
      };
      if(nextUrl) patch.url = nextUrl;
      if(nextMint) patch.mint = nextMint;
      if(tokensReceived != null) patch.tokens_received = tokensReceived;
      if(tokensDistributed != null) patch.tokens_distributed = tokensDistributed;
      if(typeof distributionStatus === "string" && distributionStatus.trim()) patch.distribution_status = distributionStatus;

      const applied = applyExternalLaunchStatusPatch(roomId, patch);
      if(applied && isPumpfunRoom(applied) && isRoomLaunchLive(applied) && !hasFrozenDistributionSnapshot(applied)){
        freezeRoomDistributionSnapshot(applied);
        snapshotRoomExternalDistributionPlan(applied);
      }
      if(!applied){
        showToast("Failed to mark launch live.");
        return false;
      }

      addSystemEvent(room.id, "Launch is now live externally.");
      safeRenderActiveRoom(room.id);
      safeRenderHome();
      return true;
    }

    function simulateRoomDistributionSettlement(roomId){
      const room = roomById(roomId);
      if(!room || !canCurrentWalletSimulateDistribution(room)){
        showToast("Distribution simulation is limited to dev creator controls.");
        return false;
      }
      if(!isPumpfunRoom(room) || !isRoomLaunchLive(room)){
        showToast("Settlement simulation requires a live Pump.fun room.");
        return false;
      }
      if(!hasFrozenDistributionSnapshot(room)) freezeRoomDistributionSnapshot(room);
      syncRoomDistributionReceiptsWithPlan(room);
      const ts = Date.now();
      const txId = `dev-distribution-${String(ts).slice(-8)}`;
      const receipts = getRoomDistributionReceipts(room);
      for(const row of getRoomPlannedDistributionRows(room)){
        const wallet = String(row?.wallet || "").trim();
        if(!wallet) continue;
        const plannedTokens = toSafeExternalTokenAmount(row?.planned_tokens, 0);
        receipts[wallet] = {
          planned_tokens: plannedTokens,
          sent_tokens: plannedTokens,
          tx_id: txId,
          sent_at: ts,
          status: "complete",
        };
      }
      room.external_distribution_receipts = receipts;
      room.external_distribution_updated_at = ts;
      snapshotRoomExternalDistributionPlan(room);
      validateDistributionSnapshot(room);
      console.debug("[pingy] distribution preview", buildRoomDistributionPreview(room));
      addSystemEvent(room.id, "Distribution settlement marked complete (dev simulation).");
      renderRoom(room.id);
      renderHome();
      return true;
    }

    function simulateRoomDistributionComplete(roomId){
      return simulateRoomDistributionSettlement(roomId);
    }

    function openExternalLaunchForRoom(roomId){
      const room = roomById(roomId);
      if(!room) return;
      const url = getRoomExternalLaunchUrl(room).trim();
      if(!url){
        showToast("No external launch URL yet.");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    }

    function normalizeLaunchRoom(room, { launchMode = null, creatorCommitSol = null } = {}){
      if(!room || typeof room !== "object") return room;
      const mode = String(launchMode || room.launch_mode || "spawn").toLowerCase() === "instant" ? "instant" : "spawn";
      const parsedCommit = Number(creatorCommitSol);
      const normalizedCommit = Number.isFinite(parsedCommit) && parsedCommit > 0 ? parsedCommit : 0;
      const toSafeNumber = (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
      };
      room.launch_vault_sol = toSafeNumber(room.launch_vault_sol, 0);
      room.launch_vault_net_sol = toSafeNumber(room.launch_vault_net_sol, 0);
      room.launch_fee_sol = toSafeNumber(room.launch_fee_sol, 0);
      room.launch_creator_buy_sol = toSafeNumber(room.launch_creator_buy_sol, 0);
      room.external_tokens_received = toSafeExternalTokenAmount(room.external_tokens_received, 0);
      room.external_tokens_distributed = toSafeExternalTokenAmount(room.external_tokens_distributed, 0);
      room.external_distribution_mode = String(room.external_distribution_mode || "pro_rata").trim() || "pro_rata";
      room.external_distribution_updated_at = Number.isFinite(Number(room.external_distribution_updated_at)) && Number(room.external_distribution_updated_at) > 0
        ? Number(room.external_distribution_updated_at)
        : null;
      room.external_distribution_notes = typeof room.external_distribution_notes === "string" ? room.external_distribution_notes : "";
      room.external_distribution_total_recipients = toSafeNumber(room.external_distribution_total_recipients, 0);
      room.external_distribution_total_tokens_planned = toSafeExternalTokenAmount(room.external_distribution_total_tokens_planned, 0);
      room.external_distribution_total_tokens_sent = toSafeExternalTokenAmount(
        room.external_distribution_total_tokens_sent,
        toSafeExternalTokenAmount(room.external_tokens_distributed, 0),
      );
      const existingBootstrapLamports = Number(room.bootstrap_cost_lamports);
      const fallbackBootstrapLamports = Math.max(0, Math.round(Number(room.bootstrap_cost_sol || 0) * LAMPORTS_PER_SOL));
      const normalizedBootstrapLamports = Number.isFinite(existingBootstrapLamports) && existingBootstrapLamports >= 0
        ? Math.round(existingBootstrapLamports)
        : fallbackBootstrapLamports;
      const normalizedBootstrapLocked = room.bootstrap_locked === true;
      const existingBootstrapBreakdown = room.bootstrap_cost_breakdown && typeof room.bootstrap_cost_breakdown === "object"
        ? room.bootstrap_cost_breakdown
        : null;
      applyRoomBootstrapCostMeta(room, normalizedBootstrapLamports, {
        known: !!existingBootstrapBreakdown?.known,
        note: existingBootstrapBreakdown?.note || "bootstrap cost tracking placeholder",
        lock: normalizedBootstrapLocked,
      });
      room.distribution_snapshot_locked_at = Number.isFinite(Number(room.distribution_snapshot_locked_at)) && Number(room.distribution_snapshot_locked_at) > 0
        ? Number(room.distribution_snapshot_locked_at)
        : null;
      room.distribution_snapshot_source_status = typeof room.distribution_snapshot_source_status === "string"
        ? room.distribution_snapshot_source_status
        : "";
      room.distribution_snapshot_total_weight = toSafeNumber(room.distribution_snapshot_total_weight, 0);
      room.distribution_snapshot_total_recipients = toSafeNumber(room.distribution_snapshot_total_recipients, 0);
      room.distribution_snapshot_rows = Array.isArray(room.distribution_snapshot_rows)
        ? room.distribution_snapshot_rows.map((row) => ({
          wallet: typeof row?.wallet === "string" ? row.wallet : "",
          committed_sol: toSafeNumber(row?.committed_sol, 0),
          weight: toSafeNumber(row?.weight, 0),
          planned_tokens: toSafeExternalTokenAmount(row?.planned_tokens, 0),
        })).filter((row) => row.wallet)
        : [];
      getRoomDistributionReceipts(room);
      syncRoomDistributionReceiptsWithPlan(room);
      snapshotRoomExternalDistributionPlan(room);
      if(isPumpfunLaunchBackend()){
        room.launch_backend = "pumpfun";
        room.launch_status = normalizePumpfunLaunchStatus(room.launch_status);
        room.external_platform = room.external_platform || "pumpfun";
        room.external_launch_url = typeof room.external_launch_url === "string" ? room.external_launch_url : "";
        room.external_mint = typeof room.external_mint === "string" ? room.external_mint : "";
        room.funding_mode = room.funding_mode || "vault";
        room.creator_commit_sol = normalizedCommit;
        room.state = "SPAWNING";
        room.market_cap_usd = 0;
        const externalLaunch = normalizeExternalLaunchRecord(room);
        if(externalLaunch){
          externalLaunch.backend = "pumpfun";
          externalLaunch.status = normalizePumpfunLaunchStatus(externalLaunch.status || room.launch_status);
          externalLaunch.url = room.external_launch_url;
          externalLaunch.mint = room.external_mint;
          if(room._lastLaunchPayload && typeof room._lastLaunchPayload === "object") externalLaunch.payload = room._lastLaunchPayload;
          room.launch_status = externalLaunch.status;
          room.external_platform = "pumpfun";
          room.external_launch_url = externalLaunch.url;
          room.external_mint = externalLaunch.mint;
        }
      } else {
        room.launch_backend = room.launch_backend || "native";
        room.launch_status = normalizePumpfunLaunchStatus(room.launch_status);
        room.external_platform = room.external_platform || "";
        room.external_launch_url = typeof room.external_launch_url === "string" ? room.external_launch_url : "";
        room.external_mint = typeof room.external_mint === "string" ? room.external_mint : "";
        room.funding_mode = room.funding_mode || "vault";
        if(typeof room.creator_commit_sol !== "number") room.creator_commit_sol = normalizedCommit;
        if(mode === "instant") room.state = room.state || "BONDING";
        normalizeExternalLaunchRecord(room);
      }
      return room;
    }

    function applyExternalLaunchResult(roomId, result = {}){
      const room = roomById(roomId);
      if(!room || !result || typeof result !== "object") return null;
      if(result.ok === false) return null;
      const normalizedResult = normalizePumpfunLaunchResult(result, room);
      if(DEBUG_EXTERNAL_STATUS) console.log("[pingy] normalized external launch result", normalizedResult);
      normalizeLaunchRoom(room);
      const externalLaunch = normalizeExternalLaunchRecord(room);
      if(!externalLaunch) return null;

      if(typeof normalizedResult.status === "string"){
        const nextStatus = normalizePumpfunLaunchStatus(normalizedResult.status);
        if(["draft", "submitted", "live"].includes(nextStatus)) externalLaunch.status = nextStatus;
      }
      if(typeof normalizedResult.url === "string" && normalizedResult.url.trim()) externalLaunch.url = normalizedResult.url.trim();
      if(typeof normalizedResult.mint === "string" && normalizedResult.mint.trim()) externalLaunch.mint = normalizedResult.mint.trim();
      if(normalizedResult.payload && typeof normalizedResult.payload === "object") externalLaunch.payload = normalizedResult.payload;

      const submittedAt = Number(normalizedResult.submitted_at);
      if(Number.isFinite(submittedAt) && submittedAt > 0) externalLaunch.submitted_at = submittedAt;
      const liveAt = Number(normalizedResult.live_at);
      if(Number.isFinite(liveAt) && liveAt > 0) externalLaunch.live_at = liveAt;

      const platform = String(normalizedResult.platform || "").toLowerCase();
      externalLaunch.backend = platform === "pumpfun" || !platform ? "pumpfun" : externalLaunch.backend;

      if(normalizedResult.has_tokens_received){
        room.external_tokens_received = toSafeExternalTokenAmount(
          normalizedResult.tokens_received,
          toSafeExternalTokenAmount(room.external_tokens_received, 0),
        );
      }
      if(normalizedResult.has_tokens_distributed){
        room.external_tokens_distributed = toSafeExternalTokenAmount(
          normalizedResult.tokens_distributed,
          toSafeExternalTokenAmount(room.external_tokens_distributed, 0),
        );
        room.external_distribution_total_tokens_sent = toSafeExternalTokenAmount(
          normalizedResult.tokens_distributed,
          toSafeExternalTokenAmount(room.external_distribution_total_tokens_sent, 0),
        );
      }
      snapshotRoomExternalDistributionPlan(room);
      if(isPumpfunRoom(room) && normalizePumpfunLaunchStatus(normalizedResult.status || room.launch_status) === "live" && !hasFrozenDistributionSnapshot(room)){
        freezeRoomDistributionSnapshot(room);
      }
      syncRoomDistributionReceiptsWithPlan(room);
      snapshotRoomExternalDistributionPlan(room);
      validateDistributionSnapshot(room);

      mirrorExternalLaunchLegacyFields(room, externalLaunch);
      if(DEBUG_EXTERNAL_STATUS) console.log("[pingy] applied external launch result", {
        roomId,
        launch_status: room.launch_status,
        external_launch_url: room.external_launch_url,
        external_mint: room.external_mint,
        external_tokens_received: room.external_tokens_received,
        external_tokens_distributed: room.external_tokens_distributed,
        external_distribution_status: room.external_distribution_status,
      });
      saveLaunchRecordsToLocalStorage();

      safeRenderActiveRoom(room.id);
      safeRenderHome();
      return room;
    }

    const DEV_SIMULATION = !!(window?.location?.hostname === "localhost" || window?.location?.hostname === "127.0.0.1" || window?.location?.hostname === "0.0.0.0" || window?.location?.hostname?.endsWith?.(".local") || window?.location?.search?.includes("devsim=1"));
    const DEBUG_EXTERNAL_STATUS = DEV_SIMULATION;
    const DEBUG_WALLET_SMOKE_BEFORE_SPAWN_TX = false;
    const DEV_SIM_DEFAULT_SEED = 1337;
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");


    let homeView;
    let roomView;
    let chatView;
    let profileView;
    let legalView;
    let homeBtn;
    let roomContextToggleBtn;

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

    function isInvalidWalletArgumentsError(err){
      const msg = String(err?.message || err || "").toLowerCase();
      return msg.includes("invalid arguments") || msg.includes("invalid params");
    }

    function explorerTxUrl(signature){
      return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
    }

    function explorerAddressUrl(address){
      return `https://explorer.solana.com/address/${address}?cluster=devnet`;
    }

    function lifecyclePhaseLabel(state){
      if(state === "SPAWNING") return "SPAWNING";
      if(state === "BONDING") return "BONDING";
      if(state === "BONDED") return "BONDED";
      return state || "—";
    }

    function primaryActionForRoom(room){
      if(isPumpfunLaunchBackend()){
        if(room?.state === "SPAWNING") return { label: "ping", opensTrade: true };
        return { label: "open", opensTrade: false };
      }
      if(room?.state === "BONDING") return { label: "buy", opensTrade: true };
      if(room?.state === "BONDED") return { label: "graduated", opensTrade: false };
      return { label: "ping", opensTrade: true };
    }

    function isPumpfunPostSpawnRoom(room){
      return isPumpfunLaunchBackend() && room?.state !== "SPAWNING";
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
      const isChat = (which === "chat");
      const isProfile = (which === "profile");
      const isLegal = (which === "legal");
      homeView.classList.toggle("on", isHome);
      roomView.classList.toggle("on", isRoom);
      chatView.classList.toggle("on", isChat);
      profileView.classList.toggle("on", isProfile);
      legalView.classList.toggle("on", isLegal);
      homeBtn.style.display = isHome ? "none" : "inline-block";
      if(roomContextToggleBtn){
        const showRoomContextToggle = (isRoom || isChat) && !!activeRoomId;
        roomContextToggleBtn.style.display = showRoomContextToggle ? "inline-block" : "none";
        roomContextToggleBtn.textContent = isChat ? "market" : "chat";
      }
      const roomActionDock = $("roomActionDock");
      if(roomActionDock) roomActionDock.style.display = isRoom ? "block" : "none";
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
      if(r.positions[wallet].deposit_exists == null) r.positions[wallet].deposit_exists = false;
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

    function defaultPersistedRoomLaunchConfig(){
      const preset = PRESETS.fast;
      const spawnTargetSol = Number(preset.targetSol || 0);
      const maxWalletShareBps = Number(preset.maxWalletShareBps || 0);
      return {
        launchMode: "spawn",
        launchPreset: preset.key,
        minApprovedWallets: Number(preset.minWallets || 0),
        spawnTargetSol,
        spawnTargetLamports: Math.round(spawnTargetSol * LAMPORTS_PER_SOL),
        maxWalletShareBps,
        maxWalletSharePct: maxWalletShareBps / 100,
        capPerWalletSol: spawnTargetSol * (maxWalletShareBps / 10000),
      };
    }

    function normalizeSupabaseRoomRowId(rowId){
      const numericId = Number(rowId);
      if(!Number.isFinite(numericId) || numericId <= 0) return "";
      return String(Math.trunc(numericId));
    }

    function normalizeSupabasePublicRoomId(publicId){
      // `public_id` is now the canonical app-facing room identity for routes, lookup,
      // and any on-chain thread ids created after the Supabase row reservation step.
      const normalizedPublicId = String(publicId || "").trim();
      return normalizedPublicId || "";
    }

    function applyPersistedRoomMetadata(room, row = {}){
      if(!room || !row || typeof row !== "object") return room;
      const normalizedRowId = normalizeSupabaseRoomRowId(row.id);
      if(normalizedRowId) room._supabaseRowId = normalizedRowId;
      const normalizedPublicId = normalizeSupabasePublicRoomId(row.public_id);
      if(normalizedPublicId) room.public_id = normalizedPublicId;
      if(typeof row.description === "string") room.desc = row.description;
      if(typeof row.image_path === "string" && row.image_path.trim()) room.image = row.image_path.trim();
      if(typeof row.banner_path === "string" && row.banner_path.trim()) room.banner = row.banner_path.trim();
      if(typeof row.created_at === "string" && row.created_at.trim()) room.created_at = row.created_at.trim();
      if(typeof row.is_test === "boolean") room.is_test = row.is_test;
      return room;
    }

    function mapSupabaseRoomRowToRoom(row){
      if(!row || typeof row !== "object") return null;
      const roomId = normalizeSupabasePublicRoomId(row.public_id);
      if(!roomId) return null;
      const room = mkRoom(
        roomId,
        String(row.name || "").trim() || "untitled",
        String(row.ticker || "").trim().toUpperCase() || "PINGY",
        String(row.description || "").trim(),
        defaultPersistedRoomLaunchConfig(),
        String(row.creator_wallet || "").trim() || DEFAULT_MOCK_CREATOR_WALLET,
      );
      applyPersistedRoomMetadata(room, row);
      return room;
    }

    async function loadRoomsFromSupabase(){
      const result = await listSupabaseRoomsMetadata();
      if(!result?.ok){
        if(result?.skipped) console.info("[pingy] supabase rooms disabled; keeping local fallback rooms");
        else console.warn("[pingy] failed loading Supabase rooms; keeping local fallback rooms", result?.error || "unknown error");
        return [];
      }
      return Array.isArray(result.data)
        ? result.data.map(mapSupabaseRoomRowToRoom).filter(Boolean)
        : [];
    }

    async function hydrateRoomsFromSupabase(){
      // Keep the existing mock/local rooms as a transition fallback. Replace them only
      // when Supabase returns actual room rows so the UI still works without config.
      const persistedRooms = await loadRoomsFromSupabase();
      if(persistedRooms.length <= 0) return false;
      state.rooms = persistedRooms;
      return true;
    }

    async function reserveSupabaseRoomMetadata(payload){
      const result = await insertSupabaseRoomMetadata(payload);
      if(!result?.ok){
        if(!result?.skipped) console.warn("[pingy] failed reserving Supabase room row", result?.error || "unknown error");
        return null;
      }
      const row = result.data && typeof result.data === "object" ? result.data : null;
      const rowId = normalizeSupabaseRoomRowId(row?.id);
      const runtimeRoomId = normalizeSupabasePublicRoomId(row?.public_id);
      if(!row || !rowId || !runtimeRoomId){
        console.warn("[pingy] Supabase room insert returned an unusable public_id; falling back to local room id");
        return null;
      }
      return { row, rowId, runtimeRoomId };
    }

    async function cleanupReservedSupabaseRoom(reservation){
      const rowId = normalizeSupabaseRoomRowId(reservation?.rowId || reservation?.row?.id);
      if(!rowId) return;
      const result = await deleteSupabaseRoomMetadataByRowId(rowId);
      if(!result?.ok && !result?.skipped){
        console.warn("[pingy] failed cleaning up Supabase room row after create failure", result?.error || "unknown error");
      }
    }

    function getCreateLaunchMode(){
      return String($("newLaunchMode")?.value || "spawn").toLowerCase() === "instant" ? "instant" : "spawn";
    }

    function launchModeByte(mode){
      return String(mode || "spawn").toLowerCase() === "instant" ? 1 : 0;
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

    function creatorCommitSol(room){
      const creatorWallet = room?.creator_wallet;
      if(!creatorWallet) return 0;
      const onchainRow = room?.onchain?.byWallet?.[creatorWallet] || state.onchain?.[room?.id]?.byWallet?.[creatorWallet] || null;
      if(onchainRow) return getWalletGrossCommittedSol(room, creatorWallet, onchainRow);
      const creatorPos = room?.positions?.[creatorWallet];
      return Number(creatorPos?.escrow_sol || 0);
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
      pos.deposit_exists = true;
      return sol;
    }

    function applyOptimisticSpawnCommitLamports(room, wallet, committedLamports){
      const r = roomById(room?.id || room);
      if(!r || !wallet) return;
      const safeCommittedLamports = Math.max(0, Math.round(Number(committedLamports || 0)));
      if(safeCommittedLamports <= 0) return;
      const committedSol = safeCommittedLamports / LAMPORTS_PER_SOL;

      applySpawnCommit(r, wallet, committedSol);

      const snapshot = state.onchain?.[r.id] || r.onchain;
      if(!snapshot) return;
      if(!snapshot.byWallet || typeof snapshot.byWallet !== "object") snapshot.byWallet = {};

      const existingRow = snapshot.byWallet[wallet] || {};
      const prevCommittedLamports = Math.max(0, Math.round(Number(
        existingRow.committed_lamports
        ?? existingRow.withdrawable_lamports
        ?? ((Number(existingRow.withdrawable_sol ?? existingRow.escrow_sol ?? 0)) * LAMPORTS_PER_SOL)
      ) || 0));
      const nextCommittedLamports = prevCommittedLamports + safeCommittedLamports;
      const nextCommittedSol = nextCommittedLamports / LAMPORTS_PER_SOL;

      snapshot.byWallet[wallet] = {
        ...existingRow,
        status: existingRow.status || "pending",
        committed_lamports: nextCommittedLamports,
        committed_sol: nextCommittedSol,
        withdrawable_lamports: nextCommittedLamports,
        withdrawable_sol: nextCommittedSol,
        allocated_lamports: nextCommittedLamports,
        allocated_sol: nextCommittedSol,
        escrow_sol: nextCommittedSol,
      };

      snapshot.total_allocated_lamports = Math.max(0, Number(snapshot.total_allocated_lamports || 0) + safeCommittedLamports);
      snapshot.total_escrow_lamports = Math.max(0, Number(snapshot.total_escrow_lamports || 0) + safeCommittedLamports);
      if(!Array.isArray(snapshot.approvedWallets)) snapshot.approvedWallets = [];
      if(!Array.isArray(snapshot.pendingWallets)) snapshot.pendingWallets = [];
      if(!snapshot.approvedWallets.includes(wallet) && !snapshot.pendingWallets.includes(wallet)) snapshot.pendingWallets.push(wallet);
      r.onchain = snapshot;
      state.onchain[r.id] = snapshot;
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
        for(const wallet of approvedWallets){
          const committed = Math.max(0, Number(getWalletGrossCommittedSol(r, wallet) || 0));
          allocated += capSol > 0 ? Math.min(committed, capSol) : committed;
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
        else if(room?.state === "BONDED") status.textContent = isPumpfunLaunchBackend() ? "external market lifecycle chart" : "bonded lifecycle chart";
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
        const spawningLabel = room?.state === "SPAWNING" ? " (implied)" : "";
        const committed = getRoomTotalCommittedSol(room);
        const volumeLabel = room?.state === "SPAWNING" ? "Committed SOL" : "24h Volume";
        const volumeValue = room?.state === "SPAWNING"
          ? `${committed.toFixed(3)} SOL`
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
    const boundWalletProviders = new WeakSet();

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

    const DEFAULT_MOCK_CREATOR_WALLET = "11111111111111111111111111111111";

    const state = {
      rooms: [
        mkRoom("r1","cats","CATS","just a mock coin", null, DEFAULT_MOCK_CREATOR_WALLET),
        mkRoom("r2","pump_alpha","ALPHA","tokenized attention", null, DEFAULT_MOCK_CREATOR_WALLET),
        mkRoom("r3","meme_lab","MEME","chaos, but organized", null, DEFAULT_MOCK_CREATOR_WALLET),
        mkRoom("r4","orbit_mint","ORBT","countdown to ignition", null, DEFAULT_MOCK_CREATOR_WALLET),
        mkRoom("r5","liquid_hype","HYPE","everyone is watching", null, DEFAULT_MOCK_CREATOR_WALLET),
        mkRoom("r6","night_shift","NITE","late hours, loud charts", null, DEFAULT_MOCK_CREATOR_WALLET)
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
      maxPingCommittedLamports: 0,
      depositRentLamportsEstimate: null,
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
      },
      activeHomeTab: "explore",
      activePingThreadId: null,
      pingReadByWallet: {},
      grossCommitDebugMeta: {},
      launchTrustExpandedByRoom: {}
    };

    const ONCHAIN_REFRESH_MS = 7000;
    const WALLET_BAL_REFRESH_MS = 6000;

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

function encodeU8Arg(v){
  const out = new Uint8Array(1);
  new DataView(out.buffer).setUint8(0, Number(v || 0));
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
        throw new Error(`Invalid public key for ${label}: ${String(value)}`);
      }
    }

    function assertIxPubkeys(ix){
      if(!ix){
        throw new Error(`Missing instruction: ${String(ix)}`);
      }
      const keys = ix.keys;
      if(!Array.isArray(keys)){
        throw new Error(`Missing key array on instruction: ${String(keys)}`);
      }
      keys.forEach((k, i) => {
        if(!k){
          throw new Error(`Missing key in instruction key ${i}: ${String(k)}`);
        }
        if(!k.pubkey){
          throw new Error(`Missing pubkey in instruction key ${i}: ${String(k.pubkey)}`);
        }
        const rawPubkey = k.pubkey?.toBase58 ? k.pubkey.toBase58() : k.pubkey;
        try {
          parsePublicKeyStrict(rawPubkey, `instruction key ${i}`);
        } catch (_err){
          throw new Error(`Invalid pubkey in key ${i}: ${String(rawPubkey)}`);
        }
      });
      if(!ix.programId){
        throw new Error(`Invalid programId: ${String(ix.programId)}`);
      }
      const rawProgramId = ix.programId?.toBase58 ? ix.programId.toBase58() : ix.programId;
      try {
        parsePublicKeyStrict(rawProgramId, "instruction programId");
      } catch (_err){
        throw new Error(`Invalid programId: ${String(rawProgramId)}`);
      }
    }

    function parseSystemTransferDetails(ix){
      if(!ix || ix.programId?.toBase58?.() !== SystemProgram.programId.toBase58()) return null;
      const data = ix.data;
      if(!(data instanceof Uint8Array) || data.length < 12) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const instructionType = view.getUint32(0, true);
      if(instructionType !== 2) return null;
      const lamports = Number(view.getBigUint64(4, true));
      return {
        fromPubkey: ix.keys?.[0]?.pubkey?.toBase58?.() || "",
        toPubkey: ix.keys?.[1]?.pubkey?.toBase58?.() || "",
        lamports,
      };
    }

    function parsePingDepositDetails(ix){
      if(!ix || ix.programId?.toBase58?.() !== PROGRAM_ID.toBase58()) return null;
      const keys = Array.isArray(ix.keys) ? ix.keys : [];
      if(keys.length !== 5 && keys.length !== 6) return null;
      if(keys[keys.length - 1]?.pubkey?.toBase58?.() !== SystemProgram.programId.toBase58()) return null;
      const data = ix.data;
      if(!(data instanceof Uint8Array) || data.length < 8) return null;
      const lamportsOffset = data.length - 8;
      if(lamportsOffset < 0) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return {
        lamports: Number(view.getBigUint64(lamportsOffset, true)),
      };
    }

    async function sendProgramInstructions(ixs, debugMeta = null){
      const provider = getProvider();
      if(!provider) throw new Error("Phantom not found");
      if(!connectedWallet) throw new Error("Wallet not connected");

      const instructions = Array.isArray(ixs) ? ixs.flat().filter(Boolean) : [ixs].filter(Boolean);
      if(!instructions.length) throw new Error("No instructions provided");

      console.log("[ping-debug] sendProgramInstructions pre-assert", instructions.map((ix, idx) => ({
        idx,
        programId: ix?.programId?.toBase58?.() || String(ix?.programId),
        keyCount: Array.isArray(ix?.keys) ? ix.keys.length : -1,
        keys: (ix?.keys || []).map((k, i) => ({
          i,
          pubkey: k?.pubkey?.toBase58?.() || String(k?.pubkey),
          isSigner: !!k?.isSigner,
          isWritable: !!k?.isWritable
        }))
      })));

      try { instructions.forEach(assertIxPubkeys); }
      catch(e){ showToast(String(e?.message || e)); throw e; }

      let feePayer;
      try {
        const providerPk = provider.publicKey?.toBase58?.() || connectedWallet;
        feePayer = parsePublicKeyStrict(providerPk, "provider public key");
      } catch(e){ showToast(String(e?.message || e)); throw e; }

      let blockhash, lastValidBlockHeight;
      try {
        ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));
      } catch(e){ showToast("getLatestBlockhash: " + (e?.message||e)); throw e; }

      const tx = new Transaction({
        feePayer,
        recentBlockhash: blockhash,
      });
      instructions.forEach((ix) => tx.add(ix));

      const expectedFeeLamports = Math.max(0, Math.floor(Number(debugMeta?.feeLamports || 0)));
      const feeRecipient = String(debugMeta?.feeRecipient || "");
      const feeInstruction = tx.instructions
        .map((ix) => parseSystemTransferDetails(ix))
        .find((details) => !!details && details.toPubkey === feeRecipient && details.lamports === expectedFeeLamports);
      const expectedWalletOutflowLamports = Math.max(0, Math.floor(Number(debugMeta?.expectedWalletOutflowLamports || 0)));
      const committedLamports = Math.max(0, Math.floor(Number(debugMeta?.committedLamports || 0)));
      const depositBackingLamports = Math.max(0, Math.floor(Number(debugMeta?.depositBackingLamports || 0)));
      const expectedDepositInstructionLamports = Math.max(0, Math.floor(Number(debugMeta?.expectedDepositInstructionLamports || 0)));
      const bootstrapCostLamports = Math.max(0, Math.floor(Number(debugMeta?.bootstrapCostLamports || 0)));
      const depositInstruction = tx.instructions
        .map((ix) => parsePingDepositDetails(ix))
        .find((details) => !!details && (expectedDepositInstructionLamports <= 0 || details.lamports === expectedDepositInstructionLamports));
      const parsedBundleOutflowLamports = expectedFeeLamports + expectedDepositInstructionLamports;
      const inferredBootstrapOutflowLamports = Math.max(0, expectedWalletOutflowLamports - parsedBundleOutflowLamports);
      console.log("[ping-debug] final instruction bundle before send", {
        instructionCount: tx.instructions.length,
        instructionProgramIds: tx.instructions.map((ix) => ix.programId?.toBase58?.()),
        hasFeeInstruction: !!feeInstruction,
        feeInstruction,
        hasDepositInstruction: !!depositInstruction,
        depositInstruction,
        expectedWalletOutflowLamports,
        expectedDepositInstructionLamports,
        parsedBundleOutflowLamports,
        inferredBootstrapOutflowLamports,
        committedLamports,
        depositBackingLamports,
        feeLamports: expectedFeeLamports,
        bootstrapCostLamports,
      });
      console.log("[ping-debug] FINAL TX INSTRUCTIONS", tx.instructions.map((ix, idx) => ({
        idx,
        programId: ix.programId?.toBase58?.(),
        keys: (ix.keys || []).map((k) => ({
          pubkey: k.pubkey?.toBase58?.(),
          isSigner: !!k.isSigner,
          isWritable: !!k.isWritable,
        })),
        transferDetails: parseSystemTransferDetails(ix),
      })));
      if(expectedFeeLamports > 0 && !feeInstruction){
        throw new Error("Missing Pingy fee transfer instruction in transaction bundle");
      }
      if(expectedDepositInstructionLamports > 0 && !depositInstruction){
        throw new Error("Missing Pingy deposit instruction in transaction bundle");
      }
      if(expectedWalletOutflowLamports > 0 && parsedBundleOutflowLamports > expectedWalletOutflowLamports){
        throw new Error(`Transaction bundle outflow mismatch (expected <= ${expectedWalletOutflowLamports}, parsed ${parsedBundleOutflowLamports})`);
      }
      if(bootstrapCostLamports > 0 && inferredBootstrapOutflowLamports <= 0){
        throw new Error(`Expected bootstrap outflow (${bootstrapCostLamports}) was not reflected in wallet outflow`);
      }

      if(bootstrapCostLamports > 0){
        console.log("[ping-debug] bootstrap outflow estimate vs inferred", {
          bootstrapCostLamports,
          inferredBootstrapOutflowLamports,
          deltaLamports: inferredBootstrapOutflowLamports - bootstrapCostLamports,
        });
      }

      console.log("[ping-debug] sendProgramInstruction program checks", {
        PROGRAM_ID: PROGRAM_ID.toBase58(),
        ixProgramIds: instructions.map((ix) => ix.programId?.toBase58?.()),
        txInstructionProgramIds: tx.instructions.map((i) => i.programId?.toBase58?.()),
      });

      console.log("[pingy] about to sign tx", {
        feePayer: tx.feePayer?.toBase58?.(),
        recentBlockhash: tx.recentBlockhash,
        ixCount: tx.instructions?.length,
        programId: instructions[0]?.programId?.toBase58?.(),
      });
      console.log("[pingy] provider methods", {
        hasSignTransaction: typeof provider.signTransaction,
      });

      if(!tx?.feePayer || !tx?.recentBlockhash || !Array.isArray(tx?.instructions) || tx.instructions.length === 0){
        throw new Error("Transaction is incomplete before wallet call");
      }

      let sig;
      traceStep("tx:signTransaction", { via: "provider.signTransaction + sendRawTransaction" }, "tx step: opening phantom with signer...");
      let signedTx;
      try {
        console.log("[ping-debug] skipping manual simulation; going straight to Phantom");
        console.log("[ping-debug] wallet call args", {
          method: "signTransaction",
          argCount: 1,
          txShape: {
            feePayer: tx.feePayer?.toBase58?.() || null,
            recentBlockhash: tx.recentBlockhash || null,
            instructionCount: tx.instructions.length,
          },
        });
        signedTx = await provider.signTransaction(tx);
      } catch(e){
        console.error("[ping-debug] signTransaction throw context", {
          connectedWallet,
          providerPublicKey: provider.publicKey?.toBase58?.(),
          txFeePayer: tx.feePayer?.toBase58?.(),
          txRecentBlockhash: tx.recentBlockhash,
          txInstructionCount: tx.instructions.length,
          ixProgramIds: tx.instructions.map((ix) => ix.programId?.toBase58?.()),
        });
        showToast("signTransaction: " + String(e?.message || e));
        throw e;
      }
      if(!signedTx) throw new Error("Missing signed transaction");

      try {
        sig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight:false });
      } catch(e){ showToast("sendRawTransaction: " + (e?.message||e)); throw e; }

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

    async function deriveAssociatedTokenAddress(owner, mint){
      return PublicKey.findProgramAddress(
        [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
    }

    async function pingDepositTx(roomId, amountLamports){
      const rid = String(roomId || "");
      const lamports = Number(amountLamports);
      if(!Number.isInteger(lamports) || lamports <= 0){
        throw new Error("amountLamports must be a positive integer");
      }
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
      const [curvePda] = await deriveCurvePda(rid);
      const [curveAuthorityPda] = await deriveCurveAuthorityPda(rid);
      const [mintPda] = await deriveMintPda(rid);
      const [curveTokenVaultPda] = await deriveCurveTokenVaultPda(rid);
      const [depositPda] = await deriveDepositPda(rid, walletPk);
      const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
      const [feeVaultPda] = await deriveFeeVaultPda();
      const launchConfig = getCreateLaunchConfig();
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
      console.log("[ping-debug] deriveBanPda typeof", typeof deriveBanPda);
      const [banPda] = await deriveBanPda(rid, walletPk);
      const banInfo = await connection.getAccountInfo(banPda, "confirmed");
      if (banInfo) {
        keys.push({ pubkey: banPda, isSigner: false, isWritable: false });
      }
      console.log("[ping-create-debug]", {
        roomId: rid,
        launchConfig,
        commitLamports: lamports,
        pdas: {
          threadPda: threadPda.toBase58(),
          curvePda: curvePda.toBase58(),
          curveAuthorityPda: curveAuthorityPda.toBase58(),
          mintPda: mintPda.toBase58(),
          curveTokenVaultPda: curveTokenVaultPda.toBase58(),
          spawnPoolPda: spawnPoolPda.toBase58(),
          threadEscrowPda: threadEscrowPda.toBase58(),
          feeVaultPda: feeVaultPda.toBase58(),
          depositPda: depositPda.toBase58(),
        },
      });
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

    async function pingWithOptionalThreadInitTx(roomId, amountLamports, includeThreadInit, createConfig = null, options = null){
      const rid = String(roomId || "");
      const lamports = Number(amountLamports);
      if(!Number.isInteger(lamports) || lamports <= 0){
        throw new Error("amountLamports must be a positive integer");
      }
      const opts = options || {};
      const includeLegacyNativeAssets = opts.includeLegacyNativeAssets !== false;
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
      const [curvePda] = await deriveCurvePda(rid);
      const [curveAuthorityPda] = await deriveCurveAuthorityPda(rid);
      const [depositPda] = await deriveDepositPda(rid, walletPk);
      const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
      let mintPda = null;
      let curveTokenVaultPda = null;
      let feeVaultPda = null;
      if(includeLegacyNativeAssets){
        mintPda = (await deriveMintPda(rid))[0];
        curveTokenVaultPda = (await deriveCurveTokenVaultPda(rid))[0];
        feeVaultPda = (await deriveFeeVaultPda())[0];
      }

      const instructions = [];
      const config = createConfig || getCreateLaunchConfig();
      if(includeThreadInit){
        instructions.push(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: walletPk, isSigner: true, isWritable: true },
            { pubkey: threadPda, isSigner: false, isWritable: true },
            { pubkey: curvePda, isSigner: false, isWritable: true },
            { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
            { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: concatBytes(await anchorDiscriminator("initialize_thread_core"), encodeStringArg(rid), encodeU32Arg(Number(config.minApprovedWallets || 0)), encodeU64Arg(Number(config.spawnTargetLamports || 0)), encodeU16Arg(Number(config.maxWalletShareBps || 0)), encodeU8Arg(launchModeByte(config.launchMode))),
        }));
        if(includeLegacyNativeAssets){
          instructions.push(new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: walletPk, isSigner: true, isWritable: true },
              { pubkey: threadPda, isSigner: false, isWritable: true },
              { pubkey: curvePda, isSigner: false, isWritable: true },
              { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
              { pubkey: mintPda, isSigner: false, isWritable: true },
              { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
              { pubkey: feeVaultPda, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: concatBytes(await anchorDiscriminator("initialize_thread_assets"), encodeStringArg(rid)),
          }));
        }
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

      const instructionNames = [
        ...(includeThreadInit
          ? ["initialize_thread_core", ...(includeLegacyNativeAssets ? ["initialize_thread_assets"] : []), "ping_deposit"]
          : ["ping_deposit"]),
      ];
      console.log("[ping-debug] pingWithOptionalThreadInitTx instruction bundle", {
        includeThreadInit,
        includeLegacyNativeAssets,
        instructionCount: instructions.length,
        instructionNames,
      });

      return {
        instructions,
        signers: [],
      };
    }

    async function initializeThreadTx(threadId, createConfig = null, options = null){
      try {
        const rid = String(threadId || "");
        const opts = options || {};
        const includeLegacyNativeAssets = opts.includeLegacyNativeAssets !== false;
        const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
        console.log("[ping-debug] initializeThreadTx admin wallet pubkey", adminPk.toBase58());
        console.log("[ping-debug] initializeThreadTx program id", PROGRAM_ID.toBase58());
        const [threadPda] = await deriveThreadPda(rid);
        console.log("[ping-debug] initializeThreadTx threadPda", threadPda.toBase58());
        const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
        console.log("[ping-debug] initializeThreadTx spawnPoolPda", spawnPoolPda.toBase58());
        const [curvePda] = await deriveCurvePda(rid);
        console.log("[ping-debug] initializeThreadTx curvePda", curvePda.toBase58());
        const [curveAuthorityPda] = await deriveCurveAuthorityPda(rid);
        console.log("[ping-debug] initializeThreadTx curveAuthorityPda", curveAuthorityPda.toBase58());
        let mintPda = null;
        let curveTokenVaultPda = null;
        const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
        console.log("[ping-debug] initializeThreadTx threadEscrowPda", threadEscrowPda.toBase58());
        let feeVaultPda = null;
        if(includeLegacyNativeAssets){
          mintPda = (await deriveMintPda(rid))[0];
          console.log("[ping-debug] initializeThreadTx mintPda", mintPda.toBase58());
          curveTokenVaultPda = (await deriveCurveTokenVaultPda(rid))[0];
          console.log("[ping-debug] initializeThreadTx curveTokenVaultPda", curveTokenVaultPda.toBase58());
          feeVaultPda = (await deriveFeeVaultPda())[0];
          console.log("[ping-debug] initializeThreadTx feeVaultPda", feeVaultPda.toBase58());
        } else {
          console.log("[ping-debug] initializeThreadTx legacy native assets skipped (pumpfun minimal prespawn path)");
        }
        const config = createConfig || getCreateLaunchConfig();
        const instructions = [
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: adminPk, isSigner: true, isWritable: true },
              { pubkey: threadPda, isSigner: false, isWritable: true },
              { pubkey: curvePda, isSigner: false, isWritable: true },
              { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
              { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
              { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: concatBytes(await anchorDiscriminator("initialize_thread_core"), encodeStringArg(rid), encodeU32Arg(Number(config.minApprovedWallets || 0)), encodeU64Arg(Number(config.spawnTargetLamports || 0)), encodeU16Arg(Number(config.maxWalletShareBps || 0)), encodeU8Arg(launchModeByte(config.launchMode))),
          }),
        ];
        if(includeLegacyNativeAssets){
          instructions.push(new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: adminPk, isSigner: true, isWritable: true },
              { pubkey: threadPda, isSigner: false, isWritable: true },
              { pubkey: curvePda, isSigner: false, isWritable: true },
              { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
              { pubkey: mintPda, isSigner: false, isWritable: true },
              { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
              { pubkey: feeVaultPda, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: concatBytes(await anchorDiscriminator("initialize_thread_assets"), encodeStringArg(rid)),
          }));
        }
        console.log("[ping-debug] initializeThreadTx instruction bundle", {
          includeLegacyNativeAssets,
          instructionNames: includeLegacyNativeAssets
            ? ["initialize_thread_core", "initialize_thread_assets"]
            : ["initialize_thread_core"],
        });
        return sendProgramInstructions(instructions);
      } catch (err){
        console.error("[ping-debug] initializeThreadTx build failed", err);
        throw err;
      }
    }

    async function buildInitializeV2GlobalStateV2Ix(defaultFeeRecipient = PINGY_FEE_RECIPIENT){
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [programStatePda] = await deriveV2ProgramStatePda();
      const [sharedVaultPda] = await deriveV2SharedVaultPda();
      const [feeVaultPda] = await deriveV2FeeVaultPda();
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: programStatePda, isSigner: false, isWritable: true },
          { pubkey: sharedVaultPda, isSigner: false, isWritable: true },
          { pubkey: feeVaultPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: concatBytes(
          await anchorDiscriminator("initialize_v2_global_state"),
          parsePublicKeyStrict(defaultFeeRecipient, "default fee recipient").toBytes()
        ),
      });
    }

    async function initializeV2GlobalStateTx(defaultFeeRecipient = PINGY_FEE_RECIPIENT){
      return sendProgramInstruction(await buildInitializeV2GlobalStateV2Ix(defaultFeeRecipient));
    }

    async function buildCreateRoomLedgerV2Ix(roomId, createConfig = null){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [programStatePda] = await deriveV2ProgramStatePda();
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const config = createConfig || getCreateLaunchConfig();
      const launchBackendByte = isPumpfunLaunchBackend() ? 1 : 0;
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: programStatePda, isSigner: false, isWritable: false },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: concatBytes(
          await anchorDiscriminator("create_room_ledger"),
          encodeStringArg(rid),
          encodeU8Arg(launchBackendByte),
          encodeU8Arg(launchModeByte(config.launchMode)),
          encodeU32Arg(Number(config.minApprovedWallets || 0)),
          encodeU64Arg(Number(config.spawnTargetLamports || 0)),
          encodeU16Arg(Number(config.maxWalletShareBps || 0)),
        ),
      });
    }

    async function createRoomLedgerV2Tx(roomId, createConfig = null){
      return sendProgramInstruction(await buildCreateRoomLedgerV2Ix(roomId, createConfig));
    }

    async function buildPingDepositSharedV2Ix(roomId, amountLamports){
      const rid = String(roomId || "");
      const lamports = Number(amountLamports);
      if(!Number.isInteger(lamports) || lamports <= 0) throw new Error("amountLamports must be a positive integer");
      const userPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [programStatePda] = await deriveV2ProgramStatePda();
      const [sharedVaultPda] = await deriveV2SharedVaultPda();
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const [roomReceiptPda] = await deriveRoomReceiptPda(rid, userPk);
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: userPk, isSigner: true, isWritable: true },
          { pubkey: programStatePda, isSigner: false, isWritable: false },
          { pubkey: sharedVaultPda, isSigner: false, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          { pubkey: roomReceiptPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: concatBytes(
          await anchorDiscriminator("ping_deposit_shared"),
          encodeStringArg(rid),
          encodeU64Arg(lamports),
        ),
      });
    }

    async function pingDepositSharedV2Tx(roomId, amountLamports){
      return sendProgramInstruction(await buildPingDepositSharedV2Ix(roomId, amountLamports));
    }

    async function buildApproveReceiptV2Ix(roomId, userWallet){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const userPk = parsePublicKeyStrict(userWallet, "approved user wallet");
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const [roomReceiptPda] = await deriveRoomReceiptPda(rid, userPk);
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          { pubkey: roomReceiptPda, isSigner: false, isWritable: true },
        ],
        data: concatBytes(
          await anchorDiscriminator("approve_receipt"),
          encodeStringArg(rid),
          userPk.toBytes(),
        ),
      });
    }

    async function approveReceiptV2Tx(roomId, userWallet){
      return sendProgramInstruction(await buildApproveReceiptV2Ix(roomId, userWallet));
    }

    async function buildRevokeReceiptV2Ix(roomId, userWallet){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const userPk = parsePublicKeyStrict(userWallet, "revoked user wallet");
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const [roomReceiptPda] = await deriveRoomReceiptPda(rid, userPk);
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          { pubkey: roomReceiptPda, isSigner: false, isWritable: true },
        ],
        data: concatBytes(
          await anchorDiscriminator("revoke_receipt"),
          encodeStringArg(rid),
          userPk.toBytes(),
        ),
      });
    }

    async function revokeReceiptV2Tx(roomId, userWallet){
      return sendProgramInstruction(await buildRevokeReceiptV2Ix(roomId, userWallet));
    }

    async function buildUnpingRefundV2Ix(roomId){
      const rid = String(roomId || "");
      const userPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [programStatePda] = await deriveV2ProgramStatePda();
      const [sharedVaultPda] = await deriveV2SharedVaultPda();
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const [roomReceiptPda] = await deriveRoomReceiptPda(rid, userPk);
      return new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: userPk, isSigner: true, isWritable: true },
          { pubkey: programStatePda, isSigner: false, isWritable: false },
          { pubkey: sharedVaultPda, isSigner: false, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          { pubkey: roomReceiptPda, isSigner: false, isWritable: true },
        ],
        data: concatBytes(await anchorDiscriminator("unping_refund"), encodeStringArg(rid)),
      });
    }

    async function unpingRefundV2Tx(roomId){
      return sendProgramInstruction(await buildUnpingRefundV2Ix(roomId));
    }

    async function buildMaybeInitializeV2GlobalStateIxs(){
      const [programStatePda] = await deriveV2ProgramStatePda();
      const existing = await connection.getAccountInfo(programStatePda, "confirmed");
      if(existing?.data?.length >= 8) return [];
      return [await buildInitializeV2GlobalStateV2Ix()];
    }

    async function executeSpawnNativeV2Tx(roomId, receiptWallets = []){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [sharedVaultPda] = await deriveV2SharedVaultPda();
      const [feeVaultPda] = await deriveV2FeeVaultPda();
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const [curvePda] = await deriveV2CurvePda(rid);
      const [curveAuthorityPda] = await deriveV2CurveAuthorityPda(rid);
      const [mintPda] = await deriveV2MintPda(rid);
      const [curveTokenVaultPda] = await deriveV2CurveTokenVaultPda(rid);
      const [spawnPoolPda] = await deriveV2SpawnPoolPda(rid);
      const remainingKeys = await Promise.all((receiptWallets || []).map(async (wallet) => {
        const walletPk = parsePublicKeyStrict(wallet, "receipt wallet");
        const [receiptPda] = await deriveRoomReceiptPda(rid, walletPk);
        return { pubkey: receiptPda, isSigner: false, isWritable: true };
      }));
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: sharedVaultPda, isSigner: false, isWritable: true },
          { pubkey: feeVaultPda, isSigner: false, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          { pubkey: curvePda, isSigner: false, isWritable: true },
          { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
          { pubkey: mintPda, isSigner: false, isWritable: true },
          { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
          { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ...remainingKeys,
        ],
        data: concatBytes(await anchorDiscriminator("execute_spawn_native"), encodeStringArg(rid)),
      }));
    }

    async function executeSpawnExternalV2Tx(roomId, receiptWallets = []){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [sharedVaultPda] = await deriveV2SharedVaultPda();
      const [feeVaultPda] = await deriveV2FeeVaultPda();
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const remainingKeys = await Promise.all((receiptWallets || []).map(async (wallet) => {
        const walletPk = parsePublicKeyStrict(wallet, "receipt wallet");
        const [receiptPda] = await deriveRoomReceiptPda(rid, walletPk);
        return { pubkey: receiptPda, isSigner: false, isWritable: true };
      }));
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: sharedVaultPda, isSigner: false, isWritable: true },
          { pubkey: feeVaultPda, isSigner: false, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          ...remainingKeys,
        ],
        data: concatBytes(await anchorDiscriminator("execute_spawn_external"), encodeStringArg(rid)),
      }));
    }

    async function claimSpawnTokensV2Tx(roomId){
      const rid = String(roomId || "");
      const userPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const [roomReceiptPda] = await deriveRoomReceiptPda(rid, userPk);
      const [curvePda] = await deriveV2CurvePda(rid);
      const [curveAuthorityPda] = await deriveV2CurveAuthorityPda(rid);
      const [mintPda] = await deriveV2MintPda(rid);
      const [curveTokenVaultPda] = await deriveV2CurveTokenVaultPda(rid);
      const [userTokenAta] = await deriveAssociatedTokenAddress(userPk, mintPda);
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: userPk, isSigner: true, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: false },
          { pubkey: roomReceiptPda, isSigner: false, isWritable: true },
          { pubkey: curvePda, isSigner: false, isWritable: true },
          { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
          { pubkey: mintPda, isSigner: false, isWritable: false },
          { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
          { pubkey: userTokenAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: concatBytes(await anchorDiscriminator("claim_spawn_tokens_v2"), encodeStringArg(rid)),
      }));
    }

    async function recordExternalDistributionTx(roomId, userWallet, settledExternalUnits){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const userPk = parsePublicKeyStrict(userWallet, "distribution wallet");
      const [roomLedgerPda] = await deriveRoomLedgerPda(rid);
      const [roomReceiptPda] = await deriveRoomReceiptPda(rid, userPk);
      return sendProgramInstruction(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: adminPk, isSigner: true, isWritable: true },
          { pubkey: roomLedgerPda, isSigner: false, isWritable: true },
          { pubkey: roomReceiptPda, isSigner: false, isWritable: true },
        ],
        data: concatBytes(
          await anchorDiscriminator("record_external_distribution"),
          encodeStringArg(rid),
          encodeU64Arg(Number(settledExternalUnits || 0)),
        ),
      }));
    }

    window.pingySolana.v2 = {
      enabled: isSharedVaultV2Enabled,
      initializeV2GlobalStateTx,
      createRoomLedgerV2Tx,
      pingDepositSharedV2Tx,
      approveReceiptV2Tx,
      revokeReceiptV2Tx,
      unpingRefundV2Tx,
      executeSpawnNativeV2Tx,
      executeSpawnExternalV2Tx,
      claimSpawnTokensV2Tx,
      recordExternalDistributionTx,
    };

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

    async function executeSpawnTx(roomId){
      const rid = String(roomId || "");
      const adminPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [curvePda] = await deriveCurvePda(rid);
      const [curveAuthorityPda] = await deriveCurveAuthorityPda(rid);
      const [mintPda] = await deriveMintPda(rid);
      const [curveTokenVaultPda] = await deriveCurveTokenVaultPda(rid);
      const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      const [feeVaultPda] = await deriveFeeVaultPda();

      const snapshot = state.onchain?.[rid] || await fetchRoomOnchainSnapshot(rid);
      const approvedRows = Object.values(snapshot?.byWallet || {}).filter((row) => normalizeDepositStatus(row?.status) === "approved" && row?.deposit_pda);
      const remainingKeys = approvedRows.map((row) => ({
        pubkey: new PublicKey(row.deposit_pda),
        isSigner: false,
        isWritable: true,
      }));

      const keys = [
        { pubkey: adminPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: true },
        { pubkey: curvePda, isSigner: false, isWritable: true },
        { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: mintPda, isSigner: false, isWritable: true },
        { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
        { pubkey: threadEscrowPda, isSigner: false, isWritable: true },
        { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
        { pubkey: feeVaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ...remainingKeys,
      ];

      const data = concatBytes(await anchorDiscriminator("execute_spawn"), encodeStringArg(rid));
      return sendProgramInstruction(new TransactionInstruction({ programId: PROGRAM_ID, keys, data }));
    }

    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    async function claimSpawnTokensTx(roomId){
      const rid = String(roomId || "");
      const userPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [curvePda] = await deriveCurvePda(rid);
      const [depositPda] = await deriveDepositPda(rid, userPk);
      const [curveAuthorityPda] = await deriveCurveAuthorityPda(rid);
      const [mintPda] = await deriveMintPda(rid);
      const [curveTokenVaultPda] = await deriveCurveTokenVaultPda(rid);
      const [userTokenAta] = await deriveAssociatedTokenAddress(userPk, mintPda);

      const keys = [
        { pubkey: userPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: false },
        { pubkey: curvePda, isSigner: false, isWritable: false },
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: mintPda, isSigner: false, isWritable: false },
        { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
        { pubkey: userTokenAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const data = concatBytes(await anchorDiscriminator("claim_spawn_tokens"), encodeStringArg(rid));
      return sendProgramInstruction(new TransactionInstruction({ programId: PROGRAM_ID, keys, data }));
    }

    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    async function buyTx(roomId, amountLamports){
      const rid = String(roomId || "");
      const lamports = Number(amountLamports);
      if(!Number.isInteger(lamports) || lamports <= 0){
        throw new Error("amountLamports must be a positive integer");
      }
      const userPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [curvePda] = await deriveCurvePda(rid);
      const [curveAuthorityPda] = await deriveCurveAuthorityPda(rid);
      const [mintPda] = await deriveMintPda(rid);
      const [curveTokenVaultPda] = await deriveCurveTokenVaultPda(rid);
      const [userTokenAta] = await deriveAssociatedTokenAddress(userPk, mintPda);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      const [feeVaultPda] = await deriveFeeVaultPda();

      const keys = [
        { pubkey: userPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: false },
        { pubkey: curvePda, isSigner: false, isWritable: true },
        { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: mintPda, isSigner: false, isWritable: true },
        { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
        { pubkey: userTokenAta, isSigner: false, isWritable: true },
        { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
        { pubkey: feeVaultPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const data = concatBytes(
        await anchorDiscriminator("buy"),
        encodeStringArg(rid),
        encodeU64Arg(lamports)
      );
      return sendProgramInstruction(new TransactionInstruction({ programId: PROGRAM_ID, keys, data }));
    }

    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    async function sellTx(roomId, tokenAmount){
      const rid = String(roomId || "");
      const tokens = Number(tokenAmount);
      if(!Number.isInteger(tokens) || tokens <= 0){
        throw new Error("tokenAmount must be a positive integer");
      }
      const userPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [threadPda] = await deriveThreadPda(rid);
      const [curvePda] = await deriveCurvePda(rid);
      const [curveAuthorityPda] = await deriveCurveAuthorityPda(rid);
      const [mintPda] = await deriveMintPda(rid);
      const [curveTokenVaultPda] = await deriveCurveTokenVaultPda(rid);
      const [userTokenAta] = await deriveAssociatedTokenAddress(userPk, mintPda);
      const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
      const [feeVaultPda] = await deriveFeeVaultPda();

      const keys = [
        { pubkey: userPk, isSigner: true, isWritable: true },
        { pubkey: threadPda, isSigner: false, isWritable: false },
        { pubkey: curvePda, isSigner: false, isWritable: true },
        { pubkey: curveAuthorityPda, isSigner: false, isWritable: false },
        { pubkey: mintPda, isSigner: false, isWritable: true },
        { pubkey: curveTokenVaultPda, isSigner: false, isWritable: true },
        { pubkey: userTokenAta, isSigner: false, isWritable: true },
        { pubkey: spawnPoolPda, isSigner: false, isWritable: true },
        { pubkey: feeVaultPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const data = concatBytes(
        await anchorDiscriminator("sell"),
        encodeStringArg(rid),
        encodeU64Arg(tokens)
      );
      return sendProgramInstruction(new TransactionInstruction({ programId: PROGRAM_ID, keys, data }));
    }

    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    async function maybeExecuteSpawnOnchain(room){
      if(!room || !shouldUseOnchain()) return false;
      if(room._spawnExecInFlight) return false;
      if(!isCreator(room, connectedWallet)) return false;
      room._spawnExecInFlight = true;
      try {
        if(isSharedVaultV2Enabled() && isV2Room(room)){
          const approvedWallets = Array.from(new Set(
            (Array.isArray(room?.approved_wallets) ? room.approved_wallets : [])
              .concat(Array.isArray(room?.onchain?.approvedWallets) ? room.onchain.approvedWallets : [])
              .concat(Object.entries(room?.onchain?.byWallet || {})
                .filter(([, row]) => String(row?.status || "").toLowerCase() === "approved")
                .map(([wallet]) => wallet))
          ));
          const launchBackend = String(room?.launch_backend || room?.onchain?.launch_backend || "native").toLowerCase() === "pumpfun" ? 1 : 0;
          if(launchBackend === 1) await executeSpawnExternalV2Tx(room.id, approvedWallets);
          else await executeSpawnNativeV2Tx(room.id, approvedWallets);
        } else {
          await executeSpawnTx(room.id);
        }
        await fetchRoomOnchainSnapshot(room.id);
        await fetchConnectedWalletDepositSnapshot();
        addSystemEvent(room.id, "spawn execute tx submitted on-chain.");
        renderRoom(room.id);
        renderHome();
        return true;
      } catch(e){
        reportTxError(e, "execute spawn transaction failed");
        return false;
      } finally {
        room._spawnExecInFlight = false;
      }
    }

    function isSpawnClosed(room){
      if(!room) return false;

      // UI state already reflects spawn completion
      if(room.state === "BONDING" || room.state === "BONDED") return true;

      // fallback to onchain thread state
      const spawnState =
        room?.onchain?.spawnState ??
        room?.onchain?.spawn_state ??
        null;

      return Number(spawnState) === 1;
    }

    function normalizeCurveLifecycle(value){
      if(value == null) return "";
      if(typeof value === "string"){
        const lower = value.toLowerCase();
        if(lower === "bonding") return "bonding";
        if(lower === "bonded") return "bonded";
        if(lower === "prespawn" || lower === "pre_spawn" || lower === "pre-spawn") return "preSpawn";
        return "";
      }
      const n = Number(value);
      if(n === 1) return "bonding";
      if(n === 2) return "bonded";
      if(n === 0) return "preSpawn";
      return "";
    }

    function mapRoomStateFromOnchainLifecycle(spawnState, curveLifecycle){
      const s = Number(spawnState);
      const normalizedLifecycle = normalizeCurveLifecycle(curveLifecycle);

      if(s === 0) return "SPAWNING";
      if(s === 1 && normalizedLifecycle === "bonding") return "BONDING";
      if(s === 1 && normalizedLifecycle === "bonded") return "BONDED";
      return null;
    }

    function mapRoomStateFromV2Lifecycle(roomState){
      const normalized = String(roomState || "").toLowerCase();
      if(normalized === "open") return "SPAWNING";
      if(normalized === "native_bonding") return "BONDING";
      if(normalized === "native_bonded" || normalized === "external_finalized" || normalized === "cancelled") return "BONDED";
      return null;
    }

    function connectedWalletUnclaimedSpawnAllocation(room){
      if(!room || !connectedWallet) return { hasClaimable: false, claimableTokens: 0, allocation: 0, claimed: 0 };
      if(!canClaimNativeSpawnTokens(room)) return { hasClaimable: false, claimableTokens: 0, allocation: 0, claimed: 0 };
      const row = room?.onchain?.byWallet?.[connectedWallet] || {};
      const allocation = Number(row.native_token_allocation ?? row.spawn_token_allocation ?? 0);
      const claimed = Number(row.native_tokens_claimed ?? row.spawn_tokens_claimed ?? 0);
      const claimableTokens = Math.max(0, allocation - claimed);
      return {
        hasClaimable: claimableTokens > 0,
        claimableTokens,
        allocation,
        claimed,
      };
    }

    async function claimConnectedWalletSpawnTokens(room){
      if(!room || !connectedWallet) return false;
      if(isPumpfunPostSpawnRoom(room) || !canClaimNativeSpawnTokens(room)){
        alert("Trading for launched coins is handled outside Pingy.");
        return false;
      }
      if(room._spawnClaimInFlight) return false;
      room._spawnClaimInFlight = true;
      try {
        if(isSharedVaultV2Enabled() && isV2Room(room)) await claimSpawnTokensV2Tx(room.id);
        else await claimSpawnTokensTx(room.id);
        await Promise.all([
          fetchRoomOnchainSnapshot(room.id),
          fetchConnectedWalletDepositSnapshot(),
        ]);
        addSystemEvent(room.id, `@${shortWallet(connectedWallet)} claimed spawn tokens.`);
        showToast("claim successful");
        renderRoom(room.id);
        renderHome();
        return true;
      } catch(e){
        reportTxError(e, "claim spawn tokens transaction failed");
        return false;
      } finally {
        room._spawnClaimInFlight = false;
      }
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
      const curveInitialized = !!bytes[o];
      o += 1;
      const launchMode = bytes[o];
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
        curve_initialized: curveInitialized,
        launch_mode: Number(launchMode || 0) === 1 ? "instant" : "spawn",
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
      o += 8;
      const spawnTokenAllocation = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const spawnTokensClaimed = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      const statusMap = ["pending", "approved", "revoked", "rejected", "withdrawn", "converted"];
      return {
        threadId,
        user: userPubkey.toBase58(),
        status: statusMap[statusCode] || "unknown",
        rejectedOnce,
        refundable_lamports: Number(refundableLamports || 0n),
        allocated_lamports: Number(allocatedLamports || 0n),
        spawn_token_allocation: Number(spawnTokenAllocation || 0n),
        spawn_tokens_claimed: Number(spawnTokensClaimed || 0n)
      };
    }

    function decodeRoomLedgerAccount(data){
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if(!bytes?.length || bytes.length < 8) return null;
      let o = 8;
      const version = bytes[o]; o += 1;
      const bump = bytes[o]; o += 1;
      const [roomId, o1] = readString(bytes, o); o = o1;
      const [creatorPubkey, o2] = readPubkey(bytes, o); o = o2;
      const [adminPubkey, o3] = readPubkey(bytes, o); o = o3;
      const launchBackend = bytes[o]; o += 1;
      const launchMode = bytes[o]; o += 1;
      const stateCode = bytes[o]; o += 1;
      const [minApprovedWallets, o4] = readU32LE(bytes, o); o = o4;
      const spawnTargetLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const maxWalletShareBps = new DataView(bytes.buffer, bytes.byteOffset + o, 2).getUint16(0, true); o += 2;
      const [pendingCount, o5] = readU32LE(bytes, o); o = o5;
      const [approvedCount, o6] = readU32LE(bytes, o); o = o6;
      const totalBundleLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const totalRefundableLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const totalAllocatedLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const totalForwardedLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const totalRefundedLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const spawnFinalized = !!bytes[o]; o += 1;
      const [mintPubkey, o7] = readPubkey(bytes, o); o = o7;
      const [curvePubkey, o8] = readPubkey(bytes, o); o = o8;
      const [spawnPoolPubkey, o9] = readPubkey(bytes, o); o = o9;
      const [curveTokenVaultPubkey, o10] = readPubkey(bytes, o); o = o10;
      const externalSettlementMode = bytes[o]; o += 1;
      const externalSettlementStatusCode = bytes[o]; o += 1;
      const totalExternalUnitsSettled = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true));
      const roomStateMap = ["open", "native_bonding", "native_bonded", "external_finalized", "cancelled"];
      const settlementStatusMap = ["pending", "in_progress", "complete"];
      return {
        version: Number(version || 0),
        bump: Number(bump || 0),
        roomId,
        creator_pubkey: creatorPubkey.toBase58(),
        admin: adminPubkey.toBase58(),
        admin_pubkey: adminPubkey,
        launch_backend: Number(launchBackend || 0) === 1 ? "pumpfun" : "native",
        launch_mode: Number(launchMode || 0) === 1 ? "instant" : "spawn",
        room_state: roomStateMap[stateCode] || "open",
        min_approved_wallets: Number(minApprovedWallets || 0),
        spawn_target_lamports: Number(spawnTargetLamports || 0),
        max_wallet_share_bps: Number(maxWalletShareBps || 0),
        pending_count: Number(pendingCount || 0),
        approved_count: Number(approvedCount || 0),
        total_bundle_lamports: Number(totalBundleLamports || 0),
        total_refundable_lamports: Number(totalRefundableLamports || 0),
        total_allocated_lamports: Number(totalAllocatedLamports || 0),
        total_forwarded_lamports: Number(totalForwardedLamports || 0),
        total_refunded_lamports: Number(totalRefundedLamports || 0),
        total_escrow_lamports: Number(totalBundleLamports || 0),
        spawn_finalized: spawnFinalized,
        mint: mintPubkey.toBase58(),
        curve: curvePubkey.toBase58(),
        spawn_pool: spawnPoolPubkey.toBase58(),
        curve_token_vault: curveTokenVaultPubkey.toBase58(),
        external_settlement_mode: Number(externalSettlementMode || 0),
        external_settlement_status: settlementStatusMap[externalSettlementStatusCode] || "pending",
        total_external_units_settled: Number(totalExternalUnitsSettled || 0),
      };
    }

    function decodeRoomReceiptAccount(data){
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if(!bytes?.length || bytes.length < 8) return null;
      let o = 8;
      const version = bytes[o]; o += 1;
      const bump = bytes[o]; o += 1;
      const [roomId, o1] = readString(bytes, o); o = o1;
      const [userPubkey, o2] = readPubkey(bytes, o); o = o2;
      const statusCode = bytes[o]; o += 1;
      const bundleLamportsTotal = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const refundableLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const allocatedLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const forwardedLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const refundedLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const receiptBackingLamports = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const nativeTokenAllocation = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const nativeTokensClaimed = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const externalAllocationUnits = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true)); o += 8;
      const externalUnitsClaimed = Number(new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true));
      const statusMap = ["pending", "approved", "revoked", "withdrawn", "converted"];
      return {
        version: Number(version || 0),
        bump: Number(bump || 0),
        roomId,
        user: userPubkey.toBase58(),
        status: statusMap[statusCode] || "unknown",
        bundle_lamports_total: Number(bundleLamportsTotal || 0),
        refundable_lamports: Number(refundableLamports || 0),
        allocated_lamports: Number(allocatedLamports || 0),
        forwarded_lamports: Number(forwardedLamports || 0),
        refunded_lamports: Number(refundedLamports || 0),
        receipt_backing_lamports: Number(receiptBackingLamports || 0),
        native_token_allocation: Number(nativeTokenAllocation || 0),
        native_tokens_claimed: Number(nativeTokensClaimed || 0),
        external_allocation_units: Number(externalAllocationUnits || 0),
        external_units_claimed: Number(externalUnitsClaimed || 0),
      };
    }

    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    function decodeCurveAccount(data){
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if(!bytes?.length || bytes.length < 8) return null;
      let o = 8; // anchor discriminator
      const [threadId, o1] = readString(bytes, o);
      o = o1;
      const lifecycleCode = bytes[o];
      o += 1;
      const [mintPubkey, o2] = readPubkey(bytes, o);
      o = o2;
      const mintDecimals = bytes[o];
      o += 1;
      const [curveTokenVault, o3] = readPubkey(bytes, o);
      o = o3;
      const curveAuthorityBump = bytes[o];
      o += 1;
      const totalSupply = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const virtualSolReserve = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const virtualTokenReserve = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const realSolReserve = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const realTokenReserve = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const openingBuyLamports = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const openingBuyTokens = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      o += 8;
      const tradeFeeBps = new DataView(bytes.buffer, bytes.byteOffset + o, 2).getUint16(0, true);
      o += 2;
      const graduationTargetLamports = new DataView(bytes.buffer, bytes.byteOffset + o, 8).getBigUint64(0, true);
      return {
        threadId,
        state: Number(lifecycleCode || 0),
        lifecycle: normalizeCurveLifecycle(lifecycleCode),
        mint: mintPubkey.toBase58(),
        mint_pubkey: mintPubkey,
        mint_decimals: Number(mintDecimals || 0),
        curve_token_vault: curveTokenVault.toBase58(),
        curve_token_vault_pubkey: curveTokenVault,
        curve_authority_bump: Number(curveAuthorityBump || 0),
        total_supply: Number(totalSupply || 0n),
        virtual_sol_reserve: Number(virtualSolReserve || 0n),
        virtual_token_reserve: Number(virtualTokenReserve || 0n),
        real_sol_reserve: Number(realSolReserve || 0n),
        real_token_reserve: Number(realTokenReserve || 0n),
        opening_buy_lamports: Number(openingBuyLamports || 0n),
        opening_buy_tokens: Number(openingBuyTokens || 0n),
        trade_fee_bps: Number(tradeFeeBps || 0),
        graduation_target_lamports: Number(graduationTargetLamports || 0n),
      };
    }


    async function fetchRoomOnchainSnapshot(roomId){
      if(!roomId) return null;
      const [threadPda] = await deriveThreadPda(roomId);
      const [curvePda] = await deriveCurvePda(roomId);
      const [roomLedgerPda] = await deriveRoomLedgerPda(roomId);
      const [threadInfo, roomLedgerInfo] = await Promise.all([
        connection.getAccountInfo(threadPda, "confirmed"),
        connection.getAccountInfo(roomLedgerPda, "confirmed"),
      ]);

      let snapshot = null;
      if(threadInfo?.data?.length >= 8){
        const thread = decodeThreadAccount(threadInfo.data);
        if(!thread) return null;
        const byWallet = {};
        const approvedWallets = [];
        const pendingWallets = [];
        const depositAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
          commitment: "confirmed",
          filters: [{ dataSize: DEPOSIT_ACCOUNT_DATA_SIZE }]
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
            committed_sol: withdrawableSol,
            withdrawable_sol: withdrawableSol,
            escrow_sol: withdrawableSol,
            committed_lamports: Number((deposit.allocated_lamports || 0) + (deposit.refundable_lamports || 0)),
            withdrawable_lamports: Number((deposit.allocated_lamports || 0) + (deposit.refundable_lamports || 0)),
            allocated_lamports: Number(deposit.allocated_lamports || 0),
            refundable_lamports: Number(deposit.refundable_lamports || 0),
            spawn_token_allocation: Number(deposit.spawn_token_allocation || 0),
            spawn_tokens_claimed: Number(deposit.spawn_tokens_claimed || 0),
            deposit_pda: acct.pubkey.toBase58()
          };

          if(deposit.status === "approved") approvedWallets.push(wallet);
          if(deposit.status === "pending") pendingWallets.push(wallet);
        }

        let curve = null;
        const curveInfo = await connection.getAccountInfo(curvePda, "confirmed");
        if(curveInfo?.data?.length >= 8){
          const decodedCurve = decodeCurveAccount(curveInfo.data);
          if(decodedCurve?.threadId === roomId) curve = decodedCurve;
        }

        const derivedRoomState = mapRoomStateFromOnchainLifecycle(thread.spawnState, curve?.lifecycle ?? curve?.state);
        snapshot = {
          roomId,
          threadPda: threadPda.toBase58(),
          curvePda: curvePda.toBase58(),
          admin: thread.admin,
          admin_pubkey: thread.admin_pubkey,
          pending_count: Number(thread.pending_count || 0),
          approved_count: Number(thread.approved_count || 0),
          total_allocated_lamports: Number(thread.total_allocated_lamports || 0),
          total_escrow_lamports: Number(thread.total_escrow_lamports || 0),
          min_approved_wallets: Number(thread.min_approved_wallets || 0),
          spawn_target_lamports: Number(thread.spawn_target_lamports || 0),
          max_wallet_share_bps: Number(thread.max_wallet_share_bps || 0),
          curve_lifecycle: curve?.lifecycle || "",
          curve_state: Number(curve?.state ?? -1),
          mint: curve?.mint || "",
          trade_fee_bps: Number(curve?.trade_fee_bps || 0),
          opening_buy_lamports: Number(curve?.opening_buy_lamports || 0),
          opening_buy_tokens: Number(curve?.opening_buy_tokens || 0),
          virtual_sol_reserve: Number(curve?.virtual_sol_reserve || 0),
          virtual_token_reserve: Number(curve?.virtual_token_reserve || 0),
          graduation_target_lamports: Number(curve?.graduation_target_lamports || 0),
          real_sol_reserve: Number(curve?.real_sol_reserve || 0),
          real_token_reserve: Number(curve?.real_token_reserve || 0),
          curve,
          derived_room_state: derivedRoomState || "",
          approverWallets: thread.admin ? [thread.admin] : [],
          byWallet,
          approvedWallets,
          pendingWallets,
          fetchedAtMs: Date.now()
        };
      } else if(roomLedgerInfo?.data?.length >= 8){
        const roomLedger = decodeRoomLedgerAccount(roomLedgerInfo.data);
        if(!roomLedger || roomLedger.roomId !== roomId){
          state.onchain[roomId] = null;
          return null;
        }
        const byWallet = {};
        const approvedWallets = [];
        const pendingWallets = [];
        const receiptAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
          commitment: "confirmed",
          filters: [{ dataSize: ROOM_RECEIPT_ACCOUNT_DATA_SIZE }]
        });

        for(const acct of receiptAccounts){
          if(!acct?.account?.data || acct.account.data.length < 8) continue;
          const receipt = decodeRoomReceiptAccount(acct.account.data);
          if(!receipt || receipt.roomId !== roomId) continue;
          const wallet = receipt.user;
          const refundableLamports = Number(receipt.refundable_lamports || 0);
          const allocatedLamports = Number(receipt.allocated_lamports || 0);
          const committedLamports = refundableLamports + allocatedLamports;
          byWallet[wallet] = {
            status: receipt.status,
            committed_lamports: committedLamports,
            committed_sol: committedLamports / LAMPORTS_PER_SOL,
            withdrawable_lamports: committedLamports,
            withdrawable_sol: committedLamports / LAMPORTS_PER_SOL,
            allocated_lamports: allocatedLamports,
            allocated_sol: allocatedLamports / LAMPORTS_PER_SOL,
            refundable_lamports: refundableLamports,
            refundable_sol: refundableLamports / LAMPORTS_PER_SOL,
            escrow_sol: committedLamports / LAMPORTS_PER_SOL,
            receipt_pda: acct.pubkey.toBase58(),
            bundle_lamports_total: Number(receipt.bundle_lamports_total || 0),
            forwarded_lamports: Number(receipt.forwarded_lamports || 0),
            refunded_lamports: Number(receipt.refunded_lamports || 0),
            receipt_backing_lamports: Number(receipt.receipt_backing_lamports || 0),
            native_token_allocation: Number(receipt.native_token_allocation || 0),
            native_tokens_claimed: Number(receipt.native_tokens_claimed || 0),
            external_allocation_units: Number(receipt.external_allocation_units || 0),
            external_units_claimed: Number(receipt.external_units_claimed || 0),
          };
          if(receipt.status === "approved") approvedWallets.push(wallet);
          if(receipt.status === "pending") pendingWallets.push(wallet);
        }

        snapshot = {
          roomId,
          roomLedgerPda: roomLedgerPda.toBase58(),
          admin: roomLedger.admin,
          admin_pubkey: roomLedger.admin_pubkey,
          pending_count: Number(roomLedger.pending_count || 0),
          approved_count: Number(roomLedger.approved_count || 0),
          total_allocated_lamports: Number(roomLedger.total_allocated_lamports || 0),
          total_escrow_lamports: Number(roomLedger.total_escrow_lamports || 0),
          total_refundable_lamports: Number(roomLedger.total_refundable_lamports || 0),
          total_forwarded_lamports: Number(roomLedger.total_forwarded_lamports || 0),
          total_refunded_lamports: Number(roomLedger.total_refunded_lamports || 0),
          min_approved_wallets: Number(roomLedger.min_approved_wallets || 0),
          spawn_target_lamports: Number(roomLedger.spawn_target_lamports || 0),
          max_wallet_share_bps: Number(roomLedger.max_wallet_share_bps || 0),
          launch_backend: roomLedger.launch_backend,
          launch_mode: roomLedger.launch_mode,
          external_settlement_status: roomLedger.external_settlement_status,
          room_version: "v2_shared_vault",
          model: "v2_shared_vault",
          derived_room_state: mapRoomStateFromV2Lifecycle(roomLedger.room_state) || "",
          approverWallets: roomLedger.admin ? [roomLedger.admin] : [],
          byWallet,
          approvedWallets,
          pendingWallets,
          fetchedAtMs: Date.now()
        };
      } else {
        state.onchain[roomId] = null;
        return null;
      }

      state.onchain[roomId] = snapshot;
      const room = roomById(roomId);
      if(room){
        room.onchain = snapshot;
        if(snapshot.model === "v2_shared_vault") markRoomAsV2SharedVault(room);
        room.curve_lifecycle = snapshot.curve_lifecycle;
        room.real_sol_reserve = snapshot.real_sol_reserve;
        room.real_token_reserve = snapshot.real_token_reserve;
        room.graduation_target_lamports = snapshot.graduation_target_lamports;
        room.spawn_target_sol = Number(snapshot.spawn_target_lamports || 0) / LAMPORTS_PER_SOL;
        room.min_approved_wallets = Number(snapshot.min_approved_wallets || room.min_approved_wallets || 0);
        room.max_wallet_share_bps = Number(snapshot.max_wallet_share_bps || room.max_wallet_share_bps || 0);
        if(snapshot.derived_room_state) room.state = snapshot.derived_room_state;
      }
      state.onchainMeta[roomId] = { fetchedAtMs: snapshot.fetchedAtMs };
      return snapshot;
    }

    async function fetchConnectedWalletDepositLamports(roomId){
      if(!roomId || !connectedWallet) return 0;
      const room = roomById(roomId);
      if(isV2Room(room) || state.onchain?.[roomId]?.model === "v2_shared_vault"){
        const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
        const [roomReceiptPda] = await deriveRoomReceiptPda(roomId, walletPk);
        const receiptInfo = await connection.getAccountInfo(roomReceiptPda, "confirmed");
        if(!receiptInfo?.data?.length || receiptInfo.data.length < 8) return 0;
        const receipt = decodeRoomReceiptAccount(receiptInfo.data);
        return Number((receipt?.allocated_lamports || 0) + (receipt?.refundable_lamports || 0));
      }
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [depositPda] = await deriveDepositPda(roomId, walletPk);
      const depositInfo = await connection.getAccountInfo(depositPda, "confirmed");
      if(!depositInfo || !depositInfo.data || depositInfo.data.length < 8) return 0;
      const deposit = decodeDepositAccount(depositInfo.data);
      return Number((deposit?.allocated_lamports || 0) + (deposit?.refundable_lamports || 0));
    }


    async function fetchConnectedWalletDepositSnapshot(roomId = activeRoomId){
      if(!connectedWallet || !roomId) {
        state.userEscrow = null;
        return null;
      }
      const room = roomById(roomId);
      if(isV2Room(room) || state.onchain?.[roomId]?.model === "v2_shared_vault"){
        const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
        const [roomReceiptPda] = await deriveRoomReceiptPda(roomId, walletPk);
        const info = await connection.getAccountInfo(roomReceiptPda, "confirmed");
        if(!info || !info.data || info.data.length < 8){
          state.userEscrow = { exists: false, refundable_lamports: 0, allocated_lamports: 0, room_receipt_pda: roomReceiptPda.toBase58() };
          return state.userEscrow;
        }
        const receipt = decodeRoomReceiptAccount(info.data);
        state.userEscrow = {
          exists: true,
          status: receipt?.status || "",
          refundable_lamports: Number(receipt?.refundable_lamports || 0),
          allocated_lamports: Number(receipt?.allocated_lamports || 0),
          withdrawable_lamports: Number((receipt?.refundable_lamports || 0) + (receipt?.allocated_lamports || 0)),
          room_receipt_pda: roomReceiptPda.toBase58(),
        };
        return state.userEscrow;
      }
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const [depositPda] = await deriveDepositPda(roomId, walletPk);
      const info = await connection.getAccountInfo(depositPda, "confirmed");
      if(!info || !info.data || info.data.length < 8){
        state.userEscrow = { exists: false, refundable_lamports: 0, allocated_lamports: 0, deposit_pda: depositPda.toBase58() };
        return state.userEscrow;
      }
      const deposit = decodeDepositAccount(info.data);
      state.userEscrow = {
        exists: true,
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
          filters: [{ dataSize: 8 + 4 + 64 + 32 + 1 + 1 + 8 + 8 + 8 + 8 }]
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
            spawn_token_allocation: Number(deposit.spawn_token_allocation || 0),
            spawn_tokens_claimed: Number(deposit.spawn_tokens_claimed || 0),
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

    function getWalletSpawnAllocations(wallet, snapshot){
      if(!wallet) return [];
      const rowsByRoomId = new Map();

      const depositsByThread = snapshot?.depositsByThread || {};
      Object.values(depositsByThread).forEach((deposit) => {
        const allocation = Number(deposit.spawn_token_allocation || 0);
        const claimed = Number(deposit.spawn_tokens_claimed || 0);
        if(allocation <= 0 && claimed <= 0) return;
        const room = roomById(deposit.threadId);
        rowsByRoomId.set(deposit.threadId, {
          roomId: deposit.threadId,
          roomName: room?.name || deposit.threadId,
          roomTicker: room?.ticker || "",
          allocation,
          claimed,
          claimable: Math.max(0, allocation - claimed),
        });
      });

      const rows = [];
      state.rooms.forEach((room) => {
        const onchain = room?.onchain || state.onchain?.[room.id] || null;
        const byWallet = onchain?.byWallet || {};
        const entry = byWallet[wallet] || null;
        if(!entry) return;
        const allocation = Number(entry.spawn_token_allocation || 0);
        const claimed = Number(entry.spawn_tokens_claimed || 0);
        if(allocation <= 0 && claimed <= 0) return;
        rowsByRoomId.set(room.id, {
          roomId: room.id,
          roomName: room.name,
          roomTicker: room.ticker,
          allocation,
          claimed,
          claimable: Math.max(0, allocation - claimed),
        });
      });
      rowsByRoomId.forEach((row) => rows.push(row));
      rows.sort((a, b) => (b.claimable - a.claimable) || (b.allocation - a.allocation));
      return rows;
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
    loadLaunchRecordsFromLocalStorage();

    function seedMockPingThreads(){
      const seeds = {
        r1: [
          { wallet: state.rooms[0].creator_wallet, text: "this one could pop if we hit approvals", kind: "chat" },
          { wallet: "SYSTEM", text: "watchlist momentum building", kind: "system_activity" },
          { wallet: state.rooms[0].creator_wallet, text: "if spawn fills i'm in", kind: "chat" }
        ],
        r2: [
          { wallet: state.rooms[1].creator_wallet, text: "market is live now", kind: "chat" },
          { wallet: state.rooms[1].creator_wallet, text: "watching this one", kind: "chat" }
        ],
        r6: [
          { wallet: state.rooms[5].creator_wallet, text: "i like the distribution here", kind: "chat" },
          { wallet: "SYSTEM", text: "Spawn threshold moved +1 approval", kind: "system_activity" }
        ]
      };
      Object.entries(seeds).forEach(([rid, msgs]) => {
        state.chat[rid] = state.chat[rid] || [];
        if(state.chat[rid].length > 1) return;
        msgs.forEach((m, idx) => {
          state.chat[rid].push({
            ts: nowStamp(),
            _ts: Date.now() - (msgs.length - idx) * 60_000,
            wallet: m.wallet,
            text: m.text,
            kind: m.kind || "chat"
          });
        });
      });

      const demoWallet = state.rooms[0].creator_wallet;
      [state.rooms[0], state.rooms[1], state.rooms[5]].forEach((r, idx) => {
        r.positions = r.positions || {};
        r.positions[demoWallet] = r.positions[demoWallet] || { escrow_sol: 0.12 + (idx * 0.05), token_balance: idx === 1 ? 2100 : 0 };
        r.approverWallets = r.approverWallets || {};
        r.approverWallets[demoWallet] = true;
      });
    }
    seedMockPingThreads();

    function mkRoom(id, name, ticker, desc, launchConfig = null, creatorWallet = null){
      const creator_wallet = String(creatorWallet || connectedWallet || "").trim();
      if(!creator_wallet){
        throw new Error("creator wallet required for room creation");
      }
      const config = launchConfig || getCreateLaunchConfig();
      const mode = config.launchMode || "spawn";
      const isInstant = mode === "instant";
      const room = {
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
      return normalizeLaunchRoom(room, { launchMode: mode });
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
      const room = roomById(roomId);
      if(!room) return 0;
      const onchainRow = state.onchain?.[roomId]?.byWallet?.[connectedWallet] || room?.onchain?.byWallet?.[connectedWallet] || null;
      if(onchainRow) return getWalletGrossCommittedSol(room, connectedWallet, onchainRow);
      const local = room.positions?.[connectedWallet] || {};
      return Math.max(0, Number((local.committed_sol ?? local.escrow_sol ?? 0)));
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
        const escrowSnapshot = await fetchConnectedWalletDepositSnapshot(roomId);
        if(activeRoomId !== roomId) return;
        const snapshot = state.onchain?.[roomId] || {};
        snapshot.byWallet = snapshot.byWallet || {};
        const fetchedDepositLamports = Math.max(0, Math.round(Number(escrowSnapshot?.withdrawable_lamports || 0)));
        const rawRow = {
          ...(snapshot.byWallet[connectedWallet] || {}),
          committed_lamports: fetchedDepositLamports,
          committed_sol: fetchedDepositLamports / LAMPORTS_PER_SOL,
          escrow_sol: fetchedDepositLamports / LAMPORTS_PER_SOL,
          withdrawable_sol: fetchedDepositLamports / LAMPORTS_PER_SOL,
          allocated_sol: Math.max(0, Number(escrowSnapshot?.allocated_lamports || 0)) / LAMPORTS_PER_SOL,
          withdrawable_lamports: fetchedDepositLamports,
          allocated_lamports: Math.max(0, Number(escrowSnapshot?.allocated_lamports || 0)),
          refundable_lamports: Math.max(0, Number(escrowSnapshot?.refundable_lamports || 0)),
        };
        console.log("[ping-debug] raw escrow refresh row", {
          roomId,
          wallet: connectedWallet,
          rawRow,
          storedBackingLamports: getWalletDepositBackingLamports(r, connectedWallet),
          resolvedCommittedLamports: resolveWalletCommittedLamports(r, connectedWallet, rawRow),
        });
        snapshot.byWallet[connectedWallet] = rawRow;
        state.onchain[roomId] = snapshot;
        const committedShownLamports = resolveWalletCommittedLamports(r, connectedWallet, rawRow);
        const grossCommittedSol = committedShownLamports / LAMPORTS_PER_SOL;
        console.log("[ping-debug] wallet committed refresh", {
          roomId,
          wallet: connectedWallet,
          rawFetchedDepositLamports: fetchedDepositLamports,
          depositBackingLamports: getWalletDepositBackingLamports(r, connectedWallet),
          resolvedCommittedLamports: committedShownLamports,
        });
        meLine.textContent = `you: your committed amount ${grossCommittedSol.toFixed(3)} SOL`;
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

    function mountCreateCoinInSpawnTab(){
      const createCoinWrap = $("createCoinWrap");
      const createCoinHead = $("createCoinHead");
      const createCoinBody = $("createCoinBody");
      const spawnCoinTabPanel = $("spawnCoinTabPanel");
      if(!createCoinWrap || !spawnCoinTabPanel) return;

      if(createCoinWrap.parentElement !== spawnCoinTabPanel){
        spawnCoinTabPanel.appendChild(createCoinWrap);
      }

      if(createCoinHead) createCoinHead.style.display = "none";
      if(createCoinBody){
        createCoinBody.style.display = "block";
        createCoinBody.style.marginTop = "0";
      }
      createCoinWrap.classList.add("on");
      createCoinWrap.style.marginBottom = "0";
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

    function isLaunchTrustExpanded(roomId){
      return !!state.launchTrustExpandedByRoom?.[roomId];
    }

    function setLaunchTrustExpanded(roomId, expanded){
      if(!roomId) return;
      state.launchTrustExpandedByRoom = state.launchTrustExpandedByRoom || {};
      state.launchTrustExpandedByRoom[roomId] = !!expanded;
    }

    function syncLaunchTrustPanel(roomId){
      const toggle = $("launchTrustToggle");
      const body = $("launchTrustBody");
      if(!toggle || !body) return;
      const expanded = isLaunchTrustExpanded(roomId);
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      body.style.display = expanded ? "block" : "none";
      if(toggle.dataset.boundRoomId !== roomId){
        toggle.onclick = () => {
          const nextExpanded = !isLaunchTrustExpanded(roomId);
          setLaunchTrustExpanded(roomId, nextExpanded);
          syncLaunchTrustPanel(roomId);
        };
        toggle.dataset.boundRoomId = roomId;
      }
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
      chatView = $("chatView");
      profileView = $("profileView");
      legalView = $("legalView");
      homeBtn = $("homeBtn");
      roomContextToggleBtn = $("roomContextToggleBtn");

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
      await hydrateRoomsFromSupabase();

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
      if(connectedWallet) console.log("[pingy] wallet connected", { connectedWallet });
    }

    function clearWalletScopedCaches(){
      state.userEscrow = null;
      state.onchain = {};
      state.onchainMeta = {};
    }

    function clearWalletDerivedState(prevWallet = null){
      state.userEscrow = null;
      state.grossCommitDebugMeta = {};
      if(prevWallet){
        delete state.walletBalances[prevWallet];
        delete state.walletBalancesMeta[prevWallet];
      }
    }

    async function refreshRoomFromChain(){
      const tasks = state.rooms.map((room) => refreshRoomOnchainSnapshot(room.id, { force: true }));
      if(connectedWallet) tasks.push(fetchConnectedWalletDepositSnapshot());
      await Promise.allSettled(tasks);
      if(activeRoomId && connectedWallet) await refreshConnectedWalletEscrowLine(activeRoomId);
    }

    function clearConnectedWallet(opts = {}){
      const prevWallet = connectedWallet;
      if(prevWallet) console.log("[wallet-sync] wallet disconnected", { wallet: prevWallet, reason: opts.reason || "unknown" });
      setConnectedWallet(null);
      clearWalletDerivedState(prevWallet);
      clearWalletScopedCaches();
      refreshWalletViews();
      console.log("[wallet-sync] cleared previous wallet state", { from: prevWallet, to: null });
    }

    async function handleWalletChanged(nextWallet, opts = {}){
      const prevWallet = connectedWallet;
      const normalizedNextWallet = nextWallet || null;
      console.log("[wallet-sync] switching wallet", { from: prevWallet, to: normalizedNextWallet, source: opts.source || "unknown" });
      if(!normalizedNextWallet){
        clearConnectedWallet({ reason: opts.source || "wallet-changed-empty" });
        return;
      }

      setConnectedWallet(normalizedNextWallet);
      clearWalletDerivedState(prevWallet && prevWallet !== normalizedNextWallet ? prevWallet : null);
      clearWalletScopedCaches();
      console.log("[wallet-sync] cleared previous wallet state", { from: prevWallet, to: normalizedNextWallet });

      await refreshRoomFromChain();
      console.log("[wallet-sync] refreshed balances for new wallet", { wallet: normalizedNextWallet });
      refreshWalletViews();
      console.log("[wallet-sync] rerender complete", { wallet: normalizedNextWallet, activeRoomId: activeRoomId || null });
      if(!opts.silent) showToast("wallet switched.");
    }

    async function syncWalletFromProvider(provider, opts = {}){
      if(!provider) return;
      const nextWallet = provider.publicKey?.toBase58?.() || provider.publicKey?.toString?.() || null;
      const prevWallet = connectedWallet;
      if(!nextWallet){
        await handleWalletChanged(null, { ...opts, source: opts.source || "sync-empty" });
        return;
      }
      if(nextWallet === prevWallet && !opts.forceRefresh) return;
      await handleWalletChanged(nextWallet, { ...opts, source: opts.source || "sync" });
    }

    async function reconcileWalletFromProvider(opts = {}){
      const provider = getProvider();
      if(!provider){
        clearConnectedWallet({ reason: "reconcile-provider-missing" });
        return;
      }
      const providerWallet = provider.publicKey?.toBase58?.() || provider.publicKey?.toString?.() || null;
      const isConnected = provider?.isConnected === true || !!providerWallet;
      if(!isConnected || !providerWallet){
        clearConnectedWallet({ reason: "reconcile-provider-disconnected" });
        return;
      }
      await syncWalletFromProvider(provider, { ...opts, source: opts.source || "reconcile" });
    }

    function bindWalletListeners(provider){
      if(!provider || typeof provider.on !== "function" || boundWalletProviders.has(provider)) return;
      provider.on("accountChanged", async (pubkey) => {
        console.log("[wallet-sync] accountChanged fired", { next: pubkey?.toBase58?.() || pubkey?.toString?.() || null });
        if(!pubkey){
          clearConnectedWallet({ reason: "accountChanged-null" });
          return;
        }
        await syncWalletFromProvider(provider, { source: "accountChanged" });
      });
      provider.on("connect", async () => {
        console.log("[wallet-sync] connect", provider.publicKey?.toBase58?.() || null);
        await syncWalletFromProvider(provider, { silent: true, source: "connect" });
      });
      provider.on("disconnect", () => {
        console.log("[wallet-sync] disconnect");
        clearConnectedWallet({ reason: "provider-disconnect" });
      });
      boundWalletProviders.add(provider);
    }

    document.addEventListener("visibilitychange", () => {
      if(document.visibilityState === "visible") reconcileWalletFromProvider({ silent: true });
    });
    window.addEventListener("focus", () => {
      reconcileWalletFromProvider({ silent: true });
    });

    function buildPingFeeTransferInstruction(feeLamports){
      const safeFeeLamports = Math.max(0, Math.floor(Number(feeLamports || 0)));
      if(safeFeeLamports <= 0) return null;
      if(!connectedWallet) throw new Error("wallet not connected");
      const fromPubkey = parsePublicKeyStrict(connectedWallet, "connected wallet");
      const feeRecipientPubkey = parsePublicKeyStrict(PINGY_FEE_RECIPIENT, "ping fee recipient");
      return SystemProgram.transfer({
        fromPubkey,
        toPubkey: feeRecipientPubkey,
        lamports: safeFeeLamports,
      });
    }

    async function runWalletSmokeTest(){
      if(!connectedWallet){
        showToast("connect wallet first.");
        return { ok: false, error: new Error("wallet not connected") };
      }
      const provider = getProvider();
      if(!provider){
        showToast("Phantom not found. Install Phantom.");
        return { ok: false, error: new Error("phantom provider not found") };
      }
      const walletPk = parsePublicKeyStrict(connectedWallet, "connected wallet");
      traceStep("wallet-smoke-test:start", { wallet: connectedWallet }, "smoke test: requesting phantom popup...");
      try {
        let blockhash, lastValidBlockHeight;
        ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));

        const tx = new Transaction({
          feePayer: walletPk,
          recentBlockhash: blockhash,
        });
        tx.add(SystemProgram.transfer({
          fromPubkey: walletPk,
          toPubkey: walletPk,
          lamports: 1,
        }));

        console.log("SystemProgram.transfer type:", typeof SystemProgram.transfer);

        const signedTx = await provider.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false });

        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        traceStep("wallet-smoke-test:ok", { signature: sig }, "smoke test confirmed");
        return { ok: true, signature: sig };
      } catch (err){
        traceStep("wallet-smoke-test:failed", { error: String(err?.message || err) }, "smoke test failed");
        reportTxError(err, "wallet smoke test failed");
        return { ok: false, error: err };
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

    console.log("[pingy] provider.publicKey after connect:", provider?.publicKey?.toString?.() || provider?.publicKey);
    toast.classList.remove("on");

    if(!profile.wallet_first_seen_ms) profile.wallet_first_seen_ms = Date.now();
    if(!profile.namesByWallet[nextWallet]) profile.namesByWallet[nextWallet] = "big_hitter";
    saveProfileLocal();

    await syncWalletFromProvider(provider, { silent: true, forceRefresh: true, source: "connect-button" });
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
  clearConnectedWallet({ reason: "manual-disconnect" });
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
    $("chatBackBtn")?.addEventListener("click", () => {
      if(activeRoomId) openRoom(activeRoomId);
      else navigateHash("home");
    });
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
        _ts: Date.now(),
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

    function walletStatus(r, wallet){
      if(!wallet) return "";
      const snapshot = readRoomEscrowSnapshot(r);
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
      return readRoomEscrowSnapshot(room);
    }

    function approvedEscrowSol(r){
      let total = 0;
      const snapshot = readRoomEscrowSnapshot(r);
      for(const w of snapshot.approvedWallets){
        total += Number(snapshot.byWallet[w]?.escrow_sol || 0);
      }
      return total;
    }

    function countedEscrowSol(r){
      if(Number(r?.onchain?.spawn_target_lamports || 0) > 0){
        const grossLamports = Number(r.onchain.total_escrow_lamports || 0);
        if(grossLamports > 0) return grossLamports / LAMPORTS_PER_SOL;
        return Number(r.onchain.total_allocated_lamports || 0) / LAMPORTS_PER_SOL;
      }
      return getRoomGrossCommittedSol(r);
    }

    function spawnProgress01(r){
      const target = spawnTargetSol(r);
      if(target <= 0) return 0;
      return clamp01(getRoomTotalCommittedSol(r) / target);
    }
    function legacyBondingProgress01(r){
      syncRoomMarketCap(r);
      const MC = Number(r?.market_cap_usd || 0);
      return clamp01((MC - MC_SPAWN_FLOOR) / (GRADUATION_MARKET_CAP - MC_SPAWN_FLOOR));
    }
    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    function graduationTargetSol(r){
      const targetLamports = Number(r?.onchain?.graduation_target_lamports || r?.graduation_target_lamports || 0);
      if(targetLamports > 0) return targetLamports / LAMPORTS_PER_SOL;
      return 78;
    }
    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    function currentBondingReserveSol(r){
      const reserveLamports = Number(r?.onchain?.real_sol_reserve || r?.real_sol_reserve || 0);
      if(reserveLamports > 0) return reserveLamports / LAMPORTS_PER_SOL;
      return legacyBondingProgress01(r) * graduationTargetSol(r);
    }
    // Native Pingy curve path retained for future reactivation. Inactive in Pump.fun mode.
    function bondingProgress01(r){
      if(r?.state === "BONDED") return 1;
      const target = graduationTargetSol(r);
      if(target <= 0) return 0;
      return clamp01(currentBondingReserveSol(r) / target);
    }

    function maybeAdvance(r){
      if(r.state === "BONDING" || r.state === "BONDED") syncRoomMarketCap(r);
      if(r.state === "SPAWNING"){
        const total = countedEscrowSol(r);
        const target = spawnTargetSol(r);
	        if(target > 0 && total >= target && readRoomEscrowSnapshot(r).approvedWallets.length >= minApprovedWalletsRequired(r)){
          if(shouldUseOnchain()){
            void maybeExecuteSpawnOnchain(r);
            return;
          }
          if(isV2Room(r)) return;

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
      let snapshot = readRoomEscrowSnapshot(room);
      if(shouldPing){
        const wallet = sim.walletPool[Math.floor(rand() * sim.walletPool.length)];
        const pos = ensurePos(room, wallet);
        const leftCap = Math.max(0, cap - Number(pos.escrow_sol || 0));
        if(leftCap > 0.002){
          const contribution = Math.min(leftCap, 0.02 + rand() * 0.28);
          const approveChance = snapshot.approvedWallets.length < minWallets ? 0.58 : 0.32;
          const approveNow = rand() < approveChance;
          upsertDevSimPing(room, wallet, contribution, approveNow);
          snapshot = readRoomEscrowSnapshot(room);
        }
      }

      if(snapshot.pendingWallets.length > 0 && rand() < 0.7){
        const wallet = snapshot.pendingWallets[Math.floor(rand() * snapshot.pendingWallets.length)];
        const wasApproved = normalizeDepositStatus(room.approval?.[wallet]) === "approved";
        room.approval[wallet] = "approved";
        if(!wasApproved) addApprovalSystemEvent(room.id, wallet);
        snapshot = readRoomEscrowSnapshot(room);
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
      const phaseLabel = isPumpfunRoom(r) ? getDisplayedRoomPhaseLabel(r) : lifecyclePhaseLabel(r.state);

      if(r.state === "SPAWNING"){
        const p = spawnProgress01(r);
        const pct = Math.round(p * 100);
        const target = spawnTargetSol(r);
        const committed = getRoomTotalCommittedSol(r);
        const approvedCount = Number(r?.onchain?.approved_count || 0);
        const minApproved = minApprovedWalletsRequired(r);
        return `
          <div class="cardGrid pre">
            ${mosaicHtml(r)}
            <div style="min-width:0;">
              <div class="row" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;">
                <div class="name">${escapeText(r.name)} <span class="k">$${escapeText(r.ticker)}</span></div>
                <span class="k chipLine" style="margin-left:auto;">${phaseLabel} • ${roomLaunchLabel(r)}</span>
              </div>
              <div class="tiny subline">${escapeText(isPumpfunRoom(r) ? getDisplayedRoomSubline(r) : (r.desc || "prespawn chat open"))}</div>
              <div class="bar barActive barSpawn"><i style="width:${pct}%"></i></div>
              <div class="barRow">
                <div class="tiny">phase: ${phaseLabel}</div>
                <div class="pct">${pct}%</div>
              </div>
              <div class="tiny muted" style="margin-top:4px;">${committed.toFixed(3)} / ${target.toFixed(3)} SOL committed</div>
              <div class="tiny muted">${approvedCount} / ${minApproved} required wallets</div>
            </div>
          </div>
        `;
      }

      const mc = Number(r.market_cap_usd || 0);
      const p = (r.state === "BONDING") ? bondingProgress01(r) : 1;
      const pct = Math.round(p * 100);
      const chg = Number(r.change_pct || 0);
      const chgCls = chg > 0 ? "up" : (chg < 0 ? "down" : "");
      const chip = `${phaseLabel} • ${roomLaunchLabel(r)}`;
      const athRatio = p;
      const isHotBonding = r.state === "BONDING" && athRatio >= 0.9;
      const isBonded = r.state === "BONDED";
      const barClass = isHotBonding ? "bar barActive barBonding barHot" : "bar barActive barBonding";
      const subline = escapeText(getDisplayedRoomSubline(r));

      return `
        <div class="cardGrid">
          ${mosaicHtml(r)}
          <div style="min-width:0;">
            <div class="row" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;">
              <div class="name">${escapeText(r.name)} <span class="k">$${escapeText(r.ticker)}</span></div>
              <span class="k chipLine" style="margin-left:auto;">${chip}${isBonded ? (getDisplayedRoomPhase(r) === "live_external" ? " • live external" : " • graduated") : ""}</span>
            </div>
            <div class="tiny subline">${subline}</div>
            <div class="${barClass}"><i style="width:${pct}%"></i>${isHotBonding ? `<span class="barSpark"></span>` : ""}</div>
          </div>
          <div class="metricCol">
            <div class="metric">${fmtK(mc)}</div>
            <div class="tiny muted">market cap</div>
            <div class="chg ${chgCls}">${signArrow(chg)}</div>
            <div class="tiny muted">24h</div>
          </div>
        </div>
      `;
    }

    function renderCard(r, where){
      where.appendChild(getOrCreateHomeCard(r));
    }

    function renderExploreCard(r, where){
      const action = primaryActionForRoom(r);
      const el = document.createElement("div");
      el.className = "card";
      el.style.maxWidth = "none";
      el.style.minWidth = "unset";
      el.innerHTML = `
        ${cardInner(r)}
        <div class="row" style="justify-content:flex-end; margin-top:10px;">
          <button class="btn subtle" data-ping="${escapeText(r.id)}">${action.label}</button>
          <button class="btn subtle" title="share" data-share="${escapeText(r.id)}">↗</button>
        </div>
      `;
      el.addEventListener("dblclick", (ev) => {
        if(ev.target.closest("[data-ping],[data-share]")) return;
        openRoom(r.id);
      });
      el.querySelector("[data-ping]").addEventListener("click", () => {
        openRoom(r.id);
        if(action.opensTrade) setTimeout(() => openPingModal(r.id), 0);
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
      const action = primaryActionForRoom(r);
      const classes = ["card"];
      if(Date.now() < (r._pulseUntil||0)) classes.push("pulse");
      if(state.movers.active.has(r.id)) classes.push("isMover");
      if(state.movers.leadId === r.id) classes.push("isLeadMover");
      if(state.movers.shimmyId === r.id && Date.now() < Number(state.movers.shimmyUntil || 0)) classes.push("isShimmy");
      el.className = classes.join(" ");
      el.innerHTML = `
        ${cardInner(r)}
        <div class="row" style="justify-content:flex-end; margin-top:10px;">
          <button class="btn subtle small" data-ping="${escapeText(r.id)}">${action.label}</button>
          <button class="btn subtle small" title="share" data-share="${escapeText(r.id)}">↗</button>
        </div>
      `;
      el.addEventListener("dblclick", (ev) => {
        if(ev.target.closest("[data-ping],[data-share]")) return;
        openRoom(r.id);
      });
      el.querySelector("[data-ping]").addEventListener("click", () => {
        openRoom(r.id);
        if(action.opensTrade) setTimeout(() => openPingModal(r.id), 0);
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

    function getWalletEscrowInRoom(room, wallet){
      if(!room || !wallet) return 0;
      const onchainRow = room?.onchain?.byWallet?.[wallet] || state.onchain?.[room.id]?.byWallet?.[wallet] || null;
      if(onchainRow) return getWalletGrossCommittedSol(room, wallet, onchainRow);
      const local = room.positions?.[wallet] || {};
      return Math.max(0, Number((local.committed_sol ?? local.escrow_sol ?? 0)));
    }

    function walletIsRelatedToRoom(room, wallet){
      if(!room || !wallet) return false;
      if(isCreator(room, wallet)) return true;
      if(isApprover(room, wallet)) return true;
      if(normalizeDepositStatus(room.approval?.[wallet] || "")) return true;
      const grossCommittedSol = getWalletGrossCommittedSol(room, wallet);
      if(grossCommittedSol > 0) return true;
      const pos = room.positions?.[wallet] || {};
      if(Number(pos.token_balance || 0) > 0) return true;
      const onchainRow = room?.onchain?.byWallet?.[wallet] || state.onchain?.[room.id]?.byWallet?.[wallet] || null;
      if(onchainRow){
        if(getWalletGrossCommittedSol(room, wallet, onchainRow) > 0) return true;
        if(Number(onchainRow.spawn_token_allocation || 0) > 0) return true;
      }
      const msgs = state.chat?.[room.id] || [];
      if(msgs.some((m) => m && m.wallet === wallet)) return true;
      return false;
    }

    function getPingInboxRooms(){
      if(!connectedWallet) return [];
      return state.rooms
        .filter((room) => walletIsRelatedToRoom(room, connectedWallet))
        .slice()
        .sort((a, b) => {
          const aChat = (state.chat[a.id] || []).length ? Number(state.chat[a.id][state.chat[a.id].length - 1]?._ts || 0) : 0;
          const bChat = (state.chat[b.id] || []).length ? Number(state.chat[b.id][state.chat[b.id].length - 1]?._ts || 0) : 0;
          if(aChat !== bChat) return bChat - aChat;
          const aAct = Number(a._lastActivity || 0);
          const bAct = Number(b._lastActivity || 0);
          if(aAct !== bAct) return bAct - aAct;
          return 0;
        });
    }





    function getWalletPingReadState(){
      if(!connectedWallet) return { tsByRoom: {}, countByRoom: {} };
      if(!state.pingReadByWallet[connectedWallet]){
        state.pingReadByWallet[connectedWallet] = { tsByRoom: {}, countByRoom: {} };
      }
      return state.pingReadByWallet[connectedWallet];
    }

    function formatUnreadCountLabel(count){
      const n = Math.max(0, Number(count) || 0);
      if(n >= 1000) return "1000+";
      if(n >= 100) return "100+";
      if(n >= 50) return "50+";
      if(n >= 10) return "10+";
      return String(n);
    }

    function getUnreadCountForRoom(roomId){
      if(!roomId || !connectedWallet) return 0;
      const msgs = state.chat[roomId] || [];
      const readState = getWalletPingReadState();
      const readAfterTs = Number(readState.tsByRoom?.[roomId] || 0);
      const readAfterCount = Number(readState.countByRoom?.[roomId] || 0);
      return msgs.reduce((count, m, idx) => {
        if(!m || m.wallet === connectedWallet || m.wallet === "SYSTEM") return count;
        const msgTs = Number(m._ts || 0);
        if(msgTs > 0){
          if(msgTs <= readAfterTs) return count;
          return count + 1;
        }
        const msgIdx = idx + 1;
        if(msgIdx <= readAfterCount) return count;
        return count + 1;
      }, 0);
    }

    function markPingThreadRead(roomId){
      if(!roomId) return;
      const readState = getWalletPingReadState();
      readState.tsByRoom[roomId] = Date.now();
      const msgs = state.chat[roomId] || [];
      readState.countByRoom[roomId] = msgs.length;
    }

    function getTotalUnreadPingsCount(){
      const rooms = getPingInboxRooms();
      return rooms.reduce((sum, room) => sum + getUnreadCountForRoom(room.id), 0);
    }

    function updatePingsTabUnreadBadge(){
      const badge = $("pingsTabUnreadBadge");
      if(!badge) return;
      const unread = getTotalUnreadPingsCount();
      if(unread <= 0){
        badge.style.display = "none";
        badge.textContent = "0";
        return;
      }
      badge.style.display = "inline-flex";
      badge.textContent = formatUnreadCountLabel(unread);
    }

    function pingThreadPreviewText(room){
      const msgs = (state.chat[room?.id] || []).slice().reverse();
      const prefer = msgs.find((m) => m && m.wallet !== "SYSTEM" && m.kind !== "activity" && String(m.text || "").trim());
      if(prefer) return String(prefer.text).trim().slice(0, 90);
      const system = msgs.find((m) => m && String(m.text || "").trim());
      if(system) return String(system.text).trim().slice(0, 90);
      if(isPumpfunRoom(room)) return getDisplayedPumpPreviewText(room);
      if(room?.state === "SPAWNING") return "Spawn discussion active";
      if(room?.state === "BONDING") return "Market is live";
      if(room?.state === "BONDED") return "Graduated from bonding";
      return "Thread active";
    }

    function pingRelationshipMeta(room, wallet){
      if(!room || !wallet) return "";
      if(isCreator(room, wallet)) return "creator";
      if(isApprover(room, wallet)) return "approver";
      const grossCommittedSol = getWalletGrossCommittedSol(room, wallet);
      if(grossCommittedSol > 0) return `your committed amount: ${grossCommittedSol.toFixed(3)} SOL`;
      const tokenBal = Number((room.positions?.[wallet]?.token_balance) || 0);
      if(tokenBal > 0) return "you hold this coin";
      return "participant";
    }

    function logRoomGrossCommitmentDebug(room){
      if(!room || room.state !== "SPAWNING") return;
      const now = Date.now();
      const key = String(room.id || "");
      const last = Number(state.grossCommitDebugMeta?.[key] || 0);
      if(last > 0 && (now - last) < 2000) return;
      state.grossCommitDebugMeta = state.grossCommitDebugMeta || {};
      state.grossCommitDebugMeta[key] = now;
      const snapshot = readRoomEscrowSnapshot(room);
      const wallets = Array.from(new Set(Object.keys(snapshot.byWallet || {})));
      const rows = wallets.map((wallet) => {
        const row = snapshot.byWallet?.[wallet] || {};
        const netCommittedSol = Math.max(0, Number(row.committed_sol ?? row.withdrawable_sol ?? row.escrow_sol ?? row.allocated_sol ?? 0));
        return {
          wallet,
          committed_sol: Number(netCommittedSol.toFixed(9)),
        };
      });
      console.log("[ping-debug] gross commitment by wallet", { roomId: room.id, rows });
    }

    function renderPingsView(){
      const wrap = $("pingsView");
      if(!wrap) return;
      wrap.innerHTML = "";

      if(!connectedWallet){
        wrap.innerHTML = `<div class="panel"><div class="muted">Connect wallet to view your pings.</div></div>`;
        return;
      }

      const rooms = getPingInboxRooms();
      if(!rooms.length){
        wrap.innerHTML = `<div class="panel"><div class="muted">No pings yet. Join, create, or approve a coin to populate this inbox.</div></div>`;
        return;
      }

      const list = document.createElement("div");
      list.className = "panel";
      rooms.forEach((room) => {
        const row = document.createElement("button");
        const unreadCount = getUnreadCountForRoom(room.id);
        row.type = "button";
        row.className = "pingRow";
        const img = room.image ? `<img src="${escapeText(room.image)}" alt="" />` : `<span>$${escapeText((room.ticker||"?").slice(0,2))}</span>`;
        row.innerHTML = `
          <div class="pingAvatar">${img}</div>
          <div class="pingMain">
            <div class="pingTitle">${escapeText(room.name)} <span class="muted">$${escapeText(room.ticker)}</span></div>
            <div class="pingPreview">${escapeText(pingThreadPreviewText(room))}</div>
            <div class="pingMeta muted tiny">${escapeText(pingRelationshipMeta(room, connectedWallet))}</div>
          </div>
          <div class="pingSide">
            <span class="k">${escapeText(lifecyclePhaseLabel(room.state))}</span>
            ${unreadCount > 0 ? `<span class="pinkCountBadge">${escapeText(formatUnreadCountLabel(unreadCount))}</span>` : `<span class="tiny muted">—</span>`}
          </div>
        `;
        row.addEventListener("click", () => openPingThread(room.id));
        list.appendChild(row);
      });
      wrap.appendChild(list);
      updatePingsTabUnreadBadge();
    }

    function openPingsInbox(){
      state.activePingThreadId = null;
      renderPingsView();
    }

    function openPingThread(threadId){
      state.activePingThreadId = threadId;
      markPingThreadRead(threadId);
      navigateHash("chat/" + encodeURIComponent(threadId));
      updatePingsTabUnreadBadge();
    }

    function openMarketRoomFromPingThread(threadId){
      if(!threadId) return;
      openRoom(threadId);
    }

    function setHomeTab(tab){
      const next = tab === "pings" || tab === "spawn" ? tab : "explore";
      state.activeHomeTab = next;

      const exploreTabPanel = $("exploreTabPanel");
      const spawnCoinTabPanel = $("spawnCoinTabPanel");
      const pingsTabPanel = $("pingsTabPanel");
      const pingsTabBtn = $("pingsTabBtn");
      const spawnCoinTabBtn = $("spawnCoinTabBtn");
      const exploreTabBtn = $("exploreTabBtn");
      if(exploreTabPanel) exploreTabPanel.style.display = next === "explore" ? "block" : "none";
      if(spawnCoinTabPanel) spawnCoinTabPanel.style.display = next === "spawn" ? "block" : "none";
      if(pingsTabPanel) pingsTabPanel.style.display = next === "pings" ? "block" : "none";
      if(next === "pings") openPingsInbox();

      if(pingsTabBtn){
        pingsTabBtn.setAttribute("aria-pressed", next === "pings" ? "true" : "false");
        pingsTabBtn.style.fontWeight = next === "pings" ? "700" : "400";
      }
      if(spawnCoinTabBtn){
        spawnCoinTabBtn.setAttribute("aria-pressed", next === "spawn" ? "true" : "false");
        spawnCoinTabBtn.style.fontWeight = next === "spawn" ? "700" : "400";
      }
      if(exploreTabBtn){
        exploreTabBtn.setAttribute("aria-pressed", next === "explore" ? "true" : "false");
        exploreTabBtn.style.fontWeight = next === "explore" ? "700" : "400";
      }
    }

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
      if(state.activeHomeTab === "pings") renderPingsView();
      updatePingsTabUnreadBadge();

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
    $("searchInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter"){ e.preventDefault(); runExploreSearch(); }
    });
    $("pingsTabBtn")?.addEventListener("click", () => setHomeTab("pings"));
    $("spawnCoinTabBtn")?.addEventListener("click", () => setHomeTab("spawn"));
    $("exploreTabBtn")?.addEventListener("click", () => setHomeTab("explore"));
    mountCreateCoinInSpawnTab();
    setHomeTab("explore");
    updatePingsTabUnreadBadge();
    bindRoomChartControls();

    async function setCreatorCommitMax(){
      if(!connectedWallet) return showToast("connect wallet first.");
      await refreshWalletBalances(connectedWallet, { force: true });
      const launchConfigResult = validateCreateLaunchConfig(getCreateLaunchConfig());
      if(!launchConfigResult.ok) return;
      const launchConfig = launchConfigResult.config;
      const launchMode = launchConfig.launchMode || "spawn";
      const useV2SpawnCreate = shouldUseV2CreateFlow(launchMode);
      const walletSnapshot = state.walletBalances[connectedWallet] || {};
      const balanceLamports = Math.max(0, Math.floor(Number(walletSnapshot.nativeSol || 0) * LAMPORTS_PER_SOL));
      const input = $("newCommit");
      if(launchMode !== "spawn"){
        if(input) input.value = formatLamportsAsSol(Math.max(0, balanceLamports - CREATOR_MAX_TX_FEE_RESERVE_LAMPORTS));
        updateCreateCommitFeePreview();
        return;
      }
      const creatorModel = computeCreatorSpawnSpendModel({
        walletBalanceLamports: balanceLamports,
        committedCapLamports: configWalletCapLamports(launchConfig),
        bootstrapCostLamports: useV2SpawnCreate ? 0 : estimateCreatorBootstrapReserveLamports(connectedWallet),
        networkBufferLamports: CREATOR_MAX_TX_FEE_RESERVE_LAMPORTS,
      });
      console.log("[ping-debug] max ping calculation", {
        roomId: null,
        wallet: connectedWallet,
        committedTargetLamports: creatorModel.committedTargetLamports,
        grossPositionInputLamports: creatorModel.grossPositionInputLamports,
        totalWalletSpendLamports: creatorModel.totalWalletSpendLamports,
        availableBalanceLamports: balanceLamports,
        mode: "creator",
      });
      if(input) input.value = formatLamportsAsSol(creatorModel.totalWalletSpendLamports);
      updateCreateCommitFeePreview();
    }

    async function createCoinFromForm(){
      if(!connectedWallet) return showToast("connect wallet first.");
      await refreshWalletBalances(connectedWallet, { force: true });
      console.log("[ping-debug] spawn button handler start", { connectedWallet, launchBackend: PINGY_LAUNCH_BACKEND });
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
      const commitInputSol = commitStr ? Number(commitStr) : 0;
      console.log("[ping-debug] creator SOL parsed", { commitStr, commitInputSol, isFinite: Number.isFinite(commitInputSol) });

      if(!name) return alert("name required.");
      if(!ticker) return alert("ticker required.");
      const TICKER_RE = /^[A-Z0-9]{1,10}$/;
      if(!TICKER_RE.test(ticker)) return alert("ticker must be 1–10 chars, A–Z and 0–9 only (no spaces).");
      if(commitStr && (!Number.isFinite(commitInputSol) || Number.isNaN(commitInputSol) || commitInputSol <= 0)) return alert("commit must be a valid SOL amount.");
      const creatorTotalSpendLamports = Math.floor(commitInputSol * LAMPORTS_PER_SOL);
      if(commitInputSol > 0 && creatorTotalSpendLamports <= 0) return alert("commit must be at least 1 lamport.");
      const creatorWalletBalanceLamports = Math.max(0, Math.floor(Number(state.walletBalances?.[connectedWallet]?.nativeSol || 0) * LAMPORTS_PER_SOL));

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
      const useV2SpawnCreate = shouldUseV2CreateFlow(launchMode);
      const creatorFeeMath = launchMode === "spawn"
        ? computeCreatorSpawnSpendModel({
            walletBalanceLamports: Number.MAX_SAFE_INTEGER,
            committedCapLamports: Number.MAX_SAFE_INTEGER,
            bootstrapCostLamports: useV2SpawnCreate ? 0 : estimateCreatorBootstrapReserveLamports(connectedWallet),
            networkBufferLamports: 0,
            totalWalletSpendLamports: creatorTotalSpendLamports,
          })
        : {
            committedTargetLamports: creatorTotalSpendLamports,
            grossPositionInputLamports: creatorTotalSpendLamports,
            feeLamports: 0,
            bootstrapCostLamports: 0,
            totalWalletSpendLamports: creatorTotalSpendLamports,
          };
      if(useV2SpawnCreate && creatorFeeMath.bootstrapCostLamports !== 0){
        creatorFeeMath.bootstrapCostLamports = 0;
      }
      const commitLamports = creatorFeeMath.committedTargetLamports;
      const commit = commitLamports / LAMPORTS_PER_SOL;
      if(launchMode === "spawn" && creatorTotalSpendLamports > 0 && commitLamports <= 0){
        return alert("Total spend must exceed estimated room creation + Pingy fee to create a committed amount.");
      }
      let createTxSignature = "";
      let creatorFeeTransferSignature = "";

      if(launchMode === "spawn"){
        const presetCapLamports = configWalletCapLamports(launchConfig);
        if(commitLamports > presetCapLamports){
          return alert(`commit exceeds ${roomLaunchLabel({ launch_mode: "spawn", launch_preset: launchConfig.launchPreset })} cap (${(presetCapLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL max committed).`);
        }
      }
      const roomMetadataPayload = {
        name,
        ticker,
        creator_wallet: connectedWallet,
        description: desc,
        // TODO: move image_path/banner_path to Supabase Storage once media upload is migrated.
        image_path: newImgData || "",
        banner_path: newBannerData || "",
        is_test: DEV_SIMULATION,
      };
      const reservedSupabaseRoom = await reserveSupabaseRoomMetadata(roomMetadataPayload);
      const id = reservedSupabaseRoom?.runtimeRoomId || ("r" + Math.random().toString(16).slice(2,6));
      let creatorDepositBackingLamports = 0;
      let creatorEscrowContributionLamports = commitLamports;
      let creatorInitialCommitLamports = commitLamports;
      if(launchMode === "spawn" && commitLamports > 0 && !useV2SpawnCreate){
        try {
          creatorDepositBackingLamports = await estimateWalletDepositBackingLamports(id, connectedWallet);
        } catch(backingErr){
          console.warn("[ping-debug] creator deposit backing estimation failed", {
            roomId: id,
            wallet: connectedWallet,
            error: String(backingErr?.message || backingErr),
          });
        }
        const creatorSplit = splitCommittedLamportsForEscrow({
          committedLamports: commitLamports,
          depositBackingLamports: creatorDepositBackingLamports,
        });
        creatorDepositBackingLamports = creatorSplit.depositBackingLamports;
        creatorEscrowContributionLamports = creatorSplit.escrowContributionLamports;
      }
      const createDepositTotalLamports = commitLamports;
      const totalRequiredLamports = createDepositTotalLamports + creatorFeeMath.feeLamports;
      const SAFE_BUFFER = 0.01 * LAMPORTS_PER_SOL;
      if(totalRequiredLamports > creatorWalletBalanceLamports - SAFE_BUFFER) return alert("insufficient wallet balance for total spend.");
      console.log("[v2-spend-check]", {
        commitLamports,
        createDepositTotalLamports,
        feeLamports: creatorFeeMath.feeLamports,
        totalRequiredLamports,
        walletLamports: creatorWalletBalanceLamports
      });
      console.log("[ping-debug] ping fee math", {
        roomId: id,
        wallet: connectedWallet,
        creatorTotalSpendLamports,
        bootstrapCostLamports: creatorFeeMath.bootstrapCostLamports,
        grossPositionInputLamports: creatorFeeMath.grossPositionInputLamports,
        feeLamports: creatorFeeMath.feeLamports,
        committedTargetLamports: creatorFeeMath.committedTargetLamports,
        depositBackingLamports: creatorDepositBackingLamports,
        escrowContributionLamports: creatorEscrowContributionLamports,
        expectedWalletOutflowLamports: creatorTotalSpendLamports,
        expectedDepositInstructionLamports: createDepositTotalLamports,
        capRemainingLamports: launchMode === "spawn" ? configWalletCapLamports(launchConfig) : null,
      });

      if(shouldUseOnchain() && (launchMode === "spawn" || isNativeLaunchBackend())){
        if(DEBUG_WALLET_SMOKE_BEFORE_SPAWN_TX && launchMode === "spawn"){
          const smokeRes = await runWalletSmokeTest();
          if(!smokeRes?.ok && isInvalidWalletArgumentsError(smokeRes?.error)){
            await cleanupReservedSupabaseRoom(reservedSupabaseRoom);
            showToast("Wallet transport failed before spawn tx.");
            return;
          }
        }

        if(launchMode === "spawn"){
          if(useV2SpawnCreate){
            try {
              const maybeInitIxs = await buildMaybeInitializeV2GlobalStateIxs();
              const createRoomIx = await buildCreateRoomLedgerV2Ix(id, launchConfig);
              try {
                createTxSignature = await sendProgramInstructions([
                  ...maybeInitIxs,
                  createRoomIx,
                ]);
              } catch(initErr){
                if(maybeInitIxs.length > 0 && isAlreadyInitializedLikeError(initErr)){
                  createTxSignature = await sendProgramInstructions([createRoomIx]);
                } else {
                  throw initErr;
                }
              }
            } catch(e){
              console.error("[ping-debug] v2 room ledger create failed", { roomId: id, error: String(e?.message || e) });
              await cleanupReservedSupabaseRoom(reservedSupabaseRoom);
              reportTxError(e, "initialize_v2_global_state + create_room_ledger failed during create");
              return;
            }
            if(commitLamports > 0){
              try {
                const creatorFeeIx = buildPingFeeTransferInstruction(creatorFeeMath.feeLamports);
                const depositIx = await buildPingDepositSharedV2Ix(id, createDepositTotalLamports);
                const instructions = [
                  ...(creatorFeeIx ? [creatorFeeIx] : []),
                  depositIx,
                ];
                creatorFeeTransferSignature = await sendProgramInstructions(instructions, {
                  feeRecipient: PINGY_FEE_RECIPIENT,
                  expectedWalletOutflowLamports: creatorTotalSpendLamports,
                  committedLamports: commitLamports,
                  depositBackingLamports: 0,
                  expectedDepositInstructionLamports: commitLamports,
                  feeLamports: creatorFeeMath.feeLamports,
                  bootstrapCostLamports: 0,
                });
              } catch(e){
                console.error("[ping-debug] v2 creator deposit failed after room create", { roomId: id, commitLamports, error: String(e?.message || e) });
                creatorInitialCommitLamports = 0;
                creatorEscrowContributionLamports = 0;
                showToast("Room created. Creator ping was not submitted.");
              }
            }
          } else {
          const launchBackend = PINGY_LAUNCH_BACKEND;
          const usePumpfunMinimalPrespawnPath = isPumpfunLaunchBackend();
          const includeLegacyNativeAssets = !usePumpfunMinimalPrespawnPath;
          console.log("[ping-debug] spawn init mode", {
            roomId: id,
            launchBackend,
            launchMode: launchConfig.launchMode,
            path: usePumpfunMinimalPrespawnPath ? "pumpfun-minimal-prespawn" : "native-legacy-init",
            included: ["initialize_thread_core", ...(includeLegacyNativeAssets ? ["initialize_thread_assets"] : []), ...(commitLamports > 0 ? ["ping_deposit"] : [])],
            excluded: includeLegacyNativeAssets ? [] : ["initialize_thread_assets (legacy native curve path retained for future reactivation; inactive for Pump.fun spawn flow)"],
          });
          try {
            const createPath = commitLamports > 0 ? "combined-init+deposit" : "init-only";
            console.log("[ping-debug] spawn funding branch entered", {
              roomId: id,
              committedLamports: commitLamports,
              createDepositTotalLamports,
              shouldFund: commitLamports > 0,
              launchBackend: PINGY_LAUNCH_BACKEND,
            });
            console.log("[ping-debug] create flow", {
              launchMode: launchConfig.launchMode,
              committedLamports: commitLamports,
              createDepositTotalLamports,
              path: createPath,
            });
            if(commitLamports > 0){
              const creatorFeeIx = buildPingFeeTransferInstruction(creatorFeeMath.feeLamports);
              console.log("[ping-debug] before Phantom funding tx", { roomId: id, commitLamports, createDepositTotalLamports, hasCreatorFeeInstruction: !!creatorFeeIx });
              const depositBundle = await pingWithOptionalThreadInitTx(id, createDepositTotalLamports, true, launchConfig, {
                includeLegacyNativeAssets,
              });
              const instructions = [
                ...(creatorFeeIx ? [creatorFeeIx] : []),
                ...(depositBundle.instructions || []),
              ];
              createTxSignature = await sendProgramInstructions(instructions, {
                feeRecipient: PINGY_FEE_RECIPIENT,
                expectedWalletOutflowLamports: creatorTotalSpendLamports,
                committedLamports: commitLamports,
                depositBackingLamports: creatorDepositBackingLamports,
                expectedDepositInstructionLamports: commitLamports,
                feeLamports: creatorFeeMath.feeLamports,
                bootstrapCostLamports: creatorFeeMath.bootstrapCostLamports,
              });
              creatorFeeTransferSignature = creatorFeeIx ? createTxSignature : "";
              if(creatorFeeIx){
                console.log("[ping-debug] creator fee transfer", {
                  roomId: id,
                  wallet: connectedWallet,
                  creatorTotalSpendLamports,
                  bootstrapCostLamports: creatorFeeMath.bootstrapCostLamports,
                  grossPositionInputLamports: creatorFeeMath.grossPositionInputLamports,
                  feeLamports: creatorFeeMath.feeLamports,
                  committedTargetLamports: commitLamports,
                  depositBackingLamports: creatorDepositBackingLamports,
                  escrowContributionLamports: creatorEscrowContributionLamports,
                  expectedWalletOutflowLamports: creatorTotalSpendLamports,
                  expectedDepositInstructionLamports: commitLamports,
                  transferSignature: creatorFeeTransferSignature,
                });
              }
              console.log("[ping-debug] funding tx success", { roomId: id, commitLamports, createDepositTotalLamports, creatorFeeTransferSignature });
            } else {
              createTxSignature = await initializeThreadTx(id, launchConfig, { includeLegacyNativeAssets });
            }
          } catch(e){
            console.error("[ping-debug] funding tx failed", { roomId: id, commitLamports, error: String(e?.message || e) });
            await cleanupReservedSupabaseRoom(reservedSupabaseRoom);
            if(isWalletTxRejected(e)) showToast("Create cancelled — no coin or commit was submitted.");
            else if(commitLamports > 0) reportTxError(e, includeLegacyNativeAssets ? "initialize_thread_core + initialize_thread_assets + ping_deposit failed during create" : "initialize_thread_core + ping_deposit failed during create");
            else reportTxError(e, includeLegacyNativeAssets ? "initialize_thread_core + initialize_thread_assets failed during create" : "initialize_thread_core failed during create");
            return;
          }
          }
        } else {
          try {
            console.log("[ping-debug] create flow", {
              launchMode: launchConfig.launchMode,
              committedLamports: commitLamports,
              path: "instant",
            });
            await initializeThreadTx(id, launchConfig);
            if(launchMode === "instant" && commitLamports > 0){
              await buyTx(id, commitLamports);
            }
          } catch (e){
            await cleanupReservedSupabaseRoom(reservedSupabaseRoom);
            if(launchMode === "instant" && commitLamports > 0){
              reportTxError(e, "initialize_thread_core + initialize_thread_assets + instant buy transaction failed");
            } else {
              reportTxError(e, "initialize_thread_core + initialize_thread_assets transaction failed");
            }
            return;
          }
        }
      }

	      const r = mkRoom(id, name, ticker, desc, launchConfig, connectedWallet);
	      const creatorWallet = String(connectedWallet || "").trim();
      if(!creatorWallet){
        await cleanupReservedSupabaseRoom(reservedSupabaseRoom);
        showToast("connect wallet first.");
        return;
      }
	      normalizeLaunchRoom(r, { launchMode, creatorCommitSol: creatorInitialCommitLamports / LAMPORTS_PER_SOL });
	      if(useV2SpawnCreate) markRoomAsV2SharedVault(r);
	      if(reservedSupabaseRoom?.row) applyPersistedRoomMetadata(r, reservedSupabaseRoom.row);
	      const creatorAppliedFeeLamports = creatorInitialCommitLamports > 0 ? creatorFeeMath.feeLamports : 0;
	      const creatorAppliedInputLamports = creatorInitialCommitLamports > 0 ? creatorTotalSpendLamports : 0;
	      r.creator_ping_fee_lamports = creatorAppliedFeeLamports;
	      r.creator_ping_fee_sol = creatorAppliedFeeLamports / LAMPORTS_PER_SOL;
	      r.creator_ping_input_lamports = creatorAppliedInputLamports;
	      r.creator_committed_target_lamports = creatorInitialCommitLamports;
	      r.creator_escrow_contribution_lamports = creatorEscrowContributionLamports;
      setWalletDepositBackingLamports(r, creatorWallet, creatorDepositBackingLamports);
      r.approval = { [creatorWallet]: "approved" };
	      r.approverWallets = r.approverWallets || {};
	      r.blockedWallets = r.blockedWallets || {};
	      r.approverWallets[creatorWallet] = true;
	      if(useV2SpawnCreate && creatorInitialCommitLamports > 0){
	        r.positions[creatorWallet] = {
	          ...(r.positions[creatorWallet] || {}),
	          committed_sol: creatorInitialCommitLamports / LAMPORTS_PER_SOL,
	          escrow_sol: creatorInitialCommitLamports / LAMPORTS_PER_SOL,
	        };
	      }
	      r.socials = { x: xUrl, tg: tgUrl, web: webUrl };
      if(newImgData) r.image = newImgData;
      if(newBannerData) r.banner = newBannerData;
      if(typeof r.is_test !== "boolean") r.is_test = DEV_SIMULATION;
      if(launchMode === "instant" && isNativeLaunchBackend()){
        r.token_address = mockTokenAddress(r.ticker || r.name || "PINGY");
        if(!shouldUseOnchain() && commit > 0){
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
      if(DEBUG_EXTERNAL_STATUS){
        console.log("[pingy] create room creator binding", {
          roomId: r.id,
          connectedWallet,
          roomCreatorWallet: r.creator_wallet,
          isCreator: isCreator(r, connectedWallet),
        });
      }
      let bootstrapMeta = buildRoomBootstrapCostMeta(0, {
        known: launchMode !== "spawn",
        note: launchMode === "spawn"
          ? "bootstrap cost tracking placeholder"
          : "non-spawn create path has no bootstrap setup cost tracking",
      });
      if(launchMode === "spawn" && !useV2SpawnCreate){
        const bootstrapEstimate = await estimateCreateBootstrapCostFromTx(createTxSignature, connectedWallet, { commitLamports: createDepositTotalLamports });
        bootstrapMeta = buildRoomBootstrapCostMeta(bootstrapEstimate.lamports, {
          known: false,
          note: `estimated (${bootstrapEstimate.source || "unknown"})`,
        });
      } else if(launchMode === "spawn" && useV2SpawnCreate){
        bootstrapMeta = buildRoomBootstrapCostMeta(0, {
          known: true,
          note: "v2 shared-vault create path skips legacy bootstrap reserve assumptions",
        });
      }
      applyRoomBootstrapCostMeta(r, bootstrapMeta.bootstrap_cost_lamports, {
        known: !!bootstrapMeta.bootstrap_cost_breakdown?.known,
        note: bootstrapMeta.bootstrap_cost_breakdown?.note,
        lock: true,
      });
      console.log("[ping-debug] create bootstrap tracking", {
        roomId: r.id,
        launchMode,
        committedLamports: commitLamports,
        bootstrapCostLamports: r.bootstrap_cost_lamports,
        bootstrapCostSol: r.bootstrap_cost_sol,
        bootstrapLocked: r.bootstrap_locked === true,
        bootstrapIsEstimated: !r.bootstrap_cost_breakdown?.known,
        bootstrapTrackingNote: r.bootstrap_cost_breakdown?.note || "",
      });
      logRoomAccounting(r);
      state.rooms.unshift(r);
      state.chat[id] = [{ ts:"—", wallet:"SYSTEM", text: launchMode === "instant" ? "coin created. ready for external launch." : "coin created. waiting for spawn." }];

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

      setHomeTab("explore");
      renderHome();
      openRoom(id);

      if(shouldUseOnchain() && launchMode === "spawn"){
        await fetchRoomOnchainSnapshot(id);
        await refreshConnectedWalletEscrowLine(id);
        await fetchConnectedWalletDepositSnapshot();
        const createdRoom = roomById(id);
        if(createdRoom){
          console.log("[ping-debug] room escrow snapshot after spawn funding", {
            roomId: id,
            snapshot: readRoomEscrowSnapshot(createdRoom),
          });
        }
        if(activeRoomId === id) renderRoom(id);
      }
    }
    $("createCoinBtn").addEventListener("click", createCoinFromForm);

    let lastPresetBeforeCustom = "fast";

    $("newCommit")?.addEventListener("input", updateCreateCommitFeePreview);
    $("newCommitMaxBtn")?.addEventListener("click", setCreatorCommitMax);

    if($("newLaunchMode")){
      $("newLaunchMode").addEventListener("change", () => {
        updateCreateLaunchModeUI();
        updateCreateCommitFeePreview();
      });
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
        updateCreateCommitFeePreview();
      });

      ["customMinWallets", "customSpawnTargetSol", "customMaxWalletSharePct"].forEach((id) => {
        const el = $(id);
        if(!el) return;
        el.addEventListener("input", () => {
          updatePresetCapHint();
          updateCreateCommitFeePreview();
        });
      });
    }

    if($("newPreset")) $("newPreset").value = "fast";
    if($("newLaunchMode")) $("newLaunchMode").value = "spawn";
    updateCreateLaunchModeUI();
    updateCreateCommitFeePreview();

    // NOTE: v22 UI removed "newRoomBtn" on explore; keep handler optional
    const newRoomBtn = $("newRoomBtn");
    if(newRoomBtn){
      newRoomBtn.addEventListener("click", () => {
        if(!connectedWallet) return showToast("connect wallet first.");
        setHomeTab("spawn");
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

    const DEFAULT_PROFILE_AVATAR = "./assets/IMG_1566.png";

    function appendAvatarImage(target, src){
      if(!target || !src) return false;
      const im = document.createElement("img");
      im.src = src;
      im.alt = "";
      target.appendChild(im);
      return true;
    }

    function renderProfileAvatar(wallet, dataUrl){
      const avatar = $("profileAvatar");
      avatar.innerHTML = "";
      if(appendAvatarImage(avatar, dataUrl || DEFAULT_PROFILE_AVATAR)) return;
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
        escrowsHeader.textContent = isNativeLaunchBackend() ? "Pingy escrows" : "Pingy launch vaults";
        sections.appendChild(escrowsHeader);

        const deposits = Object.values(snapshot.depositsByThread || {});
        if(!deposits.length){
          const none = document.createElement("div");
          none.className = "muted tiny";
          none.textContent = isNativeLaunchBackend() ? "no escrow positions" : "no launch contributions";
          sections.appendChild(none);
        } else {
          deposits.forEach((deposit) => {
            const room = roomById(deposit.threadId);
            const row = document.createElement("div");
            row.className = "btn subtle profileTabRow";
            const left = document.createElement("span");
            const contributionLabel = isNativeLaunchBackend() ? profileBalanceStatusLabel(deposit.status) : `launch contribution • ${profileBalanceStatusLabel(deposit.status)}`;
            left.innerHTML = `${escapeText(room ? `${room.name} $${room.ticker}` : deposit.threadId)} <span class="muted tiny">${escapeText(contributionLabel)} • ${Number(deposit.withdrawable_sol || 0).toFixed(4)} SOL</span>`;
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

        const spawnHeader = document.createElement("div");
        spawnHeader.className = "muted tiny";
        spawnHeader.textContent = isNativeLaunchBackend() ? "Spawn allocations" : "Launch allocations";
        sections.appendChild(spawnHeader);

        const spawnAllocations = getWalletSpawnAllocations(wallet, snapshot);
        if(!spawnAllocations.length){
          const none = document.createElement("div");
          none.className = "muted tiny";
          none.textContent = isNativeLaunchBackend() ? "no spawn allocations" : "no launch allocations";
          sections.appendChild(none);
        } else {
          spawnAllocations.forEach((allocationRow) => {
            const row = document.createElement("div");
            row.className = "btn subtle profileTabRow";
            const left = document.createElement("div");
            left.style.display = "flex";
            left.style.flexDirection = "column";
            left.style.gap = "2px";
            const line1 = document.createElement("span");
            line1.innerHTML = `${escapeText(allocationRow.roomName)} <span class="muted">$${escapeText(allocationRow.roomTicker)}</span>`;
            const line2 = document.createElement("span");
            line2.className = "muted tiny";
            line2.textContent = `${Math.round(allocationRow.claimable).toLocaleString()} claimable • ${Math.round(allocationRow.claimed).toLocaleString()} claimed`;
            left.appendChild(line1);
            left.appendChild(line2);
            row.appendChild(left);

            if(allocationRow.claimable > 0){
              const right = document.createElement("span");
              right.style.display = "inline-flex";
              right.style.gap = "6px";
              const openBtn = document.createElement("button");
              openBtn.className = "btn subtle small";
              openBtn.type = "button";
              openBtn.textContent = "open room";
              openBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                navigateHash("room/" + encodeURIComponent(allocationRow.roomId));
              });
              right.appendChild(openBtn);
              row.appendChild(right);
            }

            sections.appendChild(row);
          });
        }

        const tokens = snapshot.tokenBalances || [];
        const pingyTokens = tokens.filter((token) => !!token.roomId);
        const otherTokens = tokens.filter((token) => !token.roomId);

        const pingyHeader = document.createElement("div");
        pingyHeader.className = "muted tiny";
        pingyHeader.textContent = "Pingy tokens";
        sections.appendChild(pingyHeader);

        if(!pingyTokens.length){
          const none = document.createElement("div");
          none.className = "muted tiny";
          none.textContent = "no Pingy tokens";
          sections.appendChild(none);
        } else {
          pingyTokens.forEach((token) => {
            const room = roomById(token.roomId);
            const row = document.createElement("div");
            row.className = "btn subtle profileTabRow";
            const left = document.createElement("span");
            left.innerHTML = `${escapeText(room ? `${room.name} $${room.ticker}` : shortWallet(token.mint))} <span class="muted tiny">${Number(token.amount || 0).toLocaleString()}</span>`;
            row.appendChild(left);
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
            sections.appendChild(row);
          });
        }

        const otherHeader = document.createElement("div");
        otherHeader.className = "muted tiny";
        otherHeader.textContent = "Other SPL tokens";
        sections.appendChild(otherHeader);

        if(!otherTokens.length){
          const none = document.createElement("div");
          none.className = "muted tiny";
          none.textContent = "no other SPL tokens";
          sections.appendChild(none);
        } else {
          const maxVisible = 5;
          let expanded = false;
          const wrapper = document.createElement("div");
          const toggleBtn = document.createElement("button");
          toggleBtn.className = "btn subtle small";
          toggleBtn.type = "button";
          const renderOther = () => {
            wrapper.innerHTML = "";
            const visible = expanded ? otherTokens : otherTokens.slice(0, maxVisible);
            visible.forEach((token) => {
              const row = document.createElement("div");
              row.className = "btn subtle profileTabRow";
              row.innerHTML = `<span>${escapeText(shortWallet(token.mint))} <span class="muted tiny">${Number(token.amount || 0).toLocaleString()}</span></span>`;
              wrapper.appendChild(row);
            });
            if(otherTokens.length > maxVisible){
              toggleBtn.textContent = expanded
                ? "other wallet tokens ▾"
                : `other wallet tokens ▸ (${otherTokens.length})`;
            }
          };
          if(otherTokens.length > maxVisible){
            toggleBtn.addEventListener("click", () => {
              expanded = !expanded;
              renderOther();
            });
            sections.appendChild(toggleBtn);
          }
          renderOther();
          sections.appendChild(wrapper);
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

    function renderChatRoom(roomId, { skipRoomRender = false } = {}){
      const r = roomById(roomId);
      if(!r) return;
      if(!skipRoomRender) renderRoom(roomId);
      const chatRoomTitle = $("chatRoomTitle");
      const chatRoomMeta = $("chatRoomMeta");
      const chatRoomCoinAvatar = $("chatRoomCoinAvatar");
      const snapshot = readRoomEscrowSnapshot(r);
      const approvedCount = Number(r?.onchain?.approved_count || snapshot.approvedWallets?.length || 0);
      const pendingCount = Number(snapshot?.pendingWallets?.length || 0);
      const memberCount = Math.max(approvedCount + pendingCount, 1);
      if(chatRoomTitle) chatRoomTitle.textContent = `${r.name}  $${r.ticker}`;
      if(chatRoomMeta) chatRoomMeta.textContent = `${memberCount} member${memberCount === 1 ? "" : "s"}`;
      if(chatRoomCoinAvatar){
        if(r.image){
          chatRoomCoinAvatar.innerHTML = `<img src="${r.image}" alt="" />`;
        } else {
          chatRoomCoinAvatar.innerHTML = `<img src="${DEFAULT_PROFILE_AVATAR}" alt="" />`;
        }
      }
    }

    function openChatRoom(roomId){
      activeRoomId = roomId;
      state.activePingThreadId = roomId;
      setView("chat");
      renderChatRoom(roomId);
      if(!(state.devSim.active && state.devSim.roomId === roomId)){
        refreshRoomOnchainSnapshot(roomId, { force: true }).then(() => {
          if(activeRoomId === roomId && chatView?.classList.contains("on")) renderChatRoom(roomId);
        });
      }
      const h = "#/chat/" + encodeURIComponent(roomId);
      if(location.hash !== h) history.replaceState(null,"",h);
    }

    function formatChatTimestampLabel(rawTs){
      const raw = String(rawTs || "").trim();
      const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
      if(!match) return raw || "—";
      const hours24 = Number(match[4] || 0);
      const minutes = match[5] || "00";
      const hours12 = ((hours24 + 11) % 12) + 1;
      const suffix = hours24 >= 12 ? "PM" : "AM";
      return `${hours12}:${minutes} ${suffix}`;
    }

    function renderWalletAvatar(target, wallet, { clickable = false } = {}){
      if(!target) return;
      const details = getProfileDetails(wallet);
      target.innerHTML = "";
      if(!appendAvatarImage(target, details.image || DEFAULT_PROFILE_AVATAR)){
        target.textContent = shortWallet(wallet || "wallet").slice(0, 1).toUpperCase();
      }
      if(clickable && wallet){
        target.title = displayName(wallet);
        target.addEventListener("click", () => openProfile(wallet));
      }
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
      const snapshot = r ? readRoomEscrowSnapshot(r) : null;
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
      if(!box) return;
      const prevScrollTop = box.scrollTop;
      const prevScrollHeight = box.scrollHeight;
      const prevClientHeight = box.clientHeight;
      const wasNearBottom = (prevScrollHeight - (prevScrollTop + prevClientHeight)) <= 32;
      box.innerHTML = "";
      const msgs = state.chat[roomId] || [];
      const r = roomById(roomId);

      const isApprovalSystemMessage = (m) => (
        !!m
        && m.wallet === "SYSTEM"
        && m.kind === "system_approval"
        && !!m.approvedWallet
      );
      const isVisibleSystemMessage = (m) => {
        if(!m || m.wallet !== "SYSTEM") return false;
        if(isApprovalSystemMessage(m)) return true;
        const text = String(m.text || "").trim();
        if(!text) return false;
        if(m.kind === "system_activity" && /submitted a (buy|sell) tx on-chain/i.test(text)) return false;
        return true;
      };
      const isTradeActivityText = (text) => {
        const t = String(text || "");
        if(!t) return false;
        if(/^bought .* tokens for .* SOL gross/i.test(t)) return true;
        if(/^sold .* tokens for .* SOL gross/i.test(t)) return true;
        if(/^withdrew .* SOL \(full (escrow|launch contribution) withdrawal, returned to wallet\)\.?$/i.test(t)) return true;
        return false;
      };
      const isMainChatMessage = (m) => {
        if(!m) return false;
        if(m.wallet === "SYSTEM") return isVisibleSystemMessage(m);
        if(m.kind === "activity") return false;
        if(isTradeActivityText(m.text)) return false;
        return true;
      };

      const visibleMsgs = msgs.filter(isMainChatMessage);
      if(!visibleMsgs.length){
        const empty = document.createElement("div");
        empty.className = "muted tiny";
        empty.textContent = "No chat yet. Start the thread here.";
        box.appendChild(empty);
      }

      visibleMsgs.forEach((m) => {
        const row = document.createElement("div");
        const isSys = (m.wallet === "SYSTEM");
        const isMine = !isSys && connectedWallet && getNormalizedWallet(m.wallet) === getNormalizedWallet(connectedWallet);
        row.className = `msg${isSys ? " systemMsg" : ""}${isMine ? " mine" : ""}`;
        const nm = isSys ? "system" : displayName(m.wallet);
        const nameHtml = isSys ? `<strong>${escapeText(nm)}</strong>` : escapeText(nm);
        const timeLabel = formatChatTimestampLabel(m.ts);

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
          ${isSys || isMine ? "" : `<button class="msgAvatar" type="button" title="open profile"></button>`}
          <div class="msgBubbleWrap">
            <div class="msgBubble ${isSys ? "systemBubble" : ""} ${isMine ? "mine" : ""}">
              <div class="who">
                <div class="whoTop">
                  ${isSys ? "" : `<button class="copyBtn" title="copy wallet">⧉</button>`}
                  <span class="whoName">${nameHtml}</span>
                </div>
              </div>
              <div class="text ${isSys ? "sysLine" : ""} ${systemClass}">${escapeText(m.text)}</div>
              <div class="msgContextLine">
                <div class="msgRoleChips">${extras}</div>
                <div class="ts">${escapeText(timeLabel)}</div>
              </div>
            </div>
          </div>
        `;

        if(!isSys){
          renderWalletAvatar(row.querySelector(".msgAvatar"), m.wallet, { clickable: true });
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
          row.querySelector(".copyBtn").addEventListener("click", () => copyToClipboard(m.wallet));
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

        box.appendChild(row);
      });

      if(wasNearBottom){
        box.scrollTop = box.scrollHeight;
      } else {
        const scrollDelta = box.scrollHeight - prevScrollHeight;
        box.scrollTop = Math.max(0, prevScrollTop + scrollDelta);
      }
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
      $("msgInput").placeholder = denied ? (isNativeLaunchBackend() ? "Denied from this spawn. Your SOL remains in escrow until you unping." : "Denied from this spawn. Your committed SOL stays in the launch vault until you unping.") : (enabled ? "message" : "connect wallet");
    }

    function autoSizeComposer(){
      const input = $("msgInput");
      if(!input) return;
      const computed = window.getComputedStyle(input);
      const lineHeight = parseFloat(computed.lineHeight) || 16;
      const paddingTop = parseFloat(computed.paddingTop) || 0;
      const paddingBottom = parseFloat(computed.paddingBottom) || 0;
      const borderTop = parseFloat(computed.borderTopWidth) || 0;
      const borderBottom = parseFloat(computed.borderBottomWidth) || 0;
      const minHeight = Math.ceil(lineHeight + paddingTop + paddingBottom + borderTop + borderBottom);
      const maxHeight = Math.ceil((lineHeight * 6) + paddingTop + paddingBottom + borderTop + borderBottom);
      input.style.height = `${minHeight}px`;
      const nextHeight = Math.max(minHeight, Math.min(input.scrollHeight, maxHeight));
      input.style.height = `${nextHeight}px`;
      input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
    }

    function resetComposer(){
      const input = $("msgInput");
      if(!input) return;
      input.value = "";
      autoSizeComposer();
    }


	    async function approveWallet(roomId, wallet){
      if(!onchainEnabled) return showToast("On-chain disabled: PROGRAM_ID misconfigured");
      const r = roomById(roomId);
      if(!r || !wallet) return;
	      if(!isApprover(r, connectedWallet)) return;
	      if(!isPending(r, wallet)) return;
	      try{
	        if(isV2Room(r)) await approveReceiptV2Tx(roomId, wallet);
	        else await approveUserTx(roomId, wallet);
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
      addSystemEvent(roomId, `@${shortWallet(wallet)} denied from pending. ${isNativeLaunchBackend() ? "Denied from this spawn. Your SOL remains in escrow until you unping." : "Denied from this spawn. Your committed SOL stays in the launch vault until you unping."}`);
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
	        if(isV2Room(r)) await revokeReceiptV2Tx(roomId, wallet);
	        else await revokeApprovedUserTx(roomId, wallet);
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
      maybeAutoRefreshRoomExternalStatus(r);

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

      const snapshot = readRoomEscrowSnapshot(r);
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

      syncLaunchTrustPanel(roomId);

      const launchTrustLines = $("launchTrustLines");
      if(launchTrustLines){
        const launchTypeLabel = roomLaunchMode(r) === "instant" ? "Instant" : "Spawn";
        const approvedCountRaw = Number(r?.onchain?.approved_count);
        const approvedCount = Number.isFinite(approvedCountRaw) && approvedCountRaw >= 0
          ? approvedCountRaw
          : Number((snapshot.approvedWallets || []).length || 0);
        const requiredWalletsRaw = Number(minApprovedWalletsRequired(r));
        const requiredWallets = Number.isFinite(requiredWalletsRaw) && requiredWalletsRaw > 0 ? requiredWalletsRaw : null;
        const maxWalletSharePctRaw = Number(roomMaxWalletShareBps(r));
        const maxWalletSharePct = Number.isFinite(maxWalletSharePctRaw) && maxWalletSharePctRaw > 0
          ? (maxWalletSharePctRaw / 100).toFixed(1)
          : null;
        const creatorCommit = Number(creatorCommitSol(r));
        const creatorCommitLine = creatorCommit > 0 ? `${creatorCommit.toFixed(3)} SOL` : "—";
        const creatorLabel = isPumpfunRoom(r) ? "Creator buy" : "Creator commit";
        const approverCount = Number((approvers || []).length || 0);

        const lines = [];
        if(requiredWallets !== null) lines.push(`<div>Approved wallets: ${approvedCount} / ${requiredWallets}</div>`);
        else lines.push(`<div>Approved wallets: ${approvedCount} / —</div>`);
        if(maxWalletSharePct !== null){
          const shareLabel = (r.state === "BONDING" || r.state === "BONDED") && !isPumpfunRoom(r)
            ? "Max wallet share (formation)"
            : "Max wallet share";
          lines.push(`<div>${shareLabel}: ${maxWalletSharePct}%</div>`);
        } else {
          lines.push(`<div>Max wallet share: —</div>`);
        }
        lines.push(`<div>${creatorLabel}: ${creatorCommitLine}</div>`);
        lines.push(`<div>Approver count: ${approverCount > 0 ? approverCount : "—"}</div>`);
        lines.push(`<div>Launch type: ${launchTypeLabel}</div>`);
        lines.push(`<div>Launch backend: ${isPumpfunRoom(r) ? "Pump.fun" : "Native"}</div>`);
        const launchStatus = getRoomLaunchStatus(r);
        const externalLaunch = getRoomExternalLaunchRecord(r);
        const submittedLabel = formatLaunchTimestamp(externalLaunch?.submitted_at);
        const liveLabel = formatLaunchTimestamp(externalLaunch?.live_at);
        lines.push(`<div>Launch status: ${isPumpfunRoom(r) ? getDisplayedRoomPhaseLabel(r) : launchStatusLabel(r)}</div>`);
        if(isPumpfunRoom(r) && (launchStatus === "submitted" || launchStatus === "live")){
          if(submittedLabel) lines.push(`<div>Submitted: ${escapeText(submittedLabel)}</div>`);
        }
        if(isPumpfunRoom(r) && launchStatus === "live" && liveLabel) lines.push(`<div>Live: ${escapeText(liveLabel)}</div>`);
        const externalUrl = getRoomExternalLaunchUrl(r).trim();
        if(externalUrl) lines.push(`<div>External launch: <a href="${escapeText(externalUrl)}" target="_blank" rel="noopener noreferrer">${escapeText(externalUrl)}</a></div>`);
        const externalMint = getRoomExternalMint(r).trim();
        if(externalMint) lines.push(`<div>External mint: ${escapeText(externalMint)}</div>`);
        if(isPumpfunRoom(r)){
          const currentWallet = getNormalizedWallet(connectedWallet);
          lines.push(`<div>Current wallet: ${currentWallet ? escapeText(shortWallet(currentWallet)) : "—"}</div>`);
          lines.push(`<div>Creator match: ${isCreator(r, currentWallet) ? "yes" : "no"}</div>`);
          lines.push(`<div>Can launch now: ${canCurrentWalletLaunchExternally(r) ? "yes" : "no"}</div>`);
          lines.push(`<div>Backend mode: ${escapeText(getPumpfunBackendModeLabel())}</div>`);
          lines.push(`<div>Distribution: ${escapeText(getRoomExternalDistributionStatusLabel(r))}</div>`);
          if(isRoomStatusRefreshing(r)) lines.push("<div>Refreshing: yes</div>");
          const settlementStatus = String(r?.external_settlement_status || "").trim();
          if(settlementStatus) lines.push(`<div>Settlement status: ${escapeText(settlementStatus)}</div>`);
          const settledLabel = formatLaunchTimestamp(r?.external_settled_at);
          if(settledLabel) lines.push(`<div>Settled: ${escapeText(settledLabel)}</div>`);
          if(hasFrozenDistributionSnapshot(r)){
            lines.push(`<div>Distribution snapshot: frozen</div>`);
            lines.push(`<div>Snapshot recipients: ${Number(r.distribution_snapshot_total_recipients || getRoomPlannedDistributionRecipientCount(r) || 0).toLocaleString()}</div>`);
            const lockedLabel = formatLaunchTimestamp(r.distribution_snapshot_locked_at);
            if(lockedLabel) lines.push(`<div>Snapshot locked: ${escapeText(lockedLabel)}</div>`);
          }
          const vaultNetSol = Number(r.launch_vault_net_sol || 0);
          if(vaultNetSol > 0) lines.push(`<div>Launch vault net: ${vaultNetSol.toFixed(3)} SOL</div>`);
          const launchReadyButMissingEndpoint = !DEV_SIMULATION
            && getRoomLaunchStatus(r) === "draft"
            && validatePumpfunLaunchReadiness(r).ok
            && !hasPumpfunLaunchEndpoint();
          const refreshReadyButMissingEndpoint = !DEV_SIMULATION
            && canRefreshRoomExternalStatus(r)
            && !hasPumpfunStatusEndpoint();
          const settleReadyButMissingEndpoint = !DEV_SIMULATION
            && validatePumpfunSettlementReadiness(r).ok
            && !hasPumpfunSettlementEndpoint();
          if(launchReadyButMissingEndpoint) lines.push("<div>Launch endpoint: missing</div>");
          if(refreshReadyButMissingEndpoint) lines.push("<div>Status endpoint: missing</div>");
          if(settleReadyButMissingEndpoint) lines.push("<div>Settlement endpoint: missing</div>");
        }
        launchTrustLines.innerHTML = lines.join("");
      }

      const externalLaunchPanel = $("externalLaunchPanel");
      const externalLaunchSummary = $("externalLaunchSummary");
      if(externalLaunchPanel && externalLaunchSummary){
        const summary = getDisplayedExternalLaunchSummary(r);
        const showExternalLaunchPanel = isPumpfunRoom(r) && !!summary;
        externalLaunchPanel.style.display = showExternalLaunchPanel ? "block" : "none";
        if(showExternalLaunchPanel) externalLaunchSummary.textContent = summary;
      }

      const externalDebugPanel = $("externalDebugPanel");
      const externalDebugSummary = $("externalDebugSummary");
      if(externalDebugPanel && externalDebugSummary){
        const debugInfo = getRoomExternalDebug(r);
        const showExternalDebugPanel = isPumpfunRoom(r) && (DEV_SIMULATION || DEBUG_EXTERNAL_STATUS || !!debugInfo);
        externalDebugPanel.style.display = showExternalDebugPanel ? "block" : "none";
        if(showExternalDebugPanel){
          const updatedLabel = debugInfo?.updated_at ? formatLaunchTimestamp(debugInfo.updated_at) : "—";
          const lines = [
            `Last action: ${debugInfo?.last_action ? String(debugInfo.last_action) : "—"}`,
            `Request mode: ${debugInfo?.last_request_kind ? String(debugInfo.last_request_kind) : "—"}`,
            `Response: ${debugInfo?.last_response_kind ? String(debugInfo.last_response_kind) : "—"}`,
            `HTTP status: ${debugInfo?.last_http_status ?? "—"}`,
            `Error: ${debugInfo?.last_error ? String(debugInfo.last_error) : "—"}`,
            `Updated: ${updatedLabel || "—"}`,
          ];
          const launchReadyButMissingEndpoint = !DEV_SIMULATION
            && getRoomLaunchStatus(r) === "draft"
            && validatePumpfunLaunchReadiness(r).ok
            && !hasPumpfunLaunchEndpoint();
          const refreshReadyButMissingEndpoint = !DEV_SIMULATION
            && canRefreshRoomExternalStatus(r)
            && !hasPumpfunStatusEndpoint();
          const settleReadyButMissingEndpoint = !DEV_SIMULATION
            && validatePumpfunSettlementReadiness(r).ok
            && !hasPumpfunSettlementEndpoint();
          if(launchReadyButMissingEndpoint) lines.push("Launch endpoint: missing");
          if(refreshReadyButMissingEndpoint) lines.push("Status endpoint: missing");
          if(settleReadyButMissingEndpoint) lines.push("Settlement endpoint: missing");
          externalDebugSummary.innerHTML = lines.map((line) => `<div>${escapeText(line)}</div>`).join("");
        }
      }

      const distributionPanel = $("distributionPanel");
      const distributionSummary = $("distributionSummary");
      const distributionReceiptsPreview = $("distributionReceiptsPreview");
      if(distributionPanel && distributionSummary){
        const showDistributionPanel = isPumpfunRoom(r) && getRoomLaunchStatus(r) !== "draft";
        distributionPanel.style.display = showDistributionPanel ? "block" : "none";
        if(showDistributionPanel){
          snapshotRoomExternalDistributionPlan(r);
          const receiptRows = getRoomDistributionReceiptsRows(r);
          const lines = [
            `Mode: ${String(r.external_distribution_mode || "pro_rata").replaceAll("_", " ")}`,
            `Recipients: ${Number(r.external_distribution_total_recipients || 0).toLocaleString()}`,
            `Tokens received: ${toSafeExternalTokenAmount(r.external_tokens_received, 0).toLocaleString()}`,
            `Tokens planned: ${toSafeExternalTokenAmount(r.external_distribution_total_tokens_planned, 0).toLocaleString()}`,
            `Tokens sent: ${toSafeExternalTokenAmount(r.external_distribution_total_tokens_sent, 0).toLocaleString()}`,
            `Completed recipients: ${getRoomDistributionCompletedRecipientCount(r).toLocaleString()}`,
            `Partial recipients: ${getRoomDistributionPartialRecipientCount(r).toLocaleString()}`,
            `Pending recipients: ${getRoomDistributionPendingRecipientCount(r).toLocaleString()}`,
            `Status: ${getRoomExternalDistributionStatusLabel(r)}`,
            `Snapshot: ${hasFrozenDistributionSnapshot(r) ? "frozen" : "live preview"}`,
          ];
          if(isRoomSettlementSubmitting(r)) lines.push("Settlement submitting: yes");
          if(isRoomStatusRefreshing(r)) lines.push("Refreshing: yes");
          if(String(r?.external_settlement_status || "").trim()) lines.push(`Settlement status: ${String(r.external_settlement_status).trim()}`);
          const v2Settlement = getV2ExternalSettlementProgress(r);
          if(v2Settlement){
            lines.push(`Forwarded SOL: ${(v2Settlement.forwardedLamports / LAMPORTS_PER_SOL).toFixed(3)} / ${(Math.max(v2Settlement.targetLamports, 0) / LAMPORTS_PER_SOL).toFixed(3)} target`);
            lines.push(`External units settled: ${Math.round(v2Settlement.settledUnits).toLocaleString()}`);
          }
          {
            const settledLabel = formatLaunchTimestamp(r?.external_settled_at);
            if(settledLabel) lines.push(`Settled: ${settledLabel}`);
          }
          if(hasFrozenDistributionSnapshot(r)){
            const lockedLabel = formatLaunchTimestamp(r.distribution_snapshot_locked_at);
            if(lockedLabel) lines.push(`Locked: ${lockedLabel}`);
          }
          distributionSummary.innerHTML = lines.map((line) => `<div>${escapeText(line)}</div>`).join("");
          if(distributionReceiptsPreview){
            const previewRows = receiptRows.slice(0, 10);
            const previewLines = previewRows.map((row) => {
              const txLine = row.tx_id ? `<div class="tiny muted">tx: ${escapeText(row.tx_id)}</div>` : "";
              return `<div style="margin-top:4px;"><div>${escapeText(displayName(row.wallet))} · planned ${toSafeExternalTokenAmount(row.planned_tokens, 0).toLocaleString()} · sent ${toSafeExternalTokenAmount(row.sent_tokens, 0).toLocaleString()} · ${escapeText(row.status)}</div>${txLine}</div>`;
            });
            if(receiptRows.length > 10) previewLines.push(`<div style="margin-top:4px;">+ ${(receiptRows.length - 10).toLocaleString()} more recipients</div>`);
            distributionReceiptsPreview.innerHTML = previewLines.join("");
          }
        } else if(distributionReceiptsPreview){
          distributionReceiptsPreview.innerHTML = "";
        }
      }

      const openPumpfunBtn = $("openPumpfunBtn");
      if(openPumpfunBtn){
        const hasExternalUrl = getRoomExternalLaunchUrl(r).trim().length > 0;
        const showOpenButton = isPumpfunRoom(r) && hasExternalUrl;
        openPumpfunBtn.style.display = showOpenButton ? "inline-block" : "none";
      }
      const refreshExternalStatusBtn = $("refreshExternalStatusBtn");
      if(refreshExternalStatusBtn){
        const launchStatus = getRoomLaunchStatus(r);
        const canRefresh = canRefreshRoomExternalStatus(r) && isCreator(r, connectedWallet);
        const endpointReady = DEV_SIMULATION || hasPumpfunStatusEndpoint();
        const refreshing = isRoomStatusRefreshing(r);
        const showRefresh = isPumpfunRoom(r) && endpointReady && (launchStatus === "submitted" || launchStatus === "live") && (refreshing || canRefresh);
        refreshExternalStatusBtn.style.display = showRefresh ? "inline-block" : "none";
        refreshExternalStatusBtn.disabled = refreshing || !canRefresh;
        refreshExternalStatusBtn.textContent = refreshing ? "refreshing…" : "refresh status";
      }
      const markLiveDevBtn = $("markLiveDevBtn");
      if(markLiveDevBtn){
        const status = getRoomLaunchStatus(r);
        const canMarkLive = canCurrentWalletMarkLiveExternally(r);
        const showMarkLive = DEV_SIMULATION && isPumpfunRoom(r) && (status === "draft" || status === "submitted") && canMarkLive;
        markLiveDevBtn.style.display = showMarkLive ? "inline-block" : "none";
        markLiveDevBtn.disabled = !canMarkLive;
      }
      const simulateDistributionSettlementDevBtn = $("simulateDistributionSettlementDevBtn");
      if(simulateDistributionSettlementDevBtn){
        const showSimulate = DEV_SIMULATION && isPumpfunRoom(r) && isRoomLaunchLive(r);
        const canSimulate = canCurrentWalletSimulateDistribution(r);
        simulateDistributionSettlementDevBtn.style.display = showSimulate ? "inline-block" : "none";
        simulateDistributionSettlementDevBtn.disabled = !canSimulate;
      }
      const pumpLaunchBtn = $("pumpLaunchBtn");
      if(pumpLaunchBtn){
        const launchStatus = getRoomLaunchStatus(r);
        const isSubmitting = isRoomLaunchSubmitting(r);
        const canLaunch = canCurrentWalletLaunchExternally(r);
        const endpointReady = DEV_SIMULATION || hasPumpfunLaunchEndpoint();
        const showLaunch = isPumpfunRoom(r) && endpointReady && launchStatus === "draft" && (isSubmitting || canLaunch);
        pumpLaunchBtn.style.display = showLaunch ? "inline-block" : "none";
        pumpLaunchBtn.disabled = !canLaunch;
        pumpLaunchBtn.textContent = isSubmitting ? "submitting…" : "launch on pump.fun";
      }
      const settleDistributionBtn = $("settleDistributionBtn");
      if(settleDistributionBtn){
        const isSubmitting = isRoomSettlementSubmitting(r);
        const canSettle = canCurrentWalletSettleDistribution(r);
        const distributionStatus = resolveRoomExternalDistributionStatus(r);
        const hasExternalMint = String(getRoomExternalMint(r) || "").trim().length > 0;
        const hasTokensReceived = toSafeExternalTokenAmount(r?.external_tokens_received, 0) > 0;
        const fullyDistributed = distributionStatus === "distributed";
        const endpointReady = DEV_SIMULATION || hasPumpfunSettlementEndpoint();
        const showSettle = isPumpfunRoom(r)
          && endpointReady
          && isRoomLaunchLive(r)
          && hasFrozenDistributionSnapshot(r)
          && hasExternalMint
          && hasTokensReceived
          && !fullyDistributed
          && (isSubmitting || canSettle);
        settleDistributionBtn.style.display = showSettle ? "inline-block" : "none";
        settleDistributionBtn.disabled = isSubmitting || !canSettle;
        settleDistributionBtn.textContent = isSubmitting ? "settling…" : "settle distribution";
      }

      const pendingList = $("pendingList");
      const pingersList = $("pingersList");
      const approversList = $("approversList");
      const isInstantLaunch = roomLaunchMode(r) === "instant";
      const pingersPanel = $("chatPingersPanel");
      if(pingersPanel) pingersPanel.style.display = isInstantLaunch ? "none" : "block";

      const makeWalletRow = (wallet, walletRow = {}, actions = []) => {
        const row = document.createElement("div");
        row.className = "row";
        row.style.marginTop = "4px";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";

        const left = document.createElement("div");
        left.className = "tiny";
        const committed = getWalletGrossCommittedSol(r, wallet, walletRow);
        left.innerHTML = "";
        const walletBtn = document.createElement("button");
        walletBtn.type = "button";
        walletBtn.className = "walletLink";
        walletBtn.textContent = displayName(wallet);
        walletBtn.addEventListener("click", () => openProfile(wallet));
        left.appendChild(walletBtn);
        left.appendChild(document.createTextNode(` • Committed ${committed.toFixed(3)} SOL`));

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
      const displayedPhaseLabel = getDisplayedRoomPhaseLabel(r);
      const displayedStatePill = getDisplayedRoomStatePill(r);

      if(r.state === "SPAWNING"){
        phaseLabel.textContent = displayedPhaseLabel;
        statePill.textContent = displayedStatePill;
        const target = spawnTargetSol(r);
        const committed = getRoomTotalCommittedSol(r);
        const progress = target > 0
          ? Math.min(committed / target, 1)
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
          const capBps = roomMaxWalletShareBps(r);
          const capPct = (capBps / 100).toFixed(1);
          const creatorCommit = creatorCommitSol(r);
          const creatorLine = creatorCommit > 0
            ? `<div>${isPumpfunRoom(r) ? "Creator buy" : "Creator commit"}: ${creatorCommit.toFixed(3)} SOL</div>`
            : "";
          progressLine.innerHTML = `
            <div>Committed SOL: ${committed.toFixed(3)} / ${target.toFixed(3)} SOL</div>
            <div>Approved wallets: ${approvedCount} / ${minApproved}</div>
            <div>Max per wallet: ${walletCapSol(r).toFixed(3)} SOL or ${capPct}%</div>
            ${creatorLine}
          `;
        }
        logRoomGrossCommitmentDebug(r);
        logRoomAccounting(r);
      } else if(r.state === "BONDING"){
        phaseLabel.textContent = displayedPhaseLabel;
        statePill.textContent = displayedStatePill;
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
        if(progressLine) progressLine.textContent = getDisplayedRoomProgressText(r);
      } else {
        phaseLabel.textContent = displayedPhaseLabel;
        statePill.textContent = displayedStatePill;
        phaseBar.style.width = "100%";
        phaseBar.style.background = "#46d36f";
        if(phaseBarWrap){
          phaseBarWrap.className = "bar";
          const sparkEl = phaseBarWrap.querySelector(".barSpark");
          if(sparkEl) sparkEl.remove();
        }
        const progressLine = $("spawnProgressLine");
        if(progressLine) progressLine.textContent = getDisplayedRoomProgressText(r);
      }

      const spawnSuccessPanel = $("spawnSuccessPanel");
      const spawnSuccessTitle = $("spawnSuccessTitle");
      const spawnSuccessText = $("spawnSuccessText");
      const spawnSuccessActions = $("spawnSuccessActions");
      const claimSpawnBtn = $("claimSpawnBtn");
      const spawnClosed = isSpawnClosed(r);
      const claimState = connectedWalletUnclaimedSpawnAllocation(r);
      if(spawnSuccessPanel){
        spawnSuccessPanel.style.display = spawnClosed ? "block" : "none";
      }
      if(spawnClosed){
        if(spawnSuccessTitle){
          if(isPumpfunRoom(r)){
            spawnSuccessTitle.textContent = getDisplayedSpawnSuccessTitle(r);
          } else {
            spawnSuccessTitle.textContent = isPumpfunPostSpawnRoom(r)
              ? "Spawn completed. Trading for launched coins is handled outside Pingy."
              : r.state === "BONDED"
                ? "This launch has completed its Pingy spawn phase."
                : "External market routing will be used after spawn.";
          }
        }
        if(spawnSuccessText){
          if(isPumpfunRoom(r)){
            spawnSuccessText.textContent = getDisplayedSpawnSuccessText(r);
          } else if(isPumpfunPostSpawnRoom(r) || r.state === "BONDED"){
            spawnSuccessText.textContent = "Trading for launched coins is handled outside Pingy.";
          } else {
            spawnSuccessText.textContent = claimState.hasClaimable
              ? `You have ${Math.round(claimState.claimableTokens).toLocaleString()} spawn tokens ready to claim.`
              : "Spawn completed. If you participated in the spawn, you may have tokens to claim.";
            if(!connectedWallet){
              spawnSuccessText.textContent =
                "Spawn successful. Connect wallet to check claimable spawn tokens.";
            }
          }
        }
        if(spawnSuccessActions){
          const canClaimNow = !!connectedWallet && claimState.hasClaimable && !isPumpfunPostSpawnRoom(r) && canClaimNativeSpawnTokens(r);
          spawnSuccessActions.style.display = canClaimNow ? "flex" : "none";
          if(claimSpawnBtn){
            claimSpawnBtn.disabled = !canClaimNow || !!r._spawnClaimInFlight;
            claimSpawnBtn.textContent = r._spawnClaimInFlight ? "claiming…" : "Claim tokens";
          }
        }
      }

      const walletCommitted = (r.state === "SPAWNING" && connectedWallet)
        ? getWalletGrossCommittedSol(r, connectedWallet)
        : 0;
      const me =
        (r.state === "SPAWNING")
          ? `you: your committed amount ${walletCommitted.toFixed(3)} SOL`
           : (isNativeLaunchBackend() ? `you: ${myBond(roomId).toFixed(3)} tokens on curve` : "you: launch tracked on Pingy");
      $("meLine").textContent = connectedWallet ? me : "connect wallet";
      if(connectedWallet && r.state === "SPAWNING") refreshConnectedWalletEscrowLine(roomId);

      const roomPingDockBtn = $("roomPingDockBtn");
      const isPumpPostSpawn = isPumpfunPostSpawnRoom(r);
      const bondedTradeLocked = r.state === "BONDED";
      if(roomPingDockBtn){
        roomPingDockBtn.textContent = isPumpPostSpawn ? "market external" : (r.state === "SPAWNING" ? "ping" : "buy");
        roomPingDockBtn.classList.toggle("subtle", bondedTradeLocked || !connectedWallet);
        roomPingDockBtn.disabled = !connectedWallet || bondedTradeLocked || !!(connectedWallet && r.blockedWallets && r.blockedWallets[connectedWallet]);
      }
      updateActionModalCopy(r);

      const bondedStatusPanel = $("bondedStatusPanel");
      const bondedStatusLine = $("bondedStatusLine");
      if(bondedStatusPanel) bondedStatusPanel.style.display = (r.state === "BONDED" || isPumpPostSpawn) ? "block" : "none";
      if(bondedStatusLine && (r.state === "BONDED" || isPumpPostSpawn)) bondedStatusLine.textContent = getDisplayedBondedStatusLine(r);

      setComposerState(r);
      renderChat(roomId);
      if(chatView?.classList.contains("on") && activeRoomId === roomId) renderChatRoom(roomId, { skipRoomRender: true });
    }

    // Ping / Unping flow
    // Use an explicit room id for modals so home-card clicks can't race view changes.
    let modalRoomId = null;
    let pingActionMode = "ping";

    function setPingActionMode(mode){
      const nextMode = mode === "unping" ? "unping" : "ping";
      pingActionMode = nextMode;
      const pingModePingBtn = $("pingModePingBtn");
      const pingModeUnpingBtn = $("pingModeUnpingBtn");
      const pingPanel = $("pingPanel");
      const unpingPanel = $("unpingPanel");
      const pingConfirm = $("pingConfirm");
      const unpingConfirm = $("unpingConfirm");
      const pingWalletSmokeTest = $("pingWalletSmokeTest");
      if(pingModePingBtn){
        pingModePingBtn.classList.toggle("active", nextMode === "ping");
        pingModePingBtn.classList.toggle("subtle", nextMode !== "ping");
        pingModePingBtn.setAttribute("aria-pressed", nextMode === "ping" ? "true" : "false");
      }
      if(pingModeUnpingBtn){
        pingModeUnpingBtn.classList.toggle("active", nextMode === "unping");
        pingModeUnpingBtn.classList.toggle("subtle", nextMode !== "unping");
        pingModeUnpingBtn.setAttribute("aria-pressed", nextMode === "unping" ? "true" : "false");
      }
      if(pingPanel) pingPanel.style.display = nextMode === "ping" ? "block" : "none";
      if(unpingPanel) unpingPanel.style.display = nextMode === "unping" ? "block" : "none";
      if(pingConfirm) pingConfirm.style.display = nextMode === "ping" ? "inline-block" : "none";
      if(unpingConfirm) unpingConfirm.style.display = nextMode === "unping" ? "inline-block" : "none";
      if(pingWalletSmokeTest) pingWalletSmokeTest.style.display = nextMode === "ping" ? "inline-block" : "none";
    }
    function computeMaxPingLamports(room, userDeposit = {}, wallet = connectedWallet){
      const targetLamports = Number(room?.onchain?.spawn_target_lamports || 0);
      const totalAllocatedLamports = Number(room?.onchain?.total_allocated_lamports || 0);
      const presetCapLamports = configWalletCapLamports({
        spawnTargetLamports: targetLamports,
        maxWalletShareBps: roomMaxWalletShareBps(room),
      });
      if(targetLamports <= 0 || presetCapLamports <= 0) return 0;
      const roomWalletRow = wallet ? (room?.onchain?.byWallet?.[wallet] || null) : null;
      const resolvedWalletCommittedLamports = resolveWalletCommittedLamports(room, wallet, roomWalletRow || userDeposit || {});
      const totalRoomRemainingLamports = Math.max(0, targetLamports - totalAllocatedLamports);
      const walletRemainingLamports = Math.max(0, presetCapLamports - resolvedWalletCommittedLamports);
      const finalMaxPingLamports = Math.max(0, Math.min(totalRoomRemainingLamports, walletRemainingLamports));
      console.log("[ping-debug] spawn cap calculation", {
        roomId: room?.id,
        wallet,
        walletCapLamports: presetCapLamports,
        resolvedWalletCommittedLamports,
        walletRemainingLamports,
        totalRoomRemainingLamports,
        finalMaxPingLamports,
      });
      return finalMaxPingLamports;
    }

    function formatLamportsAsSol(lamports){
      return (Math.max(0, Number(lamports || 0)) / LAMPORTS_PER_SOL).toFixed(9).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    }

    function formatRegularPingPreview(inputLamports, feeLamports, committedLamports){
      return (
        `Input: ${formatLamportsAsSol(inputLamports)} SOL • ` +
        `Pingy fee: ${formatLamportsAsSol(feeLamports)} SOL • ` +
        `Committed: ${formatLamportsAsSol(committedLamports)} SOL`
      );
    }

    function updatePingFeePreview(){
      const preview = $("pingFeePreview");
      if(!preview) return;
      const inputSol = Number(($("pingAmount")?.value || "").trim()) || 0;
      const inputLamports = Math.floor(Math.max(0, inputSol) * LAMPORTS_PER_SOL);
      const model = computeRegularPingSpendModel({ grossWalletInputLamports: inputLamports });
      preview.textContent = formatRegularPingPreview(model.grossWalletInputLamports, model.feeLamports, model.committedLamports);
    }


    function formatCreatorSpawnPreview(totalLamports, feeLamports, bootstrapLamports, committedLamports){
      return (
        `Total spend: ${formatLamportsAsSol(totalLamports)} SOL • ` +
        `Pingy fee: ${formatLamportsAsSol(feeLamports)} SOL • ` +
        `Room creation: ${formatLamportsAsSol(bootstrapLamports)} SOL • ` +
        `Committed: ${formatLamportsAsSol(committedLamports)} SOL`
      );
    }
    function updateCreateCommitFeePreview(){
      const preview = $("newCommitFeePreview");
      if(!preview) return;

      const inputEl = $("newCommit");
      const inputSol = Number((inputEl?.value || "").trim()) || 0;
      const launchMode = getCreateLaunchMode();
      const inputLamports = Math.floor(Math.max(0, inputSol) * LAMPORTS_PER_SOL);

	      if(launchMode !== "spawn"){
	        preview.textContent = formatRegularPingPreview(inputLamports, 0, inputLamports);
	        return;
	      }
	      const useV2SpawnCreate = shouldUseV2SpawnFlow(launchMode);
	      const creatorModel = computeCreatorSpawnSpendModel({
	        walletBalanceLamports: Number.MAX_SAFE_INTEGER,
	        committedCapLamports: Number.MAX_SAFE_INTEGER,
	        bootstrapCostLamports: useV2SpawnCreate ? 0 : estimateCreatorBootstrapReserveLamports(connectedWallet),
	        networkBufferLamports: 0,
	        totalWalletSpendLamports: inputLamports,
	      });
      preview.textContent = `${formatCreatorSpawnPreview(
        creatorModel.totalWalletSpendLamports,
	        creatorModel.feeLamports,
	        creatorModel.bootstrapCostLamports,
	        creatorModel.committedTargetLamports
	      )}${useV2SpawnCreate ? "" : " (room creation estimated)"}`;
	    }

    function updateActionModalCopy(room){
      const r = room || {};
      const isSpawning = r.state === "SPAWNING";
      const isBonding = r.state === "BONDING";
      const isBonded = r.state === "BONDED";
      const isPumpPostSpawn = isPumpfunPostSpawnRoom(r);

      const pingModalTitle = $("pingModalTitle");
      const pingAmountUnit = $("pingAmountUnit");
      const unpingAmountUnit = $("unpingAmountUnit");
      const pingModalHelp = $("pingModalHelp");
      const unpingModalHelp = $("unpingModalHelp");
      const pingConfirm = $("pingConfirm");
      const unpingConfirm = $("unpingConfirm");
      const unpingAmount = $("unpingAmount");

      if(pingModalTitle) pingModalTitle.textContent = isPumpPostSpawn
        ? "launch follow"
        : (pingActionMode === "unping"
          ? (isBonded ? "launched" : (isSpawning ? "unping" : "sell"))
          : (isBonded ? "launched" : (isSpawning ? "ping" : "buy")));
      if(pingAmountUnit) pingAmountUnit.textContent = "SOL";
      if(unpingAmountUnit) unpingAmountUnit.textContent = isSpawning ? "SOL" : "tokens";

      if(pingModalHelp){
        pingModalHelp.textContent = isSpawning
          ? "Your entered amount is total spend. Pingy takes a 1% fee. The rest becomes your committed amount."
          : isPumpPostSpawn
            ? "Launched coins trade outside Pingy. Pingy remains the coordination and watch layer."
            : isBonded
              ? "Trading for launched coins is handled outside Pingy."
              : "Trading for launched coins is handled outside Pingy.";
      }

      if(unpingModalHelp){
        unpingModalHelp.textContent = isSpawning
          ? (isNativeLaunchBackend()
            ? "During spawn, unping performs a full escrow withdraw and returns funds to your wallet (minus network fees)."
            : "Before spawn completes, you can unping to withdraw your committed amount (minus network fees).")
          : isPumpPostSpawn
            ? "Launched coins trade outside Pingy. Pingy remains the coordination and watch layer."
            : isBonded
              ? "Trading for launched coins is handled outside Pingy."
              : "Trading for launched coins is handled outside Pingy.";
      }

      if(isSpawning){
        if(unpingAmount){
          unpingAmount.value = "full withdraw";
          unpingAmount.readOnly = true;
        }
        if(unpingConfirm) unpingConfirm.textContent = isNativeLaunchBackend() ? "unping (full withdraw)" : "unping (withdraw contribution)";
      } else if(isBonding && !isPumpPostSpawn){
        if(unpingAmount){
          unpingAmount.value = "";
          unpingAmount.readOnly = false;
          unpingAmount.placeholder = "e.g. 100";
        }
        if(unpingConfirm) unpingConfirm.textContent = "sell";
      } else if(isBonded || isPumpPostSpawn){
        if(unpingAmount){
          unpingAmount.value = "graduated";
          unpingAmount.readOnly = true;
        }
        if(unpingConfirm) unpingConfirm.textContent = "external routing";
      }

      if(pingConfirm) pingConfirm.textContent = (isBonded || isPumpPostSpawn) ? "external routing" : (isSpawning ? "ping" : "buy");
    }

    setUiRenderers({ renderHomeFn: renderHome, renderRoomFn: renderRoom });


    function updatePingAllocationHint(roomId){
      const hint = $("pingAllocationHint");
      if(!hint) return;
      const r = roomById(roomId || activeRoomId);
      if(!r){
        hint.textContent = "Max: 0.000 SOL";
        return;
      }
      const pingConfirm = $("pingConfirm");
      if(r.state !== "SPAWNING"){
        hint.textContent = r.state === "BONDED"
          ? "Trading for launched coins is handled outside Pingy."
          : "Trading for launched coins is handled outside Pingy.";
        if(pingConfirm) pingConfirm.disabled = r.state === "BONDED";
        return;
      }
      const userDeposit = state.userEscrow || {};
      const capRemainingCommittedLamports = computeMaxPingLamports(r, userDeposit);
      const walletBalanceLamports = Math.max(0, Math.floor(Number(state.walletBalances[connectedWallet]?.nativeSol || 0) * LAMPORTS_PER_SOL));
      const maxCommittedByBalanceLamports = computeRegularPingSpendModel({ grossWalletInputLamports: walletBalanceLamports }).committedLamports;
      const targetCommittedLamports = Math.max(0, Math.min(capRemainingCommittedLamports, maxCommittedByBalanceLamports));
      const maxGrossLamports = computeGrossPositionInputForCommittedLamports(targetCommittedLamports);
      state.maxPingLamports = maxGrossLamports;
      state.maxPingCommittedLamports = targetCommittedLamports;
      const maxSol = maxGrossLamports / LAMPORTS_PER_SOL;
      hint.textContent = maxGrossLamports > 0
        ? "Max all-in ping: " + maxSol.toFixed(3) + " SOL"
        : "Spawn is full or you're at cap.";
      if(pingConfirm) pingConfirm.disabled = maxGrossLamports <= 0;
    }

    async function openPingModal(roomId, mode = "ping"){
      setPingActionMode(mode);
      if(!connectedWallet) return showToast("connect wallet first.");
      const rid = roomId || activeRoomId;
      const r = roomById(rid);
      if(!r) return;
      r.onchain = state.onchain?.[rid] || r.onchain || {};
      if(r.state === "BONDED" || isPumpfunPostSpawnRoom(r)){
        return alert("Trading for launched coins is handled outside Pingy.");
      }
      modalRoomId = rid;
      updateActionModalCopy(r);
      $("pingAmount").value = "";
      await fetchRoomOnchainSnapshot(rid);
      await fetchConnectedWalletDepositSnapshot(rid);
      await refreshWalletBalances(connectedWallet, { force: true });
      $("pingRoomLine").textContent = `coin: ${r.name}  $${r.ticker}`;
      updatePingAllocationHint(rid);
      updatePingFeePreview();
      updateActionModalCopy(r);
      openModal($("pingBack"));
    }
    function openUnpingModal(roomId){
      return openPingModal(roomId, "unping");
    }
    $("roomPingDockBtn")?.addEventListener("click", () => openPingModal(activeRoomId));
    roomContextToggleBtn?.addEventListener("click", () => {
      if(!activeRoomId) return;
      if(chatView?.classList.contains("on")) openRoom(activeRoomId);
      else openChatRoom(activeRoomId);
    });
    $("pingModePingBtn")?.addEventListener("click", () => {
      setPingActionMode("ping");
      updateActionModalCopy(roomById(modalRoomId || activeRoomId));
    });
    $("pingModeUnpingBtn")?.addEventListener("click", () => {
      setPingActionMode("unping");
      updateActionModalCopy(roomById(modalRoomId || activeRoomId));
    });
    const claimSpawnBtn = $("claimSpawnBtn");
    if(claimSpawnBtn){
      claimSpawnBtn.addEventListener("click", async () => {
        const r = roomById(activeRoomId);
        if(!r) return;
        await claimConnectedWalletSpawnTokens(r);
      });
    }
    $("pingAmount").addEventListener("input", () => { updatePingAllocationHint(modalRoomId || activeRoomId); updatePingFeePreview(); });
    $("pingMaxBtn").addEventListener("click", () => {
      const maxLamports = Number(state.maxPingLamports || 0);
      const input = $("pingAmount");
      const rid = modalRoomId || activeRoomId;
      const r = roomById(rid);
      if(!input) return;
      input.value = formatLamportsAsSol(maxLamports);
      const availableBalanceLamports = Math.floor(Number((state.walletBalances[connectedWallet]?.nativeSol || 0)) * LAMPORTS_PER_SOL);
      const reserveLamports = 0;
      console.log("[ping-debug] max ping calculation", {
        roomId: rid,
        wallet: connectedWallet,
        targetCommittedLamports: Number(state.maxPingCommittedLamports || 0),
        requiredGrossInputLamports: maxLamports,
        availableBalanceLamports,
        reserveLamports,
        mode: "regular",
      });
      updatePingAllocationHint(modalRoomId || activeRoomId);
      updatePingFeePreview();
      if(r && r.state !== "SPAWNING") input.value = "";
    });

    const openPumpfunBtn = $("openPumpfunBtn");
    if(openPumpfunBtn) openPumpfunBtn.addEventListener("click", () => openExternalLaunchForRoom(activeRoomId));
    const refreshExternalStatusBtn = $("refreshExternalStatusBtn");
    if(refreshExternalStatusBtn) refreshExternalStatusBtn.addEventListener("click", () => {
      if(activeRoomId) refreshRoomExternalStatus(activeRoomId);
    });
    const markLiveDevBtn = $("markLiveDevBtn");
    if(markLiveDevBtn) markLiveDevBtn.addEventListener("click", () => {
      if(activeRoomId) markRoomLiveExternally(activeRoomId, {
        externalLaunchUrl: "https://pump.fun/coin/mock-room",
        externalMint: "So11111111111111111111111111111111111111112",
        tokensReceived: 1000000,
        tokensDistributed: 0,
        distributionStatus: "ready",
      });
    });
    const simulateDistributionSettlementDevBtn = $("simulateDistributionSettlementDevBtn");
    if(simulateDistributionSettlementDevBtn) simulateDistributionSettlementDevBtn.addEventListener("click", () => {
      if(activeRoomId) simulateRoomDistributionSettlement(activeRoomId);
    });
    const pumpLaunchBtn = $("pumpLaunchBtn");
    if(pumpLaunchBtn) pumpLaunchBtn.addEventListener("click", () => {
      if(activeRoomId) launchRoomOnPumpfun(activeRoomId);
    });

    const settleDistributionBtn = $("settleDistributionBtn");
    if(settleDistributionBtn) settleDistributionBtn.addEventListener("click", () => {
      if(activeRoomId) settleRoomDistributionOnPumpfun(activeRoomId);
    });

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
      if(isPumpfunPostSpawnRoom(r)) return alert("Trading for launched coins is handled outside Pingy.");
      const s = ($("pingAmount").value||"").trim();
      const solAmount = Number(s);
      if(!s || Number.isNaN(solAmount) || solAmount <= 0) return alert("enter a valid SOL amount.");

      if(r.state === "SPAWNING"){
        if(r.blockedWallets && r.blockedWallets[connectedWallet]) return alert("Denied from this spawn. Your committed SOL stays in the launch vault until you unping.");
        if(!isCreator(r, connectedWallet)){
          r.approval = r.approval || {};
          if(!r.approval[connectedWallet]) r.approval[connectedWallet] = "pending";
        }
        const amountLamports = Math.round(solAmount * 1_000_000_000);
        if(!Number.isInteger(amountLamports) || amountLamports <= 0) return alert("enter at least 1 lamport.");
	        const onchainMode = shouldUseOnchain();
	        const useV2RoomFlow = isV2Room(r);
        const mockPos = onchainMode ? null : ensurePos(r, connectedWallet);
        const userDeposit = onchainMode ? (state.userEscrow || {}) : { exists: !!mockPos?.deposit_exists };
        const pingSpendModel = computeRegularPingSpendModel({ grossWalletInputLamports: amountLamports });
        const committedLamports = pingSpendModel.committedLamports;
        let depositBackingLamports = 0;
        let escrowContributionLamports = committedLamports;
        let stagedDepositBacking = false;

        if(onchainMode){
          const netCapacityLamports = computeMaxPingLamports(r, userDeposit);
          if(committedLamports > netCapacityLamports){
            showToast(`Too much. Max is ${(Number(state.maxPingLamports || 0) / LAMPORTS_PER_SOL).toFixed(3)} SOL.`);
            return;
          }
          console.log("[ping-debug] regular ping final math", {
            roomId: rid,
            wallet: connectedWallet,
            grossWalletInputLamports: amountLamports,
            pingFeeLamports: pingSpendModel.feeLamports,
            committedTargetLamports: committedLamports,
            depositBackingLamports,
            escrowContributionLamports,
            expectedWalletOutflowLamports: amountLamports,
            expectedDepositInstructionLamports: committedLamports,
          });
          console.log("[ping-debug] all-in ping amount conversion", { solAmount, grossEnteredLamports: amountLamports, escrowContributionLamports });
	          try {
	            const feeIx = buildPingFeeTransferInstruction(pingSpendModel.feeLamports);
	            let sig = "";
	            if(useV2RoomFlow){
	              const instructions = [
	                ...(feeIx ? [feeIx] : []),
	                await buildPingDepositSharedV2Ix(rid, committedLamports),
	              ];
	              sig = await sendProgramInstructions(instructions, {
	                feeRecipient: PINGY_FEE_RECIPIENT,
	                expectedWalletOutflowLamports: amountLamports,
	                committedLamports,
	                depositBackingLamports: 0,
	                expectedDepositInstructionLamports: committedLamports,
	                feeLamports: pingSpendModel.feeLamports,
	                bootstrapCostLamports: 0,
	              });
	            } else {
	              const walletPk = new PublicKey(connectedWallet);
	              const [threadPda] = await deriveThreadPda(rid);
	              const [depositPda] = await deriveDepositPda(rid, walletPk);
	              const existingDepositInfo = await connection.getAccountInfo(depositPda, "confirmed");
	              if(!existingDepositInfo?.data?.length || existingDepositInfo.data.length < 8){
	                depositBackingLamports = await estimateWalletDepositBackingLamports(rid, connectedWallet);
	                const split = splitCommittedLamportsForEscrow({ committedLamports, depositBackingLamports });
	                depositBackingLamports = split.depositBackingLamports;
	                escrowContributionLamports = split.escrowContributionLamports;
	                setWalletDepositBackingLamports(r, connectedWallet, depositBackingLamports);
	                stagedDepositBacking = true;
	              }
	              const [threadEscrowPda] = await deriveThreadEscrowPda(rid);
	              const [spawnPoolPda] = await deriveSpawnPoolPda(rid);
	              const threadInfo = await connection.getAccountInfo(threadPda, "confirmed");

	              if(DEBUG_WALLET_SMOKE_BEFORE_SPAWN_TX){
	                const smokeRes = await runWalletSmokeTest();
	                if(!smokeRes?.ok && isInvalidWalletArgumentsError(smokeRes?.error)){
	                  showToast("Wallet transport failed before spawn tx.");
	                  return;
	                }
	              }

	              const escrowInfoBefore = await connection.getAccountInfo(threadEscrowPda, "confirmed");
	              const balBefore = escrowInfoBefore ? await connection.getBalance(threadEscrowPda, "confirmed") : 0;
	              const depositBundle = await pingWithOptionalThreadInitTx(
	                rid,
	                committedLamports,
	                !threadInfo,
	                null
	              );
	              const instructions = [
	                ...(feeIx ? [feeIx] : []),
	                ...(depositBundle.instructions || []),
	              ];
	              sig = await sendProgramInstructions(instructions, {
	                feeRecipient: PINGY_FEE_RECIPIENT,
	                expectedWalletOutflowLamports: amountLamports,
	                committedLamports,
	                depositBackingLamports,
	                expectedDepositInstructionLamports: committedLamports,
	                feeLamports: pingSpendModel.feeLamports,
	                bootstrapCostLamports: 0,
	              });
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
	                grossEnteredLamports: amountLamports,
	                expectedCommittedLamports: committedLamports,
	                expectedEscrowContributionLamports: escrowContributionLamports,
	                feeTransferSignature: feeIx ? sig : "",
	                txExplorer: explorerTxUrl(sig),
	                escrowExplorer: explorerAddressUrl(threadEscrowPda.toBase58()),
	              });
	              showToast(`Thread escrow deposit +${deltaSol.toFixed(9)} SOL (all-in ping ${solAmount} SOL)`);
	              console.log("[ping-debug] explorer links", {
	                tx: explorerTxUrl(sig),
	                threadEscrow: explorerAddressUrl(threadEscrowPda.toBase58()),
	              });
	            }
	            const feeTransferSignature = feeIx ? sig : "";
	            if(feeIx){
              console.log("[ping-debug] ping fee transfer", {
                roomId: rid,
                wallet: connectedWallet,
                grossInputLamports: amountLamports,
                depositBackingLamports,
                feeLamports: pingSpendModel.feeLamports,
                committedLamports,
                transferSignature: feeTransferSignature,
              });
            }
	            if(useV2RoomFlow) showToast("Ping committed.");
	          } catch(e){
	            if(stagedDepositBacking) clearWalletDepositBackingLamports(r, connectedWallet);
	            reportTxError(e, useV2RoomFlow ? "v2 ping deposit transaction failed" : "ping deposit transaction failed");
	            return;
	          }
        } else {
          console.log("[ping-debug] mock all-in ping amount conversion", {
            solAmount,
            grossEnteredLamports: amountLamports,
            escrowContributionLamports,
            committedLamports,
          });
        }

        applyOptimisticSpawnCommitLamports(r, connectedWallet, committedLamports);

        state.chat[r.id] = state.chat[r.id] || [];
        const statusText = isApproved(r, connectedWallet) ? "approved" : "pending approval";
        state.chat[r.id].push({ ts: nowStamp(), wallet: "SYSTEM", text:`@${shortWallet(connectedWallet)} pinged ${solAmount.toFixed(3)} SOL gross (${(committedLamports / LAMPORTS_PER_SOL).toFixed(3)} committed, ${statusText})`, kind: "system_activity" });

        maybeAdvance(r);

      } else if(r.state === "BONDING") {
        if(shouldUseOnchain()){
          const amountLamports = Math.round(solAmount * LAMPORTS_PER_SOL);
          if(!Number.isInteger(amountLamports) || amountLamports <= 0) return alert("enter at least 1 lamport.");
          try {
            await buyTx(rid, amountLamports);
          } catch(e){
            reportTxError(e, "buy transaction failed");
            return;
          }
          state.chat[r.id] = state.chat[r.id] || [];
          state.chat[r.id].push({ ts: nowStamp(), wallet: "SYSTEM", text:`@${shortWallet(connectedWallet)} submitted a buy tx on-chain (${solAmount.toFixed(3)} SOL).`, kind: "system_activity" });
        } else {
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
      }

      closeModal($("pingBack"));
      await fetchRoomOnchainSnapshot(rid);
      await fetchConnectedWalletDepositSnapshot(rid);
      if(connectedWallet) await fetchWalletBalancesSnapshot(connectedWallet);
      updatePingAllocationHint(rid);
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
      if(isPumpfunPostSpawnRoom(r)) return alert("Trading for launched coins is handled outside Pingy.");
      if(r.state === "SPAWNING"){
        const rawDepositLamports = await fetchConnectedWalletDepositLamports(rid);
        const storedBackingLamports = getWalletDepositBackingLamports(r, connectedWallet);
	        const committedBeforeWithdrawLamports = Math.max(0, Number(rawDepositLamports || 0)) + Math.max(0, Number(storedBackingLamports || 0));
	        const committedBeforeWithdrawSol = committedBeforeWithdrawLamports / LAMPORTS_PER_SOL;
	        if(committedBeforeWithdrawSol <= 0) return alert(isNativeLaunchBackend() ? "you have no escrow to withdraw." : "you have no launch contribution to withdraw.");
	        if(shouldUseOnchain()){
	          try{
	            if(isV2Room(r)) await unpingRefundV2Tx(rid);
	            else await unpingWithdrawTx(rid);
	          } catch(e){
	            reportTxError(e, "unping transaction failed");
	            return;
          }
          showToast("Withdraw complete — funds returned to wallet.");
        } else {
          applySpawnUncommit(r, connectedWallet, committedBeforeWithdrawSol);
        }

        clearWalletDepositBackingLamports(r, connectedWallet);
        if(state.onchain?.[rid]?.byWallet){
          state.onchain[rid].byWallet[connectedWallet] = {
            ...(state.onchain[rid].byWallet[connectedWallet] || {}),
            status: "withdrawn",
            committed_lamports: 0,
            withdrawable_lamports: 0,
            allocated_lamports: 0,
            committed_sol: 0,
            withdrawable_sol: 0,
            allocated_sol: 0,
            escrow_sol: 0,
          };
        }
        if(r.onchain?.byWallet){
          r.onchain.byWallet[connectedWallet] = {
            ...(r.onchain.byWallet[connectedWallet] || {}),
            status: "withdrawn",
            committed_lamports: 0,
            withdrawable_lamports: 0,
            allocated_lamports: 0,
            committed_sol: 0,
            withdrawable_sol: 0,
            allocated_sol: 0,
            escrow_sol: 0,
          };
        }

        const meLine = $("meLine");
        if(meLine) meLine.textContent = `you: your committed amount ${Number(0).toFixed(3)} SOL`;

        state.chat[r.id] = state.chat[r.id] || [];
        state.chat[r.id].push({ ts: nowStamp(), wallet: connectedWallet, text:`withdrew ${committedBeforeWithdrawSol.toFixed(3)} SOL (full committed amount withdrawal, returned to wallet).`, kind: "activity" });

      } else if(r.state === "BONDING") {
        const s = ($("unpingAmount").value||"").trim();
        const tokenAmount = Number(s);
        if(!s || Number.isNaN(tokenAmount) || tokenAmount <= 0) return alert("enter a valid token amount.");
        if(shouldUseOnchain()){
          const tokenAmountU64 = Math.round(tokenAmount);
          if(!Number.isInteger(tokenAmountU64) || tokenAmountU64 <= 0) return alert("enter at least 1 token.");
          try {
            await sellTx(rid, tokenAmountU64);
          } catch(e){
            reportTxError(e, "sell transaction failed");
            return;
          }
          state.chat[r.id] = state.chat[r.id] || [];
          state.chat[r.id].push({ ts: nowStamp(), wallet: "SYSTEM", text:`@${shortWallet(connectedWallet)} submitted a sell tx on-chain (${tokenAmountU64} tokens).`, kind: "system_activity" });
        } else {
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
        }
      } else {
        return alert("Trading for launched coins is handled outside Pingy.");
      }

      closeModal($("pingBack"));
      await fetchRoomOnchainSnapshot(rid);
      await fetchConnectedWalletDepositSnapshot();
      if(connectedWallet) await fetchWalletBalancesSnapshot(connectedWallet);
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
      state.chat[activeRoomId].push({ ts: nowStamp(), _ts: Date.now(), wallet: connectedWallet, text: txt, kind: "chat" });
      resetComposer();
      renderChat(activeRoomId);
      if(chatView?.classList.contains("on")) renderChatRoom(activeRoomId, { skipRoomRender: true });
      renderPingsView();
      updatePingsTabUnreadBadge();
    });
    $("msgInput").addEventListener("input", () => {
      autoSizeComposer();
    });
    $("msgInput").addEventListener("keydown", (e) => {
      if(e.key === "Enter" && !e.shiftKey){
        e.preventDefault();
        $("sendBtn").click();
      }
    });
    autoSizeComposer();

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
          <p><strong>Last Updated:</strong> 15 March 2026</p>
          <p>Pingy keeps fees simple and predictable.</p>

          <p><strong>Pingy currently charges a 1% platform fee at two points in the launch flow:</strong></p>
          <p>1. when a user contributes SOL to a room (“Ping”)</p>
          <p>2. when a coin successfully launches</p>

          <p>These fees support platform operations, launch coordination, settlement infrastructure, and distribution handling.</p>

          <p><strong>Pingy Platform Fees</strong></p>
          <p><strong>Action</strong> | <strong>Fee</strong></p>
          <p>Create a room | 0 SOL</p>
          <p>Contribute to a room (“Ping”) | 1% of the SOL deposited</p>
          <p>Successful coin launch | 1% of the total SOL raised</p>

          <p><strong>Ping Fee</strong></p>
          <p>When a user contributes SOL to a room, a 1% fee is automatically applied to the deposited amount.</p>
          <p><strong>Example:</strong></p>
          <p>User contribution: 1.00 SOL</p>
          <p>Pingy fee (1%): 0.01 SOL</p>
          <p>Amount added to the room pool: 0.99 SOL</p>
          <p>This fee is collected at the time of deposit.</p>

          <p><strong>Launch Fee</strong></p>
          <p>When a room successfully launches a coin, Pingy collects a 1% launch execution fee from the total SOL raised.</p>
          <p><strong>Example:</strong></p>
          <p>Total raised: 10 SOL</p>
          <p>Pingy launch fee (1%): 0.10 SOL</p>
          <p>SOL used to launch the token: 9.90 SOL</p>
          <p>This fee is only charged when a launch succeeds.</p>

          <p><strong>Token Distribution</strong></p>
          <p>After launch, tokens acquired through the launch transaction are distributed to room participants according to their proportional contributions.</p>
          <p>Distribution may require token account setup and onchain transfer activity. Related network or execution costs may be deducted from launch proceeds or otherwise handled by Pingy’s launch and settlement flow.</p>

          <p><strong>Third-Party Fees</strong></p>
          <p>Pingy does not control fees charged by third-party services or protocols.</p>
          <p>Additional costs may apply from:</p>
          <p>- blockchain network transaction fees</p>
          <p>- wallet software fees</p>
          <p>- external launch venues such as pump.fun</p>
          <p>- external trading venues after launch</p>
          <p>These are separate from Pingy platform fees.</p>

          <p><strong>Creator Rewards</strong></p>
          <p>If an external launch venue provides creator rewards, creator trading fees, or similar creator-linked incentives, those rewards are intended to belong to the designated coin creator.</p>
          <p>Pingy may structure launches so the creator remains the recognized creator for external platform purposes, while Pingy manages pooled launch capital and participant settlement.</p>

          <p><strong>Fee Transparency</strong></p>
          <p>Pingy aims to keep fees easy to understand and lightweight. Some fees may be reflected in the transaction flow or launch math rather than presented as separate standalone charges.</p>

          <p><strong>Changes to Fees</strong></p>
          <p>Pingy may update platform fees in the future. Any changes will be reflected in this Fees section.</p>
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

      if(parts[0] === "chat" && parts[1]){
        const ridFromPath = decodeURIComponent(parts[1]);
        const r = roomById(ridFromPath);
        if(r){
          if(!connectedWallet) showToast("connect wallet first.");
          else openChatRoom(ridFromPath);
          return;
        }
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
      const provider = getProvider();
      if(provider) syncWalletFromProvider(provider, { silent: true }).catch((err) => {
        console.warn("[wallet] sync failed", err);
      });
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
