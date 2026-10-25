-- PostFlow cloud data schema. Run only in a dedicated PostFlow Supabase project.
create table if not exists public.profiles (id uuid primary key references auth.users(id) on delete cascade, display_name text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.campaigns (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, name text not null default 'Untitled campaign', caption text not null default '', first_comment text not null default '', selected_group_urls jsonb not null default '[]'::jsonb, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.groups (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, url text not null, name text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(user_id,url));
alter table public.profiles enable row level security; alter table public.campaigns enable row level security; alter table public.groups enable row level security;
create policy "Users can read their own profile" on public.profiles for select to authenticated using ((select auth.uid())=id);
create policy "Users can insert their own profile" on public.profiles for insert to authenticated with check ((select auth.uid())=id);
create policy "Users can update their own profile" on public.profiles for update to authenticated using ((select auth.uid())=id) with check ((select auth.uid())=id);
create policy "Users manage their own campaigns" on public.campaigns for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy "Users manage their own groups" on public.groups for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
grant select,insert,update,delete on public.profiles,public.campaigns,public.groups to authenticated;
