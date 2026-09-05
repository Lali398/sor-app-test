-- =====================================================================
--  sor-app — idegen kulcsok
--  CSAK a sikeres adatmigráció UTÁN futtasd (Supabase SQL Editor).
--
--  Miért külön fájl? Mert a Sheetsben simán maradhattak olyan sorok,
--  amiknek az e-mailje már nem szerepel a Felhasználók lapon (törölt
--  fiók, elgépelés). Az idegen kulcs ezeket visszautasítaná, és
--  elhasalna a migráció. Így a sorrend: adat -> ellenőrzés -> kulcsok.
-- =====================================================================

-- 1) ELŐBB NÉZD MEG, van-e árva sor. Mindegyiknek 0-t kell adnia.
--    (A migrate.js is kiírja ezt a riportot a futás végén.)

select 'user_beers'  as tabla, count(*) as arva from public.user_beers       b
  where not exists (select 1 from public.users u where u.email = b.user_email)
union all
select 'user_drinks', count(*) from public.user_drinks d
  where not exists (select 1 from public.users u where u.email = d.user_email)
union all
select 'consumptions', count(*) from public.consumptions c
  where not exists (select 1 from public.users u where u.email = c.user_email)
union all
select 'beerpong_records', count(*) from public.beerpong_records p
  where not exists (select 1 from public.users u where u.email = p.user_email);

-- 2) Ha mind 0 volt, jöhetnek a kulcsok.
--    (Ha nem 0: vagy töröld az árva sorokat, vagy hagyd ki az adott
--     táblát ebből a lépésből — a séma nélküle is működik.)

alter table public.user_beers
  add constraint user_beers_email_fkey
  foreign key (user_email) references public.users (email)
  on update cascade on delete cascade;

alter table public.user_drinks
  add constraint user_drinks_email_fkey
  foreign key (user_email) references public.users (email)
  on update cascade on delete cascade;

alter table public.consumptions
  add constraint consumptions_email_fkey
  foreign key (user_email) references public.users (email)
  on update cascade on delete cascade;

alter table public.beerpong_records
  add constraint beerpong_email_fkey
  foreign key (user_email) references public.users (email)
  on update cascade on delete cascade;

-- Ettől kezdve a DELETE_USER (ami ma 18 Sheets-műveletből áll, és
-- hat lapot töröl-visszaír) ennyi lesz:
--     delete from public.users where email = $1;
-- A kapcsolódó sorok maguktól eltűnnek, atomi módon.
