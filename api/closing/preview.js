// api/closing/preview.js — GET /api/closing/preview?date=&store=
// 打烊時開啟結帳頁面用：把當日場次、既有草稿、以及頁面所需的選項一次帶回。

import { db } from "../_lib/db.js";
import { handler } from "../_lib/http.js";
import {
  loadClosing,
  normalizeClosing,
  serializeClosing,
  toApiBooking,
  defaultBusinessDate,
  assertDate,
  PAYMENT_METHODS,
  EXPENSE_CATEGORIES,
  DENOMINATIONS,
} from "../_lib/closing.js";
import { fetchDayBookings, DEFAULT_STORE } from "../_simplybook.js";

export default handler(async (req, res) => {
  const sql       = db();
  const storeCode = req.query.store || DEFAULT_STORE;
  const date      = assertDate(req.query.date || defaultBusinessDate(), "date");

  // 房間清單讓結帳頁面能手動選房間、並用定價自動算金額
  const roomRows = await sql`
    SELECT service_id, room_code, name, unit_price FROM rooms
    WHERE store_code = ${storeCode} AND active
    ORDER BY room_code
  `;

  const meta = {
    paymentMethods:    PAYMENT_METHODS,
    expenseCategories: EXPENSE_CATEGORIES,
    denominations:     DENOMINATIONS,
    rooms: roomRows.map((r) => ({
      serviceId: r.service_id,
      roomCode:  r.room_code,
      name:      r.name,
      unitPrice: r.unit_price,
    })),
  };

  // 已經有單子（草稿或已鎖定）就直接回既有內容，不要拿線上資料覆蓋店員填過的東西
  const existing = await loadClosing(sql, storeCode, date);
  if (existing) {
    return res.status(200).json({
      ok: true,
      storeCode,
      businessDate: date,
      status: existing.closing.status,
      source: "saved",
      closing: serializeClosing(existing),
      meta,
    });
  }

  // 新的一天：從訂位資料組出草稿
  const bookings = await collectBookings(sql, storeCode, date);
  const openingFloat = await lastOpeningFloat(sql, storeCode);

  const draft = normalizeClosing({
    bookings,
    payments: [],
    expenses: [],
    cashCounts: {},
    openingFloat,
  });

  return res.status(200).json({
    ok: true,
    storeCode,
    businessDate: date,
    status: "new",
    source: bookings.length ? "simplybook" : "empty",
    closing: {
      status: "new",
      businessDate: date,
      storeCode,
      openingFloat,
      bookings: draft.bookings.map(toApiBooking),
      payments: [],
      expenses: [],
      cashCounts: {},
      cashCounted: 0,
      varianceReason: null,
      notes: null,
      submittedBy: null,
      totals: draft.totals,
    },
    meta,
  });
});

/**
 * 組出當日場次：以 DB 的 bookings 為主（webhook 即時落地），
 * 再用 SimplyBook 現況補齊 / 覆蓋。SimplyBook 抓不到時仍以 DB 資料續行。
 */
async function collectBookings(sql, storeCode, date) {
  const rooms = await sql`SELECT * FROM rooms WHERE store_code = ${storeCode}`;
  const priceOf = new Map(rooms.map((r) => [r.service_id, r.unit_price]));
  const inStore = new Set(rooms.map((r) => r.service_id));

  const rows = await sql`
    SELECT * FROM bookings
    WHERE business_date = ${date} AND store_code = ${storeCode} AND status <> 'cancelled'
    ORDER BY start_time, room_code
  `;

  const byId = new Map();
  for (const r of rows) {
    byId.set(String(r.booking_id), {
      bookingId:  String(r.booking_id),
      serviceId:  r.service_id,
      roomCode:   r.room_code,
      roomName:   r.room_name,
      time:       r.start_time,
      clientName: r.client_name,
      headcount:  r.headcount || 0,
      amount:     0,
      prepaidAmount: 0,
      attended:   true,
    });
  }

  const apiKey = process.env.SB_API_KEY;
  if (apiKey) {
    try {
      for (const b of await fetchDayBookings(apiKey, date)) {
        if (b.status === "cancelled") { byId.delete(b.bookingId); continue; }
        if (!inStore.has(b.serviceId)) continue;
        byId.set(b.bookingId, {
          bookingId:     b.bookingId,
          serviceId:     b.serviceId,
          roomCode:      b.roomCode,
          roomName:      b.roomName,
          time:          b.time,
          clientName:    b.clientName,
          headcount:     b.headcount,
          amount:        b.amount,
          prepaidAmount: b.prepaidAmount,
          attended:      true,
        });
      }
    } catch (err) {
      // 訂位系統掛掉不該擋住打烊結帳，記 log 後改用 DB 既有資料
      console.error("[preview] SimplyBook 讀取失敗，改用資料庫既有訂位：", err.message);
    }
  }

  // SimplyBook 沒帶金額時，用房間定價 × 人數推估，店員可在頁面上調整
  return [...byId.values()].map((b) => {
    if (!b.amount) {
      const unit = priceOf.get(b.serviceId) || 0;
      b.amount = unit * (b.headcount || 0);
    }
    return b;
  });
}

/** 沿用上一次日結的零用金設定，店員不用每天重打 */
async function lastOpeningFloat(sql, storeCode) {
  const [row] = await sql`
    SELECT opening_float FROM daily_closings
    WHERE store_code = ${storeCode} AND status = 'locked'
    ORDER BY business_date DESC LIMIT 1
  `;
  return row?.opening_float ?? 0;
}

