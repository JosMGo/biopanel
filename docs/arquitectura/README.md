# Arquitectura · SaaS de biometría y control de acceso

Diseño para llevar BioPanel/SenseFace de un servidor único a un SaaS multi-empresa listo para producción: cientos o miles de empresas, miles de equipos ZKTeco y Dahua, millones de marcaciones.

## Decisiones

| Tema | Decisión |
|---|---|
| Modelo comercial | Venta directa: **Plataforma → Empresa → Sucursal** (sin distribuidores) |
| Superusuario vs. admin del cliente | **Dos planos separados**: staff de plataforma (cuentas, consola, API y rol de BD propios) y usuarios del cliente. El staff solo ve datos de un cliente mediante una **sesión de soporte** temporal, con motivo y auditada. → [02](02-tenancy-roles-permisos.md) |
| Qué ve el cliente | Permiso efectivo = **catálogo ∩ plan (módulos + excepciones) ∩ roles ∩ sucursales**. Lo técnico queda fuera de su alcance incluso a nivel de columna. → [02 §4](02-tenancy-roles-permisos.md) |
| Control del superusuario | Módulos por plan, límites/cuotas, funciones técnicas ocultas, roles personalizados del cliente dentro de su plan |
| Base de datos y plataforma | **Supabase self-hosted en tu VPS (Docker)** como Postgres + Auth + Realtime + Storage, con Postgres dedicado. Relojes y reglas de negocio en servicios propios. Salida a Supabase Cloud o Postgres dedicado cuando lo pidan las métricas. → [01](01-plataforma-infraestructura.md) |
| Aislamiento | Base compartida, `tenant_id` en todo, **RLS + FKs compuestas + triggers** como red de seguridad bajo la API |
| Multimarca | Modelo canónico de acciones y eventos + adaptador por marca. ZKTeco por ADMS (ya funciona). Dahua por **agente local** en la sucursal. → [03](03-dispositivos-zkteco-dahua.md) |
| Biometría | **No se almacena en la nube**: cada equipo enrola. Solo indicadores. → [03 §4](03-dispositivos-zkteco-dahua.md) |
| Marcaciones | Particionadas por mes, inmutables, idempotentes, con el empleado resuelto al ingresar. Correcciones por ajustes aprobados. → [04](04-datos-asistencia-reportes.md) |
| Stack | TypeScript (Fastify, Kysely, Zod, BullMQ), React + Vite, agente en Go, Traefik, Redis, Grafana/Loki |

## Documentos

| # | Documento | Contenido |
|---|---|---|
| 01 | [Plataforma e infraestructura](01-plataforma-infraestructura.md) | Veredicto sobre Supabase, componentes, stack, capacidad, despliegue en el VPS, ruta de escala |
| 02 | [Multi-tenancy, roles y permisos](02-tenancy-roles-permisos.md) | Superusuario vs. admin, planes, módulos, cuotas, roles, soporte, RLS, pruebas |
| 03 | [Dispositivos: ZKTeco, Dahua y agentes](03-dispositivos-zkteco-dahua.md) | Adaptadores, transportes, identidad de equipos, comandos y sagas, biometría, agente local |
| 04 | [Datos, asistencia, acceso y reportes](04-datos-asistencia-reportes.md) | Convenciones, marcaciones a escala, motor de asistencia, control de acceso, exportaciones, tiempo real |
| 05 | [Seguridad](05-seguridad.md) | **12 hallazgos del código actual**, modelo de amenazas, controles, checklist previo al lanzamiento |
| 06 | [API y frontend](06-api-frontend.md) | Superficies, convenciones, API keys, webhooks, endpoints, flujo completo, apps de cliente y consola |
| 07 | [Plan de migración](07-plan-de-migracion.md) | Fase 0 (endurecer lo actual) → fase 4 (escala), migración de datos, riesgos |
| — | [sql/](sql/) | Esquema de referencia **probado** (65 verificaciones en PostgreSQL 17) |

## SQL de referencia

| Archivo | Contenido |
|---|---|
| [001_nucleo_permisos.sql](sql/001_nucleo_permisos.sql) | Tenants, planes, módulos, límites, staff, roles, membresías, sesiones de soporte, funciones de autorización, hook del token, triggers anti-escalada y de cuotas, RLS |
| [002_operacion.sql](sql/002_operacion.sql) | Agentes, dispositivos (columnas técnicas ocultas), acciones canónicas, comandos, empleados (credenciales cifradas), bandeja, marcaciones y auditoría particionadas, RLS por rol |
| [003_catalogo.sql](sql/003_catalogo.sql) | Módulos, 40 permisos, 3 planes de ejemplo, 6 plantillas de rol, roles del staff, 12 acciones de equipo |
| [pruebas/](sql/pruebas/) | Stub mínimo de Supabase para correr en un PostgreSQL vacío + batería de pruebas que intenta romper cada regla |

Se aplican con la Supabase CLI como migraciones (sin el stub). Cómo correr las pruebas: [02 §11](02-tenancy-roles-permisos.md).

## Glosario

- **Tenant / empresa:** cliente que paga. Todo dato de cliente lleva su `tenant_id`.
- **Staff / plataforma:** tú y tu equipo (superadmin, soporte, finanzas).
- **Membresía:** vínculo usuario ↔ empresa. Los roles se asignan a la membresía, opcionalmente limitados a una sucursal.
- **Módulo:** bloque funcional que se vende por plan (asistencia, acceso…).
- **Excepción:** módulo o límite que el superusuario cambia para una empresa, con motivo y vencimiento.
- **Sesión de soporte:** acceso temporal y auditado del staff a los datos de una empresa.
- **Acción canónica:** orden independiente de la marca (`usuario.upsert`, `puerta.abrir`) que un adaptador traduce al protocolo del equipo.
- **Cuarentena:** estado de un equipo que se conectó pero aún no fue aceptado: no recibe comandos.
- **Agente local:** servicio instalado en la sucursal que habla con los equipos de la LAN y con la nube por un canal cifrado saliente.
