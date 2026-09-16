import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from './config.js';

const COLORS = {
  available: '#64748b',
  in_progress: '#f59e0b',
  done: '#10b981',
  hover: '#2563eb',
  selected: '#1d4ed8'
};

const LABELS = {
  available: 'Volná',
  in_progress: 'Roznáší se',
  done: 'Rozneseno'
};

const els = Object.fromEntries([
  'authScreen','setupCard','loginForm','usernameInput','passwordInput','loginBtn','loginError','app',
  'userName','userRole','userAvatar','changePasswordBtn','logoutBtn','topProgressText','topProgressBar','bigProgressText','bigProgressBar',
  'statAvailable','statInProgress','statDone','selectedStreetPanel','selectedStreetName','streetEmpty','streetDetail','streetStatusBadge',
  'detailStatus','detailOwner','detailUpdated','streetActions','refreshBtn','streetSearch','streetList','filterBar','myInProgressCount','myDoneCount','myTotalCount','myStreetList',
  'adminTabBtn','adminResetDistributionBtn','adminLogRefreshBtn','adminLogSearch','adminLogFilter','adminLogList','adminInProgress','adminDone','adminAvailable','adminTodayDone','adminTotalStreets','adminCompletionPct','adminProgressText','adminProgressBar','adminProgressCaption','adminTeamCount','adminReportGeneratedAt','adminExportPdfBtn','adminUserStats','adminActiveStreetList','adminDailyDate','adminDailyTodayBtn','adminDailyRefreshBtn','adminDailyTotal','adminDailyPeople','adminDailyReportCaption','adminDailyReportList','adminList','adminCreateUserForm','adminNewUsername',
  'adminNewDisplayName','adminNewPassword','adminNewRole','adminUserMessage','adminUserList','mapLoading','fitMapBtn','locateBtn',
  'sidebar','mobileMenuBtn','toastHost','mapHoverLabel','userEditDialog','userEditForm','editUserId','editUsername','editDisplayName','changePasswordDialog','changePasswordForm','currentPasswordField','newPasswordField','newPasswordConfirmField','changePasswordMessage'
].map(id => [id, document.getElementById(id)]));

let supabase = null;
let currentUser = null;
let currentProfile = null;
let map = null;
let cityBounds = null; // [[west,south],[east,north]]
let streetGroups = new Map();     // street name -> { name, lines: [], bounds }
let streetGeoJson = { type: 'FeatureCollection', features: [] };
let hoveredStreet = null;
let mapResizeObserver = null;
let mapReadyResolve = null;
let mapReady = new Promise(resolve => { mapReadyResolve = resolve; });
let statuses = new Map();         // street name -> database row
let profiles = new Map();         // user id -> profile
let selectedStreet = null;
let activeFilter = 'all';
let sessionToken = localStorage.getItem('letaky_upice_session') || '';
let pollTimer = null;
let adminUsers = [];
let adminLog = [];
let adminTodayReport = [];
let adminDailyReport = [];
let editingUser = null;

function isConfigured() {
  return CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY &&
    !CONFIG.SUPABASE_URL.includes('YOUR-PROJECT') &&
    !CONFIG.SUPABASE_ANON_KEY.includes('YOUR_');
}

function toast(title, message = '', type = '') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ''}`;
  els.toastHost.appendChild(item);
  setTimeout(() => item.remove(), 3800);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function initials(name) {
  const parts = String(name || 'U').trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map(p => p[0]).join('') || 'U').toUpperCase();
}

function normalizeStreetName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function statusFor(name) {
  return statuses.get(name)?.status || 'available';
}

function ownerFor(name) {
  const row = statuses.get(name);
  if (!row?.claimed_by) return null;
  return profiles.get(row.claimed_by) || null;
}

function isMine(name) {
  return statuses.get(name)?.claimed_by === currentUser?.id;
}

function isAdmin() {
  return currentProfile?.role === 'admin';
}

function pragueDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function formatReportDate(dateString) {
  if (!dateString) return '';
  const [y,m,d] = dateString.split('-').map(Number);
  return new Intl.DateTimeFormat('cs-CZ', { day:'2-digit', month:'2-digit', year:'numeric' })
    .format(new Date(Date.UTC(y, m-1, d, 12, 0, 0)));
}

function setActiveTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`${tab}Tab`)?.classList.add('active');
  els.app.classList.toggle('admin-mode', tab === 'admin' && isAdmin());
  if (tab === 'admin' && isAdmin()) {
    Promise.all([loadAdminLog(), loadAdminDailyReports()]).then(() => { renderAdminLog(); renderAdminDailyReport(); });
  }
  if (tab !== 'admin' && map) setTimeout(() => map.resize(), 80);
  if (window.innerWidth <= 900 && tab !== 'admin') els.sidebar.classList.remove('open');
}

function setAuthView(loggedIn) {
  els.authScreen.classList.toggle('hidden', loggedIn);
  els.app.classList.toggle('hidden', !loggedIn);
  if (loggedIn) setTimeout(() => map?.resize(), 50);
}

function setLoginBusy(busy) {
  els.loginBtn.disabled = busy;
  els.loginBtn.textContent = busy ? 'Přihlašuji…' : 'Přihlásit se';
}

function parseRpcError(error) {
  const msg = String(error?.message || '');
  if (msg.includes('INVALID_LOGIN')) return 'Neplatné uživatelské jméno nebo heslo.';
  if (msg.includes('SESSION_EXPIRED')) return 'Přihlášení vypršelo. Přihlaste se znovu.';
  if (msg.includes('USERNAME_EXISTS')) return 'Toto uživatelské jméno už existuje.';
  if (msg.includes('INVALID_USERNAME')) return 'Uživatelské jméno může mít 3–32 znaků: a–z, 0–9, tečka, podtržítko nebo pomlčka.';
  if (msg.includes('PASSWORD_TOO_SHORT')) return 'Heslo musí mít alespoň 6 znaků.';
  if (msg.includes('CURRENT_PASSWORD_INVALID')) return 'Současné heslo není správné.';
  if (msg.includes('STREET_ALREADY_CLAIMED')) return 'Ulici už mezitím převzal jiný uživatel.';
  if (msg.includes('CANNOT_DISABLE_SELF')) return 'Vlastní administrátorský účet nelze deaktivovat ani převést na uživatele.';
  if (msg.includes('CANNOT_DELETE_SELF')) return 'Vlastní administrátorský účet nelze smazat.';
  if (msg.includes('FORBIDDEN')) return 'K této akci nemáte oprávnění.';
  return error?.message || 'Operace se nezdařila.';
}

async function rpc(name, params = {}, needsSession = true) {
  const payload = needsSession ? { p_session: sessionToken, ...params } : params;
  const { data, error } = await supabase.rpc(name, payload);
  if (error) {
    if (needsSession && String(error.message || '').includes('SESSION_EXPIRED')) {
      await forceLogout('Přihlášení vypršelo. Přihlaste se znovu.');
    }
    throw error;
  }
  return data;
}

async function initSupabase() {
  if (!isConfigured()) {
    els.loginForm.classList.add('hidden');
    els.setupCard.classList.remove('hidden');
    return;
  }

  supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  if (sessionToken) {
    try {
      const data = await rpc('app_me');
      const me = data?.[0];
      if (me) await enterApp(me);
      else await forceLogout();
    } catch {
      await forceLogout();
    }
  }
}

els.loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.classList.add('hidden');
  setLoginBusy(true);
  try {
    const data = await rpc('app_login', {
      p_username: els.usernameInput.value.trim(),
      p_password: els.passwordInput.value
    }, false);
    const row = data?.[0];
    if (!row?.session_token) throw new Error('INVALID_LOGIN');
    sessionToken = row.session_token;
    localStorage.setItem('letaky_upice_session', sessionToken);
    await enterApp(row);
  } catch (error) {
    els.loginError.textContent = parseRpcError(error);
    els.loginError.classList.remove('hidden');
  } finally {
    setLoginBusy(false);
  }
});

els.logoutBtn?.addEventListener('click', async () => {
  try { if (sessionToken) await rpc('app_logout'); } catch {}
  await forceLogout();
});

async function forceLogout(message = '') {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  sessionToken = '';
  localStorage.removeItem('letaky_upice_session');
  cleanupApp();
  setAuthView(false);
  if (message) toast('Odhlášeno', message, 'error');
}

async function enterApp(profileRow) {
  currentUser = { id: profileRow.user_id, username: profileRow.username };
  currentProfile = {
    id: profileRow.user_id,
    username: profileRow.username,
    display_name: profileRow.display_name,
    role: profileRow.role
  };
  setAuthView(true);
  updateUserHeader();
  initMap();
  if (isAdmin() && els.adminDailyDate && !els.adminDailyDate.value) els.adminDailyDate.value = pragueDateString();
  await Promise.all([loadProfiles(), loadStatuses(), loadStreets(), isAdmin() ? loadAdminUsers() : Promise.resolve(), isAdmin() ? loadAdminLog() : Promise.resolve(), isAdmin() ? loadAdminDailyReports() : Promise.resolve()]);
  setActiveTab('overview');
  renderAll();
  startPolling();
}

function cleanupApp() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  currentUser = null;
  currentProfile = null;
  statuses.clear();
  profiles.clear();
  adminUsers = [];
  adminLog = [];
  adminTodayReport = [];
  adminDailyReport = [];
  editingUser = null;
  selectedStreet = null;
  els.passwordInput.value = '';
}

async function loadProfiles() {
  try {
    const data = await rpc('app_list_profiles');
    profiles = new Map((data || []).map(p => [p.id, p]));
  } catch (error) {
    console.error(error);
  }
}

async function loadStatuses() {
  try {
    const data = await rpc('app_list_street_status');
    statuses = new Map((data || []).map(row => [row.street_name, row]));
  } catch (error) {
    console.error(error);
    if (sessionToken) toast('Nepodařilo se načíst stav ulic', parseRpcError(error), 'error');
  }
}

async function loadAdminUsers() {
  if (!isAdmin()) return;
  try {
    adminUsers = await rpc('app_admin_list_users') || [];
  } catch (error) {
    console.error(error);
  }
}

async function loadAdminLog() {
  if (!isAdmin()) return;
  try {
    adminLog = await rpc('app_admin_list_log', { p_limit: 500 }) || [];
  } catch (error) {
    console.error(error);
  }
}

async function loadAdminDailyReports(dateString = null) {
  if (!isAdmin()) return;
  const today = pragueDateString();
  const selected = dateString || els.adminDailyDate?.value || today;
  if (els.adminDailyDate && !els.adminDailyDate.value) els.adminDailyDate.value = selected;
  try {
    if (selected === today) {
      const rows = await rpc('app_admin_daily_report', { p_date: today }) || [];
      adminTodayReport = rows;
      adminDailyReport = rows;
    } else {
      const [todayRows, selectedRows] = await Promise.all([
        rpc('app_admin_daily_report', { p_date: today }),
        rpc('app_admin_daily_report', { p_date: selected })
      ]);
      adminTodayReport = todayRows || [];
      adminDailyReport = selectedRows || [];
    }
  } catch (error) {
    console.error(error);
    toast('Denní report se nepodařilo načíst', parseRpcError(error), 'error');
  }
}

function updateUserHeader() {
  const name = currentProfile?.display_name || currentProfile?.username || 'Uživatel';
  els.userName.textContent = name;
  els.userRole.textContent = isAdmin() ? 'Administrátor' : `@${currentProfile?.username || 'uživatel'}`;
  els.userAvatar.textContent = initials(name);
  els.adminTabBtn.classList.toggle('hidden', !isAdmin());
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!sessionToken) return;
    await reloadSharedData(false);
    if (isAdmin()) {
      await Promise.all([loadAdminUsers(), loadAdminDailyReports()]);
      renderAdminUsers();
      renderAdminDailyReport();
    }
  }, 5000);
}

function initMap() {
  if (map) return;

  if (!window.maplibregl) {
    toast('Mapa se nepodařila spustit', 'Knihovna MapLibre není dostupná. Zkontrolujte připojení k internetu.', 'error');
    return;
  }

  map = new maplibregl.Map({
    container: 'map',
    center: [CONFIG.CITY_CENTER[1], CONFIG.CITY_CENTER[0]],
    zoom: CONFIG.DEFAULT_ZOOM,
    minZoom: 11,
    maxZoom: 19,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: [
            'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
          ],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors'
        }
      },
      layers: [
        { id: 'osm-base', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 19 }
      ]
    }
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');

  map.on('load', () => {
    ensureStreetLayers();
    if (mapReadyResolve) mapReadyResolve();
  });

  map.on('error', (event) => {
    console.warn('MapLibre:', event?.error || event);
  });

  map.on('mousemove', 'street-hit', (event) => {
    const feature = event.features?.[0];
    const name = feature?.properties?.name;
    if (!name) return;
    map.getCanvas().style.cursor = 'pointer';
    setHoveredStreet(name);
    if (els.mapHoverLabel) {
      const status = statusFor(name);
      const owner = ownerFor(name)?.display_name;
      els.mapHoverLabel.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(LABELS[status])}${owner ? ` · ${escapeHtml(owner)}` : ''}</span>`;
      els.mapHoverLabel.classList.remove('hidden');
    }
  });

  map.on('mouseleave', 'street-hit', () => {
    map.getCanvas().style.cursor = '';
    clearHoveredStreet(hoveredStreet);
    els.mapHoverLabel?.classList.add('hidden');
  });

  map.on('click', 'street-hit', (event) => {
    const feature = event.features?.[0];
    const name = feature?.properties?.name;
    if (!name) return;
    selectStreet(name, false);
  });

  map.on('click', (event) => {
    const features = map.queryRenderedFeatures(event.point, { layers: ['street-hit'] });
    if (!features.length && window.innerWidth <= 900) els.sidebar.classList.remove('open');
  });

  const mapElement = document.getElementById('map');
  if (window.ResizeObserver && mapElement) {
    mapResizeObserver = new ResizeObserver(() => requestAnimationFrame(() => map?.resize()));
    mapResizeObserver.observe(mapElement);
  }
  window.addEventListener('resize', () => map?.resize(), { passive: true });
  setTimeout(() => map?.resize(), 100);
  setTimeout(() => map?.resize(), 500);
}

function ensureStreetLayers() {
  if (!map || !map.isStyleLoaded()) return;

  if (!map.getSource('streets')) {
    map.addSource('streets', { type: 'geojson', data: streetGeoJson });
  }

  if (!map.getLayer('street-casing')) {
    map.addLayer({
      id: 'street-casing',
      type: 'line',
      source: 'streets',
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5.5, 15, 8, 18, 12],
        'line-opacity': 0.96
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }

  if (!map.getLayer('street-status')) {
    map.addLayer({
      id: 'street-status',
      type: 'line',
      source: 'streets',
      paint: {
        'line-color': [
          'match', ['get', 'status'],
          'in_progress', COLORS.in_progress,
          'done', COLORS.done,
          COLORS.available
        ],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.8, 15, 4.5, 18, 7],
        'line-opacity': 0.92
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }

  if (!map.getLayer('street-hover')) {
    map.addLayer({
      id: 'street-hover',
      type: 'line',
      source: 'streets',
      filter: ['==', ['get', 'name'], '__none__'],
      paint: {
        'line-color': COLORS.hover,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 15, 9, 18, 13],
        'line-opacity': 1
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }

  if (!map.getLayer('street-selected')) {
    map.addLayer({
      id: 'street-selected',
      type: 'line',
      source: 'streets',
      filter: ['==', ['get', 'name'], '__none__'],
      paint: {
        'line-color': COLORS.selected,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 7, 15, 10, 18, 14],
        'line-opacity': 1
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }

  if (!map.getLayer('street-hit')) {
    map.addLayer({
      id: 'street-hit',
      type: 'line',
      source: 'streets',
      paint: {
        'line-color': '#000000',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 20, 15, 26, 19, 34],
        'line-opacity': 0.01
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' }
    });
  }
}

function buildOverpassQuery(useArea = true) {
  const roadTypes = '^(primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|road)$';
  if (useArea) {
    return `[out:json][timeout:30];\narea["name"="${CONFIG.CITY_NAME}"]["boundary"="administrative"]["admin_level"="8"]->.city;\nway(area.city)["highway"~"${roadTypes}"];\nout tags geom;`;
  }
  const [s,w,n,e] = CONFIG.FALLBACK_BBOX;
  return `[out:json][timeout:30];\nway(${s},${w},${n},${e})["highway"~"${roadTypes}"];\nout tags geom;`;
}

async function overpass(query) {
  const body = new URLSearchParams({ data: query });
  const response = await fetch(CONFIG.OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body
  });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
  return response.json();
}

async function loadStreets() {
  els.mapLoading.classList.remove('hidden');
  try {
    let data = await overpass(buildOverpassQuery(true));
    if (!data?.elements?.length) data = await overpass(buildOverpassQuery(false));
    await drawStreets(data.elements || []);
  } catch (error) {
    console.error(error);
    toast('Mapa ulic se nepodařila načíst', 'Zkuste tlačítko obnovit.', 'error');
  } finally {
    els.mapLoading.classList.add('hidden');
    setTimeout(() => map?.resize(), 50);
  }
}

async function drawStreets(elements) {
  await mapReady;
  ensureStreetLayers();

  streetGroups.clear();
  hoveredStreet = null;

  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const sorted = [...elements].sort((a, b) => (a.tags?.name || '').localeCompare(b.tags?.name || '', 'cs'));

  for (const way of sorted) {
    if (!Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    const name = normalizeStreetName(way.tags?.name);
    if (!name) continue;

    const coords = way.geometry.map(p => [p.lon, p.lat]);
    for (const [lng, lat] of coords) {
      west = Math.min(west, lng); south = Math.min(south, lat);
      east = Math.max(east, lng); north = Math.max(north, lat);
    }

    if (!streetGroups.has(name)) {
      streetGroups.set(name, { name, lines: [], bounds: [Infinity, Infinity, -Infinity, -Infinity] });
    }
    const group = streetGroups.get(name);
    group.lines.push(coords);
    for (const [lng, lat] of coords) {
      group.bounds[0] = Math.min(group.bounds[0], lng);
      group.bounds[1] = Math.min(group.bounds[1], lat);
      group.bounds[2] = Math.max(group.bounds[2], lng);
      group.bounds[3] = Math.max(group.bounds[3], lat);
    }
  }

  streetGeoJson = {
    type: 'FeatureCollection',
    features: [...streetGroups.values()].map(group => ({
      type: 'Feature',
      properties: { name: group.name, status: statusFor(group.name) },
      geometry: { type: 'MultiLineString', coordinates: group.lines }
    }))
  };

  const source = map.getSource('streets');
  source?.setData(streetGeoJson);

  if (Number.isFinite(west)) {
    cityBounds = [[west, south], [east, north]];
    map.fitBounds(cityBounds, { padding: 50, duration: 0, maxZoom: 15.8 });
  }
  refreshStreetStyles();
}

function setHoveredStreet(name) {
  if (!map || hoveredStreet === name) return;
  hoveredStreet = name || null;
  if (map.getLayer('street-hover')) {
    map.setFilter('street-hover', ['==', ['get', 'name'], hoveredStreet || '__none__']);
  }
}

function clearHoveredStreet(name) {
  if (!map) return;
  if (name && hoveredStreet !== name) return;
  hoveredStreet = null;
  if (map.getLayer('street-hover')) map.setFilter('street-hover', ['==', ['get', 'name'], '__none__']);
}

function refreshStreetStyles() {
  if (!map || !map.getSource('streets')) return;
  streetGeoJson = {
    ...streetGeoJson,
    features: streetGeoJson.features.map(feature => ({
      ...feature,
      properties: { ...feature.properties, status: statusFor(feature.properties.name) }
    }))
  };
  map.getSource('streets').setData(streetGeoJson);
  if (map.getLayer('street-hover')) map.setFilter('street-hover', ['==', ['get', 'name'], hoveredStreet || '__none__']);
  if (map.getLayer('street-selected')) map.setFilter('street-selected', ['==', ['get', 'name'], selectedStreet || '__none__']);
}

function selectStreet(name, zoom = false) {
  selectedStreet = name;
  if (map?.getLayer('street-selected')) {
    map.setFilter('street-selected', ['==', ['get', 'name'], name || '__none__']);
  }
  renderStreetDetail();
  if (els.selectedStreetPanel) els.selectedStreetPanel.scrollTop = 0;

  if (zoom) {
    const group = streetGroups.get(name);
    if (group && group.bounds.every(Number.isFinite)) {
      map.fitBounds([[group.bounds[0], group.bounds[1]], [group.bounds[2], group.bounds[3]]], {
        padding: 90,
        maxZoom: 17,
        duration: 450
      });
    }
  }

  if (window.innerWidth <= 900) els.sidebar.classList.add('open');
}

function renderStreetDetail() {
  if (!selectedStreet) {
    els.selectedStreetName.textContent = 'Vyberte ulici v mapě';
    els.streetEmpty.classList.remove('hidden');
    els.streetDetail.classList.add('hidden');
    return;
  }

  const row = statuses.get(selectedStreet);
  const status = row?.status || 'available';
  const owner = ownerFor(selectedStreet);
  const mine = isMine(selectedStreet);

  els.selectedStreetName.textContent = selectedStreet;
  els.streetEmpty.classList.add('hidden');
  els.streetDetail.classList.remove('hidden');
  els.streetStatusBadge.className = `status-badge ${status}`;
  els.streetStatusBadge.textContent = mine && status !== 'available' ? `${LABELS[status]} · moje` : LABELS[status];
  els.detailStatus.textContent = LABELS[status];
  els.detailOwner.textContent = owner?.display_name || '—';
  els.detailUpdated.textContent = row?.updated_at ? formatDate(row.updated_at) : '—';
  els.streetActions.innerHTML = '';

  if (status === 'available') {
    addAction('Začít roznášet', 'btn-primary', () => claimStreet(selectedStreet));
    return;
  }

  if (mine) {
    if (status === 'in_progress') addAction('Označit jako rozneseno', 'btn-success', () => setStreetStatus(selectedStreet, 'done'));
    if (status === 'done') addAction('Vrátit na „roznáším“', 'btn-warning', () => setStreetStatus(selectedStreet, 'in_progress'));
    addAction('Uvolnit ulici', 'btn-danger', () => releaseStreet(selectedStreet));
    return;
  }

  const locked = document.createElement('div');
  locked.className = 'muted';
  locked.textContent = `Tuto ulici má rezervovanou ${owner?.display_name || 'jiný uživatel'}.`;
  els.streetActions.appendChild(locked);

  if (isAdmin()) {
    if (status === 'in_progress') addAction('Admin: označit jako rozneseno', 'btn-success', () => setStreetStatus(selectedStreet, 'done'));
    if (status === 'done') addAction('Admin: vrátit na „roznáším“', 'btn-warning', () => setStreetStatus(selectedStreet, 'in_progress'));
    addAction('Admin: uvolnit ulici', 'btn-danger', () => releaseStreet(selectedStreet));
  }
}

function addAction(label, className, handler) {
  const btn = document.createElement('button');
  btn.className = `btn ${className}`;
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await handler(); } finally { btn.disabled = false; }
  });
  els.streetActions.appendChild(btn);
}

async function claimStreet(name) {
  try {
    await rpc('app_claim_street', { p_street_name: name });
    toast('Ulice rezervována', `${name} je nyní označena jako „roznáší se“.`, 'success');
    await reloadSharedData();
  } catch (error) {
    if (String(error?.message || '').includes('duplicate key')) {
      await reloadSharedData();
      toast('Ulice už není volná', 'Mezitím si ji rezervoval jiný uživatel.', 'error');
      return;
    }
    toast('Ulici se nepodařilo rezervovat', parseRpcError(error), 'error');
  }
}

async function setStreetStatus(name, status) {
  try {
    await rpc('app_set_street_status', { p_street_name: name, p_status: status });
    toast('Stav uložen', `${name}: ${LABELS[status]}.`, 'success');
    await reloadSharedData();
  } catch (error) {
    toast('Stav se nepodařilo změnit', parseRpcError(error), 'error');
  }
}

async function releaseStreet(name) {
  try {
    await rpc('app_release_street', { p_street_name: name });
    toast('Ulice uvolněna', `${name} je znovu dostupná ostatním.`, 'success');
    await reloadSharedData();
  } catch (error) {
    toast('Ulici se nepodařilo uvolnit', parseRpcError(error), 'error');
  }
}

async function reloadSharedData(show = true) {
  await Promise.all([loadProfiles(), loadStatuses(), isAdmin() ? loadAdminUsers() : Promise.resolve(), isAdmin() ? loadAdminDailyReports() : Promise.resolve()]);
  renderAll();
}

function renderAll() {
  refreshStreetStyles();
  renderStats();
  renderStreetDetail();
  renderStreetList();
  renderMyStreets();
  if (isAdmin()) {
    renderAdminList();
    renderAdminUsers();
    renderAdminPerformance();
    renderAdminActiveStreets();
    renderAdminDailyReport();
    renderAdminLog();
  }
}


function renderMyStreets() {
  if (!els.myStreetList) return;
  const mine = [...statuses.values()]
    .filter(row => row.claimed_by === currentUser?.id)
    .sort((a,b) => {
      const order = { in_progress: 0, done: 1 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.street_name.localeCompare(b.street_name, 'cs');
    });
  const inProgress = mine.filter(x => x.status === 'in_progress').length;
  const done = mine.filter(x => x.status === 'done').length;
  els.myInProgressCount.textContent = inProgress;
  els.myDoneCount.textContent = done;
  els.myTotalCount.textContent = mine.length;
  els.myStreetList.innerHTML = '';
  if (!mine.length) {
    els.myStreetList.innerHTML = '<div class="no-results mine-empty">Zatím nemáte žádnou přidělenou ulici. Vyberte si volnou ulici v mapě.</div>';
    return;
  }
  for (const item of mine) {
    const row = makeStreetRow(item.street_name, false);
    row.classList.add('clickable','my-street-row');
    row.addEventListener('click', () => {
      selectStreet(item.street_name, true);
      setActiveTab('overview');
    });
    els.myStreetList.appendChild(row);
  }
}

function getAllStreetNames() {
  return [...streetGroups.keys()].sort((a,b) => a.localeCompare(b, 'cs'));
}

function getStatusSummary() {
  const names = getAllStreetNames();
  const counts = { available: 0, in_progress: 0, done: 0 };
  names.forEach(name => counts[statusFor(name)]++);
  const total = names.length;
  const pct = total ? Math.round((counts.done / total) * 100) : 0;
  return { names, counts, total, pct };
}

function computeUserPerformance() {
  const sourceUsers = adminUsers.length ? adminUsers : [...profiles.values()].map(p => ({
    id: p.id, username: p.username, display_name: p.display_name, role: p.role, active: true
  }));

  const perf = new Map();
  for (const user of sourceUsers) {
    perf.set(user.id, { ...user, done: 0, in_progress: 0, total: 0 });
  }

  for (const row of statuses.values()) {
    if (!row?.claimed_by) continue;
    const base = perf.get(row.claimed_by) || {
      id: row.claimed_by,
      username: profiles.get(row.claimed_by)?.username || 'neznamy',
      display_name: profiles.get(row.claimed_by)?.display_name || 'Neznámý uživatel',
      role: profiles.get(row.claimed_by)?.role || 'user',
      active: true,
      done: 0, in_progress: 0, total: 0
    };
    base.total += 1;
    if (row.status === 'done') base.done += 1;
    if (row.status === 'in_progress') base.in_progress += 1;
    perf.set(row.claimed_by, base);
  }

  return [...perf.values()].sort((a, b) =>
    b.done - a.done || b.in_progress - a.in_progress || a.display_name.localeCompare(b.display_name, 'cs')
  );
}

function renderAdminPerformance() {
  if (!isAdmin() || !els.adminUserStats) return;
  const data = computeUserPerformance();
  els.adminUserStats.innerHTML = '';
  if (els.adminTeamCount) els.adminTeamCount.textContent = `${data.length} ${data.length === 1 ? 'uživatel' : data.length >= 2 && data.length <= 4 ? 'uživatelé' : 'uživatelů'}`;
  if (!data.length) {
    els.adminUserStats.innerHTML = '<div class="no-results">Zatím nejsou k dispozici žádní uživatelé.</div>';
    return;
  }
  const maxDone = Math.max(1, ...data.map(u => u.done));
  for (const user of data) {
    const row = document.createElement('div');
    const barWidth = Math.round((user.done / maxDone) * 100);
    row.className = 'perf-row perf-row-v5';
    row.innerHTML = `
      <div class="perf-main">
        <div class="perf-avatar">${escapeHtml(initials(user.display_name))}</div>
        <div class="perf-person">
          <strong>${escapeHtml(user.display_name)}</strong>
          <span>@${escapeHtml(user.username)} · ${user.role === 'admin' ? 'Administrátor' : 'Uživatel'}${user.active === false ? ' · Blokován' : ''}</span>
          <div class="perf-mini-track"><i style="width:${barWidth}%"></i></div>
        </div>
      </div>
      <div class="perf-stats perf-stats-v5">
        <div class="perf-stat-done"><span>Hotovo</span><strong>${user.done}</strong></div>
        <div><span>Rozpracováno</span><strong>${user.in_progress}</strong></div>
        <div><span>Celkem</span><strong>${user.total}</strong></div>
      </div>`;
    els.adminUserStats.appendChild(row);
  }
}

function renderAdminActiveStreets() {
  if (!isAdmin() || !els.adminActiveStreetList) return;
  const active = getAllStreetNames()
    .filter(name => statusFor(name) === 'in_progress')
    .map(name => ({ name, owner: ownerFor(name)?.display_name || 'Neznámý uživatel' }));
  els.adminActiveStreetList.innerHTML = '';
  if (!active.length) {
    els.adminActiveStreetList.innerHTML = '<div class="admin-empty-success"><span>✓</span><div><strong>Nic není rozpracované</strong><small>V tuto chvíli nikdo nemá aktivně převzatou ulici.</small></div></div>';
    return;
  }
  for (const item of active) {
    const row = document.createElement('div');
    row.className = 'active-street-row';
    row.innerHTML = `<span class="active-street-dot"></span><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.owner)}</span></div>`;
    els.adminActiveStreetList.appendChild(row);
  }
}

function renderStats() {
  const { counts, total, pct } = getStatusSummary();
  els.statAvailable.textContent = counts.available;
  els.statInProgress.textContent = counts.in_progress;
  els.statDone.textContent = counts.done;
  els.topProgressText.textContent = `${pct} %`;
  els.topProgressBar.style.width = `${pct}%`;
  els.bigProgressText.textContent = `${counts.done} / ${total}`;
  els.bigProgressBar.style.width = `${pct}%`;
  els.adminInProgress.textContent = counts.in_progress;
  els.adminDone.textContent = counts.done;
  els.adminAvailable.textContent = counts.available;
  if (els.adminTotalStreets) els.adminTotalStreets.textContent = total;
  if (els.adminCompletionPct) els.adminCompletionPct.textContent = `${pct} %`;
  if (els.adminProgressText) els.adminProgressText.textContent = `${counts.done} / ${total}`;
  if (els.adminProgressBar) els.adminProgressBar.style.width = `${pct}%`;
  if (els.adminProgressCaption) {
    els.adminProgressCaption.textContent = counts.done === 0
      ? 'Zatím nebyla dokončena žádná ulice.'
      : counts.done === total && total > 0
        ? 'Všechny ulice jsou hotové.'
        : `Hotovo je ${pct} % všech evidovaných ulic.`;
  }
  if (els.adminReportGeneratedAt) {
    els.adminReportGeneratedAt.textContent = new Intl.DateTimeFormat('cs-CZ', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date());
  }
}

function renderStreetList() {
  const search = (els.streetSearch.value || '').trim().toLocaleLowerCase('cs');
  const names = getAllStreetNames().filter(name => {
    const status = statusFor(name);
    const filterOk = activeFilter === 'all' || status === activeFilter;
    const searchOk = !search || name.toLocaleLowerCase('cs').includes(search);
    return filterOk && searchOk;
  });

  els.streetList.innerHTML = '';
  if (!names.length) {
    els.streetList.innerHTML = '<div class="no-results">Žádná ulice neodpovídá filtru.</div>';
    return;
  }

  for (const name of names) els.streetList.appendChild(makeStreetRow(name, true));
}

function makeStreetRow(name, clickable = true) {
  const status = statusFor(name);
  const owner = ownerFor(name)?.display_name;
  const row = document.createElement('div');
  row.className = `street-row ${clickable ? 'clickable' : ''}`;
  row.innerHTML = `
    <i class="street-state ${status}"></i>
    <div class="street-row-main">
      <strong>${escapeHtml(name)}</strong>
      <span>${status === 'available' ? 'Připraveno k rezervaci' : escapeHtml(owner || 'Obsazeno')}</span>
    </div>
    <span class="mini-status">${escapeHtml(LABELS[status])}</span>`;
  if (clickable) row.addEventListener('click', () => selectStreet(name, true));
  return row;
}

function renderAdminList() {
  if (!isAdmin()) return;
  const names = getAllStreetNames().sort((a,b) => {
    const order = { in_progress: 0, done: 1, available: 2 };
    return order[statusFor(a)] - order[statusFor(b)] || a.localeCompare(b, 'cs');
  });
  els.adminList.innerHTML = '';

  for (const name of names) {
    const status = statusFor(name);
    const owner = ownerFor(name)?.display_name;
    const row = document.createElement('div');
    row.className = 'street-row';
    row.innerHTML = `
      <i class="street-state ${status}"></i>
      <div class="street-row-main">
        <strong>${escapeHtml(name)}</strong>
        <span>${status === 'available' ? 'Volná' : escapeHtml(owner || 'Obsazeno')}</span>
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'admin-row-actions';
    if (status !== 'available') {
      const select = document.createElement('select');
      select.innerHTML = `<option value="in_progress">Roznáší se</option><option value="done">Rozneseno</option>`;
      select.value = status;
      select.addEventListener('change', async () => {
        select.disabled = true;
        await setStreetStatus(name, select.value);
        select.disabled = false;
      });
      const clear = document.createElement('button');
      clear.className = 'admin-clear';
      clear.textContent = 'Uvolnit';
      clear.addEventListener('click', async () => {
        clear.disabled = true;
        await releaseStreet(name);
        clear.disabled = false;
      });
      actions.append(select, clear);
    } else {
      actions.innerHTML = '<span class="mini-status">Volná</span>';
    }
    row.appendChild(actions);
    els.adminList.appendChild(row);
  }
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  } catch { return '—'; }
}

function renderAdminUsers() {
  if (!isAdmin() || !els.adminUserList) return;
  els.adminUserList.innerHTML = '';
  for (const user of adminUsers) {
    const mine = user.id === currentUser?.id;
    const row = document.createElement('div');
    row.className = `user-admin-row ${user.active ? '' : 'inactive'}`;
    row.innerHTML = `
      <div class="user-admin-avatar">${escapeHtml(initials(user.display_name))}</div>
      <div class="user-admin-main">
        <strong>${escapeHtml(user.display_name)}</strong>
        <span>@${escapeHtml(user.username)} · ${user.role === 'admin' ? 'Administrátor' : 'Uživatel'} · ${user.active ? 'Aktivní' : 'Blokován'}</span>
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'user-admin-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'admin-mini-btn';
    editBtn.textContent = 'Upravit jméno';
    editBtn.addEventListener('click', () => openUserEditDialog(user));
    actions.appendChild(editBtn);

    if (!mine) {
      const roleBtn = document.createElement('button');
      roleBtn.className = 'admin-mini-btn';
      roleBtn.textContent = user.role === 'admin' ? 'Odebrat admin' : 'Nastavit admin';
      roleBtn.addEventListener('click', () => updateAdminUser(user, { role: user.role === 'admin' ? 'user' : 'admin' }));

      const activeBtn = document.createElement('button');
      activeBtn.className = 'admin-mini-btn';
      activeBtn.textContent = user.active ? 'Blokovat' : 'Aktivovat';
      activeBtn.addEventListener('click', () => updateAdminUser(user, { active: !user.active }));

      const passwordBtn = document.createElement('button');
      passwordBtn.className = 'admin-mini-btn';
      passwordBtn.textContent = 'Nové heslo';
      passwordBtn.addEventListener('click', () => resetAdminUserPassword(user));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'admin-mini-btn danger';
      deleteBtn.textContent = 'Smazat';
      deleteBtn.addEventListener('click', () => deleteAdminUser(user));
      actions.append(roleBtn, activeBtn, passwordBtn, deleteBtn);
    } else {
      const own = document.createElement('span');
      own.className = 'mini-status';
      own.textContent = 'Váš účet';
      actions.appendChild(own);
    }
    row.appendChild(actions);
    els.adminUserList.appendChild(row);
  }
}

function openUserEditDialog(user) {
  editingUser = user;
  els.editUserId.value = user.id;
  els.editUsername.value = user.username;
  els.editDisplayName.value = user.display_name;
  els.userEditDialog?.showModal();
}

function renderAdminDailyReport() {
  if (!isAdmin()) return;
  if (els.adminTodayDone) els.adminTodayDone.textContent = adminTodayReport.length;
  if (!els.adminDailyReportList) return;

  const selectedDate = els.adminDailyDate?.value || pragueDateString();
  const isToday = selectedDate === pragueDateString();
  if (els.adminDailyReportCaption) {
    els.adminDailyReportCaption.textContent = isToday
      ? 'Přehled ulic dokončených dnes.'
      : `Přehled ulic dokončených ${formatReportDate(selectedDate)}.`;
  }

  const grouped = new Map();
  for (const row of adminDailyReport) {
    const key = row.user_id || row.username || row.display_name || 'unknown';
    if (!grouped.has(key)) {
      grouped.set(key, {
        user_id: row.user_id,
        username: row.username || 'neznamy',
        display_name: row.display_name || row.username || 'Neznámý uživatel',
        streets: []
      });
    }
    grouped.get(key).streets.push(row);
  }

  const users = [...grouped.values()].sort((a,b) =>
    b.streets.length - a.streets.length || a.display_name.localeCompare(b.display_name, 'cs')
  );

  if (els.adminDailyTotal) els.adminDailyTotal.textContent = adminDailyReport.length;
  if (els.adminDailyPeople) els.adminDailyPeople.textContent = users.length;
  els.adminDailyReportList.innerHTML = '';

  if (!users.length) {
    els.adminDailyReportList.innerHTML = `<div class="daily-report-empty"><span>○</span><div><strong>Žádná dokončená ulice</strong><small>${isToday ? 'Dnes zatím nikdo nedokončil žádnou ulici.' : `Pro ${escapeHtml(formatReportDate(selectedDate))} nejsou zaznamenané žádné dokončené ulice.`}</small></div></div>`;
    return;
  }

  for (const user of users) {
    const card = document.createElement('section');
    card.className = 'daily-user-card';
    const streetItems = user.streets
      .sort((a,b) => new Date(a.completed_at) - new Date(b.completed_at))
      .map(row => {
        const time = new Intl.DateTimeFormat('cs-CZ', {
          timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit'
        }).format(new Date(row.completed_at));
        return `<div class="daily-street-item"><span class="daily-street-check">✓</span><strong>${escapeHtml(row.street_name)}</strong><span>${escapeHtml(time)}</span></div>`;
      }).join('');
    card.innerHTML = `
      <div class="daily-user-head">
        <div class="daily-user-person">
          <div class="perf-avatar">${escapeHtml(initials(user.display_name))}</div>
          <div><strong>${escapeHtml(user.display_name)}</strong><span>@${escapeHtml(user.username)}</span></div>
        </div>
        <div class="daily-user-count"><strong>${user.streets.length}</strong><span>${user.streets.length === 1 ? 'ulice' : user.streets.length >= 2 && user.streets.length <= 4 ? 'ulice' : 'ulic'}</span></div>
      </div>
      <div class="daily-street-list">${streetItems}</div>`;
    els.adminDailyReportList.appendChild(card);
  }
}

function logCategory(action = '') {
  if (action.startsWith('street_')) return 'streets';
  if (action.startsWith('user_') || action === 'password_changed') return 'users';
  return 'system';
}

function describeLogEntry(entry) {
  const actor = entry.actor_display_name || entry.actor_username || 'Systém';
  const target = entry.target_display_name || entry.target_username || 'uživatel';
  const details = entry.details || {};
  switch (entry.action) {
    case 'street_claimed': return `${actor} převzal ulici ${entry.street_name}.`;
    case 'street_done': return `${actor} označil ulici ${entry.street_name} jako roznesenou.`;
    case 'street_reopened': return `${actor} vrátil ulici ${entry.street_name} do stavu „roznáší se“.`;
    case 'street_released': return `${actor} uvolnil ulici ${entry.street_name}.`;
    case 'distribution_reset': return `${actor} provedl kompletní reset roznosu (${details.released_count ?? 0} ulic uvolněno).`;
    case 'user_created': return `${actor} vytvořil účet ${target}${entry.target_username ? ` (@${entry.target_username})` : ''}.`;
    case 'user_updated': {
      const changes = [];
      if (details.old_username !== details.new_username) changes.push(`login @${details.old_username} → @${details.new_username}`);
      if (details.old_display_name !== details.new_display_name) changes.push(`jméno ${details.old_display_name} → ${details.new_display_name}`);
      if (details.old_role !== details.new_role) changes.push(`role ${details.old_role} → ${details.new_role}`);
      if (details.old_active !== details.new_active) changes.push(details.new_active ? 'účet aktivován' : 'účet zablokován');
      return `${actor} upravil účet ${target}${changes.length ? `: ${changes.join(', ')}` : '.'}`;
    }
    case 'user_password_reset': return `${actor} resetoval heslo uživatele ${target}.`;
    case 'user_deleted': return `${actor} smazal účet ${target}.`;
    case 'password_changed': return `${actor} změnil své heslo.`;
    default: return `${actor}: ${entry.action}.`;
  }
}

function renderAdminLog() {
  if (!isAdmin() || !els.adminLogList) return;
  const search = (els.adminLogSearch?.value || '').trim().toLocaleLowerCase('cs');
  const filter = els.adminLogFilter?.value || 'all';
  const rows = adminLog.filter(entry => {
    if (filter !== 'all' && logCategory(entry.action) !== filter) return false;
    if (!search) return true;
    const hay = `${entry.actor_username || ''} ${entry.actor_display_name || ''} ${entry.target_username || ''} ${entry.target_display_name || ''} ${entry.street_name || ''} ${describeLogEntry(entry)}`.toLocaleLowerCase('cs');
    return hay.includes(search);
  });
  els.adminLogList.innerHTML = '';
  if (!rows.length) {
    els.adminLogList.innerHTML = '<div class="no-results">Log neobsahuje žádné odpovídající události.</div>';
    return;
  }
  for (const entry of rows) {
    const item = document.createElement('div');
    item.className = `log-row log-${logCategory(entry.action)}`;
    const icon = logCategory(entry.action) === 'streets' ? '⌖' : logCategory(entry.action) === 'users' ? '👤' : '↺';
    item.innerHTML = `
      <div class="log-icon">${icon}</div>
      <div class="log-main">
        <strong>${escapeHtml(describeLogEntry(entry))}</strong>
        <span>${escapeHtml(new Intl.DateTimeFormat('cs-CZ',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(entry.created_at)))}</span>
      </div>`;
    els.adminLogList.appendChild(item);
  }
}

function buildAdminReportElement() {
  const { counts, total, pct } = getStatusSummary();
  const performance = computeUserPerformance();
  const activeStreets = getAllStreetNames()
    .filter(name => statusFor(name) === 'in_progress')
    .map(name => ({ name, owner: ownerFor(name)?.display_name || 'Neznámý uživatel' }));
  const now = new Intl.DateTimeFormat('cs-CZ', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date());

  const report = document.createElement('section');
  report.className = 'pdf-report';
  report.innerHTML = `
    <header class="pdf-report-header">
      <div class="pdf-report-logo">Ú</div>
      <div>
        <h1>Přehled roznosu letáků - Úpice</h1>
        <p>Aktuální stav k ${escapeHtml(now)}</p>
      </div>
    </header>

    <div class="pdf-summary-grid">
      <div><span>Celkem ulic</span><strong>${total}</strong></div>
      <div class="pdf-free"><span>Volné</span><strong>${counts.available}</strong></div>
      <div class="pdf-working"><span>Rozpracované</span><strong>${counts.in_progress}</strong></div>
      <div class="pdf-done"><span>Hotové</span><strong>${counts.done}</strong></div>
      <div class="pdf-progress"><span>Dokončeno</span><strong>${pct} %</strong></div>
    </div>

    <div class="pdf-progress-section">
      <div><span>Celkový postup</span><strong>${counts.done} / ${total}</strong></div>
      <div class="pdf-progress-track"><i style="width:${pct}%"></i></div>
    </div>

    <section class="pdf-section">
      <h2>Výkon uživatelů</h2>
      <table class="pdf-table">
        <thead><tr><th>Uživatel</th><th>Hotovo</th><th>Rozpracováno</th><th>Celkem přiděleno</th></tr></thead>
        <tbody>
          ${performance.length ? performance.map(user => `
            <tr>
              <td><strong>${escapeHtml(user.display_name)}</strong><br><small>@${escapeHtml(user.username)}</small></td>
              <td>${user.done}</td>
              <td>${user.in_progress}</td>
              <td>${user.total}</td>
            </tr>`).join('') : '<tr><td colspan="4">Žádná data o uživatelích.</td></tr>'}
        </tbody>
      </table>
    </section>

    <section class="pdf-section pdf-avoid-break">
      <h2>Aktuálně rozpracované ulice</h2>
      ${activeStreets.length ? `
        <table class="pdf-table pdf-table-compact">
          <thead><tr><th>Ulice</th><th>Uživatel</th></tr></thead>
          <tbody>${activeStreets.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.owner)}</td></tr>`).join('')}</tbody>
        </table>` : '<div class="pdf-empty">V tuto chvíli není žádná ulice rozpracovaná.</div>'}
    </section>

    <footer class="pdf-report-footer">
      <span>Letáky Úpice</span>
      <span>Vygeneroval: ${escapeHtml(currentProfile?.display_name || currentProfile?.username || 'Administrátor')}</span>
    </footer>`;
  document.body.appendChild(report);
  return report;
}

function openPrintableReport(report) {
  const popup = window.open('', '_blank');
  if (!popup) throw new Error('POPUP_BLOCKED');
  popup.document.write(`<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Přehled roznosu letáků</title><style>
    body{font-family:Arial,sans-serif;padding:24px;color:#0f172a}.pdf-report{position:static!important;width:auto!important;box-shadow:none!important}.pdf-report-header{display:flex;gap:16px;align-items:center;border-bottom:2px solid #2563eb;padding-bottom:16px}.pdf-report-logo{width:48px;height:48px;background:#2563eb;color:white;border-radius:14px;display:grid;place-items:center;font-size:26px;font-weight:900}.pdf-report-header h1{margin:0;font-size:24px}.pdf-report-header p{margin:4px 0 0;color:#64748b}.pdf-summary-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:18px 0}.pdf-summary-grid>div{padding:12px;border:1px solid #e2e8f0;border-radius:10px}.pdf-summary-grid span{display:block;font-size:10px;color:#64748b}.pdf-summary-grid strong{font-size:22px}.pdf-section{margin-top:22px}.pdf-table{width:100%;border-collapse:collapse}.pdf-table th,.pdf-table td{border-bottom:1px solid #e2e8f0;padding:9px;text-align:left}.pdf-table th{background:#f8fafc}.pdf-report-footer{margin-top:28px;border-top:1px solid #e2e8f0;padding-top:10px;display:flex;justify-content:space-between;color:#64748b;font-size:10px}@media print{button{display:none}}
  </style></head><body>${report.outerHTML}<script>window.onload=()=>window.print()<\/script></body></html>`);
  popup.document.close();
}

function buildPdfDocumentDefinition() {
  const { counts, total, pct } = getStatusSummary();
  const performance = computeUserPerformance();
  const activeStreets = getAllStreetNames()
    .filter(name => statusFor(name) === 'in_progress')
    .map(name => ({
      name,
      owner: ownerFor(name)?.display_name || 'Neznámý uživatel'
    }));

  const now = new Intl.DateTimeFormat('cs-CZ', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date());

  const userRows = performance.length
    ? performance.map(user => [
        { text: `${user.display_name}\n@${user.username}`, bold: true },
        { text: String(user.done), alignment: 'center' },
        { text: String(user.in_progress), alignment: 'center' },
        { text: String(user.total), alignment: 'center' }
      ])
    : [[{ text: 'Žádná data o uživatelích.', colSpan: 4, alignment: 'center', color: '#64748b' }, {}, {}, {}]];

  const activeRows = activeStreets.length
    ? activeStreets.map(item => [item.name, item.owner])
    : [[{ text: 'V tuto chvíli není žádná ulice rozpracovaná.', colSpan: 2, alignment: 'center', color: '#047857' }, {}]];

  return {
    pageSize: 'A4',
    pageMargins: [36, 38, 36, 38],
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#0f172a' },
    info: {
      title: 'Přehled roznosu letáků - Úpice',
      author: currentProfile?.display_name || 'Administrátor',
      subject: 'Stav roznosu letáků'
    },
    content: [
      {
        columns: [
          { text: 'Ú', color: '#ffffff', fillColor: '#2563eb', bold: true, fontSize: 24, alignment: 'center', margin: [0, 6, 0, 0], width: 44 },
          {
            stack: [
              { text: 'Přehled roznosu letáků – Úpice', fontSize: 20, bold: true, margin: [0, 2, 0, 4] },
              { text: `Aktuální stav k ${now}`, color: '#64748b', fontSize: 10 }
            ],
            margin: [12, 0, 0, 0]
          }
        ],
        margin: [0, 0, 0, 16]
      },
      {
        table: {
          widths: ['*','*','*','*','*'],
          body: [
            [
              { text: 'CELKEM ULIC', style: 'metricLabel' },
              { text: 'VOLNÉ', style: 'metricLabel' },
              { text: 'ROZPRACOVANÉ', style: 'metricLabel' },
              { text: 'HOTOVÉ', style: 'metricLabel' },
              { text: 'DOKONČENO', style: 'metricLabel' }
            ],
            [
              { text: String(total), style: 'metricValue' },
              { text: String(counts.available), style: 'metricValue' },
              { text: String(counts.in_progress), style: 'metricValue', color: '#b45309' },
              { text: String(counts.done), style: 'metricValue', color: '#047857' },
              { text: `${pct} %`, style: 'metricValue', color: '#1d4ed8' }
            ]
          ]
        },
        layout: {
          hLineColor: () => '#e2e8f0',
          vLineColor: () => '#e2e8f0',
          paddingLeft: () => 8,
          paddingRight: () => 8,
          paddingTop: () => 8,
          paddingBottom: () => 8
        },
        margin: [0, 0, 0, 18]
      },
      {
        columns: [
          { text: 'Celkový postup', bold: true },
          { text: `${counts.done} / ${total}`, alignment: 'right', bold: true }
        ],
        margin: [0, 0, 0, 5]
      },
      {
        canvas: [
          { type: 'rect', x: 0, y: 0, w: 523, h: 8, r: 4, color: '#e2e8f0' },
          { type: 'rect', x: 0, y: 0, w: Math.max(0, Math.min(523, 523 * pct / 100)), h: 8, r: 4, color: '#2563eb' }
        ],
        margin: [0, 0, 0, 20]
      },
      { text: 'Výkon uživatelů', style: 'sectionTitle' },
      {
        table: {
          headerRows: 1,
          widths: ['*', 62, 78, 78],
          body: [
            [
              { text: 'Uživatel', style: 'tableHeader' },
              { text: 'Hotovo', style: 'tableHeader', alignment: 'center' },
              { text: 'Rozpracováno', style: 'tableHeader', alignment: 'center' },
              { text: 'Celkem', style: 'tableHeader', alignment: 'center' }
            ],
            ...userRows
          ]
        },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 20]
      },
      { text: 'Aktuálně rozpracované ulice', style: 'sectionTitle' },
      {
        table: {
          headerRows: 1,
          widths: ['*','*'],
          body: [
            [
              { text: 'Ulice', style: 'tableHeader' },
              { text: 'Uživatel', style: 'tableHeader' }
            ],
            ...activeRows
          ]
        },
        layout: 'lightHorizontalLines'
      },
      {
        columns: [
          { text: 'Letáky Úpice', color: '#64748b', fontSize: 8 },
          { text: `Vygeneroval: ${currentProfile?.display_name || currentProfile?.username || 'Administrátor'}`, alignment: 'right', color: '#64748b', fontSize: 8 }
        ],
        margin: [0, 28, 0, 0]
      }
    ],
    styles: {
      metricLabel: { fontSize: 7.5, color: '#64748b', bold: true, alignment: 'center' },
      metricValue: { fontSize: 18, bold: true, alignment: 'center' },
      sectionTitle: { fontSize: 13, bold: true, margin: [0, 0, 0, 8] },
      tableHeader: { bold: true, color: '#475569', fillColor: '#f1f5f9', fontSize: 8 }
    },
    footer: (currentPage, pageCount) => ({
      text: `Strana ${currentPage} / ${pageCount}`,
      alignment: 'center',
      color: '#94a3b8',
      fontSize: 8,
      margin: [0, 10, 0, 0]
    })
  };
}

async function exportAdminPdf() {
  if (!isAdmin()) return;
  const button = els.adminExportPdfBtn;
  const original = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="btn-icon">…</span> Generuji PDF';
  }

  try {
    if (!window.pdfMake) throw new Error('PDFMAKE_NOT_LOADED');
    const day = new Date().toISOString().slice(0, 10);
    const docDefinition = buildPdfDocumentDefinition();
    window.pdfMake.createPdf(docDefinition).download(`letaky-upice-prehled-${day}.pdf`);
    toast('PDF bylo vytvořeno', 'Přehled se stáhl do počítače.', 'success');
  } catch (error) {
    console.error(error);
    try {
      const report = buildAdminReportElement();
      openPrintableReport(report);
      report.remove();
      toast('Použit náhradní export', 'V dialogu zvolte „Uložit jako PDF“.', 'success');
    } catch {
      toast('PDF se nepodařilo vytvořit', 'Obnovte stránku a zkuste export znovu.', 'error');
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
}

els.adminExportPdfBtn?.addEventListener('click', exportAdminPdf);

els.adminCreateUserForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.adminUserMessage.classList.add('hidden');
  const submit = els.adminCreateUserForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await rpc('app_admin_create_user', {
      p_username: els.adminNewUsername.value.trim().toLowerCase(),
      p_display_name: els.adminNewDisplayName.value.trim(),
      p_password: els.adminNewPassword.value,
      p_role: els.adminNewRole.value
    });
    els.adminCreateUserForm.reset();
    toast('Účet vytvořen', 'Nový uživatel se může ihned přihlásit.', 'success');
    await Promise.all([loadProfiles(), loadAdminUsers(), loadAdminLog()]);
    renderAll();
  } catch (error) {
    els.adminUserMessage.textContent = parseRpcError(error);
    els.adminUserMessage.classList.remove('hidden');
  } finally {
    submit.disabled = false;
  }
});

async function updateAdminUser(user, changes) {
  try {
    await rpc('app_admin_update_user_v2', {
      p_user_id: user.id,
      p_username: changes.username ?? user.username,
      p_display_name: changes.display_name ?? user.display_name,
      p_role: changes.role ?? user.role,
      p_active: changes.active ?? user.active
    });
    if (user.id === currentUser?.id) {
      const data = await rpc('app_me');
      const me = data?.[0];
      if (me) {
        currentUser = { id: me.user_id, username: me.username };
        currentProfile = { id: me.user_id, username: me.username, display_name: me.display_name, role: me.role };
        updateUserHeader();
      }
    }
    await Promise.all([loadProfiles(), loadAdminUsers(), loadStatuses(), loadAdminLog()]);
    renderAll();
    toast('Uživatel upraven', changes.display_name ?? user.display_name, 'success');
  } catch (error) {
    toast('Uživatele se nepodařilo upravit', parseRpcError(error), 'error');
  }
}

async function resetAdminUserPassword(user) {
  const password = window.prompt(`Nové heslo pro ${user.display_name} (min. 6 znaků):`);
  if (password === null) return;
  if (password.length < 6) return toast('Heslo je příliš krátké', 'Použijte alespoň 6 znaků.', 'error');
  try {
    await rpc('app_admin_reset_password', { p_user_id: user.id, p_new_password: password });
    await loadAdminLog();
    renderAdminLog();
    toast('Heslo změněno', `Heslo uživatele ${user.display_name} bylo nastaveno.`, 'success');
  } catch (error) {
    toast('Heslo se nepodařilo změnit', parseRpcError(error), 'error');
  }
}

async function deleteAdminUser(user) {
  if (!window.confirm(`Opravdu smazat účet @${user.username}? Jeho rozpracované ulice se tím uvolní.`)) return;
  try {
    await rpc('app_admin_delete_user', { p_user_id: user.id });
    await Promise.all([loadProfiles(), loadAdminUsers(), loadStatuses(), loadAdminLog()]);
    renderAll();
    toast('Účet smazán', user.display_name, 'success');
  } catch (error) {
    toast('Účet se nepodařilo smazat', parseRpcError(error), 'error');
  }
}

els.userEditForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingUser) return;
  const username = els.editUsername.value.trim().toLowerCase();
  const displayName = els.editDisplayName.value.trim();
  await updateAdminUser(editingUser, { username, display_name: displayName });
  els.userEditDialog?.close();
  editingUser = null;
});

document.querySelectorAll('[data-close-dialog]').forEach(btn => {
  btn.addEventListener('click', () => document.getElementById(btn.dataset.closeDialog)?.close());
});

els.changePasswordBtn?.addEventListener('click', () => {
  els.changePasswordMessage.classList.add('hidden');
  els.changePasswordForm.reset();
  els.changePasswordDialog?.showModal();
});

els.changePasswordForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.changePasswordMessage.classList.add('hidden');
  const currentPassword = els.currentPasswordField.value;
  const newPassword = els.newPasswordField.value;
  const confirmPassword = els.newPasswordConfirmField.value;
  if (newPassword !== confirmPassword) {
    els.changePasswordMessage.textContent = 'Nová hesla se neshodují.';
    els.changePasswordMessage.classList.remove('hidden');
    return;
  }
  try {
    await rpc('app_change_password', { p_current_password: currentPassword, p_new_password: newPassword });
    els.changePasswordDialog?.close();
    toast('Heslo změněno', 'Vaše nové heslo je aktivní.', 'success');
    if (isAdmin()) { await loadAdminLog(); renderAdminLog(); }
  } catch (error) {
    els.changePasswordMessage.textContent = parseRpcError(error);
    els.changePasswordMessage.classList.remove('hidden');
  }
});

els.adminDailyDate?.addEventListener('change', async () => {
  await loadAdminDailyReports(els.adminDailyDate.value);
  renderAdminDailyReport();
});

els.adminDailyTodayBtn?.addEventListener('click', async () => {
  const today = pragueDateString();
  els.adminDailyDate.value = today;
  await loadAdminDailyReports(today);
  renderAdminDailyReport();
});

els.adminDailyRefreshBtn?.addEventListener('click', async () => {
  els.adminDailyRefreshBtn.disabled = true;
  await loadAdminDailyReports();
  renderAdminDailyReport();
  els.adminDailyRefreshBtn.disabled = false;
});

els.adminResetDistributionBtn?.addEventListener('click', async () => {
  if (!isAdmin()) return;
  const { counts } = getStatusSummary();
  if (!window.confirm(`Opravdu uvolnit všechny ulice? Rozpracované: ${counts.in_progress}, hotové: ${counts.done}.`)) return;
  const verification = window.prompt('Pro potvrzení kompletního resetu napište RESET:');
  if (verification !== 'RESET') return toast('Reset zrušen', 'Potvrzovací text nebyl zadán správně.', 'error');
  els.adminResetDistributionBtn.disabled = true;
  try {
    const result = await rpc('app_admin_reset_distribution');
    const info = result?.[0];
    selectedStreet = null;
    await Promise.all([loadStatuses(), loadAdminLog()]);
    renderAll();
    toast('Roznos kompletně resetován', `${info?.released_count ?? 0} ulic je nyní volných.`, 'success');
  } catch (error) {
    toast('Reset se nepodařilo provést', parseRpcError(error), 'error');
  } finally {
    els.adminResetDistributionBtn.disabled = false;
  }
});

els.adminLogRefreshBtn?.addEventListener('click', async () => {
  els.adminLogRefreshBtn.disabled = true;
  await loadAdminLog();
  renderAdminLog();
  els.adminLogRefreshBtn.disabled = false;
});
els.adminLogSearch?.addEventListener('input', renderAdminLog);
els.adminLogFilter?.addEventListener('change', renderAdminLog);

els.refreshBtn?.addEventListener('click', async () => {
  els.refreshBtn.disabled = true;
  await Promise.all([reloadSharedData(false), loadStreets(), isAdmin() ? loadAdminUsers() : Promise.resolve()]);
  renderAll();
  els.refreshBtn.disabled = false;
  toast('Data obnovena', 'Mapa i stav ulic jsou aktuální.', 'success');
});

els.streetSearch?.addEventListener('input', renderStreetList);
els.filterBar?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-filter]');
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  [...els.filterBar.querySelectorAll('.filter-chip')].forEach(b => b.classList.toggle('active', b === btn));
  renderStreetList();
});

document.querySelector('.sidebar-tabs')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-tab]');
  if (!btn) return;
  setActiveTab(btn.dataset.tab);
});

els.fitMapBtn?.addEventListener('click', () => { if (cityBounds && map) map.fitBounds(cityBounds, { padding: 50, duration: 350, maxZoom: 15.8 }); });
els.locateBtn?.addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Poloha není podporována', '', 'error');
  navigator.geolocation.getCurrentPosition(
    pos => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 }),
    () => toast('Polohu se nepodařilo zjistit', 'Zkontrolujte oprávnění prohlížeče.', 'error'),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

els.mobileMenuBtn?.addEventListener('click', () => els.sidebar.classList.toggle('open'));

initSupabase();
