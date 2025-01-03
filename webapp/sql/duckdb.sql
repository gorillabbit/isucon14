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

CREATE TABLE chairs AS
    SELECT * FROM read_csv('./webapp/sql/chairs.csv');
CREATE TABLE chair_locations AS
    SELECT * FROM read_csv('./webapp/sql/chair_locations.csv');
CREATE TABLE chairs_total AS
    SELECT * FROM read_csv('./webapp/sql/chairs_total.csv');

COPY (
WITH DiffCalculation AS (
    SELECT
        chair_id,
        latitude,
        longitude,
        LAG(latitude) OVER (PARTITION BY chair_id ORDER BY created_at) AS prev_latitude,
        LAG(longitude) OVER (PARTITION BY chair_id ORDER BY created_at) AS prev_longitude
    FROM
        read_csv_auto('./webapp/sql/chair_locations.csv')
),
CalculatedSums AS (
    SELECT
        chair_id,
        SUM(ABS(latitude - prev_latitude) + ABS(longitude - prev_longitude)) AS total_diff
    FROM
        DiffCalculation
    WHERE
        prev_latitude IS NOT NULL -- 最初の行には差分がないため除外
    GROUP BY
        chair_id
)
SELECT * FROM CalculatedSums
) TO './webapp/sql/chairs_total.csv';

COPY (
SELECT 
    chairs.id,
    chairs.owner_id,
    chairs.name,
    chairs.model,
    chairs.is_active,
    chairs.access_token,
    chairs.created_at,
    chairs.updated_at,
    chair_locations.latitude,
    chair_locations.longitude
FROM chair_locations
JOIN chairs ON chairs.id = REPLACE(chair_locations.chair_id, '''', '')
JOIN chairs_total ON chairs_total.chair_id = chairs.id
WHERE chair_locations.created_at = (
    SELECT MAX(created_at)
    FROM chair_locations
    WHERE  chairs.id =  REPLACE(chair_locations.chair_id, '''', '')
)
ORDER BY chairs.id, chair_locations.created_at DESC
) TO './webapp/sql/chairs_new.csv';