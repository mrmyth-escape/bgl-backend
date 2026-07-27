// api/closing/index.js
//   GET  /api/closing?date=&store=   讀取日結單
//   POST /api/closing                儲存草稿（不做金額檢查，隨時可存）

import { db } from "../_lib/db.js";
import { handler, readBody, fail } from "../_lib/http.js";
import {
  loadClosing,
  saveClosing,
  normalizeClosing,
  serializeClosing,
  defaultBusinessDate,
  assertDate,
} from "../_lib/closing.js";
import { DEFAULT_STORE } from "../_simplybook.js";

export default handler(
  async (req, res) => {
    const sql = db();

    if (req.method === "GET") {
      const storeCode = req.query.store || DEFAULT_STORE;
      const date      = assertDate(req.query.date || defaultBusinessDate(), "date");

      const found = await loadClosing(sql, storeCode, date);
      if (!found) throw fail(404, `${date} 尚無日結單`);

      return res.status(200).json({ ok: true, closing: serializeClosing(found) });
    }

    // POST — 存草稿
    const body      = readBody(req);
    const storeCode = body.storeCode || DEFAULT_STORE;
    const date      = assertDate(body.businessDate || defaultBusinessDate(), "businessDate");

    const data = normalizeClosing(body);
    await saveClosing(sql, {
      storeCode,
      businessDate: date,
      data,
      status: "draft",
      actor: data.submitted_by,
    });

    const saved = await loadClosing(sql, storeCode, date);
    return res.status(200).json({
      ok: true,
      message: "草稿已儲存",
      closing: serializeClosing(saved),
    });
  },
  { methods: ["GET", "POST"] }
);
