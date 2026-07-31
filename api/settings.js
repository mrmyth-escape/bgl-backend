// api/settings.js
//   GET   /api/settings?store=   收入項目 + 收款方式清單
//   POST  /api/settings          新增一項
//   PATCH /api/settings          改名 / 停用 / 調整順序 / 切換是否為現金
//
// 兩張表結構幾乎一樣，用 kind 參數區分：revenue（收入項目）/ payment（收款方式）。

import { db } from "./_lib/db.js";
import { handler, readBody, fail } from "./_lib/http.js";
import { DEFAULT_STORE } from "./_lib/store.js";

const MAX_NAME = 20;

export default handler(
  async (req, res) => {
    const sql = db();

    if (req.method === "GET") {
      const store = req.query.store || DEFAULT_STORE;
      const all   = req.query.all === "1";
      const [revenues, payments] = await Promise.all([
        all
          ? sql`SELECT * FROM revenue_items   WHERE store_code = ${store} ORDER BY active DESC, sort_order, id`
          : sql`SELECT * FROM revenue_items   WHERE store_code = ${store} AND active ORDER BY sort_order, id`,
        all
          ? sql`SELECT * FROM payment_methods WHERE store_code = ${store} ORDER BY active DESC, sort_order, id`
          : sql`SELECT * FROM payment_methods WHERE store_code = ${store} AND active ORDER BY sort_order, id`,
      ]);
      return res.status(200).json({
        ok: true, store,
        revenueItems:   revenues.map(toApi),
        paymentMethods: payments.map(toApi),
      });
    }

    const body  = readBody(req);
    const table = tableOf(body.kind);
    const store = body.storeCode || DEFAULT_STORE;

    if (req.method === "POST") {
      const name = String(body.name ?? "").trim();
      if (!name) throw fail(400, "請輸入名稱");
      if (name.length > MAX_NAME) throw fail(400, `名稱請勿超過 ${MAX_NAME} 個字`);

      // 排在最後面
      const [{ max }] = await sql`
        SELECT COALESCE(MAX(sort_order), 0) AS max FROM ${sql(table)} WHERE store_code = ${store}
      `;
      const isCash = body.kind === "payment" && body.isCash === true;

      const [row] = body.kind === "payment"
        ? await sql`
            INSERT INTO payment_methods (name, store_code, is_cash, sort_order)
            VALUES (${name}, ${store}, ${isCash}, ${Number(max) + 10})
            ON CONFLICT (store_code, name) DO UPDATE SET active = TRUE
            RETURNING *`
        : await sql`
            INSERT INTO revenue_items (name, store_code, sort_order)
            VALUES (${name}, ${store}, ${Number(max) + 10})
            ON CONFLICT (store_code, name) DO UPDATE SET active = TRUE
            RETURNING *`;

      return res.status(200).json({ ok: true, message: `已新增「${name}」`, item: toApi(row) });
    }

    // PATCH
    const id = Number(body.id);
    if (!Number.isInteger(id)) throw fail(400, "id 不合法");

    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw fail(400, "名稱不可為空");
      if (name.length > MAX_NAME) throw fail(400, `名稱請勿超過 ${MAX_NAME} 個字`);
      patch.name = name;
    }
    if (body.active !== undefined)     patch.active = body.active === true;
    if (body.sortOrder !== undefined)  patch.sort_order = Number(body.sortOrder) || 0;
    if (body.isCash !== undefined && body.kind === "payment") patch.is_cash = body.isCash === true;

    if (Object.keys(patch).length === 0) throw fail(400, "沒有要更新的欄位");

    const [row] = await sql`UPDATE ${sql(table)} SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
    if (!row) throw fail(404, "找不到這個項目");

    return res.status(200).json({ ok: true, message: `已更新「${row.name}」`, item: toApi(row) });
  },
  { methods: ["GET", "POST", "PATCH"] }
);

function tableOf(kind) {
  if (kind === "revenue") return "revenue_items";
  if (kind === "payment") return "payment_methods";
  throw fail(400, "kind 須為 revenue 或 payment");
}

function toApi(r) {
  return {
    id: r.id, name: r.name, storeCode: r.store_code,
    sortOrder: r.sort_order, active: r.active,
    ...(r.is_cash === undefined ? {} : { isCash: r.is_cash }),
  };
}
