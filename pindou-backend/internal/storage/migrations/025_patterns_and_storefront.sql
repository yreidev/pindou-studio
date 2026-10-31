-- +goose Up

CREATE TABLE pattern_categories (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 10),
  position integer NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_by uuid REFERENCES accounts(id),
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX pattern_categories_name ON pattern_categories (name);

CREATE TABLE patterns (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  category_id uuid REFERENCES pattern_categories(id),
  published boolean NOT NULL,
  first_published_at timestamptz,
  position integer NOT NULL,
  image bytea NOT NULL,
  image_type text NOT NULL CHECK (image_type IN ('image/jpeg', 'image/png')),
  thumbnail bytea NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  image_version text NOT NULL CHECK (image_version <> ''),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL,
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL,
  CHECK (NOT published OR first_published_at IS NOT NULL)
);
CREATE INDEX patterns_position ON patterns (position);

CREATE TABLE storefront_announcement (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 200),
  expires_on date,
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL
);

INSERT INTO pattern_categories (id, name, position, enabled, created_at, updated_at) VALUES
  (gen_random_uuid(), '新手', 1, true, now(), now()),
  (gen_random_uuid(), '小动物', 2, true, now(), now()),
  (gen_random_uuid(), '水果', 3, true, now(), now()),
  (gen_random_uuid(), '花草', 4, true, now(), now());
