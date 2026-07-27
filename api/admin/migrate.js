// api/admin/migrate.js — POST /api/admin/migrate
// 套用 db/schema.sql。schema 是 idempotent 的，可重複執行。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../_lib/db.js";
import { handler } from "../_lib/http.js";

export default handler(
  async (req, res) => {
    const schemaPath = path.join(process.cwd(), "db", "schema.sql");
    const sqlText = await readFile(schemaPath, "utf8");

    await db().unsafe(sqlText);

    const tables = await db()`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;

    return res.status(200).json({
      ok: true,
      message: "schema 已套用",
      tables: tables.map((t) => t.table_name),
    });
  },
  { methods: ["POST"] }
);

// schema.sql 需要一起打包進 serverless function
export const config = {
  includeFiles: "db/schema.sql",
};
