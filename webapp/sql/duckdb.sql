-- 設定
PRAGMA enable_object_cache;

-- データベースの作成（DuckDBでは暗黙的に使用されるため、USE文は不要）
-- CHARACTER SETやCOLLATIONの設定は不要です

-- テーブルの削除
DROP TABLE IF EXISTS rides;
DROP TABLE IF EXISTS ride_statuses;

-- ridesテーブルの作成
CREATE TABLE rides (
  id                    VARCHAR NOT NULL,
  user_id               VARCHAR NOT NULL,
  chair_id              VARCHAR NULL,
  pickup_latitude       INTEGER NOT NULL,
  pickup_longitude      INTEGER NOT NULL,
  destination_latitude  INTEGER NOT NULL,
  destination_longitude INTEGER NOT NULL,
  evaluation            INTEGER NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  latest_status         VARCHAR NULL, -- ENUMの代わりにVARCHARを使用
  PRIMARY KEY (id)
);

-- インデックスの作成
CREATE INDEX idx_user_created ON rides (user_id, created_at);
CREATE INDEX idx_chair_updated ON rides (chair_id, updated_at);

-- コメントはDuckDBでは直接DDLに記述不可ですが、メタデータ管理を考慮する場合は以下で代用
-- COMMENT: 'ライド情報テーブル'

-- ride_statusesテーブルの作成
CREATE TABLE ride_statuses (
  id              VARCHAR NOT NULL,
  ride_id         VARCHAR NOT NULL,
  status          VARCHAR NOT NULL, -- ENUMの代わりにVARCHARを使用
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  app_sent_at     TIMESTAMP NULL,
  chair_sent_at   TIMESTAMP NULL,
  PRIMARY KEY (id)
);

-- インデックスの作成
CREATE INDEX idx_ride_created_status ON ride_statuses (ride_id, created_at, status);
CREATE INDEX idx_ride_created ON ride_statuses (ride_id, created_at);



COPY (
WITH LatestStatus AS (
    SELECT
        *
    FROM
        read_csv_auto('./webapp/sql/ride_statuses.csv') AS a
    JOIN
        read_csv_auto('./webapp/sql/rides.csv') AS b
    ON
        a.ride_id = b.id
    QUALIFY ROW_NUMBER() OVER (PARTITION BY a.ride_id ORDER BY a.created_at DESC) = 1
)
SELECT
id_1 AS id,
user_id,
chair_id,
pickup_latitude,
pickup_longitude,
destination_latitude,
destination_longitude,
evaluation,
created_at_1 AS created_at,
updated_at,
status AS latest_status
FROM LatestStatus
) TO './webapp/sql/rides_new.csv'
;