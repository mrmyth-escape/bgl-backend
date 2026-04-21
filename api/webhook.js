// api/webhook.js — POST /api/webhook
// SimplyBook Webhook 接收器，同時匯出 store 供 bookings.js 合併

import { SERVICE_MAP } from "./_simplybook.js";

// 記憶體快取：bookingId → booking 物件（Serverless 同實例共用）
export const store = {};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const payload = req.body || {};
    const notification = payload.notification || payload;

    const bookingId = String(notification.booking_id || notification.id || "");
    const status    = notification.status || "booked";
    const serviceId = Number(notification.service_id || notification.event_id || 0);
    const startDt   = notification.start_date_time || notification.start_time || "";
    const date      = startDt.length >= 10 ? startDt.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const timeStr   = startDt.length >= 16 ? startDt.slice(11, 16) : "";
    const roomInfo  = SERVICE_MAP[serviceId];

    if (!bookingId) {
      return res.status(400).json({ error: "missing booking_id" });
    }

    if (status === "cancelled" || status === "deleted") {
      if (store[bookingId]) store[bookingId].status = "cancelled";
    } else {
      store[bookingId] = {
        bookingId,
        roomId:     roomInfo?.roomId  ?? null,
        roomName:   roomInfo?.name    ?? `Service ${serviceId}`,
        branch:     roomInfo?.branch  ?? "未知分店",
        serviceId,
        time:       timeStr,
        date,
        clientName: notification.client_name ?? notification.name ?? "",
        source:     "simplybook",
        status:     "booked",
      };
    }

    console.log(`[webhook] booking ${bookingId} → ${status}`);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("[webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
