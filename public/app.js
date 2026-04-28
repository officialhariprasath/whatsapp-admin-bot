const socket = io();

let dashboardData = [];
let allGroupsData = [];
let allSessionsData = [];
let currentSearch = "";
let deferredInstallPrompt = null;

// ---------------- AUTH ----------------
function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    "x-auth-token": localStorage.getItem("authToken") || "",
  };
}

function checkAuth() {
  if (!localStorage.getItem("authToken")) {
    window.location.href = "/login.html";
  }
}

function logout() {
  localStorage.removeItem("authToken");
  window.location.href = "/login.html";
}

// Socket.IO real-time updates
socket.on("dashboard-update", () => {
  loadDashboard();
  loadGroupsPage();
  loadAllSessions();
});

socket.on("connect", () => {
  console.log("Connected to dashboard");
});

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", () => {
  checkAuth();
  setupInstallPrompt();
  loadDashboard();
  loadGroupsPage();
  loadAllSessions();
  document.getElementById("sessionDate").value = new Date().toISOString().split("T")[0];
});

function setupInstallPrompt() {
  const btn = document.getElementById("installAppBtn");
  if (!btn) return;

  if (!window.matchMedia("(display-mode: standalone)").matches) {
    btn.style.display = "none";
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.style.display = "inline-flex";
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    btn.style.display = "none";
    showToast("App installed successfully!");
  });
}

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast("Install option not available. Use browser menu > Install app.", "error");
    return;
  }

  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById("installAppBtn").style.display = "none";

  if (choice.outcome !== "accepted") {
    showToast("Install cancelled", "error");
  }
}

// ---------------- TABS ----------------
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
  document.getElementById("pageTitle").textContent = titles[tabName];
}

// ---------------- TOAST ----------------
function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast " + type + " show";
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ---------------- DASHBOARD ----------------
async function loadDashboard() {
  try {
    const [statsRes, sessionsRes] = await Promise.all([
      fetch("/api/dashboard/stats", { headers: { "x-auth-token": localStorage.getItem("authToken") || "" } }),
      fetch("/api/dashboard/sessions", { headers: { "x-auth-token": localStorage.getItem("authToken") || "" } }),
    ]);
    if (statsRes.status === 401 || sessionsRes.status === 401) {
      logout();
      return;
    }
    const stats = await statsRes.json();
    const sessions = await sessionsRes.json();

    document.getElementById("statGroups").textContent = stats.totalGroups;
    document.getElementById("statActive").textContent = stats.activeSessions;
    document.getElementById("statEnded").textContent = stats.endedToday;
    document.getElementById("statMessages").textContent = stats.totalMessagesToday;

    dashboardData = sessions;
    renderDashboardTable();
  } catch (err) {
    console.error("Dashboard load error:", err);
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
      const liveCount =
        g.status === "receiving"
          ? `<span class="badge badge-receiving"><i class="fa-solid fa-bolt"></i> ${g.message_count}</span>`
          : g.message_count;
      const timesCsv = (g.times || []).join(",");

      return `
        <tr>
          <td><strong>${g.group_code}</strong></td>
          <td>${(g.times || []).join(", ")}</td>
          <td><span class="${statusClass}"><i class="fa-solid fa-circle" style="font-size:6px"></i> ${statusLabel}</span></td>
          <td>${g.slot || "-"}</td>
          <td>${liveCount}</td>
          <td>${g.owner_phone || "-"}</td>
          <td class="actions">
            <button class="btn btn-success btn-sm" onclick="downloadGroupReport('${g.group_code}')" title="Group Report"><i class="fa-solid fa-chart-bar"></i></button>
            ${downloadBtn}
          </td>
        </tr>
      `;
    })
    .join("");
}

function filterGroups() {
  currentSearch = document.getElementById("searchInput").value;
  renderDashboardTable();
}

// ---------------- GROUPS PAGE ----------------
async function loadGroupsPage() {
  try {
    const res = await fetch("/api/groups", { headers: { "x-auth-token": localStorage.getItem("authToken") || "" } });
    if (res.status === 401) { logout(); return; }
    allGroupsData = await res.json();
    const tbody = document.getElementById("groupsTable");

    if (!allGroupsData.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty">No groups yet</td></tr>`;
      return;
    }

    tbody.innerHTML = allGroupsData
      .map(
        (g) => `
        <tr>
          <td><strong>${g.code}</strong></td>
          <td>${g.times.join(", ")}</td>
          <td>${new Date(g.created_at).toLocaleDateString()}</td>
          <td class="actions">
            <button class="btn btn-primary btn-sm" onclick="openEditModal('${g.code}', '${g.times.join(",")}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="btn btn-danger btn-sm" onclick="deleteGroup('${g.code}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
            <button class="btn btn-success btn-sm" onclick="downloadGroupReport('${g.code}')" title="Group Report"><i class="fa-solid fa-chart-bar"></i></button>
          </td>
        </tr>
      `
      )
      .join("");
  } catch (err) {
    console.error("Groups load error:", err);
  }
}

async function addGroup() {
  const code = document.getElementById("groupCode").value.trim();
  const times = [...document.querySelectorAll("#tab-groups input[type=checkbox]:checked")].map((x) => x.value);

  if (!code || times.length === 0) {
    showToast("Please enter a group code and select at least one time slot.", "error");
    return;
  }

  try {
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ code, times }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.success) {
      showToast("Group added successfully!");
      document.getElementById("groupCode").value = "";
      document.querySelectorAll("#tab-groups input[type=checkbox]").forEach((c) => (c.checked = false));
      loadGroupsPage();
      loadDashboard();
    } else {
      showToast(data.error || "Failed to add group", "error");
    }
  } catch (err) {
    showToast("Error adding group", "error");
  }
}

async function deleteGroup(code) {
  if (!confirm(`Delete group "${code}"?`)) return;
  try {
    const res = await fetch("/api/groups/" + code, {
      method: "DELETE",
      headers: { "x-auth-token": localStorage.getItem("authToken") || "" },
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.success) {
      showToast("Group deleted!");
      loadGroupsPage();
      loadDashboard();
      loadAllSessions();
    } else {
      showToast(data.error || "Failed to delete", "error");
    }
  } catch (err) {
    showToast("Error deleting group", "error");
  }
}

// ---------------- EDIT MODAL ----------------
function openEditModal(code, timesCsv) {
  const times = timesCsv ? timesCsv.split(",") : [];
  document.getElementById("editOldCode").value = code;
  document.getElementById("editCode").value = code;
  document.querySelectorAll("#editCheckboxes input[type=checkbox]").forEach((cb) => {
    cb.checked = times.includes(cb.value);
  });
  document.getElementById("editModal").classList.add("show");
}

function closeModal() {
  document.getElementById("editModal").classList.remove("show");
}

async function saveEditGroup() {
  const oldCode = document.getElementById("editOldCode").value;
  const newCode = document.getElementById("editCode").value.trim();
  const times = [...document.querySelectorAll("#editCheckboxes input[type=checkbox]:checked")].map((x) => x.value);

  if (!newCode || times.length === 0) {
    showToast("Please enter a group code and select at least one time slot.", "error");
    return;
  }

  try {
    const res = await fetch("/api/groups/" + oldCode, {
      method: "PUT",
      headers: getAuthHeaders(),
      body: JSON.stringify({ newCode, times }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.success) {
      showToast("Group updated successfully!");
      closeModal();
      loadGroupsPage();
      loadDashboard();
    } else {
      showToast(data.error || "Failed to update group", "error");
    }
  } catch (err) {
    showToast("Error updating group", "error");
  }
}

// ---------------- ALL SESSIONS (RAW with duplicate numbering) ----------------
async function loadAllSessions() {
  try {
    const date = document.getElementById("sessionDate").value;
    const res = await fetch("/api/sessions/raw?date=" + (date || ""), {
      headers: { "x-auth-token": localStorage.getItem("authToken") || "" },
    });
    if (res.status === 401) { logout(); return; }
    const sessions = await res.json();
    const tbody = document.getElementById("sessionsTable");

    if (!sessions.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">No sessions found</td></tr>`;
      return;
    }

    // Compute duplicate numbering: (group_code + slot + session_date) occurrences
    const occurrenceMap = {};
    sessions.forEach((s) => {
      const key = `${s.group_code}_${s.slot}_${s.session_date}`;
      if (!occurrenceMap[key]) occurrenceMap[key] = 0;
      occurrenceMap[key]++;
    });

    const runningCount = {};
    tbody.innerHTML = sessions
      .map((s) => {
        const statusClass = "badge badge-" + s.status;
        const statusLabel = s.status.replace("_", " ");
        const downloadBtn =
          s.status === "excel_ready" && s.excel_path
            ? `<button class="btn btn-success btn-sm" onclick="downloadExcel(${s.id})"><i class="fa-solid fa-download"></i></button>`
            : "-";

        const key = `${s.group_code}_${s.slot}_${s.session_date}`;
        if (!runningCount[key]) runningCount[key] = 0;
        runningCount[key]++;
        const occ = occurrenceMap[key];
        const dupLabel = occ > 1 ? ` <span style="color:var(--warning);font-size:0.75rem;">(${runningCount[key]})</span>` : "";

        return `
          <tr>
            <td>#${s.id}</td>
            <td><strong>${s.group_code}</strong>${dupLabel}</td>
            <td>${s.slot}</td>
            <td><span class="${statusClass}">${statusLabel}</span></td>
            <td>${s.message_count}</td>
            <td>${s.owner_phone || "-"}</td>
            <td>${new Date(s.session_date).toLocaleDateString()}</td>
            <td>${downloadBtn}</td>
          </tr>
        `;
      })
      .join("");
  } catch (err) {
    console.error("Sessions load error:", err);
  }
}

// ---------------- DOWNLOAD ----------------
function downloadExcel(sessionId) {
  const token = localStorage.getItem("authToken") || "";
  window.open("/api/download/" + sessionId + "?token=" + encodeURIComponent(token), "_blank");
}

function downloadGroupReport(code) {
  const token = localStorage.getItem("authToken") || "";
  window.open("/api/report/group/" + code + "?token=" + encodeURIComponent(token), "_blank");
}

function downloadMasterReport() {
  const date = document.getElementById("sessionDate").value;
  if (!date) {
    showToast("Please select a date first", "error");
    return;
  }
  const token = localStorage.getItem("authToken") || "";
  window.open("/api/report/date/" + date + "?token=" + encodeURIComponent(token), "_blank");
}

// ---------------- SETTINGS ----------------
async function changePassword() {
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;

  if (!currentPassword || !newPassword || !confirmPassword) {
    showToast("Please fill all password fields", "error");
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast("New passwords do not match", "error");
    return;
  }

  try {
    const res = await fetch("/api/settings/password", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.success) {
      localStorage.setItem("authToken", data.token);
      showToast("Password changed successfully!");
      document.getElementById("currentPassword").value = "";
      document.getElementById("newPassword").value = "";
      document.getElementById("confirmPassword").value = "";
    } else {
      showToast(data.error || "Failed to change password", "error");
    }
  } catch (err) {
    showToast("Error changing password", "error");
  }
}

function showResetModal() {
  if (confirm("⚠️ WARNING: This will delete ALL groups, sessions, messages, and Excel files.\n\nThis action CANNOT be undone.\n\nAre you absolutely sure?")) {
    doReset();
  }
}

async function doReset() {
  try {
    const res = await fetch("/api/settings/reset", {
      method: "POST",
      headers: { "x-auth-token": localStorage.getItem("authToken") || "" },
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (data.success) {
      showToast("Application reset successfully!");
      loadDashboard();
      loadGroupsPage();
      loadAllSessions();
    } else {
      showToast(data.error || "Reset failed", "error");
    }
  } catch (err) {
    showToast("Error during reset", "error");
  }
}

// Close modal on outside click
document.getElementById("editModal").addEventListener("click", (e) => {
  if (e.target.id === "editModal") closeModal();
});
