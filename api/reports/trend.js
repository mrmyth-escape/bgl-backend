// api/reports/trend.js — GET /api/reports/trend?months=12&store=
// 逐月趨勢：營收、人次、客單價，以及與上月／去年同期的比較。

import { db } from "../_lib/db.js";
import { handler } from "../_lib/http.js";
import { toTaipeiDate } from "../_lib/closing.js";
import { DEFAULT_STORE } from "../_simplybook.js";

export default handler(async (req, res) => {
  const sql       = db();
  const storeCode = req.query.store || DEFAULT_STORE;
  const months    = clamp(Number(req.query.months) || 12, 1, 60);

  const to   = toTaipeiDate().slice(0, 7);
  const from = shiftMonth(to, -(months - 1));

  const rows = await sql`
    SELECT to_char(business_date, 'YYYY-MM')        AS month,
           COUNT(*)::int                            AS days,
           COALESCE(SUM(actual_total),0)::int       AS revenue,
           COALESCE(SUM(expense_total),0)::int      AS expense,
           COALESCE(SUM(headcount_total),0)::int    AS headcount,
           COALESCE(SUM(session_count),0)::int      AS sessions
    FROM daily_closings
    WHERE store_code = ${storeCode} AND status = 'locked'
      AND business_date >= ${`${from}-01`}
    GROUP BY month
    ORDER BY month
  `;

  const byMonth = new Map(rows.map((r) => [r.month, r]));

  // 補齊沒有資料的月份，圖表才不會斷線
  const series = [];
  for (let i = 0; i < months; i++) {
    const month = shiftMonth(from, i);
    const r = byMonth.get(month);
    const revenue   = r?.revenue   ?? 0;
    const headcount = r?.headcount ?? 0;
    const sessions  = r?.sessions  ?? 0;
    const expense   = r?.expense   ?? 0;

    series.push({
      month,
      days:           r?.days ?? 0,
      revenue,
      expense,
      netRevenue:     revenue - expense,
      headcount,
      sessions,
      avgPerCustomer: headcount ? Math.round(revenue / headcount) : 0,
      avgPerDay:      r?.days ? Math.round(revenue / r.days) : 0,
    });
  }

  // 每個月補上與上月、去年同期的變化率
  const idx = new Map(series.map((s, i) => [s.month, i]));
  for (const s of series) {
    s.momChange = pct(s.revenue, series[idx.get(s.month) - 1]?.revenue);
    s.yoyChange = pct(s.revenue, series[idx.get(shiftMonth(s.month, -12))]?.revenue);
  }

  const latest = series[series.length - 1];
  const total  = series.reduce((s, m) => s + m.revenue, 0);
  const activeMonths = series.filter((m) => m.days > 0).length;

  return res.status(200).json({
    ok: true,
    storeCode,
    from,
    to,
    series,
    summary: {
      totalRevenue:     total,
      avgMonthlyRevenue: activeMonths ? Math.round(total / activeMonths) : 0,
      bestMonth:  pickBy(series, (a, b) => a.revenue > b.revenue),
      worstMonth: pickBy(series.filter((m) => m.days > 0), (a, b) => a.revenue < b.revenue),
      latest,
    },
  });
});

/** 變化百分比，取一位小數；沒有比較基準回傳 null */
function pct(current, base) {
  if (!base) return null;
  return Math.round(((current - base) / base) * 1000) / 10;
}

function pickBy(list, better) {
  return list.reduce((best, m) => (best === null || better(m, best) ? m : best), null);
}

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
