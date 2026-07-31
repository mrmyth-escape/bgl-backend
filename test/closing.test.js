// test/closing.test.js — 金額計算與把關規則的迴歸測試
// 執行：npm test
//
// 基準資料取自實際的紙本表單（7/24），確保系統算出來的數字跟手寫的一致。

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClosing,
  findBlockers,
  findWarnings,
  defaultBusinessDate,
  assertDate,
  assertMonth,
  dateStr,
} from "../api/_lib/closing.js";

/** 7/24 那張紙：收入 16,444 － 折扣 550 ＝ 15,894 ＝ 收款總計 */
const realDay = {
  discountTotal: 550,
  openingFloat: 0,
  revenues: [
    { itemId: 1, itemName: "桌遊入場", amount: 2250 },
    { itemId: 2, itemName: "出租",     amount: 150 },
    { itemId: 4, itemName: "詭廁",     amount: 8837 },
    { itemId: 5, itemName: "屎力全開", amount: 2250 },
    { itemId: 7, itemName: "越獄者",   amount: 2396 },
    { itemId: 8, itemName: "蝦皮",     amount: 561 },
  ],
  payments: [
    { methodId: 1, methodName: "現金",   isCash: true,  amount: 5694 },
    { methodId: 3, methodName: "街口",   isCash: false, amount: 2695 },
    { methodId: 4, methodName: "轉帳",   isCash: false, amount: 648 },
    { methodId: 5, methodName: "信用卡", isCash: false, amount: 1855 },
    { methodId: 6, methodName: "文化幣", isCash: false, amount: 1741 },
    { methodId: 7, methodName: "訂金",   isCash: false, amount: 2700 },
    { methodId: 8, methodName: "蝦皮",   isCash: false, amount: 561 },
  ],
  expenses: [],
  cashCounts: {},
};

test("實際表單的數字：收入 16,444 － 折扣 550 ＝ 收款 15,894，帳平", () => {
  const t = normalizeClosing(realDay).totals;
  assert.equal(t.expected_revenue, 16444, "收入小計");
  assert.equal(t.discount_total, 550, "折扣");
  assert.equal(t.net_expected, 15894, "應收");
  assert.equal(t.actual_total, 15894, "收款總計");
  assert.equal(t.variance, 0, "差額應為 0");
  assert.deepEqual(findBlockers(normalizeClosing(realDay)), []);
});

test("折扣沒填就會出現差額", () => {
  const t = normalizeClosing({ ...realDay, discountTotal: 0 }).totals;
  assert.equal(t.net_expected, 16444);
  assert.equal(t.variance, -550, "少收 550");
  const b = findBlockers(normalizeClosing({ ...realDay, discountTotal: 0 }));
  assert.ok(b.some((m) => m.includes("帳款差額")), b.join("|"));
  assert.ok(b.some((m) => m.includes("16,444")), "訊息要帶出收入小計");
});

test("多收與少收的差額方向正確", () => {
  const over = normalizeClosing({
    ...realDay,
    payments: [...realDay.payments, { methodId: 9, methodName: "711", isCash: false, amount: 100 }],
  });
  assert.equal(over.totals.variance, 100, "多收 100 應為正數");

  const short = normalizeClosing({
    ...realDay,
    payments: realDay.payments.map((p) => p.methodId === 1 ? { ...p, amount: 5594 } : p),
  });
  assert.equal(short.totals.variance, -100, "少收 100 應為負數");
});

test("金額 0 的項目不會寫進資料庫", () => {
  const r = normalizeClosing({
    ...realDay,
    revenues: [...realDay.revenues, { itemId: 3, itemName: "販售", amount: 0 }],
  });
  assert.equal(r.revenues.length, 6, "販售 0 元不該存");
  assert.ok(!r.revenues.some((x) => x.item_name === "販售"));
});

test("現金櫃只計入標記為現金的收款", () => {
  const r = normalizeClosing({ ...realDay, openingFloat: 2000 });
  // 2000 零用金 + 5694 現金收款，其餘刷卡/行動支付都不進錢櫃
  assert.equal(r.totals.expected_cash, 7694);
});

test("現金支付的支出要從錢櫃扣，非現金不扣", () => {
  const cash = normalizeClosing({
    ...realDay, openingFloat: 2000,
    expenses: [{ category: "supplies", amount: 500, paidBy: "cash" }],
  });
  assert.equal(cash.totals.expected_cash, 2000 + 5694 - 500);
  assert.equal(cash.totals.expense_total, 500);

  const card = normalizeClosing({
    ...realDay, openingFloat: 2000,
    expenses: [{ category: "supplies", amount: 500, paidBy: "card" }],
  });
  assert.equal(card.totals.expected_cash, 2000 + 5694);
});

test("點鈔明細優先於直接輸入的總額", () => {
  const r = normalizeClosing({ ...realDay, cashCounted: 999, cashCounts: { 1000: 5, 500: 1, 100: 3 } });
  assert.equal(r.totals.cash_counted, 5800);

  const noDenoms = normalizeClosing({ ...realDay, cashCounted: 999, cashCounts: {} });
  assert.equal(noDenoms.totals.cash_counted, 999);
});

test("沒點鈔不會擋結帳，只會提醒", () => {
  const data = normalizeClosing(realDay); // 有 5,694 現金收款但沒點鈔
  assert.deepEqual(findBlockers(data), [], "點鈔是選填，不該擋");
  const w = findWarnings(data);
  assert.ok(w.some((m) => m.includes("沒有點鈔") && m.includes("5,694")), w.join("|"));
});

test("點了鈔就會核對現金差額", () => {
  const right = normalizeClosing({ ...realDay, openingFloat: 0, cashCounts: { 1000: 5, 500: 1, 100: 1, 50: 1, 10: 4, 1: 4 } });
  assert.equal(right.totals.cash_counted, 5694);
  assert.deepEqual(findBlockers(right), [], "點鈔剛好時不該擋");

  const wrong = normalizeClosing({ ...realDay, openingFloat: 0, cashCounts: { 1000: 5 } });
  assert.equal(wrong.totals.cash_variance, 5000 - 5694);
  const b = findBlockers(wrong);
  assert.ok(b.some((m) => m.includes("現金差額")), b.join("|"));
});

test("容許誤差可放行小額差異", () => {
  const data = normalizeClosing({ ...realDay, discountTotal: 555 });
  assert.equal(data.totals.variance, 5);
  assert.ok(findBlockers(data, 0).length > 0, "誤差 0 應該擋下");
  assert.deepEqual(findBlockers(data, 10), [], "誤差 10 應該放行");
});

test("折扣佔比過高會提醒", () => {
  const low = normalizeClosing({ ...realDay, discountTotal: 550 });
  assert.ok(!findWarnings(low).some((m) => m.includes("折扣")), "3% 不該提醒");

  const high = normalizeClosing({
    ...realDay, discountTotal: 4000,
    payments: [{ methodId: 1, methodName: "現金", isCash: true, amount: 12444 }],
  });
  const w = findWarnings(high);
  assert.ok(w.some((m) => m.includes("折扣") && m.includes("24%")), w.join("|"));
});

test("收入偏離同星期平均 40% 以上會提醒", () => {
  const data = normalizeClosing(realDay); // 應收 15,894
  assert.deepEqual(
    findWarnings(data, { avgSameWeekday: 15000 }).filter((m) => m.includes("同星期")), [],
    "差 6% 不該提醒");
  const low = findWarnings(data, { avgSameWeekday: 30000 });
  assert.ok(low.some((m) => m.includes("-47%")), low.join("|"));
});

test("沒有歷史基準時不做收入比較", () => {
  const w = findWarnings(normalizeClosing(realDay), { avgSameWeekday: 0 });
  assert.ok(!w.some((m) => m.includes("同星期")));
});

test("拒絕不合法的金額", () => {
  assert.throws(() => normalizeClosing({ ...realDay, discountTotal: -1 }), /不可為負數/);
  assert.throws(() => normalizeClosing({ ...realDay, discountTotal: 10.5 }), /整數/);
  assert.throws(() => normalizeClosing({ ...realDay, openingFloat: "abc" }), /不是數字/);
  assert.throws(
    () => normalizeClosing({ ...realDay, revenues: [{ itemId: 1, itemName: "桌遊入場", amount: -50 }] }),
    /不可為負數/
  );
});

test("staffId 會被帶進日結資料", () => {
  assert.equal(normalizeClosing({ ...realDay, staffId: 7 }).staff_id, 7);
  assert.equal(normalizeClosing({ ...realDay, staffId: "abc" }).staff_id, null);
  assert.equal(normalizeClosing(realDay).staff_id, null);
});

test("凌晨結帳算成前一天的營業日", () => {
  // 台北 2026-03-15 02:30 → UTC 2026-03-14 18:30
  assert.equal(defaultBusinessDate(new Date("2026-03-14T18:30:00Z")), "2026-03-14");
  // 台北 2026-03-15 14:00 → 就是當天
  assert.equal(defaultBusinessDate(new Date("2026-03-15T06:00:00Z")), "2026-03-15");
});

test("日期格式檢查", () => {
  assert.equal(assertDate("2026-03-15"), "2026-03-15");
  assert.throws(() => assertDate("2026/03/15"), /YYYY-MM-DD/);
  assert.throws(() => assertDate("2026-3-5"), /YYYY-MM-DD/);
  assert.equal(assertMonth("2026-03"), "2026-03");
  assert.throws(() => assertMonth("2026-03-15"), /YYYY-MM/);
  // 參數化查詢之外再加一層
  assert.throws(() => assertDate("2026-03-15'; DROP TABLE daily_closings;--"), /YYYY-MM-DD/);
});

test("dateStr 能處理 Date 物件與字串", () => {
  assert.equal(dateStr("2026-03-15"), "2026-03-15");
  assert.equal(dateStr(new Date("2026-03-15T00:00:00Z")), "2026-03-15");
  assert.equal(dateStr(null), null);
});
