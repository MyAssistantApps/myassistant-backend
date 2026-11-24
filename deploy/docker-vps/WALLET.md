# Wallet runbook

Operations guide for the MyAssistant wallet (`src/wallet/`): a closed-loop
rupee wallet on a double-entry ledger, topped up through Razorpay, with
refunds, a PIN step-up and referrals. Design: "MyAssistant Wallet,
Referrals & Razorpay — Design Plan".

## Settings (server `.env`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `WALLET_ENABLED` | off | `on` turns the wallet on; off, the app hides it |
| `WALLET_ALLOW_USERS` | empty | Comma-separated user ids; when set, only they see the wallet |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | — | Test keys (`rzp_test_…`) until launch, then live keys |
| `RAZORPAY_WEBHOOK_SECRET` | — | The webhook secret set in the Razorpay dashboard; without it every webhook is refused |
| `WALLET_MIN_TOPUP_PAISE` / `WALLET_MAX_TOPUP_PAISE` | 1000 / 1000000 | ₹10 to ₹10,000 per top-up |
| `WALLET_DAILY_TOPUP_PAISE` / `WALLET_CAP_PAISE` | 2000000 / 5000000 | ₹20,000 a rolling day; ₹50,000 held at once |
| `WALLET_STEPUP_PAISE` | 200000 | Spends above ₹2,000 need the PIN |
| `REFERRAL_REFERRER_PAISE` / `REFERRAL_REFEREE_PAISE` | 5000 / 2500 | ₹50 / ₹25 bonus |
| `REFERRAL_MIN_TOPUP_PAISE` | 10000 | The friend's first top-up must be ₹100 or more |
| `REFERRAL_HOLD_DAYS` / `REFERRAL_APPLY_DAYS` | 7 / 7 | Hold before payout; days after joining to enter a code |
| `REFERRAL_MONTHLY_CAP` / `REFERRAL_LIFETIME_CAP` | 10 / 50 | Referrer rewards |
| `BONUS_EXPIRY_DAYS` | 90 | Bonus lots expire |

Mirror any change in `deploy/vps/production.flags` (secrets as `<secret>`).

## Razorpay dashboard

1. Settings → API keys: generate the key pair (test, later live).
2. Settings → Webhooks → add `https://backend.envisionsit.in/payments/webhook`
   with a new secret, events: `payment.captured`, `payment.failed`,
   `order.paid`, `refund.processed`, `refund.failed`.
3. Payment capture: automatic.
4. Website pages Razorpay requires for a live account: terms, refund policy,
   privacy policy, contact.

## Launch (plan Phase 4)

1. Test keys and webhook secret on the server; `WALLET_ENABLED=on`,
   `WALLET_ALLOW_USERS=<team ids>`. Top up, spend, refund and refer on a phone.
2. Gate: 7 days of clean daily checks (no "Wallet ledger does not add up" or
   "captured payments were not credited" alerts in the developer inbox).
3. Live keys and a live webhook secret; team accounts again.
4. Clear `WALLET_ALLOW_USERS` (everyone), or list 10% of users first.

## Everyday checks

`GET /admin/wallet/health` (header `X-Admin-Key`): ledger drift and
unbalanced transactions must be empty; also flagged top-ups, open refunds,
referrals in review and the system account totals.

Alerts land in the developer inbox (`feedback/store.alert`):

| Alert | What to do |
| --- | --- |
| Wallet ledger does not add up | Stop and investigate before anything else; freeze affected wallets |
| Captured payments were not credited on time | The daily check already credited them; find why the webhook failed |
| Wallet top-up needs a look: mismatch / duplicate_payment / orphan | See below |
| Referral code used unusually often | Review it (approve or reject) |
| Bonus lots do not match bonus balances | Investigate with the user's admin view |

## Support tasks

All admin calls need `X-Admin-Key` and a `reason` (at least 5 characters);
each is written to the user's audit log.

- **User says they paid but see nothing**: `GET /admin/wallet/users/<id>`.
  A `created` top-up is credited within 10 minutes by the reconcile job once
  Razorpay reports it captured. `flagged` means the amount did not match or
  the account was erased: refund the payment in the Razorpay dashboard.
- **Paid twice for one top-up** (`duplicate_payment`): refund the second
  payment in the Razorpay dashboard; the wallet never credited it.
- **Freeze a wallet**: `POST /admin/wallet/users/<id>/freeze {reason}`; it
  can still receive captured money but cannot spend or refund.
  `…/unfreeze` reverses it.
- **Forgotten PIN**: `POST /admin/wallet/users/<id>/reset-pin {reason}`.
- **Goodwill credit or correction**: `POST /admin/wallet/adjust
  {user_id, kind: cash|bonus, amount_paise (±), reason, key}` — `key` is any
  unique string, so a repeated call does not credit twice.
- **Undo a spend** (an order that never arrived): `POST /admin/wallet/reverse
  {transaction_id, reason}`. Top-ups and refunds are not reversed this way.
- **Referral in review**: `POST /admin/wallet/referrals/<id>/approve` or
  `/reject {reason}`.

## Account deletion

Unspent cash is refunded to the original payment methods first; then the
wallet rows stay (financial records) with `user_id` cleared, the PIN and
referral code are deleted, and the referral links are cleared.

## Tests

`npm run test:wallet` (46 tests; set `DATABASE_URL` to a throwaway database
for the database part).
