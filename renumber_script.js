require('dotenv').config();
const { Pool } = require('pg');

// Load configuration (env vars override config.json)
const configFile = require('./config.json');
const config = {
  ...configFile,
  database: {
    ...configFile.database,
    host: process.env.DATABASE_HOST || configFile.database.host,
    port: parseInt(process.env.DATABASE_PORT || configFile.database.port, 10),
    database: process.env.DATABASE_NAME || configFile.database.database,
    user: process.env.DATABASE_USER || configFile.database.user,
    password: process.env.DATABASE_PASSWORD || configFile.database.password
  }
};

// Create PostgreSQL connection pool
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

async function renumberMembers() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Starting member renumbering process...');
    
    // Get all members ordered by current member_number (lowest first)
    const result = await client.query(`
      SELECT member_id, member_number, username 
      FROM member_numbers 
      ORDER BY member_number ASC
    `);
    
    if (result.rows.length === 0) {
      console.log('❌ No members found in database');
      return;
    }
    
    console.log(`📊 Found ${result.rows.length} members to renumber`);
    console.log(`🎯 Starting from number 2000`);
    
    let newNumber = 2000;
    let updatedCount = 0;
    
    // Renumber each member
    for (const row of result.rows) {
      const oldNumber = row.member_number;
      const memberId = row.member_id;
      const username = row.username;
      
      // Update the member number in database
      await client.query(`
        UPDATE member_numbers 
        SET member_number = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE member_id = $2
      `, [newNumber, memberId]);
      
      console.log(`✅ ${username} (${memberId}): ${oldNumber} → ${newNumber}`);
      
      newNumber++;
      updatedCount++;
    }
    
    // Update the bot_state table with the new next_number
    await client.query(`
      INSERT INTO bot_state (key, value, updated_at) 
      VALUES ('next_number', $1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) 
      DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP
    `, [newNumber.toString()]);
    
    console.log('\n🎉 Renumbering completed successfully!');
    console.log(`📈 Total members updated: ${updatedCount}`);
    console.log(`🔢 New next number: ${newNumber}`);
    console.log(`📊 Number range: 2000 - ${newNumber - 1}`);
    
    // Show summary of changes
    console.log('\n📋 Summary of changes:');
    const summaryResult = await client.query(`
      SELECT 
        MIN(member_number) as min_number,
        MAX(member_number) as max_number,
        COUNT(*) as total_members
      FROM member_numbers
    `);
    
    const summary = summaryResult.rows[0];
    console.log(`   • Lowest number: ${summary.min_number}`);
    console.log(`   • Highest number: ${summary.max_number}`);
    console.log(`   • Total members: ${summary.total_members}`);
    
  } catch (error) {
    console.error('❌ Error during renumbering:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    console.log('🚀 Starting member renumbering script...');
    console.log(`🔗 Connecting to database: ${config.database.database}@${config.database.host}:${config.database.port}`);
    
    await renumberMembers();
    
    console.log('\n✅ Script completed successfully!');
    console.log('💡 Remember to restart your Discord bot to load the new numbering!');
    
  } catch (error) {
    console.error('💥 Script failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('🔌 Database connection closed');
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { renumberMembers };
