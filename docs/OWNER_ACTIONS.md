# Owner actions: what only you can do

Written 2026-11-21. Everything the code needs from outside lives here: the
company sign-ups, the settings to fill in on the server, and the store and
compliance steps. Each item says what to do, what to send, and what to give
back to the team, usually a key to put in the server's `.env`.

Server settings go in `/opt/myassistant/.env` on the VPS. Mirror each new
**name** (never the value) in `deploy/docker-vps/production.flags`, then
redeploy.

---

## 1. Service partnerships (cabs, food, groceries, medicines, parcels)

The app is wired end to end for all of these. Voice, booking or ordering,
confirmation, live status with driver or partner and OTP, the Home card and
Cancel all work today on built-in **test providers**. Each real company
switches on as soon as you complete its step.

| # | Company | What to do | What you get back | Server settings |
|---|---|---|---|---|
| 1 | **Swiggy** (food, Instamart) | Apply to **Builders Club** at mcp.swiggy.com/builders (approval in about 2 weeks). | Production access to Swiggy's AI-assistant (MCP) servers and an OAuth client. | `SWIGGY_CLIENT_ID`, `SWIGGY_CLIENT_SECRET`, `SWIGGY_REDIRECT_URI`, then `SWIGGY_ORDERS_ENABLED=on` |
| 2 | **Uber** (cabs) | Create an app at developer.uber.com and request the privileged **`request`** scope (Ride Requests API). | Client ID and secret, plus the scope approval. Use Uber's sandbox first. | `UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`, `UBER_REDIRECT_URI`, then `UBER_RIDES_ENABLED=on` |
| 3 | **Ola** (cabs) | Email **affiliates@olacabs.com** for an X-APP token with booking rights. | X-APP token, the current API docs, and how riders authorise. | `OLA_XAPP_TOKEN`, then `OLA_RIDES_ENABLED=on` |
| 4 | **Porter** (parcels, 2-wheeler) | Email **enterprise@theporter.in** for Enterprise API access, and fund the prepaid wallet. | API key and **their API documentation**. Send the docs to the team; the calls go in `src/orders/providers.js`. | `PORTER_API_KEY`, then `PORTER_API_KEY_READY=on` once wired |
| 5 | **Tata 1mg** (medicines) | Apply through 1mg.com/partnerships (Health Partner, ePharmacy). | Partner key and **API documentation**. Send the docs to the team. | `TATA1MG_API_KEY`, then `TATA1MG_API_KEY_READY=on` once wired |
| 6 | ONDC (optional, later) | Register as an ONDC buyer network participant (ondc.org). | Subscriber ID and certification. | Weeks to months; only if rides or groceries become core. |

**What every company will ask for.** Keep this ready as one PDF:
- **Company:** legal name, registered address, GSTIN, PAN, website, support
  email and phone, and an authorised signatory.
- **Product:** "MyAssistant, a voice assistant for professionals in India.
  Users ask by voice; we place the order or ride on the user's own account
  after they link it. Payment is handled by the provider; we store no card
  data."
- **Screens:** screenshots or a 1-minute video of the voice request, the
  spoken confirmation, the Home card (driver, OTP, Cancel) and the push
  notifications. Record it with the test providers switched on in a staging
  build (§5).
- **Volumes:** expected orders or rides per day at launch, and the cities
  (Bengaluru, Mangaluru…).
- **Policies:** `https://backend.envisionsit.in/legal/privacy` and
  `/legal/terms`, plus how a user unlinks and deletes data (You → Account →
  Delete).
- **Redirect URLs** (register these exactly):
  - `https://backend.envisionsit.in/link/uber/callback`
  - `https://backend.envisionsit.in/link/swiggy/callback`
  - `https://backend.envisionsit.in/link/ola/callback` (when Ola enables it)

**"Link your account" is built** (You → Linked Accounts in the app;
`src/accounts/` on the server). A user taps Link, signs in on the company's
own page, and comes back linked. Tokens are encrypted, refreshed
automatically, and removed on Unlink or account deletion. It switches on for
each company the moment its client ID is in `.env`. Ola appears as
"Available Soon" until Ola shares its rider sign-in flow.

Zomato, Blinkit, Zepto, BigBasket, Rapido, PharmEasy, Apollo 24|7 and Urban
Company offer no partner route today. They stay as "open the app". Do not use
the unofficial website-automation tools: they break those companies' terms
and can get users' accounts blocked.

---

## 2. Keys the server needs now (`.env`)

| Setting | Why | Where |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | Exact places for cabs and orders ("Majestic" becomes a precise drop-off). Without it, the provider searches the typed words. Business search uses it too. | Google Cloud Console → Places API |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Payment links on invoices (business and advocates) | dashboard.razorpay.com |
| `SERPAPI_KEY` | Flight search and fare watch | serpapi.com |
| `RIDES_MAX_FARE` (default 1500), `ORDERS_MAX_TOTAL` (default 2000) | Above these the assistant asks before booking or ordering | Your choice |
| `AGENT_CALL_ALLOWED_PREFIXES` (default `+91`) | Countries the AI may phone | Only if you serve other countries |

**Never set on production:** `RIDES_TEST_PROVIDER=on` or
`ORDERS_TEST_PROVIDER=on`. They exist for staging and demos. With them on,
real users would get pretend cabs and orders, clearly marked TEST.

---

## 3. Google Play release

1. **Play Console developer account**, as an organisation, with the D-U-N-S
   number.
2. **Build:** `flutter build appbundle --release --dart-define=STORE=play --android-project-arg=store=play`.
   This drops SEND_SMS, READ_CALL_LOG, self-update and the other permissions
   Play refuses. `android/key.properties` (the upload key) must exist.
3. **Declarations** in Play Console → App content:
   - **Accessibility service** (screen agent): prominent disclosure plus a
     video. If you don't want to declare it, ask the team to remove it from
     the Play build.
   - **Foreground services:** microphone (live voice) and special use
     (floating bubble), each with a video.
   - **Full-screen intent and exact alarms:** wake-up reminders (alarm app
     use).
   - **Health apps declaration** (clinic features).
   - **Data safety:**
     - location sent with requests
     - contacts
     - audio
     - documents
     - Firebase Analytics with the account id
     - Crashlytics
   - **AI-generated content** (headshots): in-app reporting is required.
4. **Play Billing products** for Pro, created in Play Console. The app's Pro
   screen collects early-access interest until billing is wired
   (`kBillingLive` in `premium_plans.dart`). Check the Feedback inbox,
   source "premium", to see which plan people want.
5. **Store listing:** the positioning and keywords are in
   `myassistant-flutter/docs/PRODUCT_READINESS.md`.

---

## 4. Compliance

- **TRAI 2026, AI-voice calls:** confirm with **Bolna** that the caller ID
  is declared for AI voice traffic, and that every call announces it is an
  AI assistant.
- **DPDP Act:** core duties apply from **13 May 2027**:
  - a privacy notice and consent (already in the app)
  - a 72-hour breach-report runbook
  - a one-year retention of access logs
  - processor terms for doctors (you hold their patients' data)

  Get a lawyer to review.
- **Public doctor and advocate pages:** registration numbers are not yet
  verified before going public. Decide on a manual check (admin approval)
  before marketing the listings.
- **Phone verification:** `ALLOW_DEV_PHONE_VERIFY=true` lets anyone claim a
  number. Turn it off before a public launch.

---

## 5. Security and operations (from SECURITY.md)

- **Rotate** ADMIN_KEY, JWT_SECRET (already rotated on 21 Nov), the Bolna
  key, the Firebase service account, and the VPS deploy key.
- **App Check:** revoke the debug token in Firebase.
- **CI deploys:** create the `ghdeploy` user on the server (setup in
  `deploy/docker-vps/README.md`). Until then, deploys are manual.
- **Alerts:** connect Prometheus/Grafana alerts to email or Slack.
- **Staging:** a second, small server or a separate compose project with
  `RIDES_TEST_PROVIDER=on` and `ORDERS_TEST_PROVIDER=on`. Use it for demos
  to partners and for the screen recordings they ask for.

---

## 6. What the team does as soon as you are back with each item

| You bring | The team does |
|---|---|
| Swiggy approval and credentials | Build the "Link Swiggy" screen and test real food and Instamart orders on the sandbox, then production |
| Uber credentials | Build the "Link Uber" screen and run sandbox rides, then real rides |
| Ola token and docs | Confirm the endpoints against their current docs and build "Link Ola" |
| Porter or 1mg docs | Fill in their calls in `src/orders/providers.js` and test |
| Places key | Nothing; it starts working at once |
| Play account | Upload the Play build and fill in the declarations with you |
