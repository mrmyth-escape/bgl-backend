// api/_lib/stats.js
// 給「異常提醒」用的歷史基準值

/**
 * 同一個星期幾、近 8 次已結帳日的平均營收。
 * 用來判斷今天是不是特別好或特別差 —— 拿星期一比星期六沒有意義，所以按星期分開算。
 * 資料不足（少於 3 次）時回傳 0，代表還沒有可靠基準，不做比較。
 *
 * @returns {Promise<number>} 平均營收（元），無基準時為 0
 */
export async function avgSameWeekday(sql, storeCode, businessDate) {
  const rows = await sql`
    SELECT actual_total FROM daily_closings
    WHERE store_code = ${storeCode}
      AND status = 'locked'
      AND business_date < ${businessDate}
      AND EXTRACT(ISODOW FROM business_date) = EXTRACT(ISODOW FROM ${businessDate}::date)
    ORDER BY business_date DESC
    LIMIT 8
  `;

  if (rows.length < 3) return 0;
  return rows.reduce((s, r) => s + r.actual_total, 0) / rows.length;
}

/**
 * 區間內沒有結帳的日期（不含今天，今天可能還沒打烊）。
 * @returns {Promise<string[]>} YYYY-MM-DD 陣列
 */
export async function missingClosings(sql, storeCode, from, to) {
  const rows = await sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS date
    FROM generate_series(${from}::date, ${to}::date, '1 day') AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM daily_closings
      WHERE store_code = ${storeCode} AND status = 'locked' AND business_date = d
    )
    ORDER BY d
  `;
  return rows.map((r) => r.date);
}
