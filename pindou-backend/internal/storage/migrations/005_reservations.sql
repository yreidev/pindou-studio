CREATE TABLE reservations (
 id uuid PRIMARY KEY,
 account_id uuid REFERENCES accounts(id),
 service_table_id uuid NOT NULL REFERENCES service_tables(id),
 seat_number integer NOT NULL CHECK (seat_number > 0),
 start_at timestamptz NOT NULL,
 duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
 status text NOT NULL CHECK (status IN ('pending','confirmed','seated','cancelled','no_show')),
 venue_session_id uuid REFERENCES venue_sessions(id),
 created_at timestamptz NOT NULL,
 state jsonb NOT NULL
);
CREATE INDEX reservations_seat_window ON reservations(service_table_id,seat_number,start_at);
CREATE TABLE reservation_settings (id boolean PRIMARY KEY DEFAULT true CHECK (id), state jsonb NOT NULL);
