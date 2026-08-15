// ==========================================================================
// ALERTA DE COCINA — comanda nueva (Supabase Realtime -> proceso principal
// -> este script). Se incluye en todas las pantallas principales porque
// main.js recarga la página entera al navegar (mainWindow.loadFile), así que
// cualquier estado de alarma tiene que poder "resumirse" al cargar cada
// página, no solo arrancar una vez.
// ==========================================================================
(function () {
  if (!window.orderAlertAPI) return; // preload no expuso el puente (no debería pasar)

  const LOOP_MS = 2000;
  const RAMP_MS = 30000; // tiempo para llegar al volumen máximo
  const VOLUME_MIN = 0.3;
  const MUTE_KEY = 'wh_order_alert_muted';
  const VOLUME_KEY = 'wh_order_alert_volume'; // 0..1, techo del volumen configurado por el usuario

  let audioCtx = null;
  let loopTimer = null;
  let currentAlert = null; // { id, tableNumber, clientType, folio, total, startedAt }
  let bannerEl = null;

  function isMuted() {
    return localStorage.getItem(MUTE_KEY) === '1';
  }

  function userVolumeCeiling() {
    const raw = Number(localStorage.getItem(VOLUME_KEY));
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 1;
    return raw;
  }

  function ensureAudioContext() {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    return audioCtx;
  }

  // "Ding-ding" sintetizado con dos tonos cortos (osciladores), sin depender
  // de ningún archivo de audio externo: no hace falta cargar/decodificar
  // nada y el volumen es controlable por muestra, lo que permite la rampa
  // progresiva pedida (0.3 -> 1.0 en 30s).
  function playChime(volume) {
    const ctx = ensureAudioContext();
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const notes = [
      { freq: 1046.5, start: 0.0 },  // Do6
      { freq: 1318.5, start: 0.18 }  // Mi6
    ];

    notes.forEach(({ freq, start }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;

      const t0 = now + start;
      const attack = 0.01;
      const decay = 0.28;

      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume, t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + attack + decay);

      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + attack + decay + 0.05);
    });
  }

  function currentRampVolume() {
    if (!currentAlert) return VOLUME_MIN;
    const elapsed = Date.now() - currentAlert.startedAt;
    const t = Math.min(Math.max(elapsed / RAMP_MS, 0), 1);
    const ramped = VOLUME_MIN + (1 - VOLUME_MIN) * t;
    return ramped * userVolumeCeiling();
  }

  function tick() {
    if (!currentAlert) return;
    if (!isMuted()) playChime(currentRampVolume());
  }

  function startLoop() {
    stopLoop();
    tick(); // suena de inmediato, no espera los primeros 2s
    loopTimer = setInterval(tick, LOOP_MS);
  }

  function stopLoop() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
  }

  function ensureStyles() {
    if (document.getElementById('order-alert-styles')) return;
    const style = document.createElement('style');
    style.id = 'order-alert-styles';
    style.textContent = `
      #order-alert-banner {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 99999;
        background: #1a0d00;
        border: 2px solid #ff8a00;
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.45);
        padding: 14px 18px;
        min-width: 260px;
        color: #fff;
        font-family: inherit;
        animation: order-alert-pulse 1s ease-in-out infinite;
      }
      @keyframes order-alert-pulse {
        0%, 100% { box-shadow: 0 8px 28px rgba(255,138,0,0.25); }
        50% { box-shadow: 0 8px 28px rgba(255,138,0,0.65); }
      }
      #order-alert-banner .oa-title {
        font-weight: 800;
        font-size: 0.95rem;
        margin-bottom: 4px;
      }
      #order-alert-banner .oa-detail {
        font-size: 0.8rem;
        color: #ffd9ad;
        margin-bottom: 10px;
      }
      #order-alert-banner .oa-actions {
        display: flex;
        gap: 8px;
      }
      #order-alert-banner button {
        flex: 1;
        border: none;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 0.8rem;
        font-weight: 700;
        cursor: pointer;
      }
      #order-alert-banner .oa-view {
        background: #ff8a00;
        color: #1a0d00;
      }
      #order-alert-banner .oa-accept {
        background: transparent;
        border: 1px solid #ff8a00;
        color: #ff8a00;
      }
    `;
    document.head.appendChild(style);
  }

  function describeAlert(alert) {
    if (alert.tableNumber) return `Mesa ${alert.tableNumber}`;
    if (alert.folio) return `Folio ${alert.folio}`;
    return `Comanda #${alert.id}`;
  }

  function showBanner(alert) {
    ensureStyles();
    removeBanner();

    bannerEl = document.createElement('div');
    bannerEl.id = 'order-alert-banner';
    bannerEl.innerHTML = `
      <div class="oa-title">🔔 Nueva comanda</div>
      <div class="oa-detail">${describeAlert(alert)} · $${alert.total.toFixed(2)}</div>
      <div class="oa-actions">
        <button type="button" class="oa-view">Ver pedido</button>
        <button type="button" class="oa-accept">Aceptar comanda</button>
      </div>
    `;
    document.body.appendChild(bannerEl);

    bannerEl.querySelector('.oa-view').addEventListener('click', () => {
      dismiss(alert.id);
      if (window.api && window.api.sendAction) {
        if (alert.tableNumber) {
          try { localStorage.setItem('wh_open_table_on_load', String(alert.tableNumber)); } catch (e) { /* ignore */ }
        }
        window.api.sendAction('open-comandas');
      }
    });

    bannerEl.querySelector('.oa-accept').addEventListener('click', () => {
      dismiss(alert.id);
    });
  }

  function removeBanner() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  function dismiss(saleId) {
    currentAlert = null;
    stopLoop();
    removeBanner();
    window.orderAlertAPI.dismiss(saleId);
  }

  function activate(alert) {
    if (!alert) return;
    if (currentAlert && currentAlert.id === alert.id) return; // ya está sonando este mismo pedido
    currentAlert = alert;
    showBanner(alert);
    startLoop();
  }

  window.orderAlertAPI.onStart((alert) => activate(alert));
  window.orderAlertAPI.onStop((saleId) => {
    if (currentAlert && currentAlert.id === saleId) {
      currentAlert = null;
      stopLoop();
      removeBanner();
    }
  });

  // Al cargar cualquier pantalla, si ya había una alerta activa (por
  // ejemplo, sonó mientras el usuario estaba en otro módulo), la retoma
  // usando el "startedAt" original para que el volumen siga la rampa real,
  // no una nueva de 0.3.
  window.orderAlertAPI.getActive().then((alert) => {
    if (alert) activate(alert);
  }).catch(() => {});
})();
