// api/webhook.js
// ── SimplyBook Webhook 接收端點 ──────────────────────────
// SimplyBook 後台 → Custom Features → API → 回撥網址
// 填入：https://你的vercel網域.vercel.app/api/webhook
//
// SimplyBook 每次有以下事件會 POST 到這個網址：
//   notification_type: "new"（新預約）/ "change"（修改）/ "cancel"（取消）/ "remind"（提醒）
// POST body 格式（x-www-form-urlencoded）：
//   booking_id, booking_hash, company, notification_type

import { getToken, sbCall, SERVICE_MAP } from "./_simplybook.js";

// ── 全域 in-memory 儲存 ──────────────────────────────────
// Vercel Serverless 無狀態，這裡的資料只在同一個 instance 存活
// 正式上線建議換成 Vercel KV 或 Supabase（免費額度夠用）
// 目前版本已足夠讓前端輪詢取得最新預約狀態
if (!global._bookingStore) global._bookingStore = {};
const store = global._bookingStore;

export default async function handler(req, res) {
  // ── CORS preflight ──
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ── 僅接受 POST ──
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // SimplyBook 傳的是 form-urlencoded，也可能是 JSON，兩種都接
    const body = typeof req.body === "string"
      ? Object.fromEntries(new URLSearchParams(req.body))
      : req.body;

    const { booking_id, notification_type, company } = body;

    // 基本驗證
    if (!booking_id || !notification_type) {
      return res.status(400).json({ error: "Missing booking_id or notification_type" });
    }

    // 確認是我們自己的公司（防止惡意 POST）
    if (company && company !== "bglescape") {
      return res.status(403).json({ error: "Unauthorized company" });
    }

    const apiKey = process.env.SB_API_KEY;
    if (!apiKey) {
      console.error("SB_API_KEY 環境變數未設定");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    // ── 取消預約：從 store 移除 ──
    if (notification_type === "cancel") {
      delete store[booking_id];
      console.log(`[Webhook] 取消預約 booking_id=${booking_id}`);
      return res.status(200).json({ ok: true, action: "cancelled" });
    }

    // ── 新預約 / 修改：向 SimplyBook 查詢詳細資料 ──
    const token = await getToken(apiKey);

    // getBookingDetails 回傳單筆預約資料
    const detail = await sbCall("getBookingDetails", [booking_id], token);

    if (!detail) {
      return res.status(404).json({ error: "Booking not found in SimplyBook" });
    }

    const serviceId  = Number(detail.service_id || detail.event_id);
    const roomInfo   = SERVICE_MAP[serviceId];
    const startTime  = detail.start_date_time || detail.start_time || "";
    // 取出 HH:MM 部分（SimplyBook 格式通常是 "2026-04-20 14:00:00"）
    const timeStr    = startTime.length >= 16 ? startTime.slice(11, 16) : startTime;

    const booking = {
      bookingId:    booking_id,
      roomId:       roomInfo?.roomId    ?? null,
      roomName:     roomInfo?.name      ?? `Service ${serviceId}`,
      branch:       roomInfo?.branch    ?? "未知分店",
      serviceId,
      time:         timeStr,
      date:         startTime.slice(0, 10),
      clientName:   detail.client_name  ?? detail.name ?? "",
      clientPhone:  detail.client_phone ?? "",
      source:       "simplybook",
      status:       notification_type === "cancel" ? "cancelled" : "booked",
      updatedAt:    new Date().toISOString(),
    };

    store[booking_id] = booking;
    console.log(`[Webhook] ${notification_type} booking_id=${booking_id} room=${booking.roomName} time=${booking.time}`);

    return res.status(200).json({ ok: true, action: notification_type, booking });

  } catch (err) {
    console.error("[Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// 讓其他 API route 可以讀取 store
export { store };
