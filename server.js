// server.js — BioPanel: servidor ADMS multiempresa para ZKTeco (SenseFace 2A y otros)
// Requiere: npm install   (express 5 + pg)
const express = require('express');
const { Pool, Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cfg = require('./config');

const log = (...a) => console.log(new Date().toLocaleString('es-BO'), '|', ...a);
const ARRANQUE = Date.now();

// ---------------- Secreto para tokens ----------------
const SECRET_FILE = path.join(__dirname, '.secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

// ---------------- Base de datos ----------------
const pool = new Pool({ connectionString: cfg.DATABASE_URL });
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS empresas (
  id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, nit TEXT,
  activo BOOLEAN DEFAULT TRUE, creado TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS sucursales (
  id SERIAL PRIMARY KEY, empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL, direccion TEXT, creado TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS dispositivos (
  id SERIAL PRIMARY KEY, sn TEXT UNIQUE NOT NULL, nombre TEXT,
  tipo TEXT NOT NULL DEFAULT 'biometrico' CHECK (tipo IN ('biometrico','acceso')),
  empresa_id INT REFERENCES empresas(id) ON DELETE SET NULL,
  sucursal_id INT REFERENCES sucursales(id) ON DELETE SET NULL,
  ip TEXT, firmware TEXT, info TEXT, ultimo_contacto TIMESTAMPTZ, creado TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS usuarios_sistema (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, nombre TEXT, hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','empresa')),
  empresa_id INT REFERENCES empresas(id) ON DELETE CASCADE, creado TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS empleados (
  id SERIAL PRIMARY KEY, empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pin TEXT NOT NULL, nombre TEXT NOT NULL, ci TEXT, telefono TEXT, departamento TEXT, cargo TEXT,
  tarjeta TEXT, password TEXT, privilegio INT DEFAULT 0, activo BOOLEAN DEFAULT TRUE,
  creado TIMESTAMPTZ DEFAULT now(), UNIQUE (empresa_id, pin));
CREATE TABLE IF NOT EXISTS empleado_dispositivo (
  empleado_id INT REFERENCES empleados(id) ON DELETE CASCADE,
  dispositivo_id INT REFERENCES dispositivos(id) ON DELETE CASCADE,
  estado TEXT DEFAULT 'pendiente', rostro BOOLEAN DEFAULT FALSE, huella BOOLEAN DEFAULT FALSE,
  actualizado TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (empleado_id, dispositivo_id));
CREATE TABLE IF NOT EXISTS usuarios_reloj (
  dispositivo_id INT REFERENCES dispositivos(id) ON DELETE CASCADE,
  pin TEXT NOT NULL, nombre TEXT, tarjeta TEXT, password TEXT, privilegio INT DEFAULT 0,
  rostro BOOLEAN DEFAULT FALSE, huella BOOLEAN DEFAULT FALSE, visto TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (dispositivo_id, pin));
CREATE TABLE IF NOT EXISTS plantillas (
  dispositivo_id INT REFERENCES dispositivos(id) ON DELETE CASCADE,
  pin TEXT NOT NULL, tabla TEXT NOT NULL, indice TEXT NOT NULL, tipo TEXT NOT NULL, linea TEXT NOT NULL,
  visto TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (dispositivo_id, pin, tabla, indice));
CREATE TABLE IF NOT EXISTS comandos (
  id SERIAL PRIMARY KEY, dispositivo_id INT REFERENCES dispositivos(id) ON DELETE CASCADE,
  comando TEXT NOT NULL, tipo TEXT, empleado_id INT, estado TEXT DEFAULT 'pendiente',
  intentos INT DEFAULT 0, retorno TEXT, creado TIMESTAMPTZ DEFAULT now(),
  enviado TIMESTAMPTZ, respondido TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS marcaciones (
  id BIGSERIAL PRIMARY KEY, dispositivo_id INT REFERENCES dispositivos(id) ON DELETE SET NULL,
  sn TEXT NOT NULL, pin TEXT NOT NULL, fecha TIMESTAMP NOT NULL, estado TEXT, verificacion TEXT,
  creado TIMESTAMPTZ DEFAULT now(), UNIQUE (sn, pin, fecha));
ALTER TABLE comandos ADD COLUMN IF NOT EXISTS grupo TEXT;
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS pines_anteriores TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_marc_fecha ON marcaciones(fecha);
CREATE INDEX IF NOT EXISTS idx_cmd_pend ON comandos(dispositivo_id, estado);
`;

async function ensureDatabase() {
  try {
    const c = new Client({ connectionString: cfg.DATABASE_URL });
    await c.connect(); await c.end();
  } catch (e) {
    if (e.code !== '3D000') throw e; // 3D000 = la base no existe
    const u = new URL(cfg.DATABASE_URL);
    const db = u.pathname.slice(1);
    u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    await c.query(`CREATE DATABASE "${db.replace(/"/g, '')}"`);
    await c.end();
    log('Base de datos creada:', db);
  }
  await q(SCHEMA);
  const admin = await one(`SELECT id FROM usuarios_sistema WHERE rol='admin' LIMIT 1`);
  if (!admin) {
    await q(`INSERT INTO usuarios_sistema (email,nombre,hash,rol) VALUES ($1,'Administrador',$2,'admin')`,
      [cfg.ADMIN_EMAIL, hashPass(cfg.ADMIN_PASSWORD)]);
    log(`👤 Admin creado: ${cfg.ADMIN_EMAIL} / ${cfg.ADMIN_PASSWORD}  (cámbiala al entrar)`);
  }
}

// ---------------- Seguridad ----------------
function hashPass(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(p), salt, 64).toString('hex');
}
function checkPass(p, h) {
  const [salt, k] = String(h).split(':');
  if (!salt || !k) return false;
  const d = crypto.scryptSync(String(p), salt, 64);
  return crypto.timingSafeEqual(d, Buffer.from(k, 'hex'));
}
function signToken(obj) {
  const b = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verifyToken(t) {
  const [b, s] = String(t || '').split('.');
  if (!b || !s) return null;
  const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  const o = JSON.parse(Buffer.from(b, 'base64url').toString());
  return o.exp > Date.now() ? o : null;
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.status = code; } }

// ---------------- Excel (.xlsx) sin dependencias ----------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xEDB88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zip(files) {
  const partes = [], central = [];
  let offset = 0;
  for (const [nombre, texto] of Object.entries(files)) {
    const name = Buffer.from(nombre), raw = Buffer.from(texto), data = zlib.deflateRawSync(raw), crc = crc32(raw);
    const h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    partes.push(h, name, data); central.push(c, name);
    offset += h.length + name.length + data.length;
  }
  const cd = Buffer.concat(central), fin = Buffer.alloc(22), n = central.length / 2;
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(n, 8); fin.writeUInt16LE(n, 10);
  fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, cd, fin]);
}
// columnas: [[titulo, ancho], ...] (máx. 26); filas: arrays de valores. Todo se guarda como texto
// para que Excel no quite ceros a la izquierda en PIN o tarjeta.
function xlsx(hoja, columnas, filas) {
  const x = v => String(v ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const col = i => String.fromCharCode(65 + i);
  const fila = (vals, r, s) => `<row r="${r}">` + vals.map((v, i) => v == null || v === '' ? '' :
    `<c r="${col(i)}${r}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`).join('') + '</row>';
  const ultima = col(columnas.length - 1), total = filas.length + 1;
  const NS = 'http://schemas.openxmlformats.org', XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="${NS}/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${NS}/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${x(hoja)}" sheetId="1" r:id="rId1"/></sheets>` +
      `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${x(hoja)}'!$A$1:$${ultima}$${total}</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${NS}/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="${NS}/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFE6F4F2"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': `${XML}<worksheet xmlns="${NS}/spreadsheetml/2006/main">` +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols>${columnas.map(([, w], i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>${fila(columnas.map(c => c[0]), 1, 1)}${filas.map((f, i) => fila(f, i + 2, 0)).join('')}</sheetData>` +
      `<autoFilter ref="A1:${ultima}${total}"/></worksheet>`,
  });
}

// ---------------- Utilidades ADMS ----------------
const clean = s => String(s ?? '').replace(/[\t\r\n]/g, ' ').trim();
function parseKV(line, sep = '\t') {
  const o = {};
  line.split(sep).forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return o;
}
function lower(o) { const r = {}; for (const k in o) r[k.toLowerCase()] = o[k]; return r; }

function cmdAlta(e) {
  return `DATA UPDATE USERINFO PIN=${clean(e.pin)}\tName=${clean(e.nombre).slice(0, 24)}` +
    `\tPri=${Number(e.privilegio) || 0}\tPasswd=${clean(e.password)}\tCard=${clean(e.tarjeta)}\tGrp=1`;
}
const cmdBaja = pin => `DATA DELETE USERINFO PIN=${clean(pin)}`;
// Reenvía una plantilla tal como la mandó el reloj, pero a otro PIN (FP se sube como FINGERTMP)
function cmdPlantilla(p, pin) {
  const tabla = p.tabla.toUpperCase() === 'FP' ? 'FINGERTMP' : p.tabla;
  const campos = p.linea.split('\t').map(f => {
    const [k] = f.split('=');
    if (k.toLowerCase() === 'pin') return `${k}=${pin}`;
    if (tabla.toUpperCase() === 'FACE' && ['SIZE', 'VALID'].includes(k)) return k[0] + k.slice(1).toLowerCase() + f.slice(k.length);
    return f;
  });
  return `DATA UPDATE ${tabla} ${campos.join('\t')}`;
}

async function queueCmd(dispositivo_id, comando, tipo = 'otro', empleado_id = null, grupo = null, estado = 'pendiente') {
  await q(`INSERT INTO comandos (dispositivo_id, comando, tipo, empleado_id, grupo, estado) VALUES ($1,$2,$3,$4,$5,$6)`,
    [dispositivo_id, comando, tipo, empleado_id, grupo, estado]);
}

function optionsText(sn) {
  return [
    `GET OPTION FROM: ${sn}`, 'ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=None',
    'ErrorDelay=30', 'Delay=10', 'TransTimes=00:00;14:05', 'TransInterval=1',
    'TransFlag=TransData AttLog OpLog AttPhoto EnrollUser ChgUser EnrollFP ChgFP UserPic FACE BioPhoto',
    `TimeZone=${cfg.TIMEZONE}`, 'Realtime=1', 'Encrypt=None',
    'ServerVer=2.4.1', 'PushProtVer=2.4.1', 'PushOptionsFlag=1',
  ].join('\n');
}

// Registra el contacto del equipo (lo crea "sin asignar" si es nuevo)
async function touchDevice(req) {
  const sn = clean(req.query.SN);
  if (!sn) return null;
  const ip = (req.ip || '').replace('::ffff:', '');
  let d = await one(`UPDATE dispositivos SET ip=$2, ultimo_contacto=now() WHERE sn=$1 RETURNING *`, [sn, ip]);
  if (!d) {
    d = await one(
      `INSERT INTO dispositivos (sn, nombre, ip, ultimo_contacto) VALUES ($1,$1,$2,now())
       ON CONFLICT (sn) DO UPDATE SET ip=$2, ultimo_contacto=now() RETURNING *`, [sn, ip]);
    log('🟢 Equipo nuevo detectado (sin asignar):', sn, ip);
  }
  if (req.query.INFO) {
    const fw = String(req.query.INFO).split(',')[0];
    await q(`UPDATE dispositivos SET firmware=$2, info=$3 WHERE id=$1`, [d.id, fw, String(req.query.INFO)]);
  }
  return d;
}

async function guardarMarcacion(dev, pin, fecha, estado, verif) {
  if (!pin || pin === '0' || !fecha) return 0;
  const r = await q(
    `INSERT INTO marcaciones (dispositivo_id, sn, pin, fecha, estado, verificacion)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (sn,pin,fecha) DO NOTHING`,
    [dev.id, dev.sn, pin, fecha, estado ?? null, verif ?? null]);
  if (r.rowCount) log('🕒 Marcación', dev.sn, 'PIN', pin, fecha);
  return 1;
}

// Usuario reportado por el reloj → bandeja de revisión (usuarios_reloj).
// No crea empleados: eso se hace desde el panel. Si ya es empleado, queda enlazado al equipo.
async function guardarUsuarioReloj(dev, u) {
  const pin = clean(u.pin);
  if (!pin) return;
  const tarjeta = clean(u.card || u.cardno), password = clean(u.passwd || u.password), privilegio = Number(u.pri ?? u.privilege) || 0;
  await q(`INSERT INTO usuarios_reloj (dispositivo_id, pin, nombre, tarjeta, password, privilegio)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (dispositivo_id, pin) DO UPDATE SET nombre=EXCLUDED.nombre, tarjeta=EXCLUDED.tarjeta,
             password=EXCLUDED.password, privilegio=EXCLUDED.privilegio, visto=now()`,
    [dev.id, pin, clean(u.name), tarjeta, password, privilegio]);
  if (!dev.empresa_id) return;
  // Tarjeta, clave y privilegio se pueden cambiar en el propio reloj: el panel adopta lo que informa
  // (salvo que haya un envío del panel todavía en curso), así una edición no los pisa.
  await q(`UPDATE empleados e SET tarjeta=$3, password=$4, privilegio=$5
           WHERE e.empresa_id=$1 AND e.pin=$2 AND NOT EXISTS (SELECT 1 FROM comandos c
             WHERE c.empleado_id=e.id AND c.dispositivo_id=$6
               AND c.estado IN ('pendiente','enviado','espera') AND c.creado > now() - interval '10 minutes')`,
    [dev.empresa_id, pin, tarjeta, password, privilegio, dev.id]);
  await q(`INSERT INTO empleado_dispositivo (empleado_id, dispositivo_id, estado)
           SELECT id, $2, 'sincronizado' FROM empleados WHERE empresa_id=$1 AND pin=$3
           ON CONFLICT (empleado_id, dispositivo_id) DO UPDATE SET estado='sincronizado', actualizado=now()
           WHERE empleado_dispositivo.estado <> 'eliminando'`, [dev.empresa_id, dev.id, pin]);
}

async function marcarBiometria(dev, pin, campo) {
  pin = clean(pin);
  if (!pin) return;
  await q(`INSERT INTO usuarios_reloj (dispositivo_id, pin, ${campo}) VALUES ($1,$2,TRUE)
           ON CONFLICT (dispositivo_id, pin) DO UPDATE SET ${campo}=TRUE`, [dev.id, pin]);
  if (!dev.empresa_id) return;
  await q(`UPDATE empleado_dispositivo ed SET ${campo}=TRUE, actualizado=now()
           FROM empleados e WHERE e.id=ed.empleado_id AND e.empresa_id=$1 AND e.pin=$2 AND ed.dispositivo_id=$3`,
    [dev.empresa_id, pin, dev.id]);
}

// Tipo de una plantilla biométrica. BIODATA Type=1 es huella; 2 y 9 son rostro (9 = luz visible)
function tipoPlantilla(tag, kv) {
  if (tag === 'FP' || tag === 'FINGERTMP') return 'huella';
  if (tag === 'FACE') return 'rostro';
  if (tag === 'BIODATA') return kv.type === '1' ? 'huella' : ['2', '9'].includes(kv.type) ? 'rostro' : 'otro';
  return null;
}

// Guarda la plantilla tal cual la envió el reloj, para poder copiarla a otro PIN sin volver a registrar
async function guardarPlantilla(dev, tabla, linea, kv, tipo) {
  const pin = clean(kv.pin);
  if (!pin || !kv.tmp) return;
  const indice = tabla.toUpperCase() === 'BIODATA' ? `${kv.type}-${kv.no}-${kv.index}` : String(kv.fid ?? 0);
  await q(`INSERT INTO plantillas (dispositivo_id, pin, tabla, indice, tipo, linea) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (dispositivo_id, pin, tabla, indice) DO UPDATE SET tipo=EXCLUDED.tipo, linea=EXCLUDED.linea, visto=now()`,
    [dev.id, pin, tabla, indice, tipo, linea]);
}

// Procesa líneas de usuarios/biometría (formato push 2.x "USER PIN=..." y 3.x "user pin=...")
async function procesarLineaUsuario(dev, l) {
  const m = l.match(/^(\w+)\s+(.*)$/);
  if (!m) return false;
  const tag = m[1].toUpperCase();
  const kv = lower(parseKV(m[2]));
  if (tag === 'USER') { await guardarUsuarioReloj(dev, kv); return true; }
  const tipo = tipoPlantilla(tag, kv);
  if (tipo) {
    await guardarPlantilla(dev, m[1], m[2], kv, tipo);
    if (tipo !== 'otro') await marcarBiometria(dev, kv.pin, tipo);
    return true;
  }
  if (tag === 'BIOPHOTO') { await marcarBiometria(dev, kv.pin, 'rostro'); return true; }
  return false;
}

// Tras leer todas las huellas (o rostros) del reloj: descarta las plantillas que ya no están y
// recalcula quién tiene esa biometría. Si no envió ninguna y nunca había enviado de ese tipo
// (puede que el firmware no lo soporte), no se toca nada.
async function refrescarBiometria(dispositivo_id, tipo, desde) {
  const r = await one(`SELECT count(*)::int n FROM plantillas WHERE dispositivo_id=$1 AND tipo=$2`, [dispositivo_id, tipo]);
  if (!r.n) return;
  await q(`DELETE FROM plantillas WHERE dispositivo_id=$1 AND tipo=$2 AND visto < $3`, [dispositivo_id, tipo, desde]);
  await q(`UPDATE usuarios_reloj u SET ${tipo} = EXISTS (SELECT 1 FROM plantillas p
             WHERE p.dispositivo_id=u.dispositivo_id AND p.pin=u.pin AND p.tipo=$2)
           WHERE u.dispositivo_id=$1`, [dispositivo_id, tipo]);
  await q(`UPDATE empleado_dispositivo ed SET ${tipo}=u.${tipo}
           FROM empleados e, dispositivos d, usuarios_reloj u
           WHERE ed.dispositivo_id=$1 AND e.id=ed.empleado_id AND d.id=ed.dispositivo_id AND e.empresa_id=d.empresa_id
             AND u.dispositivo_id=ed.dispositivo_id AND u.pin=e.pin`, [dispositivo_id]);
}

// ---------------- Cambio de PIN sin perder biometría ----------------
// El reloj no permite renombrar un PIN. En cada equipo, un "grupo" de comandos hace, en orden:
//   1. lee del reloj los datos, huellas y rostro del PIN anterior (así se copia lo que hay ahora, no algo viejo)
//   2. "CAMBIAR PIN=x A PIN=y" (interno, no va al reloj): crea el PIN nuevo y le copia todo lo leído
//   3. recién cuando el reloj confirmó cada copia, borra el PIN anterior
// Cada paso "en espera" se libera solo si el reloj confirmó todos los anteriores. Si algo falla se cancela todo.
const RE_CAMBIO = /^CAMBIAR PIN=(\S+) A PIN=(\S+)$/;

async function avanzarGrupo(c, ok) {
  if (!ok) return cancelarCambioPin(c, `el reloj rechazó el comando #${c.id} (código ${c.retorno})`);
  const r = await one(`SELECT count(*)::int n FROM comandos WHERE grupo=$1 AND estado NOT IN ('ok','espera')`, [c.grupo]);
  if (r.n) return;
  const sig = await one(`SELECT * FROM comandos WHERE grupo=$1 AND estado='espera' ORDER BY id LIMIT 1`, [c.grupo]);
  if (!sig) return;
  if (sig.tipo === 'cambio-pin') await copiarAlPinNuevo(sig);
  else await q(`UPDATE comandos SET estado='pendiente' WHERE id=$1`, [sig.id]);
}

async function copiarAlPinNuevo(m) {
  const [, viejo, nuevo] = m.comando.match(RE_CAMBIO);
  const { desde } = await one(`SELECT min(enviado) desde FROM comandos WHERE grupo=$1 AND tipo='consulta'`, [m.grupo]);
  const u = await one(`SELECT * FROM usuarios_reloj WHERE dispositivo_id=$1 AND pin=$2 AND visto >= $3`, [m.dispositivo_id, viejo, desde]);
  // Huellas y rostros (BIODATA 9) se toman solo de lo que el reloj acaba de enviar; otras plantillas, de lo guardado
  const { rows: plantillas } = await q(`SELECT tabla, linea, tipo FROM plantillas WHERE dispositivo_id=$1 AND pin=$2
      AND (visto >= $3 OR NOT (tipo='huella' OR (upper(tabla)='BIODATA' AND indice LIKE '9-%')))
    ORDER BY tabla, indice`, [m.dispositivo_id, viejo, desde]);
  if (u) {
    for (const tipo of ['huella', 'rostro'])
      if (u[tipo] && !plantillas.some(p => p.tipo === tipo))
        return cancelarCambioPin(m, `el reloj no envió la plantilla de ${tipo} del PIN ${viejo}; ` +
          'pulsa "Leer del reloj" en Usuarios del reloj y vuelve a intentar');
    // Se conserva exactamente la tarjeta, clave y privilegio que el usuario tiene ahora en el reloj
    await q(`UPDATE empleados SET tarjeta=$2, password=$3, privilegio=$4 WHERE id=$1`,
      [m.empleado_id, u.tarjeta, u.password, u.privilegio]);
  }
  const e = await one(`SELECT * FROM empleados WHERE id=$1`, [m.empleado_id]);
  if (!e || e.pin !== nuevo) return cancelarCambioPin(m, 'el empleado cambió mientras tanto');
  await q(`UPDATE comandos SET estado='ok', respondido=now(), retorno=$2 WHERE id=$1`,
    [m.id, `${plantillas.length} plantilla(s)`]);
  await queueCmd(m.dispositivo_id, cmdAlta(e), 'alta', e.id, m.grupo);
  for (const p of plantillas) await queueCmd(m.dispositivo_id, cmdPlantilla(p, nuevo), 'plantilla', e.id, m.grupo);
  if (!u) return; // el PIN anterior no está en este reloj: no hay nada que borrar
  await queueCmd(m.dispositivo_id, cmdBaja(viejo), 'otro', e.id, m.grupo, 'espera');
  // La bandeja y las plantillas del panel pasan también al PIN nuevo
  await q(`INSERT INTO usuarios_reloj (dispositivo_id, pin, nombre, tarjeta, password, privilegio, rostro, huella)
           SELECT dispositivo_id, $3, $4, $5, $6, $7, rostro, huella FROM usuarios_reloj WHERE dispositivo_id=$1 AND pin=$2
           ON CONFLICT (dispositivo_id, pin) DO NOTHING`, [m.dispositivo_id, viejo, nuevo, e.nombre, e.tarjeta, e.password, e.privilegio]);
  await q(`INSERT INTO plantillas (dispositivo_id, pin, tabla, indice, tipo, linea)
           SELECT dispositivo_id, $3, tabla, indice, tipo, linea FROM plantillas WHERE dispositivo_id=$1 AND pin=$2
           ON CONFLICT DO NOTHING`, [m.dispositivo_id, viejo, nuevo]);
}

// Si algo falla en cualquier equipo se detiene todo el cambio: el PIN anterior sigue intacto en los relojes,
// se quita la copia a medias del PIN nuevo y, si en ningún equipo llegó a borrarse el anterior, el panel vuelve a él.
async function cancelarCambioPin(c, motivo) {
  const op = c.grupo.replace(/-d\d+$/, '') + '-%';
  const r = await q(`UPDATE comandos SET estado='cancelado', retorno=$2 WHERE grupo LIKE $1 AND estado IN ('espera','pendiente')`, [op, motivo]);
  if (!r.rowCount) return; // ya estaba cancelado
  log('⚠️ Cambio de PIN detenido:', motivo, '— el PIN anterior se conserva');
  const [, viejo, nuevo] = (await one(`SELECT comando FROM comandos WHERE grupo LIKE $1 AND tipo='cambio-pin' LIMIT 1`, [op])).comando.match(RE_CAMBIO);
  const { rows } = await q(`SELECT DISTINCT a.dispositivo_id FROM comandos a
    WHERE a.grupo LIKE $1 AND a.tipo='alta' AND a.estado IN ('ok','enviado')
      AND NOT EXISTS (SELECT 1 FROM comandos b WHERE b.grupo=a.grupo AND b.comando=$2 AND b.estado IN ('ok','enviado'))`, [op, cmdBaja(viejo)]);
  for (const d of rows) await queueCmd(d.dispositivo_id, cmdBaja(nuevo), 'otro', c.empleado_id);
  const borrado = await one(`SELECT 1 FROM comandos WHERE grupo LIKE $1 AND comando=$2 AND estado IN ('ok','enviado')`, [op, cmdBaja(viejo)]);
  if (!borrado) await q(`UPDATE empleados SET pin=$2, pines_anteriores=array_remove(pines_anteriores, $2) WHERE id=$1 AND pin=$3`,
    [c.empleado_id, viejo, nuevo]);
  await q(`UPDATE empleado_dispositivo SET estado='error' WHERE empleado_id=$1 AND dispositivo_id=$2`, [c.empleado_id, c.dispositivo_id]);
}

// ---------------- App ----------------
const app = express();
app.set('trust proxy', false);
app.use('/iclock', express.text({ type: '*/*', limit: '20mb' }));
app.use('/api', express.json({ limit: '2mb' }));

// ===== Protocolo ADMS (lo usa el reloj) =====
app.use('/iclock', async (req, res, next) => {
  req.dev = await touchDevice(req);
  if (!req.path.includes('getrequest')) log('⇢', req.method, req.originalUrl.slice(0, 140));
  next();
});

app.get('/iclock/cdata', (req, res) => res.type('text/plain').send(optionsText(req.query.SN)));
app.post('/iclock/registry', (req, res) => res.type('text/plain').send('RegistryCode=BIOPANEL01'));
app.all('/iclock/push', (req, res) => res.type('text/plain').send(optionsText(req.query.SN)));

app.post('/iclock/cdata', async (req, res) => {
  const dev = req.dev;
  const table = String(req.query.table || '').toUpperCase();
  const lines = String(req.body || '').split(/\r?\n/).filter(Boolean);
  let n = 0;
  for (const l of lines) {
    try {
      if (table === 'ATTLOG') {
        const [pin, fecha, estado, verif] = l.split('\t');
        n += await guardarMarcacion(dev, clean(pin), clean(fecha), clean(estado), clean(verif));
      } else if (table === 'RTLOG') {
        const o = lower(parseKV(l));
        n += await guardarMarcacion(dev, o.pin, o.time, o.inoutstatus, o.verifytype);
      } else {
        await procesarLineaUsuario(dev, l); // OPERLOG, USERINFO, BIODATA...
        n++;
      }
    } catch (e) { log('❌ Error línea', table, e.message); }
  }
  res.type('text/plain').send(`OK: ${n || lines.length}`);
});

// Respuestas a DATA QUERY en push 3.x
app.post('/iclock/querydata', async (req, res) => {
  const lines = String(req.body || '').split(/\r?\n/).filter(Boolean);
  for (const l of lines) {
    if (/^transaction\s/i.test(l)) {
      const o = lower(parseKV(l.replace(/^\w+\s+/, '')));
      await guardarMarcacion(req.dev, o.pin, o.time, o.inoutstatus, o.verifytype);
    } else await procesarLineaUsuario(req.dev, l);
  }
  res.type('text/plain').send('OK');
});

app.get('/iclock/getrequest', async (req, res) => {
  const dev = req.dev;
  if (!dev) return res.type('text/plain').send('OK');
  // Pendientes + reintentos de enviados sin respuesta hace más de 2 min (máx. 3 intentos)
  const { rows } = await q(
    `UPDATE comandos SET estado='enviado', enviado=now(), intentos=intentos+1
     WHERE id IN (SELECT id FROM comandos WHERE dispositivo_id=$1 AND
       (estado='pendiente' OR (estado='enviado' AND enviado < now() - interval '2 minutes' AND intentos < 3))
       ORDER BY id LIMIT 20)
     RETURNING id, comando`, [dev.id]);
  if (!rows.length) return res.type('text/plain').send('OK');
  rows.sort((a, b) => a.id - b.id);
  const body = rows.map(r => `C:${r.id}:${r.comando}`).join('\n');
  log('📤 Comandos a', dev.sn, '\n' + body);
  res.type('text/plain').send(body);
});

app.post('/iclock/devicecmd', async (req, res) => {
  const lines = String(req.body || '').split(/\r?\n/).filter(Boolean);
  for (const l of lines) {
    const p = new URLSearchParams(l.replace(/\t/g, '&'));
    const id = Number(p.get('ID')); const ret = Number(p.get('Return'));
    if (!id) continue;
    const ok = ret >= 0;
    const c = await one(`UPDATE comandos SET estado=$2, retorno=$3, respondido=now() WHERE id=$1 AND dispositivo_id=$4 RETURNING *`,
      [id, ok ? 'ok' : 'error', String(p.get('Return')), req.dev?.id]);
    log(ok ? '✅' : '❌', 'Comando', id, 'Return=' + ret);
    if (!c) continue;
    if (c.grupo) await avanzarGrupo(c, ok);
    if (c.tipo === 'lectura' && ok) {
      // Lectura completa: quita de la bandeja a los usuarios que ya no están en el reloj
      await q(`DELETE FROM usuarios_reloj WHERE dispositivo_id=$1 AND visto < $2
               AND EXISTS (SELECT 1 FROM usuarios_reloj WHERE dispositivo_id=$1 AND visto >= $2)`,
        [c.dispositivo_id, c.enviado]);
      await q(`DELETE FROM plantillas p WHERE p.dispositivo_id=$1
               AND NOT EXISTS (SELECT 1 FROM usuarios_reloj u WHERE u.dispositivo_id=p.dispositivo_id AND u.pin=p.pin)`,
        [c.dispositivo_id]);
    }
    if (ok && c.comando === 'DATA QUERY FINGERTMP') await refrescarBiometria(c.dispositivo_id, 'huella', c.enviado);
    if (ok && c.comando === 'DATA QUERY BIODATA Type=9') await refrescarBiometria(c.dispositivo_id, 'rostro', c.enviado);
    const borrado = ok && c.comando.match(/^DATA DELETE USERINFO PIN=(.+)$/);
    if (borrado) {
      await q(`DELETE FROM usuarios_reloj WHERE dispositivo_id=$1 AND pin=$2`, [c.dispositivo_id, borrado[1]]);
      await q(`DELETE FROM plantillas WHERE dispositivo_id=$1 AND pin=$2`, [c.dispositivo_id, borrado[1]]);
    }
    if (!c.empleado_id) continue;
    if (c.tipo === 'alta')
      await q(`UPDATE empleado_dispositivo SET estado=$3, actualizado=now() WHERE empleado_id=$1 AND dispositivo_id=$2`,
        [c.empleado_id, c.dispositivo_id, ok ? 'sincronizado' : 'error']);
    if (c.tipo === 'baja' && ok)
      await q(`DELETE FROM empleado_dispositivo WHERE empleado_id=$1 AND dispositivo_id=$2 AND estado='eliminando'`,
        [c.empleado_id, c.dispositivo_id]);
  }
  res.type('text/plain').send('OK');
});

app.all('/iclock/{*resto}', (req, res) => res.type('text/plain').send('OK'));

// ===== API del dashboard =====
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const u = await one(`SELECT * FROM usuarios_sistema WHERE lower(email)=lower($1)`, [email || '']);
  if (!u || !checkPass(password || '', u.hash)) throw new HttpError(401, 'Correo o contraseña incorrectos');
  const token = signToken({ id: u.id, rol: u.rol, empresa_id: u.empresa_id, exp: Date.now() + 12 * 3600e3 });
  res.json({ token });
});

app.use('/api', (req, res, next) => {
  const t = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!t) throw new HttpError(401, 'Sesión expirada, vuelve a entrar');
  req.user = t;
  next();
});
const isAdmin = req => req.user.rol === 'admin';
const soloAdmin = (req) => { if (!isAdmin(req)) throw new HttpError(403, 'Solo el administrador'); };
// Empresa efectiva para filtros: admin puede elegir (o todas), empresa ve la suya
const empresaScope = (req, pedida) => isAdmin(req) ? (pedida ? Number(pedida) : null) : req.user.empresa_id;
const checkEmpresa = (req, empresa_id) => {
  if (!isAdmin(req) && Number(empresa_id) !== Number(req.user.empresa_id)) throw new HttpError(403, 'No autorizado');
};

app.get('/api/me', async (req, res) => {
  const u = await one(`SELECT u.id,u.email,u.nombre,u.rol,u.empresa_id,e.nombre empresa
    FROM usuarios_sistema u LEFT JOIN empresas e ON e.id=u.empresa_id WHERE u.id=$1`, [req.user.id]);
  // Si server.js o config.js cambiaron después de arrancar, el reloj sigue recibiendo órdenes del código viejo
  u.desactualizado = ['server.js', 'config.js'].some(f => fs.statSync(path.join(__dirname, f)).mtimeMs > ARRANQUE);
  res.json(u);
});
app.post('/api/me/password', async (req, res) => {
  const { actual, nueva } = req.body;
  const u = await one(`SELECT * FROM usuarios_sistema WHERE id=$1`, [req.user.id]);
  if (!checkPass(actual || '', u.hash)) throw new HttpError(400, 'La contraseña actual no es correcta');
  if (!nueva || nueva.length < 6) throw new HttpError(400, 'Mínimo 6 caracteres');
  await q(`UPDATE usuarios_sistema SET hash=$2 WHERE id=$1`, [u.id, hashPass(nueva)]);
  res.json({ ok: true });
});

// Resumen
app.get('/api/resumen', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const suc = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  const r = await one(`
    SELECT
      (SELECT count(*) FROM dispositivos d WHERE ($1::int IS NULL OR d.empresa_id=$1) AND ($2::int IS NULL OR d.sucursal_id=$2) AND d.empresa_id IS NOT NULL) dispositivos,
      (SELECT count(*) FROM dispositivos d WHERE ($1::int IS NULL OR d.empresa_id=$1) AND ($2::int IS NULL OR d.sucursal_id=$2) AND d.empresa_id IS NOT NULL
         AND d.ultimo_contacto > now() - make_interval(secs => $3)) en_linea,
      (SELECT count(*) FROM empleados e WHERE ($1::int IS NULL OR e.empresa_id=$1)
         AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM empleado_dispositivo ed JOIN dispositivos d ON d.id=ed.dispositivo_id WHERE ed.empleado_id=e.id AND d.sucursal_id=$2))) empleados,
      (SELECT count(*) FROM marcaciones m JOIN dispositivos d ON d.id=m.dispositivo_id
         WHERE ($1::int IS NULL OR d.empresa_id=$1) AND ($2::int IS NULL OR d.sucursal_id=$2) AND m.fecha::date = (now() AT TIME ZONE 'America/La_Paz')::date) marcaciones_hoy,
      (SELECT count(*) FROM dispositivos WHERE empresa_id IS NULL AND $4) sin_asignar`,
    [emp, suc, cfg.ONLINE_SECONDS, isAdmin(req)]);
  res.json(r);
});

// Empresas
app.get('/api/empresas', async (req, res) => {
  const { rows } = await q(`SELECT e.*,
      (SELECT count(*) FROM sucursales s WHERE s.empresa_id=e.id) sucursales,
      (SELECT count(*) FROM dispositivos d WHERE d.empresa_id=e.id) dispositivos,
      (SELECT count(*) FROM empleados x WHERE x.empresa_id=e.id) empleados
    FROM empresas e WHERE ($1::int IS NULL OR e.id=$1) ORDER BY e.nombre`, [isAdmin(req) ? null : req.user.empresa_id]);
  res.json(rows);
});
app.post('/api/empresas', async (req, res) => {
  soloAdmin(req);
  const { nombre, nit } = req.body;
  if (!clean(nombre)) throw new HttpError(400, 'Nombre obligatorio');
  const e = await one(`INSERT INTO empresas (nombre,nit) VALUES ($1,$2) RETURNING *`, [clean(nombre), clean(nit)]);
  // Crea una sucursal "Principal" por defecto
  await q(`INSERT INTO sucursales (empresa_id,nombre) VALUES ($1,'Principal')`, [e.id]);
  res.json(e);
});
app.put('/api/empresas/:id', async (req, res) => {
  soloAdmin(req);
  const { nombre, nit, activo } = req.body;
  res.json(await one(`UPDATE empresas SET nombre=$2, nit=$3, activo=COALESCE($4,activo) WHERE id=$1 RETURNING *`,
    [req.params.id, clean(nombre), clean(nit), activo]));
});
app.delete('/api/empresas/:id', async (req, res) => {
  soloAdmin(req);
  await q(`DELETE FROM empresas WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// Sucursales
app.get('/api/sucursales', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const { rows } = await q(`SELECT s.*, e.nombre empresa,
      (SELECT count(*) FROM dispositivos d WHERE d.sucursal_id=s.id AND d.tipo='biometrico') biometricos,
      (SELECT count(*) FROM dispositivos d WHERE d.sucursal_id=s.id AND d.tipo='acceso') accesos
    FROM sucursales s JOIN empresas e ON e.id=s.empresa_id
    WHERE ($1::int IS NULL OR s.empresa_id=$1) ORDER BY e.nombre, s.nombre`, [emp]);
  res.json(rows);
});
app.post('/api/sucursales', async (req, res) => {
  const empresa_id = isAdmin(req) ? req.body.empresa_id : req.user.empresa_id;
  checkEmpresa(req, empresa_id);
  if (!empresa_id || !clean(req.body.nombre)) throw new HttpError(400, 'Empresa y nombre obligatorios');
  res.json(await one(`INSERT INTO sucursales (empresa_id,nombre,direccion) VALUES ($1,$2,$3) RETURNING *`,
    [empresa_id, clean(req.body.nombre), clean(req.body.direccion)]));
});
app.put('/api/sucursales/:id', async (req, res) => {
  const s = await one(`SELECT * FROM sucursales WHERE id=$1`, [req.params.id]);
  if (!s) throw new HttpError(404, 'No existe');
  checkEmpresa(req, s.empresa_id);
  res.json(await one(`UPDATE sucursales SET nombre=$2, direccion=$3 WHERE id=$1 RETURNING *`,
    [s.id, clean(req.body.nombre), clean(req.body.direccion)]));
});
app.delete('/api/sucursales/:id', async (req, res) => {
  const s = await one(`SELECT * FROM sucursales WHERE id=$1`, [req.params.id]);
  if (!s) throw new HttpError(404, 'No existe');
  checkEmpresa(req, s.empresa_id);
  const n = await one(`SELECT count(*)::int n FROM dispositivos WHERE sucursal_id=$1`, [s.id]);
  if (n.n) throw new HttpError(409, 'La sucursal tiene dispositivos; muévelos o elimínalos primero');
  await q(`DELETE FROM sucursales WHERE id=$1`, [s.id]);
  res.json({ ok: true });
});

// Dispositivos
const DEV_SELECT = `SELECT d.*, s.nombre sucursal, e.nombre empresa,
    (d.ultimo_contacto > now() - make_interval(secs => ${Number(cfg.ONLINE_SECONDS)})) en_linea,
    (SELECT count(*) FROM empleado_dispositivo ed WHERE ed.dispositivo_id=d.id) empleados,
    (SELECT count(*) FROM comandos c WHERE c.dispositivo_id=d.id AND c.estado IN ('pendiente','enviado','espera')) cmd_pendientes,
    (SELECT count(*) FROM usuarios_reloj u WHERE u.dispositivo_id=d.id
       AND NOT EXISTS (SELECT 1 FROM empleados x WHERE x.empresa_id=d.empresa_id AND x.pin=u.pin)) usuarios_nuevos
  FROM dispositivos d LEFT JOIN sucursales s ON s.id=d.sucursal_id LEFT JOIN empresas e ON e.id=d.empresa_id`;

async function getDevice(req, id) {
  const d = await one(`SELECT * FROM dispositivos WHERE id=$1`, [id]);
  if (!d) throw new HttpError(404, 'Dispositivo no existe');
  if (!isAdmin(req) && d.empresa_id !== req.user.empresa_id) throw new HttpError(403, 'No autorizado');
  return d;
}

app.get('/api/dispositivos', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const suc = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  const incluirSinAsignar = isAdmin(req) && !emp && !suc;
  const { rows } = await q(`${DEV_SELECT}
    WHERE (($1::int IS NULL AND d.empresa_id IS NOT NULL) OR d.empresa_id=$1 OR ($3 AND d.empresa_id IS NULL))
      AND ($2::int IS NULL OR d.sucursal_id=$2)
    ORDER BY d.empresa_id NULLS FIRST, s.nombre, d.nombre`, [emp, suc, incluirSinAsignar]);
  res.json(rows);
});

app.post('/api/dispositivos', async (req, res) => {
  const sn = clean(req.body.sn).toUpperCase();
  const { nombre, tipo = 'biometrico', sucursal_id } = req.body;
  if (!sn) throw new HttpError(400, 'Número de serie obligatorio');
  const s = await one(`SELECT * FROM sucursales WHERE id=$1`, [sucursal_id]);
  if (!s) throw new HttpError(400, 'Elige una sucursal');
  checkEmpresa(req, s.empresa_id);
  const existe = await one(`SELECT * FROM dispositivos WHERE upper(sn)=$1`, [sn]);
  if (existe && existe.empresa_id && existe.empresa_id !== s.empresa_id)
    throw new HttpError(409, 'Ese número de serie ya pertenece a otra empresa');
  const d = existe
    ? await one(`UPDATE dispositivos SET nombre=$2, tipo=$3, sucursal_id=$4, empresa_id=$5 WHERE id=$1 RETURNING *`,
      [existe.id, clean(nombre) || sn, tipo, s.id, s.empresa_id])
    : await one(`INSERT INTO dispositivos (sn,nombre,tipo,sucursal_id,empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [sn, clean(nombre) || sn, tipo, s.id, s.empresa_id]);
  res.json(d);
});

app.put('/api/dispositivos/:id', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  const s = await one(`SELECT * FROM sucursales WHERE id=$1`, [req.body.sucursal_id || d.sucursal_id]);
  if (!s) throw new HttpError(400, 'Elige una sucursal');
  checkEmpresa(req, s.empresa_id);
  if (d.empresa_id && d.empresa_id !== s.empresa_id && !isAdmin(req)) throw new HttpError(403, 'No autorizado');
  res.json(await one(`UPDATE dispositivos SET nombre=$2, tipo=$3, sucursal_id=$4, empresa_id=$5 WHERE id=$1 RETURNING *`,
    [d.id, clean(req.body.nombre) || d.sn, req.body.tipo || d.tipo, s.id, s.empresa_id]));
});

app.delete('/api/dispositivos/:id', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  await q(`DELETE FROM dispositivos WHERE id=$1`, [d.id]);
  res.json({ ok: true });
});

// Bandeja: usuarios que ya existen en el reloj, para revisarlos, exportarlos y agregarlos al panel
app.post('/api/dispositivos/:id/leer-usuarios', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  await queueCmd(d.id, 'DATA QUERY USERINFO', 'lectura');
  await queueCmd(d.id, 'DATA QUERY FINGERTMP', 'consulta');
  await queueCmd(d.id, 'DATA QUERY BIODATA Type=9', 'consulta'); // rostro (luz visible)
  res.json({ ok: true });
});
const PRIVILEGIO = { 0: 'Usuario', 14: 'Administrador' };
app.get('/api/dispositivos/:id/usuarios-reloj', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  const { rows } = await q(`SELECT u.pin, u.nombre, u.tarjeta, u.password, u.privilegio, u.rostro, u.huella,
      e.id empleado_id, e.nombre empleado
    FROM usuarios_reloj u LEFT JOIN empleados e ON e.empresa_id=$2 AND e.pin=u.pin
    WHERE u.dispositivo_id=$1 ORDER BY length(u.pin), u.pin`, [d.id, d.empresa_id]);
  if (req.query.formato === 'xlsx') {
    const si = v => v ? 'Sí' : 'No';
    const file = xlsx('Usuarios',
      [['PIN', 10], ['Nombre', 30], ['Tarjeta', 14], ['Privilegio', 14], ['Clave', 10], ['Rostro', 9], ['Huella', 9], ['Estado en el panel', 34]],
      rows.map(u => [u.pin, u.nombre, u.tarjeta, PRIVILEGIO[u.privilegio] || `Nivel ${u.privilegio}`, u.password,
        si(u.rostro), si(u.huella), u.empleado_id ? `En el panel (${u.empleado})` : 'Nuevo']));
    res.setHeader('Content-Disposition', `attachment; filename="usuarios_${d.sn.replace(/[^\w-]/g, '')}.xlsx"`);
    return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(file);
  }
  const lectura = await one(`SELECT estado, retorno, creado, respondido FROM comandos
    WHERE dispositivo_id=$1 AND tipo='lectura' ORDER BY id DESC LIMIT 1`, [d.id]);
  const en_linea = !!d.ultimo_contacto && Date.now() - d.ultimo_contacto < cfg.ONLINE_SECONDS * 1000;
  res.json({ lectura, en_linea, usuarios: rows });
});
app.post('/api/dispositivos/:id/usuarios-reloj/agregar', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  if (!d.empresa_id) throw new HttpError(400, 'Asigna el equipo a una sucursal primero');
  const pines = [...new Set([].concat(req.body.pines || []).map(clean).filter(Boolean))];
  if (!pines.length) throw new HttpError(400, 'Selecciona al menos un usuario');
  // Ya existen en el reloj: se crean como empleados sincronizados, sin enviarle nada al equipo
  const { rows } = await q(`
    WITH nuevos AS (
      INSERT INTO empleados (empresa_id, pin, nombre, tarjeta, password, privilegio)
      SELECT $2, pin, COALESCE(NULLIF(nombre, ''), 'Usuario ' || pin), tarjeta, password, privilegio
      FROM usuarios_reloj WHERE dispositivo_id=$1 AND pin = ANY($3)
      ON CONFLICT (empresa_id, pin) DO NOTHING RETURNING id, pin)
    INSERT INTO empleado_dispositivo (empleado_id, dispositivo_id, estado, rostro, huella)
    SELECT n.id, $1, 'sincronizado', u.rostro, u.huella
    FROM nuevos n JOIN usuarios_reloj u ON u.dispositivo_id=$1 AND u.pin=n.pin
    RETURNING empleado_id`, [d.id, d.empresa_id, pines]);
  res.json({ agregados: rows.length, omitidos: pines.length - rows.length });
});
app.post('/api/dispositivos/:id/traer-marcaciones', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  await queueCmd(d.id, 'DATA QUERY ATTLOG StartTime=2000-01-01 00:00:00\tEndTime=2099-12-31 23:59:59', 'consulta');
  res.json({ ok: true });
});
app.post('/api/dispositivos/:id/reenviar', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  const { rows } = await q(`SELECT e.* FROM empleados e JOIN empleado_dispositivo ed ON ed.empleado_id=e.id
    WHERE ed.dispositivo_id=$1 AND ed.estado <> 'eliminando'`, [d.id]);
  for (const e of rows) {
    await queueCmd(d.id, cmdAlta(e), 'alta', e.id);
    await q(`UPDATE empleado_dispositivo SET estado='pendiente' WHERE empleado_id=$1 AND dispositivo_id=$2`, [e.id, d.id]);
  }
  res.json({ ok: true, enviados: rows.length });
});
app.get('/api/dispositivos/:id/comandos', async (req, res) => {
  const d = await getDevice(req, req.params.id);
  const { rows } = await q(`SELECT c.*, e.nombre empleado FROM comandos c LEFT JOIN empleados e ON e.id=c.empleado_id
    WHERE c.dispositivo_id=$1 ORDER BY c.id DESC LIMIT 50`, [d.id]);
  res.json(rows);
});

// Empleados
app.get('/api/empleados', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const suc = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
  const dev = req.query.dispositivo_id ? Number(req.query.dispositivo_id) : null;
  const buscar = req.query.buscar ? `%${req.query.buscar}%` : null;
  const { rows } = await q(`
    SELECT e.*, x.nombre empresa,
      COALESCE((SELECT json_agg(json_build_object('id',d.id,'nombre',d.nombre,'sn',d.sn,'tipo',d.tipo,
          'sucursal',s.nombre,'estado',ed.estado,'rostro',ed.rostro,'huella',ed.huella) ORDER BY d.nombre)
        FROM empleado_dispositivo ed JOIN dispositivos d ON d.id=ed.dispositivo_id
        LEFT JOIN sucursales s ON s.id=d.sucursal_id WHERE ed.empleado_id=e.id), '[]') dispositivos
    FROM empleados e JOIN empresas x ON x.id=e.empresa_id
    WHERE ($1::int IS NULL OR e.empresa_id=$1)
      AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM empleado_dispositivo ed JOIN dispositivos d ON d.id=ed.dispositivo_id
             WHERE ed.empleado_id=e.id AND d.sucursal_id=$2))
      AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM empleado_dispositivo ed WHERE ed.empleado_id=e.id AND ed.dispositivo_id=$3))
      AND ($4::text IS NULL OR e.nombre ILIKE $4 OR e.pin ILIKE $4 OR e.ci ILIKE $4)
    ORDER BY x.nombre, (CASE WHEN e.pin ~ '^[0-9]+$' THEN e.pin::bigint END), e.pin`, [emp, suc, dev, buscar]);
  res.json(rows);
});

async function validarDispositivos(empresa_id, ids) {
  ids = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (ids.length) {
    const { rows } = await q(`SELECT id FROM dispositivos WHERE id = ANY($1) AND empresa_id=$2`, [ids, empresa_id]);
    if (rows.length !== ids.length) throw new HttpError(400, 'Hay dispositivos que no son de esta empresa');
  }
  return ids;
}

// Evita pisar a otra persona: el PIN no debe existir ya en esos relojes como otro usuario
async function validarPinLibre(pin, dispositivos) {
  if (!dispositivos.length) return;
  const u = await one(`SELECT u.nombre, d.nombre equipo FROM usuarios_reloj u JOIN dispositivos d ON d.id=u.dispositivo_id
    WHERE u.pin=$1 AND u.dispositivo_id = ANY($2) LIMIT 1`, [pin, dispositivos]);
  if (u) throw new HttpError(409, `El PIN ${pin} ya lo usa ${u.nombre ? `"${u.nombre}"` : 'otro usuario'} en el reloj "${u.equipo}". ` +
    'Si es la misma persona, agrégala desde "Usuarios del reloj"; si no, elige otro PIN.');
}

// Mientras un cambio de PIN está en curso no se puede editar ni borrar al empleado
async function sinCambioEnCurso(empleado_id) {
  const r = await one(`SELECT 1 FROM comandos WHERE grupo LIKE $1 AND estado IN ('pendiente','enviado','espera')
    AND creado > now() - interval '15 minutes' LIMIT 1`, [`pin-${Number(empleado_id)}-%`]);
  if (r) throw new HttpError(409, 'Hay un cambio de PIN en curso para este empleado. Espera a que el reloj termine (unos segundos).');
}
// Equipos donde hay que cambiar el PIN (ver "Cambio de PIN sin perder biometría")
async function planCambioPin(prev, nuevoPin, ids) {
  await validarPinLibre(nuevoPin, ids);
  const { rows } = await q(`SELECT dispositivo_id FROM empleado_dispositivo
    WHERE empleado_id=$1 AND estado <> 'eliminando' AND dispositivo_id = ANY($2)`, [prev.id, ids]);
  return rows;
}
async function ejecutarCambioPin(prev, e, plan) {
  const op = `pin-${e.id}-${Date.now()}`;
  for (const { dispositivo_id } of plan) {
    const grupo = `${op}-d${dispositivo_id}`;
    for (const cmd of [`DATA QUERY USERINFO PIN=${prev.pin}`, `DATA QUERY FINGERTMP PIN=${prev.pin}`, `DATA QUERY BIODATA Type=9\tPIN=${prev.pin}`])
      await queueCmd(dispositivo_id, cmd, 'consulta', e.id, grupo);
    await queueCmd(dispositivo_id, `CAMBIAR PIN=${prev.pin} A PIN=${e.pin}`, 'cambio-pin', e.id, grupo, 'espera');
    await q(`UPDATE empleado_dispositivo SET estado='pendiente', actualizado=now() WHERE empleado_id=$1 AND dispositivo_id=$2`,
      [e.id, dispositivo_id]);
  }
}

async function aplicarDispositivos(req, empleado, ids, reenviarTodos, omitir = []) {
  ids = await validarDispositivos(empleado.empresa_id, ids);
  const actuales = (await q(`SELECT dispositivo_id FROM empleado_dispositivo WHERE empleado_id=$1 AND estado<>'eliminando'`,
    [empleado.id])).rows.map(r => r.dispositivo_id);
  for (const d of ids) {
    if ((!actuales.includes(d) || reenviarTodos) && !omitir.includes(d)) {
      await q(`INSERT INTO empleado_dispositivo (empleado_id,dispositivo_id,estado) VALUES ($1,$2,'pendiente')
               ON CONFLICT (empleado_id,dispositivo_id) DO UPDATE SET estado='pendiente', actualizado=now()`, [empleado.id, d]);
      await queueCmd(d, cmdAlta(empleado), 'alta', empleado.id);
    }
  }
  for (const d of actuales.filter(x => !ids.includes(x))) {
    await q(`UPDATE empleado_dispositivo SET estado='eliminando' WHERE empleado_id=$1 AND dispositivo_id=$2`, [empleado.id, d]);
    await queueCmd(d, cmdBaja(empleado.pin), 'baja', empleado.id);
  }
}

function datosEmpleado(b) {
  const pin = clean(b.pin);
  if (!/^\d{1,9}$/.test(pin)) throw new HttpError(400, 'El PIN debe ser numérico (hasta 9 dígitos)');
  if (!clean(b.nombre)) throw new HttpError(400, 'Nombre obligatorio');
  if (b.password && !/^\d{1,8}$/.test(clean(b.password))) throw new HttpError(400, 'La clave del reloj debe ser numérica (hasta 8 dígitos)');
  return [pin, clean(b.nombre), clean(b.ci), clean(b.telefono), clean(b.departamento), clean(b.cargo),
    clean(b.tarjeta), clean(b.password), Number(b.privilegio) === 14 ? 14 : 0];
}

app.post('/api/empleados', async (req, res) => {
  const empresa_id = isAdmin(req) ? Number(req.body.empresa_id) : req.user.empresa_id;
  if (!empresa_id) throw new HttpError(400, 'Elige la empresa');
  checkEmpresa(req, empresa_id);
  const datos = datosEmpleado(req.body);
  await validarPinLibre(datos[0], await validarDispositivos(empresa_id, req.body.dispositivos));
  const e = await one(`INSERT INTO empleados (empresa_id,pin,nombre,ci,telefono,departamento,cargo,tarjeta,password,privilegio)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [empresa_id, ...datos]);
  await aplicarDispositivos(req, e, req.body.dispositivos, false);
  res.json(e);
});

app.put('/api/empleados/:id', async (req, res) => {
  const prev = await one(`SELECT * FROM empleados WHERE id=$1`, [req.params.id]);
  if (!prev) throw new HttpError(404, 'No existe');
  checkEmpresa(req, prev.empresa_id);
  await sinCambioEnCurso(prev.id);
  const datos = datosEmpleado(req.body);
  const ids = await validarDispositivos(prev.empresa_id, req.body.dispositivos);
  const cambioPin = datos[0] !== prev.pin;
  if (cambioPin && (datos[6] !== clean(prev.tarjeta) || datos[7] !== clean(prev.password) || datos[8] !== (prev.privilegio == 14 ? 14 : 0)))
    throw new HttpError(400, 'Para no mezclar cambios, cambia primero solo el PIN y guarda. Luego edita la tarjeta, clave o privilegio.');
  const plan = cambioPin ? await planCambioPin(prev, datos[0], ids) : [];
  // pines_anteriores: sus marcaciones con el PIN viejo siguen apareciendo a su nombre
  const e = await one(`UPDATE empleados SET pin=$2,nombre=$3,ci=$4,telefono=$5,departamento=$6,cargo=$7,tarjeta=$8,password=$9,privilegio=$10,
      pines_anteriores = CASE WHEN pin <> $2 THEN array_append(array_remove(pines_anteriores, $2), pin) ELSE pines_anteriores END
    WHERE id=$1 RETURNING *`, [prev.id, ...datos]);
  if (cambioPin) {
    await ejecutarCambioPin(prev, e, plan);
    // Equipos que se quitaron en esta misma edición: ahí existe el PIN anterior
    const { rows } = await q(`UPDATE empleado_dispositivo SET estado='eliminando'
      WHERE empleado_id=$1 AND estado<>'eliminando' AND NOT (dispositivo_id = ANY($2)) RETURNING dispositivo_id`, [e.id, ids]);
    for (const r of rows) await queueCmd(r.dispositivo_id, cmdBaja(prev.pin), 'baja', e.id);
  }
  await aplicarDispositivos(req, e, ids, true, plan.map(p => p.dispositivo_id));
  res.json(e);
});

app.delete('/api/empleados/:id', async (req, res) => {
  const e = await one(`SELECT * FROM empleados WHERE id=$1`, [req.params.id]);
  if (!e) throw new HttpError(404, 'No existe');
  checkEmpresa(req, e.empresa_id);
  await sinCambioEnCurso(e.id);
  const { rows } = await q(`SELECT dispositivo_id FROM empleado_dispositivo WHERE empleado_id=$1`, [e.id]);
  for (const r of rows) await queueCmd(r.dispositivo_id, cmdBaja(e.pin), 'baja', null);
  await q(`DELETE FROM empleados WHERE id=$1`, [e.id]);
  res.json({ ok: true, equipos: rows.length });
});

// Marcaciones
app.get('/api/marcaciones', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const p = [emp,
    req.query.sucursal_id ? Number(req.query.sucursal_id) : null,
    req.query.dispositivo_id ? Number(req.query.dispositivo_id) : null,
    req.query.desde || null, req.query.hasta || null,
    req.query.buscar ? `%${req.query.buscar}%` : null,
    Math.min(Number(req.query.limit) || 500, 20000)];
  const { rows } = await q(`
    SELECT m.id, to_char(m.fecha,'YYYY-MM-DD HH24:MI:SS') fecha, m.pin, m.estado, m.verificacion, m.sn,
      d.nombre dispositivo, d.tipo, s.nombre sucursal, x.nombre empresa,
      e.nombre empleado, e.departamento, e.cargo
    FROM marcaciones m
    LEFT JOIN dispositivos d ON d.id=m.dispositivo_id
    LEFT JOIN sucursales s ON s.id=d.sucursal_id
    LEFT JOIN empresas x ON x.id=d.empresa_id
    LEFT JOIN LATERAL (SELECT em.nombre, em.departamento, em.cargo FROM empleados em
      WHERE em.empresa_id=d.empresa_id AND (em.pin=m.pin OR m.pin = ANY(em.pines_anteriores))
      ORDER BY em.pin=m.pin DESC LIMIT 1) e ON TRUE
    WHERE d.empresa_id IS NOT NULL AND ($1::int IS NULL OR d.empresa_id=$1)
      AND ($2::int IS NULL OR d.sucursal_id=$2) AND ($3::int IS NULL OR d.id=$3)
      AND ($4::date IS NULL OR m.fecha >= $4::date) AND ($5::date IS NULL OR m.fecha < $5::date + 1)
      AND ($6::text IS NULL OR e.nombre ILIKE $6 OR m.pin ILIKE $6)
    ORDER BY m.fecha DESC LIMIT $7`, p);
  if (req.query.formato === 'csv') {
    const cols = ['fecha', 'pin', 'empleado', 'departamento', 'cargo', 'empresa', 'sucursal', 'dispositivo', 'tipo', 'sn', 'verificacion'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '﻿' + cols.join(';') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(';')).join('\n');
    res.setHeader('Content-Disposition', 'attachment; filename="marcaciones.csv"');
    return res.type('text/csv').send(csv);
  }
  res.json(rows);
});

// Usuarios del sistema (logins)
app.get('/api/usuarios-sistema', async (req, res) => {
  soloAdmin(req);
  const { rows } = await q(`SELECT u.id,u.email,u.nombre,u.rol,u.empresa_id,e.nombre empresa,u.creado
    FROM usuarios_sistema u LEFT JOIN empresas e ON e.id=u.empresa_id ORDER BY u.rol, e.nombre, u.email`);
  res.json(rows);
});
app.post('/api/usuarios-sistema', async (req, res) => {
  soloAdmin(req);
  const { email, nombre, password, rol = 'empresa', empresa_id } = req.body;
  if (!clean(email) || !password || password.length < 6) throw new HttpError(400, 'Correo y contraseña (mín. 6) obligatorios');
  if (rol === 'empresa' && !empresa_id) throw new HttpError(400, 'Elige la empresa');
  res.json(await one(`INSERT INTO usuarios_sistema (email,nombre,hash,rol,empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING id,email`,
    [clean(email).toLowerCase(), clean(nombre), hashPass(password), rol === 'admin' ? 'admin' : 'empresa', rol === 'admin' ? null : empresa_id]));
});
app.put('/api/usuarios-sistema/:id/password', async (req, res) => {
  soloAdmin(req);
  if (!req.body.password || req.body.password.length < 6) throw new HttpError(400, 'Mínimo 6 caracteres');
  await q(`UPDATE usuarios_sistema SET hash=$2 WHERE id=$1`, [req.params.id, hashPass(req.body.password)]);
  res.json({ ok: true });
});
app.delete('/api/usuarios-sistema/:id', async (req, res) => {
  soloAdmin(req);
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'No puedes eliminar tu propio usuario');
  await q(`DELETE FROM usuarios_sistema WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// Dashboard (archivos estáticos)
app.use(express.static(path.join(__dirname, 'public')));

// Errores
app.use((err, req, res, next) => {
  let status = err.status || 500, msg = err.message;
  if (err.code === '23505') { status = 409; msg = 'Ya existe un registro con ese dato (PIN, correo o número de serie repetido)'; }
  if (status === 500) log('❌', req.method, req.originalUrl, err.stack || err);
  if (req.path.startsWith('/iclock')) return res.type('text/plain').send('OK');
  res.status(status).json({ error: msg });
});

ensureDatabase()
  .then(() => app.listen(cfg.PORT, '0.0.0.0', () =>
    log(`BioPanel escuchando en puerto ${cfg.PORT} → abre http://localhost:${cfg.PORT}`)))
  .catch(e => {
    console.error('\n❌ No pude conectar a PostgreSQL:', e.message);
    console.error('   Revisa DATABASE_URL en config.js (usuario, contraseña y puerto de PostgreSQL).\n');
    process.exit(1);
  });
