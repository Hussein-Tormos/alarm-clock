// server.js
const express = require('express');
const { Pool } = require('pg'); // Changed from mysql2 to pg
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.DB_PORT || 3000;

// --- Database Connection Configuration ---
// IMPORTANT: Render provides a DATABASE_URL environment variable for PostgreSQL.
// Use this for deployed environments. For local development, you'll need a local PostgreSQL setup
// or just use different credentials here.
// The structure will typically be: postgres://user:password@host:port/database
const DATABASE_URL = process.env.DATABASE_URL

let pool; // Connection pool for efficient database connections

async function initializeDatabase() {
    try {
        // For Render, DATABASE_URL will include SSL parameters automatically.
        // For local development, you might need to adjust based on your local PostgreSQL setup.
        pool = new Pool({
            connectionString: DATABASE_URL,
            // If connecting to Render from local machine (for testing), you might need SSL options:
            // ssl: {
            //     rejectUnauthorized: false // Use this if you get self-signed certificate errors during local testing with Render's external URL
            // }
        });

        await pool.connect(); // Test the connection

        console.log('PostgreSQL connection pool created and connected.');

        // Ensure table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS alarm_settings (
                id SERIAL PRIMARY KEY, -- SERIAL for auto-increment in PostgreSQL
                active BOOLEAN NOT NULL DEFAULT FALSE,
                alarm_time VARCHAR(5) NOT NULL DEFAULT '',
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // Note: ON UPDATE CURRENT_TIMESTAMP is a MySQLism. PostgreSQL handles this differently,
        // often through triggers or by simply updating the column manually.
        // For simplicity, we'll omit auto-update on last_updated for now,
        // or you could update it manually with NOW() in setAlarmData if needed.

        // Check if there's an initial row, if not, insert one
        const res = await pool.query("SELECT COUNT(*) AS count FROM alarm_settings");
        if (res.rows[0].count === '0') { // count comes as string
            await pool.query("INSERT INTO alarm_settings (active, alarm_time) VALUES (FALSE, '')");
            console.log('Initial alarm_settings row inserted.');
        }
        console.log('Database table "alarm_settings" checked/created and initialized.');
    } catch (err) {
        console.error('Failed to connect to PostgreSQL or create table:', err);
        // Exit process if database connection fails on startup
        process.exit(1);
    }
}

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- API Endpoints ---

// API endpoint to get current alarm data
app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query("SELECT active, alarm_time FROM alarm_settings WHERE id = 1 LIMIT 1");
        if (result.rows.length > 0) {
            const data = result.rows[0];
            // PostgreSQL's boolean type maps directly to JavaScript boolean
            res.json(data);
        } else {
            res.json({ active: false, alarm_time: '' });
        }
    } catch (err) {
        console.error('Error fetching alarm status:', err);
        res.status(500).json({ success: false, message: 'Database error fetching status.' });
    }
});

// API endpoint to set/update alarm (used by frontend POST)
app.post('/api/set-alarm', async (req, res) => {
    const { alarm_time } = req.body;

    if (!alarm_time || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(alarm_time)) {
        return res.status(400).json({ success: false, message: 'Invalid alarm time format. Use HH:MM.' });
    }

    try {
        // Use $1, $2 for parameterized queries in pg
        await pool.query("UPDATE alarm_settings SET active = $1, alarm_time = $2, last_updated = NOW() WHERE id = 1", [true, alarm_time]);
        res.json({ success: true, active: true, alarm_time: alarm_time, message: 'Alarm set successfully!' });
    } catch (err) {
        console.error('Error setting alarm:', err);
        res.status(500).json({ success: false, message: 'Database error setting alarm.' });
    }
});

// API endpoint to reset alarm (used by frontend POST)
app.post('/api/reset-alarm', async (req, res) => {
    try {
        await pool.query("UPDATE alarm_settings SET active = $1, alarm_time = $2, last_updated = NOW() WHERE id = 1", [false, '']);
        res.json({ success: true, active: false, alarm_time: '', message: 'Alarm reset successfully.' });
    } catch (err) {
        console.error('Error resetting alarm:', err);
        res.status(500).json({ success: false, message: 'Database error resetting alarm.' });
    }
});

// API endpoint for ESP8266 to signal alarm stopped (POST)
app.post('/api/alarm-stopped', async (req, res) => {
    try {
        // No need to get current alarm_time before deactivating, as we just set active to false
        await pool.query("UPDATE alarm_settings SET active = $1, last_updated = NOW() WHERE id = 1", [false]);
        res.json({ success: true, message: 'Alarm stopped by device.' });
    } catch (err) {
        console.error('Error handling alarm stopped signal:', err);
        res.status(500).json({ success: false, message: 'Database error.' });
    }
});

// --- Start Server ---
async function startServer() {
    await initializeDatabase();
    app.listen(port, () => {
        console.log(`Node.js server listening on port ${port}`);
    });
}

startServer();
