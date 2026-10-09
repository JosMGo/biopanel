# BioPanel: instalación en Windows

## 1. Instalar PostgreSQL (una sola vez)
1. Descarga el instalador de https://www.postgresql.org/download/windows/ (versión 16 o 17).
2. Instálalo con las opciones por defecto. **Anota la contraseña** que pongas para el usuario `postgres`. El puerto es `5432`.
3. No hace falta crear la base de datos: BioPanel la crea sola.

## 2. Copiar los archivos
Pon esto dentro de `C:\SenseFace` (reemplaza el server.js viejo):

```
C:\SenseFace\
  config.example.js
  package.json
  server.js
  public\admin\index.html      (tu panel)
  public\clientes\index.html   (panel de las empresas cliente)
  public\comun\panel.css
  public\comun\panel.js
```

## 3. Configurar la contraseña de PostgreSQL
Copia `config.example.js` como `config.js` (este último no se sube a GitHub porque lleva tus claves). En `config.js` cambia `TU_CLAVE` por la clave de PostgreSQL y pon el correo y la clave del administrador:

```js
DATABASE_URL: 'postgres://postgres:TU_CLAVE@localhost:5432/senseface',
```

## 4. Instalar y arrancar
```powershell
cd C:\SenseFace
npm install
node server.js
```

Debe salir:
```
Base de datos creada: senseface
👤 Admin creado: admin@teracorp.bo / admin123
BioPanel escuchando en puerto 8088
```

## 5. Primer uso
Hay dos links, cada uno con su propio inicio de sesión:

| Link | Quién entra | Qué ve |
|---|---|---|
| http://localhost:8088/admin | Tú (administrador de la plataforma) | Todas las empresas, relojes con su parte técnica, accesos |
| http://localhost:8088/clientes | Las empresas cliente | Solo su empresa: resumen, sucursales, empleados, marcaciones, reportes, usuarios y "Mi empresa" |

Un acceso de empresa no puede entrar por `/admin` ni el tuyo por `/clientes`. La dirección raíz lleva a `/clientes`.

1. Abre http://localhost:8088/admin y entra con `admin@teracorp.bo` / `admin123`. Cámbiala después en "Cambiar clave".
2. **Empresas**: crea la empresa. Se crea sola la sucursal "Principal". Si quieres, crea ahí mismo el acceso de la empresa (perfil Administrador): con él, el cliente entra por `/clientes` y crea los usuarios de su gente.
3. **Sucursales**: agrega las demás sucursales.
4. **Dispositivos**: el SenseFace ya conectado aparecerá en "Equipos detectados sin asignar". Pulsa **Asignar** y elige nombre, tipo y sucursal. También puedes registrar uno nuevo escribiendo su número de serie.
5. **Usuarios del reloj** (en Dispositivos): lee los usuarios que ya existen en el equipo (PIN, nombre, tarjeta, privilegio, clave, rostro/huella) y los muestra en una bandeja. Desde ahí puedes **Descargar Excel** y **Agregar al panel** los que marques. Los usuarios que se registren después directamente en el reloj también llegan a esta bandeja como "Nuevos" (el botón muestra cuántos hay).
6. **Empleados**: crea el empleado y marca en qué equipos debe existir. Se envía solo en unos 10 segundos. El chip cambia de "Pendiente" (naranja) a "Sincronizado" (verde).
7. Registra el rostro en el equipo: Gestión de usuarios → editar → Rostro.
8. **Horarios**: crea el horario (por ejemplo, "Oficina": lunes a viernes 08:00–18:00, sábado 08:00–12:00, tolerancia 10 minutos, falta después de las 10:00) y ponlo como **horario principal** de la empresa desde una fecha. El principal se aplica solo a todo el personal de la empresa, también a los empleados nuevos. Si la empresa cambia de horario, pulsa "Cambiar" y elige desde cuándo: los días anteriores no se alteran.
   - **Excepciones**: en **Empleados**, marca a quien trabaja distinto y pulsa **Horario propio**. Puedes darle otro horario, dejarlo "sin control de horario" (por ejemplo, gerencia) o devolverlo al de la empresa.
   - En la misma pantalla de Horarios se cargan los **feriados**: los nacionales los cargas tú desde `/admin`, y cada empresa puede agregar los suyos.
9. **Reportes → Por empleados**: filtra por sucursal, nombre/PIN/CI o departamento. Con un clic en una persona ves su **hoja de asistencia**. "Imprimir hojas" saca una hoja horizontal por cada persona de la lista, y "Hojas en Excel" genera un Excel con una pestaña por persona.
10. **Por empleados, Por sucursal y Por fecha** muestran sus tablas con el aspecto del Excel (encabezado azul oscuro y celdas con borde). Debajo de cada uno va la **tabla de marcaciones** del mismo filtro, que el Excel trae también como pestaña "Marcaciones". La hoja de asistencia de una persona también lleva sus marcaciones.
11. **Reportes → Detalle de marcaciones**: una fila por marcación, ordenada por persona, fecha y hora. Muestra ID, nombre, CI, departamento, cargo, fecha, día, sucursal, equipo, hora, estado (entrada, salida, descanso) y método (rostro, huella, tarjeta o clave). Se imprime en horizontal y se descarga en Excel. El botón "Descargar Excel" de la pantalla **Marcaciones** baja este mismo Excel.
    - El reloj no envía si cada marcación es entrada o salida: el panel lo deduce con la misma regla de las horas (ver abajo). Las marcaciones a menos de 2 minutos de la anterior salen como "repetida".
    - La columna **Retraso** muestra el retraso del día en la fila de la entrada. Si la persona llegó después del límite, dice "Falta".
    - Con la casilla **Una hoja por persona**, cada persona sale en su hoja: una página horizontal al imprimir y una pestaña en el Excel. Al pie de cada hoja van el total de retraso y las faltas del período. También salen quienes no marcaron, con sus faltas.

**Cómo se calcula con el horario:**
- **Entrada y salida**: la primera marcación del día es la entrada y la última la salida. Con 4 o más, la 2.ª y la 3.ª son la salida y el regreso del descanso, que se descuenta de las horas. Con 3, la del medio no se usa. Una marcación a menos de 2 minutos de la anterior es repetida y cuenta como una.
- **Retraso**: si llega después de la entrada más la tolerancia, se cuentan los minutos desde la hora de entrada. Por ejemplo, con entrada 08:00 y tolerancia de 10 minutos: llegar a las 08:08 no cuenta retraso, y llegar a las 08:15 cuenta 0:15.
- **Falta**: llegar después de la hora de falta (por ejemplo, 10:00), o no marcar en un día de trabajo, cuenta 1 día de falta.
- **Salida anticipada**: los minutos antes de la salida del horario.
- **Días que no cuentan falta**: los días libres, los feriados, los días sin horario (antes de que la empresa tuviera horario principal) y los días que aún no pasaron.
- Si editas un horario, cambian también los reportes pasados de quienes lo tienen. Para un cambio a partir de una fecha, crea un horario nuevo y ponlo como principal (o como horario propio) desde esa fecha.

## Seguridad del inicio de sesión
- **5 contraseñas incorrectas seguidas** bloquean esa cuenta **15 minutos**, en `/admin` y en `/clientes`. El mensaje avisa cuántos intentos quedan.
- Se libera sola a los 15 minutos. Antes, la liberan "Desbloquear" o "Cambiar clave" en Usuarios (o en Accesos al sistema). Tú desbloqueas a cualquiera; el administrador de una empresa, solo a su gente.
- Si se bloquea tu propia cuenta de plataforma y no hay otro administrador, espera los 15 minutos.
- Las claves nuevas deben tener **al menos 8 caracteres, con letras y números**. Las que ya existen siguen sirviendo.

## Notas
- **Entrar con clave en el reloj**: los ZKTeco no aceptan solo la clave. En la pantalla principal toca el icono del teclado, escribe el **PIN** del usuario, confirma y luego escribe la **clave**.
- **Cambiar el PIN** de un empleado: el reloj no permite renombrar un PIN. El panel, en cada equipo: 1) lee del reloj en ese momento la huella, rostro, tarjeta y clave del PIN anterior; 2) crea el PIN nuevo y le copia exactamente eso; 3) solo cuando el reloj confirma cada copia, borra el PIN anterior. Si algo falla, no se borra nada y el empleado conserva su PIN (queda en "Error" y el motivo se ve en "Comandos"). Cambia el PIN solo; la tarjeta, clave o privilegio se editan en otro guardado. Las marcaciones con el PIN anterior siguen apareciendo a nombre del empleado.
- **Después de actualizar server.js o config.js hay que reiniciar el servidor** (Ctrl+C y `node server.js`). Si no, el panel muestra un aviso rojo, porque el reloj seguiría recibiendo órdenes del código anterior.
- Si se cambia la tarjeta o la clave directamente en el reloj, el panel adopta ese valor, para que una edición desde el panel no lo pise.
