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
require('pg').types.setTypeParser(1082, v => v); // DATE como 'AAAA-MM-DD', sin pasar por zonas horarias
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
-- Fecha de ingreso: antes de ella no se cuentan faltas (vacía = la fecha en que se registró en el panel)
ALTER TABLE empleados ADD COLUMN IF NOT EXISTS ingreso DATE;
ALTER TABLE usuarios_sistema ADD COLUMN IF NOT EXISTS perfil TEXT NOT NULL DEFAULT 'administrador'
  CHECK (perfil IN ('administrador','consulta'));
-- Turnos: catálogo de cada empresa. Horas "de reloj": una hora menor que la entrada es del día siguiente
-- (un turno de 22:00 a 06:00 termina al otro día y pertenece al día en que empieza). marca_desde/marca_hasta:
-- entre qué horas una marcación se toma como de este turno. Descanso (opcional, flexible): puede salir desde
-- descanso_desde, dura descanso_min y, si vuelve después de descanso_limite, falta a la 2.ª parte del turno.
-- vale: cuánto de un día es (una falta resta eso). fuera: qué hacer con marcaciones fuera de marca_desde/hasta.
CREATE TABLE IF NOT EXISTS turnos (
  id SERIAL PRIMARY KEY, empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'teal', vale NUMERIC(3,1) NOT NULL DEFAULT 1 CHECK (vale > 0 AND vale <= 3),
  entrada TIME NOT NULL, salida TIME NOT NULL, limite_falta TIME NOT NULL, marca_desde TIME NOT NULL, marca_hasta TIME NOT NULL,
  tolerancia INT NOT NULL DEFAULT 0 CHECK (tolerancia BETWEEN 0 AND 240),
  descanso_desde TIME, descanso_min INT CHECK (descanso_min BETWEEN 1 AND 600), descanso_limite TIME,
  fuera TEXT NOT NULL DEFAULT 'sin_turno' CHECK (fuera IN ('sin_turno','trabajadas')),
  creado TIMESTAMPTZ DEFAULT now(), UNIQUE (empresa_id, nombre));
-- Horarios semanales: qué turno toca cada día (0 = domingo … 6 = sábado). Un día sin fila es libre.
-- (tolerancia y las horas por día son de la versión anterior: ahora van en el turno; se conservan sin usarse.)
CREATE TABLE IF NOT EXISTS horarios (
  id SERIAL PRIMARY KEY, empresa_id INT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL, tolerancia INT NOT NULL DEFAULT 0 CHECK (tolerancia BETWEEN 0 AND 240),
  creado TIMESTAMPTZ DEFAULT now(), UNIQUE (empresa_id, nombre));
CREATE TABLE IF NOT EXISTS horario_dias (
  horario_id INT REFERENCES horarios(id) ON DELETE CASCADE, dia SMALLINT NOT NULL CHECK (dia BETWEEN 0 AND 6),
  turno_id INT REFERENCES turnos(id), entrada TIME, salida TIME, limite_falta TIME,
  PRIMARY KEY (horario_id, dia));
ALTER TABLE horario_dias ADD COLUMN IF NOT EXISTS turno_id INT REFERENCES turnos(id);
ALTER TABLE horario_dias DROP CONSTRAINT IF EXISTS horario_dias_check;
ALTER TABLE horario_dias ALTER COLUMN entrada DROP NOT NULL, ALTER COLUMN salida DROP NOT NULL, ALTER COLUMN limite_falta DROP NOT NULL;
-- Horario principal de cada empresa desde una fecha: rige para todo su personal (NULL = sin horario desde esa fecha).
-- Cambiarlo desde una fecha no altera los días anteriores.
CREATE TABLE IF NOT EXISTS empresa_horario (
  empresa_id INT REFERENCES empresas(id) ON DELETE CASCADE, desde DATE NOT NULL,
  horario_id INT REFERENCES horarios(id), PRIMARY KEY (empresa_id, desde));
-- Excepciones por empleado desde una fecha. modo: 'horario' (uno propio), 'sin_horario' (no se le controla)
-- o 'empresa' (vuelve al horario de su empresa).
CREATE TABLE IF NOT EXISTS empleado_horario (
  empleado_id INT REFERENCES empleados(id) ON DELETE CASCADE, desde DATE NOT NULL,
  horario_id INT REFERENCES horarios(id), PRIMARY KEY (empleado_id, desde));
ALTER TABLE empleado_horario ADD COLUMN IF NOT EXISTS modo TEXT NOT NULL DEFAULT 'horario';
UPDATE empleado_horario SET modo='sin_horario' WHERE modo='horario' AND horario_id IS NULL;
-- Horario que rige para un empleado un día: su excepción si la tiene; si no, el de su empresa.
-- (Los reportes hacen lo mismo en contextoHorarios, para muchos días a la vez.)
CREATE OR REPLACE FUNCTION horario_vigente(p_empleado INT, p_dia DATE) RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN ex.modo = 'horario' THEN ex.horario_id WHEN ex.modo = 'sin_horario' THEN NULL
    ELSE (SELECT eh.horario_id FROM empresa_horario eh JOIN empleados e ON e.empresa_id = eh.empresa_id
          WHERE e.id = p_empleado AND eh.desde <= p_dia ORDER BY eh.desde DESC LIMIT 1) END
  FROM (SELECT 1) uno LEFT JOIN LATERAL (SELECT modo, horario_id FROM empleado_horario
    WHERE empleado_id = p_empleado AND desde <= p_dia ORDER BY desde DESC LIMIT 1) ex ON TRUE
$$;
-- Feriados: empresa_id NULL = nacional (todas las empresas)
CREATE TABLE IF NOT EXISTS feriados (
  id SERIAL PRIMARY KEY, empresa_id INT REFERENCES empresas(id) ON DELETE CASCADE,
  fecha DATE NOT NULL, nombre TEXT NOT NULL, UNIQUE NULLS NOT DISTINCT (empresa_id, fecha));
-- Intentos fallidos de inicio de sesión, por correo (exista o no la cuenta)
CREATE TABLE IF NOT EXISTS intentos_login (
  email TEXT PRIMARY KEY, fallidos INT NOT NULL DEFAULT 0, bloqueado_hasta TIMESTAMPTZ, ultimo TIMESTAMPTZ NOT NULL DEFAULT now());
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
  await migrarHorariosATurnos();
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
// Para un correo que no existe se verifica igual contra esta clave: tarda lo mismo y no delata qué correos existen
const HASH_FALSO = hashPass(crypto.randomBytes(16).toString('hex'));
// Claves nuevas: mínimo 8 caracteres, con letras y números. Las que ya existen siguen sirviendo.
function validarClave(p) {
  p = String(p ?? '');
  if (p.length < 8 || p.length > 128 || !/\p{L}/u.test(p) || !/\d/.test(p))
    throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres, con letras y números');
  return p;
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
// Libro con una o varias hojas: [{ nombre, columnas, filas, encabezado?, horizontal? }].
// columnas: [[titulo, ancho, tipo?], ...] (máx. 26); filas: arrays de valores. El texto se guarda como texto
// para que Excel no quite ceros a la izquierda en PIN o tarjeta; los números, como números. Tipos de columna:
// 'horas' = minutos que se muestran como [h]:mm (Excel puede sumarlas); 'fecha' = 'AAAA-MM-DD' y 'hora' = 'HH:MM:SS',
// que se guardan como fecha y hora de Excel para ordenar y filtrar bien.
// encabezado: filas de texto sobre la tabla (la primera en negrita); horizontal: se imprime apaisada y a lo ancho.
// Títulos de la tabla en azul oscuro con letra blanca y celdas con borde.
function libroXlsx(hojas) {
  const x = v => String(v ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const col = i => String.fromCharCode(65 + i);
  // Estilos (cellXfs): 0 normal, 1 título de columna, 2 horas, 3 negrita, 4 dato con borde, 5 fecha, 6 hora
  const ESTILO_TIPO = { horas: 2, fecha: 5, hora: 6 };
  const numero = (v, tipo) => tipo === 'horas' ? v / 1440 :
    tipo === 'fecha' ? Date.parse(v + 'T00:00:00Z') / 864e5 + 25569 :
    tipo === 'hora' ? String(v).split(':').reduce((a, n) => a * 60 + Number(n), 0) / 86400 : v;
  const celda = (v, ref, s, tipo) => {
    if (s === 4) s = ESTILO_TIPO[tipo] || 4;
    if (v == null || v === '') return s ? `<c r="${ref}" s="${s}"/>` : ''; // vacía, pero con su borde
    const n = numero(v, tipo); // un texto en una columna de horas o fechas (p. ej. "Totales") queda como texto
    if (typeof n === 'number' && Number.isFinite(n)) return `<c r="${ref}" s="${s}"><v>${n}</v></c>`;
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  };
  const fila = (vals, r, s, tipos = [], attrs = '') =>
    `<row r="${r}"${attrs}>` + vals.map((v, i) => celda(v, col(i) + r, s, tipos[i])).join('') + '</row>';
  // Nombres de hoja: máx. 31 caracteres, sin \ / ? * [ ] : y sin repetirse
  const usados = new Set();
  const nombreHoja = n => {
    const base = String(n).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Hoja';
    let s = base;
    for (let i = 2; usados.has(s.toLowerCase()); i++) s = `${base.slice(0, 27)} (${i})`;
    usados.add(s.toLowerCase());
    return s;
  };
  const hs = hojas.map(h => {
    const encabezado = h.encabezado || [], ini = encabezado.length ? encabezado.length + 2 : 1; // fila de títulos
    return { ...h, nombre: nombreHoja(h.nombre), encabezado, ini, ultima: col(h.columnas.length - 1), fin: ini + h.filas.length };
  });
  const NS = 'http://schemas.openxmlformats.org', XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const archivos = {
    '[Content_Types].xml': `${XML}<Types xmlns="${NS}/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>` +
      hs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.worksheet+xml"/>`).join('') +
      `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${NS}/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships">` +
      `<sheets>${hs.map((h, i) => `<sheet name="${x(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      `<definedNames>${hs.map((h, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">` +
        `'${x(h.nombre).replace(/'/g, "''")}'!$A$${h.ini}:$${h.ultima}$${h.fin}</definedName>`).join('')}</definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${NS}/package/2006/relationships">` +
      hs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${hs.length + 1}" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="${NS}/spreadsheetml/2006/main">` +
      `<numFmts count="3"><numFmt numFmtId="164" formatCode="[h]:mm"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>` +
      `<numFmt numFmtId="166" formatCode="hh:mm:ss"/></numFmts>` +
      `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>` +
      `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>` +
      ['left', 'right', 'top', 'bottom'].map(l => `<${l} style="thin"><color rgb="FFBFBFBF"/></${l}>`).join('') + '<diagonal/></border></borders>' +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">` +
      `<alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>` +
      `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>` +
      `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>` +
      `<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
  hs.forEach((h, i) => {
    archivos[`xl/worksheets/sheet${i + 1}.xml`] = `${XML}<worksheet xmlns="${NS}/spreadsheetml/2006/main">` +
      (h.horizontal ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '') +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${h.ini}" topLeftCell="A${h.ini + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols>${h.columnas.map(([, w], k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>${h.encabezado.map((f, k) => fila(f, k + 1, k ? 0 : 3)).join('')}` +
      fila(h.columnas.map(c => c[0]), h.ini, 1, [], ' ht="32" customHeight="1"') +
      `${h.filas.map((f, k) => fila(f, h.ini + k + 1, 4, h.columnas.map(c => c[2]))).join('')}</sheetData>` +
      `<autoFilter ref="A${h.ini}:${h.ultima}${h.fin}"/>` +
      (h.horizontal ? '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' : '') + '</worksheet>';
  });
  return zip(archivos);
}
function enviarLibro(res, archivo, hojas) {
  res.setHeader('Content-Disposition', `attachment; filename="${archivo.replace(/[^\w-]/g, '')}.xlsx"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(libroXlsx(hojas));
}
const enviarXlsx = (res, archivo, hoja, columnas, filas) => enviarLibro(res, archivo, [{ nombre: hoja, columnas, filas }]);

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
// Bloqueo por intentos: 5 claves mal seguidas bloquean ese correo 15 minutos (los dos paneles). El intento se cuenta
// antes de revisar la clave, así varios pedidos a la vez no consiguen más de 5. Una entrada correcta borra la cuenta;
// fallos de hace más de 15 minutos ya no suman. Todo es igual exista o no el correo.
const MAX_INTENTOS = 5, BLOQUEO_MIN = 15;
const minutosRestantes = hasta => Math.max(1, Math.ceil((new Date(hasta) - Date.now()) / 60000));
const errorBloqueo = hasta => new HttpError(429, `Por seguridad, la cuenta está bloqueada por ${MAX_INTENTOS} intentos fallidos. ` +
  `Vuelve a intentar en ${minutosRestantes(hasta)} min, o pide a un administrador que la desbloquee.`);

app.post('/api/login', async (req, res) => {
  const { password, panel } = req.body || {};
  const correo = clean(req.body?.email).toLowerCase();
  if (!correo || !password) throw new HttpError(400, 'Escribe tu correo y tu contraseña');
  const intento = await one(`
    INSERT INTO intentos_login AS i (email, fallidos) VALUES ($1, 1)
    ON CONFLICT (email) DO UPDATE SET
      fallidos = CASE WHEN i.bloqueado_hasta > now() THEN i.fallidos
        WHEN i.bloqueado_hasta IS NOT NULL OR i.ultimo < now() - make_interval(mins => $2) THEN 1 ELSE i.fallidos + 1 END,
      bloqueado_hasta = CASE WHEN i.bloqueado_hasta > now() THEN i.bloqueado_hasta END,
      ultimo = CASE WHEN i.bloqueado_hasta > now() THEN i.ultimo ELSE now() END
    RETURNING fallidos, bloqueado_hasta`, [correo, BLOQUEO_MIN]);
  if (intento.bloqueado_hasta) throw errorBloqueo(intento.bloqueado_hasta);
  const bloquear = () => one(`UPDATE intentos_login SET bloqueado_hasta = now() + make_interval(mins => $2)
    WHERE email=$1 AND bloqueado_hasta IS NULL RETURNING bloqueado_hasta`, [correo, BLOQUEO_MIN]);
  if (intento.fallidos > MAX_INTENTOS) { await bloquear(); throw errorBloqueo(Date.now() + BLOQUEO_MIN * 60e3); }
  const u = await one(`SELECT * FROM usuarios_sistema WHERE lower(email)=$1`, [correo]);
  const correcta = String(password).length <= 128 && checkPass(password, u ? u.hash : HASH_FALSO) && !!u;
  if (!correcta) {
    const quedan = MAX_INTENTOS - intento.fallidos;
    if (quedan <= 0) { await bloquear(); throw errorBloqueo(Date.now() + BLOQUEO_MIN * 60e3); }
    throw new HttpError(401, `Correo o contraseña incorrectos. ${quedan === 1 ? 'Te queda 1 intento' : `Te quedan ${quedan} intentos`} ` +
      `antes de que la cuenta se bloquee ${BLOQUEO_MIN} minutos.`);
  }
  await q(`DELETE FROM intentos_login WHERE email=$1`, [correo]);
  // Cada panel tiene su link: la plataforma entra por /admin y las empresas por /clientes
  if (panel !== (u.rol === 'admin' ? 'admin' : 'clientes'))
    throw new HttpError(403, u.rol === 'admin' ? 'Este acceso es de administrador: entra por /admin' : 'Este acceso es de cliente: entra por /clientes');
  const token = signToken({ id: u.id, rol: u.rol, empresa_id: u.empresa_id, exp: Date.now() + 12 * 3600e3 });
  res.json({ token });
});

app.use('/api', async (req, res, next) => {
  const t = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!t) throw new HttpError(401, 'Sesión expirada, vuelve a entrar');
  // Se lee el usuario en cada pedido: si lo eliminan o le cambian el perfil, se aplica al instante
  req.user = await one(`SELECT id, rol, empresa_id, perfil FROM usuarios_sistema WHERE id=$1`, [t.id]);
  if (!req.user) throw new HttpError(401, 'Sesión expirada, vuelve a entrar');
  next();
});
const isAdmin = req => req.user.rol === 'admin';
const soloAdmin = (req) => { if (!isAdmin(req)) throw new HttpError(403, 'Solo el administrador'); };
// Empleados y usuarios de la empresa: la plataforma o un usuario de la empresa con perfil "administrador"
const soloEditor = req => {
  if (!isAdmin(req) && req.user.perfil !== 'administrador') throw new HttpError(403, 'Tu perfil es de solo consulta');
};
// Empresa efectiva para filtros: admin puede elegir (o todas), empresa ve la suya
const empresaScope = (req, pedida) => isAdmin(req) ? (pedida ? Number(pedida) : null) : req.user.empresa_id;
const checkEmpresa = (req, empresa_id) => {
  if (!isAdmin(req) && Number(empresa_id) !== Number(req.user.empresa_id)) throw new HttpError(403, 'No autorizado');
};

app.get('/api/me', async (req, res) => {
  const u = await one(`SELECT u.id,u.email,u.nombre,u.rol,u.perfil,u.empresa_id,e.nombre empresa
    FROM usuarios_sistema u LEFT JOIN empresas e ON e.id=u.empresa_id WHERE u.id=$1`, [req.user.id]);
  // Si server.js o config.js cambiaron después de arrancar, el reloj sigue recibiendo órdenes del código viejo
  if (isAdmin(req)) u.desactualizado = ['server.js', 'config.js'].some(f => fs.statSync(path.join(__dirname, f)).mtimeMs > ARRANQUE);
  u.soporte = cfg.SOPORTE || null;
  res.json(u);
});
app.post('/api/me/password', async (req, res) => {
  const { actual, nueva } = req.body;
  const u = await one(`SELECT * FROM usuarios_sistema WHERE id=$1`, [req.user.id]);
  if (!checkPass(actual || '', u.hash)) throw new HttpError(400, 'La contraseña actual no es correcta');
  await q(`UPDATE usuarios_sistema SET hash=$2 WHERE id=$1`, [u.id, hashPass(validarClave(nueva))]);
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
// El cliente solo ve sus sucursales; crearlas y cambiarlas es de la plataforma
app.post('/api/sucursales', async (req, res) => {
  soloAdmin(req);
  const { empresa_id } = req.body;
  if (!empresa_id || !clean(req.body.nombre)) throw new HttpError(400, 'Empresa y nombre obligatorios');
  res.json(await one(`INSERT INTO sucursales (empresa_id,nombre,direccion) VALUES ($1,$2,$3) RETURNING *`,
    [empresa_id, clean(req.body.nombre), clean(req.body.direccion)]));
});
app.put('/api/sucursales/:id', async (req, res) => {
  soloAdmin(req);
  const s = await one(`SELECT * FROM sucursales WHERE id=$1`, [req.params.id]);
  if (!s) throw new HttpError(404, 'No existe');
  res.json(await one(`UPDATE sucursales SET nombre=$2, direccion=$3 WHERE id=$1 RETURNING *`,
    [s.id, clean(req.body.nombre), clean(req.body.direccion)]));
});
app.delete('/api/sucursales/:id', async (req, res) => {
  soloAdmin(req);
  const s = await one(`SELECT * FROM sucursales WHERE id=$1`, [req.params.id]);
  if (!s) throw new HttpError(404, 'No existe');
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

// Los relojes los administra solo la plataforma: el cliente únicamente obtiene la lista (sin datos técnicos),
// que usa para el resumen, los filtros y para elegir en qué relojes va cada empleado
const DEV_TECNICOS = ['sn', 'ip', 'firmware', 'info', 'cmd_pendientes', 'usuarios_nuevos'];
app.use('/api/dispositivos', (req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/') soloAdmin(req);
  next();
});

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
  if (!isAdmin(req)) rows.forEach(d => DEV_TECNICOS.forEach(k => delete d[k]));
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
    return enviarXlsx(res, `usuarios_${d.sn}`, 'Usuarios',
      [['PIN', 10], ['Nombre', 30], ['Tarjeta', 14], ['Privilegio', 14], ['Clave', 10], ['Rostro', 9], ['Huella', 9], ['Estado en el panel', 34]],
      rows.map(u => [u.pin, u.nombre, u.tarjeta, PRIVILEGIO[u.privilegio] || `Nivel ${u.privilegio}`, u.password,
        si(u.rostro), si(u.huella), u.empleado_id ? `En el panel (${u.empleado})` : 'Nuevo']));
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
      (SELECT nombre FROM horarios WHERE id = horario_vigente(e.id, (now() AT TIME ZONE 'America/La_Paz')::date)) horario,
      COALESCE((SELECT modo FROM empleado_horario WHERE empleado_id=e.id
         AND desde <= (now() AT TIME ZONE 'America/La_Paz')::date ORDER BY desde DESC LIMIT 1) <> 'empresa', false) horario_propio,
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
  if (!isAdmin(req)) rows.forEach(e => e.dispositivos.forEach(d => delete d.sn));
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
    clean(b.tarjeta), clean(b.password), Number(b.privilegio) === 14 ? 14 : 0, b.ingreso ? fechaParam(b.ingreso, 'de ingreso') : null];
}

app.post('/api/empleados', async (req, res) => {
  soloEditor(req);
  const empresa_id = isAdmin(req) ? Number(req.body.empresa_id) : req.user.empresa_id;
  if (!empresa_id) throw new HttpError(400, 'Elige la empresa');
  checkEmpresa(req, empresa_id);
  const datos = datosEmpleado(req.body);
  await validarPinLibre(datos[0], await validarDispositivos(empresa_id, req.body.dispositivos));
  const e = await one(`INSERT INTO empleados (empresa_id,pin,nombre,ci,telefono,departamento,cargo,tarjeta,password,privilegio,ingreso)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [empresa_id, ...datos]);
  await aplicarDispositivos(req, e, req.body.dispositivos, false);
  res.json(e);
});

app.put('/api/empleados/:id', async (req, res) => {
  soloEditor(req);
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
  const e = await one(`UPDATE empleados SET pin=$2,nombre=$3,ci=$4,telefono=$5,departamento=$6,cargo=$7,tarjeta=$8,password=$9,privilegio=$10,ingreso=$11,
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
  soloEditor(req);
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
  if (!isAdmin(req)) rows.forEach(r => delete r.sn);
  res.json(rows); // el Excel de esta pantalla es el del reporte de marcaciones
});

// ---------------- Reportes de asistencia ----------------
// Jornada = un empleado en un día. Entrada = 1.ª marcación; salida = la última. Con 4 o más marcaciones,
// la 2.ª y la 3.ª son el almuerzo y se descuentan. Una marcación a menos de 2 min de la anterior es repetida.
// La jornada se cuenta en la sucursal donde marcó la entrada.
const REPETIDA_SEG = 120;
const DIA_SEM = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const numId = v => Number(v) || null;
const fechaBO = d => d.split('-').reverse().join('/');
const diaSem = d => DIA_SEM[new Date(d + 'T00:00:00Z').getUTCDay()];

function fechaParam(v, nombre) {
  const d = new Date(String(v) + 'T00:00:00Z'); // un mes 13 da fecha inválida; un 31/02 pasa a marzo: ambas se rechazan
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '') || isNaN(d) || d.toISOString().slice(0, 10) !== v)
    throw new HttpError(400, `La fecha ${nombre} no es válida`);
  return v;
}
function rangoParam(query) {
  const desde = fechaParam(query.desde, '"desde"'), hasta = fechaParam(query.hasta, '"hasta"');
  const dias = (Date.parse(hasta) - Date.parse(desde)) / 864e5;
  if (dias < 0) throw new HttpError(400, '"Desde" no puede ser posterior a "Hasta"');
  if (dias > 366) throw new HttpError(400, 'El rango máximo es de un año');
  return { desde, hasta };
}

// Tiempos: un día es su número desde 1970 y una marcación, segundos desde ese origen; así un turno puede cruzar la medianoche.
const segHora = h => { const [a, b, c] = h.split(':').map(Number); return a * 3600 + b * 60 + (c || 0); };
const diaNum = d => Date.parse(d + 'T00:00:00Z') / 864e5;
const numDia = n => new Date(n * 864e5).toISOString().slice(0, 10);
const hhmm = min => { const x = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

// ts: segundos de las marcaciones de una jornada, en orden. Entrada = la primera, salida = la última; con 4 o más,
// la 2.ª y la 3.ª son el descanso y se descuenta. Las repetidas (menos de 2 min de la anterior que cuenta) no cuentan.
function calcularJornada(ts) {
  const t = [];
  for (const s of ts) if (!t.length || s - t[t.length - 1] >= REPETIDA_SEG) t.push(s);
  const n = t.length, min = (a, b) => Math.round((b - a) / 60), hm = s => hhmm(Math.floor(s / 60));
  const total = n < 2 ? null : min(t[0], t[n - 1]), descanso = n >= 4 ? min(t[1], t[2]) : null;
  return {
    entrada: hm(t[0]), salida: n > 1 ? hm(t[n - 1]) : null,
    descanso_ini: n >= 4 ? hm(t[1]) : null, descanso_fin: n >= 4 ? hm(t[2]) : null, descanso,
    almuerzo: n >= 4 ? `${hm(t[1])}–${hm(t[2])}` : null,
    total, minutos: total == null ? null : total - (descanso || 0),
  };
}

// Marcaciones de [desde − 1, hasta + 1]: los días de al lado traen las de los turnos de noche que entran o salen del rango.
// Filtros opcionales por persona (empleado_id, o pin si no está en el panel).
async function marcasCrudas(emp, desde, hasta, { empleado_id = null, pin = null } = {}) {
  const { rows } = await q(`
    SELECT d.empresa_id, x.nombre empresa, e.id empleado_id, COALESCE(e.pin, m.pin) pin, e.nombre, e.ci, e.departamento, e.cargo, e.alta,
      to_char(m.fecha, 'YYYY-MM-DD') dia, to_char(m.fecha, 'HH24:MI:SS') hora, m.verificacion,
      d.id dispositivo_id, d.nombre dispositivo, d.sucursal_id, s.nombre sucursal
    FROM marcaciones m
    JOIN dispositivos d ON d.id=m.dispositivo_id
    JOIN empresas x ON x.id=d.empresa_id
    LEFT JOIN sucursales s ON s.id=d.sucursal_id
    LEFT JOIN LATERAL (SELECT em.id, em.pin, em.nombre, em.ci, em.departamento, em.cargo,
        COALESCE(em.ingreso, (em.creado AT TIME ZONE 'America/La_Paz')::date)::text alta FROM empleados em
      WHERE em.empresa_id=d.empresa_id AND (em.pin=m.pin OR m.pin = ANY(em.pines_anteriores))
      ORDER BY em.pin=m.pin DESC LIMIT 1) e ON TRUE
    WHERE ($1::int IS NULL OR d.empresa_id=$1) AND m.fecha >= $2::date - 1 AND m.fecha < $3::date + 2
      AND ($4::int IS NULL OR e.id=$4) AND ($5::text IS NULL OR (e.id IS NULL AND m.pin=$5))
    ORDER BY m.fecha, m.id`, [emp, desde, hasta, empleado_id, pin]);
  for (const r of rows) {
    r.clave = r.empleado_id ? `e${r.empleado_id}` : `p${r.empresa_id}-${r.pin}`;
    r.t = diaNum(r.dia) * 86400 + segHora(r.hora);
  }
  return rows;
}

// Empleados que se espera ver: los activos de la empresa y, si se filtra por sucursal, con equipos en ella
async function esperados(emp, suc) {
  const { rows } = await q(`
    SELECT 'e' || e.id clave, e.id empleado_id, e.empresa_id, x.nombre empresa, e.pin, e.nombre, e.ci, e.departamento, e.cargo,
      COALESCE(e.ingreso, (e.creado AT TIME ZONE 'America/La_Paz')::date)::text alta,
      (SELECT string_agg(DISTINCT s.nombre, ', ') FROM empleado_dispositivo ed JOIN dispositivos d ON d.id=ed.dispositivo_id
         JOIN sucursales s ON s.id=d.sucursal_id WHERE ed.empleado_id=e.id AND ed.estado<>'eliminando') sucursal
    FROM empleados e JOIN empresas x ON x.id=e.empresa_id
    WHERE e.activo AND ($1::int IS NULL OR e.empresa_id=$1)
      AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM empleado_dispositivo ed JOIN dispositivos d ON d.id=ed.dispositivo_id
             WHERE ed.empleado_id=e.id AND ed.estado<>'eliminando' AND d.sucursal_id=$2))`, [emp, suc]);
  return rows;
}

// Por empresa y nombre; los PIN no registrados en el panel, al final
const porNombre = (a, b) => a.empresa.localeCompare(b.empresa) || !a.nombre - !b.nombre ||
  (a.nombre || '').localeCompare(b.nombre || '') || a.pin.localeCompare(b.pin, undefined, { numeric: true });

// ---------------- Asistencia contra el horario ----------------
// Por día: retraso = minutos desde la hora de entrada, solo si pasa la tolerancia; llegar después del límite
// (o no marcar en un día laboral) es 1 día de falta; salida anticipada = minutos antes de la salida del horario.
// Los días libres, los feriados y lo que todavía no pasó (hoy antes del límite, días futuros) no cuentan falta.
const aHoras = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const ahoraBO = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/La_Paz' }); // 'AAAA-MM-DD HH:MM:SS'

// Las horas de un turno en minutos desde las 00:00 del día en que empieza (E entrada, L límite de falta, S salida,
// eD/sH desde y hasta cuándo acepta marcar, dD/dL/dur el descanso). Una hora menor que la entrada es del día siguiente;
// "acepta desde", mayor que la entrada, del día anterior.
function horasTurno(t) {
  const E = aMin(t.entrada), despues = h => { const m = aMin(h); return m < E ? m + 1440 : m; };
  const S = aMin(t.salida) <= E ? aMin(t.salida) + 1440 : aMin(t.salida);
  let sH = despues(t.marca_hasta); if (sH < S) sH += 1440;
  const eD = aMin(t.marca_desde) > E ? aMin(t.marca_desde) - 1440 : aMin(t.marca_desde);
  const dur = t.descanso_min ? Number(t.descanso_min) : 0;
  return { E, S, L: despues(t.limite_falta), eD, sH, dur, dD: dur ? despues(t.descanso_desde) : null, dL: dur ? despues(t.descanso_limite) : null };
}
const aMin = h => Number(String(h).slice(0, 2)) * 60 + Number(String(h).slice(3, 5));
const TURNO_COLS = `t.id, t.empresa_id, t.nombre, t.color, t.vale::float vale, to_char(t.entrada,'HH24:MI') entrada, to_char(t.salida,'HH24:MI') salida,
  to_char(t.limite_falta,'HH24:MI') limite_falta, to_char(t.marca_desde,'HH24:MI') marca_desde, to_char(t.marca_hasta,'HH24:MI') marca_hasta,
  t.tolerancia, to_char(t.descanso_desde,'HH24:MI') descanso_desde, t.descanso_min, to_char(t.descanso_limite,'HH24:MI') descanso_limite, t.fuera`;

// Lo que rige para cada persona y día. Cubre desde − 1 hasta hasta + 1 por los turnos de noche.
async function contextoHorarios(emp, desde, hasta) {
  const [{ rows: hs }, { rows: ex }, { rows: pr }, { rows: fs }] = await Promise.all([
    q(`SELECT h.id hid, h.nombre hnombre, d.dia, ${TURNO_COLS}
       FROM horarios h LEFT JOIN horario_dias d ON d.horario_id=h.id LEFT JOIN turnos t ON t.id=d.turno_id
       WHERE ($1::int IS NULL OR h.empresa_id=$1)`, [emp]),
    q(`SELECT eh.empleado_id clave, eh.desde::text desde, eh.horario_id, eh.modo FROM empleado_horario eh JOIN empleados e ON e.id=eh.empleado_id
       WHERE ($1::int IS NULL OR e.empresa_id=$1) AND eh.desde <= $2::date + 1 ORDER BY eh.empleado_id, eh.desde`, [emp, hasta]),
    q(`SELECT empresa_id clave, desde::text desde, horario_id FROM empresa_horario
       WHERE ($1::int IS NULL OR empresa_id=$1) AND desde <= $2::date + 1 ORDER BY empresa_id, desde`, [emp, hasta]),
    q(`SELECT fecha::text fecha, nombre, empresa_id FROM feriados
       WHERE fecha BETWEEN $2::date - 1 AND $3::date + 1 AND ($1::int IS NULL OR empresa_id IS NULL OR empresa_id=$1)`, [emp, desde, hasta]),
  ]);
  const horarios = new Map(), turnos = new Map();
  for (const { hid, hnombre, dia, ...t } of hs) {
    if (!horarios.has(hid)) horarios.set(hid, { id: hid, nombre: hnombre, turnos: {} });
    if (dia == null || !t.id) continue;
    if (!turnos.has(t.id)) turnos.set(t.id, { ...t, h: horasTurno(t) });
    horarios.get(hid).turnos[dia] = turnos.get(t.id);
  }
  const agrupar = filas => {
    const m = new Map();
    for (const f of filas) { if (!m.has(f.clave)) m.set(f.clave, []); m.get(f.clave).push(f); }
    return m;
  };
  const excepciones = agrupar(ex), principales = agrupar(pr);
  const vigente = (lista, dia) => { let a = null; for (const x of lista || []) if (x.desde <= dia) a = x; else break; return a; };
  const feriados = new Map(fs.map(f => [`${f.empresa_id ?? ''}|${f.fecha}`, f.nombre]));
  return {
    // { horario, turno, origen } de un empleado ese día: su excepción si la tiene, si no el principal de su empresa.
    // horario null = sin horario; turno null = día libre. Los PIN que no están en el panel no tienen horario.
    de(empleado_id, empresa_id, dia) {
      if (!empleado_id) return { horario: null, turno: null, origen: 'empresa' };
      const propio = vigente(excepciones.get(empleado_id), dia);
      let horario_id, origen = 'empresa';
      if (propio && propio.modo !== 'empresa') { origen = 'propio'; horario_id = propio.modo === 'horario' ? propio.horario_id : null; }
      else horario_id = vigente(principales.get(empresa_id), dia)?.horario_id;
      const horario = horario_id ? horarios.get(horario_id) : null;
      return { horario, origen, turno: horario?.turnos[new Date(dia + 'T00:00:00Z').getUTCDay()] || null };
    },
    feriado: (empresa_id, dia) => feriados.get(`${empresa_id}|${dia}`) || feriados.get(`|${dia}`) || null,
  };
}

const ESTADO_DIA = { presente: 'Presente', retraso: 'Retraso', anticipada: 'Salida anticipada', sin_salida: 'Sin salida',
  falta: 'Falta', media_falta: 'Falta de medio turno', libre: 'Libre', feriado: 'Feriado', sin_horario: 'Sin horario',
  pendiente: 'Pendiente', antes_alta: 'Antes del ingreso' };
const minutoAhora = () => { const a = ahoraBO(); return diaNum(a.slice(0, 10)) * 1440 + aMin(a.slice(11, 16)); };

// Los turnos que le tocan a una persona del día d0 al d1 (números de día), cada uno con su ventana para marcar en
// segundos, y a cuál va cada marcación: al turno cuya ventana la contiene (si hay dos, al más cercano). La que no cae
// en ninguno queda suelta por fecha (día libre, sin horario o fuera del turno), salvo que el turno de ese día diga
// "sumarlas como trabajadas": entonces va a él.
function repartirMarcas(p, marcas, ctx, d0, d1) {
  const turnos = [];
  for (let n = d0; n <= d1; n++) {
    const dia = numDia(n), v = ctx.de(p.empleado_id, p.empresa_id, dia);
    if (!v.turno) continue;
    const h = v.turno.h, b = n * 1440;
    turnos.push({ dia, n, base: b, turno: v.turno, horario: v.horario, marcas: [],
      ini: (b + h.eD) * 60, fin: (b + h.sH) * 60 + 59, E: (b + h.E) * 60, S: (b + h.S) * 60 });
  }
  const dist = (x, t) => t < x.E ? x.E - t : t > x.S ? t - x.S : 0;
  const masCerca = (lista, t) => lista.reduce((a, x) => !a || dist(x, t) < dist(a, t) ? x : a, null);
  const sueltas = new Map();
  for (const m of marcas) {
    let x = masCerca(turnos.filter(x => m.t >= x.ini && m.t <= x.fin), m.t);
    if (!x) x = masCerca(turnos.filter(x => x.turno.fuera === 'trabajadas' &&
      (m.dia === x.dia || (x.turno.h.S >= 1440 && diaNum(m.dia) === x.n + 1))), m.t);
    if (x) { x.marcas.push(m); Object.assign(m, { turno: x.turno.nombre, turno_dia: x.dia }); }
    else {
      Object.assign(m, { turno: '', turno_dia: m.dia });
      if (!sueltas.has(m.dia)) sueltas.set(m.dia, []);
      sueltas.get(m.dia).push(m);
    }
  }
  return { turnos, sueltas };
}

// Qué fue cada marcación por orden (entrada, descanso, salida…; las repetidas, como la que repiten), sin retraso ni falta
function anotarPorOrden(marcas) {
  estadosDelDia(marcas.map(m => m.t)).forEach((e, i) => Object.assign(marcas[i], e, { retraso: null, falta: 0 }));
}
// Lo marcado en una jornada (n: su día): entrada, salida, descanso por orden y horas
function marcadoDe(marcas, n) {
  if (!marcas.length) return { marcaciones: 0 };
  const j = calcularJornada(marcas.map(m => m.t));
  const ultima = marcas.reduce((u, m) => m.t - u.t >= REPETIDA_SEG ? m : u, marcas[0]);
  return { ...j, salida_sig: !!j.salida && Math.floor(ultima.t / 86400) > n, marcaciones: marcas.length,
    sucursal: marcas[0].sucursal, sucursal_id: marcas[0].sucursal_id };
}

// Una jornada con turno. ahora: minuto absoluto actual (lo que aún no pasó no es falta).
function evaluarTurno(x, feriado, ahora, alta) {
  const t = x.turno, h = t.h, b = x.base, marcas = x.marcas;
  const r = { horario: x.horario?.nombre || '', turno: t.nombre, h_entrada: t.entrada, h_salida: t.salida, h_salida_sig: h.S >= 1440,
    h_minutos: h.S - h.E - h.dur, laboral: 0, retraso: 0, anticipada: 0, falta: 0 };
  if (feriado) { anotarPorOrden(marcas); return { ...marcadoDe(marcas, x.n), ...r, estado: 'feriado', obs: `Feriado: ${feriado}` }; }
  if (!marcas.length) {
    if (ahora <= b + h.L) return { marcaciones: 0, ...r, estado: 'pendiente', obs: '' };
    if (alta && x.dia < alta) return { marcaciones: 0, ...r, estado: 'antes_alta', obs: `Antes de su ingreso (${fechaBO(alta)})` };
    return { marcaciones: 0, ...r, laboral: t.vale, falta: t.vale, estado: 'falta', obs: 'No marcó' };
  }
  r.laboral = t.vale;
  return h.dur ? evaluarPartido(x, r, ahora) : evaluarCorrido(x, r);
}

// Turno corrido: entrada = la primera, salida = la última. Llegar después del límite es falta del turno entero.
function evaluarCorrido(x, r) {
  const t = x.turno, h = t.h, b = x.base, marcado = marcadoDe(x.marcas, x.n), primera = x.marcas[0];
  anotarPorOrden(x.marcas);
  const ent = Math.floor(primera.t / 60);
  if (ent > b + h.L) {
    const obs = `Llegó ${hhmm(ent)}, después del límite de las ${t.limite_falta}`;
    Object.assign(primera, { falta: t.vale, obs });
    return { ...marcado, ...r, falta: t.vale, estado: 'falta', obs };
  }
  if (ent - (b + h.E) > t.tolerancia) r.retraso = ent - (b + h.E);
  const sinSalida = !marcado.salida;
  if (!sinSalida) {
    const ultima = x.marcas.reduce((u, m) => m.t - u.t >= REPETIDA_SEG ? m : u, primera);
    r.anticipada = Math.max(0, b + h.S - Math.floor(ultima.t / 60));
  }
  primera.retraso = r.retraso || null;
  const obs = [r.retraso ? `Retraso ${aHoras(r.retraso)}` : '', sinSalida ? 'Sin salida' : r.anticipada ? `Salió ${aHoras(r.anticipada)} antes` : '']
    .filter(Boolean).join(' · ');
  return { ...marcado, ...r, estado: r.retraso ? 'retraso' : sinSalida ? 'sin_salida' : r.anticipada ? 'anticipada' : 'presente', obs };
}

// Turno con descanso flexible: 1.ª parte (entrada → salida a descanso) y 2.ª parte (regreso → salida); cada parte vale
// la mitad del turno. Retraso al volver = lo que se pase de la duración del descanso. Volver después del límite, o
// faltarle una marcación a una parte, es falta de esa parte. Si no marcó nada en el descanso, no hay falta: se le
// descuenta la duración. Lo que todavía no pasó (hoy) no es falta.
function evaluarPartido(x, r, ahora) {
  const t = x.turno, h = t.h, b = x.base, marcas = x.marcas, medio = t.vale / 2, tol = t.tolerancia;
  const E = b + h.E, L = b + h.L, S = b + h.S, dD = b + h.dD, dL = b + h.dL, dur = h.dur;
  const K = [], de = marcas.map((m, i) => { if (!K.length || m.t - marcas[K[K.length - 1]].t >= REPETIDA_SEG) K.push(i); return K.length - 1; });
  const sec = K.map(i => marcas[i].t), km = sec.map(s => Math.floor(s / 60)), paso = m => ahora > m;
  let e1 = null, s1 = null, e2 = null, s2 = null, f1 = '', f2 = '', sinDescanso = false;
  if (km[0] < dD) {
    e1 = 0;
    const resto = K.length - 1;
    if (resto === 0) { if (paso(S)) { f1 = 'no marcó la salida a descanso'; f2 = 'no volvió del descanso'; } }
    else if (resto === 1) {
      if (km[1] >= dL) { s2 = 1; sinDescanso = true; }
      else { s1 = 1; if (paso(dL)) f2 = 'no volvió del descanso'; }
    } else if (resto === 2) {
      if (km[2] < dL) { s1 = 1; e2 = 2; if (paso(S)) f2 = 'no marcó la salida'; }
      else if (km[1] < (dD + dL) / 2) { s1 = 1; s2 = 2; f2 = 'no marcó el regreso del descanso'; }
      else { e2 = 1; s2 = 2; f1 = 'no marcó la salida a descanso'; }
    } else { s1 = 1; e2 = 2; s2 = K.length - 1; }
  } else {
    f1 = 'no vino'; e2 = 0;
    if (K.length > 1) s2 = K.length - 1; else if (paso(S)) f2 = 'no marcó la salida';
  }
  let ret1 = 0, ret2 = 0, ant1 = 0, ant2 = 0;
  if (e1 != null) {
    if (km[e1] > L) f1 = f1 || `llegó ${hhmm(km[e1])}, después del límite de las ${t.limite_falta}`;
    else if (km[e1] - E > tol) ret1 = km[e1] - E;
  }
  if (s1 != null && km[s1] < dD) ant1 = dD - km[s1];
  if (e2 != null) {
    if (km[e2] > dL) f2 = f2 || `${s1 != null ? 'volvió' : 'llegó'} ${hhmm(km[e2])}, después del límite de las ${t.descanso_limite}`;
    else {
      const exceso = s1 != null ? km[e2] - km[s1] - dur : km[e2] - (dD + dur);
      if (exceso > tol) ret2 = exceso;
    }
  }
  if (s2 != null) ant2 = Math.max(0, S - km[s2]);
  if (f1) ret1 = ant1 = 0;
  if (f2) ret2 = ant2 = 0;
  const mins = (a, c) => Math.round((sec[c] - sec[a]) / 60);
  let minutos;
  if (sinDescanso) minutos = Math.max(0, mins(e1, s2) - dur);
  else {
    const p1 = e1 != null && s1 != null ? mins(e1, s1) : null, p2 = e2 != null && s2 != null ? mins(e2, s2) : null;
    minutos = p1 == null && p2 == null ? null : (p1 || 0) + (p2 || 0);
  }
  // Cada marcación: qué fue; el retraso o la falta de cada parte va en su primera marcación
  const papel = new Map([[e1, 'entrada'], [s1, 'descanso_ini'], [e2, s1 != null ? 'descanso_fin' : 'entrada'], [s2, 'salida']]);
  marcas.forEach((m, i) => Object.assign(m, { estado: papel.get(de[i]) || 'intermedia', repetida: K[de[i]] !== i, retraso: null, falta: 0, obs: undefined }));
  // Si una parte no tiene marcaciones, lo suyo va en la de la otra parte (así la fila suma la falta del día)
  let k1 = e1 ?? s1, k2 = e2 ?? s2 ?? s1;
  if (k1 == null) k1 = k2;
  if (k2 == null) k2 = k1;
  const marcar = (k, ret, f) => {
    const m = marcas[K[k]];
    m.retraso = (m.retraso || 0) + ret || null;
    if (f) { m.falta += medio; m.obs = [m.obs, f[0].toUpperCase() + f.slice(1)].filter(Boolean).join(' · '); }
  };
  marcar(k1, ret1, f1);
  marcar(k2, ret2, f2);
  const falta = (f1 ? medio : 0) + (f2 ? medio : 0);
  Object.assign(r, { retraso: ret1 + ret2, anticipada: ant1 + ant2, falta });
  const ini = e1 ?? e2 ?? 0, conDescanso = s1 != null && e2 != null;
  const obs = [f1 && `1.ª parte: ${f1}`, f2 && `2.ª parte: ${f2}`, ret1 && `Retraso ${aHoras(ret1)}`,
    ret2 && `Retraso al volver del descanso ${aHoras(ret2)}`, ant1 && `Salió a descanso ${aHoras(ant1)} antes`,
    ant2 && `Salió ${aHoras(ant2)} antes`, sinDescanso && `No marcó el descanso: se descontó ${aHoras(dur)}`].filter(Boolean).join(' · ');
  return {
    entrada: hhmm(km[ini]), salida: s2 != null ? hhmm(km[s2]) : null, salida_sig: s2 != null && Math.floor(sec[s2] / 86400) > x.n,
    descanso_ini: s1 != null ? hhmm(km[s1]) : null, descanso_fin: conDescanso ? hhmm(km[e2]) : null,
    descanso: conDescanso ? mins(s1, e2) : sinDescanso ? dur : null, almuerzo: conDescanso ? `${hhmm(km[s1])}–${hhmm(km[e2])}` : null,
    total: s2 != null ? mins(ini, s2) : null, minutos, marcaciones: marcas.length, sucursal: marcas[0].sucursal, sucursal_id: marcas[0].sucursal_id,
    ...r, estado: falta >= t.vale ? 'falta' : falta ? 'media_falta' : r.retraso ? 'retraso' : s2 == null ? 'sin_salida' : r.anticipada ? 'anticipada' : 'presente',
    obs,
  };
}

// Un día sin turno (libre o sin horario), con o sin marcaciones
function evaluarSinTurno(dia, marcas, v, feriado) {
  anotarPorOrden(marcas);
  const marcado = marcadoDe(marcas, diaNum(dia)), j = marcas.length > 0, sinSalida = j && !marcado.salida;
  const r = { horario: v.horario?.nombre || '', turno: '', h_entrada: null, h_salida: null, h_salida_sig: false, h_minutos: null,
    laboral: 0, retraso: 0, anticipada: 0, falta: 0 };
  if (feriado) return { ...marcado, ...r, estado: 'feriado', obs: `Feriado: ${feriado}` };
  if (!v.horario) return { ...marcado, ...r, estado: !j ? 'sin_horario' : sinSalida ? 'sin_salida' : 'presente',
    obs: !j ? (v.origen === 'propio' ? 'Sin control de horario' : 'Sin horario asignado') : sinSalida ? 'Sin salida' : '' };
  return { ...marcado, ...r, estado: 'libre', obs: j ? 'Día libre (marcó)' : 'Día libre' };
}

// Una fila por día de [desde, hasta] para una persona, evaluada contra el turno de ese día (la jornada es del día en que
// empieza el turno); de paso anota en cada marcación qué fue. suc: solo cuentan las jornadas que empezaron en esa
// sucursal; las demás se ven como si no hubiera marcado.
function diasPersona(p, marcas, ctx, desde, hasta, ahora, suc = null) {
  const d0 = diaNum(desde), d1 = diaNum(hasta);
  const { turnos, sueltas } = repartirMarcas(p, marcas, ctx, d0 - 1, d1 + 1);
  const porDia = new Map(turnos.map(x => [x.dia, x]));
  // Los turnos de los días de al lado se evalúan para anotar sus marcaciones que caen dentro del rango
  for (const x of turnos) if (x.n < d0 || x.n > d1) evaluarTurno(x, ctx.feriado(p.empresa_id, x.dia), ahora, p.alta);
  const dias = [];
  for (let n = d0; n <= d1; n++) {
    const dia = numDia(n), x = porDia.get(dia), feriado = ctx.feriado(p.empresa_id, dia);
    let sueltasDia = sueltas.get(dia) || [], d;
    if (x) {
      const cuenta = !suc || !x.marcas.length || x.marcas[0].sucursal_id === suc;
      d = evaluarTurno(cuenta ? x : { ...x, marcas: [] }, feriado, ahora, p.alta);
      if (sueltasDia.length) {
        sueltasDia.forEach(m => Object.assign(m, { estado: 'fuera', repetida: false, retraso: null, falta: 0 }));
        d.obs = [d.obs, `Marcó fuera del turno: ${sueltasDia.map(m => m.hora.slice(0, 5)).join(', ')}`].filter(Boolean).join(' · ');
      }
    } else {
      if (suc && sueltasDia.length && sueltasDia[0].sucursal_id !== suc) sueltasDia = [];
      d = evaluarSinTurno(dia, sueltasDia, ctx.de(p.empleado_id, p.empresa_id, dia), feriado);
    }
    dias.push({ dia, ...d });
  }
  return dias;
}

function totalizar(dias) {
  const t = { laborables: 0, dias: 0, marcaciones: 0, total: 0, descanso: 0, minutos: 0, sin_salida: 0,
    retrasos: 0, retraso: 0, anticipadas: 0, anticipada: 0, faltas: 0 };
  for (const d of dias) {
    t.laborables += d.laboral; t.faltas += d.falta;
    if (d.retraso) { t.retrasos++; t.retraso += d.retraso; }
    if (d.anticipada) { t.anticipadas++; t.anticipada += d.anticipada; }
    if (!d.marcaciones) continue;
    t.dias++; t.marcaciones += d.marcaciones; t.descanso += d.descanso || 0;
    if (d.minutos == null) t.sin_salida++; else { t.minutos += d.minutos; t.total += d.total; }
  }
  return t;
}

// Una hoja por persona con todos los días del rango. personas: los esperados; los que marcaron sin estar entre ellos
// (PIN que no están en el panel, gente de otra sucursal) se agregan si tienen alguna jornada en el rango.
// marcas: las de marcasCrudas, que quedan anotadas (qué fue cada una, su retraso o falta y su turno).
function armarHojas(personas, marcas, ctx, desde, hasta, { incluir = () => true, suc = null } = {}) {
  const ahora = minutoAhora();
  const porClave = new Map(personas.map(p => [p.clave, { ...p, marcas: [] }]));
  for (const m of marcas) {
    if (!porClave.has(m.clave)) porClave.set(m.clave, { clave: m.clave, empleado_id: m.empleado_id, empresa_id: m.empresa_id, empresa: m.empresa,
      pin: m.pin, nombre: m.nombre, ci: m.ci, departamento: m.departamento, cargo: m.cargo, alta: m.alta, marcas: [], extra: true });
    porClave.get(m.clave).marcas.push(m);
  }
  const hojas = [];
  for (const { marcas: suyas, extra, ...p } of [...porClave.values()].filter(incluir).sort(porNombre)) {
    const dias = diasPersona(p, suyas, ctx, desde, hasta, ahora, suc);
    if (extra && !dias.some(d => d.marcaciones)) continue;
    const actual = ctx.de(p.empleado_id, p.empresa_id, hasta);
    hojas.push({ ...p, horario: actual.horario?.nombre || '', horario_propio: actual.origen === 'propio', dias, totales: totalizar(dias) });
  }
  return hojas;
}

// Personal filtrado: sucursal (selector de arriba), nombre/PIN/CI y departamento
async function hojasFiltradas(req, desde, hasta) {
  const emp = empresaScope(req, req.query.empresa_id), suc = numId(req.query.sucursal_id);
  const buscar = clean(req.query.buscar).toLowerCase(), dep = clean(req.query.departamento);
  const [personas, marcas, ctx] = await Promise.all([esperados(emp, suc), marcasCrudas(emp, desde, hasta), contextoHorarios(emp, desde, hasta)]);
  const incluir = p => (!buscar || [p.nombre, p.pin, p.ci].some(v => String(v || '').toLowerCase().includes(buscar))) && (!dep || p.departamento === dep);
  const departamentos = [...new Set(personas.map(p => p.departamento).filter(Boolean))].sort();
  return { hojas: armarHojas(personas, marcas, ctx, desde, hasta, { incluir, suc }), departamentos };
}

// Hoja de asistencia en Excel, con las columnas de la hoja impresa
const COLS_HOJA = [['Fecha', 11], ['Día', 10], ['Turno', 16], ['Entrada horario', 9], ['Salida horario', 11], ['Horas laborales', 9, 'horas'],
  ['Día laboral', 8], ['Entrada', 9], ['Salida', 9], ['Salida descanso', 9], ['Entrada descanso', 9], ['Horas descanso', 9, 'horas'],
  ['Total horas', 9, 'horas'], ['Horas trabajadas', 10, 'horas'], ['Retraso', 9, 'horas'], ['Salida anticipada', 10, 'horas'], ['Falta', 7],
  ['Observación', 34]];
// Columnas de la persona en las tablas de los reportes en Excel (como la tabla de marcaciones).
// ec: con columna Empresa (la plataforma con "Todas las empresas")
const COLS_PERSONA = ec => [['ID empleado', 12], ['Empleado', 28], ['CI', 12], ...(ec ? [['Empresa', 22]] : []), ['Departamento', 18], ['Cargo', 16]];
const celdasPersona = (f, ec) => [f.pin, f.nombre || 'No registrado', f.ci, ...(ec ? [f.empresa] : []), f.departamento, f.cargo];
// Encabezado de las hojas por persona en Excel
const lineaPersona = h => `ID del empleado: ${h.pin}    Nombres: ${h.nombre || 'No registrado'}    CI: ${h.ci || '—'}    Departamento: ${h.departamento || '—'}` +
  `    Cargo: ${h.cargo || '—'}    Horario: ${h.horario || 'Sin horario'}${h.horario_propio ? ' (propio)' : h.horario ? ' (de la empresa)' : ''}`;
// Una hora que es del día siguiente (salida de un turno de noche) lleva "(+1)"
const masUno = (h, sig) => h && sig ? `${h} (+1)` : h;
function hojaExcel(h, desde, hasta) {
  const t = h.totales;
  return {
    nombre: `${h.pin} ${h.nombre || 'No registrado'}`, horizontal: true, columnas: COLS_HOJA,
    encabezado: [[`Hoja de asistencia · ${h.empresa}`], [`Fecha inicial ${fechaBO(desde)}    Fecha final ${fechaBO(hasta)}`], [lineaPersona(h)]],
    filas: [...h.dias.map(d => [fechaBO(d.dia), diaSem(d.dia), d.turno, d.h_entrada, masUno(d.h_salida, d.h_salida_sig), d.h_minutos,
      d.horario ? d.laboral : null, d.entrada, masUno(d.salida, d.salida_sig), d.descanso_ini, d.descanso_fin, d.descanso, d.total, d.minutos,
      d.retraso || null, d.anticipada || null, d.falta || null, d.obs]),
    ['Totales', '', '', '', '', null, t.laborables, '', '', '', '', t.descanso, t.total, t.minutos, t.retraso, t.anticipada, t.faltas,
      `${t.dias} ${t.dias === 1 ? 'día trabajado' : 'días trabajados'} · ${t.retrasos} ${t.retrasos === 1 ? 'retraso' : 'retrasos'} · ${t.sin_salida} sin salida`]],
  };
}

app.get('/api/reportes/empleados', async (req, res) => {
  const { desde, hasta } = rangoParam(req.query);
  const { hojas, departamentos } = await hojasFiltradas(req, desde, hasta);
  const filas = hojas.map(({ dias, totales, ...p }) => ({ ...p, ...totales }));
  if (req.query.formato === 'xlsx') {
    const ec = !empresaScope(req, req.query.empresa_id);
    return libroConMarcaciones(req, res, `reporte_empleados_${desde}_${hasta}`, [{ nombre: 'Empleados', horizontal: true,
      columnas: [...COLS_PERSONA(ec), ['Horario', 16], ['Días laborables', 10], ['Días trabajados', 10], ['Horas trabajadas', 10, 'horas'],
        ['Retrasos', 9], ['Retraso total', 10, 'horas'], ['Salida anticipada', 10, 'horas'], ['Faltas', 8], ['Días sin salida', 10]],
      filas: filas.map(f => [...celdasPersona(f, ec), f.horario, f.laborables, f.dias, f.minutos,
        f.retrasos, f.retraso, f.anticipada, f.faltas, f.sin_salida]) }], desde, hasta);
  }
  res.json({ desde, hasta, filas, departamentos });
});

// Hojas de todo el personal filtrado: para imprimirlas juntas (una página por persona) o en Excel (una pestaña cada una)
app.get('/api/reportes/hojas', async (req, res) => {
  const { desde, hasta } = rangoParam(req.query);
  const { hojas } = await hojasFiltradas(req, desde, hasta);
  if (req.query.formato === 'xlsx') {
    if (!hojas.length) throw new HttpError(404, 'No hay personal con esos filtros');
    return enviarLibro(res, `hojas_asistencia_${desde}_${hasta}`, hojas.map(h => hojaExcel(h, desde, hasta)));
  }
  res.json({ desde, hasta, hojas });
});

app.get('/api/reportes/empleado', async (req, res) => {
  const { desde, hasta } = rangoParam(req.query);
  const emp = empresaScope(req, req.query.empresa_id), suc = numId(req.query.sucursal_id);
  const empleado_id = numId(req.query.empleado_id), pin = empleado_id ? null : clean(req.query.pin) || null;
  if (!empleado_id && !pin) throw new HttpError(400, 'Elige un empleado');
  if (pin && !emp) throw new HttpError(400, 'Elige la empresa');
  const persona = empleado_id
    ? await one(`SELECT 'e' || e.id clave, e.id empleado_id, e.empresa_id, x.nombre empresa, e.pin, e.nombre, e.ci, e.departamento, e.cargo,
        COALESCE(e.ingreso, (e.creado AT TIME ZONE 'America/La_Paz')::date)::text alta
        FROM empleados e JOIN empresas x ON x.id=e.empresa_id WHERE e.id=$1 AND ($2::int IS NULL OR e.empresa_id=$2)`, [empleado_id, emp])
    : await one(`SELECT 'p' || id || '-' || $2 clave, NULL::int empleado_id, id empresa_id, nombre empresa, $2::text pin FROM empresas WHERE id=$1`, [emp, pin]);
  if (!persona) throw new HttpError(404, 'El empleado no existe');
  const [marcas, ctx] = await Promise.all([marcasCrudas(emp, desde, hasta, { empleado_id, pin }), contextoHorarios(emp, desde, hasta)]);
  const [hoja] = armarHojas([persona], marcas, ctx, desde, hasta, { suc });
  if (req.query.formato === 'xlsx')
    return libroConMarcaciones(req, res, `asistencia_${persona.pin}_${desde}_${hasta}`, [hojaExcel(hoja, desde, hasta)], desde, hasta);
  res.json({ desde, hasta, hoja });
});

app.get('/api/reportes/sucursales', async (req, res) => {
  const { desde, hasta } = rangoParam(req.query);
  const emp = empresaScope(req, req.query.empresa_id), suc = numId(req.query.sucursal_id);
  const { rows } = await q(`
    SELECT s.id sucursal_id, s.nombre sucursal, s.empresa_id, x.nombre empresa,
      (SELECT count(DISTINCT ed.empleado_id) FROM empleado_dispositivo ed JOIN dispositivos d ON d.id=ed.dispositivo_id
         JOIN empleados em ON em.id=ed.empleado_id WHERE d.sucursal_id=s.id AND ed.estado<>'eliminando' AND em.activo)::int empleados
    FROM sucursales s JOIN empresas x ON x.id=s.empresa_id
    WHERE ($1::int IS NULL OR s.empresa_id=$1) AND ($2::int IS NULL OR s.id=$2)
    ORDER BY x.nombre, s.nombre`, [emp, suc]);
  const filas = new Map(rows.map(s => [s.sucursal_id, { ...s, asistieron: new Set(), jornadas: 0, marcaciones: 0, minutos: 0, sin_salida: 0 }]));
  // Cada jornada cuenta en la sucursal donde marcó su entrada
  const [marcas, ctx] = await Promise.all([marcasCrudas(emp, desde, hasta), contextoHorarios(emp, desde, hasta)]);
  for (const h of armarHojas([], marcas, ctx, desde, hasta, { suc })) for (const j of h.dias) {
    const f = j.marcaciones && filas.get(j.sucursal_id);
    if (!f) continue; // sin marcaciones, o equipo sin sucursal
    f.asistieron.add(h.clave); f.jornadas++; f.marcaciones += j.marcaciones;
    if (j.minutos == null) f.sin_salida++; else f.minutos += j.minutos;
  }
  const lista = [...filas.values()].map(f => ({ ...f, asistieron: f.asistieron.size }));
  if (req.query.formato === 'xlsx')
    return libroConMarcaciones(req, res, `reporte_sucursales_${desde}_${hasta}`, [{ nombre: 'Sucursales',
      columnas: [['Sucursal', 24], ['Empresa', 24], ['Empleados', 11], ['Asistieron', 11], ['Jornadas', 11], ['Marcaciones', 12],
        ['Horas', 10, 'horas'], ['Jornadas sin salida', 12]],
      filas: lista.map(f => [f.sucursal, f.empresa, f.empleados, f.asistieron, f.jornadas, f.marcaciones, f.minutos, f.sin_salida]) }], desde, hasta);
  res.json({ desde, hasta, filas: lista });
});

app.get('/api/reportes/fecha', async (req, res) => {
  const dia = fechaParam(req.query.dia, 'del reporte');
  const { hojas } = await hojasFiltradas(req, dia, dia);
  // sucursal: donde marcó; si no marcó, las de sus relojes
  const lista = hojas.map(({ dias: [d], totales, ...p }) => ({ ...p, ...d, sucursal: d.sucursal || p.sucursal }));
  const totales = { presentes: 0, faltas: 0, retrasos: 0, sin_salida: 0, minutos: 0 };
  for (const f of lista) {
    if (f.marcaciones) totales.presentes++;
    if (f.marcaciones && !f.salida) totales.sin_salida++;
    totales.faltas += f.falta; totales.retrasos += f.retraso ? 1 : 0; totales.minutos += f.minutos || 0;
  }
  if (req.query.formato === 'xlsx') {
    const ec = !empresaScope(req, req.query.empresa_id);
    return libroConMarcaciones(req, res, `asistencia_${dia}`, [{ nombre: fechaBO(dia).replace(/\//g, '-'), horizontal: true,
      columnas: [...COLS_PERSONA(ec), ['Sucursal', 18], ['Horario', 14], ['Entrada', 9], ['Descanso', 13], ['Salida', 9],
        ['Horas trabajadas', 10, 'horas'], ['Retraso', 9, 'horas'], ['Salida anticipada', 10, 'horas'], ['Falta', 7], ['Estado', 34]],
      filas: lista.map(f => [...celdasPersona(f, ec), f.sucursal,
        f.h_entrada ? `${f.h_entrada}–${masUno(f.h_salida, f.h_salida_sig)}` : f.horario, f.entrada, f.almuerzo, masUno(f.salida, f.salida_sig), f.minutos,
        f.retraso || null, f.anticipada || null, f.falta || null, ESTADO_DIA[f.estado] + (f.obs ? ` · ${f.obs}` : '')]) }], dia, dia);
  }
  res.json({ dia, totales, filas: lista });
});

// Detalle de marcaciones: una fila por marcación. El reloj no dice si es entrada o salida (manda el estado 255),
// así que cada una se nombra con la misma regla de las jornadas, para que coincida con las horas de los reportes.
const ESTADO_MARC = { entrada: 'Entrada', salida: 'Salida', descanso_ini: 'Salida a descanso', descanso_fin: 'Regreso de descanso',
  intermedia: 'Intermedia', fuera: 'Fuera del turno' };
const VERIFICACION = { 0: 'Clave', 1: 'Huella', 2: 'Tarjeta', 3: 'Clave', 4: 'Tarjeta', 15: 'Rostro', 25: 'Palma' };
const MAX_MARC_PANTALLA = 3000; // en pantalla; el Excel las trae todas
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const decimal = n => String(n).replace('.', ',');
// Columna "Retraso": minutos de retraso, o "Falta" si esa marcación dejó falta (con lo que vale, si no es 1 día)
const celdaRetraso = f => f.falta ? (f.falta === 1 ? 'Falta' : `Falta ${decimal(f.falta)}`) : f.retraso || null;
const COLS_MARC_PERSONA = [['Fecha', 12, 'fecha'], ['Día', 7], ['Sucursal', 18], ['Dispositivo', 22], ['Hora marcación', 13, 'hora'],
  ['Estado de marcación', 24], ['Turno', 16], ['Retraso', 10, 'horas'], ['Método de verificación', 15]];

// ts: segundos de las marcaciones de una jornada, en orden. La que llega a menos de 2 min de la última que cuenta es
// repetida y se nombra como esa. Con 3 que cuentan, la del medio no entra en el cálculo: es "intermedia".
function estadosDelDia(ts) {
  const cuentan = [];
  const de = ts.map((s, i) => {
    if (!cuentan.length || s - ts[cuentan.at(-1)] >= REPETIDA_SEG) cuentan.push(i);
    return cuentan.at(-1);
  });
  const n = cuentan.length, pos = new Map(cuentan.map((i, k) => [i, k]));
  const estado = k => k === 0 ? 'entrada' : k === n - 1 ? 'salida' :
    n >= 4 && k === 1 ? 'descanso_ini' : n >= 4 && k === 2 ? 'descanso_fin' : 'intermedia';
  return ts.map((_, i) => ({ estado: estado(pos.get(de[i])), repetida: de[i] !== i }));
}

// Marcaciones del filtro, una fila por marcación, ordenadas por persona, fecha y hora. Filtros: empresa, sucursal,
// equipo, persona (empleado_id, o pin si no está en el panel), nombre/PIN/CI y departamento. Las usan el detalle de
// marcaciones y la tabla de marcaciones que va debajo de los demás reportes (y su pestaña en el Excel).
async function marcacionesFiltradas(req, desde, hasta) {
  const emp = empresaScope(req, req.query.empresa_id), suc = numId(req.query.sucursal_id), dev = numId(req.query.dispositivo_id);
  const buscar = clean(req.query.buscar).toLowerCase(), dep = clean(req.query.departamento);
  const empId = numId(req.query.empleado_id), pinSuelto = empId ? null : clean(req.query.pin) || null;
  const [marcas, ctx] = await Promise.all([marcasCrudas(emp, desde, hasta), contextoHorarios(emp, desde, hasta)]);
  // Cada persona se evalúa con todas sus marcaciones, en cualquier reloj: así cada una sabe qué fue, su turno y su
  // retraso o falta (en la primera marcación de su parte del turno). Recién después se filtra.
  armarHojas([], marcas, ctx, desde, hasta);
  const incluir = r => r.dia >= desde && r.dia <= hasta && r.estado &&
    (!suc || r.sucursal_id === suc) && (!dev || r.dispositivo_id === dev) && (!dep || r.departamento === dep) &&
    (!empId || r.empleado_id === empId) && (!pinSuelto || (!r.empleado_id && r.pin === pinSuelto)) &&
    (!buscar || [r.nombre, r.pin, r.ci].some(v => String(v || '').toLowerCase().includes(buscar)));
  const filas = marcas.filter(incluir)
    .sort((a, b) => porNombre(a, b) || a.t - b.t)
    .map(({ verificacion, t, alta, ...r }) => ({ ...r, estado_texto: ESTADO_MARC[r.estado] + (r.repetida ? ' (repetida)' : ''),
      metodo: VERIFICACION[verificacion] || (verificacion ? `Código ${verificacion}` : '') }));
  return { filas, ctx, emp };
}

// Columna "Turno": su nombre y, si la marcación es de un turno que empezó otro día (la salida de uno de noche), ese día
const turnoDe = f => f.turno ? f.turno + (f.turno_dia !== f.dia ? ` (del ${fechaBO(f.turno_dia)})` : '') : '';
// Pestaña "Marcaciones" del Excel. ec: con columna Empresa (la plataforma con "Todas las empresas")
function hojaMarcaciones(filas, ec) {
  return { nombre: 'Marcaciones', horizontal: true,
    columnas: [...COLS_PERSONA(ec), ['Fecha', 12, 'fecha'], ['Día', 7], ['Sucursal', 18], ['Dispositivo', 22], ['Hora marcación', 13, 'hora'],
      ['Estado de marcación', 24], ['Turno', 18], ['Retraso', 10, 'horas'], ['Método de verificación', 15]],
    filas: filas.map(f => [...celdasPersona(f, ec), f.dia, diaSem(f.dia).slice(0, 3), f.sucursal, f.dispositivo, f.hora,
      f.estado_texto, turnoDe(f), celdaRetraso(f), f.metodo]) };
}
// Los reportes con Excel le agregan la pestaña de marcaciones del mismo filtro
async function libroConMarcaciones(req, res, archivo, hojas, desde, hasta) {
  const { filas, emp } = await marcacionesFiltradas(req, desde, hasta);
  return enviarLibro(res, archivo, [...hojas, hojaMarcaciones(filas, !emp)]);
}

// por_persona=1: una hoja por persona (en Excel, una pestaña cada una) con su total de retraso y sus faltas del período.
// Salen todas las personas del filtro, también las que no marcaron (para ver sus faltas).
app.get('/api/reportes/marcaciones', async (req, res) => {
  const { desde, hasta } = rangoParam(req.query);
  const porPersona = req.query.por_persona === '1';
  const [{ filas, ctx, emp }, personas, hojas] = await Promise.all([marcacionesFiltradas(req, desde, hasta),
    esperados(empresaScope(req, req.query.empresa_id), numId(req.query.sucursal_id)),
    porPersona ? hojasFiltradas(req, desde, hasta).then(r => r.hojas) : null]);
  const departamentos = [...new Set(personas.map(p => p.departamento).filter(Boolean))].sort();
  if (porPersona) return marcacionesPorPersona(req, res, { desde, hasta, filas, hojas, ctx, departamentos });
  if (req.query.formato === 'xlsx') return enviarLibro(res, `marcaciones_${desde}_${hasta}`, [hojaMarcaciones(filas, !emp)]);
  res.json({ desde, hasta, total: filas.length, personas: new Set(filas.map(f => f.clave)).size,
    filas: filas.slice(0, MAX_MARC_PANTALLA), departamentos });
});

// Agrupa las marcaciones por persona. hojas: las de asistencia del mismo filtro, de donde salen el horario y las faltas
// (incluidas las de días sin marcar). Quien marcó en la sucursal filtrada sin estar asignado a ella va igual, con sus marcaciones.
function marcacionesPorPersona(req, res, { desde, hasta, filas, hojas, ctx, departamentos }) {
  const grupos = new Map(hojas.map(({ dias, totales, ...h }) => [h.clave, { ...h, faltas: totales.faltas, filas: [] }]));
  for (const f of filas) {
    if (!grupos.has(f.clave)) {
      const actual = ctx.de(f.empleado_id, f.empresa_id, hasta);
      grupos.set(f.clave, { clave: f.clave, empleado_id: f.empleado_id, empresa_id: f.empresa_id, empresa: f.empresa, pin: f.pin, nombre: f.nombre,
        ci: f.ci, departamento: f.departamento, cargo: f.cargo, horario: actual.horario?.nombre || '', horario_propio: actual.origen === 'propio',
        faltas: 0, filas: [] });
    }
    grupos.get(f.clave).filas.push(f);
  }
  const lista = [...grupos.values()].sort(porNombre).map(g => ({ ...g, marcaciones: g.filas.length,
    retraso: g.filas.reduce((a, f) => a + (f.retraso || 0), 0), retrasos: new Set(g.filas.filter(f => f.retraso).map(f => f.turno_dia)).size }));
  if (req.query.formato === 'xlsx') {
    if (!lista.length) throw new HttpError(404, 'No hay personal con esos filtros');
    return enviarLibro(res, `marcaciones_por_persona_${desde}_${hasta}`, lista.map(g => ({
      nombre: `${g.pin} ${g.nombre || 'No registrado'}`, horizontal: true, columnas: COLS_MARC_PERSONA,
      encabezado: [[`Detalle de marcaciones · ${g.empresa}`], [`Fecha inicial ${fechaBO(desde)}    Fecha final ${fechaBO(hasta)}`], [lineaPersona(g)],
        [`${plural(g.marcaciones, 'marcación', 'marcaciones')}    Retraso total: ${aHoras(g.retraso)} (${plural(g.retrasos, 'retraso', 'retrasos')})` +
          `    Faltas en el período: ${decimal(g.faltas)}`]],
      filas: [...g.filas.map(f => [f.dia, diaSem(f.dia).slice(0, 3), f.sucursal, f.dispositivo, f.hora, f.estado_texto, turnoDe(f), celdaRetraso(f), f.metodo]),
        ['Totales', null, null, null, plural(g.marcaciones, 'marcación', 'marcaciones'), plural(g.retrasos, 'retraso', 'retrasos'), null, g.retraso,
          `${decimal(g.faltas)} ${g.faltas === 1 ? 'falta' : 'faltas'}`]],
    })));
  }
  // En pantalla, personas enteras hasta llegar al máximo de filas
  const enPantalla = [];
  let n = 0;
  for (const g of lista) {
    if (enPantalla.length && n + g.filas.length > MAX_MARC_PANTALLA) break;
    enPantalla.push(g); n += g.filas.length;
  }
  res.json({ desde, hasta, total: filas.length, personas: lista.length, hojas: enPantalla, departamentos });
}

// ---------------- Horarios y feriados ----------------
// Los gestionan la plataforma y los usuarios de la empresa con perfil administrador; los de consulta solo los ven.
async function enTransaccion(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
// ---- Turnos (catálogo de cada empresa) ----
const COLORES_TURNO = ['teal', 'blue', 'orange', 'purple', 'gray'];
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Duración "1:30" o en minutos ("90")
const duracionMin = v => {
  const s = clean(v), m = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : /^\d+$/.test(s) ? Number(s) : NaN;
};
function datosTurno(b) {
  const hhmm = v => clean(v).slice(0, 5);
  const t = { nombre: clean(b.nombre), color: COLORES_TURNO.includes(b.color) ? b.color : 'teal', vale: Number(String(b.vale ?? 1).replace(',', '.')),
    entrada: hhmm(b.entrada), salida: hhmm(b.salida), limite_falta: hhmm(b.limite_falta), marca_desde: hhmm(b.marca_desde),
    marca_hasta: hhmm(b.marca_hasta), tolerancia: Number(b.tolerancia ?? 0), fuera: b.fuera === 'trabajadas' ? 'trabajadas' : 'sin_turno',
    descanso_desde: null, descanso_min: null, descanso_limite: null };
  if (!t.nombre) throw new HttpError(400, 'Ponle un nombre al turno');
  if (![0.5, 1, 1.5, 2].includes(t.vale)) throw new HttpError(400, '"Vale como" puede ser 0,5, 1, 1,5 o 2 días');
  if (!Number.isInteger(t.tolerancia) || t.tolerancia < 0 || t.tolerancia > 240) throw new HttpError(400, 'La tolerancia va de 0 a 240 minutos');
  for (const [k, nom] of [['entrada', 'la hora de entrada'], ['limite_falta', 'la hora de falta'], ['marca_desde', 'desde cuándo acepta marcar'],
    ['salida', 'la hora de salida'], ['marca_hasta', 'hasta cuándo acepta marcar']])
    if (!HORA_RE.test(t[k])) throw new HttpError(400, `Completa ${nom}`);
  if (b.descanso) {
    Object.assign(t, { descanso_desde: hhmm(b.descanso_desde), descanso_min: duracionMin(b.descanso_min), descanso_limite: hhmm(b.descanso_limite) });
    if (!HORA_RE.test(t.descanso_desde) || !HORA_RE.test(t.descanso_limite)) throw new HttpError(400, 'Descanso: completa las horas');
    if (!Number.isInteger(t.descanso_min) || t.descanso_min < 1 || t.descanso_min > 600)
      throw new HttpError(400, 'Descanso: la duración va de 0:01 a 10:00 (horas:minutos)');
  }
  const h = horasTurno(t);
  if (h.S - h.E < 30) throw new HttpError(400, 'El turno debe durar al menos 30 minutos');
  if (!(h.E < h.L && h.L < h.S)) throw new HttpError(400, 'La hora de falta debe quedar entre la entrada y la salida');
  if (h.E - h.eD > 720) throw new HttpError(400, '"Acepta la marcación desde" puede ser como mucho 12 horas antes de la entrada');
  if (h.sH - h.S > 720) throw new HttpError(400, '"Acepta la marcación hasta" puede ser como mucho 12 horas después de la salida');
  if (t.descanso_min) {
    if (!(h.L < h.dD)) throw new HttpError(400, 'El descanso debe empezar después de la hora de falta de la entrada');
    if (!(h.dD + h.dur < h.S)) throw new HttpError(400, 'El descanso debe terminar antes de la salida');
    if (!(h.dD < h.dL && h.dL < h.S)) throw new HttpError(400, 'La hora de falta de la 2.ª parte debe quedar entre "puede salir desde" y la salida');
  }
  return t;
}
async function turnoPropio(req, id) {
  const t = await one(`SELECT * FROM turnos WHERE id=$1`, [id]);
  if (!t) throw new HttpError(404, 'El turno no existe');
  checkEmpresa(req, t.empresa_id);
  return t;
}
async function nombreTurnoLibre(empresa_id, nombre, id = 0) {
  if (await one(`SELECT 1 FROM turnos WHERE empresa_id=$1 AND lower(nombre)=lower($2) AND id<>$3`, [empresa_id, nombre, id]))
    throw new HttpError(409, `Ya hay un turno llamado "${nombre}"`);
}
const CAMPOS_TURNO = ['nombre', 'color', 'vale', 'entrada', 'salida', 'limite_falta', 'marca_desde', 'marca_hasta', 'tolerancia',
  'descanso_desde', 'descanso_min', 'descanso_limite', 'fuera'];

app.get('/api/turnos', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const { rows } = await q(`SELECT ${TURNO_COLS}, x.nombre empresa,
      COALESCE((SELECT json_agg(DISTINCT h.nombre) FROM horario_dias d JOIN horarios h ON h.id=d.horario_id WHERE d.turno_id=t.id), '[]') horarios
    FROM turnos t JOIN empresas x ON x.id=t.empresa_id WHERE ($1::int IS NULL OR t.empresa_id=$1) ORDER BY x.nombre, t.entrada, t.nombre`, [emp]);
  res.json(rows);
});
app.post('/api/turnos', async (req, res) => {
  soloEditor(req);
  const empresa_id = isAdmin(req) ? numId(req.body.empresa_id) : req.user.empresa_id;
  if (!empresa_id) throw new HttpError(400, 'Elige la empresa');
  const t = datosTurno(req.body);
  await nombreTurnoLibre(empresa_id, t.nombre);
  res.json(await one(`INSERT INTO turnos (empresa_id, ${CAMPOS_TURNO}) VALUES ($1, ${CAMPOS_TURNO.map((_, i) => '$' + (i + 2))})
    RETURNING id, empresa_id, nombre`, [empresa_id, ...CAMPOS_TURNO.map(k => t[k])]));
});
// Ojo: cambiar un turno también cambia los reportes de fechas pasadas de quienes lo tenían
app.put('/api/turnos/:id', async (req, res) => {
  soloEditor(req);
  const actual = await turnoPropio(req, req.params.id), t = datosTurno(req.body);
  await nombreTurnoLibre(actual.empresa_id, t.nombre, actual.id);
  await q(`UPDATE turnos SET ${CAMPOS_TURNO.map((k, i) => `${k}=$${i + 2}`)} WHERE id=$1`, [actual.id, ...CAMPOS_TURNO.map(k => t[k])]);
  res.json({ ok: true });
});
app.delete('/api/turnos/:id', async (req, res) => {
  soloEditor(req);
  const t = await turnoPropio(req, req.params.id);
  const { rows } = await q(`SELECT DISTINCT h.nombre FROM horario_dias d JOIN horarios h ON h.id=d.horario_id WHERE d.turno_id=$1`, [t.id]);
  if (rows.length) throw new HttpError(409, `Este turno se usa en ${rows.length === 1 ? 'el horario' : 'los horarios'} ` +
    `${rows.map(r => `"${r.nombre}"`).join(', ')}. Quítalo de ahí antes de eliminarlo.`);
  await q(`DELETE FROM turnos WHERE id=$1`, [t.id]);
  res.json({ ok: true });
});

// ---- Horarios semanales: qué turno toca cada día ----
// dias: [{ dia, turno_id }]. También se aceptan las horas por día de la versión anterior ({ dia, entrada, salida,
// limite_falta }): se convierten en turnos, como al actualizar el panel.
function datosHorario(b) {
  const nombre = clean(b.nombre), tolerancia = Number(b.tolerancia || 0), hhmm = v => clean(v).slice(0, 5);
  if (!nombre) throw new HttpError(400, 'Ponle un nombre al horario');
  if (!Number.isInteger(tolerancia) || tolerancia < 0 || tolerancia > 240) throw new HttpError(400, 'La tolerancia va de 0 a 240 minutos');
  const dias = [].concat(b.dias || []).map(d => d.turno_id != null
    ? { dia: Number(d.dia), turno_id: numId(d.turno_id) }
    : { dia: Number(d.dia), entrada: hhmm(d.entrada), salida: hhmm(d.salida), limite_falta: hhmm(d.limite_falta) });
  if (!dias.length) throw new HttpError(400, 'Elige el turno de al menos un día');
  if (new Set(dias.map(d => d.dia)).size !== dias.length) throw new HttpError(400, 'Hay un día repetido');
  for (const d of dias) {
    const nom = DIA_SEM[d.dia];
    if (!Number.isInteger(d.dia) || !nom) throw new HttpError(400, 'Día no válido');
    if ('turno_id' in d) { if (!d.turno_id) throw new HttpError(400, `${nom}: elige el turno`); continue; }
    if (![d.entrada, d.salida, d.limite_falta].every(h => HORA_RE.test(h))) throw new HttpError(400, `${nom}: completa las horas`);
    if (!(d.entrada < d.limite_falta && d.limite_falta < d.salida))
      throw new HttpError(400, `${nom}: la hora de falta debe quedar entre la entrada y la salida`);
  }
  return { nombre, tolerancia, dias };
}
async function nombreHorarioLibre(empresa_id, nombre, id = 0) {
  if (await one(`SELECT 1 FROM horarios WHERE empresa_id=$1 AND lower(nombre)=lower($2) AND id<>$3`, [empresa_id, nombre, id]))
    throw new HttpError(409, `Ya hay un horario llamado "${nombre}"`);
}
// "lu–vi", "sá", "lu, mi": los días de un grupo, de lunes a domingo
const DIA_ABR = ['do', 'lu', 'ma', 'mi', 'ju', 'vi', 'sá'], SEMANA = [1, 2, 3, 4, 5, 6, 0];
function nombreDias(dias) {
  const grupos = [];
  for (const d of SEMANA.filter(x => dias.includes(x))) {
    const g = grupos.at(-1);
    if (g && SEMANA.indexOf(g.at(-1)) === SEMANA.indexOf(d) - 1) g.push(d); else grupos.push([d]);
  }
  return grupos.map(g => g.length > 2 ? `${DIA_ABR[g[0]]}–${DIA_ABR[g.at(-1)]}` : g.map(d => DIA_ABR[d]).join(', ')).join(', ');
}
// Horas por día (versión anterior) → turnos: uno por cada juego de horas distinto, que acepta marcar todo el día
// (así las marcaciones se agrupan por fecha, como antes). Si ya hay un turno igual en la empresa, se usa ese.
async function turnosDeHoras(c, empresa_id, nombreHorario, tolerancia, dias) {
  const grupos = new Map();
  for (const d of dias) {
    const k = `${d.entrada}|${d.salida}|${d.limite_falta}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(d);
  }
  const res = [];
  for (const g of grupos.values()) {
    const { entrada, salida, limite_falta } = g[0];
    let id = (await c.query(`SELECT id FROM turnos WHERE empresa_id=$1 AND entrada=$2 AND salida=$3 AND limite_falta=$4 AND tolerancia=$5
      AND marca_desde='00:00' AND marca_hasta='23:59' AND descanso_min IS NULL AND vale=1 AND fuera='sin_turno' ORDER BY id LIMIT 1`,
      [empresa_id, entrada, salida, limite_falta, tolerancia])).rows[0]?.id;
    if (!id) {
      const base = grupos.size > 1 ? `${nombreHorario} (${nombreDias(g.map(d => d.dia))})` : nombreHorario;
      let nombre = base;
      for (let i = 2; (await c.query(`SELECT 1 FROM turnos WHERE empresa_id=$1 AND lower(nombre)=lower($2)`, [empresa_id, nombre])).rowCount; i++)
        nombre = `${base} ${i}`;
      id = (await c.query(`INSERT INTO turnos (empresa_id, nombre, entrada, salida, limite_falta, marca_desde, marca_hasta, tolerancia)
        VALUES ($1,$2,$3,$4,$5,'00:00','23:59',$6) RETURNING id`, [empresa_id, nombre, entrada, salida, limite_falta, tolerancia])).rows[0].id;
    }
    for (const d of g) res.push({ dia: d.dia, turno_id: id });
  }
  return res;
}
async function guardarDias(c, h, dias) {
  const conHoras = dias.filter(d => !('turno_id' in d));
  const todos = [...dias.filter(d => 'turno_id' in d), ...(conHoras.length ? await turnosDeHoras(c, h.empresa_id, h.nombre, h.tolerancia, conHoras) : [])];
  const ids = [...new Set(todos.map(d => d.turno_id))];
  const { rows } = await c.query(`SELECT id FROM turnos WHERE id = ANY($1) AND empresa_id=$2`, [ids, h.empresa_id]);
  if (rows.length !== ids.length) throw new HttpError(400, 'Hay un turno que no existe o es de otra empresa');
  await c.query(`DELETE FROM horario_dias WHERE horario_id=$1`, [h.id]);
  for (const d of todos) await c.query(`INSERT INTO horario_dias (horario_id, dia, turno_id) VALUES ($1,$2,$3)`, [h.id, d.dia, d.turno_id]);
}
// Al arrancar: los horarios de la versión anterior (horas por día, sin turno) pasan a usar turnos. Los reportes no cambian.
async function migrarHorariosATurnos() {
  const { rows } = await q(`SELECT d.horario_id, d.dia, to_char(d.entrada,'HH24:MI') entrada, to_char(d.salida,'HH24:MI') salida,
      to_char(d.limite_falta,'HH24:MI') limite_falta, h.empresa_id, h.nombre, h.tolerancia
    FROM horario_dias d JOIN horarios h ON h.id=d.horario_id WHERE d.turno_id IS NULL AND d.entrada IS NOT NULL ORDER BY d.horario_id, d.dia`);
  if (!rows.length) return;
  const porHorario = new Map();
  for (const r of rows) { if (!porHorario.has(r.horario_id)) porHorario.set(r.horario_id, []); porHorario.get(r.horario_id).push(r); }
  await enTransaccion(async c => {
    for (const [horario_id, dias] of porHorario) {
      const { empresa_id, nombre, tolerancia } = dias[0];
      for (const d of await turnosDeHoras(c, empresa_id, nombre, tolerancia, dias))
        await c.query(`UPDATE horario_dias SET turno_id=$3 WHERE horario_id=$1 AND dia=$2`, [horario_id, d.dia, d.turno_id]);
    }
  });
  log(`🔁 ${porHorario.size} horario(s) pasaron a usar turnos (sus reportes no cambian)`);
}
async function horarioPropio(req, id) {
  const h = await one(`SELECT * FROM horarios WHERE id=$1`, [id]);
  if (!h) throw new HttpError(404, 'El horario no existe');
  checkEmpresa(req, h.empresa_id);
  return h;
}

app.get('/api/horarios', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const { rows } = await q(`
    SELECT h.id, h.empresa_id, x.nombre empresa, h.nombre, h.tolerancia,
      COALESCE((SELECT json_agg(json_build_object('dia', d.dia, 'turno_id', t.id, 'turno', t.nombre, 'color', t.color,
          'entrada', to_char(t.entrada,'HH24:MI'), 'salida', to_char(t.salida,'HH24:MI'), 'limite_falta', to_char(t.limite_falta,'HH24:MI')) ORDER BY d.dia)
        FROM horario_dias d JOIN turnos t ON t.id=d.turno_id WHERE d.horario_id=h.id), '[]') dias,
      (SELECT count(*)::int FROM empleados e WHERE e.empresa_id=h.empresa_id AND e.activo
         AND horario_vigente(e.id, (now() AT TIME ZONE 'America/La_Paz')::date) = h.id) empleados,
      COALESCE((SELECT eh.horario_id FROM empresa_horario eh WHERE eh.empresa_id=h.empresa_id
         AND eh.desde <= (now() AT TIME ZONE 'America/La_Paz')::date ORDER BY eh.desde DESC LIMIT 1) = h.id, false) principal
    FROM horarios h JOIN empresas x ON x.id=h.empresa_id
    WHERE ($1::int IS NULL OR h.empresa_id=$1) ORDER BY x.nombre, h.nombre`, [emp]);
  res.json(rows);
});

// Horario principal de cada empresa: el actual, los cambios anteriores y los programados, y cuántos tienen excepción hoy
app.get('/api/horarios/principal', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const { rows } = await q(`
    SELECT x.id empresa_id, x.nombre empresa,
      COALESCE((SELECT json_agg(json_build_object('desde', eh.desde::text, 'horario_id', eh.horario_id, 'horario', h.nombre) ORDER BY eh.desde DESC)
        FROM empresa_horario eh LEFT JOIN horarios h ON h.id=eh.horario_id WHERE eh.empresa_id=x.id), '[]') cambios,
      (SELECT count(*)::int FROM empleados e WHERE e.empresa_id=x.id AND e.activo AND (SELECT modo FROM empleado_horario
         WHERE empleado_id=e.id AND desde <= (now() AT TIME ZONE 'America/La_Paz')::date ORDER BY desde DESC LIMIT 1) <> 'empresa') excepciones
    FROM empresas x WHERE ($1::int IS NULL OR x.id=$1) ORDER BY x.nombre`, [emp]);
  res.json({ hoy: ahoraBO().slice(0, 10), empresas: rows });
});
// Pone o cambia el horario principal desde una fecha (horario_id vacío = sin horario desde esa fecha)
app.post('/api/horarios/principal', async (req, res) => {
  soloEditor(req);
  const empresa_id = isAdmin(req) ? numId(req.body.empresa_id) : req.user.empresa_id;
  const horario_id = numId(req.body.horario_id), desde = fechaParam(req.body.desde, '"desde"');
  if (!empresa_id) throw new HttpError(400, 'Elige la empresa');
  if (horario_id && (await horarioPropio(req, horario_id)).empresa_id !== empresa_id) throw new HttpError(400, 'Ese horario es de otra empresa');
  await q(`INSERT INTO empresa_horario (empresa_id, desde, horario_id) VALUES ($1,$2,$3)
           ON CONFLICT (empresa_id, desde) DO UPDATE SET horario_id=EXCLUDED.horario_id`, [empresa_id, desde, horario_id]);
  res.json({ ok: true });
});
// Quita un cambio del horario principal (por ejemplo, uno cargado con la fecha equivocada)
app.delete('/api/horarios/principal', async (req, res) => {
  soloEditor(req);
  const empresa_id = isAdmin(req) ? numId(req.query.empresa_id) : req.user.empresa_id, desde = fechaParam(req.query.desde, '"desde"');
  const r = await q(`DELETE FROM empresa_horario WHERE empresa_id=$1 AND desde=$2`, [empresa_id, desde]);
  if (!r.rowCount) throw new HttpError(404, 'Ese cambio no existe');
  res.json({ ok: true });
});
app.post('/api/horarios', async (req, res) => {
  soloEditor(req);
  const empresa_id = isAdmin(req) ? numId(req.body.empresa_id) : req.user.empresa_id;
  if (!empresa_id) throw new HttpError(400, 'Elige la empresa');
  const { nombre, tolerancia, dias } = datosHorario(req.body);
  await nombreHorarioLibre(empresa_id, nombre);
  res.json(await enTransaccion(async c => {
    const h = (await c.query(`INSERT INTO horarios (empresa_id, nombre, tolerancia) VALUES ($1,$2,$3) RETURNING *`, [empresa_id, nombre, tolerancia])).rows[0];
    await guardarDias(c, h, dias);
    return h;
  }));
});
// Ojo: cambiar un horario también cambia los reportes de fechas pasadas de quienes lo tenían
app.put('/api/horarios/:id', async (req, res) => {
  soloEditor(req);
  const h = await horarioPropio(req, req.params.id);
  const { nombre, tolerancia, dias } = datosHorario(req.body);
  await nombreHorarioLibre(h.empresa_id, nombre, h.id);
  res.json(await enTransaccion(async c => {
    await c.query(`UPDATE horarios SET nombre=$2, tolerancia=$3 WHERE id=$1`, [h.id, nombre, tolerancia]);
    await guardarDias(c, { ...h, nombre, tolerancia }, dias);
    return { ok: true };
  }));
});
app.delete('/api/horarios/:id', async (req, res) => {
  soloEditor(req);
  const h = await horarioPropio(req, req.params.id);
  const { n } = await one(`SELECT count(DISTINCT empleado_id)::int n FROM empleado_horario WHERE horario_id=$1`, [h.id]);
  if (n) throw new HttpError(409, `Este horario está o estuvo asignado a ${n} empleado(s) y sus reportes dependen de él. Crea uno nuevo en lugar de eliminarlo.`);
  if (await one(`SELECT 1 FROM empresa_horario WHERE horario_id=$1`, [h.id]))
    throw new HttpError(409, 'Este horario es o fue el principal de la empresa y sus reportes dependen de él. Crea uno nuevo en lugar de eliminarlo.');
  await q(`DELETE FROM horarios WHERE id=$1`, [h.id]);
  res.json({ ok: true });
});

// Excepción para varios empleados desde una fecha: un horario propio ('horario'), sin control ('sin_horario')
// o volver al horario de la empresa ('empresa'). Lo anterior a esa fecha no cambia.
app.post('/api/horarios/asignar', async (req, res) => {
  soloEditor(req);
  const ids = [...new Set([].concat(req.body.empleados || []).map(Number).filter(Boolean))];
  const modo = req.body.modo || (req.body.horario_id ? 'horario' : 'empresa');
  const horario_id = modo === 'horario' ? numId(req.body.horario_id) : null, desde = fechaParam(req.body.desde, '"desde"');
  if (!['horario', 'sin_horario', 'empresa'].includes(modo)) throw new HttpError(400, 'Opción no válida');
  if (modo === 'horario' && !horario_id) throw new HttpError(400, 'Elige el horario');
  if (!ids.length) throw new HttpError(400, 'Elige al menos un empleado');
  const { rows } = await q(`SELECT DISTINCT empresa_id FROM empleados WHERE id = ANY($1)`, [ids]);
  const { n } = await one(`SELECT count(*)::int n FROM empleados WHERE id = ANY($1)`, [ids]);
  if (n !== ids.length) throw new HttpError(400, 'Hay empleados que no existen');
  if (rows.length !== 1) throw new HttpError(400, 'Elige empleados de una sola empresa');
  const empresa_id = rows[0].empresa_id;
  checkEmpresa(req, empresa_id);
  if (horario_id && (await horarioPropio(req, horario_id)).empresa_id !== empresa_id)
    throw new HttpError(400, 'Ese horario es de otra empresa');
  await q(`INSERT INTO empleado_horario (empleado_id, desde, horario_id, modo) SELECT unnest($1::int[]), $2, $3, $4
           ON CONFLICT (empleado_id, desde) DO UPDATE SET horario_id=EXCLUDED.horario_id, modo=EXCLUDED.modo`, [ids, desde, horario_id, modo]);
  res.json({ ok: true, asignados: ids.length });
});

app.get('/api/feriados', async (req, res) => {
  const emp = empresaScope(req, req.query.empresa_id);
  const anio = Number(req.query.anio) || Number(ahoraBO().slice(0, 4));
  const { rows } = await q(`SELECT f.id, f.fecha::text fecha, f.nombre, f.empresa_id, x.nombre empresa
    FROM feriados f LEFT JOIN empresas x ON x.id=f.empresa_id
    WHERE EXTRACT(year FROM f.fecha) = $2 AND (f.empresa_id IS NULL OR $1::int IS NULL OR f.empresa_id=$1)
    ORDER BY f.fecha, f.empresa_id NULLS FIRST`, [emp, anio]);
  res.json(rows);
});
app.post('/api/feriados', async (req, res) => {
  soloEditor(req);
  // Sin empresa = nacional (vale para todas): solo lo carga la plataforma
  const empresa_id = isAdmin(req) ? numId(req.body.empresa_id) : req.user.empresa_id;
  const fecha = fechaParam(req.body.fecha, 'del feriado'), nombre = clean(req.body.nombre);
  if (!nombre) throw new HttpError(400, 'Ponle un nombre al feriado');
  if (await one(`SELECT 1 FROM feriados WHERE fecha=$1 AND (empresa_id IS NULL OR empresa_id IS NOT DISTINCT FROM $2::int)`, [fecha, empresa_id]))
    throw new HttpError(409, 'Ese día ya está cargado como feriado');
  res.json(await one(`INSERT INTO feriados (empresa_id, fecha, nombre) VALUES ($1,$2,$3) RETURNING id`, [empresa_id, fecha, nombre]));
});
app.delete('/api/feriados/:id', async (req, res) => {
  soloEditor(req);
  const f = await one(`SELECT * FROM feriados WHERE id=$1`, [req.params.id]);
  if (!f) throw new HttpError(404, 'El feriado no existe');
  if (!isAdmin(req) && f.empresa_id !== req.user.empresa_id)
    throw new HttpError(403, f.empresa_id ? 'No autorizado' : 'Los feriados nacionales los administra soporte');
  await q(`DELETE FROM feriados WHERE id=$1`, [f.id]);
  res.json({ ok: true });
});

// Usuarios del sistema (logins). La plataforma gestiona todos; el administrador de una empresa, solo los de
// su empresa, y nunca puede crear usuarios de la plataforma.
const PERFILES = ['administrador', 'consulta'];
async function usuarioGestionable(req, id) {
  const u = await one(`SELECT * FROM usuarios_sistema WHERE id=$1`, [id]);
  if (!u) throw new HttpError(404, 'El usuario no existe');
  if (!isAdmin(req) && (u.rol !== 'empresa' || u.empresa_id !== req.user.empresa_id)) throw new HttpError(403, 'No autorizado');
  return u;
}
app.get('/api/usuarios-sistema', async (req, res) => {
  soloEditor(req);
  // bloqueado_hasta: solo si está bloqueado ahora por intentos fallidos
  const { rows } = await q(`SELECT u.id,u.email,u.nombre,u.rol,u.perfil,u.empresa_id,e.nombre empresa,u.creado,
      CASE WHEN i.bloqueado_hasta > now() THEN i.bloqueado_hasta END bloqueado_hasta
    FROM usuarios_sistema u LEFT JOIN empresas e ON e.id=u.empresa_id LEFT JOIN intentos_login i ON i.email=lower(u.email)
    WHERE ($1::int IS NULL OR u.empresa_id=$1) ORDER BY u.rol, e.nombre, u.email`, [isAdmin(req) ? null : req.user.empresa_id]);
  res.json(rows);
});
app.post('/api/usuarios-sistema', async (req, res) => {
  soloEditor(req);
  const { email, nombre, password, perfil = 'administrador' } = req.body;
  const rol = isAdmin(req) && req.body.rol === 'admin' ? 'admin' : 'empresa';
  const empresa_id = rol === 'admin' ? null : isAdmin(req) ? req.body.empresa_id : req.user.empresa_id;
  if (!clean(email)) throw new HttpError(400, 'Escribe el correo');
  validarClave(password);
  if (rol === 'empresa' && !empresa_id) throw new HttpError(400, 'Elige la empresa');
  if (!PERFILES.includes(perfil)) throw new HttpError(400, 'Perfil no válido');
  res.json(await one(`INSERT INTO usuarios_sistema (email,nombre,hash,rol,empresa_id,perfil) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,email`,
    [clean(email).toLowerCase(), clean(nombre), hashPass(password), rol, empresa_id, perfil]));
});
// Poner una clave nueva también desbloquea la cuenta
app.put('/api/usuarios-sistema/:id/password', async (req, res) => {
  soloEditor(req);
  const u = await usuarioGestionable(req, req.params.id);
  await q(`UPDATE usuarios_sistema SET hash=$2 WHERE id=$1`, [u.id, hashPass(validarClave(req.body.password))]);
  await q(`DELETE FROM intentos_login WHERE email=lower($1)`, [u.email]);
  res.json({ ok: true });
});
app.post('/api/usuarios-sistema/:id/desbloquear', async (req, res) => {
  soloEditor(req);
  const u = await usuarioGestionable(req, req.params.id);
  await q(`DELETE FROM intentos_login WHERE email=lower($1)`, [u.email]);
  res.json({ ok: true });
});
app.delete('/api/usuarios-sistema/:id', async (req, res) => {
  soloEditor(req);
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'No puedes eliminar tu propio usuario');
  const u = await usuarioGestionable(req, req.params.id);
  await q(`DELETE FROM usuarios_sistema WHERE id=$1`, [u.id]);
  res.json({ ok: true });
});

// Dashboards: las empresas entran por /clientes y la plataforma por /admin
app.get('/', (req, res) => res.redirect('/clientes/'));
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
    log(`BioPanel escuchando en puerto ${cfg.PORT} → administración: http://localhost:${cfg.PORT}/admin · clientes: http://localhost:${cfg.PORT}/clientes`)))
  .catch(e => {
    console.error('\n❌ No pude conectar a PostgreSQL:', e.message);
    console.error('   Revisa DATABASE_URL en config.js (usuario, contraseña y puerto de PostgreSQL).\n');
    process.exit(1);
  });
