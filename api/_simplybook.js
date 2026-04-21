// api/_simplybook.js
// SimplyBook JSON-RPC 客戶端共用模組

const SB_LOGIN_URL = "https://user-api.simplybook.asia/login";
const SB_API_URL   = "https://user-api.simplybook.asia/";
const COMPANY      = "bglescape";

// Service ID → 房間資訊對應表
export const SERVICE_MAP = {
  2:  { roomId:"A", name:"孤兒怨",   branch:"大忠店" },
  3:  { roomId:"B", name:"屎力全開", branch:"大忠店" },
  15: { roomId:"C", name:"越獄者",   branch:"大忠店" },
  14: { roomId:"D", name:"詭廁",     branch:"大忠店" },
  11: { roomId:"E", name:"詭獄",     branch:"謎先生" },
  17: { roomId:"F", name:"詭獄加場", branch:"謎先生" },
  16: { roomId:"G", name:"詭店",     branch:"謎先生" },
};

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
