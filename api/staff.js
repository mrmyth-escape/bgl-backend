// api/staff.js
//   GET   /api/staff?store=      在職員工名單（結帳頁面的下拉選單）
//   POST  /api/staff             新增一位（員工頁與老闆頁都能用）
//   PATCH /api/staff             停用 / 復職（只放在老闆頁）
//
// 停用不會刪除資料 —— 已結的帳一律保留當時的姓名快照。

import { db } from "./_lib/db.js";
import { handler, readBody, fail } from "./_lib/http.js";
import { DEFAULT_STORE } from "./_lib/store.js";

const MAX_NAME = 20;

export default handler(
  async (req, res) => {
    const sql = db();

    if (req.method === "GET") {
      const store = req.query.store || DEFAULT_STORE;
      // 老闆頁要看到停用的人，員工頁只要在職的
      const rows = req.query.all === "1"
        ? await sql`SELECT * FROM staff WHERE store_code = ${store} ORDER BY active DESC, name`
        : await sql`SELECT * FROM staff WHERE store_code = ${store} AND active ORDER BY name`;
      return res.status(200).json({ ok: true, store, staff: rows.map(toApi) });
    }

    const body  = readBody(req);
    const store = body.storeCode || DEFAULT_STORE;

    if (req.method === "POST") {
      const name = String(body.name ?? "").trim();
      if (!name) throw fail(400, "請輸入姓名");
      if (name.length > MAX_NAME) throw fail(400, `姓名請勿超過 ${MAX_NAME} 個字`);

      // 同名的人如果之前被停用，直接讓他復職，不要建第二筆
      const [row] = await sql`
        INSERT INTO staff (name, store_code) VALUES (${name}, ${store})
        ON CONFLICT (store_code, name) DO UPDATE SET active = TRUE
        RETURNING *
      `;
      return res.status(200).json({ ok: true, message: `已新增「${name}」`, staff: toApi(row) });
    }

    // PATCH — 停用 / 復職
    const id = Number(body.id);
    if (!Number.isInteger(id)) throw fail(400, "id 不合法");

    const [row] = await sql`
      UPDATE staff SET active = ${body.active === true}
      WHERE id = ${id} RETURNING *
    `;
    if (!row) throw fail(404, "找不到這位員工");

    return res.status(200).json({
      ok: true,
      message: `已${row.active ? "復職" : "停用"}「${row.name}」`,
      staff: toApi(row),
    });
  },
  { methods: ["GET", "POST", "PATCH"] }
);

function toApi(s) {
  return { id: s.id, name: s.name, storeCode: s.store_code, active: s.active };
}
