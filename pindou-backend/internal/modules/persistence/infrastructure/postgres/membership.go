package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// membershipTables 是快照 Membership 下的子集合与各自的表；会员资料按账户作键。
var membershipTables = []struct{ collection, table, key string }{
	{"drafts", "membership_drafts", "id"},
	{"publications", "membership_publications", "id"},
	{"profiles", "membership_profiles", "account_id"},
	{"entries", "membership_entries", "id"},
	{"admissions", "membership_admissions", "id"},
}

// SaveMembership 写入 doc 里会员的一个子集合（drafts、publications、profiles、entries、admissions）。
// doc 的形状是 {"Membership": {子集合: {键: 记录}}}，只含要写的记录。
func SaveMembership(ctx context.Context, tx pgx.Tx, collection string, doc []byte) error {
	for _, t := range membershipTables {
		if t.collection != collection {
			continue
		}
		query := "INSERT INTO " + t.table + "(" + t.key + ",state) SELECT key::uuid,value FROM jsonb_each(COALESCE($1::jsonb->'Membership'->$2,'{}')) ON CONFLICT(" + t.key + ") DO UPDATE SET state=excluded.state WHERE " + t.table + ".state IS DISTINCT FROM excluded.state"
		switch t.collection {
		case "entries":
			query = `INSERT INTO membership_entries(id,account_id,kind,principal_cents,gift_cents,created_at,state) SELECT key::uuid,(value->>'accountId')::uuid,value->>'kind',(value->>'principalCents')::bigint,(value->>'giftCents')::bigint,(value->>'createdAt')::timestamptz,value FROM jsonb_each(COALESCE($1::jsonb->'Membership'->$2,'{}')) ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE membership_entries.state IS DISTINCT FROM excluded.state`
		case "admissions":
			query = `INSERT INTO membership_admissions(id,account_id,state) SELECT key::uuid,(value->>'accountId')::uuid,value FROM jsonb_each(COALESCE($1::jsonb->'Membership'->$2,'{}')) ON CONFLICT(id) DO UPDATE SET state=excluded.state WHERE membership_admissions.state IS DISTINCT FROM excluded.state`
		}
		if _, err := tx.Exec(ctx, query, string(doc), t.collection); err != nil {
			return fmt.Errorf("save membership %s: %w", collection, err)
		}
		return nil
	}
	return fmt.Errorf("unknown membership collection %s", collection)
}
