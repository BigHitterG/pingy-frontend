module.exports = function handler(_req, res) {
  const url = typeof process.env.NEXT_PUBLIC_SUPABASE_URL === "string"
    ? process.env.NEXT_PUBLIC_SUPABASE_URL.trim()
    : "";
  const anonKey = typeof process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY === "string"
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim()
    : "";

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    NEXT_PUBLIC_SUPABASE_URL: url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
  });
};
