CREATE TABLE IF NOT EXISTS projects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

ALTER TABLE tasks
    MODIFY COLUMN planned_date DATE NULL,
    ADD COLUMN planned_start_time TIME NULL,
    ADD COLUMN project_id INT NULL,
    ADD CONSTRAINT fk_tasks_project_id
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;