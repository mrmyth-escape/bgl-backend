// api/_lib/closing.js
// 日結單的核心邏輯：金額計算、把關規則、讀寫。
//
// 對應紙本表單的核心等式：
//     收入小計 － 折扣 ＝ 收款合計
// 兩邊對不起來就是帳有問題，這是整套系統唯一要守住的事。

import { fail } from "./http.js";

export const EXPENSE_CATEGORIES = [
  { key: "supplies",  label: "耗材/道具" },
  { key: "repair",    label: "維修" },
  { key: "food",      label: "餐飲/茶水" },
  { key: "transport", label: "交通" },
  { key: "refund",    label: "退款" },
  { key: "other",     label: "其他" },
];

/** 台幣現行流通面額，由大到小 */
export const DENOMINATIONS = [1000, 500, 100, 50, 10, 5, 1];

/**
 * 取得台北時區的營業日。
 * 打烊常拖到凌晨，所以往前推 6 小時 —— 凌晨 2 點結的帳算前一天的營業日。
 */
export function defaultBusinessDate(now = new Date()) {
  return toTaipeiDate(new Date(now.getTime() - 6 * 60 * 60 * 1000));
}

/** Date → 台北時區的 YYYY-MM-DD */
export function toTaipeiDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function assertDate(value, field = "date") {
  if (!DATE_RE.test(String(value))) throw fail(400, `${field} 格式須為 YYYY-MM-DD`);
  return value;
}

export function assertMonth(value, field = "month") {
  if (!MONTH_RE.test(String(value))) throw fail(400, `${field} 格式須為 YYYY-MM`);
  return value;
}

/** 轉成非負整數金額（元）；空字串視為 0 */
function money(value, field) {
  if (value === "" || value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) throw fail(400, `${field} 不是數字`);
  if (!Number.isInteger(n)) throw fail(400, `${field} 須為整數（新台幣以元為單位）`);
  if (n < 0) throw fail(400, `${field} 不可為負數`);
  return n;
}

function intOf(value, field) {
  if (value === "" || value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw fail(400, `${field} 須為非負整數`);
  return n;
}

/**
 * 把前端送來的日結內容整理成乾淨的結構，並算出所有衍生金額。
 * 這是唯一計算帳務的地方 —— 前端顯示的數字僅供參考，一律以此為準。
 */
export function normalizeClosing(input) {
  const revenues = (input.revenues || [])
    .map((r, i) => ({
      item_id:   Number.isInteger(Number(r.itemId)) ? Number(r.itemId) : null,
      item_name: String(r.itemName ?? "").trim() || `項目 ${i + 1}`,
      amount:    money(r.amount, `${r.itemName || `收入項目 #${i + 1}`} 金額`),
    }))
    .filter((r) => r.amount > 0);

  const payments = (input.payments || [])
    .map((p, i) => ({
      method_id:   Number.isInteger(Number(p.methodId)) ? Number(p.methodId) : null,
      method_name: String(p.methodName ?? "").trim() || `收款 ${i + 1}`,
      is_cash:     p.isCash === true,
      amount:      money(p.amount, `${p.methodName || `收款 #${i + 1}`} 金額`),
      ref_no:      p.refNo ?? null,
      note:        p.note ?? null,
    }))
    .filter((p) => p.amount > 0 || p.ref_no || p.note);

  const expenses = (input.expenses || [])
    .map((e, i) => ({
      category: e.category || "other",
      amount:   money(e.amount, `支出 #${i + 1} 金額`),
      paid_by:  e.paidBy === "card" ? "card" : "cash",
      note:     e.note ?? null,
    }))
    .filter((e) => e.amount > 0);

  const cashCounts = DENOMINATIONS
    .map((d) => ({ denomination: d, qty: intOf(input.cashCounts?.[d], `${d} 元張數`) }))
    .filter((c) => c.qty > 0);

  const openingFloat  = money(input.openingFloat, "開店零用金");
  const discountTotal = money(input.discountTotal, "折扣");

  // ---- 衍生金額 ----
  const expectedRevenue = revenues.reduce((s, r) => s + r.amount, 0);
  const actualTotal     = payments.reduce((s, p) => s + p.amount, 0);
  const expenseTotal    = expenses.reduce((s, e) => s + e.amount, 0);

  // 核心等式：收入小計 － 折扣 ＝ 收款合計
  const netExpected = expectedRevenue - discountTotal;

  const cashPayments = payments.filter((p) => p.is_cash).reduce((s, p) => s + p.amount, 0);
  const cashExpenses = expenses.filter((e) => e.paid_by === "cash").reduce((s, e) => s + e.amount, 0);
  const expectedCash = openingFloat + cashPayments - cashExpenses;

  // 有點鈔明細就以明細為準，否則採用直接輸入的總額
  const countedFromDenoms = cashCounts.reduce((s, c) => s + c.denomination * c.qty, 0);
  const cashCounted = cashCounts.length > 0 ? countedFromDenoms : money(input.cashCounted, "點鈔金額");

  return {
    revenues, payments, expenses, cashCounts,
    totals: {
      expected_revenue: expectedRevenue,
      discount_total:   discountTotal,
      net_expected:     netExpected,
      actual_total:     actualTotal,
      variance:         actualTotal - netExpected,
      opening_float:    openingFloat,
      expected_cash:    expectedCash,
      cash_counted:     cashCounted,
      cash_variance:    cashCounted - expectedCash,
      expense_total:    expenseTotal,
      // 保留欄位讓資料表結構不變；本階段不記錄人次與場次
      headcount_total:  0,
      session_count:    revenues.length,
    },
    variance_reason: input.varianceReason || null,
    notes:           input.notes || null,
    staff_id:        Number.isInteger(Number(input.staffId)) ? Number(input.staffId) : null,
    submitted_by:    input.submittedBy || null,
  };
}

/**
 * 送出前的把關。回傳的每一項都會擋下結帳，除非填了差額原因並確認送出。
 * @param {ReturnType<typeof normalizeClosing>} data
 * @param {number} tolerance 允許誤差（元）
 */
export function findBlockers(data, tolerance = 0) {
  const t = data.totals;
  const out = [];

  if (Math.abs(t.variance) > tolerance) {
    out.push(
      `帳款差額 ${fmt(t.variance)} 元（收入 ${fmt(t.expected_revenue)} － 折扣 ${fmt(t.discount_total)} ＝ ${fmt(t.net_expected)}，收款合計 ${fmt(t.actual_total)}）`
    );
  }

  if (t.cash_counted > 0 && Math.abs(t.cash_variance) > tolerance) {
    out.push(
      `現金差額 ${fmt(t.cash_variance)} 元（櫃內應有 ${fmt(t.expected_cash)}，實際點鈔 ${fmt(t.cash_counted)}）`
    );
  }

  return out;
}

/**
 * 提醒事項：不擋結帳，只是提示再看一眼。
 * @param {{ avgSameWeekday?: number }} context
 */
export function findWarnings(data, context = {}) {
  const t = data.totals;
  const out = [];

  const cashTaken = data.payments.filter((p) => p.is_cash).reduce((s, p) => s + p.amount, 0);
  if (cashTaken > 0 && t.cash_counted === 0) {
    out.push(`今日有現金收款 ${fmt(cashTaken)} 元，但沒有點鈔`);
  }

  if (t.discount_total > 0 && t.expected_revenue > 0) {
    const ratio = t.discount_total / t.expected_revenue;
    if (ratio >= 0.2) {
      out.push(`折扣 ${fmt(t.discount_total)} 元佔收入 ${Math.round(ratio * 100)}%，比例偏高`);
    }
  }

  const avg = context.avgSameWeekday;
  if (avg > 0 && t.net_expected > 0) {
    const diff = (t.net_expected - avg) / avg;
    if (Math.abs(diff) >= 0.4) {
      out.push(
        `今日收入 ${fmt(t.net_expected)} 元，與近期同星期平均 ${fmt(Math.round(avg))} 元相差 ${Math.round(diff * 100)}%`
      );
    }
  }

  return out;
}

function fmt(n) {
  return n.toLocaleString("zh-TW");
}

/** pg 回傳的 DATE 可能是 Date 物件，統一成 YYYY-MM-DD 字串 */
export function dateStr(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return toTaipeiDate(value);
}

/** loadClosing() 的結果 → 給前端的 JSON */
export function serializeClosing({ closing, payments, expenses, cashCounts, revenues }) {
  return {
    id:             closing.id,
    status:         closing.status,
    storeCode:      closing.store_code,
    businessDate:   dateStr(closing.business_date),
    openingFloat:   closing.opening_float,
    discountTotal:  closing.discount_total,
    cashCounted:    closing.cash_counted,
    varianceReason: closing.variance_reason,
    notes:          closing.notes,
    staffId:        closing.staff_id,
    submittedBy:    closing.submitted_by,
    submittedAt:    closing.submitted_at,
    revenues: revenues.map((r) => ({ itemId: r.item_id, itemName: r.item_name, amount: r.amount })),
    payments: payments.map((p) => ({
      methodId: p.method_id, methodName: p.method_name, isCash: p.is_cash,
      amount: p.amount, refNo: p.ref_no, note: p.note,
    })),
    expenses: expenses.map((e) => ({
      category: e.category, amount: e.amount, paidBy: e.paid_by, note: e.note,
    })),
    cashCounts: Object.fromEntries(cashCounts.map((c) => [c.denomination, c.qty])),
    totals: {
      expected_revenue: closing.expected_revenue,
      discount_total:   closing.discount_total,
      net_expected:     closing.expected_revenue - closing.discount_total,
      actual_total:     closing.actual_total,
      variance:         closing.variance,
      opening_float:    closing.opening_float,
      expected_cash:    closing.expected_cash,
      cash_counted:     closing.cash_counted,
      cash_variance:    closing.cash_variance,
      expense_total:    closing.expense_total,
    },
  };
}

/** 讀取單張日結單（含所有明細）；找不到回傳 null */
export async function loadClosing(sql, storeCode, businessDate) {
  const [closing] = await sql`
    SELECT * FROM daily_closings
    WHERE store_code = ${storeCode} AND business_date = ${businessDate}
  `;
  if (!closing) return null;

  const [payments, expenses, cashCounts, revenues] = await Promise.all([
    sql`SELECT * FROM payment_lines         WHERE closing_id = ${closing.id} ORDER BY id`,
    sql`SELECT * FROM expense_lines         WHERE closing_id = ${closing.id} ORDER BY id`,
    sql`SELECT * FROM cash_counts           WHERE closing_id = ${closing.id} ORDER BY denomination DESC`,
    sql`SELECT * FROM closing_revenue_lines WHERE closing_id = ${closing.id} ORDER BY id`,
  ]);

  return { closing, payments, expenses, cashCounts, revenues };
}

/**
 * 寫入日結單（新增或覆蓋草稿）。已鎖定的單子會被拒絕。
 * 整段包在 transaction 裡，避免主檔寫進去但明細失敗。
 */
export async function saveClosing(sql, { storeCode, businessDate, data, status, actor }) {
  return await sql.begin(async (tx) => {
    const [existing] = await tx`
      SELECT id, status FROM daily_closings
      WHERE store_code = ${storeCode} AND business_date = ${businessDate}
      FOR UPDATE
    `;

    if (existing && existing.status === "locked") {
      throw fail(409, `${businessDate} 的日結單已鎖定，需先解鎖才能修改`);
    }

    const t = data.totals;
    const row = {
      store_code:       storeCode,
      business_date:    businessDate,
      status,
      expected_revenue: t.expected_revenue,
      discount_total:   t.discount_total,
      actual_total:     t.actual_total,
      variance:         t.variance,
      opening_float:    t.opening_float,
      expected_cash:    t.expected_cash,
      cash_counted:     t.cash_counted,
      cash_variance:    t.cash_variance,
      expense_total:    t.expense_total,
      headcount_total:  t.headcount_total,
      session_count:    t.session_count,
      variance_reason:  data.variance_reason,
      notes:            data.notes,
      staff_id:         data.staff_id,
      submitted_by:     data.submitted_by,
      submitted_at:     status === "locked" ? new Date() : null,
      updated_at:       new Date(),
    };

    let closingId;
    if (existing) {
      closingId = existing.id;
      await tx`UPDATE daily_closings SET ${tx(row)} WHERE id = ${closingId}`;
      await tx`DELETE FROM payment_lines         WHERE closing_id = ${closingId}`;
      await tx`DELETE FROM expense_lines         WHERE closing_id = ${closingId}`;
      await tx`DELETE FROM cash_counts           WHERE closing_id = ${closingId}`;
      await tx`DELETE FROM closing_revenue_lines WHERE closing_id = ${closingId}`;
    } else {
      const [created] = await tx`INSERT INTO daily_closings ${tx(row)} RETURNING id`;
      closingId = created.id;
    }

    const withId = (rows) => rows.map((r) => ({ ...r, closing_id: closingId }));
    if (data.payments.length)   await tx`INSERT INTO payment_lines         ${tx(withId(data.payments))}`;
    if (data.expenses.length)   await tx`INSERT INTO expense_lines         ${tx(withId(data.expenses))}`;
    if (data.cashCounts.length) await tx`INSERT INTO cash_counts           ${tx(withId(data.cashCounts))}`;
    if (data.revenues.length)   await tx`INSERT INTO closing_revenue_lines ${tx(withId(data.revenues))}`;

    await tx`
      INSERT INTO closing_audit_log (closing_id, action, actor, detail)
      VALUES (${closingId}, ${status === "locked" ? "submit" : "save"}, ${actor || null}, ${tx.json(t)})
    `;

    return closingId;
  });
}
