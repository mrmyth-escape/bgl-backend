// test/closing.test.js — 金額計算的迴歸測試
// 執行：npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClosing,
  defaultBusinessDate,
  assertDate,
  assertMonth,
  dateStr,
} from "../api/_lib/closing.js";

const base = {
  openingFloat: 2000,
  bookings: [
    { roomCode: "A", headcount: 4, amount: 3200, prepaidAmount: 800 },
    { roomCode: "B", headcount: 6, amount: 4800, prepaidAmount: 0 },
  ],
  payments: [],
  expenses: [],
  cashCounts: {},
};

test("帳平：實收等於應收時差額為 0", () => {
  const r = normalizeClosing({
    ...base,
    payments: [
      { method: "prepaid", amount: 800 },
      { method: "cash", amount: 3200 },
      { method: "credit_card", amount: 4000 },
    ],
    cashCounts: { 1000: 5, 100: 2 }, // 5200
  });

  assert.equal(r.totals.expected_revenue, 8000);
  assert.equal(r.totals.actual_total, 8000);
  assert.equal(r.totals.variance, 0);
  assert.equal(r.totals.expected_cash, 5200); // 2000 零用金 + 3200 現金收款
  assert.equal(r.totals.cash_counted, 5200);
  assert.equal(r.totals.cash_variance, 0);
  assert.equal(r.totals.headcount_total, 10);
  assert.equal(r.totals.session_count, 2);
});

test("未到店的場次不計入應收與人次", () => {
  const r = normalizeClosing({
    ...base,
    bookings: [base.bookings[0], { ...base.bookings[1], attended: false }],
  });
  assert.equal(r.totals.expected_revenue, 3200);
  assert.equal(r.totals.headcount_total, 4);
  assert.equal(r.totals.session_count, 1);
});

test("現金雜支要從錢櫃扣除，非現金雜支不扣", () => {
  const withCash = normalizeClosing({
    ...base,
    payments: [{ method: "cash", amount: 8000 }],
    expenses: [{ category: "supplies", amount: 500, paidBy: "cash" }],
  });
  assert.equal(withCash.totals.expected_cash, 2000 + 8000 - 500);
  assert.equal(withCash.totals.expense_total, 500);

  const withCard = normalizeClosing({
    ...base,
    payments: [{ method: "cash", amount: 8000 }],
    expenses: [{ category: "supplies", amount: 500, paidBy: "card" }],
  });
  assert.equal(withCard.totals.expected_cash, 2000 + 8000);
  assert.equal(withCard.totals.expense_total, 500);
});

test("只有現金會影響錢櫃，刷卡與行動支付不會", () => {
  const r = normalizeClosing({
    ...base,
    payments: [
      { method: "cash", amount: 1000 },
      { method: "credit_card", amount: 2000 },
      { method: "linepay", amount: 3000 },
      { method: "jkopay", amount: 1000 },
      { method: "twpay", amount: 500 },
      { method: "transfer", amount: 300 },
      { method: "prepaid", amount: 200 },
    ],
  });
  assert.equal(r.totals.actual_total, 8000);
  assert.equal(r.totals.variance, 0);
  assert.equal(r.totals.expected_cash, 3000); // 只有 2000 零用金 + 1000 現金
});

test("點鈔明細優先於直接輸入的總額", () => {
  const r = normalizeClosing({
    ...base,
    cashCounted: 999,                       // 這個會被忽略
    cashCounts: { 1000: 2, 500: 1, 100: 3 }, // 2800
  });
  assert.equal(r.totals.cash_counted, 2800);

  const noDenoms = normalizeClosing({ ...base, cashCounted: 999, cashCounts: {} });
  assert.equal(noDenoms.totals.cash_counted, 999);
});

test("短收與溢收的差額方向正確", () => {
  const short = normalizeClosing({ ...base, payments: [{ method: "cash", amount: 7900 }] });
  assert.equal(short.totals.variance, -100, "少收 100 應為負數");

  const over = normalizeClosing({ ...base, payments: [{ method: "cash", amount: 8100 }] });
  assert.equal(over.totals.variance, 100, "多收 100 應為正數");
});

test("拒絕不合法的金額", () => {
  assert.throws(() => normalizeClosing({ ...base, openingFloat: -1 }), /不可為負數/);
  assert.throws(() => normalizeClosing({ ...base, openingFloat: 10.5 }), /整數/);
  assert.throws(() => normalizeClosing({ ...base, openingFloat: "abc" }), /不是數字/);
  assert.throws(
    () => normalizeClosing({ ...base, payments: [{ method: "bitcoin", amount: 100 }] }),
    /未知的收款方式/
  );
});

test("空白的收款與雜支列不會被存進資料庫", () => {
  const r = normalizeClosing({
    ...base,
    payments: [{ method: "cash", amount: 0 }, { method: "linepay", amount: 8000 }],
    expenses: [{ category: "other", amount: 0 }],
  });
  assert.equal(r.payments.length, 1);
  assert.equal(r.expenses.length, 0);
});

test("凌晨結帳算成前一天的營業日", () => {
  // 台北時間 2026-03-15 02:30 → UTC 2026-03-14 18:30
  const lateNight = new Date("2026-03-14T18:30:00Z");
  assert.equal(defaultBusinessDate(lateNight), "2026-03-14");

  // 台北時間 2026-03-15 14:00 → 就是當天
  const afternoon = new Date("2026-03-15T06:00:00Z");
  assert.equal(defaultBusinessDate(afternoon), "2026-03-15");
});

test("日期格式檢查", () => {
  assert.equal(assertDate("2026-03-15"), "2026-03-15");
  assert.throws(() => assertDate("2026/03/15"), /YYYY-MM-DD/);
  assert.throws(() => assertDate("2026-3-5"), /YYYY-MM-DD/);
  assert.equal(assertMonth("2026-03"), "2026-03");
  assert.throws(() => assertMonth("2026-03-15"), /YYYY-MM/);

  // SQL injection 走不進來 —— 參數化查詢之外再加一層
  assert.throws(() => assertDate("2026-03-15'; DROP TABLE daily_closings;--"), /YYYY-MM-DD/);
});

test("dateStr 能處理 Date 物件與字串", () => {
  assert.equal(dateStr("2026-03-15"), "2026-03-15");
  assert.equal(dateStr(new Date("2026-03-15T00:00:00Z")), "2026-03-15");
  assert.equal(dateStr(null), null);
});
