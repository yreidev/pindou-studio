ALTER TABLE auth_sessions ADD COLUMN client text NOT NULL DEFAULT 'miniapp' CHECK (client IN ('miniapp', 'web'));
