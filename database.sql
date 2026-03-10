-- ============================================
-- LSRP Number Bot - Database Schema (MariaDB)
-- ============================================
-- Run this file to set up the MariaDB database
-- for the Discord number assignment bot.
--
-- Usage: mysql -u your_user -p your_database < database.sql
-- Or import via phpMyAdmin, HeidiSQL, DBeaver, etc.
--
-- Note: Default MariaDB port is 3306 (vs PostgreSQL's 5432)
-- ============================================

-- Create member_numbers table
-- Stores Discord member IDs with their assigned badge numbers
CREATE TABLE IF NOT EXISTS member_numbers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    member_id VARCHAR(20) UNIQUE NOT NULL,
    member_number INT NOT NULL,
    username VARCHAR(32) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Index for faster lookups (MariaDB 10.5+ supports IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_member_numbers_member_id ON member_numbers(member_id);
CREATE INDEX IF NOT EXISTS idx_member_numbers_member_number ON member_numbers(member_number);

-- Create bot_state table
-- Stores key-value pairs for bot state (e.g., next number to assign)
-- Note: `key` is a reserved word in MySQL/MariaDB, hence backticks
CREATE TABLE IF NOT EXISTS bot_state (
    id INT AUTO_INCREMENT PRIMARY KEY,
    `key` VARCHAR(50) UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Seed initial bot state (next number to assign, starts at 2000)
INSERT IGNORE INTO bot_state (`key`, value, updated_at)
VALUES ('next_number', '2000', CURRENT_TIMESTAMP);

-- ============================================
-- Optional: Uncomment below to reset tables
-- (WARNING: This will delete all existing data!)
-- ============================================
-- DROP TABLE IF EXISTS member_numbers;
-- DROP TABLE IF EXISTS bot_state;
