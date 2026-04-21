export default async function handler(req, res) {
  const apiKey = process.env.SB_API_KEY;
  return res.status(200).json({
    ok: true,
    server: "bgl-escape-backend",
    timestamp: new Date().toISOString(),
    apiKeySet: !!apiKey,
  });
}
