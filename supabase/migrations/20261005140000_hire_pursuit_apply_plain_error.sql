-- Hiring workspace: hire_pursuit_apply refuses a stale write with an ordinary error (default SQLSTATE
-- P0001). SQLSTATE 40001 (serialization_failure) would be retried by the API layer until the request
-- times out, so a refused write would hang instead of failing at once. Then `npm run db:types`.

create or replace function hire_pursuit_apply(p_id uuid, p_expected_seq integer, p_row jsonb, p_event jsonb, p_new_keys text[]) returns integer language plpgsql as $$
declare n integer;
begin
  update hire_pursuits set
    contact = p_row->'contact', engagement = p_row->>'engagement', screening_consent = p_row->'screening_consent',
    disclosure = p_row->'disclosure', screening = p_row->'screening', handoff = p_row->>'handoff',
    ask = nullif(p_row->'ask', 'null'::jsonb), waiting_for = p_row->>'waiting_for', due_at = (p_row->>'due_at')::timestamptz,
    sent_to = p_row->>'sent_to', to_read = nullif(p_row->'to_read', 'null'::jsonb), closed_out = (p_row->>'closed_out')::boolean,
    version = p_row->>'version', seq = p_expected_seq + 1
  where id = p_id and seq = p_expected_seq;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'hire_pursuit_apply: % moved since it was read (expected seq %)', p_id, p_expected_seq;
  end if;
  insert into hire_pursuit_events (pursuit_id, seq, type, actor, at, ref, from_state, to_state, effects, version)
  values (p_id, p_expected_seq + 1, p_event->>'type', p_event->>'actor', (p_event->>'at')::timestamptz, p_event->>'ref',
    p_event->'from', p_event->'to', coalesce(p_event->'effects', '[]'::jsonb), p_event->>'version');
  if p_new_keys is not null and array_length(p_new_keys, 1) > 0 then
    insert into hire_pursuit_keys (key, pursuit_id) select k, p_id from unnest(p_new_keys) as k;
  end if;
  return p_expected_seq + 1;
end $$;
