// api/closing/submit.js — POST /api/closing/submit
// 送出並鎖定日結單。這裡是「帳款正確」的把關點：對不上就不給結。

import { db } from "../_lib/db.js";
import { handler, readBody, fail } from "../_lib/http.js";
import {
  loadClosing,
  saveClosing,
  normalizeClosing,
  serializeClosing,
  findBlockers,
  findWarnings,
  defaultBusinessDate,
  assertDate,
} from "../_lib/closing.js";
import { avgSameWeekday } from "../_lib/stats.js";
import { DEFAULT_STORE } from "../_lib/store.js";

/** 允許的誤差（元）。設為 0 表示必須完全相符。 */
const TOLERANCE = Number(process.env.CLOSING_TOLERANCE ?? 0);

export default handler(
  async (req, res) => {
    const sql       = db();
    const body      = readBody(req);
    const storeCode = body.storeCode || DEFAULT_STORE;
    const date      = assertDate(body.businessDate || defaultBusinessDate(), "businessDate");

    if (!body.submittedBy) throw fail(400, "請選擇結帳人員");

    const data = normalizeClosing(body);
    const t    = data.totals;

    if (t.expected_revenue === 0 && t.actual_total === 0 && !data.notes) {
      throw fail(400, "今日沒有任何收入與收款，請在備註說明（例如：公休）");
    }

    const blockers = findBlockers(data, TOLERANCE);

    // 差額有填說明就放行，但一定要留下紀錄
    const forced = Boolean(body.forceSubmit) && Boolean(data.variance_reason);
    if (blockers.length && !forced) {
      return res.status(422).json({
        ok: false,
        error: "帳款未平，無法結帳",
        blockers,
        hint: "確認金額無誤後，請填寫差額原因並勾選「仍要送出」",
        totals: t,
      });
    }

    await saveClosing(sql, {
      storeCode,
      businessDate: date,
      data,
      status: "locked",
      actor: data.submitted_by,
    });

    const warnings = findWarnings(data, {
      avgSameWeekday: await avgSameWeekday(sql, storeCode, date),
    });

    const saved = await loadClosing(sql, storeCode, date);
    return res.status(200).json({
      ok: true,
      message: blockers.length
        ? `已結帳（帶差額，原因：${data.variance_reason}）`
        : "已結帳，帳款相符",
      hadVariance: blockers.length > 0,
      warnings,
      closing: serializeClosing(saved),
    });
  },
  { methods: ["POST"] }
);
