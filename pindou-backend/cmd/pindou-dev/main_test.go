package main

import (
	"testing"

	"github.com/jackc/pgx/v5"
)

// dsnFor 拼出来的连接串要能原样解析回去：密码里有引号、反斜杠、空格也不能串位。
func TestDSNForRoundTrips(t *testing.T) {
	tricky := false
	for _, source := range []string{
		"postgres://postgres:pindou-test@127.0.0.1:55433/postgres?sslmode=disable",
		`host=db.local port=6543 user='dev user' password='it\'s a \\ test' dbname=postgres sslmode=disable`,
	} {
		config, err := pgx.ParseConfig(source)
		if err != nil {
			t.Fatal(err)
		}
		tricky = tricky || config.Password == `it's a \ test`
		parsed, err := pgx.ParseConfig(dsnFor(config, "pindou_dev_1"))
		if err != nil {
			t.Fatalf("%s：拼出的连接串解析失败：%v", source, err)
		}
		if parsed.Host != config.Host || parsed.Port != config.Port || parsed.User != config.User ||
			parsed.Password != config.Password || parsed.Database != "pindou_dev_1" || parsed.TLSConfig != nil {
			t.Errorf("%s：往返后变成 host=%q port=%d user=%q dbname=%q（密码一致：%v）",
				source, parsed.Host, parsed.Port, parsed.User, parsed.Database, parsed.Password == config.Password)
		}
	}
	if !tricky {
		t.Fatal("没测到带引号和反斜杠的密码")
	}
}
