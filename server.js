// server.js
const express = require('express');
const mysql = require('mysql2/promise'); // Using promise-based version for async/await
const cors = require('cors'); // For handling Cross-Origin Resource Sharing (important for ESP8266)
const path = require('path'); // Node.js path module for serving static files

const app = express();
const port = process.env.PORT || 3000; // Use port 3000 by default, or process.env.PORT for hosting

// --- Database Connection Configuration ---
// IMPORTANT: Replace these with your actual database credentials
const dbConfig = {
    host: 'localhost', // Your MySQL host (e.g., 'localhost' or a specific IP/hostname)
    user: 'your_db_username', // Your MySQL username
    password: 'your_db_password', // Your MySQL password
    database: 'your_db_name',     // Your database name
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool; // Connection pool for efficient database connections

async function initializeDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        console.log('MySQL connection pool created.');

        // Test connection and ensure table exists
        const connection = await pool.getConnection();
        await connection.query(`
            CREATE TABLE IF NOT EXISTS alarm_settings (
                id INT(11) AUTO_INCREMENT PRIMARY KEY,
                active BOOLEAN NOT NULL DEFAULT FALSE,
                alarm_time VARCHAR(5) NOT NULL DEFAULT '',
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        // Check if there's an initial row, if not, insert one
        const [rows] = await connection.query("SELECT COUNT(*) AS count FROM alarm_settings");
        if (rows[0].count === 0) {
            await connection.query("INSERT INTO alarm_settings (active, alarm_time) VALUES (FALSE, '')");
            console.log('Initial alarm_settings row inserted.');
        }
        connection.release(); // Release the connection back to the pool
        console.log('Database table "alarm_settings" checked/created and initialized.');
    } catch (err) {
        console.error('Failed to connect to MySQL or create table:', err);
        // Exit process if database connection fails on startup
        process.exit(1);
    }
}

// --- Middleware ---
app.use(express.json()); // To parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // To parse URL-encoded request bodies (for form-like data)
app.use(cors()); // Enable CORS for all routes (important for ESP8266 and potentially different frontend domains)

// Serve static files from the 'public' directory
// Create a 'public' folder in the same directory as server.js
// and put index.html inside it.
app.use(express.static(path.join(__dirname, 'public')));

// --- API Endpoints ---

// API endpoint to get current alarm data
// Used by both frontend (AJAX) and ESP8266 (GET)
app.get('/api/status', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT active, alarm_time FROM alarm_settings WHERE id = 1 LIMIT 1");
        if (rows.length > 0) {
            const data = rows[0];
            data.active = Boolean(data.active); // Convert TINYINT(1) to boolean
            res.json(data);
        } else {
            // Should not happen if initial row is always inserted
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

    // Basic validation for HH:MM format
    if (!alarm_time || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(alarm_time)) {
        return res.status(400).json({ success: false, message: 'Invalid alarm time format. Use HH:MM.' });
    }

    try {
        await pool.query("UPDATE alarm_settings SET active = ?, alarm_time = ? WHERE id = 1", [true, alarm_time]);
        res.json({ success: true, active: true, alarm_time: alarm_time, message: 'Alarm set successfully!' });
    } catch (err) {
        console.error('Error setting alarm:', err);
        res.status(500).json({ success: false, message: 'Database error setting alarm.' });
    }
});

// API endpoint to reset alarm (used by frontend POST)
app.post('/api/reset-alarm', async (req, res) => {
    try {
        await pool.query("UPDATE alarm_settings SET active = ?, alarm_time = ? WHERE id = 1", [false, '']);
        res.json({ success: true, active: false, alarm_time: '', message: 'Alarm reset successfully.' });
    } catch (err) {
        console.error('Error resetting alarm:', err);
        res.status(500).json({ success: false, message: 'Database error resetting alarm.' });
    }
});

// API endpoint for ESP8266 to signal alarm stopped (POST)
app.post('/api/alarm-stopped', async (req, res) => {
    try {
        // Get current alarm_time before deactivating, to keep it stored
        const [currentRows] = await pool.query("SELECT alarm_time FROM alarm_settings WHERE id = 1 LIMIT 1");
        const currentAlarmTime = currentRows.length > 0 ? currentRows[0].alarm_time : '';

        await pool.query("UPDATE alarm_settings SET active = ? WHERE id = 1", [false]);
        res.json({ success: true, message: 'Alarm stopped by device.' });
    } catch (err) {
        console.error('Error handling alarm stopped signal:', err);
        res.status(500).json({ success: false, message: 'Database error.' });
    }
});

// --- Start Server ---
async function startServer() {
    await initializeDatabase(); // Ensure DB is ready before starting server
    app.listen(port, () => {
        console.log(`Node.js server listening at http://localhost:${port}`);
    });
}

startServer();
