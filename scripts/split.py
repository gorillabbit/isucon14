import re
from pathlib import Path

def split_sql_file_by_table(input_file, output_dir):
    """
    Splits a SQL dump file into separate files for each table based on INSERT INTO statements.
    
    Args:
        input_file (str): Path to the input SQL file.
        output_dir (str): Directory where the split files will be saved.
    """
    # Create the output directory if it doesn't exist
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Regular expression to identify table-specific data blocks
    table_pattern = re.compile(r"INSERT INTO `(\w+)` VALUES")
    
    # Initialize variables
    current_table = None
    current_table_data = []

    # Read the input file
    with open(input_file, 'r', encoding='utf-8') as file:
        lines = file.readlines()

    # Process each line
    for line in lines:
        # Check for new table block
        table_match = table_pattern.match(line)
        if table_match:
            # Save the current table data if it exists
            if current_table and current_table_data:
                table_file = output_dir / f"{current_table}.sql"
                with open(table_file, 'w', encoding='utf-8') as table_file:
                    table_file.write("\n".join(current_table_data))
            
            # Start a new table block
            current_table = table_match.group(1)
            current_table_data = [line]
        elif current_table:
            # Append data to the current table block
            current_table_data.append(line)

    # Write the last table data block
    if current_table and current_table_data:
        table_file = output_dir / f"{current_table}.sql"
        with open(table_file, 'w', encoding='utf-8') as table_file:
            table_file.write("\n".join(current_table_data))

    print(f"SQL data has been split into table-specific files in '{output_dir}'.")

# 使用例
input_file_path = "3-initial-data.sql"  # 入力SQLファイル
output_directory = "output_tables"  # 分割されたSQLファイルを保存するディレクトリ

split_sql_file_by_table(input_file_path, output_directory)
