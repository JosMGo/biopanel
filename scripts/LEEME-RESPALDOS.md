# Respaldos de BioPanel

Guía para manejar las copias de seguridad de la base de datos: qué se guarda, dónde, los comandos y qué hacer si hay que recuperar datos.

## En pocas palabras
- **Todos los días a las 23:30** Windows hace una copia completa de la base, la cifra y la deja en `OneDrive\Respaldos BioPanel`. Desde ahí OneDrive la sube a la nube.
- **Cada copia se comprueba** antes de darla por buena: se descifra y se verifica que PostgreSQL pueda leerla entera.
- **Lo viejo se borra solo**: quedan los últimos 14 días, una copia por semana de las últimas 8 semanas y el cierre de cada mes de los últimos 24 meses.
- **Para abrir una copia hace falta la clave de cifrado.** Está en tu PC, fuera de OneDrive. Guárdala también en otro lado (ver más abajo).

## ⚠ Lo más importante: la clave
- Está en `C:\Users\<tu usuario>\.biopanel\respaldo.key`.
- **Sin ella, los respaldos no se pueden abrir.** Ni tú ni nadie.
- Está fuera de OneDrive a propósito: si alguien entra a tu OneDrive, ve los respaldos pero no los puede abrir.
- **Guarda una copia del archivo en un USB o en un gestor de contraseñas.** Si la PC se daña y la clave solo estaba ahí, los respaldos de OneDrive quedan inservibles.
- No la subas a GitHub, no la mandes por correo ni la guardes en la misma carpeta de los respaldos.
- Si alguna vez la cambias, los respaldos anteriores solo se abren con la clave anterior. Guarda las dos.

## Dónde está cada cosa
| Qué | Dónde |
|---|---|
| Script que hace el respaldo | `scripts\respaldo.js` (en la carpeta del proyecto) |
| Script que restaura | `scripts\restaurar.js` |
| Copias | `C:\Users\<tu usuario>\OneDrive\Respaldos BioPanel\` |
| Registro de cada respaldo | `respaldos.log`, en esa misma carpeta |
| Clave de cifrado | `C:\Users\<tu usuario>\.biopanel\respaldo.key` |
| Tarea automática | Programador de tareas de Windows → **"BioPanel - respaldo diario"** |

Los nombres de las copias llevan la fecha y la hora (de Bolivia): `biopanel_2026-10-09_2330.dump.enc`.

## Qué se guarda y cuánto tiempo
| Copias | Cuánto tiempo |
|---|---|
| La última de cada día | 14 días |
| La última de cada semana (de lunes a domingo) | 8 semanas |
| La última de cada mes (el "cierre" del mes) | 24 meses |

- Si haces varias copias el mismo día, queda la más reciente.
- La copia guarda **toda** la base: empresas, sucursales, relojes, empleados, marcaciones, turnos, horarios, feriados y usuarios (sus contraseñas van cifradas, nunca en texto). Por eso la copia tiene datos personales y siempre va cifrada.

## Comandos
Todos se escriben en **PowerShell, dentro de la carpeta del proyecto**:
```powershell
cd C:\Users\malva\OneDrive\Desktop\SenseFace
```

### Hacer un respaldo ahora (por ejemplo, antes de actualizar el panel)
```powershell
node scripts/respaldo.js
```
Al terminar muestra una línea como `OK biopanel_2026-10-09_1757.dump.enc | 59 KB | 17 tablas`. Si dice `ERROR`, mira "Problemas frecuentes" más abajo.

### Probar que los respaldos sirven (hazlo una vez al mes)
```powershell
node scripts/restaurar.js --probar
```
Restaura el respaldo más reciente en una base aparte (`senseface_prueba_restauracion`), muestra cuántas empresas, empleados y marcaciones tiene, y la borra. Compara esos números con lo que ves en el panel. Para probar una copia en particular:
```powershell
node scripts/restaurar.js "C:\Users\malva\OneDrive\Respaldos BioPanel\biopanel_2026-10-01_2330.dump.enc" --probar
```

### Ver las copias que hay
```powershell
Get-ChildItem "$env:USERPROFILE\OneDrive\Respaldos BioPanel\*.dump.enc" | Sort-Object Name -Descending | Select-Object Name, Length, LastWriteTime
```

### Ver el registro (cómo salieron los últimos respaldos)
```powershell
Get-Content "$env:USERPROFILE\OneDrive\Respaldos BioPanel\respaldos.log" -Encoding UTF8 -Tail 20
```
También se puede abrir `respaldos.log` con el Bloc de notas.

### Restaurar una copia en una base nueva
```powershell
node scripts/restaurar.js                                   # el respaldo más reciente
node scripts/restaurar.js "<ruta del archivo .dump.enc>"     # uno en particular
node scripts/restaurar.js "<ruta del archivo .dump.enc>" mi_base   # con el nombre de base que elijas
```
- Crea una base **nueva**, por defecto `senseface_restaurada_<fecha>`.
- **Nunca restaura encima de la base que está en uso**: si le pides el nombre de esa base, se niega.
- Si la base nueva ya existe, también se niega: elige otro nombre o borra la anterior.

## La tarea automática
Comandos de PowerShell (no hace falta estar en la carpeta del proyecto):
```powershell
# Ver su estado, la última vez que corrió (resultado 0 = bien) y la próxima
Get-ScheduledTaskInfo -TaskName 'BioPanel - respaldo diario' | Select-Object LastRunTime, LastTaskResult, NextRunTime

# Ejecutarla ahora
Start-ScheduledTask -TaskName 'BioPanel - respaldo diario'

# Cambiar la hora (por ejemplo, a las 22:00)
Set-ScheduledTask -TaskName 'BioPanel - respaldo diario' -Trigger (New-ScheduledTaskTrigger -Daily -At '22:00')

# Pausarla y volver a activarla
Disable-ScheduledTask -TaskName 'BioPanel - respaldo diario'
Enable-ScheduledTask  -TaskName 'BioPanel - respaldo diario'

# Eliminarla
Unregister-ScheduledTask -TaskName 'BioPanel - respaldo diario' -Confirm:$false
```
También se ve y se edita desde **Programador de tareas** (búscalo en el menú Inicio) → Biblioteca del Programador de tareas → "BioPanel - respaldo diario".

**Cómo se comporta:**
- Si a las 23:30 la PC estaba apagada, el respaldo se hace apenas se enciende.
- Corre con tu sesión de Windows: si la sesión está cerrada, se hace cuando vuelvas a entrar.

### Volver a crear la tarea (por ejemplo, en otra PC)
```powershell
$accion  = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument '"C:\Users\malva\OneDrive\Desktop\SenseFace\scripts\respaldo.js"' -WorkingDirectory 'C:\Users\malva\OneDrive\Desktop\SenseFace'
$cuando  = New-ScheduledTaskTrigger -Daily -At '23:30'
$ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'BioPanel - respaldo diario' -Action $accion -Trigger $cuando -Settings $ajustes -Description 'Copia cifrada diaria de la base de BioPanel'
```
Cambia las rutas si el proyecto está en otra carpeta.

## Recuperar datos: qué hacer en cada caso

### 1. Se borró o se cambió algo por error (la base funciona)
1. Restaura en una base nueva la copia del día **anterior** al error:
   ```powershell
   node scripts/restaurar.js "C:\Users\malva\OneDrive\Respaldos BioPanel\biopanel_2026-10-08_2330.dump.enc"
   ```
2. Esa base queda al lado de la que está en uso, sin tocarla. Desde ahí se pueden mirar o copiar los datos que se perdieron (por ejemplo, un empleado borrado). Si no sabes cómo hacerlo, pide ayuda antes de tocar la base en uso.

### 2. La base se dañó o se perdió: volver entera a una copia
1. **Detén el servidor** (Ctrl+C en su ventana).
2. Restaura la última copia buena en una base nueva:
   ```powershell
   node scripts/restaurar.js
   ```
   Anota el nombre que te muestra, por ejemplo `senseface_restaurada_20261009_2330`.
3. Elige **una** de estas dos formas:
   - **A. Cambiar la configuración:** en `config.js` cambia el final de `DATABASE_URL` por el nombre de la base nueva (`.../senseface_restaurada_20261009_2330`).
   - **B. Cambiar los nombres de las bases**, para que la restaurada pase a llamarse `senseface`:
     ```powershell
     & "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d postgres -c "ALTER DATABASE senseface RENAME TO senseface_danada;"
     & "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d postgres -c "ALTER DATABASE senseface_restaurada_20261009_2330 RENAME TO senseface;"
     ```
     Te pedirá la clave de PostgreSQL. Así no hay que tocar `config.js`. Guarda `senseface_danada` hasta estar seguro de que todo está bien; después se puede borrar.
4. Arranca el servidor (`node server.js`) y revisa el panel.
5. **Recupera las marcaciones de las horas posteriores a la copia**: en el panel, Dispositivos → **"Traer marcaciones"** en cada reloj. Los relojes guardan su propio registro, y el panel descarga lo que falte sin duplicar nada.

### 3. La PC se dañó: empezar en una PC nueva
1. Instala PostgreSQL (la misma versión o una más nueva) y Node.js.
2. Copia el proyecto (desde GitHub o desde tu OneDrive) y crea su `config.js` con la clave de PostgreSQL de esa PC.
3. Pon la clave de cifrado en `C:\Users\<usuario>\.biopanel\respaldo.key` (copiándola desde tu USB o gestor de contraseñas). O usa la variable para leerla desde el USB:
   ```powershell
   $env:RESPALDO_CLAVE = 'E:\respaldo.key'
   ```
4. Restaura la copia más reciente (OneDrive la habrá bajado sola a `OneDrive\Respaldos BioPanel`):
   ```powershell
   node scripts/restaurar.js
   ```
5. Sigue desde el paso 3 del caso 2: apunta `config.js` a esa base o renómbrala a `senseface`. Después arranca el servidor.
6. Haz "Traer marcaciones" en cada reloj y vuelve a crear la tarea automática (ver "Volver a crear la tarea").

## Revisión de cada mes (5 minutos)
- [ ] `node scripts/restaurar.js --probar` termina con "el respaldo sirve", y los números se parecen a los del panel.
- [ ] En `respaldos.log`, los últimos días dicen `OK` (ninguno `ERROR`).
- [ ] OneDrive está sincronizando: el ícono de la nube, sin errores.
- [ ] La clave sigue guardada fuera de la PC.
- [ ] Los relojes no están llenos: si su memoria de marcaciones se llena, empiezan a pisar las más viejas. Nunca borres el registro desde el menú del reloj.

## Problemas frecuentes
| En el registro o la pantalla dice… | Qué pasa | Qué hacer |
|---|---|---|
| `password authentication failed` | La clave de PostgreSQL de `config.js` no es la correcta | Revisa `DATABASE_URL` en `config.js` |
| `pg_dump` / `pg_restore` no se reconoce o no se encuentra | No encuentra las herramientas de PostgreSQL | Pon su carpeta: `$env:PG_BIN = 'C:\Program Files\PostgreSQL\17\bin'` |
| `No se pudo abrir el respaldo: la clave no es la de este respaldo…` | Clave equivocada, o el archivo se dañó | Usa la clave correcta (¿la cambiaste?) o prueba con otra copia |
| `La base … ya existe` | Ya restauraste antes con ese nombre | Usa otro nombre, o borra esa base si ya no la necesitas |
| `No hay respaldos en …` | La carpeta está vacía o no es la correcta | Revisa la carpeta, o pásale la ruta del archivo |
| La tarea no corre | La PC estaba apagada o la sesión de Windows cerrada | Corre al encender o al entrar; revisa con `Get-ScheduledTaskInfo` |
| Disco u OneDrive llenos | No hay espacio para copias nuevas | Libera espacio; las copias pesan poco (decenas o cientos de KB) |

## Cambiar dónde se guarda o qué base se respalda
Variables opcionales, antes del comando o en la configuración de la tarea:
| Variable | Para qué | Por defecto |
|---|---|---|
| `RESPALDO_DIR` | Carpeta de las copias | `OneDrive\Respaldos BioPanel` |
| `RESPALDO_CLAVE` | Archivo de la clave | `~\.biopanel\respaldo.key` |
| `DATABASE_URL` | Base que se respalda | La de `config.js` |
| `PG_BIN` | Carpeta de `pg_dump` y `pg_restore` | La de PostgreSQL instalado, o el PATH |

Por ejemplo, para guardar una copia en un disco externo:
```powershell
$env:RESPALDO_DIR = 'E:\Respaldos BioPanel'; node scripts/respaldo.js
```

## Cuando el panel pase a Docker / Coolify
- La base va como un servicio aparte en Coolify, con su volumen persistente.
- Los respaldos diarios los hace Coolify ("Scheduled Backups" de la base): horario `0 3 * * *` (todos los días a las 03:00), cantidad a conservar y destino en un almacenamiento externo tipo S3 (Backblaze, Cloudflare R2, Amazon S3).
- Los scripts de esta carpeta siguen sirviendo en Linux para restaurar o para respaldos a mano: usan las mismas variables (`DATABASE_URL`, `RESPALDO_DIR`, `RESPALDO_CLAVE`, `PG_BIN`).
- Las claves (`SESSION_SECRET`, la de la base, la de cifrado de respaldos) se guardan en un gestor de contraseñas, nunca junto a los respaldos.

## Detalles técnicos (para quien mantenga el sistema)
- **Copia:** `pg_dump --format=custom --compress=9 --no-owner --no-privileges`. Formato propio de PostgreSQL, comprimido; se restaura con `pg_restore`.
- **Cifrado:** AES-256-GCM, que además detecta si el archivo fue alterado. El archivo es `BPR1` (4 bytes) + IV (12 bytes) + datos cifrados + etiqueta de autenticación (16 bytes).
- **Clave:** 32 bytes aleatorios guardados como 64 caracteres hexadecimales. Se crea sola la primera vez si no existe.
- **Comprobación:** antes de dar una copia por buena se descifra y se ejecuta `pg_restore --list`; si no aparecen datos de tablas, se marca como error y no se guarda.
- **Escritura segura:** la copia se escribe primero como `.parcial` y recién se renombra cuando pasó la comprobación. Una copia a medias nunca reemplaza a una buena.
- **Restauración:** `pg_restore --no-owner --no-privileges --exit-on-error` sobre una base recién creada.
