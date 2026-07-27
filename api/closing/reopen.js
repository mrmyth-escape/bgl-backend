// api/closing/reopen.js — POST /api/closing/reopen
// 解鎖已結帳的單子（結錯帳時用）。一定要留原因，並寫進 audit log。

import { db } from "../_lib/db.js";
import { handler, readBody, fail } from "../_lib/http.js";
import { assertDate } from "../_lib/closing.js";
import { DEFAULT_STORE } from "../_simplybook.js";

export default handler(
  async (req, res) => {
    const sql       = db();
    const body      = readBody(req);
    const storeCode = body.storeCode || DEFAULT_STORE;
    const date      = assertDate(body.businessDate, "businessDate");

    if (!body.reason)  throw fail(400, "請填寫解鎖原因");
    if (!body.actor)   throw fail(400, "請填寫操作人員姓名");

    const [closing] = await sql`
      SELECT id, status FROM daily_closings
      WHERE store_code = ${storeCode} AND business_date = ${date}
    `;
    if (!closing) throw fail(404, `${date} 尚無日結單`);
    if (closing.status !== "locked") throw fail(409, "此日結單並未鎖定");

    await sql.begin(async (tx) => {
      await tx`
        UPDATE daily_closings
        SET status = 'draft', submitted_at = NULL, updated_at = now()
        WHERE id = ${closing.id}
      `;
      await tx`
        INSERT INTO closing_audit_log (closing_id, action, actor, detail)
        VALUES (${closing.id}, 'reopen', ${body.actor}, ${tx.json({ reason: body.reason })})
      `;
    });

    return res.status(200).json({ ok: true, message: `${date} 的日結單已解鎖，可重新編輯` });
  },
  { methods: ["POST"] }
);
