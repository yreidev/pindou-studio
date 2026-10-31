package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/testdb"
)

func avatarFixture(t *testing.T) string {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 24, 24))); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data.Bytes())
}

// TEST-USER-001: registration accepts an optional image atomically with the account.
func TestRegistrationAvatar(t *testing.T) {
	for _, mode := range []string{"omitted", "empty", "selected"} {
		t.Run(mode, func(t *testing.T) {
			s := newTestServer(t)
			input := map[string]any{"wechatLoginCode": "avatar-register", "nickname": "Customer", "phone": "13800135678", "privacyContractVersion": "v1"}
			if mode == "empty" {
				input["avatarDataUrl"] = ""
			} else if mode == "selected" {
				input["avatarDataUrl"] = avatarFixture(t)
			}
			response := call(t, s, "POST", "/api/v2/accounts", "", "", input)
			if response.Code != 201 {
				t.Fatal(response.Code, response.Body.String())
			}
			var session sessionResponse
			if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil {
				t.Fatal(err)
			}
			avatar := userOf(t, s, session.User.ID).AvatarDataURL
			if mode == "selected" && !strings.HasPrefix(avatar, "data:image/jpeg;base64,") {
				t.Fatal("selected avatar was not normalized")
			}
			if mode != "selected" && avatar != "" {
				t.Fatal("registration without avatar created one")
			}
			if session.User.AvatarDataURL != avatar {
				t.Fatal("registration response differs from stored avatar")
			}
			profile := call(t, s, "GET", "/api/v2/accounts/"+session.User.ID, session.AccessToken, "", nil)
			if profile.Code != 200 || (avatar != "" && decodeMap(t, profile)["avatarDataUrl"] != avatar) {
				t.Fatal("profile did not return saved avatar")
			}
			restored := serverOn(t, s.postgres)
			if userOf(t, restored, session.User.ID).AvatarDataURL != avatar {
				t.Fatal("restoration lost registration avatar")
			}
		})
	}
}

func TestRegistrationRejectsAvatarWithoutCreatingAccount(t *testing.T) {
	s := newTestServer(t)
	input := map[string]any{"wechatLoginCode": "avatar-retry", "nickname": "Customer", "phone": "13800135678", "privacyContractVersion": "v1", "avatarDataUrl": "wxfile://temporary"}
	response := call(t, s, "POST", "/api/v2/accounts", "", "", input)
	if response.Code != 400 || decodeMap(t, response)["code"] != "invalid_avatar" {
		t.Fatal("invalid registration avatar accepted")
	}
	if count(t, s, "accounts") != 0 || count(t, s, "account_wechat_identities") != 0 || count(t, s, "auth_sessions") != 0 {
		t.Fatal("invalid avatar created account, identity or session")
	}
	delete(input, "avatarDataUrl")
	if response := call(t, s, "POST", "/api/v2/accounts", "", "", input); response.Code != 201 {
		t.Fatal("registration cannot retry after removing avatar", response.Code)
	}
}

// TEST-USER-001: owned profile image, rejected updates, omission, clearing and restoration.
func TestAccountAvatarLifecycle(t *testing.T) {
	s := newTestServer(t)
	user := register(t, s, "avatar-customer", "Customer")
	owner := register(t, s, "avatar-owner", "Owner")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	url := "/api/v2/accounts/" + user.User.ID
	response := call(t, s, "PATCH", url, user.AccessToken, "", map[string]any{"nickname": "Updated", "avatarDataUrl": avatarFixture(t)})
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	avatar := decodeMap(t, response)["avatarDataUrl"].(string)
	if avatar == "" {
		t.Fatal("avatar missing")
	}
	if response := call(t, s, "PATCH", url, owner.AccessToken, "", map[string]any{"avatarDataUrl": ""}); response.Code != 403 {
		t.Fatal("other account can change avatar")
	}
	if response := call(t, s, "PATCH", url, user.AccessToken, "", map[string]any{"nickname": "Invalid", "avatarDataUrl": "wxfile://temporary"}); response.Code != 400 {
		t.Fatal("invalid avatar accepted")
	}
	if userOf(t, s, user.User.ID).Nickname != "Updated" || userOf(t, s, user.User.ID).AvatarDataURL != avatar {
		t.Fatal("rejected request changed profile")
	}
	if response := call(t, s, "PATCH", url, user.AccessToken, "", map[string]any{"nickname": "Renamed"}); response.Code != 200 {
		t.Fatal(response.Code)
	}
	if userOf(t, s, user.User.ID).AvatarDataURL != avatar {
		t.Fatal("omission cleared avatar")
	}
	restored := serverOn(t, s.postgres)
	if userOf(t, restored, user.User.ID).AvatarDataURL != avatar {
		t.Fatal("restoration lost avatar")
	}
	if response := call(t, s, "GET", "/api/v2/accounts", owner.AccessToken, "", nil); bytes.Contains(response.Body.Bytes(), []byte(avatar)) {
		t.Fatal("search list unnecessarily contains image bytes")
	}
	if response := call(t, s, "PATCH", url, user.AccessToken, "", map[string]any{"avatarDataUrl": ""}); response.Code != 200 || bytes.Contains(response.Body.Bytes(), []byte("avatarDataUrl")) {
		t.Fatal("clear failed")
	}
}

func TestPostgresAvatarSurvivesRestart(t *testing.T) {
	dsn := testdb.New(t)
	ctx := context.Background()
	db, err := storage.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := serverOn(t, db)
	user := register(t, s, "avatar-persistent", "Customer")
	response := call(t, s, "PATCH", "/api/v2/accounts/"+user.User.ID, user.AccessToken, "", map[string]any{"avatarDataUrl": avatarFixture(t)})
	if response.Code != 200 {
		t.Fatal(response.Code)
	}
	restarted := serverOn(t, db)
	if userOf(t, restarted, user.User.ID).AvatarDataURL != decodeMap(t, response)["avatarDataUrl"] {
		t.Fatal("PostgreSQL restart lost avatar")
	}
}
