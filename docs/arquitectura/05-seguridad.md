# 05 · Seguridad

## 1. Hallazgos en el código actual

Revisión de [server.js](../../server.js) al commit `6ad61a4`. Ordenados por gravedad **para un SaaS expuesto a internet**. En una LAN cerrada varios bajan de nivel.

| # | Gravedad | Dónde | Qué pasa | Corrección |
|---|---|---|---|---|
| 1 | **Crítica** | [server.js:239-255](../../server.js#L239-L255), [:475-490](../../server.js#L475-L490), [:441-461](../../server.js#L441-L461) | **Suplantación de equipo por SN.** Quien conozca un SN recibe los comandos pendientes de ese reloj (PIN, nombre, tarjeta, clave y, en el cambio de PIN, plantillas biométricas). También puede inyectar marcaciones falsas. Además, cualquier SN inventado crea una fila nueva: se puede inundar la tabla. | Subdominio por empresa + cuarentena sin comandos + anomalías + rate limit ([03 §3.1](03-dispositivos-zkteco-dahua.md)) |
| 2 | **Alta** | [server.js:56-59](../../server.js#L56-L59), [:312-319](../../server.js#L312-L319) | **Plantillas biométricas guardadas en claro y para siempre** (`plantillas.linea`). Contradice la decisión "cada equipo enrola" y es el dato más sensible del sistema. | Purgar. Tabla temporal cifrada con TTL solo para la saga de cambio de PIN. |
| 3 | **Alta** | [server.js:785-804](../../server.js#L785-L804) (`e.*`), [:724-743](../../server.js#L724-L743) | **Clave del reloj y tarjeta en claro**, devueltas por la API y exportadas a Excel | Cifrado en la app (AES-256-GCM) + permisos de columna. La UI muestra `****1234` y "tiene clave". |
| 4 | **Alta** | [server.js:966-973](../../server.js#L966-L973), [:548-554](../../server.js#L548-L554) | **Superusuario y admin del cliente son el mismo rol.** Cualquier `admin` creado desde el panel ve y modifica todas las empresas. | Dos planos, staff separado ([02](02-tenancy-roles-permisos.md)) |
| 5 | **Media** | [server.js:681-697](../../server.js#L681-L697) | **Reclamar un equipo ajeno.** Un usuario de cualquier empresa que escriba el SN de un equipo aún sin asignar se lo queda. | Solo se acepta lo que llegó por el subdominio propio, o la plataforma lo asigna |
| 6 | **Media** | [server.js:542-554](../../server.js#L542-L554) y cada endpoint | **Aislamiento solo en código** (`checkEmpresa`). No encontré un endpoint roto, pero un olvido futuro = fuga entre empresas. | RLS + FKs compuestas como red de seguridad |
| 7 | **Media** | [server.js:534-540](../../server.js#L534-L540), [:110-121](../../server.js#L110-L121) | **Login sin límite de intentos ni MFA.** Token propio de 12 h, sin revocación. Clave mínima de 6. | Supabase Auth: rate limit, MFA, token de 15 min, refresh rotativo. Mínimo 10 caracteres + lista de claves filtradas. |
| 8 | **Media** | [server.js:614-618](../../server.js#L614-L618), [:66](../../server.js#L66) | **Borrado en cascada inmediato** de una empresa. Borrar un equipo deja marcaciones huérfanas e invisibles. | Baja programada con exportación; equipos `retirado` |
| 9 | **Media** | todo el esquema | **IDs secuenciales** enumerables (`SERIAL`) | UUIDv7 |
| 10 | **Baja** | [server.js:560](../../server.js#L560), [:95](../../server.js#L95) | `/api/me` informa a *cualquier* usuario si el servidor está desactualizado. La clave del admin inicial se imprime en el log. | Información de sistema solo en la consola. Sin secretos en logs. |
| 11 | **Baja** | [server.js:427](../../server.js#L427), [:426](../../server.js#L426) | Cuerpo de hasta 20 MB sin autenticar en `/iclock`. `trust proxy` desactivado: detrás de Traefik, todas las IP se verán como la del proxy. | Límite por tabla; `trust proxy` apuntando solo al proxy |
| 12 | **Baja** | [server.js:15-17](../../server.js#L15-L17) | Secreto de tokens en un archivo junto al código | Secretos por `docker secret` o gestor, con rotación |

Los arreglos 1–5 son la **fase 0** del [plan de migración](07-plan-de-migracion.md): se pueden hacer sobre el código actual antes de sumar clientes.

## 2. Modelo de amenazas

| Actor | Objetivo | Controles principales |
|---|---|---|
| Atacante en internet | Datos de empleados, marcaciones falsas, caída del servicio | Identidad de equipos por capas, WAF y rate limit, RLS, nada técnico expuesto, backups probados |
| Usuario malicioso de un cliente | Ver otra empresa; darse más permisos | RLS + FKs compuestas; anti-escalada en triggers; auditoría |
| Empleado desleal del cliente | Exportar datos masivamente; abrir puertas | Permisos granulares; exportaciones auditadas y limitadas; `puerta.abrir` sensible (MFA) y auditada |
| Equipo o agente comprometido | Pivotar a otras empresas | El equipo solo escribe en su empresa; el agente con certificado atado a empresa y sucursal, solo acciones del catálogo |
| Staff curioso o cuenta de staff robada | Leer datos personales de clientes | Sin acceso a datos personales sin sesión de soporte; MFA; allowlist de IP; sesiones visibles al cliente |
| Token robado (XSS, malware) | Suplantar a un usuario | CSP estricta; token de 15 min; revalidación en vivo en RLS; revocación de sesiones; alertas por IP o país nuevo |
| Dependencia comprometida (supply chain) | Código malicioso en build | Lockfile, `pnpm audit` o Renovate, imágenes fijadas por digest, builds reproducibles, agente firmado |

## 3. Controles por capa

**Identidad y sesión**
- Supabase Auth. MFA TOTP **obligatorio para todo el staff** y para permisos sensibles del cliente. La empresa puede exigirlo a todos sus usuarios (`mfa_obligatorio`).
- Token de 15 min, refresh rotativo con detección de reutilización, "cerrar todas las sesiones".
- **Step-up**: acciones destructivas (borrar empleados en masa, eliminar sucursal, transferir propiedad) piden la clave o el código MFA otra vez.

**API**
- Validación Zod en toda entrada. DTO de salida por audiencia: el serializador del cliente **no conoce** los campos técnicos.
- Rate limit por IP, por usuario, por empresa y por API key (Redis).
- CORS cerrado a los orígenes propios. CSP estricta, HSTS con preload, `X-Content-Type-Options`, `frame-ancestors 'none'`.
- Errores en formato `problem+json`, sin trazas ni SQL. `request_id` en cada respuesta y en cada log.
- `Idempotency-Key` en los POST que encolan comandos.

**Base de datos**
- RLS en todas las tablas de `app`. Ningún servicio que atienda personas usa `BYPASSRLS`.
- Permisos de columna para lo técnico y lo cifrado. FKs compuestas por empresa.
- Funciones `SECURITY DEFINER` siempre con `set search_path = ''` y `EXECUTE` revocado a `public`.
- Auditoría append-only: triggers que la bloquean incluso para el superusuario de la BD.

**Datos sensibles**
- **Tarjeta y clave del equipo:** AES-256-GCM en la aplicación, con una clave de datos por empresa (DEK) cifrada por una clave maestra (KEK) que vive fuera de la BD (secreto del contenedor; más adelante un KMS). La tarjeta lleva además un HMAC para buscar sin descifrar.
- **Biometría:** no se almacena.
- **Documento de identidad y teléfono:** se muestran completos solo con `empleados.ver`; en exportaciones, según permiso.
- **Logs sin datos personales:** los comandos se registran redactados y los payloads de equipos solo en debug temporal de plataforma.

**Dispositivos:** ver [03 §3.1](03-dispositivos-zkteco-dahua.md) y [§6](03-dispositivos-zkteco-dahua.md).

**Infraestructura**
- Solo 80 y 443 públicos; SSH con llave y, si se puede, detrás de VPN. Postgres, Redis y Studio nunca expuestos.
- Consola de plataforma con allowlist de IP o Cloudflare Access.
- Backups cifrados fuera del VPS, restauración probada cada mes. Objetivo: **RPO ≤ 5 min** (WAL continuo), **RTO ≤ 4 h** para empezar.
- Actualizaciones de seguridad del SO automáticas; imágenes fijadas y renovadas con PRs automáticos.

**Operación**
- Alertas: equipos caídos en masa (¿caída propia o del proveedor de internet del cliente?), lag de ingesta, errores 5xx, logins fallidos anómalos, sesiones de soporte abiertas.
- Runbooks: restaurar backup, rotar la clave maestra, revocar un agente, bloquear un SN, responder a un incidente de datos.

## 4. Antes del primer cliente que paga

- [ ] Fase 0 completa (hallazgos 1–5)
- [ ] HTTPS en todo lo que no sea un reloj sin soporte de TLS
- [ ] MFA obligatorio para tu cuenta y la de soporte
- [ ] Backups automáticos + **una restauración probada**
- [ ] Plantillas biométricas purgadas
- [ ] Contrato y política de privacidad con cláusula de datos biométricos y de acceso de soporte (revisados por un abogado)
- [ ] Monitoreo externo (Uptime Kuma) + alertas a tu teléfono
- [ ] Pruebas SQL de permisos corriendo en CI
