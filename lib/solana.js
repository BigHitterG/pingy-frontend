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

export async function deriveFeeVaultPda() {
  return PublicKey.findProgramAddress(
    [threadIdBytes("fee_vault")],
    PROGRAM_ID,
  );
}

export async function deriveDepositPda(threadId, userPubkey) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("deposit"), threadIdBytes(threadId), toPublicKey(userPubkey).toBuffer()],
    PROGRAM_ID,
  );
}

export async function deriveUserVaultPda(userPubkey) {
  return PublicKey.findProgramAddress(
    [threadIdBytes("vault"), toPublicKey(userPubkey).toBuffer()],
    PROGRAM_ID,
  );
}

export async function fetchProgramAccounts(config = {}) {
  return connection.getProgramAccounts(PROGRAM_ID, config);
}
