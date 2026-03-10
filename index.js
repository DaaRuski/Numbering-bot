require('dotenv').config();
const { Client, GatewayIntentBits, Events, Partials, ActivityType, ApplicationCommandType, REST, Routes } = require('discord.js');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Load configuration (env vars override config.json for sensitive values)
let configFile;
try {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('config.json not found. Copy config.example.json to config.json and fill in your values.');
  }
  configFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('❌ Error loading config.json:', err.message);
  process.exit(1);
}
const config = {
  ...configFile,
  token: process.env.DISCORD_TOKEN || configFile.token,
  startingNumber: process.env.STARTING_NUMBER ? parseInt(process.env.STARTING_NUMBER, 10) : (configFile.startingNumber ?? 2000),
  skipRoleIds: process.env.SKIP_ROLE_IDS
    ? process.env.SKIP_ROLE_IDS.split(',').map(id => id.trim()).filter(Boolean)
    : (configFile.skipRoleIds || []),
  database: {
    ...(configFile.database || {}),
    host: process.env.DATABASE_HOST || configFile.database?.host || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || configFile.database?.port || '3306', 10),
    database: process.env.DATABASE_NAME || configFile.database?.database || 'lsrp_bot',
    user: process.env.DATABASE_USER || configFile.database?.user || 'root',
    password: process.env.DATABASE_PASSWORD || configFile.database?.password
  }
};

// Validate required config
if (!config.token) {
  console.error('❌ Error: DISCORD_TOKEN (or config.json token) is required. Set it in .env or config.json.');
  process.exit(1);
}
if (!config.database?.password) {
  console.error('❌ Error: DATABASE_PASSWORD (or config.json database.password) is required.');
  process.exit(1);
}

const skipRoleIds = (config.skipRoleIds || []).filter(id => id && id.trim() !== '');
if (skipRoleIds.length === 0) {
  console.warn('⚠️ No skip roles configured. Add role IDs to config.json skipRoleIds or SKIP_ROLE_IDS in .env (comma-separated) to exclude members from numbering.');
}

// NOTE: This bot automatically skips guild owners due to permission limitations.
// Guild owners cannot have their nicknames modified by bots, so they are excluded
// from all nickname operations and number assignments.

// ===== RATE LIMITING =====
const rateLimitConfig = config.rateLimit || { enabled: true, maxCommands: 10, windowMs: 60000 };
const rateLimitExempt = new Set(config.rateLimit?.exemptCommands || ['ping']);
const userCommandTimestamps = new Map();

function isRateLimited(userId, commandName) {
  if (!rateLimitConfig.enabled) return false;
  if (rateLimitExempt.has(commandName)) return false;

  const now = Date.now();
  const windowMs = rateLimitConfig.windowMs || 60000;
  const maxCommands = rateLimitConfig.maxCommands || 10;

  let timestamps = userCommandTimestamps.get(userId);
  if (!timestamps) {
    userCommandTimestamps.set(userId, [now]);
    return false;
  }

  timestamps = timestamps.filter(t => now - t < windowMs);
  if (timestamps.length >= maxCommands) {
    const oldest = timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { retryAfter };
  }
  timestamps.push(now);
  userCommandTimestamps.set(userId, timestamps);
  return false;
}

// Clean up old entries periodically
setInterval(() => {
  const cutoff = Date.now() - (rateLimitConfig.windowMs || 60000);
  for (const [userId, timestamps] of userCommandTimestamps.entries()) {
    const filtered = timestamps.filter(t => t > cutoff);
    if (filtered.length === 0) userCommandTimestamps.delete(userId);
    else userCommandTimestamps.set(userId, filtered);
  }
}, 60000);

// ===== EMBED HELPER FUNCTIONS =====
function createEmbed(type, title, description, fields = [], color = null, user = null) {
  const embedColors = {
    success: 0x00ff00,    // Green
    error: 0xff0000,      // Red
    info: 0x0099ff,       // Blue
    warning: 0xffaa00,    // Orange
    neutral: 0x808080     // Gray
  };
  
  const embed = {
    color: color || embedColors[type] || embedColors.neutral,
    title: title,
    description: description,
    timestamp: new Date().toISOString()
  };
  
  if (fields.length > 0) {
    embed.fields = fields;
  }
  
  // Add user avatar if provided
  if (user && user.displayAvatarURL) {
    embed.thumbnail = { url: user.displayAvatarURL({ size: 256 }) };
  }
  
  return embed;
 }

function createSuccessEmbed(title, description, fields = [], user = null) {
  return createEmbed('success', `✅ ${title}`, description, fields, null, user);
}

function createErrorEmbed(title, description, fields = [], user = null) {
  return createEmbed('error', `❌ ${title}`, description, fields, null, user);
}

function createInfoEmbed(title, description, fields = [], user = null) {
  return createEmbed('info', `ℹ️ ${title}`, description, fields, null, user);
}

function createWarningEmbed(title, description, fields = [], user = null) {
  return createEmbed('warning', `⚠️ ${title}`, description, fields, null, user);
}

// Create MariaDB connection pool
const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port || 3306,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
});

// Create Discord client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.GuildMember]
});

// ===== SLASH COMMAND DEFINITIONS =====
const commands = [
  {
    name: 'status',
    description: 'Show bot status information',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'validate',
    description: 'Validate and correct the next number',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'refresh',
    description: 'Force refresh bot status',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'remove',
    description: 'Remove a member\'s badge number',
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: 'user',
        description: 'User ID to remove',
        type: 3, // STRING type
        required: true
      }
    ]
  },
  {
    name: 'edituser',
    description: 'Edit a user\'s badge number or name',
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: 'user',
        description: 'User to edit',
        type: 6, // USER type
        required: true
      },
      {
        name: 'badge_number',
        description: 'New badge number (leave empty to keep current)',
        type: 4, // INTEGER type
        required: false
      },
      {
        name: 'username',
        description: 'New username to store (leave empty to keep current)',
        type: 3, // STRING type
        required: false
      }
    ]
  },
  {
    name: 'cleanup',
    description: 'Clean up members no longer in the server',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'welcome',
    description: 'Send welcome message to a specific user',
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: 'user',
        description: 'User to send welcome message to',
        type: 6, // USER type
        required: true
      }
    ]
  },
  {
    name: 'testwelcome',
    description: 'Test the welcome message system',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'welcomeconfig',
    description: 'Show welcome message configuration',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'previewwelcome',
    description: 'Preview how the welcome message will look',
    type: ApplicationCommandType.ChatInput
  },

  {
    name: 'adduser',
    description: 'Add a user to the database with a specific badge number',
    type: ApplicationCommandType.ChatInput,
    options: [
      {
        name: 'user',
        description: 'User to add to the database',
        type: 6, // USER type
        required: true
      },
      {
        name: 'badge_number',
        description: 'Badge number to assign (leave empty for next available)',
        type: 4, // INTEGER type
        required: false
      },
      {
        name: 'username',
        description: 'Username to store (leave empty to use Discord username)',
        type: 3, // STRING type
        required: false
      }
    ]
  },
  {
    name: 'ping',
    description: 'Test if the bot is responding',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'health',
    description: 'Health check and uptime for monitoring',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'reserved',
    description: 'List reserved badge numbers (skipped during auto-assignment)',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'permissions',
    description: 'Show command permissions and your current access',
    type: ApplicationCommandType.ChatInput
  },

];

// ===== COMMAND PERMISSIONS =====
const commandPermissions = {
  // Basic commands - everyone can use
  'ping': [],
  'status': [],
  'health': [],
  'reserved': [],
  
  // Management commands - require specific roles
  'validate': ['director', 'management','admin', 'moderator'],
  'refresh': ['director', 'management','admin', 'moderator'],
  'remove': ['director', 'management','admin', 'moderator'],
  'edituser': ['director', 'management','admin', 'moderator'],
  'adduser': ['director', 'management','admin', 'moderator'],
  'cleanup': ['director', 'management','admin', 'moderator'],
  
  // Welcome message commands - require specific roles
  'welcome': ['director', 'management','admin', 'moderator'],
  'testwelcome': ['director', 'management','admin', 'moderator'],
  'welcomeconfig': ['director', 'management','admin', 'moderator'],
  'previewwelcome': ['director', 'management','admin', 'moderator'],

  
  // Permission command - everyone can use
  'permissions': [],

};

// Check if user has permission to use a command
function hasCommandPermission(member, commandName) {
  // If no permissions defined for command, allow everyone
  if (!commandPermissions[commandName]) {
    return true;
  }
  
  // If empty array, allow everyone
  if (commandPermissions[commandName].length === 0) {
    return true;
  }
  
  // Check if user has any of the required roles
  const requiredRoles = commandPermissions[commandName];
  
  // Check against role IDs from config
  for (const roleName of requiredRoles) {
    const roleId = config.rolePermissions?.[roleName];
    if (roleId && member.roles.cache.has(roleId)) {
      return true;
    }
  }
  
  return false;
}

// Check if interaction is still valid (not expired)
function isInteractionValid(interaction) {
  try {
    // Check if the interaction can still be replied to
    return interaction.isRepliable();
  } catch (error) {
    return false;
  }
}

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    
    console.log('🔄 Registering slash commands...');
    
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    
    console.log('✅ Slash commands registered successfully!');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
}

// ===== STATUS MANAGEMENT =====
const statusPresets = (config.status && config.status.presets) 
  ? config.status.presets.map(preset => ({
      text: preset.text,
      type: ActivityType[preset.type]
    }))
  : [
      {
        text: `LSRP`,
        type: ActivityType.Playing
      },
      {
        text: `Next: #{nextNumber}`,
        type: ActivityType.Watching
      }
    ];

let currentStatusIndex = 0;
let statusInterval;

// Update bot status with current data
function updateStatus() {
  try {
    if (statusPresets.length === 0 || nextNumber < 1) return;
    
    const status = statusPresets[currentStatusIndex];
    let displayText = status.text
      .replace('{nextNumber}', nextNumber)
      .replace('{memberCount}', memberNumbers.size);
    
    client.user.setActivity(displayText, { type: status.type });

    // Move to next status
    currentStatusIndex = (currentStatusIndex + 1) % statusPresets.length;
  } catch (error) {
    console.error('Error updating status:', error);
  }
}

// Force immediate status update
function forceStatusUpdate() {
  try {
    if (statusPresets.length === 0 || nextNumber < 1) return;
    
    const status = statusPresets[currentStatusIndex];
    let displayText = status.text
      .replace('{nextNumber}', nextNumber)
      .replace('{memberCount}', memberNumbers.size);
    
    client.user.setActivity(displayText, { type: status.type });
  } catch (error) {
    console.error('Error forcing status update:', error);
  }
}

// Start status cycling
function startStatusCycling() {
  try {
    if (!config.status?.presets?.length) {
      console.log('No status configuration found, status cycling disabled');
      return;
    }
    
    if (nextNumber < 1) {
      console.log('Waiting for valid nextNumber before starting status cycling...');
      setTimeout(startStatusCycling, 1000);
      return;
    }
    
    console.log(`Starting status cycling (Next: ${nextNumber}, Members: ${memberNumbers.size})`);
    
    // Update status immediately
    updateStatus();
    
    // Set interval to cycle status
    const interval = config.status.cycleInterval || 30000;
    statusInterval = setInterval(updateStatus, interval);
    console.log(`Status cycling started - every ${interval / 1000} seconds`);
    
    // Periodic validation every 5 minutes
    setInterval(async () => {
      await validateNextNumber();
      forceStatusUpdate();
    }, 5 * 60 * 1000);
    console.log('Periodic validation started - every 5 minutes');
    
    // Periodic cleanup every 10 minutes to remove users who left without triggering events
    setInterval(async () => {
      try {
        const guild = client.guilds.cache.get(config.guildId);
        if (!guild) return;
        
        let removedCount = 0;
        const membersToRemove = [];
        
        // Check all stored member numbers against current guild members
        for (const [memberId, number] of memberNumbers.entries()) {
          const guildMember = await guild.members.fetch(memberId).catch(() => null);
          if (!guildMember) {
            membersToRemove.push({ id: memberId, number });
          }
        }
        
        // Remove members who are no longer in the guild
        for (const member of membersToRemove) {
          memberNumbers.delete(member.id);
          await removeMemberNumberFromDatabase(member.id);
          removedCount++;
        }
        
        if (removedCount > 0) {
          console.log(`🧹 Periodic cleanup: Removed ${removedCount} members no longer in server`);
          await validateNextNumber();
          forceStatusUpdate();
        }
      } catch (error) {
        console.error('Error during periodic cleanup:', error);
      }
    }, 10 * 60 * 1000);
    console.log('Periodic cleanup started - every 10 minutes');
  } catch (error) {
    console.error('Error starting status cycling:', error);
  }
}

// Stop status cycling
function stopStatusCycling() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
    console.log('Status cycling stopped');
  }
}

// ===== MEMBER NUMBERING =====
let memberNumbers = new Map();
let nextNumber = config.startingNumber;

function getReservedNumbers() {
  return (config.reservedNumbers || []).filter(n => typeof n === 'number' && n >= 0);
}

function getNextAvailableNumber() {
  const reserved = getReservedNumbers();
  while (reserved.includes(nextNumber)) {
    nextNumber++;
  }
  return nextNumber++;
}

// Validate and correct nextNumber
async function validateNextNumber() {
  try {
    if (memberNumbers.size === 0) {
      nextNumber = config.startingNumber;
      const reserved = getReservedNumbers();
      while (reserved.includes(nextNumber)) nextNumber++;
      console.log(`No members found, setting nextNumber to ${nextNumber}`);
      await updateNextNumberInDatabase();
      return;
    }

    const highestExisting = Math.max(...Array.from(memberNumbers.values()));
    let expectedNext = Math.max(highestExisting + 1, config.startingNumber);
    const reserved = getReservedNumbers();
    while (reserved.includes(expectedNext)) expectedNext++;

    if (nextNumber !== expectedNext) {
      console.log(`🔧 Correcting nextNumber from ${nextNumber} to ${expectedNext}`);
      nextNumber = expectedNext;
      await updateNextNumberInDatabase();
    } else {
      console.log(`✅ nextNumber is correct: ${nextNumber}`);
    }
  } catch (error) {
    console.error('Error validating nextNumber:', error);
  }
}

// ===== DATABASE FUNCTIONS =====
async function initializeDatabase() {
  try {
    // Create member_numbers table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS member_numbers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        member_id VARCHAR(20) UNIQUE NOT NULL,
        member_number INT NOT NULL,
        username VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create bot_state table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS bot_state (
        id INT AUTO_INCREMENT PRIMARY KEY,
        \`key\` VARCHAR(50) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Ensure next_number row exists
    await pool.execute(`
      INSERT IGNORE INTO bot_state (\`key\`, value, updated_at)
      VALUES ('next_number', ?, CURRENT_TIMESTAMP)
    `, [config.startingNumber.toString()]);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1);
  }
}

// Load existing member numbers from database
async function loadMemberNumbers() {
  try {
    const [rows] = await pool.execute(
      'SELECT member_id, member_number, username FROM member_numbers ORDER BY member_number'
    );

    memberNumbers.clear();
    let highestNumber = config.startingNumber - 1;

    rows.forEach(row => {
      memberNumbers.set(row.member_id, row.member_number);
      if (row.member_number > highestNumber) {
        highestNumber = row.member_number;
      }
    });

    nextNumber = Math.max(highestNumber + 1, config.startingNumber);
    const reserved = getReservedNumbers();
    while (reserved.includes(nextNumber)) nextNumber++;
    console.log(`Loaded ${memberNumbers.size} members, nextNumber: ${nextNumber}`);

    // Validate and correct if needed
    await validateNextNumber();
  } catch (error) {
    console.error('Error loading member numbers:', error);
  }
}

// Load stored usernames and update nicknames for existing members
async function loadStoredUsernames() {
  try {
    const [rows] = await pool.execute(
      'SELECT member_id, member_number, username FROM member_numbers ORDER BY member_number'
    );
    
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.log('⚠️ Guild not found, skipping username loading');
      return;
    }
    
    let updatedCount = 0;
    
    for (const row of rows) {
      try {
        const guildMember = await guild.members.fetch(row.member_id).catch(() => null);
        if (guildMember) {
          // Skip guild owner since bot cannot work with owners due to permissions
          if (guildMember.id === guild.ownerId) {
            console.log(`⚠️ Skipping guild owner ${guildMember.user.tag} during nickname update`);
            continue;
          }
          
          const expectedNickname = `${row.member_number} | ${row.username}`;
          
                     // Only update if nickname is different
           if (guildMember.nickname !== expectedNickname) {
             try {
               await guildMember.setNickname(expectedNickname);
               console.log(`🔄 Updated nickname for ${guildMember.user.tag} to: ${expectedNickname}`);
               updatedCount++;
             } catch (nicknameError) {
               if (nicknameError.code === 50013) {
                 console.log(`⚠️ Could not update nickname for ${guildMember.user.tag} - Missing permissions.`);
               } else {
                 console.error(`Error updating nickname for ${guildMember.user.tag}:`, nicknameError);
               }
             }
           }
        }
      } catch (error) {
        console.error(`Error updating nickname for member ${row.member_id}:`, error);
      }
    }
    
    if (updatedCount > 0) {
      console.log(`✅ Updated ${updatedCount} member nicknames with stored usernames`);
    } else {
      console.log(`ℹ️ All member nicknames are already up to date`);
    }
  } catch (error) {
    console.error('Error loading stored usernames:', error);
  }
}

// Save member number to database
async function saveMemberNumberToDatabase(memberId, number, username) {
  try {
    await pool.execute(`
      INSERT INTO member_numbers (member_id, member_number, username) 
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        member_number = VALUES(member_number), 
        username = VALUES(username), 
        updated_at = CURRENT_TIMESTAMP
    `, [memberId, number, username]);
  } catch (error) {
    console.error('Error saving member number:', error);
  }
}

// Update user information in database
async function updateUserInDatabase(memberId, number, username) {
  try {
    await pool.execute(`
      UPDATE member_numbers 
      SET 
        member_number = ?, 
        username = ?, 
        updated_at = CURRENT_TIMESTAMP
      WHERE member_id = ?
    `, [number, username, memberId]);
  } catch (error) {
    console.error('Error updating user information:', error);
  }
}

// Update next number in database (upsert handles both insert and update)
async function updateNextNumberInDatabase() {
  try {
    await pool.execute(`
      INSERT INTO bot_state (\`key\`, value, updated_at)
      VALUES ('next_number', ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP
    `, [nextNumber.toString()]);
  } catch (error) {
    console.error('Error updating next number in database:', error);
  }
}

// Remove member number from database
async function removeMemberNumberFromDatabase(memberId) {
  try {
    await pool.execute(
      'DELETE FROM member_numbers WHERE member_id = ?',
      [memberId]
    );
  } catch (error) {
    console.error('Error removing member number:', error);
  }
}

// ===== MEMBER MANAGEMENT =====
function getSkipRoleIds() {
  return (config.skipRoleIds || []).filter(id => id && id.trim() !== '');
}

function shouldSkipMember(member) {
  if (member.user.bot) return true;

  // Skip guild owner since bot cannot work with owners due to permissions
  if (member.id === member.guild.ownerId) return true;

  for (const skipRoleId of getSkipRoleIds()) {
    if (member.roles.cache.has(skipRoleId)) {
      return true;
    }
  }

  return false;
}

// Get skip reason for logging purposes
function getSkipReason(member) {
  if (member.user.bot) return 'bot';
  if (member.id === member.guild.ownerId) return 'guild owner';
  if (!canManageMember(member)) return 'cannot be managed by bot';
  
  for (const skipRoleId of getSkipRoleIds()) {
    if (member.roles.cache.has(skipRoleId)) {
      return 'skip role';
    }
  }
  return null;
}

// Check if member can be managed by the bot
function canManageMember(member) {
  // Bot can't manage guild owner
  if (member.id === member.guild.ownerId) return false;
  
  // Bot can't manage members with higher roles
  if (!member.manageable) return false;
  
  // Bot needs ManageNicknames permission
  const botMember = member.guild.members.cache.get(client.user.id);
  if (!botMember || !botMember.permissions.has('ManageNicknames')) return false;
  
  return true;
}

// Assign number to member without nickname update (for unmanageable members)
async function assignNumberWithoutNickname(member, number) {
  try {
    memberNumbers.set(member.id, number);
    await saveMemberNumberToDatabase(member.id, number, member.user.username);
    await updateNextNumberInDatabase();
    console.log(`✅ Assigned number ${number} to ${member.user.tag} (Next: ${nextNumber}) - Nickname update skipped due to permission limitations`);
    forceStatusUpdate();
  } catch (error) {
    console.error(`Error assigning number without nickname to ${member.user.tag}:`, error);
  }
}

// Assign number to a member
async function assignNumberToMember(member) {
  try {
    // Fetch fresh member data to ensure we have up-to-date roles (handles cache staleness)
    try {
      member = await member.fetch();
    } catch (fetchErr) {
      console.warn(`Could not fetch member ${member.user?.tag || member.id}:`, fetchErr.message);
    }

    // If member has a number but should be skipped (e.g. has skip role), remove it first
    if (memberNumbers.has(member.id) && shouldRemoveNumber(member)) {
      await removeNumberFromMember(member);
      return;
    }

    // Check if member already has a number (sync nickname if needed)
    if (memberNumbers.has(member.id)) {
      const existingNumber = memberNumbers.get(member.id);
      
      // Get stored username from database if it exists
      let storedUsername = member.user.username;
      try {
        const [rows] = await pool.execute(
          'SELECT username FROM member_numbers WHERE member_id = ?',
          [member.id]
        );
        if (rows.length > 0) {
          storedUsername = rows[0].username;
        }
      } catch (error) {
        console.error(`Error fetching stored username for ${member.user.tag}:`, error);
      }
      
      const expectedNickname = `${existingNumber} | ${storedUsername}`;
      
      if (member.nickname !== expectedNickname) {
        // Check if member can be managed by the bot
        if (!canManageMember(member)) {
          console.log(`⚠️ Member ${member.user.tag} cannot be managed by bot. Skipping nickname update.`);
        } else {
          try {
            await member.setNickname(expectedNickname);
            console.log(`Updated nickname for ${member.user.tag} to ${expectedNickname}`);
          } catch (nicknameError) {
            if (nicknameError.code === 50013) {
              console.log(`⚠️ Could not update nickname for ${member.user.tag} - Missing permissions. Nickname update skipped.`);
            } else {
              console.error(`Error updating nickname for ${member.user.tag}:`, nicknameError);
            }
          }
        }
      }
      return;
    }

    // Check if member should be skipped
    if (shouldSkipMember(member)) {
      const skipReason = getSkipReason(member);
      console.log(`Skipping ${member.user.tag} due to: ${skipReason}`);
      return;
    }

    // Check if member can be managed by the bot
    if (!canManageMember(member)) {
      console.log(`⚠️ Member ${member.user.tag} cannot be managed by bot. Assigning number without nickname update.`);
      const number = getNextAvailableNumber();
      await assignNumberWithoutNickname(member, number);
      return;
    }

    // Assign next available number (only for new members, skipping reserved)
    const number = getNextAvailableNumber();
    memberNumbers.set(member.id, number);
    
    // Update member's nickname
    const newNickname = `${number} | ${member.user.username}`;
    try {
      await member.setNickname(newNickname);
      console.log(`✅ Nickname updated for ${member.user.tag} to: ${newNickname}`);
    } catch (nicknameError) {
      if (nicknameError.code === 50013) {
        console.log(`⚠️ Could not update nickname for ${member.user.tag} - Missing permissions. Number will still be assigned.`);
      } else {
        console.error(`Error updating nickname for ${member.user.tag}:`, nicknameError);
        throw nicknameError; // Re-throw other errors
      }
    }
    
    // Save to database
    await saveMemberNumberToDatabase(member.id, number, member.user.username);
    await updateNextNumberInDatabase();
    
    console.log(`✅ Assigned number ${number} to ${member.user.tag} (Next: ${nextNumber})`);
    
    // Update status immediately
    forceStatusUpdate();
    
  } catch (error) {
    console.error(`Error assigning number to ${member.user.tag}:`, error);
  }
}

// Remove number from a member
async function removeNumberFromMember(member) {
  try {
    if (memberNumbers.has(member.id)) {
      const number = memberNumbers.get(member.id);
      memberNumbers.delete(member.id);
      
      // Skip guild owner since bot cannot work with owners due to permissions
      if (member.id === member.guild.ownerId) {
        console.log(`⚠️ Skipping guild owner ${member.user.tag} during nickname removal`);
      } else {
        // Only try to update nickname if member is still in the server
        try {
          await member.setNickname(null);
          console.log(`✅ Nickname removed for ${member.user.tag}`);
        } catch (nicknameError) {
          // If member is no longer in server, just log it (this is expected)
          if (nicknameError.code === 10007) {
            console.log(`ℹ️ Member ${member.user.tag} already left server, skipping nickname update`);
          } else if (nicknameError.code === 50013) {
            console.log(`⚠️ Could not remove nickname for ${member.user.tag} - Missing permissions. Number will still be removed from database.`);
          } else {
            console.error(`Error updating nickname for ${member.user.tag}:`, nicknameError);
          }
        }
      }
      
      await removeMemberNumberFromDatabase(member.id);
      
      console.log(`❌ Removed number ${number} from ${member.user.tag}`);
      
      // Update status immediately
      forceStatusUpdate();
    }
  } catch (error) {
    console.error(`Error removing number from ${member.user.tag}:`, error);
  }
}

// Hide number from member (keep number but remove nickname)
async function hideNumberFromMember(member) {
  try {
    if (memberNumbers.has(member.id)) {
      const number = memberNumbers.get(member.id);
      
      // Skip guild owner since bot cannot work with owners due to permissions
      if (member.id === member.guild.ownerId) {
        console.log(`⚠️ Skipping guild owner ${member.user.tag} during nickname hiding`);
      } else {
        try {
          await member.setNickname(null);
          console.log(`👁️ Hidden number ${number} from ${member.user.tag}`);
        } catch (nicknameError) {
          if (nicknameError.code === 50013) {
            console.log(`⚠️ Could not hide number for ${member.user.tag} - Missing permissions. Number will still be hidden from display.`);
          } else {
            console.error(`Error hiding number from ${member.user.tag}:`, nicknameError);
            throw nicknameError; // Re-throw other errors
          }
        }
      }
      
      // Update status immediately
      forceStatusUpdate();
    }
  } catch (error) {
    console.error(`Error hiding number from ${member.user.tag}:`, error);
  }
}

// Check if member should have number removed
function shouldRemoveNumber(member) {
  if (member.roles.cache.has(config.numberingRoleId)) {
    return shouldSkipMember(member);
  }
  return false;
}

// Send welcome message with embed to new members
async function sendWelcomeMessage(member, assignedNumber) {
  try {
    // Check if welcome messages are enabled
    if (!config.welcomeMessage?.enabled) {
      console.log(`📨 Welcome messages are disabled, skipping for ${member.user.tag}`);
      return;
    }

    console.log(`📨 Attempting to send welcome message to ${member.user.tag} (ID: ${member.id}) with badge number ${assignedNumber}`);
    
    // Get welcome message configuration
    const welcomeConfig = config.welcomeMessage;
    
    // Create embed from configuration
    const welcomeEmbed = {
      color: parseInt(welcomeConfig.embed.color.replace('0x', ''), 16),
      title: welcomeConfig.embed.title,
      description: welcomeConfig.embed.description.replace('{username}', member.user.username).replace('{badgeNumber}', assignedNumber),
      fields: welcomeConfig.embed.fields.map(field => ({
        name: field.name,
        value: field.value.replace('{username}', member.user.username).replace('{badgeNumber}', assignedNumber),
        inline: field.inline
      })),
      footer: welcomeConfig.embed.footer,
      timestamp: new Date().toISOString()
    };

    // Add optional thumbnail and image if configured
    if (welcomeConfig.embed.thumbnail) {
      welcomeEmbed.thumbnail = { url: welcomeConfig.embed.thumbnail };
    }
    if (welcomeConfig.embed.image) {
      welcomeEmbed.image = { url: welcomeConfig.embed.image };
    }

    console.log(`📋 Welcome embed created for ${member.user.tag} using configuration`);

    // Send welcome message directly to the member via DM
    try {
      console.log(`📤 Attempting to send DM to ${member.user.tag}...`);
      await member.send({ embeds: [welcomeEmbed] });
      console.log(`✅ Welcome message sent to ${member.user.tag} via DM successfully!`);
      
      
    } catch (dmError) {
      console.log(`⚠️ Could not send welcome message to ${member.user.tag} - DMs may be disabled`);
      console.error('DM Error details:', dmError.message);
      console.error('DM Error code:', dmError.code);
      console.error('DM Error stack:', dmError.stack);
    }
  } catch (error) {
    console.error(`❌ Error in sendWelcomeMessage function for ${member.user.tag}:`, error);
    console.error('Error stack:', error.stack);
  }
}











// ===== BOT EVENTS =====





client.once(Events.ClientReady, async () => {
  console.log(`Bot is ready! Logged in as ${client.user.tag}`);
  
  // Register slash commands
  await registerCommands();
  
  // Initialize database and load existing member numbers
  await initializeDatabase();
  await loadMemberNumbers();
  
  // Load stored usernames and update nicknames
  await loadStoredUsernames();
  
  // Start status cycling
  startStatusCycling();
  
  // Log final status for verification
  console.log('=== FINAL STATUS VERIFICATION ===');
  console.log(`Total members with numbers: ${memberNumbers.size}`);
  console.log(`Next number to be assigned: ${nextNumber}`);
  console.log(`Current status index: ${currentStatusIndex}`);
  if (statusPresets.length > 0) {
    const currentStatus = statusPresets[currentStatusIndex];
    console.log(`Current status: ${currentStatus.type} ${currentStatus.text}`);
  }
  console.log('================================');
  
  // Initialize numbering for existing members with the role
  const guild = client.guilds.cache.get(config.guildId);
  if (guild) {
    const role = guild.roles.cache.get(config.numberingRoleId);
    if (role) {
      role.members.forEach(member => {
        assignNumberToMember(member);
      });
      // Check for members who should have numbers removed due to skip roles
      role.members.forEach(member => {
        if (memberNumbers.has(member.id) && shouldRemoveNumber(member)) {
          removeNumberFromMember(member);
        }
      });
    }
  }
});

// Guild member update event (role changes)
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild || newMember.guild.id !== config.guildId) return;
  
  const role = guild.roles.cache.get(config.numberingRoleId);
  if (!role) return;
  
  const hadRole = oldMember.roles.cache.has(config.numberingRoleId);
  const hasRole = newMember.roles.cache.has(config.numberingRoleId);
  
  // Log role changes for debugging
  if (hadRole !== hasRole) {
    console.log(`🔄 Role change detected for ${newMember.user.tag}:`);
    console.log(`   Before: ${hadRole ? 'Had numbering role' : 'No numbering role'}`);
    console.log(`   After: ${hasRole ? 'Has numbering role' : 'No numbering role'}`);
  }
  
  // Check for skip role changes
  const hadSkipRole = shouldSkipMember(oldMember);
  const hasSkipRole = shouldSkipMember(newMember);
  
  // Role was added
  if (!hadRole && hasRole) {
    console.log(`Role added to ${newMember.user.tag}`);
    await assignNumberToMember(newMember);
    
    // Send welcome message for existing member who just got the numbering role
    if (config.welcomeMessage?.sendToExistingMembers) {
      const delay = config.welcomeMessage?.delayBeforeSending || 1000;
      setTimeout(async () => {
        try {
          const assignedNumber = memberNumbers.get(newMember.id);
          if (assignedNumber) {
            console.log(`📨 Sending welcome message to existing member ${newMember.user.tag} who just got numbering role, badge number: ${assignedNumber}`);
            await sendWelcomeMessage(newMember, assignedNumber);
          } else {
            console.log(`⚠️ No badge number found for ${newMember.user.tag} when trying to send welcome message after role addition`);
          }
        } catch (error) {
          console.error(`Error sending welcome message to ${newMember.user.tag} after role addition:`, error);
        }
      }, delay);
    } else {
      console.log(`📨 Welcome messages for existing members are disabled, skipping for ${newMember.user.tag}`);
    }
  }
  
  // Role was removed
  if (hadRole && !hasRole) {
    console.log(`Role removed from ${newMember.user.tag}`);
    await hideNumberFromMember(newMember);
  }
  
  // Skip role was added (remove number if member has numbering role)
  if (!hadSkipRole && hasSkipRole && hasRole) {
    console.log(`Skip role added to ${newMember.user.tag}, removing number`);
    await removeNumberFromMember(newMember);
  }
  
  // Skip role was removed (assign number if member has numbering role and no number)
  if (hadSkipRole && !hasSkipRole && hasRole && !memberNumbers.has(newMember.id)) {
    console.log(`Skip role removed from ${newMember.user.tag}, assigning number`);
    await assignNumberToMember(newMember);
  }
});

// Guild member add event (new members)
client.on(Events.GuildMemberAdd, async (member) => {
  console.log(`👋 GuildMemberAdd event triggered for ${member.user.tag} (ID: ${member.id})`);
  
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild || member.guild.id !== config.guildId) {
    console.log(`⚠️ GuildMemberAdd: Guild mismatch or not found for ${member.user.tag}`);
    return;
  }
  
  console.log(`🔍 Checking if ${member.user.tag} has numbering role ${config.numberingRoleId}`);
  console.log(`📋 Member roles: ${Array.from(member.roles.cache.keys()).join(', ')}`);
  
  // Check if new member has the role
  if (member.roles.cache.has(config.numberingRoleId)) {
    console.log(`✅ ${member.user.tag} has numbering role, proceeding with number assignment`);
    
    // Check if this user previously had a number (rejoining user)
    const wasRejoiningMember = memberNumbers.has(member.id);
    
    if (wasRejoiningMember) {
      console.log(`🔄 Rejoining member ${member.user.tag} had number ${memberNumbers.get(member.id)}, assigning new number`);
      // Remove old number and assign fresh one
      const oldNumber = memberNumbers.get(member.id);
      memberNumbers.delete(member.id);
      await removeMemberNumberFromDatabase(member.id);
      console.log(`🔄 Removed old number ${oldNumber} from rejoining member ${member.user.tag}`);
    } else {
      console.log(`🆕 New member ${member.user.tag} joining with role`);
    }
    
    // Assign fresh number
    console.log(`🔢 Assigning number to ${member.user.tag}...`);
    await assignNumberToMember(member);
    
    // Send welcome message with embed for new members (not rejoining members)
    if (!wasRejoiningMember && config.welcomeMessage?.sendToNewMembers) {
      console.log(`📨 Will send welcome message to new member ${member.user.tag}`);
      // Wait a moment for the number to be assigned
      const delay = config.welcomeMessage?.delayBeforeSending || 1000;
      setTimeout(async () => {
        try {
          const assignedNumber = memberNumbers.get(member.id);
          if (assignedNumber) {
            console.log(`📨 Sending welcome message to new member ${member.user.tag} with badge number ${assignedNumber}`);
            await sendWelcomeMessage(member, assignedNumber);
          } else {
            console.log(`⚠️ No badge number found for ${member.user.tag} when trying to send welcome message`);
          }
        } catch (error) {
          console.error(`Error sending welcome message to ${member.user.tag}:`, error);
        }
      }, delay);
    } else if (wasRejoiningMember) {
      console.log(`📨 Skipping welcome message for rejoining member ${member.user.tag}`);
    } else if (!config.welcomeMessage?.sendToNewMembers) {
      console.log(`📨 Welcome messages for new members are disabled, skipping for ${member.user.tag}`);
    }
  } else {
    console.log(`❌ ${member.user.tag} does not have numbering role, skipping`);
  }
});

// Guild member remove event (member leaves server)
client.on(Events.GuildMemberRemove, async (member) => {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild || member.guild.id !== config.guildId) return;
  
  // Check if the leaving member had a number assigned
  if (memberNumbers.has(member.id)) {
    console.log(`Member ${member.user.tag} left the server, removing their number`);
    
    // Remove from memory and database without trying to update nickname
    const number = memberNumbers.get(member.id);
    memberNumbers.delete(member.id);
    
    await removeMemberNumberFromDatabase(member.id);
    
    console.log(`❌ Removed number ${number} from ${member.user.tag} (left server)`);
    
    // Update status immediately
    forceStatusUpdate();
  }
});

// ===== SLASH COMMAND HANDLER =====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  console.log(`📨 Slash command received: /${interaction.commandName} from ${interaction.user.tag} (${interaction.user.id})`);
  
     // Check permissions before executing command
   if (!hasCommandPermission(interaction.member, interaction.commandName)) {
     console.log(`❌ Permission denied: ${interaction.user.tag} tried to use /${interaction.commandName}`);
     await interaction.reply({ 
       content: '❌ **Access Denied!** You do not have permission to use this command.', 
       flags: 64 // 64 = ephemeral flag
     });
     return;
   }

   // Check rate limit
   const rateLimitResult = isRateLimited(interaction.user.id, interaction.commandName);
   if (rateLimitResult) {
     console.log(`⏱️ Rate limited: ${interaction.user.tag} tried /${interaction.commandName}`);
     await interaction.reply({
       content: `⏱️ **Rate limited.** Please wait ${rateLimitResult.retryAfter} seconds before using commands again.`,
       flags: 64
     });
     return;
   }
  
  console.log(`✅ Permission granted: ${interaction.user.tag} using /${interaction.commandName}`);
  
  try {
    switch (interaction.commandName) {
      case 'status':
        const reservedList = getReservedNumbers();
        const reservedStr = reservedList.length > 0 ? reservedList.join(', ') : 'None';
        const embed = {
          color: 0x00ff00,
          title: '🤖 Bot Status Information',
          fields: [
            {
              name: '📊 Member Statistics',
              value: `**Total Members with Numbers:** ${memberNumbers.size}\n**Next Number to Assign:** ${nextNumber}`,
              inline: true
            },
            {
              name: '🔒 Reserved Numbers',
              value: reservedStr,
              inline: true
            },
            {
              name: '🔄 Current Status',
              value: `**Type:** ${statusPresets[currentStatusIndex]?.type || 'Unknown'}\n**Text:** ${statusPresets[currentStatusIndex]?.text.replace('{nextNumber}', nextNumber).replace('{memberCount}', memberNumbers.size) || 'Unknown'}`,
              inline: true
            },
            {
              name: '⏰ Status Cycling',
              value: `**Current Index:** ${currentStatusIndex + 1}/${statusPresets.length}\n**Cycle Interval:** ${(config.status?.cycleInterval || 30000) / 1000}s`,
              inline: true
            }
          ],
          timestamp: new Date().toISOString()
        };
        
        await interaction.reply({ embeds: [embed] });
        break;
        
      case 'validate':
        const oldNextNumber = nextNumber;
        await validateNextNumber();
        
        if (oldNextNumber !== nextNumber) {
          const embed = createSuccessEmbed(
            'Next Number Corrected',
            'The next number has been automatically corrected and status updated.',
            [
              { name: 'Before', value: `${oldNextNumber}`, inline: true },
              { name: 'After', value: `${nextNumber}`, inline: true },
              { name: 'Status', value: 'Updated automatically', inline: false }
            ]
          );
          await interaction.reply({ embeds: [embed] });
        } else {
          const embed = createSuccessEmbed(
            'Validation Passed',
            'Next number validation completed successfully.',
            [
              { name: 'Current Next Number', value: `${nextNumber}`, inline: true },
              { name: 'Total Members', value: `${memberNumbers.size}`, inline: true }
            ]
          );
          await interaction.reply({ embeds: [embed] });
        }
        
        forceStatusUpdate();
        break;
        
      case 'refresh':
        forceStatusUpdate();
        const refreshEmbed = createSuccessEmbed(
          'Status Refreshed',
          'Bot status has been successfully refreshed with current information.',
          [
            { name: 'Next Number', value: `${nextNumber}`, inline: true },
            { name: 'Member Count', value: `${memberNumbers.size}`, inline: true }
          ]
        );
        await interaction.reply({ embeds: [refreshEmbed] });
        break;
        
      case 'remove':
        const userId = interaction.options.getString('user');
        if (!userId) {
          const usageEmbed = createErrorEmbed(
            'Usage Error',
            'Please provide a valid user ID to remove.',
            [
              { name: 'Usage', value: '`/remove <user_id>`', inline: false },
              { name: 'Example', value: '`/remove 123456789012345678`', inline: false }
            ]
          );
          await interaction.reply({ embeds: [usageEmbed] });
          return;
        }
        
        // Check if user exists in the guild
        const guild = client.guilds.cache.get(config.guildId);
        if (!guild) {
          const errorEmbed = createErrorEmbed('Guild Error', 'Guild not found. Please check your configuration.');
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }
        
        const guildMember = await guild.members.fetch(userId).catch(() => null);
        
        if (memberNumbers.has(userId)) {
          const number = memberNumbers.get(userId);
          
          // Remove from memory
          memberNumbers.delete(userId);
          
          // Remove from database
          await removeMemberNumberFromDatabase(userId);
          
          // Update status
          forceStatusUpdate();
          
          const successEmbed = createSuccessEmbed(
            'Member Removed',
            'Member has been successfully removed from the system.',
            [
              { name: 'User', value: guildMember ? guildMember.user.tag : 'Unknown', inline: true },
              { name: 'Badge Number', value: `${number}`, inline: true },
              { name: 'Status', value: 'Updated automatically', inline: false }
            ],
            guildMember ? guildMember.user : null
          );
          await interaction.reply({ embeds: [successEmbed] });
        } else {
          const errorEmbed = createErrorEmbed(
            'User Not Found',
            'No badge number is assigned to this user ID.',
            [
              { name: 'User ID', value: userId, inline: false }
            ],
            guildMember ? guildMember.user : null
          );
          await interaction.reply({ embeds: [errorEmbed] });
        }
        break;
        
                                   case 'edituser':
           const editUser = interaction.options.getUser('user');
           if (!editUser) {
             const usageEmbed = createErrorEmbed(
               'Usage Error',
               'Please provide a valid user to edit.',
               [
                 { name: 'Usage', value: '`/edituser <user> [badge_number] [username]`', inline: false },
                 { name: 'Examples', value: '• `/edituser @User 1234` - Change badge number only\n• `/edituser @User 1234 NewUsername` - Change both\n• `/edituser @User` - View current info only', inline: false }
               ]
             );
             await interaction.reply({ embeds: [usageEmbed] });
             return;
           }

           const newBadgeNumber = interaction.options.getInteger('badge_number');
           const newUsername = interaction.options.getString('username');

           if (newBadgeNumber !== null && (newBadgeNumber < 1 || newBadgeNumber > 999999)) {
             const errorEmbed = createErrorEmbed(
               'Invalid Badge Number',
               'Badge number must be within the valid range.',
               [
                 { name: 'Valid Range', value: '1 - 999,999', inline: true },
                 { name: 'Provided Value', value: `${newBadgeNumber}`, inline: true }
               ]
             );
             await interaction.reply({ embeds: [errorEmbed] });
             return;
           }

           if (newUsername !== null && (newUsername.length < 1 || newUsername.length > 32)) {
             const errorEmbed = createErrorEmbed(
               'Invalid Username',
               'Username must be within the valid length range.',
               [
                 { name: 'Valid Length', value: '1 - 32 characters', inline: true },
                 { name: 'Provided Length', value: `${newUsername.length} characters`, inline: true }
               ]
             );
             await interaction.reply({ embeds: [errorEmbed] });
             return;
           }

           // Get guild for this case
           const editGuild = client.guilds.cache.get(config.guildId);
           if (!editGuild) {
             const errorEmbed = createErrorEmbed('Guild Error', 'Guild not found. Please check your configuration.');
             await interaction.reply({ embeds: [errorEmbed] });
             return;
           }

           const userToEdit = await editGuild.members.fetch(editUser.id).catch(() => null);
           if (!userToEdit) {
             const errorEmbed = createErrorEmbed(
               'User Not Found',
               'The specified user is not a member of this server.',
               [
                 { name: 'User', value: editUser.tag, inline: false }
               ]
             );
             await interaction.reply({ embeds: [errorEmbed] });
             return;
           }

           // Check if user is guild owner (bot cannot work with owners due to permissions)
           if (userToEdit.id === editGuild.ownerId) {
             const errorEmbed = createErrorEmbed(
               'Cannot Edit Guild Owner',
               'The bot cannot edit the guild owner due to permission limitations.',
               [
                 { name: 'User', value: editUser.tag, inline: true },
                 { name: 'Reason', value: 'Guild owner permissions prevent bot operations', inline: true }
               ]
             );
             await interaction.reply({ embeds: [errorEmbed] });
             return;
           }

           if (memberNumbers.has(editUser.id)) {
             const currentNumber = memberNumbers.get(editUser.id);
             const currentUsername = userToEdit.user.username;

             // If no changes specified, show current information
             if (newBadgeNumber === null && newUsername === null) {
               const currentNickname = userToEdit.nickname || 'None';
               
               // Get stored username from database
               let storedUsername = currentUsername;
               try {
                 const [rows] = await pool.execute(
                   'SELECT username FROM member_numbers WHERE member_id = ?',
                   [editUser.id]
                 );
                 if (rows.length > 0) {
                   storedUsername = rows[0].username;
                 }
               } catch (error) {
                 console.error(`Error fetching stored username for ${editUser.tag}:`, error);
               }
               
               const infoEmbed = createInfoEmbed(
                 'Current User Information',
                 'User details and current configuration.',
                 [
                   { name: 'User', value: editUser.tag, inline: true },
                   { name: 'Badge Number', value: `${currentNumber}`, inline: true },
                   { name: 'Discord Username', value: currentUsername, inline: true },
                   { name: 'Stored Username', value: storedUsername, inline: true },
                   { name: 'Nickname', value: currentNickname, inline: true }
                 ],
                 editUser
               );
               infoEmbed.footer = { text: 'Use optional parameters to make changes' };
               await interaction.reply({ embeds: [infoEmbed] });
               return;
             }

             let newNumber = newBadgeNumber !== null ? newBadgeNumber : currentNumber;
             let finalUsername = newUsername !== null ? newUsername : currentUsername;
             if (newUsername === null) {
               try {
                 const [rows] = await pool.execute(
                   'SELECT username FROM member_numbers WHERE member_id = ?',
                   [editUser.id]
                 );
                 if (rows.length > 0) finalUsername = rows[0].username;
               } catch (err) {
                 console.error(`Error fetching stored username for ${editUser.tag}:`, err);
               }
             }

             // Check if the new badge number is already taken by another user
             if (newNumber !== currentNumber) {
               for (const [memberId, number] of memberNumbers.entries()) {
                 if (memberId !== editUser.id && number === newNumber) {
                   const errorEmbed = createErrorEmbed(
                     'Badge Number Conflict',
                     'The requested badge number is already assigned to another user.',
                     [
                       { name: 'Requested Number', value: `${newNumber}`, inline: true },
                       { name: 'Status', value: 'Already assigned', inline: true }
                     ]
                   );
                   await interaction.reply({ embeds: [errorEmbed] });
                   return;
                 }
               }
             }

             // Update the member numbers map
             if (newNumber !== currentNumber) {
               memberNumbers.set(editUser.id, newNumber);
               console.log(`✅ Badge number updated for ${editUser.tag} from ${currentNumber} to ${newNumber}`);
             }

             // Update database when badge number or username changed
             if (newNumber !== currentNumber || newUsername !== null) {
               await updateUserInDatabase(editUser.id, newNumber, finalUsername);
               if (newUsername !== null) {
                 console.log(`✅ Username updated for ${editUser.tag} to: ${finalUsername}`);
               }
               if (newNumber !== currentNumber) {
                 console.log(`✅ Badge number updated in database for ${editUser.tag}`);
               }
             }

             // Update nickname if needed
             const newNickname = `${newNumber} | ${finalUsername}`;
             if (newNickname !== userToEdit.nickname) {
               try {
                 await userToEdit.setNickname(newNickname);
                 console.log(`✅ Nickname updated for ${editUser.tag} to ${newNickname}`);
               } catch (nicknameError) {
                 if (nicknameError.code === 50013) {
                   console.log(`⚠️ Could not update nickname for ${editUser.tag} - Missing permissions. User information will still be updated.`);
                 } else {
                   console.error(`Error updating nickname for ${editUser.tag}:`, nicknameError);
                   throw nicknameError; // Re-throw other errors
                 }
               }
             }

                           // Update status and validate next number
              forceStatusUpdate();
              await validateNextNumber();
              
              // Send the reply immediately to avoid timeout
              const successEmbed = createSuccessEmbed(
                'User Updated Successfully',
                `User ${editUser.tag} has been updated successfully.`,
                [
                  { name: 'Badge Number', value: `${currentNumber} → ${newNumber}`, inline: true },
                  { name: 'Username', value: finalUsername, inline: true },
                  { name: 'Nickname', value: newNickname, inline: true },
                  { name: 'Status', value: 'Sending notification to user...', inline: false }
                ],
                editUser
              );
              const reply = await interaction.reply({ embeds: [successEmbed] });
              
              // Send notification to the user asynchronously and update the embed
              setImmediate(async () => {
                try {
                  const notificationEmbed = {
                    color: 0x00ff00,
                    title: '🔧 Account Information Updated',
                    description: `Your account information has been updated by a staff member.`,
                    fields: [
                      {
                        name: '👤 Updated By',
                        value: `<@${interaction.user.id}>`,
                        inline: true
                      },
                      {
                        name: '📅 Updated At',
                        value: new Date().toLocaleString(),
                        inline: true
                      }
                    ],
                    footer: {
                      text: 'If you have any questions, please contact a staff member.'
                    },
                    timestamp: new Date().toISOString()
                  };
                  
                  // Add fields for what was changed
                  if (newNumber !== currentNumber) {
                    notificationEmbed.fields.push({
                      name: '🆔 Badge Number Changed',
                      value: `**Before:** ${currentNumber}\n**After:** ${newNumber}`,
                      inline: false
                    });
                  }
                  
                  if (newUsername !== null) {
                    notificationEmbed.fields.push({
                      name: '📝 Username Updated',
                      value: `**New Username:** ${finalUsername}`,
                      inline: false
                    });
                  }
                  
                  // Try to send DM to the user
                  try {
                    await editUser.send({ embeds: [notificationEmbed] });
                    console.log(`✅ Notification sent to ${editUser.tag} about account changes`);
                    
                    // Update the original embed to show DM was sent
                    const updatedEmbed = createSuccessEmbed(
                      'User Updated Successfully',
                      `User ${editUser.tag} has been updated successfully.`,
                      [
                        { name: 'Badge Number', value: `${currentNumber} → ${newNumber}`, inline: true },
                        { name: 'Username', value: finalUsername, inline: true },
                        { name: 'Nickname', value: newNickname, inline: true },
                        { name: 'Notification Status', value: '✅ DM sent successfully', inline: false }
                      ],
                      editUser
                    );
                    await interaction.editReply({ embeds: [updatedEmbed] });
                  } catch (dmError) {
                    console.log(`⚠️ Could not send notification to ${editUser.tag} - DMs may be disabled`);
                    
                    // Update the original embed to show DM failed
                    const updatedEmbed = createWarningEmbed(
                      'User Updated Successfully',
                      `User ${editUser.tag} has been updated successfully, but notification could not be sent.`,
                      [
                        { name: 'Badge Number', value: `${currentNumber} → ${newNumber}`, inline: true },
                        { name: 'Username', value: finalUsername, inline: true },
                        { name: 'Nickname', value: newNickname, inline: true },
                        { name: 'Notification Status', value: '⚠️ DM failed - user may have DMs disabled', inline: false }
                      ],
                      editUser
                    );
                    await interaction.editReply({ embeds: [updatedEmbed] });
                  }
                } catch (notificationError) {
                  console.error(`Error sending notification to ${editUser.tag}:`, notificationError);
                  
                  // Update the original embed to show error
                  const updatedEmbed = createErrorEmbed(
                    'User Updated Successfully',
                    `User ${editUser.tag} has been updated successfully, but there was an error sending the notification.`,
                    [
                      { name: 'Badge Number', value: `${currentNumber} → ${newNumber}`, inline: true },
                      { name: 'Username', value: finalUsername, inline: true },
                      { name: 'Nickname', value: newNickname, inline: true },
                      { name: 'Notification Status', value: '❌ Error sending DM', inline: false }
                    ],
                    editUser
                  );
                  await interaction.editReply({ embeds: [updatedEmbed] });
                }
              });
           } else {
             const errorEmbed = createErrorEmbed(
               'No Badge Number Assigned',
               'This user does not have a badge number assigned.',
               [
                 { name: 'User', value: editUser.tag, inline: false }
               ]
             );
             await interaction.reply({ embeds: [errorEmbed] });
           }
           break;
        
      case 'adduser':
        const addUser = interaction.options.getUser('user');
        if (!addUser) {
          const usageEmbed = createErrorEmbed(
            'Usage Error',
            'Please provide a valid user to add.',
            [
              { name: 'Usage', value: '`/adduser <user> [badge_number] [username]`', inline: false },
              { name: 'Examples', value: '• `/adduser @User` - Add user with next available number\n• `/adduser @User 1234` - Add user with specific number\n• `/adduser @User 1234 CustomUsername` - Add user with specific number and username', inline: false }
            ]
          );
          await interaction.reply({ embeds: [usageEmbed] });
          return;
        }

        const requestedBadgeNumber = interaction.options.getInteger('badge_number');
        const customUsername = interaction.options.getString('username');

        // Validate badge number if provided
        if (requestedBadgeNumber !== null && (requestedBadgeNumber < 1 || requestedBadgeNumber > 999999)) {
          const errorEmbed = createErrorEmbed(
            'Invalid Badge Number',
            'Badge number must be within the valid range.',
            [
              { name: 'Valid Range', value: '1 - 999,999', inline: true },
              { name: 'Provided Value', value: `${requestedBadgeNumber}`, inline: true }
            ]
          );
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }

        // Validate username if provided
        if (customUsername !== null && (customUsername.length < 1 || customUsername.length > 32)) {
          const errorEmbed = createErrorEmbed(
            'Invalid Username',
            'Username must be within the valid length range.',
            [
              { name: 'Valid Length', value: '1 - 32 characters', inline: true },
              { name: 'Provided Length', value: `${customUsername.length} characters`, inline: true }
            ]
          );
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }

        // Check if user exists in the guild
        const addUserGuild = client.guilds.cache.get(config.guildId);
        if (!addUserGuild) {
          const errorEmbed = createErrorEmbed('Guild Error', 'Guild not found. Please check your configuration.');
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }

        const userToAdd = await addUserGuild.members.fetch(addUser.id).catch(() => null);
        if (!userToAdd) {
          const errorEmbed = createErrorEmbed(
            'User Not Found',
            'The specified user is not a member of this server.',
            [
              { name: 'User', value: addUser.tag, inline: false }
            ]
          );
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }

        // Check if user is guild owner (bot cannot work with owners due to permissions)
        if (userToAdd.id === addUserGuild.ownerId) {
          const errorEmbed = createErrorEmbed(
            'Cannot Add Guild Owner',
            'The bot cannot add the guild owner due to permission limitations.',
            [
              { name: 'User', value: addUser.tag, inline: true },
              { name: 'Reason', value: 'Guild owner permissions prevent bot operations', inline: true }
            ]
          );
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }

        // Check if user already has a badge number
        if (memberNumbers.has(addUser.id)) {
          const existingNumber = memberNumbers.get(addUser.id);
          const errorEmbed = createErrorEmbed(
            'User Already Has Badge Number',
            'This user already has a badge number assigned.',
            [
              { name: 'User', value: addUser.tag, inline: true },
              { name: 'Current Number', value: `${existingNumber}`, inline: true },
              { name: 'Action', value: 'Use `/edituser` to modify existing user information', inline: false }
            ]
          );
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }

        // Determine the badge number to assign
        let badgeNumberToAssign;
        if (requestedBadgeNumber !== null) {
          // Check if the requested number is already taken
          for (const [memberId, number] of memberNumbers.entries()) {
            if (number === requestedBadgeNumber) {
              const errorEmbed = createErrorEmbed(
                'Badge Number Conflict',
                'The requested badge number is already assigned to another user.',
                [
                  { name: 'Requested Number', value: `${requestedBadgeNumber}`, inline: true },
                  { name: 'Status', value: 'Already assigned', inline: true }
                ]
              );
              await interaction.reply({ embeds: [errorEmbed] });
              return;
            }
          }
          badgeNumberToAssign = requestedBadgeNumber;
        } else {
          // Use the next available number (skips reserved)
          badgeNumberToAssign = getNextAvailableNumber();
        }

        // Determine the username to store
        const finalUsername = customUsername || userToAdd.user.username;

        try {
          // Add user to memory
          memberNumbers.set(addUser.id, badgeNumberToAssign);
          
          // Save to database
          await saveMemberNumberToDatabase(addUser.id, badgeNumberToAssign, finalUsername);
          
                     // Update nickname
           const newNickname = `${badgeNumberToAssign} | ${finalUsername}`;
           try {
             await userToAdd.setNickname(newNickname);
             console.log(`✅ Nickname updated for ${addUser.tag} to: ${newNickname}`);
           } catch (nicknameError) {
             if (nicknameError.code === 50013) {
               console.log(`⚠️ Could not update nickname for ${addUser.tag} - Missing permissions. User will still be added to database.`);
               // Continue with the process even if nickname update fails
             } else {
               console.error(`Error updating nickname for ${addUser.tag}:`, nicknameError);
               throw nicknameError; // Re-throw other errors
             }
           }
          
          // Update next number in DB if we used the next available (getNextAvailableNumber already incremented)
          if (requestedBadgeNumber === null) {
            await updateNextNumberInDatabase();
          }
          
          // Update status
          forceStatusUpdate();
          
                     // Send success reply
           const nicknameStatus = userToAdd.nickname === newNickname ? '✅ Updated' : '⚠️ Could not update (permission issue)';
           const successEmbed = createSuccessEmbed(
             'User Added Successfully',
             'User has been added to the system successfully.',
             [
               { name: 'User', value: addUser.tag, inline: true },
               { name: 'Badge Number', value: `${badgeNumberToAssign}`, inline: true },
               { name: 'Username', value: finalUsername, inline: true },
               { name: 'Nickname', value: newNickname, inline: true },
               { name: 'Nickname Status', value: nicknameStatus, inline: true },
               { name: 'Status', value: 'Sending welcome message...', inline: false }
             ],
             addUser
           );
           const reply = await interaction.reply({ embeds: [successEmbed] });
          
          // Send welcome message to the user asynchronously and update the embed
          setImmediate(async () => {
            try {
              await sendWelcomeMessage(userToAdd, badgeNumberToAssign);
              console.log(`✅ Welcome message sent to ${addUser.tag} after manual addition`);
              
              // Update the embed to show welcome message was sent
              const updatedEmbed = createSuccessEmbed(
                'User Added Successfully',
                'User has been added to the system successfully.',
                [
                  { name: 'User', value: addUser.tag, inline: true },
                  { name: 'Badge Number', value: `${badgeNumberToAssign}`, inline: true },
                  { name: 'Username', value: finalUsername, inline: true },
                  { name: 'Nickname', value: newNickname, inline: true },
                  { name: 'Nickname Status', value: nicknameStatus, inline: true },
                  { name: 'Welcome Message', value: '✅ Sent successfully', inline: false }
                ],
                addUser
              );
              await interaction.editReply({ embeds: [updatedEmbed] });
            } catch (welcomeError) {
              console.error(`Error sending welcome message to ${addUser.tag}:`, welcomeError);
              
              // Update the embed to show welcome message failed
              const updatedEmbed = createWarningEmbed(
                'User Added Successfully',
                'User has been added to the system successfully, but welcome message could not be sent.',
                [
                  { name: 'User', value: addUser.tag, inline: true },
                  { name: 'Badge Number', value: `${badgeNumberToAssign}`, inline: true },
                  { name: 'Username', value: finalUsername, inline: true },
                  { name: 'Nickname', value: newNickname, inline: true },
                  { name: 'Nickname Status', value: nicknameStatus, inline: true },
                  { name: 'Welcome Message', value: '❌ Failed to send', inline: false }
                ],
                addUser
              );
              await interaction.editReply({ embeds: [updatedEmbed] });
            }
          });
          
          console.log(`✅ User ${addUser.tag} manually added with badge number ${badgeNumberToAssign}`);
          
        } catch (error) {
          console.error(`Error adding user ${addUser.tag}:`, error);

          // Rollback memory changes on error
          memberNumbers.delete(addUser.id);

          const errorEmbed = createErrorEmbed(
            'Error Adding User',
            'An error occurred while processing the request.',
            [
              { name: 'Action', value: 'Please try again or contact an administrator', inline: false }
            ]
          );
          try {
            if (interaction.replied || interaction.deferred) {
              await interaction.editReply({ embeds: [errorEmbed] });
            } else {
              await interaction.reply({ embeds: [errorEmbed] });
            }
          } catch (replyErr) {
            console.error('Failed to send error reply:', replyErr);
          }
        }
        break;
        
      case 'cleanup':
        const cleanupGuild = client.guilds.cache.get(config.guildId);
        if (!cleanupGuild) {
          const errorEmbed = createErrorEmbed('Guild Error', 'Guild not found. Please check your configuration.');
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }

        await interaction.deferReply();

        let removedCount = 0;
        const membersToRemove = [];

        // Check all stored member numbers against current guild members
        for (const [memberId, number] of memberNumbers.entries()) {
          const cleanupGuildMember = await cleanupGuild.members.fetch(memberId).catch(() => null);
          if (!cleanupGuildMember) {
            membersToRemove.push({ id: memberId, number });
          }
        }

        // Remove members who are no longer in the guild
        for (const member of membersToRemove) {
          memberNumbers.delete(member.id);
          await removeMemberNumberFromDatabase(member.id);
          removedCount++;
        }

        if (removedCount > 0) {
          await validateNextNumber();
          forceStatusUpdate();
        }

        const cleanupEmbed = removedCount > 0
          ? createSuccessEmbed(
              'Cleanup Completed',
              'Members no longer in the server have been removed.',
              [
                { name: 'Members Removed', value: `${removedCount}`, inline: true },
                { name: 'Next Number', value: `${nextNumber}`, inline: true },
                { name: 'Status', value: 'Updated automatically', inline: false }
              ]
            )
          : createInfoEmbed(
              'No Cleanup Needed',
              'All stored members are still present in the server.',
              [{ name: 'Status', value: 'No action required', inline: false }]
            );
        await interaction.editReply({ embeds: [cleanupEmbed] });
        break;
        
      case 'welcome':
        const welcomeUser = interaction.options.getUser('user');
        if (!welcomeUser) {
          const usageEmbed = createErrorEmbed(
            'Usage Error',
            'Please select a user from the dropdown.',
            [
              { name: 'Usage', value: '`/welcome <user>`', inline: false }
            ]
          );
          await interaction.reply({ embeds: [usageEmbed] });
          return;
        }
        
        // Check if user exists in the guild
        const welcomeGuild = client.guilds.cache.get(config.guildId);
        if (!welcomeGuild) {
          const errorEmbed = createErrorEmbed('Guild Error', 'Guild not found. Please check your configuration.');
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }
        
        const welcomeGuildMember = await welcomeGuild.members.fetch(welcomeUser.id).catch(() => null);
        if (!welcomeGuildMember) {
          const errorEmbed = createErrorEmbed(
            'User Not Found',
            'The specified user is not a member of this server.',
            [
              { name: 'User', value: welcomeUser.tag, inline: false }
            ]
          );
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }
        
        if (memberNumbers.has(welcomeUser.id)) {
          const number = memberNumbers.get(welcomeUser.id);
          
          // Send initial embed
          const initialEmbed = createInfoEmbed(
            'Sending Welcome Message',
            'Welcome message is being sent to the user...',
            [
              { name: 'User', value: welcomeGuildMember.user.tag, inline: true },
              { name: 'Badge Number', value: `${number}`, inline: true },
              { name: 'Status', value: 'Sending...', inline: false }
            ],
            welcomeGuildMember.user
          );
          const reply = await interaction.reply({ embeds: [initialEmbed] });
          
          try {
            await sendWelcomeMessage(welcomeGuildMember, number);
            
            // Update embed to show success
            const successEmbed = createSuccessEmbed(
              'Welcome Message Sent',
              'Welcome message has been sent to the user successfully.',
              [
                { name: 'User', value: welcomeGuildMember.user.tag, inline: true },
                { name: 'Badge Number', value: `${number}`, inline: true },
                { name: 'Delivery Method', value: 'Direct Message', inline: true },
                { name: 'Status', value: '✅ Sent successfully', inline: false }
              ],
              welcomeGuildMember.user
            );
            await interaction.editReply({ embeds: [successEmbed] });
          } catch (welcomeError) {
            console.error(`Error sending welcome message to ${welcomeGuildMember.user.tag}:`, welcomeError);
            
            // Update embed to show error
            const errorEmbed = createErrorEmbed(
              'Welcome Message Failed',
              'Failed to send welcome message to the user.',
              [
                { name: 'User', value: welcomeGuildMember.user.tag, inline: true },
                { name: 'Badge Number', value: `${number}`, inline: true },
                { name: 'Delivery Method', value: 'Direct Message', inline: true },
                { name: 'Status', value: '❌ Failed to send', inline: false }
              ],
              welcomeGuildMember.user
            );
            await interaction.editReply({ embeds: [errorEmbed] });
          }
        } else {
          const errorEmbed = createErrorEmbed(
            'No Badge Number Found',
            'This user does not have a badge number assigned.',
            [
              { name: 'User', value: welcomeGuildMember.user.tag, inline: false }
            ]
          );
          await interaction.reply({ embeds: [errorEmbed] });
        }
        break;
        
      case 'testwelcome':
        // Test the welcome message function with the command author
        const testMember = interaction.member;
        const testNumber = memberNumbers.get(testMember.id) || 9999; // Use their number or 9999 as test
        
        console.log(`🧪 Testing welcome message for ${testMember.user.tag} with number ${testNumber}`);
        
        // Send initial embed
        const initialEmbed = createInfoEmbed(
          'Testing Welcome Message',
          'Test welcome message is being sent...',
          [
            { name: 'User', value: testMember.user.tag, inline: true },
            { name: 'Test Number', value: `${testNumber}`, inline: true },
            { name: 'Status', value: 'Sending...', inline: false }
          ],
          testMember.user
        );
        const reply = await interaction.reply({ embeds: [initialEmbed] });
        
        try {
          await sendWelcomeMessage(testMember, testNumber);
          
          // Update embed to show success
          const testEmbed = createSuccessEmbed(
            'Test Welcome Message Sent',
            'Test welcome message has been sent successfully.',
            [
              { name: 'User', value: testMember.user.tag, inline: true },
              { name: 'Test Number', value: `${testNumber}`, inline: true },
              { name: 'Delivery Method', value: 'Direct Message', inline: true },
              { name: 'Status', value: '✅ Sent successfully', inline: false }
            ],
            testMember.user
          );
          await interaction.editReply({ embeds: [testEmbed] });
        } catch (welcomeError) {
          console.error(`Error sending test welcome message to ${testMember.user.tag}:`, welcomeError);
          
          // Update embed to show error
          const errorEmbed = createErrorEmbed(
            'Test Welcome Message Failed',
            'Failed to send test welcome message.',
            [
              { name: 'User', value: testMember.user.tag, inline: true },
              { name: 'Test Number', value: `${testNumber}`, inline: true },
              { name: 'Delivery Method', value: 'Direct Message', inline: true },
              { name: 'Status', value: '❌ Failed to send', inline: false }
            ],
            testMember.user
          );
          await interaction.editReply({ embeds: [errorEmbed] });
        }
        break;
        
      case 'welcomeconfig':
        const welcomeConfig = config.welcomeMessage;
        if (!welcomeConfig) {
          const errorEmbed = createErrorEmbed('Configuration Error', 'No welcome message configuration found.');
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }
        
        const configEmbed = {
          color: 0x00ff00,
          title: '📋 Welcome Message Configuration',
          fields: [
            {
              name: '🔄 Status',
              value: `**Enabled:** ${welcomeConfig.enabled ? '✅ Yes' : '❌ No'}\n**New Members:** ${welcomeConfig.sendToNewMembers ? '✅ Yes' : '❌ No'}\n**Existing Members:** ${welcomeConfig.sendToExistingMembers ? '✅ Yes' : '❌ No'}`,
              inline: true
            },
            {
              name: '⏰ Settings',
              value: `**Delay:** ${welcomeConfig.delayBeforeSending}ms\n**Color:** ${welcomeConfig.embed.color}`,
              inline: true
            },
            {
              name: '📝 Content',
              value: `**Title:** ${welcomeConfig.embed.title}\n**Description:** ${welcomeConfig.embed.description.substring(0, 100)}...`,
              inline: false
            },
            {
              name: '📊 Fields',
              value: `**Total Fields:** ${welcomeConfig.embed.fields.length}`,
              inline: true
            }
          ],
          timestamp: new Date().toISOString()
        };
        
        await interaction.reply({ embeds: [configEmbed] });
        break;
        
             
        
      case 'previewwelcome':
        const previewConfig = config.welcomeMessage;
        if (!previewConfig?.enabled) {
          const errorEmbed = createErrorEmbed('Welcome Messages Disabled', 'Welcome messages are currently disabled in the configuration.');
          await interaction.reply({ embeds: [errorEmbed] });
          return;
        }
        
        // Create a preview embed
        const previewEmbed = {
          color: parseInt(previewConfig.embed.color.replace('0x', ''), 16),
          title: previewConfig.embed.title,
          description: previewConfig.embed.description.replace('{username}', interaction.user.username).replace('{badgeNumber}', '1234'),
          fields: previewConfig.embed.fields.map(field => ({
            name: field.name,
            value: field.value.replace('{username}', interaction.user.username).replace('{badgeNumber}', '1234'),
            inline: field.inline
          })),
          footer: previewConfig.embed.footer,
          timestamp: new Date().toISOString()
        };
        
        // Add optional thumbnail and image if configured
        if (previewConfig.embed.thumbnail) {
          previewEmbed.thumbnail = { url: previewConfig.embed.thumbnail };
        }
        if (previewConfig.embed.image) {
          previewEmbed.image = { url: previewConfig.embed.image };
        }
        
        await interaction.reply({ 
          content: '📋 **Welcome Message Preview** (Example with username: YourUsername, Badge Number: 1234)',
          embeds: [previewEmbed] 
        });
        break;
        
      case 'ping':
        const pingEmbed = createInfoEmbed(
          'Pong!',
          'Bot is working and responding to slash commands.',
          [
            { name: 'Status', value: '✅ Online', inline: true },
            { name: 'Response Time', value: 'Immediate', inline: true }
          ],
          interaction.user
        );
        await interaction.reply({ embeds: [pingEmbed] });
        console.log(`✅ Ping command responded to ${interaction.user.tag}`);
        break;

      case 'health':
        const uptimeSec = Math.floor(process.uptime());
        const days = Math.floor(uptimeSec / 86400);
        const hours = Math.floor((uptimeSec % 86400) / 3600);
        const mins = Math.floor((uptimeSec % 3600) / 60);
        const secs = uptimeSec % 60;
        const uptimeStr = [days && `${days}d`, hours && `${hours}h`, mins && `${mins}m`, `${secs}s`].filter(Boolean).join(' ');

        let dbStatus = '❌ Unknown';
        try {
          await pool.execute('SELECT 1');
          dbStatus = '✅ Connected';
        } catch (dbErr) {
          dbStatus = `❌ Error: ${dbErr.message}`;
        }

        const wsLatency = client.ws.ping;
        const healthEmbed = createInfoEmbed(
          'Health Check',
          'Bot health status for monitoring.',
          [
            { name: 'Status', value: '✅ Online', inline: true },
            { name: 'Uptime', value: uptimeStr, inline: true },
            { name: 'Discord Latency', value: `${wsLatency >= 0 ? wsLatency : '—'} ms`, inline: true },
            { name: 'Database', value: dbStatus, inline: false }
          ]
        );
        await interaction.reply({ embeds: [healthEmbed] });
        break;

      case 'reserved':
        const reserved = getReservedNumbers();
        const reservedEmbed = createInfoEmbed(
          'Reserved Badge Numbers',
          reserved.length > 0
            ? 'These numbers are skipped during auto-assignment. Assign them manually via `/adduser` for special members.'
            : 'No numbers are currently reserved.',
          [
            {
              name: 'Reserved Numbers',
              value: reserved.length > 0 ? reserved.sort((a, b) => a - b).join(', ') : '—',
              inline: false
            },
            {
              name: 'Next Auto-Assign',
              value: `${nextNumber}`,
              inline: true
            }
          ]
        );
        await interaction.reply({ embeds: [reservedEmbed] });
        break;
        
             case 'permissions':
         const userRoles = interaction.member.roles.cache.map(role => role.name).join(', ');
         const userRoleIds = Array.from(interaction.member.roles.cache.keys());
         
         // Create permissions embed
         const permissionsEmbed = {
           color: 0x00ff00,
           title: '🔐 Command Permissions',
           description: `**User:** ${interaction.user.tag}\n**Roles:** ${userRoles}`,
           fields: [],
           thumbnail: { url: interaction.user.displayAvatarURL({ size: 256 }) }
         };
         
         // Check access for each command
         for (const [commandName, requiredRoles] of Object.entries(commandPermissions)) {
           const hasAccess = hasCommandPermission(interaction.member, commandName);
           const accessEmoji = hasAccess ? '✅' : '❌';
           const accessText = hasAccess ? 'Access Granted' : 'Access Denied';
           
           let roleText = 'Everyone';
           if (requiredRoles.length > 0) {
             roleText = requiredRoles.map(role => {
               const roleId = config.rolePermissions?.[role];
               if (roleId && userRoleIds.includes(roleId)) {
                 return `**${role}** (You have this)`;
               }
               return role;
             }).join(', ');
           }
           
           permissionsEmbed.fields.push({
             name: `${accessEmoji} /${commandName}`,
             value: `**Required Roles:** ${roleText}\n**Status:** ${accessText}`,
             inline: true
           });
         }
         
         permissionsEmbed.footer = {
           text: 'Use /permissions to check your access to commands'
         };
         permissionsEmbed.timestamp = new Date().toISOString();
         
         await interaction.reply({ embeds: [permissionsEmbed] });
         break;
         
       
        
      default:
        const errorEmbed = createErrorEmbed('Unknown Command', 'The specified command was not found.');
        await interaction.reply({ embeds: [errorEmbed] });
        break;
    }
     } catch (error) {
     console.error(`Error handling slash command ${interaction.commandName}:`, error);
     try {
       const errorEmbed = createErrorEmbed('Command Error', 'An error occurred while processing the command.');
       if (interaction.replied || interaction.deferred) {
         await interaction.editReply({ embeds: [errorEmbed] });
       } else {
         await interaction.reply({ embeds: [errorEmbed], flags: 64 });
       }
     } catch (replyError) {
       console.error('Failed to send error reply:', replyError);
     }
   }
});

// ===== ERROR HANDLING & SHUTDOWN =====
client.on('error', error => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  stopStatusCycling();
  client.destroy();
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  stopStatusCycling();
  client.destroy();
  await pool.end();
  process.exit(0);
});

// Login to Discord
client.login(config.token);
