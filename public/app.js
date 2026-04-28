const socket = io();

let dashboardData = [];
let allGroupsData = [];
let agentsData = [];
let currentSearch = "";
let deferredInstallPrompt = null;
let pwaUpdatePending = false;
let pwaUpdateDismissed = false;
let lastUserActivityAt = Date.now();
const userRole = localStorage.getItem("userRole") || "admin";

function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    "x-auth-token": localStorage.getItem("authToken") || "",
  };
}

function checkAuth() {
  if (!localStorage.getItem("authToken")) window.location.href = "/login.html";
}

function logout() {
  localStorage.removeItem("authToken");
  localStorage.removeItem("userRole");
  localStorage.removeItem("agentId");
  window.location.href = "/login.html";
}

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast " + type + " show";
  setTimeout(() => toast.classList.remove("show"), 3000);
}

function toggleSidebar() {
  document.body.classList.toggle("mobile-sidebar-open");
}

function closeSidebar() {
  document.body.classList.remove("mobile-sidebar-open");
}

function applyRoleUI() {
  const isAdmin = userRole === "admin";
  document.querySelectorAll(".js-admin-only").forEach((el) => {
    el.style.display = isAdmin ? "" : "none";
  });
  document.querySelectorAll(".js-agent-only").forEach((el) => {
    el.style.display = isAdmin ? "none" : "";
  });
}

function switchTab(tabName, el) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".sidebar nav a").forEach((a) => a.classList.remove("active"));
  document.getElementById("tab-" + tabName).classList.add("active");
  el.classList.add("active");
  const titles = {
    dashboard: "Dashboard",
    groups: "Groups",
    sessions: "Session History",
    settings: "Settings",
  };
  document.getElementById("pageTitle").textContent = titles[tabName] || "Dashboard";
  closeSidebar();
}

function refreshApp() {
  window.location.reload();
}

function setupInstallPrompt() {
  const btn = document.getElementById("installAppBtn");
  const hint = document.getElementById("installHint");
  if (!btn) return;

  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  if (standalone) {
    btn.disabled = true;
    btn.classList.add("btn-secondary");
    btn.classList.remove("btn-success");
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Installed';
    if (hint) hint.textContent = "You are already running the installed app.";
    return;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (hint) hint.textContent = "Install is available—tap Install App or use browser menu.";
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    showToast("App installed successfully!");
    btn.disabled = true;
    btn.classList.add("btn-secondary");
    btn.classList.remove("btn-success");
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Installed';
  });
}

async function installApp() {
  if (window.matchMedia("(display-mode: standalone)").matches) return;
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    return;
  }
  showToast(
    "Install prompt not provided by browser. Use browser menu to install.",
    "error"
  );
}

function normalizeDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function getSelectedAgentIds(containerSelector) {
  return [...document.querySelectorAll(`${containerSelector} input[type=checkbox]:checked`)]
    .map((c) => Number(c.value))
    .filter((n) => Number.isFinite(n));
}

function renderAgentCheckboxes(containerId, selected = []) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  if (!agentsData.length) {
    wrap.innerHTML = `<small style="color:var(--text-muted);">No agents created yet.</small>`;
    return;
  }
  wrap.innerHTML = agentsData
    .map(
      (a) => `<label class="checkbox-label"><input type="checkbox" value="${a.id}" ${
        selected.includes(a.id) ? "checked" : ""
      }> ${a.phone}</label>`
    )
    .join("");
}

socket.on("dashboard-update", () => {
  loadDashboard();
  if (userRole === "admin") loadGroupsPage();
  loadAllSessions();
});

document.addEventListener("DOMContentLoaded", async () => {
  checkAuth();
  applyRoleUI();
  setupInstallPrompt();
  setupPwaUpdateUX();
  document.getElementById("sessionDate").value = new Date().toISOString().split("T")[0];
  if (userRole === "admin") await loadAgents();
  await loadDashboard();
  if (userRole === "admin") await loadGroupsPage();
  await loadAllSessions();
});

function setupPwaUpdateUX() {
  ["click", "keydown", "touchstart", "mousemove", "scroll"].forEach((ev) => {
    window.addEventListener(
      ev,
      () => {
        lastUserActivityAt = Date.now();
      },
      { passive: true }
    );
  });

  document.addEventListener("pwa:update-available", () => {
    pwaUpdatePending = true;
    pwaUpdateDismissed = false;
    showUpdateBanner();
  });

  document.addEventListener("pwa:update-applied", () => {
    pwaUpdatePending = false;
    hideUpdateBanner();
  });

  // Safe auto-refresh: only when update is pending, visible tab, and idle for 60s.
  setInterval(() => {
    if (!pwaUpdatePending || pwaUpdateDismissed) return;
    if (document.hidden) return;
    const idleMs = Date.now() - lastUserActivityAt;
    if (idleMs >= 60_000) {
      applyPwaUpdate();
    }
  }, 10_000);
}

function showUpdateBanner() {
  const b = document.getElementById("updateBanner");
  if (!b) return;
  b.style.display = "flex";
}

function hideUpdateBanner() {
  const b = document.getElementById("updateBanner");
  if (!b) return;
  b.style.display = "none";
}

function dismissPwaUpdate() {
  pwaUpdateDismissed = true;
  hideUpdateBanner();
}

function applyPwaUpdate() {
  try {
    const ok = typeof window.__applyPwaUpdate === "function" && window.__applyPwaUpdate();
    if (!ok) {
      showToast("Checking for update... please try again in a moment.", "error");
    }
  } catch {
    showToast("Unable to apply update right now.", "error");
  }
}

async function loadDashboard() {
  try {
    const [statsRes, sessionsRes] = await Promise.all([
      fetch("/api/dashboard/stats", { headers: getAuthHeaders() }),
      fetch("/api/dashboard/sessions", { headers: getAuthHeaders() }),
    ]);
    if (statsRes.status === 401 || sessionsRes.status === 401) return logout();

    const stats = await statsRes.json();
    dashboardData = await sessionsRes.json();

    document.getElementById("statGroups").textContent = stats.totalGroups;
    document.getElementById("statActive").textContent = stats.activeSessions;
    document.getElementById("statEnded").textContent = stats.endedToday;
    document.getElementById("statMessages").textContent = stats.totalMessagesToday;

    renderDashboardTable();
  } catch (err) {
    console.error(err);
  }
}

function renderDashboardTable() {
  const tbody = document.getElementById("dashboardTable");
  const filtered = dashboardData.filter((g) =>
    g.group_code.toLowerCase().includes(currentSearch.toLowerCase())
  );
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No groups found</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered
    .map((g) => {
      const statusClass = "badge badge-" + g.status;
      const statusLabel = g.status.replace("_", " ");
      const downloadBtn =
        g.status === "excel_ready" && g.session_id
          ? `<button class="btn btn-success btn-sm" onclick="downloadExcel(${g.session_id})"><i class="fa-solid fa-download"></i> Excel</button>`
          : "";
      return `
      <tr>
        <td><strong>${g.group_code}</strong></td>
        <td>${(g.times || []).join(", ")}</td>
        <td><span class="${statusClass}">${statusLabel}</span></td>
        <td>${g.slot || "-"}</td>
        <td>${g.message_count || 0}</td>
        <td>${g.owner_phone || "-"}</td>
        <td class="actions">
          <button class="btn btn-success btn-sm" onclick="downloadGroupReport('${g.group_code}')" title="Group Report"><i class="fa-solid fa-chart-bar"></i></button>
          ${downloadBtn}
        </td>
      </tr>`;
    })
    .join("");
}

function filterGroups() {
  currentSearch = document.getElementById("searchInput").value || "";
  renderDashboardTable();
}

async function loadAgents() {
  if (userRole !== "admin") return;
  const res = await fetch("/api/agents", { headers: getAuthHeaders() });
  if (res.status === 401) return logout();
  if (res.status === 403) return;
  agentsData = await res.json();
  renderAgentCheckboxes("addGroupAgentCheckboxes");
  renderAgentsTable();
}

function renderAgentsTable() {
  const tbody = document.getElementById("agentsAdminTable");
  if (!tbody) return;
  if (!agentsData.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">No agents yet</td></tr>`;
    return;
  }
  tbody.innerHTML = agentsData
    .map(
      (a) => `<tr>
      <td>#${a.id}</td>
      <td>${a.phone}</td>
      <td>${new Date(a.created_at).toLocaleDateString()}</td>
      <td class="actions">
        <button class="btn btn-secondary btn-sm" onclick="resetAgentPassword(${a.id})"><i class="fa-solid fa-key"></i> Reset pwd</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAgent(${a.id})"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`
    )
    .join("");
}

async function createAgent() {
  const phone = normalizeDigits(document.getElementById("newAgentPhone").value);
  const password = document.getElementById("newAgentPassword").value;
  if (!phone || !password || password.length < 4) {
    return showToast("Enter phone and password (min 4 chars).", "error");
  }
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to create agent", "error");
  showToast("Agent created");
  document.getElementById("newAgentPhone").value = "";
  document.getElementById("newAgentPassword").value = "";
  await loadAgents();
  await loadGroupsPage();
}

async function deleteAgent(id) {
  if (!confirm("Delete this agent?")) return;
  const res = await fetch(`/api/agents/${id}`, { method: "DELETE", headers: getAuthHeaders() });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to delete agent", "error");
  showToast("Agent deleted");
  await loadAgents();
  await loadGroupsPage();
}

async function resetAgentPassword(id) {
  const newPassword = prompt("Enter new password for this agent (min 4 chars):");
  if (!newPassword) return;
  const res = await fetch(`/api/agents/${id}/reset-password`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ newPassword }),
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Reset failed", "error");
  showToast("Agent password reset");
}

function selectedAgentNames(agentIds = []) {
  if (!agentIds.length) return "<span style='color:var(--text-muted)'>Unassigned</span>";
  return agentIds
    .map((id) => agentsData.find((a) => a.id === Number(id))?.phone || `#${id}`)
    .join(", ");
}

async function loadGroupsPage() {
  if (userRole !== "admin") return;
  const res = await fetch("/api/groups", { headers: getAuthHeaders() });
  if (res.status === 401) return logout();
  allGroupsData = await res.json();
  const tbody = document.getElementById("groupsTable");
  if (!allGroupsData.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">No groups yet</td></tr>`;
    return;
  }
  tbody.innerHTML = allGroupsData
    .map(
      (g) => `<tr>
      <td><strong>${g.code}</strong></td>
      <td>${g.times.join(", ")}</td>
      <td>${selectedAgentNames(g.agent_ids || [])}</td>
      <td>${new Date(g.created_at).toLocaleDateString()}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm" onclick="openEditModal('${g.code}', '${g.times.join(",")}', '${(g.agent_ids || []).join(",")}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteGroup('${g.code}')"><i class="fa-solid fa-trash"></i></button>
        <button class="btn btn-success btn-sm" onclick="downloadGroupReport('${g.code}')"><i class="fa-solid fa-chart-bar"></i></button>
      </td>
    </tr>`
    )
    .join("");
}

async function addGroup() {
  const code = document.getElementById("groupCode").value.trim();
  const times = [...document.querySelectorAll("#tab-groups input[type=checkbox]:checked")].map((x) => x.value);
  const agentIds = getSelectedAgentIds("#addGroupAgentCheckboxes");
  if (!code || !times.length) return showToast("Enter group code and select time slots.", "error");

  const res = await fetch("/api/groups", {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ code, times, agentIds }),
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to add group", "error");

  showToast("Group added successfully");
  document.getElementById("groupCode").value = "";
  document.querySelectorAll("#tab-groups input[type=checkbox]").forEach((c) => (c.checked = false));
  document.querySelectorAll("#addGroupAgentCheckboxes input[type=checkbox]").forEach((c) => (c.checked = false));
  await loadGroupsPage();
  await loadDashboard();
}

async function deleteGroup(code) {
  if (!confirm(`Delete group "${code}"?`)) return;
  const res = await fetch(`/api/groups/${code}`, { method: "DELETE", headers: getAuthHeaders() });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to delete", "error");
  showToast("Group deleted");
  await loadGroupsPage();
  await loadDashboard();
  await loadAllSessions();
}

function openEditModal(code, timesCsv, agentCsv = "") {
  const times = timesCsv ? timesCsv.split(",") : [];
  const selected = agentCsv ? agentCsv.split(",").filter(Boolean).map(Number) : [];
  document.getElementById("editOldCode").value = code;
  document.getElementById("editCode").value = code;
  document.querySelectorAll("#editCheckboxes input[type=checkbox]").forEach((cb) => {
    cb.checked = times.includes(cb.value);
  });
  renderAgentCheckboxes("editGroupAgentCheckboxes", selected);
  document.getElementById("editModal").classList.add("show");
}

function closeModal() {
  document.getElementById("editModal").classList.remove("show");
}

async function saveEditGroup() {
  const oldCode = document.getElementById("editOldCode").value;
  const newCode = document.getElementById("editCode").value.trim();
  const times = [...document.querySelectorAll("#editCheckboxes input[type=checkbox]:checked")].map((x) => x.value);
  const agentIds = getSelectedAgentIds("#editGroupAgentCheckboxes");
  if (!newCode || !times.length) return showToast("Enter group code and select time slots.", "error");

  const res = await fetch(`/api/groups/${oldCode}`, {
    method: "PUT",
    headers: getAuthHeaders(),
    body: JSON.stringify({ newCode, times, agentIds }),
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to update group", "error");
  showToast("Group updated");
  closeModal();
  await loadGroupsPage();
  await loadDashboard();
}

async function loadAllSessions() {
  const date = document.getElementById("sessionDate").value;
  const res = await fetch("/api/sessions/raw?date=" + (date || ""), { headers: getAuthHeaders() });
  if (res.status === 401) return logout();
  const sessions = await res.json();
  const tbody = document.getElementById("sessionsTable");
  if (!sessions.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No sessions found</td></tr>`;
    return;
  }
  tbody.innerHTML = sessions
    .map((s) => {
      const statusClass = "badge badge-" + s.status;
      const statusLabel = s.status.replace("_", " ");
      const downloadBtn =
        s.status === "excel_ready" && s.excel_path
          ? `<button class="btn btn-success btn-sm" onclick="downloadExcel(${s.id})"><i class="fa-solid fa-download"></i></button>`
          : "-";
      return `<tr>
        <td>#${s.id}</td>
        <td><strong>${s.group_code}</strong></td>
        <td>${s.slot}</td>
        <td><span class="${statusClass}">${statusLabel}</span></td>
        <td>${s.message_count}</td>
        <td>${s.owner_phone || "-"}</td>
        <td>${new Date(s.session_date).toLocaleDateString()}</td>
        <td>${downloadBtn}</td>
      </tr>`;
    })
    .join("");
}

function downloadExcel(sessionId) {
  const token = localStorage.getItem("authToken") || "";
  window.open(`/api/download/${sessionId}?token=${encodeURIComponent(token)}`, "_blank");
}

function downloadGroupReport(code) {
  const token = localStorage.getItem("authToken") || "";
  window.open(`/api/report/group/${code}?token=${encodeURIComponent(token)}`, "_blank");
}

function downloadMasterReport() {
  const date = document.getElementById("sessionDate").value;
  if (!date) return showToast("Please select a date first", "error");
  const token = localStorage.getItem("authToken") || "";
  window.open(`/api/report/date/${date}?token=${encodeURIComponent(token)}`, "_blank");
}

async function changePassword() {
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return showToast("Please fill all password fields", "error");
  }
  if (newPassword !== confirmPassword) return showToast("Passwords do not match", "error");

  const res = await fetch("/api/settings/password", {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to change password", "error");
  localStorage.setItem("authToken", data.token);
  showToast("Password changed");
  document.getElementById("currentPassword").value = "";
  document.getElementById("newPassword").value = "";
  document.getElementById("confirmPassword").value = "";
}

async function changeAgentPassword() {
  const currentPassword = document.getElementById("agentCurrentPassword").value;
  const newPassword = document.getElementById("agentNewPassword").value;
  const confirmPassword = document.getElementById("agentConfirmPassword").value;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return showToast("Please fill all password fields", "error");
  }
  if (newPassword !== confirmPassword) return showToast("Passwords do not match", "error");

  const res = await fetch("/api/agent/change-password", {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Failed to change password", "error");
  localStorage.setItem("authToken", data.token);
  showToast("Agent password changed");
  document.getElementById("agentCurrentPassword").value = "";
  document.getElementById("agentNewPassword").value = "";
  document.getElementById("agentConfirmPassword").value = "";
}

function showResetModal() {
  if (
    confirm(
      "⚠️ WARNING: This will delete ALL groups, sessions, messages, and Excel files.\n\nThis action CANNOT be undone.\n\nAre you absolutely sure?"
    )
  ) {
    doReset();
  }
}

async function doReset() {
  const res = await fetch("/api/settings/reset", { method: "POST", headers: getAuthHeaders() });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || "Reset failed", "error");
  showToast("Application reset successfully");
  await loadDashboard();
  if (userRole === "admin") await loadGroupsPage();
  await loadAllSessions();
}

document.getElementById("editModal").addEventListener("click", (e) => {
  if (e.target.id === "editModal") closeModal();
});
