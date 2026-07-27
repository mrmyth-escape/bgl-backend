// api/_simplybook.js
// SimplyBook JSON-RPC 客戶端共用模組

const SB_LOGIN_URL = "https://user-api.simplybook.asia/login";
const SB_API_URL   = "https://user-api.simplybook.asia/";
const COMPANY      = "bglescape";

// Service ID → 房間資訊對應表
// storeCode 是本系統內部的分店代號，資料表 rooms 以此欄位為準
export const SERVICE_MAP = {
  2:  { roomId:"A", name:"孤兒怨",   branch:"大忠店", storeCode:"dazhong" },
  3:  { roomId:"B", name:"屎力全開", branch:"大忠店", storeCode:"dazhong" },
  15: { roomId:"C", name:"越獄者",   branch:"大忠店", storeCode:"dazhong" },
  14: { roomId:"D", name:"詭廁",     branch:"大忠店", storeCode:"dazhong" },
  11: { roomId:"E", name:"詭獄",     branch:"謎先生", storeCode:"mrmyth" },
  17: { roomId:"F", name:"詭獄加場", branch:"謎先生", storeCode:"mrmyth" },
  16: { roomId:"G", name:"詭店",     branch:"謎先生", storeCode:"mrmyth" },
};

/** 預設分店：初期只做大忠店 */
export const DEFAULT_STORE = "dazhong";

// Token 快取（Vercel Serverless 同一實例內共用，跨 invocation 不保證）
let _tokenCache = null;
let _tokenExpiry = 0;

/**
 * 取得 SimplyBook User API token
 * @param {string} apiKey - 從 Vercel 環境變數 SB_API_KEY 取得
 * @returns {Promise<string>} token
 */
export async function getToken(apiKey) {
  const now = Date.now();
  if (_tokenCache && now < _tokenExpiry) return _tokenCache;

  const resp = await fetch(SB_LOGIN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "getToken",
      params:  [COMPANY, "api", apiKey],
    }),
  });

  if (!resp.ok) throw new Error(`SimplyBook login HTTP ${resp.status}`);

  const data = await resp.json();
  if (data.error) throw new Error(`SimplyBook login error: ${JSON.stringify(data.error)}`);

  const token = data.result;
  if (!token) throw new Error("SimplyBook 未回傳 token");

  _tokenCache  = token;
  _tokenExpiry = now + 50 * 60 * 1000; // 50 分鐘（token 有效期 1 小時）
  return token;
}

/**
 * 呼叫 SimplyBook JSON-RPC API
 * @param {string} method - API 方法名稱
 * @param {Array}  params - 參數陣列
 * @param {string} token  - 由 getToken() 取得
 * @returns {Promise<any>} result
 */
export async function sbCall(method, params, token) {
  const resp = await fetch(SB_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Company-Login": COMPANY,
      "X-Token":         token,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method,
      params,
    }),
  });

  if (!resp.ok) throw new Error(`SimplyBook API HTTP ${resp.status}`);

  const data = await resp.json();
  if (data.error) throw new Error(`SimplyBook API error [${method}]: ${JSON.stringify(data.error)}`);

  return data.result;
}

/**
 * SimplyBook 各版本欄位名稱不一致，這裡把可能的欄位都試一遍。
 * 找不到就回傳 fallback，讓店員在結帳頁面手動補。
 */
function pick(obj, keys, fallback = null) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

/**
 * 取得某日的訂位清單，並正規化成本系統的格式。
 * @param {string} apiKey
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<Array>} 正規化後的訂位
 */
export async function fetchDayBookings(apiKey, date) {
  const token = await getToken(apiKey);
  const result = await sbCall(
    "getBookingList",
    [{ date_from: date, date_to: date, status: ["approved", "confirmed", "pending"] }],
    token
  );

  return (result || []).map((b) => normalizeBooking(b, date));
}

/** 把 SimplyBook 的一筆訂位轉成本系統格式 */
export function normalizeBooking(b, fallbackDate) {
  const serviceId = Number(pick(b, ["service_id", "event_id"], 0));
  const room      = SERVICE_MAP[serviceId];

  const startDt = String(pick(b, ["start_date_time", "start_date", "start_time"], ""));
  const date    = startDt.length >= 10 ? startDt.slice(0, 10) : fallbackDate;
  const time    = startDt.length >= 16 ? startDt.slice(11, 16) : "";

  const headcount = Number(pick(b, ["qty", "quantity", "count", "unit_count"], 0)) || 0;
  const amount    = Number(pick(b, ["amount", "price", "total_price", "invoice_amount"], 0)) || 0;
  const prepaid   = Number(pick(b, ["client_paid", "paid_amount", "deposit"], 0)) || 0;

  const rawStatus = String(pick(b, ["status"], "booked")).toLowerCase();
  const cancelled = rawStatus === "cancelled" || rawStatus === "canceled" || rawStatus === "deleted";

  return {
    bookingId:     String(pick(b, ["id", "booking_id"], "")),
    serviceId,
    roomCode:      room?.roomId ?? null,
    roomName:      room?.name ?? `Service ${serviceId}`,
    storeCode:     room?.storeCode ?? null,
    branch:        room?.branch ?? "未知分店",
    date,
    time,
    clientName:    String(pick(b, ["client_name", "name", "client"], "")),
    headcount,
    amount,
    prepaidAmount: prepaid,
    status:        cancelled ? "cancelled" : "booked",
    source:        "simplybook",
  };
}
