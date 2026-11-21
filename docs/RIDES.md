# Booking cabs by voice

"Book a cab from Yeshwanthpur to Majestic" → booked, confirmed, followed to
the end. Built 2026-11-21. Code: `src/rides/` (service, providers, routes),
tools `book_ride` / `ride_status` / `cancel_ride` in `src/tools/builtins.js`,
app card `lib/features/home/ride_strip.dart`. Tests: `npm run test:rides`.

## How it works

1. **Voice.** The assistant calls `book_ride` with `destination`, and `pickup`
   only when one was named (otherwise the phone's location). It never asks
   which company: the cheapest available provider is chosen, unless the user
   names Uber or Ola.
2. **Places.** Pickup and drop-off are resolved to coordinates. A match more
   than `RIDES_MAX_KM` (100) km away is treated as another place with the same
   name and dropped.
3. **Quotes.** Every bookable provider gives an estimate; real providers are
   preferred over the test one. A fare above `RIDES_MAX_FARE` (₹1,500) is
   only booked after the user says yes (`confirm_fare: true`).
4. **Booking.** The ride is booked and stored in `ride_bookings`. The
   assistant says: "Booked. A <provider> cab from X to Y, about Rs N. It is
   finding you a driver now…". Only one ride can be active at a time.
5. **Follow-up.** The `ride_status` job polls every `RIDES_POLL_MS` (15 s).
   Each change sends one push (`kind: ride_update`):
   - **Driver assigned:** name, car, number plate, **OTP**, arrival time.
   - **Arriving:** plate and OTP.
   - **Trip started.**
   - **Completed:** with the fare.
   - **No driver found** and **cancelled.**

   The driver, car and OTP are sent even if a poll first sees the cab
   already arriving.
6. **Home.** The "Your Ride" card (GET `/rides/active`) shows the driver, car,
   plate and a large OTP, with Cancel (POST `/rides/:id/cancel`).
7. **More voice commands.** "What is my OTP?" and "Where is my cab?" use
   `ride_status`; "Cancel my cab" uses `cancel_ride`.
8. **No provider live.** `book_ride` falls back to the provider's own confirm
   screen with the trip pre-filled (Uber's documented universal link). This
   works today without any agreement.

## Providers

| Provider | Switch | Status |
|---|---|---|
| Test Cabs | `RIDES_TEST_PROVIDER=on` | Simulated end to end: driver, car, 4-digit OTP, statuses. Never contacts anyone, and every message says "TEST". **Off by default; never enable it on production for real users.** |
| Uber | `UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`, `UBER_REDIRECT_URI`, `UBER_RIDES_ENABLED=on` | Coded against the Ride Requests API (estimate, request, status, cancel). Needs Uber's approval and each rider's linked Uber account. |
| Ola | `OLA_XAPP_TOKEN`, `OLA_RIDES_ENABLED=on` | Coded against Ola's partner booking API. Needs Ola's XAPP token and each rider's Ola authorisation. |

Riders' provider tokens live in `ride_accounts`. Account linking (the OAuth
screens) is the one piece still to build once a provider approves: it
cannot be tested before they issue credentials.

## What to send each provider

### Uber: Ride Requests API (developer.uber.com)

1. **Create an app** at developer.uber.com (Rides API product). You get a
   **Client ID** and **Client Secret**.
2. **Redirect URI** to register: `https://backend.envisionsit.in/rides/uber/callback`
3. **Scopes to request:** `profile`, `request` (privileged), `request_receipt`
   (privileged), `places` (optional).
4. **Privileged access request.** Uber's partnerships team reviews it, so
   tell them:
   - **Company:** your registered business name, address, GSTIN, website,
     support email and phone.
   - **Product:** MyAssistant, a voice assistant for professionals in India.
     Users ask by voice; the app books a ride on the user's own Uber account
     after they link it (OAuth). Uber shows the fare and handles payment; we
     never touch card data.
   - **Expected volume:** rides per day at launch, and the cities
     (Bengaluru, Mangaluru…).
   - **User experience:** screenshots or a video of the voice request, the
     confirmation, and the Home ride card showing the driver, car, OTP and
     Cancel.
   - **Policies:** links to the privacy policy and terms
     (`/legal/privacy`, `/legal/terms`), and how the user can unlink and
     delete data.
   - **Webhook URL** for status changes (optional; we poll today):
     `https://backend.envisionsit.in/rides/uber/webhook`.
5. **Sandbox.** Uber provides `sandbox-api.uber.com` for testing requests
   without real drivers. Set `UBER_API_BASE` to it while testing.

### Ola: partner / affiliate API (developers.olacabs.com)

Email **affiliates@olacabs.com** asking for an **X-APP token** for ride
booking (not just deep links), with:
- Company details: legal name, address, GSTIN, website, contact person.
- Use case: voice booking on the rider's own Ola account. Ask what Ola
  offers for user authorisation (OAuth or an SDK).
- Expected volume, cities, and screenshots of the flow.
- Privacy policy and terms links.
- Ask whether they have a sandbox, and for their current API documentation.
  The public docs exist but may be out of date.

### ONDC mobility (Namma Yatri and other drivers)

Register as an **ONDC buyer network participant** (ondc.org):
- Business entity documents, GSTIN, PAN.
- A subscriber ID (domain) and signing and encryption key pairs.
- A Beckn-compliant buyer app integration, which ONDC certifies in
  pre-production.

This takes weeks to months. Worth it only if rides become a core feature.

## The OTP

- **Test Cabs:** always 4 digits. It appears in the "Driver Assigned" push,
  on the Home card, and in answer to "What is my OTP?" (read digit by digit).
- **Uber:** a ride PIN appears only when the rider has turned PIN
  verification on in the Uber app. When the API returns it, it is shown the
  same way; otherwise the card shows the plate and driver only.
- **Ola:** returns a start-trip OTP in the track-ride response, shown the
  same way.
