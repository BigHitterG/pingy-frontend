import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from "https://esm.sh/@solana/web3.js@1.95.4";

export {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
};

export const SOLANA_CLUSTER = "devnet";
export const DEVNET_RPC = clusterApiUrl(SOLANA_CLUSTER);
export const connection = new Connection(DEVNET_RPC, "confirmed");

export const PROGRAM_ID = new PublicKey(
  "FSvYheeHSLjU6UKqka5AnMeaPwsQBrLm8dCL4VtFpf5R"
);
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

function threadIdBytes(threadId) {
  return new TextEncoder().encode(String(threadId || ""));
}

const roomSeedCache = new Map();

async function roomSeedBytes(threadId) {
  const normalized = String(threadId || "");
  if (roomSeedCache.has(normalized)) return roomSeedCache.get(normalized);
  const digest = await crypto.subtle.digest("SHA-256", threadIdBytes(normalized));
  const seed = new Uint8Array(digest).slice(0, 32);
  roomSeedCache.set(normalized, seed);
  return seed;
}

function toPublicKey(pubkey) {
  return pubkey instanceof PublicKey ? pubkey : new PublicKey(pubkey);
}

export async function deriveThreadPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("thread"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveSpawnPoolPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("spawn_pool"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveCurvePda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("curve"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveCurveAuthorityPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("curve_authority"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveCurveTokenVaultPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("curve_token_vault"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveMintPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("mint"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveEscrowPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("escrow"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveThreadEscrowPda(threadId) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("escrow"), await roomSeedBytes(threadId)],
    PROGRAM_ID,
  );
}

export async function deriveFeeVaultPda() {
  return PublicKey.findProgramAddress(
    [threadIdBytes("fee_vault")],
    PROGRAM_ID,
  );
}

export async function deriveDepositPda(threadId, userPubkey) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("deposit"), await roomSeedBytes(threadId), toPublicKey(userPubkey).toBuffer()],
    PROGRAM_ID,
  );
}

export async function deriveBanPda(threadId, userPubkey) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("ban"), await roomSeedBytes(threadId), toPublicKey(userPubkey).toBuffer()],
    PROGRAM_ID,
  );
}
export async function fetchProgramAccounts(config = {}) {
  return connection.getProgramAccounts(PROGRAM_ID, config);
}
