// api/reports/monthly.js — GET /api/reports/monthly?month=YYYY-MM&store=
// 單月結算：總覽、每日、各房間、各收款方式、雜支、平日假日、時段熱度。
// 一律只採計已鎖定（locked）的日結單，草稿不列入。

import { db } from "../_lib/db.js";
import { handler } from "../_lib/http.js";
import { assertMonth, toTaipeiDate, dateStr } from "../_lib/closing.js";
import { DEFAULT_STORE } from "../_lib/store.js";

export default handler(async (req, res) => {
  const sql       = db();
  const storeCode = req.query.store || DEFAULT_STORE;
  const month     = assertMonth(req.query.month || toTaipeiDate().slice(0, 7), "month");

  const from = `${month}-01`;
  const to   = monthEnd(month);

  const [summaryRow] = await sql`
    SELECT
      COUNT(*)::int                    AS days,
      COALESCE(SUM(expected_revenue),0)::int AS gross_revenue,
      COALESCE(SUM(discount_total),0)::int   AS discount_total,
      COALESCE(SUM(actual_total),0)::int     AS revenue,
      COALESCE(SUM(expense_total),0)::int    AS expense_total,
      COALESCE(SUM(ABS(variance)),0)::int    AS abs_variance,
      COUNT(*) FILTER (WHERE variance <> 0 OR cash_variance <> 0)::int AS variance_days
    FROM daily_closings
    WHERE store_code = ${storeCode} AND status = 'locked'
      AND business_date BETWEEN ${from} AND ${to}
  `;

  const [daily, byItem, byMethod, byExpense, byWeekday] = await Promise.all([
    sql`
      SELECT business_date, actual_total, expected_revenue, discount_total,
             expense_total, variance, cash_variance
      FROM daily_closings
      WHERE store_code = ${storeCode} AND status = 'locked'
        AND business_date BETWEEN ${from} AND ${to}
      ORDER BY business_date
    `,
    sql`
      SELECT rl.item_name,
             COUNT(*)::int                   AS days,
             COALESCE(SUM(rl.amount),0)::int AS revenue
      FROM closing_revenue_lines rl
      JOIN daily_closings dc ON dc.id = rl.closing_id
      WHERE dc.store_code = ${storeCode} AND dc.status = 'locked'
        AND dc.business_date BETWEEN ${from} AND ${to}
      GROUP BY rl.item_name
      ORDER BY revenue DESC
    `,
    sql`
      SELECT pl.method_name AS method, COALESCE(SUM(pl.amount),0)::int AS amount
      FROM payment_lines pl
      JOIN daily_closings dc ON dc.id = pl.closing_id
      WHERE dc.store_code = ${storeCode} AND dc.status = 'locked'
        AND dc.business_date BETWEEN ${from} AND ${to}
      GROUP BY pl.method_name
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
             COALESCE(SUM(actual_total),0)::int     AS revenue
      FROM daily_closings
      WHERE store_code = ${storeCode} AND status = 'locked'
        AND business_date BETWEEN ${from} AND ${to}
      GROUP BY weekday ORDER BY weekday
    `,
  ]);

  const revenue = summaryRow.revenue;

  return res.status(200).json({
    ok: true,
    storeCode,
    month,
    summary: {
      daysClosed:    summaryRow.days,
      grossRevenue:  summaryRow.gross_revenue,
      discountTotal: summaryRow.discount_total,
      revenue,                                   // 實際收到的錢
      expenseTotal:  summaryRow.expense_total,
      netRevenue:    revenue - summaryRow.expense_total,
      avgPerDay:     summaryRow.days ? Math.round(revenue / summaryRow.days) : 0,
      discountRate:  summaryRow.gross_revenue
        ? Math.round((summaryRow.discount_total / summaryRow.gross_revenue) * 1000) / 10 : 0,
      varianceDays:  summaryRow.variance_days,
      absVariance:   summaryRow.abs_variance,
    },
    daily: daily.map((d) => ({
      date:         dateStr(d.business_date),
      revenue:      d.actual_total,
      grossRevenue: d.expected_revenue,
      discount:     d.discount_total,
      expense:      d.expense_total,
      variance:     d.variance,
      cashVariance: d.cash_variance,
    })),
    byItem: byItem.map((r) => ({
      itemName: r.item_name,
      days:     r.days,
      revenue:  r.revenue,
      share:    summaryRow.gross_revenue
        ? Math.round((r.revenue / summaryRow.gross_revenue) * 1000) / 10 : 0,
    })),
    byPaymentMethod: byMethod.map((m) => ({
      method: m.method,
      amount: m.amount,
      share:  revenue ? Math.round((m.amount / revenue) * 1000) / 10 : 0,
    })),
    byExpenseCategory: byExpense.map((e) => ({ category: e.category, amount: e.amount })),
    byWeekday: byWeekday.map((w) => ({
      weekday:    w.weekday,                 // 1 = 週一
      label:      ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"][w.weekday],
      days:       w.days,
      revenue:    w.revenue,
      avgRevenue: w.days ? Math.round(w.revenue / w.days) : 0,
    })),
  });
});

function monthEnd(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
