-- =====================================================================================
-- 002 — Operación: dispositivos, agentes, comandos, empleados, marcaciones y auditoría
-- Requiere 001. Todas las tablas llevan tenant_id y FKs compuestas (tenant_id, id): la base
-- de datos rechaza, por ejemplo, enrolar un empleado de la empresa A en un equipo de la B.
-- =====================================================================================

create type app.marca_equipo       as enum ('zkteco', 'dahua');
create type app.estado_dispositivo as enum ('cuarentena', 'activo', 'retirado');

-- Agente local (edge) instalado en una sucursal: habla con equipos de la LAN (p. ej. Dahua por HTTP/CGI)
create table app.agentes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references app.tenants(id),
  sucursal_id      uuid not null,
  nombre           text not null,
  version          text,
  huella_cert      text unique,                  -- fingerprint del certificado mTLS emitido al enrolarlo
  ultimo_contacto  timestamptz,
  revocado_en      timestamptz,
  creado           timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, sucursal_id) references app.sucursales(tenant_id, id)
);

create table app.dispositivos (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references app.tenants(id),      -- null = cuarentena global (solo plataforma)
  sucursal_id     uuid,
  marca           app.marca_equipo not null,
  sn              text not null,
  modelo          text,
  nombre          text not null,
  uso             text not null default 'asistencia' check (uso in ('asistencia', 'acceso', 'mixto')),
  estado          app.estado_dispositivo not null default 'cuarentena',
  capacidades     jsonb not null default '{}',          -- {"rostro":true,"huella":true,"tarjeta":true,"puertas":1}
  ultimo_contacto timestamptz,                           -- lo vuelca el gateway por lotes (no en cada latido)
  -- Técnico: el rol `authenticated` NO tiene permiso de columna sobre estos campos
  transporte      text not null check (transporte in ('zk_adms', 'dahua_http', 'agente')),
  agente_id       uuid,
  firmware        text,
  ip_publica      inet,
  info_tecnica    jsonb,
  creado          timestamptz not null default now(),
  unique (marca, sn),
  unique (tenant_id, id),
  foreign key (tenant_id, sucursal_id) references app.sucursales(tenant_id, id),
  foreign key (tenant_id, agente_id)   references app.agentes(tenant_id, id),
  check (estado = 'cuarentena' or (tenant_id is not null and sucursal_id is not null)),
  check ((transporte = 'agente') = (agente_id is not null))
);
create trigger cuota before insert or update of tenant_id, estado on app.dispositivos
  for each row execute function app.trg_cuota('dispositivos', 'estado = ''activo''');

-- Catálogo de acciones canónicas (independientes de la marca). Cada una exige un permiso;
-- si el permiso es de ámbito 'plataforma', el cliente simplemente no puede encolarla.
create table app.acciones_dispositivo (
  codigo      text primary key,
  permiso     text not null references app.permisos(codigo),
  ttl         interval,                 -- null = espera a que el equipo vuelva; 'puerta.abrir' caduca en segundos
  descripcion text not null
);

create table app.comandos (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null,
  dispositivo_id  uuid not null,
  operacion_id    uuid,                   -- saga de varios pasos (p. ej. cambio de PIN)
  paso            smallint,
  accion          text not null references app.acciones_dispositivo(codigo),
  -- Referencias, nunca secretos: la clave/tarjeta se descifra y se renderiza al momento de enviar
  parametros      jsonb not null default '{}',
  estado          text not null default 'pendiente'
                    check (estado in ('espera', 'pendiente', 'enviado', 'ok', 'error', 'cancelado', 'expirado')),
  intentos        smallint not null default 0,
  resultado       text,                   -- mensaje legible para el cliente
  -- Técnico (solo plataforma): comando tal como salió, con secretos redactados, y código del equipo
  comando_vendor  text,
  codigo_retorno  text,
  creado_por      uuid,
  creado          timestamptz not null default now(),
  expira_en       timestamptz,
  enviado         timestamptz,
  respondido      timestamptz,
  foreign key (tenant_id, dispositivo_id) references app.dispositivos(tenant_id, id)
);
create index comandos_cola on app.comandos (dispositivo_id, id) where estado in ('pendiente', 'enviado');
create index comandos_operacion on app.comandos (operacion_id) where operacion_id is not null;

create table app.empleados (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references app.tenants(id),
  sucursal_id     uuid,                   -- sucursal base: define qué supervisores lo ven
  codigo          text not null,          -- código de RRHH (puede cambiar sin tocar los equipos)
  pin_dispositivo text not null check (pin_dispositivo ~ '^[0-9]{1,9}$'),  -- ID en los equipos (estable)
  nombre          text not null,
  documento       text,
  departamento    text,
  cargo           text,
  -- Credenciales cifradas en la aplicación (AES-256-GCM, clave por empresa); jamás se devuelven en claro
  tarjeta_cifrada bytea,
  tarjeta_hash    bytea,                  -- HMAC para buscar por tarjeta sin descifrar
  tarjeta_ult4    text,
  clave_cifrada   bytea,
  activo          boolean not null default true,
  creado          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, pin_dispositivo),
  unique (tenant_id, codigo),
  foreign key (tenant_id, sucursal_id) references app.sucursales(tenant_id, id)
);
create trigger cuota before insert or update of activo on app.empleados
  for each row execute function app.trg_cuota('empleados', 'activo');

-- En qué equipos debe existir cada empleado y qué biometría tiene allí (solo indicadores, sin plantillas)
create table app.empleado_dispositivo (
  tenant_id      uuid not null,
  empleado_id    uuid not null,
  dispositivo_id uuid not null,
  estado_sync    text not null default 'pendiente'
                   check (estado_sync in ('pendiente', 'sincronizado', 'error', 'eliminando')),
  tiene_rostro   boolean not null default false,
  huellas        smallint not null default 0,
  actualizado    timestamptz not null default now(),
  primary key (tenant_id, empleado_id, dispositivo_id),
  foreign key (tenant_id, empleado_id)    references app.empleados(tenant_id, id) on delete cascade,
  foreign key (tenant_id, dispositivo_id) references app.dispositivos(tenant_id, id)
);

-- Bandeja: usuarios tal como los reporta el equipo (para importarlos o detectar altas hechas en el reloj)
create table app.usuarios_dispositivo (
  tenant_id       uuid not null,
  dispositivo_id  uuid not null,
  pin             text not null,
  nombre          text,
  privilegio      smallint not null default 0,
  tiene_tarjeta   boolean not null default false,
  tiene_clave     boolean not null default false,
  tiene_rostro    boolean not null default false,
  huellas         smallint not null default 0,
  tarjeta_cifrada bytea,                  -- necesarias para no borrarle la tarjeta/clave al reenviar el usuario
  clave_cifrada   bytea,
  visto           timestamptz not null default now(),
  primary key (dispositivo_id, pin),
  foreign key (tenant_id, dispositivo_id) references app.dispositivos(tenant_id, id)
);

-- -------------------------------------------------------------------------------------
-- Marcaciones: particionada por mes. Inmutable (las correcciones van a otra tabla de ajustes).
-- -------------------------------------------------------------------------------------
create table app.marcaciones (
  id             bigint generated always as identity,
  tenant_id      uuid not null,
  sucursal_id    uuid not null,           -- denormalizado: filtro y RLS por sucursal sin JOIN
  dispositivo_id uuid not null,
  empleado_id    uuid,                    -- resuelto al ingresar (null = PIN desconocido)
  pin            text not null,
  ocurrido_en    timestamptz not null,    -- hora del equipo convertida con la zona IANA de la sucursal
  hora_local     timestamp not null,      -- tal como la reportó el equipo
  tipo           text not null default 'marcacion'
                   check (tipo in ('marcacion', 'acceso_concedido', 'acceso_denegado')),
  sentido        smallint,                -- 0 entrada, 1 salida, null desconocido
  metodo         text,                    -- rostro, huella, tarjeta, clave, qr, remoto (normalizado entre marcas)
  puerta         smallint,
  origen         text not null default 'tiempo_real' check (origen in ('tiempo_real', 'recuperada', 'importada')),
  recibido_en    timestamptz not null default now(),
  primary key (ocurrido_en, id),
  unique (dispositivo_id, pin, ocurrido_en),   -- idempotencia: los equipos reenvían lo no confirmado
  foreign key (tenant_id, dispositivo_id) references app.dispositivos(tenant_id, id)
) partition by range (ocurrido_en);
create index on app.marcaciones (tenant_id, ocurrido_en desc);
create index on app.marcaciones (tenant_id, empleado_id, ocurrido_en desc);
create index on app.marcaciones (tenant_id, sucursal_id, ocurrido_en desc);

-- -------------------------------------------------------------------------------------
-- Auditoría: append-only, particionada por mes
-- -------------------------------------------------------------------------------------
create table app.auditoria (
  id                bigint generated always as identity,
  tenant_id         uuid,                 -- null = acción de plataforma
  ocurrido_en       timestamptz not null default now(),
  actor_user_id     uuid,
  actor_tipo        text not null check (actor_tipo in ('usuario', 'staff', 'soporte', 'sistema', 'api_key', 'dispositivo')),
  soporte_sesion_id uuid,
  accion            text not null,
  entidad           text not null,
  entidad_id        text,
  antes             jsonb,
  despues           jsonb,
  ip                inet,
  request_id        text,
  primary key (ocurrido_en, id)
) partition by range (ocurrido_en);
create index on app.auditoria (tenant_id, ocurrido_en desc);

create function app.trg_auditoria_inmutable() returns trigger
language plpgsql as $$
begin
  raise exception 'La auditoría es de solo inserción' using errcode = '42501';
end $$;
create trigger inmutable before update or delete on app.auditoria
  for each row execute function app.trg_auditoria_inmutable();

-- Trigger genérico: registra quién (usuario, staff, soporte o sistema) cambió qué. Nunca guarda secretos.
create function app.trg_auditar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'clave_cifrada' - 'tarjeta_cifrada' - 'tarjeta_hash' end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'clave_cifrada' - 'tarjeta_cifrada' - 'tarjeta_hash' end;
  v_row jsonb := coalesce(v_new, v_old);
  v_jwt jsonb := auth.jwt();
begin
  if tg_op = 'UPDATE' and v_old = v_new then return null; end if;
  insert into app.auditoria (tenant_id, actor_user_id, actor_tipo, soporte_sesion_id, accion, entidad, entidad_id,
                             antes, despues, ip, request_id)
  values (
    case when tg_table_name = 'tenants' then (v_row ->> 'id')::uuid else (v_row ->> 'tenant_id')::uuid end,
    auth.uid(),
    case when v_jwt ? 'soporte_sesion_id' then 'soporte'
         when v_jwt ? 'rol_plataforma'    then 'staff'
         when auth.uid() is not null      then 'usuario'
         else 'sistema' end,
    nullif(v_jwt ->> 'soporte_sesion_id', '')::uuid,
    lower(tg_op), tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'rol_id', v_row ->> 'empleado_id'),
    v_old, v_new,
    nullif(current_setting('app.ip', true), '')::inet,
    nullif(current_setting('app.request_id', true), ''));
  return null;
end $$;

create trigger auditar after insert or update or delete on app.tenants          for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.tenant_modulos   for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.tenant_limites   for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.sucursales       for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.roles            for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.rol_permisos     for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.membresias       for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.asignaciones_rol for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.empleados        for each row execute function app.trg_auditar();
create trigger auditar after insert or update or delete on app.sesiones_soporte for each row execute function app.trg_auditar();
-- En dispositivos solo interesan los cambios de negocio, no el latido (ultimo_contacto)
create trigger auditar after insert or delete or update of tenant_id, sucursal_id, nombre, uso, estado
  on app.dispositivos for each row execute function app.trg_auditar();

-- -------------------------------------------------------------------------------------
-- Particiones mensuales (programar a diario con pg_cron, o reemplazar por pg_partman)
-- -------------------------------------------------------------------------------------
create function app.crear_particiones(p_tabla text, p_meses_adelante int default 3) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_mes date := date_trunc('month', now())::date;
  v_nombre text;
begin
  for i in 0 .. p_meses_adelante loop
    v_nombre := format('%s_%s', p_tabla, to_char(v_mes, 'YYYY_MM'));
    if to_regclass('app.' || v_nombre) is null then
      execute format('create table app.%I partition of app.%I for values from (%L) to (%L)',
                     v_nombre, p_tabla, v_mes, (v_mes + interval '1 month')::date);
    end if;
    v_mes := (v_mes + interval '1 month')::date;
  end loop;
end $$;

do $$ begin perform app.crear_particiones('marcaciones', 3); perform app.crear_particiones('auditoria', 3); end $$;
-- Red de seguridad: si el job de particiones deja de correr, auditar nunca debe hacer fallar una operación.
-- (Alertar si esta partición tiene filas.) Las marcaciones NO llevan DEFAULT: el gateway rechaza fechas
-- fuera de rango (relojes sin hora: año 2000, 2099...) y las guarda en una bandeja de rechazadas.
create table app.auditoria_default partition of app.auditoria default;
-- pg_cron (Supabase): select cron.schedule('particiones', '0 3 * * *',
--   $$select app.crear_particiones('marcaciones', 3); select app.crear_particiones('auditoria', 3)$$);

-- =====================================================================================
-- Servicio de la cola: la acción exige su permiso en la sucursal del equipo y equipo activo.
-- =====================================================================================
create function app.puede_encolar(p_accion text, p_dispositivo uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from app.dispositivos d join app.acciones_dispositivo a on a.codigo = p_accion
     where d.id = p_dispositivo and d.estado = 'activo'
       and d.tenant_id = app.tenant_actual()
       and app.tiene_permiso(a.permiso, d.sucursal_id))
$$;

-- El equipo llegó por el subdominio de la empresa y quedó en cuarentena "de la cuenta":
-- un usuario con permiso lo acepta en una sucursal (la cuota del plan se valida en el trigger).
create function app.aceptar_dispositivo(p_dispositivo uuid, p_sucursal uuid, p_nombre text, p_uso text default 'asistencia')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.tiene_permiso('dispositivos.administrar', p_sucursal) then
    raise exception 'No tienes permiso para administrar equipos en esa sucursal' using errcode = '42501';
  end if;
  update app.dispositivos
     set estado = 'activo', sucursal_id = p_sucursal, uso = p_uso, nombre = coalesce(nullif(trim(p_nombre), ''), sn)
   where id = p_dispositivo and tenant_id = app.tenant_actual() and estado = 'cuarentena';
  if not found then
    raise exception 'El equipo no está pendiente en tu cuenta' using errcode = 'P0002';
  end if;
end $$;

-- =====================================================================================
-- RLS
-- =====================================================================================
alter table app.agentes              enable row level security;
alter table app.dispositivos         enable row level security;
alter table app.acciones_dispositivo enable row level security;
alter table app.comandos             enable row level security;
alter table app.empleados            enable row level security;
alter table app.empleado_dispositivo enable row level security;
alter table app.usuarios_dispositivo enable row level security;
alter table app.marcaciones          enable row level security;
alter table app.auditoria            enable row level security;

-- ---------- Dispositivos: el cliente ve columnas de negocio; lo técnico ni siquiera es seleccionable ----------
grant select (id, tenant_id, sucursal_id, marca, sn, modelo, nombre, uso, estado, capacidades, ultimo_contacto, creado)
  on app.dispositivos to authenticated;
grant update (nombre, sucursal_id, uso) on app.dispositivos to authenticated;
create policy dis_sel on app.dispositivos for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and ((select app.permiso_global('dispositivos.ver')) or sucursal_id = any ((select app.sucursales_con_permiso('dispositivos.ver'))::uuid[])));
create policy dis_upd on app.dispositivos for update to authenticated
  using (tenant_id = (select app.tenant_actual()) and (select app.permiso_global('dispositivos.administrar')))
  with check (tenant_id = (select app.tenant_actual()) and estado = 'activo');

grant select, insert, update on app.dispositivos to consola;
create policy dis_con_sel on app.dispositivos for select to consola using ((select app.staff_tiene('plataforma.dispositivos.ver')));
create policy dis_con_ins on app.dispositivos for insert to consola with check ((select app.staff_tiene('plataforma.dispositivos.asignar')));
create policy dis_con_upd on app.dispositivos for update to consola using ((select app.staff_tiene('plataforma.dispositivos.asignar')));

grant select on app.agentes to authenticated;
create policy age_sel on app.agentes for select to authenticated using (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('dispositivos.ver')));
grant select, update on app.agentes to consola;
create policy age_con on app.agentes for all to consola using ((select app.staff_tiene('plataforma.dispositivos.ver')));

-- ---------- Acciones y comandos ----------
grant select on app.acciones_dispositivo to authenticated, consola;
create policy acc_cli on app.acciones_dispositivo for select to authenticated using (
  exists (select 1 from app.permisos p where p.codigo = permiso));      -- hereda el filtro por ámbito de permisos
create policy acc_con on app.acciones_dispositivo for select to consola using (true);

grant select (id, tenant_id, dispositivo_id, operacion_id, accion, estado, intentos, resultado, creado, expira_en, respondido)
  on app.comandos to authenticated;
grant insert (tenant_id, dispositivo_id, operacion_id, paso, accion, parametros, estado, creado_por, expira_en)
  on app.comandos to authenticated;
create policy cmd_sel on app.comandos for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and exists (select 1 from app.dispositivos d where d.id = dispositivo_id));  -- hereda el alcance por sucursal
create policy cmd_ins on app.comandos for insert to authenticated with check (
  tenant_id = (select app.tenant_actual())
  and estado in ('pendiente', 'espera')
  and app.puede_encolar(accion, dispositivo_id));

grant select, insert, update on app.comandos to consola;
create policy cmd_con_sel on app.comandos for select to consola using ((select app.staff_tiene('plataforma.dispositivos.ver')));
-- La consola solo encola acciones de plataforma (reinicio, firmware, comando crudo...), nunca de datos del cliente
create policy cmd_con_ins on app.comandos for insert to consola with check (
  exists (select 1 from app.acciones_dispositivo a join app.permisos p on p.codigo = a.permiso
           where a.codigo = accion and p.ambito = 'plataforma' and app.staff_tiene(a.permiso)));

-- ---------- Empleados (la consola NO tiene acceso: solo con sesión de soporte, por el panel del cliente) ----------
grant select (id, tenant_id, sucursal_id, codigo, pin_dispositivo, nombre, documento, departamento, cargo,
              tarjeta_ult4, activo, creado) on app.empleados to authenticated;
grant insert, update (sucursal_id, codigo, pin_dispositivo, nombre, documento, departamento, cargo,
                      tarjeta_cifrada, tarjeta_hash, tarjeta_ult4, clave_cifrada, activo) on app.empleados to authenticated;
grant delete on app.empleados to authenticated;
create policy emp_sel on app.empleados for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and ((select app.permiso_global('empleados.ver')) or sucursal_id = any ((select app.sucursales_con_permiso('empleados.ver'))::uuid[])));
create policy emp_ins on app.empleados for insert to authenticated with check (
  tenant_id = (select app.tenant_actual())
  and ((select app.permiso_global('empleados.editar')) or sucursal_id = any ((select app.sucursales_con_permiso('empleados.editar'))::uuid[])));
create policy emp_upd on app.empleados for update to authenticated
  using (tenant_id = (select app.tenant_actual())
    and ((select app.permiso_global('empleados.editar')) or sucursal_id = any ((select app.sucursales_con_permiso('empleados.editar'))::uuid[])))
  with check (tenant_id = (select app.tenant_actual())
    and ((select app.permiso_global('empleados.editar')) or sucursal_id = any ((select app.sucursales_con_permiso('empleados.editar'))::uuid[])));
create policy emp_del on app.empleados for delete to authenticated using (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('empleados.eliminar')));

grant select, insert, update, delete on app.empleado_dispositivo to authenticated;
create policy ed_all on app.empleado_dispositivo for all to authenticated
  using (tenant_id = (select app.tenant_actual()) and exists (select 1 from app.empleados e where e.id = empleado_id))
  with check (tenant_id = (select app.tenant_actual())
    and exists (select 1 from app.empleados e where e.id = empleado_id)
    and exists (select 1 from app.dispositivos d where d.id = dispositivo_id));

grant select (tenant_id, dispositivo_id, pin, nombre, privilegio, tiene_tarjeta, tiene_clave, tiene_rostro, huellas, visto)
  on app.usuarios_dispositivo to authenticated;
create policy ud_sel on app.usuarios_dispositivo for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and (select app.tiene_permiso_en_alguna('dispositivos.bandeja'))
  and exists (select 1 from app.dispositivos d where d.id = dispositivo_id));

-- ---------- Marcaciones: solo lectura para personas; escribe el gateway ----------
grant select on app.marcaciones to authenticated;
create policy mar_sel on app.marcaciones for select to authenticated using (
  tenant_id = (select app.tenant_actual())
  and ((select app.permiso_global('marcaciones.ver')) or sucursal_id = any ((select app.sucursales_con_permiso('marcaciones.ver'))::uuid[])));

-- ---------- Auditoría ----------
grant select on app.auditoria to authenticated, consola;
create policy aud_cli on app.auditoria for select to authenticated using (
  tenant_id = (select app.tenant_actual()) and (select app.permiso_global('auditoria.ver')));
create policy aud_con on app.auditoria for select to consola using ((select app.staff_tiene('plataforma.auditoria.ver')));

-- ---------- Gateway de equipos (rol de servicio acotado, sin BYPASSRLS) ----------
grant select, update (ultimo_contacto, firmware, ip_publica, info_tecnica, capacidades, modelo) on app.dispositivos to gateway;
grant insert (marca, sn, nombre, transporte, tenant_id, ip_publica, info_tecnica) on app.dispositivos to gateway;
grant select, update (estado, intentos, resultado, comando_vendor, codigo_retorno, enviado, respondido) on app.comandos to gateway;
grant insert on app.marcaciones to gateway;
grant select, insert, update, delete on app.usuarios_dispositivo to gateway;
grant select, update (estado_sync, tiene_rostro, huellas, actualizado) on app.empleado_dispositivo to gateway;
grant select (id, tenant_id, pin_dispositivo, nombre, tarjeta_cifrada, clave_cifrada, activo) on app.empleados to gateway;
grant select on app.sucursales, app.tenants, app.acciones_dispositivo to gateway;
create policy gw on app.dispositivos         for all    to gateway using (true) with check (estado = 'cuarentena' or tenant_id is not null);
create policy gw on app.comandos             for all    to gateway using (true);
create policy gw on app.marcaciones          for insert to gateway with check (true);
create policy gw on app.usuarios_dispositivo for all    to gateway using (true);
create policy gw on app.empleado_dispositivo for all    to gateway using (true);
create policy gw on app.empleados            for select to gateway using (true);
create policy gw on app.sucursales           for select to gateway using (true);
create policy gw on app.tenants              for select to gateway using (true);
create policy gw on app.acciones_dispositivo for select to gateway using (true);

grant execute on function app.puede_encolar(text, uuid), app.aceptar_dispositivo(uuid, uuid, text, text) to authenticated;
