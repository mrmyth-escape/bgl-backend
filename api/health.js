// api/health.js — GET /api/health
// 健檢：同時確認 SimplyBook 與資料庫。不需要 API key，方便直接用瀏覽器開。

import { applyCors } from "./_lib/http.js";
import { getToken } from "./_simplybook.js";
import { db } from "./_lib/db.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const simplybook = await checkSimplyBook();
  const database   = await checkDatabase();

  const ok = simplybook.ok && database.ok;
  return res.status(ok ? 200 : 503).json({
    ok,
    server:    "bgl-escape-backend",
    timestamp: new Date().toISOString(),
    config: {
      SB_API_KEY:        Boolean(process.env.SB_API_KEY),
      DATABASE_URL:      Boolean(process.env.DATABASE_URL),
      APP_API_KEY:       Boolean(process.env.APP_API_KEY),
      SB_WEBHOOK_SECRET: Boolean(process.env.SB_WEBHOOK_SECRET),
      ALLOWED_ORIGIN:    process.env.ALLOWED_ORIGIN || "*（未限制，建議上線後設定）",
    },
    simplybook,
    database,
  });
}

async function checkSimplyBook() {
  if (!process.env.SB_API_KEY) return { ok: false, message: "未設定 SB_API_KEY" };
  try {
    await getToken(process.env.SB_API_KEY);
    return { ok: true, message: "SimplyBook 連線正常 ✓" };
  } catch (e) {
    return { ok: false, message: `SimplyBook 連線失敗：${e.message}` };
  }
}

async function checkDatabase() {
  if (!process.env.DATABASE_URL) return { ok: false, message: "未設定 DATABASE_URL" };
  try {
    const [row] = await db()`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'daily_closings'
    `;
    if (row.n === 0) {
      return { ok: false, message: "資料庫已連線，但尚未建表 —— 請執行 POST /api/admin/migrate" };
    }
    return { ok: true, message: "資料庫連線正常 ✓" };
  } catch (e) {
    return { ok: false, message: `資料庫連線失敗：${e.message}` };
  }
}
