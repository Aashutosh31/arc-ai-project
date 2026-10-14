#!/usr/bin/env node
// Backfill IdempotencyRecord.expiresAt for legacy records
// Run with: node scripts/backfillIdempotencyExpiresAt.js

require('dotenv').config();
const mongoose = require('mongoose');
const IdempotencyRecord = require('../server/models/IdempotencyRecord');

const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours default retention

async function backfill() {
    const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;
    if (!mongoUri) {
        console.error('❌ MONGO_URI or DATABASE_URL not set');
        process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log('🟢 MongoDB connected');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + RETENTION_MS);

    // Find records with expiresAt: null
    const legacyRecords = await IdempotencyRecord.find({ expiresAt: null });
    console.log(`Found ${legacyRecords.length} legacy records with expiresAt: null`);

    if (legacyRecords.length === 0) {
        console.log('✅ No legacy records to backfill');
        await mongoose.disconnect();
        process.exit(0);
    }

    // Option 1: Set expiresAt to now + retention (keeps dedup protection for remaining window)
    // Option 2: Delete legacy records (safe because losing dedup record only means repeat is treated as new action)
    // We'll use Option 1 by default, but allow --delete flag for Option 2

    const shouldDelete = process.argv.includes('--delete');

    if (shouldDelete) {
        const result = await IdempotencyRecord.deleteMany({ expiresAt: null });
        console.log(`🗑️ Deleted ${result.deletedCount} legacy records`);
    } else {
        const result = await IdempotencyRecord.updateMany(
            { expiresAt: null },
            { $set: { expiresAt } }
        );
        console.log(`✅ Updated ${result.modifiedCount} legacy records with expiresAt: ${expiresAt.toISOString()}`);
    }

    await mongoose.disconnect();
    console.log('🟢 MongoDB disconnected');
    process.exit(0);
}

backfill().catch((err) => {
    console.error('❌ Backfill failed:', err);
    process.exit(1);
});