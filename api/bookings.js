// api/bookings.js — GET /api/bookings?date=&store=
// 當日訂位清單。以資料庫為底（webhook 落地的資料），SimplyBook 現況優先覆蓋。

import { db } from "./_lib/db.js";
import { handler } from "./_lib/http.js";
import { fetchDayBookings, SERVICE_MAP } from "./_simplybook.js";
import { defaultBusinessDate, assertDate } from "./_lib/closing.js";

export default handler(async (req, res) => {
  const sql   = db();
  const date  = assertDate(req.query.date || defaultBusinessDate(), "date");
  const store = req.query.store || null;

  const rows = await sql`
    SELECT * FROM bookings
    WHERE business_date = ${date} AND status <> 'cancelled'
    ORDER BY start_time, room_code
  `;

  const byId = new Map(
    rows.map((r) => [
      String(r.booking_id),
      {
        bookingId:     String(r.booking_id),
        serviceId:     r.service_id,
        roomCode:      r.room_code,
        roomName:      r.room_name,
        storeCode:     r.store_code,
        branch:        SERVICE_MAP[r.service_id]?.branch ?? "未知分店",
        date,
        time:          r.start_time,
        clientName:    r.client_name,
        headcount:     r.headcount || 0,
        amount:        0,
        prepaidAmount: 0,
        status:        r.status,
        source:        r.source,
      },
    ])
  );

  let simplybookOk = false;
  const apiKey = process.env.SB_API_KEY;
  if (apiKey) {
    try {
      for (const b of await fetchDayBookings(apiKey, date)) {
        if (b.status === "cancelled") byId.delete(b.bookingId);
        else byId.set(b.bookingId, b);
      }
      simplybookOk = true;
    } catch (err) {
      console.error("[bookings] SimplyBook 讀取失敗，僅回傳資料庫資料：", err.message);
    }
  }

  let bookings = [...byId.values()];
  if (store) bookings = bookings.filter((b) => b.storeCode === store);
  bookings.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));

  return res.status(200).json({
    ok: true,
    date,
    store,
    simplybookOk,
    count: bookings.length,
    bookings,
  });
});
