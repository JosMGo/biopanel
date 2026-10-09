// Restaura un respaldo de BioPanel en una base NUEVA (nunca encima de la que está en uso).
//   node scripts/restaurar.js "<archivo .dump.enc>"            → crea senseface_restaurada_<fecha> con los datos
//   node scripts/restaurar.js "<archivo .dump.enc>" mi_base    → con ese nombre
//   node scripts/restaurar.js "<archivo .dump.enc>" --probar   → restaura, muestra los totales y la borra (prueba mensual)
// Sin argumentos, usa el respaldo más reciente de la carpeta de respaldos.
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const { Client } = require('pg');
const { clave, descifrar, binario, entornoPg, url } = require('./respaldo');

const args = process.argv.slice(2), probar = args.includes('--probar');
const [archivoArg, baseArg] = args.filter(a => a !== '--probar');
const carpeta = process.env.RESPALDO_DIR || path.join(os.homedir(), 'OneDrive', 'Respaldos BioPanel');

const conectar = db => { const u = new URL(url); u.pathname = '/' + db; return new Client({ connectionString: u.toString() }); };
async function sql(db, texto, p) { const c = conectar(db); await c.connect(); try { return (await c.query(texto, p)).rows; } finally { await c.end(); } }

(async () => {
  const archivo = archivoArg || (() => {
    const lista = fs.existsSync(carpeta) ? fs.readdirSync(carpeta).filter(f => f.endsWith('.dump.enc')).sort() : [];
    if (!lista.length) throw new Error(`No hay respaldos en ${carpeta}`);
    return path.join(carpeta, lista.at(-1));
  })();
  const fecha = (/(\d{4}-\d{2}-\d{2})_(\d{4})/.exec(path.basename(archivo)) || []).slice(1).join('_') || 'copia';
  const base = probar ? `senseface_prueba_restauracion` : baseArg || `senseface_restaurada_${fecha.replace(/-/g, '')}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(base)) throw new Error('Nombre de base no válido (minúsculas, números y _)');
  if (base === decodeURIComponent(url.pathname.slice(1))) throw new Error('Esa es la base en uso: restaura en una base nueva');
  if (probar) await sql('postgres', `DROP DATABASE IF EXISTS ${base} WITH (FORCE)`);
  if ((await sql('postgres', `SELECT 1 FROM pg_database WHERE datname=$1`, [base])).length) throw new Error(`La base ${base} ya existe: elige otro nombre`);

  console.log(`Restaurando ${path.basename(archivo)} en la base nueva "${base}"…`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biopanel-'));
  try {
    const dump = path.join(tmp, 'base.dump');
    await descifrar(archivo, dump, clave());
    await sql('postgres', `CREATE DATABASE ${base}`);
    execFileSync(binario('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '-d', base, dump],
      { env: { ...entornoPg(), PGDATABASE: base }, stdio: ['ignore', 'ignore', 'pipe'] });
    const [t] = await sql(base, `SELECT (SELECT count(*) FROM empresas)::int empresas, (SELECT count(*) FROM empleados)::int empleados,
      (SELECT count(*) FROM marcaciones)::int marcaciones, (SELECT max(fecha)::text FROM marcaciones) ultima_marcacion`);
    console.log(`✔ Restaurado: ${t.empresas} empresas · ${t.empleados} empleados · ${t.marcaciones} marcaciones · última marcación ${t.ultima_marcacion || '—'}`);
    if (probar) { await sql('postgres', `DROP DATABASE IF EXISTS ${base} WITH (FORCE)`); console.log('Prueba terminada: el respaldo sirve. Base de prueba borrada.'); }
    else console.log(`Para usarla, cambia DATABASE_URL a .../${base}. Para borrarla: DROP DATABASE ${base};`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error('✘', e.stderr ? String(e.stderr).trim() : e.message); process.exit(1); });
