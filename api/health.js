// api/health.js — GET /api/health
// 健檢：確認資料庫連線與設定。不需要 API key，方便直接用瀏覽器開。

import { applyCors } from "./_lib/http.js";
import { db } from "./_lib/db.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const database = await checkDatabase();
  const ok = database.ok;
  return res.status(ok ? 200 : 503).json({
    ok,
    server:    "bgl-escape-backend",
    timestamp: new Date().toISOString(),
    config: {
      DATABASE_URL:   Boolean(process.env.DATABASE_URL),
      APP_API_KEY:    Boolean(process.env.APP_API_KEY),
      ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || "*（未限制，建議上線後設定）",
    },
    database,
  });
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
