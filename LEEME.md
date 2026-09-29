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
  public\index.html
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
1. Abre http://localhost:8088 y entra con `admin@teracorp.bo` / `admin123`. Cámbiala después en "Cambiar clave".
2. **Empresas**: crea la empresa. Se crea sola la sucursal "Principal". Si quieres, crea ahí mismo el acceso de la empresa.
3. **Sucursales**: agrega las demás sucursales.
4. **Dispositivos**: el SenseFace ya conectado aparecerá en "Equipos detectados sin asignar". Pulsa **Asignar** y elige nombre, tipo y sucursal. También puedes registrar uno nuevo escribiendo su número de serie.
5. **Usuarios del reloj** (en Dispositivos): lee los usuarios que ya existen en el equipo (PIN, nombre, tarjeta, privilegio, clave, rostro/huella) y los muestra en una bandeja. Desde ahí puedes **Descargar Excel** y **Agregar al panel** los que marques. Los usuarios que se registren después directamente en el reloj también llegan a esta bandeja como "Nuevos" (el botón muestra cuántos hay).
6. **Empleados**: crea el empleado y marca en qué equipos debe existir. Se envía solo en unos 10 segundos. El chip cambia de "Pendiente" (naranja) a "Sincronizado" (verde).
7. Registra el rostro en el equipo: Gestión de usuarios → editar → Rostro.

## Notas
- **Entrar con clave en el reloj**: los ZKTeco no aceptan solo la clave. En la pantalla principal toca el icono del teclado, escribe el **PIN** del usuario, confirma y luego escribe la **clave**.
- **Cambiar el PIN** de un empleado: el reloj no permite renombrar un PIN. El panel, en cada equipo: 1) lee del reloj en ese momento la huella, rostro, tarjeta y clave del PIN anterior; 2) crea el PIN nuevo y le copia exactamente eso; 3) solo cuando el reloj confirma cada copia, borra el PIN anterior. Si algo falla, no se borra nada y el empleado conserva su PIN (queda en "Error" y el motivo se ve en "Comandos"). Cambia el PIN solo; la tarjeta, clave o privilegio se editan en otro guardado. Las marcaciones con el PIN anterior siguen apareciendo a nombre del empleado.
- **Después de actualizar server.js o config.js hay que reiniciar el servidor** (Ctrl+C y `node server.js`). Si no, el panel muestra un aviso rojo, porque el reloj seguiría recibiendo órdenes del código anterior.
- Si se cambia la tarjeta o la clave directamente en el reloj, el panel adopta ese valor, para que una edición desde el panel no lo pise.
