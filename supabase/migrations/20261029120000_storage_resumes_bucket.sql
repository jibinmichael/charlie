-- The private `resumes` Storage bucket: each job seeker's resume text, `<email>.txt`, written and read by
-- charlie-store.mjs with the service-role key. No earlier migration created it, so a fresh project failed
-- onboarding with "is the private resumes bucket created?". Idempotent: a project that already has the
-- bucket (created by hand) is left as it is.
--
-- The other private buckets: `cvs` is created by 20261005170000_hire_connections.sql; `job-pool` and
-- `voice-verification` are created by the code on first write.
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;
