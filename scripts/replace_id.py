def remove_first_value_from_values_file(input_file, output_file):
    with open(input_file, 'r', encoding='utf-8') as infile:
        values_string = infile.read().strip()

    # 各VALUESの行を分割して処理
    rows = values_string.split("),(")
    processed_rows = []

    for row in rows:
        # 先頭の括弧や末尾の括弧を処理
        row = row.strip("()")
        values = row.split(",", 1)  # 最初のカンマだけで分割
        if len(values) > 1:
            processed_rows.append(values[1])  # 最初の値を削除した部分を保存

    # 再度カッコで結合して出力形式に戻す
    output_values = f"({'),('.join(processed_rows)})"

    with open(output_file, 'w', encoding='utf-8') as outfile:
        outfile.write(output_values)

# 使用例
input_file = "input.sql"  # 入力ファイルのパス
output_file = "output.sql"  # 出力ファイルのパス

remove_first_value_from_values_file(input_file, output_file)
