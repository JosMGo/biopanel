// Código común a los dos paneles: /admin (plataforma) y /clientes (empresas cliente).
// Cada página define su menú con menu(), agrega sus vistas propias a VIEWS y llama a start().
// Lo que un cliente no puede hacer aquí solo se oculta: el servidor lo bloquea igual.
const PANEL = document.body.dataset.panel;          // 'admin' | 'clientes'
const LS = PANEL === 'admin' ? 'bp_' : 'bpc_';      // sesión propia de cada panel en el mismo navegador
const MENU_REPORTES = [['rep-empleados','Por empleados'], ['rep-sucursales','Por sucursal'], ['rep-fecha','Por fecha'],
  ['rep-marcaciones','Detalle de marcaciones']];

const ICON = {
  resumen:'<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  empresas:'<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1"/>',
  sucursales:'<path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  dispositivos:'<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="9" r="3"/><path d="M9 17h6"/>',
  empleados:'<circle cx="9" cy="8" r="3.5"/><path d="M2 20c1-3.5 3.8-5.5 7-5.5s6 2 7 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.4 2.4 4 5.5"/>',
  marcaciones:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  reportes:'<path d="M3 3v18h18"/><path d="M8 16v-4M13 16V8M18 16v-7"/>',
  horarios:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M12 12v3.5l2.5 1.5"/>',
  usuarios:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  empresa:'<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1"/>'
};
const VERIF = {0:'Clave',1:'Huella',2:'Tarjeta',3:'Clave',4:'Tarjeta',15:'Rostro',25:'Palma'};
const ESTADO_ED = {sincronizado:['ok','Sincronizado'],pendiente:['warn','Pendiente'],error:['err','Error'],eliminando:['warn','Quitando']};

let token = localStorage.getItem(LS + 'token') || '';
let me = null, empresas = [], sucursales = [], current = 'resumen', timer = null, navKeys = [];
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isAdmin = () => me && me.rol === 'admin';
// Puede modificar empleados y usuarios: la plataforma o un usuario de la empresa con perfil administrador
const puedeEditar = () => isAdmin() || (me && me.perfil === 'administrador');
const scope = () => ({ empresa_id: isAdmin() ? $('#scopeEmpresa').value : '', sucursal_id: $('#scopeSucursal').value });
const qs = o => { const p = new URLSearchParams(); for (const k in o) if (o[k] !== '' && o[k] != null) p.set(k, o[k]); const s = p.toString(); return s ? '?' + s : ''; };

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (r.status === 401 && path !== '/login') { logout(); throw new Error('Sesión expirada'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Error ' + r.status);
  return data;
}
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}
async function run(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); throw e; } }
function hace(ts) {
  if (!ts) return 'nunca';
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return `hace ${s}s`; if (s < 3600) return `hace ${Math.round(s/60)} min`;
  if (s < 86400) return `hace ${Math.round(s/3600)} h`; return new Date(ts).toLocaleString('es-BO');
}
const tipoBadge = t => t === 'acceso' ? '<span class="badge acc">Control de acceso</span>' : '<span class="badge">Biométrico</span>';

/* ---------- Sesión ---------- */
// Botón con un ojo para ver u ocultar la contraseña. Devuelve una función que la vuelve a ocultar.
const OJO = {
  ver: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  ocultar: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>',
};
function ojoClave(input) {
  const caja = document.createElement('span'), b = document.createElement('button');
  caja.className = 'clave-caja'; input.replaceWith(caja); caja.append(input, b);
  b.type = 'button'; b.className = 'ojo';
  const pintar = () => {
    const visible = input.type === 'text';
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${visible ? OJO.ocultar : OJO.ver}</svg>`;
    b.title = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
    b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', visible);
  };
  b.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; pintar(); input.focus(); };
  pintar();
  return () => { input.type = 'password'; pintar(); };
}
const ocultarClaveLogin = ojoClave($('#loginForm [name=password]'));

$('#loginForm').onsubmit = async ev => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  try {
    const r = await api('/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password'), panel: PANEL } });
    $('#loginErr').textContent = '';
    // La clave no queda escrita (ni a la vista) en el formulario para cuando se cierre la sesión
    ev.target.password.value = ''; ocultarClaveLogin();
    token = r.token; localStorage.setItem(LS + 'token', token); start();
  } catch (e) { $('#loginErr').textContent = e.message; }
};
function logout() { token = ''; localStorage.removeItem(LS + 'token'); clearInterval(timer); $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }

async function start() {
  if (!token) return logout();
  try { me = await api('/me'); } catch { return; }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#meName').textContent = me.nombre || me.email;
  $('#meEmpresa').textContent = isAdmin() ? 'Administrador' : me.empresa;
  $('#aviso')?.classList.toggle('hidden', !me.desactualizado);
  const items = menu(); // lo define cada panel
  navKeys = items.flatMap(([k, , sub]) => sub ? sub.map(s => s[0]) : [k]);
  const icono = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
  $('#nav').innerHTML = items.map(([k, t, sub]) => sub
    ? `<div class="nav-grp">${icono(k)}${t}</div>` + sub.map(([k2, t2]) => `<a data-v="${k2}" class="sub">${t2}</a>`).join('')
    : `<a data-v="${k}">${icono(k)}${t}</a>`).join('');
  $('#nav').onclick = e => { const a = e.target.closest('a'); if (a) go(a.dataset.v); };
  await cargarScope();
  go(localStorage.getItem(LS + 'view') || 'resumen');
}

async function cargarScope() {
  empresas = await api('/empresas');
  const se = $('#scopeEmpresa');
  if (isAdmin()) {
    se.classList.remove('hidden');
    const prev = localStorage.getItem(LS + 'emp') || '';
    se.innerHTML = '<option value="">Todas las empresas</option>' + empresas.map(e => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('');
    se.value = empresas.some(e => String(e.id) === prev) ? prev : '';
  }
  await cargarSucursales();
}
async function cargarSucursales() {
  sucursales = await api('/sucursales' + qs({ empresa_id: scope().empresa_id }));
  const ss = $('#scopeSucursal'), prev = localStorage.getItem(LS + 'suc') || '';
  ss.innerHTML = '<option value="">Todas las sucursales</option>' + sucursales.map(s =>
    `<option value="${s.id}">${esc(isAdmin() && !scope().empresa_id ? s.empresa + ' · ' : '')}${esc(s.nombre)}</option>`).join('');
  ss.value = sucursales.some(s => String(s.id) === prev) ? prev : '';
}
$('#scopeEmpresa').onchange = async () => { localStorage.setItem(LS + 'emp', $('#scopeEmpresa').value); localStorage.removeItem(LS + 'suc'); rep.sel = null; await cargarSucursales(); render(); };
$('#scopeSucursal').onchange = () => { localStorage.setItem(LS + 'suc', $('#scopeSucursal').value); rep.sel = null; render(); };

function go(v) {
  if (!VIEWS[v] || !navKeys.includes(v)) v = 'resumen';
  current = v; localStorage.setItem(LS + 'view', v); rep.sel = null;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.v === v));
  $('#side').classList.remove('open');
  render();
}
async function render() {
  clearInterval(timer);
  const v = VIEWS[current];
  $('#title').textContent = v.title;
  try { await v.render(); } catch (e) { $('#view').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
  if (v.auto) timer = setInterval(() => v.render().catch(() => {}), 10000);
}

/* ---------- Modal ---------- */
function modal({ title, body, onSave, saveText = 'Guardar', wide }) {
  $('#modalRoot').innerHTML = `<div class="modal-bg"><form class="modal ${wide ? 'wide' : ''}">
    <div class="modal-h"><h3>${esc(title)}</h3><button type="button" class="x" data-close>×</button></div>
    <div class="modal-b">${body}</div>
    <div class="modal-f"><button type="button" class="btn" data-close>${onSave ? 'Cancelar' : 'Cerrar'}</button>${onSave ? `<button class="btn primary">${saveText}</button>` : ''}</div>
  </form></div>`;
  const form = $('#modalRoot form');
  $('#modalRoot').querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  form.onsubmit = async ev => {
    ev.preventDefault(); if (!onSave) return;
    const btn = form.querySelector('.btn.primary'); btn.disabled = true;
    try { await onSave(form); closeModal(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  };
  return form;
}
function closeModal() { $('#modalRoot').innerHTML = ''; }
const fd = form => Object.fromEntries(new FormData(form));
const confirmar = msg => window.confirm(msg);

/* ---------- Usuarios del sistema (los dos paneles) ---------- */
const PERFIL = { administrador: ['acc', 'Administrador'], consulta: ['', 'Consulta'] };
const perfilBadge = p => { const [c, t] = PERFIL[p] || ['', p]; return `<span class="badge ${c}">${t}</span>`; };
const perfilSelect = () => `<label class="f">Perfil<select name="perfil">
  <option value="administrador">Administrador: gestiona empleados y usuarios de la empresa</option>
  <option value="consulta">Consulta: solo ve (resumen, marcaciones, reportes…)</option></select></label>`;
// Misma regla que el servidor para las claves nuevas: mínimo 8 caracteres, con letras y números
const CLAVE_REGLA = 'Mínimo 8 caracteres, con letras y números';
const claveInput = (name, tipo = 'text', required = true) =>
  `<input name="${name}" type="${tipo}" minlength="8" maxlength="128" pattern="(?=.*\\p{L})(?=.*\\d).{8,}" title="${CLAVE_REGLA}" ${required ? 'required' : ''} autocomplete="new-password">`;
function resetClave(id) {
  modal({ title: 'Cambiar clave', body: `<label class="f">Nueva contraseña${claveInput('password')}</label><p class="hint" style="margin:0">${CLAVE_REGLA}. Si la cuenta estaba bloqueada por intentos fallidos, también se desbloquea.</p>`,
    async onSave(f) { await api(`/usuarios-sistema/${id}/password`, { method: 'PUT', body: fd(f) }); toast('Clave actualizada'); render(); } });
}
// Cuenta bloqueada por intentos fallidos: se libera sola a los 15 minutos o con el botón Desbloquear
const bloqueoBadge = u => u.bloqueado_hasta
  ? ` <span class="badge err" title="Bloqueada por intentos fallidos hasta las ${new Date(u.bloqueado_hasta).toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' })}">Bloqueada</span>` : '';
const botonDesbloquear = u => u.bloqueado_hasta ? `<button class="btn sm" onclick="desbloquear(${u.id})">Desbloquear</button>` : '';
async function desbloquear(id) {
  await run(() => api(`/usuarios-sistema/${id}/desbloquear`, { method: 'POST' }), 'Cuenta desbloqueada'); render();
}
async function borrarUsuario(id) {
  if (!confirmar('¿Eliminar este acceso? La persona deja de poder entrar en ese momento.')) return;
  await run(() => api('/usuarios-sistema/' + id, { method: 'DELETE' }), 'Acceso eliminado'); render();
}

function empresaSelect(name, value, required = true) {
  return `<label class="f">Empresa<select name="${name}" ${required ? 'required' : ''}><option value="">Elegir…</option>${empresas.map(e => `<option value="${e.id}" ${String(value) === String(e.id) ? 'selected' : ''}>${esc(e.nombre)}</option>`).join('')}</select></label>`;
}

/* ---------- Vistas ---------- */
const VIEWS = {};

VIEWS.resumen = { title: 'Resumen', auto: true, async render() {
  const s = scope();
  const [r, devs, marc] = await Promise.all([api('/resumen' + qs(s)), api('/dispositivos' + qs(s)), api('/marcaciones' + qs({ ...s, limit: 12 }))]);
  $('#view').innerHTML = `
    ${r.sin_asignar > 0 ? `<div class="alert">Hay ${r.sin_asignar} equipo(s) conectado(s) sin asignar a una sucursal. <a onclick="go('dispositivos')" style="cursor:pointer">Asignar ahora</a></div>` : ''}
    <div class="tiles">
      <div class="card tile"><div class="k">Equipos en línea</div><div class="v">${r.en_linea}<small> / ${r.dispositivos}</small></div></div>
      <div class="card tile"><div class="k">Empleados</div><div class="v">${r.empleados}</div></div>
      <div class="card tile"><div class="k">Marcaciones hoy</div><div class="v">${r.marcaciones_hoy}</div></div>
    </div>
    <div class="two">
      <div class="card"><div class="card-h"><h2>${VIEWS.dispositivos ? 'Dispositivos' : 'Relojes'}</h2>${VIEWS.dispositivos ? `<button class="btn sm" onclick="go('dispositivos')">Ver todos</button>` : ''}</div>
        <div class="dev-list">${devs.filter(d => d.empresa_id).map(d => `<div class="dev-row"><span class="dot ${d.en_linea ? 'on' : ''}"></span>
          <div class="grow"><b>${esc(d.nombre)}</b><div class="sub hint">${esc(d.sucursal || '')} · ${hace(d.ultimo_contacto)}</div></div>${tipoBadge(d.tipo)}</div>`).join('') || '<div class="empty">Sin dispositivos</div>'}</div></div>
      <div class="card"><div class="card-h"><h2>Últimas marcaciones</h2><button class="btn sm" onclick="go('marcaciones')">Ver todas</button></div>
        <div class="table-wrap"><table><tbody>${marc.map(m => `<tr><td><b>${esc(m.empleado || 'PIN ' + m.pin)}</b><div class="sub">${esc(m.dispositivo)}</div></td>
          <td class="num" style="text-align:right">${esc(m.fecha.slice(11,16))}<div class="sub">${esc(m.fecha.slice(0,10))}</div></td></tr>`).join('') || '<tr><td class="empty">Sin marcaciones</td></tr>'}</tbody></table></div></div>
    </div>`;
}};

VIEWS.sucursales = { title: 'Sucursales', async render() {
  const list = await api('/sucursales' + qs({ empresa_id: scope().empresa_id }));
  // El cliente solo las ve: crear, editar y eliminar es de la plataforma
  $('#view').innerHTML = `<div class="card"><div class="card-h"><h2>${list.length} sucursales</h2>${isAdmin() ? '<button class="btn primary" onclick="formSucursal()">+ Nueva sucursal</button>' : ''}</div>
    <div class="table-wrap"><table><thead><tr>${isAdmin() ? '<th>Empresa</th>' : ''}<th>Sucursal</th><th>Dirección</th><th class="num">Biométricos</th><th class="num">Control de acceso</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
    ${list.map(s => `<tr>${isAdmin() ? `<td>${esc(s.empresa)}</td>` : ''}<td><b>${esc(s.nombre)}</b></td><td>${esc(s.direccion)}</td><td class="num">${s.biometricos}</td><td class="num">${s.accesos}</td>
      ${isAdmin() ? `<td><div class="actions"><button class="btn sm" onclick='formSucursal(${JSON.stringify(s).replace(/'/g, "&#39;")})'>Editar</button><button class="btn sm danger" onclick="borrarSucursal(${s.id})">Eliminar</button></div></td>` : ''}</tr>`).join('') || '<tr><td colspan="6" class="empty">Sin sucursales</td></tr>'}
    </tbody></table></div></div>`;
}};
function formSucursal(s = {}) {
  modal({ title: s.id ? 'Editar sucursal' : 'Nueva sucursal', body: `
    ${isAdmin() && !s.id ? empresaSelect('empresa_id', scope().empresa_id) : ''}
    <label class="f">Nombre<input name="nombre" required value="${esc(s.nombre)}" placeholder="Ej: Oficina Central, Planta Norte"></label>
    <label class="f">Dirección<input name="direccion" value="${esc(s.direccion)}"></label>`,
    async onSave(f) {
      const d = fd(f);
      if (s.id) await api('/sucursales/' + s.id, { method: 'PUT', body: d }); else await api('/sucursales', { method: 'POST', body: d });
      toast('Sucursal guardada'); await cargarSucursales(); render();
    } });
}
async function borrarSucursal(id) {
  if (!confirmar('¿Eliminar esta sucursal?')) return;
  await run(() => api('/sucursales/' + id, { method: 'DELETE' }), 'Sucursal eliminada'); await cargarSucursales(); render();
}

let devsCache = [], empCache = [];
VIEWS.empleados = { title: 'Empleados', async render() {
  if (!$('#empToolbar')) {
    $('#view').innerHTML = `<div class="toolbar" id="empToolbar">
      <input id="empBuscar" class="grow" placeholder="Buscar por nombre, PIN o CI…">
      <select id="empDev"><option value="">Todos los equipos</option></select>
      ${puedeEditar() ? `<button class="btn" onclick="asignarHorario()" title="Marca empleados que no siguen el horario de la empresa">Horario propio</button>
        <button class="btn primary" onclick="formEmpleado()">+ Nuevo empleado</button>` : ''}</div><div id="empTable"></div>`;
    let t; $('#empBuscar').oninput = () => { clearTimeout(t); t = setTimeout(() => VIEWS.empleados.render(), 300); };
    $('#empDev').onchange = () => VIEWS.empleados.render();
  }
  const devs = await api('/dispositivos' + qs(scope()));
  devsCache = devs;
  const sel = $('#empDev'), prev = sel.value;
  sel.innerHTML = '<option value="">Todos los equipos</option>' + devs.filter(d => d.empresa_id).map(d => `<option value="${d.id}">${esc(d.nombre)}</option>`).join('');
  sel.value = prev;
  empCache = await api('/empleados' + qs({ ...scope(), dispositivo_id: sel.value, buscar: $('#empBuscar').value.trim() }));
  $('#empTable').innerHTML = `<div class="card"><div class="table-wrap"><table>
    <thead><tr>${puedeEditar() ? '<th><input type="checkbox" onchange="marcarTodos(this)" title="Marcar todos"></th>' : ''}<th class="num">PIN</th><th>Nombre</th>
      ${isAdmin() ? '<th>Empresa</th>' : ''}<th>Departamento / Cargo</th><th>Horario</th><th>Teléfono</th><th>Equipos</th><th></th></tr></thead><tbody>
    ${empCache.map(e => `<tr>${puedeEditar() ? `<td><input type="checkbox" name="empSel" value="${e.id}"></td>` : ''}
      <td class="num"><b>${esc(e.pin)}</b></td>
      <td><b>${esc(e.nombre)}</b>${e.privilegio == 14 ? ' <span class="badge acc">Admin reloj</span>' : ''}<div class="sub">${e.ci ? 'CI ' + esc(e.ci) : ''}${e.tarjeta ? ' · Tarjeta ' + esc(e.tarjeta) : ''}</div></td>
      ${isAdmin() ? `<td>${esc(e.empresa)}</td>` : ''}
      <td>${esc(e.departamento)}<div class="sub">${esc(e.cargo)}</div></td>
      <td>${e.horario ? esc(e.horario) : `<span class="hint">${e.horario_propio ? 'Sin control' : 'Sin horario'}</span>`}${e.horario_propio ? ' <span class="badge">propio</span>' : ''}</td>
      <td>${esc(e.telefono)}</td>
      <td><div class="chips">${e.dispositivos.map(d => { const [c, t] = ESTADO_ED[d.estado] || ['', d.estado];
        return `<span class="badge ${c}" title="${esc(d.sucursal || '')} · ${t}${d.rostro ? ' · rostro registrado' : ''}${d.huella ? ' · huella registrada' : ''}">${esc(d.nombre)}${d.rostro ? ' · rostro' : ''}${d.huella ? ' · huella' : ''}</span>`; }).join('') || '<span class="hint">Sin equipos</span>'}</div></td>
      <td>${puedeEditar() ? `<div class="actions"><button class="btn sm" onclick="formEmpleado(${e.id})">Editar</button><button class="btn sm danger" onclick="borrarEmpleado(${e.id})">Eliminar</button></div>` : ''}</td></tr>`).join('')
      || `<tr><td colspan="10" class="empty">${VIEWS.dispositivos ? 'Sin empleados. Crea uno o agrégalos desde "Usuarios del reloj" en Dispositivos.' : 'Sin empleados.'}</td></tr>`}
    </tbody></table></div></div>`;
}};

async function formEmpleado(id) {
  const e = empCache.find(x => x.id === id) || { privilegio: 0, dispositivos: [], empresa_id: isAdmin() ? scope().empresa_id : me.empresa_id };
  const allDevs = (await api('/dispositivos' + qs({ empresa_id: isAdmin() ? '' : me.empresa_id }))).filter(d => d.empresa_id);
  const marcados = new Set(e.dispositivos.filter(d => d.estado !== 'eliminando').map(d => d.id));
  const pickHtml = empId => {
    const list = allDevs.filter(d => String(d.empresa_id) === String(empId));
    if (!empId) return '<div class="empty" style="padding:16px">Elige primero la empresa</div>';
    if (!list.length) return `<div class="empty" style="padding:16px">${isAdmin() ? 'Esta empresa no tiene dispositivos registrados' : 'Aún no tienes relojes registrados. Pide a soporte que los registre.'}</div>`;
    const g = {}; list.forEach(d => (g[d.sucursal || 'Sin sucursal'] ||= []).push(d));
    return Object.entries(g).map(([s, ds]) => `<div class="grp">${esc(s)}</div>` + ds.map(d => `<label><input type="checkbox" name="dev" value="${d.id}" ${marcados.has(d.id) || (!id && String(scope().sucursal_id) === String(d.sucursal_id)) ? 'checked' : ''}>
      <span style="flex:1"><b>${esc(d.nombre)}</b>${d.sn ? ` <span class="hint">SN ${esc(d.sn)}</span>` : ''}</span>${tipoBadge(d.tipo)}<span class="dot ${d.en_linea ? 'on' : ''}"></span></label>`).join('')).join('');
  };
  const form = modal({ title: id ? 'Editar empleado' : 'Nuevo empleado', wide: true, body: `
    ${isAdmin() ? (id ? `<div class="hint">Empresa: <b>${esc(e.empresa)}</b></div>` : empresaSelect('empresa_id', e.empresa_id)) : ''}
    <div class="grid2">
      <label class="f">PIN / ID en el reloj<input name="pin" required pattern="\\d{1,9}" inputmode="numeric" value="${esc(e.pin)}" placeholder="Ej: 1001"></label>
      <label class="f">Nombre completo<input name="nombre" required maxlength="60" value="${esc(e.nombre)}"></label>
      <label class="f">CI<input name="ci" value="${esc(e.ci)}"></label>
      <label class="f">Teléfono<input name="telefono" value="${esc(e.telefono)}"></label>
      <label class="f">Departamento<input name="departamento" value="${esc(e.departamento)}" list="deptos"></label>
      <label class="f">Cargo<input name="cargo" value="${esc(e.cargo)}"></label>
      <label class="f">Tarjeta RFID (opcional)<input name="tarjeta" value="${esc(e.tarjeta)}" inputmode="numeric"></label>
      <label class="f">Clave numérica en el reloj (opcional)<input name="password" value="${esc(e.password)}" pattern="\\d{0,8}" inputmode="numeric"></label>
      <label class="f">Privilegio en el reloj<select name="privilegio"><option value="0">Usuario normal</option><option value="14" ${e.privilegio == 14 ? 'selected' : ''}>Administrador del equipo</option></select></label>
      <label class="f" title="Antes de esta fecha no se le cuentan faltas. Vacía: la fecha en que se registró en el panel">Fecha de ingreso<input type="date" name="ingreso" value="${esc(e.ingreso)}"></label>
    </div>
    <datalist id="deptos">${[...new Set(empCache.map(x => x.departamento).filter(Boolean))].map(d => `<option value="${esc(d)}">`).join('')}</datalist>
    <div class="f" style="font-size:12.5px;color:var(--muted);display:flex;flex-direction:column;gap:6px">Equipos donde se creará el usuario
      <div class="devpick" id="devpick">${pickHtml(e.empresa_id)}</div></div>
    <p class="hint" style="margin:0">El rostro o la huella se registran en el propio equipo (Gestión de usuarios → editar → Rostro). Al quitar un equipo, el usuario se borra de ese equipo.
      Si cambias el PIN, su huella, rostro, tarjeta y clave se copian al PIN nuevo. Para entrar con clave en el reloj se escribe primero el PIN y luego la clave.
      Antes de la fecha de ingreso no se le cuentan faltas; si la dejas vacía, se toma la fecha en que lo registraste aquí.</p>`,
    async onSave(f) {
      const b = fd(f);
      b.dispositivos = [...f.querySelectorAll('input[name=dev]:checked')].map(x => Number(x.value));
      delete b.dev;
      const cambioPin = id && b.pin !== e.pin && e.dispositivos.some(d => d.estado !== 'eliminando');
      if (cambioPin && !confirmar(`¿Cambiar el PIN de ${e.pin} a ${b.pin}?\n\nEn cada reloj: primero se lee su huella, rostro, tarjeta y clave; luego se copian al PIN ${b.pin} y, solo cuando el reloj confirma todo, se borra el PIN ${e.pin}. Si algo falla no se borra nada y el empleado conserva el PIN ${e.pin}.\n\nSus marcaciones anteriores seguirán a su nombre.`))
        throw new Error('Cambio de PIN cancelado');
      if (id) await api('/empleados/' + id, { method: 'PUT', body: b }); else await api('/empleados', { method: 'POST', body: b });
      toast(cambioPin ? 'Guardado. El PIN se cambiará en los equipos en unos segundos'
        : b.dispositivos.length ? 'Guardado. Se enviará a los equipos en unos segundos' : 'Empleado guardado'); render();
    } });
  const es = form.querySelector('select[name=empresa_id]');
  if (es) es.onchange = () => { form.querySelector('#devpick').innerHTML = pickHtml(es.value); };
}
async function borrarEmpleado(id) {
  const e = empCache.find(x => x.id === id);
  if (!confirmar(`¿Eliminar a ${e.nombre} (PIN ${e.pin})? También se borrará de ${e.dispositivos.length} equipo(s).`)) return;
  await run(() => api('/empleados/' + id, { method: 'DELETE' }), 'Empleado eliminado'); render();
}

VIEWS.marcaciones = { title: 'Marcaciones', async render() {
  if (!$('#mToolbar')) {
    const hoy = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $('#view').innerHTML = `<div class="toolbar" id="mToolbar">
      <label class="f">Desde<input type="date" id="mDesde" value="${hoy}"></label>
      <label class="f">Hasta<input type="date" id="mHasta" value="${hoy}"></label>
      <label class="f">Equipo<select id="mDev"><option value="">Todos</option></select></label>
      <label class="f grow">Empleado<input id="mBuscar" placeholder="Nombre o PIN"></label>
      <button class="btn" style="align-self:flex-end" onclick="VIEWS.marcaciones.render()">Filtrar</button>
      <button class="btn primary" style="align-self:flex-end" onclick="exportarMarcaciones()">Descargar Excel</button></div><div id="mTable"></div>`;
    ['mDesde', 'mHasta', 'mDev'].forEach(i => $('#' + i).onchange = () => VIEWS.marcaciones.render());
    let t; $('#mBuscar').oninput = () => { clearTimeout(t); t = setTimeout(() => VIEWS.marcaciones.render(), 300); };
  }
  const devs = await api('/dispositivos' + qs(scope()));
  const sel = $('#mDev'), prev = sel.value;
  sel.innerHTML = '<option value="">Todos</option>' + devs.filter(d => d.empresa_id).map(d => `<option value="${d.id}">${esc(d.nombre)}</option>`).join('');
  sel.value = prev;
  const list = await api('/marcaciones' + qs(filtrosMarc()));
  $('#mTable').innerHTML = `<div class="card"><div class="card-h"><h2>${list.length}${list.length >= 1000 ? '+' : ''} marcaciones</h2></div><div class="table-wrap"><table>
    <thead><tr><th>Fecha y hora</th><th class="num">PIN</th><th>Empleado</th><th>Departamento</th>${isAdmin() ? '<th>Empresa</th>' : ''}<th>Sucursal / Equipo</th><th>Verificación</th></tr></thead><tbody>
    ${list.map(m => `<tr><td class="num">${esc(m.fecha)}</td><td class="num">${esc(m.pin)}</td><td>${m.empleado ? '<b>' + esc(m.empleado) + '</b>' : '<span class="hint">No registrado</span>'}</td>
      <td>${esc(m.departamento)}</td>${isAdmin() ? `<td>${esc(m.empresa)}</td>` : ''}<td>${esc(m.sucursal)}<div class="sub">${esc(m.dispositivo)} ${m.tipo === 'acceso' ? '· acceso' : ''}</div></td>
      <td>${esc(VERIF[m.verificacion] || m.verificacion || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sin marcaciones en este rango</td></tr>'}
    </tbody></table></div></div>`;
}};
function filtrosMarc() {
  return { ...scope(), desde: $('#mDesde').value, hasta: $('#mHasta').value, dispositivo_id: $('#mDev').value, buscar: $('#mBuscar').value.trim(), limit: 1000 };
}
// El mismo Excel que Reportes → Detalle de marcaciones, con los filtros de esta pantalla
function exportarMarcaciones() {
  const { limit, ...p } = filtrosMarc();
  repDescargar({ path: '/reportes/marcaciones', p, nombre: `marcaciones_${p.desde}_${p.hasta}.xlsx` });
}

/* ---------- Reportes ---------- */
// El servidor arma las jornadas y las compara con el horario de cada persona; aquí solo se muestran
const hoyISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const rep = { desde: hoyISO().slice(0, 8) + '01', hasta: hoyISO(), dia: hoyISO(), sel: null, filas: [], xlsx: null,
  buscar: '', departamento: '', departamentos: [], hojas: null, porPersona: false };
const DIA_SEM = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const diaSem = d => DIA_SEM[new Date(d + 'T00:00:00Z').getUTCDay()];
const fechaBO = d => d.split('-').reverse().join('/');
const hm = min => min == null ? '' : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const repEmpCol = () => isAdmin() && !scope().empresa_id;
const REP_AYUDA = '<p class="hint">El reloj no indica si una marcación es entrada o salida: el panel lo deduce. La primera del día es la entrada y la última la salida; con 4 o más, la 2.ª y la 3.ª son la salida y el regreso del descanso, que se descuenta de las horas; con 3, la del medio no se usa ("Intermedia"). Una marcación a menos de 2 minutos de la anterior es "repetida" y cuenta como una. Retrasos, salidas anticipadas y faltas se calculan con el horario de cada persona (ver "Horarios"): el retraso del día va en la fila de la entrada y, si llegó después del límite, ese día es falta.</p>';
// Tablas de los reportes con el aspecto del Excel (encabezado azul oscuro, celdas con borde) y la persona en columnas
const colsPersona = () => repEmpCol() ? 6 : 5;
const thPersona = () => `<th>ID empleado</th><th>Empleado</th><th>CI</th>${repEmpCol() ? '<th>Empresa</th>' : ''}<th>Departamento</th><th>Cargo</th>`;
const tdPersona = f => `<td class="num">${esc(f.pin)}</td><td>${f.nombre ? `<b>${esc(f.nombre)}</b>` : '<span class="hint">No registrado</span>'}</td>
  <td>${esc(f.ci)}</td>${repEmpCol() ? `<td>${esc(f.empresa)}</td>` : ''}<td>${esc(f.departamento)}</td><td>${esc(f.cargo)}</td>`;
const ESTADO_REP = { presente: ['ok', 'Presente'], retraso: ['warn', 'Retraso'], anticipada: ['warn', 'Salida anticipada'],
  sin_salida: ['warn', 'Sin salida'], falta: ['err', 'Falta'], libre: ['', 'Libre'], feriado: ['acc', 'Feriado'],
  sin_horario: ['', 'Sin horario'], pendiente: ['', 'Pendiente'], antes_alta: ['', 'Antes del ingreso'] };
const estadoBadge = e => { const [c, t] = ESTADO_REP[e] || ['', e]; return `<span class="badge ${c}">${t}</span>`; };

function repBarra(campos, volver = '') {
  return `<div class="toolbar rep-bar no-print">${volver}${campos}<span class="grow"></span>
    <div class="rep-acciones"><button class="btn" onclick="window.print()">Imprimir / PDF</button>
    <button class="btn primary" onclick="repDescargar(rep.xlsx)">Descargar Excel</button></div></div>`;
}
const repRango = () => `<label class="f">Desde<input type="date" value="${rep.desde}" onchange="if (this.value) { rep.desde = this.value; render(); }"></label>
  <label class="f">Hasta<input type="date" value="${rep.hasta}" onchange="if (this.value) { rep.hasta = this.value; render(); }"></label>`;
// Personal filtrado: nombre / PIN / CI y departamento (la sucursal se elige arriba)
const repDepOpciones = () => '<option value="">Todos</option>' +
  rep.departamentos.map(d => `<option value="${esc(d)}" ${d === rep.departamento ? 'selected' : ''}>${esc(d)}</option>`).join('');
const repFiltros = () => `<label class="f">Buscar<input style="width:150px" value="${esc(rep.buscar)}" placeholder="Nombre, PIN o CI" onchange="rep.buscar = this.value.trim(); render()"></label>
  <label class="f">Departamento<select id="repDep" onchange="rep.departamento = this.value; render()">${repDepOpciones()}</select></label>`;
const repRangoTexto = () => rep.desde === rep.hasta ? fechaBO(rep.desde) : `Del ${fechaBO(rep.desde)} al ${fechaBO(rep.hasta)}`;
function repLugar(empresa) {
  empresa ||= isAdmin() ? empresas.find(x => String(x.id) === scope().empresa_id)?.nombre || 'Todas las empresas' : me.empresa;
  const s = sucursales.find(x => String(x.id) === scope().sucursal_id);
  return empresa + (s ? ' · ' + s.nombre : '');
}
// Encabezado que solo aparece al imprimir o guardar como PDF
const repCabecera = (titulo, detalle, lugar = repLugar()) => `<div class="print-head"><h2>${esc(titulo)}</h2>
  <div>${esc(lugar)} · ${esc(detalle)}</div><div class="hint">Generado el ${new Date().toLocaleString('es-BO')}</div></div>`;

// Muestra la barra enseguida y el reporte cuando llega; si falla, la barra queda para corregir las fechas
async function repVista(barra, cargar) {
  rep.xlsx = null;
  $('#view').innerHTML = barra + '<div id="repBody"><div class="card empty">Cargando…</div></div>';
  const body = $('#repBody');
  try {
    const r = await cargar();
    if (!body.isConnected) return; // mientras tanto se cambió de vista o de filtros
    rep.filas = r.filas || []; rep.xlsx = r.xlsx; body.innerHTML = r.html; r.alMostrar?.();
  } catch (e) { body.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
async function repDescargar(x) {
  if (!x) return toast('Espera a que cargue el reporte', true);
  const r = await fetch('/api' + x.path + qs({ ...x.p, formato: 'xlsx' }), { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) return toast((await r.json().catch(() => ({}))).error || 'No se pudo exportar', true);
  const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob());
  a.download = x.nombre; a.click();
}

// titulo ya viene escapado. clic: cada fila abre la hoja de la persona y se ofrecen las hojas de todos los listados
function repTablaEmpleados(titulo, filas, clic) {
  const t = { dias: 0, minutos: 0, retrasos: 0, retraso: 0, anticipada: 0, faltas: 0, sin_salida: 0 };
  filas.forEach(f => { for (const k in t) t[k] += f[k]; });
  return `<div class="card"><div class="card-h"><h2>${titulo}</h2>${clic && filas.length ? `<span class="hint no-print">Clic en una persona: su hoja de asistencia</span>
      <button class="btn sm no-print" onclick="imprimirHojas()" title="Una hoja horizontal por cada persona de la lista">Imprimir hojas (${filas.length})</button>
      <button class="btn sm no-print" onclick="repDescargar(rep.hojas)" title="Un Excel con una pestaña por persona de la lista">Hojas en Excel</button>` : ''}</div>
    <div class="table-wrap"><table class="grilla rep">
    <thead><tr>${thPersona()}<th>Horario</th><th title="Días trabajados / días laborables según su horario">Días</th><th>Horas</th><th>Retrasos</th>
      <th>Salida anticip.</th><th>Faltas</th><th>Sin salida</th></tr></thead><tbody>
    ${filas.map((f, i) => `<tr${clic ? ` class="clic" onclick="rep.sel = rep.filas[${i}]; render()"` : ''}>${tdPersona(f)}
      <td>${f.horario ? esc(f.horario) : '<span class="hint">Sin horario</span>'}${f.horario_propio ? ' <span class="badge">propio</span>' : ''}</td>
      <td class="num">${f.dias}${f.laborables ? `<span class="hint"> / ${f.laborables}</span>` : ''}</td><td class="num">${f.dias ? hm(f.minutos) : ''}</td>
      <td class="num">${f.retrasos ? `<b class="t-warn">${hm(f.retraso)}</b> <span class="hint">(${f.retrasos} ${f.retrasos === 1 ? 'vez' : 'veces'})</span>` : ''}</td>
      <td class="num">${f.anticipada ? hm(f.anticipada) : ''}</td>
      <td class="num">${f.faltas ? `<span class="badge err">${f.faltas}</span>` : ''}</td>
      <td class="num">${f.sin_salida ? `<span class="badge warn">${f.sin_salida}</span>` : ''}</td></tr>`).join('')
      || `<tr><td colspan="${colsPersona() + 7}" class="empty">Sin empleados con esos filtros</td></tr>`}
    </tbody>${filas.length ? `<tfoot><tr><td colspan="${colsPersona() + 1}">Total · ${filas.length} empleados</td><td class="num">${t.dias}</td>
      <td class="num">${hm(t.minutos)}</td><td class="num">${t.retrasos ? hm(t.retraso) : ''}</td><td class="num">${t.anticipada ? hm(t.anticipada) : ''}</td>
      <td class="num">${t.faltas || ''}</td><td class="num">${t.sin_salida || ''}</td></tr></tfoot>` : ''}
    </table></div></div>`;
}

// Datos de la persona en el encabezado de las hojas
const personaHtml = h => `<div>ID del empleado: <b>${esc(h.pin)}</b> · Nombres: <b>${esc(h.nombre || 'No registrado en el panel')}</b> · CI: <b>${esc(h.ci || '—')}</b>
  · Departamento: <b>${esc(h.departamento || '—')}</b>${h.cargo ? ` · Cargo: <b>${esc(h.cargo)}</b>` : ''} · Horario: <b>${esc(h.horario || 'Sin horario')}</b>${h.horario
    ? (h.horario_propio ? ' (propio)' : ' (de la empresa)') : ''}</div>`;
// Hoja de asistencia de una persona: en pantalla, impresa (una página horizontal por persona) y en el Excel
function hojaHtml(h, desde, hasta) {
  const t = h.totales, v = x => x || '';
  return `<div class="hoja card">
    <div class="hoja-cab"><h2>Hoja de asistencia</h2>
      <div>${esc(h.empresa)} · Fecha inicial <b>${fechaBO(desde)}</b> · Fecha final <b>${fechaBO(hasta)}</b></div>${personaHtml(h)}</div>
    <div class="table-wrap"><table class="grilla">
      <thead><tr><th rowspan="2">Fecha</th><th rowspan="2">Día</th><th colspan="5">Horario</th><th colspan="7">Marcado</th><th colspan="4">Resultado</th></tr>
        <tr><th>Nombre</th><th>Entrada</th><th>Salida</th><th>Horas laborales</th><th>Día laboral</th>
          <th>Entrada</th><th>Salida</th><th>Salida descanso</th><th>Entrada descanso</th><th>Horas descanso</th><th>Total horas</th><th>Horas trabajadas</th>
          <th>Retraso</th><th>Salida anticipada</th><th>Falta</th><th>Observación</th></tr></thead>
      <tbody>${h.dias.map(d => `<tr class="${d.marcaciones || d.laboral ? '' : 'vacio'}">
        <td>${fechaBO(d.dia)}</td><td>${diaSem(d.dia)}</td>
        <td>${esc(d.horario)}</td><td>${v(d.h_entrada)}</td><td>${v(d.h_salida)}</td><td>${hm(d.h_minutos)}</td><td>${d.horario ? d.laboral : ''}</td>
        <td>${v(d.entrada)}</td><td>${v(d.salida)}</td><td>${v(d.descanso_ini)}</td><td>${v(d.descanso_fin)}</td>
        <td>${hm(d.descanso)}</td><td>${hm(d.total)}</td><td>${hm(d.minutos)}</td>
        <td class="${d.retraso ? 't-warn' : ''}">${d.retraso ? hm(d.retraso) : ''}</td>
        <td class="${d.anticipada ? 't-warn' : ''}">${d.anticipada ? hm(d.anticipada) : ''}</td>
        <td class="${d.falta ? 't-err' : ''}">${d.falta || ''}</td>
        <td class="obs">${d.estado === 'falta' ? estadoBadge('falta') + ' ' : ''}${esc(d.obs)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="6">Totales</td><td>${t.laborables}</td><td colspan="4"></td><td>${hm(t.descanso)}</td><td>${hm(t.total)}</td>
        <td>${hm(t.minutos)}</td><td>${hm(t.retraso)}</td><td>${hm(t.anticipada)}</td><td>${t.faltas}</td>
        <td class="obs">${t.dias} ${t.dias === 1 ? 'día trabajado' : 'días trabajados'} · ${t.retrasos} ${t.retrasos === 1 ? 'retraso' : 'retrasos'}${t.sin_salida ? ` · ${t.sin_salida} sin salida` : ''}</td></tr></tfoot>
    </table></div>
    <p class="hint hoja-pie">Retraso: minutos desde la hora de entrada, cuando se pasa la tolerancia. Falta: no marcó en un día laboral o llegó después del límite. · Generado el ${new Date().toLocaleString('es-BO')}</p>
  </div>`;
}
// Imprime (o guarda en PDF) las hojas de todo el personal filtrado: una página horizontal por persona
async function imprimirHojas() {
  if (!rep.hojas) return toast('Espera a que cargue el reporte', true);
  const r = await run(() => api('/reportes/hojas' + qs(rep.hojas.p)));
  if (!r.hojas.length) return toast('No hay personal con esos filtros', true);
  const div = document.createElement('div');
  div.id = 'impresion'; div.innerHTML = r.hojas.map(h => hojaHtml(h, r.desde, r.hasta)).join('');
  document.body.append(div); document.body.classList.add('imprimiendo');
  window.addEventListener('afterprint', () => { div.remove(); document.body.classList.remove('imprimiendo'); }, { once: true });
  window.print();
}

VIEWS['rep-empleados'] = { title: 'Reporte por empleados', render() {
  if (rep.sel) return repEmpleado();
  const p = { ...scope(), desde: rep.desde, hasta: rep.hasta, buscar: rep.buscar, departamento: rep.departamento };
  return repVista(repBarra(repRango() + repFiltros()), async () => {
    const [r, m] = await Promise.all([api('/reportes/empleados' + qs(p)), api('/reportes/marcaciones' + qs(p))]);
    return { filas: r.filas, xlsx: { path: '/reportes/empleados', p, nombre: `reporte_empleados_${p.desde}_${p.hasta}.xlsx` },
      alMostrar() {
        rep.hojas = { path: '/reportes/hojas', p, nombre: `hojas_asistencia_${p.desde}_${p.hasta}.xlsx` };
        rep.departamentos = r.departamentos; if ($('#repDep')) $('#repDep').innerHTML = repDepOpciones();
      },
      html: `<div class="apaisado">${repCabecera('Reporte por empleados', repRangoTexto())}${repTablaEmpleados(`${r.filas.length} empleados`, r.filas, true)}
        ${tablaMarcaciones(m, 'Marcaciones')}${REP_AYUDA}</div>` };
  });
}};

function repEmpleado() {
  const f = rep.sel;
  const p = { ...scope(), empresa_id: f.empresa_id, desde: rep.desde, hasta: rep.hasta, ...(f.empleado_id ? { empleado_id: f.empleado_id } : { pin: f.pin }) };
  return repVista(repBarra(repRango(), '<button class="btn" onclick="rep.sel = null; render()">← Todos los empleados</button>'), async () => {
    const [r, m] = await Promise.all([api('/reportes/empleado' + qs(p)), api('/reportes/marcaciones' + qs(p))]);
    // Al imprimir, la hoja va en una página y sus marcaciones en la siguiente
    return { xlsx: { path: '/reportes/empleado', p, nombre: `asistencia_${r.hoja.pin}_${p.desde}_${p.hasta}.xlsx` },
      html: `<div class="apaisado">${hojaHtml(r.hoja, r.desde, r.hasta)}${tablaMarcaciones(m, 'Marcaciones')}</div>` };
  });
}

VIEWS['rep-sucursales'] = { title: 'Reporte por sucursal', render() {
  const p = { ...scope(), desde: rep.desde, hasta: rep.hasta };
  if (rep.sel) {
    const s = rep.sel, pd = { ...p, empresa_id: s.empresa_id, sucursal_id: s.sucursal_id };
    return repVista(repBarra(repRango(), '<button class="btn" onclick="rep.sel = null; render()">← Todas las sucursales</button>'), async () => {
      const [r, m] = await Promise.all([api('/reportes/empleados' + qs(pd)), api('/reportes/marcaciones' + qs(pd))]);
      return { xlsx: { path: '/reportes/empleados', p: pd, nombre: `reporte_${s.sucursal.replace(/[^\w-]+/g, '_')}_${p.desde}_${p.hasta}.xlsx` },
        html: `<div class="apaisado">${repCabecera(`Reporte de la sucursal ${s.sucursal}`, repRangoTexto(), `${s.empresa} · ${s.sucursal}`)}
          ${repTablaEmpleados(`${esc(s.sucursal)} · ${r.filas.length} empleados`, r.filas, false)}
          ${tablaMarcaciones(m, `Marcaciones en ${esc(s.sucursal)}`)}${REP_AYUDA}</div>` };
    });
  }
  return repVista(repBarra(repRango()), async () => {
    const [r, m] = await Promise.all([api('/reportes/sucursales' + qs(p)), api('/reportes/marcaciones' + qs(p))]), ec = repEmpCol();
    const t = { jornadas: 0, marcaciones: 0, minutos: 0, sin_salida: 0 };
    r.filas.forEach(f => { for (const k in t) t[k] += f[k]; });
    return { filas: r.filas, xlsx: { path: '/reportes/sucursales', p, nombre: `reporte_sucursales_${p.desde}_${p.hasta}.xlsx` },
      html: `<div class="apaisado">${repCabecera('Reporte por sucursal', repRangoTexto())}<div class="card">
        <div class="card-h"><h2>${r.filas.length} sucursales</h2>${r.filas.length ? '<span class="hint no-print">Haz clic en una sucursal para ver a sus empleados</span>' : ''}</div>
        <div class="table-wrap"><table class="grilla rep"><thead><tr><th>Sucursal</th>${ec ? '<th>Empresa</th>' : ''}<th>Empleados</th><th>Asistieron</th>
          <th title="Suma de los días trabajados por todos los empleados">Jornadas</th>
          <th title="Las de las jornadas que empezaron en esta sucursal (la tabla de abajo muestra lo marcado en sus relojes)">Marcaciones</th><th>Horas</th><th>Sin salida</th></tr></thead><tbody>
        ${r.filas.map((f, i) => `<tr class="clic" onclick="rep.sel = rep.filas[${i}]; render()"><td><b>${esc(f.sucursal)}</b></td>${ec ? `<td>${esc(f.empresa)}</td>` : ''}
          <td class="num">${f.empleados}</td><td class="num">${f.asistieron}</td><td class="num">${f.jornadas}</td><td class="num">${f.marcaciones}</td>
          <td class="num">${hm(f.minutos)}</td><td class="num">${f.sin_salida ? `<span class="badge warn">${f.sin_salida}</span>` : ''}</td></tr>`).join('')
          || `<tr><td colspan="${ec ? 8 : 7}" class="empty">Sin sucursales</td></tr>`}
        </tbody>${r.filas.length > 1 ? `<tfoot><tr><td colspan="${ec ? 4 : 3}">Total</td><td class="num">${t.jornadas}</td><td class="num">${t.marcaciones}</td>
          <td class="num">${hm(t.minutos)}</td><td class="num">${t.sin_salida || ''}</td></tr></tfoot>` : ''}</table></div></div>
        ${tablaMarcaciones(m, 'Marcaciones')}${REP_AYUDA}</div>` };
  });
}};

VIEWS['rep-fecha'] = { title: 'Reporte por fecha', render() {
  const p = { ...scope(), dia: rep.dia };
  const campos = `<button class="btn" onclick="repMoverDia(-1)" title="Día anterior">‹</button>
    <label class="f">Día<input type="date" value="${rep.dia}" onchange="if (this.value) { rep.dia = this.value; render(); }"></label>
    <button class="btn" onclick="repMoverDia(1)" title="Día siguiente">›</button>`;
  return repVista(repBarra(campos), async () => {
    const [r, m] = await Promise.all([api('/reportes/fecha' + qs(p)), api('/reportes/marcaciones' + qs({ ...scope(), desde: rep.dia, hasta: rep.dia }))]);
    const t = r.totales, fecha = `${diaSem(r.dia)} ${fechaBO(r.dia)}`, conDetalle = ['falta', 'retraso', 'anticipada', 'feriado'];
    return { xlsx: { path: '/reportes/fecha', p, nombre: `asistencia_${r.dia}.xlsx` },
      html: `<div class="apaisado">${repCabecera('Asistencia del día', fecha)}<div class="tiles">
        <div class="card tile"><div class="k">Presentes</div><div class="v">${t.presentes}<small> / ${r.filas.length}</small></div></div>
        <div class="card tile"><div class="k">Faltas</div><div class="v">${t.faltas}</div></div>
        <div class="card tile"><div class="k">Retrasos</div><div class="v">${t.retrasos}</div></div>
        <div class="card tile"><div class="k">Sin salida</div><div class="v">${t.sin_salida}</div></div>
        <div class="card tile"><div class="k">Horas trabajadas</div><div class="v">${hm(t.minutos)}</div></div></div>
        <div class="card"><div class="card-h"><h2>${esc(fecha)}</h2></div><div class="table-wrap"><table class="grilla rep">
        <thead><tr>${thPersona()}<th>Sucursal</th><th>Horario</th><th>Entrada</th><th>Descanso</th>
          <th>Salida</th><th>Horas</th><th>Retraso</th><th>Estado</th></tr></thead><tbody>
        ${r.filas.map(f => `<tr>${tdPersona(f)}<td>${esc(f.sucursal)}</td>
          <td class="num">${f.h_entrada ? `${f.h_entrada}–${f.h_salida}` : f.horario ? '<span class="hint">Libre</span>' : '<span class="hint">Sin horario</span>'}</td>
          <td class="num">${f.entrada || ''}</td><td class="num">${f.almuerzo || ''}</td><td class="num">${f.salida || ''}</td><td class="num">${hm(f.minutos)}</td>
          <td class="num">${f.retraso ? `<b class="t-warn">${hm(f.retraso)}</b>` : ''}</td>
          <td class="obs">${estadoBadge(f.estado)}${conDetalle.includes(f.estado) && f.obs ? ` <span class="hint">${esc(f.obs)}</span>` : ''}</td></tr>`).join('')
          || `<tr><td colspan="${colsPersona() + 8}" class="empty">Sin empleados ni marcaciones este día</td></tr>`}
        </tbody></table></div></div>
        ${tablaMarcaciones(m, `Marcaciones del ${esc(fecha)}`)}${REP_AYUDA}</div>` };
  });
}};
function repMoverDia(n) {
  const d = new Date(rep.dia + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  rep.dia = d.toISOString().slice(0, 10); render();
}

// Una fila por marcación, como el Excel. Se imprime en horizontal. Con la casilla "Una hoja por persona",
// cada persona va en su hoja (una página impresa, una pestaña en Excel) con su total de retraso y sus faltas.
const MARC_COLOR = { entrada: 'ok', salida: 'acc', descanso_ini: '', descanso_fin: '' };
const marcEstado = f => f.repetida || f.estado === 'intermedia' ? `<span class="hint">${esc(f.estado_texto)}</span>`
  : `<span class="badge ${MARC_COLOR[f.estado]}">${esc(f.estado_texto)}</span>`;
const marcRetraso = f => f.falta ? `<span class="badge err" title="${esc(f.obs)}">Falta</span>` : f.retraso ? `<b class="t-warn">${hm(f.retraso)}</b>` : '';
const cuentaMarc = r => `${r.total} ${r.total === 1 ? 'marcación' : 'marcaciones'} · ${r.personas} ${r.personas === 1 ? 'persona' : 'personas'}`;

// Tabla de marcaciones del filtro (r: respuesta de /reportes/marcaciones): el detalle de marcaciones y, con
// título, la que va debajo de los demás reportes
function tablaMarcaciones(r, titulo = '') {
  // Una línea más marcada donde empieza otra persona
  const filas = r.filas.map((f, i) => `<tr class="${i && f.clave !== r.filas[i - 1].clave ? 'corte' : ''}">${tdPersona(f)}
    <td class="num">${fechaBO(f.dia)}</td><td>${diaSem(f.dia).slice(0, 3)}</td><td>${esc(f.sucursal)}</td><td>${esc(f.dispositivo)}</td>
    <td class="num"><b>${f.hora}</b></td><td>${marcEstado(f)}</td><td class="num">${marcRetraso(f)}</td><td>${esc(f.metodo)}</td></tr>`).join('');
  const corte = r.total > r.filas.length ? `<span class="hint">Se muestran las primeras ${r.filas.length}; el Excel trae las ${r.total}</span>` : '';
  return `<div class="card rep-marc"><div class="card-h">${titulo ? `<h2>${titulo}</h2><span class="hint">${cuentaMarc(r)}</span>` : `<h2>${cuentaMarc(r)}</h2>`}${corte}</div>
    <div class="table-wrap"><table class="grilla rep"><thead><tr>${thPersona()}<th>Fecha</th><th>Día</th><th>Sucursal</th><th>Dispositivo</th>
      <th>Hora marcación</th><th>Estado de marcación</th><th>Retraso</th><th>Método de verificación</th></tr></thead>
    <tbody>${filas || `<tr><td colspan="${colsPersona() + 8}" class="empty">Sin marcaciones con esos filtros</td></tr>`}</tbody></table></div></div>`;
}
const marcCasilla = () => `<label class="casilla" title="Cada persona en su hoja: una página al imprimir y una pestaña en el Excel">
  <input type="checkbox" ${rep.porPersona ? 'checked' : ''} onchange="rep.porPersona = this.checked; render()"> Una hoja por persona</label>`;

function marcHojaHtml(g, desde, hasta) {
  return `<div class="hoja card">
    <div class="hoja-cab"><h2>Detalle de marcaciones</h2>
      <div>${esc(g.empresa)} · Fecha inicial <b>${fechaBO(desde)}</b> · Fecha final <b>${fechaBO(hasta)}</b></div>${personaHtml(g)}</div>
    <div class="table-wrap"><table class="grilla rep"><thead><tr><th>Fecha</th><th>Día</th><th>Sucursal</th><th>Dispositivo</th>
      <th>Hora marcación</th><th>Estado de marcación</th><th>Retraso</th><th>Método de verificación</th></tr></thead>
    <tbody>${g.filas.map(f => `<tr><td class="num">${fechaBO(f.dia)}</td><td>${diaSem(f.dia).slice(0, 3)}</td><td>${esc(f.sucursal)}</td>
      <td>${esc(f.dispositivo)}</td><td class="num"><b>${f.hora}</b></td><td>${marcEstado(f)}</td><td class="num">${marcRetraso(f)}</td>
      <td>${esc(f.metodo)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Sin marcaciones en el período</td></tr>'}</tbody>
    <tfoot><tr><td colspan="4">Totales</td><td class="num">${g.marcaciones} ${g.marcaciones === 1 ? 'marcación' : 'marcaciones'}</td>
      <td>${g.retrasos} ${g.retrasos === 1 ? 'retraso' : 'retrasos'}</td><td class="num">${hm(g.retraso)}</td>
      <td class="${g.faltas ? 't-err' : ''}">Faltas en el período: ${g.faltas}</td></tr></tfoot></table></div></div>`;
}

VIEWS['rep-marcaciones'] = { title: 'Detalle de marcaciones', render() {
  const p = { ...scope(), desde: rep.desde, hasta: rep.hasta, buscar: rep.buscar, departamento: rep.departamento, por_persona: rep.porPersona ? 1 : '' };
  const xlsx = { path: '/reportes/marcaciones', p, nombre: `marcaciones${rep.porPersona ? '_por_persona' : ''}_${p.desde}_${p.hasta}.xlsx` };
  const alMostrar = r => () => { rep.departamentos = r.departamentos; if ($('#repDep')) $('#repDep').innerHTML = repDepOpciones(); };
  return repVista(repBarra(repRango() + repFiltros() + marcCasilla()), async () => {
    const r = await api('/reportes/marcaciones' + qs(p));
    if (rep.porPersona) {
      const corte = r.hojas.length < r.personas ? ` · <span class="t-warn">se muestran ${r.hojas.length}; el Excel trae a todas</span>` : '';
      return { xlsx, alMostrar: alMostrar(r),
        html: `<p class="hint no-print">${r.personas} ${r.personas === 1 ? 'persona' : 'personas'} · ${r.total} ${r.total === 1 ? 'marcación' : 'marcaciones'}${corte}.
          Al imprimir, cada persona sale en una hoja horizontal.</p>
          <div>${r.hojas.map(g => marcHojaHtml(g, r.desde, r.hasta)).join('') || '<div class="card empty">No hay personal con esos filtros</div>'}</div>
          <div class="no-print">${REP_AYUDA}</div>` };
    }
    return { xlsx, alMostrar: alMostrar(r),
      html: `<div class="apaisado">${repCabecera('Detalle de marcaciones', repRangoTexto())}${tablaMarcaciones(r)}${REP_AYUDA}</div>` };
  });
}};

/* ---------- Horarios y feriados ---------- */
// Un horario dice, por día de la semana, la entrada, la salida y después de qué hora llegar es falta.
// Cada empresa tiene un horario principal (desde una fecha) que rige para todo su personal; quien trabaja
// distinto tiene una excepción (Empleados → Horario propio).
const DIA_CORTO = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá'], ORDEN_SEM = [1, 2, 3, 4, 5, 6, 0];
let horCache = [], principalCache = { hoy: '', empresas: [] }, feriadosAnio = new Date().getFullYear();
// "Lu–Vi 08:00–18:00 · Sá 08:00–12:00": agrupa los días seguidos con las mismas horas
function resumenDias(dias) {
  const por = Object.fromEntries(dias.map(d => [d.dia, d])), grupos = [];
  ORDEN_SEM.forEach((n, i) => {
    const d = por[n], clave = d && `${d.entrada}|${d.salida}|${d.limite_falta}`, g = grupos[grupos.length - 1];
    if (!d) return;
    if (g && g.clave === clave && g.fin === ORDEN_SEM[i - 1]) g.fin = n; else grupos.push({ clave, ini: n, fin: n, d });
  });
  return grupos.map(g => `<div>${DIA_CORTO[g.ini]}${g.fin !== g.ini ? '–' + DIA_CORTO[g.fin] : ''} ${g.d.entrada}–${g.d.salida}
    <span class="hint">· falta después de ${g.d.limite_falta}</span></div>`).join('') || '<span class="hint">Sin días de trabajo</span>';
}
// Cambios del horario principal de una empresa (vienen del más nuevo al más viejo): el que rige hoy,
// los programados para más adelante y los anteriores
function principalDe(e) {
  const cambios = e?.cambios || [], hoy = principalCache.hoy;
  const pasados = cambios.filter(c => c.desde <= hoy);
  return { vigente: pasados[0], anteriores: pasados.slice(1), proximos: cambios.filter(c => c.desde > hoy).reverse() };
}

VIEWS.horarios = { title: 'Horarios', async render() {
  const emp = scope().empresa_id, ed = puedeEditar(), ec = isAdmin() && !emp;
  const [hs, pr, fs] = await Promise.all([api('/horarios' + qs({ empresa_id: emp })), api('/horarios/principal' + qs({ empresa_id: emp })),
    api('/feriados' + qs({ empresa_id: emp, anio: feriadosAnio }))]);
  horCache = hs; principalCache = pr;
  const anios = [-1, 0, 1].map(k => new Date().getFullYear() + k);
  const cambio = (e, c, clase = '') => `<div class="${clase}">${clase === 'prox' ? '<span class="badge acc">Programado</span> ' : ''}${esc(c.horario || 'Sin horario')} desde ${fechaBO(c.desde)}${ed
    ? ` <button class="btn sm" onclick="borrarCambioPrincipal(${e.empresa_id}, '${c.desde}')" title="Quitar este cambio">Quitar</button>` : ''}</div>`;
  $('#view').innerHTML = `
    <div class="card"><div class="card-h"><h2>Horario principal</h2><span class="hint">Rige para todo el personal de la empresa, salvo quien tenga horario propio</span></div>
      <div class="table-wrap"><table><thead><tr>${ec ? '<th>Empresa</th>' : ''}<th>Horario de la empresa</th><th>Desde</th><th>Otros cambios</th>
        <th class="num" title="Empleados con horario propio o sin control de horario">Con horario propio</th><th></th></tr></thead><tbody>
      ${pr.empresas.map(e => { const { vigente, anteriores, proximos } = principalDe(e), h = vigente && hs.find(x => x.id === vigente.horario_id);
        return `<tr>${ec ? `<td><b>${esc(e.empresa)}</b></td>` : ''}
          <td>${h ? `<b>${esc(h.nombre)}</b>${resumenDias(h.dias)}` : '<span class="hint">Sin horario principal: nadie tiene retrasos ni faltas</span>'}</td>
          <td class="num">${vigente ? fechaBO(vigente.desde) : ''}</td>
          <td>${proximos.map(c => cambio(e, c, 'prox')).join('')}${anteriores.map(c => cambio(e, c, 'hint')).join('') || (proximos.length ? '' : '<span class="hint">—</span>')}</td>
          <td class="num">${e.excepciones || ''}</td>
          <td>${ed ? `<div class="actions"><button class="btn sm primary" onclick="formPrincipal(${e.empresa_id})">${vigente ? 'Cambiar' : 'Elegir horario'}</button></div>` : ''}</td></tr>`; }).join('')
        || '<tr><td colspan="6" class="empty">Sin empresas</td></tr>'}
      </tbody></table></div></div>
    <div class="card" style="margin-top:18px"><div class="card-h"><h2>${hs.length} horarios</h2>${ed ? '<button class="btn primary" onclick="formHorario()">+ Nuevo horario</button>' : ''}</div>
      <div class="table-wrap"><table><thead><tr><th>Horario</th>${ec ? '<th>Empresa</th>' : ''}<th>Días y horas</th><th class="num">Tolerancia</th>
        <th class="num" title="Empleados que lo tienen hoy (por la empresa o como horario propio)">Empleados</th><th></th></tr></thead><tbody>
      ${hs.map(h => `<tr><td><b>${esc(h.nombre)}</b>${h.principal ? ' <span class="badge acc">Principal</span>' : ''}</td>${ec ? `<td>${esc(h.empresa)}</td>` : ''}
        <td>${resumenDias(h.dias)}</td><td class="num">${h.tolerancia} min</td><td class="num">${h.empleados}</td>
        <td>${ed ? `<div class="actions"><button class="btn sm" onclick="formHorario(${h.id})">Editar</button><button class="btn sm danger" onclick="borrarHorario(${h.id})">Eliminar</button></div>` : ''}</td></tr>`).join('')
        || `<tr><td colspan="6" class="empty">${ed ? 'Crea el primer horario: se puede usar como horario principal de la empresa.' : 'Aún no hay horarios.'}</td></tr>`}
      </tbody></table></div></div>
    <p class="hint">Retraso: si llega después de la entrada más la tolerancia, se cuentan los minutos desde la hora de entrada. Llegar después de la hora de falta, o no marcar en un día de trabajo, cuenta 1 día de falta. Los días sin horario son libres.</p>
    <div class="card" style="margin-top:18px"><div class="card-h"><h2>Feriados</h2>
      <select onchange="feriadosAnio = Number(this.value); render()">${anios.map(a => `<option ${a === feriadosAnio ? 'selected' : ''}>${a}</option>`).join('')}</select>
      ${ed ? '<button class="btn primary" onclick="formFeriado()">+ Feriado</button>' : ''}</div>
      <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Día</th><th>Feriado</th><th>Vale para</th><th></th></tr></thead><tbody>
      ${fs.map(f => `<tr><td class="num">${fechaBO(f.fecha)}</td><td>${diaSem(f.fecha)}</td><td><b>${esc(f.nombre)}</b></td>
        <td>${f.empresa_id ? esc(isAdmin() ? f.empresa : 'Tu empresa') : '<span class="badge acc">Nacional</span>'}</td>
        <td>${ed && (isAdmin() || f.empresa_id) ? `<div class="actions"><button class="btn sm danger" onclick="borrarFeriado(${f.id})">Quitar</button></div>` : ''}</td></tr>`).join('')
        || `<tr><td colspan="5" class="empty">Sin feriados cargados en ${feriadosAnio}</td></tr>`}
      </tbody></table></div></div>
    <p class="hint">En un feriado nadie tiene falta ni retraso; si alguien marca, sus horas se cuentan igual.${isAdmin() ? '' : ' Los feriados nacionales los carga soporte.'}</p>`;
}};

function formPrincipal(empresa_id) {
  const e = principalCache.empresas.find(x => x.empresa_id === empresa_id), { vigente } = principalDe(e);
  const propios = horCache.filter(h => h.empresa_id === empresa_id);
  modal({ title: `Horario principal${isAdmin() ? ' · ' + e.empresa : ''}`, body: `
    <label class="f">Horario<select name="horario_id">${propios.map(h => `<option value="${h.id}" ${vigente?.horario_id === h.id ? 'selected' : ''}>${esc(h.nombre)}</option>`).join('')}
      <option value="">Sin horario principal</option></select></label>
    <label class="f">Rige desde<input type="date" name="desde" required value="${hoyISO()}"></label>
    <p class="hint" style="margin:0">${propios.length ? 'Se aplica a todo el personal de la empresa, también a los empleados nuevos, salvo quien tenga horario propio. Los días anteriores a esa fecha conservan el horario que tenían.'
      : 'Esta empresa aún no tiene horarios: créalo primero con "+ Nuevo horario".'}</p>`,
    async onSave(f) { await api('/horarios/principal', { method: 'POST', body: { ...fd(f), empresa_id } }); toast('Horario principal guardado'); render(); } });
}
async function borrarCambioPrincipal(empresa_id, desde) {
  if (!confirmar(`¿Quitar el cambio del ${fechaBO(desde)}? Esos días pasan a usar el horario principal anterior.`)) return;
  await run(() => api('/horarios/principal' + qs({ empresa_id, desde }), { method: 'DELETE' }), 'Cambio quitado'); render();
}

function formHorario(id) {
  const h = horCache.find(x => x.id === id) || { tolerancia: 10, dias: [1, 2, 3, 4, 5].map(dia => ({ dia, entrada: '08:00', salida: '18:00', limite_falta: '10:00' })) };
  const por = Object.fromEntries(h.dias.map(d => [d.dia, d]));
  // Al crear: se propone como principal si la empresa todavía no tiene uno
  const empresaActual = isAdmin() ? Number(scope().empresa_id) : me.empresa_id;
  const proponer = !id && empresaActual && !principalDe(principalCache.empresas.find(e => e.empresa_id === empresaActual)).vigente;
  const form = modal({ title: id ? 'Editar horario' : 'Nuevo horario', wide: true, body: `
    ${isAdmin() && !id ? empresaSelect('empresa_id', scope().empresa_id) : ''}
    <div class="grid2"><label class="f">Nombre<input name="nombre" required value="${esc(h.nombre)}" placeholder="Ej: Oficina, Obra"></label>
      <label class="f">Tolerancia (minutos)<input name="tolerancia" type="number" min="0" max="240" required value="${h.tolerancia}"></label></div>
    <div class="table-wrap"><table class="dias"><thead><tr><th>Día</th><th>Trabaja</th><th>Entrada</th><th>Falta después de</th><th>Salida</th></tr></thead><tbody>
    ${ORDEN_SEM.map(n => { const d = por[n] || { entrada: '08:00', salida: n === 6 ? '12:00' : '18:00', limite_falta: '10:00' };
      return `<tr data-dia="${n}"><td><b>${DIA_SEM[n]}</b></td><td><input type="checkbox" name="t${n}" ${por[n] ? 'checked' : ''}></td>
        <td><input type="time" name="e${n}" value="${d.entrada}" required></td><td><input type="time" name="l${n}" value="${d.limite_falta}" required></td>
        <td><input type="time" name="s${n}" value="${d.salida}" required></td></tr>`; }).join('')}
    </tbody></table></div>
    ${id ? '' : `<div class="toolbar" style="margin:0"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="principal" ${proponer ? 'checked' : ''}>
      Usarlo como horario principal de la empresa, desde</label><input type="date" name="principal_desde" value="${hoyISO()}"></div>`}
    <p class="hint" style="margin:0">Con entrada 08:00 y tolerancia 10: llega 08:08 → sin retraso; 08:15 → 0:15 de retraso; después de la hora de falta → 1 día de falta. Los días sin "Trabaja" son libres.
      ${id ? '<br><b>Si cambias este horario también cambian los reportes de fechas pasadas</b> de quienes lo tienen. Para un cambio desde una fecha, crea un horario nuevo y ponlo como principal (o como horario propio) desde esa fecha.' : ''}</p>`,
    async onSave(f) {
      const b = fd(f);
      const dias = ORDEN_SEM.filter(n => f.querySelector(`[name=t${n}]`).checked).map(n => ({ dia: n, entrada: b['e' + n], salida: b['s' + n], limite_falta: b['l' + n] }));
      const body = { empresa_id: b.empresa_id, nombre: b.nombre, tolerancia: b.tolerancia, dias };
      if (id) await api('/horarios/' + id, { method: 'PUT', body });
      else {
        const nuevo = await api('/horarios', { method: 'POST', body });
        if (b.principal) await api('/horarios/principal', { method: 'POST', body: { empresa_id: nuevo.empresa_id, horario_id: nuevo.id, desde: b.principal_desde } });
      }
      toast('Horario guardado'); render();
    } });
  // Un día que no se trabaja no lleva horas
  const sync = () => ORDEN_SEM.forEach(n => form.querySelectorAll(`tr[data-dia="${n}"] input[type=time]`)
    .forEach(i => { i.disabled = !form.querySelector(`[name=t${n}]`).checked; }));
  form.addEventListener('change', sync); sync();
}
async function borrarHorario(id) {
  const h = horCache.find(x => x.id === id);
  if (!confirmar(`¿Eliminar el horario "${h.nombre}"?`)) return;
  await run(() => api('/horarios/' + id, { method: 'DELETE' }), 'Horario eliminado'); render();
}
function formFeriado() {
  modal({ title: 'Nuevo feriado', body: `
    ${isAdmin() ? `<label class="f">Vale para<select name="empresa_id"><option value="">Nacional (todas las empresas)</option>${empresas.map(e =>
      `<option value="${e.id}" ${String(scope().empresa_id) === String(e.id) ? 'selected' : ''}>Solo ${esc(e.nombre)}</option>`).join('')}</select></label>` : ''}
    <div class="grid2"><label class="f">Fecha<input type="date" name="fecha" required></label><label class="f">Nombre<input name="nombre" required placeholder="Ej: Año Nuevo"></label></div>`,
    async onSave(f) { await api('/feriados', { method: 'POST', body: fd(f) }); toast('Feriado guardado'); render(); } });
}
async function borrarFeriado(id) {
  if (!confirmar('¿Quitar este feriado? Ese día volverá a contar faltas y retrasos.')) return;
  await run(() => api('/feriados/' + id, { method: 'DELETE' }), 'Feriado quitado'); render();
}
// Empleados → Horario propio: excepción para los marcados, desde una fecha (lo anterior no cambia)
async function asignarHorario() {
  const ids = [...document.querySelectorAll('#empTable input[name=empSel]:checked')].map(c => Number(c.value));
  if (!ids.length) return toast('Marca primero a los empleados', true);
  const emps = empCache.filter(e => ids.includes(e.id)), empresa_id = emps[0].empresa_id;
  if (emps.some(e => e.empresa_id !== empresa_id)) return toast('Marca empleados de una sola empresa', true);
  const [hs, pr] = await run(() => Promise.all([api('/horarios' + qs({ empresa_id: isAdmin() ? empresa_id : '' })),
    api('/horarios/principal' + qs({ empresa_id: isAdmin() ? empresa_id : '' }))]));
  principalCache = pr;
  const { vigente } = principalDe(pr.empresas[0]);
  modal({ title: `Horario de ${ids.length} empleado(s)`, body: `
    <label class="f">Horario<select name="opcion">
      <option value="empresa">El de la empresa (${esc(vigente?.horario || 'sin horario principal')})</option>
      ${hs.map(h => `<option value="${h.id}">Propio: ${esc(h.nombre)}</option>`).join('')}
      <option value="sin_horario">Sin control de horario</option></select></label>
    <label class="f">Desde<input type="date" name="desde" required value="${hoyISO()}"></label>
    <p class="hint" style="margin:0">"El de la empresa" sigue los cambios del horario principal. "Sin control de horario" no cuenta retrasos ni faltas (por ejemplo, gerencia). Los días anteriores a esa fecha no cambian.</p>`,
    async onSave(f) {
      const { opcion, desde } = fd(f);
      const modo = ['empresa', 'sin_horario'].includes(opcion) ? opcion : 'horario';
      const r = await api('/horarios/asignar', { method: 'POST', body: { empleados: ids, desde, modo, horario_id: modo === 'horario' ? Number(opcion) : null } });
      toast(`Horario actualizado para ${r.asignados} empleado(s)`); render();
    } });
}
const marcarTodos = c => document.querySelectorAll('#empTable input[name=empSel]').forEach(x => { x.checked = c.checked; });

function cambiarClave() {
  modal({ title: 'Cambiar mi clave', body: `<label class="f">Clave actual<input name="actual" type="password" required autocomplete="current-password"></label>
    <label class="f">Nueva clave${claveInput('nueva', 'password')}</label><p class="hint" style="margin:0">${CLAVE_REGLA}.</p>`,
    async onSave(f) { await api('/me/password', { method: 'POST', body: fd(f) }); toast('Clave actualizada'); } });
}
