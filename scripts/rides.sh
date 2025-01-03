#!/bin/bash

# データベース接続情報
DB_USER="root"
DB_PASS="password"
DB_NAME="isuride"
DB_HOST="localhost"

# 共通の user_id を変数に設定
USER_ID=1

# 挿入するレコードの開始IDとレコード数
START_ID=11
NUM_RECORDS=10

# SQL文の初期化
SQL="INSERT INTO rides (
  id,
  user_id,
  chair_id,
  pickup_latitude,
  pickup_longitude,
  destination_latitude,
  destination_longitude,
  evaluation,
  created_at,
  updated_at
) VALUES"

# ループでVALUES句を生成
for ((i=0; i<NUM_RECORDS; i++)); do
  # 現在の日時を取得
  CURRENT_TIME=$(date '+%Y-%m-%d %H:%M:%S')
  
  # idを計算
  ID=$((START_ID + i))
  
  # VALUES句の作成
  VALUE="($ID, '$USER_ID', NULL, 26, 19, 38, 5, NULL, '$CURRENT_TIME', '$CURRENT_TIME')"
  
  # 最後のレコードにはカンマを付けない
  if [ $i -eq $((NUM_RECORDS - 1)) ]; then
    SQL+="$VALUE;"
  else
    SQL+="$VALUE,"
  fi
done

# MySQLコマンドを使用してデータを挿入
mysql -u "$DB_USER" -p"$DB_PASS" -h "$DB_HOST" "$DB_NAME" -e "$SQL"
