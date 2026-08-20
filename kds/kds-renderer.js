// KDS de cocina. No usa createClient/Supabase aquí: main.js (proceso
// principal) hace todas las consultas y Realtime, y solo empuja por IPC
// (kds:orders / kds:online) vía kds-preload.js -- ver comentario ahí.
let latestOrders = [];
const alreadyBeeped = new Set(); // ids que ya sonaron por pasar 18 min, para no repetir cada segundo

// Atajos de teclado (N/R/Esc) -- ver más abajo, cerca de setInterval(render).
// selectedIndex es una posición dentro de latestOrders (ya viene ordenado
// por created_at asc, el más urgente primero), no dentro de una columna: la
// tarjeta seleccionada puede estar en cualquiera de las 3 columnas.
let selectedIndex = 0;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmt(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function fmtElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function orderLabel(order) {
  if (order.tableNumber) return `Mesa ${order.tableNumber}`;
  if (order.folio) return `#${order.folio}`;
  return `Pedido #${order.id}`;
}

// Beep sintetizado (Web Audio), sin archivo de audio que empaquetar: mismo
// enfoque que ya usa order-alert.js en el resto de la app.
function playAlertBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 660;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.55);
  } catch (err) {
    console.error('No se pudo reproducir el aviso de orden con retraso:', err);
  }
}

function cardHtml(order) {
  const elapsedMs = Date.now() - new Date(order.createdAt).getTime();
  const minutes = elapsedMs / 60000;
  const overClass = minutes >= 18 ? 'over18' : minutes >= 12 ? 'over12' : '';

  if (minutes >= 18 && !alreadyBeeped.has(order.id)) {
    alreadyBeeped.add(order.id);
    playAlertBeep();
  }

  const itemsHtml = (order.items || []).length
    ? order.items.map((it) => {
        const modifiersHtml = (it.modifiers || [])
          .map((name) => `<span class="item-modifier">${escapeHtml(name.toUpperCase())}</span>`)
          .join('');
        return `<div class="item-line">${it.quantity}x ${escapeHtml(it.name)}${modifiersHtml ? `<br>${modifiersHtml}` : ''}</div>`;
      }).join('')
    : '<div style="opacity:.6">Sin artículos</div>';

  const action = order.kdsStatus === 'nueva'
    ? { cls: 'cook', label: 'COCINAR' }
    : order.kdsStatus === 'en_preparacion'
      ? { cls: 'ready', label: 'LISTA' }
      : { cls: 'deliver', label: 'ENTREGAR' };

  // Domicilio: badge grande para que cocina no lo confunda con un pedido
  // normal para llevar. La cocina solo avanza kds_status (nueva ->
  // en_preparacion -> lista); el dinero (payment_status) es cosa de caja,
  // no del KDS.
  const deliveryBadge = order.isDelivery
    ? `<div class="delivery-badge">🛵 DOMICILIO ${fmt(order.total)}</div>`
    : '';
  const driverLine = order.isDelivery && order.driverName
    ? `<div class="delivery-driver-name">Repartidor: ${escapeHtml(order.driverName)}</div>`
    : '';

  const isSelected = latestOrders[selectedIndex] && latestOrders[selectedIndex].id === order.id;

  return `
    <div class="card ${overClass} ${isSelected ? 'selected' : ''}" data-id="${order.id}">
      ${deliveryBadge}
      <div class="id">${escapeHtml(orderLabel(order))}</div>
      ${driverLine}
      <div class="items">${itemsHtml}</div>
      <div class="timer">${fmtElapsed(elapsedMs)}</div>
      <button data-action="${action.cls}" data-id="${order.id}">${action.label}</button>
    </div>
  `;
}

function renderColumn(elId, orders, emptyLabel) {
  const el = document.getElementById(elId);
  el.innerHTML = orders.length ? orders.map(cardHtml).join('') : `<div class="empty-column">${emptyLabel}</div>`;
}

function render() {
  // Si la orden seleccionada ya no está (se entregó, o la lista se achicó),
  // no dejar el índice apuntando a nada.
  if (selectedIndex >= latestOrders.length) selectedIndex = Math.max(0, latestOrders.length - 1);

  renderColumn('cards-nueva', latestOrders.filter((o) => o.kdsStatus === 'nueva'), 'Sin órdenes nuevas');
  renderColumn('cards-prep', latestOrders.filter((o) => o.kdsStatus === 'en_preparacion'), 'Nada en preparación');
  renderColumn('cards-lista', latestOrders.filter((o) => o.kdsStatus === 'lista'), 'Nada listo para entregar');
}

const ACTION_CALL = {
  cook: (id) => window.kdsAPI.cook(id),
  ready: (id) => window.kdsAPI.markReady(id),
  deliver: (id) => window.kdsAPI.markDelivered(id)
};

document.getElementById('app').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const call = ACTION_CALL[btn.dataset.action];
  if (!call) return;
  btn.disabled = true;
  call(id).catch((err) => {
    console.error('No se pudo actualizar la orden:', err);
    btn.disabled = false;
  });
});

// ==========================================================================
// ATAJOS DE TECLADO -- la TV no tiene mouse a mano (ni teclado, casi
// siempre), pero si alguien conecta uno para operar el KDS directo sin
// pasar por el mapa de mesas, N mueve la selección (tarjeta resaltada, ver
// .card.selected en kds.css) al siguiente pedido más urgente (latestOrders
// ya viene ordenado por antigüedad), y R lo avanza un paso -- el mismo
// botón que ya tiene esa tarjeta (COCINAR/LISTA/ENTREGAR según su estado
// actual), sin duplicar esa lógica aquí.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.kdsAPI.exitFullscreen();
    return;
  }

  if (e.key === 'n' || e.key === 'N') {
    if (latestOrders.length === 0) return;
    selectedIndex = (selectedIndex + 1) % latestOrders.length;
    render();
    return;
  }

  if (e.key === 'r' || e.key === 'R') {
    const order = latestOrders[selectedIndex];
    if (!order) return;
    const actionKey = order.kdsStatus === 'nueva' ? 'cook' : order.kdsStatus === 'en_preparacion' ? 'ready' : 'deliver';
    ACTION_CALL[actionKey](order.id).catch((err) => {
      console.error('No se pudo avanzar la orden seleccionada con R:', err);
    });
  }
});

function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('es-MX');
}

window.kdsAPI.onOrders((orders) => {
  latestOrders = orders || [];
  const validIds = new Set(latestOrders.map((o) => o.id));
  Array.from(alreadyBeeped).forEach((id) => { if (!validIds.has(id)) alreadyBeeped.delete(id); });
  render();
});

window.kdsAPI.onOnline((online) => {
  document.getElementById('offline').hidden = !!online;
});

setInterval(render, 1000); // recalcula timers (mm:ss) y clases over12/over18 en vivo
setInterval(updateClock, 1000);
updateClock();
render();
