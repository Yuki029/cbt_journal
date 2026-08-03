-- Supabase SQL Editorで一度だけ実行してください。
create table if not exists public.cbt_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.cbt_sync enable row level security;

create policy "Users can read their own CBT data"
on public.cbt_sync for select to authenticated
using (auth.uid() = user_id);

create policy "Users can create their own CBT data"
on public.cbt_sync for insert to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own CBT data"
on public.cbt_sync for update to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
