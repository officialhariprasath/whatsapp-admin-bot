const { Pool, Client } = require("pg");
require("dotenv").config();

function parseTimes(row) {
  const t = row.times;
  if (t == null) return null;
  if (typeof t === "object") return t;
  return JSON.parse(t);
}

function sslFromUrl(url) {
  if (!url) return false;
  if (url.includes("localhost") || url.includes("127.0.0.1")) return false;
  return { rejectUnauthorized: false };
}

function createPool() {
  const url = process.env.DATABASE_URL;
  if (url) {
    return new Pool({
      connectionString: url,
      max: 10,
      ssl: sslFromUrl(url),
    });
  }

  const { DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_USER || !DB_PASSWORD || !DB_NAME) {
    throw new Error(
      "Database env vars missing. On Render: Dashboard → your Web Service → Environment → add DATABASE_URL " +
        "(copy Internal Database URL from your Render PostgreSQL → Connections). " +
        "Locally: use DATABASE_URL or set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME in .env"
    );
  }

  return new Pool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    max: 10,
  });
}

let pool = createPool();

async function init() {
  if (process.env.DATABASE_URL) {
    const c = await pool.connect();
    c.release();
    console.log("✅ Database connection OK");
    return;
  }

  const dbName = process.env.DB_NAME;
  if (!dbName) throw new Error("DB_NAME is required when DATABASE_URL is not set");

  const admin = new Client({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: "postgres",
  });
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rows.length) {
      const safe = dbName.replace(/"/g, '""');
      await admin.query(`CREATE DATABASE "${safe}"`);
      console.log("✅ Database created");
    } else {
      console.log("✅ Database ensured");
    }
  } finally {
    await admin.end();
  }
}

async function initTables() {
  const conn = await pool.connect();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS groups_table (
        code VARCHAR(50) PRIMARY KEY,
        times JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        group_code VARCHAR(50) NOT NULL REFERENCES groups_table(code) ON DELETE CASCADE,
        slot VARCHAR(20) NOT NULL,
        owner_phone VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'idle'
          CHECK (status IN ('idle','started','receiving','ended','excel_ready')),
        message_count INT DEFAULT 0,
        excel_path VARCHAR(255) DEFAULT NULL,
        session_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMPTZ NULL DEFAULT NULL
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        received_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const { rows: settings } = await conn.query(
      "SELECT * FROM settings WHERE key = 'admin_password'"
    );
    if (!settings.length) {
      await conn.query("INSERT INTO settings (key, value) VALUES ('admin_password', $1)", [
        process.env.ADMIN_PASSWORD || "admin123",
      ]);
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(50) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        session_token VARCHAR(128),
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS group_agents (
        group_code VARCHAR(50) NOT NULL REFERENCES groups_table(code) ON DELETE CASCADE,
        agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        PRIMARY KEY (group_code, agent_id)
      )
    `);

    await conn.query(
      "CREATE INDEX IF NOT EXISTS idx_group_agents_agent_id ON group_agents(agent_id)"
    );

    await conn.query(
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS bill_image_path VARCHAR(512) DEFAULT NULL`
    );

    console.log("✅ Database tables initialized");
  } finally {
    conn.release();
  }
}

function parseAgentIds(row) {
  const v = row.agent_ids;
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(Number).filter((n) => !Number.isNaN(n));
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(Number) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Groups (includes agent_ids for admin UI)
async function getGroups() {
  const { rows } = await pool.query(`
    SELECT g.code, g.times, g.created_at,
      COALESCE(
        (SELECT json_agg(ga.agent_id ORDER BY ga.agent_id)
         FROM group_agents ga WHERE ga.group_code = g.code),
        '[]'::json
      ) AS agent_ids
    FROM groups_table g
    ORDER BY g.created_at DESC
  `);
  return rows.map((r) => ({ ...r, times: parseTimes(r), agent_ids: parseAgentIds(r) }));
}

async function getGroupsForAgent(agentId) {
  const { rows } = await pool.query(
    `
    SELECT g.code, g.times, g.created_at,
      COALESCE(
        (SELECT json_agg(ga2.agent_id ORDER BY ga2.agent_id)
         FROM group_agents ga2 WHERE ga2.group_code = g.code),
        '[]'::json
      ) AS agent_ids
    FROM groups_table g
    INNER JOIN group_agents ga ON ga.group_code = g.code AND ga.agent_id = $1
    ORDER BY g.created_at DESC
  `,
    [agentId]
  );
  return rows.map((r) => ({ ...r, times: parseTimes(r), agent_ids: parseAgentIds(r) }));
}

/** Groups visible on WhatsApp for an agent phone: only assigned groups. */
async function getGroupsForWhatsappPhone(phoneDigits) {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT g.code, g.times, g.created_at,
      COALESCE(
        (SELECT json_agg(ga2.agent_id ORDER BY ga2.agent_id)
         FROM group_agents ga2 WHERE ga2.group_code = g.code),
        '[]'::json
      ) AS agent_ids
    FROM groups_table g
    INNER JOIN group_agents ga3 ON ga3.group_code = g.code
    INNER JOIN agents a ON a.id = ga3.agent_id
    WHERE regexp_replace(a.phone, '\\D', '', 'g') = $1
    ORDER BY g.created_at DESC
  `,
    [phoneDigits]
  );
  return rows.map((r) => ({ ...r, times: parseTimes(r), agent_ids: parseAgentIds(r) }));
}

async function getGroup(code) {
  const { rows } = await pool.query("SELECT * FROM groups_table WHERE code = $1", [code]);
  if (!rows.length) return null;
  return { ...rows[0], times: parseTimes(rows[0]) };
}

async function setGroupAgents(groupCode, agentIds) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM group_agents WHERE group_code = $1", [groupCode]);
    for (const id of agentIds || []) {
      const n = Number(id);
      if (!Number.isFinite(n)) continue;
      await client.query(
        "INSERT INTO group_agents (group_code, agent_id) VALUES ($1, $2) ON CONFLICT (group_code, agent_id) DO NOTHING",
        [groupCode, n]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function addGroup(code, times, agentIds = []) {
  await pool.query("INSERT INTO groups_table (code, times) VALUES ($1, $2::jsonb)", [
    code,
    JSON.stringify(times),
  ]);
  await setGroupAgents(code, agentIds);
}

async function updateGroup(oldCode, newCode, times, agentIds) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (oldCode !== newCode) {
      await client.query("UPDATE group_agents SET group_code = $1 WHERE group_code = $2", [
        newCode,
        oldCode,
      ]);
    }
    await client.query("UPDATE groups_table SET code = $1, times = $2::jsonb WHERE code = $3", [
      newCode,
      JSON.stringify(times),
      oldCode,
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  if (agentIds !== undefined) {
    await setGroupAgents(newCode, agentIds);
  }
}

async function deleteGroup(code) {
  await pool.query("DELETE FROM groups_table WHERE code = $1", [code]);
}

// Sessions
async function createSession(group_code, slot, owner_phone, session_date) {
  const { rows } = await pool.query(
    `INSERT INTO sessions (group_code, slot, owner_phone, status, session_date)
     VALUES ($1, $2, $3, 'started', $4)
     RETURNING id`,
    [group_code, slot, owner_phone, session_date]
  );
  return rows[0].id;
}

async function getActiveSession(owner_phone, session_date) {
  const { rows } = await pool.query(
    `SELECT * FROM sessions WHERE owner_phone = $1 AND session_date = $2
     AND status IN ('started','receiving') LIMIT 1`,
    [owner_phone, session_date]
  );
  return rows[0] || null;
}

async function getSessionByKey(group_code, slot, session_date) {
  const { rows } = await pool.query(
    `SELECT * FROM sessions WHERE group_code = $1 AND slot = $2 AND session_date = $3
     AND status IN ('started','receiving') LIMIT 1`,
    [group_code, slot, session_date]
  );
  return rows[0] || null;
}

async function getSessionById(id) {
  const { rows } = await pool.query("SELECT * FROM sessions WHERE id = $1", [id]);
  return rows[0] || null;
}

async function setSessionBillImagePath(sessionId, filePath) {
  await pool.query("UPDATE sessions SET bill_image_path = $1 WHERE id = $2", [
    filePath,
    sessionId,
  ]);
}

/** Clears DB path; returns previous filesystem path if any (caller deletes file). */
async function clearSessionBillImage(sessionId) {
  const session = await getSessionById(sessionId);
  if (!session) return null;
  const old = session.bill_image_path;
  await pool.query("UPDATE sessions SET bill_image_path = NULL WHERE id = $1", [sessionId]);
  return old;
}

async function addMessage(session_id, content) {
  await pool.query("INSERT INTO messages (session_id, content) VALUES ($1, $2)", [
    session_id,
    content,
  ]);
  await pool.query(
    "UPDATE sessions SET message_count = message_count + 1, status = 'receiving' WHERE id = $1",
    [session_id]
  );
}

async function endSession(session_id, excel_path) {
  await pool.query(
    "UPDATE sessions SET status = 'excel_ready', excel_path = $1, ended_at = NOW() WHERE id = $2",
    [excel_path, session_id]
  );
}

async function getSessions(date) {
  let sql = "SELECT * FROM sessions";
  const params = [];
  if (date) {
    sql += " WHERE session_date = $1";
    params.push(date);
  }
  sql += " ORDER BY created_at DESC";
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getMessages(session_id) {
  const { rows } = await pool.query(
    "SELECT * FROM messages WHERE session_id = $1 ORDER BY received_at ASC",
    [session_id]
  );
  return rows;
}

async function getTodaySessionForGroup(group_code, session_date) {
  const { rows } = await pool.query(
    `SELECT * FROM sessions WHERE group_code = $1 AND session_date = $2
     ORDER BY created_at DESC LIMIT 1`,
    [group_code, session_date]
  );
  return rows[0] || null;
}

async function getSessionsByGroup(group_code) {
  const { rows } = await pool.query(
    "SELECT * FROM sessions WHERE group_code = $1 ORDER BY session_date DESC, created_at DESC",
    [group_code]
  );
  return rows;
}

async function getSessionsByDate(session_date) {
  const { rows } = await pool.query(
    "SELECT * FROM sessions WHERE session_date = $1 ORDER BY group_code ASC, slot ASC",
    [session_date]
  );
  return rows;
}

/** All sessions for one group on a calendar day (multiple slots possible). */
async function getSessionsForGroupAndDate(group_code, session_date) {
  const { rows } = await pool.query(
    `SELECT * FROM sessions
     WHERE group_code = $1 AND session_date = $2::date
     ORDER BY slot ASC, created_at DESC`,
    [group_code, session_date]
  );
  return rows;
}

async function getDashboardStats(session_date) {
  const { rows: groupCount } = await pool.query("SELECT COUNT(*)::int AS count FROM groups_table");
  const { rows: activeSessions } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM sessions WHERE session_date = $1 AND status IN ('started','receiving')`,
    [session_date]
  );
  const { rows: endedToday } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM sessions WHERE session_date = $1 AND status = 'excel_ready'`,
    [session_date]
  );
  const { rows: totalMessages } = await pool.query(
    `SELECT COALESCE(SUM(message_count),0)::bigint AS count FROM sessions WHERE session_date = $1`,
    [session_date]
  );
  return {
    totalGroups: groupCount[0].count,
    activeSessions: activeSessions[0].count,
    endedToday: endedToday[0].count,
    totalMessagesToday: Number(totalMessages[0].count),
  };
}

async function getDashboardStatsForAgent(agentId, session_date) {
  const { rows: groupCount } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM group_agents WHERE agent_id = $1",
    [agentId]
  );
  const { rows: activeSessions } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM sessions s
     INNER JOIN group_agents ga ON ga.group_code = s.group_code AND ga.agent_id = $1
     WHERE s.session_date = $2 AND s.status IN ('started','receiving')`,
    [agentId, session_date]
  );
  const { rows: endedToday } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM sessions s
     INNER JOIN group_agents ga ON ga.group_code = s.group_code AND ga.agent_id = $1
     WHERE s.session_date = $2 AND s.status = 'excel_ready'`,
    [agentId, session_date]
  );
  const { rows: totalMessages } = await pool.query(
    `SELECT COALESCE(SUM(s.message_count),0)::bigint AS count FROM sessions s
     INNER JOIN group_agents ga ON ga.group_code = s.group_code AND ga.agent_id = $1
     WHERE s.session_date = $2`,
    [agentId, session_date]
  );
  return {
    totalGroups: groupCount[0].count,
    activeSessions: activeSessions[0].count,
    endedToday: endedToday[0].count,
    totalMessagesToday: Number(totalMessages[0].count),
  };
}

async function getSessionsForAgent(agentId, date) {
  if (date) {
    const { rows } = await pool.query(
      `SELECT s.* FROM sessions s
       INNER JOIN group_agents ga ON ga.group_code = s.group_code AND ga.agent_id = $1
       WHERE s.session_date = $2::date
       ORDER BY s.created_at DESC`,
      [agentId, date]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT s.* FROM sessions s
     INNER JOIN group_agents ga ON ga.group_code = s.group_code AND ga.agent_id = $1
     ORDER BY s.created_at DESC`,
    [agentId]
  );
  return rows;
}

async function agentCanAccessGroup(agentId, groupCode) {
  const { rows } = await pool.query(
    "SELECT 1 FROM group_agents WHERE agent_id = $1 AND group_code = $2 LIMIT 1",
    [agentId, groupCode]
  );
  return rows.length > 0;
}

// Agents
async function listAgents() {
  const { rows } = await pool.query(
    "SELECT id, phone, created_at FROM agents ORDER BY id ASC"
  );
  return rows;
}

async function createAgent(phone, passwordHash) {
  const { rows } = await pool.query(
    "INSERT INTO agents (phone, password_hash) VALUES ($1, $2) RETURNING id, phone, created_at",
    [phone, passwordHash]
  );
  return rows[0];
}

async function getAgentById(id) {
  const { rows } = await pool.query("SELECT id, phone, created_at FROM agents WHERE id = $1", [id]);
  return rows[0] || null;
}

async function getAgentByPhoneDigits(phoneDigits) {
  const { rows } = await pool.query(
    "SELECT * FROM agents WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1",
    [phoneDigits]
  );
  return rows[0] || null;
}

async function getAgentBySessionToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    "SELECT id, phone, created_at FROM agents WHERE session_token = $1 LIMIT 1",
    [token]
  );
  return rows[0] || null;
}

async function getAgentWithHash(id) {
  const { rows } = await pool.query("SELECT * FROM agents WHERE id = $1", [id]);
  return rows[0] || null;
}

async function setAgentSessionToken(agentId, token) {
  await pool.query("UPDATE agents SET session_token = $1 WHERE id = $2", [token, agentId]);
}

async function clearAgentSessionToken(agentId) {
  await pool.query("UPDATE agents SET session_token = NULL WHERE id = $1", [agentId]);
}

async function updateAgentPassword(agentId, passwordHash) {
  await pool.query("UPDATE agents SET password_hash = $1, session_token = NULL WHERE id = $2", [
    passwordHash,
    agentId,
  ]);
}

async function deleteAgent(id) {
  await pool.query("DELETE FROM agents WHERE id = $1", [id]);
}

// Settings
async function getSetting(key) {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// Reset
async function resetDatabase() {
  const conn = await pool.connect();
  try {
    await conn.query(
      "TRUNCATE messages, sessions, group_agents, agents, groups_table RESTART IDENTITY CASCADE"
    );
  } finally {
    conn.release();
  }
}

module.exports = {
  pool,
  init,
  initTables,
  getGroups,
  getGroupsForAgent,
  getGroupsForWhatsappPhone,
  getGroup,
  addGroup,
  updateGroup,
  deleteGroup,
  setGroupAgents,
  createSession,
  getActiveSession,
  getSessionByKey,
  getSessionById,
  setSessionBillImagePath,
  clearSessionBillImage,
  addMessage,
  endSession,
  getSessions,
  getMessages,
  getTodaySessionForGroup,
  getDashboardStats,
  getDashboardStatsForAgent,
  getSessionsForAgent,
  agentCanAccessGroup,
  getSessionsByGroup,
  getSessionsByDate,
  getSessionsForGroupAndDate,
  listAgents,
  createAgent,
  getAgentById,
  getAgentByPhoneDigits,
  getAgentBySessionToken,
  getAgentWithHash,
  setAgentSessionToken,
  clearAgentSessionToken,
  updateAgentPassword,
  deleteAgent,
  getSetting,
  setSetting,
  resetDatabase,
};

