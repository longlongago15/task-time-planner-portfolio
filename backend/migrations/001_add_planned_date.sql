-- MySQL migration for existing V1.0 databases.
ALTER TABLE tasks ADD COLUMN planned_date DATE NULL;
UPDATE tasks SET planned_date = CURRENT_DATE WHERE planned_date IS NULL;
ALTER TABLE tasks MODIFY COLUMN planned_date DATE NOT NULL;