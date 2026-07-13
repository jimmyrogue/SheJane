package app

import (
	"context"

	stripe "github.com/stripe/stripe-go/v85"
)

type StripeCheckoutRequest struct {
	UserID      string
	Email       string
	AmountCents int64
	Currency    string
	Credits     int64
	ProductName string
	SuccessURL  string
	CancelURL   string
	Metadata    map[string]string
}

type StripeCheckoutSession struct {
	ID  string
	URL string
}

type StripeCheckoutClient interface {
	CreateCheckoutSession(ctx context.Context, request StripeCheckoutRequest) (StripeCheckoutSession, error)
}

type stripeCheckoutClient struct {
	client *stripe.Client
}

func NewStripeCheckoutClient(secretKey string) StripeCheckoutClient {
	return &stripeCheckoutClient{client: stripe.NewClient(secretKey)}
}

func (c *stripeCheckoutClient) CreateCheckoutSession(ctx context.Context, request StripeCheckoutRequest) (StripeCheckoutSession, error) {
	params := &stripe.CheckoutSessionCreateParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModePayment)),
		CustomerEmail:     stripe.String(request.Email),
		ClientReferenceID: stripe.String(request.UserID),
		SuccessURL:        stripe.String(request.SuccessURL),
		CancelURL:         stripe.String(request.CancelURL),
		Metadata:          request.Metadata,
		LineItems: []*stripe.CheckoutSessionCreateLineItemParams{
			{
				Quantity: stripe.Int64(1),
				PriceData: &stripe.CheckoutSessionCreateLineItemPriceDataParams{
					Currency:   stripe.String(request.Currency),
					UnitAmount: stripe.Int64(request.AmountCents),
					ProductData: &stripe.CheckoutSessionCreateLineItemPriceDataProductDataParams{
						Name: stripe.String(request.ProductName),
					},
				},
			},
		},
	}
	session, err := c.client.V1CheckoutSessions.Create(ctx, params)
	if err != nil {
		return StripeCheckoutSession{}, err
	}
	return StripeCheckoutSession{ID: session.ID, URL: session.URL}, nil
}
