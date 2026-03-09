require('dotenv').config();
const { Pool } = require('pg');

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

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password
});

async function previewRenumbering() {
  const client = await pool.connect();
  
  try {
    console.log('👀 Previewing member renumbering (no changes will be made)...\n');
    
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
    console.log(`🎯 Would start from number 2000\n`);
    
    let newNumber = 2000;
    let updatedCount = 0;
    
    console.log('📋 Preview of changes:');
    console.log('='.repeat(60));
    
    // Show what would change
    for (const row of result.rows) {
      const oldNumber = row.member_number;
      const username = row.username;
      
      console.log(`${username.padEnd(20)} ${oldNumber.toString().padStart(4)} → ${newNumber.toString().padStart(4)}`);
      
      newNumber++;
      updatedCount++;
    }
    
    console.log('='.repeat(60));
    console.log(`\n📈 Total members that would be updated: ${updatedCount}`);
    console.log(`🔢 New next number would be: ${newNumber}`);
    console.log(`📊 Number range would be: 2000 - ${newNumber - 1}`);
    
    console.log('\n💡 To apply these changes, run: node renumber_script.js');
    
  } catch (error) {
    console.error('❌ Error during preview:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

previewRenumbering();
