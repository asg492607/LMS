# MIT ADT LMS

Responsive React learning management system for MIT ADT University. The frontend uses Supabase Auth, and the protected Express API stores LMS records in Supabase Postgres.

## Supabase connection

The project is connected to the Supabase project configured by `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The initial migration is in `supabase/migrations/20261101000100_lms_postgres_store.sql`.

The browser bundle receives only the publishable key. The LMS record table is inaccessible to the Supabase `anon` and `authenticated` Data API roles. The Express API verifies Supabase access tokens and connects to Postgres using a separate `lms_backend` role with access only to the LMS record table. The database connection uses Supabase's root CA certificate with TLS verification enabled.

Keep `.env` private. It contains the backend database role credential. Never copy a database password or service credential into a `VITE_*` variable.

## Authentication and first administrator

Public email and password signups require email verification before the API grants access. Platform administrators can also create individual accounts from the admin dashboard when a server-only Supabase Auth Admin key is configured. Those admin-created accounts are confirmed at creation, receive a temporary password, and must change it at first sign-in. The LMS never stores that temporary password. Admins must confirm they are authorized to register the user's actual email address. Existing accounts can be assigned roles without changing their password or confirmation status.

The first account created for `asg492607@gmail.com` receives the platform administrator role from a database trigger. No password is created or stored for that account. The administrator must register with that email and verify it before opening the admin dashboard.

Administrators can assign scoped roles to existing accounts or create a new account and role together. Bulk role CSV files assign roles to existing accounts; new accounts are created individually so their temporary password is not placed in a CSV file.

## LMS features

The directory hierarchy is university → school → department → program cohort → academic year → semester → division → subject offering. Programs generate two semesters per academic year. Divisions and subjects are linked through teaching offerings.

Role dashboards provide role-scoped structure, people, courses, resources, announcements, attendance, assessments, submissions, and grades. Subject teachers and coordinators can create quizzes, assignments, resources, and announcements. Students can submit quizzes and written assignments. Quiz scores are calculated by the backend, and assignment grades are restricted to authorized teaching roles.

Dean, school administrator, and HOD workspaces include semester and division analysis for attendance, assessment completion, average scores, score bands, and aggregate learner risk. Manager reports do not include individual attendance names or written submissions.

## Local development

Keep the browser and API settings in separate files. Copy `.env.example` to ignored `.env` for the API, then copy `.env.local.example` to ignored `.env.local` for Vite. Put only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local`. The API `.env` holds the project URL and publishable key, the Auth Admin secret key (`SUPABASE_SECRET_KEY`, or legacy `SUPABASE_SERVICE_ROLE_KEY`), and the `lms_backend` database role credentials. Never give server credentials a `VITE_` prefix or commit them. Without the Auth Admin key, account provisioning is disabled while directory management can still run. Vite proxies `/api` to the Express API on port 4000.

Run `npm run env:check` to validate the local files without displaying credentials. Install dependencies with `npm install`. Start the API with `npm run server` and the Vite app with `npm run dev`.

## Deploy the API to Render

The root `render.yaml` is a Render Blueprint for the Express API. In Render, create a Blueprint from this GitHub repository and the `main` branch. It uses `npm ci --omit=dev`, starts with `npm run server`, binds to Render's `PORT` on `0.0.0.0`, and checks `/healthz` for API configuration and Postgres connectivity. The Blueprint keeps environment-specific credentials out of Git by prompting for variables marked `sync: false`.

Set `CORS_ORIGINS` to the exact origin of the deployed frontend (for local testing, include `http://localhost:5173`). Supply `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_HOST`, and `SUPABASE_DB_PASSWORD` from the Supabase project. Keep the secret key and database password in Render's environment settings only. Choose a Render region close to the Supabase database. The free web service may sleep when idle, so its first request after a quiet period can take longer.

## Security boundaries and current limits

- The publishable key is public by design; authorization is enforced by verified Supabase sessions, the API, and Postgres grants.
- Admin access is based on a server-side database role assignment, not a browser-supplied role or email alone.
- Bulk CSV imports are limited to 250 rows per upload and are validated before changes are applied.
- The LMS currently accepts HTTPS resource links; direct file upload and storage policies are not configured.
- Password reset and verification messages use the Supabase Auth email settings for this project.
- Production deployment still requires private environment variables on the hosting service, HTTPS, and an appropriate Supabase Auth email provider and redirect URL configuration.
