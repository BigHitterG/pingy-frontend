import * as solanaWeb3 from "https://esm.sh/@solana/web3.js@1.95.3?bundle";

export const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} = solanaWeb3;
export { solanaWeb3 };

export const SOLANA_CLUSTER = "devnet";
export const DEVNET_RPC = clusterApiUrl(SOLANA_CLUSTER);
export const connection = new Connection(DEVNET_RPC, "confirmed");

// Program id from `idl/pingy_spawn.json` / `program/Anchor.toml`.
// Keep UI interactive even if a placeholder/non-base58 id is configured.
const PROGRAM_ID_RAW = "11111111111111111111111111111111";
const PROGRAM_ID_PLACEHOLDER = "Pingy1111111111111111111111111111111111111";
function resolveProgramId() {
  if (PROGRAM_ID_RAW === PROGRAM_ID_PLACEHOLDER) {
    console.warn("[pingy] PROGRAM_ID_RAW is still a placeholder. Replace with deployed devnet program id.");
  }
  try {
    return new PublicKey(PROGRAM_ID_RAW);
  } catch (err) {
    console.warn("[pingy] invalid PROGRAM_ID, falling back to system program id", err);
    return new PublicKey("11111111111111111111111111111111");
  }
}
export const PROGRAM_ID = resolveProgramId();

function threadIdBytes(threadId) {
  return new TextEncoder().encode(String(threadId || ""));
}

function toPublicKey(pubkey) {
  return pubkey instanceof PublicKey ? pubkey : new PublicKey(pubkey);
}

export async function deriveThreadPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("thread"), threadIdBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveSpawnPoolPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("spawn_pool"), threadIdBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveDepositPda(threadId, userPubkey) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("deposit"), threadIdBytes(threadId), toPublicKey(userPubkey).toBuffer()],
    PROGRAM_ID,
  );
}

export async function fetchProgramAccounts(config = {}) {
  return connection.getProgramAccounts(PROGRAM_ID, config);
}
