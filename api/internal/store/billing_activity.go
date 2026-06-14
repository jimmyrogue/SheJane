package store

import (
	"sort"
	"strings"
	"time"

	"github.com/coldflame/shejane/api/internal/billing"
)

type billingTransactionWithRun struct {
	billing.Transaction
	RunID string
}

func buildBillingActivities(transactions []billingTransactionWithRun, llmCalls []LLMCallRecord, toolCalls []ExternalToolCallRecord, limit int) []BillingActivity {
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	builders := make(map[string]*BillingActivity)
	reservationRuns := make(map[string]string)
	for _, call := range llmCalls {
		if call.ReservationID != "" && call.RunID != "" {
			reservationRuns[call.ReservationID] = call.RunID
		}
	}
	for _, call := range toolCalls {
		if call.ReservationID != "" && call.RunID != "" {
			reservationRuns[call.ReservationID] = call.RunID
		}
	}

	for _, tx := range transactions {
		runID := strings.TrimSpace(tx.RunID)
		if runID == "" && tx.ReservationID != "" {
			runID = reservationRuns[tx.ReservationID]
		}
		key, kind := billingActivityKey(tx.Transaction, runID)
		activity := activityBuilder(builders, key, kind, runID, tx.CreatedAt)
		activity.Transactions = append(activity.Transactions, tx.Transaction)
		if tx.ReservationID != "" && !stringSliceContains(activity.ReservationIDs, tx.ReservationID) {
			activity.ReservationIDs = append(activity.ReservationIDs, tx.ReservationID)
		}
		mergeActivityTime(activity, tx.CreatedAt)
	}

	for _, call := range llmCalls {
		key, kind, runID := callActivityKey(call.RunID, call.ReservationID)
		activity := activityBuilder(builders, key, kind, runID, call.StartedAt)
		activity.LLMCalls = append(activity.LLMCalls, call)
		if call.ReservationID != "" && !stringSliceContains(activity.ReservationIDs, call.ReservationID) {
			activity.ReservationIDs = append(activity.ReservationIDs, call.ReservationID)
		}
		mergeActivityTime(activity, call.StartedAt)
		mergeActivityTime(activity, call.FinishedAt)
	}

	for _, call := range toolCalls {
		key, kind, runID := callActivityKey(call.RunID, call.ReservationID)
		activity := activityBuilder(builders, key, kind, runID, call.StartedAt)
		activity.ToolCalls = append(activity.ToolCalls, call)
		if call.ReservationID != "" && !stringSliceContains(activity.ReservationIDs, call.ReservationID) {
			activity.ReservationIDs = append(activity.ReservationIDs, call.ReservationID)
		}
		mergeActivityTime(activity, call.StartedAt)
		mergeActivityTime(activity, call.FinishedAt)
	}

	activities := make([]BillingActivity, 0, len(builders))
	for _, activity := range builders {
		finalizeBillingActivity(activity)
		activities = append(activities, *activity)
	}
	sort.Slice(activities, func(i, j int) bool {
		return activities[i].UpdatedAt.After(activities[j].UpdatedAt)
	})
	if len(activities) > limit {
		return activities[:limit]
	}
	return activities
}

func billingActivityKey(tx billing.Transaction, runID string) (string, string) {
	if strings.HasPrefix(tx.Type, "usage_") {
		if runID != "" {
			return "run:" + runID, "usage"
		}
		if tx.ReservationID != "" {
			return "reservation:" + tx.ReservationID, "usage"
		}
	}
	return "transaction:" + tx.ID, "ledger"
}

func callActivityKey(runID string, reservationID string) (string, string, string) {
	if runID != "" {
		return "run:" + runID, "usage", runID
	}
	if reservationID != "" {
		return "reservation:" + reservationID, "usage", ""
	}
	return "call", "usage", ""
}

func activityBuilder(builders map[string]*BillingActivity, key string, kind string, runID string, timestamp time.Time) *BillingActivity {
	if activity, ok := builders[key]; ok {
		if activity.RunID == "" {
			activity.RunID = runID
		}
		return activity
	}
	if timestamp.IsZero() {
		timestamp = time.Now().UTC()
	}
	activity := &BillingActivity{
		ID:           key,
		Kind:         kind,
		RunID:        runID,
		LLMCalls:     make([]LLMCallRecord, 0),
		ToolCalls:    make([]ExternalToolCallRecord, 0),
		Transactions: make([]billing.Transaction, 0),
		CreatedAt:    timestamp,
		UpdatedAt:    timestamp,
	}
	builders[key] = activity
	return activity
}

func finalizeBillingActivity(activity *BillingActivity) {
	reservedByReservation := make(map[string]int64)
	settledByReservation := make(map[string]int64)
	releasedByReservation := make(map[string]int64)

	for _, tx := range activity.Transactions {
		reservationID := tx.ReservationID
		switch tx.Type {
		case "usage_reserve":
			amount := absInt64(tx.Amount)
			activity.ReservedCredits += amount
			reservedByReservation[reservationID] += amount
		case "usage_settle":
			amount := absInt64(tx.Amount)
			activity.SettledCredits += amount
			settledByReservation[reservationID] += amount
		case "usage_release":
			amount := absInt64(tx.Amount)
			activity.ReleasedCredits += amount
			releasedByReservation[reservationID] += amount
		}
	}
	for reservationID, reserved := range reservedByReservation {
		settled := settledByReservation[reservationID]
		if settled > 0 && reserved > settled && releasedByReservation[reservationID] == 0 {
			activity.ReleasedCredits += reserved - settled
		}
	}
	activity.NetCredits = activity.SettledCredits

	sort.Strings(activity.ReservationIDs)
	sort.Slice(activity.Transactions, func(i, j int) bool {
		return activity.Transactions[i].CreatedAt.Before(activity.Transactions[j].CreatedAt)
	})
	sort.Slice(activity.LLMCalls, func(i, j int) bool {
		return activity.LLMCalls[i].StartedAt.Before(activity.LLMCalls[j].StartedAt)
	})
	sort.Slice(activity.ToolCalls, func(i, j int) bool {
		return activity.ToolCalls[i].StartedAt.Before(activity.ToolCalls[j].StartedAt)
	})
}

func mergeActivityTime(activity *BillingActivity, timestamp time.Time) {
	if timestamp.IsZero() {
		return
	}
	if activity.CreatedAt.IsZero() || timestamp.Before(activity.CreatedAt) {
		activity.CreatedAt = timestamp
	}
	if activity.UpdatedAt.IsZero() || timestamp.After(activity.UpdatedAt) {
		activity.UpdatedAt = timestamp
	}
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func stringSliceContains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
