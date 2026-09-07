/** Shared client auth helpers for Prop Tax Scraper. */
(function (global) {
  const TOKEN_KEY = "propTax.jwt";
  const SAVED_USER_KEY = "propTax.savedUser";
  const SAVED_PASS_KEY = "propTax.savedPass";
  const USER_CACHE_KEY = "propTax.user";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function setCachedUser(user) {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_CACHE_KEY);
  }

  function getCachedUser() {
    try {
      const raw = localStorage.getItem(USER_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_CACHE_KEY);
  }

  function saveCredentials(username, password) {
    localStorage.setItem(SAVED_USER_KEY, username || "");
    localStorage.setItem(SAVED_PASS_KEY, password || "");
  }

  function clearSavedCredentials() {
    localStorage.removeItem(SAVED_USER_KEY);
    localStorage.removeItem(SAVED_PASS_KEY);
  }

  function loadSavedCredentials() {
    return {
      username: localStorage.getItem(SAVED_USER_KEY) || "",
      password: localStorage.getItem(SAVED_PASS_KEY) || "",
    };
  }

  function loginRedirect(nextPath) {
    const next = nextPath || window.location.pathname + window.location.search;
    window.location.href =
      "/login.html?next=" + encodeURIComponent(next || "/");
  }

  async function authFetch(url, options = {}) {
    const opts = { ...options };
    const headers = new Headers(opts.headers || {});
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (opts.body && !headers.has("Content-Type") && !(opts.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    opts.headers = headers;
    const res = await fetch(url, opts);
    if (res.status === 401) {
      clearAuth();
      loginRedirect();
      throw new Error("authentication required");
    }
    return res;
  }

  async function fetchMe() {
    const res = await authFetch("/api/auth/me");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load profile");
    setCachedUser(data.user);
    return data;
  }

  async function requireLogin() {
    if (!getToken()) {
      loginRedirect();
      return null;
    }
    try {
      return await fetchMe();
    } catch {
      clearAuth();
      loginRedirect();
      return null;
    }
  }

  async function requireAdminPage() {
    const me = await requireLogin();
    if (!me) return null;
    if (me.user.role !== "ADMIN") {
      window.location.href = "/";
      return null;
    }
    return me;
  }

  function logout() {
    clearAuth();
    window.location.href = "/login.html";
  }

  function displayName(user) {
    if (!user) return "";
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    return name || user.email || "User";
  }

  function renderAuthBar(container, me) {
    if (!container || !me?.user) return;
    const user = me.user;
    const adminLink =
      user.role === "ADMIN"
        ? `<a href="/admin.html" style="color:#58a6ff;text-decoration:none;margin-right:0.75rem;">Admin</a>`
        : "";
    container.innerHTML = `
      <span style="color:#8b949e;font-size:0.85rem;margin-right:0.75rem;">
        ${escapeHtml(displayName(user))}
        <span style="opacity:0.7;">(${escapeHtml(user.role)})</span>
      </span>
      ${adminLink}
      <button type="button" id="authLogoutBtn"
        style="background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:0.3rem 0.65rem;cursor:pointer;font-size:0.85rem;">
        Logout
      </button>`;
    const btn = container.querySelector("#authLogoutBtn");
    if (btn) btn.addEventListener("click", logout);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function accessStatusMap(me) {
    const grants = new Set();
    const pending = new Set();
    const denied = new Set();
    for (const g of me.grants || []) {
      grants.add(`${g.state}:${g.county}`);
    }
    for (const r of me.requests || []) {
      const key = `${r.state}:${r.county}`;
      if (r.status === "pending") pending.add(key);
      if (r.status === "denied") denied.add(key);
    }
    return { grants, pending, denied };
  }

  function countyAccessKey(state, slug) {
    return `${String(state).toUpperCase()}:${String(slug).toLowerCase()}`;
  }

  global.PropTaxAuth = {
    getToken,
    setToken,
    setCachedUser,
    getCachedUser,
    clearAuth,
    saveCredentials,
    clearSavedCredentials,
    loadSavedCredentials,
    authFetch,
    fetchMe,
    requireLogin,
    requireAdminPage,
    logout,
    displayName,
    renderAuthBar,
    accessStatusMap,
    countyAccessKey,
    loginRedirect,
  };
})(window);
