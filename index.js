const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const FormData = require("form-data");
require("dotenv").config();

const db = require("./db");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use(express.static("public"));

const userState = {}; // temporary state for interactive selections

function today() {
  return new Date().toISOString().split("T")[0];
}

function emitUpdate() {
  io.emit("dashboard-update");
}

const EXPORTS_DIR = path.join(__dirname, "exports");
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function ensureExportsDir() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

async function uploadWhatsAppMediaForDocument(filePath, fileName) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", fs.createReadStream(filePath), {
    filename: fileName,
    contentType: XLSX_MIME,
  });
  form.append("type", XLSX_MIME);

  const { data } = await axios.post(
    `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );
  if (!data.id) {
    throw new Error(`WhatsApp media upload: ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function sendWhatsAppDocumentMessage(to, mediaId, fileName, caption) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: {
        id: mediaId,
        filename: fileName,
        ...(caption ? { caption } : {}),
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ---------------- AUTH MIDDLEWARE ----------------
async function requireAuth(req, res, next) {
  const token = req.headers["x-auth-token"] || req.query.token;
  const adminPassword = await db.getSetting("admin_password");
  if (token === adminPassword) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

// ---------------- WEBHOOK VERIFY ----------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ---------------- RECEIVE WEBHOOK ----------------
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;

    if (msg.type === "text") {
      const text = msg.text.body.trim();

      if (text.toLowerCase() === "/start") {
        await sendGroupList(from);
      } else if (text.toLowerCase() === "/end") {
        await finishSession(from);
      } else {
        const session = await db.getActiveSession(from, today());
        if (session) {
          await db.addMessage(session.id, text);
          emitUpdate();
        }
      }
    }

    if (msg.type === "interactive") {
      const reply = msg.interactive.list_reply.id;

      if (reply.startsWith("GROUP_")) {
        const code = reply.replace("GROUP_", "");
        userState[from] = { group: code };
        await sendTimeList(from, code);
      } else if (reply.startsWith("TIME_")) {
        const slot = reply.replace("TIME_", "");
        const group = userState[from]?.group;
        if (!group) return res.sendStatus(200);

        const existing = await db.getSessionByKey(group, slot, today());
        if (existing && ["started", "receiving"].includes(existing.status)) {
          await sendText(from, `${group} for ${slot} is already active by another admin.`);
        } else {
          await db.createSession(group, slot, from, today());
          await sendText(from, `✅ Session started for ${group} - ${slot}\nForward messages now.\nSend /end when finished.`);
          emitUpdate();
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    console.error("Webhook stack:", err.stack);
    res.sendStatus(500);
  }
});

// ---------------- SEND GROUP LIST ----------------
async function sendGroupList(to) {
  const groups = await db.getGroups();
  const rows = groups.map((g) => ({ id: "GROUP_" + g.code, title: g.code }));
  await sendList(to, "Select Group", "Choose group", rows);
}

// ---------------- SEND TIME LIST ----------------
async function sendTimeList(to, code) {
  const group = await db.getGroup(code);
  if (!group) return;
  const rows = group.times.map((t) => ({ id: "TIME_" + t, title: t }));
  await sendList(to, `Timings for ${code}`, "Choose slot", rows);
}

// ---------------- GENERIC LIST ----------------
async function sendList(to, title, body, rows) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: title },
        body: { text: body },
        action: { button: "Open List", sections: [{ title: "Options", rows }] },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ---------------- SEND TEXT ----------------
async function sendText(to, body) {
  await axios.post(
    `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ---------------- END SESSION ----------------
async function finishSession(from) {
  const session = await db.getActiveSession(from, today());
  if (!session) {
    await sendText(from, "❌ No active session.");
    return;
  }

  const messages = await db.getMessages(session.id);
  const data = messages.map((m, i) => ({ SNo: i + 1, Message: m.content }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ SNo: "-", Message: "(no messages)" }]);
  XLSX.utils.book_append_sheet(wb, ws, "Messages");

  const fileName = `${session.id}_${session.group_code}_${today()}_${session.slot}.xlsx`;
  ensureExportsDir();
  const filePath = path.join(EXPORTS_DIR, fileName);
  XLSX.writeFile(wb, filePath);

  await db.endSession(session.id, filePath);
  emitUpdate();

  const caption = `✅ ${data.length} message(s)`;
  try {
    const mediaId = await uploadWhatsAppMediaForDocument(filePath, fileName);
    await sendWhatsAppDocumentMessage(from, mediaId, fileName, caption);
  } catch (err) {
    console.error("finishSession document send:", err.response?.data || err.message || err);
    await sendText(
      from,
      `✅ Excel saved: ${fileName}\nMessages: ${data.length}\n` +
        `Download: open your web dashboard → Sessions tab → Excel button.\n` +
        `(If you expected the file here, check server logs — Meta media upload may need permissions.)`
    );
  }
}

// ---------------- AUTH: LOGIN ----------------
app.post("/api/login", async (req, res) => {
  try {
    const { password } = req.body;
    const adminPassword = await db.getSetting("admin_password");
    if (password === adminPassword) {
      res.json({ success: true, token: adminPassword });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- API: GROUPS (Protected) ----------------
app.get("/api/groups", requireAuth, async (req, res) => {
  try {
    const groups = await db.getGroups();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/groups", requireAuth, async (req, res) => {
  try {
    const { code, times } = req.body;
    if (!code || !Array.isArray(times) || times.length === 0) {
      return res.status(400).json({ error: "Invalid group data" });
    }
    await db.addGroup(code.trim().toUpperCase(), times);
    emitUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/groups/:code", requireAuth, async (req, res) => {
  try {
    const { newCode, times } = req.body;
    if (!newCode || !Array.isArray(times) || times.length === 0) {
      return res.status(400).json({ error: "Invalid group data" });
    }
    await db.updateGroup(req.params.code, newCode.trim().toUpperCase(), times);
    emitUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/groups/:code", requireAuth, async (req, res) => {
  try {
    await db.deleteGroup(req.params.code);
    emitUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- API: DASHBOARD ----------------
app.get("/api/dashboard/sessions", requireAuth, async (req, res) => {
  try {
    const date = req.query.date || today();
    const sessions = await db.getSessions(date);

    const groups = await db.getGroups();
    const groupMap = {};
    groups.forEach((g) => (groupMap[g.code] = g));

    // Enrich with group status
    const result = groups.map((g) => {
      const todaySession = sessions.find((s) => s.group_code === g.code);
      return {
        group_code: g.code,
        times: g.times,
        status: todaySession ? todaySession.status : "idle",
        session_id: todaySession ? todaySession.id : null,
        slot: todaySession ? todaySession.slot : null,
        message_count: todaySession ? todaySession.message_count : 0,
        excel_path: todaySession ? todaySession.excel_path : null,
        owner_phone: todaySession ? todaySession.owner_phone : null,
        created_at: todaySession ? todaySession.created_at : null,
        ended_at: todaySession ? todaySession.ended_at : null,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dashboard/sessions/:id", requireAuth, async (req, res) => {
  try {
    const session = await db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const messages = await db.getMessages(session.id);
    res.json({ ...session, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dashboard/stats", requireAuth, async (req, res) => {
  try {
    const stats = await db.getDashboardStats(today());
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download/:sessionId", requireAuth, async (req, res) => {
  try {
    const session = await db.getSessionById(req.params.sessionId);
    if (!session || !session.excel_path || !fs.existsSync(session.excel_path)) {
      return res.status(404).json({ error: "File not found" });
    }
    res.download(session.excel_path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- REPORT: GROUP SESSIONS ----------------
app.get("/api/report/group/:code", requireAuth, async (req, res) => {
  try {
    const group = await db.getGroup(req.params.code);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const sessions = await db.getSessionsByGroup(req.params.code);

    const data = sessions.map((s) => ({
      "Session ID": s.id,
      "Date": s.session_date,
      "Slot": s.slot,
      "Status": s.status.replace("_", " "),
      "Messages": s.message_count,
      "Owner Phone": s.owner_phone,
      "Created At": s.created_at ? new Date(s.created_at).toLocaleString() : "-",
      "Ended At": s.ended_at ? new Date(s.ended_at).toLocaleString() : "-",
      "Excel Available": s.excel_path && fs.existsSync(s.excel_path) ? "Yes" : "No",
    }));

    if (data.length === 0) {
      data.push({ "Session ID": "-", "Date": "-", "Slot": "-", "Status": "No sessions yet", "Messages": 0, "Owner Phone": "-", "Created At": "-", "Ended At": "-", "Excel Available": "-" });
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, "Group Report");

    const fileName = `report_group_${group.code}_${today()}.xlsx`;
    ensureExportsDir();
    const filePath = path.join(EXPORTS_DIR, fileName);
    XLSX.writeFile(wb, filePath);

    res.download(filePath, fileName);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- REPORT: MASTER DATE REPORT ----------------
app.get("/api/report/date/:date", requireAuth, async (req, res) => {
  try {
    const date = req.params.date;
    const sessions = await db.getSessionsByDate(date);
    const groups = await db.getGroups();

    // Build a map of sessions by group
    const sessionMap = {};
    sessions.forEach((s) => {
      if (!sessionMap[s.group_code]) sessionMap[s.group_code] = [];
      sessionMap[s.group_code].push(s);
    });

    // Build master report: include ALL groups (even idle ones)
    const data = groups.map((g) => {
      const groupSessions = sessionMap[g.code] || [];
      if (groupSessions.length === 0) {
        return {
          "Group Code": g.code,
          "Time Slots": g.times.join(", "),
          "Session ID": "-",
          "Slot": "-",
          "Status": "idle",
          "Messages": 0,
          "Owner Phone": "-",
          "Created At": "-",
          "Ended At": "-",
          "Excel Available": "No",
        };
      }
      // For groups with multiple sessions on same date, list first one (or we could list all)
      const s = groupSessions[0];
      return {
        "Group Code": g.code,
        "Time Slots": g.times.join(", "),
        "Session ID": s.id,
        "Slot": s.slot,
        "Status": s.status.replace("_", " "),
        "Messages": s.message_count,
        "Owner Phone": s.owner_phone,
        "Created At": s.created_at ? new Date(s.created_at).toLocaleString() : "-",
        "Ended At": s.ended_at ? new Date(s.ended_at).toLocaleString() : "-",
        "Excel Available": s.excel_path && fs.existsSync(s.excel_path) ? "Yes" : "No",
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, "Master Report");

    const fileName = `report_master_${date}.xlsx`;
    ensureExportsDir();
    const filePath = path.join(EXPORTS_DIR, fileName);
    XLSX.writeFile(wb, filePath);

    res.download(filePath, fileName);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- API: RAW SESSIONS (for history tab) ----------------
app.get("/api/sessions/raw", requireAuth, async (req, res) => {
  try {
    const date = req.query.date || today();
    const sessions = await db.getSessions(date);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- API: SETTINGS ----------------
app.post("/api/settings/reset", requireAuth, async (req, res) => {
  try {
    // Delete all exported Excel files
    ensureExportsDir();
    const exportsDir = EXPORTS_DIR;
    const files = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
    for (const file of files) {
      if (file.endsWith(".xlsx")) {
        fs.unlinkSync(path.join(exportsDir, file));
      }
    }

    // Reset database
    await db.resetDatabase();

    // Re-insert default admin password
    await db.setSetting("admin_password", process.env.ADMIN_PASSWORD || "admin123");

    emitUpdate();
    res.json({ success: true, message: "Application reset successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/settings/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const adminPassword = await db.getSetting("admin_password");

    if (currentPassword !== adminPassword) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: "New password must be at least 4 characters" });
    }

    await db.setSetting("admin_password", newPassword);
    res.json({ success: true, token: newPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
  console.log("Dashboard client connected");
  socket.on("disconnect", () => console.log("Dashboard client disconnected"));
});

// ---------------- START ----------------
(async () => {
  try {
    await db.init();
    await db.initTables();
    ensureExportsDir();
    httpServer.listen(process.env.PORT, () => {
      console.log(`🚀 Server running on port ${process.env.PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err && err.stack ? err.stack : err);
    console.error(
      "Check DATABASE_URL on Render (Web Service → Environment), or local .env. PostgreSQL must be reachable."
    );
    process.exit(1);
  }
})();
