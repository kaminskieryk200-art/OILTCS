-- Rises Spaces v3.44.0 — kanały publiczne (jak na Discordzie).
-- Zasada: kanał publiczny jest zwykłą grupą (`groups`), więc wiadomości,
-- wysyłka, reakcje i podsłuch na żywo działają bez nowej infrastruktury.
-- Publiczność kanału = wiersz w `spaces_channels`; członkostwo każdego
-- zalogowanego = wiersz w `group_members` (rola 'member').

create table if not exists public.spaces_channels (
  group_id   uuid primary key references public.groups(id) on delete cascade,
  slug       text not null unique,
  topic      text,
  is_public  boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.spaces_channels enable row level security;

-- Kanał publiczny widzi każdy zalogowany; kanał prywatny (is_public=false)
-- tylko członkowie — czyli tak, jak dotąd działały grupy.
drop policy if exists spaces_channels_select on public.spaces_channels;
create policy spaces_channels_select on public.spaces_channels
  for select to authenticated
  using (
    is_public
    or exists (select 1 from public.group_members m
               where m.group_id = spaces_channels.group_id and m.user_id = auth.uid())
    or exists (select 1 from public.groups g
               where g.id = spaces_channels.group_id and g.created_by = auth.uid())
  );

-- Tworzyć kanały może każdy zalogowany (tak jak zwykłe grupy) i tylko na
-- grupie, której jest właścicielem.
drop policy if exists spaces_channels_insert on public.spaces_channels;
create policy spaces_channels_insert on public.spaces_channels
  for insert to authenticated
  with check (
    exists (select 1 from public.groups g
            where g.id = spaces_channels.group_id and g.created_by = auth.uid())
  );

drop policy if exists spaces_channels_update on public.spaces_channels;
create policy spaces_channels_update on public.spaces_channels
  for update to authenticated
  using (exists (select 1 from public.groups g
                 where g.id = spaces_channels.group_id and g.created_by = auth.uid()))
  with check (exists (select 1 from public.groups g
                      where g.id = spaces_channels.group_id and g.created_by = auth.uid()));

-- --- wejście do kanału publicznego -------------------------------------
-- Każdy zalogowany może dopisać SIEBIE do kanału publicznego; do prywatnego
-- nadal tylko właściciel (dotychczasowa polityka `gm_insert`).
drop policy if exists gm_join_public on public.group_members;
create policy gm_join_public on public.group_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.spaces_channels c
                where c.group_id = group_members.group_id and c.is_public)
  );

-- --- widoczność kanałów publicznych ------------------------------------
-- Grupa oznaczona jako kanał publiczny jest widoczna dla wszystkich
-- zalogowanych. Grupy prywatne działają po staremu.
create or replace function public.rises_group_visible(p_group uuid)
returns boolean
language sql
stable security definer
set search_path to 'pg_catalog'
as $function$
  select exists (select 1 from public.groups g where g.id = p_group and g.created_by = auth.uid())
      or exists (select 1 from public.group_members m where m.group_id = p_group and m.user_id = auth.uid())
      or exists (select 1 from public.spaces_channels c where c.group_id = p_group and c.is_public)
$function$;

-- --- kanał domowy: #ogólny --------------------------------------------
do $$
declare
  v_author uuid;
  v_group  uuid;
begin
  if exists (select 1 from public.spaces_channels where slug = 'ogolny') then
    return;
  end if;

  select id into v_author from public.profiles
   where account_type is distinct from 'business'
   order by updated_at desc nulls last limit 1;
  if v_author is null then
    select id into v_author from public.profiles order by updated_at desc nulls last limit 1;
  end if;
  if v_author is null then
    raise notice 'Brak kont — kanał #ogólny nie został utworzony.';
    return;
  end if;

  insert into public.groups (name, description, avatar_class, created_by)
  values ('ogólny', 'Kanał publiczny Rises — miejsce na wszystko', 'avatar-blue', v_author)
  returning id into v_group;

  insert into public.spaces_channels (group_id, slug, topic, is_public)
  values (v_group, 'ogolny', 'Kanał publiczny Rises — miejsce na wszystko', true);

  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_author, 'admin');
end
$$;
