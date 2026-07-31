-- db/schema.sql
-- 勃根地密室 結帳系統 — 資料表結構
-- 可重複執行（idempotent），由 POST /api/admin/migrate 套用
--
-- 金額一律以「新台幣元」的整數儲存，不使用小數。
-- ---------------------------------------------------------------------------
-- 員工名單（結帳頁面的下拉選單來源）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  id         SERIAL PRIMARY KEY,
  name       TEXT    NOT NULL,
  store_code TEXT    NOT NULL DEFAULT 'dazhong',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_unique_name UNIQUE (store_code, name)
);

CREATE INDEX IF NOT EXISTS staff_store_idx ON staff (store_code, active);

-- ---------------------------------------------------------------------------
-- 收入項目（對應紙本表單左欄）
-- 老闆可自行增減，順序決定畫面上的排列
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revenue_items (
  id         SERIAL PRIMARY KEY,
  store_code TEXT    NOT NULL DEFAULT 'dazhong',
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT revenue_items_unique UNIQUE (store_code, name)
);

CREATE INDEX IF NOT EXISTS revenue_items_store_idx ON revenue_items (store_code, active, sort_order);

-- ---------------------------------------------------------------------------
-- 收款方式（對應紙本表單右欄）
-- is_cash 為真的才會影響現金櫃結算
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
  id         SERIAL PRIMARY KEY,
  store_code TEXT    NOT NULL DEFAULT 'dazhong',
  name       TEXT    NOT NULL,
  is_cash    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT payment_methods_unique UNIQUE (store_code, name)
);

CREATE INDEX IF NOT EXISTS payment_methods_store_idx ON payment_methods (store_code, active, sort_order);

-- ---------------------------------------------------------------------------
-- 日結單
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_closings (
  id                SERIAL PRIMARY KEY,
  store_code        TEXT    NOT NULL,
  business_date     DATE    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'draft',   -- draft / locked / voided

  expected_revenue  INTEGER NOT NULL DEFAULT 0,  -- 收入小計（各收入項目加總）
  discount_total    INTEGER NOT NULL DEFAULT 0,  -- 折扣
  actual_total      INTEGER NOT NULL DEFAULT 0,  -- 收款合計（各收款方式加總）
  variance          INTEGER NOT NULL DEFAULT 0,  -- actual_total - (expected_revenue - discount_total)

  opening_float     INTEGER NOT NULL DEFAULT 0,  -- 開店零用金
  expected_cash     INTEGER NOT NULL DEFAULT 0,  -- 現金櫃應有 = 零用金 + 現金收款 - 現金雜支
  cash_counted      INTEGER NOT NULL DEFAULT 0,  -- 實際點鈔金額
  cash_variance     INTEGER NOT NULL DEFAULT 0,  -- cash_counted - expected_cash

  expense_total     INTEGER NOT NULL DEFAULT 0,
  headcount_total   INTEGER NOT NULL DEFAULT 0,
  session_count     INTEGER NOT NULL DEFAULT 0,

  variance_reason   TEXT,                        -- 差額說明（有差額時必填）
  notes             TEXT,
  staff_id          INTEGER REFERENCES staff (id),
  submitted_by      TEXT,                        -- 姓名快照：員工改名或停用後，歷史紀錄不變
  submitted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT daily_closings_unique UNIQUE (store_code, business_date)
);

CREATE INDEX IF NOT EXISTS closings_date_idx ON daily_closings (business_date DESC);

-- ---------------------------------------------------------------------------
-- 日結的收入明細（名稱一併快照，項目日後改名不影響已結的帳）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closing_revenue_lines (
  id         SERIAL PRIMARY KEY,
  closing_id INTEGER NOT NULL REFERENCES daily_closings (id) ON DELETE CASCADE,
  item_id    INTEGER,
  item_name  TEXT    NOT NULL,
  amount     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS closing_revenue_closing_idx ON closing_revenue_lines (closing_id);

-- ---------------------------------------------------------------------------
-- 收款明細
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_lines (
  id          SERIAL PRIMARY KEY,
  closing_id  INTEGER NOT NULL REFERENCES daily_closings (id) ON DELETE CASCADE,
  method_id   INTEGER,
  method_name TEXT    NOT NULL,  -- 名稱快照
  is_cash     BOOLEAN NOT NULL DEFAULT FALSE,
  amount      INTEGER NOT NULL DEFAULT 0,
  ref_no      TEXT,              -- 刷卡機結帳單號、平台批次號
  note        TEXT
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
-- 後續新增的欄位
-- CREATE TABLE IF NOT EXISTS 不會幫既有的表補欄位，所以另外列出來
-- ---------------------------------------------------------------------------
ALTER TABLE daily_closings ADD COLUMN IF NOT EXISTS staff_id       INTEGER REFERENCES staff (id);
ALTER TABLE daily_closings ADD COLUMN IF NOT EXISTS discount_total INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 收入項目 / 收款方式種子資料（依大忠店現行紙本表單）
-- ---------------------------------------------------------------------------
INSERT INTO revenue_items (name, store_code, sort_order) VALUES
  ('桌遊入場', 'dazhong', 10),
  ('出租',     'dazhong', 20),
  ('販售',     'dazhong', 30),
  ('詭廁',     'dazhong', 40),
  ('屎力全開', 'dazhong', 50),
  ('孤兒怨',   'dazhong', 60),
  ('越獄者',   'dazhong', 70),
  ('蝦皮',     'dazhong', 80),
  ('711',      'dazhong', 90)
ON CONFLICT (store_code, name) DO NOTHING;

INSERT INTO payment_methods (name, store_code, is_cash, sort_order) VALUES
  ('現金',     'dazhong', TRUE,  10),
  ('LINE Pay', 'dazhong', FALSE, 20),
  ('街口',     'dazhong', FALSE, 30),
  ('轉帳',     'dazhong', FALSE, 40),
  ('信用卡',   'dazhong', FALSE, 50),
  ('文化幣',   'dazhong', FALSE, 60),
  ('訂金',     'dazhong', FALSE, 70),
  ('蝦皮',     'dazhong', FALSE, 80),
  ('711',      'dazhong', FALSE, 90)
ON CONFLICT (store_code, name) DO NOTHING;
