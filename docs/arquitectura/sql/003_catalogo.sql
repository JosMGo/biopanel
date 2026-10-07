-- =====================================================================================
-- 003 — Catálogo: módulos, permisos, límites, planes, plantillas de rol y acciones de equipo
-- Es código, no datos del cliente: se versiona y se cambia solo por migración.
-- =====================================================================================

insert into app.modulos (codigo, nombre, descripcion) values
  ('nucleo',             'Núcleo',               'Sucursales, equipos, empleados, marcaciones, usuarios y auditoría'),
  ('asistencia',         'Asistencia',           'Horarios, turnos, jornadas calculadas, ajustes y aprobaciones'),
  ('acceso',             'Control de acceso',    'Puertas, reglas y horarios de acceso, apertura remota, eventos'),
  ('reportes_avanzados', 'Reportes avanzados',   'Reportes consolidados, programados y exportaciones grandes'),
  ('integraciones',      'Integraciones',        'API pública con llaves y webhooks');

insert into app.permisos (codigo, modulo, ambito, tipo, sensible, descripcion) values
  -- Cliente · núcleo
  ('cuenta.administrar',        'nucleo', 'cliente', 'escritura', true,  'Datos de la empresa, MFA obligatorio, transferir propiedad'),
  ('sucursales.ver',            'nucleo', 'cliente', 'lectura',   false, 'Ver sucursales'),
  ('sucursales.administrar',    'nucleo', 'cliente', 'escritura', false, 'Crear, editar y eliminar sucursales'),
  ('dispositivos.ver',          'nucleo', 'cliente', 'lectura',   false, 'Ver equipos, estado y sincronización'),
  ('dispositivos.administrar',  'nucleo', 'cliente', 'escritura', false, 'Aceptar, renombrar y mover equipos'),
  ('dispositivos.operar',       'nucleo', 'cliente', 'escritura', false, 'Sincronizar, leer usuarios, recuperar marcaciones, ajustar hora'),
  ('dispositivos.bandeja',      'nucleo', 'cliente', 'lectura',   false, 'Ver los usuarios que existen en el equipo'),
  ('empleados.ver',             'nucleo', 'cliente', 'lectura',   false, 'Ver empleados'),
  ('empleados.editar',          'nucleo', 'cliente', 'escritura', false, 'Crear y editar empleados y enviarlos a los equipos'),
  ('empleados.credenciales',    'nucleo', 'cliente', 'escritura', true,  'Asignar tarjeta y clave del equipo'),
  ('empleados.eliminar',        'nucleo', 'cliente', 'escritura', false, 'Eliminar empleados (y borrarlos de los equipos)'),
  ('marcaciones.ver',           'nucleo', 'cliente', 'lectura',   false, 'Ver marcaciones'),
  ('marcaciones.exportar',      'nucleo', 'cliente', 'lectura',   false, 'Exportar marcaciones'),
  ('usuarios.ver',              'nucleo', 'cliente', 'lectura',   false, 'Ver usuarios del panel y sus roles'),
  ('usuarios.administrar',      'nucleo', 'cliente', 'escritura', true,  'Invitar, suspender y asignar roles'),
  ('roles.administrar',         'nucleo', 'cliente', 'escritura', true,  'Crear y editar roles personalizados'),
  ('auditoria.ver',             'nucleo', 'cliente', 'lectura',   false, 'Ver la auditoría de la empresa (incluye accesos de soporte)'),
  -- Cliente · asistencia
  ('asistencia.ver',            'asistencia', 'cliente', 'lectura',   false, 'Ver jornadas, atrasos y horas'),
  ('asistencia.horarios',       'asistencia', 'cliente', 'escritura', false, 'Configurar horarios, turnos y feriados'),
  ('asistencia.ajustar',        'asistencia', 'cliente', 'escritura', false, 'Registrar ajustes (marcación olvidada, permisos)'),
  ('asistencia.aprobar',        'asistencia', 'cliente', 'escritura', false, 'Aprobar o rechazar ajustes'),
  -- Cliente · control de acceso
  ('acceso.eventos.ver',        'acceso', 'cliente', 'lectura',   false, 'Ver eventos de acceso en vivo'),
  ('acceso.reglas',             'acceso', 'cliente', 'escritura', false, 'Grupos, puertas y horarios de acceso'),
  ('acceso.puertas.abrir',      'acceso', 'cliente', 'escritura', true,  'Abrir puertas de forma remota'),
  -- Cliente · reportes e integraciones
  ('reportes.avanzados',        'reportes_avanzados', 'cliente', 'lectura',   false, 'Reportes consolidados y exportaciones grandes'),
  ('reportes.programados',      'reportes_avanzados', 'cliente', 'escritura', false, 'Programar envío de reportes'),
  ('integraciones.api_keys',    'integraciones',      'cliente', 'escritura', true,  'Crear y revocar llaves de API'),
  ('integraciones.webhooks',    'integraciones',      'cliente', 'escritura', false, 'Configurar webhooks'),
  -- Plataforma (jamás asignables a un cliente)
  ('plataforma.tenants.ver',                'nucleo', 'plataforma', 'lectura',   false, 'Ver empresas, plan, uso y salud'),
  ('plataforma.tenants.administrar',        'nucleo', 'plataforma', 'escritura', true,  'Crear, suspender, cancelar empresas'),
  ('plataforma.planes.administrar',         'nucleo', 'plataforma', 'escritura', true,  'Planes, módulos y límites; excepciones por empresa'),
  ('plataforma.facturacion.ver',            'nucleo', 'plataforma', 'lectura',   false, 'Estado de cuenta y facturación'),
  ('plataforma.dispositivos.ver',           'nucleo', 'plataforma', 'lectura',   false, 'Datos técnicos: IP, firmware, protocolo, logs, cola'),
  ('plataforma.dispositivos.asignar',       'nucleo', 'plataforma', 'escritura', true,  'Cuarentena global; asignar o mover equipos entre empresas'),
  ('plataforma.dispositivos.mantenimiento', 'nucleo', 'plataforma', 'escritura', true,  'Reiniciar, configurar, actualizar firmware, borrar datos'),
  ('plataforma.dispositivos.comando_crudo', 'nucleo', 'plataforma', 'escritura', true,  'Enviar comandos del protocolo sin traducir'),
  ('plataforma.soporte.sesion',             'nucleo', 'plataforma', 'lectura',   false, 'Abrir sesión de soporte de solo lectura en una empresa'),
  ('plataforma.soporte.escritura',          'nucleo', 'plataforma', 'escritura', true,  'Abrir sesión de soporte con escritura'),
  ('plataforma.auditoria.ver',              'nucleo', 'plataforma', 'lectura',   false, 'Auditoría de toda la plataforma'),
  ('plataforma.staff.administrar',          'nucleo', 'plataforma', 'escritura', true,  'Alta y baja de staff');

insert into app.limites (clave, descripcion) values
  ('sucursales',      'Sucursales'),
  ('dispositivos',    'Equipos activos'),
  ('empleados',       'Empleados activos'),
  ('usuarios',        'Usuarios del panel'),
  ('retencion_meses', 'Meses de marcaciones en línea'),
  ('api_llamadas_dia','Llamadas a la API por día');

insert into app.planes (codigo, nombre) values ('basico', 'Básico'), ('profesional', 'Profesional'), ('empresarial', 'Empresarial');

insert into app.plan_modulos (plan_id, modulo)
select p.id, m from app.planes p, unnest(case p.codigo
  when 'basico'      then array['nucleo', 'asistencia']
  when 'profesional' then array['nucleo', 'asistencia', 'acceso', 'reportes_avanzados']
  else                    array['nucleo', 'asistencia', 'acceso', 'reportes_avanzados', 'integraciones'] end) m;

-- Sin fila = ilimitado
insert into app.plan_limites (plan_id, clave, valor)
select p.id, l.clave, l.valor from app.planes p
join (values
  ('basico', 'sucursales', 2), ('basico', 'dispositivos', 3), ('basico', 'empleados', 100),
  ('basico', 'usuarios', 3),   ('basico', 'retencion_meses', 12),
  ('profesional', 'sucursales', 10), ('profesional', 'dispositivos', 25), ('profesional', 'empleados', 1000),
  ('profesional', 'usuarios', 15),   ('profesional', 'retencion_meses', 24),
  ('empresarial', 'retencion_meses', 60), ('empresarial', 'api_llamadas_dia', 100000)
) l(plan, clave, valor) on l.plan = p.codigo;

-- Plantillas de rol del cliente (tenant_id null). El cliente puede crear las suyas a partir de estas.
insert into app.roles (codigo, nombre, descripcion) values
  ('propietario',   'Propietario',            'Todo lo que incluye el plan, más la cuenta'),
  ('administrador', 'Administrador',          'Todo lo que incluye el plan, excepto la cuenta'),
  ('rrhh',          'Recursos humanos',       'Empleados, marcaciones, asistencia y reportes'),
  ('supervisor',    'Supervisor de sucursal', 'Se asigna por sucursal: ve y aprueba lo de su sucursal'),
  ('recepcion',     'Recepción / seguridad',  'Eventos de acceso en vivo y apertura de puertas'),
  ('lectura',       'Solo lectura',           'Consulta y auditoría, sin cambios');

insert into app.rol_permisos (rol_id, permiso)
select r.id, p.codigo from app.roles r join app.permisos p on p.ambito = 'cliente'
 where r.tenant_id is null and (
      r.codigo = 'propietario'
   or (r.codigo = 'administrador' and p.codigo <> 'cuenta.administrar')
   or (r.codigo = 'rrhh' and p.codigo in ('sucursales.ver', 'dispositivos.ver', 'dispositivos.bandeja',
        'empleados.ver', 'empleados.editar', 'empleados.credenciales', 'empleados.eliminar',
        'marcaciones.ver', 'marcaciones.exportar', 'asistencia.ver', 'asistencia.horarios',
        'asistencia.ajustar', 'asistencia.aprobar', 'reportes.avanzados'))
   or (r.codigo = 'supervisor' and p.codigo in ('sucursales.ver', 'dispositivos.ver', 'empleados.ver',
        'marcaciones.ver', 'asistencia.ver', 'asistencia.ajustar', 'asistencia.aprobar'))
   or (r.codigo = 'recepcion' and p.codigo in ('sucursales.ver', 'dispositivos.ver', 'empleados.ver',
        'acceso.eventos.ver', 'acceso.puertas.abrir'))
   or (r.codigo = 'lectura' and p.tipo = 'lectura'));

-- Roles del staff de plataforma
insert into app.staff_rol_permisos (rol, permiso)
select 'superadmin'::app.rol_plataforma, codigo from app.permisos where ambito = 'plataforma'
union all
select 'soporte'::app.rol_plataforma, unnest(array['plataforma.tenants.ver', 'plataforma.dispositivos.ver', 'plataforma.dispositivos.asignar',
                               'plataforma.dispositivos.mantenimiento', 'plataforma.soporte.sesion', 'plataforma.soporte.escritura'])
union all
select 'finanzas'::app.rol_plataforma, unnest(array['plataforma.tenants.ver', 'plataforma.planes.administrar', 'plataforma.facturacion.ver']);

-- Acciones canónicas de equipo → permiso requerido. El adaptador de cada marca las traduce.
insert into app.acciones_dispositivo (codigo, permiso, ttl, descripcion) values
  ('usuario.upsert',        'empleados.editar',                       null,               'Crear o actualizar el usuario en el equipo'),
  ('usuario.borrar',        'empleados.editar',                       null,               'Borrar el usuario del equipo'),
  ('pin.cambiar',           'empleados.editar',                       interval '15 min',  'Paso interno de la saga de cambio de PIN'),
  ('usuarios.leer',         'dispositivos.operar',                    interval '10 min',  'Leer usuarios y biometría registrados en el equipo'),
  ('marcaciones.recuperar', 'dispositivos.operar',                    interval '1 hour',  'Pedir al equipo las marcaciones de un rango'),
  ('hora.sincronizar',      'dispositivos.operar',                    interval '10 min',  'Poner el equipo en hora'),
  ('puerta.abrir',          'acceso.puertas.abrir',                   interval '15 sec',  'Abrir una puerta (caduca si el equipo no responde)'),
  ('dispositivo.reiniciar', 'plataforma.dispositivos.mantenimiento',  interval '10 min',  'Reiniciar el equipo'),
  ('dispositivo.configurar','plataforma.dispositivos.mantenimiento',  null,               'Opciones del protocolo (intervalos, zona horaria, flags)'),
  ('firmware.actualizar',   'plataforma.dispositivos.mantenimiento',  null,               'Actualizar firmware'),
  ('dispositivo.borrar_datos','plataforma.dispositivos.mantenimiento', interval '10 min', 'Borrar usuarios o registros del equipo'),
  ('comando.crudo',         'plataforma.dispositivos.comando_crudo',  interval '10 min',  'Comando del protocolo sin traducir');
