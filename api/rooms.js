// api/rooms.js
//   GET   /api/rooms?store=      房間清單（含每人定價）
//   PATCH /api/rooms             更新定價 / 啟用狀態
//
// 有了定價，結帳頁面選房間 + 填人數就會自動算金額，店員不用每場手打。

import { db } from "./_lib/db.js";
import { handler, readBody, fail } from "./_lib/http.js";
import { DEFAULT_STORE } from "./_simplybook.js";

export default handler(
  async (req, res) => {
    const sql = db();

    if (req.method === "GET") {
      const store = req.query.store || DEFAULT_STORE;
      const rooms = await sql`
        SELECT * FROM rooms WHERE store_code = ${store} ORDER BY room_code
      `;
      return res.status(200).json({ ok: true, store, rooms: rooms.map(toApi) });
    }

    // PATCH — 批次更新定價
    const body  = readBody(req);
    const items = body.rooms;
    if (!Array.isArray(items) || items.length === 0) {
      throw fail(400, "請提供 rooms 陣列");
    }

    const updated = await sql.begin(async (tx) => {
      const out = [];
      for (const r of items) {
        const serviceId = Number(r.serviceId);
        if (!Number.isInteger(serviceId)) throw fail(400, `serviceId 不合法：${r.serviceId}`);

        const price = Number(r.unitPrice);
        if (!Number.isInteger(price) || price < 0) {
          throw fail(400, `${r.roomCode || serviceId} 的定價須為非負整數`);
        }

        const [row] = await tx`
          UPDATE rooms
          SET unit_price = ${price},
              active     = ${r.active === false ? false : true}
          WHERE service_id = ${serviceId}
          RETURNING *
        `;
        if (!row) throw fail(404, `找不到 service_id = ${serviceId} 的房間`);
        out.push(row);
      }
      return out;
    });

    return res.status(200).json({
      ok: true,
      message: `已更新 ${updated.length} 間房的設定`,
      rooms: updated.map(toApi),
    });
  },
  { methods: ["GET", "PATCH"] }
);

function toApi(r) {
  return {
    serviceId: r.service_id,
    roomCode:  r.room_code,
    name:      r.name,
    storeCode: r.store_code,
    storeName: r.store_name,
    unitPrice: r.unit_price,
    active:    r.active,
  };
}
