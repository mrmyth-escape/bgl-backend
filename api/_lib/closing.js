// api/_lib/closing.js
// 日結單的共用邏輯：金額計算、讀取、寫入

import { fail } from "./http.js";

export const PAYMENT_METHODS = [
  { key: "cash",        label: "現金",       affectsDrawer: true  },
  { key: "credit_card", label: "信用卡",     affectsDrawer: false },
  { key: "linepay",     label: "LINE Pay",   affectsDrawer: false },
  { key: "jkopay",      label: "街口支付",   affectsDrawer: false },
  { key: "twpay",       label: "台灣 Pay",   affectsDrawer: false },
  { key: "transfer",    label: "銀行轉帳",   affectsDrawer: false },
  { key: "prepaid",     label: "線上預付/訂金", affectsDrawer: false },
  { key: "other",       label: "其他",       affectsDrawer: false },
];

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

const PAYMENT_KEYS = new Set(PAYMENT_METHODS.map((m) => m.key));
const DRAWER_KEYS  = new Set(PAYMENT_METHODS.filter((m) => m.affectsDrawer).map((m) => m.key));

/**
 * 取得台北時區的營業日。
 * 打烊常拖到凌晨，所以往前推 6 小時 —— 凌晨 2 點結的帳算前一天的營業日。
 * @param {Date} [now]
 */
export function defaultBusinessDate(now = new Date()) {
  const shifted = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  return toTaipeiDate(shifted);
}

/** Date → 台北時區的 YYYY-MM-DD */
export function toTaipeiDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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
  const bookings = (input.bookings || []).map((b, i) => ({
    booking_id:     b.bookingId ? String(b.bookingId) : null,
    room_code:      b.roomCode ?? null,
    room_name:      b.roomName ?? null,
    service_id:     b.serviceId != null ? Number(b.serviceId) : null,
    start_time:     b.time ?? null,
    client_name:    b.clientName ?? null,
    headcount:      intOf(b.headcount, `場次 #${i + 1} 人數`),
    amount:         money(b.amount, `場次 #${i + 1} 金額`),
    prepaid_amount: money(b.prepaidAmount, `場次 #${i + 1} 預收金額`),
    attended:       b.attended !== false,
    note:           b.note ?? null,
  }));

  const payments = (input.payments || [])
    .map((p, i) => {
      if (!PAYMENT_KEYS.has(p.method)) throw fail(400, `未知的收款方式：${p.method}`);
      return {
        method: p.method,
        amount: money(p.amount, `收款 #${i + 1} 金額`),
        ref_no: p.refNo ?? null,
        note:   p.note ?? null,
      };
    })
    .filter((p) => p.amount > 0 || p.ref_no || p.note);

  const expenses = (input.expenses || [])
    .map((e, i) => ({
      category: e.category || "other",
      amount:   money(e.amount, `雜支 #${i + 1} 金額`),
      paid_by:  e.paidBy === "cash" ? "cash" : (e.paidBy || "cash"),
      note:     e.note ?? null,
    }))
    .filter((e) => e.amount > 0);

  const cashCounts = DENOMINATIONS.map((d) => ({
    denomination: d,
    qty: intOf(input.cashCounts?.[d], `${d} 元張數`),
  })).filter((c) => c.qty > 0);

  const openingFloat = money(input.openingFloat, "開店零用金");

  // ---- 衍生金額 ----
  const attended = bookings.filter((b) => b.attended);

  const expectedRevenue = attended.reduce((s, b) => s + b.amount, 0);
  const actualTotal     = payments.reduce((s, p) => s + p.amount, 0);
  const expenseTotal    = expenses.reduce((s, e) => s + e.amount, 0);

  const cashPayments = payments
    .filter((p) => DRAWER_KEYS.has(p.method))
    .reduce((s, p) => s + p.amount, 0);
  const cashExpenses = expenses
    .filter((e) => e.paid_by === "cash")
    .reduce((s, e) => s + e.amount, 0);

  const expectedCash = openingFloat + cashPayments - cashExpenses;

  // 有點鈔明細就以明細為準，否則採用直接輸入的總額
  const countedFromDenoms = cashCounts.reduce((s, c) => s + c.denomination * c.qty, 0);
  const cashCounted = cashCounts.length > 0
    ? countedFromDenoms
    : money(input.cashCounted, "點鈔金額");

  return {
    bookings,
    payments,
    expenses,
    cashCounts,
    totals: {
      expected_revenue: expectedRevenue,
      actual_total:     actualTotal,
      variance:         actualTotal - expectedRevenue,
      opening_float:    openingFloat,
      expected_cash:    expectedCash,
      cash_counted:     cashCounted,
      cash_variance:    cashCounted - expectedCash,
      expense_total:    expenseTotal,
      headcount_total:  attended.reduce((s, b) => s + b.headcount, 0),
      session_count:    attended.length,
    },
    variance_reason: input.varianceReason || null,
    notes:           input.notes || null,
    submitted_by:    input.submittedBy || null,
  };
}

/** DB 欄位 → API 欄位 */
export function toApiBooking(b) {
  return {
    bookingId:     b.booking_id,
    serviceId:     b.service_id,
    roomCode:      b.room_code,
    roomName:      b.room_name,
    time:          b.start_time,
    clientName:    b.client_name,
    headcount:     b.headcount,
    amount:        b.amount,
    prepaidAmount: b.prepaid_amount,
    attended:      b.attended,
    note:          b.note,
  };
}

/** loadClosing() 的結果 → 給前端的 JSON */
export function serializeClosing({ closing, payments, expenses, cashCounts, bookings }) {
  return {
    id:             closing.id,
    status:         closing.status,
    storeCode:      closing.store_code,
    businessDate:   dateStr(closing.business_date),
    openingFloat:   closing.opening_float,
    cashCounted:    closing.cash_counted,
    varianceReason: closing.variance_reason,
    notes:          closing.notes,
    submittedBy:    closing.submitted_by,
    submittedAt:    closing.submitted_at,
    bookings:       bookings.map(toApiBooking),
    payments:       payments.map((p) => ({ method: p.method, amount: p.amount, refNo: p.ref_no, note: p.note })),
    expenses:       expenses.map((e) => ({ category: e.category, amount: e.amount, paidBy: e.paid_by, note: e.note })),
    cashCounts:     Object.fromEntries(cashCounts.map((c) => [c.denomination, c.qty])),
    totals: {
      expected_revenue: closing.expected_revenue,
      actual_total:     closing.actual_total,
      variance:         closing.variance,
      opening_float:    closing.opening_float,
      expected_cash:    closing.expected_cash,
      cash_counted:     closing.cash_counted,
      cash_variance:    closing.cash_variance,
      expense_total:    closing.expense_total,
      headcount_total:  closing.headcount_total,
      session_count:    closing.session_count,
    },
  };
}

/** pg 回傳的 DATE 可能是 Date 物件，統一成 YYYY-MM-DD 字串 */
export function dateStr(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return toTaipeiDate(value);
}

/** 讀取單張日結單（含所有明細）；找不到回傳 null */
export async function loadClosing(sql, storeCode, businessDate) {
  const [closing] = await sql`
    SELECT * FROM daily_closings
    WHERE store_code = ${storeCode} AND business_date = ${businessDate}
  `;
  if (!closing) return null;

  const [payments, expenses, cashCounts, bookings] = await Promise.all([
    sql`SELECT * FROM payment_lines    WHERE closing_id = ${closing.id} ORDER BY id`,
    sql`SELECT * FROM expense_lines    WHERE closing_id = ${closing.id} ORDER BY id`,
    sql`SELECT * FROM cash_counts      WHERE closing_id = ${closing.id} ORDER BY denomination DESC`,
    sql`SELECT * FROM closing_bookings WHERE closing_id = ${closing.id} ORDER BY start_time, room_code`,
  ]);

  return { closing, payments, expenses, cashCounts, bookings };
}

/**
 * 寫入日結單（新增或覆蓋 draft）。已鎖定的單子會被拒絕。
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
      submitted_by:     data.submitted_by,
      submitted_at:     status === "locked" ? new Date() : null,
      updated_at:       new Date(),
    };

    let closingId;
    if (existing) {
      closingId = existing.id;
      await tx`UPDATE daily_closings SET ${tx(row)} WHERE id = ${closingId}`;
      await tx`DELETE FROM payment_lines    WHERE closing_id = ${closingId}`;
      await tx`DELETE FROM expense_lines    WHERE closing_id = ${closingId}`;
      await tx`DELETE FROM cash_counts      WHERE closing_id = ${closingId}`;
      await tx`DELETE FROM closing_bookings WHERE closing_id = ${closingId}`;
    } else {
      const [created] = await tx`
        INSERT INTO daily_closings ${tx(row)} RETURNING id
      `;
      closingId = created.id;
    }

    const withId = (rows) => rows.map((r) => ({ ...r, closing_id: closingId }));
    if (data.payments.length)   await tx`INSERT INTO payment_lines    ${tx(withId(data.payments))}`;
    if (data.expenses.length)   await tx`INSERT INTO expense_lines    ${tx(withId(data.expenses))}`;
    if (data.cashCounts.length) await tx`INSERT INTO cash_counts      ${tx(withId(data.cashCounts))}`;
    if (data.bookings.length)   await tx`INSERT INTO closing_bookings ${tx(withId(data.bookings))}`;

    await tx`
      INSERT INTO closing_audit_log (closing_id, action, actor, detail)
      VALUES (${closingId}, ${status === "locked" ? "submit" : "save"}, ${actor || null}, ${tx.json(t)})
    `;

    return closingId;
  });
}
