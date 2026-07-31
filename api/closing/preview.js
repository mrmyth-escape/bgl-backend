// api/closing/preview.js — GET /api/closing/preview?date=&store=
// 打烊時開啟結帳頁面用：把既有內容、可填的項目、員工名單一次帶回。

import { db } from "../_lib/db.js";
import { handler } from "../_lib/http.js";
import {
  loadClosing,
  serializeClosing,
  defaultBusinessDate,
  assertDate,
  EXPENSE_CATEGORIES,
  DENOMINATIONS,
} from "../_lib/closing.js";
import { missingClosings } from "../_lib/stats.js";
import { DEFAULT_STORE } from "../_lib/store.js";

export default handler(async (req, res) => {
  const sql       = db();
  const storeCode = req.query.store || DEFAULT_STORE;
  const date      = assertDate(req.query.date || defaultBusinessDate(), "date");

  const [revenueItems, paymentMethods, staffRows, pending] = await Promise.all([
    sql`SELECT id, name FROM revenue_items
        WHERE store_code = ${storeCode} AND active ORDER BY sort_order, id`,
    sql`SELECT id, name, is_cash FROM payment_methods
        WHERE store_code = ${storeCode} AND active ORDER BY sort_order, id`,
    sql`SELECT id, name FROM staff
        WHERE store_code = ${storeCode} AND active ORDER BY name`,
    // 前幾天有沒有漏結帳 —— 開頁面時就提醒，不要等到月底才發現
    missingClosings(sql, storeCode, shiftDays(date, -7), shiftDays(date, -1)),
  ]);

  const meta = {
    revenueItems:      revenueItems.map((r) => ({ id: r.id, name: r.name })),
    paymentMethods:    paymentMethods.map((p) => ({ id: p.id, name: p.name, isCash: p.is_cash })),
    staff:             staffRows.map((s) => ({ id: s.id, name: s.name })),
    expenseCategories: EXPENSE_CATEGORIES,
    denominations:     DENOMINATIONS,
  };

  // 已經有單子（草稿或已鎖定）就直接回既有內容
  const existing = await loadClosing(sql, storeCode, date);
  if (existing) {
    return res.status(200).json({
      ok: true, storeCode, businessDate: date,
      status: existing.closing.status,
      pendingClosings: pending,
      closing: serializeClosing(existing),
      meta,
    });
  }

  // 新的一天：空白表單，零用金沿用上一次
  const openingFloat = await lastOpeningFloat(sql, storeCode);

  return res.status(200).json({
    ok: true, storeCode, businessDate: date,
    status: "new",
    pendingClosings: pending,
    closing: {
      status: "new", businessDate: date, storeCode,
      openingFloat, discountTotal: 0, cashCounted: 0,
      revenues: [], payments: [], expenses: [], cashCounts: {},
      varianceReason: null, notes: null, staffId: null, submittedBy: null,
      totals: {
        expected_revenue: 0, discount_total: 0, net_expected: 0,
        actual_total: 0, variance: 0,
        opening_float: openingFloat, expected_cash: openingFloat,
        cash_counted: 0, cash_variance: -openingFloat, expense_total: 0,
      },
    },
    meta,
  });
});

/** 沿用上一次日結的零用金設定，店員不用每天重打 */
async function lastOpeningFloat(sql, storeCode) {
  const [row] = await sql`
    SELECT opening_float FROM daily_closings
    WHERE store_code = ${storeCode} AND status = 'locked'
    ORDER BY business_date DESC LIMIT 1
  `;
  return row?.opening_float ?? 0;
}

/** 日期加減天數，維持 YYYY-MM-DD */
function shiftDays(dateStrIn, days) {
  const d = new Date(`${dateStrIn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
