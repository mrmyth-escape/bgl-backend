// api/reports/monthly.js — GET /api/reports/monthly?month=YYYY-MM&store=
// 單月結算：總覽、每日、各房間、各收款方式、雜支、平日假日、時段熱度。
// 一律只採計已鎖定（locked）的日結單，草稿不列入。

import { db } from "../_lib/db.js";
import { handler } from "../_lib/http.js";
import { assertMonth, toTaipeiDate, dateStr } from "../_lib/closing.js";
import { DEFAULT_STORE } from "../_simplybook.js";

export default handler(async (req, res) => {
  const sql       = db();
  const storeCode = req.query.store || DEFAULT_STORE;
  const month     = assertMonth(req.query.month || toTaipeiDate().slice(0, 7), "month");

  const from = `${month}-01`;
  const to   = monthEnd(month);

  const [summaryRow] = await sql`
    SELECT
      COUNT(*)::int                    AS days,
      COALESCE(SUM(expected_revenue),0)::int AS expected_revenue,
      COALESCE(SUM(actual_total),0)::int     AS revenue,
      COALESCE(SUM(expense_total),0)::int    AS expense_total,
      COALESCE(SUM(headcount_total),0)::int  AS headcount,
      COALESCE(SUM(session_count),0)::int    AS sessions,
      COALESCE(SUM(ABS(variance)),0)::int    AS abs_variance,
      COUNT(*) FILTER (WHERE variance <> 0 OR cash_variance <> 0)::int AS variance_days
    FROM daily_closings
    WHERE store_code = ${storeCode} AND status = 'locked'
      AND business_date BETWEEN ${from} AND ${to}
  `;

  const [daily, byRoom, byMethod, byExpense, byWeekday, byHour] = await Promise.all([
    sql`
      SELECT business_date, actual_total, expense_total, headcount_total,
             session_count, variance, cash_variance
      FROM daily_closings
      WHERE store_code = ${storeCode} AND status = 'locked'
        AND business_date BETWEEN ${from} AND ${to}
      ORDER BY business_date
    `,
    sql`
      SELECT cb.room_code, cb.room_name,
             COUNT(*)::int                AS sessions,
             COALESCE(SUM(cb.headcount),0)::int AS headcount,
             COALESCE(SUM(cb.amount),0)::int    AS revenue
      FROM closing_bookings cb
      JOIN daily_closings dc ON dc.id = cb.closing_id
      WHERE dc.store_code = ${storeCode} AND dc.status = 'locked'
        AND dc.business_date BETWEEN ${from} AND ${to}
        AND cb.attended
      GROUP BY cb.room_code, cb.room_name
      ORDER BY revenue DESC
    `,
    sql`
      SELECT pl.method, COALESCE(SUM(pl.amount),0)::int AS amount
      FROM payment_lines pl
      JOIN daily_closings dc ON dc.id = pl.closing_id
      WHERE dc.store_code = ${storeCode} AND dc.status = 'locked'
        AND dc.business_date BETWEEN ${from} AND ${to}
      GROUP BY pl.method
      ORDER BY amount DESC
    `,
    sql`
      SELECT el.category, COALESCE(SUM(el.amount),0)::int AS amount
      FROM expense_lines el
      JOIN daily_closings dc ON dc.id = el.closing_id
      WHERE dc.store_code = ${storeCode} AND dc.status = 'locked'
        AND dc.business_date BETWEEN ${from} AND ${to}
      GROUP BY el.category
      ORDER BY amount DESC
    `,
    sql`
      SELECT EXTRACT(ISODOW FROM business_date)::int AS weekday,
             COUNT(*)::int                          AS days,
             COALESCE(SUM(actual_total),0)::int     AS revenue,
             COALESCE(SUM(headcount_total),0)::int  AS headcount
      FROM daily_closings
      WHERE store_code = ${storeCode} AND status = 'locked'
        AND business_date BETWEEN ${from} AND ${to}
      GROUP BY weekday ORDER BY weekday
    `,
    sql`
      SELECT LEFT(cb.start_time, 2) AS hour,
             COUNT(*)::int                      AS sessions,
             COALESCE(SUM(cb.headcount),0)::int AS headcount,
             COALESCE(SUM(cb.amount),0)::int    AS revenue
      FROM closing_bookings cb
      JOIN daily_closings dc ON dc.id = cb.closing_id
      WHERE dc.store_code = ${storeCode} AND dc.status = 'locked'
        AND dc.business_date BETWEEN ${from} AND ${to}
        AND cb.attended AND cb.start_time IS NOT NULL AND cb.start_time <> ''
      GROUP BY hour ORDER BY hour
    `,
  ]);

  const revenue   = summaryRow.revenue;
  const headcount = summaryRow.headcount;
  const sessions  = summaryRow.sessions;

  return res.status(200).json({
    ok: true,
    storeCode,
    month,
    summary: {
      daysClosed:      summaryRow.days,
      revenue,
      expectedRevenue: summaryRow.expected_revenue,
      expenseTotal:    summaryRow.expense_total,
      netRevenue:      revenue - summaryRow.expense_total,
      headcount,
      sessions,
      avgPerCustomer:  headcount ? Math.round(revenue / headcount) : 0,
      avgPerSession:   sessions  ? Math.round(revenue / sessions)  : 0,
      avgPerDay:       summaryRow.days ? Math.round(revenue / summaryRow.days) : 0,
      varianceDays:    summaryRow.variance_days,
      absVariance:     summaryRow.abs_variance,
    },
    daily: daily.map((d) => ({
      date:      dateStr(d.business_date),
      revenue:   d.actual_total,
      expense:   d.expense_total,
      headcount: d.headcount_total,
      sessions:  d.session_count,
      variance:  d.variance,
      cashVariance: d.cash_variance,
    })),
    byRoom: byRoom.map((r) => ({
      roomCode:  r.room_code,
      roomName:  r.room_name,
      sessions:  r.sessions,
      headcount: r.headcount,
      revenue:   r.revenue,
      share:     revenue ? Math.round((r.revenue / revenue) * 1000) / 10 : 0,
    })),
    byPaymentMethod: byMethod.map((m) => ({
      method: m.method,
      amount: m.amount,
      share:  revenue ? Math.round((m.amount / revenue) * 1000) / 10 : 0,
    })),
    byExpenseCategory: byExpense.map((e) => ({ category: e.category, amount: e.amount })),
    byWeekday: byWeekday.map((w) => ({
      weekday:   w.weekday,                 // 1 = 週一
      label:     ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"][w.weekday],
      days:      w.days,
      revenue:   w.revenue,
      headcount: w.headcount,
      avgRevenue: w.days ? Math.round(w.revenue / w.days) : 0,
    })),
    byHour: byHour.map((h) => ({
      hour:      h.hour,
      sessions:  h.sessions,
      headcount: h.headcount,
      revenue:   h.revenue,
    })),
  });
});

function monthEnd(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
