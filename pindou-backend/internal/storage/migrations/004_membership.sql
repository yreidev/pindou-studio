CREATE TABLE membership_drafts (id uuid PRIMARY KEY, state jsonb NOT NULL);
CREATE TABLE membership_publications (id uuid PRIMARY KEY, state jsonb NOT NULL);
CREATE TABLE membership_profiles (account_id uuid PRIMARY KEY REFERENCES accounts(id), state jsonb NOT NULL);
CREATE TABLE membership_entries (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 kind text NOT NULL, principal_cents bigint NOT NULL, gift_cents bigint NOT NULL,
 created_at timestamptz NOT NULL, state jsonb NOT NULL
);
CREATE INDEX membership_entries_account ON membership_entries(account_id,created_at);
CREATE TABLE membership_admissions (id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), state jsonb NOT NULL);
CREATE TRIGGER immutable_membership_entry BEFORE UPDATE OR DELETE ON membership_entries FOR EACH ROW EXECUTE FUNCTION protect_append_only();
CREATE TRIGGER immutable_membership_publication BEFORE UPDATE OR DELETE ON membership_publications FOR EACH ROW EXECUTE FUNCTION protect_append_only();
ALTER TABLE venue_sessions ADD COLUMN seat_number integer NOT NULL DEFAULT 0 CHECK (seat_number >= 0);
CREATE UNIQUE INDEX active_seat_session ON venue_sessions(service_table_id,seat_number) WHERE seat_number>0 AND status IN ('active','paused','companion');
ALTER TABLE payment_records DROP CONSTRAINT IF EXISTS payment_records_method_check;
ALTER TABLE payment_records ADD CONSTRAINT payment_records_method_check CHECK(method IN ('cash','wechat','alipay','balance'));
