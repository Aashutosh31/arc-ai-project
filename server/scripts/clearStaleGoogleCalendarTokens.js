#!/usr/bin/env node

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { decryptJson } = require('../services/googleCalendarService');

const argv = new Set(process.argv.slice(2));
const shouldApply = argv.has('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

if (limit !== null && !isPositiveInt(limit)) {
    console.error('Invalid --limit value. Use a positive integer, e.g. --limit=100');
    process.exit(1);
}

const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL;
if (!mongoUri) {
    console.error('Missing MONGO_URI or DATABASE_URL environment variable.');
    process.exit(1);
}

const main = async () => {
    await mongoose.connect(mongoUri);
    console.log('[calendar-maintenance] MongoDB connected');

    const query = {
        'googleCalendar.connected': true,
        'googleCalendar.encryptedTokenData': { $type: 'string', $ne: '' }
    };

    let cursor = User.find(query)
        .select('_id googleCalendar.encryptedTokenData googleCalendar.connected')
        .lean()
        .cursor();

    let scanned = 0;
    let staleCount = 0;
    const staleIds = [];

    for await (const user of cursor) {
        scanned += 1;

        const blob = user?.googleCalendar?.encryptedTokenData;
        try {
            const parsed = decryptJson(blob);
            if (!parsed || typeof parsed !== 'object') {
                staleCount += 1;
                staleIds.push(user._id);
            }
        } catch (error) {
            staleCount += 1;
            staleIds.push(user._id);
        }

        if (limit !== null && scanned >= limit) {
            break;
        }
    }

    console.log(`[calendar-maintenance] scanned=${scanned} stale=${staleCount} mode=${shouldApply ? 'apply' : 'dry-run'}`);

    if (!shouldApply) {
        if (staleIds.length > 0) {
            console.log('[calendar-maintenance] No changes made. Re-run with --apply to clear stale blobs.');
        }
        return;
    }

    if (staleIds.length === 0) {
        console.log('[calendar-maintenance] Nothing to update.');
        return;
    }

    const result = await User.updateMany(
        { _id: { $in: staleIds } },
        {
            $set: {
                'googleCalendar.connected': false,
                'googleCalendar.updatedAt': new Date()
            },
            $unset: {
                'googleCalendar.encryptedTokenData': '',
                'googleCalendar.connectedAt': ''
            }
        }
    );

    console.log(`[calendar-maintenance] Cleared stale calendar tokens for ${result.modifiedCount} users.`);
};

main()
    .catch((error) => {
        console.error('[calendar-maintenance] Failed:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await mongoose.disconnect();
        } catch (error) {
            // Ignore disconnect errors during shutdown.
        }
    });
