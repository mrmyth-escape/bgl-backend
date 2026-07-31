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

// ---------------------------------------------------------------------------
// 送出前的把關規則
// ---------------------------------------------------------------------------
import { findBlockers, findWarnings } from "../api/_lib/closing.js";

const balanced = {
  openingFloat: 2000,
  bookings: [{ roomCode: "A", roomName: "孤兒怨", headcount: 4, amount: 3200 }],
  payments: [{ method: "cash", amount: 3200 }],
  expenses: [],
  cashCounts: { 1000: 5, 100: 2 }, // 5200 = 2000 + 3200
};

test("帳平時沒有任何阻擋", () => {
  assert.deepEqual(findBlockers(normalizeClosing(balanced)), []);
});

test("帳款差額會被擋下，訊息含實際金額", () => {
  const r = findBlockers(normalizeClosing({
    ...balanced,
    payments: [{ method: "cash", amount: 3000 }],
    cashCounts: { 1000: 5 },
  }));
  assert.ok(r.some((m) => m.includes("帳款差額")), r.join("|"));
  assert.ok(r.some((m) => m.includes("3,200")), "訊息應包含應收金額");
});

test("收了現金卻沒點鈔會被擋下", () => {
  const r = findBlockers(normalizeClosing({ ...balanced, cashCounts: {}, cashCounted: 0 }));
  assert.ok(r.some((m) => m.includes("尚未點鈔")), r.join("|"));
});

test("沒有現金收款時不會要求點鈔", () => {
  const r = findBlockers(normalizeClosing({
    ...balanced,
    payments: [{ method: "credit_card", amount: 3200 }],
    cashCounts: { 1000: 2 }, // 2000 = 零用金，現金無進出
  }));
  assert.deepEqual(r, []);
});

test("容許誤差可放行小額差異", () => {
  const input = { ...balanced, payments: [{ method: "cash", amount: 3195 }], cashCounts: { 1000: 5, 100: 1, 10: 9, 5: 1 } };
  const data = normalizeClosing(input);
  assert.equal(data.totals.variance, -5);
  assert.ok(findBlockers(data, 0).length > 0, "誤差 0 應該擋下");
  assert.deepEqual(findBlockers(data, 10), [], "誤差 10 應該放行");
});

test("有人數但金額 0 會提醒（但不擋）", () => {
  const data = normalizeClosing({
    ...balanced,
    bookings: [{ roomCode: "B", roomName: "屎力全開", time: "20:00", headcount: 5, amount: 0 }],
    payments: [], cashCounts: { 1000: 2 },
  });
  assert.deepEqual(findBlockers(data), [], "金額 0 但帳平，不該擋");
  const w = findWarnings(data);
  assert.ok(w.some((m) => m.includes("屎力全開") && m.includes("5 人")), w.join("|"));
});

test("營收偏離同星期平均 40% 以上會提醒", () => {
  const data = normalizeClosing(balanced); // 應收 3200
  assert.deepEqual(findWarnings(data, { avgSameWeekday: 3000 }), [], "差 7% 不該提醒");
  const low = findWarnings(data, { avgSameWeekday: 8000 });
  assert.ok(low.some((m) => m.includes("-60%")), low.join("|"));
  const high = findWarnings(data, { avgSameWeekday: 1000 });
  assert.ok(high.some((m) => m.includes("220%")), high.join("|"));
});

test("沒有歷史基準時不做營收比較", () => {
  assert.deepEqual(findWarnings(normalizeClosing(balanced), { avgSameWeekday: 0 }), []);
});

test("未到店的場次不會觸發金額 0 提醒", () => {
  const data = normalizeClosing({
    ...balanced,
    bookings: [{ roomCode: "C", headcount: 6, amount: 0, attended: false }],
    payments: [], cashCounts: { 1000: 2 },
  });
  assert.deepEqual(findWarnings(data), []);
});

test("staffId 會被帶進日結資料", () => {
  assert.equal(normalizeClosing({ ...balanced, staffId: 7 }).staff_id, 7);
  assert.equal(normalizeClosing({ ...balanced, staffId: "abc" }).staff_id, null);
  assert.equal(normalizeClosing(balanced).staff_id, null);
});
