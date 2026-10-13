-- BOOKLOG: Supabase에서 한 번만 실행하는 설정
-- SQL Editor에 전체를 붙여 넣고 Run을 누르세요.
-- 맨 아래 초대 코드는 원하는 값으로 바꿔서 실행하세요.

-- 초대 코드 (아무도 직접 읽을 수 없고, 가입할 때 맞는지만 확인해요)
create table if not exists public.invite_codes (
  code text primary key
);

-- 사람마다 책장 하나: 로그인 이름, 보이는 이름, 프로필 이미지
create table if not exists public.shelves (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  nickname text,
  avatar_data text,
  since timestamptz not null default now()
);

-- 책과 일기 기록 (내용은 data에 통째로)
create table if not exists public.books (
  owner uuid not null references public.shelves (id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

alter table public.invite_codes enable row level security;
alter table public.shelves enable row level security;
alter table public.books enable row level security;

-- 책장이 있는 사람(초대받아 가입한 사람)인지
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.shelves where id = auth.uid());
$$;

-- 책장: 멤버끼리만 보고, 자기 것만 고쳐요
drop policy if exists "members read shelves" on public.shelves;
create policy "members read shelves" on public.shelves
  for select to authenticated using (public.is_member());
drop policy if exists "own shelf update" on public.shelves;
create policy "own shelf update" on public.shelves
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- 기록: 멤버끼리만 보고, 자기 것만 쓰고 지워요
drop policy if exists "members read books" on public.books;
create policy "members read books" on public.books
  for select to authenticated using (public.is_member());
drop policy if exists "own books insert" on public.books;
create policy "own books insert" on public.books
  for insert to authenticated with check (owner = auth.uid());
drop policy if exists "own books update" on public.books;
create policy "own books update" on public.books
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "own books delete" on public.books;
create policy "own books delete" on public.books
  for delete to authenticated using (owner = auth.uid());

-- 가입 전에 초대 코드가 맞는지만 알려줘요
create or replace function public.check_invite(c text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.invite_codes where code = c);
$$;

-- 초대 코드가 맞으면 책장을 만들어요
create or replace function public.join_booklog(c text, uname text, nick text, avatar text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if not exists (select 1 from public.invite_codes where code = c) then
    raise exception 'bad invite code';
  end if;
  insert into public.shelves (id, username, nickname, avatar_data)
  values (auth.uid(), uname, nick, avatar)
  on conflict (id) do nothing;
end;
$$;

grant execute on function public.check_invite(text) to anon, authenticated;
grant execute on function public.join_booklog(text, text, text, text) to authenticated;

-- 실시간 반영 (친구가 기록하면 바로 보이게)
do $$
begin
  begin alter publication supabase_realtime add table public.shelves; exception when others then null; end;
  begin alter publication supabase_realtime add table public.books; exception when others then null; end;
end $$;

-- 표지·사진 저장소 (주소를 아는 사람만 열 수 있는 무작위 파일 이름)
insert into storage.buckets (id, name, public, file_size_limit)
values ('covers', 'covers', true, 10485760)
on conflict (id) do nothing;

drop policy if exists "members upload covers" on storage.objects;
create policy "members upload covers" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'covers' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own covers delete" on storage.objects;
create policy "own covers delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);

-- 초대 코드: 바꿔서 쓰세요. 여러 개 넣어도 돼요.
insert into public.invite_codes (code) values ('여기에-초대코드') on conflict do nothing;
