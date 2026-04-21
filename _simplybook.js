// api/health.js
// ── 健康檢查 ─────────────────────────────────────────────
// GET /api/health
// 用來確認 Vercel 部署成功 + SimplyBook token 是否可以取得

import { getToken } from "./_simplybook.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.SB_API_KEY;
  let sbStatus = "未設定 SB_API_KEY";
  let sbOk     = false;

  if (apiKey) {
    try {
      await getToken(apiKey);
      sbStatus = "SimplyBook 連線正常 ✓";
      sbOk     = true;
    } catch (e) {
      sbStatus = `SimplyBook 連線失敗：${e.message}`;
    }
  }

  return res.status(200).json({
    ok:        true,
    server:    "bgl-escape-backend",
    timestamp: new Date().toISOString(),
    simplybook: { ok: sbOk, message: sbStatus },
  });
}
