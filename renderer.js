const ALL_MENU_ITEMS = [
  { id: 'ventas', title: 'VENTAS', icon: '💰', desc: 'Panel Principal de Pedidos y Caja', action: 'open-sales', roles: ['admin', 'cajero'] },
  { id: 'comandas', title: 'COMANDAS', icon: '🍽️', desc: 'Control de Consumo por Mesa', action: 'open-comandas', roles: ['admin', 'cajero'] },
  { id: 'catalogo', title: 'CATÁLOGO', icon: '🍗', desc: 'Catálogo de Productos y Promociones', action: 'open-catalog', roles: ['admin'] },
  { id: 'inventarios', title: 'INVENTARIOS', icon: '📦', desc: 'Gestión de Stock de Insumos', action: 'open-inventory', roles: ['admin'] },
  { id: 'merma', title: 'MERMA', icon: '🗑️', desc: 'Control de Desperdicios y Bajas', action: 'open-waste', roles: ['admin'] },
  { id: 'costos', title: 'COSTOS', icon: '📊', desc: 'Análisis de Rentabilidad y Gastos', action: 'open-costs', roles: ['admin'] },
  { id: 'corte', title: 'CORTE DE CAJA', icon: '🧾', desc: 'Cierre de Caja Diario', action: 'open-corte', roles: ['admin', 'cajero'] },
  { id: 'reportes', title: 'REPORTES', icon: '📑', desc: 'Exportación Diaria, Semanal y Mensual', action: 'open-reports', roles: ['admin'] },
  { id: 'asistencia', title: 'ASISTENCIA', icon: '⏱️', desc: 'Horarios y Empleados', action: 'open-attendance', roles: ['admin', 'empleado'] },
  { id: 'nomina', title: 'NÓMINA', icon: '💵', desc: 'Pago Semanal, Créditos y Faltas', action: 'open-payroll', roles: ['admin'] },
  { id: 'cuentas', title: 'CUENTAS', icon: '🔐', desc: 'Usuarios y Roles del Sistema', action: 'open-accounts', roles: ['admin'] },
  { id: 'ajustes', title: 'AJUSTES', icon: '⚙️', desc: 'Impresora, Negocio y Descuentos', action: 'open-settings', roles: ['admin'] }
];

let menuItems = [];
let currentIndex = 0;
let isAnimating = false;

function renderUserBadge(session) {
  const ROLE_LABELS = { admin: 'Administrador', cajero: 'Cajero', empleado: 'Empleado' };
  const el = document.getElementById('user-badge-index');
  el.innerHTML = `
    <div class="name">
      <strong>${session.displayName}</strong>
      <span>${ROLE_LABELS[session.role] || session.role}</span>
    </div>
    <button id="btn-logout-index">Salir</button>
  `;
  document.getElementById('btn-logout-index').addEventListener('click', async () => {
    await window.auth.logout();
    window.api.sendAction('open-login');
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await window.auth.getSession();
  if (!session) {
    window.api.sendAction('open-login');
    return;
  }
  renderUserBadge(session);
  menuItems = ALL_MENU_ITEMS.filter((item) => item.roles.includes(session.role));
  if (menuItems.length === 0) menuItems = ALL_MENU_ITEMS.filter((item) => item.id === 'asistencia');

  const track = document.getElementById('carousel-track');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const infoBox = document.getElementById('selected-info');
  const viewport = document.querySelector('.carousel-viewport');

  if (!track) return;

  function buildCarousel() {
    track.innerHTML = '';

    menuItems.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-icon">${item.icon}</div>
        <div class="card-title">${item.title}</div>
        <div class="card-desc">${item.desc}</div>
      `;

      card.addEventListener('click', () => {
        if (isAnimating) return;
        if (index === currentIndex) {
          triggerAction(item);
        } else {
          currentIndex = index;
          updateCarousel();
        }
      });

      track.appendChild(card);
    });

    updateCarousel();
  }

  function updateCarousel() {
    const cards = track.children;
    if (cards.length === 0) return;

    const viewportWidth = viewport ? viewport.offsetWidth : 1000;
    const cardWidth = 230;
    const gap = 20;
    const itemTotalWidth = cardWidth + gap;

    const centerOffset = (viewportWidth / 2) - (cardWidth / 2);
    const offset = centerOffset - (currentIndex * itemTotalWidth);

    track.style.transform = `translateX(${offset}px)`;

    Array.from(cards).forEach((card, idx) => {
      if (idx === currentIndex) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });

    const activeItem = menuItems[currentIndex];
    if (infoBox && activeItem) {
      infoBox.textContent = `SECCIÓN ACTIVA: ${activeItem.title} — ${activeItem.desc}`;
    }
  }

  function triggerAction(item) {
    if (isAnimating) return;
    isAnimating = true;

    const activeCard = track.children[currentIndex];
    const container = document.querySelector('.app-container');

    if (infoBox) {
      infoBox.textContent = `ABRIENDO: ${item.title}...`;
    }

    track.classList.add('zooming');
    if (activeCard) activeCard.classList.add('zoom-in');
    if (container) container.classList.add('fade-out');

    setTimeout(() => {
      if (window.api && window.api.sendAction) {
        window.api.sendAction(item.action);
      } else {
        console.log(`Navegando a: ${item.action}`);
      }
    }, 550);
  }

  function next() {
    if (isAnimating) return;
    currentIndex = (currentIndex + 1) % menuItems.length;
    updateCarousel();
  }

  function prev() {
    if (isAnimating) return;
    currentIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
    updateCarousel();
  }

  if (prevBtn) prevBtn.addEventListener('click', prev);
  if (nextBtn) nextBtn.addEventListener('click', next);

  window.addEventListener('keydown', (e) => {
    if (isAnimating) return;
    if (e.key === 'ArrowRight' || e.key === 'd') next();
    if (e.key === 'ArrowLeft' || e.key === 'a') prev();
    if (e.key === 'Enter') triggerAction(menuItems[currentIndex]);
  });

  window.addEventListener('wheel', (e) => {
    if (isAnimating) return;
    if (e.deltaY > 30) next();
    else if (e.deltaY < -30) prev();
  });

  window.addEventListener('resize', updateCarousel);
  buildCarousel();
});
