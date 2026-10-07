-- =====================================================================================
-- 001 — Núcleo multi-tenant: plataforma, planes, módulos, cuotas, roles y permisos
-- Destino: PostgreSQL 15+ en Supabase (self-hosted o cloud). Usa auth.users, auth.uid(), auth.jwt().
--
-- Principios:
--   * Dos planos separados: PLATAFORMA (tú y tu equipo) y CLIENTE (cada empresa).
--     Una cuenta de staff NUNCA es miembro de una empresa (y viceversa).
--   * Permiso efectivo = permisos del rol ∩ módulos del plan (+ excepciones) ∩ ámbito 'cliente'
--     y, si corresponde, limitado a sucursales.
--   * El esquema `app` NO se expone por PostgREST. La API propia entra como rol `authenticated`
--     (panel del cliente) o `consola` (panel de plataforma) y fija los claims del JWT por transacción.
-- =====================================================================================

create schema if not exists app;
revoke all on schema app from public;
alter default privileges in schema app revoke execute on functions from public;

-- Rol de base de datos para la API de la consola de plataforma (staff). Los clientes usan `authenticated`.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'consola') then create role consola nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'gateway') then create role gateway nologin; end if;
end $$;
grant usage on schema app to authenticated, consola, gateway;

create type app.estado_tenant  as enum ('prueba', 'activo', 'suspendido', 'cancelado');
create type app.rol_plataforma as enum ('superadmin', 'soporte', 'finanzas');
create type app.ambito_permiso as enum ('cliente', 'plataforma');
create type app.tipo_permiso   as enum ('lectura', 'escritura');

-- -------------------------------------------------------------------------------------
-- Catálogo (lo define el código y se siembra por migración; nadie lo edita desde un panel)
-- -------------------------------------------------------------------------------------
create table app.modulos (
  codigo      text primary key,                 -- nucleo, asistencia, acceso, reportes_avanzados, integraciones
  nombre      text not null,
  descripcion text
);

create table app.permisos (
  codigo      text primary key,                 -- p. ej. 'empleados.editar'
  modulo      text not null references app.modulos(codigo),
  ambito      app.ambito_permiso not null,      -- 'plataforma' = jamás asignable a un cliente
  tipo        app.tipo_permiso not null,        -- 'lectura' sigue disponible con la cuenta suspendida
  sensible    boolean not null default false,   -- exige MFA (aal2) y queda fuera de las sesiones de soporte
  descripcion text not null
);

create table app.limites (
  clave       text primary key,                 -- sucursales, dispositivos, empleados, usuarios, retencion_meses
  descripcion text not null
);

create table app.planes (
  id      uuid primary key default gen_random_uuid(),
  codigo  text not null unique,
  nombre  text not null,
  activo  boolean not null default true
);
create table app.plan_modulos (
  plan_id uuid not null references app.planes(id) on delete cascade,
  modulo  text not null references app.modulos(codigo),
  primary key (plan_id, modulo)
);
create table app.plan_limites (
  plan_id uuid not null references app.planes(id) on delete cascade,
  clave   text not null references app.limites(clave),
  valor   int  not null check (valor >= 0),     -- sin fila = ilimitado
  primary key (plan_id, clave)
);

-- -------------------------------------------------------------------------------------
-- Plataforma (staff)
-- -------------------------------------------------------------------------------------
create table app.staff_plataforma (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rol     app.rol_plataforma not null,
  activo  boolean not null default true,
  creado  timestamptz not null default now()
);

create table app.staff_rol_permisos (
  rol     app.rol_plataforma not null,
  permiso text not null references app.permisos(codigo),
  primary key (rol, permiso)
);

-- -------------------------------------------------------------------------------------
-- Clientes (tenants)
-- -------------------------------------------------------------------------------------
create table app.tenants (
  id               uuid primary key default gen_random_uuid(),
  nombre           text not null,
  nit              text,
  -- Subdominio de equipos: <slug>.eq.tudominio.com. Liga el SN del reloj a esta empresa.
  slug_equipos     text not null unique default left(replace(gen_random_uuid()::text, '-', ''), 16),
  plan_id          uuid not null references app.planes(id),
  estado           app.estado_tenant not null default 'prueba',
  zona_horaria     text not null default 'America/La_Paz',
  mfa_obligatorio  boolean not null default false,
  creado           timestamptz not null default now(),
  eliminar_desde   timestamptz                  -- baja programada (papelera); la purga la hace un job
);

-- Excepciones del superusuario sobre el plan (con motivo y vencimiento opcional)
create table app.tenant_modulos (
  tenant_id  uuid not null references app.tenants(id),
  modulo     text not null references app.modulos(codigo),
  habilitado boolean not null,
  motivo     text not null,
  vence      timestamptz,
  primary key (tenant_id, modulo)
);
create table app.tenant_limites (
  tenant_id uuid not null references app.tenants(id),
  clave     text not null references app.limites(clave),
  valor     int  not null check (valor >= 0),
  motivo    text not null,
  vence     timestamptz,
  primary key (tenant_id, clave)
);

create table app.sucursales (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references app.tenants(id),
  nombre       text not null,
  direccion    text,
  zona_horaria text,                            -- null = la del tenant
  creado       timestamptz not null default now(),
  unique (tenant_id, id),                       -- destino de FKs compuestas: impide cruces entre empresas
  unique (tenant_id, nombre)
);

-- Roles: plantillas del sistema (tenant_id null) y roles personalizados de cada cliente
create table app.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references app.tenants(id),
  codigo      text,                             -- solo plantillas: propietario, administrador, rrhh...
  nombre      text not null,
  descripcion text,
  creado      timestamptz not null default now(),
  unique nulls not distinct (tenant_id, nombre),
  check ((tenant_id is null) = (codigo is not null))
);
create table app.rol_permisos (
  rol_id  uuid not null references app.roles(id) on delete cascade,
  permiso text not null references app.permisos(codigo),
  primary key (rol_id, permiso)
);

create table app.membresias (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  user_id   uuid not null references auth.users(id) on delete cascade,
  estado    text not null default 'activa' check (estado in ('invitada', 'activa', 'suspendida')),
  creado    timestamptz not null default now(),
  unique (tenant_id, user_id),
  unique (tenant_id, id)
);

-- Un rol en un alcance: sucursal_id null = todas las sucursales
create table app.asignaciones_rol (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  membresia_id uuid not null,
  rol_id       uuid not null references app.roles(id),
  sucursal_id  uuid,
  foreign key (tenant_id, membresia_id) references app.membresias(tenant_id, id) on delete cascade,
  foreign key (tenant_id, sucursal_id)  references app.sucursales(tenant_id, id) on delete cascade,
  unique nulls not distinct (membresia_id, rol_id, sucursal_id)
);
create index on app.asignaciones_rol (membresia_id);

-- Sesión de soporte: la ÚNICA forma en que el staff ve datos de un cliente. Temporal, con motivo, auditada.
create table app.sesiones_soporte (
  id            uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references app.staff_plataforma(user_id),
  tenant_id     uuid not null references app.tenants(id),
  modo          text not null check (modo in ('lectura', 'escritura')),
  motivo        text not null check (length(motivo) >= 10),
  ticket        text,
  inicia        timestamptz not null default now(),
  expira        timestamptz not null,
  revocada_en   timestamptz,
  check (expira > inicia and expira <= inicia + interval '8 hours')
);

-- Qué empresa (o sesión de soporte) tiene activa cada usuario; lo lee el hook del token
create table app.contexto_sesion (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  membresia_id      uuid references app.membresias(id) on delete set null,
  soporte_sesion_id uuid references app.sesiones_soporte(id) on delete set null,
  actualizado       timestamptz not null default now()
);

-- =====================================================================================
-- Funciones de autorización (SECURITY DEFINER + search_path vacío; se usan dentro de RLS)
-- En las políticas se llaman como (select app.f(...)) para que Postgres las evalúe una vez
-- por consulta (initPlan) y no una vez por fila.
-- =====================================================================================

create function app.modulo_habilitado(p_tenant uuid, p_modulo text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select tm.habilitado from app.tenant_modulos tm
      where tm.tenant_id = p_tenant and tm.modulo = p_modulo and (tm.vence is null or tm.vence > now())),
    exists (select 1 from app.tenants t join app.plan_modulos pm on pm.plan_id = t.plan_id
             where t.id = p_tenant and pm.modulo = p_modulo))
$$;

-- null = ilimitado
create function app.limite(p_tenant uuid, p_clave text) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select tl.valor from app.tenant_limites tl
      where tl.tenant_id = p_tenant and tl.clave = p_clave and (tl.vence is null or tl.vence > now())),
    (select pl.valor from app.tenants t join app.plan_limites pl on pl.plan_id = t.plan_id and pl.clave = p_clave
      where t.id = p_tenant))
$$;

-- Empresa sobre la que actúa la petición. Se revalida en vivo (no se confía solo en el token):
-- membresía activa, o sesión de soporte vigente. 'suspendido' puede leer; 'cancelado' no ve nada.
create function app.tenant_actual() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id
    from app.membresias m join app.tenants t on t.id = m.tenant_id
   where m.id = nullif(auth.jwt() ->> 'membresia_id', '')::uuid
     and m.user_id = auth.uid() and m.estado = 'activa'
     and t.estado in ('prueba', 'activo', 'suspendido')
     and (not t.mfa_obligatorio or auth.jwt() ->> 'aal' = 'aal2')
  union all
  select s.tenant_id
    from app.sesiones_soporte s join app.staff_plataforma st on st.user_id = s.staff_user_id
   where s.id = nullif(auth.jwt() ->> 'soporte_sesion_id', '')::uuid
     and s.staff_user_id = auth.uid() and st.activo
     and s.revocada_en is null and now() >= s.inicia and now() < s.expira
     and auth.jwt() ->> 'aal' = 'aal2'
  limit 1
$$;

-- Alcances en los que el usuario actual tiene un permiso: una fila por alcance (null = todas las sucursales)
create function app._alcances_permiso(p_permiso text) returns table (sucursal_id uuid)
language sql stable security definer set search_path = '' as $$
  select ar.sucursal_id
    from app.membresias m
    join app.tenants t          on t.id = m.tenant_id
    join app.asignaciones_rol ar on ar.membresia_id = m.id
    join app.rol_permisos rp    on rp.rol_id = ar.rol_id and rp.permiso = p_permiso
    join app.permisos p         on p.codigo = rp.permiso
   where m.id = nullif(auth.jwt() ->> 'membresia_id', '')::uuid
     and m.user_id = auth.uid() and m.estado = 'activa'
     and m.tenant_id = app.tenant_actual()
     and p.ambito = 'cliente'
     and app.modulo_habilitado(m.tenant_id, p.modulo)
     and (not p.sensible or auth.jwt() ->> 'aal' = 'aal2')
     and (p.tipo = 'lectura' or t.estado in ('prueba', 'activo'))
  union all
  select null::uuid
    from app.sesiones_soporte s
    join app.permisos p on p.codigo = p_permiso
   where s.id = nullif(auth.jwt() ->> 'soporte_sesion_id', '')::uuid
     and s.tenant_id = app.tenant_actual()
     and p.ambito = 'cliente' and not p.sensible
     and app.modulo_habilitado(s.tenant_id, p.modulo)
     and (p.tipo = 'lectura' or s.modo = 'escritura')
     and (p.tipo = 'lectura' or exists (select 1 from app.tenants t where t.id = s.tenant_id and t.estado in ('prueba', 'activo')))
$$;

-- ¿Tiene el permiso en toda la empresa?
create function app.permiso_global(p_permiso text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app._alcances_permiso(p_permiso) a where a.sucursal_id is null)
$$;

-- Sucursales concretas donde lo tiene (además de un posible alcance global)
create function app.sucursales_con_permiso(p_permiso text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(a.sucursal_id), '{}') from app._alcances_permiso(p_permiso) a where a.sucursal_id is not null
$$;

-- ¿Puede hacer X en esta sucursal? (p_sucursal null = acción sobre toda la empresa)
create function app.tiene_permiso(p_permiso text, p_sucursal uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app._alcances_permiso(p_permiso) a
                  where a.sucursal_id is null or a.sucursal_id = p_sucursal)
$$;

-- Permisos de plataforma: solo staff activo y con MFA
create function app.staff_tiene(p_permiso text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.staff_plataforma s
      join app.staff_rol_permisos rp on rp.rol = s.rol and rp.permiso = p_permiso
     where s.user_id = auth.uid() and s.activo and auth.jwt() ->> 'aal' = 'aal2')
$$;

-- ¿Lo tiene en al menos un alcance?
create function app.tiene_permiso_en_alguna(p_permiso text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app._alcances_permiso(p_permiso))
$$;

-- Lo que el panel del cliente necesita para armar menús y botones (la seguridad real está en RLS/API)
create function app.mis_permisos() returns table (permiso text, global boolean, sucursales uuid[])
language sql stable security definer set search_path = '' as $$
  select p.codigo, app.permiso_global(p.codigo), app.sucursales_con_permiso(p.codigo)
    from app.permisos p
   where p.ambito = 'cliente' and app.tiene_permiso_en_alguna(p.codigo)
$$;

-- =====================================================================================
-- Hook de Supabase Auth (Custom Access Token): agrega el contexto al JWT.
-- Configurar en Auth → Hooks (o GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_* en self-hosted).
-- Los claims son una PISTA: tenant_actual() y _alcances_permiso() los revalidan en cada consulta.
-- =====================================================================================
create function app.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user   uuid  := (event ->> 'user_id')::uuid;
  v_claims jsonb := coalesce(event -> 'claims', '{}');
  v_staff  app.rol_plataforma;
  v_ctx    app.contexto_sesion;
  v_mem    app.membresias;
  v_sop    app.sesiones_soporte;
begin
  v_claims := v_claims - 'tenant_id' - 'membresia_id' - 'rol_plataforma' - 'soporte_sesion_id';
  select rol into v_staff from app.staff_plataforma where user_id = v_user and activo;
  select * into v_ctx from app.contexto_sesion where user_id = v_user;

  if v_staff is not null then
    v_claims := v_claims || jsonb_build_object('rol_plataforma', v_staff);
    select * into v_sop from app.sesiones_soporte
     where id = v_ctx.soporte_sesion_id and staff_user_id = v_user and revocada_en is null and now() < expira;
    if found then
      v_claims := v_claims || jsonb_build_object('soporte_sesion_id', v_sop.id, 'tenant_id', v_sop.tenant_id);
    end if;
  else
    select m.* into v_mem from app.membresias m
     where m.user_id = v_user and m.estado = 'activa'
     order by (m.id = v_ctx.membresia_id) desc nulls last, m.creado
     limit 1;
    if found then
      v_claims := v_claims || jsonb_build_object('tenant_id', v_mem.tenant_id, 'membresia_id', v_mem.id);
    end if;
  end if;
  return jsonb_set(event, '{claims}', v_claims);
end $$;

-- =====================================================================================
-- Reglas que ni un bug de la API puede saltarse (triggers)
-- =====================================================================================

-- Staff y clientes son cuentas distintas
create function app.trg_cuentas_separadas() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'membresias' and exists (select 1 from app.staff_plataforma where user_id = new.user_id) then
    raise exception 'Una cuenta de staff de plataforma no puede ser miembro de una empresa' using errcode = '42501';
  end if;
  if tg_table_name = 'staff_plataforma' and exists (select 1 from app.membresias where user_id = new.user_id) then
    raise exception 'Esa cuenta ya pertenece a una empresa; el staff usa cuentas separadas' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger cuentas_separadas before insert or update of user_id on app.membresias
  for each row execute function app.trg_cuentas_separadas();
create trigger cuentas_separadas before insert or update of user_id on app.staff_plataforma
  for each row execute function app.trg_cuentas_separadas();

-- Solo permisos de ámbito plataforma en roles de staff, y de ámbito cliente en roles de cliente
create function app.trg_staff_rol_permisos() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select ambito from app.permisos where codigo = new.permiso) <> 'plataforma' then
    raise exception 'El staff recibe permisos de plataforma; % es de cliente (usa una sesión de soporte)', new.permiso
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger ambito before insert or update on app.staff_rol_permisos
  for each row execute function app.trg_staff_rol_permisos();

-- Roles del cliente: nunca permisos de plataforma y nunca otorgar lo que uno no tiene
create function app.trg_rol_permisos() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_rol app.roles;
begin
  if tg_op <> 'DELETE' and (select ambito from app.permisos where codigo = new.permiso) <> 'cliente' then
    raise exception 'El permiso % es exclusivo de la plataforma', new.permiso using errcode = '42501';
  end if;
  select * into v_rol from app.roles where id = coalesce(new.rol_id, old.rol_id);
  if auth.uid() is not null then  -- usuario real (las migraciones y jobs no tienen JWT)
    if v_rol.tenant_id is null then
      raise exception 'Las plantillas de rol del sistema no se editan' using errcode = '42501';
    end if;
    if not app.permiso_global(coalesce(new.permiso, old.permiso)) then
      raise exception 'No puedes otorgar ni quitar un permiso que no tienes: %', coalesce(new.permiso, old.permiso)
        using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger guardia before insert or update or delete on app.rol_permisos
  for each row execute function app.trg_rol_permisos();

-- Asignar o quitar un rol: hay que tener todos sus permisos en ese alcance y no puede ser a uno mismo
create function app.trg_asignaciones_rol() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r      record := coalesce(new, old);
  v_rol  app.roles;
  v_user uuid;
  v_falta text;
begin
  select * into v_rol from app.roles where id = r.rol_id;
  if v_rol.tenant_id is not null and v_rol.tenant_id <> r.tenant_id then
    raise exception 'El rol pertenece a otra empresa' using errcode = '42501';
  end if;
  if auth.uid() is null then return r; end if;
  select user_id into v_user from app.membresias where id = r.membresia_id;
  if v_user = auth.uid() then
    raise exception 'No puedes cambiar tus propios roles' using errcode = '42501';
  end if;
  -- Los permisos de módulos que el plan no incluye son inertes: no cuentan como escalada
  select rp.permiso into v_falta from app.rol_permisos rp join app.permisos p on p.codigo = rp.permiso
   where rp.rol_id = r.rol_id and app.modulo_habilitado(r.tenant_id, p.modulo)
     and not app.tiene_permiso(rp.permiso, r.sucursal_id) limit 1;
  if v_falta is not null then
    raise exception 'No puedes asignar un rol con permisos que no tienes (%)', v_falta using errcode = '42501';
  end if;
  return r;
end $$;
create trigger guardia before insert or update or delete on app.asignaciones_rol
  for each row execute function app.trg_asignaciones_rol();

-- Siempre debe quedar al menos un propietario activo (al quitar el rol, suspender o borrar la membresía)
create function app.trg_ultimo_propietario() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return null; end if;  -- purga de cuenta por un job
  if tg_table_name = 'asignaciones_rol' then
    if (select codigo from app.roles where id = old.rol_id) is distinct from 'propietario' then return null; end if;
  end if;
  if not exists (select 1 from app.asignaciones_rol ar
                   join app.roles r on r.id = ar.rol_id and r.codigo = 'propietario'
                   join app.membresias m on m.id = ar.membresia_id and m.estado = 'activa'
                  where ar.tenant_id = old.tenant_id) then
    raise exception 'La empresa debe conservar al menos un propietario' using errcode = '42501';
  end if;
  return null;
end $$;
create trigger ultimo_propietario after delete or update on app.asignaciones_rol
  for each row execute function app.trg_ultimo_propietario();
create trigger ultimo_propietario after delete or update of estado on app.membresias
  for each row execute function app.trg_ultimo_propietario();

-- Cuotas del plan. Solo valida cuando la fila PASA a contar (alta, reactivación o cambio de empresa);
-- retirar o editar nunca se bloquea. Serializa altas concurrentes de la misma empresa bloqueando su fila.
-- tg_argv[0] = clave del límite; tg_argv[1] = condición para contar (la escriben las migraciones, no usuarios)
create function app.trg_cuota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cond text := coalesce(tg_argv[1], 'true');
  v_lim int; v_uso int; v_cuenta boolean; v_contaba boolean := false;
begin
  if new.tenant_id is null then return new; end if;
  -- Los triggers BEFORE corren ANTES que el WITH CHECK de RLS. En contexto de cliente (o sesión de soporte)
  -- solo se evalúa la cuota de la propia empresa: con otra, RLS rechazará la fila y no se debe revelar
  -- el límite ajeno ni bloquear su fila.
  if auth.uid() is not null and not (auth.jwt() ? 'rol_plataforma' and not auth.jwt() ? 'soporte_sesion_id')
     and new.tenant_id is distinct from app.tenant_actual() then
    return new;
  end if;
  execute format('select (%s) from (select ($1::%s).*) x', v_cond, tg_relid::regclass) into v_cuenta using new;
  if not coalesce(v_cuenta, false) then return new; end if;
  if tg_op = 'UPDATE' and old.tenant_id is not distinct from new.tenant_id then
    execute format('select (%s) from (select ($1::%s).*) x', v_cond, tg_relid::regclass) into v_contaba using old;
    if coalesce(v_contaba, false) then return new; end if;
  end if;
  v_lim := app.limite(new.tenant_id, tg_argv[0]);
  if v_lim is null then return new; end if;
  perform 1 from app.tenants where id = new.tenant_id for update;
  execute format('select count(*) from %s where tenant_id = $1 and id <> $2 and (%s)', tg_relid::regclass, v_cond)
     into v_uso using new.tenant_id, new.id;
  if v_uso >= v_lim then
    raise exception 'Límite del plan alcanzado: % (máximo %)', tg_argv[0], v_lim
      using errcode = 'P0001', hint = 'plan_limite';
  end if;
  return new;
end $$;
create trigger cuota before insert on app.sucursales
  for each row execute function app.trg_cuota('sucursales');
create trigger cuota before insert or update of estado on app.membresias
  for each row execute function app.trg_cuota('usuarios', 'estado <> ''suspendida''');

-- =====================================================================================
-- RLS
-- =====================================================================================
alter table app.modulos            enable row level security;
alter table app.permisos           enable row level security;
alter table app.limites            enable row level security;
alter table app.planes             enable row level security;
alter table app.plan_modulos       enable row level security;
alter table app.plan_limites       enable row level security;
alter table app.staff_plataforma   enable row level security;
alter table app.staff_rol_permisos enable row level security;
alter table app.tenants            enable row level security;
alter table app.tenant_modulos     enable row level security;
alter table app.tenant_limites     enable row level security;
alter table app.sucursales         enable row level security;
alter table app.roles              enable row level security;
alter table app.rol_permisos       enable row level security;
alter table app.membresias         enable row level security;
alter table app.asignaciones_rol   enable row level security;
alter table app.sesiones_soporte   enable row level security;
alter table app.contexto_sesion    enable row level security;

-- ---------- Catálogo: el cliente solo ve lo que le concierne ----------
grant select on app.modulos, app.limites, app.planes, app.plan_modulos, app.plan_limites to authenticated, consola;
grant select on app.permisos to authenticated, consola;
create policy cat_mod on app.modulos      for select to authenticated, consola using (true);
create policy cat_lim on app.limites      for select to authenticated, consola using (true);
create policy cat_plm on app.plan_modulos for select to authenticated, consola using (true);
create policy cat_pll on app.plan_limites for select to authenticated, consola using (true);
create policy cat_pla on app.planes       for select to authenticated, consola using (true);
-- Los permisos de plataforma ni siquiera se listan al cliente
create policy cat_per_cli on app.permisos for select to authenticated using (ambito = 'cliente');
create policy cat_per_con on app.permisos for select to consola       using (true);

-- ---------- Tenants ----------
grant select (id, nombre, nit, plan_id, estado, zona_horaria, mfa_obligatorio, creado) on app.tenants to authenticated;
grant update (nombre, nit, zona_horaria, mfa_obligatorio) on app.tenants to authenticated;
create policy t_cli_sel on app.tenants for select to authenticated using (id = (select app.tenant_actual()));
create policy t_cli_upd on app.tenants for update to authenticated
  using (id = (select app.tenant_actual()) and (select app.permiso_global('cuenta.administrar')))
  with check (id = (select app.tenant_actual()));

grant select, insert, update on app.tenants to consola;
create policy t_con_sel on app.tenants for select to consola using ((select app.staff_tiene('plataforma.tenants.ver')));
create policy t_con_ins on app.tenants for insert to consola with check ((select app.staff_tiene('plataforma.tenants.administrar')));
create policy t_con_upd on app.tenants for update to consola using ((select app.staff_tiene('plataforma.tenants.administrar')));

-- ---------- Excepciones de plan: el cliente las ve, solo la plataforma las cambia ----------
grant select on app.tenant_modulos, app.tenant_limites to authenticated;
grant select, insert, update, delete on app.tenant_modulos, app.tenant_limites to consola;
create policy tm_cli on app.tenant_modulos for select to authenticated using (tenant_id = (select app.tenant_actual()));
create policy tl_cli on app.tenant_limites for select to authenticated using (tenant_id = (select app.tenant_actual()));
create policy tm_con_sel on app.tenant_modulos for select to consola using ((select app.staff_tiene('plataforma.tenants.ver')));
create policy tl_con_sel on app.tenant_limites for select to consola using ((select app.staff_tiene('plataforma.tenants.ver')));
create policy tm_con_all on app.tenant_modulos for all to consola
  using ((select app.staff_tiene('plataforma.planes.administrar'))) with check ((select app.staff_tiene('plataforma.planes.administrar')));
create policy tl_con_all on app.tenant_limites for all to consola
  using ((select app.staff_tiene('plataforma.planes.administrar'))) with check ((select app.staff_tiene('plataforma.planes.administrar')));

-- ---------- Sucursales ----------
grant select, insert, update, delete on app.sucursales to authenticated;
grant select on app.sucursales to consola;
create policy suc_sel on app.sucursales for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and ((select app.permiso_global('sucursales.ver')) or id = any ((select app.sucursales_con_permiso('sucursales.ver'))::uuid[])));
create policy suc_ins on app.sucursales for insert to authenticated with check (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('sucursales.administrar')));
create policy suc_upd on app.sucursales for update to authenticated
  using (tenant_id = (select app.tenant_actual()) and (select app.permiso_global('sucursales.administrar')))
  with check (tenant_id = (select app.tenant_actual()));
create policy suc_del on app.sucursales for delete to authenticated
  using (tenant_id = (select app.tenant_actual()) and (select app.permiso_global('sucursales.administrar')));
create policy suc_con on app.sucursales for select to consola using ((select app.staff_tiene('plataforma.tenants.ver')));

-- ---------- Roles y permisos de roles ----------
grant select, insert, update, delete on app.roles, app.rol_permisos to authenticated;
create policy rol_sel on app.roles for select to authenticated using (
  tenant_id is null or tenant_id = (select app.tenant_actual()));
create policy rol_ins on app.roles for insert to authenticated with check (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('roles.administrar')));
create policy rol_upd on app.roles for update to authenticated
  using (tenant_id = (select app.tenant_actual()) and (select app.permiso_global('roles.administrar')))
  with check (tenant_id = (select app.tenant_actual()));
create policy rol_del on app.roles for delete to authenticated
  using (tenant_id = (select app.tenant_actual()) and (select app.permiso_global('roles.administrar')));

create policy rp_sel on app.rol_permisos for select to authenticated using (
  exists (select 1 from app.roles r where r.id = rol_id));  -- hereda la visibilidad de roles (RLS de roles)
create policy rp_ins on app.rol_permisos for insert to authenticated with check (
  (select app.permiso_global('roles.administrar'))
  and exists (select 1 from app.roles r where r.id = rol_id and r.tenant_id = (select app.tenant_actual())));
create policy rp_del on app.rol_permisos for delete to authenticated using (
  (select app.permiso_global('roles.administrar'))
  and exists (select 1 from app.roles r where r.id = rol_id and r.tenant_id = (select app.tenant_actual())));

-- ---------- Usuarios del cliente (membresías) y asignaciones ----------
grant select, insert, update, delete on app.membresias to authenticated;
grant select, insert, delete on app.asignaciones_rol to authenticated;
create policy mem_sel on app.membresias for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and ((select app.permiso_global('usuarios.ver')) or user_id = auth.uid()));
create policy mem_ins on app.membresias for insert to authenticated with check (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('usuarios.administrar')));
create policy mem_upd on app.membresias for update to authenticated
  using (tenant_id = (select app.tenant_actual()) and (select app.permiso_global('usuarios.administrar')) and user_id <> auth.uid())
  with check (tenant_id = (select app.tenant_actual()));
create policy mem_del on app.membresias for delete to authenticated
  using (tenant_id = (select app.tenant_actual()) and (select app.permiso_global('usuarios.administrar')) and user_id <> auth.uid());

create policy asg_sel on app.asignaciones_rol for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and ((select app.permiso_global('usuarios.ver'))
       or membresia_id = nullif(auth.jwt() ->> 'membresia_id', '')::uuid));
create policy asg_ins on app.asignaciones_rol for insert to authenticated with check (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('usuarios.administrar')));
create policy asg_del on app.asignaciones_rol for delete to authenticated using (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('usuarios.administrar')));

-- ---------- Staff y soporte: solo consola ----------
grant select on app.staff_plataforma, app.staff_rol_permisos to consola;
grant select, insert, update on app.sesiones_soporte to consola;
create policy stf_sel on app.staff_plataforma   for select to consola using (user_id = auth.uid() or (select app.staff_tiene('plataforma.staff.administrar')));
create policy srp_sel on app.staff_rol_permisos for select to consola using (true);
create policy ss_sel on app.sesiones_soporte for select to consola using (
  staff_user_id = auth.uid() or (select app.staff_tiene('plataforma.auditoria.ver')));
create policy ss_ins on app.sesiones_soporte for insert to consola with check (
  staff_user_id = auth.uid() and (select app.staff_tiene('plataforma.soporte.sesion'))
  and (modo = 'lectura' or (select app.staff_tiene('plataforma.soporte.escritura'))));
create policy ss_upd on app.sesiones_soporte for update to consola using (staff_user_id = auth.uid());
-- El cliente ve quién entró a su cuenta, cuándo y por qué
grant select on app.sesiones_soporte to authenticated;
create policy ss_cli on app.sesiones_soporte for select to authenticated using (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('auditoria.ver')));

-- Hook y funciones: solo quien las necesita (el hook es SECURITY DEFINER: no requiere permisos de tabla)
grant usage on schema app to supabase_auth_admin;
grant execute on function app.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant execute on function
  app.tenant_actual(), app.permiso_global(text), app.sucursales_con_permiso(text), app.tiene_permiso(text, uuid),
  app.mis_permisos(), app.tiene_permiso_en_alguna(text), app.modulo_habilitado(uuid, text), app.limite(uuid, text)
  to authenticated;
grant execute on function app.staff_tiene(text), app.modulo_habilitado(uuid, text), app.limite(uuid, text) to consola;
