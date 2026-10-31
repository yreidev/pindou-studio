-- +goose Up

CREATE TABLE bead_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  palette text NOT NULL CHECK (palette <> ''),
  available text[],
  boxes jsonb NOT NULL CHECK (jsonb_typeof(boxes) = 'object'),
  board_size integer NOT NULL CHECK (board_size BETWEEN 10 AND 150),
  bead_size text NOT NULL CHECK (bead_size IN ('mini', 'midi')),
  revision integer NOT NULL CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL
);

CREATE TABLE bead_patterns (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  palette text NOT NULL CHECK (palette <> ''),
  width integer NOT NULL CHECK (width BETWEEN 4 AND 300),
  height integer NOT NULL CHECK (height BETWEEN 4 AND 300),
  colors text[] NOT NULL CHECK (cardinality(colors) <= 64),
  cells text NOT NULL CHECK (char_length(cells) = width * height),
  done text NOT NULL,
  preview text NOT NULL CHECK (char_length(preview) = preview_width * preview_height),
  preview_width integer NOT NULL CHECK (preview_width BETWEEN 1 AND 32),
  preview_height integer NOT NULL CHECK (preview_height BETWEEN 1 AND 32),
  beads integer NOT NULL CHECK (beads BETWEEN 0 AND width * height),
  done_beads integer NOT NULL CHECK (done_beads BETWEEN 0 AND beads),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX bead_patterns_account ON bead_patterns (account_id, updated_at DESC);
