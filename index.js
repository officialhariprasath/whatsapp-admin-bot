const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const FormData = require("form-data");
const JSZip = require("jszip");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
require("dotenv").config();

const db = require("./db");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

app.get("/group/:code/slots", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(express.static("public"));

const userState = {}; // temporary state for interactive selections

function today() {
  return new Date().toISOString().split("T")[0];
}

function emitUpdate() {
  io.emit("dashboard-update");
}

const EXPORTS_DIR = path.join(__dirname, "exports");
const BILLS_DIR = path.join(__dirname, "uploads", "bills");
const SESSION_TEMPLATE_PATH = path.join(__dirname, "template_excel", "lottery_output.xlsm");
const XLSM_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12";
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function ensureExportsDir() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

function ensureBillsDir() {
  fs.mkdirSync(BILLS_DIR, { recursive: true });
}

function mimeFromBillPath(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[ext] || "application/octet-stream";
}

const billImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureBillsDir();
      cb(null, BILLS_DIR);
    },
    filename: (req, file, cb) => {
      const id = String(req.params.id || "0");
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext) ? ext : ".jpg";
      cb(null, `bill_${id}_${Date.now()}${safeExt}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, GIF, or WebP images are allowed"));
  },
});

async function loadSessionBillForRequest(req, res) {
  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session" });
    return null;
  }
  const session = await db.getSessionById(sessionId);
  if (!session || !session.bill_image_path || !fs.existsSync(session.bill_image_path)) {
    res.status(404).json({ error: "Bill not found" });
    return null;
  }
  if (
    req.user.role === "agent" &&
    !(await db.agentCanAccessGroup(req.user.agentId, session.group_code))
  ) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return session;
}

async function uploadWhatsAppMediaForDocument(filePath, fileName) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", fs.createReadStream(filePath), {
    filename: fileName,
    contentType: XLSM_MIME,
  });
  form.append("type", XLSM_MIME);

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

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function colFromRef(cellRef = "") {
  return (cellRef.match(/^[A-Z]+/) || [""])[0];
}

function rowFromRef(cellRef = "") {
  return Number((cellRef.match(/\d+$/) || ["0"])[0]);
}

async function buildSessionWorkbookFromTemplate(messages, outputPath) {
  if (!fs.existsSync(SESSION_TEMPLATE_PATH)) {
    throw new Error(`Session template not found: ${SESSION_TEMPLATE_PATH}`);
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(SESSION_TEMPLATE_PATH));
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");

  const workbook = xmlParser.parse(workbookXml);
  const rels = xmlParser.parse(relsXml);

  const sheets = asArray(workbook.workbook?.sheets?.sheet);
  const targetSheet = sheets.find((s) => s["@_name"] === "Raw_Output");
  if (!targetSheet) throw new Error("Template sheet 'Raw_Output' not found");

  const targetRelId = targetSheet["@_r:id"];
  const relationships = asArray(rels.Relationships?.Relationship);
  const targetRel = relationships.find((r) => r["@_Id"] === targetRelId);
  if (!targetRel) throw new Error("Raw_Output relationship not found in workbook.xml.rels");

  const sheetPath = path.posix.join("xl", targetRel["@_Target"].replace(/^\/+/, ""));
  const sheetXml = await zip.file(sheetPath).async("string");
  const wsObj = xmlParser.parse(sheetXml);
  const worksheet = wsObj.worksheet;
  if (!worksheet?.sheetData) throw new Error("Raw_Output sheetData missing in template");

  const rows = asArray(worksheet.sheetData.row);
  const rowMap = new Map(rows.map((r) => [Number(r["@_r"] || 0), r]));

  // Clear previous generated values only in A/B columns from row 2 onwards.
  rows.forEach((row) => {
    const rowNum = Number(row["@_r"] || 0);
    if (rowNum < 2 || !row.c) return;
    const cells = asArray(row.c).filter((c) => {
      const col = colFromRef(c["@_r"]);
      return !(col === "A" || col === "B");
    });
    if (cells.length === 0) delete row.c;
    else row.c = cells;
  });

  messages.forEach((m, i) => {
    const rowNum = i + 2;
    let row = rowMap.get(rowNum);
    if (!row) {
      row = { "@_r": String(rowNum), c: [] };
      rows.push(row);
      rowMap.set(rowNum, row);
    }

    const existingCells = asArray(row.c).filter(Boolean);
    const otherCells = existingCells.filter((c) => {
      const col = colFromRef(c["@_r"]);
      return !(col === "A" || col === "B");
    });

    const aCell = { "@_r": `A${rowNum}`, v: i + 1 };
    const bCell = {
      "@_r": `B${rowNum}`,
      "@_t": "inlineStr",
      is: { t: m.content || "" },
    };

    row.c = [aCell, bCell, ...otherCells];
  });

  rows.sort((a, b) => Number(a["@_r"] || 0) - Number(b["@_r"] || 0));
  worksheet.sheetData.row = rows;

  const currentRef = worksheet.dimension?.["@_ref"] || "A1:B1";
  const currentMaxRef = currentRef.includes(":") ? currentRef.split(":")[1] : currentRef;
  const maxCol = colFromRef(currentMaxRef) || "B";
  const maxRow = Math.max(rowFromRef(currentMaxRef), messages.length + 1);
  worksheet.dimension = { ...(worksheet.dimension || {}), "@_ref": `A1:${maxCol}${maxRow}` };

  let updatedSheetXml = xmlBuilder.build(wsObj);
  if (!updatedSheetXml.startsWith("<?xml")) {
    updatedSheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${updatedSheetXml}`;
  }

  zip.file(sheetPath, updatedSheetXml);
  const outBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outputPath, outBuffer);
}

function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

// ---------------- AUTH MIDDLEWARE ----------------
async function resolveUser(req, res, next) {
  const token = req.headers["x-auth-token"] || req.query.token;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const adminPassword = await db.getSetting("admin_password");
  if (token === adminPassword) {
    req.user = { role: "admin" };
    return next();
  }
  const agent = await db.getAgentBySessionToken(token);
  if (agent) {
    req.user = { role: "agent", agentId: agent.id, phone: agent.phone };
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

function requireAgent(req, res, next) {
  if (req.user?.role !== "agent") {
    return res.status(403).json({ error: "Agent only" });
  }
  next();
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

        const digits = normalizePhoneDigits(from);
        const agentRow = await db.getAgentByPhoneDigits(digits);
        if (agentRow && !(await db.agentCanAccessGroup(agentRow.id, group))) {
          await sendText(from, "You are not assigned to this group.");
        } else {
          const existing = await db.getSessionByKey(group, slot, today());
          if (existing && ["started", "receiving"].includes(existing.status)) {
            await sendText(from, `${group} for ${slot} is already active by another admin.`);
          } else {
            await db.createSession(group, slot, from, today());
            await sendText(
              from,
              `✅ Session started for ${group} - ${slot}\nForward messages now.\nSend /end when finished.`
            );
            emitUpdate();
          }
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
  const digits = normalizePhoneDigits(to);
  const agentRow = await db.getAgentByPhoneDigits(digits);
  const groups = agentRow
    ? await db.getGroupsForWhatsappPhone(digits)
    : await db.getGroups();
  const rows = groups.map((g) => ({ id: "GROUP_" + g.code, title: g.code }));
  if (!rows.length) {
    await sendText(to, "No groups available for your account. Ask an admin to assign you to groups.");
    return;
  }
  await sendList(to, "Select Group", "Choose group", rows);
}

// ---------------- SEND TIME LIST ----------------
async function sendTimeList(to, code) {
  const group = await db.getGroup(code);
  if (!group) return;
  const digits = normalizePhoneDigits(to);
  const agentRow = await db.getAgentByPhoneDigits(digits);
  if (agentRow && !(await db.agentCanAccessGroup(agentRow.id, code))) {
    await sendText(to, "You are not assigned to this group.");
    return;
  }
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
  const fileName = `${session.id}_${session.group_code}_${today()}_${session.slot}.xlsm`;
  ensureExportsDir();
  const filePath = path.join(EXPORTS_DIR, fileName);
  await buildSessionWorkbookFromTemplate(messages, filePath);

  await db.endSession(session.id, filePath);
  emitUpdate();

  const caption = `✅ ${messages.length} message(s)`;
  try {
    const mediaId = await uploadWhatsAppMediaForDocument(filePath, fileName);
    await sendWhatsAppDocumentMessage(from, mediaId, fileName, caption);
  } catch (err) {
    console.error("finishSession document send:", err.response?.data || err.message || err);
    await sendText(
      from,
      `✅ Excel saved: ${fileName}\nMessages: ${messages.length}\n` +
        `Download: open your web dashboard → Sessions tab → Excel button.\n` +
        `(If you expected the file here, check server logs — Meta media upload may need permissions.)`
    );
  }
}

// ---------------- AUTH: LOGIN ----------------
app.post("/api/login", async (req, res) => {
  try {
    const { role, password, phone } = req.body || {};
    if (role === "agent" || (phone && !role)) {
      const digits = normalizePhoneDigits(phone);
      if (!digits || !password) {
        return res.status(400).json({ error: "Phone and password required" });
      }
      const found = await db.getAgentByPhoneDigits(digits);
      if (!found) {
        return res.status(401).json({ error: "Invalid phone or password" });
      }
      const full = await db.getAgentWithHash(found.id);
      if (!bcrypt.compareSync(password, full.password_hash)) {
        return res.status(401).json({ error: "Invalid phone or password" });
      }
      const sessionToken = crypto.randomBytes(32).toString("hex");
      await db.setAgentSessionToken(found.id, sessionToken);
      return res.json({
        success: true,
        role: "agent",
        token: sessionToken,
        agentId: found.id,
        phone: found.phone,
      });
    }

    const adminPassword = await db.getSetting("admin_password");
    if (password === adminPassword) {
      return res.json({ success: true, role: "admin", token: adminPassword });
    }
    res.status(401).json({ error: "Invalid password" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/me", resolveUser, async (req, res) => {
  res.json(req.user);
});

// ---------------- API: GROUPS (Protected) ----------------
app.get("/api/groups", resolveUser, async (req, res) => {
  try {
    const groups =
      req.user.role === "admin"
        ? await db.getGroups()
        : await db.getGroupsForAgent(req.user.agentId);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/groups", resolveUser, requireAdmin, async (req, res) => {
  try {
    const { code, times, agentIds } = req.body;
    if (!code || !Array.isArray(times) || times.length === 0) {
      return res.status(400).json({ error: "Invalid group data" });
    }
    await db.addGroup(code.trim().toUpperCase(), times, Array.isArray(agentIds) ? agentIds : []);
    emitUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/groups/:code", resolveUser, requireAdmin, async (req, res) => {
  try {
    const { newCode, times, agentIds } = req.body;
    if (!newCode || !Array.isArray(times) || times.length === 0) {
      return res.status(400).json({ error: "Invalid group data" });
    }
    await db.updateGroup(
      req.params.code,
      newCode.trim().toUpperCase(),
      times,
      Array.isArray(agentIds) ? agentIds : undefined
    );
    emitUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/groups/:code", resolveUser, requireAdmin, async (req, res) => {
  try {
    await db.deleteGroup(req.params.code);
    emitUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- API: DASHBOARD ----------------
app.get("/api/dashboard/sessions", resolveUser, async (req, res) => {
  try {
    const date = req.query.date || today();
    const sessions =
      req.user.role === "admin"
        ? await db.getSessions(date)
        : await db.getSessionsForAgent(req.user.agentId, date);

    const groups =
      req.user.role === "admin"
        ? await db.getGroups()
        : await db.getGroupsForAgent(req.user.agentId);
    const groupMap = {};
    groups.forEach((g) => (groupMap[g.code] = g));

    const result = groups.map((g) => {
      const todaySession = sessions.find((s) => s.group_code === g.code);
      return {
        group_code: g.code,
        times: g.times,
        agent_ids: g.agent_ids || [],
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

/** Per-group view: each configured time slot + session on a given date (admin + assigned agents). */
app.get("/api/dashboard/groups/:code/slot-detail", resolveUser, async (req, res) => {
  try {
    const code = String(req.params.code || "")
      .trim()
      .toUpperCase();
    if (!code) return res.status(400).json({ error: "Invalid group code" });
    const date = req.query.date || today();
    const group = await db.getGroup(code);
    if (!group) return res.status(404).json({ error: "Group not found" });
    if (
      req.user.role === "agent" &&
      !(await db.agentCanAccessGroup(req.user.agentId, code))
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const sessions = await db.getSessionsForGroupAndDate(code, date);
    const bySlot = {};
    for (const s of sessions) {
      const prev = bySlot[s.slot];
      if (!prev || new Date(s.created_at) > new Date(prev.created_at)) {
        bySlot[s.slot] = s;
      }
    }
    const times = Array.isArray(group.times) ? group.times : [];
    const slots = times.map((slot) => {
      const session = bySlot[slot] || null;
      return {
        slot,
        session: session
          ? {
              id: session.id,
              status: session.status,
              message_count: session.message_count,
              owner_phone: session.owner_phone,
              created_at: session.created_at,
              ended_at: session.ended_at,
              has_excel: Boolean(session.excel_path),
              has_bill: Boolean(session.bill_image_path),
            }
          : null,
      };
    });
    res.json({
      code: group.code,
      date,
      times,
      slots,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dashboard/sessions/:id", resolveUser, async (req, res) => {
  try {
    const session = await db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (
      req.user.role === "agent" &&
      !(await db.agentCanAccessGroup(req.user.agentId, session.group_code))
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const messages = await db.getMessages(session.id);
    res.json({ ...session, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(
  "/api/sessions/:id/bill",
  resolveUser,
  requireAdmin,
  (req, res, next) => {
    billImageUpload.single("bill")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Upload failed" });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const sessionId = Number(req.params.id);
      if (!Number.isFinite(sessionId)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res.status(400).json({ error: "Invalid session" });
      }
      const session = await db.getSessionById(sessionId);
      if (!session) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res.status(404).json({ error: "Session not found" });
      }
      if (session.bill_image_path && fs.existsSync(session.bill_image_path)) {
        try {
          fs.unlinkSync(session.bill_image_path);
        } catch {}
      }
      await db.setSessionBillImagePath(sessionId, req.file.path);
      emitUpdate();
      res.json({ success: true });
    } catch (e) {
      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }
      res.status(500).json({ error: e.message });
    }
  }
);

app.delete("/api/sessions/:id/bill", resolveUser, requireAdmin, async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ error: "Invalid session" });
    }
    const session = await db.getSessionById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const oldPath = await db.clearSessionBillImage(sessionId);
    if (oldPath && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {}
    }
    emitUpdate();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/bill/view", resolveUser, async (req, res) => {
  try {
    const session = await loadSessionBillForRequest(req, res);
    if (!session) return;
    const abs = path.resolve(session.bill_image_path);
    res.setHeader("Content-Type", mimeFromBillPath(abs));
    res.setHeader("Cache-Control", "private, max-age=120");
    res.setHeader("Content-Disposition", 'inline; filename="bill"');
    res.sendFile(abs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/bill/file", resolveUser, async (req, res) => {
  try {
    const session = await loadSessionBillForRequest(req, res);
    if (!session) return;
    const abs = path.resolve(session.bill_image_path);
    const base = `bill-${session.group_code}-${session.slot}-${session.session_date}`
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 120);
    const ext = path.extname(abs) || ".jpg";
    res.setHeader("Content-Type", mimeFromBillPath(abs));
    res.setHeader("Content-Disposition", `attachment; filename="${base}${ext}"`);
    res.sendFile(abs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/dashboard/stats", resolveUser, async (req, res) => {
  try {
    const stats =
      req.user.role === "admin"
        ? await db.getDashboardStats(today())
        : await db.getDashboardStatsForAgent(req.user.agentId, today());
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download/:sessionId", resolveUser, async (req, res) => {
  try {
    const session = await db.getSessionById(req.params.sessionId);
    if (!session || !session.excel_path || !fs.existsSync(session.excel_path)) {
      return res.status(404).json({ error: "File not found" });
    }
    if (
      req.user.role === "agent" &&
      !(await db.agentCanAccessGroup(req.user.agentId, session.group_code))
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.download(session.excel_path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- REPORT: GROUP SESSIONS ----------------
app.get("/api/report/group/:code", resolveUser, async (req, res) => {
  try {
    const group = await db.getGroup(req.params.code);
    if (!group) return res.status(404).json({ error: "Group not found" });
    if (
      req.user.role === "agent" &&
      !(await db.agentCanAccessGroup(req.user.agentId, req.params.code))
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

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
app.get("/api/report/date/:date", resolveUser, async (req, res) => {
  try {
    const date = req.params.date;
    const sessions = await db.getSessionsByDate(date);
    const groups =
      req.user.role === "admin"
        ? await db.getGroups()
        : await db.getGroupsForAgent(req.user.agentId);

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
app.get("/api/sessions/raw", resolveUser, async (req, res) => {
  try {
    const date = req.query.date || today();
    const sessions =
      req.user.role === "admin"
        ? await db.getSessions(date)
        : await db.getSessionsForAgent(req.user.agentId, date);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- API: SETTINGS ----------------
app.post("/api/settings/reset", resolveUser, requireAdmin, async (req, res) => {
  try {
    // Delete all exported Excel files
    ensureExportsDir();
    const exportsDir = EXPORTS_DIR;
    const files = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
    for (const file of files) {
      if (file.endsWith(".xlsx") || file.endsWith(".xlsm")) {
        fs.unlinkSync(path.join(exportsDir, file));
      }
    }

    ensureBillsDir();
    const billFiles = fs.existsSync(BILLS_DIR) ? fs.readdirSync(BILLS_DIR) : [];
    for (const file of billFiles) {
      try {
        fs.unlinkSync(path.join(BILLS_DIR, file));
      } catch {}
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

app.post("/api/settings/password", resolveUser, requireAdmin, async (req, res) => {
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

// ---------------- API: AGENTS (admin) ----------------
app.get("/api/agents", resolveUser, requireAdmin, async (req, res) => {
  try {
    const agents = await db.listAgents();
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agents", resolveUser, requireAdmin, async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    const digits = normalizePhoneDigits(phone);
    if (!digits || !password || password.length < 4) {
      return res.status(400).json({ error: "Phone and password (min 4 chars) required" });
    }
    const hash = bcrypt.hashSync(password, 10);
    const row = await db.createAgent(digits, hash);
    emitUpdate();
    res.json({ success: true, agent: row });
  } catch (err) {
    if (String(err.message).includes("unique") || err.code === "23505") {
      return res.status(400).json({ error: "Agent phone already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/agents/:id", resolveUser, requireAdmin, async (req, res) => {
  try {
    await db.deleteAgent(Number(req.params.id));
    emitUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agents/:id/reset-password", resolveUser, requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: "New password must be at least 4 characters" });
    }
    const id = Number(req.params.id);
    const agent = await db.getAgentById(id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const hash = bcrypt.hashSync(newPassword, 10);
    await db.updateAgentPassword(id, hash);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agent/change-password", resolveUser, requireAgent, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: "Invalid input" });
    }
    const full = await db.getAgentWithHash(req.user.agentId);
    if (!bcrypt.compareSync(currentPassword, full.password_hash)) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await db.updateAgentPassword(req.user.agentId, hash);
    const sessionToken = crypto.randomBytes(32).toString("hex");
    await db.setAgentSessionToken(req.user.agentId, sessionToken);
    res.json({ success: true, token: sessionToken });
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
    ensureBillsDir();
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
