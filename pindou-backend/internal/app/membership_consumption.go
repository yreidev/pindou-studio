package app

import (
	"errors"
	"time"

	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

type loyaltyConsumptionInput struct {
	PackageID   string `json:"packageId,omitzero"`
	Headcount   int    `json:"headcount"`
	DayType     string `json:"dayType"`
	AmountCents *int64 `json:"amountCents"`
	BoardUses   *int64 `json:"boardUses"`
}

func loyaltyServiceDate(date string, u *User, now time.Time) (string, error) {
	day, err := time.ParseInLocation("2006-01-02", date, storetime.Location)
	if err != nil || day.Format("2006-01-02") != date {
		return "", invalidInput{errors.New("请填写正确的门店日期")}
	}
	local := now.In(storetime.Location)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, storetime.Location)
	if day.After(today) {
		return "", invalidInput{errors.New("登记日期不能是将来")}
	}
	if day.Before(today.AddDate(0, 0, -7)) && !hasRole(u, Manager, Owner) {
		return "", errForbidden
	}
	return date, nil
}
