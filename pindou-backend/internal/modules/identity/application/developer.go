package application

import (
	"errors"
	"regexp"
	"strings"
)

var developerAccountID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Developer access is provisioned by the operator, separately from shop roles.
func DeveloperAccounts(value string) (map[string]bool, error) {
	accounts := map[string]bool{}
	if strings.TrimSpace(value) == "" {
		return accounts, nil
	}
	for _, item := range strings.Split(value, ",") {
		id := strings.TrimSpace(item)
		if !developerAccountID.MatchString(id) {
			return nil, errors.New("PINDOU_DEVELOPER_ACCOUNT_IDS must contain comma-separated account UUIDs")
		}
		accounts[strings.ToLower(id)] = true
	}
	return accounts, nil
}

func ValidDeveloperMode(mode string) bool {
	switch mode {
	case "developer", "guest", "customer", "clerk", "manager", "owner":
		return true
	}
	return false
}
