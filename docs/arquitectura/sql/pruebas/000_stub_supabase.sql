-- SOLO PARA PRUEBAS LOCALES en un PostgreSQL vacío: imita lo mínimo que Supabase ya trae.
-- En Supabase NO se ejecuta este archivo.
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;

create schema auth;
grant usage on schema auth to public;
create table auth.users (id uuid primary key, email text);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
