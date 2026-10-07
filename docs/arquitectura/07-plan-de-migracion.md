# 07 · Plan de migración desde el código actual

Principio: **no se rompe lo que funciona.** La lógica ADMS de [server.js](../../server.js) (cola, bandeja, saga de cambio de PIN) es valiosa y se *porta*, no se reescribe desde cero. Cada fase es desplegable por sí sola.

## Fase 0 · Endurecer lo actual (antes de sumar clientes)

Cambios pequeños sobre el `server.js` actual que cierran los hallazgos 1–5 de [05](05-seguridad.md):

| Cambio | Dónde |
|---|---|
| **Cuarentena real:** un SN desconocido no se asigna solo, no recibe comandos, y sus eventos quedan aparte | `touchDevice()` y `GET /iclock/getrequest`: si `empresa_id` es nulo → responder `OK` sin comandos |
| **Host por empresa:** columna `slug_equipos` en `empresas`; `touchDevice` compara `req.hostname` con el slug de la empresa del equipo | `touchDevice()` |
| **Reclamar equipos:** `POST /api/dispositivos` con un SN ya detectado solo si llegó por el host de esa empresa; si no, lo asigna el superusuario | [server.js:681-697](../../server.js#L681-L697) |
| **Plantillas:** borrar las filas existentes de `plantillas`. Al terminar (o cancelar) un cambio de PIN, borrar las de ese PIN. Job cada 15 min que borre lo que tenga `visto` > 15 min. | `guardarPlantilla()`, `copiarAlPinNuevo()`, `cancelarCambioPin()` |
| **Secretos fuera de las respuestas:** quitar `password` de `GET /api/empleados` y de la bandeja y su Excel; enmascarar la tarjeta | [server.js:791](../../server.js#L791), [:726-735](../../server.js#L726-L735) |
| **Separar roles:** nuevo rol `superadmin` (solo tú, creado por config). `admin` pasa a "admin de su empresa". `POST /api/usuarios-sistema` ya no puede crear roles globales. | [server.js:966-973](../../server.js#L966-L973), `isAdmin()` |
| **Login:** límite de intentos por IP y correo (en memoria alcanza por ahora); clave mínima de 10 | [server.js:534-540](../../server.js#L534-L540) |
| **Operación:** HTTPS delante (Traefik o Caddy), backup diario con `pg_dump` fuera del servidor, `desactualizado` solo para superadmin | — |

## Fase 1 · Fundaciones

1. Monorepo TypeScript ([01 §4](01-plataforma-infraestructura.md)). Supabase self-hosted en Docker, en tu VPS, con Postgres dedicado.
2. Migraciones `001`–`003` (las de [sql/](sql/)) en `supabase/migrations`, con las pruebas SQL en CI.
3. Supabase Auth + hook + MFA. Superusuario creado por script, nunca desde un panel.
4. `apps/gateway`: **portar** el adaptador ZKTeco desde `server.js` (parseo de ATTLOG/RTLOG/USER/BIODATA, `cmdAlta`, `cmdBaja`, la saga de PIN), sobre el modelo canónico, con presencia en Redis e ingesta por lotes.
5. `apps/api` (`/v1`) con los módulos del núcleo: sucursales, equipos, empleados, marcaciones, usuarios y roles.
6. `apps/web` (panel del cliente) y `apps/consola` (plataforma): pantallas equivalentes a las de hoy, más usuarios y roles, "Mi plan", sesiones de soporte.
7. **Migración de datos** (script único e idempotente, ver abajo) y corte: cambiar el DNS del servidor ADMS de cada reloj al subdominio de su empresa.

**Migración de datos:**

| Hoy | Nuevo | Nota |
|---|---|---|
| `empresas` | `tenants` (+ plan, `slug_equipos`) | Todas empiezan en un plan definido por ti |
| `sucursales` | `sucursales` | Zona IANA `America/La_Paz` |
| `usuarios_sistema` rol `admin` | `auth.users` + `staff_plataforma` (`superadmin`) | Solo tu cuenta. Revisa si hay otros `admin`: probablemente son de clientes. |
| `usuarios_sistema` rol `empresa` | `auth.users` + `membresias` + rol **Propietario** | Sus hashes scrypt no son compatibles con GoTrue: se les envía un enlace para crear clave, o se implementa verificación de scrypt en el primer login |
| `dispositivos` | `dispositivos` (`marca = 'zkteco'`, `transporte = 'zk_adms'`) | Los que no tienen empresa → cuarentena global |
| `empleados` | `empleados` (`codigo` = `pin_dispositivo` = pin actual) | `password` y `tarjeta` → cifradas; `pines_anteriores` → `empleado_pines` |
| `empleado_dispositivo` | `empleado_dispositivo` | `rostro` → `tiene_rostro`, `huella` → `huellas` |
| `usuarios_reloj` | `usuarios_dispositivo` | Clave y tarjeta cifradas |
| `marcaciones` | `marcaciones` (particionada) | `fecha` → `hora_local`; `ocurrido_en` con la zona de la sucursal; `empleado_id` resuelto con `pin` + `pines_anteriores` |
| `comandos` | `comandos` (solo los pendientes y los últimos 30 días) | `comando` crudo → `accion` canónica + `comando_vendor` redactado |
| `plantillas` | **No se migra** | Se purga |

## Fase 2 · Producto

Asistencia (horarios, jornadas, ajustes y aprobaciones), reportes asíncronos, Realtime, auditoría visible para el cliente, planes y cuotas en la UI, API keys y webhooks, alertas de equipo caído.

## Fase 3 · Dahua y control de acceso

Agente local en Go (enrolamiento, mTLS, buffer, auto-actualización), adaptador Dahua, puertas, grupos y horarios de acceso, apertura remota, eventos de acceso en vivo. **Antes de programar**, consigue 2 o 3 equipos Dahua de los modelos que venderás y valida sus endpoints y firmware ([03 §5](03-dispositivos-zkteco-dahua.md)).

## Fase 4 · Escala

Cuando lo pidan las señales de [01 §2](01-plataforma-infraestructura.md): Postgres dedicado o Supabase Cloud con PITR y réplica, gateway y API ×2+, Redis Stream en la ingesta, archivo de particiones a Parquet, observabilidad completa con SLOs.

## Riesgos y cómo cubrirlos

| Riesgo | Mitigación |
|---|---|
| Relojes que no aceptan nombre de dominio en el servidor ADMS | Inventario de modelos y firmware en la fase 0. Para esos: lista blanca por SN + IP, o agente local. |
| El corte de DNS deja relojes sin conexión | Durante la transición, el gateway nuevo acepta también el host viejo (con SN en lista blanca). El reloj conserva las marcaciones y reenvía las no confirmadas al reconectar; además, `marcaciones.recuperar` permite pedirlas por rango. |
| Diferencias de zona horaria al migrar marcaciones | Validar con una muestra por sucursal: mismo conteo por día antes y después |
| Clientes sin clave tras migrar (hash distinto) | Verificación de scrypt en el primer login, o enlace de activación con aviso previo |
| Sobre-ingeniería para el tamaño actual | Las fases 2–4 se activan por necesidad. La fase 1 ya da multi-tenancy seguro. |
