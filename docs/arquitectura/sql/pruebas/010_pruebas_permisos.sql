-- =====================================================================================
-- Pruebas del modelo multi-tenant y de permisos. Cada bloque intenta ROMPER una regla.
-- Ejecutar sobre una base vacía: 000_stub_supabase.sql → 001 → 002 → 003 → este archivo.
-- Si algo falla, se detiene con "FALLA [...]".
-- =====================================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create schema test;
grant usage on schema test to public;

-- Espera que p_sql falle con el SQLSTATE indicado
create function test.falla(p_nombre text, p_estado text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FALLA [%]: se esperaba error % y no hubo', p_nombre, p_estado;
exception when others then
  if sqlerrm like 'FALLA%' then raise; end if;
  if sqlstate <> p_estado then
    raise exception 'FALLA [%]: se esperaba % y llegó % (%)', p_nombre, p_estado, sqlstate, sqlerrm;
  end if;
  raise notice 'OK  %  →  %', p_nombre, sqlerrm;
end $$;

create function test.igual(p_nombre text, p_valor anyelement, p_esperado anyelement) returns void language plpgsql as $$
begin
  if p_valor is distinct from p_esperado then
    raise exception 'FALLA [%]: obtuve %, esperaba %', p_nombre, p_valor, p_esperado;
  end if;
  raise notice 'OK  %', p_nombre;
end $$;

-- Filas afectadas por una sentencia (para comprobar que RLS no deja modificar nada)
create function test.filas(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- Personas de prueba → claims del JWT
create function test.como(p_quien text, p_aal text default 'aal2') returns void language plpgsql as $$
declare c jsonb;
begin
  c := case p_quien
    when 'owner_a'  then '{"sub":"10000000-0000-4000-8000-00000000000a","tenant_id":"20000000-0000-4000-8000-00000000000a","membresia_id":"40000000-0000-4000-8000-00000000000a"}'
    when 'admin_a'  then '{"sub":"10000000-0000-4000-8000-0000000000aa","tenant_id":"20000000-0000-4000-8000-00000000000a","membresia_id":"40000000-0000-4000-8000-0000000000aa"}'
    when 'sup_a'    then '{"sub":"10000000-0000-4000-8000-000000000a51","tenant_id":"20000000-0000-4000-8000-00000000000a","membresia_id":"40000000-0000-4000-8000-0000000000a5"}'
    when 'owner_b'  then '{"sub":"10000000-0000-4000-8000-00000000000b","tenant_id":"20000000-0000-4000-8000-00000000000b","membresia_id":"40000000-0000-4000-8000-00000000000b"}'
    -- Un usuario de A que "inventa" el tenant de B en su token
    when 'falso_b'  then '{"sub":"10000000-0000-4000-8000-00000000000a","tenant_id":"20000000-0000-4000-8000-00000000000b","membresia_id":"40000000-0000-4000-8000-00000000000b"}'
    when 'staff_sa' then '{"sub":"10000000-0000-4000-8000-0000000005a0","rol_plataforma":"superadmin"}'
    when 'staff_sp' then '{"sub":"10000000-0000-4000-8000-0000000005b0","rol_plataforma":"soporte","soporte_sesion_id":"70000000-0000-4000-8000-000000000001","tenant_id":"20000000-0000-4000-8000-00000000000a"}'
  end::jsonb;
  perform set_config('request.jwt.claims', (c || jsonb_build_object('aal', p_aal, 'role', 'authenticated'))::text, true);
end $$;

-- -------------------------------------------------------------------------------------
-- Datos (como superusuario, sin JWT: igual que una migración o un job)
-- -------------------------------------------------------------------------------------
do $$ begin perform app.crear_particiones('auditoria', 1); perform app.crear_particiones('marcaciones', 1); end $$;

insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-00000000000a', 'owner@a.bo'),
  ('10000000-0000-4000-8000-0000000000aa', 'admin@a.bo'),
  ('10000000-0000-4000-8000-000000000a51', 'supervisor@a.bo'),
  ('10000000-0000-4000-8000-00000000000b', 'owner@b.bo'),
  ('10000000-0000-4000-8000-0000000005a0', 'yo@plataforma.bo'),
  ('10000000-0000-4000-8000-0000000005b0', 'soporte@plataforma.bo');

insert into app.tenants (id, nombre, plan_id, estado)
select '20000000-0000-4000-8000-00000000000a', 'Empresa A', id, 'activo' from app.planes where codigo = 'basico';
insert into app.tenants (id, nombre, plan_id, estado)
select '20000000-0000-4000-8000-00000000000b', 'Empresa B', id, 'activo' from app.planes where codigo = 'profesional';

insert into app.sucursales (id, tenant_id, nombre) values
  ('30000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-00000000000a', 'A Central'),
  ('30000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-00000000000a', 'A Norte'),
  ('30000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-00000000000b', 'B Central');

insert into app.membresias (id, tenant_id, user_id) values
  ('40000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a'),
  ('40000000-0000-4000-8000-0000000000aa', '20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-0000000000aa'),
  ('40000000-0000-4000-8000-0000000000a5', '20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000a51'),
  ('40000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b');

insert into app.asignaciones_rol (tenant_id, membresia_id, rol_id, sucursal_id)
select '20000000-0000-4000-8000-00000000000a'::uuid, '40000000-0000-4000-8000-00000000000a'::uuid, id, null::uuid from app.roles where codigo = 'propietario'
union all
select '20000000-0000-4000-8000-00000000000a'::uuid, '40000000-0000-4000-8000-0000000000aa'::uuid, id, null::uuid from app.roles where codigo = 'administrador'
union all
select '20000000-0000-4000-8000-00000000000a'::uuid, '40000000-0000-4000-8000-0000000000a5'::uuid, id, '30000000-0000-4000-8000-0000000000a1'::uuid from app.roles where codigo = 'supervisor'
union all
select '20000000-0000-4000-8000-00000000000b'::uuid, '40000000-0000-4000-8000-00000000000b'::uuid, id, null::uuid from app.roles where codigo = 'propietario';

insert into app.staff_plataforma (user_id, rol) values
  ('10000000-0000-4000-8000-0000000005a0', 'superadmin'),
  ('10000000-0000-4000-8000-0000000005b0', 'soporte');
insert into app.sesiones_soporte (id, staff_user_id, tenant_id, modo, motivo, expira) values
  ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-0000000005b0', '20000000-0000-4000-8000-00000000000a',
   'lectura', 'Ticket 123: el reloj no sincroniza', now() + interval '1 hour');

insert into app.dispositivos (id, tenant_id, sucursal_id, marca, sn, nombre, estado, transporte, firmware, ip_publica) values
  ('50000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-0000000000a1', 'zkteco', 'SNA1', 'Reloj A1', 'activo', 'zk_adms', 'ZAM180-NF', '200.87.1.1'),
  ('50000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-0000000000a2', 'zkteco', 'SNA2', 'Reloj A2', 'activo', 'zk_adms', 'ZAM180-NF', '200.87.1.2'),
  ('50000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-00000000000b', '30000000-0000-4000-8000-0000000000b1', 'zkteco', 'SNB1', 'Reloj B1', 'activo', 'zk_adms', 'ZAM180-NF', '181.1.1.1'),
  -- Llegó por el subdominio de A: cuarentena de la cuenta
  ('50000000-0000-4000-8000-0000000000a0', '20000000-0000-4000-8000-00000000000a', null, 'zkteco', 'SNA3', 'SNA3', 'cuarentena', 'zk_adms', null, null),
  -- Llegó por el host genérico: cuarentena global (solo plataforma)
  ('50000000-0000-4000-8000-000000000000', null, null, 'dahua', 'SNX', 'SNX', 'cuarentena', 'dahua_http', null, null);

insert into app.empleados (id, tenant_id, sucursal_id, codigo, pin_dispositivo, nombre) values
  ('60000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-0000000000a1', 'A-001', '1', 'Ana (A1)'),
  ('60000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-0000000000a2', 'A-002', '2', 'Luis (A2)'),
  ('60000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-00000000000b', '30000000-0000-4000-8000-0000000000b1', 'B-001', '1', 'Rosa (B1)');

insert into app.marcaciones (tenant_id, sucursal_id, dispositivo_id, empleado_id, pin, ocurrido_en, hora_local) values
  ('20000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000a1', '60000000-0000-4000-8000-0000000000a1', '1', now(), now()::timestamp),
  ('20000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-0000000000a2', '50000000-0000-4000-8000-0000000000a2', '60000000-0000-4000-8000-0000000000a2', '2', now(), now()::timestamp),
  ('20000000-0000-4000-8000-00000000000b', '30000000-0000-4000-8000-0000000000b1', '50000000-0000-4000-8000-0000000000b1', '60000000-0000-4000-8000-0000000000b1', '1', now(), now()::timestamp);

\echo '== 1. Aislamiento entre empresas'
begin;
select test.como('owner_a');
set local role authenticated;
select test.igual('owner A ve solo sus 2 sucursales', (select count(*) from app.sucursales)::int, 2);
select test.igual('owner A ve solo sus 2 empleados', (select count(*) from app.empleados)::int, 2);
select test.igual('owner A ve solo sus 2 marcaciones', (select count(*) from app.marcaciones)::int, 2);
select test.igual('owner A no ve el equipo de B ni pidiéndolo por id',
  (select count(*) from app.dispositivos where id = '50000000-0000-4000-8000-0000000000b1')::int, 0);
select test.igual('owner A no ve la cuarentena global',
  (select count(*) from app.dispositivos where tenant_id is null)::int, 0);
rollback;

begin;
select test.como('falso_b');
set local role authenticated;
select test.igual('token con tenant/membresía de otra empresa no ve nada', (select count(*) from app.empleados)::int, 0);
rollback;

\echo '== 2. Alcance por sucursal (supervisor asignado solo a A Central)'
begin;
select test.como('sup_a', 'aal1');
set local role authenticated;
select test.igual('supervisor ve 1 sucursal', (select count(*) from app.sucursales)::int, 1);
select test.igual('supervisor ve 1 empleado', (select count(*) from app.empleados)::int, 1);
select test.igual('supervisor ve 1 marcación', (select count(*) from app.marcaciones)::int, 1);
select test.igual('mis_permisos: marcaciones.ver limitado a A Central',
  (select row(global, sucursales)::text from app.mis_permisos() where permiso = 'marcaciones.ver'),
  row(false, array['30000000-0000-4000-8000-0000000000a1'::uuid])::text);
select test.igual('mis_permisos no incluye empleados.editar',
  (select count(*) from app.mis_permisos() where permiso = 'empleados.editar')::int, 0);
rollback;

\echo '== 3. Funciones técnicas ocultas al cliente'
begin;
select test.como('owner_a');
set local role authenticated;
select test.falla('cliente no puede leer firmware/IP', '42501', 'select firmware, ip_publica from app.dispositivos');
select test.falla('cliente no puede leer el comando crudo', '42501', 'select comando_vendor from app.comandos');
select test.falla('cliente no puede leer credenciales cifradas', '42501', 'select tarjeta_cifrada from app.empleados');
select test.igual('cliente no ve que existen permisos de plataforma',
  (select count(*) from app.permisos where ambito = 'plataforma')::int, 0);
select test.falla('cliente no puede cambiarse de plan', '42501',
  $$update app.tenants set plan_id = (select id from app.planes where codigo = 'empresarial')$$);
select test.falla('cliente no puede encolar comando crudo', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'comando.crudo')$$);
select test.falla('cliente no puede reiniciar ni borrar el equipo', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'dispositivo.borrar_datos')$$);
insert into app.comandos (tenant_id, dispositivo_id, accion) values
  ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'usuarios.leer');
select test.igual('cliente sí puede pedir "leer usuarios"', (select count(*) from app.comandos)::int, 1);
select test.falla('cliente no puede encolar en un equipo de otra empresa', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000b1', 'usuarios.leer')$$);
rollback;

\echo '== 4. Módulos del plan (Básico no incluye control de acceso)'
begin;
select test.como('owner_a');
set local role authenticated;
select test.falla('sin módulo "acceso" no se abre la puerta aunque el rol lo tenga', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'puerta.abrir')$$);
reset role;
insert into app.tenant_modulos (tenant_id, modulo, habilitado, motivo, vence)
values ('20000000-0000-4000-8000-00000000000a', 'acceso', true, 'Demo 30 días', now() + interval '30 days');
set local role authenticated;
insert into app.comandos (tenant_id, dispositivo_id, accion) values
  ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'puerta.abrir');
select test.igual('con excepción del superusuario, sí abre', (select count(*) from app.comandos where accion = 'puerta.abrir')::int, 1);
select test.como('owner_a', 'aal1');
select test.falla('abrir puerta es sensible: sin MFA (aal1) no se puede', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'puerta.abrir')$$);
rollback;

\echo '== 5. Roles personalizados y anti-escalada'
begin;
select test.como('owner_a');
set local role authenticated;
insert into app.roles (id, tenant_id, nombre) values
  ('80000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-00000000000a', 'Operador de relojes');
insert into app.rol_permisos (rol_id, permiso) values
  ('80000000-0000-4000-8000-000000000001', 'dispositivos.ver'),
  ('80000000-0000-4000-8000-000000000001', 'dispositivos.operar');
insert into app.asignaciones_rol (tenant_id, membresia_id, rol_id, sucursal_id) values
  ('20000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-0000000000a5', '80000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-0000000000a1');
select test.falla('ningún usuario (ni el propietario) mete permisos de plataforma en un rol', '42501',
  $$insert into app.rol_permisos values ('80000000-0000-4000-8000-000000000001', 'plataforma.dispositivos.comando_crudo')$$);
select test.falla('nadie cambia sus propios roles', '42501',
  $$delete from app.asignaciones_rol where membresia_id = '40000000-0000-4000-8000-00000000000a'$$);

-- El supervisor ahora opera relojes, pero solo en A Central
select test.como('sup_a', 'aal1');
insert into app.comandos (tenant_id, dispositivo_id, accion) values
  ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'usuarios.leer');
select test.igual('supervisor opera el reloj de su sucursal', (select count(*) from app.comandos)::int, 1);
select test.falla('supervisor no opera el reloj de otra sucursal', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a2', 'usuarios.leer')$$);

-- El administrador (sin cuenta.administrar) intenta escalar
select test.como('admin_a');
select test.falla('admin no puede otorgar un permiso que no tiene', '42501',
  $$insert into app.rol_permisos values ('80000000-0000-4000-8000-000000000001', 'cuenta.administrar')$$);
select test.falla('admin no puede nombrar propietarios (le falta cuenta.administrar)', '42501',
  $$insert into app.asignaciones_rol (tenant_id, membresia_id, rol_id)
    select '20000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-0000000000a5', id from app.roles where codigo = 'propietario'$$);
select test.falla('admin no puede suspender al único propietario', '42501',
  $$update app.membresias set estado = 'suspendida' where id = '40000000-0000-4000-8000-00000000000a'$$);
select test.falla('admin no puede borrar al propietario', '42501',
  $$delete from app.membresias where id = '40000000-0000-4000-8000-00000000000a'$$);
select test.como('admin_a', 'aal1');
select test.falla('administrar usuarios es sensible: sin MFA no se puede', '42501',
  $$insert into app.asignaciones_rol (tenant_id, membresia_id, rol_id)
    select '20000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-0000000000a5', id from app.roles where codigo = 'lectura'$$);
-- El propietario sí puede nombrar a otro propietario aunque la plantilla incluya módulos fuera de su plan
select test.como('owner_a');
insert into app.asignaciones_rol (tenant_id, membresia_id, rol_id)
select '20000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-0000000000aa', id from app.roles where codigo = 'propietario';
select test.igual('propietario nombra a otro propietario en plan Básico',
  (select count(*) from app.asignaciones_rol ar join app.roles r on r.id = ar.rol_id where r.codigo = 'propietario')::int, 2);
-- Con dos propietarios se puede quitar uno; el que queda sigue protegido
delete from app.asignaciones_rol ar using app.roles r
 where r.id = ar.rol_id and r.codigo = 'propietario' and ar.membresia_id = '40000000-0000-4000-8000-0000000000aa';
select test.igual('con otro propietario activo, se le quita el rol al segundo',
  (select count(*) from app.asignaciones_rol ar join app.roles r on r.id = ar.rol_id where r.codigo = 'propietario')::int, 1);
select test.como('admin_a');
select test.falla('y el último propietario sigue sin poder ser suspendido', '42501',
  $$update app.membresias set estado = 'suspendida' where id = '40000000-0000-4000-8000-00000000000a'$$);
rollback;

\echo '== 6. Integridad entre empresas (FKs compuestas)'
select test.falla('no se enrola un empleado de A en un reloj de B', '23503',
  $$insert into app.empleado_dispositivo (tenant_id, empleado_id, dispositivo_id) values
    ('20000000-0000-4000-8000-00000000000a', '60000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000b1')$$);
select test.falla('no se guarda una marcación de A con un reloj de B', '23503',
  $$insert into app.marcaciones (tenant_id, sucursal_id, dispositivo_id, pin, ocurrido_en, hora_local) values
    ('20000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-0000000000a1', '50000000-0000-4000-8000-0000000000b1', '9', now(), now())$$);
select test.falla('ni siquiera una migración mete un permiso de plataforma en un rol de cliente', '42501',
  $$insert into app.rol_permisos select id, 'plataforma.tenants.ver' from app.roles where codigo = 'administrador'$$);
select test.falla('una cuenta de staff no puede ser miembro de una empresa', '42501',
  $$insert into app.membresias (tenant_id, user_id) values
    ('20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-0000000005a0')$$);

\echo '== 7. Cuotas del plan (Básico: 3 equipos activos)'
begin;
select test.como('owner_a');
set local role authenticated;
select app.aceptar_dispositivo('50000000-0000-4000-8000-0000000000a0', '30000000-0000-4000-8000-0000000000a1', 'Reloj A3');
select test.igual('acepta el 3.er equipo detectado en su cuenta',
  (select count(*) from app.dispositivos where estado = 'activo')::int, 3);
reset role;
insert into app.dispositivos (id, tenant_id, marca, sn, nombre, transporte) values
  ('50000000-0000-4000-8000-0000000000a9', '20000000-0000-4000-8000-00000000000a', 'zkteco', 'SNA4', 'SNA4', 'zk_adms');
set local role authenticated;
select test.falla('el 4.º equipo supera el plan', 'P0001',
  $$select app.aceptar_dispositivo('50000000-0000-4000-8000-0000000000a9', '30000000-0000-4000-8000-0000000000a1', 'Reloj A4')$$);
select test.falla('insertar en otra empresa lo rechaza RLS, sin revelar la cuota ajena', '42501',
  $$insert into app.sucursales (tenant_id, nombre) values ('20000000-0000-4000-8000-00000000000b', 'Intrusa')$$);
reset role;
update app.dispositivos set estado = 'retirado' where id = '50000000-0000-4000-8000-0000000000a1';
select test.igual('retirar un equipo estando en el límite no se bloquea',
  (select estado::text from app.dispositivos where id = '50000000-0000-4000-8000-0000000000a1'), 'retirado');
rollback;

\echo '== 8. Soporte: solo con sesión, temporal y de solo lectura'
begin;
select test.como('staff_sp');
set local role authenticated;
select test.igual('soporte en sesión ve los empleados de A', (select count(*) from app.empleados)::int, 2);
select test.igual('soporte en sesión no ve B', (select count(*) from app.empleados where tenant_id = '20000000-0000-4000-8000-00000000000b')::int, 0);
select test.igual('sesión de lectura: no modifica', test.filas($$update app.empleados set nombre = 'x'$$), 0);
select test.falla('sesión de lectura: no envía comandos', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'usuarios.leer')$$);
reset role;
update app.sesiones_soporte set revocada_en = now() where id = '70000000-0000-4000-8000-000000000001';
set local role authenticated;
select test.igual('sesión revocada: ya no ve nada (aunque el token siga vivo)', (select count(*) from app.empleados)::int, 0);
rollback;

\echo '== 9. Consola de plataforma (rol consola)'
begin;
select test.como('staff_sa');
set local role consola;
select test.igual('superadmin ve todas las empresas', (select count(*) from app.tenants)::int, 2);
select test.igual('superadmin ve datos técnicos y la cuarentena global',
  (select count(*) from app.dispositivos where firmware is not null or tenant_id is null)::int, 4);
select test.falla('superadmin NO ve datos personales de empleados sin sesión de soporte', '42501',
  'select count(*) from app.empleados');
select test.falla('la consola no encola acciones sobre datos del cliente', '42501',
  $$insert into app.comandos (tenant_id, dispositivo_id, accion) values
    ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'usuario.borrar')$$);
insert into app.comandos (tenant_id, dispositivo_id, accion) values
  ('20000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-0000000000a1', 'dispositivo.reiniciar');
select test.igual('la consola sí reinicia un equipo', (select count(*) from app.comandos where accion = 'dispositivo.reiniciar')::int, 1);
select test.como('staff_sa', 'aal1');
select test.igual('staff sin MFA no ve nada', (select count(*) from app.tenants)::int, 0);
rollback;

begin;
select test.como('staff_sa');
set local role authenticated;
select test.igual('staff por el panel del cliente sin sesión de soporte no ve nada', (select count(*) from app.empleados)::int, 0);
rollback;

\echo '== 10. Estado de la cuenta'
begin;
update app.tenants set estado = 'suspendido' where id = '20000000-0000-4000-8000-00000000000a';
select test.como('owner_a');
set local role authenticated;
select test.igual('suspendida: puede leer (y exportar) sus datos', (select count(*) from app.empleados)::int, 2);
select test.falla('suspendida: no puede escribir', '42501',
  $$insert into app.roles (tenant_id, nombre) values ('20000000-0000-4000-8000-00000000000a', 'Nuevo rol')$$);
select test.igual('suspendida: no edita', test.filas($$update app.empleados set cargo = 'x'$$), 0);
reset role;
update app.tenants set estado = 'cancelado' where id = '20000000-0000-4000-8000-00000000000a';
set local role authenticated;
select test.igual('cancelada: no ve nada', (select count(*) from app.empleados)::int, 0);
rollback;

\echo '== 11. Hook del token'
select test.igual('hook: cliente recibe tenant y membresía',
  (select app.custom_access_token_hook(
     '{"user_id":"10000000-0000-4000-8000-00000000000a","claims":{"sub":"10000000-0000-4000-8000-00000000000a","aal":"aal1"}}'
   ) -> 'claims' ->> 'membresia_id'),
  '40000000-0000-4000-8000-00000000000a');
insert into app.contexto_sesion (user_id, soporte_sesion_id)
values ('10000000-0000-4000-8000-0000000005b0', '70000000-0000-4000-8000-000000000001');
select test.igual('hook: staff recibe rol y su sesión de soporte',
  (select (c ->> 'rol_plataforma') || '/' || (c ->> 'soporte_sesion_id') from (select app.custom_access_token_hook(
     '{"user_id":"10000000-0000-4000-8000-0000000005b0","claims":{"sub":"10000000-0000-4000-8000-0000000005b0","tenant_id":"inyectado"}}'
   ) -> 'claims' c) x),
  'soporte/70000000-0000-4000-8000-000000000001');
select test.igual('hook: staff nunca recibe membresía de cliente',
  (select app.custom_access_token_hook(
     '{"user_id":"10000000-0000-4000-8000-0000000005a0","claims":{"membresia_id":"40000000-0000-4000-8000-00000000000a"}}'
   ) -> 'claims' ? 'membresia_id'), false);

\echo '== 12. Auditoría'
begin;
select test.como('owner_a');
set local role authenticated;
update app.empleados set cargo = 'Jefa' where id = '60000000-0000-4000-8000-0000000000a1';
select test.igual('el cambio queda auditado con su actor',
  (select actor_tipo || ':' || (despues ->> 'cargo') from app.auditoria where entidad = 'empleados' and accion = 'update'),
  'usuario:Jefa');
select test.igual('el cliente ve el acceso del soporte en su auditoría',
  (select count(*) from app.sesiones_soporte)::int, 1);
rollback;
select test.falla('la auditoría no se puede borrar (ni como superusuario)', '42501', 'delete from app.auditoria');

\echo '== TODAS LAS PRUEBAS PASARON'
