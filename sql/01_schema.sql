-- =====================================================================
--  sor-app — PostgreSQL séma (Supabase)
--  1. lépés: futtasd le EGYSZER a Supabase SQL Editorban.
--
--  Az oszlopok 1:1-ben követik a jelenlegi Google Sheets munkalapokat,
--  hogy az api/sheet.js átírása mezőnkénti csere legyen, ne újratervezés.
--  A megjegyzésekben ott a Sheets-oszlopbetű, amiből származik.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Felhasználók  (Sheets: 'Felhasználók', A–O)
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id                  bigint generated always as identity primary key,
  name                text        not null,                      -- A
  email               text        not null unique,               -- B
  password_hash       text,                                      -- C (bcrypt, VÁLTOZATLANUL átvinni!)
  twofa_secret        text,                                      -- D ('enc:v1:...' AES-GCM)
  twofa_enabled       boolean     not null default false,        -- E ('TRUE'/'FALSE')
  achievements        jsonb       not null default '{"unlocked":[]}'::jsonb,  -- F
  badge               text        not null default '',           -- G
  recovery_hash       text,                                      -- H (bcrypt)
  last_activity_week  text,                                      -- I ('2026-W05')
  current_streak      integer     not null default 0,            -- J
  longest_streak      integer     not null default 0,            -- K
  google_id           text,                                      -- L
  warnings            jsonb       not null default '[]'::jsonb,  -- M
  is_banned           boolean     not null default false,        -- N ('TRUE'/'FALSE')
  settings            jsonb       not null default '{}'::jsonb,  -- O
  created_at          timestamptz not null default now()
);

create index if not exists users_google_id_idx
  on public.users (google_id) where google_id is not null;
create index if not exists users_is_banned_idx
  on public.users (is_banned) where is_banned = true;

-- ---------------------------------------------------------------------
-- Admin sörök  (Sheets: 'Sör táblázat'!A4:V)
-- A lapon KÉT értékelő adata van EGYMÁS MELLETT (A–J és M–V).
-- Itt két külön sorrá bomlik, rated_by megkülönböztetéssel.
-- ---------------------------------------------------------------------
create table if not exists public.admin_beers (
  id               bigint generated always as identity primary key,
  rated_by         text    not null check (rated_by in ('admin1','admin2')),
  beer_name        text    not null,
  location         text    not null default '',
  type             text    not null default 'N/A',
  look             numeric not null default 0,
  smell            numeric not null default 0,
  taste            numeric not null default 0,
  total_score      numeric not null default 0,
  avg              numeric not null default 0,
  beer_percentage  numeric not null default 0,
  date_text        text,        -- eredeti dátumszöveg (a frontend így jeleníti meg)
  sheet_row        integer,     -- honnan jött (csak nyomkövetéshez)
  created_at       timestamptz not null default now()
);

create index if not exists admin_beers_name_idx on public.admin_beers (beer_name);

-- ---------------------------------------------------------------------
-- Felhasználói sörértékelések  (Sheets: 'Vendég Sör Teszt', A–O)
-- ---------------------------------------------------------------------
create table if not exists public.user_beers (
  id               bigint generated always as identity primary key,
  beer_uid         text unique,                                  -- O (stabil ID; régi soroknál üres)
  date_text        text,                                         -- A (pontos eredeti szöveg)
  created_at       timestamptz not null default now(),           -- A-ból parse-olva
  submitter_name   text    not null default '',                  -- B
  beer_name        text    not null,                             -- C
  location         text    not null default '',                  -- D
  type             text    not null default '',                  -- E
  look             numeric not null default 0,                   -- F
  smell            numeric not null default 0,                   -- G
  taste            numeric not null default 0,                   -- H
  beer_percentage  numeric not null default 0,                   -- I
  total_score      numeric not null default 0,                   -- J
  avg              numeric not null default 0,                   -- K ('3,67' -> 3.67)
  notes            text    not null default '',                  -- L
  approved         text    not null default 'Nem',               -- M
  user_email       text    not null                              -- N
);

create index if not exists user_beers_email_idx on public.user_beers (user_email);
create index if not exists user_beers_email_id_idx on public.user_beers (user_email, id);

-- ---------------------------------------------------------------------
-- Felhasználói italértékelések  (Sheets: 'Vendég ital teszt', A–N)
-- FIGYELEM: ezen a lapon NINCS stabil ID oszlop (a söröknél van).
-- ---------------------------------------------------------------------
create table if not exists public.user_drinks (
  id                bigint generated always as identity primary key,
  date_text         text,                                        -- A
  created_at        timestamptz not null default now(),
  submitter_name    text    not null default '',                 -- B
  drink_name        text    not null,                            -- C
  category          text    not null default '',                 -- D
  type              text    not null default '',                 -- E
  location          text    not null default '',                 -- F
  drink_percentage  numeric not null default 0,                  -- G
  look              numeric not null default 0,                  -- H
  smell             numeric not null default 0,                  -- I
  taste             numeric not null default 0,                  -- J
  total_score       numeric not null default 0,                  -- K
  avg               numeric not null default 0,                  -- L
  notes             text    not null default '',                 -- M
  user_email        text    not null                             -- N
);

create index if not exists user_drinks_email_idx on public.user_drinks (user_email);
create index if not exists user_drinks_email_id_idx on public.user_drinks (user_email, id);

-- ---------------------------------------------------------------------
-- Ötletek  (Sheets: 'Vendég ötletek', A–H)
-- ---------------------------------------------------------------------
create table if not exists public.ideas (
  id              bigint generated always as identity primary key,
  submitter_name  text    not null default '',                   -- A
  idea_text       text    not null,                              -- B
  time_text       text,                                          -- C
  status          text    not null default 'Megcsinálásra vár',  -- D
  date_text       text,                                          -- E
  created_at      timestamptz not null default now(),
  user_email      text    not null default '',                   -- F
  vote_count      integer not null default 0,                    -- G
  voters          jsonb   not null default '[]'::jsonb           -- H
);

create index if not exists ideas_email_idx on public.ideas (user_email);

-- ---------------------------------------------------------------------
-- Ajánlások  (Sheets: 'Vendég sör ajánló', A–K)
-- ---------------------------------------------------------------------
create table if not exists public.recommendations (
  id            bigint generated always as identity primary key,
  date_text     text,                                            -- A
  created_at    timestamptz not null default now(),
  name          text    not null default '',                     -- B
  user_email    text    not null default '',                     -- C
  item_name     text    not null,                                -- D
  item_type     text    not null default '',                     -- E
  description   text    not null default '',                     -- F
  is_anonymous  boolean not null default false,                  -- G ('TRUE'/'FALSE')
  category      text    not null default 'Egyéb',                -- H
  is_edited     boolean not null default false,                  -- I ('TRUE'/'FALSE')
  vote_count    integer not null default 0,                      -- J
  voters        jsonb   not null default '[]'::jsonb             -- K
);

create index if not exists recommendations_email_idx on public.recommendations (user_email);

-- ---------------------------------------------------------------------
-- Hibajelentések / support  (Sheets: 'Hibajelentések', A–F)
-- ---------------------------------------------------------------------
create table if not exists public.support_tickets (
  id          bigint generated always as identity primary key,
  date_text   text,                                              -- A
  created_at  timestamptz not null default now(),
  name        text not null default '',                          -- B
  user_email  text not null default '',                          -- C
  subject     text not null default '',                          -- D
  message     text not null default '',                          -- E
  status      text not null default 'Új'                         -- F
);

-- ---------------------------------------------------------------------
-- Moderációs jelentések  (Sheets: 'Jelentések', A–G)
-- ---------------------------------------------------------------------
create table if not exists public.reports (
  id              bigint generated always as identity primary key,
  date_text       text,                                          -- A
  created_at      timestamptz not null default now(),
  reporter_email  text not null default '',                      -- B
  content_type    text not null default '',                      -- C
  content_id      text not null default '',                      -- D
  reported_email  text not null default '',                      -- E
  reason          text not null default '',                      -- F
  status          text not null default 'Nyitott'                -- G
);

create index if not exists reports_status_idx on public.reports (status);

-- ---------------------------------------------------------------------
-- Sörpong  (Sheets: 'Sörpong', A–E)
-- ---------------------------------------------------------------------
create table if not exists public.beerpong_records (
  id          bigint generated always as identity primary key,
  user_email  text not null,                                     -- A
  type        text not null,                                     -- B
  record_id   text not null,                                     -- C
  date_text   text,                                              -- D
  payload     jsonb not null default '{}'::jsonb,                -- E (JSON-szöveg volt)
  created_at  timestamptz not null default now(),
  unique (user_email, record_id)
);

create index if not exists beerpong_email_idx on public.beerpong_records (user_email);

-- ---------------------------------------------------------------------
-- Fogyasztás napló  (Sheets: 'Fogyasztás napló', A–H)
-- ---------------------------------------------------------------------
create table if not exists public.consumptions (
  id             bigint generated always as identity primary key,
  date_text      text,                                           -- A
  created_at     timestamptz not null default now(),
  user_email     text    not null,                               -- B
  beer_name      text    not null default '',                    -- C
  beer_uid       text,                                           -- D
  qty            numeric not null default 0,                     -- E
  dl_per_glass   numeric not null default 0,                     -- F
  total_dl       numeric not null default 0,                     -- G
  abv            numeric not null default 0                      -- H
);

create index if not exists consumptions_email_idx on public.consumptions (user_email);

-- ---------------------------------------------------------------------
-- Nyertesek  (Sheets: 'Nyertesek')
-- A kód ezt a lapot CSAK a GDPR-törlésnél érinti (C oszlop = e-mail),
-- sehol nem olvassa. Ezért veszteségmentesen, nyers formában visszük át.
-- Ha megmondod a valódi oszlopait, kibontjuk rendes mezőkre.
-- ---------------------------------------------------------------------
create table if not exists public.winners (
  id          bigint generated always as identity primary key,
  user_email  text,                                              -- C
  row_data    jsonb not null default '[]'::jsonb,                -- a teljes eredeti sor
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Row Level Security
-- Minden hozzáférés a saját /api/sheet végpontodon megy át, ami a
-- service_role kulcsot használja — az MEGKERÜLI az RLS-t. Ezért itt
-- csak bekapcsoljuk, és NEM adunk policy-t: így ha a kulcs valaha
-- kiszivárogna anon szinten, az anon kulccsal semmi nem érhető el.
-- ---------------------------------------------------------------------
alter table public.users             enable row level security;
alter table public.admin_beers       enable row level security;
alter table public.user_beers        enable row level security;
alter table public.user_drinks       enable row level security;
alter table public.ideas             enable row level security;
alter table public.recommendations   enable row level security;
alter table public.support_tickets   enable row level security;
alter table public.reports           enable row level security;
alter table public.beerpong_records  enable row level security;
alter table public.consumptions      enable row level security;
alter table public.winners           enable row level security;
