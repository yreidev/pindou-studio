package app

import (
	"errors"
	"net/http"

	identityapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/application"
)

// ConfigureDeveloperAccounts is called before serving requests.
func (s *Server) ConfigureDeveloperAccounts(value string) error {
	accounts, err := identityapp.DeveloperAccounts(value)
	if err != nil {
		return err
	}
	s.developers = accounts
	return nil
}

// sessionUser 是这次会话里的账户。开发者可以选体验身份看各角色的界面，但体验身份只能降不能升：
// 不高于真实任命（店员 < 店长 < 老板），高于时当顾客看；没选（developer）时就是真实任命。
// 所以开发者白名单本身不给任何权限，撤销任命同样立即生效。
func (s *Server) sessionUser(u *User, session authSession) User {
	v := cloneUser(u)
	if !s.developers[u.ID] {
		return v
	}
	v.DeveloperMode = session.DeveloperMode
	if v.DeveloperMode == "" {
		v.DeveloperMode = "developer"
	}
	switch mode := Role(v.DeveloperMode); mode {
	case Clerk, Manager, Owner:
		v.Roles = []Role{}
		if roleRank(mode) <= highestRoleRank(u.Roles) {
			v.Roles = []Role{mode}
		}
	case "developer":
	default: // guest、customer：按顾客看
		v.Roles = []Role{}
	}
	return v
}

func roleRank(role Role) int {
	switch role {
	case Clerk:
		return 1
	case Manager:
		return 2
	case Owner:
		return 3
	}
	return 0
}

func highestRoleRank(roles []Role) int {
	highest := 0
	for _, role := range roles {
		highest = max(highest, roleRank(role))
	}
	return highest
}

func (s *Server) switchDeveloperMode(w http.ResponseWriter, r *http.Request) {
	u, err := s.userFor(r)
	if err != nil {
		s.writeError(w, r, 401, "unauthorized", err)
		return
	}
	if !s.developers[u.ID] {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	var in struct {
		Mode string `json:"mode"`
	}
	if err := decode(r, &in); err != nil || !identityapp.ValidDeveloperMode(in.Mode) {
		s.writeError(w, r, 400, "invalid_request", errForbidden)
		return
	}
	q := s.tx(r)
	oldKey := identityKey(bearerCredential(r))
	session, _ := q.authSession(oldKey)
	// 体验身份只在小程序里切：网页后台会话始终按真实任命
	if session.Client == clientWeb {
		s.writeError(w, r, 403, "forbidden", errors.New("网页后台不能切换体验身份，请在小程序里切换"))
		return
	}
	account := q.user(u.ID)
	if mode := Role(in.Mode); roleRank(mode) > highestRoleRank(account.Roles) {
		s.writeError(w, r, 403, "forbidden", errors.New("体验身份不能高于你的真实角色"))
		return
	}
	session.DeveloperMode = in.Mode
	accessToken := token()
	q.deleteAuthSession(oldKey)
	q.putAuthSession(identityKey(accessToken), session)
	q.audit(u.ID, "developer.mode_switched", u.ID, u.DeveloperMode+" -> "+in.Mode, requestID(r))
	writeJSON(w, 201, map[string]any{"accessToken": accessToken, "expiresAt": session.ExpiresAt, "user": s.sessionUser(account, session)})
}
