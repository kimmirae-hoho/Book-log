-- BOOKLOG 업데이트: 먼슬리 기록 공개 + 잠금
-- Supabase SQL Editor에 전체를 붙여 넣고 Run을 눌러 주세요. 한 번만 하면 돼요.

-- 기록 원본은 본인만 직접 읽어요
drop policy if exists "members read books" on public.books;
drop policy if exists "own books read" on public.books;
create policy "own books read" on public.books
  for select to authenticated using (owner = auth.uid());

-- 친구 기록은 이 함수로만 읽어요. 잠긴 기록은 날짜와 이미지만 내려가요
create or replace function public.friend_books(target uuid)
returns table (id text, data jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select b.id,
    case when coalesce((b.data->>'locked')::boolean, false) and b.owner <> auth.uid()
      then jsonb_strip_nulls(jsonb_build_object(
        'date', b.data->'date', 'kind', b.data->'kind', 'locked', true,
        'cover', b.data->'cover', 'coverData', b.data->'coverData',
        'pages', b.data->'pages', 'createdAt', b.data->'createdAt'))
      else b.data
    end
  from public.books b
  where b.owner = target and public.is_member();
$$;
grant execute on function public.friend_books(uuid) to authenticated;

-- 기록이 바뀌면 책장 줄에 시간을 찍어서, 친구 화면이 실시간으로 다시 불러오게 해요
alter table public.shelves add column if not exists books_at timestamptz;
create or replace function public.touch_shelf()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.shelves set books_at = now() where id = coalesce(new.owner, old.owner);
  return null;
end;
$$;
drop trigger if exists books_touch on public.books;
create trigger books_touch after insert or update or delete on public.books
  for each row execute function public.touch_shelf();
