// api/_lib/db.js
// Postgres 連線（Neon / Supabase 皆適用）
//
// 環境變數 DATABASE_URL 請填「連線池（pooled / pgbouncer）」的連線字串：
//   Neon     → ...-pooler.<region>.aws.neon.tech/<db>?sslmode=require
//   Supabase → Connection Pooling 分頁的 URI（port 6543）
// Serverless 每次呼叫都是新實例，走連線池才不會把資料庫連線數吃光。

import postgres from "postgres";

let _sql = null;

export function db() {
  if (_sql) return _sql;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未設定");

  _sql = postgres(url, {
    // 雲端資料庫一律走 TLS；本機測試可在連線字串加 sslmode=disable
    ssl: /sslmode=disable/.test(url) ? false : "require",
    // pgbouncer 的 transaction mode 不支援 prepared statement
    prepare: false,
    // 單一 serverless 實例只需要一條連線
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return _sql;
}
