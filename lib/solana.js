function createMockSolanaWeb3(){
  class MockPublicKey {
    constructor(value){
      const raw = value instanceof Uint8Array
        ? Array.from(value).map((b) => b.toString(16).padStart(2, "0")).join("")
        : String(value || "").trim();
      if(!raw) throw new Error("Invalid public key input");
      this._value = raw;
    }
    toBase58(){ return this._value; }
    toBytes(){ return new TextEncoder().encode(this._value).slice(0, 32); }
    toBuffer(){ return Uint8Array.from(this.toBytes()); }
    toString(){ return this._value; }
    static async findProgramAddress(){
      return [new MockPublicKey("11111111111111111111111111111111"), 255];
    }
  }

  class MockConnection {
    async getAccountInfo(){ return { executable: true, data: new Uint8Array() }; }
    async getLatestBlockhash(){ return { blockhash: "mock-blockhash", lastValidBlockHeight: 0 }; }
    async simulateTransaction(){ return { value: { err: null, logs: [] } }; }
    async sendRawTransaction(){ return "mock-signature"; }
    async confirmTransaction(){ return { value: { err: null } }; }
    async getTransaction(){ return { meta: { logMessages: [] } }; }
    async getProgramAccounts(){ return []; }
  }

  class MockTransaction {
    constructor(){ this.instructions = []; }
    add(ix){ this.instructions.push(ix); return this; }
    serialize(){ return new Uint8Array(); }
  }

  class MockTransactionInstruction {
    constructor({ programId, keys = [], data = new Uint8Array() }){
      this.programId = programId;
      this.keys = keys;
      this.data = data;
    }
  }

  return {
    Connection: MockConnection,
    PublicKey: MockPublicKey,
    SystemProgram: { programId: new MockPublicKey("11111111111111111111111111111111") },
    Transaction: MockTransaction,
    TransactionInstruction: MockTransactionInstruction,
    clusterApiUrl: (cluster) => `https://api.${cluster}.solana.com`,
  };
}

const SOLANA_WEB3_CDNS = [
  "https://esm.sh/@solana/web3.js@1.95.3?bundle",
  "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.browser.esm.js",
  "https://unpkg.com/@solana/web3.js@1.95.3/lib/index.browser.esm.js",
];

let solanaWeb3 = null;
for(const url of SOLANA_WEB3_CDNS){
  try {
    solanaWeb3 = await import(url);
    break;
  } catch (err){
    console.warn("[pingy] failed to load @solana/web3.js from", url, err);
  }
}

if(!solanaWeb3){
  console.warn("[pingy] falling back to mock solana client; wallet + onchain tx disabled");
  solanaWeb3 = createMockSolanaWeb3();
}

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

export const PROGRAM_ID = new PublicKey("Pingy1111111111111111111111111111111111111");

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
