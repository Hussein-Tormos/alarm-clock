// server.js
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");

const app = express();
const port = process.env.DB_PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL });

async function initializeDatabase() {
  try {
    await pool.connect();
    console.log("PostgreSQL connected.");

    // IMPORTANT: Added 'timezone' column to the table.
    // If you already have the table created, you'll need to run an ALTER TABLE statement manually:
    // ALTER TABLE alarm_settings ADD COLUMN timezone REAL NOT NULL DEFAULT 0;
    // Or drop the table and let it recreate for development: DROP TABLE IF EXISTS alarm_settings;
    await pool.query(`
            CREATE TABLE IF NOT EXISTS alarm_settings (
                id SERIAL PRIMARY KEY,
                alarm_time VARCHAR(5) NOT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                timezone REAL NOT NULL DEFAULT 0, -- Added timezone column (e.g., -5, 3, 5.5)
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    console.log("alarm_settings table ensured with timezone column.");
  } catch (err) {
    console.error("Database init error:", err);
    process.exit(1);
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
// Assuming your frontend HTML file is in a 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// --- API ROUTES ---

// Get all active alarms
// Modified: Now returns all active alarms with their timezone
app.get("/api/alarms", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, alarm_time, active, timezone FROM alarm_settings WHERE active = TRUE ORDER BY alarm_time`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching all alarms:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch alarms." });
  }
});

// Get next upcoming alarm (for ESP device primarily)
// Modified: Also returns the timezone
app.get("/api/next-alarm", async (req, res) => {
  try {
    const now = new Date();
    // Format current time to HH:MM for comparison
    const nowHHMM = now.toTimeString().substring(0, 5);

    // Try to find an active alarm today that hasn't passed yet
    let result = await pool.query(
      `
            SELECT id, alarm_time, active, timezone FROM alarm_settings
            WHERE active = TRUE AND alarm_time >= $1
            ORDER BY alarm_time ASC LIMIT 1
        `,
      [nowHHMM]
    );

    if (result.rows.length === 0) {
      // If no future alarms today, get the earliest alarm for tomorrow
      result = await pool.query(`
                SELECT id, alarm_time, active, timezone FROM alarm_settings
                WHERE active = TRUE
                ORDER BY alarm_time ASC LIMIT 1
            `);
    }

    // Return the next alarm or an empty object if no alarms are set
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error("Error fetching next alarm:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch next alarm." });
  }
});

// Add a new alarm or update an existing one
// Modified: Accepts 'id' for updates and 'timezone'
app.post("/api/set-alarm", async (req, res) => {
  const { id, alarm_time, timezone } = req.body; // 'id' is optional for new alarms

  if (!alarm_time || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(alarm_time)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid alarm time format (HH:MM)." });
  }

  // Basic validation for timezone
  if (typeof timezone === "undefined" || isNaN(parseFloat(timezone))) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid timezone provided." });
  }

  try {
    let queryResult;
    let alarm;

    if (id) {
      // Update existing alarm
      queryResult = await pool.query(
        `
                UPDATE alarm_settings
                SET alarm_time = $1, active = TRUE, timezone = $2, last_updated = NOW()
                WHERE id = $3
                RETURNING id, alarm_time, active, timezone
            `,
        [alarm_time, timezone, id]
      );
      alarm = queryResult.rows[0];
      if (!alarm) {
        return res
          .status(404)
          .json({ success: false, message: "Alarm not found." });
      }
      res.json({
        success: true,
        message: "Alarm updated successfully!",
        alarm: alarm,
      });
    } else {
      // Insert new alarm
      queryResult = await pool.query(
        `
                INSERT INTO alarm_settings (alarm_time, active, timezone, last_updated)
                VALUES ($1, TRUE, $2, NOW())
                RETURNING id, alarm_time, active, timezone
            `,
        [alarm_time, timezone]
      );
      alarm = queryResult.rows[0]; // Get the newly created alarm with its ID
      res
        .status(201)
        .json({
          success: true,
          message: "Alarm added successfully!",
          alarm: alarm,
        });
    }
  } catch (err) {
    console.error("Error setting/updating alarm:", err);
    res.status(500).json({ success: false, message: "Failed to set alarm." });
  }
});

// Delete an alarm by ID (soft delete by setting active to false)
// Modified: Renamed from /reset-alarm to /delete-alarm, takes ID from body
app.post("/api/delete-alarm", async (req, res) => {
  const { id } = req.body; // Expecting id in the request body
  if (!id) {
    return res
      .status(400)
      .json({ success: false, message: "Alarm ID is required for deletion." });
  }
  try {
    const result = await pool.query(
      "UPDATE alarm_settings SET active = FALSE WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Alarm not found." });
    }
    res.json({ success: true, message: "Alarm deleted successfully." });
  } catch (err) {
    console.error("Error deleting alarm:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to delete alarm." });
  }
});

// From ESP32 — mark current alarm as stopped (still uses ID from params)
// Note: This endpoint's functionality is similar to deleting but assumes the ESP specifically calls it.
// It might be useful to keep it distinct from a full frontend 'delete'
app.post("/api/alarm-stopped/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res
      .status(400)
      .json({ success: false, message: "Alarm ID is required." });
  }
  try {
    const result = await pool.query(
      "UPDATE alarm_settings SET active = FALSE WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Alarm not found." });
    }
    res.json({ success: true, message: "Alarm stopped (deactivated)." });
  } catch (err) {
    console.error("Error stopping alarm:", err);
    res.status(500).json({ success: false, message: "Failed to stop alarm." });
  }
});

// Start server
initializeDatabase().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
});
