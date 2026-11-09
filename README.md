# Koro Loans KE

A Node.js + PostgreSQL application portal with customer registration, phone OTP verification, customer application tracking and inbox, and a private admin review dashboard.

## Important before going live
This is a deployable application codebase, not a hosted/live website. Do not collect real customer data until the business's applicable lending authorization, privacy/data-protection obligations, customer notices, loan contracts, pricing and complaint process have been verified. The sample UI deliberately does not claim that an applicant is pre-approved. No application fee is charged by this code.

## Requirements
- Node.js 20+
- PostgreSQL database
- HTTPS hosting and a real domain for production
- Africa's Talking account and approved sender ID for live SMS

## Run locally
1. Create a PostgreSQL database, e.g. `koro_loans`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, a long random `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
3. Run `npm install`.
4. Run `psql "$DATABASE_URL" -f schema.sql`.
5. Run `npm start` and open `http://localhost:3000`.
6. Customer site: `/`. Admin sign-in: `/?admin=1`.

## SMS setup
`OTP_MODE` supports three values: `console` (prints OTPs in server logs; no SMS), `sandbox` (uses the Africa's Talking Sandbox API; test messages are simulated and do not reach real customers), and `live` (uses the production SMS API). For Sandbox set `AT_USERNAME=sandbox`, `AT_API_KEY` to the Sandbox API key, and `OTP_MODE=sandbox`. For live use your approved production username/API key and any approved sender ID, then set `OTP_MODE=live`. Keep secrets in the hosting provider's environment settings, never in source code or chat. Sandbox testing is not proof of live SMS delivery.

## Production checklist
- Use a managed PostgreSQL database with backups and restricted access.
- Set `NODE_ENV=production`, HTTPS, a unique `SESSION_SECRET`, and secure environment variables.
- Replace the simple environment-based administrator credential with a managed admin identity, MFA, password rotation and role controls before real use.
- Add CSRF protection, account recovery, consent and privacy notice/version logging, data retention/deletion workflows, access logging, monitoring and security testing.
- Confirm OTP delivery, resend limits, phone normalization, and provider delivery receipts.
- Have Kenyan counsel/compliance professionals validate the applicable CBK authorization and ODPC/data-protection requirements, loan disclosures, fees, interest, repayment terms and complaints handling.
- Do not enable M-Pesa collection or upfront fees until the exact lawful payment purpose and customer disclosures have been reviewed and an authorized merchant account is configured.

## Fee schedule
The previously discussed fee tiers are intentionally not configured as charges. Confirm their legal basis, whether they are one-time or recurring, and full disclosure requirements before adding any fee to a customer offer.
