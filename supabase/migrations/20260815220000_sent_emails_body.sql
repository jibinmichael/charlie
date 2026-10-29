-- sent_emails: keep what we actually said.
--
-- WHY. Without these columns `sent_emails` records who was written to and which template was used,
-- never the words, and a send-only Resend key cannot fetch them back. A reply cannot be corrected
-- until somebody knows what it claimed: a system that does not write down what it did cannot be
-- checked or corrected afterwards.
--
-- THE SUBJECT AND THE TEXT HALF ONLY. The HTML is a rendering of the same words wrapped in a locked
-- shell, so storing it would multiply the size for nothing a human reading the record needs. The text
-- half is what the person could have read in a plain client, which is the honest record of what was
-- said.
--
-- SIZE. A text body runs 1 to 6 KB, so the table stays small; it has no retention policy.

alter table public.sent_emails add column if not exists subject   text;
alter table public.sent_emails add column if not exists body_text text;

-- Finding "what did we say to this person" is the query this exists for.
create index if not exists sent_emails_email_sent_idx on public.sent_emails (email, sent_at desc);
