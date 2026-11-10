-- Meeting Copilot: conversation history in Supabase Postgres.
-- Every row belongs to one Supabase Auth user; Row Level Security limits each user to their own rows.
-- Timestamps are epoch milliseconds (bigint), matching the SQLite schema and the shared CardRecord type.
-- What is stored: question/answer cards and minimal metadata. Never audio, transcripts, resume text, prompts or keys.

create table if not exists public.conversations (
  user_id     uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id          uuid    not null,
  title       text    check (title is null or char_length(title) <= 120),
  started_at  bigint  not null,
  updated_at  bigint  not null,
  simulated   boolean not null default false,
  primary key (user_id, id)
);

create index if not exists conversations_user_updated_idx on public.conversations (user_id, updated_at desc, id desc);

create table if not exists public.cards (
  user_id             uuid    not null default auth.uid(),
  id                  text    not null check (char_length(id) between 1 and 64),
  conversation_id     uuid    not null,
  created_at          bigint  not null,
  updated_at          bigint  not null,
  question            text    not null,
  source              text    not null check (source in ('auto', 'manual')),
  status              text    not null check (status in ('pending', 'completed', 'failed', 'cancelled')),
  answer              text,
  model               text,
  simulated           boolean not null default false,
  grounding_kind      text,
  grounding_evidence  text,
  grounding_sections  jsonb   not null default '[]'::jsonb check (jsonb_typeof(grounding_sections) = 'array'),
  first_token_ms      integer,
  duration_ms         integer,
  error_code          text,
  primary key (user_id, id),
  foreign key (user_id, conversation_id) references public.conversations (user_id, id) on delete cascade
);

create index if not exists cards_conversation_idx on public.cards (user_id, conversation_id, created_at);

-- Row Level Security: a signed-in user can only see and change their own rows. Anonymous access is denied.
alter table public.conversations enable row level security;
alter table public.cards enable row level security;

drop policy if exists "own conversations" on public.conversations;
create policy "own conversations" on public.conversations
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own cards" on public.cards;
create policy "own cards" on public.cards
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.conversations, public.cards from anon;
grant select, insert, update, delete on public.conversations, public.cards to authenticated;

-- List view with card count and first question (security_invoker: RLS of the caller applies).
create or replace view public.conversation_summaries with (security_invoker = true) as
select
  c.user_id, c.id, c.title, c.started_at, c.updated_at, c.simulated,
  (select count(*) from public.cards k where k.user_id = c.user_id and k.conversation_id = c.id)::integer as card_count,
  (select k.question from public.cards k where k.user_id = c.user_id and k.conversation_id = c.id
     order by k.created_at, k.id limit 1) as first_question
from public.conversations c;

revoke all on public.conversation_summaries from anon;
grant select on public.conversation_summaries to authenticated;

-- Atomic batch upsert used by the server's HistoryWriter (one transaction per call).
-- Conversations: keep the latest updated_at. Cards: an older version never overwrites a newer one.
create or replace function public.apply_history_batch(p_conversations jsonb default '[]'::jsonb, p_cards jsonb default '[]'::jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  insert into public.conversations (user_id, id, title, started_at, updated_at, simulated)
  select uid, (e->>'id')::uuid, null, (e->>'at')::bigint, (e->>'at')::bigint, coalesce((e->>'simulated')::boolean, false)
  from jsonb_array_elements(coalesce(p_conversations, '[]'::jsonb)) as e
  on conflict (user_id, id) do update
    set updated_at = greatest(public.conversations.updated_at, excluded.updated_at);

  insert into public.cards (user_id, id, conversation_id, created_at, updated_at, question, source, status, answer, model,
                            simulated, grounding_kind, grounding_evidence, grounding_sections, first_token_ms, duration_ms, error_code)
  select uid, e->>'id', (e->>'conversationId')::uuid, (e->>'createdAt')::bigint, (e->>'updatedAt')::bigint, e->>'question',
         e->>'source', e->>'status', e->>'answer', e->>'model', coalesce((e->>'simulated')::boolean, false),
         e->>'groundingKind', e->>'groundingEvidence', coalesce(e->'groundingSections', '[]'::jsonb),
         (e->>'firstTokenMs')::integer, (e->>'durationMs')::integer, e->>'errorCode'
  from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb)) as e
  on conflict (user_id, id) do update set
    updated_at = excluded.updated_at, question = excluded.question, status = excluded.status, answer = excluded.answer,
    model = excluded.model, simulated = excluded.simulated, grounding_kind = excluded.grounding_kind,
    grounding_evidence = excluded.grounding_evidence, grounding_sections = excluded.grounding_sections,
    first_token_ms = excluded.first_token_ms, duration_ms = excluded.duration_ms, error_code = excluded.error_code
  where excluded.updated_at >= public.cards.updated_at and public.cards.conversation_id = excluded.conversation_id;
end;
$$;

-- Deletes all of the caller's conversations (cards cascade) and returns their IDs.
create or replace function public.delete_all_history()
returns setof uuid
language sql
security invoker
set search_path = ''
as $$
  delete from public.conversations where user_id = auth.uid() returning id;
$$;

revoke execute on function public.apply_history_batch(jsonb, jsonb) from public, anon;
revoke execute on function public.delete_all_history() from public, anon;
grant execute on function public.apply_history_batch(jsonb, jsonb) to authenticated;
grant execute on function public.delete_all_history() to authenticated;
