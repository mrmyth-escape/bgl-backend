// api/_lib/http.js
// 共用的 HTTP 處理：CORS、驗證、錯誤回應

/**
 * 設定 CORS。ALLOWED_ORIGIN 未設定時預設放行全部（開發用）。
 * 上線後請在 Vercel 設定 ALLOWED_ORIGIN=https://你的網域
 */
export function applyCors(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (allowed !== "*") res.setHeader("Vary", "Origin");
}

/**
 * 檢查 X-Api-Key（或 ?key=）是否等於環境變數 APP_API_KEY。
 * APP_API_KEY 未設定時直接擋下 —— 結帳資料不該裸奔。
 * @returns {boolean} true 表示已回應錯誤，呼叫端應直接 return
 */
export function rejectUnauthorized(req, res) {
  const expected = process.env.APP_API_KEY;
  if (!expected) {
    res.status(500).json({ error: "APP_API_KEY 未設定，拒絕服務" });
    return true;
  }

  const provided = req.headers["x-api-key"] || req.query?.key || "";
  if (!timingSafeEqual(String(provided), expected)) {
    res.status(401).json({ error: "未授權" });
    return true;
  }
  return false;
}

/** 長度無關的字串比較，避免以回應時間猜測金鑰 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 包裝 handler：套 CORS、處理 OPTIONS、限制方法、統一錯誤格式。
 * @param {{ methods?: string[], auth?: boolean }} opts
 */
export function handler(fn, opts = {}) {
  const methods = opts.methods || ["GET"];
  const needAuth = opts.auth !== false;

  return async function wrapped(req, res) {
    applyCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();

    if (!methods.includes(req.method)) {
      return res.status(405).json({ error: `僅支援 ${methods.join(" / ")}` });
    }
    if (needAuth && rejectUnauthorized(req, res)) return;

    try {
      return await fn(req, res);
    } catch (err) {
      console.error(`[${req.url}]`, err);
      const status = err.statusCode || 500;
      return res.status(status).json({ error: err.message });
    }
  };
}

/** 丟出帶 HTTP 狀態碼的錯誤 */
export function fail(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

/** 解析 request body（Vercel 通常已解析好，這裡處理字串的情況） */
export function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      throw fail(400, "request body 不是合法 JSON");
    }
  }
  return body;
}
