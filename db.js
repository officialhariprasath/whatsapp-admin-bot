const mysql = require("mysql2/promise");
require("dotenv").config();

async function init() {
  // First connect without database to create it if needed
  const tempConn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``);
  await tempConn.end();
  console.log("✅ Database ensured");
}

let pool;
if (process.env.DATABASE_URL) {
  // PlanetScale / Render MySQL with SSL
  pool = mysql.createPool(process.env.DATABASE_URL);
} else {
  // Local MySQL (XAMPP)
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
}

async function initTables() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS groups_table (
        code VARCHAR(50) PRIMARY KEY,
        times JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_code VARCHAR(50) NOT NULL,
        slot VARCHAR(20) NOT NULL,
        owner_phone VARCHAR(50) NOT NULL,
        status ENUM('idle','started','receiving','ended','excel_ready') DEFAULT 'idle',
        message_count INT DEFAULT 0,
        excel_path VARCHAR(255) DEFAULT NULL,
        session_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL DEFAULT NULL,
        FOREIGN KEY (group_code) REFERENCES groups_table(code) ON DELETE CASCADE
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        content TEXT NOT NULL,
        received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(50) PRIMARY KEY,
        \`value\` TEXT NOT NULL
      )
    `);

    // Insert default admin password if not exists
    const [settings] = await conn.query("SELECT * FROM settings WHERE `key` = 'admin_password'");
    if (!settings.length) {
      await conn.query("INSERT INTO settings (`key`, `value`) VALUES ('admin_password', ?)", [process.env.ADMIN_PASSWORD || 'admin123']);
    }

    console.log("✅ Database tables initialized");
  } finally {
    conn.release();
  }
}

// Groups
async function getGroups() {
  const [rows] = await pool.query("SELECT * FROM groups_table ORDER BY created_at DESC");
  return rows.map((r) => ({ ...r, times: JSON.parse(r.times) }));
}

async function getGroup(code) {
  const [rows] = await pool.query("SELECT * FROM groups_table WHERE code = ?", [code]);
  if (!rows.length) return null;
  return { ...rows[0], times: JSON.parse(rows[0].times) };
}

async function addGroup(code, times) {
  await pool.query("INSERT INTO groups_table (code, times) VALUES (?, ?)", [code, JSON.stringify(times)]);
}

async function updateGroup(oldCode, newCode, times) {
  await pool.query("UPDATE groups_table SET code = ?, times = ? WHERE code = ?", [newCode, JSON.stringify(times), oldCode]);
}

async function deleteGroup(code) {
  await pool.query("DELETE FROM groups_table WHERE code = ?", [code]);
}

// Sessions
async function createSession(group_code, slot, owner_phone, session_date) {
  const [result] = await pool.query(
    "INSERT INTO sessions (group_code, slot, owner_phone, status, session_date) VALUES (?, ?, ?, 'started', ?)",
    [group_code, slot, owner_phone, session_date]
  );
  return result.insertId;
}

async function getActiveSession(owner_phone, session_date) {
  const [rows] = await pool.query(
    "SELECT * FROM sessions WHERE owner_phone = ? AND session_date = ? AND status IN ('started','receiving') LIMIT 1",
    [owner_phone, session_date]
  );
  return rows[0] || null;
}

async function getSessionByKey(group_code, slot, session_date) {
  const [rows] = await pool.query(
    "SELECT * FROM sessions WHERE group_code = ? AND slot = ? AND session_date = ? AND status IN ('started','receiving') LIMIT 1",
    [group_code, slot, session_date]
  );
  return rows[0] || null;
}

async function getSessionById(id) {
  const [rows] = await pool.query("SELECT * FROM sessions WHERE id = ?", [id]);
  return rows[0] || null;
}

async function addMessage(session_id, content) {
  await pool.query("INSERT INTO messages (session_id, content) VALUES (?, ?)", [session_id, content]);
  await pool.query("UPDATE sessions SET message_count = message_count + 1, status = 'receiving' WHERE id = ?", [session_id]);
}

async function endSession(session_id, excel_path) {
  await pool.query(
    "UPDATE sessions SET status = 'excel_ready', excel_path = ?, ended_at = NOW() WHERE id = ?",
    [excel_path, session_id]
  );
}

async function getSessions(date) {
  let sql = "SELECT * FROM sessions";
  let params = [];
  if (date) {
    sql += " WHERE session_date = ?";
    params.push(date);
  }
  sql += " ORDER BY created_at DESC";
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function getMessages(session_id) {
  const [rows] = await pool.query("SELECT * FROM messages WHERE session_id = ? ORDER BY received_at ASC", [session_id]);
  return rows;
}

async function getTodaySessionForGroup(group_code, session_date) {
  const [rows] = await pool.query(
    "SELECT * FROM sessions WHERE group_code = ? AND session_date = ? ORDER BY created_at DESC LIMIT 1",
    [group_code, session_date]
  );
  return rows[0] || null;
}

async function getSessionsByGroup(group_code) {
  const [rows] = await pool.query(
    "SELECT * FROM sessions WHERE group_code = ? ORDER BY session_date DESC, created_at DESC",
    [group_code]
  );
  return rows;
}

async function getSessionsByDate(session_date) {
  const [rows] = await pool.query(
    "SELECT * FROM sessions WHERE session_date = ? ORDER BY group_code ASC, slot ASC",
    [session_date]
  );
  return rows;
}

async function getDashboardStats(session_date) {
  const [groupCount] = await pool.query("SELECT COUNT(*) as count FROM groups_table");
  const [activeSessions] = await pool.query(
    "SELECT COUNT(*) as count FROM sessions WHERE session_date = ? AND status IN ('started','receiving')",
    [session_date]
  );
  const [endedToday] = await pool.query(
    "SELECT COUNT(*) as count FROM sessions WHERE session_date = ? AND status = 'excel_ready'",
    [session_date]
  );
  const [totalMessages] = await pool.query(
    "SELECT COALESCE(SUM(message_count),0) as count FROM sessions WHERE session_date = ?",
    [session_date]
  );
  return {
    totalGroups: groupCount[0].count,
    activeSessions: activeSessions[0].count,
    endedToday: endedToday[0].count,
    totalMessagesToday: totalMessages[0].count,
  };
}

// Settings
async function getSetting(key) {
  const [rows] = await pool.query("SELECT `value` FROM settings WHERE `key` = ?", [key]);
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query("INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?", [key, value, value]);
}

// Reset
async function resetDatabase() {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    await conn.query("TRUNCATE TABLE messages");
    await conn.query("TRUNCATE TABLE sessions");
    await conn.query("TRUNCATE TABLE groups_table");
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
}

module.exports = {
  pool,
  init,
  initTables,
  getGroups,
  getGroup,
  addGroup,
  updateGroup,
  deleteGroup,
  createSession,
  getActiveSession,
  getSessionByKey,
  getSessionById,
  addMessage,
  endSession,
  getSessions,
  getMessages,
  getTodaySessionForGroup,
  getDashboardStats,
  getSessionsByGroup,
  getSessionsByDate,
  getSetting,
  setSetting,
  resetDatabase,
};
