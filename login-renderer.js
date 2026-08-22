// Logo/tema (Ajustes -> SaaS): login.html no incluye common.js (no necesita
// guardSession/atajos), así que aquí se repite solo la parte de branding,
// leyendo primero la caché local (instantáneo, sirve sin conexión) y
// refrescando desde settings después. Mismo esquema que
// loadAndApplyBranding() en common.js -- si cambia allá, cambia aquí.
function applyLoginBranding() {
  try {
    const cached = JSON.parse(localStorage.getItem('wh_branding_cache') || 'null');
    if (cached) {
      if (cached.logoUrl) document.querySelectorAll('.login-logo').forEach((img) => (img.src = cached.logoUrl));
      if (cached.primaryColor) document.documentElement.style.setProperty('--brand-orange', cached.primaryColor);
      if (cached.secondaryColor) document.documentElement.style.setProperty('--brand-red', cached.secondaryColor);
    }
  } catch {
    // caché corrupta/ausente: se queda con el logo/colores default
  }

  if (window.db && window.db.settings) {
    window.db.settings.getAll().then((settings) => {
      if (settings.logo_url) {
        document.querySelectorAll('.login-logo').forEach((img) => (img.src = settings.logo_url));
      }
    }).catch(() => {
      // sin conexión al abrir el login: se queda con la caché/el default
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyLoginBranding();

  const loginForm = document.getElementById('login-form');
  const userInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const errorDiv = document.getElementById('login-error');
  const loginButton = document.getElementById('btn-login');

  if (!loginForm) return;

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = userInput?.value.trim() || '';
    const password = passwordInput?.value || '';

    hideError();

    if (!username || !password) {
      showError('Escribe el usuario y la contraseña.');
      return;
    }

    if (!window.auth || typeof window.auth.login !== 'function') {
      console.error('window.auth no está disponible. Revisa preload.js y contextIsolation.');
      showError('No está disponible el servicio de autenticación.');
      return;
    }

    try {
      if (loginButton) {
        loginButton.disabled = true;
        loginButton.textContent = 'Validando...';
      }

      const session = await window.auth.login(username, password);

      if (!session) {
        throw new Error('Supabase no devolvió una sesión válida.');
      }

      localStorage.setItem('currentUser', JSON.stringify(session));
      window.location.replace('index.html');
    } catch (err) {
      console.error('Error durante el inicio de sesión:', err);
      showError(normalizeLoginError(err));
    } finally {
      if (loginButton) {
        loginButton.disabled = false;
        loginButton.textContent = 'Entrar';
      }
    }
  });

  function normalizeLoginError(err) {
    const message = String(err?.message || err || '');

    if (/usuario o contraseña incorrectos/i.test(message)) {
      return 'Usuario o contraseña incorrectos.';
    }

    if (/failed to fetch|fetch failed|network|enotfound|timed out|timeout|connection|conectar/i.test(message)) {
      return 'No se pudo conectar con Supabase. Verifica Internet y la configuración de Supabase.';
    }

    return message || 'No se pudo iniciar sesión.';
  }

  function showError(msg) {
    if (!errorDiv) return;
    errorDiv.textContent = msg;
    errorDiv.style.display = 'block';
  }

  function hideError() {
    if (!errorDiv) return;
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';
  }
});
