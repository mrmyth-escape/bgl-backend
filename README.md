# 勃根地密室 — 結帳系統後端

大忠店的每日打烊結帳、月結報表，以及 SimplyBook 訂位整合。
部署在 Vercel（Serverless Functions + 靜態頁面），資料存 Postgres。

---

## 第一次架設

### 1. 開一個 Postgres

[Neon](https://neon.tech) 或 [Supabase](https://supabase.com) 免費方案都夠用。
建好之後複製**連線池（Pooled / Connection Pooling）**的連線字串 —— 不要用直連的那條，
Serverless 每次呼叫都是新實例，直連會很快把連線數吃光。

- Neon：連線字串裡會有 `-pooler`
- Supabase：Connection Pooling 分頁，port `6543`

### 2. 在 Vercel 設定環境變數

| 變數 | 必填 | 說明 |
|---|:--:|---|
| `DATABASE_URL` | ✅ | 上一步的連線池連線字串 |
| `APP_API_KEY` | ✅ | 自己設一組長密碼，店員登入結帳頁面時要用。**沒設定的話所有 API 一律拒絕服務** |
| `SB_API_KEY` | ✅ | SimplyBook 的 API key，用來抓當日場次 |
| `SB_WEBHOOK_SECRET` | 建議 | 設了之後 webhook 網址要帶 `?secret=xxx`，防止有人偽造訂位 |
| `ALLOWED_ORIGIN` | 建議 | 上線後填你的網域，例如 `https://bgl.vercel.app`。不填等於開放所有來源 |
| `CLOSING_TOLERANCE` | 選填 | 允許的誤差（元），預設 `0`，也就是必須完全對上 |

產生 `APP_API_KEY` 的方法：`openssl rand -base64 32`

### 3. 建表

部署完成後執行一次（把網址與金鑰換成你的）：

```bash
curl -X POST https://你的網域/api/admin/migrate \
  -H "X-Api-Key: 你的APP_API_KEY"
```

`db/schema.sql` 是可重複執行的，之後改結構重跑一次即可。

### 4. 確認狀態

瀏覽器打開 `https://你的網域/api/health`，資料庫與 SimplyBook 都要是 `ok: true`。

### 5. 設定房間定價

SimplyBook 若沒有回傳金額，系統會用「每人定價 × 人數」推估，讓店員在頁面上確認即可。
先把定價填進去：

```sql
UPDATE rooms SET unit_price = 800 WHERE room_code = 'A';
```

不設也能用 —— 只是每場金額會是 0，要店員自己打。

---

## 每天怎麼用

**打烊時** 開 `https://你的網域/closing.html`

1. 第一次使用貼上 API 金鑰（之後瀏覽器會記住）
2. 當日場次會自動帶出來，確認人數與金額，沒到店的取消勾選
3. 填各種收款方式的實收金額
4. 有雜支就記一筆，註明是不是用現金付的
5. 點鈔，按面額填張數
6. 填結帳人員姓名 → **送出結帳**

**帳對不上就送不出去。** 差額會明確告訴你差多少、差在哪：

- **帳款差額** = 實收合計 − 應收合計
- **現金差額** = 實際點鈔 − 櫃內應有（零用金 ＋ 現金收款 − 現金雜支）

真的有差額而且已經確認過原因，填寫「差額原因」並勾選「仍要送出」才能結帳，
系統會把原因一起存下來。

**看數據** 開 `https://你的網域/report.html` —— 月營收、各房間佔比、星期別、時段熱度、逐月趨勢。

> 打烊常拖到凌晨，所以**凌晨 6 點前結的帳算前一天的營業日**。

---

## API

寫入類的端點都需要 `X-Api-Key` 標頭。

| 端點 | 方法 | 說明 |
|---|---|---|
| `/api/health` | GET | 健檢（免金鑰） |
| `/api/admin/migrate` | POST | 套用 `db/schema.sql` |
| `/api/webhook` | POST | SimplyBook 訂位通知接收 |
| `/api/bookings?date=` | GET | 當日訂位清單 |
| `/api/closing/preview?date=&store=` | GET | 打烊頁面初始資料 |
| `/api/closing` | GET / POST | 讀取日結單 / 存草稿 |
| `/api/closing/submit` | POST | 送出並鎖定（會擋差額） |
| `/api/closing/reopen` | POST | 解鎖（需填原因，寫入 audit log） |
| `/api/closing/list?from=&to=` | GET | 日結單清單 ＋ 漏結帳日期 |
| `/api/reports/monthly?month=YYYY-MM` | GET | 月報 |
| `/api/reports/trend?months=12` | GET | 逐月趨勢（含 MoM / YoY） |

日期一律 `YYYY-MM-DD`，金額一律以「元」為單位的整數。
`store` 目前有 `dazhong`（大忠店）與 `mrmyth`（謎先生），預設 `dazhong`。

### SimplyBook Webhook 設定

在 SimplyBook 後台把 webhook 網址設成：

```
https://你的網域/api/webhook?secret=你的SB_WEBHOOK_SECRET
```

---

## 資料表

| 表 | 內容 |
|---|---|
| `rooms` | 房間 ↔ SimplyBook service_id 對照、每人定價 |
| `bookings` | webhook 落地的訂位 |
| `daily_closings` | 日結單主檔（狀態：`draft` / `locked` / `voided`） |
| `payment_lines` | 各收款方式明細 |
| `expense_lines` | 雜支 |
| `cash_counts` | 現金點鈔（面額 × 張數） |
| `closing_bookings` | 結帳當下的場次快照 —— 事後訂位系統再改也不影響已結的帳 |
| `closing_audit_log` | 存檔 / 送出 / 解鎖紀錄 |

**只有 `locked` 的日結單才會被算進報表**，草稿不列入。

---

## 開發

```bash
npm install
npm test          # 金額計算的迴歸測試
```

`test/closing.test.js` 涵蓋差額方向、現金櫃計算、點鈔優先序、金額驗證、跨午夜營業日等。
改動 `api/_lib/closing.js` 的計算邏輯前請先看這裡。

---

## 已知限制

- **SimplyBook 的金額欄位名稱各版本不一致**。`normalizeBooking()` 會依序嘗試
  `amount` / `price` / `total_price` / `invoice_amount`，抓不到就退回「定價 × 人數」，
  最後由店員在頁面上確認。上線後請比對前幾天的實際數字，確認抓的是對的欄位。
- 目前是單一 API 金鑰，沒有分帳號。要追蹤是誰結的帳，靠「結帳人員」欄位（人工填寫）。
- 尚未串接 POS 的逐筆交易，日結是以「場次」為單位。
