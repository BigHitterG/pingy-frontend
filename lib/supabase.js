import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let cachedRuntimeConfigPromise = null;
let cachedSupabaseClientPromise = null;

async function readRuntimeSupabaseConfig(){
  if(cachedRuntimeConfigPromise) return cachedRuntimeConfigPromise;
  cachedRuntimeConfigPromise = (async () => {
    const processEnv = globalThis?.process?.env || null;
    const processUrl = typeof processEnv?.NEXT_PUBLIC_SUPABASE_URL === "string"
      ? processEnv.NEXT_PUBLIC_SUPABASE_URL.trim()
      : "";
    const processAnonKey = typeof processEnv?.NEXT_PUBLIC_SUPABASE_ANON_KEY === "string"
      ? processEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim()
      : "";
    if(processUrl && processAnonKey){
      return { url: processUrl, anonKey: processAnonKey, source: "process.env" };
    }

    // Pingy currently ships as a plain browser module, so fetch public env values
    // from a tiny Vercel/serverless endpoint when build-time env injection is unavailable.
    try {
      const response = await fetch("/api/runtime-config", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if(!response.ok) return null;
      const body = await response.json();
      const runtimeUrl = typeof body?.NEXT_PUBLIC_SUPABASE_URL === "string"
        ? body.NEXT_PUBLIC_SUPABASE_URL.trim()
        : "";
      const runtimeAnonKey = typeof body?.NEXT_PUBLIC_SUPABASE_ANON_KEY === "string"
        ? body.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim()
        : "";
      if(!runtimeUrl || !runtimeAnonKey) return null;
      return { url: runtimeUrl, anonKey: runtimeAnonKey, source: "runtime-config" };
    } catch (_err){
      return null;
    }
  })();
  return cachedRuntimeConfigPromise;
}

export async function getSupabaseRoomsClient(){
  if(cachedSupabaseClientPromise) return cachedSupabaseClientPromise;
  cachedSupabaseClientPromise = (async () => {
    const config = await readRuntimeSupabaseConfig();
    if(!config?.url || !config?.anonKey) return null;
    return createClient(config.url, config.anonKey, {
      auth: { persistSession: false },
    });
  })();
  return cachedSupabaseClientPromise;
}

export async function listRoomsMetadata(){
  const client = await getSupabaseRoomsClient();
  if(!client) return { ok: false, skipped: true, data: [], error: "Supabase rooms client not configured." };
  const { data, error } = await client
    .from("rooms")
    .select("id, public_id, created_at, name, ticker, creator_wallet, description, image_path, banner_path, is_test")
    .order("created_at", { ascending: false });
  if(error) return { ok: false, skipped: false, data: [], error: error.message || "Failed to load rooms." };
  return { ok: true, skipped: false, data: Array.isArray(data) ? data : [], error: null };
}

export async function insertRoomMetadata(payload){
  const client = await getSupabaseRoomsClient();
  if(!client) return { ok: false, skipped: true, data: null, error: "Supabase rooms client not configured." };
  const publicId = typeof payload?.public_id === "string" ? payload.public_id.trim() : "";
  const { data, error } = await client
    .from("rooms")
    .insert({
      ...(publicId ? { public_id: publicId } : {}),
      name: String(payload?.name || "").trim(),
      ticker: String(payload?.ticker || "").trim(),
      creator_wallet: String(payload?.creator_wallet || "").trim(),
      description: String(payload?.description || "").trim(),
      image_path: typeof payload?.image_path === "string" ? payload.image_path : "",
      banner_path: typeof payload?.banner_path === "string" ? payload.banner_path : "",
      is_test: payload?.is_test === true,
    })
    .select("id, public_id, created_at, name, ticker, creator_wallet, description, image_path, banner_path, is_test")
    .single();
  if(error) return { ok: false, skipped: false, data: null, error: error.message || "Failed to save room metadata." };
  return { ok: true, skipped: false, data: data || null, error: null };
}

export async function deleteRoomMetadataByRowId(rowId){
  const client = await getSupabaseRoomsClient();
  if(!client) return { ok: false, skipped: true, error: "Supabase rooms client not configured." };
  const numericId = Number(rowId);
  if(!Number.isFinite(numericId) || numericId <= 0) return { ok: false, skipped: false, error: "Invalid Supabase room row id." };
  const { error } = await client
    .from("rooms")
    .delete()
    .eq("id", Math.trunc(numericId));
  if(error) return { ok: false, skipped: false, error: error.message || "Failed to delete room metadata." };
  return { ok: true, skipped: false, error: null };
}
