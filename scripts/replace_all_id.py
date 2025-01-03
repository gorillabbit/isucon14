import re
from pathlib import Path
import csv

def replace_ids_with_mapping(insert_file, search_file, output_insert_file, output_search_file, mapping_file):
    """
    Replace IDs in one SQL file and update occurrences in another file, with ID mapping saved to a file.

    Args:
        insert_file (str): Path to the SQL file containing the INSERT INTO statements.
        search_file (str): Path to the SQL file where IDs will be replaced.
        output_insert_file (str): Path to save the updated INSERT INTO SQL file.
        output_search_file (str): Path to save the updated search SQL file.
        mapping_file (str): Path to save the ID mapping (original ID to new ID).
    """
    # Regular expressions
    insert_pattern = re.compile(r"INSERT INTO `(\w+)` VALUES")
    values_pattern = re.compile(r"\(([^)]+)\)")

    # Mapping of original IDs to new sequential IDs
    id_mapping = {}
    current_id = 1

    # Step 1: Process the insert file
    with open(insert_file, 'r', encoding='utf-8') as file:
        insert_content = file.read()

    # Find all INSERT INTO statements
    matches = insert_pattern.finditer(insert_content)
    for match in matches:
        table_name = match.group(1)
        start = match.end()
        values_block = insert_content[start:insert_content.find(";", start)]

        # Replace the first value in each row with a sequential number
        def replace_first_value(row_match):
            nonlocal current_id
            row_values = row_match.group(1).split(",")
            original_id = row_values[0].strip("'")
            if original_id not in id_mapping:
                id_mapping[original_id] = current_id
                current_id += 1
            row_values[0] = f"'{id_mapping[original_id]}'"
            return f"({','.join(row_values)})"

        updated_values = values_pattern.sub(replace_first_value, values_block)
        insert_content = insert_content.replace(values_block, updated_values)

    # Save the updated insert file
    with open(output_insert_file, "w", encoding="utf-8") as file:
        file.write(insert_content)

    # Step 2: Update IDs in the search file
    with open(search_file, "r", encoding="utf-8") as file:
        search_content = file.read()

    # Replace all occurrences of the original IDs with new IDs
    for original_id, new_id in id_mapping.items():
        search_content = search_content.replace(f"'{original_id}'", f"'{new_id}'")

    # Save the updated search file
    with open(output_search_file, "w", encoding="utf-8") as file:
        file.write(search_content)

    # Step 3: Save the ID mapping to a file
    with open(mapping_file, "w", encoding="utf-8", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["Original ID", "New ID"])
        for original_id, new_id in id_mapping.items():
            writer.writerow([original_id, new_id])

    print("Processing completed:")
    print(f"  Updated INSERT file: {output_insert_file}")
    print(f"  Updated SEARCH file: {output_search_file}")
    print(f"  ID mapping saved to: {mapping_file}")

# 使用例
insert_file_path = "output_tables/users.sql"  # INSERT INTO を含むファイル
search_file_path = "3-initial-data.sql"  # 検索して置換するファイル
output_insert_path = "output_tables/updated_insert_file.sql"  # 更新後のINSERTファイル
output_search_path = "output_tables/updated_search_file.sql"  # 更新後の検索ファイル
mapping_file_path = "output_tables/id_mapping.csv"  # マッピングを保存するCSVファイル

replace_ids_with_mapping(insert_file_path, search_file_path, output_insert_path, output_search_path, mapping_file_path)
