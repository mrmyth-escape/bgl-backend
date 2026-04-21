// api/bookings.js
import { getToken, sbCall, SERVICE_MAP } from "./_simplybook.js";
import { store } from "./webhook.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const apiKey = process.env.SB_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SB_API_KEY 未設定" });
    const today = req.query.date || new Date().toISOString().slice(0, 10);
    const token = await getToken(apiKey);
    const sbBookings = await sbCall("getBookingList", [{ date_from: today, date_to: today, status: ["approved", "confirmed", "pending"] }], token);
    const bookings = (sbBookings || []).map(b => {
      const serviceId = Number(b.service_id || b.event_id);
      const roomInfo = SERVICE_MAP[serviceId];
      const startTime = b.start_date_time || b.start_time || "";
      const timeStr = startTime.length >= 16 ? startTime.slice(11, 16) : startTime;
      return { bookingId: b.id, roomId: roomInfo?.roomId ?? null, roomName: roomInfo?.name ?? `Service ${serviceId}`, branch: roomInfo?.branch ?? "未知分店", serviceId, time: timeStr, date: today, clientName: b.client_name ?? b.name ?? "", source: "simplybook", status: "booked" };
    });
    const todayFromStore = Object.values(store).filter(b => b.date === today);
    todayFromStore.forEach(wb => {
      const idx = bookings.findIndex(b => b.bookingId === wb.bookingId);
      if (idx >= 0) bookings[idx] = { ...bookings[idx], ...wb };
      else if (wb.status !== "cancelled") bookings.push(wb);
    });
    const active = bookings.filter(b => b.status !== "cancelled");
    return res.status(200).json({ ok: true, date: today, count: active.length, bookings: active });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
