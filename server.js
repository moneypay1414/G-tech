const express = require('express');
const oracledb = require('oracledb');
const cors = require('cors');
require('dotenv').config();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Oracle DB timeout settings
oracledb.connectionClass = 'POOLED';
oracledb.poolMax = 10;
oracledb.poolMin = 2;
oracledb.getConnectionTimeout = 120; // Increased to 120 seconds

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Oracle Database Configuration
const dbConfig = {
  user: process.env.DB_USER || 'CBS_DB_OPSUPP',
  password: process.env.DB_PASSWORD || 'CBS_DB_OPSUPP',
  connectString: `${process.env.DB_HOST || '172.168.101.238'}:${process.env.DB_PORT || 1521}/${process.env.DB_SERVICE || 'PDB1'}`
};

// Initialize Oracle connection pool
let connectionPool;
let poolRetries = 0;
const MAX_RETRIES = 3;

async function initializePool() {
  try {
    console.log(`[${new Date().toISOString()}] Attempting to connect to Oracle DB: ${dbConfig.connectString}`);
    
    connectionPool = await oracledb.createPool({
      user: dbConfig.user,
      password: dbConfig.password,
      connectString: dbConfig.connectString,
      poolMax: 10,
      poolMin: 2,
      poolIncrement: 1,
      connectionClass: 'POOLED',
      waitTimeout: 60000,
      enableStatistics: false,
      _enableOracleClientV12: true,
      accessToken: undefined,
      externalAuth: false,
      connectTimeout: 30
    });
    poolRetries = 0;
    console.log('[' + new Date().toISOString() + '] Oracle Connection Pool Created Successfully');
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] Error creating connection pool:', err.message);
    
    // Retry logic
    if (poolRetries < MAX_RETRIES) {
      poolRetries++;
      console.log(`[${new Date().toISOString()}] Retrying connection (${poolRetries}/${MAX_RETRIES}) in 5 seconds...`);
      setTimeout(initializePool, 5000);
    } else {
      console.error(`[${new Date().toISOString()}] Max retries (${MAX_RETRIES}) exceeded. Exiting.`);
      console.error(`[${new Date().toISOString()}] Please verify:
        1. Database host is reachable: ${dbConfig.connectString}
        2. Database service is running
        3. Firewall allows port 1512
        4. Credentials are correct (User: ${dbConfig.user})`);
      process.exit(1);
    }
  }
}

// Route to serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Diagnostic endpoint to check connection status
app.get('/api/health', async (req, res) => {
  try {
    if (!connectionPool) {
      return res.status(503).json({
        status: 'disconnected',
        message: 'Connection pool not initialized'
      });
    }

    console.log(`[${new Date().toISOString()}] Health check: Attempting to get connection...`);
    const connection = await connectionPool.getConnection();
    console.log(`[${new Date().toISOString()}] Health check: Connection obtained, running test query...`);
    
    // Try a simple query
    const result = await connection.execute('SELECT 1 FROM DUAL');
    await connection.close();
    
    res.json({
      status: 'connected',
      database: dbConfig.connectString,
      user: dbConfig.user,
      message: 'Database connection successful',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Health check failed:`, err.message);
    res.status(503).json({
      status: 'error',
      message: 'Database connection failed: ' + err.message,
      database: dbConfig.connectString,
      user: dbConfig.user,
      errorCode: err.code,
      suggestions: [
        '1. Verify the database host is reachable: ping 172.168.101.103',
        '2. Check if port 1512 is open: telnet 172.168.101.103 1512',
        '3. Confirm Oracle database service is running',
        '4. Verify firewall allows outbound connection to port 1512',
        '5. Test credentials with SQL*Plus or another tool first',
        '6. Ensure service name ZSSUAT is correct',
        '7. Check if you need to use original database: 172.168.101.238:1521'
      ],
      timestamp: new Date().toISOString()
    });
  }
});

// Fallback test endpoint - try original database
app.get('/api/test-original-db', async (req, res) => {
  const originalDb = '172.168.101.238:1521/PDB1';
  const originalUser = 'CBS_DB_OPSUPP';
  const originalPass = 'CBS_DB_OPSUPP';
  
  try {
    console.log(`[${new Date().toISOString()}] Testing original database: ${originalDb}`);
    
    const testPool = await oracledb.createPool({
      user: originalUser,
      password: originalPass,
      connectString: originalDb,
      poolMax: 2,
      poolMin: 1,
      connectTimeout: 10
    });
    
    const conn = await testPool.getConnection();
    const result = await conn.execute('SELECT 1 FROM DUAL');
    await conn.close();
    await testPool.close();
    
    res.json({
      status: 'connected',
      message: 'Original database is reachable',
      database: originalDb,
      user: originalUser,
      action: 'Use these credentials instead if current settings fail'
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      message: 'Original database also unreachable: ' + err.message,
      database: originalDb,
      error: err.code
    });
  }
});

// API Route to update STATUS_V
app.post('/api/update-status', async (req, res) => {
  const { mobileNumber, statusValue } = req.body;

  // Validation
  if (!mobileNumber || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'Mobile number and status value are required' 
    });
  }

  let connection;
  try {
    // Get connection from pool
    console.log(`[${new Date().toISOString()}] Getting connection from pool for mobile: ${mobileNumber}`);
    connection = await connectionPool.getConnection();
    console.log(`[${new Date().toISOString()}] Connection obtained successfully`);

    // First, check the current status
    const selectQuery = `SELECT STATUS_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                        WHERE MOBILE_NUMBER_V = :mobileNumber`;
    
    const currentResult = await connection.execute(
      selectQuery,
      { mobileNumber: mobileNumber }
    );

    if (currentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

    const currentStatus = currentResult.rows[0][0];
    const restrictedCurrentStatuses = ['A', 'Z', 'N'];

    // Check if current status is restricted
    if (restrictedCurrentStatuses.includes(currentStatus.toString().toUpperCase())) {
      return res.status(400).json({
        success: false,
        message: `Current status can't be updated. Mobile number ${mobileNumber} has restricted status: ${currentStatus}`
      });
    }

    // Update query
    const updateQuery = `UPDATE CBS_CORE.GSM_MOBILE_MASTER 
                        SET STATUS_V = :statusValue 
                        WHERE MOBILE_NUMBER_V = :mobileNumber`;

    const result = await connection.execute(
      updateQuery,
      {
        statusValue: statusValue,
        mobileNumber: mobileNumber
      },
      { autoCommit: true }
    );

    if (result.rowsAffected > 0) {
      res.json({
        success: true,
        message: `Status updated successfully for mobile number: ${mobileNumber}`,
        rowsUpdated: result.rowsAffected
      });
    } else {
      res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to update STATUS_V in GSM_SIMS_MASTER (supports comma or space separated entries)
app.post('/api/update-sims-status', async (req, res) => {
  const { simIdentifier, statusValue } = req.body;

  // Validation
  if (!simIdentifier || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'SIM identifier (comma or space separated) and status value are required' 
    });
  }

  let connection;
  try {
    // Parse input - support comma and space separated values
    const simList = simIdentifier
      .split(/[,\s]+/) // Split by comma or space
      .map(sim => sim.trim())
      .filter(sim => sim.length > 0);

    if (simList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid SIM identifiers provided'
      });
    }

    console.log(`[${new Date().toISOString()}] Updating GSM_SIMS_MASTER for ${simList.length} SIM(s): ${simList.join(', ')}`);
    
    connection = await connectionPool.getConnection();
    
    let successCount = 0;
    let restrictedCount = 0;
    let failureCount = 0;
    const failedSims = [];
    
    // Process each SIM identifier
    for (const sim of simList) {
      try {
        // First, check the current status
        const selectQuery = `SELECT STATUS_V FROM CBS_CORE.GSM_SIMS_MASTER 
                            WHERE SIM_IDENTIFIER_V = :simId`;
        
        const currentResult = await connection.execute(
          selectQuery,
          { simId: sim }
        );

        if (currentResult.rows.length === 0) {
          failureCount++;
          failedSims.push(`${sim} (not found)`);
          continue;
        }

        const currentStatus = currentResult.rows[0][0];

        // Check if current status is 'A' (restricted)
        if (currentStatus.toString().toUpperCase() === 'A') {
          restrictedCount++;
          failedSims.push(`${sim} (status is A - cannot update)`);
          continue;
        }

        // Update query for GSM_SIMS_MASTER
        const updateQuery = `UPDATE CBS_CORE.GSM_SIMS_MASTER 
                            SET STATUS_V = :statusValue 
                            WHERE SIM_IDENTIFIER_V = :simId`;

        const result = await connection.execute(
          updateQuery,
          {
            statusValue: statusValue,
            simId: sim
          },
          { autoCommit: true }
        );

        if (result.rowsAffected > 0) {
          successCount++;
          console.log(`[${new Date().toISOString()}] Updated SIM ${sim} status to ${statusValue}`);
        } else {
          failureCount++;
          failedSims.push(`${sim} (no rows affected)`);
        }
      } catch (err) {
        failureCount++;
        failedSims.push(`${sim} (error: ${err.message})`);
        console.error(`[${new Date().toISOString()}] Error updating SIM ${sim}:`, err.message);
      }
    }

    let message = `Updated ${successCount} SIM(s) successfully`;
    if (restrictedCount > 0) message += ` | Skipped ${restrictedCount} SIM(s) with status A`;
    if (failureCount > 0) {
      message += ` | Failed: ${failureCount}`;
      message += ` | Issues: ${failedSims.join('; ')}`;
    }

    res.json({
      success: successCount > 0,
      message: message,
      summary: {
        total: simList.length,
        updated: successCount,
        restricted: restrictedCount,
        failed: failureCount
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to update STATUS_V in GSM_SIMS_MASTER by SIM_NUM_V (supports comma or space separated entries)
app.post('/api/update-sim-num-status', async (req, res) => {
  const { simNum, statusValue } = req.body;

  // Validation
  if (!simNum || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'SIM number (comma or space separated) and status value are required' 
    });
  }

  let connection;
  try {
    // Parse input - support comma and space separated values
    const simNumList = simNum
      .split(/[,\s]+/) // Split by comma or space
      .map(num => num.trim())
      .filter(num => num.length > 0);

    if (simNumList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid SIM numbers provided'
      });
    }

    console.log(`[${new Date().toISOString()}] Updating GSM_SIMS_MASTER by SIM_NUM_V for ${simNumList.length} SIM(s): ${simNumList.join(', ')}`);
    
    connection = await connectionPool.getConnection();
    
    let successCount = 0;
    let restrictedCount = 0;
    let failureCount = 0;
    const failedSims = [];
    
    // Process each SIM number
    for (const num of simNumList) {
      try {
        // First, check the current status
        const selectQuery = `SELECT STATUS_V FROM CBS_CORE.GSM_SIMS_MASTER 
                            WHERE SIM_NUM_V = :simNum`;
        
        const currentResult = await connection.execute(
          selectQuery,
          { simNum: num }
        );

        if (currentResult.rows.length === 0) {
          failureCount++;
          failedSims.push(`${num} (not found)`);
          continue;
        }

        const currentStatus = currentResult.rows[0][0];

        // Check if current status is 'A' (restricted)
        if (currentStatus.toString().toUpperCase() === 'A') {
          restrictedCount++;
          failedSims.push(`${num} (status is A - cannot update)`);
          continue;
        }

        // Update query for GSM_SIMS_MASTER by SIM_NUM_V
        const updateQuery = `UPDATE CBS_CORE.GSM_SIMS_MASTER 
                            SET STATUS_V = :statusValue 
                            WHERE SIM_NUM_V = :simNum`;

        const result = await connection.execute(
          updateQuery,
          {
            statusValue: statusValue,
            simNum: num
          },
          { autoCommit: true }
        );

        if (result.rowsAffected > 0) {
          successCount++;
          console.log(`[${new Date().toISOString()}] Updated SIM number ${num} status to ${statusValue}`);
        } else {
          failureCount++;
          failedSims.push(`${num} (no rows affected)`);
        }
      } catch (err) {
        failureCount++;
        failedSims.push(`${num} (error: ${err.message})`);
        console.error(`[${new Date().toISOString()}] Error updating SIM number ${num}:`, err.message);
      }
    }

    let message = `Updated ${successCount} SIM number(s) successfully`;
    if (restrictedCount > 0) message += ` | Skipped ${restrictedCount} SIM(s) with status A`;
    if (failureCount > 0) {
      message += ` | Failed: ${failureCount}`;
      message += ` | Issues: ${failedSims.join('; ')}`;
    }

    res.json({
      success: successCount > 0,
      message: message,
      summary: {
        total: simNumList.length,
        updated: successCount,
        restricted: restrictedCount,
        failed: failureCount
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route to get status (optional - for verification)
app.get('/api/get-status/:mobileNumber', async (req, res) => {
  const { mobileNumber } = req.params;

  let connection;
  try {
    connection = await connectionPool.getConnection();

    const query = `SELECT MOBILE_NUMBER_V, STATUS_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                   WHERE MOBILE_NUMBER_V = :mobileNumber`;

    const result = await connection.execute(query, { mobileNumber: mobileNumber });

    if (result.rows.length > 0) {
      res.json({
        success: true,
        data: {
          mobileNumber: result.rows[0][0],
          status: result.rows[0][1]
        }
      });
    } else {
      res.status(404).json({
        success: false,
        message: `No record found for mobile number: ${mobileNumber}`
      });
    }

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// API Route for bulk update
app.post('/api/bulk-update-status', async (req, res) => {
  const { mobileNumbers, statusValue } = req.body;

  // Validation
  if (!mobileNumbers || !Array.isArray(mobileNumbers) || mobileNumbers.length === 0 || statusValue === undefined) {
    return res.status(400).json({ 
      success: false, 
      message: 'Mobile numbers array and status value are required' 
    });
  }

  let connection;
  try {
    connection = await connectionPool.getConnection();

    let successCount = 0;
    let failureCount = 0;
    let restrictedCount = 0;
    const failedNumbers = [];

    // Process each mobile number
    for (const mobileNumber of mobileNumbers) {
      try {
        // First, check the current status
        const selectQuery = `SELECT STATUS_V FROM CBS_CORE.GSM_MOBILE_MASTER 
                            WHERE MOBILE_NUMBER_V = :mobileNumber`;
        
        const currentResult = await connection.execute(
          selectQuery,
          { mobileNumber: mobileNumber.trim() }
        );

        if (currentResult.rows.length === 0) {
          failureCount++;
          failedNumbers.push(`${mobileNumber} - Not found`);
          continue;
        }

        const currentStatus = currentResult.rows[0][0];
        const restrictedCurrentStatuses = ['A', 'Z', 'N'];

        // Check if current status is restricted
        if (restrictedCurrentStatuses.includes(currentStatus.toString().toUpperCase())) {
          restrictedCount++;
          failedNumbers.push(`${mobileNumber} - Restricted status (${currentStatus})`);
          continue;
        }

        // Update the status
        const updateQuery = `UPDATE CBS_CORE.GSM_MOBILE_MASTER 
                            SET STATUS_V = :statusValue 
                            WHERE MOBILE_NUMBER_V = :mobileNumber`;

        const result = await connection.execute(
          updateQuery,
          {
            statusValue: statusValue,
            mobileNumber: mobileNumber.trim()
          },
          { autoCommit: true }
        );

        if (result.rowsAffected > 0) {
          successCount++;
        } else {
          failureCount++;
          failedNumbers.push(`${mobileNumber} - Update failed`);
        }
      } catch (err) {
        failureCount++;
        failedNumbers.push(`${mobileNumber} - Error: ${err.message}`);
      }
    }

    // Build response message
    let message = `Updated: ${successCount}, Restricted: ${restrictedCount}, Failed: ${failureCount}`;
    if (failedNumbers.length > 0 && failedNumbers.length <= 5) {
      message += ` | Issues: ${failedNumbers.join('; ')}`;
    }

    res.json({
      success: successCount > 0,
      message: message,
      summary: {
        total: mobileNumbers.length,
        updated: successCount,
        restricted: restrictedCount,
        failed: failureCount
      }
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
});

// Start the server
app.listen(PORT, async () => {
  await initializePool();
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  if (connectionPool) {
    try {
      await connectionPool.close();
      console.log('Connection pool closed');
    } catch (err) {
      console.error('Error closing pool:', err);
    }
  }
  process.exit(0);
});
