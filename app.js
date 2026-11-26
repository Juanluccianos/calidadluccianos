/* =============================================================================
 *  Calidad — Lucciano's (frontend)
 *  Vanilla JS, sin build. Habla con el Worker calidad-api (window.CALIDAD_API).
 *  Rutas por hash: #/tablero, #/hoy, #/historial, #/equipo, #/tarea/ID
 *  Misma base visual y de código que Asientos (marco común de Herramientas).
 * ============================================================================= */
'use strict';

/* Entrada desde Herramientas: si en este navegador quedó la sesión de OTRA persona,
   se descarta y el portal consigue la de quien está usando la compu. */
(function controlarCuenta() {
  const m = location.hash.match(/^#portal(?:!(\d+))?(?:=.*)?$/);
  if (!m) return;
  try {
    const uid = m[1];
    const token = localStorage.getItem('calidad_token') || '';
    const dueno = localStorage.getItem('herr_uid');
    if (token && uid && dueno !== uid) { localStorage.removeItem('calidad_token'); localStorage.removeItem('herr_uid'); }
    if (uid) history.replaceState(null, '', location.pathname + location.search + location.hash.replace('!' + uid, ''));
  } catch (e) { /* sin storage */ }
})();
try { if (localStorage.getItem('herr_portal') === '0') document.head.insertAdjacentHTML('beforeend', '<style>[aria-label="Volver al portal"]{display:none!important}</style>'); } catch (e) { /* sin storage */ }

// ---------------------------------------------------------------------------
//  Estado y utilidades
// ---------------------------------------------------------------------------
const API = (() => {
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q) localStorage.setItem('calidad_api', q);
    return (localStorage.getItem('calidad_api') || window.CALIDAD_API).replace(/\/$/, '');
  } catch { return String(window.CALIDAD_API).replace(/\/$/, ''); }
})();
const PORTAL = 'https://herramientas.luccianos.com.ar';
const ACCESO_API = 'https://acceso-api.lucciano-viaticos.workers.dev';
const ACCESO_APP = 'calidad';

const S = {
  token: null, user: null, ro: false, mios: [],
  data: null, cargadoAt: 0, render: null,
  f: { q: '', puesto: '', cat: '', urg: '', criticas: false, saturados: false },
  modo: 'kanban', colMovil: 'pendiente', hoyPuesto: null,
  estrategia: 'auto',
};
try {
  S.token = localStorage.getItem('calidad_token');
  S.estrategia = localStorage.getItem('calidad_estrategia') || 'auto';
  S.modo = localStorage.getItem('calidad_modo') || 'kanban';
} catch { /* sin storage */ }

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esAdmin = () => S.user && S.user.rol === 'admin';

const CATEGORIAS = ['Auditoría BPM', 'Verificación POES', 'Laboratorio / Microbiología', 'Asuntos Regulatorios / Rótulos', 'No Conformidad / Desvíos', 'Documentación / KPIs'];
const URG = {
  critica: { t: 'Crítica', largo: 'Crítica (inocuidad / bloqueo)' },
  alta: { t: 'Alta', largo: 'Alta (prioritaria)' },
  media: { t: 'Media', largo: 'Media (planificada)' },
  baja: { t: 'Baja', largo: 'Baja (rutina / mejora)' },
};
const ESTADOS = [
  { id: 'pendiente', t: 'Pendiente', largo: 'Pendiente / por iniciar' },
  { id: 'ejecucion', t: 'En ejecución', largo: 'En ejecución' },
  { id: 'revision', t: 'En revisión', largo: 'En revisión / validación' },
  { id: 'resuelto', t: 'Resuelto', largo: 'Resuelto / cerrado' },
];
const nombreEstado = (id) => (ESTADOS.find(e => e.id === id) || {}).t || id;

function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'ver' + (error ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, error ? 6000 : 3000);
}

/* ---- Pantallas rápidas: el inicio y la salud muestran al instante lo último que se vio y se actualizan solas
   de fondo (si llegó algo nuevo, la pantalla se vuelve a dibujar). Se guarda en este navegador, por persona. ---- */
const RAPIDAS = /^\/api\/(tablero|salud)(\?|$)/;
const RAPIDA_FRESCA_MS = 15000;
const rapidaEnCurso = new Set();
let rapidaRedibujo = null;
function rapidaClave(path) { let u = ''; try { u = localStorage.getItem('herr_uid') || ''; } catch (e) { /* sin storage */ } return 'rapida:' + u + ':' + path; }
function rapidaGuardar(k, d) { try { localStorage.setItem(k, JSON.stringify({ at: Date.now(), data: d })); } catch (e) { /* sin lugar: se ignora */ } }
async function api(path, opts = {}) {
  const metodo = String(opts.method || 'GET').toUpperCase();
  if (metodo !== 'GET' || opts.raw || !RAPIDAS.test(path)) return apiRed(path, opts);
  const k = rapidaClave(path);
  let c = null;
  try { c = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { c = null; }
  if (c && Date.now() - c.at < RAPIDA_FRESCA_MS) return c.data;
  if (!c) { const d = await apiRed(path, opts); rapidaGuardar(k, d); return d; }
  if (!rapidaEnCurso.has(k)) {
    rapidaEnCurso.add(k);
    const hash = location.hash;
    apiRed(path, opts).then(d => {
      const cambio = JSON.stringify(d) !== JSON.stringify(c.data);
      rapidaGuardar(k, d);
      if (cambio && location.hash === hash) { clearTimeout(rapidaRedibujo); rapidaRedibujo = setTimeout(() => { if (typeof router === 'function') router(); }, 150); }
    }).catch(() => { /* sin conexión: queda lo guardado */ }).finally(() => rapidaEnCurso.delete(k));
  }
  return c.data;
}

async function apiRed(path, { method = 'GET', body } = {}) {
  let res;
  for (let intento = 0; ; intento++) {
    try {
      res = await fetch(API + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (method === 'GET' && [502, 503, 504].includes(res.status) && intento < 2) throw new TypeError('HTTP ' + res.status);
      break;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (method !== 'GET' || intento >= 2) throw new Error(method === 'GET' ? 'No hay conexión con el servidor. Probá de nuevo en unos segundos.' : 'Se cortó la conexión y no sé si se guardó. Actualizá la pantalla antes de volver a intentar.');
      await new Promise(r => setTimeout(r, 700 * (intento + 1)));
    }
  }
  if (res.status === 401 && S.token) {
    salir();
    throw new Error('La sesión se cerró. Volvé a entrar desde el portal.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

async function conBoton(btn, fn) {
  const txt = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cargando"></span>'; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = txt; } }
}

function modal(html, { ancho = false, alMontar, foco = true } = {}) {
  const m = $('#modal');
  $('.modal-box', m).classList.toggle('ancho', ancho);
  $('.modal-cuerpo', m).innerHTML = html;
  m.hidden = false;
  document.body.classList.add('con-modal');
  const cerrar = () => { m.hidden = true; $('.modal-cuerpo', m).innerHTML = ''; document.body.classList.remove('con-modal'); };
  $('.modal-cerrar', m).onclick = cerrar;
  m.onclick = (e) => { if (e.target === m) cerrar(); };
  if (alMontar) alMontar($('.modal-cuerpo', m), cerrar);
  const primero = foco && matchMedia('(hover: hover)').matches ? $('input:not([type=checkbox]):not([disabled]), textarea:not([disabled])', m) : null;
  if (primero) setTimeout(() => primero.focus(), 30);
  return cerrar;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) $('.modal-cerrar').click(); });

function confirmar(texto, { boton = 'Sí, seguir', peligro = false } = {}) {
  return new Promise((resolve) => {
    let hecho = false;
    modal(`<h2 style="margin-bottom:6px">¿Confirmás?</h2><p class="muted" style="white-space:pre-line;margin:0 0 18px">${esc(texto)}</p>
      <div class="acciones" style="justify-content:flex-end"><button class="btn" data-no>Cancelar</button><button class="btn ${peligro ? 'btn-rojo' : 'btn-acento'}" data-si>${esc(boton)}</button></div>`, {
      foco: false,
      alMontar: (el, cerrar) => {
        const fin = (v) => { if (hecho) return; hecho = true; cerrar(); resolve(v); };
        $('[data-si]', el).onclick = () => fin(true);
        $('[data-no]', el).onclick = () => fin(false);
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!hecho) { hecho = true; resolve(false); } } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

// ---------------------------------------------------------------------------
//  Íconos
// ---------------------------------------------------------------------------
const svgI = (p) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  tablero: svgI('<rect x="3" y="3" width="5" height="18" rx="1.5"/><rect x="10" y="3" width="5" height="12" rx="1.5"/><rect x="17" y="3" width="4" height="8" rx="1.5"/>'),
  hoy: svgI('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3h6v3H9zM9 12l2 2 4-4M9 17h6"/>'),
  hist: svgI('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  users: svgI('<path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M17 11a3 3 0 1 0 0-6M21 21v-2a4 4 0 0 0-3-3.87"/>'),
  mas: svgI('<path d="M12 5v14M5 12h14"/>'),
  rayo: svgI('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  balanza: svgI('<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z"/>'),
  search: svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  refresh: svgI('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  check: svgI('<path d="M20 6 9 17l-5-5"/>'),
  arrow: svgI('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  play: svgI('<path d="M7 4v16l13-8z"/>'),
  edit: svgI('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  trash: svgI('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
  up: svgI('<path d="m18 15-6-6-6 6"/>'),
  down: svgI('<path d="m6 9 6 6 6-6"/>'),
  copy: svgI('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  download: svgI('<path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  upload: svgI('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  archive: svgI('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>'),
  clock: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  alert: svgI('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  sun: svgI('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svgI('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  grid: svgI('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  lista: svgI('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  x: svgI('<path d="M6 6l12 12M18 6 6 18"/>'),
  mas2: svgI('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
};
const iniciales = (s) => String(s || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !/^(y|e|de|del|la|el|los|las)$/i.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

function temaActual() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function alternarTema() {
  const nuevo = temaActual() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem('calidad_tema', nuevo); } catch { }
  const b = $('#b-tema'); if (b) b.innerHTML = nuevo === 'dark' ? ICO.sun : ICO.moon;
}

// ---------------------------------------------------------------------------
//  Fechas, horas y prioridad
// ---------------------------------------------------------------------------
const diaAR = (n = 0) => new Date(Date.now() - 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const hoy = () => diaAR(0);
const fmtCorta = (d) => { if (!d) return 'Sin fecha'; const p = String(d).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : d; };
const fmtLarga = (d) => { if (!d) return '—'; const p = String(d).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d; };
const fmtFH = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
function fmtHoras(h) {
  h = Number(h) || 0;
  if (h <= 0) return '0 min';
  const m = Math.round(h * 60), hh = Math.floor(m / 60), mm = m % 60;
  if (!hh) return `${mm} min`;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}
function horasCorriendo(t) {
  if (!t.iniciado_at) return 0;
  return Math.max(0.25, Math.round(((Date.now() - new Date(t.iniciado_at).getTime()) / 3600e3) * 4) / 4);
}
function etiquetaVence(t) {
  if (t.estado === 'resuelto') return { cls: '', txt: fmtCorta(t.vence) };
  if (t.vence && t.vence < hoy()) return { cls: 'vencida', txt: 'Vencida ' + fmtCorta(t.vence) };
  if (t.vence === hoy()) return { cls: 'hoy', txt: 'Vence hoy' };
  if (t.vence === diaAR(1)) return { cls: '', txt: 'Mañana' };
  return { cls: '', txt: fmtCorta(t.vence) };
}

const puesto = (id) => (S.data?.puestos || []).find(p => p.id === id);
const nombrePuesto = (id) => puesto(id)?.corto || 'Sin puesto';
const puedeTocar = (t) => !S.ro && (esAdmin() || S.mios.includes(t.puesto_id));
const puedeCargar = () => !S.ro && (esAdmin() || S.mios.length > 0);

function stats(pid) {
  const p = puesto(pid) || { max_activas: 3 };
  const ts = (S.data?.tareas || []).filter(t => t.puesto_id === pid);
  const act = ts.filter(t => t.estado !== 'resuelto');
  const res = ts.filter(t => t.estado === 'resuelto');
  const criticas = act.filter(t => t.urgencia === 'critica').length;
  const max = p.max_activas || 3;
  const saturado = act.length > max || (act.length >= max && criticas >= 2);
  const limite = !saturado && (act.length === max || criticas >= 1);
  return { activas: act.length, max, resueltas: res.length, criticas, horas: res.reduce((a, t) => a + (Number(t.horas) || 0), 0), saturado, limite };
}

const PESO = { critica: 100, alta: 60, media: 30, baja: 10 };
function puntaje(t, est = S.estrategia) {
  let s = PESO[t.urgencia] || 20;
  const h = hoy();
  if (t.vence) {
    if (t.vence < h) s += 70; else if (t.vence === h) s += 45; else if (t.vence === diaAR(1)) s += 20;
  }
  if (t.estado === 'ejecucion') s += 18;
  if (t.estado === 'revision') s += 12;
  if (est === 'cuellos') { const st = stats(t.puesto_id); if (st.saturado) s += 85; else if (st.limite) s += 35; }
  else if (est === 'antiguas') s += Math.min(80, ((Date.now() - new Date(t.creado_at).getTime()) / 3600e3) * 4);
  return s;
}
const porPrioridad = (lista) => [...lista].sort((a, b) => puntaje(b) - puntaje(a) || a.id - b.id);
// "Mi día": primero el orden que eligió la persona (flechitas), después la prioridad automática
const porOrdenDelDia = (lista) => [...lista].sort((a, b) => (a.orden_manual ?? 1e6) - (b.orden_manual ?? 1e6) || puntaje(b) - puntaje(a) || a.id - b.id);

// ---------------------------------------------------------------------------
//  Sesión (login único del portal)
// ---------------------------------------------------------------------------
function guardarToken(t) { S.token = t; try { t ? localStorage.setItem('calidad_token', t) : localStorage.removeItem('calidad_token'); } catch { } }
function salir() { guardarToken(null); S.user = null; S.data = null; vistaLogin(); }

async function canjearAcceso() {
  const mPortal = location.hash.match(/^#portal(?:=(.+))?$/);
  if (mPortal) {
    const destino = mPortal[1] ? decodeURIComponent(mPortal[1]) : '';
    history.replaceState(null, '', location.pathname + location.search + destino);
    if (!S.token) { location.replace(PORTAL + '/#ir=' + ACCESO_APP); return 'redirigiendo'; }
    return;
  }
  const m = location.hash.match(/^#acceso=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const res = await fetch(ACCESO_API + '/canjear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo: m[1], app: ACCESO_APP }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || 'No se pudo ingresar.');
    guardarToken(r.token);
    try {
      localStorage.setItem('herr_uid', String(r.usuario?.id || ''));
      localStorage.setItem('herr_portal', r.ve_portal === false ? '0' : '1');
    } catch (e2) { /* sin storage */ }
  } catch (e) {
    setTimeout(() => toast(e.message.includes('fetch') ? 'No se pudo conectar para ingresar. Volvé a entrar desde el portal.' : e.message, true), 400);
  }
}

function vistaLogin() {
  $('#app').innerHTML = `<div class="login">
    <div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><p class="login-sub">Calidad</p>
      <div class="login-txt"><h2>Tareas del equipo de Calidad, en un solo tablero.</h2><p>Cada puesto ve lo suyo, ordenado por riesgo y vencimiento. Al cerrar una tarea queda anotado cuánto tiempo llevó.</p></div>
      <div class="pasos"><span>${ICO.mas}Se carga</span><span>${ICO.play}Se ejecuta</span><span>${ICO.check}Se cierra</span><span>${ICO.clock}Se mide</span></div></div>
    <div class="login-form"><div class="caja">
      <h1>Ingresar</h1>
      <p>Entrá desde el portal de Herramientas, con tu usuario de Lucciano's.</p>
      <a class="btn btn-acento btn-grande" href="${PORTAL}/#ir=${ACCESO_APP}" style="text-decoration:none;justify-content:center">Ir al portal ${ICO.arrow}</a>
    </div></div></div>`;
}

// ---------------------------------------------------------------------------
//  Datos
// ---------------------------------------------------------------------------
async function cargarDatos(forzar = false) {
  if (!forzar && S.data && Date.now() - S.cargadoAt < 30e3) return S.data;
  S.data = await api('/api/tablero');
  S.mios = S.data.mis_puestos || [];
  S.cargadoAt = Date.now();
  pintarContadores();
  return S.data;
}
function aplicar(t) {
  if (!S.data || !t) return;
  const i = S.data.tareas.findIndex(x => x.id === t.id);
  if (t.archivada) { if (i >= 0) S.data.tareas.splice(i, 1); return; }
  if (i >= 0) S.data.tareas[i] = t; else S.data.tareas.unshift(t);
}
function repintar() { pintarContadores(); if (S.render) S.render(); }

// ---------------------------------------------------------------------------
//  Marco (barra lateral + barra superior + menú inferior) y router
// ---------------------------------------------------------------------------
const RUTAS = [
  { re: /^#\/tablero$/, v: vistaTablero, nav: 'tablero', miga: 'Trabajo / <b>Tablero</b>' },
  { re: /^#\/hoy$/, v: vistaHoy, nav: 'hoy', miga: 'Trabajo / <b>Mi día</b>' },
  { re: /^#\/tarea\/(\d+)$/, v: vistaTablero, nav: 'tablero', miga: 'Trabajo / <b>Tablero</b>' },
  { re: /^#\/historial$/, v: vistaHistorial, nav: 'historial', miga: 'Datos / <b>Historial</b>' },
  { re: /^#\/equipo$/, v: vistaEquipo, nav: 'equipo', miga: 'Datos / <b>Equipo y puestos</b>', admin: true },
];
const rutaInicial = () => (esAdmin() ? '#/tablero' : '#/hoy');

function shell(ruta) {
  const a = ruta.nav;
  const it = (k, ic, t, cnt = '') => `<a href="#/${k}" class="${k === a ? 'activo' : ''}" ${k === a ? 'aria-current="page"' : ''}>${ICO[ic]}<span>${t}</span>${cnt}</a>`;
  const rol = S.ro ? 'Consulta' : esAdmin() ? 'Líder / Admin' : 'Equipo';
  const puestosTxt = S.mios.map(nombrePuesto).join(', ');
  return `<div class="app">
    <aside class="side">
      <a class="brand" href="${rutaInicial()}"><img src="logo-negro.png" alt="Lucciano's"><span>Calidad</span></a>
      <nav class="nav" aria-label="Secciones">
        <div class="grp-t">Trabajo</div>
        ${it('tablero', 'tablero', 'Tablero', '<span class="cnt hot" data-cnt="criticas"></span>')}
        ${it('hoy', 'hoy', 'Mi día', '<span class="cnt" data-cnt="mias"></span>')}
        <div class="grp-t">Datos</div>
        ${it('historial', 'hist', 'Historial')}
        ${esAdmin() ? it('equipo', 'users', 'Equipo y puestos') : ''}
      </nav>
      <div class="me"><span class="av">${esc(iniciales(S.user.nombre))}</span>
        <span class="who"><b>${esc(S.user.nombre)}</b><small>${esc(puestosTxt || rol)}</small></span>
        <div class="ibtns"><button class="ibtn" id="b-tema" title="Claro / oscuro" aria-label="Cambiar tema">${temaActual() === 'dark' ? ICO.sun : ICO.moon}</button><a class="ibtn" href="${PORTAL}" title="Volver al portal" aria-label="Volver al portal">${ICO.grid}</a></div></div>
    </aside>
    <div style="min-width:0">
      <header class="top"><img class="marca-m" src="logo-negro.png" alt="Lucciano's"><div class="crumbs">${ruta.miga}</div>
        <label class="buscar">${ICO.search}<input id="buscar-global" placeholder="Buscar tarea, lote, línea…" aria-label="Buscar"><kbd>Ctrl K</kbd></label>
        ${S.ro ? '<span class="tag">Solo consulta</span>' : ''}
        <button class="ibtn" id="b-actualizar" title="Actualizar" aria-label="Actualizar">${ICO.refresh}</button></header>
      <main id="vista" class="entra"><div class="vacio"><span class="cargando"></span></div></main>
    </div></div>
    <nav class="mnav" aria-label="Secciones">
      <a href="#/tablero" class="${a === 'tablero' ? 'activo' : ''}">${ICO.tablero}Tablero<span class="cnt hot" data-cnt="criticas"></span></a>
      <a href="#/hoy" class="${a === 'hoy' ? 'activo' : ''}">${ICO.hoy}Mi día<span class="cnt" data-cnt="mias"></span></a>
      ${puedeCargar() ? `<a href="#" data-acc="carga-rapida" class="mnav-mas">${ICO.mas}Cargar</a>` : ''}
      <a href="#/historial" class="${a === 'historial' ? 'activo' : ''}">${ICO.hist}Historial</a>
      ${esAdmin() ? `<a href="#/equipo" class="${a === 'equipo' ? 'activo' : ''}">${ICO.users}Equipo</a>` : ''}
    </nav>`;
}

function pintarContadores() {
  if (!S.data) return;
  const abiertas = S.data.tareas.filter(t => t.estado !== 'resuelto');
  const c = {
    criticas: abiertas.filter(t => t.urgencia === 'critica').length,
    mias: abiertas.filter(t => S.mios.includes(t.puesto_id)).length,
  };
  $$('[data-cnt]').forEach(x => { const n = c[x.dataset.cnt]; x.textContent = n ? n : ''; });
}

async function router() {
  if (!S.token) return vistaLogin();
  let h = location.hash;
  let r = RUTAS.find(x => x.re.test(h));
  if (!r || (r.admin && !esAdmin())) { h = rutaInicial(); history.replaceState(null, '', location.pathname + location.search + h); r = RUTAS.find(x => x.re.test(h)); }
  const m = h.match(r.re) || [];
  $('#app').innerHTML = shell(r);
  $('#b-actualizar').onclick = actualizar;
  $('#b-tema').onclick = alternarTema;
  const bg = $('#buscar-global');
  bg.value = S.f.q;
  bg.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    S.f.q = bg.value.trim();
    if (location.hash === '#/tablero') { const f = $('#f-q'); if (f) f.value = S.f.q; S.render?.(); }
    else location.hash = '#/tablero';
  };
  S.render = null;
  window.scrollTo(0, 0);
  try { await r.v($('#vista'), ...m.slice(1)); pintarContadores(); }
  catch (e) {
    if (S.token && $('#vista')) {
      $('#vista').innerHTML = `<div class="panel panel-pad"><h2>No se pudo cargar</h2><p class="muted">${esc(e.message)}</p><button class="btn btn-acento" id="b-reint">${ICO.refresh}Reintentar</button></div>`;
      $('#b-reint').onclick = () => { S.data = null; router(); };
    }
  }
}

async function actualizar() {
  const b = $('#b-actualizar');
  if (b) b.classList.add('girando');
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) { await reg.update().catch(() => null); if (reg.waiting || reg.installing) { location.reload(); return; } }
    await cargarDatos(true);
    await router();
    toast('Actualizado');
  } catch (e) { toast(e.message, true); }
  finally { const x = $('#b-actualizar'); if (x) x.classList.remove('girando'); }
}

async function iniciar() {
  if (await canjearAcceso() === 'redirigiendo') return;
  if (!S.token) return vistaLogin();
  try {
    const r = await api('/api/yo');
    S.user = r.usuario; S.ro = !!r.usuario.solo_lectura; S.mios = r.mis_puestos || [];
    await cargarDatos(true);
  } catch (e) { if (S.token) { $('#app').innerHTML = `<div class="vacio"><span class="grande">No se pudo conectar</span>${esc(e.message)}<p><button class="btn btn-acento" onclick="location.reload()">Reintentar</button></p></div>`; } return; }
  if (!location.hash || !RUTAS.some(x => x.re.test(location.hash))) history.replaceState(null, '', location.pathname + location.search + rutaInicial());
  await router();
}
window.addEventListener('hashchange', router);
document.addEventListener('DOMContentLoaded', iniciar);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { const b = $('#buscar-global'); if (b) { e.preventDefault(); b.focus(); b.select(); } }
});

// Refresco solo: si otra persona movió algo, se ve sin tocar nada (cada 3 minutos, o al volver a la pestaña)
async function refrescoSilencioso() {
  if (!S.token || !S.user || !S.data || document.visibilityState !== 'visible') return;
  if (!$('#modal').hidden) return;
  const act = document.activeElement;
  if (act && act.closest('#vista') && /INPUT|TEXTAREA|SELECT/.test(act.tagName)) return;
  if (!['#/tablero', '#/hoy'].includes(location.hash)) return;
  const antes = JSON.stringify(S.data.tareas);
  try { await cargarDatos(true); } catch { return; }
  if (JSON.stringify(S.data.tareas) !== antes) repintar();
}
setInterval(refrescoSilencioso, 180e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - S.cargadoAt > 60e3) refrescoSilencioso(); });

// ---------------------------------------------------------------------------
//  Piezas comunes
// ---------------------------------------------------------------------------
const badgeUrg = (u) => `<span class="urg u-${esc(u)}">${esc(URG[u]?.t || u)}</span>`;
const optsCategorias = (sel) => CATEGORIAS.map(c => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');
const optsUrg = (sel) => Object.entries(URG).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v.largo)}</option>`).join('');
const optsEstados = (sel) => ESTADOS.map(e => `<option value="${e.id}" ${e.id === sel ? 'selected' : ''}>${esc(e.largo)}</option>`).join('');
// Puestos que esta persona puede elegir al cargar: la Líder todos; el equipo, los suyos
const puestosElegibles = () => (S.data?.puestos || []).filter(p => esAdmin() || S.mios.includes(p.id));
function optsPuestos(sel, { conCarga = false } = {}) {
  return puestosElegibles().map(p => {
    let extra = '';
    if (conCarga && esAdmin()) { const st = stats(p.id); extra = ` (${st.activas}/${st.max})${st.saturado ? ' · saturado' : st.limite ? ' · al límite' : ''}`; }
    return `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.corto)}${extra}</option>`;
  }).join('');
}
const avatarPuesto = (p, chico = false) => `<span class="av-p${chico ? ' chico' : ''}" style="--pc:${esc(p?.color || '#3a3933')}">${esc(iniciales(p?.corto || '?'))}</span>`;

function sinPuesto() {
  return `<div class="panel panel-pad aviso-puesto"><h2>Todavía no tenés un puesto asignado</h2>
    <p class="muted">Para ver y cargar tus tareas, la Líder de Calidad tiene que poner tu mail (<b>${esc(S.user.email)}</b>) en tu puesto, desde "Equipo y puestos".</p></div>`;
}

// Acciones sobre tareas (botones con data-acc en cualquier pantalla)
async function guardarTarea(id, cambios, { msg } = {}) {
  const r = await api('/api/tareas/' + id, { method: 'PUT', body: cambios });
  aplicar(r.tarea); repintar();
  if (msg) toast(msg);
  return r.tarea;
}
const tareaPorId = (id) => (S.data?.tareas || []).find(t => t.id === Number(id));

async function cambiarEstado(id, estado) {
  const t = tareaPorId(id);
  if (!t || t.estado === estado) return;
  if (estado === 'resuelto') return modalResolver(t);
  await guardarTarea(id, { estado }, { msg: t.estado === 'resuelto' ? 'Tarea reabierta' : `Pasó a "${nombreEstado(estado)}"` });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-acc]');
  if (!el) return;
  const acc = el.dataset.acc, id = el.dataset.id;
  if (el.tagName === 'A') e.preventDefault();
  try {
    if (acc === 'carga-rapida') return modalCargaRapida();
    if (acc === 'nueva') return modalTarea(null, { puesto_id: el.dataset.puesto || '' });
    if (acc === 'editar') return modalTarea(tareaPorId(id));
    if (acc === 'resolver') return modalResolver(tareaPorId(id));
    if (acc === 'rebalancear') return modalRebalanceo();
    if (acc === 'estado') return await conBoton(el, () => cambiarEstado(id, el.dataset.v));
    if (acc === 'reabrir') return await conBoton(el, () => cambiarEstado(id, 'ejecucion'));
    if (acc === 'mover-vence') return await conBoton(el, () => guardarTarea(id, { vence: diaAR(Number(el.dataset.v)) }, { msg: el.dataset.v === '0' ? 'Ahora vence hoy' : 'Pasó para mañana' }));
    if (acc === 'filtro-puesto') { S.f.puesto = S.f.puesto === el.dataset.v ? '' : el.dataset.v; const s = $('#f-puesto'); if (s) s.value = S.f.puesto; return S.render?.(); }
    if (acc === 'col-movil') { S.colMovil = el.dataset.v; return S.render?.(); }
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.matches('[data-check]')) {
      el.disabled = true;
      await guardarTarea(el.dataset.id, { check_toggle: Number(el.dataset.check), check_valor: el.checked });
    } else if (el.matches('[data-derivar]')) {
      const p = puesto(el.value);
      await guardarTarea(el.dataset.derivar, { puesto_id: el.value }, { msg: `Derivada a ${p ? p.corto : 'otro puesto'}` });
    } else if (el.matches('[data-cambiar-estado]')) {
      const id = el.dataset.cambiarEstado, v = el.value;
      el.value = tareaPorId(id)?.estado || v;
      await cambiarEstado(id, v);
    }
  } catch (err) { toast(err.message, true); repintar(); }
});

// ---------------------------------------------------------------------------
//  TABLERO
// ---------------------------------------------------------------------------
function filtrar(lista) {
  const f = S.f, q = f.q.toLowerCase();
  return lista.filter(t => {
    if (f.puesto && t.puesto_id !== f.puesto) return false;
    if (f.cat && t.categoria !== f.cat) return false;
    if (f.urg && t.urgencia !== f.urg) return false;
    if (f.criticas && t.urgencia !== 'critica') return false;
    if (f.saturados && !stats(t.puesto_id).saturado) return false;
    if (q && !`${t.titulo} ${t.categoria} ${t.notas || ''} ${nombrePuesto(t.puesto_id)}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

async function vistaTablero(el, idTarea) {
  await cargarDatos();
  const verRadar = esAdmin() || S.mios.length > 1;
  if (!esAdmin() && !S.mios.length) { el.innerHTML = sinPuesto(); return; }
  el.innerHTML = `
    <div class="encabezado">
      <div><h1>Tablero de Calidad</h1><p>${esAdmin() ? 'Pendientes de todo el equipo, ordenados por riesgo y vencimiento.' : 'Las tareas de tu puesto, ordenadas por riesgo y vencimiento.'}</p></div>
      <div class="acciones">
        ${puedeCargar() ? `<button class="btn btn-acento" data-acc="carga-rapida">${ICO.rayo}Carga rápida</button><button class="btn" data-acc="nueva">${ICO.mas}Tarea detallada</button>` : ''}
        ${esAdmin() && !S.ro ? `<button class="btn" data-acc="rebalancear">${ICO.balanza}Rebalancear<span class="cnt hot" id="cnt-saturados"></span></button>` : ''}
        <button class="btn btn-ghost" id="b-csv" title="Bajar las tareas que se ven a Excel">${ICO.download}Excel</button>
      </div>
    </div>
    <section class="foco" id="foco"></section>
    ${verRadar ? `<section class="radar-cab"><h3>Carga por puesto</h3><span class="muted small">Tocá un puesto para filtrar. Semáforo por pendientes activos y urgencias críticas.</span></section><section class="radar" id="radar"></section>` : ''}
    <section class="panel">
      <div class="filtros barra-f">
        <div class="campo ancho"><label for="f-q">Buscar</label><div class="campo-buscar">${ICO.search}<input id="f-q" placeholder="Tarea, lote, línea…" value="${esc(S.f.q)}"></div></div>
        ${verRadar ? `<div class="campo"><label for="f-puesto">Puesto</label><select id="f-puesto"><option value="">Todos los puestos</option>${(S.data.puestos || []).filter(p => esAdmin() || S.mios.includes(p.id)).map(p => `<option value="${esc(p.id)}" ${p.id === S.f.puesto ? 'selected' : ''}>${esc(p.corto)}</option>`).join('')}</select></div>` : ''}
        <div class="campo"><label for="f-cat">Proceso</label><select id="f-cat"><option value="">Todos los procesos</option>${optsCategorias(S.f.cat)}</select></div>
        <div class="campo"><label for="f-urg">Urgencia</label><select id="f-urg"><option value="">Toda urgencia</option>${Object.entries(URG).map(([k, v]) => `<option value="${k}" ${k === S.f.urg ? 'selected' : ''}>${v.t}</option>`).join('')}</select></div>
        <div class="campo"><label for="f-est">Orden automático</label><select id="f-est">
          <option value="auto" ${S.estrategia === 'auto' ? 'selected' : ''}>Riesgo + vencimiento</option>
          <option value="cuellos" ${S.estrategia === 'cuellos' ? 'selected' : ''}>Descomprimir saturados</option>
          <option value="antiguas" ${S.estrategia === 'antiguas' ? 'selected' : ''}>Más antiguas primero</option></select></div>
      </div>
      <div class="barra-f2">
        <div class="toggles">
          <button class="tg ${S.f.criticas ? 'on' : ''}" id="tg-crit">${ICO.alert}Solo críticas</button>
          ${verRadar ? `<button class="tg ${S.f.saturados ? 'on' : ''}" id="tg-sat">Solo puestos saturados</button>` : ''}
          <button class="btn-link small hidden" id="b-limpiar">Limpiar filtros</button>
        </div>
        <span class="muted small" id="resumen-f"></span>
        <div class="seg-vista" role="group" aria-label="Vista">
          <button class="${S.modo === 'kanban' ? 'on' : ''}" data-modo="kanban">${ICO.tablero}Tablero</button>
          <button class="${S.modo === 'lista' ? 'on' : ''}" data-modo="lista">${ICO.lista}Lista</button>
        </div>
      </div>
    </section>
    <section id="board"></section>`;

  const fq = $('#f-q', el);
  fq.oninput = () => { S.f.q = fq.value.trim(); const g = $('#buscar-global'); if (g) g.value = S.f.q; pintar(); };
  $('#f-cat', el).onchange = (e) => { S.f.cat = e.target.value; pintar(); };
  $('#f-urg', el).onchange = (e) => { S.f.urg = e.target.value; pintar(); };
  if ($('#f-puesto', el)) $('#f-puesto', el).onchange = (e) => { S.f.puesto = e.target.value; pintar(); };
  $('#f-est', el).onchange = (e) => { S.estrategia = e.target.value; try { localStorage.setItem('calidad_estrategia', S.estrategia); } catch { } pintar(); toast('Prioridades reordenadas'); };
  $('#tg-crit', el).onclick = (e) => { S.f.criticas = !S.f.criticas; e.currentTarget.classList.toggle('on', S.f.criticas); pintar(); };
  if ($('#tg-sat', el)) $('#tg-sat', el).onclick = (e) => { S.f.saturados = !S.f.saturados; e.currentTarget.classList.toggle('on', S.f.saturados); pintar(); };
  $('#b-limpiar', el).onclick = () => { S.f = { q: '', puesto: '', cat: '', urg: '', criticas: false, saturados: false }; vistaTablero(el); };
  $$('[data-modo]', el).forEach(b => b.onclick = () => {
    S.modo = b.dataset.modo; try { localStorage.setItem('calidad_modo', S.modo); } catch { }
    $$('[data-modo]', el).forEach(x => x.classList.toggle('on', x === b)); pintar();
  });
  $('#b-csv', el).onclick = () => exportarCSV(filtrar(S.data.tareas), 'tablero');

  function pintar() {
    const todas = S.data.tareas;
    const lista = porPrioridad(filtrar(todas));
    pintarFoco(todas);
    if (verRadar) pintarRadar();
    const activas = lista.filter(t => t.estado !== 'resuelto');
    const criticas = activas.filter(t => t.urgencia === 'critica').length;
    const saturados = (S.data.puestos || []).filter(p => stats(p.id).saturado).length;
    $('#resumen-f').innerHTML = `${lista.length} tareas · ${activas.length} abiertas${criticas ? ` · <b class="txt-neg">${criticas} críticas</b>` : ''}${esAdmin() ? (saturados ? ` · <b class="txt-warn">${saturados} ${saturados === 1 ? 'puesto saturado' : 'puestos saturados'}</b>` : ' · carga equilibrada') : ''}`;
    const c = $('#cnt-saturados'); if (c) c.textContent = saturados || '';
    const hayFiltro = S.f.q || S.f.puesto || S.f.cat || S.f.urg || S.f.criticas || S.f.saturados;
    $('#b-limpiar').classList.toggle('hidden', !hayFiltro);
    const board = $('#board');
    if (S.modo === 'lista') board.innerHTML = tablaTareas(lista);
    else { board.innerHTML = kanban(lista); conectarArrastre(board); }
  }
  S.render = pintar;
  pintar();
  if (idTarea) {
    let t = tareaPorId(idTarea);
    if (!t) { try { t = (await api('/api/tareas/' + idTarea)).tarea; } catch (e) { toast(e.message, true); } }
    if (t) modalTarea(t);
    history.replaceState(null, '', location.pathname + location.search + '#/tablero');
  }
}

function pintarFoco(todas) {
  const caja = $('#foco');
  if (!caja) return;
  const abiertas = porPrioridad(todas.filter(t => t.estado !== 'resuelto'));
  const top = abiertas.slice(0, 3);
  const rh = S.data.resueltas_hoy || { n: 0, horas: 0 };
  const fecha = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  caja.innerHTML = `
    <div class="foco-cab"><div><h2>Foco del día</h2><span>${esc(fecha.charAt(0).toUpperCase() + fecha.slice(1))}</span></div>
      <span class="foco-res">${rh.n} ${rh.n === 1 ? 'resuelta' : 'resueltas'} hoy · ${fmtHoras(rh.horas)} reales</span></div>
    <div class="foco-grid">${top.length ? top.map((t, i) => {
      const v = etiquetaVence(t);
      const corre = ['ejecucion', 'revision'].includes(t.estado) ? ` · en curso ${fmtHoras(horasCorriendo(t))}` : '';
      return `<article class="foco-t u-${esc(t.urgencia)}">
        <div class="foco-n"><b>${i + 1}</b>${badgeUrg(t.urgencia)}<span class="vence ${v.cls}">${esc(v.txt)}</span></div>
        <h3>${esc(t.titulo)}</h3>
        <div class="foco-pie"><span>${esc(nombrePuesto(t.puesto_id))}${esc(corre)}</span>
          <span class="foco-acc"><button class="btn btn-chico btn-ghost" data-acc="editar" data-id="${t.id}">${puedeTocar(t) ? 'Editar' : 'Ver'}</button>
          ${puedeTocar(t) ? `<button class="btn btn-chico btn-acento" data-acc="resolver" data-id="${t.id}">${ICO.check}Cerrar y medir</button>` : ''}</span></div>
      </article>`;
    }).join('') : `<p class="foco-vacio">No hay pendientes abiertos. ${puedeCargar() ? 'Usá <b>Carga rápida</b> para sumar las tareas del turno.' : ''}</p>`}</div>`;
}

function pintarRadar() {
  const caja = $('#radar');
  if (!caja) return;
  const lista = (S.data.puestos || []).filter(p => esAdmin() || S.mios.includes(p.id));
  caja.innerHTML = lista.map(p => {
    const st = stats(p.id);
    const pct = Math.min(100, Math.round((st.activas / st.max) * 100));
    const est = st.saturado ? ['sat', 'Saturado'] : st.limite ? ['lim', 'Al límite'] : ['ok', 'Óptimo'];
    return `<button class="pz pz-${est[0]} ${S.f.puesto === p.id ? 'sel' : ''}" data-acc="filtro-puesto" data-v="${esc(p.id)}" title="${esc(p.nombre)}${p.email ? ' · ' + esc(p.email) : ''}">
      <span class="pz-cab">${avatarPuesto(p)}<span class="pz-n"><b>${esc(p.corto)}</b><small>${esc(p.area || '')}</small></span></span>
      <span class="pz-med"><span class="pz-est">${est[1]}</span><span class="pz-num"><b>${st.activas}</b> / ${st.max} activas</span></span>
      <span class="pz-bar"><i style="width:${pct}%"></i></span>
      <span class="pz-pie"><span>${ICO.clock}${fmtHoras(st.horas)} cerradas</span>${st.criticas ? `<b class="txt-neg">${st.criticas} crítica${st.criticas > 1 ? 's' : ''}</b>` : `<span>${st.resueltas} resueltas</span>`}</span>
    </button>`;
  }).join('');
}

function tarjeta(t, rank) {
  const v = etiquetaVence(t);
  const toca = puedeTocar(t);
  const ck = t.checklist || [];
  const hechos = ck.filter(c => c.hecho).length;
  let tiempo = '';
  if (t.estado === 'resuelto') tiempo = `<span class="tiempo ok">${ICO.clock}${fmtHoras(t.horas)} real</span>`;
  else if (['ejecucion', 'revision'].includes(t.estado)) tiempo = `<span class="tiempo">${ICO.clock}${fmtHoras(horasCorriendo(t))}</span>`;
  const siguiente = !toca ? '' : t.estado === 'resuelto'
    ? `<button class="btn btn-chico" data-acc="reabrir" data-id="${t.id}">Reabrir</button>`
    : `${t.estado === 'pendiente' ? `<button class="btn btn-chico btn-ghost" data-acc="estado" data-v="ejecucion" data-id="${t.id}" title="Empezar">${ICO.play}<span class="solo-ancho">Empezar</span></button>` : ''}
       ${t.estado === 'ejecucion' ? `<button class="btn btn-chico btn-ghost" data-acc="estado" data-v="revision" data-id="${t.id}">A revisión</button>` : ''}
       <button class="btn btn-chico btn-acento" data-acc="resolver" data-id="${t.id}">${ICO.check}Resolver</button>`;
  const responsable = esAdmin() && toca
    ? `<select class="derivar" data-derivar="${t.id}" aria-label="Derivar a otro puesto">${optsPuestos(t.puesto_id, { conCarga: true })}</select>`
    : `<span class="resp">${avatarPuesto(puesto(t.puesto_id), true)}${esc(nombrePuesto(t.puesto_id))}</span>`;
  return `<article class="tj u-${esc(t.urgencia)} ${v.cls === 'vencida' ? 'es-vencida' : ''}" data-id="${t.id}" ${toca ? 'draggable="true"' : ''}>
    <div class="tj-cab"><span class="rk">${rank}</span>${badgeUrg(t.urgencia)}<span class="cat">${esc(t.categoria)}</span>
      <button class="ibtn chico" data-acc="editar" data-id="${t.id}" title="${toca ? 'Editar' : 'Ver detalle'}" aria-label="Editar">${ICO.edit}</button></div>
    <h4>${esc(t.titulo)}</h4>
    ${t.notas ? `<p class="tj-notas">${esc(t.notas)}</p>` : ''}
    ${ck.length ? `<div class="tj-ck"><div class="tj-ck-cab"><span>Checklist</span><b class="${hechos === ck.length ? 'txt-pos' : ''}">${hechos}/${ck.length}</b></div>
      ${ck.map((c, i) => `<label class="ck-it ${c.hecho ? 'hecho' : ''}"><input type="checkbox" data-check="${i}" data-id="${t.id}" ${c.hecho ? 'checked' : ''} ${toca && t.estado !== 'resuelto' ? '' : 'disabled'}><span>${esc(c.texto)}</span></label>`).join('')}</div>` : ''}
    <div class="tj-vence"><span class="vence ${v.cls}">${esc(v.txt)}</span>
      ${toca && t.estado !== 'resuelto' ? `<button class="mini" data-acc="mover-vence" data-v="0" data-id="${t.id}" title="Que venza hoy">Hoy</button><button class="mini" data-acc="mover-vence" data-v="1" data-id="${t.id}" title="Pasar para mañana">Mañana</button>` : ''}
      ${tiempo}</div>
    <div class="tj-pie">${responsable}<span class="tj-acc">${siguiente}</span></div>
  </article>`;
}

function kanban(lista) {
  const cols = ESTADOS.map(e => ({ ...e, ts: lista.filter(t => t.estado === e.id) }));
  const horasRes = cols[3].ts.reduce((a, t) => a + (Number(t.horas) || 0), 0);
  return `<div class="kb-tabs" role="tablist">${cols.map(c => `<button class="${S.colMovil === c.id ? 'on' : ''}" data-acc="col-movil" data-v="${c.id}">${esc(c.t)}<b>${c.ts.length}</b></button>`).join('')}</div>
  <div class="kanban">${cols.map(c => `
    <section class="col col-${c.id} ${S.colMovil === c.id ? 'movil-on' : ''}" data-col="${c.id}">
      <div class="col-cab"><span class="punto"></span><h3>${esc(c.largo)}</h3><b>${c.ts.length}</b>${c.id === 'resuelto' ? `<small>${fmtHoras(horasRes)} reales</small>` : ''}</div>
      <div class="col-cuerpo">${c.ts.length ? c.ts.map((t, i) => tarjeta(t, i + 1)).join('') : '<div class="col-vacia">Sin tareas en esta etapa</div>'}</div>
    </section>`).join('')}</div>`;
}

function conectarArrastre(board) {
  let arrastrada = null;
  $$('.tj[draggable="true"]', board).forEach(c => {
    c.addEventListener('dragstart', (e) => { arrastrada = c.dataset.id; c.classList.add('arrastrando'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', arrastrada); });
    c.addEventListener('dragend', () => { c.classList.remove('arrastrando'); $$('.col', board).forEach(x => x.classList.remove('sobre')); });
  });
  $$('.col', board).forEach(col => {
    col.addEventListener('dragover', (e) => { if (!arrastrada) return; e.preventDefault(); col.classList.add('sobre'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('sobre'); });
    col.addEventListener('drop', async (e) => {
      e.preventDefault(); col.classList.remove('sobre');
      const id = arrastrada; arrastrada = null;
      if (id) try { await cambiarEstado(id, col.dataset.col); } catch (err) { toast(err.message, true); }
    });
  });
}

function tablaTareas(lista) {
  if (!lista.length) return '<div class="panel"><div class="vacio">No hay tareas que coincidan con los filtros.</div></div>';
  return `<div class="panel"><div class="tabla-wrap"><table class="tabla-t">
    <thead><tr><th>Tarea</th><th>Responsable</th><th>Urgencia</th><th>Estado</th><th>Avance</th><th>Tiempo real</th><th>Vence</th><th></th></tr></thead>
    <tbody>${lista.map(t => {
      const toca = puedeTocar(t), ck = t.checklist || [], v = etiquetaVence(t);
      const tiempo = t.estado === 'resuelto' ? `<b class="txt-pos">${fmtHoras(t.horas)}</b>` : t.iniciado_at ? `<span class="txt-info">${fmtHoras(horasCorriendo(t))} (en curso)</span>` : '<span class="muted">—</span>';
      return `<tr>
        <td><b>${esc(t.titulo)}</b><span class="sub-celda">${esc(t.categoria)}</span></td>
        <td>${esAdmin() && toca ? `<select class="derivar" data-derivar="${t.id}">${optsPuestos(t.puesto_id)}</select>` : esc(nombrePuesto(t.puesto_id))}</td>
        <td>${badgeUrg(t.urgencia)}</td>
        <td>${toca ? `<select data-cambiar-estado="${t.id}">${ESTADOS.map(e => `<option value="${e.id}" ${e.id === t.estado ? 'selected' : ''}>${e.t}</option>`).join('')}</select>` : esc(nombreEstado(t.estado))}</td>
        <td>${ck.length ? `${ck.filter(c => c.hecho).length}/${ck.length}` : '—'}</td>
        <td>${tiempo}</td>
        <td><span class="vence ${v.cls}">${esc(v.txt)}</span></td>
        <td class="num"><button class="btn btn-chico" data-acc="editar" data-id="${t.id}">${toca ? 'Editar' : 'Ver'}</button>
          ${toca && t.estado !== 'resuelto' ? `<button class="btn btn-chico btn-acento" data-acc="resolver" data-id="${t.id}">Cerrar</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
}

// ---------------------------------------------------------------------------
//  MI DÍA (hoja de ruta por puesto, pensada para el celular)
// ---------------------------------------------------------------------------
async function vistaHoy(el) {
  await cargarDatos();
  const elegibles = (S.data.puestos || []).filter(p => esAdmin() || S.mios.includes(p.id));
  if (!esAdmin() && !S.mios.length) { el.innerHTML = sinPuesto(); return; }
  if (!S.hoyPuesto || !elegibles.some(p => p.id === S.hoyPuesto)) S.hoyPuesto = S.mios[0] || elegibles[0]?.id;
  const p = puesto(S.hoyPuesto);
  const toca = !S.ro && (esAdmin() || S.mios.includes(S.hoyPuesto));
  el.innerHTML = `
    <div class="encabezado">
      <div><h1>Mi día</h1><p>Hoja de ruta del puesto, en el orden en que conviene hacerla. Cada tilde se ve al instante en el tablero.</p></div>
      ${elegibles.length > 1 ? `<div class="campo" style="margin:0;min-width:220px"><label for="h-puesto">Puesto</label><select id="h-puesto">${elegibles.map(x => `<option value="${esc(x.id)}" ${x.id === S.hoyPuesto ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select></div>` : ''}
    </div>
    <section class="hoy-cab panel">
      <div class="hoy-quien">${avatarPuesto(p)}<div><b>${esc(p?.nombre || '')}</b><small>${esc(p?.area || '')}</small></div></div>
      <div class="hoy-prog" id="h-prog"></div>
      <div class="hoy-acc">
        ${toca ? `<button class="btn btn-acento" data-acc="nueva" data-puesto="${esc(S.hoyPuesto)}">${ICO.mas}Agregar pendiente</button>
          <button class="btn" id="b-rutina">${ICO.rayo}Cargar rutina del turno</button>` : ''}
        <button class="btn btn-ghost" id="b-wpp">${ICO.copy}Copiar para WhatsApp</button>
      </div>
    </section>
    <section id="h-lista" class="hoy-lista"></section>`;
  if ($('#h-puesto', el)) $('#h-puesto', el).onchange = (e) => { S.hoyPuesto = e.target.value; vistaHoy(el); };
  if ($('#b-rutina', el)) $('#b-rutina', el).onclick = (e) => conBoton(e.currentTarget, async () => {
    const r = await api('/api/rutina', { method: 'POST', body: { puesto_id: S.hoyPuesto } });
    if (!r.agregadas) return toast('La rutina de hoy ya estaba cargada para este puesto');
    await cargarDatos(true); repintar();
    toast(`${r.agregadas} controles del turno cargados`);
  });
  $('#b-wpp', el).onclick = () => copiarWhatsApp(S.hoyPuesto);

  function pintar() {
    const ts = S.data.tareas.filter(t => t.puesto_id === S.hoyPuesto);
    const activas = porOrdenDelDia(ts.filter(t => t.estado !== 'resuelto'));
    const cerradas = ts.filter(t => t.estado === 'resuelto').sort((a, b) => String(b.resuelto_at).localeCompare(String(a.resuelto_at)));
    const total = ts.reduce((a, t) => a + Math.max(1, (t.checklist || []).length), 0);
    const hechos = ts.reduce((a, t) => a + (t.estado === 'resuelto' ? Math.max(1, (t.checklist || []).length) : (t.checklist || []).filter(c => c.hecho).length), 0);
    const pct = total ? Math.round(hechos / total * 100) : 0;
    $('#h-prog').innerHTML = `<div class="hoy-prog-t"><span>Avance del puesto</span><b>${hechos} / ${total} controles · ${pct}%</b></div><div class="prog"><i style="width:${pct}%"></i></div>`;
    const lista = $('#h-lista');
    if (!ts.length) {
      lista.innerHTML = `<div class="panel"><div class="vacio"><span class="grande">Sin pendientes</span>${toca ? 'Tocá <b>Cargar rutina del turno</b> para sumar los controles diarios, o agregá un pendiente.' : 'Este puesto no tiene tareas abiertas.'}</div></div>`;
      return;
    }
    lista.innerHTML = activas.map((t, i) => pasoHoy(t, i, activas.length, toca)).join('') +
      (cerradas.length ? `<h3 class="hoy-sep">Cerradas (${cerradas.length})</h3>` + cerradas.map(t => pasoHoy(t, -1, 0, toca)).join('') : '');
    $$('[data-subir]', lista).forEach(b => b.onclick = () => moverOrden(activas, Number(b.dataset.subir), -1));
    $$('[data-bajar]', lista).forEach(b => b.onclick = () => moverOrden(activas, Number(b.dataset.bajar), 1));
    $$('form[data-agregar]', lista).forEach(f => f.onsubmit = (e) => {
      e.preventDefault();
      const inp = $('input', f), texto = inp.value.trim();
      if (!texto) return;
      conBoton($('button', f), async () => { await guardarTarea(f.dataset.agregar, { check_agregar: texto }); });
    });
  }
  S.render = pintar;
  pintar();
}

function pasoHoy(t, i, n, toca) {
  const cerrada = t.estado === 'resuelto';
  const v = etiquetaVence(t);
  const ck = t.checklist || [];
  const puede = toca && puedeTocar(t);
  return `<article class="paso u-${esc(t.urgencia)} ${cerrada ? 'cerrada' : ''}">
    <div class="paso-cab">
      <span class="paso-n">${cerrada ? ICO.check : i + 1}</span>
      <div class="paso-t"><h4>${esc(t.titulo)}</h4>
        <span class="paso-meta">${badgeUrg(t.urgencia)}<span>${esc(t.categoria)}</span><span class="vence ${v.cls}">${esc(v.txt)}</span>
        ${t.estado === 'ejecucion' || t.estado === 'revision' ? `<span class="tiempo">${ICO.clock}${esc(nombreEstado(t.estado))} · ${fmtHoras(horasCorriendo(t))}</span>` : ''}
        ${cerrada ? `<span class="tiempo ok">${ICO.clock}${fmtHoras(t.horas)}</span>` : ''}</span></div>
      <div class="paso-acc">
        <button class="ibtn" data-acc="editar" data-id="${t.id}" title="Detalle" aria-label="Detalle">${ICO.edit}</button>
      </div>
    </div>
    ${t.notas ? `<p class="paso-notas">${esc(t.notas)}</p>` : ''}
    ${ck.length || (puede && !cerrada) ? `<div class="paso-ck">
      ${ck.map((c, k) => `<label class="ck-it grande ${c.hecho ? 'hecho' : ''}"><input type="checkbox" data-check="${k}" data-id="${t.id}" ${c.hecho ? 'checked' : ''} ${puede && !cerrada ? '' : 'disabled'}><span>${esc(c.texto)}</span></label>`).join('')}
      ${puede && !cerrada ? `<form class="ck-nuevo" data-agregar="${t.id}"><input placeholder="Agregar punto de control…" maxlength="200" aria-label="Nuevo punto de control"><button class="btn btn-chico" type="submit">${ICO.mas}Sumar</button></form>` : ''}
    </div>` : ''}
    ${puede ? `<div class="paso-pie">${!cerrada && n > 1 ? `<span class="paso-orden"><button class="ibtn" data-subir="${t.id}" title="Hacerla antes" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>${ICO.up}</button><button class="ibtn" data-bajar="${t.id}" title="Hacerla después" aria-label="Bajar" ${i === n - 1 ? 'disabled' : ''}>${ICO.down}</button></span>` : ''}${cerrada
      ? `<button class="btn btn-chico" data-acc="reabrir" data-id="${t.id}">Reabrir</button>`
      : `${t.estado === 'pendiente' ? `<button class="btn btn-chico" data-acc="estado" data-v="ejecucion" data-id="${t.id}">${ICO.play}Empezar</button>` : ''}
         ${t.estado === 'ejecucion' ? `<button class="btn btn-chico" data-acc="estado" data-v="revision" data-id="${t.id}">Pasar a revisión</button>` : ''}
         <button class="btn btn-acento" data-acc="resolver" data-id="${t.id}">${ICO.check}Completar tarea</button>`}</div>` : ''}
  </article>`;
}

async function moverOrden(activas, id, dir) {
  const ids = activas.map(t => t.id);
  const i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  ids.forEach((x, k) => { const t = tareaPorId(x); if (t) t.orden_manual = k; });
  repintar();
  try { await api('/api/tareas/orden', { method: 'POST', body: { ids } }); }
  catch (e) { toast(e.message, true); await cargarDatos(true); repintar(); }
}

async function copiarWhatsApp(pid) {
  const p = puesto(pid);
  const ts = S.data.tareas.filter(t => t.puesto_id === pid);
  if (!ts.length) return toast('No hay tareas para copiar en este puesto', true);
  const orden = [...porOrdenDelDia(ts.filter(t => t.estado !== 'resuelto')), ...ts.filter(t => t.estado === 'resuelto')];
  const lineas = [`📋 *HOJA DE RUTA CALIDAD · ${String(p?.nombre || '').toUpperCase()}*`, `📅 ${new Date().toLocaleDateString('es-AR')}`, ''];
  orden.forEach((t, i) => {
    const ico = t.estado === 'resuelto' ? '✅' : t.urgencia === 'critica' ? '🔴' : t.urgencia === 'alta' ? '🟠' : '🔵';
    lineas.push(`${ico} *${i + 1}. ${t.titulo}* (${URG[t.urgencia]?.t || t.urgencia})`);
    (t.checklist || []).forEach(c => lineas.push(`   ${c.hecho ? '☑' : '⬜'} ${c.texto}`));
    lineas.push('');
  });
  const texto = lineas.join('\n');
  try { await navigator.clipboard.writeText(texto); }
  catch {
    const ta = document.createElement('textarea'); ta.value = texto; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Listado copiado: pegalo en WhatsApp');
}

// ---------------------------------------------------------------------------
//  HISTORIAL (tareas resueltas, con el tiempo que llevaron)
// ---------------------------------------------------------------------------
async function vistaHistorial(el) {
  await cargarDatos();
  const elegibles = (S.data.puestos || []).filter(p => esAdmin() || S.mios.includes(p.id));
  const F = S.fh || (S.fh = { desde: diaAR(-30), hasta: hoy(), puesto: '', q: '' });
  el.innerHTML = `
    <div class="encabezado"><div><h1>Historial</h1><p>Tareas cerradas y el tiempo real que llevó cada una.</p></div>
      <div class="acciones"><button class="btn" id="b-hcsv">${ICO.download}Bajar a Excel</button></div></div>
    <section class="panel"><form class="filtros" id="f-h">
      <div class="campo"><label for="h-d">Desde</label><input type="date" id="h-d" value="${F.desde}"></div>
      <div class="campo"><label for="h-h">Hasta</label><input type="date" id="h-h" value="${F.hasta}"></div>
      ${elegibles.length > 1 ? `<div class="campo"><label for="h-p">Puesto</label><select id="h-p"><option value="">Todos</option>${elegibles.map(p => `<option value="${esc(p.id)}" ${p.id === F.puesto ? 'selected' : ''}>${esc(p.corto)}</option>`).join('')}</select></div>` : ''}
      <div class="campo ancho"><label for="h-q">Buscar</label><input id="h-q" value="${esc(F.q)}" placeholder="Tarea o comentario de cierre"></div>
      <div class="campo"><button class="btn btn-negro" type="submit">Ver</button></div>
    </form><div id="h-res"><div class="vacio"><span class="cargando"></span></div></div></section>`;
  let ultimo = [];
  const buscar = async () => {
    F.desde = $('#h-d').value; F.hasta = $('#h-h').value; F.puesto = $('#h-p')?.value || ''; F.q = $('#h-q').value.trim();
    const qs = new URLSearchParams({ desde: F.desde, hasta: F.hasta, puesto: F.puesto, q: F.q });
    const r = await api('/api/historial?' + qs);
    ultimo = r.tareas || [];
    const horas = ultimo.reduce((a, t) => a + (Number(t.horas) || 0), 0);
    const por = {};
    ultimo.forEach(t => { const x = por[t.puesto_id] || (por[t.puesto_id] = { n: 0, h: 0 }); x.n++; x.h += Number(t.horas) || 0; });
    $('#h-res').innerHTML = `
      <div class="kpis h-kpis">
        <div class="kpi"><div class="et">Tareas cerradas</div><div class="val">${ultimo.length}${ultimo.length >= (r.limite || 300) ? '+' : ''}</div></div>
        <div class="kpi"><div class="et">Tiempo real total</div><div class="val">${fmtHoras(horas)}</div></div>
        <div class="kpi"><div class="et">Promedio por tarea</div><div class="val">${ultimo.length ? fmtHoras(horas / ultimo.length) : '—'}</div></div>
      </div>
      ${Object.keys(por).length > 1 ? `<div class="h-puestos">${Object.entries(por).sort((a, b) => b[1].h - a[1].h).map(([pid, x]) => `<div class="h-pz">${avatarPuesto(puesto(pid), true)}<b>${esc(nombrePuesto(pid))}</b><span>${x.n} ${x.n === 1 ? 'tarea' : 'tareas'} · ${fmtHoras(x.h)}</span></div>`).join('')}</div>` : ''}
      ${ultimo.length ? `<div class="tabla-wrap"><table><thead><tr><th>Cerrada</th><th>Tarea</th><th>Puesto</th><th>Urgencia</th><th class="num">Tiempo real</th><th>Cierre</th></tr></thead><tbody>
        ${ultimo.map(t => `<tr class="click" data-ver="${t.id}"><td class="mono">${fmtFH(t.resuelto_at)}</td><td><b>${esc(t.titulo)}</b><span class="sub-celda">${esc(t.categoria)}</span></td>
          <td>${esc(nombrePuesto(t.puesto_id))}</td><td>${badgeUrg(t.urgencia)}</td><td class="num"><b>${fmtHoras(t.horas)}</b></td><td class="h-cierre">${esc(t.cierre_nota || '')}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="vacio">No hay tareas cerradas en ese período.</div>'}`;
    $$('[data-ver]', $('#h-res')).forEach(tr => tr.onclick = () => modalTarea(ultimo.find(t => t.id === Number(tr.dataset.ver))));
  };
  $('#f-h').onsubmit = (e) => { e.preventDefault(); buscar().catch(err => toast(err.message, true)); };
  $('#b-hcsv').onclick = () => exportarCSV(ultimo, 'historial');
  await buscar();
}

// ---------------------------------------------------------------------------
//  EQUIPO Y PUESTOS (Líder)
// ---------------------------------------------------------------------------
async function vistaEquipo(el) {
  const r = await api('/api/puestos');
  let lista = r.puestos.map(p => ({ ...p }));
  const ro = S.ro;
  el.innerHTML = `
    <div class="encabezado"><div><h1>Equipo y puestos</h1><p>Cada puesto tiene su responsable (el mail con el que entra a Herramientas) y un máximo de pendientes simultáneos. El semáforo del tablero se calcula con ese máximo.</p></div></div>
    <section class="panel"><div class="panel-titulo"><h2>Puestos</h2>${ro ? '' : `<button class="btn btn-chico" id="b-mas-p">${ICO.mas}Agregar puesto</button>`}</div>
      <div id="lista-p" class="lista-p"></div>
      ${ro ? '' : `<div class="panel-pad acciones" style="justify-content:flex-end;border-top:1px solid var(--line)"><button class="btn btn-acento" id="b-guardar-p">${ICO.check}Guardar cambios</button></div>`}
    </section>
    <p class="ayuda" style="margin:10px 4px 22px">Para que alguien vea su puesto, además tiene que tener acceso a <b>Calidad</b> en "Administrar usuarios" del portal (rol <b>Equipo</b>; la Líder, rol <b>Admin</b>). Si dos personas comparten puesto, separá los mails con coma.</p>
    ${ro ? '' : `<section class="panel"><div class="panel-titulo"><h2>Datos</h2></div><div class="panel-pad datos-acc">
      <div><b>Cerrar el día</b><p class="muted small">Saca del tablero las tareas resueltas (siguen en el Historial). Las resueltas hace más de una semana salen solas.</p><button class="btn" id="b-archivar">${ICO.archive}Archivar resueltas</button></div>
      <div><b>Traer el tablero anterior</b><p class="muted small">En el tablero viejo (Google Sites), "Rutina &amp; Datos" → "Respaldo completo JSON". Subí acá ese archivo: se cargan sus tareas.</p><label class="btn">${ICO.upload}Subir respaldo JSON<input type="file" accept=".json,application/json" id="f-json" hidden></label></div>
    </div></section>`}`;

  const pintar = () => {
    $('#lista-p').innerHTML = lista.map((p, i) => `
      <div class="fila-p ${p.activo === false ? 'inactivo' : ''}" data-i="${i}">
        <div class="fp-av">${avatarPuesto(p)}<input type="color" value="${esc(p.color || '#3a3933')}" data-f="color" ${ro ? 'disabled' : ''} title="Color" aria-label="Color"></div>
        <div class="campo"><label>Nombre del puesto</label><input data-f="nombre" value="${esc(p.nombre)}" maxlength="80" ${ro ? 'disabled' : ''}></div>
        <div class="campo"><label>Nombre corto</label><input data-f="corto" value="${esc(p.corto)}" maxlength="30" ${ro ? 'disabled' : ''}></div>
        <div class="campo"><label>Área / turno</label><input data-f="area" value="${esc(p.area || '')}" maxlength="80" ${ro ? 'disabled' : ''}></div>
        <div class="campo fp-mail"><label>Mail de la persona</label><input data-f="email" type="text" inputmode="email" value="${esc(p.email || '')}" placeholder="nombre@luccianos.com.ar" ${ro ? 'disabled' : ''}></div>
        <div class="campo fp-max"><label>Máx. activas</label><input data-f="max_activas" type="number" min="1" max="20" value="${p.max_activas}" ${ro ? 'disabled' : ''}></div>
        <div class="fp-hab"><label>Procesos que domina <span class="muted">(para sugerir derivaciones)</span></label><div class="chips">${CATEGORIAS.map(c => `<label class="chip-ck"><input type="checkbox" data-hab="${esc(c)}" ${(p.habilidades || []).includes(c) ? 'checked' : ''} ${ro ? 'disabled' : ''}>${esc(c)}</label>`).join('')}</div></div>
        <label class="check fp-act"><input type="checkbox" data-f="activo" ${p.activo !== false ? 'checked' : ''} ${ro ? 'disabled' : ''}>Activo</label>
      </div>`).join('');
    $$('.fila-p', $('#lista-p')).forEach(f => {
      const i = Number(f.dataset.i);
      $$('[data-f]', f).forEach(inp => inp.oninput = inp.onchange = () => {
        const k = inp.dataset.f;
        lista[i][k] = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (k === 'color' || k === 'corto') $('.av-p', f).outerHTML = avatarPuesto(lista[i]);
      });
      $$('[data-hab]', f).forEach(inp => inp.onchange = () => {
        const h = new Set(lista[i].habilidades || []);
        inp.checked ? h.add(inp.dataset.hab) : h.delete(inp.dataset.hab);
        lista[i].habilidades = [...h];
      });
    });
  };
  pintar();
  if (ro) return;
  $('#b-mas-p').onclick = () => { lista.push({ id: '', nombre: 'Nuevo puesto', corto: 'Nuevo', area: '', email: '', max_activas: 3, color: '#4f7a28', habilidades: [], activo: true }); pintar(); $$('.fila-p').pop()?.querySelector('[data-f="nombre"]')?.select(); };
  $('#b-guardar-p').onclick = (e) => conBoton(e.currentTarget, async () => {
    const r2 = await api('/api/puestos', { method: 'PUT', body: { puestos: lista } });
    lista = r2.puestos.map(p => ({ ...p }));
    pintar();
    await cargarDatos(true);
    toast('Puestos guardados');
  });
  $('#b-archivar').onclick = (e) => conBoton(e.currentTarget, async () => {
    if (!(await confirmar('Las tareas resueltas salen del tablero y quedan en el Historial.', { boton: 'Archivar' }))) return;
    const r2 = await api('/api/archivar', { method: 'POST' });
    await cargarDatos(true);
    toast(r2.archivadas ? `${r2.archivadas} tareas archivadas` : 'No había tareas resueltas para archivar');
  });
  $('#f-json').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const n = Array.isArray(data.tasks) ? data.tasks.length : 0;
      if (!n) throw new Error('El archivo no tiene tareas del tablero anterior.');
      if (!(await confirmar(`Se van a cargar ${n} tareas del tablero anterior. Si ya lo subiste antes, se duplican.`, { boton: 'Cargar' }))) return;
      const r2 = await api('/api/importar', { method: 'POST', body: { team: data.team || [], tasks: data.tasks } });
      await cargarDatos(true);
      toast(`Listo: ${r2.tareas} tareas cargadas${r2.puestos ? ` y ${r2.puestos} puestos nuevos` : ''}`);
    } catch (err) { toast(err.message.includes('JSON') ? 'Ese archivo no es un respaldo válido.' : err.message, true); }
  };
}

// ---------------------------------------------------------------------------
//  MODAL: tarea (nueva / editar / ver)
// ---------------------------------------------------------------------------
function modalTarea(t, def = {}) {
  if (!t && !puedeCargar()) return;
  const nueva = !t;
  const toca = nueva ? puedeCargar() : puedeTocar(t);
  const x = t || { titulo: '', categoria: CATEGORIAS[0], puesto_id: def.puesto_id || S.f.puesto || S.mios[0] || puestosElegibles()[0]?.id, urgencia: 'media', vence: hoy(), estado: 'pendiente', checklist: [], notas: '' };
  const dis = toca ? '' : 'disabled';
  const elegibles = puestosElegibles();
  const puestoCampo = esAdmin() || elegibles.length > 1
    ? `<select id="t-puesto" ${dis}>${optsPuestos(x.puesto_id, { conCarga: true })}${!elegibles.some(p => p.id === x.puesto_id) ? `<option value="${esc(x.puesto_id)}" selected>${esc(nombrePuesto(x.puesto_id))}</option>` : ''}</select><p class="ayuda" id="t-carga"></p>`
    : `<input value="${esc(nombrePuesto(x.puesto_id))}" disabled><input type="hidden" id="t-puesto" value="${esc(x.puesto_id)}">`;
  modal(`<h2>${nueva ? 'Nueva tarea de calidad' : toca ? 'Editar tarea' : 'Detalle de la tarea'}</h2>
    <form id="f-tarea">
      <div class="campo"><label for="t-tit">Tarea *</label><input id="t-tit" required maxlength="200" value="${esc(x.titulo)}" placeholder="Ej. Verificación de rótulos y alérgenos línea pistacho" ${dis}></div>
      <div class="fila">
        <div class="campo"><label for="t-cat">Proceso</label><select id="t-cat" ${dis}>${optsCategorias(x.categoria)}</select></div>
        <div class="campo"><label for="t-puesto">Responsable</label>${puestoCampo}</div>
      </div>
      <div class="fila">
        <div class="campo"><label for="t-urg">Urgencia</label><select id="t-urg" ${dis}>${optsUrg(x.urgencia)}</select></div>
        <div class="campo"><label for="t-vence">Vence</label><input type="date" id="t-vence" value="${esc(x.vence || hoy())}" ${dis}></div>
        <div class="campo"><label for="t-est">Estado</label><select id="t-est" ${dis}>${optsEstados(x.estado)}</select></div>
      </div>
      <div class="campo resuelta-c ${x.estado === 'resuelto' ? '' : 'hidden'}"><label for="t-horas">Tiempo real que llevó (horas)</label><input type="number" id="t-horas" step="0.25" min="0.25" max="200" value="${x.horas ?? ''}" placeholder="Ej. 1,5 = 1 h 30 min" ${dis}></div>
      <div class="campo"><label for="t-ck">Checklist (un punto por renglón)</label><textarea id="t-ck" rows="3" placeholder="Tomar muestra&#10;Cargar planilla&#10;Validar con la Líder" ${dis}>${esc((x.checklist || []).map(c => c.texto).join('\n'))}</textarea></div>
      <div class="campo"><label for="t-notas">Notas técnicas / observaciones</label><textarea id="t-notas" rows="2" placeholder="Lote, línea, normativa, bloqueos…" ${dis}>${esc(x.notas || '')}</textarea></div>
      ${x.cierre_nota ? `<div class="cierre-nota"><b>Comentario de cierre:</b> ${esc(x.cierre_nota)}</div>` : ''}
      ${nueva ? '' : `<p class="ayuda">Cargada ${fmtFH(x.creado_at)}${x.creado_por ? ' por ' + esc(x.creado_por) : ''}${x.resuelto_at ? ` · cerrada ${fmtFH(x.resuelto_at)}` : ''} · <button type="button" class="btn-link" id="t-hist">Ver movimientos</button></p><div id="t-hist-c"></div>`}
      <div class="acciones" style="justify-content:space-between;margin-top:16px">
        <span>${!nueva && toca && esAdmin() ? `<button type="button" class="btn btn-rojo" id="t-borrar">${ICO.trash}Borrar</button>` : ''}</span>
        <span class="acciones">${toca ? `<button type="button" class="btn" data-cerrar>Cancelar</button><button class="btn btn-acento" type="submit">${nueva ? 'Guardar y asignar' : 'Guardar'}</button>` : '<button type="button" class="btn" data-cerrar>Cerrar</button>'}</span>
      </div>
    </form>`, {
    ancho: false,
    alMontar: (el, cerrar) => {
      $$('[data-cerrar]', el).forEach(b => b.onclick = cerrar);
      const est = $('#t-est', el);
      est.onchange = () => $('.resuelta-c', el).classList.toggle('hidden', est.value !== 'resuelto');
      const pSel = $('select#t-puesto', el), hint = $('#t-carga', el);
      const pintarCarga = () => {
        if (!hint || !pSel || !esAdmin()) return;
        const st = stats(pSel.value);
        hint.className = 'ayuda ' + (st.saturado ? 'txt-neg' : st.limite ? 'txt-warn' : 'txt-pos');
        hint.textContent = st.saturado ? `Puesto saturado (${st.activas}/${st.max} activas)` : st.limite ? `Puesto al límite (${st.activas}/${st.max} activas)` : `Con lugar (${st.activas}/${st.max} activas)`;
      };
      if (pSel) { pSel.onchange = pintarCarga; pintarCarga(); }
      if ($('#t-hist', el)) $('#t-hist', el).onclick = async (e) => {
        e.currentTarget.remove();
        const c = $('#t-hist-c', el);
        c.innerHTML = '<span class="cargando"></span>';
        try {
          const h = (await api(`/api/tareas/${x.id}/historial`)).historial || [];
          c.innerHTML = h.length ? `<ul class="movs">${h.map(m => `<li><span class="mono">${fmtFH(m.ts)}</span> <b>${esc(m.quien || '')}</b> ${esc(m.accion)}${m.detalle ? ': ' + esc(m.detalle) : ''}</li>`).join('')}</ul>` : '<p class="muted small">Sin movimientos registrados.</p>';
        } catch (err) { c.innerHTML = `<p class="txt-neg small">${esc(err.message)}</p>`; }
      };
      if ($('#t-borrar', el)) $('#t-borrar', el).onclick = async () => {
        if (!(await confirmar(`Se borra "${x.titulo}" del tablero y del historial.`, { boton: 'Borrar', peligro: true }))) return modalTarea(x);
        try {
          await api('/api/tareas/' + x.id, { method: 'DELETE' });
          S.data.tareas = S.data.tareas.filter(y => y.id !== x.id); repintar(); toast('Tarea borrada');
        } catch (err) { toast(err.message, true); }
      };
      if (!toca) return;
      $('#f-tarea', el).onsubmit = (e) => {
        e.preventDefault();
        const datos = {
          titulo: $('#t-tit', el).value.trim(), categoria: $('#t-cat', el).value, puesto_id: $('#t-puesto', el).value,
          urgencia: $('#t-urg', el).value, vence: $('#t-vence', el).value, estado: est.value,
          checklist: $('#t-ck', el).value.split('\n').map(s => s.trim()).filter(Boolean),
          notas: $('#t-notas', el).value.trim(),
        };
        if (est.value === 'resuelto') {
          datos.horas = Number(String($('#t-horas', el).value).replace(',', '.'));
          if (!(datos.horas > 0)) { toast('Indicá cuánto tiempo real llevó.', true); $('#t-horas', el).focus(); return; }
        }
        conBoton($('button[type=submit]', el), async () => {
          if (nueva) {
            const r = await api('/api/tareas', { method: 'POST', body: datos });
            r.tareas.forEach(aplicar); repintar(); cerrar();
            toast('Tarea cargada y priorizada');
          } else {
            await guardarTarea(x.id, datos); cerrar(); toast('Tarea actualizada');
          }
        });
      };
    },
  });
}

// ---------------------------------------------------------------------------
//  MODAL: cerrar tarea y registrar el tiempo real
// ---------------------------------------------------------------------------
function modalResolver(t) {
  if (!t || !puedeTocar(t)) return;
  const sugerido = t.iniciado_at ? horasCorriendo(t) : 0.5;
  modal(`<h2>Cerrar tarea y registrar tiempo</h2>
    <div class="cierre-cab"><small>Pendiente a cerrar</small><b>${esc(t.titulo)}</b>
      <span>${t.iniciado_at ? `Desde que se empezó pasaron ${fmtHoras(horasCorriendo(t))}.` : 'No tenía el reloj corriendo: indicá el tiempo real que le dedicaste.'}</span></div>
    <form id="f-res">
      <div class="campo"><label for="r-h">Tiempo real que llevó (horas) *</label>
        <div class="horas-in"><input type="number" id="r-h" step="0.25" min="0.25" max="200" required value="${sugerido}" inputmode="decimal"><span>horas</span></div>
        <div class="presets">${[[0.25, '15 min'], [0.5, '30 min'], [1, '1 h'], [2, '2 h'], [4, '4 h']].map(([v, l]) => `<button type="button" data-h="${v}">${l}</button>`).join('')}</div></div>
      <div class="campo"><label for="r-n">Comentario de cierre / acción tomada (opcional)</label><textarea id="r-n" rows="2" placeholder="Ej. Lote liberado tras verificación, desvío cerrado sin reincidencia…"></textarea></div>
      <div class="acciones" style="justify-content:flex-end"><button type="button" class="btn" data-cerrar>Cancelar</button><button class="btn btn-acento" type="submit">${ICO.check}Confirmar cierre</button></div>
    </form>`, {
    foco: false,
    alMontar: (el, cerrar) => {
      $('[data-cerrar]', el).onclick = cerrar;
      $$('[data-h]', el).forEach(b => b.onclick = () => { $('#r-h', el).value = b.dataset.h; });
      $('#f-res', el).onsubmit = (e) => {
        e.preventDefault();
        const horas = Number(String($('#r-h', el).value).replace(',', '.'));
        if (!(horas > 0)) return toast('Indicá el tiempo real.', true);
        conBoton($('button[type=submit]', el), async () => {
          const r = await guardarTarea(t.id, { estado: 'resuelto', horas, cierre_nota: $('#r-n', el).value.trim() });
          if (S.data.resueltas_hoy) { S.data.resueltas_hoy.n++; S.data.resueltas_hoy.horas += horas; }
          cerrar(); repintar(); toast(`Cerrada en ${fmtHoras(r.horas)} reales`);
        });
      };
    },
  });
}

// ---------------------------------------------------------------------------
//  MODAL: carga rápida (texto libre o grilla)
// ---------------------------------------------------------------------------
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const sinTilde = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function proximoDia(nombre) {
  const objetivo = DIAS.indexOf(nombre);
  const hoyD = new Date(Date.now() - 3 * 3600e3).getUTCDay();
  let dif = (objetivo - hoyD + 7) % 7; if (dif === 0) dif = 7;
  return diaAR(dif);
}
// Palabras que eligen el puesto (las del tablero anterior + el nombre corto de cada puesto)
const CLAVES_PUESTO = [
  [/\b(insp2|inspectora\s*2|turno tarde|tt)\b/, 'insp2'], [/\b(insp1|inspectora\s*1|turno manana|tm)\b/, 'insp1'],
  [/\b(poes|lab|laboratorio|micro|hisopado)\b/, 'poes_lab'], [/\b(reg|regulatorios|rotulo|anmat|octogono|etiqueta)\b/, 'regulatorios'],
  [/\b(analista|kpi|indicador|instructivo)\b/, 'analista'], [/\b(lider|auditoria externa)\b/, 'lider'],
];
function leerLinea(linea) {
  const crudo = linea.trim(), l = sinTilde(crudo);
  let urgencia = 'media';
  if (/\b(critic[ao]|urgente|bloqueo|inmediat[ao])\b/.test(l)) urgencia = 'critica';
  else if (/\b(alta|prioritari[ao]|importante)\b/.test(l)) urgencia = 'alta';
  else if (/\b(baja|rutina|cuando pueda)\b/.test(l)) urgencia = 'baja';
  let puesto_id = '';
  const elegibles = puestosElegibles();
  for (const p of elegibles) if (p.corto && l.includes(sinTilde(p.corto))) { puesto_id = p.id; break; }
  if (!puesto_id) for (const [re, id] of CLAVES_PUESTO) if (re.test(l) && elegibles.some(p => p.id === id)) { puesto_id = id; break; }
  if (!puesto_id) puesto_id = S.hoyPuesto && elegibles.some(p => p.id === S.hoyPuesto) ? S.hoyPuesto : (S.mios[0] || elegibles[0]?.id || '');
  let categoria = 'Auditoría BPM';
  if (/\b(desvio|no conformidad|bloqueo|retenid)/.test(l)) categoria = 'No Conformidad / Desvíos';
  else if (/\b(lab|micro|hisopado|atp|listeria|placa|muestra)/.test(l)) categoria = 'Laboratorio / Microbiología';
  else if (/\b(poes|limpieza|cip|sanitiz|saneamiento)/.test(l)) categoria = 'Verificación POES';
  else if (/\b(rotulo|etiqueta|anmat|octogono|ficha tecnica|tabla nutricional|regulator)/.test(l)) categoria = 'Asuntos Regulatorios / Rótulos';
  else if (/\b(kpi|indicador|instructivo|informe|resumen|planilla|documento)/.test(l)) categoria = 'Documentación / KPIs';
  let vence = hoy();
  if (/\bpasado manana\b/.test(l)) vence = diaAR(2);
  else if (/\bmanana\b/.test(l) && !/\bturno manana\b/.test(l)) vence = diaAR(1);
  else { const d = l.match(/\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/); if (d) vence = proximoDia(d[1]); }
  let titulo = crudo
    .replace(/\b(insp1|insp2|poes|lab|regulatorios|reg|analista|l[ií]der|urgente|cr[ií]tic[ao]|alta|media|baja|hoy|pasado mañana|mañana|para el (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi, '')
    .replace(/\s{2,}/g, ' ').replace(/[\s,.;-]+$/, '').trim();
  if (!titulo) titulo = crudo;
  titulo = titulo.charAt(0).toUpperCase() + titulo.slice(1);
  return { titulo, categoria, puesto_id, urgencia, vence };
}

function modalCargaRapida() {
  if (!puedeCargar()) return;
  let borrador = [];
  const filaEditable = (x, i) => `<tr>
    <td><input data-k="titulo" data-i="${i}" value="${esc(x.titulo)}" maxlength="200" placeholder="Ej. Controlar temperatura cámara 3"></td>
    <td><select data-k="categoria" data-i="${i}">${optsCategorias(x.categoria)}</select></td>
    <td><select data-k="puesto_id" data-i="${i}">${optsPuestos(x.puesto_id)}</select></td>
    <td><select data-k="urgencia" data-i="${i}">${Object.entries(URG).map(([k, v]) => `<option value="${k}" ${k === x.urgencia ? 'selected' : ''}>${v.t}</option>`).join('')}</select></td>
    <td><input type="date" data-k="vence" data-i="${i}" value="${esc(x.vence)}"></td>
    <td><button type="button" class="ibtn chico" data-quitar="${i}" title="Quitar" aria-label="Quitar">${ICO.x}</button></td></tr>`;
  modal(`<h2>Carga rápida del día</h2>
    <p class="muted" style="margin:-6px 0 12px">Cargá pendientes al instante, sin estimar tiempos: el tiempo real se anota al cerrarlos.</p>
    <div class="tabs cr-tabs"><button class="activo" data-tab="texto">Texto libre / dictado</button><button data-tab="grilla">Fila por fila</button></div>
    <div data-panel="texto" class="cr-panel">
      <p class="ayuda">Una tarea por renglón (sirve pegar notas de WhatsApp o dictar). Se detecta sola la <b>urgencia</b> (crítica, urgente, alta, baja), la <b>fecha</b> (hoy, mañana, viernes…), el <b>proceso</b>${esAdmin() ? ' y el <b>responsable</b> (insp1, insp2, poes, lab, analista, reg, líder o el nombre corto del puesto)' : ''}. <button type="button" class="btn-link" id="cr-ej">Ver un ejemplo</button></p>
      <textarea id="cr-txt" rows="5" class="mono-suave" placeholder="Auditar línea de bombones y temple de chocolate hoy urgente insp1&#10;Validar ficha técnica pistachos para el viernes regulatorios&#10;Controlar ATP tanque pasteurizador mañana poes"></textarea>
      <div class="acciones" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn btn-negro" id="cr-leer">${ICO.search}Procesar y revisar</button></div>
    </div>
    <div data-panel="grilla" class="cr-panel hidden"><p class="ayuda">Completá las filas que necesites (con Tab pasás al campo siguiente). Las filas sin título no se cargan.</p></div>
    <div id="cr-prev" class="hidden">
      <div class="tabla-wrap cr-tabla"><table><thead><tr><th>Tarea</th><th>Proceso</th><th>Responsable</th><th>Urgencia</th><th>Vence</th><th></th></tr></thead><tbody id="cr-body"></tbody></table></div>
      <div class="acciones" style="justify-content:space-between;margin-top:12px"><button type="button" class="btn btn-chico" id="cr-mas">${ICO.mas}Otra fila</button>
        <span class="acciones"><button type="button" class="btn" data-cerrar>Cancelar</button><button type="button" class="btn btn-acento" id="cr-ok">${ICO.check}Cargar al tablero</button></span></div>
    </div>`, {
    ancho: true,
    alMontar: (el, cerrar) => {
      const pintarPrev = () => {
        $('#cr-prev', el).classList.toggle('hidden', !borrador.length);
        $('#cr-body', el).innerHTML = borrador.map(filaEditable).join('');
        $$('[data-k]', el).forEach(inp => inp.oninput = inp.onchange = () => { borrador[Number(inp.dataset.i)][inp.dataset.k] = inp.value; });
        $$('[data-quitar]', el).forEach(b => b.onclick = () => { borrador.splice(Number(b.dataset.quitar), 1); pintarPrev(); });
        const ok = $('#cr-ok', el); if (ok) ok.innerHTML = `${ICO.check}Cargar ${borrador.filter(x => x.titulo.trim()).length || ''} al tablero`;
      };
      const filaVacia = () => ({ titulo: '', categoria: CATEGORIAS[0], puesto_id: S.hoyPuesto && puestosElegibles().some(p => p.id === S.hoyPuesto) ? S.hoyPuesto : (S.mios[0] || puestosElegibles()[0]?.id), urgencia: 'media', vence: hoy() });
      $$('[data-tab]', el).forEach(b => b.onclick = () => {
        $$('[data-tab]', el).forEach(x => x.classList.toggle('activo', x === b));
        $$('[data-panel]', el).forEach(p => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
        if (b.dataset.tab === 'grilla' && !borrador.length) { borrador = [filaVacia(), filaVacia(), filaVacia(), filaVacia()]; pintarPrev(); }
      });
      $('#cr-ej', el).onclick = () => {
        $('#cr-txt', el).value = 'Auditar temple de chocolate y alérgenos en línea bombones hoy urgente insp1\nVerificar peso neto y sellado en línea paletas hoy alta insp2\nHisopado ATP en tanque pasteurizador mañana crítica poes\nRevisar tabla nutricional y octógonos nuevo sabor dulce de leche viernes regulatorios';
      };
      $('#cr-leer', el).onclick = () => {
        const lineas = $('#cr-txt', el).value.split('\n').map(s => s.trim()).filter(Boolean);
        if (!lineas.length) return toast('Escribí al menos un renglón', true);
        borrador = [...borrador.filter(x => x.titulo.trim()), ...lineas.map(leerLinea)];
        pintarPrev();
        toast(`${lineas.length} ${lineas.length === 1 ? 'tarea detectada' : 'tareas detectadas'}: revisalas y confirmá`);
      };
      $('#cr-mas', el).onclick = () => { borrador.push(filaVacia()); pintarPrev(); $$('[data-k="titulo"]', el).pop()?.focus(); };
      $('[data-cerrar]', el).onclick = cerrar;
      $('#cr-ok', el).onclick = (e) => {
        const tareas = borrador.filter(x => x.titulo.trim());
        if (!tareas.length) return toast('Completá al menos el título de una fila', true);
        conBoton(e.currentTarget, async () => {
          const r = await api('/api/tareas', { method: 'POST', body: { tareas } });
          r.tareas.forEach(aplicar); repintar(); cerrar();
          toast(`${r.tareas.length} pendientes cargados y ordenados por prioridad`);
        });
      };
    },
  });
}

// ---------------------------------------------------------------------------
//  MODAL: rebalanceo (sugerencias de derivación para los puestos saturados)
// ---------------------------------------------------------------------------
function modalRebalanceo() {
  if (!esAdmin() || S.ro) return;
  const pintar = (el) => {
    const ps = S.data.puestos || [];
    const saturados = ps.filter(p => stats(p.id).saturado);
    const libres = ps.filter(p => { const s = stats(p.id); return !s.saturado && !s.limite; });
    el.innerHTML = `<h2>Cuellos de botella y rebalanceo</h2>
      <p class="muted" style="margin:-6px 0 14px">Se mira la cantidad de pendientes activos de cada puesto contra su máximo, las urgencias críticas y qué procesos domina cada uno.</p>
      ${!saturados.length ? `<div class="ok-caja">${ICO.check}<div><b>No hay puestos saturados.</b><br><span class="muted">Todos trabajan dentro de su máximo de pendientes simultáneos.</span></div></div>` :
      saturados.map(p => {
        const st = stats(p.id);
        const movibles = porPrioridad(S.data.tareas.filter(t => t.puesto_id === p.id && t.estado === 'pendiente')).slice(0, 3);
        return `<div class="reb">
          <div class="reb-cab">${avatarPuesto(p)}<div><b>${esc(p.nombre)}</b><span class="txt-neg small">${st.activas} activas (máximo ${st.max}) · ${st.criticas} críticas</span></div></div>
          ${movibles.length ? movibles.map(t => {
            const cand = libres.find(c => (c.habilidades || []).includes(t.categoria)) || libres[0];
            return `<div class="reb-t"><div><b>${esc(t.titulo)}</b><small>${cand ? `Sugerencia: derivar a <b>${esc(cand.corto)}</b> (${stats(cand.id).activas}/${cand.max_activas} activas)` : 'Todo el equipo está al límite'}</small></div>
              ${cand ? `<button class="btn btn-chico btn-negro" data-mover="${t.id}" data-a="${esc(cand.id)}">Derivar</button>` : ''}</div>`;
          }).join('') : '<p class="muted small">Todas sus tareas ya están en curso: conviene asignar los nuevos ingresos del día a otro puesto.</p>'}
        </div>`;
      }).join('')}
      <div class="acciones" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-cerrar>Cerrar</button></div>`;
    $$('[data-mover]', el).forEach(b => b.onclick = () => conBoton(b, async () => {
      const p = puesto(b.dataset.a);
      await guardarTarea(b.dataset.mover, { puesto_id: b.dataset.a }, { msg: `Derivada a ${p ? p.corto : 'otro puesto'}` });
      pintar(el);
    }));
  };
  modal('<div></div>', { ancho: true, foco: false, alMontar: (el, cerrar) => { pintar(el); el.addEventListener('click', (e) => { if (e.target.closest('[data-cerrar]')) cerrar(); }); } });
}

// ---------------------------------------------------------------------------
//  Exportar (CSV que abre directo en Excel)
// ---------------------------------------------------------------------------
function exportarCSV(lista, nombre) {
  if (!lista.length) return toast('No hay tareas para bajar', true);
  const c = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const filas = [['N°', 'Tarea', 'Proceso', 'Puesto', 'Urgencia', 'Estado', 'Vence', 'Cargada', 'Cerrada', 'Horas reales', 'Checklist', 'Notas', 'Comentario de cierre'].map(c).join(';')];
  lista.forEach(t => {
    const ck = t.checklist || [];
    filas.push([t.id, t.titulo, t.categoria, nombrePuesto(t.puesto_id), URG[t.urgencia]?.t || t.urgencia, nombreEstado(t.estado), fmtLarga(t.vence),
      fmtFH(t.creado_at), t.resuelto_at ? fmtFH(t.resuelto_at) : '', t.horas != null ? String(t.horas).replace('.', ',') : '',
      ck.length ? `${ck.filter(x => x.hecho).length}/${ck.length}` : '', t.notas || '', t.cierre_nota || ''].map(c).join(';'));
  });
  const blob = new Blob(['\uFEFF' + filas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `calidad_${nombre}_${hoy()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Archivo descargado');
}

// ---------------------------------------------------------------------------
//  Service worker (app instalable)
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => null));

/* Marco común de Herramientas: botón negro "‹ Herramientas" arriba de la barra lateral y la ruta
   "Herramientas / Calidad / …" en la barra de arriba. No aparece para quien usa una sola app (operativos). */
(function marcoHerramientas() {
  try { if (localStorage.getItem('herr_portal') === '0') return; } catch (e) { /* sin storage */ }
  document.head.insertAdjacentHTML('beforeend', `<style id="herr-marco">
    .herr-volver { display: flex !important; align-items: center; gap: 9px; margin: 0 0 14px; padding: 10px 12px !important; border-radius: 12px !important; background: #15140f !important; color: #fff !important; text-decoration: none !important; font: 600 14px/1.1 'Instrument Sans', system-ui, sans-serif !important; box-shadow: none !important; }
    .herr-volver:hover { background: #2c2a22 !important; }
    .herr-volver svg { width: 16px !important; height: 16px !important; flex: none; color: #fff !important; }
    .herr-volver b { flex: 1; font-weight: 600; }
    .herr-ruta { display: inline-flex; align-items: center; gap: 8px; font-weight: 500; }
    .herr-ruta a { color: inherit; opacity: .6; text-decoration: none; }
    .herr-ruta a:hover { opacity: 1; text-decoration: underline; }
    .herr-ruta i { font-style: normal; opacity: .45; }
  </style>`);
  const FLECHA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  const GRILLA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  const poner = () => {
    document.querySelectorAll('aside.side').forEach(s => {
      if (s.querySelector('.herr-volver')) return;
      const br = s.querySelector(':scope > .brand');
      (br || s).insertAdjacentHTML(br ? 'afterend' : 'afterbegin', `<a class="herr-volver" href="https://herramientas.luccianos.com.ar" title="Volver a Herramientas">${FLECHA}<b>Herramientas</b>${GRILLA}</a>`);
    });
    document.querySelectorAll('header.top .crumbs').forEach(c => {
      if (!c.querySelector('.herr-ruta')) c.insertAdjacentHTML('afterbegin', `<span class="herr-ruta"><a href="https://herramientas.luccianos.com.ar">Herramientas</a><i>/</i><span>Calidad</span><i>/</i></span> `);
    });
  };
  new MutationObserver(poner).observe(document.documentElement, { childList: true, subtree: true });
  poner();
})();
