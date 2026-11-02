-- PinBox: таблицы, правила доступа и хранилище.
-- Вставь целиком в Supabase -> SQL Editor -> Run. Можно запускать повторно.

-- Разделы
create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  created timestamptz not null default now()
);

-- Сохранённые файлы
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type text not null check (type in ('image', 'video')),
  path text not null,
  size bigint not null default 0,
  title text not null default '',
  pin_url text,
  col uuid references public.collections(id) on delete set null,
  added timestamptz not null default now()
);

create index if not exists items_user_added on public.items (user_id, added desc);

-- Каждый видит и меняет только свои строки
alter table public.collections enable row level security;
alter table public.items enable row level security;

drop policy if exists "own collections" on public.collections;
create policy "own collections" on public.collections
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own items" on public.items;
create policy "own items" on public.items
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Хранилище файлов: папка на пользователя, имена файлов случайные
insert into storage.buckets (id, name, public)
values ('pins', 'pins', true)
on conflict (id) do nothing;

drop policy if exists "pins insert own" on storage.objects;
create policy "pins insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'pins' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pins select own" on storage.objects;
create policy "pins select own" on storage.objects
  for select to authenticated
  using (bucket_id = 'pins' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pins delete own" on storage.objects;
create policy "pins delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'pins' and (storage.foldername(name))[1] = auth.uid()::text);
