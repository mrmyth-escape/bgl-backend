// api/closing/list.js — GET /api/closing/list?from=&to=&store=
// 日結單清單，順便回報區間內「漏結帳」的日期。

import { db } from "../_lib/db.js";
import { handler } from "../_lib/http.js";
import { assertDate, defaultBusinessDate, dateStr } from "../_lib/closing.js";
import { DEFAULT_STORE } from "../_lib/store.js";

export default handler(async (req, res) => {
  const sql       = db();
  const storeCode = req.query.store || DEFAULT_STORE;
  const to        = assertDate(req.query.to || defaultBusinessDate(), "to");
  const from      = assertDate(req.query.from || shiftDays(to, -30), "from");

  const rows = await sql`
    SELECT business_date, status, expected_revenue, actual_total, variance,
           cash_variance, expense_total, headcount_total, session_count,
           submitted_by, submitted_at
    FROM daily_closings
    WHERE store_code = ${storeCode}
      AND business_date BETWEEN ${from} AND ${to}
    ORDER BY business_date DESC
  `;

  const closings = rows.map((r) => ({
    businessDate:    dateStr(r.business_date),
    status:          r.status,
    expectedRevenue: r.expected_revenue,
    actualTotal:     r.actual_total,
    variance:        r.variance,
    cashVariance:    r.cash_variance,
    expenseTotal:    r.expense_total,
    headcountTotal:  r.headcount_total,
    sessionCount:    r.session_count,
    submittedBy:     r.submitted_by,
    submittedAt:     r.submitted_at,
  }));

  // 漏結帳偵測：區間內沒有 locked 單子的日期（不含今天，今天可能還沒打烊）
  const locked = new Set(closings.filter((c) => c.status === "locked").map((c) => c.businessDate));
  const today  = defaultBusinessDate();
  const missing = [];
  for (let d = from; d <= to; d = shiftDays(d, 1)) {
    if (d !== today && !locked.has(d)) missing.push(d);
  }

  return res.status(200).json({
    ok: true,
    storeCode,
    from,
    to,
    count: closings.length,
    closings,
    missingDates: missing,
  });
});

function shiftDays(dateStrIn, days) {
  const d = new Date(`${dateStrIn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
