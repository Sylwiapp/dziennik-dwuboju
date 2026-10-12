-- Uruchom cały plik w Supabase > SQL Editor.
-- Konta obsługuje Supabase Auth. Dane zawodnika widzi on sam i przypisani trenerzy.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 2 and 80),
  role text not null check (role in ('coach', 'athlete')),
  created_at timestamptz not null default now()
);

create table if not exists public.coach_athletes (
  coach_id uuid not null references public.profiles(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (coach_id, athlete_id),
  check (coach_id <> athlete_id)
);

create table if not exists public.athlete_data (
  athlete_id uuid primary key references public.profiles(id) on delete cascade,
  data jsonb not null default '{"seq":0,"records":[],"microcycles":[],"sessions":[]}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles(id) on delete cascade,
  code text not null unique,
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_role text;
  requested_name text;
begin
  requested_role := case
    when new.raw_user_meta_data ->> 'role' = 'coach' then 'coach'
    else 'athlete'
  end;
  requested_name := trim(coalesce(new.raw_user_meta_data ->> 'full_name', 'Użytkownik'));
  if char_length(requested_name) < 2 then
    requested_name := 'Użytkownik';
  end if;

  insert into public.profiles (id, full_name, role)
  values (new.id, left(requested_name, 80), requested_role);

  if requested_role = 'athlete' then
    insert into public.athlete_data (athlete_id) values (new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_coach_of(target_athlete uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.coach_athletes
    where coach_id = auth.uid() and athlete_id = target_athlete
  );
$$;

create or replace function public.create_athlete_invitation()
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  generated_code text;
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'coach'
  ) then
    raise exception 'Tylko trener może tworzyć zaproszenia.';
  end if;

  generated_code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 10));
  insert into public.invitations (coach_id, code)
  values (auth.uid(), generated_code);
  return generated_code;
end;
$$;

create or replace function public.claim_athlete_invitation(invitation_code text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  invitation public.invitations%rowtype;
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'athlete'
  ) then
    raise exception 'Zaproszenie może przyjąć konto zawodnika.';
  end if;

  select * into invitation
  from public.invitations
  where code = upper(trim(invitation_code))
    and used_by is null
    and expires_at > now()
  for update;

  if invitation.id is null then
    raise exception 'Kod jest nieprawidłowy, wykorzystany albo wygasł.';
  end if;

  insert into public.coach_athletes (coach_id, athlete_id)
  values (invitation.coach_id, auth.uid())
  on conflict do nothing;

  update public.invitations
  set used_by = auth.uid(), used_at = now()
  where id = invitation.id;
end;
$$;

create or replace function public.list_my_athletes()
returns table (id uuid, full_name text, updated_at timestamptz)
language sql
stable
security definer set search_path = public
as $$
  select p.id, p.full_name, d.updated_at
  from public.coach_athletes ca
  join public.profiles p on p.id = ca.athlete_id
  left join public.athlete_data d on d.athlete_id = ca.athlete_id
  where ca.coach_id = auth.uid()
  order by p.full_name;
$$;

alter table public.profiles enable row level security;
alter table public.coach_athletes enable row level security;
alter table public.athlete_data enable row level security;
alter table public.invitations enable row level security;

drop policy if exists "profile self or linked coach" on public.profiles;
create policy "profile self or linked coach"
on public.profiles for select
using (
  id = auth.uid()
  or public.is_coach_of(id)
);

drop policy if exists "athlete data self select" on public.athlete_data;
create policy "athlete data self select"
on public.athlete_data for select
using (athlete_id = auth.uid() or public.is_coach_of(athlete_id));

drop policy if exists "athlete data self insert" on public.athlete_data;
create policy "athlete data self insert"
on public.athlete_data for insert
with check (athlete_id = auth.uid());

drop policy if exists "athlete data self or coach update" on public.athlete_data;
create policy "athlete data self or coach update"
on public.athlete_data for update
using (athlete_id = auth.uid() or public.is_coach_of(athlete_id))
with check (athlete_id = auth.uid() or public.is_coach_of(athlete_id));

revoke all on function public.create_athlete_invitation() from public, anon;
revoke all on function public.claim_athlete_invitation(text) from public, anon;
revoke all on function public.list_my_athletes() from public, anon;
revoke all on function public.is_coach_of(uuid) from public, anon;
grant execute on function public.create_athlete_invitation() to authenticated;
grant execute on function public.claim_athlete_invitation(text) to authenticated;
grant execute on function public.list_my_athletes() to authenticated;
grant execute on function public.is_coach_of(uuid) to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update on public.athlete_data to authenticated;

