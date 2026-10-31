package storage

import (
	"context"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

// 迁移 026（顾客预约的微信订阅消息）：从 025 的库升上来，已有的微信身份原样、还没有加密的 openid；
// 通知表只收合规的行——种类、状态只认那几个，失败的一定记着错误码、没失败的一定没有，一条预约一种通知只有一行，
// 预约和账户要真的存在。
func TestMigration026AddsReservationNotices(t *testing.T) {
	ctx := context.Background()
	pool := openPool(t, testdb.New(t))
	if err := runMigrate(t, pool, migrationsThrough(t, 25)); err != nil {
		t.Fatal(err)
	}
	var customer, area, table, reservation string
	for _, step := range []struct {
		sql  string
		args []any
		into *string
	}{
		{`INSERT INTO accounts(id,nickname,phone_verification_status,created_at,state) VALUES (gen_random_uuid(),'小林','unverified',now(),'{}') RETURNING id`, nil, &customer},
		{`INSERT INTO account_wechat_identities(account_id,identity_hash) VALUES ($1,'hash-1') RETURNING account_id`, []any{&customer}, new(string)},
		{`INSERT INTO floor_areas(id,name,grid_columns,grid_rows,locked,state) VALUES (gen_random_uuid(),'H 区',4,4,false,'{}') RETURNING id`, nil, &area},
		{`INSERT INTO service_tables(id,floor_area_id,number,seat_count,enabled,state,code) VALUES (gen_random_uuid(),$1,1,2,true,'{"Code":"H1"}','H1') RETURNING id`, []any{&area}, &table},
		{`INSERT INTO reservations(id,account_id,service_table_id,seat_number,start_at,duration_minutes,status,created_at,state)
			VALUES (gen_random_uuid(),$1,$2,1,now() + interval '3 hours',180,'pending',now(),'{"status":"pending"}') RETURNING id`, []any{&customer, &table}, &reservation},
	} {
		args := make([]any, 0, len(step.args))
		for _, a := range step.args {
			args = append(args, *(a.(*string)))
		}
		if err := pool.QueryRow(ctx, step.sql, args...).Scan(step.into); err != nil {
			t.Fatal(err)
		}
	}

	if err := runMigrate(t, pool, embeddedMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var sealed []byte
	var hash string
	if err := pool.QueryRow(ctx, `SELECT identity_hash, openid_sealed FROM account_wechat_identities WHERE account_id = $1`, customer).Scan(&hash, &sealed); err != nil || hash != "hash-1" || sealed != nil {
		t.Fatalf("已有的微信身份应原样、还没有加密的 openid：%s %v %v", hash, sealed, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE account_wechat_identities SET openid_sealed = '\x0102'::bytea WHERE account_id = $1`, customer); err != nil {
		t.Fatalf("存加密的 openid：%v", err)
	}

	insert := func(kind, status, failure, reservationID, account string) error {
		_, err := pool.Exec(ctx, `INSERT INTO reservation_notices(reservation_id,kind,account_id,status,failure,created_at,updated_at) VALUES ($1,$2,$3,$4,NULLIF($5,''),now(),now())`,
			reservationID, kind, account, status, failure)
		return err
	}
	for _, ok := range [][3]string{{"confirmed", "pending", ""}, {"reminder", "failed", "43101"}, {"cancelled", "void", ""}} {
		if err := insert(ok[0], ok[1], ok[2], reservation, customer); err != nil {
			t.Fatalf("%v：%v", ok, err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE reservation_notices SET status = 'sent' WHERE kind = 'confirmed'`); err != nil {
		t.Fatalf("发出去了：%v", err)
	}
	missing := "00000000-0000-4000-8000-000000000000"
	exec := func(sql string) error {
		_, err := pool.Exec(ctx, sql, missing)
		return err
	}
	for label, err := range map[string]error{
		"同一种通知第二行":  insert("confirmed", "pending", "", reservation, customer),
		"不认识的种类":    insert("birthday", "pending", "", reservation, customer),
		"不认识的状态":    insert("confirmed", "queued", "", reservation, customer),
		"失败了没记错误码":  exec(`UPDATE reservation_notices SET failure = NULL WHERE kind = 'reminder' AND $1::uuid IS NOT NULL`),
		"没失败却记着错误码": exec(`UPDATE reservation_notices SET failure = '43101' WHERE kind = 'cancelled' AND $1::uuid IS NOT NULL`),
		"错误码太长":     exec(`UPDATE reservation_notices SET failure = repeat('x', 41) WHERE kind = 'reminder' AND $1::uuid IS NOT NULL`),
		"预约不存在":     insert("confirmed", "pending", "", missing, customer),
		"账户不存在":     exec(`UPDATE reservation_notices SET account_id = $1 WHERE kind = 'cancelled'`),
	} {
		if err == nil {
			t.Errorf("%s应被拒绝", label)
		}
	}
}
