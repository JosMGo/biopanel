// Respaldo de la base de BioPanel: copia completa con pg_dump, cifrada (AES-256-GCM), en la carpeta de respaldos.
// Guarda los últimos 14 días, 8 semanas (el último de cada semana) y 24 cierres de mes (el último de cada mes);
// borra el resto. Comprueba cada copia antes de darla por buena. Uso: node scripts/respaldo.js
//
// Variables (opcionales):
//   DATABASE_URL          la base (si no, la de config.js)
//   RESPALDO_DIR          carpeta destino (por defecto: OneDrive\Respaldos BioPanel)
//   RESPALDO_CLAVE        archivo con la clave de cifrado (por defecto: ~\.biopanel\respaldo.key; si no existe, se crea)
//   PG_BIN                carpeta de pg_dump/pg_restore (si no, la de PostgreSQL instalado o el PATH)
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { pipeline } = require('stream/promises');

const raiz = path.join(__dirname, '..');
const url = new URL(process.env.DATABASE_URL || require(path.join(raiz, 'config.js')).DATABASE_URL);
const destino = process.env.RESPALDO_DIR || path.join(os.homedir(), 'OneDrive', 'Respaldos BioPanel');
const archivoClave = process.env.RESPALDO_CLAVE || path.join(os.homedir(), '.biopanel', 'respaldo.key');
const GUARDAR = { dias: 14, semanas: 8, meses: 24 };
const MAGIA = Buffer.from('BPR1'); // formato: "BPR1" + iv (12 bytes) + datos cifrados + etiqueta GCM (16 bytes)

function binario(nombre) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, nombre + ext);
  const base = 'C:/Program Files/PostgreSQL';
  if (process.platform === 'win32' && fs.existsSync(base)) {
    const versiones = fs.readdirSync(base).filter(v => fs.existsSync(path.join(base, v, 'bin', nombre + ext))).sort((a, b) => b - a);
    if (versiones.length) return path.join(base, versiones[0], 'bin', nombre + ext);
  }
  return nombre + ext; // en el PATH (Linux / Docker)
}
const entornoPg = () => ({ ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) });

function clave() {
  if (!fs.existsSync(archivoClave)) {
    fs.mkdirSync(path.dirname(archivoClave), { recursive: true });
    fs.writeFileSync(archivoClave, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    console.log(`⚠ Se creó la clave de cifrado en ${archivoClave}. GUARDA UNA COPIA FUERA DE ESTA PC (USB o gestor de contraseñas):`);
    console.log('  sin ella los respaldos no se pueden abrir.');
  }
  const k = Buffer.from(fs.readFileSync(archivoClave, 'utf8').trim(), 'hex');
  if (k.length !== 32) throw new Error(`La clave de ${archivoClave} no es válida (deben ser 64 caracteres hexadecimales)`);
  return k;
}

async function cifrar(origen, salida, k) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const out = fs.createWriteStream(salida);
  out.write(Buffer.concat([MAGIA, iv]));
  await pipeline(fs.createReadStream(origen), c, out, { end: false });
  await new Promise((ok, mal) => out.end(c.getAuthTag(), e => e ? mal(e) : ok()));
}
async function descifrar(origen, salida, k) {
  const { size } = fs.statSync(origen), fd = fs.openSync(origen, 'r');
  const cab = Buffer.alloc(16), tag = Buffer.alloc(16);
  fs.readSync(fd, cab, 0, 16, 0); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  if (!cab.subarray(0, 4).equals(MAGIA)) throw new Error('El archivo no es un respaldo de BioPanel');
  const d = crypto.createDecipheriv('aes-256-gcm', k, cab.subarray(4, 16));
  d.setAuthTag(tag); // si la clave no es la correcta o el archivo se dañó, falla al terminar
  try { await pipeline(fs.createReadStream(origen, { start: 16, end: size - 17 }), d, fs.createWriteStream(salida)); }
  catch { throw new Error('No se pudo abrir el respaldo: la clave no es la de este respaldo, o el archivo está dañado'); }
}

// Qué copias conservar: los 14 días más recientes, el último de cada una de las 8 semanas más recientes y el último
// de cada uno de los 24 meses más recientes. Los nombres llevan la fecha: biopanel_AAAA-MM-DD_HHMM.dump.enc
function aBorrar(archivos) {
  const copias = archivos.map(f => ({ f, m: /^biopanel_(\d{4})-(\d{2})-(\d{2})_(\d{4})\.dump\.enc$/.exec(f) })).filter(x => x.m)
    .map(({ f, m }) => ({ f, fecha: new Date(Date.UTC(+m[1], m[2] - 1, +m[3])), dia: `${m[1]}-${m[2]}-${m[3]}`, mes: `${m[1]}-${m[2]}` }))
    .sort((a, b) => b.f.localeCompare(a.f));
  const semana = d => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
  const quedan = new Set(), ultimoDe = (clave, n) => { const vistos = new Set(); for (const c of copias) { const k = clave(c); if (vistos.has(k)) continue; vistos.add(k); if (vistos.size > n) break; quedan.add(c.f); } };
  ultimoDe(c => c.dia, GUARDAR.dias);
  ultimoDe(c => semana(c.fecha), GUARDAR.semanas);
  ultimoDe(c => c.mes, GUARDAR.meses);
  return copias.filter(c => !quedan.has(c.f)).map(c => c.f);
}

async function respaldar() {
  const k = clave();
  fs.mkdirSync(destino, { recursive: true });
  const ahora = new Date().toLocaleString('sv-SE', { timeZone: 'America/La_Paz' }); // AAAA-MM-DD HH:MM:SS
  const nombre = `biopanel_${ahora.slice(0, 10)}_${ahora.slice(11, 13)}${ahora.slice(14, 16)}.dump.enc`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biopanel-'));
  const dump = path.join(tmp, 'base.dump'), prueba = path.join(tmp, 'prueba.dump'), final = path.join(destino, nombre);
  try {
    // Formato propio de PostgreSQL: comprimido y se restaura con pg_restore
    execFileSync(binario('pg_dump'), ['--format=custom', '--compress=9', '--no-owner', '--no-privileges', '-f', dump], { env: entornoPg(), stdio: ['ignore', 'ignore', 'pipe'] });
    await cifrar(dump, final + '.parcial', k);
    // Comprobación: se descifra la copia ya escrita y pg_restore debe poder leerla entera
    await descifrar(final + '.parcial', prueba, k);
    const tablas = execFileSync(binario('pg_restore'), ['--list', prueba], { encoding: 'utf8' }).split('\n').filter(l => / TABLE DATA /.test(l)).length;
    if (!tablas) throw new Error('La copia no tiene datos de tablas');
    fs.renameSync(final + '.parcial', final);
    const borradas = aBorrar(fs.readdirSync(destino));
    for (const f of borradas) fs.unlinkSync(path.join(destino, f));
    const kb = Math.round(fs.statSync(final).size / 1024);
    anotar(`OK ${nombre} | ${kb} KB | ${tablas} tablas${borradas.length ? ` | borradas ${borradas.length} viejas` : ''}`);
  } catch (e) {
    try { fs.unlinkSync(final + '.parcial'); } catch {}
    anotar(`ERROR ${e.stderr ? String(e.stderr).trim() : e.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function anotar(linea) {
  const texto = `${new Date().toLocaleString('sv-SE', { timeZone: 'America/La_Paz' })}  ${linea}`;
  console.log(texto);
  try { fs.appendFileSync(path.join(destino, 'respaldos.log'), texto + '\n'); } catch {}
}

module.exports = { clave, descifrar, binario, entornoPg, aBorrar, url };
if (require.main === module) respaldar();
