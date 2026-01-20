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

async function initializePool() {
  try {
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
      externalAuth: false
    });
    // Set connection timeout for individual connections
    oracledb.connectionString = dbConfig.connectString;
    console.log('Oracle Connection Pool Created Successfully');
  } catch (err) {
    console.error('Error creating connection pool:', err);
    process.exit(1);
  }
}

// Route to serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    connection = await connectionPool.getConnection();

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
