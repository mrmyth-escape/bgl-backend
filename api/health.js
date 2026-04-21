// api/health.js — GET /api/health
import { getToken } from "./_simplybook.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.SB_API_KEY;
  let sbOk     = false;
  let sbStatus = "未設定 SB_API_KEY";

  if (apiKey) {
    try {
      await getToken(apiKey);
      sbOk     = true;
      sbStatus = "SimplyBook 連線正常 ✓";
    } catch (e) {
      sbStatus = `SimplyBook 連線失敗：${e.message}`;
    }
  }

  return res.status(200).json({
    ok:         true,
    server:     "bgl-escape-backend",
    timestamp:  new Date().toISOString(),
    simplybook: { ok: sbOk, message: sbStatus },
  });
}
