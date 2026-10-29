-- What people told us in a reply, filed where it can be read.
--
-- Replies often state a pay expectation, a notice period, a work mode, or an account of work the
-- person has done. These columns put that onto the person's record instead of leaving it unread in
-- inbound_messages.
--
-- WHY comp_expected_raw EXISTS ALONGSIDE THE NUMBER. comp_expected is numeric. What people actually
-- write is "up to 30 lakhs", "30L", "$9000 per year", "90 days, but negotiable to 30 days", or a
-- figure with a typo in it. Parsing prose into a number invents a figure for a
-- person and then quotes it back to a client as if they had said it. Store the sentence. If a clean
-- number can be read out of it later, that is a separate decision with a human in it.
--
-- WHY signals IS jsonb AND NOT A SCORE. Each entry is {label, quote}: the observation and the words
-- that produced it, same cite-or-drop rule as everything else that describes a person. The labels
-- come from a vocabulary discovered FROM the corpus and approved by hand, not from a list somebody
-- wrote in advance: a private taxonomy stated as a standard is a standard nobody agreed to. A signal is a thing they said. It is never a rating and never a ranking.
--
-- BLANK MEANS WE WERE NOT TOLD. Not "no", not "zero", not "unwilling to say".

alter table talent_pool
  -- Their pay expectation and notice in their own words, exactly as written. Verbatim, never parsed.
  add column if not exists comp_expected_raw text,
  -- [{label, quote}] -- what their messages said about their work, each with its citation.
  add column if not exists signals           jsonb,
  add column if not exists signals_read_at   timestamptz;

create index if not exists talent_pool_signals_read_idx on talent_pool (signals_read_at)
  where signals_read_at is not null;

comment on column talent_pool.comp_expected_raw is
  'Pay expectation in the person''s own words, verbatim. comp_expected is the numeric column; this one is never parsed into it automatically, because inventing a figure for a person is the one thing this product does not do.';
comment on column talent_pool.signals is
  'jsonb [{label, quote}]. Observations about what a person''s messages SAID, each carrying the words that produced it. Labels come from a corpus-discovered, hand-approved vocabulary. Never a score, never a rank, never a verdict about the person.';
