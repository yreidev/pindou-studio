package application

import "testing"

func TestDeveloperAllowlistValidation(t *testing.T) {
	for _, value := range []string{"", "11111111-1111-4111-8111-111111111111", " 11111111-1111-4111-8111-111111111111 , 22222222-2222-4222-8222-222222222222 "} {
		if _, err := DeveloperAccounts(value); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"*", "owner", "11111111-1111-4111-8111-111111111111,"} {
		if _, err := DeveloperAccounts(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
