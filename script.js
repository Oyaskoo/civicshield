(() => {
  'use strict';
  const API_BASE_URL = "http://localhost:8081/api";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const ADMIN_KEY = 'civicshield_admin_v1';
  const STATUS_LABEL = { pending: 'Pending Crew', progress: 'In Progress', resolved: 'Resolved' };
  const SEV_ICON = { Low: '🟢', Medium: '🟡', High: '🟠', Critical: '🔴' };
  const STATUS_TO_UI = { PENDING: 'pending', IN_PROGRESS: 'progress', RESOLVED: 'resolved' };
  const STATUS_TO_API = { pending: 'PENDING', progress: 'IN_PROGRESS', resolved: 'RESOLVED' };

  /* ---------- State / storage ---------- */
  let reports = [];
  let filter = 'all';
  let isAdmin = false;
  let photoData = '';
  try { isAdmin = sessionStorage.getItem(ADMIN_KEY) === '1'; } catch {}

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function normalizeReport(report) {
    const rawSeverity = String(report.severity || 'Medium').toLowerCase();
    return {
      id: String(report.id || ''),
      category: String(report.category || ''),
      severity: rawSeverity.charAt(0).toUpperCase() + rawSeverity.slice(1),
      description: String(report.description || ''),
      lat: Number(report.latitude ?? report.lat),
      lon: Number(report.longitude ?? report.lon),
      photo: typeof report.photo === 'string' ? report.photo : '',
      status: STATUS_TO_UI[String(report.status || '').toUpperCase()] || 'pending',
      createdAt: report.createdAt || Date.now()
    };
  }

  function apiErrorMessage(error) {
    if (error.networkError) return 'Unable to connect to CivicShield server.';
    if (error.status === 400) return 'Invalid incident details.';
    if (error.status === 404) return 'Incident not found.';
    return 'Server error. Please try again.';
  }

  function photoMarkup(photo, alt = '') {
    if (!photo) return '';
    if (/^data:image\/(jpeg|png|webp);base64,/i.test(photo) || /^https?:\/\//i.test(photo)) {
      return `<img src="${esc(photo)}" alt="${esc(alt)}">`;
    }
    return `<p class="meta">Photo: ${esc(photo)}</p>`;
  }

  async function apiRequest(path, options = {}) {
    let response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, options);
    } catch {
      const error = new Error('Network request failed');
      error.networkError = true;
      throw error;
    }

    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error('API request failed');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function loadReports({ notify = true } = {}) {
    try {
      const result = await apiRequest('/reports');
      if (!Array.isArray(result)) throw new Error('Invalid report response');
      reports = result.map(normalizeReport).filter(report => report.id);
      renderAll();
      return true;
    } catch (error) {
      if (notify) toast(apiErrorMessage(error));
      return false;
    }
  }

  /* ---------- Map ---------- */
  const map = L.map('map', { zoomControl: true }).setView([9.9816, 76.2999], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const selectionLayer = L.layerGroup().addTo(map);
  const reportMarkers = new Map();
  let selectMarker = null;

  const pinIcon = cls => L.divIcon({
    className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -22]
  });

  function setSelectMarker(lat, lon) {
    if (selectMarker) selectMarker.setLatLng([lat, lon]);
    else selectMarker = L.marker([lat, lon], { icon: pinIcon('select') }).addTo(selectionLayer);
  }

  map.on('click', e => {
    const lat = +e.latlng.lat.toFixed(6), lon = +e.latlng.lng.toFixed(6);
    $('#lat').value = lat; $('#lon').value = lon;
    setSelectMarker(lat, lon);
    toast(`Location selected: ${lat}, ${lon}`);
  });

  function drawMarkers() {
    markerLayer.clearLayers();
    reportMarkers.clear();
    reports.forEach(r => {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return;
      const m = L.marker([r.lat, r.lon], { icon: pinIcon(r.status) });
      m.bindPopup(
        `<h4>${esc(r.category)}</h4>
         <div>${esc(r.id)}</div>
         <div>${SEV_ICON[r.severity] || ''} ${esc(r.severity)} · ${STATUS_LABEL[r.status]}</div>
         <div style="margin-top:6px">${esc(r.description)}</div>
         ${photoMarkup(r.photo)}`
      );
      m.addTo(markerLayer);
      reportMarkers.set(r.id, m);
    });
  }

  /* ---------- Rendering ---------- */
  function counts() {
    const c = { total: reports.length, pending: 0, progress: 0, resolved: 0 };
    reports.forEach(r => c[r.status]++);
    return c;
  }

  function renderStats() {
    const c = counts();
    $$('[data-stat]').forEach(el => el.textContent = c[el.dataset.stat]);
  }

  function renderReports() {
    const list = reports.filter(r => filter === 'all' || r.status === filter);
    const box = $('#reports');
    if (!list.length) {
      box.innerHTML = `<div class="empty">${
        reports.length
          ? 'No reports match this filter.'
          : 'No hazard reports currently submitted. Use the form above to submit your first report!'
      }</div>`;
      return;
    }
    box.innerHTML = list.slice().reverse().map(r => `
      <article class="report">
        ${photoMarkup(r.photo, `Photo of ${r.category}`)}
        <div class="body">
          <div class="row"><h3>${esc(r.category)}</h3><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span></div>
          <p>${esc(r.description)}</p>
          <div class="meta">
            <span class="sev">${SEV_ICON[r.severity] || ''} ${esc(r.severity)}</span>
            <span>${fmt(r.createdAt)}</span>
          </div>
          <div class="row">
            <span class="meta">${esc(r.id)} · 📍 ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</span>
            <button class="linkbtn" data-locate="${r.id}">View on map</button>
          </div>
        </div>
      </article>`).join('');
  }

  function renderStream() {
    const box = $('#stream');
    if (!reports.length) { box.innerHTML = '<div class="stream"><div class="none">No active incidents reported.</div></div>'; return; }
    box.innerHTML = reports.slice(-6).reverse().map(r => `
      <div class="stream-item" data-locate="${r.id}">
        <b>${SEV_ICON[r.severity] || ''} ${esc(r.category)}</b>
        <span>${STATUS_LABEL[r.status]} · ${fmt(r.createdAt)}</span>
      </div>`).join('');
  }

  function renderAdmin() {
    $('#adminSection').classList.toggle('show', isAdmin);
    $('#adminBtnText').textContent = isAdmin ? 'Admin Console' : 'Admin Login';
    if (!isAdmin) return;
    const body = $('#adminRows');
    if (!reports.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">No incidents to manage yet.</td></tr>';
      return;
    }
    body.innerHTML = reports.slice().reverse().map(r => `
      <tr>
        <td>${esc(r.category)}</td>
        <td>${SEV_ICON[r.severity] || ''} ${esc(r.severity)}</td>
        <td>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</td>
        <td>${fmt(r.createdAt)}</td>
        <td>
          <select data-status="${r.id}" aria-label="Status">
            ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </td>
        <td><button class="del" data-del="${r.id}">Delete</button></td>
      </tr>`).join('');
  }

  function renderAll() {
    renderStats(); renderReports(); renderStream(); renderAdmin(); drawMarkers();
  }

  /* ---------- Filters ---------- */
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.f;
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    renderReports();
  });

  /* ---------- Locate on map ---------- */
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-locate]'); if (!b) return;
    const r = reports.find(x => x.id === b.dataset.locate); if (!r) return;
    closeDrawer();
    $('#map-section').scrollIntoView();
    map.setView([r.lat, r.lon], 16);
    reportMarkers.get(r.id)?.openPopup();
  });

  /* ---------- Photo upload ---------- */
  const dz = $('#dropzone'), fileIn = $('#photo');
  dz.addEventListener('click', e => { if (e.target.id !== 'removeImg') fileIn.click(); });
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
  fileIn.addEventListener('change', () => handleFile(fileIn.files[0]));
  $('#removeImg').addEventListener('click', e => { e.stopPropagation(); clearPhoto(); });

  function handleFile(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast('Please choose a JPG, PNG or WEBP image.');
    if (file.size > 5 * 1024 * 1024) return toast('Image is larger than 5MB.');
    const reader = new FileReader();
    reader.onload = () => {
      // Downscale before sending the image to the API.
      const img = new Image();
      img.onload = () => {
        const max = 800, scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = img.width * scale; c.height = img.height * scale;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        photoData = c.toDataURL('image/jpeg', 0.7);
        $('#preview').src = photoData;
        $('#preview').style.display = 'block';
        $('#dzEmpty').style.display = 'none';
        dz.classList.add('has-img');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  function clearPhoto() {
    photoData = ''; fileIn.value = '';
    $('#preview').style.display = 'none';
    $('#dzEmpty').style.display = 'flex';
    dz.classList.remove('has-img');
  }

  /* ---------- GPS ---------- */
  $('#gpsBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Geolocation is not supported by this browser.');
    toast('Detecting your location…');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = +pos.coords.latitude.toFixed(6), lon = +pos.coords.longitude.toFixed(6);
        $('#lat').value = lat; $('#lon').value = lon;
        setSelectMarker(lat, lon);
        map.setView([lat, lon], 15);
        toast('GPS location attached.');
      },
      () => toast('Could not get location. Allow access or click the map.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  /* ---------- API-backed report actions ---------- */
  async function createIncident() {
    const category = $('#category').value;
    const severity = $('#severity').value;
    const description = $('#description').value.trim();
    const lat = parseFloat($('#lat').value), lon = parseFloat($('#lon').value);

    if (!category) return toast('Please select a hazard category.');
    if (!description) return toast('Please describe the hazard.');
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return toast('Enter valid coordinates or click the map.');

    const submitButton = $('#submitBtn');
    submitButton.disabled = true;
    try {
      const created = await apiRequest('/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, severity, description, latitude: lat, longitude: lon, photo: photoData || null })
      });
      const normalized = normalizeReport(created);
      reports = reports.filter(report => report.id !== normalized.id);
      reports.push(normalized);

      $('#category').value = ''; $('#severity').value = 'Medium';
      $('#description').value = ''; $('#lat').value = ''; $('#lon').value = '';
      clearPhoto();
      selectionLayer.clearLayers();
      selectMarker = null;

      await loadReports({ notify: false });
      renderAll();
      toast('Report submitted. City crews have been alerted.');
      $('#map-section').scrollIntoView();
    } catch (error) {
      toast(apiErrorMessage(error));
    } finally {
      submitButton.disabled = false;
    }
  }

  async function updateIncidentStatus(id, status) {
    const apiStatus = STATUS_TO_API[status];
    if (!apiStatus) return toast('Invalid incident details.');
    try {
      const updated = await apiRequest(`/reports/${encodeURIComponent(id)}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: apiStatus })
      });
      const normalized = normalizeReport(updated);
      reports = reports.map(report => report.id === id ? normalized : report);
      renderAll();
      toast(`Status updated to ${STATUS_LABEL[normalized.status]}.`);
    } catch (error) {
      renderAdmin();
      toast(apiErrorMessage(error));
    }
  }

  async function deleteIncident(id) {
    try {
      await apiRequest(`/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
      reports = reports.filter(report => report.id !== id);
      renderAll();
      toast('Report deleted.');
    } catch (error) {
      toast(apiErrorMessage(error));
    }
  }

  $('#submitBtn').addEventListener('click', createIncident);

  ['lat', 'lon'].forEach(id => $('#' + id).addEventListener('change', () => {
    const lat = parseFloat($('#lat').value), lon = parseFloat($('#lon').value);
    if (!isNaN(lat) && !isNaN(lon)) setSelectMarker(lat, lon);
  }));

  /* ---------- Drawer ---------- */
  const drawer = $('#drawer'), overlay = $('#overlay');
  function openDrawer() { drawer.classList.add('show'); overlay.classList.add('show'); drawer.setAttribute('aria-hidden', 'false'); }
  function closeDrawer() { drawer.classList.remove('show'); overlay.classList.remove('show'); drawer.setAttribute('aria-hidden', 'true'); }
  $('#menuBtn').addEventListener('click', openDrawer);
  $('#closeDrawer').addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);
  $$('[data-close]').forEach(a => a.addEventListener('click', closeDrawer));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeLogin(); } });

  /* ---------- Admin ---------- */
  const modal = $('#loginModal');
  function openLogin() {
    if (isAdmin) { closeDrawer(); return $('#adminSection').scrollIntoView(); }
    closeDrawer(); modal.classList.add('show'); $('#loginErr').textContent = ''; $('#user').focus();
  }
  function closeLogin() { modal.classList.remove('show'); }
  $('#adminBtn').addEventListener('click', openLogin);
  $('#drawerAdmin').addEventListener('click', openLogin);
  $('#cancelLogin').addEventListener('click', closeLogin);
  modal.addEventListener('click', e => { if (e.target === modal) closeLogin(); });

  function doLogin() {
    if ($('#user').value.trim() === 'admin' && $('#pass').value === 'admin123') {
      isAdmin = true;
      try { sessionStorage.setItem(ADMIN_KEY, '1'); } catch {}
      $('#user').value = $('#pass').value = '';
      closeLogin(); renderAdmin(); toast('Logged in as admin.');
      $('#adminSection').scrollIntoView();
    } else {
      $('#loginErr').textContent = 'Incorrect username or password.';
    }
  }
  $('#doLogin').addEventListener('click', doLogin);
  $('#pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  $('#logoutBtn').addEventListener('click', () => {
    isAdmin = false;
    try { sessionStorage.removeItem(ADMIN_KEY); } catch {}
    renderAdmin(); toast('Logged out.');
  });

  $('#adminRows').addEventListener('change', e => {
    const id = e.target.dataset.status; if (!id) return;
    updateIncidentStatus(id, e.target.value);
  });
  $('#adminRows').addEventListener('click', e => {
    const id = e.target.dataset.del; if (!id) return;
    if (!confirm('Delete this report permanently?')) return;
    deleteIncident(id);
  });

  /* ---------- Nav active state ---------- */
  const links = $$('.nav-links a');
  const targets = links.map(a => $(a.getAttribute('href')));
  addEventListener('scroll', () => {
    const y = scrollY + 140;
    let cur = 0;
    targets.forEach((t, i) => { if (t && t.offsetTop <= y) cur = i; });
    links.forEach((a, i) => a.classList.toggle('active', i === cur));
  }, { passive: true });

  renderAll();
  loadReports();
  setTimeout(() => map.invalidateSize(), 300);
})();
