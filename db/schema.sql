-- db/schema.sql
-- 勃根地密室 結帳系統 — 資料表結構
-- 可重複執行（idempotent），由 POST /api/admin/migrate 套用
--
-- 金額一律以「新台幣元」的整數儲存，不使用小數。

-- ---------------------------------------------------------------------------
-- 房間 / 服務對照
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  service_id   INTEGER PRIMARY KEY,           -- SimplyBook service_id
  room_code    TEXT    NOT NULL,              -- A / B / C ...
  name         TEXT    NOT NULL,              -- 孤兒怨
  store_code   TEXT    NOT NULL,              -- dazhong / mrmyth
  store_name   TEXT    NOT NULL,              -- 大忠店 / 謎先生
  unit_price   INTEGER NOT NULL DEFAULT 0,    -- 每人定價，用於推估應收
  active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS rooms_store_idx ON rooms (store_code);

-- ---------------------------------------------------------------------------
-- 訂位（webhook 與 SimplyBook 同步的落地資料）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  booking_id    TEXT PRIMARY KEY,
  service_id    INTEGER,
  room_code     TEXT,
  room_name     TEXT,
  store_code    TEXT,
  business_date DATE    NOT NULL,
  start_time    TEXT,                          -- HH:MM
  client_name   TEXT,
  headcount     INTEGER,
  status        TEXT    NOT NULL DEFAULT 'booked',  -- booked / cancelled
  source        TEXT    NOT NULL DEFAULT 'simplybook',
  raw           JSONB,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bookings_date_idx  ON bookings (business_date, store_code);
CREATE INDEX IF NOT EXISTS bookings_store_idx ON bookings (store_code);

-- ---------------------------------------------------------------------------
-- 日結單
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_closings (
  id                SERIAL PRIMARY KEY,
  store_code        TEXT    NOT NULL,
  business_date     DATE    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'draft',   -- draft / locked / voided

  expected_revenue  INTEGER NOT NULL DEFAULT 0,  -- 系統推估應收（當日場次總額）
  actual_total      INTEGER NOT NULL DEFAULT 0,  -- 各收款方式合計
  variance          INTEGER NOT NULL DEFAULT 0,  -- actual_total - expected_revenue

  opening_float     INTEGER NOT NULL DEFAULT 0,  -- 開店零用金
  expected_cash     INTEGER NOT NULL DEFAULT 0,  -- 現金櫃應有 = 零用金 + 現金收款 - 現金雜支
  cash_counted      INTEGER NOT NULL DEFAULT 0,  -- 實際點鈔金額
  cash_variance     INTEGER NOT NULL DEFAULT 0,  -- cash_counted - expected_cash

  expense_total     INTEGER NOT NULL DEFAULT 0,
  headcount_total   INTEGER NOT NULL DEFAULT 0,
  session_count     INTEGER NOT NULL DEFAULT 0,

  variance_reason   TEXT,                        -- 差額說明（有差額時必填）
  notes             TEXT,
  submitted_by      TEXT,
  submitted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT daily_closings_unique UNIQUE (store_code, business_date)
);

CREATE INDEX IF NOT EXISTS closings_date_idx ON daily_closings (business_date DESC);

-- ---------------------------------------------------------------------------
-- 收款明細
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_lines (
  id         SERIAL PRIMARY KEY,
  closing_id INTEGER NOT NULL REFERENCES daily_closings (id) ON DELETE CASCADE,
  method     TEXT    NOT NULL,   -- cash / credit_card / linepay / jkopay / twpay / prepaid / transfer / other
  amount     INTEGER NOT NULL DEFAULT 0,
  ref_no     TEXT,               -- 刷卡機結帳單號、平台批次號
  note       TEXT
);

CREATE INDEX IF NOT EXISTS payment_lines_closing_idx ON payment_lines (closing_id);

-- ---------------------------------------------------------------------------
-- 雜支
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_lines (
  id         SERIAL PRIMARY KEY,
  closing_id INTEGER NOT NULL REFERENCES daily_closings (id) ON DELETE CASCADE,
  category   TEXT    NOT NULL DEFAULT 'other',  -- supplies / repair / food / transport / other
  amount     INTEGER NOT NULL DEFAULT 0,
  paid_by    TEXT    NOT NULL DEFAULT 'cash',   -- cash 才會從現金櫃扣除
  note       TEXT
);

CREATE INDEX IF NOT EXISTS expense_lines_closing_idx ON expense_lines (closing_id);

-- ---------------------------------------------------------------------------
-- 現金點鈔
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_counts (
  id           SERIAL PRIMARY KEY,
  closing_id   INTEGER NOT NULL REFERENCES daily_closings (id) ON DELETE CASCADE,
  denomination INTEGER NOT NULL,   -- 1000 / 500 / 100 / 50 / 10 / 5 / 1
  qty          INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT cash_counts_unique UNIQUE (closing_id, denomination)
);

-- ---------------------------------------------------------------------------
-- 日結當下的場次快照（結帳後訂位系統再改也不影響已結的帳）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closing_bookings (
  id             SERIAL PRIMARY KEY,
  closing_id     INTEGER NOT NULL REFERENCES daily_closings (id) ON DELETE CASCADE,
  booking_id     TEXT,
  room_code      TEXT,
  room_name      TEXT,
  service_id     INTEGER,
  start_time     TEXT,
  client_name    TEXT,
  headcount      INTEGER NOT NULL DEFAULT 0,
  amount         INTEGER NOT NULL DEFAULT 0,   -- 該場次應收（可人工調整）
  prepaid_amount INTEGER NOT NULL DEFAULT 0,   -- 其中已於線上預收的金額
  attended       BOOLEAN NOT NULL DEFAULT TRUE,-- 是否實際到店
  note           TEXT
);

CREATE INDEX IF NOT EXISTS closing_bookings_closing_idx ON closing_bookings (closing_id);

-- ---------------------------------------------------------------------------
-- 異動紀錄
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closing_audit_log (
  id         SERIAL PRIMARY KEY,
  closing_id INTEGER REFERENCES daily_closings (id) ON DELETE CASCADE,
  action     TEXT NOT NULL,      -- save / submit / reopen / void
  actor      TEXT,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS closing_audit_closing_idx ON closing_audit_log (closing_id);

-- ---------------------------------------------------------------------------
-- 房間種子資料（沿用 SERVICE_MAP，unit_price 之後用後台或 SQL 調整）
-- ---------------------------------------------------------------------------
INSERT INTO rooms (service_id, room_code, name, store_code, store_name) VALUES
  (2,  'A', '孤兒怨',   'dazhong', '大忠店'),
  (3,  'B', '屎力全開', 'dazhong', '大忠店'),
  (15, 'C', '越獄者',   'dazhong', '大忠店'),
  (14, 'D', '詭廁',     'dazhong', '大忠店'),
  (11, 'E', '詭獄',     'mrmyth',  '謎先生'),
  (17, 'F', '詭獄加場', 'mrmyth',  '謎先生'),
  (16, 'G', '詭店',     'mrmyth',  '謎先生')
ON CONFLICT (service_id) DO UPDATE
  SET room_code  = EXCLUDED.room_code,
      name       = EXCLUDED.name,
      store_code = EXCLUDED.store_code,
      store_name = EXCLUDED.store_name;
