// api/webhook.js — POST /api/webhook
// SimplyBook Webhook 接收器。
//
// 原本這裡把訂位寫在記憶體物件裡，在 Vercel 上每次呼叫都可能是新的實例，
// 而且 bookings.js import 到的是「另一份」空物件 —— 資料等於沒有留下。
// 現在一律寫入資料庫。

import { db } from "./_lib/db.js";
import { applyCors } from "./_lib/http.js";
import { SERVICE_MAP, normalizeBooking } from "./_simplybook.js";
import { toTaipeiDate } from "./_lib/closing.js";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "僅支援 POST" });

  // SimplyBook 不簽章，所以用共用密鑰擋掉偽造請求。
  // 設定 SB_WEBHOOK_SECRET 後，webhook 網址要帶 ?secret=xxx
  const secret = process.env.SB_WEBHOOK_SECRET;
  if (secret && req.query?.secret !== secret) {
    return res.status(401).json({ error: "未授權" });
  }

  try {
    const payload      = req.body || {};
    const notification = payload.notification || payload;

    const bookingId = String(notification.booking_id || notification.id || "");
    if (!bookingId) return res.status(400).json({ error: "缺少 booking_id" });

    const sql       = db();
    const b         = normalizeBooking(notification, toTaipeiDate());
    const rawStatus = String(notification.status || "").toLowerCase();
    const cancelled =
      b.status === "cancelled" || rawStatus === "cancelled" || rawStatus === "deleted";

    const room = SERVICE_MAP[b.serviceId];

    await sql`
      INSERT INTO bookings (
        booking_id, service_id, room_code, room_name, store_code,
        business_date, start_time, client_name, headcount, status, source, raw, updated_at
      ) VALUES (
        ${bookingId}, ${b.serviceId || null}, ${room?.roomId ?? null}, ${b.roomName},
        ${room?.storeCode ?? null}, ${b.date}, ${b.time}, ${b.clientName},
        ${b.headcount}, ${cancelled ? "cancelled" : "booked"}, 'simplybook',
        ${sql.json(notification)}, now()
      )
      ON CONFLICT (booking_id) DO UPDATE SET
        service_id    = EXCLUDED.service_id,
        room_code     = EXCLUDED.room_code,
        room_name     = EXCLUDED.room_name,
        store_code    = EXCLUDED.store_code,
        business_date = EXCLUDED.business_date,
        start_time    = EXCLUDED.start_time,
        client_name   = EXCLUDED.client_name,
        headcount     = EXCLUDED.headcount,
        status        = EXCLUDED.status,
        raw           = EXCLUDED.raw,
        updated_at    = now()
    `;

    console.log(`[webhook] booking ${bookingId} → ${cancelled ? "cancelled" : "booked"}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[webhook] 失敗：", err);
    return res.status(500).json({ error: err.message });
  }
}
